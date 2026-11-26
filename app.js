const $=s=>document.querySelector(s);
const cfg=window.REHZO_SUPABASE;
$('#year').textContent=new Date().getFullYear();
document.querySelectorAll('[data-modal]').forEach(b=>b.addEventListener('click',()=>$('#'+b.dataset.modal).classList.add('open')));
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>b.closest('.modal').classList.remove('open')));
document.querySelectorAll('.modal').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)m.classList.remove('open')}));
document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelectorAll('.modal').forEach(m=>m.classList.remove('open'));});
let listings=[];
const results=$('#results');
function money(amount,currency){try{return new Intl.NumberFormat(undefined,{style:'currency',currency:currency||'INR',maximumFractionDigits:0}).format(amount)}catch{return String(amount)}}
function render(){
 const q=$('#q').value.trim().toLowerCase(),type=$('#type').value,country=$('#country').value,currency=$('#currency').value;
 const found=listings.filter(x=>(!q||x.house_name.toLowerCase().includes(q)||String(x.trl_number||'').includes(q))&&(!type||x.room_type===type)&&(!country||x.country_code===country||x.country_code==='IN'&&country==='India')&&(!currency||x.currency_code===currency));
 results.replaceChildren();
 if(!found.length){const h=document.createElement('div');h.className='house';h.textContent='⌂';const title=document.createElement('h3');title.textContent=listings.length?'No matching stays found.':'No verified listings available yet.';const p=document.createElement('p');p.textContent='Only real listings from REHZO 99 are shown here. Please check again later.';results.append(h,title,p);return}
 found.forEach(x=>{
  const card=document.createElement('article');card.className='listing-card';
  const photo=document.createElement('div');photo.className='listing-photo';
  if(Array.isArray(x.photo_urls)&&x.photo_urls[0]){const img=document.createElement('img');img.src=x.photo_urls[0];img.alt=x.house_name;img.loading='lazy';photo.append(img)}else{photo.textContent='⌂'}
  const body=document.createElement('div');body.className='listing-body';
  const name=document.createElement('h3');name.textContent=x.house_name;
  const place=document.createElement('p');place.textContent=[x.locality,x.city,x.country_code].filter(Boolean).join(', ');
  const meta=document.createElement('span');meta.className='listing-meta';meta.textContent=x.room_type+' · '+x.status;
  const rent=document.createElement('strong');rent.className='listing-rent';rent.textContent=money(x.monthly_rent,x.currency_code)+' / month';
  body.append(name,place,meta,rent);card.append(photo,body);results.append(card);
 });
}
async function loadListings(){
 try{
  const response=await fetch(cfg.url+'/rest/v1/listings?select=id,trl_number,house_name,city,locality,country_code,currency_code,monthly_rent,room_type,photo_urls,status,discount_percent,discount_ends_at&status=in.(available,pending)&order=created_at.desc',{headers:{apikey:cfg.publishableKey,Authorization:'Bearer '+cfg.publishableKey}});
  if(!response.ok)throw new Error('Listings service is not available yet.');
  listings=await response.json();render();
 }catch(err){results.replaceChildren();const h=document.createElement('h3');h.textContent='Listings are temporarily unavailable.';const p=document.createElement('p');p.textContent='Please try again later. No sample listings are displayed.';results.append(h,p);console.error(err)}
}
$('#search').addEventListener('click',()=>{render();results.scrollIntoView({behavior:'smooth',block:'center'})});
$('#q').addEventListener('keydown',e=>{if(e.key==='Enter'){render();results.scrollIntoView({behavior:'smooth',block:'center'})}});
['#type','#country','#currency'].forEach(s=>$(s).addEventListener('change',render));
$('#clear').addEventListener('click',()=>{$('#q').value='';$('#type').value='';$('#country').value='';$('#currency').value='';render()});
function locate(){const out=$('#location');if(!navigator.geolocation){out.textContent='Location is not supported by this browser.';return;}out.textContent='Waiting for location permission…';navigator.geolocation.getCurrentPosition(()=>out.textContent='Location permission received. Nearby matching will be available when room coordinates are added to listings.',e=>out.textContent=e.code===1?'Permission denied. You can still search manually.':'Could not get location. Check device location settings and try again.',{enableHighAccuracy:true,timeout:12000,maximumAge:60000});}
$('#near').addEventListener('click',locate);$('#mobileNear').addEventListener('click',()=>{locate();$('.near').scrollIntoView({behavior:'smooth'})});
loadListings();