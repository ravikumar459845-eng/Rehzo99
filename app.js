const $=s=>document.querySelector(s);
const cfg=window.REHZO_SUPABASE;
const API=cfg.url+'/rest/v1';
const AUTH=cfg.url+'/auth/v1';
const STORAGE=cfg.url+'/storage/v1';
let session=JSON.parse(localStorage.getItem('rehzo99_session')||'null');
let profile=null, listings=[], currentGps=null, nearbyMode=false, isAdmin=false;
const money=(v,c)=>{try{return new Intl.NumberFormat(undefined,{style:'currency',currency:c||'INR',maximumFractionDigits:0}).format(Number(v))}catch{return String(v)}};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.classList.remove('show'),3800)}
function modal(id,on=true){$('#'+id).classList.toggle('open',on)}
function formData(form){return Object.fromEntries(new FormData(form).entries())}
function authHeaders(){return session?.access_token?{Authorization:'Bearer '+session.access_token}:{}}
async function api(path,{method='GET',body,auth=true,prefer}={}){
 const headers={apikey:cfg.publishableKey,...(auth?authHeaders():{}),...(body?{'Content-Type':'application/json'}:{}),...(prefer?{Prefer:prefer}:{})};
 const res=await fetch(API+'/'+path,{method,headers,body:body?JSON.stringify(body):undefined});
 const text=await res.text();let data=null;try{data=text?JSON.parse(text):null}catch{data=text}
 if(!res.ok)throw new Error(data?.message||data?.hint||data?.details||data?.error_description||data?.msg||('Request failed ('+res.status+')'));
 return data;
}
async function authRequest(path,body){
 const res=await fetch(AUTH+'/'+path,{method:'POST',headers:{apikey:cfg.publishableKey,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const data=await res.json().catch(()=>({}));
 if(!res.ok)throw new Error(data.msg||data.message||data.error_description||'Authentication failed');
 return data;
}
function saveSession(s){session=s; if(s)localStorage.setItem('rehzo99_session',JSON.stringify(s));else localStorage.removeItem('rehzo99_session');}
function closeAll(){document.querySelectorAll('.modal').forEach(m=>m.classList.remove('open'))}
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>b.closest('.modal').classList.remove('open')));
document.querySelectorAll('.modal').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)m.classList.remove('open')}));
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeAll()});
$('#year').textContent=new Date().getFullYear();
function authUi(){const logged=!!session?.access_token;$('#accountBtn').hidden=logged;$('#dashboardBtn').hidden=!logged;$('#ownerBtn').textContent=logged?'Owner dashboard ↗':'List your place ↗';$('#mobileAccount').textContent=logged?'☻':'☻';}
function showAuth(mode='login'){modal('authModal');setAuthMode(mode)}
function setAuthMode(mode){const signup=mode==='signup';$('#loginForm').hidden=signup;$('#signupForm').hidden=!signup;$('#showLogin').classList.toggle('active',!signup);$('#showSignup').classList.toggle('active',signup);$('#authHeading').textContent=signup?'Create your free account':'Log in to continue';$('#authHelp').textContent=signup?'Create an account with your email. Verify it if email confirmation is enabled.':'Use your email and password to access your account.';$('#authMessage').textContent=''}
$('#accountBtn').addEventListener('click',()=>showAuth());$('#mobileAccount').addEventListener('click',()=>session?openDashboard():showAuth());$('#showLogin').addEventListener('click',()=>setAuthMode('login'));$('#showSignup').addEventListener('click',()=>setAuthMode('signup'));
$('#loginForm').addEventListener('submit',async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;$('#authMessage').textContent='Signing in…';try{const d=formData(e.target);const data=await authRequest('token?grant_type=password',{email:d.email,password:d.password});saveSession(data);await refreshAccount();modal('authModal',false);toast('You are logged in.');}catch(err){$('#authMessage').textContent=err.message}finally{b.disabled=false}});
$('#signupForm').addEventListener('submit',async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;$('#authMessage').textContent='Creating your account…';try{const d=formData(e.target);const data=await authRequest('signup',{email:d.email,password:d.password,data:{display_name:d.display_name,country_code:d.country_code,preferred_currency:d.country_code==='IN'?'INR':''}});if(data.session){saveSession(data.session);await refreshAccount();modal('authModal',false);toast('Account created successfully.')}else{$('#authMessage').textContent='Account created. Please verify your email using the message sent to '+d.email+', then log in.';setAuthMode('login')}}catch(err){$('#authMessage').textContent=err.message}finally{b.disabled=false}});
async function refreshSession(){
 if(!session?.refresh_token)return;
 try{const data=await authRequest('token?grant_type=refresh_token',{refresh_token:session.refresh_token});saveSession(data)}catch(err){console.warn('Session refresh failed',err.message);saveSession(null)}
}
async function refreshAccount(){
 if(!session?.access_token){profile=null;authUi();return}
 try{
  const u=await fetch(AUTH+'/user',{headers:{apikey:cfg.publishableKey,Authorization:'Bearer '+session.access_token}});
  if(!u.ok){saveSession(null);profile=null;authUi();return}
  const user=await u.json();
  profile=(await api('profiles?select=*&id=eq.'+encodeURIComponent(user.id))).at(0)||null;
  isAdmin=(await api('admin_users?select=user_id&user_id=eq.'+encodeURIComponent(user.id))).length>0;
 }catch(err){console.warn(err);profile=null;isAdmin=false}
 authUi();
}
async function requireLogin(){if(!session?.access_token){showAuth();return false}if(!profile)await refreshAccount();return !!profile}
$('#ownerBtn').addEventListener('click',()=>session?openDashboard('myListings'):showAuth('signup'));$('#ownerCta').addEventListener('click',()=>session?openListing():showAuth('signup'));$('#mobileOwner').addEventListener('click',()=>session?openDashboard('myListings'):showAuth('signup'));
function activeDiscount(x){return x.discount_percent&&Number(x.discount_percent)>0&&x.discount_ends_at&&new Date(x.discount_ends_at)>new Date()}
function rentText(x){const discounted=activeDiscount(x);return discounted?money(Number(x.monthly_rent)*(1-Number(x.discount_percent)/100),x.currency_code)+' / month (was '+money(x.monthly_rent,x.currency_code)+')':money(x.monthly_rent,x.currency_code)+' / month'}
function renderListings(data=listings){
 const q=$('#q').value.trim().toLowerCase(),type=$('#type').value,country=$('#country').value,currency=$('#currency').value;
 let found=data.filter(x=>(!q||x.house_name.toLowerCase().includes(q)||String(x.trl_number||'').includes(q))&&(!type||x.room_type===type)&&(!country||x.country_code===country)&&(!currency||x.currency_code===currency));
 const root=$('#results');root.replaceChildren();
 if(!found.length){const box=document.createElement('div');box.className='empty';box.innerHTML='<div class="house">⌂</div><h3>No verified stays found.</h3><p>Try changing your search filters or check again later.</p>';root.append(box);return}
 found.forEach(x=>{
  const card=document.createElement('article');card.className='listing-card';
  const photo=document.createElement('div');photo.className='listing-photo';
  if(x.photo_urls?.[0]){const img=document.createElement('img');img.src=x.photo_urls[0];img.alt=x.house_name;img.loading='lazy';photo.append(img)}else photo.textContent='⌂';
  const body=document.createElement('div');body.className='listing-body';
  const h=document.createElement('h3');h.textContent=x.house_name;
  const p=document.createElement('p');p.textContent=[x.locality,x.city,x.country_code].filter(Boolean).join(', ');
  const meta=document.createElement('span');meta.className='listing-meta';meta.textContent=x.room_type+' · '+x.status;
  const rent=document.createElement('strong');rent.className='listing-rent';rent.textContent=rentText(x);
  const actions=document.createElement('div');actions.className='card-actions';
  const details=document.createElement('button');details.className='outline';details.textContent='View details';details.onclick=()=>showDetails(x.id);
  actions.append(details);
  if(x.status==='available'){const book=document.createElement('button');book.className='dark';book.textContent='Request booking';book.onclick=()=>requestBooking(x);actions.append(book)}
  body.append(h,p,meta,rent,actions);card.append(photo,body);root.append(card);
 });
}
async function loadListings(){
 try{listings=await api('listings?select=id,owner_id,trl_number,house_name,description,city,locality,country_code,currency_code,monthly_rent,deposit,room_type,suitable_for,amenities,photo_urls,status,discount_percent,discount_ends_at,created_at&status=in.(available,pending)&order=created_at.desc',{auth:false});renderListings()}
 catch(err){$('#results').innerHTML='<div class="empty"><h3>Listings could not be loaded.</h3><p>'+esc(err.message)+'</p></div>';console.error(err)}
}
$('#searchBtn').addEventListener('click',()=>{nearbyMode=false;renderListings();$('#explore').scrollIntoView({behavior:'smooth'})});
$('#q').addEventListener('keydown',e=>{if(e.key==='Enter')$('#searchBtn').click()});
['#type','#country','#currency'].forEach(s=>$(s).addEventListener('change',()=>{nearbyMode=false;renderListings()}));
$('#clearBtn').addEventListener('click',()=>{$('#q').value='';$('#type').value='';$('#country').value='';$('#currency').value='';nearbyMode=false;renderListings()});
async function showDetails(id){
 const x=listings.find(v=>v.id===id);if(!x)return;
 $('#detailContent').innerHTML='<label class="eyebrow">ROOM DETAILS</label><h2>'+esc(x.house_name)+'</h2><p>'+esc([x.locality,x.city,x.country_code].filter(Boolean).join(', '))+'</p><p><strong>'+esc(rentText(x))+'</strong></p><p>'+esc(x.description||'No description provided.')+'</p><p><b>'+esc(x.room_type)+'</b> · '+esc(x.status)+'</p><p>Suitable for: '+esc((x.suitable_for||[]).join(', ')||'Not specified')+'</p><p>Amenities: '+esc((x.amenities||[]).join(', ')||'Not specified')+'</p><div class="detail-photos">'+(x.photo_urls||[]).map(u=>'<img src="'+esc(u)+'" alt="Room photo">').join('')+'</div><p class="privacy-note">Owner contact and exact room directions are shared only after final booking confirmation.</p><button class="dark full" id="detailBook" '+(x.status!=='available'?'disabled':'')+'>Request booking</button>';
 const b=$('#detailBook');if(b&&!b.disabled)b.onclick=()=>requestBooking(x);
 modal('detailModal');
}
async function requestBooking(x){
 if(!await requireLogin())return;
 if(x.owner_id===session.user.id){toast('You cannot book your own listing.');return}
 if(!confirm('Send a booking request for '+x.house_name+'?'))return;
 try{await api('booking_requests',{method:'POST',body:{listing_id:x.id,seeker_id:session.user.id},prefer:'return=representation'});toast('Booking request sent to the owner.');modal('detailModal',false);await openDashboard('myBookings')}
 catch(err){toast(err.message)}
}
let dashTab='myListings';
async function openDashboard(tab='myListings'){
 if(!await requireLogin())return;
 dashTab=tab;$('#profileSummary').textContent=(profile?.display_name||'REHZO member')+' · '+(profile?.email||session.user?.email||'')+' · '+(profile?.country_code||'');
 $('#adminTab').hidden=!isAdmin;document.querySelectorAll('[data-dash]').forEach(b=>b.classList.toggle('active',b.dataset.dash===tab));
 modal('dashboardModal');await renderDashboard(tab);
}
document.querySelectorAll('[data-dash]').forEach(b=>b.addEventListener('click',()=>{dashTab=b.dataset.dash;document.querySelectorAll('[data-dash]').forEach(x=>x.classList.toggle('active',x===b));renderDashboard(dashTab)}));
async function renderDashboard(tab){
 const root=$('#dashContent');root.innerHTML='<p>Loading…</p>';
 try{
  if(tab==='myListings'){
   const rows=await api('listings?select=*&owner_id=eq.'+session.user.id+'&order=created_at.desc');
   root.innerHTML=rows.length?rows.map(x=>'<article class="dash-card"><div><b>'+esc(x.house_name)+'</b><p>'+esc(x.city)+' · '+esc(x.room_type)+' · '+esc(x.status)+'</p><strong>'+esc(rentText(x))+'</strong></div><div class="dash-card-actions"><button class="outline" data-discount="'+x.id+'">Set discount</button><button class="outline" data-status="'+x.id+'" data-value="'+(x.status==='available'?'pending':'available')+'">'+(x.status==='available'?'Mark pending':'Mark available')+'</button></div></article>').join(''):'<p>You have not published any listings yet.</p>';
   root.insertAdjacentHTML('beforeend','<button class="dark" id="newListingBtn">＋ Add a room</button>');
   $('#newListingBtn').onclick=()=>openListing();
   root.querySelectorAll('[data-status]').forEach(b=>b.onclick=async()=>{try{await api('listings?id=eq.'+b.dataset.status,{method:'PATCH',body:{status:b.dataset.value,updated_at:new Date().toISOString()},prefer:'return=representation'});toast('Listing updated.');renderDashboard('myListings');loadListings()}catch(e){toast(e.message)}});
   root.querySelectorAll('[data-discount]').forEach(b=>b.onclick=async()=>{const pct=prompt('Discount percentage (0 to remove):','10');if(pct===null)return;const days=pct==='0'?0:Number(prompt('Discount duration in days:','2'));if(!/^(?:100|[1-9]?\d)(?:\.\d{1,2})?$/.test(pct)||Number(pct)>100||(!Number.isFinite(days)||days<0)){toast('Enter a valid discount and duration.');return}try{await api('listings?id=eq.'+b.dataset.discount,{method:'PATCH',body:{discount_percent:Number(pct)||null,discount_ends_at:Number(pct)>0?new Date(Date.now()+days*86400000).toISOString():null},prefer:'return=representation'});toast('Discount saved.');renderDashboard('myListings');loadListings()}catch(e){toast(e.message)}});
  }else if(tab==='incoming'){
   const rows=await api('booking_requests?select=id,status,trl_number,requested_at,listing_id,listings(house_name,city,owner_id)&order=requested_at.desc');
   const own=rows.filter(x=>x.listings?.owner_id===session.user.id);
   root.innerHTML=own.length?own.map(x=>'<article class="dash-card"><div><b>'+esc(x.listings.house_name)+'</b><p>'+esc(x.listings.city)+' · '+esc(x.status)+'</p><small>'+new Date(x.requested_at).toLocaleString()+'</small></div><div class="dash-card-actions">'+(x.status==='pending'?'<button class="dark" data-accept="'+x.id+'">Accept</button><button class="outline" data-reject="'+x.id+'">Reject</button>':'<span class="listing-meta">'+esc(x.status)+'</span>')+'</div></article>').join(''):'<p>No booking requests received yet.</p>';
   root.querySelectorAll('[data-accept]').forEach(b=>b.onclick=()=>respondBooking(b.dataset.accept,'accepted'));
   root.querySelectorAll('[data-reject]').forEach(b=>b.onclick=()=>respondBooking(b.dataset.reject,'owner_rejected'));
  }else if(tab==='myBookings'){
   const rows=await api('booking_requests?select=id,status,trl_number,requested_at,finalised_at,listing_id,listings(house_name,city,owner_id)&seeker_id=eq.'+session.user.id+'&order=requested_at.desc');
   root.innerHTML=rows.length?rows.map(x=>'<article class="dash-card"><div><b>'+esc(x.listings?.house_name||'Stay')+'</b><p>'+esc(x.listings?.city||'')+' · '+esc(x.status)+'</p>'+(x.trl_number?'<strong>TRL: '+esc(x.trl_number)+'</strong>':'')+'</div><div class="dash-card-actions">'+(x.status==='accepted'?'<button class="dark" data-confirm="'+x.id+'">Final confirm</button><button class="outline" data-decline="'+x.id+'">Reject</button>':'')+(x.status==='final_confirmed'?'<button class="outline" data-contact="'+x.listing_id+'">Room directions & contact</button>':'')+'</div></article>').join(''):'<p>You have not sent any booking requests.</p>';
   root.querySelectorAll('[data-confirm]').forEach(b=>b.onclick=()=>finaliseBooking(b.dataset.confirm));
   root.querySelectorAll('[data-decline]').forEach(b=>b.onclick=()=>respondBooking(b.dataset.decline,'seeker_rejected'));
   root.querySelectorAll('[data-contact]').forEach(b=>b.onclick=()=>showConfirmedDetails(b.dataset.contact));
  }else if(tab==='tickets'){
   const rows=await api('support_tickets?select=*&user_id=eq.'+session.user.id+'&order=created_at.desc');
   root.innerHTML=rows.length?rows.map(x=>'<article class="dash-card"><div><b>'+esc(x.ticket_number||'Support ticket')+' · '+esc(x.subject)+'</b><p>'+esc(x.message)+'</p></div><span class="listing-meta">'+esc(x.status)+'</span></article>').join(''):'<p>No support tickets yet.</p>';
  }else if(tab==='admin'&&isAdmin){
   const [allListings,tickets,bookings]=await Promise.all([api('listings?select=id,house_name,city,status,owner_id&order=created_at.desc'),api('support_tickets?select=*&order=created_at.desc'),api('booking_requests?select=id,status,trl_number,requested_at&order=requested_at.desc')]);
   root.innerHTML='<h3>Admin overview</h3><div class="stats"><div><b>'+allListings.length+'</b><small>Listings</small></div><div><b>'+bookings.length+'</b><small>Bookings</small></div><div><b>'+tickets.filter(t=>t.status==='open').length+'</b><small>Open tickets</small></div></div><h3>Listings</h3>'+allListings.map(x=>'<article class="dash-card"><div><b>'+esc(x.house_name)+'</b><p>'+esc(x.city)+' · '+esc(x.status)+'</p></div><button class="outline" data-admin-remove="'+x.id+'">Remove</button></article>').join('')+'<h3>Support tickets</h3>'+tickets.map(x=>'<article class="dash-card"><div><b>'+esc(x.ticket_number)+' · '+esc(x.subject)+'</b><p>'+esc(x.status)+' — '+esc(x.message)+'</p></div><button class="outline" data-ticket-resolve="'+x.id+'">Resolve</button></article>').join('');
   root.querySelectorAll('[data-admin-remove]').forEach(b=>b.onclick=async()=>{if(!confirm('Remove this listing?'))return;try{await api('listings?id=eq.'+b.dataset.adminRemove,{method:'PATCH',body:{status:'booked'},prefer:'return=representation'});toast('Listing removed from public results.');renderDashboard('admin');loadListings()}catch(e){toast(e.message)}});
   root.querySelectorAll('[data-ticket-resolve]').forEach(b=>b.onclick=async()=>{try{await api('support_tickets?id=eq.'+b.dataset.ticketResolve,{method:'PATCH',body:{status:'resolved'},prefer:'return=representation'});renderDashboard('admin')}catch(e){toast(e.message)}});
  }
 }catch(err){root.innerHTML='<p class="error">'+esc(err.message)+'</p>'}
}
async function respondBooking(id,status){try{await api('booking_requests?id=eq.'+id,{method:'PATCH',body:{status},prefer:'return=representation'});toast(status==='accepted'?'Booking accepted. Waiting for user final confirmation.':'Booking updated.');renderDashboard(dashTab)}catch(e){toast(e.message)}}
async function finaliseBooking(id){if(!confirm('Final confirmation will reserve this room. The first confirmed booking wins. Continue?'))return;try{const rows=await api('booking_requests?id=eq.'+id,{method:'PATCH',body:{status:'final_confirmed'},prefer:'return=representation'});if(!rows?.length)throw new Error('Could not confirm. This room may already have been booked.');toast('Booking finally confirmed. Your 12-digit TRL is '+rows[0].trl_number);renderDashboard('myBookings');loadListings()}catch(e){toast(e.message)}}
async function showConfirmedDetails(listingId){
 try{
  const [details,loc]=await Promise.all([api('listing_private_details?select=contact_phone,contact_email&listing_id=eq.'+listingId),api('listing_locations?select=latitude,longitude&listing_id=eq.'+listingId)]);
  const p=details[0],g=loc[0];if(!p)throw new Error('Private contact details are not available.');
  let html='<label class="eyebrow">CONFIRMED BOOKING</label><h2>Owner contact</h2><p>Phone: '+esc(p.contact_phone||'Not provided')+'</p><p>Email: '+esc(p.contact_email||'Not provided')+'</p>';
  if(g)html+='<a class="dark full link-button" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination='+g.latitude+','+g.longitude+'">Open room directions</a>';else html+='<p>Owner has not added room GPS.</p>';
  $('#detailContent').innerHTML=html;modal('detailModal');
 }catch(e){toast(e.message)}
}
async function openListing(){
 if(!await requireLogin())return;
 modal('listingModal');$('#listingMessage').textContent='';$('#listingForm').reset();currentGps=null;$('#gpsMsg').textContent='GPS is optional. Exact coordinates stay private.';
}
$('#captureGps').addEventListener('click',()=>{if(!navigator.geolocation){$('#gpsMsg').textContent='GPS not supported. You can still continue.';return}$('#gpsMsg').textContent='Getting GPS…';navigator.geolocation.getCurrentPosition(pos=>{currentGps={latitude:pos.coords.latitude,longitude:pos.coords.longitude};$('#gpsMsg').textContent='Room GPS captured successfully.'},err=>{$('#gpsMsg').textContent=err.code===1?'Permission denied. You can still publish without GPS.':'GPS unavailable. You can still publish without GPS.'},{enableHighAccuracy:true,timeout:15000,maximumAge:0})});
async function uploadPhoto(file){
 if(file.type!=='image/webp')throw new Error('Only WebP photos are allowed.');
 if(file.size>3*1024*1024)throw new Error('Each photo must be 3 MB or smaller.');
 const path=session.user.id+'/'+crypto.randomUUID()+'.webp';
 const res=await fetch(STORAGE+'/object/room-photos/'+path,{method:'POST',headers:{apikey:cfg.publishableKey,Authorization:'Bearer '+session.access_token,'Content-Type':'image/webp','x-upsert':'false'},body:file});
 const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.message||'Photo upload failed.');
 return STORAGE+'/object/public/room-photos/'+path;
}
$('#listingForm').addEventListener('submit',async e=>{
 e.preventDefault();if(!await requireLogin())return;
 const b=e.submitter;b.disabled=true;$('#listingMessage').textContent='Saving your listing…';
 let listingId=null;
 try{
  const f=e.target,d=formData(f),photos=[...$('#listingPhotos').files];
  if(photos.length>3)throw new Error('You can upload a maximum of 3 photos.');
  const photoUrls=[];for(const file of photos)photoUrls.push(await uploadPhoto(file));
  const payload={owner_id:session.user.id,house_name:d.house_name.trim(),description:d.description.trim()||null,country_code:d.country_code,city:d.city.trim(),locality:d.locality.trim()||null,currency_code:d.currency_code,monthly_rent:Number(d.monthly_rent),deposit:d.deposit?Number(d.deposit):null,room_type:d.room_type,suitable_for:[...f.querySelectorAll('[name="suitable_for"]:checked')].map(x=>x.value),amenities:[...f.querySelectorAll('[name="amenities"]:checked')].map(x=>x.value),photo_urls:photoUrls,status:'available'};
  const created=await api('listings',{method:'POST',body:payload,prefer:'return=representation'});listingId=created[0].id;
  await api('listing_private_details',{method:'POST',body:{listing_id:listingId,owner_id:session.user.id,contact_phone:d.contact_phone.trim(),contact_email:d.contact_email.trim()},prefer:'return=representation'});
  if(currentGps){
   await api('listing_locations',{method:'POST',body:{listing_id:listingId,owner_id:session.user.id,latitude:currentGps.latitude,longitude:currentGps.longitude},prefer:'return=representation'});
   await api('listing_search_areas',{method:'POST',body:{listing_id:listingId,owner_id:session.user.id,latitude_approx:Number(currentGps.latitude.toFixed(2)),longitude_approx:Number(currentGps.longitude.toFixed(2))},prefer:'return=representation'});
  }
  await api('profiles?id=eq.'+session.user.id,{method:'PATCH',body:{account_type:'owner',phone_number:d.contact_phone.trim()},prefer:'return=representation'});
  await refreshAccount();modal('listingModal',false);toast('Your room listing is published.');await loadListings();await openDashboard('myListings');
 }catch(err){$('#listingMessage').textContent=err.message;if(listingId){try{await api('listings?id=eq.'+listingId,{method:'DELETE'})}catch{}}}
 finally{b.disabled=false}
});
async function findNearby(){
 const out=$('#locationMsg');if(!navigator.geolocation){out.textContent='Location is not supported. Search manually.';return}
 out.textContent='Waiting for location permission…';
 navigator.geolocation.getCurrentPosition(async pos=>{
  out.textContent='Searching nearby stays…';
  try{
   const areas=await api('listing_search_areas?select=listing_id,latitude_approx,longitude_approx',{auth:false});
   const hav=(a,b,c,d)=>{const r=6371,p=Math.PI/180,dy=(c-a)*p,dx=(d-b)*p;return 2*r*Math.asin(Math.sqrt(Math.sin(dy/2)**2+Math.cos(a*p)*Math.cos(c*p)*Math.sin(dx/2)**2))};
   const ids=new Set(areas.filter(a=>hav(pos.coords.latitude,pos.coords.longitude,a.latitude_approx,a.longitude_approx)<=2).map(a=>a.listing_id));
   const near=listings.filter(x=>ids.has(x.id)&&x.status==='available');
   nearbyMode=true;renderListings(near);out.textContent=near.length?near.length+' available stays found near your location.':'No available stays found nearby. Try normal search.';
   $('#explore').scrollIntoView({behavior:'smooth'});
  }catch(e){out.textContent='Nearby search unavailable. You can still search manually.';toast(e.message)}
 },e=>{out.textContent=e.code===1?'Location permission denied. You can still search manually.':'Could not get location. Check your device location settings.'},{enableHighAccuracy:true,timeout:15000,maximumAge:60000});
}
$('#nearBtn').addEventListener('click',findNearby);$('#mobileNear').addEventListener('click',()=>{findNearby();$('.near').scrollIntoView({behavior:'smooth'})});
$('#dashboardBtn').addEventListener('click',()=>openDashboard());$('#logoutBtn').addEventListener('click',async()=>{try{await fetch(AUTH+'/logout',{method:'POST',headers:{apikey:cfg.publishableKey,...authHeaders()}})}catch{}saveSession(null);profile=null;isAdmin=false;authUi();modal('dashboardModal',false);toast('Logged out.')});
$('#supportNew').addEventListener('click',()=>{modal('ticketModal');$('#ticketMessage').textContent=''});
$('#ticketForm').addEventListener('submit',async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{const d=formData(e.target);const rows=await api('support_tickets',{method:'POST',body:{user_id:session.user.id,subject:d.subject.trim(),message:d.message.trim()},prefer:'return=representation'});$('#ticketMessage').textContent='Ticket created: '+rows[0].ticket_number;e.target.reset();await renderDashboard('tickets')}catch(err){$('#ticketMessage').textContent=err.message}finally{b.disabled=false}});
async function init(){authUi();await refreshSession();await refreshAccount();authUi();await loadListings()}
init();
