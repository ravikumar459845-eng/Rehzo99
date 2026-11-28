// ================= PWA CACHE CLEANUP =================
// This repository has no sw.js. Remove any older worker/cache so it cannot
// keep serving stale JavaScript after a production update.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.getRegistrations().then(function(registrations) {
      registrations.forEach(function(registration) { registration.unregister().catch(function() {}); });
    }).catch(function() {});
  });
}
if ('caches' in window) {
  window.addEventListener('load', function() {
    caches.keys().then(function(keys) {
      keys.filter(function(key) { return key.indexOf('rehzo99') !== -1 || key.indexOf('rehzu') !== -1; })
        .forEach(function(key) { caches.delete(key).catch(function() {}); });
    }).catch(function() {});
  });
}

// ================= SUPABASE CLIENT INITIALIZATION =================
var SUPABASE_URL = "https://fbjclsnxcxorkzbcgelv.supabase.co";
var SUPABASE_KEY = "sb_publishable_Adcr-hbVYN6YBQ3e5VqFcA_IrJboYzY";
var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Realtime app presence uses an anonymous per-tab key; no user ID, phone or email
// is sent to the shared presence channel.
var rehzuPresenceChannel = null;
var rehzuPresenceKey = 'session-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
var adminRealtimeChannel = null;
var adminPresenceChannel = null;
var adminRealtimeRefreshTimer = null;
var adminRealtimeRefreshRunning = false;
var adminRealtimeRefreshQueued = false;
var adminRealtimeReconnectTimer = null;
// Ensure the first Admin Panel render always fetches fresh, server-authorized data.
var adminEntryRefreshInProgress = false;
var adminEntryDataLoaded = false;

function updateAdminLivePresenceCount() {
  if (!adminPresenceChannel) return;
  var state = adminPresenceChannel.presenceState() || {};
  var count = Object.keys(state).reduce(function(total, key) {
    var entries = state[key];
    return total + (Array.isArray(entries) ? entries.length : 1);
  }, 0);
  DB.liveUsersCount = count;
  adminDashboardSet('adminLiveUsersCount', count);
  adminDashboardSet('adminTrafficLiveStatus', count + ' online');
}

async function startRehzuPresence() {
  if (rehzuPresenceChannel) return;
  var sessionResult = await sb.auth.getSession();
  if (!sessionResult.data || !sessionResult.data.session) return;
  var channel = sb.channel('rehzu:app-presence', {
    config: { private: true, presence: { key: rehzuPresenceKey } }
  });
  rehzuPresenceChannel = channel;
  channel.subscribe(async function(status) {
    if (status === 'SUBSCRIBED') {
      try { await channel.track({ online: true }); } catch (err) {
        console.warn('Presence tracking unavailable:', err);
      }
    }
  });
}

function stopRehzuPresence() {
  if (!rehzuPresenceChannel) return;
  var channel = rehzuPresenceChannel;
  rehzuPresenceChannel = null;
  sb.removeChannel(channel);
}

function queueAdminRealtimeRefresh() {
  if (adminRealtimeRefreshRunning) {
    adminRealtimeRefreshQueued = true;
    return;
  }
  if (adminRealtimeRefreshTimer) return;
  adminRealtimeRefreshTimer = setTimeout(async function() {
    adminRealtimeRefreshTimer = null;
    var view = document.getElementById('view-admin');
    if (!view || !view.classList.contains('active') || document.hidden) return;
    adminRealtimeRefreshRunning = true;
    var startedAt = Date.now();
    try {
      await syncFromSupabase();
      adminDashboardSet('adminResponseTime', Math.max(0, Date.now() - startedAt) + ' ms');
      adminDashboardSet('adminLastRefresh', 'Live update · ' + new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }));
    } catch (err) {
      console.warn('Admin live refresh failed:', err);
    } finally {
      adminRealtimeRefreshRunning = false;
      if (adminRealtimeRefreshQueued) {
        adminRealtimeRefreshQueued = false;
        queueAdminRealtimeRefresh();
      }
    }
  }, 250);
}

function startAdminRealtimeSubscriptions() {
  if (!adminRealtimeChannel) {
    var channel = sb.channel('rehzu:admin-dashboard', { config: { private: true } });
    adminRealtimeChannel = channel;
    channel
      .on('broadcast', { event: 'platform_changed' }, function() {
        queueAdminRealtimeRefresh();
      })
      .subscribe(function(status) {
        if (status === 'SUBSCRIBED') {
          if (adminRealtimeReconnectTimer) {
            clearTimeout(adminRealtimeReconnectTimer);
            adminRealtimeReconnectTimer = null;
          }
          adminDashboardSet('adminDatabaseLiveStatus', 'Connected');
          adminDashboardSet('adminLastRefresh', 'Live updates connected');
          queueAdminRealtimeRefresh();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          // Realtime is retried independently; database RPC health remains separate.
          if (adminRealtimeChannel === channel) adminRealtimeChannel = null;
          try { sb.removeChannel(channel); } catch (removeError) {}
          adminDashboardSet('adminLastRefresh', 'Database connected · reconnecting live updates');
          if (!adminRealtimeReconnectTimer) {
            adminRealtimeReconnectTimer = setTimeout(function() {
              adminRealtimeReconnectTimer = null;
              var view = document.getElementById('view-admin');
              if (view && view.classList.contains('active') && !document.hidden) startAdminRealtimeSubscriptions();
            }, 3000);
          }
        }
      });
  }
  if (!adminPresenceChannel) {
    adminPresenceChannel = sb.channel('rehzu:app-presence', { config: { private: true } })
      .on('presence', { event: 'sync' }, updateAdminLivePresenceCount)
      .on('presence', { event: 'join' }, updateAdminLivePresenceCount)
      .on('presence', { event: 'leave' }, updateAdminLivePresenceCount)
      .subscribe(function(status) {
        if (status === 'SUBSCRIBED') updateAdminLivePresenceCount();
      });
  }
}

function stopAdminRealtimeSubscriptions() {
  if (adminRealtimeReconnectTimer) {
    clearTimeout(adminRealtimeReconnectTimer);
    adminRealtimeReconnectTimer = null;
  }
  if (adminRealtimeRefreshTimer) {
    clearTimeout(adminRealtimeRefreshTimer);
    adminRealtimeRefreshTimer = null;
  }
  if (adminRealtimeChannel) {
    var channel = adminRealtimeChannel;
    adminRealtimeChannel = null;
    sb.removeChannel(channel);
  }
  if (adminPresenceChannel) {
    var presence = adminPresenceChannel;
    adminPresenceChannel = null;
    sb.removeChannel(presence);
  }
}

sb.auth.onAuthStateChange(function(event, session) {
  if (session) {
    if (sessionStorage.getItem('rehzu_open_support_after_login') === '1') {
      sessionStorage.removeItem('rehzu_open_support_after_login');
      setTimeout(function() { openSupportView(); }, 700);
    }
    setTimeout(function() { startRehzuPresence().catch(function(err) {
      console.warn('Presence startup unavailable:', err);
    }); }, 0);
  } else {
    stopRehzuPresence();
    stopAdminRealtimeSubscriptions();
  }
});

// ================= AUTOMATIC CLIENT-SIDE IMAGE COMPRESSOR =================
// Room-photo allowlist: raster JPEG, PNG and WebP only. SVG/GIF/HTML and
// executable or unknown formats are rejected. Never trust file.name or file.type alone.
const REHZU_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
function rehzuDetectImageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
      bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) return 'image/png';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return '';
}
async function compressImageFile(file, maxWidth = 1600, quality = 0.88) {
  if (!file || !Number.isFinite(file.size) || file.size <= 0 || file.size > REHZU_IMAGE_MAX_BYTES) {
    throw new Error('Photo must be between 1 byte and 5 MB.');
  }
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const detectedType = rehzuDetectImageType(bytes);
  if (!detectedType || (file.type && file.type !== detectedType)) {
    throw new Error('Only genuine JPEG, PNG or WebP photos are allowed.');
  }
  // Decode then re-encode to strip metadata/polyglot payloads. Keep detail first;
  // reduce quality/resolution only as needed to target a compact ~450 KB upload.
  const sourceUrl = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('The selected file is not a valid image.'));
      img.src = sourceUrl;
    });
    if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth > 10000 || img.naturalHeight > 10000 ||
        img.naturalWidth * img.naturalHeight > 40000000) {
      throw new Error('Photo dimensions are too large.');
    }
    let scale = Math.min(1, maxWidth / img.naturalWidth, 1600 / img.naturalHeight);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Photo processing is not supported on this device.');
    const qualities = [quality, 0.84, 0.80, 0.76, 0.72, 0.70];
    let blob = null;
    for (let attempt = 0; attempt < qualities.length; attempt++) {
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', qualities[attempt]));
      if (!blob || blob.type !== 'image/webp' || blob.size <= 0) {
        throw new Error('Could not safely process this photo.');
      }
      if (blob.size <= 450 * 1024) break;
      if (attempt >= 2) scale *= 0.88;
    }
    if (!blob || blob.size > REHZU_IMAGE_MAX_BYTES) {
      throw new Error('Photo could not be compressed to a safe size. Please choose another photo.');
    }
    return new File([blob], 'room-photo.webp', { type: 'image/webp', lastModified: Date.now() });
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}
function cleanText(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;')
    .trim();
}

function safeImageUrl(value) {
  try {
    var raw = String(value || '').trim();
    var parsed = new URL(raw, window.location.origin);
    if (parsed.protocol === 'https:') return parsed.href;
    if (parsed.protocol === 'blob:' && parsed.origin === window.location.origin) return parsed.href;
  } catch (e) {}
  return 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=600';
}

function safeUserError(error, fallback) {
  var raw = String(error && error.message ? error.message : error || '');
  // Never show SQL, schema, storage paths, tokens, stack traces or provider internals to users.
  if (/too many login attempts|wait 15 minutes/i.test(raw)) return 'Too many login attempts. Please wait 15 minutes and try again.';
  if (/invalid login details/i.test(raw)) return 'Login details are incorrect. Please check and try again.';
  if (/not authorized|administrator access required|permission denied/i.test(raw)) return 'You do not have permission to perform this action.';
  if (/already has an active booking request|already has an active booking/i.test(raw)) return 'A booking request is already pending for this room. Please check My Bookings for updates.';
  if (/no longer available/i.test(raw)) return 'This room is no longer available. It may have been booked, expired, or removed by the owner.';
  if (/valid image|photo|image|dimensions|compress/i.test(raw)) return raw.slice(0, 180);
  return fallback || 'Something went wrong. Please try again.';
}

function validateTextField(value, min, max) {
  var text = String(value == null ? '' : value).trim();
  return text.length >= min && text.length <= max && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text);
}

function safeMoney(value, minimum, maximum) {
  var n = Number(value);
  return Number.isFinite(n) && n >= minimum && n <= maximum;
}

function safeInlineToken(value) {
  var token = String(value === null || value === undefined ? '' : value);
  return /^[A-Za-z0-9_-]{1,80}$/.test(token) ? token : '';
}

function normalizePhoneDigits(phoneStr) {
  if (!phoneStr) return '';
  return String(phoneStr).replace(/\D/g, '').slice(-10);
}

var WORLD_COUNTRIES = `AD~Andorra~+376~€|AE~United Arab Emirates~+971~AED|AF~Afghanistan~+93~AFN|AG~Antigua and Barbuda~+1268~EC$|AI~Anguilla~+1264~EC$|AL~Albania~+355~ALL|AM~Armenia~+374~AMD|AO~Angola~+244~AOA|AQ~Antarctica~—~—|AR~Argentina~+54~ARS|AS~American Samoa~+1684~$|AT~Austria~+43~€|AU~Australia~+61~A$|AW~Aruba~+297~AWG|AX~Åland Islands~+358~EUR|AZ~Azerbaijan~+994~AZN|BA~Bosnia and Herzegovina~+387~BAM|BB~Barbados~+1246~BBD|BD~Bangladesh~+880~BDT|BE~Belgium~+32~€|BF~Burkina Faso~+226~F CFA|BG~Bulgaria~+359~BGN|BH~Bahrain~+973~BHD|BI~Burundi~+257~BIF|BJ~Benin~+229~F CFA|BL~Saint Barthélemy~+590~€|BM~Bermuda~+1441~BMD|BN~Brunei Darussalam~+673~BND|BO~Bolivia, Plurinational State of~+591~BOB|BQ~Bonaire, Sint Eustatius and Saba~+599~USD|BR~Brazil~+55~R$|BS~Bahamas~+1242~BSD|BT~Bhutan~+975~BTN|BV~Bouvet Island~—~—|BW~Botswana~+267~BWP|BY~Belarus~+375~BYN|BZ~Belize~+501~BZD|CA~Canada~+1~C$|CC~Cocos (Keeling) Islands~+61~A$|CD~Congo, The Democratic Republic of the~+243~CDF|CF~Central African Republic~+236~FCFA|CG~Congo~+242~FCFA|CH~Switzerland~+41~CHF|CI~Côte d'Ivoire~+225~F CFA|CK~Cook Islands~+682~NZ$|CL~Chile~+56~CLP|CM~Cameroon~+237~FCFA|CN~China~+86~¥|CO~Colombia~+57~COP|CR~Costa Rica~+506~CRC|CU~Cuba~+53~CUP|CV~Cabo Verde~+238~CVE|CW~Curaçao~+599~ANG|CX~Christmas Island~+61~A$|CY~Cyprus~+357~€|CZ~Czechia~+420~CZK|DE~Germany~+49~€|DJ~Djibouti~+253~DJF|DK~Denmark~+45~DKK|DM~Dominica~+1767~EC$|DO~Dominican Republic~+1809~DOP|DZ~Algeria~+213~DZD|EC~Ecuador~+593~$|EE~Estonia~+372~€|EG~Egypt~+20~EGP|EH~Western Sahara~+212~MAD|ER~Eritrea~+291~ERN|ES~Spain~+34~€|ET~Ethiopia~+251~ETB|FI~Finland~+358~€|FJ~Fiji~+679~FJD|FK~Falkland Islands (Malvinas)~+500~FKP|FM~Micronesia, Federated States of~+691~$|FO~Faroe Islands~+298~DKK|FR~France~+33~€|GA~Gabon~+241~FCFA|GB~United Kingdom~+44~£|GD~Grenada~+1473~EC$|GE~Georgia~+995~GEL|GF~French Guiana~+594~€|GG~Guernsey~+44~£|GH~Ghana~+233~GHS|GI~Gibraltar~+350~GIP|GL~Greenland~+299~DKK|GM~Gambia~+220~GMD|GN~Guinea~+224~GNF|GP~Guadeloupe~+590~€|GQ~Equatorial Guinea~+240~FCFA|GR~Greece~+30~€|GS~South Georgia and the South Sandwich Islands~+500~£|GT~Guatemala~+502~GTQ|GU~Guam~+1671~$|GW~Guinea-Bissau~+245~F CFA|GY~Guyana~+592~GYD|HK~Hong Kong~+852~HK$|HM~Heard Island and McDonald Islands~—~AUD|HN~Honduras~+504~HNL|HR~Croatia~+385~€|HT~Haiti~+509~HTG|HU~Hungary~+36~HUF|ID~Indonesia~+62~IDR|IE~Ireland~+353~€|IL~Israel~+972~₪|IM~Isle of Man~+44~£|IN~India~+91~₹|IO~British Indian Ocean Territory~+246~$|IQ~Iraq~+964~IQD|IR~Iran, Islamic Republic of~+98~IRR|IS~Iceland~+354~ISK|IT~Italy~+39~€|JE~Jersey~+44~£|JM~Jamaica~+1876~JMD|JO~Jordan~+962~JOD|JP~Japan~+81~¥|KE~Kenya~+254~KES|KG~Kyrgyzstan~+996~KGS|KH~Cambodia~+855~KHR|KI~Kiribati~+686~A$|KM~Comoros~+269~KMF|KN~Saint Kitts and Nevis~+1869~EC$|KP~Korea, Democratic People's Republic of~+850~KPW|KR~Korea, Republic of~+82~₩|KW~Kuwait~+965~KWD|KY~Cayman Islands~+1345~KYD|KZ~Kazakhstan~+7~KZT|LA~Lao People's Democratic Republic~+856~LAK|LB~Lebanon~+961~LBP|LC~Saint Lucia~+1758~EC$|LI~Liechtenstein~+423~CHF|LK~Sri Lanka~+94~LKR|LR~Liberia~+231~LRD|LS~Lesotho~+266~LSL|LT~Lithuania~+370~€|LU~Luxembourg~+352~€|LV~Latvia~+371~€|LY~Libya~+218~LYD|MA~Morocco~+212~MAD|MC~Monaco~+377~€|MD~Moldova, Republic of~+373~MDL|ME~Montenegro~+382~€|MF~Saint Martin (French part)~+590~€|MG~Madagascar~+261~MGA|MH~Marshall Islands~+692~$|MK~North Macedonia~+389~MKD|ML~Mali~+223~F CFA|MM~Myanmar~+95~MMK|MN~Mongolia~+976~MNT|MO~Macao~+853~MOP|MP~Northern Mariana Islands~+1670~$|MQ~Martinique~+596~€|MR~Mauritania~+222~MRU|MS~Montserrat~+1664~EC$|MT~Malta~+356~€|MU~Mauritius~+230~MUR|MV~Maldives~+960~MVR|MW~Malawi~+265~MWK|MX~Mexico~+52~MX$|MY~Malaysia~+60~RM|MZ~Mozambique~+258~MZN|NA~Namibia~+264~NAD|NC~New Caledonia~+687~CFPF|NE~Niger~+227~F CFA|NF~Norfolk Island~+672~A$|NG~Nigeria~+234~NGN|NI~Nicaragua~+505~NIO|NL~Netherlands~+31~€|NO~Norway~+47~NOK|NP~Nepal~+977~NPR|NR~Nauru~+674~A$|NU~Niue~+683~NZ$|NZ~New Zealand~+64~NZ$|OM~Oman~+968~OMR|PA~Panama~+507~PAB|PE~Peru~+51~PEN|PF~French Polynesia~+689~CFPF|PG~Papua New Guinea~+675~PGK|PH~Philippines~+63~₱|PK~Pakistan~+92~PKR|PL~Poland~+48~PLN|PM~Saint Pierre and Miquelon~+508~€|PN~Pitcairn~+64~NZ$|PR~Puerto Rico~+1787~$|PS~Palestine, State of~+970~ILS|PT~Portugal~+351~€|PW~Palau~+680~$|PY~Paraguay~+595~PYG|QA~Qatar~+974~QAR|RE~Réunion~+262~€|RO~Romania~+40~RON|RS~Serbia~+381~RSD|RU~Russian Federation~+7~₽|RW~Rwanda~+250~RWF|SA~Saudi Arabia~+966~SAR|SB~Solomon Islands~+677~SBD|SC~Seychelles~+248~SCR|SD~Sudan~+249~SDG|SE~Sweden~+46~SEK|SG~Singapore~+65~S$|SH~Saint Helena, Ascension and Tristan da Cunha~+290~SHP|SI~Slovenia~+386~€|SJ~Svalbard and Jan Mayen~+4779~NOK|SK~Slovakia~+421~€|SL~Sierra Leone~+232~SLL|SM~San Marino~+378~€|SN~Senegal~+221~F CFA|SO~Somalia~+252~SOS|SR~Suriname~+597~SRD|SS~South Sudan~+211~SSP|ST~Sao Tome and Principe~+239~STN|SV~El Salvador~+503~$|SX~Sint Maarten (Dutch part)~+1721~ANG|SY~Syrian Arab Republic~+963~SYP|SZ~Eswatini~+268~SZL|TC~Turks and Caicos Islands~+1649~USD|TD~Chad~+235~FCFA|TF~French Southern Territories~—~EUR|TG~Togo~+228~F CFA|TH~Thailand~+66~THB|TJ~Tajikistan~+992~TJS|TK~Tokelau~+690~NZ$|TL~Timor-Leste~+670~$|TM~Turkmenistan~+993~TMT|TN~Tunisia~+216~TND|TO~Tonga~+676~TOP|TR~Türkiye~+90~₺|TT~Trinidad and Tobago~+1868~TTD|TV~Tuvalu~+688~A$|TW~Taiwan, Province of China~+886~NT$|TZ~Tanzania, United Republic of~+255~TZS|UA~Ukraine~+380~UAH|UG~Uganda~+256~UGX|UM~United States Minor Outlying Islands~+1~$|US~United States~+1~$|UY~Uruguay~+598~UYU|UZ~Uzbekistan~+998~UZS|VA~Holy See (Vatican City State)~+39~€|VC~Saint Vincent and the Grenadines~+1784~EC$|VE~Venezuela, Bolivarian Republic of~+58~VES|VG~Virgin Islands, British~+1284~$|VI~Virgin Islands, U.S.~+1340~$|VN~Viet Nam~+84~₫|VU~Vanuatu~+678~VUV|WF~Wallis and Futuna~+681~CFPF|WS~Samoa~+685~WST|XK~Kosovo~+383~€|YE~Yemen~+967~YER|YT~Mayotte~+262~€|ZA~South Africa~+27~R|ZM~Zambia~+260~ZMW|ZW~Zimbabwe~+263~$`.split('|').map(function(row) { var p = row.split('~'); return { code:p[0], name:p[1], dial:p[2], sym:p[3] }; });

var detectedCountryCode = 'IN';

function getCurrencySymbol(cCode) {
  var c = WORLD_COUNTRIES.find(function(item){ return item.code === cCode; });
  return c ? c.sym : '—';
}

function populateCountryDropdowns() {
  var cf = document.getElementById('countryFilter');
  if (cf) {
    cf.innerHTML = '';
    WORLD_COUNTRIES.forEach(function(c) {
      var opt = document.createElement('option');
      opt.value = c.code;
      opt.textContent = c.name + ' (' + c.dial + ' / ' + c.sym + ')';
      cf.appendChild(opt);
    });
  }
}

function readRehzuCurrentUserSession() {
  try {
    var raw = sessionStorage.getItem('rehzu_current_user');
    if (!raw) return null;
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sessionStorage.removeItem('rehzu_current_user');
      return null;
    }
    return parsed;
  } catch (error) {
    // A malformed or blocked session cache must not prevent the public app from starting.
    try { sessionStorage.removeItem('rehzu_current_user'); } catch (_) {}
    console.warn('REHZO 99 session cache was reset because it could not be read.');
    return null;
  }
}

var DB = {
  currentUser: readRehzuCurrentUserSession(),
  listings: [],
  bookings: [],
  profiles: [],
  totalProfilesCount: 0
};

var userGeo = { lat: null, lng: null };
var lockedMapCoord = { lat: null, lng: null };
var roomAddressMapReady = false;
var currentEditGpsRoomId = '';
var currentEditGpsCoord = null;
var currentBookingsTab = 'current';
var currentOwnerTab = 'rooms';
var currentAdminSubTab = 'owners';
var uploadedPhotoFiles = [];
var editUploadedPhotoFiles = [];
var currentEditListingPhotos = [];
var selectedSuitable = ['Family'];
var selectedAmenities = ['Wi-Fi', 'Parking'];
var selectedRules = ['No Smoking'];
var activeBookingRoom = null;
var matchedBookingId = null;

var registrationGoogleVerifiedEmail = null;
var recoveryFoundUser = null;
var currentLoginMode = 'uid';

var detectedCountryProof = '';
var countryProofExpiresAt = 0;
var countryVerified = false;

function getFreshDeviceCoordinates(maxAccuracyMeters) {
  return new Promise(function(resolve, reject) {
    if (!window.isSecureContext) {
      reject(new Error('Location requires a secure HTTPS connection. Open REHZO 99 using its HTTPS address.'));
      return;
    }
    if (!navigator.geolocation) {
      reject(new Error('This browser does not provide location services. Enable location services or use a phone with location enabled.'));
      return;
    }
    var accuracyLimit = Number.isFinite(Number(maxAccuracyMeters)) ? Number(maxAccuracyMeters) : 2500;
    var settled = false;

    function finishPosition(position, sourceLabel) {
      if (settled) return;
      var coords = position && position.coords ? position.coords : {};
      var lat = Number(coords.latitude);
      var lng = Number(coords.longitude);
      var accuracy = Number(coords.accuracy);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
          lat < -90 || lat > 90 || lng < -180 || lng > 180 ||
          !Number.isFinite(accuracy) || accuracy <= 0 || accuracy > accuracyLimit) {
        settled = true;
        reject(new Error('Location accuracy is ' + (Number.isFinite(accuracy) ? Math.round(accuracy) + ' m' : 'unavailable') +
          '. REHZO 99 needs accuracy within ' + accuracyLimit + ' m. Turn on Windows Location and allow location access in your browser, then retry.'));
        return;
      }
      settled = true;
      resolve({ latitude: lat, longitude: lng, accuracy: accuracy, source: sourceLabel });
    }

    function handleFirstError(error) {
      if (settled) return;
      if (error && error.code === 1) {
        settled = true;
        reject(new Error('Location permission is blocked. Allow location access for ' + location.hostname + ' in your browser and device settings, then reload.'));
        return;
      }
      // Many laptops have no GPS chip. Retry once using the browser/OS
      // network-location provider (Wi-Fi and system location services).
      // This is still a fresh browser geolocation fix; IP-only lookup is never used.
      navigator.geolocation.getCurrentPosition(
        function(position) { finishPosition(position, 'browser-network-location'); },
        function(fallbackError) {
          if (settled) return;
          settled = true;
          if (fallbackError && fallbackError.code === 1) {
            reject(new Error('Location permission is blocked. Allow location access for ' + location.hostname + ' in your browser and device settings, then reload.'));
          } else if (fallbackError && fallbackError.code === 3) {
            reject(new Error('Laptop location timed out. Turn on Windows Location, connect to Wi-Fi, allow location for REHZO 99 in Chrome/Edge, and retry.'));
          } else {
            reject(new Error('Laptop location is unavailable. Many laptops do not have GPS hardware; turn on Windows Location and Wi-Fi so your browser can estimate location.'));
          }
        },
        { enableHighAccuracy: false, timeout: 25000, maximumAge: 0 }
      );
    }

    // Try a fresh high-accuracy fix first; if a laptop has no GPS receiver,
    // fall back to its OS/browser network-location provider without using IP geolocation.
    navigator.geolocation.getCurrentPosition(
      function(position) { finishPosition(position, 'device-high-accuracy'); },
      handleFirstError,
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  });
}

async function autoDetectUserCountry(coordsOverride) {
  try {
    // Country is derived from a fresh, consented device GPS fix. The server
    // issues a proof only after checking that result against network country.
    var coords = coordsOverride || await getFreshDeviceCoordinates();
    // Keep the verified live device position for Home distance labels and directions.
    userGeo = { lat: Number(coords.latitude), lng: Number(coords.longitude) };
    // BigDataCloud's free reverse-geocoding endpoint is explicitly client-side:
    // call it from this consented device request, never from the Edge server.
    var reverseUrl = 'https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=' +
      encodeURIComponent(String(coords.latitude)) + '&longitude=' +
      encodeURIComponent(String(coords.longitude)) + '&localityLanguage=en';
    var reverseResponse = await fetch(reverseUrl, { method: 'GET', cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!reverseResponse.ok) throw new Error('GPS country lookup is temporarily unavailable (' + reverseResponse.status + '). Please retry.');
    var reverseData = await reverseResponse.json();
    var gpsCountryCode = String(reverseData.countryCode || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(gpsCountryCode) || gpsCountryCode === 'XX') {
      throw new Error('GPS could not identify your country. Turn on precise location and retry.');
    }
    var countryProofUrl = SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/rehzu-country-proof';
    var res = await fetch(countryProofUrl, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy,
        gps_country_code: gpsCountryCode
      })
    });
    var data = await res.json().catch(function(){ return {}; });
    if (!res.ok) throw new Error(data.error || 'Secure current-country verification failed.');
    var found = WORLD_COUNTRIES.find(function(c){ return c.code === String(data.country_code || '').toUpperCase(); });
    var proofLifetime = Number(data.expires_in_seconds);
    if (!found || !data.proof || !Number.isFinite(proofLifetime) || proofLifetime <= 0) {
      throw new Error('Current country could not be verified. Please retry with precise GPS enabled.');
    }
    detectedCountryCode = found.code;
    detectedCountryProof = String(data.proof);
    countryProofExpiresAt = Date.now() + Math.min(proofLifetime, 300) * 1000;
    countryVerified = true;

    var badge = document.getElementById('userDetectedCountryBadge');
    if (badge) badge.innerText = '📍 GPS verified current country: ' + found.name;
    var cf = document.getElementById('countryFilter');
    if (cf) {
      cf.innerHTML = '';
      var opt = document.createElement('option');
      opt.value = found.code;
      opt.textContent = found.name + ' · Current country';
      cf.appendChild(opt);
      cf.value = found.code;
      cf.disabled = true;
    }
    updateDialPrefix(detectedCountryCode);
    var opDisplay = document.getElementById('opCountryDisplay');
    var opHidden = document.getElementById('opCountry');
    if (opDisplay) opDisplay.value = found.name;
    if (opHidden) opHidden.value = found.code;
    return true;
  } catch(e) {
    countryVerified = false;
    userGeo = { lat: null, lng: null };
    detectedCountryCode = '';
    detectedCountryProof = '';
    countryProofExpiresAt = 0;
    var countryFilter = document.getElementById('countryFilter');
    if (countryFilter) {
      countryFilter.innerHTML = '<option value="">Verify current country first</option>';
      countryFilter.disabled = true;
    }
    var badge = document.getElementById('userDetectedCountryBadge');
    var countryErrorMessage = e && e.message ? String(e.message) : 'Current country could not be verified';
    // Browser fetch failures expose only a low-level TypeError such as "Failed to fetch".
    // Keep the country gate closed, but give users a clear recovery instruction.
    if (/failed to fetch|networkerror|load failed|fetch failed/i.test(countryErrorMessage)) {
      countryErrorMessage = 'Country verification could not connect. Check your internet connection and try again.';
    }
    if (badge) badge.innerText = '📍 ' + countryErrorMessage;
    console.warn('REHZO 99 GPS country verification failed:', countryErrorMessage);
    return false;
  }
}

async function ensureCurrentCountryProof() {
  // Reuse only a still-valid server-signed proof. This avoids repeated reverse
  // geocoding during focus/realtime refreshes while preserving the 180s expiry.
  if (countryVerified && detectedCountryProof &&
      detectedCountryProof.indexOf(String(detectedCountryCode) + ':') === 0 &&
      countryProofExpiresAt > Date.now() + 15000) {
    return detectedCountryProof;
  }
  if (!await autoDetectUserCountry()) {
    throw new Error('Your current country could not be securely verified. Check your connection and try again.');
  }
  return detectedCountryProof;
}

var rehzuCountryRefreshInFlight = false;
async function refreshCountryWhenAppReturns() {
  if (rehzuCountryRefreshInFlight || document.visibilityState === 'hidden') return;
  rehzuCountryRefreshInFlight = true;
  var previousCountry = detectedCountryCode;
  var wasVerified = countryVerified;
  try {
    var verified = await autoDetectUserCountry();
    if (verified) {
      if (!wasVerified || previousCountry !== detectedCountryCode) {
        // Drop the old country's room list immediately after a country change.
        DB.listings = [];
        renderHomeGrid([]);
      }
      // Refresh all data only after the fresh GPS country proof is ready.
      await syncFromSupabase();
      renderHomeGrid();
      if (typeof applyFilters === 'function') applyFilters();
    } else {
      // Fail closed: do not leave previously loaded rooms visible if the
      // current country can no longer be verified.
      DB.listings = [];
      renderHomeGrid([]);
    }
  } catch (error) {
    console.warn('REHZO 99 could not refresh current country:', error && error.message ? error.message : 'unavailable');
  } finally {
    rehzuCountryRefreshInFlight = false;
  }
}

document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible') refreshCountryWhenAppReturns();
});
window.addEventListener('focus', refreshCountryWhenAppReturns);

function getBookingTimeZone(booking) {
  var zone = String(booking && booking.roomTimezone || '').trim();
  var country = String(booking && booking.roomCountry || '').toUpperCase().trim();
  var fallback = {IN:'Asia/Kolkata',NP:'Asia/Kathmandu',BD:'Asia/Dhaka',PK:'Asia/Karachi',AE:'Asia/Dubai',SG:'Asia/Singapore',JP:'Asia/Tokyo',KR:'Asia/Seoul',CN:'Asia/Shanghai',GB:'Europe/London',IE:'Europe/Dublin',FR:'Europe/Paris',DE:'Europe/Berlin',IT:'Europe/Rome',ES:'Europe/Madrid',ZA:'Africa/Johannesburg',NG:'Africa/Lagos',KE:'Africa/Nairobi',NZ:'Pacific/Auckland',AU:'Australia/Sydney',US:'America/New_York',CA:'America/Toronto',BR:'America/Sao_Paulo',MX:'America/Mexico_City',RU:'Europe/Moscow'};
  if (!zone) zone = fallback[country] || 'UTC';
  try { new Intl.DateTimeFormat('en-GB', {timeZone:zone}).format(new Date(0)); return zone; }
  catch (error) { return fallback[country] || 'UTC'; }
}

function formatBookingLocalTime(timestamp, booking) {
  if (!timestamp) return 'Time unavailable';
  var instant = new Date(timestamp);
  if (!Number.isFinite(instant.getTime())) return 'Time unavailable';
  var zone = getBookingTimeZone(booking);
  try {
    return new Intl.DateTimeFormat('en-GB', {timeZone:zone,day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true,timeZoneName:'short'}).format(instant) + ' (' + zone + ')';
  } catch (error) {
    return new Intl.DateTimeFormat('en-GB', {timeZone:'UTC',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true,timeZoneName:'short'}).format(instant) + ' (UTC)';
  }
}

var rehzuSyncInProgress = false;
async function syncFromSupabase() {
  // Focus, visibility and realtime can fire together on mobile browsers.
  // Collapse overlapping refreshes into one country-proof and database pass.
  if (rehzuSyncInProgress) return;
  rehzuSyncInProgress = true;
  try {
    // Public discovery reads only the privacy-safe view. Private owner fields are
    // fetched separately and must be authorized by Supabase RLS.
    // Signed RPC replaces direct from('public_listings_safe') reads so the country proof is mandatory.
    var publicListingsRes = { data: [], error: null };
    try {
      var countryProof = await ensureCurrentCountryProof();
      publicListingsRes = await sb.rpc('rehzu_list_public_listings', { p_country_proof: countryProof });
    } catch (publicReadError) {
      console.warn('Verified country room discovery unavailable; hiding public rooms.');
      publicListingsRes.error = publicReadError;
    }

    var privateListingsRes = { data: [], error: null };
    // A browser/sessionStorage profile is not proof of authentication. Confirm
    // the live Supabase Auth identity and bind it to the cached profile email.
    var authResult = { data: { user: null }, error: null };
    try {
      authResult = await sb.auth.getUser();
    } catch (authReadError) {
      // A failed session refresh must not prevent public rooms from rendering.
      console.warn('Auth session check unavailable; continuing public room load.');
    }
    var verifiedAuthUser = authResult && authResult.data && authResult.data.user;
    var authEmail = verifiedAuthUser && verifiedAuthUser.email ? String(verifiedAuthUser.email).toLowerCase().trim() : '';
    var cachedProfileEmail = DB.currentUser && DB.currentUser.gmail ? String(DB.currentUser.gmail).toLowerCase().trim() : '';
    var currentUid = (authEmail && cachedProfileEmail && authEmail === cachedProfileEmail && DB.currentUser && DB.currentUser.uid)
      ? String(DB.currentUser.uid) : '';
    var isAdminView = false;

    // Admin authorization comes from the verified Supabase Auth session and
    // server-side role check, never from a possibly stale browser profile cache.
    if (verifiedAuthUser) {
      var adminCheck = await sb.rpc('rehzu_is_admin');
      isAdminView = !adminCheck.error && adminCheck.data === true;
    }

    if (isAdminView) {
      DB.adminMetrics = null;
      DB.adminSecurityAlerts = null;
      try {
        var adminMetricsResult = await sb.rpc('rehzu_admin_dashboard_metrics');
        if (!adminMetricsResult.error && adminMetricsResult.data) DB.adminMetrics = adminMetricsResult.data;
      } catch (adminMetricsError) {
        console.warn('Admin live metrics unavailable:', adminMetricsError);
      }
      try {
        var adminSecurityResult = await sb.rpc('rehzu_admin_list_security_alerts', { p_limit: 100 });
        if (!adminSecurityResult.error && Array.isArray(adminSecurityResult.data)) DB.adminSecurityAlerts = adminSecurityResult.data;
      } catch (adminSecurityError) {
        console.warn('Admin security summary unavailable:', adminSecurityError);
      }
    }

    // Admins receive complete platform data through dedicated server-checked RPCs.
    // Regular accounts continue to receive only their own listings.
    if (isAdminView || currentUid) {
      privateListingsRes = isAdminView
        ? await sb.rpc('rehzu_admin_list_all_listings')
        : await sb.rpc('rehzu_list_my_listings');
    }

    function mapListing(item) {
      var days = 90;
      if (item.expires_at) {
        days = Math.max(0, Math.ceil((new Date(item.expires_at) - new Date()) / (1000 * 60 * 60 * 24)));
      } else if (item.created_at) {
        var expiryDate = new Date(new Date(item.created_at).getTime() + (90 * 24 * 60 * 60 * 1000));
        days = Math.max(0, Math.ceil((expiryDate - new Date()) / (1000 * 60 * 60 * 24)));
      }
      return {
        id: item.id,
        houseName: item.house_name,
        roomType: item.room_type,
        suitableFor: item.suitable_for || [],
        amenities: item.amenities || [],
        rules: item.rules || [],
        rent: Math.max(0, parseFloat(item.rent) || 0),
        deposit: Math.max(0, parseFloat(item.deposit) || 0),
        // Accept both database snake_case and already-mapped camelCase fields so
        // public and owner listing responses render the same active offer.
        discountEnabled: item.discount_enabled === true && !!item.discount_expires_at &&
          Number.isFinite(new Date(item.discount_expires_at).getTime()) &&
          new Date(item.discount_expires_at).getTime() > Date.now(),
        discountType: item.discount_type || item.discountType || 'percent',
        discountValue: Math.max(0, parseFloat(item.discount_value != null ? item.discount_value : item.discountValue) || 0),
        discountExpiresAt: item.discount_expires_at || item.discountExpiresAt || null,
        discountStartedAt: item.discount_started_at || item.discountStartedAt || null,
        discountDurationDays: Number(item.discount_duration_days || item.discountDurationDays || 0) || null,
        country: item.country || 'IN',
        createdAt: item.created_at || null,
        city: item.city,
        state: item.state,
        pin: item.pin || '',
        address: item.address || '',
        lat: item.lat == null ? null : item.lat,
        lng: item.lng == null ? null : item.lng,
        ownerUid: item.owner_uid || '',
        ownerName: item.owner_name || '',
        phone: item.owner_phone || '',
        gmail: item.owner_gmail || '',
        status: item.status || 'available',
        photos: (item.photos && item.photos.length) ? item.photos : [],
        daysLeft: days
      };
    }

    var listingById = {};
    if (!publicListingsRes.error && publicListingsRes.data) {
      publicListingsRes.data.forEach(function(item) { listingById[item.id] = mapListing(item); });
    } else if (publicListingsRes.error) {
      console.warn('Safe public listing view unavailable:', publicListingsRes.error.message);
    }
    if (!privateListingsRes.error && privateListingsRes.data) {
      privateListingsRes.data.forEach(function(item) { listingById[item.id] = mapListing(item); });
    } else if (privateListingsRes.error) {
      console.warn('Private owner listings unavailable:', privateListingsRes.error.message);
    }
    DB.listings = Object.values(listingById);

    // Select only fields needed by the UI; RLS must restrict rows to the tenant,
    // the owner of the booked listing, or a database-authorized administrator.
    var resBookings = { data: [], error: null };
    if (isAdminView || currentUid) {
      var bookingRpc = isAdminView
        ? await sb.rpc('rehzu_admin_list_all_bookings')
        : await sb.rpc('rehzu_list_my_bookings');
      if (bookingRpc.error) resBookings.error = bookingRpc.error;
      else resBookings.data = Array.isArray(bookingRpc.data) ? bookingRpc.data : [];
    }
    if (!resBookings.error && resBookings.data) {
      DB.bookings = resBookings.data.map(function(b) {
        return {
          id: b.id, trl: b.trl, trlIssuedAt: b.trl_issued_at, trlExpiresAt: b.trl_expires_at,
          listingId: b.listing_id, houseName: b.house_name,
          roomType: b.room_type, rent: Math.max(0, parseFloat(b.rent) || 0),
          deposit: Math.max(0, parseFloat(b.deposit) || 0),
          duration: Math.max(1, parseInt(b.duration) || 1), date: b.checkin_date,
          userUid: b.user_uid, userName: b.user_name, userPhone: b.user_phone,
          userGmail: b.user_gmail, userOldAddress: b.user_old_address,
          ownerName: b.owner_name, ownerPhone: b.owner_phone, ownerGmail: b.owner_gmail,
          roomCity: b.room_city, roomState: b.room_state, roomPin: b.room_pin,
          roomCountry: b.room_country || '', roomTimezone: b.room_timezone || 'UTC',
          roomExactAddress: b.room_exact_address, roomLat: b.room_lat, roomLng: b.room_lng,
          status: b.status || 'pending', cancelRequestedBy: b.cancel_requested_by,
          suitableFor: b.suitable_for || 'Family', peopleCount: Math.max(1, Math.min(20, parseInt(b.people_count, 10) || 1)), discountType: b.discount_type || '', discountValue: Math.max(0, parseFloat(b.discount_value) || 0), discountPerMonth: Math.max(0, parseFloat(b.discount_per_month) || 0), discountTotal: Math.max(0, parseFloat(b.discount_total) || 0), createdAt: b.created_at
        };
      });
    } else if (resBookings.error) {
      console.warn('Authorized bookings unavailable:', resBookings.error.message);
    } else {
      DB.bookings = [];
    }

    // Do not query the private profiles table at all before authentication.
    // A .limit(0) query still requires SELECT permission and can cause a pre-login
    // 401/permission error on projects where anon has no profiles access.
    if (!currentUid && !isAdminView) {
      DB.profiles = [];
      DB.totalProfilesCount = 0;
    } else {
      var profileColumns = 'id,uid,name,phone,gmail,created_at,country_code,role';
      var profilesQuery = sb.from('profiles').select(profileColumns).order('created_at', { ascending: false });
      if (!isAdminView) profilesQuery = profilesQuery.eq('uid', currentUid);
      var resProfiles = await profilesQuery;
      if (!resProfiles.error && resProfiles.data) {
        DB.profiles = resProfiles.data;
        if (isAdminView) {
          try {
            var loginActivity = await sb.rpc('rehzu_admin_login_activity');
            if (loginActivity.error) throw loginActivity.error;
            var loginByUid = {};
            (Array.isArray(loginActivity.data) ? loginActivity.data : []).forEach(function(row) {
              loginByUid[String(row.uid)] = row.last_login_at || null;
            });
            DB.profiles.forEach(function(profile) {
              profile.last_login_at = loginByUid[String(profile.uid)] || null;
            });
          } catch (loginActivityError) {
            console.warn('Admin login activity unavailable:', loginActivityError);
          }
        }
        DB.adminLastSyncedAt = Date.now();
        DB.totalProfilesCount = isAdminView ? resProfiles.data.length : (resProfiles.data.length ? 1 : 0);
        if (DB.currentUser) {
          var myUpdated = DB.profiles.find(function(p) { return p.uid === DB.currentUser.uid; });
          if (myUpdated) {
            myUpdated.role = isAdminView ? 'admin' : 'user';
            DB.currentUser = myUpdated;
            sessionStorage.setItem('rehzu_current_user', JSON.stringify(DB.currentUser));
          }
        }
      } else if (resProfiles.error) {
        console.warn('Authorized profile read unavailable:', resProfiles.error.message);
      }
    }
  } catch(e) {
    console.warn("Supabase fetch notice:", e);
  } finally {
    rehzuSyncInProgress = false;
  }

  updateUserHeaderChip();
  updateNotificationsBadge();
  renderHomeGrid();
  if (document.getElementById('view-bookings').classList.contains('active')) renderBookingsView();
  if (document.getElementById('view-owner').classList.contains('active')) renderOwnerView();
  if (document.getElementById('view-notifications').classList.contains('active')) renderNotifications();
  if (document.getElementById('view-admin').classList.contains('active')) {
    if (adminEntryRefreshInProgress) renderAdminModerationContent();
    else renderAdminModeration();
  }
}

function dismissSplash() {
  var splash = document.getElementById('splashOverlay');
  if (splash && splash.style.display !== 'none') {
    splash.style.opacity = '0';
    setTimeout(function() { splash.style.display = 'none'; }, 450);
  }
}

function initRehzuApp() {
  populateCountryDropdowns();
  // Country is displayed only after GPS and server verification succeed.
  updateUserHeaderChip();
  setTimeout(dismissSplash, 1200);

  // Country proof must be verified before public room discovery or booking actions.
  (async function() {
    // syncFromSupabase obtains the country proof once before public discovery.
    // Avoid a duplicate GPS/geocoder request during initial startup.
    try { await handleOAuthRedirect(); } catch(e) {
      console.warn('Sign-in redirect could not be completed:', e);
    }
    try { await startRehzuPresence(); } catch(e) {
      console.warn('Presence tracking could not be started:', e);
    }
    try { await syncFromSupabase(); } catch(e) {
      console.warn('Initial data sync failed:', e);
    }
    try { renderHomeGrid(); } catch(e) {}
    if (new URLSearchParams(window.location.search).get('openSupport') === '1') {
      sessionStorage.setItem('rehzu_open_support_after_login','1');
      window.history.replaceState({}, document.title, window.location.pathname);
      openSupportView();
    }
    dismissSplash();
  })();

  try {
    sb.channel('public:listings_and_bookings')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'listings' }, function(payload) {
        syncFromSupabase();
      })
      .subscribe();
  } catch(err) {
    console.warn("Realtime notice:", err);
  }

  // Country refresh owns resume synchronization so a fresh GPS proof is
  // obtained before any country-scoped listing or booking refresh.
  // Event-driven Broadcast refreshes are primary; this slower reconciliation
  // refresh keeps time-window metrics accurate if a transient event is missed.
  setInterval(function() {
    var adminView = document.getElementById('view-admin');
    if (adminView && adminView.classList.contains('active') && !document.hidden) {
      syncFromSupabase();
      var complaintsSection = document.getElementById('adminComplaintsSection');
      if (complaintsSection && complaintsSection.style.display !== 'none') renderAdminComplaints();
    }
  }, 10000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initRehzuApp, { once: true });
} else {
  initRehzuApp();
}

function getRelevantNotifications() {
  if (!DB.currentUser) return [];
  var notifs = [];
  var userTenDigit = normalizePhoneDigits(DB.currentUser.phone);
  var userUid = String(DB.currentUser.uid || '').toUpperCase().trim();

  DB.bookings.forEach(function(b) {
    var ownerTenDigit = normalizePhoneDigits(b.ownerPhone);
    var tenantTenDigit = normalizePhoneDigits(b.userPhone);

    var isOwnerOfBooking = (userTenDigit && ownerTenDigit && userTenDigit === ownerTenDigit);
    if (!isOwnerOfBooking && b.listingId) {
      var lMatch = DB.listings.find(function(x){ return x.id === b.listingId; });
      if (lMatch && (lMatch.ownerUid === userUid || (normalizePhoneDigits(lMatch.phone) === userTenDigit))) {
        isOwnerOfBooking = true;
      }
    }

    if (isOwnerOfBooking) {
      if (b.status === 'pending') {
        notifs.push({
          id: 'notif_' + b.id,
          title: 'New Booking Request 📥',
          desc: cleanText(b.userName) + ' requested to book ' + cleanText(b.houseName) + ' (' + b.duration + ' mo).',
          time: b.date || 'Recent',
          action: 'owner'
        });
      } else if (b.status === 'confirmed') {
        notifs.push({
          id: 'notif_' + b.id,
          title: 'Booking Confirmed! 🎉',
          desc: cleanText(b.userName) + ' confirmed stay for ' + cleanText(b.houseName) + '. TRL: ' + (b.trl || ''),
          time: b.date || 'Recent',
          action: 'owner'
        });
      }
    }

    var isTenantOfBooking = (b.userUid === userUid) || (userTenDigit && tenantTenDigit && userTenDigit === tenantTenDigit);
    if (isTenantOfBooking) {
      if (b.status === 'owner_accepted') {
        notifs.push({
          id: 'notif_' + b.id,
          title: 'Request Accepted by Owner! ✅',
          desc: 'Owner accepted your request for ' + cleanText(b.houseName) + '. Tap to confirm your stay.',
          time: b.date || 'Recent',
          action: 'bookings'
        });
      } else if (b.status === 'confirmed') {
        notifs.push({
          id: 'notif_' + b.id,
          title: 'Stay Confirmed & Locked 🏠',
          desc: 'Your booking for ' + cleanText(b.houseName) + ' is verified. TRL: ' + (b.trl || ''),
          time: b.date || 'Recent',
          action: 'bookings'
        });
      }
    }
  });

  return notifs;
}

function updateNotificationsBadge() {
  var badge = document.getElementById('headerNotifBadge');
  if (!badge) return;
  var notifs = getRelevantNotifications();
  var readList = JSON.parse(sessionStorage.getItem('rehzu_read_notifs') || '[]');
  var unreadCount = notifs.filter(function(n){ return readList.indexOf(n.id) === -1; }).length;

  if (unreadCount > 0) {
    badge.innerText = unreadCount;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

function renderNotifications() {
  var container = document.getElementById('notificationsContainer');
  if (!container) return;

  if (!DB.currentUser) {
    container.innerHTML = '<div style="background:#fff; border:1px solid #E2E8F0; border-radius:16px; padding:24px; text-align:center; font-size:11px; color:#64748B;">Please login to view notifications.</div>';
    return;
  }

  var notifs = getRelevantNotifications();
  var readList = JSON.parse(sessionStorage.getItem('rehzu_read_notifs') || '[]');

  if (!notifs.length) {
    container.innerHTML = '<div style="background:#fff; border:1px solid #E2E8F0; border-radius:16px; padding:24px; text-align:center; font-size:11px; color:#64748B;">No notifications at this moment.</div>';
    return;
  }

  container.innerHTML = notifs.map(function(n) {
    var isRead = readList.indexOf(n.id) !== -1;
    return '<div class="notif-card ' + (isRead ? '' : 'unread') + '" onclick="handleNotifClick(\'' + safeInlineToken(n.id) + '\', \'' + safeInlineToken(n.action) + '\')">' +
      '<div class="notif-title"><span>' + cleanText(n.title) + '</span><span class="notif-time">' + cleanText(n.time) + '</span></div>' +
      '<div style="color:#475569;">' + cleanText(n.desc) + '</div>' +
    '</div>';
  }).join('');
}

function handleNotifClick(notifId, actionView) {
  var readList = JSON.parse(sessionStorage.getItem('rehzu_read_notifs') || '[]');
  if (readList.indexOf(notifId) === -1) {
    readList.push(notifId);
    sessionStorage.setItem('rehzu_read_notifs', JSON.stringify(readList));
  }
  updateNotificationsBadge();
  if (actionView) goView(actionView);
}

function markAllNotifsRead() {
  var notifs = getRelevantNotifications();
  var readList = notifs.map(function(n){ return n.id; });
  sessionStorage.setItem('rehzu_read_notifs', JSON.stringify(readList));
  updateNotificationsBadge();
  renderNotifications();
}

function updateUserHeaderChip() {
  var chip = document.getElementById('userHeaderChip');
  if (chip) {
    if (DB.currentUser) {
      chip.innerText = '👤 ' + cleanText(DB.currentUser.name ? DB.currentUser.name.split(' ')[0] : 'User') + ' (' + cleanText(DB.currentUser.uid) + ')';
    } else {
      chip.innerText = '👤 Login';
    }
  }
}

async function handleOAuthRedirect() {
  try {
    var sessionRes = await sb.auth.getSession();
    var session = sessionRes.data ? sessionRes.data.session : null;
    var pendingOAuthReg = sessionStorage.getItem('rehzu_pending_reg_oauth');
    var pendingOAuthRecov = sessionStorage.getItem('rehzu_pending_recov_oauth');

    if (session && session.user && session.user.email) {
      var googleEmail = session.user.email;
      
      if (pendingOAuthReg === 'true') {
        sessionStorage.removeItem('rehzu_pending_reg_oauth');

        // Re-validate the OAuth identity with Supabase Auth before treating the email as verified.
        var verifiedUserRes = await sb.auth.getUser();
        var verifiedUser = verifiedUserRes && verifiedUserRes.data ? verifiedUserRes.data.user : null;
        var verifiedProviders = verifiedUser && verifiedUser.app_metadata
          ? (verifiedUser.app_metadata.providers || [])
          : [];
        if (
          verifiedUserRes.error ||
          !verifiedUser ||
          !verifiedUser.email ||
          !verifiedUser.email_confirmed_at ||
          (verifiedUser.app_metadata && verifiedUser.app_metadata.provider !== 'google' && verifiedProviders.indexOf('google') === -1)
        ) {
          registrationGoogleVerifiedEmail = null;
          alert("Google account verification could not be confirmed. Please try Google sign-in again.");
          await sb.auth.signOut();
          openProfileModal();
          return;
        }
        googleEmail = verifiedUser.email.toLowerCase().trim();

        // Check the verified Auth identity server-side. A unique database index
        // remains the final protection against duplicate Gmail addresses across RLS.
        var profCheck = await sb.rpc('rehzo_registration_email_available');
        if (profCheck.error) throw new Error('Could not verify this Gmail for registration. Please retry.');
        if (profCheck.data !== true) {
          alert("Account already exists with this Gmail (" + googleEmail + ")!\\nPlease login with your existing account.");
          openProfileModal();
          return;
        }

        setTimeout(function() {
          openRegistrationModal({
            gmail: googleEmail,
            name: (session.user.user_metadata && session.user.user_metadata.full_name) ? session.user.user_metadata.full_name : ''
          });
        }, 300);
        return;
      }

      if (pendingOAuthRecov === 'true') {
        sessionStorage.removeItem('rehzu_pending_recov_oauth');
        var savedRecovPhone = sessionStorage.getItem('rehzu_pending_recov_phone') || '';
        var recovAuthRes = await sb.auth.getUser();
        var recovAuthUser = recovAuthRes && recovAuthRes.data ? recovAuthRes.data.user : null;
        var recovProviders = recovAuthUser && recovAuthUser.app_metadata
          ? (recovAuthUser.app_metadata.providers || [])
          : [];
        var recovEmail = recovAuthUser && recovAuthUser.email
          ? recovAuthUser.email.toLowerCase().trim()
          : '';
        if (
          recovAuthRes.error ||
          !recovAuthUser ||
          !recovAuthUser.email_confirmed_at ||
          (recovAuthUser.app_metadata && recovAuthUser.app_metadata.provider !== 'google' && recovProviders.indexOf('google') === -1)
        ) {
          sessionStorage.removeItem('rehzu_pending_recov_phone');
          alert("Google account verification could not be confirmed. Please try again.");
          await sb.auth.signOut();
          openForgotCredentialsModal();
          return;
        }

        // RLS permits this profile read only when its Gmail matches the verified Google identity.
        var recovProfileRes = await sb.from('profiles')
          .select('id,uid,name,phone,gmail,created_at')
          .ilike('gmail', recovEmail)
          .maybeSingle();
        var recovProfile = recovProfileRes && recovProfileRes.data ? recovProfileRes.data : null;
        var registeredPhoneDigits = recovProfile ? String(recovProfile.phone || '').replace(/\D/g, '') : '';
        if (recovProfileRes.error || !recovProfile || !savedRecovPhone || registeredPhoneDigits !== savedRecovPhone) {
          sessionStorage.removeItem('rehzu_pending_recov_phone');
          sessionStorage.removeItem('rehzu_temp_recov_user');
          alert("The verified Google account and Contact No. do not match a REHZO 99 account.");
          await sb.auth.signOut();
          openForgotCredentialsModal();
          return;
        }

        sessionStorage.removeItem('rehzu_pending_recov_phone');
        recoveryFoundUser = recovProfile;
        sessionStorage.setItem('rehzu_temp_recov_user', JSON.stringify(recovProfile));
        setTimeout(function() {
          openResetPasswordDirectModal(recovProfile, recovEmail);
        }, 300);
        return;
      }
    }
  } catch(e) {
    console.warn("OAuth Session check notice:", e);
  }
}

function openResetPasswordDirectModal(userObj, verifiedGoogleEmail) {
  var cleanEmail = (verifiedGoogleEmail || '').toLowerCase().trim();
  var registeredEmail = (userObj && userObj.gmail) ? userObj.gmail.toLowerCase().trim() : '';
  var isMatch = cleanEmail && registeredEmail && (cleanEmail === registeredEmail);

  recoveryFoundUser = userObj;

  document.getElementById('modalSlot').innerHTML = '<div class="modal-overlay">' +
    '<div class="modal-box-narrow">' +
      '<div class="modal-header">' +
        '<div style="display:flex; align-items:center; gap:8px;">' +
          '<img src="logo.svg" alt="Rehzu" style="height:26px; width:auto; object-fit:contain;" onerror="this.style.display=\'none\'">' +
          '<h3 style="font-size:15px; font-weight:800; color:#0F172A;">Reset Password</h3>' +
        '</div>' +
        '<span onclick="closeModal()" style="cursor:pointer; font-size:16px; font-weight:bold;">✕</span>' +
      '</div>' +

      '<div style="background:#ECFDF5; border:1px solid #BBF7D0; border-radius:14px; padding:12px; margin-bottom:12px;">' +
        '<div style="font-size:10px; font-weight:800; color:#044E3B; letter-spacing:0.5px;">✓ GMAIL VERIFIED</div>' +
        '<div style="font-size:10.5px; color:#15803D;">' + cleanText(cleanEmail) + '</div>' +
      '</div>' +

      (isMatch ? (
        '<div class="field-box" style="margin-bottom:8px;">' +
          '<label class="field-label">Set New Password *</label>' +
          '<div class="pwd-wrap">' +
            '<input id="newResetPwd" type="password" class="pill-input" placeholder="6–12 character password" minlength="6" maxlength="12" autocomplete="new-password">' +
            '<button type="button" class="pwd-toggle-btn" onclick="togglePasswordVisibility(\'newResetPwd\', this)">👁️</button>' +
          '</div>' +
          '<span style="font-size:9px; font-weight:700; color:#B45309; margin-top:2px;">Password 6–12 characters ka ho, aur isme letter, number aur special character zaroor ho.</span>' +
        '</div>' +
        '<button class="big-action-btn" id="btnSaveNewResetPwd" onclick="saveNewResetPassword()">Save New Password & Login </button>'
      ) : (
        '<div style="color:#DC2626; font-size:11px; font-weight:700; margin-bottom:10px;">✕ Selected Google account (' + cleanText(cleanEmail) + ') does not match the registered Gmail (' + cleanText(registeredEmail) + ') for this User ID.</div>' +
        '<button class="big-action-btn" onclick="openForgotCredentialsModal()">Try Again with Correct Account</button>'
      )) +
    '</div>' +
  '</div>';
}

function openProfileModal(callbackAction) {
  if (DB.currentUser) {
    document.getElementById('modalSlot').innerHTML = '<div class="modal-overlay">' +
      '<div class="modal-box-narrow">' +
        '<div class="modal-header">' +
          '<div style="display:flex; align-items:center; gap:8px;">' +
            '<img src="logo.svg" alt="Rehzu" style="height:26px; width:auto; object-fit:contain;" onerror="this.style.display=\'none\'">' +
            '<h3 style="font-size:15px; font-weight:800; color:#0F172A;">Your Rehzu Account</h3>' +
          '</div>' +
          '<span onclick="closeModal()" style="cursor:pointer; font-size:16px; font-weight:bold;">✕</span>' +
        '</div>' +
        '<div style="text-align:center; padding:10px 0;">' +
          '<div style="width:54px; height:54px; border-radius:50%; background:#044E3B; color:#fff; display:flex; align-items:center; justify-content:center; font-size:24px; margin:0 auto 8px;">👤</div>' +
          '<h2 style="font-size:16px; font-weight:800; color:#0F172A;">' + cleanText(DB.currentUser.name) + '</h2>' +
          '</div>' +
        '<div style="background:#F8FAF9; border:1px solid #E2E8F0; border-radius:14px; padding:12px; font-size:11.5px; line-height:1.7; margin-bottom:12px;">' +
          '<div>📞 <b>Contact No.:</b> ' + cleanText(DB.currentUser.phone) + '</div>' +
          '<div>✉️ <b>Gmail:</b> ' + cleanText(DB.currentUser.gmail || 'Not Linked') + '</div>' +
          '<div>🛡️ <b>Access:</b> ' + (DB.currentUser.role === 'admin' ? 'Administrator 🔐' : 'Verified Account') + '</div>' +
        '</div>' +
        '<button class="big-action-btn" style="background:#EF4444;" onclick="logoutUser()">Log Out / Switch Account</button>' +
      '</div>' +
    '</div>';
  } else {
    currentLoginMode = 'uid';
    var countryOptionsHTML = WORLD_COUNTRIES.map(function(c) {
      return '<option value="' + c.dial + '" ' + (c.code === detectedCountryCode ? 'selected' : '') + '>' + c.code + ' (' + c.dial + ')</option>';
    }).join('');

    document.getElementById('modalSlot').innerHTML = '<div class="modal-overlay">' +
      '<div class="modal-box-narrow">' +
        '<div class="modal-header">' +
          '<div style="display:flex; align-items:center; gap:8px;">' +
            '<img src="logo.svg" alt="Rehzu" style="height:26px; width:auto; object-fit:contain;" onerror="this.style.display=\'none\'">' +
            '<h3 style="font-size:15px; font-weight:800; color:#0F172A;">Welcome to Rehzu</h3>' +
          '</div>' +
          '<span onclick="closeModal()" style="cursor:pointer; font-size:16px; font-weight:bold;">✕</span>' +
        '</div>' +

        '<div class="switch-box-row">' +
          '<button type="button" class="switch-btn active" id="btnModeUid" onclick="setLoginInputMode(\'uid\')">USER ID</button>' +
          '<button type="button" class="switch-btn" id="btnModePhone" onclick="setLoginInputMode(\'phone\')">CONTACT NO</button>' +
        '</div>' +

        '<div class="field-box" style="margin-bottom:10px;">' +
          '<label class="field-label" id="lblLoginIdentifier">User ID *</label>' +
          
          '<div id="boxInputUid" class="prefix-input-wrap">' +
            '<select id="loginUidPrefix" class="prefix-select-inline">' +
              '<option value="RZ">RZ</option>' +
              '<option value="RE">RE</option>' +
              '<option value="HR">HR</option>' +
              '<option value="ZO">ZO</option>' +
              '<option value="OE">OE</option>' +
            '</select>' +
            '<input id="loginUidSuffix" placeholder="USER ID" autocomplete="off">' +
          '</div>' +

          '<div id="boxInputPhone" class="dial-prefix-wrap" style="display:none;">' +
            '<select id="loginCountryDial" class="dial-select-inline">' + countryOptionsHTML + '</select>' +
            '<input id="loginPhoneInput" type="tel" placeholder="Contact No." autocomplete="off">' +
          '</div>' +
        '</div>' +

        '<div class="field-box" style="margin-bottom:6px;">' +
          '<label class="field-label">Password *</label>' +
          '<div class="pwd-wrap">' +
            '<input id="loginPwd" type="password" class="pill-input" placeholder="Password" minlength="6" maxlength="12" autocomplete="new-password">' +
            '<button type="button" class="pwd-toggle-btn" onclick="togglePasswordVisibility(\'loginPwd\', this)">👁️</button>' +
          '</div>' +
        '</div>' +

        '<div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px; margin-bottom:12px;">' +
          '<span style="font-size:10.5px; color:#044E3B; font-weight:700; cursor:pointer;" onclick="openForgotCredentialsModal()">Forgot User ID or Password?</span>' +
          '<a href="/legal.html" aria-label="Terms, Policies and Support" style="display:inline-flex; align-items:center; gap:3px; color:#64748B; font-size:9px; line-height:1.2; font-weight:600; text-decoration:none; padding:2px 0;">☷ Terms, Policies &amp; Support</a>' +
        '</div>' +

        '<button class="big-action-btn" id="btnLoginSubmit" onclick="submitCredentialsLogin(' + (callbackAction ? '\'' + callbackAction + '\'' : 'null') + ')">Login with Rehzu ID </button>' +
        
        '<div style="text-align:center; margin-top:14px;">' +
          '<span style="font-size:11px; color:#044E3B; font-weight:800; cursor:pointer;" onclick="openRegistrationModal(null, ' + (callbackAction ? '\'' + callbackAction + '\'' : 'null') + ')">New here? Create Rehzu Account</span>' +
        '</div>' +
      '</div>' +
    '</div>';
  }
}

function setLoginInputMode(mode) {
  currentLoginMode = mode;
  var btnUid = document.getElementById('btnModeUid');
  var btnPhone = document.getElementById('btnModePhone');
  var boxUid = document.getElementById('boxInputUid');
  var boxPhone = document.getElementById('boxInputPhone');
  var lbl = document.getElementById('lblLoginIdentifier');

  if (mode === 'uid') {
    if (btnUid) btnUid.className = 'switch-btn active';
    if (btnPhone) btnPhone.className = 'switch-btn';
    if (boxUid) boxUid.style.display = 'flex';
    if (boxPhone) boxPhone.style.display = 'none';
    if (lbl) lbl.innerText = 'User ID *';
  } else {
    if (btnUid) btnUid.className = 'switch-btn';
    if (btnPhone) btnPhone.className = 'switch-btn active';
    if (boxUid) boxUid.style.display = 'none';
    if (boxPhone) boxPhone.style.display = 'flex';
    if (lbl) lbl.innerText = 'Contact No *';
  }
}

function openRegistrationModal(prefillData, callbackAction) {
  var pName = (prefillData && prefillData.name) ? prefillData.name : '';
  var pGmail = (prefillData && prefillData.gmail) ? prefillData.gmail : '';
  registrationGoogleVerifiedEmail = pGmail ? pGmail.toLowerCase() : null;

  var countryOptionsHTML = WORLD_COUNTRIES.map(function(c) {
    return '<option value="' + c.dial + '" ' + (c.code === detectedCountryCode ? 'selected' : '') + '>' + c.code + ' (' + c.dial + ')</option>';
  }).join('');

  document.getElementById('modalSlot').innerHTML = '<div class="modal-overlay">' +
    '<div class="modal-box-narrow">' +
      '<div class="modal-header">' +
        '<div style="display:flex; align-items:center; gap:8px;">' +
          '<img src="logo.svg" alt="Rehzu" style="height:26px; width:auto; object-fit:contain;" onerror="this.style.display=\'none\'">' +
          '<div>' +
            '<h3 style="font-size:15px; font-weight:800; color:#0F172A;">Create Rehzu Account</h3>' +
            '<p style="font-size:9.5px; color:#044E3B; font-weight:700;">Unified Profile for Tenants & Landlords</p>' +
          '</div>' +
        '</div>' +
        '<span onclick="closeModal()" style="cursor:pointer; font-size:16px; font-weight:bold;">✕</span>' +
      '</div>' +

      '<form id="formRegistration" onsubmit="submitUnifiedRegistration(event, ' + (callbackAction ? '\'' + callbackAction + '\'' : 'null') + ')">' +
        '<div class="pill-grid">' +
          '<div class="field-box">' +
            '<label class="field-label">FULL NAME *</label>' +
            '<input id="regFullName" class="pill-input" placeholder="Full Name" value="' + cleanText(pName) + '" required autocomplete="off" maxlength="60">' +
          '</div>' +
          '<div class="field-box">' +
            '<label class="field-label">CONTACT NO *</label>' +
            '<div class="dial-prefix-wrap">' +
              '<select id="regCountryDial" class="dial-select-inline">' + countryOptionsHTML + '</select>' +
              '<input id="regPhoneInput" type="tel" placeholder="Contact No." required autocomplete="off" maxlength="15">' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="field-box" style="margin-bottom:10px;">' +
          '<label class="field-label">Google Gmail Verification *</label>' +
          '<button type="button" class="google-auth-btn" id="btnRegisterGoogleVerify" onclick="triggerRegisterGoogleAuth()" style="margin-bottom:3px;">' +
            '<svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>' +
            '<span id="txtRegGoogleLabel">' + (registrationGoogleVerifiedEmail ? '✓ Verified: ' + registrationGoogleVerifiedEmail : 'Verify with Google Gmail') + '</span>' +
          '</button>' +
          '<span id="regGoogleStatus" style="font-size:10px; font-weight:700; color:' + (registrationGoogleVerifiedEmail ? '#15803D' : '#64748B') + ';">' + (registrationGoogleVerifiedEmail ? '✓ Google Gmail Verified!' : 'Please tap above to verify your Gmail.') + '</span>' +
        '</div>' +

        '<div class="pill-grid">' +
          '<div class="field-box">' +
            '<label class="field-label">Create User ID *</label>' +
            '<div class="prefix-input-wrap">' +
              '<select id="regUidPrefix" class="prefix-select-inline" onchange="validateUniqueUserId(document.getElementById(\'regUidSuffix\').value)">' +
                '<option value="RZ">RZ</option>' +
                '<option value="RE">RE</option>' +
                '<option value="HR">HR</option>' +
                '<option value="ZO">ZO</option>' +
                '<option value="OE">OE</option>' +
              '</select>' +
              '<input id="regUidSuffix" placeholder="Unique ID" minlength="2" maxlength="10" onblur="validateUniqueUserId(this.value)" required autocomplete="off">' +
            '</div>' +
            '<span id="regUidFeedback" style="display:none; font-size:9px; font-weight:700; margin-top:2px;"></span>' +
          '</div>' +

          '<div class="field-box" style="width:100%; min-width:0;">' +
            '<label class="field-label">Create Password *</label>' +
            '<div class="pwd-wrap" style="width:100%; min-width:0; position:relative;">' +
              '<input id="regPasswordInput" type="password" class="pill-input" placeholder="Create Password" minlength="6" maxlength="12" required autocomplete="new-password" style="width:100%; min-height:46px; box-sizing:border-box; padding-right:48px;" onfocus="var hint=document.getElementById(\'regPasswordHint\'); if(hint) hint.style.display=\'block\';" onblur="var hint=document.getElementById(\'regPasswordHint\'); if(hint) hint.style.display=\'none\';">' +
              '<span id="regPasswordHint" style="display:none; font-size:10px; color:#64748B; font-weight:600; margin-top:5px;">Password 6–12 characters ka ho: kam se kam 1 letter, 1 number aur 1 special character.</span>' +
              '<button type="button" class="pwd-toggle-btn" onclick="togglePasswordVisibility(\'regPasswordInput\', this)">👁️</button>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<label style="display:flex;align-items:flex-start;gap:8px;font-size:11px;line-height:1.45;color:#334155;margin:8px 0 12px;">' +
          '<input id="regPolicyConsent" type="checkbox" required style="margin-top:2px;flex:0 0 auto;">' +
          '<span>I have read and agree to the <a href="/legal.html#policy-terms" target="_blank" rel="noopener noreferrer">Terms &amp; Conditions</a>, <a href="/legal.html#policy-privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a> and <a href="/legal.html#policy-fraud-security" target="_blank" rel="noopener noreferrer">Fraud &amp; Data Security Policy</a>.</span>' +
        '</label>' +
        '<button type="submit" id="btnRegisterSubmit" class="big-action-btn">Complete & Enter Rehzu </button>' +
      '</form>' +
    '</div>' +
  '</div>';
}

async function triggerRegisterGoogleAuth() {
  try {
    sessionStorage.setItem('rehzu_pending_reg_oauth', 'true');
    var redirectToUrl = window.location.origin + window.location.pathname;
    var res = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { 
        redirectTo: redirectToUrl,
        queryParams: { prompt: 'select_account' }
      }
    });

    if (res.error) {
      sessionStorage.removeItem('rehzu_pending_reg_oauth');
      registrationGoogleVerifiedEmail = null;
      alert("Google verification could not start. Please try again. Your email has not been verified.");
    }
  } catch(e) {
    sessionStorage.removeItem('rehzu_pending_reg_oauth');
    registrationGoogleVerifiedEmail = null;
    alert("Google verification failed. Please try again. Your email has not been verified.");
  }
}

function isValidRehzuPassword(value) {
  // New passwords: 6–12 printable characters, including a letter, digit and symbol.
  var password = String(value || '');
  if (password.length < 6 || password.length > 12) return false;
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return false;
  var allowedSymbols = '!@#$%^&*()_+-=[]{};:|<>?,./`~'.split('');
  allowedSymbols.push(String.fromCharCode(34), String.fromCharCode(39), String.fromCharCode(92));
  if (!allowedSymbols.some(function(symbol) { return password.indexOf(symbol) !== -1; })) return false;
  return Array.from(password).every(function(character) {
    return /[A-Za-z0-9]/.test(character) || allowedSymbols.indexOf(character) !== -1;
  });
}

function togglePasswordVisibility(inputId, btn) {
  var input = document.getElementById(inputId);
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    btn.innerText = '🙈';
  } else {
    input.type = 'password';
    btn.innerText = '👁️';
  }
}

async function validateUniqueUserId(suffixVal) {
  var feedback = document.getElementById('regUidFeedback');
  var prefixElem = document.getElementById('regUidPrefix');
  var prefix = prefixElem ? prefixElem.value : 'RZ';
  if (!feedback) return;

  var raw = suffixVal.trim().replace(/^(rz|re|hr|zo|oe)/i, '');
  var totalLen = 2 + raw.length;

  if (totalLen < 4 || totalLen > 12) {
    feedback.style.display = 'block';
    feedback.innerText = '⚠️ Must be 4 to 12 characters including prefix.';
    feedback.style.color = '#B45309';
    return;
  }

  var fullUid = (prefix + raw).toUpperCase();
  var res = await sb.from('profiles').select('uid').ilike('uid', fullUid);
  if (res.data && res.data.length > 0) {
    feedback.style.display = 'block';
    feedback.innerText = '✕ ' + fullUid + ' already taken! Choose another.';
    feedback.style.color = '#DC2626';
  } else {
    feedback.style.display = 'block';
    feedback.innerText = '✓ Available: ' + fullUid;
    feedback.style.color = '#15803D';
  }
}

async function submitUnifiedRegistration(e, callbackAction) {
  e.preventDefault();
  var btn = document.getElementById('btnRegisterSubmit');
  btn.disabled = true;
  btn.innerText = 'Creating Profile...';

  try {
    var name = cleanText(document.getElementById('regFullName').value);
    var dial = document.getElementById('regCountryDial').value;
    var rawPhone = document.getElementById('regPhoneInput').value.trim();
    var prefix = document.getElementById('regUidPrefix').value;
    var rawSuffix = document.getElementById('regUidSuffix').value.trim().replace(/^(rz|re|hr|zo|oe)/i, '');
    var password = document.getElementById('regPasswordInput').value;
    var policyConsent = document.getElementById('regPolicyConsent');

    if (!policyConsent || !policyConsent.checked) {
      alert("Please read and accept the Terms & Conditions, Privacy Policy and Fraud & Data Security Policy.");
      btn.disabled = false;
      btn.innerText = 'Complete & Enter Rehzu ';
      return;
    }

    if (!registrationGoogleVerifiedEmail) {
      alert("Please verify your Google Gmail before completing registration!");
      btn.disabled = false;
      btn.innerText = 'Complete & Enter Rehzu ';
      return;
    }

    // Do not trust a client-side flag alone: verify the current Supabase Auth identity at submit time.
    var submitAuthRes = await sb.auth.getUser();
    var submitAuthUser = submitAuthRes && submitAuthRes.data ? submitAuthRes.data.user : null;
    var submitProviders = submitAuthUser && submitAuthUser.app_metadata
      ? (submitAuthUser.app_metadata.providers || [])
      : [];
    var submitEmail = submitAuthUser && submitAuthUser.email
      ? submitAuthUser.email.toLowerCase().trim()
      : '';
    if (
      submitAuthRes.error ||
      !submitAuthUser ||
      !submitAuthUser.email_confirmed_at ||
      submitEmail !== registrationGoogleVerifiedEmail.toLowerCase().trim() ||
      (submitAuthUser.app_metadata && submitAuthUser.app_metadata.provider !== 'google' && submitProviders.indexOf('google') === -1)
    ) {
      registrationGoogleVerifiedEmail = null;
      alert("Google verification expired or could not be confirmed. Please verify with Google again.");
      btn.disabled = false;
      btn.innerText = 'Complete & Enter Rehzu ';
      return;
    }

    if (!isValidRehzuPassword(password)) {
      alert("Password 6–12 characters ka hona chahiye aur letter, number aur special character teeno zaroori hain.");
      btn.disabled = false;
      btn.innerText = 'Complete & Enter Rehzu ';
      return;
    }

    var fullUid = (prefix + rawSuffix).toUpperCase();
    var cleanDigits = rawPhone.replace(/[^0-9]/g, '');
    var fullContactWithDial = (dial + cleanDigits).replace(/[^0-9]/g, '');

    if (fullContactWithDial.length < 1 || fullContactWithDial.length > 17 || cleanDigits.length < 1) {
      alert("Contact number must be valid.");
      btn.disabled = false;
      btn.innerText = 'Complete & Enter Rehzu ';
      return;
    }

    var fullPhone = dial + ' ' + cleanDigits;

    // Check Gmail, phone and User ID together on the server. Client-side
    // profile reads are restricted by RLS and cannot safely detect other users.
    var fieldsCheck = await sb.rpc('rehzo_registration_fields_available', {
      p_phone: fullContactWithDial,
      p_uid: fullUid
    });
    if (fieldsCheck.error || !fieldsCheck.data) {
      throw new Error('Could not securely verify your registration details. Please retry.');
    }
    if (fieldsCheck.data.email_available !== true) {
      alert("Account already exists with this Gmail (" + registrationGoogleVerifiedEmail + ")!\\nPlease login with your existing account.");
      btn.disabled = false;
      btn.innerText = 'Complete & Enter Rehzu ';
      return;
    }
    if (fieldsCheck.data.phone_available !== true) {
      alert("Account already exists with this Contact No. (" + fullPhone + ")!\\nPlease login with your existing account.");
      btn.disabled = false;
      btn.innerText = 'Complete & Enter Rehzu ';
      return;
    }
    if (fieldsCheck.data.uid_available !== true) {
      alert("User ID " + fullUid + " is already taken. Please choose another suffix.");
      btn.disabled = false;
      btn.innerText = 'Complete & Enter Rehzu ';
      return;
    }

    // Record affirmative, versioned consent in a dedicated RLS-protected audit table.
    // The database supplies accepted_at; no client timestamp is trusted.
    var consentRes = await sb.from('policy_acceptances').upsert([{
      auth_user_id: submitAuthUser.id,
      consent_type: 'account_registration',
      policy_version: '2026-10-30-v3'
    }], {
      onConflict: 'auth_user_id,consent_type,policy_version',
      ignoreDuplicates: true
    });
    if (consentRes.error) throw new Error('Could not securely record policy acceptance. Please retry.');

    // Store the password only in Supabase Auth; never write it or a client hash to public.profiles.
    var authPasswordRes = await sb.auth.updateUser({ password: password });
    if (authPasswordRes.error) throw new Error('Could not set your secure login password. Please retry Google verification.');

    var newProfile = {
      id: submitAuthUser.id,
      uid: fullUid,
      name: name,
      phone: fullPhone,
      gmail: registrationGoogleVerifiedEmail,
      country_code: /^[A-Z]{2}$/.test(String(detectedCountryCode || '').toUpperCase()) ? String(detectedCountryCode).toUpperCase() : null
    };

    var insertRes = await sb.from('profiles').upsert([newProfile], { onConflict: 'id' }).select('id,uid,name,phone,gmail,created_at,country_code').single();
    if (insertRes.error) throw insertRes.error;

    DB.currentUser = insertRes.data;
    sessionStorage.setItem('rehzu_current_user', JSON.stringify(DB.currentUser));
    updateUserHeaderChip();
    closeModal();
    alert("Welcome to Rehzu, " + cleanText(DB.currentUser.name) + "!");
    await syncFromSupabase();
    resumePendingAction(callbackAction);

  } catch(err) {
    alert(safeUserError(err, "Registration failed. Please check your details and try again."));
  } finally {
    btn.disabled = false;
    btn.innerText = 'Complete & Enter Rehzu ';
  }
}

async function submitCredentialsLogin(callbackAction) {
  var btn = document.getElementById('btnLoginSubmit');
  var rawPwd = document.getElementById('loginPwd').value;
  var pwd = String(rawPwd || '');
  var identifier = '';
  var rawPhone = '';

  if (currentLoginMode === 'uid') {
    var pfx = document.getElementById('loginUidPrefix').value;
    var rawSuffix = document.getElementById('loginUidSuffix').value.trim();
    if (!rawSuffix) {
      alert("Please enter your User ID.");
      return;
    }
    var strippedSuffix = rawSuffix.replace(/^(rz|re|hr|zo|oe)/i, '').trim();
    identifier = (pfx + (strippedSuffix || rawSuffix)).toUpperCase().trim();
  } else {
    rawPhone = document.getElementById('loginPhoneInput').value.trim();
    if (!rawPhone) {
      alert("Please enter your Contact No.");
      return;
    }
  }

  if (!/^[\x21-\x7E]{6,12}$/.test(pwd)) {
    alert("Password 6–12 characters ka hona chahiye aur letter, number aur special character teeno zaroori hain.");
    return;
  }

  btn.disabled = true;
  btn.innerText = 'Authenticating...';

  try {
    // Resolve custom User ID/phone privately and verify the password through Supabase Auth.
    // The Edge Function returns no account details unless the password is correct.
    var loginResult = await sb.functions.invoke('rehzo99-login', {
      body: {
        identifier: currentLoginMode === 'uid' ? identifier : rawPhone,
        mode: currentLoginMode === 'uid' ? 'uid' : 'phone',
        password: pwd
      }
    });
    if (loginResult.error || !loginResult.data || !loginResult.data.session || !loginResult.data.profile) {
      throw new Error((loginResult.data && loginResult.data.error) || 'Invalid login details.');
    }
    var sessionResult = await sb.auth.setSession(loginResult.data.session);
    if (sessionResult.error) throw new Error('Could not establish a secure session. Please try again.');
    var verifiedLoginRes = await sb.auth.getUser();
    var verifiedLoginUser = verifiedLoginRes && verifiedLoginRes.data ? verifiedLoginRes.data.user : null;
    var profile = loginResult.data.profile;
    if (verifiedLoginRes.error || !verifiedLoginUser || !verifiedLoginUser.email ||
        verifiedLoginUser.email.toLowerCase().trim() !== String(profile.gmail || '').toLowerCase().trim()) {
      await sb.auth.signOut();
      throw new Error('Signed-in identity does not match this REHZO 99 account.');
    }

    var adminRoleCheck = await sb.rpc('rehzu_is_admin');
    profile.role = (!adminRoleCheck.error && adminRoleCheck.data === true) ? 'admin' : 'user';
    DB.currentUser = profile;
    sessionStorage.setItem('rehzu_current_user', JSON.stringify(DB.currentUser));
    updateUserHeaderChip();
    closeModal();
    alert("Logged in successfully as " + cleanText(DB.currentUser.name) + "!");
    await syncFromSupabase();
    resumePendingAction(callbackAction);
  } catch(e) {
    alert(safeUserError(e, "Login failed. Please check your details and try again."));
  } finally {
    btn.disabled = false;
    btn.innerText = 'Login with Rehzu ID ';
  }
}

function openForgotCredentialsModal() {
  recoveryFoundUser = null;

  var countryOptionsHTML = WORLD_COUNTRIES.map(function(c) {
    return '<option value="' + c.dial + '" ' + (c.code === detectedCountryCode ? 'selected' : '') + '>' + c.code + ' (' + c.dial + ')</option>';
  }).join('');

  document.getElementById('modalSlot').innerHTML = '<div class="modal-overlay">' +
    '<div class="modal-box-narrow">' +
      '<div class="modal-header">' +
        '<div style="display:flex; align-items:center; gap:8px;">' +
          '<img src="logo.svg" alt="Rehzu" style="height:26px; width:auto; object-fit:contain;" onerror="this.style.display=\'none\'">' +
          '<h3 style="font-size:15px; font-weight:800; color:#0F172A;">Account Recovery</h3>' +
        '</div>' +
        '<span onclick="closeModal()" style="cursor:pointer; font-size:16px; font-weight:bold;">✕</span>' +
      '</div>' +

      '<p style="font-size:11px; color:#64748B; margin-bottom:12px;">Enter your Contact No. and verify the linked Google Gmail to recover account access securely. Account IDs are kept private.</p>' +

      '<div class="field-box" style="margin-bottom:10px;">' +
        '<label class="field-label">Contact No. *</label>' +
        '<div class="dial-prefix-wrap">' +
          '<select id="recovCountryDial" class="dial-select-inline">' + countryOptionsHTML + '</select>' +
          '<input id="recovPhoneInput" type="tel" placeholder="Contact No." required autocomplete="off">' +
        '</div>' +
      '</div>' +

      '<button class="big-action-btn" id="btnFindMyIdOnly" onclick="executeFindMyIdOnly()">Find My ID </button>' +
      '<div id="recoveryIdResultBox" style="display:none; margin-top:14px; border-top:1px solid #E2E8F0; padding-top:12px;"></div>' +
    '</div>' +
  '</div>';
}

async function executeFindMyIdOnly() {
  var rawPhone = document.getElementById('recovPhoneInput').value.trim();
  var cleanDigits = rawPhone.replace(/\D/g, '');
  var dialDigits = String(document.getElementById('recovCountryDial').value || '').replace(/\D/g, '');
  var fullPhoneDigits = dialDigits + cleanDigits;

  if (cleanDigits.length < 1 || fullPhoneDigits.length < 7) {
    alert("Please enter a valid Contact No.");
    return;
  }

  // Never search profiles anonymously by phone; verify the linked Google identity first.
  sessionStorage.setItem('rehzu_pending_recov_phone', fullPhoneDigits);
  var btn = document.getElementById('btnFindMyIdOnly');
  btn.disabled = true;
  btn.innerText = 'Verifying linked Google Gmail...';
  await triggerRecoveryGoogleAuth();
}
async function triggerRecoveryGoogleAuth() {
  try {
    sessionStorage.setItem('rehzu_pending_recov_oauth', 'true');
    var redirectToUrl = window.location.origin + window.location.pathname;
    var oauthOptions = {
      redirectTo: redirectToUrl,
      queryParams: { prompt: 'select_account' }
    };
    var res = await sb.auth.signInWithOAuth({ provider: 'google', options: oauthOptions });
    if (res.error) throw res.error;
  } catch(e) {
    sessionStorage.removeItem('rehzu_pending_recov_oauth');
    sessionStorage.removeItem('rehzu_pending_recov_phone');
    var btn = document.getElementById('btnFindMyIdOnly');
    if (btn) { btn.disabled = false; btn.innerText = 'Find My ID '; }
    alert("Google verification failed. Please try again.");
  }
}

async function saveNewResetPassword() {
  var newPwdInput = document.getElementById('newResetPwd');
  var newPwd = newPwdInput ? String(newPwdInput.value || '') : '';

  if (!isValidRehzuPassword(newPwd)) {
    alert("Password 6–12 characters ka hona chahiye aur letter, number aur special character teeno zaroori hain.");
    return;
  }

  var targetUser = recoveryFoundUser || JSON.parse(sessionStorage.getItem('rehzu_temp_recov_user') || 'null');
  if (!targetUser || !targetUser.uid) {
    alert("Recovery session expired. Please find your ID again.");
    openForgotCredentialsModal();
    return;
  }

  var btn = document.getElementById('btnSaveNewResetPwd');
  if (btn) {
    btn.disabled = true;
    btn.innerText = 'Saving to Database...';
  }

  try {
    // Re-check the verified Google identity at the moment the password reset is submitted.
    var resetAuthRes = await sb.auth.getUser();
    var resetAuthUser = resetAuthRes && resetAuthRes.data ? resetAuthRes.data.user : null;
    var resetProviders = resetAuthUser && resetAuthUser.app_metadata
      ? (resetAuthUser.app_metadata.providers || [])
      : [];
    var resetEmail = resetAuthUser && resetAuthUser.email
      ? resetAuthUser.email.toLowerCase().trim()
      : '';
    if (
      resetAuthRes.error ||
      !resetAuthUser ||
      !resetAuthUser.email_confirmed_at ||
      !targetUser.gmail ||
      resetEmail !== targetUser.gmail.toLowerCase().trim() ||
      (resetAuthUser.app_metadata && resetAuthUser.app_metadata.provider !== 'google' && resetProviders.indexOf('google') === -1)
    ) {
      throw new Error("Verified Google account does not match this Rehzu account.");
    }

    // Reset the password inside Supabase Auth after verifying the matching Google identity.
    var authPwdUpdateRes = await sb.auth.updateUser({ password: newPwd });
    if (authPwdUpdateRes.error) throw authPwdUpdateRes.error;
    var cleanUid = String(targetUser.uid).trim();

    var checkRes = await sb.from('profiles').select('id,uid,name,phone,gmail,created_at').ilike('uid', cleanUid);
    if (checkRes.data && checkRes.data.length > 0) {
      var updatedProfile = checkRes.data[0];
      DB.currentUser = updatedProfile;
      sessionStorage.setItem('rehzu_current_user', JSON.stringify(DB.currentUser));
      sessionStorage.removeItem('rehzu_temp_recov_user');
      recoveryFoundUser = null;
      
      updateUserHeaderChip();
      closeModal();
      alert("Password reset successfully! Logged in as " + cleanText(updatedProfile.name));
      await syncFromSupabase();
    } else {
      throw new Error("Unable to verify profile update.");
    }
  } catch(err) {
    alert(safeUserError(err, "Password update failed. Please try again."));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = 'Save New Password & Login ';
    }
  }
}

async function logoutUser() {
  if (confirm("Log out from Rehzu?")) {
    try { await sb.auth.signOut(); } catch(e){}
    DB.currentUser = null;
    adminNavigationVerifiedUntil = 0;
    // Drop cached private/admin data when a session ends, especially on shared devices.
    DB.profiles = [];
    DB.bookings = [];
    DB.totalProfilesCount = 0;
    sessionStorage.removeItem('rehzu_current_user');
    var adminView = document.getElementById('view-admin');
    if (adminView) adminView.classList.remove('active');
    ['adminOwnersListContainer','adminUsersListContainer','adminReportedListingsControl'].forEach(function(id) {
      var node = document.getElementById(id);
      if (node) node.textContent = 'Sign in with an administrator account to view this area.';
    });
    updateUserHeaderChip();
    closeModal();
    alert("Logged out successfully.");
    await syncFromSupabase();
    goView('home');
  }
}

function resumePendingAction(callbackAction) {
  if (callbackAction === 'openOwnerForm') toggleOwnerForm(true);
  else if (callbackAction && callbackAction.indexOf('bookRoom:') === 0) {
    var rId = callbackAction.split(':')[1];
    openBookingPillModal(rId);
  }
}

function checkOwnerAddAction() {
  if (!DB.currentUser) {
    alert("Please sign in or create an account to list your property.");
    openProfileModal('openOwnerForm');
  } else {
    toggleOwnerForm(true);
  }
}

// Client-side admin navigation is only a UI guard. Every sensitive read/write
// must still be authorized by Supabase RLS or a server-side RPC.
var adminNavigationVerifiedUntil = 0;

function goView(viewId) {
  if (viewId === 'admin' && Date.now() > adminNavigationVerifiedUntil) {
    checkAdminAccess();
    return;
  }
  var views = document.querySelectorAll('.view');
  for (var i = 0; i < views.length; i++) views[i].classList.remove('active');
  var target = document.getElementById('view-' + viewId);
  if (target) target.classList.add('active');

  var navBtns = document.querySelectorAll('.nav-item');
  for (var j = 0; j < navBtns.length; j++) {
    if (navBtns[j].getAttribute('data-view') === viewId) navBtns[j].classList.add('active');
    else navBtns[j].classList.remove('active');
  }

  if (viewId === 'home') renderHomeGrid();
  if (viewId === 'search') renderSearchGrid();
  if (viewId === 'near') detectGPS(false);
  if (viewId === 'bookings') renderBookingsView();
  if (viewId === 'owner') renderOwnerView();
  if (viewId === 'notifications') renderNotifications();
  if (viewId === 'admin') renderAdminModeration();
  window.scrollTo(0, 0);
}

// ================= ZERO-EXPOSURE DATABASE ROLE ADMIN ACCESS =================
var adminTapCount = 0;
var adminTapTimer = null;

function handleBrandLogoTap() {
  adminTapCount++;

  if (adminTapTimer) clearTimeout(adminTapTimer);
  adminTapTimer = setTimeout(function() {
    if (adminTapCount < 5) {
      goView('home');
    }
    adminTapCount = 0;
  }, 1800);

  if (adminTapCount >= 5) {
    adminTapCount = 0;
    if (adminTapTimer) clearTimeout(adminTapTimer);
    checkAdminAccess();
  }
}

async function checkAdminAccess() {
  if (!DB.currentUser) {
    adminNavigationVerifiedUntil = 0;
    alert("Access Restricted: Please login with your Administrator account first.");
    openProfileModal();
    return;
  }

  // Never trust sessionStorage/profile.role for admin authorization.
  // Ask Supabase using the active Auth session; database RLS/RPC checks remain authoritative.
  try {
    var authResult = await sb.auth.getUser();
    if (authResult.error || !authResult.data || !authResult.data.user) {
      throw new Error("A valid signed-in session is required.");
    }
    var adminCheck = await sb.rpc('rehzu_is_admin');
    if (adminCheck.error) throw adminCheck.error;
    if (adminCheck.data === true) {
      adminEntryDataLoaded = false;
      adminNavigationVerifiedUntil = Date.now() + 15000;
      goView('admin');
    } else {
      adminNavigationVerifiedUntil = 0;
      goView('home');
      alert("Access Denied: You do not have administrator privileges.");
    }
  } catch (err) {
    adminNavigationVerifiedUntil = 0;
    goView('home');
    console.error("Admin authorization check failed:", err);
    alert("Admin verification failed. Please sign in again and retry.");
  }
}

async function reportListing(listingId) {
  if (!DB.currentUser) {
    alert("Please sign in before reporting a listing.");
    openProfileModal();
    return;
  }
  var reason = prompt("Select Report Reason:\n1. Fake Room\n2. High Demand\n3. Fake Room Owner\n4. Other\n\nEnter reason or number:");
  if (!reason) return;
  var reasonMap = {'1':'Fake Room','2':'High Demand','3':'Fake Room Owner','4':'Other'};
  var reasonText = reasonMap[String(reason).trim()] || String(reason).trim();
  if (['Fake Room','High Demand','Fake Room Owner','Other'].indexOf(reasonText) === -1) {
    alert("Invalid reason. Please choose 1, 2, 3 or 4.");
    return;
  }
  try {
    var authRes = await sb.auth.getUser();
    if (authRes.error || !authRes.data || !authRes.data.user) throw new Error("Please sign in again before reporting.");
    var reportRes = await sb.rpc('rehzu_submit_listing_report', {p_listing_id: listingId, p_reason: reasonText});
    if (reportRes.error) throw reportRes.error;
    alert("Report submitted securely. Admin can review it.");
  } catch (err) {
    console.warn("Listing report failed:", err);
    alert("Report could not be submitted. Please sign in again and retry.");
  }
}

function renderHomeGrid(items, targetGridId) {
  var confirmedRoomIds = DB.bookings
    .filter(function(b){ return b.status === 'confirmed'; })
    .map(function(b){ return b.listingId; });

  var list = (items || DB.listings.filter(function(x){ 
    var isConfirmed = confirmedRoomIds.indexOf(x.id) !== -1;
    return countryVerified && (x.status === 'available') && (!isConfirmed) && (x.daysLeft > 0) && (x.country === detectedCountryCode); 
  })).filter(function(x){ return countryVerified && x.country === detectedCountryCode; });

  var container = document.getElementById(targetGridId || 'homeRoomsGrid');
  if (!list.length) {
    container.innerHTML = targetGridId === 'searchRoomsGrid' ? '<div style="grid-column:span 2; text-align:center; padding:28px; font-size:11.5px; color:#64748B;">No matching rooms found. Try another search.</div>' : '<div style="grid-column:span 2; text-align:center; padding:28px; font-size:11.5px; color:#64748B;">No available rooms listed yet. Tap "Owner" & "+ Add" to list a room!</div>';
    return;
  }
  container.innerHTML = list.map(function(r) {
    var photosArr = (r.photos && r.photos.length) ? r.photos : [];
    var slidesHtml = photosArr.length ? photosArr.map(function(url) {
      return '<img src="' + cleanText(safeImageUrl(url)) + '" class="room-thumb-slide" loading="lazy" decoding="async" onclick="openRoomDetailsModal(\'' + safeInlineToken(r.id) + '\')" onerror="this.style.display=\'none\'">';
    }).join('') : '<div style="height:100%;min-width:100%;display:flex;align-items:center;justify-content:center;background:#EAF3EF;color:#477568;font-size:32px;">🏡<span style="font-size:10px;margin-left:8px;">No photo provided</span></div>';
    var photoControls = photosArr.length > 1 ? '<button class="room-photo-arrow prev" onclick="event.stopPropagation();scrollCardPhotos(this,-1)" aria-label="Previous photo">‹</button><button class="room-photo-arrow next" onclick="event.stopPropagation();scrollCardPhotos(this,1)" aria-label="Next photo"></button><span class="room-photo-count">1 / ' + photosArr.length + '</span>' : (photosArr.length ? '<span class="room-photo-count">1 / 1</span>' : '');

    var sym = getCurrencySymbol(r.country);
    // Owner-provided exact room location is intentionally public on available listings.
    var fullAddress = [r.address, r.city, r.state, r.pin, r.country].filter(Boolean).join(', ');
    var hasExactRoomGps = r.lat !== null && r.lat !== undefined && r.lng !== null && r.lng !== undefined &&
      r.lat !== '' && r.lng !== '' && Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lng)) &&
      Number(r.lat) >= -90 && Number(r.lat) <= 90 && Number(r.lng) >= -180 && Number(r.lng) <= 180;
    // Maps destination should contain only the room/place name and area PIN code.
    var directionsDestination = [r.houseName, r.pin].filter(Boolean).join(', ');
    // Prefer the owner's saved room GPS coordinates; use the name/PIN only for legacy listings without GPS.
    var directionsTarget = hasExactRoomGps ? (Number(r.lat) + ',' + Number(r.lng)) : directionsDestination;
    var directionsLink = 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(directionsTarget) + '&travelmode=driving&dir_action=navigate';
    var hasUserGps = Number.isFinite(Number(userGeo.lat)) && Number.isFinite(Number(userGeo.lng)) &&
      Number(userGeo.lat) >= -90 && Number(userGeo.lat) <= 90 && Number(userGeo.lng) >= -180 && Number(userGeo.lng) <= 180;
    var distanceLabel = hasUserGps && hasExactRoomGps
      ? (function(km) { return km < 1 ? Math.max(1, Math.round(km * 1000)) + ' m away' : km.toFixed(1) + ' km away'; })(getDistKm(Number(userGeo.lat), Number(userGeo.lng), Number(r.lat), Number(r.lng)))
      : '';
    var directionsLabel = 'Room Name & PIN Code';
    var discountExpiryMs = r.discountExpiresAt ? new Date(r.discountExpiresAt).getTime() : 0;
    var hasActiveHomeDiscount = r.discountEnabled === true && r.discountType === 'percent' &&
      Number.isFinite(discountExpiryMs) && discountExpiryMs > Date.now() &&
      Number.isFinite(Number(r.discountValue)) && Number(r.discountValue) >= 1 && Number(r.discountValue) <= 90;
    var homeDiscountPercent = hasActiveHomeDiscount ? Math.round(Number(r.discountValue)) : 0;
    var homeDiscountRent = hasActiveHomeDiscount ? Math.max(0, Number(r.rent) * (100 - homeDiscountPercent) / 100) : Number(r.rent);
    var homeDiscountExpiryText = hasActiveHomeDiscount
      ? new Date(discountExpiryMs).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';
    var homeRentHtml = hasActiveHomeDiscount
      ? '<div class="room-rent" style="margin:0;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px;">' +
          '<span style="font-size:9px;color:#64748B;text-decoration:line-through;font-weight:700;">' + sym + Number(r.rent).toLocaleString() + '</span>' +
          '<b style="color:#047857;">' + sym + homeDiscountRent.toLocaleString('en-IN', { maximumFractionDigits: 2 }) + '</b>' +
          '<span style="font-size:9px;font-weight:800;color:#475569;">/month</span>' +
          '<span style="font-size:9px;font-weight:900;color:#047857;background:#DCFCE7;border-radius:6px;padding:2px 5px;">' + homeDiscountPercent + '% OFF</span>' +
          '<span style="font-size:8.5px;font-weight:800;color:#047857;margin-left:3px;white-space:nowrap;">' + cleanText(homeDiscountExpiryText) + '</span>' +
        '</div>'
      : '<div class="room-rent" style="margin:0;">' + sym + Number(r.rent).toLocaleString() + '<span style="font-size:9px;font-weight:800;color:#475569;">/month</span></div>';
    var suitableText = (r.suitableFor && r.suitableFor.length) ? r.suitableFor.join(', ') : 'Anyone';
    var amenitiesText = (r.amenities && r.amenities.length) ? r.amenities.join(', ') : 'Basic amenities';
    return '<div class="room-card" role="button" tabindex="0" aria-label="View full details for ' + cleanText(r.houseName) + '" onclick="openRoomDetailsModal(\'' + safeInlineToken(r.id) + '\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();openRoomDetailsModal(\'' + safeInlineToken(r.id) + '\')}" style="cursor:pointer;">' +
      '<div class="room-thumb-wrap" style="height:112px;min-height:112px;overflow:hidden;">' +
        slidesHtml + photoControls +
        '<div class="badge-stack">' +
          '<span class="avail-badge">Available</span>' +
          '<button class="report-flag-btn" onclick="reportListing(\'' + safeInlineToken(r.id) + '\')">🚩 Report</button>' +
        '</div>' +
      '</div>' +
      '<div class="room-details" style="padding:7px 9px 8px;" onclick="openRoomDetailsModal(\'' + safeInlineToken(r.id) + '\')">' +
        '<div class="room-title" onclick="openRoomDetailsModal(\'' + safeInlineToken(r.id) + '\')">' + cleanText(r.houseName) + '</div>' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:7px;margin:4px 0 5px;flex-wrap:wrap;">' +
          homeRentHtml +
          '<div style="font-size:9px;font-weight:800;color:#334155;text-align:right;">Security Deposit: ' + (Number(r.deposit || 0) > 0 ? sym + Number(r.deposit).toLocaleString() : 'Not specified') + '</div>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin:0 0 4px;">' +
          '<div style="min-width:0;font-size:9px;color:#475569;"><span style="display:block;font-size:7px;color:#475569;font-weight:900;text-transform:uppercase;margin-bottom:0;">Room Type</span><b>' + cleanText(r.roomType || 'Room') + '</b></div>' +
          '<div style="min-width:0;font-size:10px;color:#475569;"><span style="display:block;font-size:8px;color:#475569;font-weight:900;text-transform:uppercase;margin-bottom:1px;">Suitable For</span><b>' + cleanText(suitableText) + '</b></div>' +
        '</div>' +
        '<div class="room-extra-detail" style="margin:2px 0;font-size:9px;font-weight:800;color:#334155;">📍 <b>Room Address:</b> ' + cleanText(fullAddress || 'Owner has not provided an exact address') + '</div>' +
        (distanceLabel ? '<div class="room-extra-detail" style="margin:2px 0 5px;font-size:9px;font-weight:900;color:#047857;">🧭 ' + cleanText(distanceLabel) + '</div>' : '') +
                '<div class="room-card-actions">' +
          '<button class="book-btn" onclick="event.stopPropagation();triggerBookRoomFlow(\'' + safeInlineToken(r.id) + '\')">Book Now</button>' +
          '<a class="room-directions-btn" href="' + directionsLink + '" onclick="event.stopPropagation();" target="_blank" rel="noopener noreferrer" aria-label="Navigate from your current location to ' + cleanText(r.houseName) + '" title="' + directionsLabel + '">🧭 ' + (hasExactRoomGps ? 'Navigate to Room' : 'Location') + '</a>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function triggerBookRoomFlow(roomId) {
  var r = DB.listings.find(function(x){ return x.id === roomId; });
  if (!r) return;

  if (r.status !== 'available') {
    alert("This room is already confirmed and booked by another tenant!");
    return;
  }

  if (!DB.currentUser) {
    alert("Please sign in or create an account to book this room.");
    openProfileModal('bookRoom:' + roomId);
    return;
  }

  var cleanOwnerPhone = normalizePhoneDigits(r.phone);
  var cleanUserPhone = normalizePhoneDigits(DB.currentUser.phone);

  if (DB.currentUser.uid === r.ownerUid || (cleanUserPhone && cleanOwnerPhone === cleanUserPhone)) {
    alert("Cannot book this room! You are the registered owner of this property.");
    return;
  }

  openBookingPillModal(roomId);
}

function scrollCardPhotos(button, direction) {
  var wrap = button.parentElement;
  if (!wrap) return;
  var width = wrap.clientWidth || 1;
  wrap.scrollBy({ left: direction * width, behavior: 'smooth' });
  var counter = wrap.querySelector('.room-photo-count');
  if (counter) {
    var count = wrap.querySelectorAll('.room-thumb-slide').length;
    setTimeout(function() {
      var actual = Math.round(wrap.scrollLeft / (wrap.clientWidth || 1));
      counter.textContent = (Math.max(0, Math.min(count - 1, actual)) + 1) + ' / ' + count;
    }, 350);
  }
}
function scrollModalRoomPhotos(direction) {
  var track = document.getElementById('modalRoomPhotoTrack');
  if (!track) return;
  track.scrollBy({ left: direction * (track.clientWidth || 1), behavior: 'smooth' });
  var counter = document.getElementById('modalRoomPhotoCount');
  if (counter) {
    var count = track.querySelectorAll('img').length;
    setTimeout(function() {
      var index = Math.round(track.scrollLeft / (track.clientWidth || 1));
      counter.textContent = (Math.max(0, Math.min(count - 1, index)) + 1) + ' / ' + count;
    }, 350);
  }
}

function openRoomDetailsModal(roomId) {
  var r = DB.listings.find(function(x){ return x.id === roomId; });
  if (!r) return;

  var photosArr = (r.photos && r.photos.length) ? r.photos : ['https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=600'];
  var modalSlidesHtml = photosArr.map(function(url) {
    return '<img src="' + cleanText(safeImageUrl(url)) + '" alt="Room photo" onerror="this.style.display=\'none\'">';
  }).join('');
  var modalPhotoControls = photosArr.length > 1 ? '<button class="room-photo-arrow prev" onclick="scrollModalRoomPhotos(-1)" aria-label="Previous photo">‹</button><button class="room-photo-arrow next" onclick="scrollModalRoomPhotos(1)" aria-label="Next photo"></button><span class="room-photo-count" id="modalRoomPhotoCount">1 / ' + photosArr.length + '</span>' : '<span class="room-photo-count">1 / 1</span>';

  var sym = getCurrencySymbol(r.country);
  var discountExpiryMs = r.discountExpiresAt ? new Date(r.discountExpiresAt).getTime() : 0;
  var hasActiveDetailDiscount = r.discountEnabled === true && Number.isFinite(discountExpiryMs) &&
    discountExpiryMs > Date.now() && Number.isFinite(Number(r.discountValue)) && Number(r.discountValue) > 0;
  var detailDiscountAmount = hasActiveDetailDiscount
    ? (r.discountType === 'fixed'
        ? Math.min(Number(r.rent) || 0, Number(r.discountValue))
        : (Number(r.rent) || 0) * Math.min(90, Number(r.discountValue)) / 100)
    : 0;
  var detailDiscountRent = Math.max(0, (Number(r.rent) || 0) - detailDiscountAmount);
  var detailDiscountExpiryText = hasActiveDetailDiscount
    ? new Date(discountExpiryMs).toLocaleString('en-IN', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })
    : '';
  var detailDiscountHtml = hasActiveDetailDiscount
    ? '<div style="margin:0 0 10px;padding:10px 12px;border:1px solid #86efac;border-radius:12px;background:linear-gradient(135deg,#f0fdf4,#dcfce7);">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">' +
          '<b style="font-size:12px;color:#166534;">🎉 Owner Discount Active</b>' +
          '<span style="font-size:11px;font-weight:900;color:#166534;background:#bbf7d0;padding:3px 8px;border-radius:20px;">' +
            (r.discountType === 'fixed' ? sym + Number(r.discountValue).toLocaleString('en-IN') + ' OFF' : Number(r.discountValue) + '% OFF') +
          '</span></div>' +
        '<div style="display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;margin-top:6px;">' +
          '<span style="font-size:11px;color:#64748b;text-decoration:line-through;">' + sym + Number(r.rent).toLocaleString('en-IN') + '/month</span>' +
          '<b style="font-size:17px;color:#047857;">' + sym + detailDiscountRent.toLocaleString('en-IN', {maximumFractionDigits:2}) + '/month</b>' +
        '</div>' +
        '<div style="font-size:10px;color:#166534;font-weight:800;margin-top:4px;">You save ' + sym + detailDiscountAmount.toLocaleString('en-IN', {maximumFractionDigits:2}) + ' every month</div>' +
      '</div>'
    : '';

  var suitableBadges = (r.suitableFor && r.suitableFor.length)
    ? r.suitableFor.map(function(s){ return '<span style="display:inline-block; padding:3px 9px; background:#E6F3ED; color:#044E3B; border-radius:14px; font-size:10px; font-weight:700; margin:2px;">• ' + cleanText(s) + '</span>'; }).join('')
    : '<span style="font-size:10.5px; color:#64748B;">Anyone</span>';

  var amenitiesBadges = (r.amenities && r.amenities.length)
    ? r.amenities.map(function(a){ return '<span style="display:inline-block; padding:3px 9px; background:#F1F5F9; color:#334155; border-radius:14px; font-size:10px; font-weight:700; margin:2px;">✓ ' + cleanText(a) + '</span>'; }).join('')
    : '<span style="font-size:10.5px; color:#64748B;">Basic amenities</span>';

  var rulesBadges = (r.rules && r.rules.length)
    ? r.rules.map(function(ru){ return '<span style="display:inline-block; padding:3px 9px; background:#FEF2F2; color:#991B1B; border-radius:14px; font-size:10px; font-weight:700; margin:2px;">⚠️ ' + cleanText(ru) + '</span>'; }).join('')
    : '<span style="font-size:10.5px; color:#64748B;">Standard house rules apply</span>';

  // Show the exact owner-submitted address and open the exact pin when coordinates exist.
  var mapsAddress = [r.address, r.city, r.state, r.pin, r.country].filter(Boolean).join(', ');
  var exactMapQuery = (r.lat != null && r.lng != null) ? String(r.lat) + ',' + String(r.lng) : mapsAddress;
  var mapsLink = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(exactMapQuery);

  document.getElementById('modalSlot').innerHTML = '<div class="modal-overlay">' +
    '<div class="modal-box-narrow booking-modal-box" style="max-width:560px;">' +
      '<div class="modal-header">' +
        '<div style="display:flex; align-items:center; gap:8px;">' +
          '<img src="logo.svg" alt="Rehzu" style="height:24px; width:auto; object-fit:contain;" onerror="this.style.display=\'none\'">' +
          '<h3 style="font-size:15px; font-weight:800; color:#0F172A;">Property Overview</h3>' +
        '</div>' +
        '<span onclick="closeModal()" style="cursor:pointer; font-size:16px; font-weight:bold;">✕</span>' +
      '</div>' +
      '<div style="position:relative; margin-bottom:14px;"><div class="room-modal-photo-track" id="modalRoomPhotoTrack">' + modalSlidesHtml + '</div>' + modalPhotoControls + '</div>' +
      '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">' +
        '<h2 style="font-size:16px; font-weight:900; color:#0F172A;">' + cleanText(r.houseName) + '</h2>' +
        '<span style="background:#ECFDF5; color:#044E3B; padding:3px 8px; border-radius:12px; font-size:10px; font-weight:800;">' + cleanText(r.roomType) + '</span>' +
      '</div>' +
      '<div id="listingRatingSummary" style="font-size:11px;font-weight:800;color:#92400E;margin:0 0 8px;">⭐ Loading ratings...</div>' +
      (hasActiveDetailDiscount ? detailDiscountHtml : '<div style="font-size:15px; font-weight:900; color:#044E3B; margin-bottom:8px;">' + sym + Number(r.rent).toLocaleString() + ' <span style="font-size:10px; color:#64748B; font-weight:normal;">/ month</span></div>') +
      '<div class="room-address-panel"><div style="font-size:12px;font-weight:900;color:#0F172A;margin-bottom:5px;">📍 Room Location</div>' +
        '<div style="font-weight:800;color:#334155;">' + cleanText(mapsAddress || 'Exact address not provided by owner') + '</div>' +

        '' +
        '<div style="font-weight:800;color:#334155;">💵 <b>Security Deposit:</b> ' + sym + Number(r.deposit || 0).toLocaleString() + '</div>' +
      '</div>' +
      '<div style="margin-bottom:8px;"><div style="font-size:11px; font-weight:800; color:#0F172A; margin-bottom:3px;">👥 Suitable For:</div><div>' + suitableBadges + '</div></div>' +
      '<div style="margin-bottom:8px;"><div style="font-size:11px; font-weight:800; color:#0F172A; margin-bottom:3px;">✨ Amenities Included:</div><div>' + amenitiesBadges + '</div></div>' +
      '<div style="margin-bottom:12px;"><div style="font-size:11px; font-weight:800; color:#0F172A; margin-bottom:3px;">📋 Owner Conditions & Rules:</div><div>' + rulesBadges + '</div></div>' +
      '<button class="big-action-btn" onclick="closeModal(); triggerBookRoomFlow(\'' + safeInlineToken(r.id) + '\')">Book This Room Now </button>' +
    '</div>' +
  '</div>';
  loadListingReviewSummary(r.id);
}

async function handleSearch(val) {
  var q = String(val || '').trim();
  var alertBox = document.getElementById('trlAlertBox');
  var slipButton = document.getElementById('trlViewSlipBtn');
  if (q.length === 12 && /^(?:[0-9]{12}|[A-F0-9]{12})$/i.test(q)) {
    var authCheck = await sb.auth.getUser();
    if (!authCheck || authCheck.error || !authCheck.data || !authCheck.data.user) {
      alertBox.style.display = 'block';
      alertBox.style.background = '#FFF7ED';
      alertBox.style.borderColor = '#FDBA74';
      alertBox.querySelector('b').innerText = 'Login required for TRL verification';
      document.getElementById('trlAlertDetails').innerText = 'Please log in to your REHZO 99 account before verifying a TRL.';
      slipButton.style.display = 'none';
      if (typeof openProfileModal === 'function') openProfileModal();
      return;
    }
    var verifyRes = await sb.rpc('rehzu_verify_trl', { p_trl: q.toUpperCase() });
    if (verifyRes.error) {
      alertBox.style.display = 'block';
      alertBox.style.background = '#FFF7ED';
      alertBox.style.borderColor = '#FDBA74';
      alertBox.querySelector('b').innerText = 'TRL verification temporarily unavailable';
      document.getElementById('trlAlertDetails').innerText = 'Please retry in a moment. No booking details are shown until the database verifies the TRL.';
      slipButton.style.display = 'none';
      return;
    }
    var record = verifyRes.data || {};
    if (record.verification_status === 'rate_limited') {
      alertBox.style.display = 'block';
      alertBox.style.background = '#FFF7ED';
      alertBox.style.borderColor = '#FDBA74';
      alertBox.querySelector('b').innerText = 'TRL verification rate limit reached';
      document.getElementById('trlAlertDetails').innerText = 'Too many verification attempts. Please wait a minute and try again.';
      slipButton.style.display = 'none';
      return;
    }
    if (record.verification_status === 'valid' || record.verification_status === 'expired') {
      var ownBooking = DB.bookings.find(function(x){ return x.trl === q.toUpperCase(); });
      var isExpired = record.verification_status === 'expired';
      var issuedText = record.issued_at ? new Date(record.issued_at).toLocaleDateString('en-IN', {day:'2-digit',month:'short',year:'numeric'}) : '—';
      var expiryText = record.expires_at ? new Date(record.expires_at).toLocaleDateString('en-IN', {day:'2-digit',month:'short',year:'numeric'}) : '—';
      matchedBookingId = ownBooking ? ownBooking.id : null;
      alertBox.style.display = 'block';
      alertBox.style.background = isExpired ? '#FFF7ED' : '#ECFDF5';
      alertBox.style.borderColor = isExpired ? '#FDBA74' : '#10B981';
      alertBox.querySelector('b').innerText = isExpired ? '⌛ REHZO 99 TRL EXPIRED' : '✓ REHZO 99 TRL VERIFIED';
      document.getElementById('trlAlertDetails').innerText = record.history_deleted
        ? 'Booking History securely deleted after its retention period. Only this TRL expiry marker remains • Issued: ' + issuedText + ' • Expired: ' + expiryText
        : cleanText(record.house_name || 'Room booking') + ' • ' + cleanText(record.room_type || 'Room') +
          ' • Booking: ' + cleanText(String(record.booking_status || 'confirmed').toUpperCase()) +
          ' • Issued: ' + issuedText + ' • Valid until: ' + expiryText;
      if (record.history_deleted) {
        slipButton.style.display = 'none';
      } else if (ownBooking) {
        slipButton.style.display = '';
        slipButton.innerText = 'View My Official TRL Slip';
        slipButton.onclick = function() { openSlipModal(ownBooking.id); };
      } else {
        slipButton.style.display = 'none';
      }
      return;
    }
  }
  alertBox.style.display = 'none';
  slipButton.style.display = '';

  var sLow = q.toLowerCase();
  var confirmedRoomIds = DB.bookings
    .filter(function(b){ return b.status === 'confirmed'; })
    .map(function(b){ return b.listingId; });

  var filtered = DB.listings.filter(function(l) {
    var isConfirmed = confirmedRoomIds.indexOf(l.id) !== -1;
    return (l.status === 'available') && (!isConfirmed) && (l.daysLeft > 0) && (l.country === detectedCountryCode) && (
      l.houseName.toLowerCase().indexOf(sLow) !== -1 ||
      l.city.toLowerCase().indexOf(sLow) !== -1 ||
      l.roomType.toLowerCase().indexOf(sLow) !== -1
    );
  });
  renderHomeGrid(filtered);
}

function handleAdvancedSearch(val) {
  var q = val.toLowerCase().trim();
  var container = document.getElementById('searchRoomsGrid');
  if (!q) {
    container.innerHTML = '';
    return;
  }
  var confirmedRoomIds = DB.bookings
    .filter(function(b){ return b.status === 'confirmed'; })
    .map(function(b){ return b.listingId; });

  var filtered = DB.listings.filter(function(l) {
    var isConfirmed = confirmedRoomIds.indexOf(l.id) !== -1;
    if (!countryVerified || l.country !== detectedCountryCode || l.status !== 'available' || isConfirmed || l.daysLeft <= 0) return false;
    if (!q) return true;

    var fullTargetText = [
      l.country,
      l.state,
      l.city,
      l.pin,
      l.address,
      l.houseName,
      l.roomType
    ].join(' ').toLowerCase();

    var qWords = q.split(/\s+/);
    return qWords.every(function(word) {
      return fullTargetText.indexOf(word) !== -1;
    });
  });

  renderHomeGrid(filtered, 'searchRoomsGrid');
}

function applyFilters() {
  var c = detectedCountryCode;
  var countrySelect = document.getElementById('countryFilter');
  if (countrySelect && countryVerified) countrySelect.value = detectedCountryCode;
  var t = document.getElementById('typeFilter').value;
  var confirmedRoomIds = DB.bookings
    .filter(function(b){ return b.status === 'confirmed'; })
    .map(function(b){ return b.listingId; });

  var filtered = DB.listings.filter(function(l) {
    var isConfirmed = confirmedRoomIds.indexOf(l.id) !== -1;
    return (l.status === 'available') && (!isConfirmed) && (l.daysLeft > 0) && (!c || l.country === c) && (!t || l.roomType === t);
  });
  renderHomeGrid(filtered);
}

function filterChip(cat, el) {
  var chips = document.querySelectorAll('.chip');
  for (var i = 0; i < chips.length; i++) chips[i].classList.remove('active');
  el.classList.add('active');
  if (cat === 'all') renderHomeGrid();
  else {
    var confirmedRoomIds = DB.bookings
      .filter(function(b){ return b.status === 'confirmed'; })
      .map(function(b){ return b.listingId; });

    var filtered = DB.listings.filter(function(l){
      var isConfirmed = confirmedRoomIds.indexOf(l.id) !== -1;
      return (l.status === 'available') && (!isConfirmed) && (l.daysLeft > 0) && (l.country === detectedCountryCode) && (l.suitableFor.indexOf(cat) !== -1 || l.suitableFor.indexOf(cat+'s') !== -1);
    });
    renderHomeGrid(filtered);
  }
}

function getDistKm(lat1, lon1, lat2, lon2) {
  var R = 6371;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLon = (lon2 - lon1) * Math.PI / 180;
  var a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)*Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function renderNearGrid() {
  var container = document.getElementById('nearRoomsGrid');
  var count = document.getElementById('nearResultsCount');
  var radiusKm = 2;
  if (!container) return;

  if (!Number.isFinite(userGeo.lat) || !Number.isFinite(userGeo.lng)) {
    if (count) count.innerText = 'GPS required';
    container.innerHTML = '<div style="grid-column:1/-1;background:#fff;border:1px solid #E2E8F0;border-radius:18px;padding:25px 18px;text-align:center;">' +
      '<div style="font-size:32px;margin-bottom:8px;">🧭</div>' +
      '<div style="font-size:14px;font-weight:850;color:#0F172A;margin-bottom:6px;">Turn on your location</div>' +
      '<div style="font-size:11px;line-height:1.6;color:#64748B;max-width:280px;margin:0 auto 14px;">REHZO 99 needs your permission to calculate real distances. We will not guess your location or show made-up nearby results.</div>' +
      '<button onclick="detectGPS(true)" style="background:#044E3B;color:#fff;border:0;border-radius:12px;padding:10px 16px;font-size:11px;font-weight:800;">Allow location access</button>' +
      '</div>';
    return;
  }

  var confirmedRoomIds = DB.bookings
    .filter(function(b){ return b.status === 'confirmed'; })
    .map(function(b){ return b.listingId; });
  var near = [];
  for (var i = 0; i < DB.listings.length; i++) {
    var l = DB.listings[i];
    var isConfirmed = confirmedRoomIds.indexOf(l.id) !== -1;
    if (countryVerified && l.country === detectedCountryCode && l.status === 'available' && !isConfirmed && l.daysLeft > 0 &&
        l.lat !== null && l.lat !== undefined && l.lng !== null && l.lng !== undefined &&
        l.lat !== '' && l.lng !== '' && Number.isFinite(Number(l.lat)) && Number.isFinite(Number(l.lng)) && l.country === detectedCountryCode) {
      var d = getDistKm(userGeo.lat, userGeo.lng, Number(l.lat), Number(l.lng));
      if (d <= radiusKm) near.push(Object.assign({}, l, { distKm: d }));
    }
  }
  near.sort(function(a,b){ return a.distKm - b.distKm; });
  if (count) {
    count.innerText = near.length + (near.length === 1 ? ' room found' : ' rooms found');
    count.style.display = near.length ? '' : 'none';
  }
  if (!near.length) {
    container.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:24px 12px;color:#64748B;font-size:13px;font-weight:800;">Rooms Not Available</div>';
    return;
  }
  container.innerHTML = near.map(function(r) {
    var photosArr = (r.photos && r.photos.length) ? r.photos : [];
    var slidesHtml = photosArr.length ? photosArr.map(function(url) {
      return '<img src="' + cleanText(safeImageUrl(url)) + '" class="room-thumb-slide" loading="lazy" decoding="async" alt="' + cleanText(r.houseName || 'Room photo') + '" onclick="openRoomDetailsModal(\'' + safeInlineToken(r.id) + '\')" onerror="this.style.display=\'none\'">';
    }).join('') : '<div style="height:100%;min-height:145px;display:flex;align-items:center;justify-content:center;background:#EAF3EF;color:#477568;font-size:32px;">🏡<span style="font-size:10px;margin-left:8px;">No photo provided</span></div>';
    var sym = getCurrencySymbol(r.country);
    var fullAddress = [r.address, r.city, r.state, r.pin, r.country].filter(Boolean).join(', ');
    var suitableText = (r.suitableFor && r.suitableFor.length) ? r.suitableFor.join(', ') : 'Anyone';
    return '<div class="room-card">' +
      '<div class="room-thumb-wrap">' + slidesHtml +
        '<div class="badge-stack"><span class="avail-badge">' + r.distKm.toFixed(1) + ' km away</span>' +
        '<button class="report-flag-btn" onclick="reportListing(\'' + safeInlineToken(r.id) + '\')">🚩 Report</button></div>' +
      '</div><div class="room-details">' +
        '<div class="room-title" onclick="openRoomDetailsModal(\'' + safeInlineToken(r.id) + '\')">' + cleanText(r.houseName) + '</div>' +
        '<div class="room-rent">' + sym + Number(r.rent).toLocaleString() + '<span style="font-size:10px;font-weight:600;color:#64748B;"> / month</span></div>' +
        '<div style="display:flex;justify-content:space-between;gap:6px;flex-wrap:wrap;font-size:9px;color:#475569;margin:4px 0;"><span><b>Security Deposit:</b> ' + (Number(r.deposit || 0) > 0 ? sym + Number(r.deposit).toLocaleString() : 'Not specified') + '</span><span><b>Room Type:</b> ' + cleanText(r.roomType || 'Room') + '</span></div>' +
        '<div style="font-size:9px;color:#475569;margin:3px 0;"><b>Suitable For:</b> ' + cleanText(suitableText) + '</div>' +
        '<div class="room-extra-detail" style="font-size:9px;line-height:1.45;overflow-wrap:anywhere;margin:3px 0 7px;">📍 <b>Exact Room Address:</b> ' + cleanText(fullAddress || 'Owner has not provided an exact address') + '</div>' +
        '<button class="book-btn" onclick="triggerBookRoomFlow(\'' + safeInlineToken(r.id) + '\')">View & Book</button>' +
      '</div></div>';
  }).join('');
}

var rehzuNearGpsRequestId = 0;
async function detectGPS(isManual) {
  var statusText = document.getElementById('nearStatusText');
  var btn = document.getElementById('gpsRefreshBtn');
  if (!statusText) return;
  var requestId = ++rehzuNearGpsRequestId;
  userGeo = { lat: null, lng: null };
  renderNearGrid();
  statusText.innerText = 'Detecting real live GPS…';
  if (btn) { btn.innerText = 'Finding…'; btn.disabled = true; }

  try {
    // Use one fresh, high-accuracy GPS fix for both nearby distance and
    // server-verified country. Never accept a stale cached location.
    var coords = await getFreshDeviceCoordinates(100);
    if (requestId !== rehzuNearGpsRequestId) return;
    var previousCountry = detectedCountryCode;
    var verified = await autoDetectUserCountry(coords);
    if (!verified) throw new Error('Your current country could not be securely verified. Check your connection and try again.');
    if (requestId !== rehzuNearGpsRequestId) return;

    userGeo = { lat: coords.latitude, lng: coords.longitude };
    if (previousCountry !== detectedCountryCode) {
      DB.listings = [];
      await syncFromSupabase();
    }
    statusText.innerText = '✓ Live GPS detected · accuracy ' + Math.round(coords.accuracy) + ' m · nearby rooms updated';
    renderNearGrid();
  } catch (error) {
    if (requestId !== rehzuNearGpsRequestId) return;
    userGeo = { lat: null, lng: null };
    statusText.innerText = error && error.message ? error.message : 'GPS could not be detected. Turn on precise location and try again.';
    renderNearGrid();
  } finally {
    if (requestId === rehzuNearGpsRequestId && btn) {
      btn.innerText = 'Find Room';
      btn.disabled = false;
    }
  }
}

function renderSearchGrid() {
  handleAdvancedSearch(document.getElementById('searchScreenInput') ? document.getElementById('searchScreenInput').value : '');
}

function switchBookingsTab(tab) {
  currentBookingsTab = tab;
  document.getElementById('tabBookingsCurrent').className = 'sub-tab-btn ' + (tab==='current'?'active':'');
  document.getElementById('tabBookingsConfirm').className = 'sub-tab-btn ' + (tab==='confirm'?'active':'');
  document.getElementById('tabBookingsCancelled').className = 'sub-tab-btn ' + (tab==='cancelled'?'active':'');
  renderBookingsView();
}


var rehzuReviewBookingId = '';
var rehzuSelectedReviewRating = 0;
function isBookingReviewWindowOpen(b) {
  if (!b || b.status !== 'confirmed') return false;
  var months = Math.max(1, Math.min(36, parseInt(b.duration, 10) || 1));
  var m = String(b.date || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return false;
  var target = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + months, 1));
  var last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return Date.now() >= Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(Number(m[3]), last));
}
function selectRehzuReviewRating(value) {
  rehzuSelectedReviewRating = Math.max(1, Math.min(5, Number(value) || 0));
  document.querySelectorAll('.rehzu-review-star').forEach(function(btn) {
    var on = Number(btn.getAttribute('data-rating')) <= rehzuSelectedReviewRating;
    btn.textContent = on ? '★' : '☆'; btn.style.color = on ? '#D97706' : '#94A3B8';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}
async function openBookingReviewModal(bookingId) {
  var booking = DB.bookings.find(function(x) { return x.id === bookingId; });
  if (!booking || !isBookingReviewWindowOpen(booking)) {
    showRehzuSystemAlert('You can rate this room after your booked stay is completed.', 'Rating not available yet'); return;
  }
  var loaded = await sb.rpc('rehzu_get_my_booking_review', { p_booking_id: bookingId });
  if (loaded.error) { showRehzuSystemAlert('Could not load your rating. Please try again.', 'Rating unavailable'); return; }
  var existing = loaded.data || null;
  rehzuReviewBookingId = bookingId; rehzuSelectedReviewRating = existing ? Number(existing.rating) : 0;
  document.getElementById('modalSlot').innerHTML =
    '<div class="modal-overlay"><div class="modal-box-narrow booking-modal-box" style="max-width:440px;">' +
    '<div class="modal-header"><h3 style="font-size:15px;font-weight:900;">Rate Your Stay</h3><span onclick="closeModal()" style="cursor:pointer;font-size:18px;">✕</span></div>' +
    '<div style="padding:16px;"><div style="font-size:14px;font-weight:900;margin-bottom:4px;">' + cleanText(booking.houseName) + '</div>' +
    '<div style="font-size:11px;color:#64748B;margin-bottom:12px;">Share an honest rating about your completed stay.</div>' +
    '<div style="display:flex;gap:8px;justify-content:center;margin:14px 0;">' +
    [1,2,3,4,5].map(function(n) { return '<button type="button" class="rehzu-review-star" data-rating="' + n + '" aria-label="' + n + ' stars" aria-pressed="false" onclick="selectRehzuReviewRating(' + n + ')" style="border:0;background:transparent;font-size:34px;color:#94A3B8;padding:2px;cursor:pointer;">☆</button>'; }).join('') +
    '</div><label for="rehzuReviewText" style="display:block;font-size:11px;font-weight:800;margin:10px 0 5px;">Your review (optional, up to 500 characters)</label>' +
    '<textarea id="rehzuReviewText" maxlength="500" rows="4" placeholder="How was the room and your stay?" style="width:100%;box-sizing:border-box;border:1px solid #CBD5E1;border-radius:12px;padding:10px;font:inherit;font-size:12px;resize:vertical;"></textarea>' +
    '<div id="rehzuReviewStatus" style="font-size:11px;color:#64748B;margin:8px 0;"></div><button id="rehzuReviewSubmit" class="big-action-btn" onclick="submitRehzuBookingReview()">Submit Rating</button></div></div></div>';
  if (existing) {
    selectRehzuReviewRating(existing.rating);
    document.getElementById('rehzuReviewText').value = existing.review || '';
    document.getElementById('rehzuReviewText').readOnly = true;
    document.getElementById('rehzuReviewStatus').textContent = 'You have already rated this booking. Ratings cannot be changed.';
    document.getElementById('rehzuReviewSubmit').style.display = 'none';
    document.querySelectorAll('.rehzu-review-star').forEach(function(btn) { btn.disabled = true; btn.style.cursor = 'default'; });
  }
}
async function submitRehzuBookingReview() {
  var rating = rehzuSelectedReviewRating;
  var review = document.getElementById('rehzuReviewText') ? document.getElementById('rehzuReviewText').value.trim() : '';
  if (!rehzuReviewBookingId || rating < 1 || rating > 5) { showRehzuSystemAlert('Please select a star rating from 1 to 5.', 'Choose a rating'); return; }
  var submit = document.getElementById('rehzuReviewSubmit');
  if (submit) { submit.disabled = true; submit.textContent = 'Submitting...'; }
  var result = await sb.rpc('rehzu_submit_listing_review', { p_booking_id: rehzuReviewBookingId, p_rating: rating, p_review: review });
  if (result.error) {
    if (submit) { submit.disabled = false; submit.textContent = 'Submit Rating'; }
    showRehzuSystemAlert('Your rating could not be saved. Please check that your stay is complete and try again.', 'Rating not saved'); return;
  }
  closeModal(); showRehzuSystemAlert('Thank you! Your verified rating has been saved.', 'Rating submitted');
  await syncFromSupabase();
}
async function loadListingReviewSummary(listingId) {
  var target = document.getElementById('listingRatingSummary'); if (!target) return;
  var result = await sb.rpc('rehzu_get_listing_review_summary', { p_listing_id: listingId });
  target = document.getElementById('listingRatingSummary'); if (!target) return;
  if (result.error || !result.data) { target.textContent = '⭐ Ratings temporarily unavailable'; return; }
  var count = Number(result.data.count) || 0, average = Number(result.data.average) || 0;
  target.textContent = count ? ('⭐ ' + average.toFixed(1) + ' / 5 · ' + count + ' verified ' + (count === 1 ? 'rating' : 'ratings')) : '☆ No ratings yet';
}

function renderBookingsView() {
  var container = document.getElementById('bookingsListContainer');

  if (!DB.currentUser) {
    container.innerHTML = '<div style="background:#fff; border:1px solid #E2E8F0; border-radius:16px; padding:32px 16px; text-align:center;">' +
      '<div style="font-size:36px; margin-bottom:8px;">🔒</div>' +
      '<h4 style="font-size:14px; font-weight:800; color:#0F172A; margin-bottom:4px;">Login Required</h4>' +
      '<p style="font-size:11px; color:#64748B; margin-bottom:14px;">Please login to view and manage your booked stays.</p>' +
      '<button class="big-action-btn" style="max-width:200px; margin:0 auto; padding:8px 16px; font-size:11.5px;" onclick="openProfileModal()">Login Now</button>' +
    '</div>';
    return;
  }

  var list = [];
  if (currentBookingsTab === 'current') {
    list = DB.bookings.filter(function(b){ return b.status === 'pending' || b.status === 'owner_accepted' || b.status === 'cancel_pending'; });
  } else if (currentBookingsTab === 'confirm') {
    list = DB.bookings.filter(function(b){ return b.status === 'confirmed'; });
  } else if (currentBookingsTab === 'cancelled') {
    list = DB.bookings.filter(function(b){ return b.status === 'cancelled' || b.status === 'rejected'; });
  }

  var myUid = String(DB.currentUser.uid || '').toUpperCase().trim();
  var myPhoneTen = normalizePhoneDigits(DB.currentUser.phone);

  list = list.filter(function(b){ 
    var bookingPhoneTen = normalizePhoneDigits(b.userPhone);
    return (b.userUid && b.userUid.toUpperCase().trim() === myUid) || (myPhoneTen && bookingPhoneTen && myPhoneTen === bookingPhoneTen); 
  });

  if (!list.length) {
    container.innerHTML = '<div style="background:#fff; border:1px solid #E2E8F0; border-radius:16px; padding:24px; text-align:center; font-size:11.5px; color:#64748B;">No ' + cleanText(currentBookingsTab) + ' bookings found.</div>';
    return;
  }

  container.innerHTML = list.map(function(b) {
    var l = DB.listings.find(function(x){ return x.id === b.listingId; });
    var cover = cleanText(safeImageUrl((l && l.photos && l.photos.length) ? l.photos[0] : 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=600'));
    var isConfirmed = (b.status === 'confirmed');
    var isOwnerAccepted = (b.status === 'owner_accepted');
    var isPending = (b.status === 'pending');
    var isCancelPending = (b.status === 'cancel_pending');

    var pillClass = isConfirmed ? 'status-confirmed' : (isOwnerAccepted ? 'status-owner-accepted' : (isPending ? 'status-pending' : (isCancelPending ? 'status-cancel-pending' : 'status-cancelled')));
    var statusText = isConfirmed ? 'CONFIRMED' : (isOwnerAccepted ? 'OWNER ACCEPTED (CONFIRM NOW)' : (isPending ? 'WAITING OWNER' : (isCancelPending ? 'CANCEL PENDING' : b.status.toUpperCase())));
    var totalRent = Math.max(0, ((parseFloat(b.rent) || 0) * (parseInt(b.duration) || 1)) - (parseFloat(b.discountTotal) || 0)) + (parseFloat(b.deposit) || 0);
    var sym = getCurrencySymbol(l ? l.country : 'IN');

    return '<div class="compact-h-card">' +
      '<img src="' + cover + '" class="compact-h-img" loading="lazy" decoding="async" onerror="this.src=\'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=600\'">' +
      '<div class="compact-h-content">' +
        '<div class="compact-h-header">' +
          '<div class="compact-h-title">' + cleanText(b.houseName) + '</div>' +
          '<span class="status-pill ' + pillClass + '">● ' + statusText + '</span>' +
        '</div>' +
        '<div class="compact-h-rent">' + sym + Number(b.rent).toLocaleString() + '/mo • Total (inc. Deposit): ' + sym + Number(totalRent).toLocaleString() + '</div>' +
        '<div class="compact-h-sub">' + b.duration + ' mo • Check-in: ' + cleanText(b.date) + ' • Suitable: <b>' + cleanText(b.suitableFor || 'Family') + '</b></div>' +
        '<div class="compact-h-sub">Request received: ' + cleanText(formatBookingLocalTime(b.createdAt, b)) + '</div>' +
        (b.trl ? '<div class="compact-h-sub" style="font-weight:700; color:#1E293B; margin-top:2px;">TRL: ' + cleanText(b.trl) + '</div>' : '') +
        (isConfirmed ? '<div style="font-size:10.5px;color:#334155;margin-top:5px;line-height:1.6;">📞 Owner: ' + cleanText(b.ownerPhone || 'Not available') + ' · ✉️ ' + cleanText(b.ownerGmail || 'Not available') + '<br>📞 Your contact: ' + cleanText(b.userPhone || 'Not available') + ' · ✉️ ' + cleanText(b.userGmail || 'Not available') + '</div>' : '') +
        (isConfirmed ? '<button class="btn-action-large success" style="margin-top:6px;" onclick="openConfirmedRoomLocation(\'' + safeInlineToken(b.id) + '\')">📍 Room Location · Open Maps</button>' : '') +
        '<div class="action-row-mini">' +
          (isOwnerAccepted ? '<button class="btn-action-large success" onclick="tenantFinalConfirmBooking(\'' + safeInlineToken(b.id) + '\')">✓ Final Confirm & Book</button><button class="btn-action-large danger" onclick="tenantRejectBooking(\'' + safeInlineToken(b.id) + '\')">✕ Reject Request</button>' : '') +
          (isConfirmed && isBookingReviewWindowOpen(b) ? '<button class="btn-action-large success" onclick="openBookingReviewModal(\'' + safeInlineToken(b.id) + '\')">⭐ Rate This Room</button>' : '') +
          (isConfirmed ? '<button class="btn-action-large" onclick="openSlipModal(\'' + safeInlineToken(b.id) + '\')">📄 Official Slip</button>' : '') +
          (isConfirmed ? '<button class="btn-action-large danger" onclick="requestCancelBooking(\'' + safeInlineToken(b.id) + '\', \'user\')">Request Cancel</button>' : '') +
          (isCancelPending && b.cancelRequestedBy === 'owner' ? '<button class="btn-action-large success" onclick="acceptCancelBooking(\'' + safeInlineToken(b.id) + '\')">Accept Owner Cancel</button>' : '') +
          (isCancelPending && b.cancelRequestedBy === 'owner' ? '<button class="btn-action-large danger" onclick="rejectCancelBooking(\'' + safeInlineToken(b.id) + '\')">Reject Cancel</button>' : '') +
          (isCancelPending && b.cancelRequestedBy === 'user' ? '<span class="btn-action-large disabled">Waiting Owner Approval</span>' : '') +
          (isPending ? '<span class="btn-action-large disabled">Awaiting Owner</span>' : '') +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function openConfirmedRoomLocation(bookingId) {
  var b = DB.bookings.find(function(x){ return x.id === bookingId; });
  if (!b || b.status !== 'confirmed') {
    alert('Room location is available only after final booking confirmation.');
    return;
  }
  // Exact room coordinates are private booking data and are available only
  // after final confirmation. Prefer them for accurate turn-by-turn directions.
  var hasExactGps = b.roomLat !== null && b.roomLat !== undefined &&
    b.roomLng !== null && b.roomLng !== undefined &&
    Number.isFinite(Number(b.roomLat)) && Number.isFinite(Number(b.roomLng)) &&
    Number(b.roomLat) >= -90 && Number(b.roomLat) <= 90 &&
    Number(b.roomLng) >= -180 && Number(b.roomLng) <= 180;
  var query = hasExactGps
    ? Number(b.roomLat) + ',' + Number(b.roomLng)
    : [b.houseName, b.roomExactAddress, b.roomPin].filter(Boolean).join(', ');
  if (!query) {
    alert('Owner has not provided a usable room location yet.');
    return;
  }
  window.open('https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(query) + '&travelmode=driving', '_blank', 'noopener');
}

async function tenantFinalConfirmBooking(bookingId) {
  var b = DB.bookings.find(function(x){ return x.id === bookingId; });
  if (!b) return;

  var verifyRes = await sb.from('listings').select('status').eq('id', b.listingId).single();
  if (verifyRes.data && verifyRes.data.status === 'booked') {
    alert("Sorry! This room was just confirmed by another tenant. Your request has been cancelled.");
    var rejectRes = await sb.rpc('rehzu_owner_reject_booking', { p_booking_id: bookingId });
    if (rejectRes.error) alert(safeUserError(rejectRes.error, 'Could not reject this booking. Please try again.'));
    await syncFromSupabase();
    return;
  }

  // The database creates the permanent 12-digit numeric TRL during confirmation.
  var res = await sb.rpc('rehzu_confirm_booking', { p_booking_id: bookingId });

  if (!res.error && b.listingId) {
    var targetListing = DB.listings.find(function(x){ return x.id === b.listingId; });
    if (targetListing) targetListing.status = 'booked';
    b.status = 'confirmed';
    b.trl = res.data && res.data.trl ? res.data.trl : (res.data && res.data[0] && res.data[0].trl ? res.data[0].trl : '');
  }

  if (!res.error) {
    alert("Room Confirmed & Booked Exclusively for You!\n12-Digit TRL: " + (b.trl || 'Assigned securely') + "\nRoom is now locked and removed from public listings.");
    renderHomeGrid();
    await syncFromSupabase();
    openSlipModal(bookingId);
  } else {
    alert(safeUserError(res.error, "Could not confirm this booking. Please try again."));
  }
}

async function tenantRejectBooking(bookingId) {
  var b = DB.bookings.find(function(x){ return x.id === bookingId; });
  if (!b || b.status !== 'owner_accepted') {
    alert('Only an owner-accepted request can be rejected.');
    return;
  }
  if (!confirm('Reject this accepted room request? The room will remain available for other users.')) return;
  var result = await sb.rpc('rehzu_tenant_reject_booking', { p_booking_id: bookingId });
  if (result.error || result.data !== true) {
    alert(safeUserError(result.error, 'Could not reject this request. Please try again.'));
    return;
  }
  alert('Your request has been rejected. The room remains available.');
  await syncFromSupabase();
}

async function requestCancelBooking(id, role) {
  if (confirm("Send cancellation request?")) {
    var res = await sb.rpc('rehzu_request_booking_cancel', { p_booking_id: id, p_actor: role });
    if (!res.error) {
      alert("Cancellation request sent!");
      await syncFromSupabase();
    }
  }
}

async function acceptCancelBooking(id) {
  if (confirm("Accept cancellation? Room will immediately be released and live on Home screen.")) {
    var b = DB.bookings.find(function(x){ return x.id === id; });
    var res = await sb.rpc('rehzu_resolve_booking_cancel', { p_booking_id: id, p_accept: true });
    if (!res.error && b && b.listingId) {
      var targetListing = DB.listings.find(function(x){ return x.id === b.listingId; });
      if (targetListing) targetListing.status = 'available';
    }
    alert("Booking cancelled and room restored to Home screen!");
    renderHomeGrid();
    await syncFromSupabase();
  }
}

async function rejectCancelBooking(id) {
  if (confirm("Reject this cancellation request? Booking will remain active.")) {
    var res = await sb.rpc('rehzu_resolve_booking_cancel', { p_booking_id: id, p_accept: false });
    if (!res.error) {
      alert("Cancellation request rejected. Booking stays confirmed.");
      await syncFromSupabase();
    }
  }
}

function toggleOwnerForm(show) {
  if (show && !DB.currentUser) {
    alert("Please sign in or create an account to list your property.");
    openProfileModal('openOwnerForm');
    return;
  }
  document.getElementById('ownerDashboardWrap').style.display = show ? 'none' : 'block';
  document.getElementById('ownerFormWrap').style.display = show ? 'block' : 'none';

  if (show) {
    var cObj = WORLD_COUNTRIES.find(function(item){ return item.code === detectedCountryCode; }) || WORLD_COUNTRIES[0];
    
    var opDisplay = document.getElementById('opCountryDisplay');
    var opHidden = document.getElementById('opCountry');
    if (opDisplay) opDisplay.value = cObj.name;
    if (opHidden) opHidden.value = cObj.code;
    updateDialPrefix(cObj.code);

    if (DB.currentUser) {
      document.getElementById('opName').value = DB.currentUser.name || '';
      if (DB.currentUser.gmail) document.getElementById('opGmail').value = DB.currentUser.gmail;

      var rawPhone = DB.currentUser.phone || '';
      var cleanPhone = rawPhone;
      WORLD_COUNTRIES.forEach(function(c) {
        var cleanDial = c.dial.replace('+', '');
        cleanPhone = cleanPhone.replace(c.dial, '').trim();
        var re = new RegExp('^' + cleanDial);
        cleanPhone = cleanPhone.replace(re, '').trim();
      });
      document.getElementById('opPhone').value = cleanPhone;
    }
  }
}


async function openOwnerDiscountSettings(listingId) {
  var room = DB.listings.find(function(item){ return item.id === listingId; });
  if (!room || !DB.currentUser || String(room.ownerUid) !== String(DB.currentUser.uid)) {
    alert('Only this room owner can change its discount.');
    return;
  }

  // Step 1: ask for the percentage first. No extra enable-confirmation popup.
  var valueText = prompt('Discount kitna percent (%) dena chahte hain? (1 se 90). Discount band karne ke liye 0 likhein.', String(room.discountType === 'percent' ? (room.discountValue || '') : ''));
  if (valueText === null) return;
  var value = Number(valueText);

  // Allow the owner to switch an existing offer off without a separate menu.
  if (value === 0 && String(valueText).trim() === '0') {
    var off = await sb.from('listings').update({ discount_enabled: false, discount_expires_at: null, discount_started_at: null, discount_duration_days: null })
      .eq('id', listingId).eq('owner_uid', DB.currentUser.uid).select('id');
    if (off.error || !off.data || !off.data.length) {
      alert('Discount could not be turned off. Please try again.');
      return;
    }
    alert('Discount is now OFF for this room.');
    await syncFromSupabase();
    renderOwnerView();
    return;
  }

  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > 90) {
    alert('Discount percentage 1 se 90 ke beech poora number hona chahiye. Discount band karne ke liye 0 likhein.');
    return;
  }

  // Step 2: immediately ask how many full days the owner wants the offer to run.
  var daysText = prompt('Discount kitne din tak chalana hai? (1 se 365 din)', '2');
  if (daysText === null) return;
  var days = Number(daysText);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    alert('Discount duration 1 se 365 poore din ke beech honi chahiye.');
    return;
  }

  // Save only after both OK actions; expiry is calculated from the activation moment.
  var type = 'percent';
  var discountStartedAt = new Date();
  var discountExpiresAt = new Date(discountStartedAt.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
  var upd = await sb.from('listings').update({
    discount_enabled: true, discount_type: type, discount_value: value,
    discount_started_at: discountStartedAt.toISOString(), discount_duration_days: days,
    discount_expires_at: discountExpiresAt
  }).eq('id', listingId).eq('owner_uid', DB.currentUser.uid).select('id');
  if (upd.error || !upd.data || !upd.data.length) {
    alert('Discount save nahi hua. Please try again.');
    return;
  }
  alert(value + '% Discount ' + days + ' din ke liye LIVE ho gaya. Expiry ke baad automatic band ho jayega.');
  await syncFromSupabase();
  renderOwnerView();
}

function switchOwnerTab(tab) {
  currentOwnerTab = tab;
  document.getElementById('tabOwnerRooms').className = 'sub-tab-btn ' + (tab==='rooms'?'active':'');
  document.getElementById('tabOwnerRequests').className = 'sub-tab-btn ' + (tab==='requests'?'active':'');
  document.getElementById('tabOwnerExpired').className = 'sub-tab-btn ' + (tab==='expired'?'active':'');
  renderOwnerView();
}

function formatOwnerDiscountTimeLeft(expiresAt) {
  var remaining = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return 'Expired · OFF';
  var days = Math.floor(remaining / 86400000);
  var hours = Math.floor((remaining % 86400000) / 3600000);
  var minutes = Math.floor((remaining % 3600000) / 60000);
  if (days > 0) return days + 'd ' + hours + 'h left';
  if (hours > 0) return hours + 'h ' + minutes + 'm left';
  return Math.max(1, minutes) + 'm left';
}

function updateOwnerDiscountCountdowns() {
  document.querySelectorAll('[data-owner-discount-expiry]').forEach(function(node) {
    var expiry = node.getAttribute('data-owner-discount-expiry');
    if (new Date(expiry).getTime() <= Date.now()) {
      var offer = node.closest('.owner-discount-live');
      if (offer) offer.style.display = 'none';
      return;
    }
    node.textContent = 'Time left: ' + formatOwnerDiscountTimeLeft(expiry);
  });
}

function renderOwnerView() {
  if (!window.__rehzuOwnerDiscountTicker) {
    window.__rehzuOwnerDiscountTicker = setInterval(updateOwnerDiscountCountdowns, 60000);
  }
  var container = document.getElementById('ownerContentContainer');

  if (!DB.currentUser) {
    document.getElementById('statActiveCount').innerText = 0;
    document.getElementById('statRequestsCount').innerText = 0;
    document.getElementById('statExpiredCount').innerText = 0;

    container.innerHTML = '<div style="background:#fff; border:1px solid #E2E8F0; border-radius:16px; padding:32px 16px; text-align:center;">' +
      '<div style="font-size:36px; margin-bottom:8px;">🔒</div>' +
      '<h4 style="font-size:14px; font-weight:800; color:#0F172A; margin-bottom:4px;">Landlord Login Required</h4>' +
      '<p style="font-size:11px; color:#64748B; margin-bottom:14px;">Sign in to view your listed properties, booking requests, and edit room info.</p>' +
      '<button class="big-action-btn" style="max-width:200px; margin:0 auto; padding:8px 16px; font-size:11.5px;" onclick="openProfileModal()">Login as Owner</button>' +
    '</div>';
    return;
  }

  var myUid = String(DB.currentUser.uid || '').toUpperCase().trim();
  var myPhoneTen = normalizePhoneDigits(DB.currentUser.phone);

  var myRooms = DB.listings.filter(function(l){ 
    var cleanOwnerPhoneTen = normalizePhoneDigits(l.phone);
    return (l.ownerUid && l.ownerUid.toUpperCase().trim() === myUid) || (myPhoneTen && cleanOwnerPhoneTen && myPhoneTen === cleanOwnerPhoneTen); 
  });

  var myRoomIds = myRooms.map(function(r){ return r.id; });

  var myRequests = DB.bookings.filter(function(b){ 
    var bOwnerPhoneTen = normalizePhoneDigits(b.ownerPhone);
    var isDirectPhoneMatch = (myPhoneTen && bOwnerPhoneTen && myPhoneTen === bOwnerPhoneTen);
    var isRoomIdMatch = (b.listingId && myRoomIds.indexOf(b.listingId) !== -1);
    return (isDirectPhoneMatch || isRoomIdMatch);
  });

  document.getElementById('statActiveCount').innerText = myRooms.filter(function(l){ return l.daysLeft > 0; }).length;
  document.getElementById('statRequestsCount').innerText = myRequests.filter(function(b){ return b.status==='pending' || b.status==='owner_accepted' || b.status==='confirmed'; }).length;
  document.getElementById('statExpiredCount').innerText = myRooms.filter(function(l){ return l.daysLeft <= 0; }).length;

  if (currentOwnerTab === 'rooms') {
    if (!myRooms.length) {
      container.innerHTML = '<div style="background:#fff; border:1px solid #E2E8F0; border-radius:16px; padding:24px; text-align:center; font-size:11px; color:#64748B;">You haven\'t listed any properties yet. Tap "+ Add" to list one.</div>';
      return;
    }
    container.innerHTML = myRooms.map(function(r) {
      var sym = getCurrencySymbol(r.country);
      var liveDiscount = r.discountEnabled && r.discountExpiresAt && new Date(r.discountExpiresAt).getTime() > Date.now();
      var discountExpiryLabel = liveDiscount ? new Date(r.discountExpiresAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
      var discountPanel = liveDiscount ? '<div class="owner-discount-live" style="margin-top:6px;padding:6px 8px;border:1px solid #a7e8c4;border-radius:9px;background:#effdf4;color:#166534;font-size:9px;line-height:1.45;">' +
        '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;"><b style="font-size:9px;">● LIVE</b><b>' + cleanText(r.discountValue) + '% OFF</b><span>Duration: ' + (r.discountDurationDays ? cleanText(r.discountDurationDays) + ' day(s)' : 'Previously set · duration not recorded') + '</span></div>' +
        '<div>Ends: ' + cleanText(discountExpiryLabel) + '</div>' +
        '<div data-owner-discount-expiry="' + cleanText(r.discountExpiresAt) + '">Time left: ' + cleanText(formatOwnerDiscountTimeLeft(r.discountExpiresAt)) + '</div>' +
      '</div>' : '';
      return '<div class="compact-h-card">' +
        '<img src="' + cleanText(safeImageUrl(r.photos[0])) + '" class="compact-h-img" loading="lazy" decoding="async" onerror="this.src=\'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=600\'">' +
        '<div class="compact-h-content">' +
          '<div class="compact-h-header">' +
            '<div class="compact-h-title">' + cleanText(r.houseName) + '</div>' +
            '<span class="status-pill ' + (r.status==='available'?'status-confirmed':'status-pending') + '">● ' + r.status.toUpperCase() + '</span>' +
          '</div>' +
          '<div class="compact-h-rent">' + sym + Number(r.rent).toLocaleString() + '/mo</div>' +
          '<div class="compact-h-sub" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">' +
            '<span>' + cleanText(r.city) + ' • <b>' + r.daysLeft + ' days left</b></span>' +
            (liveDiscount ? '<span style="display:inline-flex;align-items:center;gap:4px;flex-shrink:0;padding:3px 8px;border-radius:999px;background:#eafaf0;color:#16803d;border:1px solid #b7ebc8;font-size:10px;font-weight:800;letter-spacing:.35px;"><span style="width:6px;height:6px;border-radius:50%;background:#16a34a;display:inline-block;"></span>LIVE</span>' : '') +
          '</div>' +
          discountPanel +
          '<div class="action-row-mini owner-actions-row">' +
            '<button class="btn-action-large" onclick="openRoomDetailsModal(\'' + safeInlineToken(r.id) + '\')">View</button>' +
            '<button class="btn-action-large" onclick="openOwnerDiscountSettings(\'' + safeInlineToken(r.id) + '\')">🏷️ Discount</button>' +
            '<button class="btn-action-large success" onclick="openFullEditRoomModal(\'' + safeInlineToken(r.id) + '\')">✏️ Edit</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
    updateOwnerDiscountCountdowns();
  } else if (currentOwnerTab === 'requests') {
    if (!myRequests.length) {
      container.innerHTML = '<div style="background:#fff; border:1px solid #E2E8F0; border-radius:16px; padding:24px; text-align:center; font-size:11px; color:#64748B;">No booking requests received yet.</div>';
      return;
    }
    container.innerHTML = myRequests.map(function(b) {
      var isPending = (b.status === 'pending');
      var isOwnerAccepted = (b.status === 'owner_accepted');
      var isConfirmed = (b.status === 'confirmed');
      var isCancelPending = (b.status === 'cancel_pending');
      var totalRent = ((parseFloat(b.rent) || 0) * (parseInt(b.duration) || 1)) + (parseFloat(b.deposit) || 0);
      var l = DB.listings.find(function(x){ return x.id === b.listingId; });
      var sym = getCurrencySymbol(l ? l.country : 'IN');

      return '<div class="compact-h-card" style="align-items:flex-start;">' +
        '<div class="compact-h-content">' +
          '<div class="compact-h-header">' +
            '<div class="compact-h-title">' + cleanText(b.houseName) + '</div>' +
            '<span class="status-pill ' + (isConfirmed ? 'status-confirmed' : (isOwnerAccepted ? 'status-owner-accepted' : (isPending ? 'status-pending' : (isCancelPending ? 'status-cancel-pending' : 'status-cancelled')))) + '">' +
              '● ' + (isOwnerAccepted ? 'AWAITING TENANT CONFIRM' : b.status.toUpperCase()) + '</span>' +
          '</div>' +
          '<div style="font-size:10.5px; color:#334155; margin-top:3px; line-height:1.5;">' +
            '<div><b>Guest Name:</b> ' + cleanText(b.userName || 'Not available') + '</div>' +
            '<div><b>Previous Address:</b> ' + cleanText(b.userOldAddress || 'Not provided') + '</div>' +
            '<div><b>Room Type:</b> ' + cleanText(b.roomType || (l && l.roomType) || 'Room') + '</div>' +
            '<div><b>Stay Duration:</b> ' + cleanText(b.duration) + ' month(s) • <b>Check-in:</b> ' + cleanText(b.date || 'Not specified') + '</div>' +
            '<div><b>How Many People:</b> ' + cleanText(b.peopleCount || 1) + ((Number(b.peopleCount || 1) === 1) ? ' Person' : ' People') + '</div>' +
            '<div><b>Suitable For:</b> ' + cleanText(b.suitableFor || 'Family') + '</div>' +
            '<div><b>Rent:</b> ' + sym + Number(b.rent || 0).toLocaleString() + '/month • <b>Deposit:</b> ' + sym + Number(b.deposit || 0).toLocaleString() + '</div>' +
            '<div><b>Total:</b> ' + sym + Number(totalRent).toLocaleString() + ' • <b>Request received:</b> ' + cleanText(formatBookingLocalTime(b.createdAt, b)) + '</div>' +
            (isConfirmed ? '<div style="font-weight:700; margin-top:3px;">📞 Phone: ' + cleanText(b.userPhone || 'Not available') + ' • ✉️ Gmail: ' + cleanText(b.userGmail || 'Not available') + '</div>' : '<div style="font-weight:700; color:#64748B; margin-top:3px;">Phone Number & Gmail will appear only after Final Booking Confirmation.</div>') +
            (b.trl ? '<div style="font-weight:700; color:#044E3B; margin-top:2px;">TRL: ' + cleanText(b.trl) + '</div>' : '') +
          '</div>' +
          '<div class="action-row-mini" style="margin-top:8px;">' +
            (isPending ? '<button class="btn-action-large success" onclick="ownerAcceptRequest(\'' + safeInlineToken(b.id) + '\')">✓ Accept Request</button>' : '') +
            (isPending ? '<button class="btn-action-large danger" onclick="ownerRejectRequest(\'' + safeInlineToken(b.id) + '\')">✕ Reject</button>' : '') +
            (isOwnerAccepted ? '<span class="btn-action-large disabled">Waiting for Tenant to Confirm</span>' : '') +
            (isConfirmed ? '<button class="btn-action-large" onclick="openSlipModal(\'' + safeInlineToken(b.id) + '\')">📄 Official Slip</button>' : '') +
            (isConfirmed ? '<button class="btn-action-large danger" onclick="requestCancelBooking(\'' + safeInlineToken(b.id) + '\', \'owner\')">Request Cancel</button>' : '') +
            (isCancelPending && b.cancelRequestedBy === 'user' ? '<button class="btn-action-large success" onclick="acceptCancelBooking(\'' + safeInlineToken(b.id) + '\')">Accept Tenant Cancel</button>' : '') +
            (isCancelPending && b.cancelRequestedBy === 'user' ? '<button class="btn-action-large danger" onclick="rejectCancelBooking(\'' + safeInlineToken(b.id) + '\')">Reject Tenant Cancel</button>' : '') +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  } else {
    container.innerHTML = '<div style="background:#fff; border:1px solid #E2E8F0; border-radius:16px; padding:24px; text-align:center; font-size:11px; color:#64748B;">No expired listings.</div>';
  }
}

async function ownerAcceptRequest(bookingId) {
  var res = await sb.rpc('rehzu_owner_accept_booking', { p_booking_id: bookingId });
  if (!res.error) {
    alert("Request Accepted!\nTenant will now confirm finally to book the room.");
    await syncFromSupabase();
  }
}

async function ownerRejectRequest(bookingId) {
  if (confirm("Reject this booking request?")) {
    var rejectRes = await sb.rpc('rehzu_owner_reject_booking', { p_booking_id: bookingId });
    if (rejectRes.error) { alert(safeUserError(rejectRes.error, "Could not reject this booking. Please try again.")); return; }
    alert("Booking request rejected.");
    await syncFromSupabase();
  }
}

function openFullEditRoomModal(roomId) {
  var r = DB.listings.find(function(x){ return x.id === roomId; });
  if (!r) return;

  currentEditListingPhotos = (r.photos && r.photos.length) ? r.photos.slice() : [];
  editUploadedPhotoFiles = [];
  currentEditGpsRoomId = '';
  currentEditGpsCoord = null;
  var sym = getCurrencySymbol(r.country);

  document.getElementById('modalSlot').innerHTML = '<div class="modal-overlay">' +
    '<div class="modal-box-narrow room-booking-form-box" style="max-width:420px;">' +
      '<div class="modal-header">' +
        '<div style="display:flex; align-items:center; gap:8px;">' +
          '<img src="logo.svg" alt="Rehzu" style="height:24px; width:auto; object-fit:contain;" onerror="this.style.display=\'none\'">' +
          '<h3 style="font-size:15px; font-weight:800; color:#0F172A;">Edit Room Details</h3>' +
        '</div>' +
        '<span onclick="closeModal()" style="cursor:pointer; font-size:16px; font-weight:bold;">✕</span>' +
      '</div>' +

      '<div class="pill-grid">' +
        '<div class="field-box">' +
          '<label class="field-label">House Name *</label>' +
          '<input id="edHouse" class="pill-input" value="' + cleanText(r.houseName) + '" maxlength="80">' +
        '</div>' +
        '<div class="field-box">' +
          '<label class="field-label">Room Type *</label>' +
          '<select id="edType" class="pill-input">' +
            '<option ' + (r.roomType==='Single Room'?'selected':'') + '>Single Room</option>' +
            '<option ' + (r.roomType==='1 RK'?'selected':'') + '>1 RK</option>' +
            '<option ' + (r.roomType==='2 BHK'?'selected':'') + '>2 BHK</option>' +
            '<option ' + (r.roomType==='3 BHK'?'selected':'') + '>3 BHK</option>' +
            '<option ' + (r.roomType==='PG'?'selected':'') + '>PG</option>' +
            '<option ' + (r.roomType==='Hostel'?'selected':'') + '>Hostel</option>' +
          '</select>' +
        '</div>' +
      '</div>' +

      '<div class="pill-grid">' +
        '<div class="field-box">' +
          '<label class="field-label">Monthly Rent (' + sym + ') *</label>' +
          '<input id="edRent" type="number" class="pill-input" value="' + r.rent + '" min="1" max="10000000">' +
        '</div>' +
        '<div class="field-box">' +
          '<label class="field-label">Security Deposit (' + sym + ')</label>' +
          '<input id="edDeposit" type="number" class="pill-input" value="' + (r.deposit || 0) + '" min="0" max="10000000">' +
        '</div>' +
      '</div>' +

      '<div class="pill-grid">' +
        '<div class="field-box">' +
          '<label class="field-label">City *</label>' +
          '<input id="edCity" class="pill-input" value="' + cleanText(r.city) + '" maxlength="50">' +
        '</div>' +
        '<div class="field-box">' +
          '<label class="field-label">State</label>' +
          '<input id="edState" class="pill-input" value="' + cleanText(r.state||'') + '" maxlength="50">' +
        '</div>' +
      '</div>' +

      '<div class="pill-grid">' +
        '<div class="field-box">' +
          '<label class="field-label">Area Pin Code</label>' +
          '<input id="edPin" class="pill-input" value="' + cleanText(r.pin||'') + '" maxlength="12">' +
        '</div>' +
        '<div class="field-box">' +
          '<label class="field-label">Availability Status</label>' +
          '<select id="edStatus" class="pill-input">' +
            '<option value="available" ' + (r.status==='available'?'selected':'') + '>Available (Live on Home)</option>' +
            '<option value="booked" ' + (r.status==='booked'?'selected':'') + '>Booked (Hidden from Home)</option>' +
          '</select>' +
        '</div>' +
      '</div>' +

      '<div class="field-box" style="margin-top:22px;margin-bottom:8px;">' +
        '<label class="field-label">Full Address *</label>' +
        '<input id="edAddr" class="pill-input" value="' + cleanText(r.address) + '" maxlength="200">' +
      '</div>' +


      '<div class="field-box" style="margin-bottom:8px;">' +
        '<label class="field-label">Room Photos (Max 3)</label>' +
        '<div class="photo-upload-row" id="editPhotoPreviewContainer"></div>' +
        '<input type="file" id="editPhotoFileInput" accept="image/jpeg,image/png,image/webp" multiple onchange="handleEditPhotoPick(event)" style="display:none;">' +
        '<div class="photo-add-box" onclick="document.getElementById(\'editPhotoFileInput\').click()">' +
          '<span style="font-size:16px;">⇪</span>' +
          '<span>Add Photo</span>' +
        '</div>' +
      '</div>' +

      '<div style="display:flex;gap:8px;margin-top:8px;align-items:stretch;">' +
        '<button class="big-action-btn" id="btnSaveFullEdit" style="flex:1;min-width:0;" onclick="saveFullRoomEdit(\'' + safeInlineToken(r.id) + '\')">Save Changes</button>' +
        '<button type="button" class="big-action-btn" id="edGpsCaptureBtn" style="flex:1;min-width:0;" onclick="captureEditRoomGPS(\'' + safeInlineToken(r.id) + '\')">Capture Exact Room GPS</button>' +
      '</div>' +
    '</div>' +
  '</div>';

  renderEditPhotoPreviews();
}

async function captureEditRoomGPS(roomId) {
  var btn = document.getElementById('edGpsCaptureBtn');
  if (!btn) return;
  btn.disabled = true;
  btn.innerText = 'Detecting GPS…';
  try {
    var coords = await getFreshDeviceCoordinates(100);
    currentEditGpsRoomId = roomId;
    currentEditGpsCoord = { lat: coords.latitude, lng: coords.longitude };
    btn.innerText = '✓ GPS Captured';
  } catch (error) {
    btn.innerText = 'Capture Exact Room GPS';
    alert(error && error.message ? error.message : 'GPS capture failed. Please try again.');
  } finally {
    btn.disabled = false;
  }
}

function renderEditPhotoPreviews() {
  var container = document.getElementById('editPhotoPreviewContainer');
  if (!container) return;
  var html = '';

  currentEditListingPhotos.forEach(function(url, idx) {
    html += '<div class="photo-preview-item">' +
      '<img src="' + cleanText(safeImageUrl(url)) + '" class="photo-thumb-preview" alt="Room photo preview" loading="lazy">' +
      '<button type="button" class="photo-del-btn" onclick="currentEditListingPhotos.splice(' + idx + ',1);renderEditPhotoPreviews();">✕</button>' +
    '</div>';
  });

  editUploadedPhotoFiles.forEach(function(file, idx) {
    var previewUrl = URL.createObjectURL(file);
    html += '<div class="photo-preview-item">' +
      '<img src="' + cleanText(safeImageUrl(previewUrl)) + '" class="photo-thumb-preview" alt="Room photo preview" loading="lazy">' +
      '<button type="button" class="photo-del-btn" onclick="editUploadedPhotoFiles.splice(' + idx + ',1);renderEditPhotoPreviews();">✕</button>' +
    '</div>';
  });

  container.innerHTML = html;
}

async function handleEditPhotoPick(event) {
  var input = event && event.target;
  var maxAllowed = 3 - (currentEditListingPhotos.length + editUploadedPhotoFiles.length);
  if (maxAllowed <= 0) {
    alert('You can have a maximum of 3 photos.');
    if (input) input.value = '';
    return;
  }
  var files = Array.prototype.slice.call(input && input.files || []);
  if (files.length > maxAllowed) {
    alert('You can have a maximum of 3 photos.');
    files = files.slice(0, maxAllowed);
  }
  for (var i = 0; i < files.length; i++) {
    try { editUploadedPhotoFiles.push(await compressImageFile(files[i])); }
    catch (err) { alert((files[i].name || 'Photo') + ': ' + (err.message || 'Unsupported photo.')); }
  }
  if (input) input.value = '';
  renderEditPhotoPreviews();
}

async function saveFullRoomEdit(roomId) {
  var rawHouseName = document.getElementById('edHouse').value;
  if (!validateTextField(rawHouseName, 2, 80)) { alert('House name must be 2–80 characters.'); return; }
  if (!safeMoney(document.getElementById('edRent').value, 1, 100000000) ||
      !safeMoney(document.getElementById('edDeposit').value || 0, 0, 100000000)) {
    alert('Enter a valid rent and deposit amount.'); return;
  }
  var houseName = cleanText(rawHouseName);
  var roomType = document.getElementById('edType').value;
  var rent = Math.max(0, parseFloat(document.getElementById('edRent').value) || 0);
  var deposit = Math.max(0, parseFloat(document.getElementById('edDeposit').value) || 0);
  var city = cleanText(document.getElementById('edCity').value);
  var state = cleanText(document.getElementById('edState').value);
  var pin = cleanText(document.getElementById('edPin').value);
  var address = cleanText(document.getElementById('edAddr').value);
  var status = document.getElementById('edStatus').value;

  var btn = document.getElementById('btnSaveFullEdit');
  btn.disabled = true;
  btn.innerText = 'Optimizing & Uploading...';

  try {
    var finalPhotos = currentEditListingPhotos.slice();

    for (var i = 0; i < editUploadedPhotoFiles.length; i++) {
      var file = editUploadedPhotoFiles[i];
      var authCheck = await sb.auth.getUser();
      if (authCheck.error || !authCheck.data || !authCheck.data.user) throw new Error('Please sign in with Google again before uploading room photos.');
      var cleanName = authCheck.data.user.id + '/' + crypto.randomUUID() + '.webp';
      var uploadRes = await sb.storage.from('room-photos').upload(cleanName, file, {
        contentType: 'image/webp'
      });
      if (uploadRes.error) throw uploadRes.error;
      var urlData = sb.storage.from('room-photos').getPublicUrl(cleanName);
      finalPhotos.push(urlData.data.publicUrl);
    }

    var listingUpdate = {
      house_name: houseName,
      room_type: roomType,
      rent: rent,
      deposit: deposit,
      city: city,
      state: state,
      pin: pin,
      address: address,
      photos: finalPhotos
    };
    if (currentEditGpsRoomId === roomId && currentEditGpsCoord) {
      listingUpdate.lat = currentEditGpsCoord.lat;
      listingUpdate.lng = currentEditGpsCoord.lng;
    }
    var res = await sb.from('listings').update(listingUpdate).eq('id', roomId);

    if (res.error) throw res.error;

    var statusRes = await sb.rpc('rehzu_owner_set_listing_status', {
      p_listing_id: roomId,
      p_status: status
    });

    if (statusRes.error) {
      alert(safeUserError(statusRes.error, "Property details were saved, but availability status was not changed."));
    } else {
      alert("Property updated successfully!");
    }
    closeModal();
    currentEditGpsRoomId = '';
    currentEditGpsCoord = null;
    await syncFromSupabase();
    renderHomeGrid();
    renderOwnerView();
  } catch(err) {
    alert(safeUserError(err, "Could not update this property. Please check the details and try again."));
  } finally {
    btn.disabled = false;
    btn.innerText = 'Save Changes ';
  }
}

function toggleDrawer(id) {
  document.getElementById(id).classList.toggle('open');
}

function toggleSelectChip(el, group, val) {
  el.classList.toggle('selected');
  var isSel = el.classList.contains('selected');
  if (group === 'suitable') {
    if (isSel) selectedSuitable.push(val);
    else selectedSuitable = selectedSuitable.filter(function(x){ return x !== val; });
    document.getElementById('suitableSelectedText').innerText = selectedSuitable.length ? selectedSuitable.join(', ') : 'Select Suitable For';
  } else if (group === 'amenity') {
    if (isSel) selectedAmenities.push(val);
    else selectedAmenities = selectedAmenities.filter(function(x){ return x !== val; });
    document.getElementById('amenitiesSelectedText').innerText = selectedAmenities.length ? selectedAmenities.join(', ') : 'Select Amenities';
  } else if (group === 'rule') {
    if (isSel) selectedRules.push(val);
    else selectedRules = selectedRules.filter(function(x){ return x !== val; });
  }
}

function updateDialPrefix(code) {
  var c = WORLD_COUNTRIES.find(function(item){ return item.code === code; });
  if (c) {
    document.getElementById('opDialPrefix').innerText = c.dial;
    document.getElementById('opRentSym').innerText = c.sym;
    document.getElementById('opDepSym').innerText = c.sym;
  }
}

function invalidateRoomMapAddressCheck() {
  roomAddressMapReady = false;
  lockedMapCoord = { lat: null, lng: null };
  var btn = document.getElementById('opMapLockBtn');
  var txt = document.getElementById('opMapLockText');
  var status = document.getElementById('opMapLocationStatus');
  var preview = document.getElementById('opMapPreviewLink');
  if (txt) txt.innerText = 'Capture Room GPS Location *';
  if (status) status.innerText = 'Address badla hai. Room ke entrance par khade hokar GPS location dobara capture karein.';
  if (preview) { preview.hidden = true; preview.removeAttribute('href'); }
  if (btn) { btn.classList.remove('locked'); btn.disabled = false; }
}

async function reverseGeocodeRoomLocation(coords) {
  var status = document.getElementById('opMapLocationStatus');
  try {
    var url = 'https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=' +
      encodeURIComponent(coords.lat) + '&longitude=' + encodeURIComponent(coords.lng) + '&localityLanguage=en';
    var response = await fetch(url, { method: 'GET', mode: 'cors', cache: 'no-store', signal: AbortSignal.timeout(9000) });
    if (!response.ok) throw new Error('Address lookup unavailable');
    var data = await response.json();
    var detected = String(data.countryCode || '').toUpperCase();
    if (detected && detectedCountryCode && detected !== detectedCountryCode) {
      if (status) status.innerText = 'GPS pin captured, lekin detected country aapke verified country se match nahi karti. Country/address manually verify karein.';
      return false;
    }
    var cityValue = String(data.city || data.locality || data.principalSubdivision || '').trim();
    var stateValue = String(data.principalSubdivision || '').trim();
    var pinValue = String(data.postcode || '').trim();
    var addressParts = [data.locality, data.city, data.principalSubdivision, pinValue, data.countryName]
      .filter(function(value, index, all) { return value && all.indexOf(value) === index; });
    var addressValue = addressParts.join(', ');
    var cityInput = document.getElementById('opCity');
    var stateInput = document.getElementById('opState');
    var pinInput = document.getElementById('opPin');
    var addressInput = document.getElementById('opAddr');
    if (cityInput && !cityInput.value.trim() && cityValue) cityInput.value = cityValue;
    if (stateInput && !stateInput.value.trim() && stateValue) stateInput.value = stateValue;
    if (pinInput && !pinInput.value.trim() && pinValue) pinInput.value = pinValue;
    if (addressInput && !addressInput.value.trim() && addressValue) addressInput.value = addressValue;
    if (status) status.innerText = 'GPS location saved.';
    return true;
  } catch (error) {
    if (status) status.innerText = 'GPS location saved.';
    return false;
  }
}

function saveExactMapLocation() {
  var btn = document.getElementById('opMapLockBtn');
  var txt = document.getElementById('opMapLockText');
  var status = document.getElementById('opMapLocationStatus');
  if (!navigator.geolocation) {
    if (status) status.innerText = 'Is browser mein GPS supported nahi hai. Android Chrome ya supported browser use karein.';
    return;
  }
  if (!window.isSecureContext) {
    if (status) status.innerText = 'GPS ke liye secure HTTPS connection zaroori hai. Rehzu ko HTTPS par kholein.';
    return;
  }

  roomAddressMapReady = false;
  lockedMapCoord = { lat: null, lng: null };
  if (btn) { btn.disabled = true; btn.classList.remove('locked'); }
  if (txt) txt.innerText = 'Saving GPS location…';
  if (status) status.innerText = 'Device GPS se room ki location li ja rahi hai. Location ON rakhein aur permission allow karein.';

  navigator.geolocation.getCurrentPosition(function(position) {
    var c = position && position.coords ? position.coords : {};
    var lat = Number(c.latitude);
    var lng = Number(c.longitude);
    var accuracy = Number(c.accuracy);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 ||
        lng < -180 || lng > 180 || !Number.isFinite(accuracy) || accuracy <= 0) {
      if (status) status.innerText = 'GPS se valid location nahi mili. Location/GPS ON karke dobara tap karein.';
      if (txt) txt.innerText = 'Capture Room GPS Location *';
      if (btn) btn.disabled = false;
      return;
    }

    lockedMapCoord = { lat: lat, lng: lng };
    roomAddressMapReady = true;
    if (btn) { btn.classList.add('locked'); btn.disabled = false; }
    if (txt) txt.innerText = '✓ Exact Room GPS Location Saved';
    if (status) status.innerText = 'GPS location saved.';
    reverseGeocodeRoomLocation({ lat: lat, lng: lng, accuracy: accuracy });
  }, function(error) {
    var message = error && error.code === 1
      ? 'Location permission blocked hai. Android Settings  Apps  Chrome  Permissions  Location allow karein.'
      : (error && error.code === 3
        ? 'GPS response timeout ho gaya. Location ON karke room ke entrance par dobara tap karein.'
        : 'GPS signal nahi mila. Device Location/GPS ON karke dobara tap karein.');
    if (status) status.innerText = message;
    if (txt) txt.innerText = 'Capture Room GPS Location *';
    if (btn) btn.disabled = false;
  }, { enableHighAccuracy: true, timeout: 60000, maximumAge: 0 });
}

async function handlePhotoPick(event) {
  var input = event && event.target;
  var files = Array.prototype.slice.call(input && input.files || []);
  if (uploadedPhotoFiles.length + files.length > 3) {
    alert('You can have a maximum of 3 photos.');
    files = files.slice(0, 3 - uploadedPhotoFiles.length);
  }
  for (var i = 0; i < files.length; i++) {
    try { uploadedPhotoFiles.push(await compressImageFile(files[i])); }
    catch (err) { alert((files[i].name || 'Photo') + ': ' + (err.message || 'Unsupported photo.')); }
  }
  if (input) input.value = '';
  renderPhotoPreviewList();
}

function renderPhotoPreviewList() {
  var container = document.getElementById('photoPreviewContainer');
  document.getElementById('photoCountText').innerText = '(' + uploadedPhotoFiles.length + '/3)';
  container.innerHTML = uploadedPhotoFiles.map(function(file, i) {
    var url = URL.createObjectURL(file);
    return '<div class="photo-preview-item">' +
      '<img src="' + cleanText(safeImageUrl(url)) + '" class="photo-thumb-preview" alt="Room photo preview" loading="lazy">' +
      '<button type="button" class="photo-del-btn" onclick="uploadedPhotoFiles.splice(' + i + ',1);renderPhotoPreviewList();">✕</button>' +
    '</div>';
  }).join('');
}

async function handlePublishProperty(e) {
  e.preventDefault();

  if (!roomAddressMapReady || !String(document.getElementById('opAddr')?.value || '').trim() ||
      !String(document.getElementById('opCity')?.value || '').trim()) {
    alert("Room publish karne se pehle Full Address aur City bharein, phir room ke entrance par 'Capture Room GPS Location' se accurate coordinates save karein.");
    document.getElementById('opMapLockBtn')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  if (!validateTextField(document.getElementById('opHouse').value, 2, 80) ||
      !validateTextField(document.getElementById('opCity').value, 2, 100) ||
      !validateTextField(document.getElementById('opState').value, 2, 100) ||
      !validateTextField(document.getElementById('opAddr').value, 5, 500)) {
    alert('Please check the house name, city, state and address. Some fields are empty or too long.');
    return;
  }
  if (!safeMoney(document.getElementById('opRent').value, 1, 100000000) ||
      !safeMoney(document.getElementById('opDeposit').value || 0, 0, 100000000)) {
    alert('Enter a valid rent and deposit amount.');
    return;
  }

  if (!DB.currentUser) {
    alert("Please sign in first to publish property.");
    openProfileModal();
    return;
  }

  var btn = document.getElementById('btnPublishSubmit');
  btn.disabled = true;
  btn.innerText = 'Compressing & Uploading...';

  try {
    var photoUrls = [];

    for (var i = 0; i < uploadedPhotoFiles.length; i++) {
      var file = uploadedPhotoFiles[i];
      var authCheck = await sb.auth.getUser();
      if (authCheck.error || !authCheck.data || !authCheck.data.user) throw new Error('Please sign in with Google again before uploading room photos.');
      var cleanName = authCheck.data.user.id + '/' + crypto.randomUUID() + '.webp';
      var uploadRes = await sb.storage.from('room-photos').upload(cleanName, file, {
        contentType: 'image/webp'
      });
      if (uploadRes.error) throw uploadRes.error;
      var urlData = sb.storage.from('room-photos').getPublicUrl(cleanName);
      photoUrls.push(urlData.data.publicUrl);
    }

    var currentCountryProof = await ensureCurrentCountryProof();
    var newListing = {
      country_proof: currentCountryProof,
      house_name: cleanText(document.getElementById('opHouse').value),
      room_type: document.getElementById('opRoomType').value,
      suitable_for: selectedSuitable,
      amenities: selectedAmenities,
      rules: selectedRules,
      rent: Math.max(1, parseFloat(document.getElementById('opRent').value) || 2500),
      deposit: Math.max(0, parseFloat(document.getElementById('opDeposit').value) || 0),
      country: detectedCountryCode,
      city: cleanText(document.getElementById('opCity').value),
      state: cleanText(document.getElementById('opState').value),
      pin: cleanText(document.getElementById('opPin').value),
      address: cleanText(document.getElementById('opAddr').value),
      lat: lockedMapCoord.lat,
      lng: lockedMapCoord.lng,
      owner_uid: DB.currentUser.uid,
      owner_name: cleanText(document.getElementById('opName').value),
      owner_phone: document.getElementById('opPhone').value.trim(),
      owner_gmail: document.getElementById('opGmail').value.trim() || null,
      status: 'available',
      photos: photoUrls
    };

    var insertRes = await sb.from('listings').insert([newListing]);
    if (insertRes.error) throw insertRes.error;

    alert("Room successfully published to Supabase Cloud for 90 Days in " + cleanText(detectedCountryCode) + "!");
    e.target.reset();
    roomAddressMapReady = false;
    lockedMapCoord = { lat: null, lng: null };
    uploadedPhotoFiles = [];
    toggleOwnerForm(false);
    await syncFromSupabase();
    goView('owner');

  } catch(err) {
    alert(safeUserError(err, "Upload failed. Please check your details and try again."));
  } finally {
    btn.disabled = false;
    btn.innerText = 'Publish Listing';
  }
}

function openBookingPillModal(id) {
  var l = DB.listings.find(function(x){ return x.id === id; });
  if (!l) return;
  if (!countryVerified || l.country !== detectedCountryCode) {
    alert('You can only book rooms in the country where you are currently located.');
    return;
  }
  activeBookingRoom = l;
  var today = new Date().toISOString().slice(0, 10);
  var sym = getCurrencySymbol(l.country);

  var prefillName = DB.currentUser ? DB.currentUser.name : '';
  var prefillPhone = DB.currentUser ? DB.currentUser.phone : '';
  var prefillGmail = (DB.currentUser && DB.currentUser.gmail) ? DB.currentUser.gmail : '';

  var suitableOptions = (l.suitableFor && l.suitableFor.length) ? l.suitableFor : ['Family', 'Student', 'Worker', 'Anyone'];
  var suitableSelectHTML = suitableOptions.map(function(opt) {
    return '<option value="' + opt + '">' + opt + '</option>';
  }).join('');

  document.getElementById('modalSlot').innerHTML = '<div class="modal-overlay">' +
    '<div class="modal-box-narrow" style="max-width:420px;">' +
      '<div class="modal-header">' +
        '<div style="display:flex; align-items:center; gap:8px;">' +
          '<img src="logo.svg" alt="Rehzu" style="height:24px; width:auto; object-fit:contain;" onerror="this.style.display=\'none\'">' +
          '<h3 style="font-size:15px; font-weight:800; color:#0F172A;">Request Room Booking</h3>' +
        '</div>' +
        '<span onclick="closeModal()" style="cursor:pointer; font-size:16px; font-weight:bold;">✕</span>' +
      '</div>' +
      '<div class="pill-grid" style="column-gap:14px;row-gap:14px;margin-bottom:14px;">' +
        '<div class="field-box"><input id="bpName" class="pill-input" aria-label="Your Name" value="' + cleanText(prefillName) + '" placeholder="Full Name *" maxlength="60"></div>' +
        '<div class="field-box"><input id="bpPhone" class="pill-input" aria-label="Contact Number" value="' + cleanText(prefillPhone) + '" placeholder="Contact No. *" maxlength="15"></div>' +
      '</div>' +
      '<div class="pill-grid" style="column-gap:14px;row-gap:14px;margin-bottom:14px;">' +
        '<div class="field-box"><input id="bpGmail" class="pill-input" aria-label="Gmail optional" value="' + cleanText(prefillGmail) + '" placeholder="Gmail (optional)" maxlength="80"></div>' +
        '<div class="field-box"><input id="bpOldAddr" class="pill-input" aria-label="Permanent Address" placeholder="Permanent address *" maxlength="200"></div>' +
      '</div>' +
      '<div class="pill-grid" style="column-gap:14px;row-gap:14px;margin-bottom:14px;">' +
        '<div class="field-box"><input id="bpDate" type="date" aria-label="Check-in Date" value="' + today + '" class="pill-input" required></div>' +
        '<div class="field-box">' +
          '<select id="bpMonths" class="pill-input" aria-label="Stay Duration" required onchange="updateBookingTotalCalculation()">' +
            '<option value="1">1 Month</option>' +
            '<option value="3">3 Months</option>' +
            '<option value="6">6 Months</option>' +
            '<option value="12">12 Months</option>' +
          '</select>' +
        '</div>' +
      '</div>' +
      '<div class="pill-grid" style="column-gap:14px;row-gap:14px;margin:6px 0 16px 0;align-items:start;">' +
        '<div class="field-box">' +
          '<select id="bpPeopleCount" class="pill-input" aria-label="How Many People" required style="font-weight:800;color:#044E3B;">' +
            Array.from({length:20}, function(_, i) { var count = i + 1; return '<option value="' + count + '"' + (count === 1 ? ' selected' : '') + '>' + count + (count === 1 ? ' Person' : ' People') + '</option>'; }).join('') +
          '</select>' +
        '</div>' +
        '<div class="field-box">' +
          '<select id="bpSuitable" class="pill-input" aria-label="Suitable For" required style="font-weight:800;color:#044E3B;">' + suitableSelectHTML + '</select>' +
        '</div>' +
      '</div>' +
      '<div id="bookingCalcBox" style="background:#ECFDF5; border:1px solid #A7F3D0; border-radius:14px; padding:12px 14px; margin:14px 0 16px; font-size:11.5px; color:#044E3B; display:flex; flex-direction:column; gap:3px;">' +
        '<div style="display:flex; justify-content:space-between;"><span>Rent: ' + sym + Number(l.rent).toLocaleString() + ' × <b id="calcMonthText">1 Month</b></span><span>' + sym + Number(l.rent).toLocaleString() + '</span></div>' +
        '<div style="display:flex; justify-content:space-between;"><span>Security Deposit:</span><span>+ ' + sym + Number(l.deposit || 0).toLocaleString() + '</span></div>' +
        '<div style="border-top:1px dashed #A7F3D0; margin-top:4px; padding-top:4px; display:flex; justify-content:space-between; font-weight:900; font-size:13px;" id="calcTotalText"><span>Total Amount:</span><span>' + sym + Number((parseFloat(l.rent) || 0) + (parseFloat(l.deposit) || 0)).toLocaleString() + '</span></div>' +
      '</div>' +
      '<label style="display:flex;align-items:flex-start;gap:8px;font-size:10.5px;line-height:1.45;color:#334155;margin:8px 0 12px;">' +
        '<input id="bpPolicyConsent" type="checkbox" required style="margin-top:2px;flex:0 0 auto;">' +
        '<span>I agree to the <a href="/legal.html#policy-booking-policy" target="_blank" rel="noopener noreferrer">Booking &amp; Cancellation Policy</a>, <a href="/legal.html#policy-terms" target="_blank" rel="noopener noreferrer">Terms</a> and <a href="/legal.html#policy-privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.</span>' +
      '</label>' +
      '<button class="big-action-btn" id="btnConfirmBooking" onclick="submitBookingRequest()">Send Request to Owner </button>' +
    '</div>' +
  '</div>';
  updateBookingTotalCalculation();
}

function updateBookingTotalCalculation() {
  if (!activeBookingRoom) return;
  var months = Math.max(1, parseInt(document.getElementById('bpMonths').value) || 1);
  var monthlyRent = Math.max(0, parseFloat(activeBookingRoom.rent) || 0);
  var deposit = Math.max(0, parseFloat(activeBookingRoom.deposit) || 0);
  var discount = 0;
  if (activeBookingRoom.discountEnabled && activeBookingRoom.discountValue > 0 &&
      (!activeBookingRoom.discountExpiresAt || new Date(activeBookingRoom.discountExpiresAt).getTime() > Date.now())) {
    discount = activeBookingRoom.discountType === 'fixed'
      ? Math.min(monthlyRent, activeBookingRoom.discountValue)
      : Math.round(monthlyRent * Math.min(90, activeBookingRoom.discountValue) / 100 * 100) / 100;
  }
  var rentAfterDiscount = Math.max(0, monthlyRent - discount);
  var discountTotal = discount * months;
  var totalAmount = (rentAfterDiscount * months) + deposit;
  var sym = getCurrencySymbol(activeBookingRoom.country);
  var box = document.getElementById('bookingCalcBox');
  if (box) {
    box.innerHTML =
      '<div style="display:flex;justify-content:space-between;"><span>Monthly Rent × ' + months + ' months</span><b>' + sym + Number(monthlyRent * months).toLocaleString() + '</b></div>' +
      (discount > 0 ? '<div style="display:flex;justify-content:space-between;color:#07834d;"><span>Owner Discount (' + (activeBookingRoom.discountType === 'fixed' ? 'Fixed' : Number(activeBookingRoom.discountValue) + '%') + ')</span><b>− ' + sym + Number(discountTotal).toLocaleString() + '</b></div>' : '') +
      '<div style="display:flex;justify-content:space-between;"><span>Security Deposit</span><b>+ ' + sym + Number(deposit).toLocaleString() + '</b></div>' +
      '<div style="border-top:1px dashed #A7F3D0;margin-top:5px;padding-top:7px;display:flex;justify-content:space-between;font-weight:900;font-size:13px;"><span>Final Total</span><span>' + sym + Number(totalAmount).toLocaleString() + '</span></div>' +
      (discount > 0 ? '<div style="font-size:10px;color:#07834d;font-weight:800;">You save ' + sym + Number(discountTotal).toLocaleString() + ' on this booking</div>' : '');
  }
}

async function submitBookingRequest() {
  var name = cleanText(document.getElementById('bpName').value);
  var phone = document.getElementById('bpPhone').value.trim();
  var gmail = document.getElementById('bpGmail').value.trim();
  var addr = cleanText(document.getElementById('bpOldAddr').value);
  var date = document.getElementById('bpDate').value;
  var months = Math.max(1, parseInt(document.getElementById('bpMonths').value) || 1);
  var suitable = document.getElementById('bpSuitable') ? document.getElementById('bpSuitable').value : 'Family';
  var peopleCount = Math.max(1, Math.min(20, parseInt(document.getElementById('bpPeopleCount')?.value, 10) || 1));
  var bookingConsent = document.getElementById('bpPolicyConsent');
  if (!bookingConsent || !bookingConsent.checked) {
    alert("Please read and accept the Booking & Cancellation Policy, Terms and Privacy Policy.");
    return;
  }

  if (!validateTextField(name, 2, 120) || !validateTextField(phone, 7, 32) ||
      !/^\+?[0-9 ()-]{7,32}$/.test(phone) || !validateTextField(addr, 3, 500) || !date) {
    alert("Please enter a valid name, phone number, address and check-in date.");
    return;
  }
  var checkinDate = new Date(date + 'T00:00:00');
  var todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);
  if (Number.isNaN(checkinDate.getTime()) || checkinDate < todayDate || months < 1 || months > 36) {
    alert("Please choose a valid future check-in date and a duration of 1–36 months.");
    return;
  }

  var btn = document.getElementById('btnConfirmBooking');
  btn.disabled = true;
  btn.innerText = 'Sending to Cloud...';

  var bookingData = {
    listing_id: activeBookingRoom.id,
    house_name: activeBookingRoom.houseName,
    room_type: activeBookingRoom.roomType,
    rent: Math.max(0, parseFloat(activeBookingRoom.rent) || 0),
    deposit: Math.max(0, parseFloat(activeBookingRoom.deposit) || 0),
    duration: months,
    checkin_date: date,
    suitable_for: suitable,
    people_count: peopleCount,
    user_uid: DB.currentUser ? DB.currentUser.uid : 'GUEST',
    user_name: name,
    user_phone: phone,
    user_gmail: gmail || null,
    user_old_address: addr,
    owner_name: activeBookingRoom.ownerName,
    owner_phone: activeBookingRoom.phone,
    owner_gmail: activeBookingRoom.gmail || null,
    room_city: activeBookingRoom.city,
    room_state: activeBookingRoom.state || '',
    room_pin: activeBookingRoom.pin || '',
    room_exact_address: activeBookingRoom.address,
    room_lat: activeBookingRoom.lat,
    room_lng: activeBookingRoom.lng,
    status: 'pending'
  };

  var bookingAuthRes = await sb.auth.getUser();
  var bookingAuthUser = bookingAuthRes && bookingAuthRes.data ? bookingAuthRes.data.user : null;
  if (bookingAuthRes.error || !bookingAuthUser) {
    alert("Your secure login session expired. Please login again.");
    btn.disabled = false;
    btn.innerText = 'Send Request to Owner ';
    return;
  }
  var bookingConsentRes = await sb.from('policy_acceptances').insert([{
    auth_user_id: bookingAuthUser.id,
    consent_type: 'room_booking',
    policy_version: '2026-10-30-v3',
    listing_id: activeBookingRoom.id
  }]);
  if (bookingConsentRes.error) {
    alert("Could not securely record your policy acceptance. Booking was not sent. Please retry.");
    btn.disabled = false;
    btn.innerText = 'Send Request to Owner ';
    return;
  }

  var currentCountryProof;
  try {
    currentCountryProof = await ensureCurrentCountryProof();
    if (!activeBookingRoom || activeBookingRoom.country !== detectedCountryCode) throw new Error('You can only book rooms in your current country.');
  } catch(countryError) {
    alert(countryError.message || 'Current country verification failed.');
    btn.disabled = false;
    btn.innerText = 'Send Request to Owner ';
    return;
  }

  var res = await sb.rpc('rehzu_create_booking_request', {
    p_country_proof: currentCountryProof,
    p_listing_id: activeBookingRoom.id,
    p_duration: months,
    p_checkin_date: date,
    p_user_name: name,
    p_user_phone: phone,
    p_user_old_address: addr,
    p_people_count: peopleCount,
    p_suitable_for: suitable
  });
  if (res.error) {
    var bookingErrorText = [
      res.error.message || '',
      res.error.details || '',
      res.error.hint || ''
    ].join(' ').toLowerCase();

    // A duplicate active request is an expected booking state, not a generic failure.
    // Keep the database guard in place and direct the renter to the existing request.
    if (bookingErrorText.indexOf('already have an active request for this room') !== -1) {
      btn.disabled = false;
      btn.innerText = 'Send Request to Owner ';
      alert('You already have an active request for this room. Open My Bookings to check its latest status. You do not need to submit another request.');
      closeModal();
      await syncFromSupabase();
      goView('bookings');
      return;
    }

    alert(safeUserError(res.error, "Booking failed. Please check the details and try again."));
    btn.disabled = false;
    btn.innerText = 'Send Request to Owner ';
    return;
  }

  closeModal();
  alert("Booking Request Sent to Owner via Cloud!");
  await syncFromSupabase();
  goView('bookings');
}

function openSlipModal(bkId) {
  var b = DB.bookings.find(function(x){ return x.id === bkId; });
  if (!b) return;

  var l = DB.listings.find(function(x){ return x.id === b.listingId; }) || {};
  var sym = getCurrencySymbol(l.country || 'IN');

  var houseName = b.houseName || l.houseName || 'Room Listing';
  var roomType = b.roomType || l.roomType || 'Room';
  var address = b.roomExactAddress || l.address || '';
  var city = b.roomCity || l.city || '';
  var state = b.roomState || l.state || '';
  var pin = b.roomPin || l.pin || '';
  var rent = b.rent || l.rent || 0;
  var deposit = (b.deposit !== undefined && b.deposit !== null) ? b.deposit : (l.deposit || 0);
  var duration = b.duration || 1;
  var totalAmount = Math.max(0, (parseFloat(rent) * parseInt(duration)) - (parseFloat(b.discountTotal) || 0)) + parseFloat(deposit);

  var lat = b.roomLat || l.lat;
  var lng = b.roomLng || l.lng;
  // The official printable slip intentionally contains no room address, map link, coordinates, or PIN.
  var mapsLink = (lat && lng) 
    ? 'https://www.google.com/maps/search/?api=1&query=' + lat + ',' + lng 
    : 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(address + ', ' + city);

  document.getElementById('modalSlot').innerHTML = '<div class="modal-overlay">' +
    '<div class="modal-box-pdf" id="printableSlip">' +
      '<div class="modal-header">' +
        '<div style="display:flex; align-items:center; gap:6px;">' +
          '<img src="logo.svg" alt="Rehzu" style="width:24px; height:auto; object-fit:contain;" onerror="this.style.display=\'none\'">' +
          '<b style="font-size:13px; color:#0F172A;">Rehzu Official Slip</b>' +
        '</div>' +
        '<div style="display:flex; gap:6px; align-items:center;">' +
          '<button onclick="window.print()" style="padding:4px 9px; background:#044E3B; color:#fff; border:none; border-radius:12px; font-size:9.5px; font-weight:800; cursor:pointer;">🖨 Print</button>' +
          '<span onclick="closeModal()" style="cursor:pointer; font-size:15px; font-weight:bold;">✕</span>' +
        '</div>' +
      '</div>' +

      '<div style="text-align:center; background:#ECFDF5; border:1px solid #BBF7D0; border-radius:12px; padding:8px;">' +
        '<div style="font-size:8px; font-weight:800; color:#044E3B; letter-spacing:0.5px;">OFFICIAL 12-CHARACTER TRL NUMBER</div>' +
        '<div style="font-size:18px; font-weight:900; letter-spacing:1.5px; color:#0F172A; margin:2px 0;">' + cleanText(b.trl || 'PENDING CONFIRM') + '</div>' +
        '<div style="font-size:8px; color:#64748B;">🔒 Verified Cloud Database Record</div>' +
        '<div style="font-size:9px; font-weight:800; color:' + ((b.trlExpiresAt && Date.now() >= Date.parse(b.trlExpiresAt)) ? '#B45309' : '#047857') + '; margin-top:4px;">' +
          'TRL STATUS: ' + ((b.trlExpiresAt && Date.now() >= Date.parse(b.trlExpiresAt)) ? 'EXPIRED' : 'VALID') +
          ' · VALID UNTIL: ' + (b.trlExpiresAt ? new Date(b.trlExpiresAt).toLocaleDateString('en-IN', {day:'2-digit',month:'short',year:'numeric'}) : '—') +
        '</div>' +
      '</div>' +

      '<div class="barcode-strip"></div>' +

      '<div style="font-size:10.5px; line-height:1.65;">' +
        '<div style="font-weight:900; color:#044E3B; margin-top:4px; border-bottom:1px solid #E2E8F0; padding-bottom:2px;">🏠 ROOM & PROPERTY DETAILS</div>' +
        '<div style="display:flex; justify-content:space-between; color:#64748B;"><span>House Name:</span> <b style="color:#0F172A;">' + cleanText(houseName) + '</b></div>' +
        '<div style="display:flex; justify-content:space-between; color:#64748B;"><span>Room Type:</span> <b style="color:#0F172A;">' + cleanText(roomType) + '</b></div>' +
        '<div style="display:flex; justify-content:space-between; color:#64748B;"><span>City / State:</span> <b style="color:#0F172A;">' + cleanText(city) + (state ? ' (' + cleanText(state) + ')' : '') + '</b></div>' +
        '<div style="display:flex; justify-content:space-between; color:#64748B;"><span>Booking Request Time:</span> <b style="color:#0F172A;text-align:right;max-width:65%;">' + cleanText(formatBookingLocalTime(b.createdAt, b)) + '</b></div>' +
        '<div style="display:flex; justify-content:space-between; color:#64748B;"><span>Monthly Rent:</span> <b style="color:#0F172A;">' + sym + Number(rent).toLocaleString() + '</b></div>' +
        '<div style="display:flex; justify-content:space-between; color:#64748B;"><span>Security Deposit:</span> <b style="color:#0F172A;">' + sym + Number(deposit).toLocaleString() + '</b></div>' +


        '<div style="font-weight:900; color:#044E3B; margin-top:8px; border-bottom:1px solid #E2E8F0; padding-bottom:2px;">👤 TENANT DETAILS</div>' +
        '<div style="display:flex; justify-content:space-between; color:#64748B;"><span>Name:</span> <b style="color:#0F172A;">' + cleanText(b.userName) + '</b></div>' +
        '<div style="display:flex; justify-content:space-between; color:#64748B;"><span>Contact No.:</span> <b style="color:#0F172A;">' + cleanText(b.userPhone) + '</b></div>' +
        '<div style="display:flex; justify-content:space-between; color:#64748B;"><span>Permanent Address:</span> <b style="color:#0F172A; text-align:right;">' + cleanText(b.userOldAddress) + '</b></div>' +
        '<div style="display:flex; justify-content:space-between; color:#64748B;"><span>Check-in Date:</span> <b style="color:#0F172A;">' + cleanText(b.date) + '</b></div>' +
        '<div style="display:flex; justify-content:space-between; color:#64748B;"><span>Stay Duration:</span> <b style="color:#0F172A;">' + b.duration + ' ' + (b.duration > 1 ? 'Months' : 'Month') + '</b></div>' +
        '<div style="display:flex; justify-content:space-between; color:#64748B;"><span>Suitable For:</span> <b style="color:#044E3B;">' + cleanText(b.suitableFor || 'Family') + '</b></div>' +
        '<div style="display:flex; justify-content:space-between; color:#044E3B; font-size:11.5px; font-weight:900; margin-top:2px;"><span>Total Rent (inc. Deposit):</span> <span>' + sym + Number(totalAmount).toLocaleString() + '</span></div>' +

        '<div style="font-weight:900; color:#044E3B; margin-top:8px; border-bottom:1px solid #E2E8F0; padding-bottom:2px;">🏢 OWNER DETAILS</div>' +
        '<div style="display:flex; justify-content:space-between; color:#64748B;"><span>Owner Name:</span> <b style="color:#0F172A;">' + cleanText(b.ownerName || l.ownerName || 'Property Owner') + '</b></div>' +
        '<div style="display:flex; justify-content:space-between; color:#64748B;"><span>Contact No.:</span> <b style="color:#0F172A;">' + cleanText(b.ownerPhone || l.phone || 'N/A') + '</b></div>' +
        '<div style="display:flex; justify-content:space-between; color:#64748B;"><span>Gmail:</span> <b style="color:#0F172A;">' + cleanText(b.ownerGmail || l.gmail || 'Not Provided') + '</b></div>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function closeModal() {
  document.getElementById('modalSlot').innerHTML = '';
}

// ================= ADMIN DASHBOARD FUNCTIONS =================
function adminExportSummaryCsv() {
  (async function(){
    try {
      var auth=await sb.auth.getUser(); if(auth.error||!auth.data||!auth.data.user) throw new Error();
      var check=await sb.rpc('rehzu_is_admin'); if(check.error||check.data!==true) throw new Error();
      var rows=[['Metric','Count'],['Total users',(DB.profiles||[]).length],['Total listings',(DB.listings||[]).length],['Booking requests',(DB.bookings||[]).length]];
      var csv=rows.map(function(r){return r.map(function(v){return '"'+String(v).replace(/"/g,'""')+'"';}).join(',');}).join('\r\n');
      var blob=new Blob([csv],{type:'text/csv;charset=utf-8'}); var url=URL.createObjectURL(blob);
      var a=document.createElement('a');a.href=url;a.download='rehzu-admin-summary.csv';a.click();URL.revokeObjectURL(url);
    } catch(e){alert('Admin authorization required for export.');}
  })();
}
async function adminCheckSystemHealth() {
  var el=document.getElementById('adminHealthStatus');if(!el)return;el.textContent='Checking…';
  try {var a=await sb.auth.getUser();if(a.error||!a.data||!a.data.user)throw 0;var c=await sb.rpc('rehzu_is_admin');if(c.error||c.data!==true)throw 0;var p=await sb.from('profiles').select('id',{count:'exact',head:true});if(p.error)throw 0;el.textContent='Connected · Admin authorization verified · Database query successful';}
  catch(e){el.textContent='Check failed. Verify connection, session and server permissions.';}
}

function adminControlTab(section) {
  var allowed = ['dashboard','owners','users','reports','bookings','security','complaints','countries','settings','notifications','activity','health'];
  if (allowed.indexOf(section) === -1) section = 'dashboard';

  document.querySelectorAll('.rehzu-admin-compact-nav > button').forEach(function(node) {
    var action = String(node.getAttribute('onclick') || '');
    node.classList.toggle('active', action.indexOf("adminControlTab('" + section + "')") !== -1);
  });
  var topTabSection = section === 'dashboard' ? 'dashboard' : section === 'owners' ? 'owners' :
    (section === 'users' || section === 'bookings') ? 'users' : section === 'reports' ? 'reports' : '';
  document.querySelectorAll('.radmin-dashboard-tabs button').forEach(function(node) {
    var action = String(node.getAttribute('onclick') || '');
    node.classList.toggle('active', !!topTabSection && action.indexOf("adminControlTab('" + topTabSection + "')") !== -1);
  });

  var allPanels = [
    'adminDashboardSection','adminOwnersSection','adminUsersSection','adminRoomsSection',
    'adminBookingsSection','adminSecuritySection','adminComplaintsSection','adminCountriesSection',
    'adminSettingsSection','adminNotificationsSection','adminActivitySection','adminHealthSection',
    'adminRatingsSection','adminExportSection'
  ];
  allPanels.forEach(function(id) {
    var node = document.getElementById(id);
    if (node) node.style.display = 'none';
  });

  var titles = {
    dashboard:['Dashboard','Live overview of REHZO 99 users, listings, bookings and platform activity.'],
    owners:['Owners & Listings','Review registered owners and every room listing published on REHZO 99.'],
    users:['Users & Bookings','Review registered users, account access and booking records.'],
    bookings:['Booking Records','Review booking requests, confirmations and TRL records.'],
    reports:['Reports & Analytics','Review reported listings and platform analytics.'],
    security:['Security & Settings','Inspect recorded security events and review status.'],
    complaints:['User Complaints','Privately review and resolve user complaint tickets.'],
    countries:['Country Management','Review country-wise users and room listings.'],
    settings:['Content & Policies','Review platform policy and content controls.'],
    notifications:['Notifications','Review recent database-backed platform events.'],
    activity:['Admin Activity','Review the administrator activity history.'],
    health:['System Logs','Check administrator access and database connectivity.']
  };
  var title = document.getElementById('adminCurrentSectionTitle');
  var description = document.getElementById('adminSectionDescription');
  if (title) title.textContent = titles[section][0];
  if (description) description.textContent = titles[section][1];

  function show(id) {
    var node = document.getElementById(id);
    if (node) node.style.display = 'block';
  }
  var search = document.getElementById('adminSearchInput');
  var query = search ? search.value : '';
  if (search && section === 'dashboard') search.value = '';

  if (section === 'dashboard') {
    show('adminDashboardSection');
    renderAdminDashboardMetrics();
    return;
  }
  if (section === 'owners') {
    show('adminOwnersSection');
    currentAdminSubTab = 'owners';
    renderAdminOwnersSection(query);
    filterAdminListings(query);
    return;
  }
  if (section === 'users') {
    show('adminUsersSection');
    show('adminBookingsSection');
    currentAdminSubTab = 'users';
    renderCurrentAdminSubTab();
    return;
  }
  if (section === 'bookings') {
    show('adminBookingsSection');
    currentAdminSubTab = 'bookings';
    if (window.adminBookingFilter == null) window.adminBookingFilter = '';
    renderAdminBookingsSection(query);
    return;
  }
  if (section === 'reports') {
    show('adminRoomsSection');
    renderAdminReportedListings(query);
    return;
  }

  var panelMap = {
    security:'adminSecuritySection', complaints:'adminComplaintsSection', countries:'adminCountriesSection',
    settings:'adminSettingsSection', notifications:'adminNotificationsSection', activity:'adminActivitySection',
    health:'adminHealthSection'
  };
  if (panelMap[section]) show(panelMap[section]);
  if (section === 'security') renderAdminSecurityAlerts();
  if (section === 'complaints') renderAdminComplaints();
  if (section === 'countries') {
    var listings = document.getElementById('adminCountryListings');
    var users = document.getElementById('adminCountryUsers');
    if (listings) listings.innerHTML = adminDashboardCountryRows(DB.listings || [], 'country');
    if (users) users.innerHTML = adminDashboardCountryRows(DB.profiles || [], 'country_code');
  }
  if (section === 'notifications' || section === 'activity') renderAdminActivityFeed(section);
  if (section === 'health') adminCheckSystemHealth();
}

function adminQuickOpen(section) {
  var search = document.getElementById('adminSearchInput');
  if (search) search.value = '';
  if (section === 'owners' || section === 'users' || section === 'rooms' || section === 'bookings') {
    switchAdminSubTab(section);
    if (section === 'bookings') window.adminBookingFilter = '';
    return;
  }
  if (section === 'reports') {
    switchAdminSubTab('rooms');
    var reports = document.getElementById('adminReportedListingsControl');
    if (reports) reports.scrollIntoView({behavior:'smooth', block:'start'});
    return;
  }
  if (section === 'pending' || section === 'accepted' || section === 'rejected' || section === 'confirmed' || section === 'cancelled' || section === 'trl') {
    window.adminBookingFilter = section;
    switchAdminSubTab('bookings');
    return;
  }
  if (section === 'stats') {
    var stats = document.getElementById('adminQuickGrid');
    if (stats) stats.scrollIntoView({behavior:'smooth', block:'start'});
  }
}

function switchAdminSubTab(tab) {
  if (tab === 'owners') return adminControlTab('owners');
  if (tab === 'users') return adminControlTab('users');
  if (tab === 'rooms') return adminControlTab('reports');
  if (tab === 'bookings') return adminControlTab('bookings');
  if (tab === 'security') return adminControlTab('security');
}

// ================= REHZO 99 ADVANCED ADMIN COMMAND SEARCH =================
var rehzuAdminSearchItems = [
  {label:'Dashboard',detail:'Open live platform overview',type:'Command',section:'dashboard'},
  {label:'Owners & Listings',detail:'Find owners and room listings',type:'Command',section:'owners'},
  {label:'Users & Bookings',detail:'Find registered users and booking activity',type:'Command',section:'users'},
  {label:'Booking Records',detail:'Search booking requests and TRL records',type:'Command',section:'bookings'},
  {label:'Reports & Analytics',detail:'Open reported listings and analytics',type:'Command',section:'reports'},
  {label:'User Complaints',detail:'Open private complaint queue',type:'Command',section:'complaints'},
  {label:'Country Management',detail:'Open country-wise platform data',type:'Command',section:'countries'},
  {label:'Security & Settings',detail:'Open security monitoring',type:'Command',section:'security'},
  {label:'Content & Policies',detail:'Open platform content and policies',type:'Command',section:'settings'},
  {label:'Notifications',detail:'Open platform notifications',type:'Command',section:'notifications'},
  {label:'Admin Activity',detail:'Open administrator activity',type:'Command',section:'activity'},
  {label:'System Logs',detail:'Open system health and logs',type:'Command',section:'health'}
];
function rehzuAdminSearchText(values) {
  return values.map(function(v){return String(v==null?'':v);}).join(' ').toLowerCase();
}
function rehzuAdminSearchGo(section, query) {
  var input=document.getElementById('adminSearchInput');
  var panel=document.getElementById('rehzuAdminSearchResults');
  if(input) input.value=query||'';
  if(panel) panel.hidden=true;
  if(section==='dashboard') { if(input) input.value=''; adminControlTab('dashboard'); return; }
  adminControlTab(section);
  if(section==='owners') filterAdminListings(query||'');
  if(section==='users') renderCurrentAdminSubTab();
  if(section==='bookings') renderAdminBookingsSection(query||'');
}
function rehzuAdminSearchDateMode(raw) {
  var q=String(raw||'').toLowerCase();
  var now=new Date(), today=adminDashboardDayKey(now), mode='';
  if (/\b(today|aaj)\b/.test(q)) mode='today';
  else if (/\b(yesterday|kal|beete kal|pichhle kal)\b/.test(q)) mode='yesterday';
  else if (/\b(day before yesterday|parso|parson|pichhle parso)\b/.test(q)) mode='dayBefore';
  else if (/\b(tomorrow|aane wala kal|next day)\b/.test(q)) mode='tomorrow';
  else if (/\b(day after tomorrow|aane wala parso)\b/.test(q)) mode='dayAfter';
  else if (/\b(last 30 days|past 30 days|within 1 month|within one month|1 month|one month|ek mahina|pichhle 30 din|30 days)\b/.test(q)) mode='last30';
  else if (/\b(this month|current month|iss mahine|is mahine)\b/.test(q)) mode='thisMonth';
  else if (/\b(last month|previous month|pichhle mahine)\b/.test(q)) mode='lastMonth';
  var date=new Date(now);
  if(mode==='yesterday') date.setDate(date.getDate()-1);
  if(mode==='dayBefore') date.setDate(date.getDate()-2);
  if(mode==='tomorrow') date.setDate(date.getDate()+1);
  if(mode==='dayAfter') date.setDate(date.getDate()+2);
  var key=mode==='today'||mode==='yesterday'||mode==='dayBefore'||mode==='tomorrow'||mode==='dayAfter'?adminDashboardDayKey(date):'';
  var monthStart=new Date(now.getFullYear(),now.getMonth(),1);
  var prevStart=new Date(now.getFullYear(),now.getMonth()-1,1);
  var prevEnd=new Date(now.getFullYear(),now.getMonth(),1);
  var cutoff=new Date(now); cutoff.setDate(cutoff.getDate()-30);
  return {mode:mode,key:key,today:today,monthStart:monthStart,prevStart:prevStart,prevEnd:prevEnd,cutoff:cutoff};
}
function rehzuAdminDateMatches(value, range) {
  if(!range.mode)return true;
  if(!value)return false;
  var d=new Date(value); if(!Number.isFinite(d.getTime()))return false;
  var key=adminDashboardDayKey(d);
  if(['today','yesterday','dayBefore','tomorrow','dayAfter'].includes(range.mode))return key===range.key;
  if(range.mode==='last30')return d>=range.cutoff;
  if(range.mode==='thisMonth')return d>=range.monthStart && d<new Date(range.monthStart.getFullYear(),range.monthStart.getMonth()+1,1);
  if(range.mode==='lastMonth')return d>=range.prevStart && d<range.prevEnd;
  return true;
}
function rehzuAdminCompactLine(label,value) {
  return '<div class="rehzu-admin-result-line"><b>'+cleanText(label)+':</b> '+cleanText(value==null||value===''?'—':String(value))+'</div>';
}
function rehzuAdminStartVoiceSearch() {
  var input=document.getElementById('adminSearchInput'), panel=document.getElementById('rehzuAdminSearchResults');
  var SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!input)return;
  if(!SpeechRecognition){if(panel){panel.innerHTML='<div class="rehzu-admin-search-empty">Voice search is not supported here. Please use Chrome or type your search.</div>';panel.hidden=false;}return;}
  if(window.__rehzuAdminSpeechRecognition){try{window.__rehzuAdminSpeechRecognition.stop();}catch(e){}window.__rehzuAdminSpeechRecognition=null;}
  var recognition=new SpeechRecognition();window.__rehzuAdminSpeechRecognition=recognition;
  recognition.lang='hi-IN';recognition.interimResults=false;recognition.maxAlternatives=1;
  recognition.onstart=function(){var b=document.getElementById('adminVoiceSearchBtn');if(b){b.textContent='■';b.classList.add('is-listening');}if(panel){panel.innerHTML='<div class="rehzu-admin-search-empty">Listening… नाम, User ID, Contact No. या Gmail बोलिए</div>';panel.hidden=false;}};
  recognition.onresult=function(e){var t=e.results&&e.results[0]&&e.results[0][0]?e.results[0][0].transcript:'';if(t){input.value=t.trim();rehzuAdminGlobalSearch(input.value);}};
  recognition.onerror=function(e){if(panel){panel.innerHTML='<div class="rehzu-admin-search-empty">'+cleanText(e&&e.error==='not-allowed'?'Microphone permission allow करें.':'आवाज साफ नहीं मिली. फिर से कोशिश करें.')+'</div>';panel.hidden=false;}};
  recognition.onend=function(){var b=document.getElementById('adminVoiceSearchBtn');if(b){b.textContent='🎙';b.classList.remove('is-listening');}if(window.__rehzuAdminSpeechRecognition===recognition)window.__rehzuAdminSpeechRecognition=null;};
  try{recognition.start();}catch(e){if(panel){panel.innerHTML='<div class="rehzu-admin-search-empty">Voice search could not start. Please try again.</div>';panel.hidden=false;}}
}
function rehzuAdminGlobalSearch(raw) {
  var panel=document.getElementById('rehzuAdminSearchResults');
  if(!panel)return;
  var original=String(raw||'').trim(), q=original.toLowerCase();
  var range=rehzuAdminSearchDateMode(q);
  var bookings=Array.isArray(DB.bookings)?DB.bookings:[];
  var listings=Array.isArray(DB.listings)?DB.listings:[];
  var profiles=Array.isArray(DB.profiles)?DB.profiles:[];
  var allBookings=/\b(all|every|sabhi|sare|saare)\b/.test(q)&&/\b(trl|trn|booking|bookings|reservation)\b/.test(q);
  var allListings=/\b(all|every|sabhi|sare|saare)\b/.test(q)&&/\b(listing|listings|rooms|room)\b/.test(q);
  var allProfiles=/\b(all|every|sabhi|sare|saare)\b/.test(q)&&/\b(account|accounts|users|user|register|registration|login)\b/.test(q);
  var bookingIntent=allBookings||/\b(booking|bookings|trl|trn|booked|reservation)\b/.test(q);
  var listingIntent=allListings||/\b(listing|listings|room|rooms)\b/.test(q);
  var profileIntent=allProfiles||/\b(account|accounts|users|user|register|registration|login)\b/.test(q);
  var loginIntent=/\b(login|logged in|last login|sign in|signin)\b/.test(q);
  var isDateOnly=!!range.mode;
  var needle=q.replace(/\b(last login|logged in|sign in|signin|login|last|today|aaj|yesterday|kal|beete kal|pichhle kal|day before yesterday|parso|parson|pichhle parso|tomorrow|aane wala kal|next day|day after tomorrow|aane wala parso|last 30 days|past 30 days|within 1 month|within one month|1 month|one month|ek mahina|pichhle 30 din|30 days|this month|current month|iss mahine|is mahine|last month|previous month|pichhle mahine|all|every|sabhi|sare|saare|no|number|numbers|trl|trn|booking|bookings|reservation|listing|listings|rooms|room|account|accounts|users|user|register|registration)\b/g,' ').replace(/\s+/g,' ').trim();
  function includes(values){
    var source=rehzuAdminSearchText(values);
    if(source.includes(needle))return true;
    var compactNeedle=needle.replace(/[^a-z0-9@._+-]/g,'');
    var compactSource=source.replace(/[^a-z0-9@._+-]/g,'');
    var digitNeedle=needle.replace(/\D/g,'');
    var digitSource=source.replace(/\D/g,'');
    return (compactNeedle.length>=2&&compactSource.includes(compactNeedle))||(digitNeedle.length>=4&&digitSource.includes(digitNeedle));
  }
  var matchedBookings=bookings.filter(function(b){
    var dateOk=!range.mode||rehzuAdminDateMatches(b.createdAt||b.trlIssuedAt,range);
    if(!dateOk)return false;
    if(allBookings||(isDateOnly&&!needle&&(!listingIntent&&!profileIntent||bookingIntent)))return true;
    if(bookingIntent&&!needle)return true;
    return !!needle&&includes([b.id,b.trl,b.listingId,b.houseName,b.roomType,b.roomCity,b.roomState,b.roomPin,b.userName,b.userUid,b.userPhone,b.userGmail,b.ownerName,b.ownerPhone,b.ownerGmail,b.status]);
  }).sort(function(a,b){return String(b.createdAt||'').localeCompare(String(a.createdAt||''));});
  var matchedListings=listings.filter(function(x){
    if(range.mode&&!rehzuAdminDateMatches(x.createdAt,range))return false;
    if(allListings||(isDateOnly&&!needle&&(!bookingIntent&&!profileIntent||listingIntent)))return true;
    if(listingIntent&&!needle)return true;
    return !!needle&&includes([x.id,x.houseName,x.city,x.state,x.country,x.ownerName,x.ownerUid,x.phone,x.gmail,x.status,x.roomType,x.pin]);
  }).sort(function(a,b){return String(b.createdAt||'').localeCompare(String(a.createdAt||''));});
  var matchedProfiles=profiles.filter(function(x){
    if(range.mode&&!rehzuAdminDateMatches(loginIntent?x.last_login_at:x.created_at,range))return false;
    if(allProfiles||(isDateOnly&&!needle&&(!bookingIntent&&!listingIntent||profileIntent)))return true;
    if(profileIntent&&!needle)return true;
    return !!needle&&includes([x.id,x.uid,x.name,x.phone,x.gmail,x.role,x.country_code,x.last_login_at]);
  }).sort(function(a,b){return String((loginIntent?b.last_login_at:b.created_at)||'').localeCompare(String((loginIntent?a.last_login_at:a.created_at)||''));});
  if(!q){
    var commands=rehzuAdminSearchItems.slice(0,8);
    var recent=[];try{recent=JSON.parse(sessionStorage.getItem('rehzu_admin_recent_searches')||'[]');}catch(e){}
    panel.innerHTML='<div class="rehzu-admin-search-heading">QUICK SEARCH</div>'+commands.map(function(x){return '<button type="button" class="rehzu-admin-search-item" data-section="'+cleanText(x.section)+'"><span>⌕</span><span><b>'+cleanText(x.label)+'</b><small>'+cleanText(x.detail)+'</small></span></button>';}).join('')+(recent.length?'<div class="rehzu-admin-search-heading">RECENT · '+cleanText(recent.slice(0,3).join(' · '))+'</div>':'');
    panel.hidden=false;
    panel.querySelectorAll('button[data-section]').forEach(function(btn){btn.addEventListener('click',function(){var sec=btn.getAttribute('data-section');if(sec)rehzuAdminSearchGo(sec,'');});});
    return;
  }
  var modeLabels={today:'Today / Aaj',yesterday:'Yesterday / Kal',dayBefore:'Day before yesterday / Parso',tomorrow:'Tomorrow',dayAfter:'Day after tomorrow',last30:'Last 30 days / 1 month',thisMonth:'This month',lastMonth:'Last month'};
  var html='<div class="rehzu-admin-search-heading">SEARCH RESULTS · '+cleanText(modeLabels[range.mode]||'All matching records')+'</div>';
  var total=matchedBookings.length+matchedListings.length+matchedProfiles.length;
  html+='<div class="rehzu-admin-search-summary">Bookings: <b>'+matchedBookings.length+'</b> · Listings: <b>'+matchedListings.length+'</b> · Accounts: <b>'+matchedProfiles.length+'</b> · Total: <b>'+total+'</b></div>';
  matchedBookings.slice(0,30).forEach(function(b){
    var room=listings.find(function(x){return String(x.id)===String(b.listingId);})||{};
    var created=b.createdAt?adminDashboardFormatDate(b.createdAt):'Not recorded';
    var confirmed=b.trlIssuedAt?adminDashboardFormatDate(b.trlIssuedAt):'Not final-confirmed';
    var lines=rehzuAdminCompactLine('TRL',b.trl||'Not generated')+
      rehzuAdminCompactLine('Room / Listing',b.houseName||room.houseName||b.roomType)+
      rehzuAdminCompactLine('Area', [b.roomCity||room.city,b.roomState||room.state,b.roomPin||room.pin].filter(Boolean).join(', '))+
      rehzuAdminCompactLine('Owner',b.ownerName||room.ownerName)+
      rehzuAdminCompactLine('Owner ID',room.ownerUid||'Not recorded')+
      rehzuAdminCompactLine('Owner contact',b.ownerPhone||room.phone)+
      rehzuAdminCompactLine('Owner Gmail',b.ownerGmail||room.gmail)+
      rehzuAdminCompactLine('Booked by',b.userName)+
      rehzuAdminCompactLine('User ID',b.userUid)+
      rehzuAdminCompactLine('User contact',b.userPhone)+
      rehzuAdminCompactLine('User Gmail',b.userGmail)+
      rehzuAdminCompactLine('Request created',created)+
      rehzuAdminCompactLine('Final booking time',confirmed)+
      rehzuAdminCompactLine('Check-in',b.date||'—')+
      rehzuAdminCompactLine('Status',String(b.status||'pending').replace(/_/g,' '));
    html+='<article class="rehzu-admin-search-record"><b>BOOKING · '+cleanText(b.trl||b.id||'Record')+'</b>'+lines+'</article>';
  });
  matchedListings.slice(0,30).forEach(function(x){
    html+='<article class="rehzu-admin-search-record"><b>ROOM LISTING · '+cleanText(x.houseName||'Room')+'</b>'+
      rehzuAdminCompactLine('Listing ID',x.id)+rehzuAdminCompactLine('Owner',x.ownerName)+
      rehzuAdminCompactLine('Owner ID',x.ownerUid)+rehzuAdminCompactLine('Phone',x.phone)+
      rehzuAdminCompactLine('Gmail',x.gmail)+rehzuAdminCompactLine('Location',[x.city,x.state,x.pin].filter(Boolean).join(', '))+
      rehzuAdminCompactLine('Listed on',x.createdAt?adminDashboardFormatDate(x.createdAt):'Not recorded')+
      rehzuAdminCompactLine('Status',x.status)+'</article>';
  });
  matchedProfiles.slice(0,30).forEach(function(x){
    html+='<article class="rehzu-admin-search-record"><b>APP ACCOUNT · '+cleanText(x.name||'User')+'</b>'+
      rehzuAdminCompactLine('User ID',x.uid)+rehzuAdminCompactLine('Phone',x.phone)+
      rehzuAdminCompactLine('Gmail',x.gmail)+rehzuAdminCompactLine('Country',x.country_code)+
      rehzuAdminCompactLine('Account created',x.created_at?adminDashboardFormatDate(x.created_at):'Not recorded')+
      rehzuAdminCompactLine('Last login',x.last_login_at?adminDashboardFormatDate(x.last_login_at):'No login recorded')+
      rehzuAdminCompactLine('Role',x.role||'User')+'</article>';
  });
  if(!total)html+='<div class="rehzu-admin-search-empty">No matching records found in the currently loaded admin data. Refresh and try a TRL, User ID, phone, Gmail, room name or city.</div>';
  if(total>90)html+='<div class="rehzu-admin-search-empty">Showing up to 30 records per category. Open the related section or narrow the search to see fewer results.</div>';
  html+='<div class="rehzu-admin-search-heading">Admin-only information · Latest loaded records · Refresh for current data</div>';
  panel.innerHTML=html;
  panel.hidden=false;
  try{var recent=JSON.parse(sessionStorage.getItem('rehzu_admin_recent_searches')||'[]');recent=[original].concat(recent.filter(function(v){return v!==original;})).slice(0,5);sessionStorage.setItem('rehzu_admin_recent_searches',JSON.stringify(recent));}catch(e){}
}
(function bindRehzuAdminSearchShortcuts(){
  if(window.__rehzuAdminSearchBound)return;
  window.__rehzuAdminSearchBound=true;
  document.addEventListener('keydown',function(event){
    if((event.ctrlKey||event.metaKey)&&String(event.key).toLowerCase()==='k'){
      var input=document.getElementById('adminSearchInput');
      if(input){event.preventDefault();input.focus();input.select();rehzuAdminGlobalSearch(input.value);}
    }
    if(event.key==='Escape'){
      var panel=document.getElementById('rehzuAdminSearchResults');
      if(panel)panel.hidden=true;
    }
  });
  document.addEventListener('click',function(event){
    var panel=document.getElementById('rehzuAdminSearchResults');
    var wrap=document.querySelector('.radmin-command-search');
    if(panel&&wrap&&!wrap.contains(event.target))panel.hidden=true;
  });
})();

function renderCurrentAdminSubTab() {
  var q = document.getElementById('adminSearchInput') ? document.getElementById('adminSearchInput').value : '';
  if (currentAdminSubTab === 'owners') renderAdminOwnersSection(q);
  else if (currentAdminSubTab === 'users') { renderAdminUsersSection(q); renderAdminModerationUsers(q); renderAdminBookingsSection(q); }
  else if (currentAdminSubTab === 'bookings') renderAdminBookingsSection(q);
  else if (currentAdminSubTab === 'rooms') renderAdminReportedListings(q);
  else if (currentAdminSubTab === 'owners') { renderAdminOwnersSection(q); filterAdminListings(q); }
}

function adminDashboardDayKey(value) {
  if (!value) return '';
  var date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  var parts = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  var part = {};
  parts.forEach(function(p){ part[p.type] = p.value; });
  return part.year + '-' + part.month + '-' + part.day;
}
function adminDashboardCountryName(code) {
  var value = String(code || '').toUpperCase().trim();
  if (!value) return 'Not recorded';
  var match = (WORLD_COUNTRIES || []).find(function(country){ return country.code === value; });
  return match ? match.name : value;
}
function adminDashboardFormatDate(value) {
  if (!value) return 'Date/time not recorded';
  var date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Date/time not recorded';
  return new Intl.DateTimeFormat('en-IN', {timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'short'}).format(date) + ' IST';
}
function adminDashboardSet(id, value) {
  var node = document.getElementById(id);
  if (node) node.textContent = String(value);
}
function adminDashboardCountryRows(records, countryField) {
  var counts = Object.create(null);
  (records || []).forEach(function(record) {
    var code = String(record[countryField] || '').toUpperCase().trim() || 'UNKNOWN';
    counts[code] = (counts[code] || 0) + 1;
  });
  var rows = Object.keys(counts).sort(function(a,b){ return counts[b]-counts[a] || a.localeCompare(b); });
  if (!rows.length) return '<p class="ra-empty-note">No records available yet.</p>';
  return rows.map(function(code) {
    return '<div class="ra-country-row"><span>' + cleanText(adminDashboardCountryName(code)) + '</span><strong>' + counts[code] + '</strong></div>';
  }).join('');
}
function adminDashboardActivityCard(title, who, country, place, when, subline) {
  return '<article class="ra-live-record"><div class="ra-live-record-top"><b>' + cleanText(title || 'Record') + '</b><span>' + cleanText(country || 'Not recorded') + '</span></div>' +
    '<div class="ra-live-record-person">' + cleanText(who || 'Name not recorded') + '</div>' +
    '<div class="ra-live-record-meta">' + cleanText(place || 'Location not recorded') + '</div>' +
    '<div class="ra-live-record-meta">' + cleanText(when || 'Date/time not recorded') + '</div>' +
    (subline ? '<div class="ra-live-record-meta">' + cleanText(subline) + '</div>' : '') + '</article>';
}
async function renderAdminDashboardMetrics() {
  var today = adminDashboardDayKey(new Date());
  var yesterdayDate = new Date(Date.now() - 86400000);
  var yesterday = adminDashboardDayKey(yesterdayDate);
  var tomorrowDate = new Date(Date.now() + 86400000);
  var tomorrow = adminDashboardDayKey(tomorrowDate);
  var listings = Array.isArray(DB.listings) ? DB.listings : [];
  var profiles = Array.isArray(DB.profiles) ? DB.profiles : [];
  var bookings = Array.isArray(DB.bookings) ? DB.bookings : [];
  var serverMetrics = DB.adminMetrics && typeof DB.adminMetrics === 'object' ? DB.adminMetrics : {};
  var securityAlerts = Array.isArray(DB.adminSecurityAlerts) ? DB.adminSecurityAlerts : [];
  var unreviewedSecurityAlerts = securityAlerts.filter(function(alert){ return !alert.acknowledged_at; }).length;
  var todayListings = listings.filter(function(item){ return adminDashboardDayKey(item.createdAt) === today; })
    .sort(function(a,b){ return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
  var yesterdayUsers = profiles.filter(function(item){ return adminDashboardDayKey(item.created_at) === yesterday; })
    .sort(function(a,b){ return String(b.created_at || '').localeCompare(String(a.created_at || '')); });
  var todayUsers = profiles.filter(function(item){ return adminDashboardDayKey(item.created_at) === today; })
    .sort(function(a,b){ return String(b.created_at || '').localeCompare(String(a.created_at || '')); });
  var pending = bookings.filter(function(item){ return String(item.status || '').toLowerCase() === 'pending'; });
  var accepted = bookings.filter(function(item){ return String(item.status || '').toLowerCase() === 'owner_accepted'; });
  var rejected = bookings.filter(function(item){ return String(item.status || '').toLowerCase() === 'rejected'; });
  var todayBookings = bookings.filter(function(item){ return adminDashboardDayKey(item.created_at || item.createdAt) === today; });
  var yesterdayBookings = bookings.filter(function(item){ return adminDashboardDayKey(item.created_at || item.createdAt) === yesterday; });
  var confirmedBookings = bookings.filter(function(item){ return ['confirmed','final_confirmed','booked'].includes(String(item.status || '').toLowerCase()); });
  var yesterdayListings = listings.filter(function(item){ return adminDashboardDayKey(item.createdAt || item.created_at) === yesterday; });
  var tomorrowListings = listings.filter(function(item){ return adminDashboardDayKey(item.createdAt || item.created_at) === tomorrow; });
  var tomorrowUsers = profiles.filter(function(item){ return adminDashboardDayKey(item.created_at || item.createdAt) === tomorrow; });
  var liveListings = listings.filter(function(item){
    var status = String(item.status || '').toLowerCase();
    var expiry = item.expires_at || item.expiresAt;
    return ['deleted','removed','expired'].indexOf(status) < 0 && (!expiry || new Date(expiry).getTime() >= Date.now());
  });
  var availableListings = listings.filter(function(item){ return ['available','active','published',''].includes(String(item.status || '').toLowerCase()); });
  var pendingListings = listings.filter(function(item){ return String(item.status || '').toLowerCase() === 'pending'; });
  var bookedListings = listings.filter(function(item){ return String(item.status || '').toLowerCase() === 'booked'; });
  adminDashboardSet('adminYesterdayListingsCount', yesterdayListings.length);
  adminDashboardSet('adminLiveListingsCount', liveListings.length);
  adminDashboardSet('adminPeriodYesterdayListings', yesterdayListings.length);
  adminDashboardSet('adminPeriodTomorrowListings', tomorrowListings.length);
  adminDashboardSet('adminPeriodTodayListings', todayListings.length);
  adminDashboardSet('adminPeriodLiveListings', liveListings.length);
  adminDashboardSet('adminPeriodYesterdayRegisters', serverMetrics.yesterday_registered == null ? yesterdayUsers.length : Number(serverMetrics.yesterday_registered) || 0);
  adminDashboardSet('adminPeriodTomorrowRegisters', tomorrowUsers.length);
  adminDashboardSet('adminPeriodTodayRegisters', serverMetrics.today_registered == null ? todayUsers.length : Number(serverMetrics.today_registered) || 0);
  adminDashboardSet('adminPeriodLiveRegisters', DB.liveUsersCount == null
    ? (serverMetrics.live_users == null ? '—' : Number(serverMetrics.live_users) || 0)
    : Number(DB.liveUsersCount) || 0);
  adminDashboardSet('adminTodayBookingsCount', todayBookings.length);
  adminDashboardSet('adminYesterdayBookingsCount', yesterdayBookings.length);
  adminDashboardSet('adminConfirmedBookingsCount', confirmedBookings.length);
  var cancelledBookings = bookings.filter(function(item){ return String(item.status || '').toLowerCase() === 'cancelled'; });
  adminDashboardSet('adminLiveRejectedCount', rejected.length);
  adminDashboardSet('adminBookingConfirmedShortcut', confirmedBookings.length);
  adminDashboardSet('adminBookingPendingShortcut', pending.length);
  adminDashboardSet('adminBookingRejectedShortcut', rejected.length);
  adminDashboardSet('adminBookingCancelledShortcut', cancelledBookings.length);
  adminDashboardSet('adminRejectedBookingsMini', rejected.length);
  adminDashboardSet('adminCancelledBookingsMini', cancelledBookings.length);
  adminDashboardSet('adminListingAvailableCount', availableListings.length);
  adminDashboardSet('adminListingAvailableDetail', availableListings.length);
  adminDashboardSet('adminListingPendingCount', pendingListings.length);
  adminDashboardSet('adminListingBookedCount', bookedListings.length);


  adminDashboardSet('adminTotalListings', listings.length);
  adminDashboardSet('adminTodayListingsCount', todayListings.length);
  adminDashboardSet('adminTotalBookingRequests', bookings.length);
  var fallbackInactiveUsers = profiles.filter(function(item) {
    var status = String(item.status || item.account_status || '').toLowerCase();
    return item.is_blocked === true || item.blocked === true || item.is_active === false ||
      status === 'blocked' || status === 'suspended' || status === 'inactive';
  }).length;
  var inactiveUsers = serverMetrics.inactive_users == null ? fallbackInactiveUsers : Number(serverMetrics.inactive_users) || 0;
  var activeUsers = serverMetrics.active_users == null ? Math.max(0, profiles.length - inactiveUsers) : Number(serverMetrics.active_users) || 0;
  var totalUsers = serverMetrics.total_users == null ? profiles.length : Number(serverMetrics.total_users) || 0;
  adminDashboardSet('adminTotalRegisteredUsers', totalUsers);
  adminDashboardSet('adminActiveUsersCount', activeUsers);
  adminDashboardSet('adminActiveUsersDetail', activeUsers);
  adminDashboardSet('adminInactiveUsersCount', inactiveUsers);
  adminDashboardSet('adminTotalActiveUsers', activeUsers);
  // Payment gateway is not enabled; never infer paid status from unrelated account data.
  adminDashboardSet('adminPaidUsersCount', 0);
  adminDashboardSet('adminPaidUsersDetail', 0);
  adminDashboardSet('adminUnpaidUsersCount', totalUsers);
  adminDashboardSet('adminPaidYesterdayJoin', 0);
  adminDashboardSet('adminPaidTodayJoin', 0);
  var liveCount = DB.liveUsersCount == null
    ? (serverMetrics.live_users == null ? '—' : Number(serverMetrics.live_users) || 0)
    : Number(DB.liveUsersCount) || 0;
  adminDashboardSet('adminLiveUsersCount', liveCount);
  adminDashboardSet('adminYesterdayLiveUsersCount', serverMetrics.yesterday_live_users == null ? '—' : Number(serverMetrics.yesterday_live_users) || 0);
  adminDashboardSet('adminYesterdayUsersCount', serverMetrics.yesterday_registered == null ? yesterdayUsers.length : Number(serverMetrics.yesterday_registered) || 0);
  adminDashboardSet('adminTodayUsersCount', serverMetrics.today_registered == null ? todayUsers.length : Number(serverMetrics.today_registered) || 0);
  adminDashboardSet('adminTrafficLiveStatus', liveCount === '—' ? 'Not available' : liveCount + ' online');
  adminDashboardSet('adminSecurityEventCount', securityAlerts.length === 100 ? '100+' : securityAlerts.length);
  adminDashboardSet('adminSecurityUnreviewedCount', unreviewedSecurityAlerts);
  adminDashboardSet('adminLivePendingCount', pending.length);
  adminDashboardSet('adminLiveAcceptedCount', accepted.length);
  adminDashboardSet('adminLiveRejectedCount', rejected.length);

  var listingCountries = document.getElementById('adminListingsCountryBreakdown');
  if (listingCountries) listingCountries.innerHTML = adminDashboardCountryRows(listings, 'country');
  var userCountries = document.getElementById('adminUsersCountryBreakdown');
  if (userCountries) userCountries.innerHTML = adminDashboardCountryRows(profiles, 'country_code');

  adminDashboardSet('adminAllListingsCount', listings.length);
  var allListingNode = document.getElementById('adminAllListingsList');
  if (allListingNode) allListingNode.innerHTML = listings.length ? listings.slice().sort(function(a,b) {
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  }).slice(0,100).map(function(item) {
    return adminDashboardActivityCard(item.houseName || 'Room listing', item.ownerName || item.ownerUid || 'Owner not recorded',
      adminDashboardCountryName(item.country), [item.city,item.state,item.pin].filter(Boolean).join(', ') || 'Location not recorded',
      adminDashboardFormatDate(item.createdAt), 'Owner ID: ' + (item.ownerUid || 'Not recorded'));
  }).join('') : '<p class="ra-empty-note">No room listings recorded.</p>';

  var todayListingNode = document.getElementById('adminTodayListingsList');
  if (todayListingNode) todayListingNode.innerHTML = todayListings.length ? todayListings.slice(0,30).map(function(item) {
    return adminDashboardActivityCard(item.houseName, item.ownerName || item.ownerUid, adminDashboardCountryName(item.country), [item.city,item.state,item.pin].filter(Boolean).join(', '), adminDashboardFormatDate(item.createdAt), 'Owner ID: ' + (item.ownerUid || 'Not recorded'));
  }).join('') : '<p class="ra-empty-note">No room listings recorded today.</p>';

  function renderRegistrationRows(rows, emptyText) {
    return rows.length ? rows.slice(0,30).map(function(item) {
      return adminDashboardActivityCard('Registered account', item.name, adminDashboardCountryName(item.country_code), 'Registration city not collected', adminDashboardFormatDate(item.created_at), 'User ID: ' + (item.uid || 'Not recorded'));
    }).join('') : '<p class="ra-empty-note">' + cleanText(emptyText) + '</p>';
  }
  var yesterdayNode = document.getElementById('adminYesterdayUsersList');
  if (yesterdayNode) yesterdayNode.innerHTML = renderRegistrationRows(yesterdayUsers, 'No registrations recorded yesterday.');
  var todayNode = document.getElementById('adminTodayUsersList');
  if (todayNode) todayNode.innerHTML = renderRegistrationRows(todayUsers, 'No registrations recorded today.');

  var latestBookings = bookings.slice().sort(function(a,b){ return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); }).slice(0,50);
  var bookingNode = document.getElementById('adminLiveBookingRequests');
  if (bookingNode) {
    var bookingRows = latestBookings.map(function(item,index) {
      var status = String(item.status || 'pending').toLowerCase();
      var label = status === 'owner_accepted' ? 'Accepted' : status.replace(/_/g,' ').replace(/\b\w/g,function(ch){return ch.toUpperCase();});
      var cls = status === 'confirmed' ? 'approved' : status === 'rejected' || status === 'cancelled' ? 'rejected' : status === 'owner_accepted' ? 'accepted' : 'pending';
      var requestId = item.id || item.bookingId || item.trl || ('REQ-' + String(index+1).padStart(3,'0'));
      var customer = item.userName || item.userUid || 'Customer not recorded';
      var room = item.houseName || item.roomType || 'Room booking';
      var owner = item.ownerName || 'Owner not recorded';
      var place = [item.roomCity,item.roomState,item.roomPin].filter(Boolean).join(', ') || 'Location not recorded';
      return '<tr><td><b>'+cleanText(String(requestId).slice(0,20))+'</b></td><td><b>'+cleanText(customer)+'</b><small>'+cleanText(item.userUid || '')+'</small></td><td>'+cleanText(room)+'<small>'+cleanText(place)+'</small></td><td>'+cleanText(owner)+'</td><td>'+cleanText(adminDashboardFormatDate(item.createdAt))+'</td><td><span class="ra-status-badge '+cls+'">'+cleanText(label)+'</span></td></tr>';
    }).join('');
    bookingNode.innerHTML = latestBookings.length ? '<div class="ra-table-wrap"><table class="ra-requests-table ra-dashboard-requests-table"><thead><tr><th>Request ID</th><th>Customer</th><th>Room</th><th>Owner</th><th>Date</th><th>Status</th></tr></thead><tbody>'+bookingRows+'</tbody></table></div><p class="ra-table-foot">Latest '+latestBookings.length+' of '+bookings.length+' booking requests</p>' : '<p class="ra-empty-note">No booking requests recorded.</p>';
  }


function renderRehzuVisualAdminDashboard() {
  var profiles = Array.isArray(DB.profiles) ? DB.profiles : [];
  var listings = Array.isArray(DB.listings) ? DB.listings : [];
  var bookings = Array.isArray(DB.bookings) ? DB.bookings : [];
  var ownerIds = new Set(listings.map(function(x){return String(x.ownerUid || x.owner_uid || '').trim();}).filter(Boolean));
  var ownersNode = document.getElementById('adminVisualOwnersCount');
  if (ownersNode) ownersNode.textContent = String(ownerIds.size);
  var countryTotal = document.getElementById('adminVisualCountryTotal');
  if (countryTotal) countryTotal.innerHTML = cleanText(String(profiles.length)) + '<small>Users</small>';

  var chart = document.getElementById('adminVisualBookingChart');
  if (chart) {
    var days = [];
    for (var n=29;n>=0;n--) { var d=new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()-n); days.push({date:d,count:0}); }
    bookings.forEach(function(b){
      var raw=b.createdAt || b.created_at;
      var t=raw ? new Date(raw).getTime() : NaN;
      if (!Number.isFinite(t)) return;
      var day=new Date(t); day.setHours(0,0,0,0);
      var key=day.getTime();
      var found=days.find(function(x){return x.date.getTime()===key;});
      if(found) found.count++;
    });
    var max=Math.max(1,...days.map(function(x){return x.count;}));
    var W=560,H=190,L=34,R=10,T=12,B=30,innerW=W-L-R,innerH=H-T-B;
    var pts=days.map(function(x,i){return {x:L+i*innerW/(days.length-1),y:T+innerH-(x.count/max)*innerH,count:x.count};});
    var line=pts.map(function(p,i){return (i?'L':'M')+p.x.toFixed(1)+' '+p.y.toFixed(1);}).join(' ');
    var area=line+' L '+(L+innerW)+' '+(T+innerH)+' L '+L+' '+(T+innerH)+' Z';
    var grid=[0,.5,1].map(function(f){var y=T+innerH*(1-f);return '<line x1="'+L+'" y1="'+y+'" x2="'+(W-R)+'" y2="'+y+'" stroke="#e5ebf3" stroke-width="1"/><text x="22" y="'+(y+4)+'" font-size="10" fill="#66758b" text-anchor="middle">'+Math.round(max*f)+'</text>';}).join('');
    var dots=pts.filter(function(p,i){return i%3===0||i===pts.length-1;}).map(function(p){return '<circle cx="'+p.x+'" cy="'+p.y+'" r="3.5" fill="#1677ed"/>';}).join('');
    var labels=[0,7,14,21,29].map(function(i){return '<text x="'+pts[i].x+'" y="'+(H-8)+'" font-size="10" fill="#53627a" text-anchor="middle">'+days[i].date.toLocaleDateString('en-IN',{day:'numeric',month:'short'})+'</text>';}).join('');
    chart.innerHTML=bookings.length?'<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Booking requests per day for the last 30 days">'+grid+'<path d="'+area+'" fill="#1677ed" opacity=".12"/><path d="'+line+'" fill="none" stroke="#1677ed" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'+dots+labels+'</svg>':'<p class="ra-empty-note">No booking activity recorded in the last 30 days.</p>';
  }
  var alerts=document.getElementById('adminVisualAlerts');
  if(alerts){
    var pending=bookings.filter(function(x){return ['pending','owner_accepted'].includes(String(x.status||'').toLowerCase());}).length;
    var expired=listings.filter(function(x){var v=x.expiresAt||x.expires_at;return v&&new Date(v).getTime()<Date.now();}).length;
    alerts.innerHTML='';
    var rows=[{label:pending+' Pending Bookings',tag:pending?'Requires Action':'No pending',cls:''},{label:expired+' Expired Listings',tag:expired?'Review':'Clear',cls:'warn'}];
    rows.forEach(function(x){var row=document.createElement('div');row.className='radmin-alert-row '+x.cls;var dot=document.createElement('i');dot.className='radmin-alert-dot';var label=document.createElement('span');label.textContent=x.label;var tag=document.createElement('b');tag.textContent=x.tag;row.append(dot,label,tag);alerts.appendChild(row);});
    var complaintRow=document.createElement('div');complaintRow.className='radmin-alert-row info';var dot2=document.createElement('i');dot2.className='radmin-alert-dot';var label2=document.createElement('span');label2.textContent='Complaint queue';var tag2=document.createElement('b');tag2.textContent='Open to review';complaintRow.append(dot2,label2,tag2);alerts.appendChild(complaintRow);
  }
  var recent=document.getElementById('adminVisualRecentActivities');
  if(recent){
    var events=[];
    profiles.forEach(function(x){var t=new Date(x.created_at||x.createdAt||0).getTime();if(Number.isFinite(t)&&t>0)events.push({t:t,icon:'👤',label:'New user registered'});});
    listings.forEach(function(x){var t=new Date(x.createdAt||x.created_at||0).getTime();if(Number.isFinite(t)&&t>0)events.push({t:t,icon:'⌂',label:'New room listing added'});});
    bookings.forEach(function(x){var t=new Date(x.createdAt||x.created_at||0).getTime();if(Number.isFinite(t)&&t>0)events.push({t:t,icon:'▣',label:'Booking request updated'});});
    events.sort(function(a,b){return b.t-a.t;});recent.innerHTML='';
    events.slice(0,5).forEach(function(e){var row=document.createElement('div');row.className='radmin-recent-row';var icon=document.createElement('span');icon.className='radmin-recent-icon';icon.textContent=e.icon;var label=document.createElement('span');label.textContent=e.label;var time=document.createElement('small');time.textContent=new Date(e.t).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});row.append(icon,label,time);recent.appendChild(row);});
    if(!events.length)recent.textContent='No recent activity records available.';
  }
}

  adminDashboardSet('adminAnalyticsUpdated', '● Updated ' + new Date().toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata'}));
  renderRehzuVisualAdminDashboard();
  return true;
}

async function adminRefreshAll() {
  var button = document.getElementById('adminRefreshBtn');
  var stamp = document.getElementById('adminLastRefresh');
  if (button) { button.disabled = true; button.textContent = 'Refreshing…'; }
  try {
    var auth = await sb.auth.getUser();
    if (auth.error || !auth.data || !auth.data.user) throw new Error('Sign in again to refresh admin data.');
    var check = await sb.rpc('rehzu_is_admin');
    if (check.error || check.data !== true) throw new Error('Administrator access required.');
    await syncFromSupabase();
    await renderAdminDashboardMetrics();
    if (stamp) stamp.textContent = 'Last refreshed: ' + new Date().toLocaleTimeString();
  } catch (err) {
    console.warn('Admin refresh failed:', err);
    alert('Admin data could not be refreshed. Check your connection and administrator session.');
  } finally {
    if (button) { button.disabled = false; button.textContent = '↻ Refresh data'; }
  }
}

async function adminLoadActivityEvents() {
  var auth = await sb.auth.getUser();
  if (auth.error || !auth.data || !auth.data.user) throw new Error('Sign in again to view admin activity.');
  var check = await sb.rpc('rehzu_is_admin');
  if (check.error || check.data !== true) throw new Error('Administrator access required.');
  var result = await sb.rpc('rehzu_admin_list_activity', { p_limit: 100 });
  if (result.error) throw result.error;
  return Array.isArray(result.data) ? result.data : [];
}

async function renderAdminActivityFeed(targetName) {
  var targetId = targetName === 'notifications' ? 'adminNotificationsFeed' : 'adminActivityFeed';
  var target = document.getElementById(targetId);
  if (!target) return;
  target.innerHTML = '<p class="ra-empty-note">Loading live database events…</p>';
  try {
    var rows = await adminLoadActivityEvents();
    if (!rows.length) {
      target.innerHTML = '<p class="ra-empty-note">No activity has been recorded yet. New database changes will appear here automatically.</p>';
      return;
    }
    target.innerHTML = rows.map(function(row) {
      var op = String(row.operation || 'UPDATE').toUpperCase();
      var label = op === 'INSERT' ? 'Created' : op === 'DELETE' ? 'Deleted' : 'Updated';
      var table = String(row.source_table || '').replace('public.', '').replace(/^rehzu_/, '');
      var record = row.record_id ? 'Record: ' + row.record_id : 'Record ID not available';
      return '<article class="ra-admin-record" style="margin-bottom:8px;">' +
        '<div class="ra-admin-record-head"><b>' + cleanText(label + ' · ' + table.replace(/_/g, ' ')) + '</b><span>' + cleanText(adminDashboardFormatDate(row.created_at)) + '</span></div>' +
        '<div class="ra-admin-record-meta">' + cleanText(record) + '</div>' +
        '<div class="ra-admin-record-meta">Actor: ' + cleanText(row.actor_uid || 'System / service action') + '</div>' +
      '</article>';
    }).join('');
  } catch (err) {
    console.warn('Admin activity feed failed:', err);
    target.innerHTML = '<p class="ra-empty-note">Could not load activity. Verify administrator access and database connection.</p>';
  }
}

async function renderAdminRatingsFeed() {
  var target = document.getElementById('adminRatingsFeed');
  if (!target) return;
  target.innerHTML = '<p class="ra-empty-note">Loading verified reviews…</p>';
  try {
    var auth = await sb.auth.getUser();
    if (auth.error || !auth.data || !auth.data.user) throw new Error('Sign in again to view reviews.');
    var check = await sb.rpc('rehzu_is_admin');
    if (check.error || check.data !== true) throw new Error('Administrator access required.');
    var result = await sb.rpc('rehzu_admin_list_reviews', { p_limit: 100 });
    if (result.error) throw result.error;
    var rows = Array.isArray(result.data) ? result.data : [];
    if (!rows.length) {
      target.innerHTML = '<p class="ra-empty-note">No user reviews have been submitted yet. New reviews will appear automatically.</p>';
      return;
    }
    target.innerHTML = rows.map(function(row) {
      return '<article class="ra-admin-record" style="margin-bottom:8px;">' +
        '<div class="ra-admin-record-head"><b>' + cleanText('★'.repeat(Math.max(0, Math.min(5, Number(row.rating) || 0))) + ' · ' + (Number(row.rating) || 0) + '/5') + '</b><span>' + cleanText(adminDashboardFormatDate(row.created_at)) + '</span></div>' +
        '<div class="ra-admin-record-meta">' + cleanText(row.review || 'No written review') + '</div>' +
        '<div class="ra-admin-record-meta">Listing: ' + cleanText(row.listing_id || '—') + ' · Reviewer: ' + cleanText(row.reviewer_uid || '—') + '</div>' +
      '</article>';
    }).join('');
  } catch (err) {
    console.warn('Admin reviews feed failed:', err);
    target.innerHTML = '<p class="ra-empty-note">Could not load reviews. Verify administrator access and review RPC deployment.</p>';
  }
}

async function renderAdminSecurityAlerts(unacknowledgedOnly) {
  var target = document.getElementById('adminSecurityAlertsList');
  if (!target) return;
  target.innerHTML = '<p style="font-size:11px;color:#64748B;">Loading security alerts…</p>';
  try {
    var auth = await sb.auth.getUser();
    if (auth.error || !auth.data || !auth.data.user) throw new Error('Please sign in again.');
    var adminCheck = await sb.rpc('rehzu_is_admin');
    if (adminCheck.error || adminCheck.data !== true) throw new Error('Admin authorization failed.');
    var result = await sb.rpc('rehzu_admin_list_security_alerts', { p_limit: 100 });
    if (result.error) throw result.error;
    var rows = Array.isArray(result.data) ? result.data : [];
    if (unacknowledgedOnly) rows = rows.filter(function(row){ return !row.acknowledged_at; });
    if (!rows.length) {
      target.innerHTML = unacknowledgedOnly ? '<p style="font-size:11px;color:#64748B;">No unacknowledged alerts. Reviewed alerts are hidden by this filter. Tap Refresh to view all recorded alerts.</p>' : '<p style="font-size:11px;color:#64748B;">No recorded alerts found. This does not prove that no attack occurred.</p>';
      return;
    }
    target.innerHTML = rows.map(function(row) {
      var severity = String(row.severity || 'low').toUpperCase();
      var color = severity === 'CRITICAL' || severity === 'HIGH' ? '#B91C1C' : severity === 'MEDIUM' ? '#B45309' : '#475569';
      var detail = row.details && typeof row.details === 'object' ? JSON.stringify(row.details) : '';
      return '<div style="border:1px solid #E2E8F0;border-radius:12px;padding:10px;margin-bottom:8px;">' +
        '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;"><b style="font-size:11px;color:'+color+';">'+cleanText(severity)+' · '+cleanText(row.event_type || 'security_event')+'</b><span style="font-size:9px;color:#64748B;">'+cleanText(row.created_at ? new Date(row.created_at).toLocaleString() : '')+'</span></div>' +
        '<p style="font-size:11px;margin-top:5px;">'+cleanText(row.message || 'Security event recorded.')+'</p>' +
        (detail ? '<p style="font-size:9px;color:#64748B;margin-top:4px;overflow-wrap:anywhere;">'+cleanText(detail)+'</p>' : '') +
        (row.acknowledged_at ? '<p style="font-size:10px;color:#047857;margin-top:6px;">Acknowledged</p>' : '<button class="btn-action-large" style="margin-top:7px;" onclick="acknowledgeAdminSecurityAlert('+Number(row.id)+')">Mark reviewed</button>') +
      '</div>';
    }).join('');
  } catch (err) {
    console.warn('Security alerts load failed:', err);
    target.innerHTML = '<p style="font-size:11px;color:#B91C1C;">Could not load alerts. Verify admin permissions and security RPC deployment.</p>';
  }
}

async function acknowledgeAdminSecurityAlert(alertId) {
  if (!Number.isSafeInteger(Number(alertId)) || Number(alertId) < 1) return;
  try {
    var auth = await sb.auth.getUser();
    if (auth.error || !auth.data || !auth.data.user) throw new Error('Sign-in required');
    var adminCheck = await sb.rpc('rehzu_is_admin');
    if (adminCheck.error || adminCheck.data !== true) throw new Error('Admin authorization failed');
    var result = await sb.rpc('rehzu_admin_ack_security_alert', { p_alert_id: Number(alertId) });
    if (result.error) throw result.error;
    await renderAdminSecurityAlerts();
  } catch (err) {
    alert('Could not mark alert reviewed. Check admin access and RPC deployment.');
  }
}

async function renderAdminModeration() {
  // Re-check against Supabase whenever admin data is rendered, not just on navigation.
  try {
    var authResult = await sb.auth.getUser();
    if (authResult.error || !authResult.data || !authResult.data.user) {
      throw new Error("Signed-in session required.");
    }
    var adminCheck = await sb.rpc('rehzu_is_admin');
    if (adminCheck.error) throw adminCheck.error;
    // This authenticated RPC round-trip is the real database health check.
    // Do not leave the dashboard stuck at "Connecting…" merely because the
    // separate private Realtime broadcast channel is unavailable.
    adminDashboardSet('adminDatabaseLiveStatus', 'Connected');
    adminDashboardSet('adminLastRefresh', 'Database verified · ' + new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }));
    if (adminCheck.data !== true) {
      throw new Error("Administrator authorization failed.");
    }
  } catch (err) {
    if (err && /fetch|network|timeout|failed to|jwt|session/i.test(String(err.message || err))) {
      adminDashboardSet('adminDatabaseLiveStatus', 'Unavailable');
      adminDashboardSet('adminLastRefresh', 'Database check failed · retry sign-in or refresh');
    }
    adminNavigationVerifiedUntil = 0;
    var adminView = document.getElementById('view-admin');
    if (adminView) adminView.classList.remove('active');
    goView('home');
    console.warn("Admin panel blocked:", err);
    return;
  }
  if (!adminEntryDataLoaded && !adminEntryRefreshInProgress) {
    adminEntryRefreshInProgress = true;
    try {
      await syncFromSupabase();
      adminEntryDataLoaded = true;
    } finally {
      adminEntryRefreshInProgress = false;
    }
  }
  startAdminRealtimeSubscriptions();
  renderAdminModerationContent();
}

function renderAdminModerationContent() {
  var ownerPhones = {};
  DB.listings.forEach(function(l) {
    var p = normalizePhoneDigits(l.phone);
    if (p) ownerPhones[p] = true;
    if (l.ownerUid) ownerPhones[l.ownerUid.toUpperCase().trim()] = true;
  });

  var totalOwnersCount = 0;
  var totalUsersCount = 0;

  DB.profiles.forEach(function(prof) {
    var p = normalizePhoneDigits(prof.phone);
    var u = String(prof.uid || '').toUpperCase().trim();
    if (ownerPhones[p] || ownerPhones[u]) {
      totalOwnersCount++;
    } else {
      totalUsersCount++;
    }
  });

  var statOwners = document.getElementById('adminStatOwners');
  var statUsers = document.getElementById('adminStatUsers');
  var statActive = document.getElementById('adminStatActive');

  if (statOwners) statOwners.innerText = totalOwnersCount;
  if (statUsers) statUsers.innerText = totalUsersCount;
  if (statActive) statActive.innerText = DB.listings.length;
  var insightTotalUsers = document.getElementById('adminInsightTotalUsers');
  var insightOwners = document.getElementById('adminInsightOwners');
  var insightRenters = document.getElementById('adminInsightRenters');
  var insightProfiles = document.getElementById('adminInsightProfiles');
  if (insightTotalUsers) insightTotalUsers.innerText = DB.profiles.length;
  if (insightOwners) insightOwners.innerText = totalOwnersCount;
  if (insightRenters) insightRenters.innerText = totalUsersCount;
  if (insightProfiles) insightProfiles.innerText = DB.profiles.length;
  var confirmedCount = DB.bookings.filter(function(b){ return b.status === 'confirmed'; }).length;
  var pendingCount = DB.bookings.filter(function(b){ return b.status === 'pending' || b.status === 'owner_accepted' || b.status === 'cancel_pending'; }).length;
  var rejectedCount = DB.bookings.filter(function(b){ return b.status === 'rejected'; }).length;
  var confirmedRoomIds = DB.bookings.filter(function(b){ return b.status === 'confirmed'; }).map(function(b){ return b.listingId; });
  var availableCount = DB.listings.filter(function(l){ return l.status === 'available' && l.daysLeft > 0 && confirmedRoomIds.indexOf(l.id) === -1; }).length;
  var statAvailable = document.getElementById('adminStatAvailable');
  var statPending = document.getElementById('adminStatPending');
  var statConfirmed = document.getElementById('adminStatConfirmed');
  if (statAvailable) statAvailable.innerText = availableCount;
  if (statPending) statPending.innerText = pendingCount;
  var pendingInline = document.getElementById('adminStatPendingInline');
  if (pendingInline) pendingInline.innerText = pendingCount;
  if (statConfirmed) statConfirmed.innerText = confirmedCount;
  var insightValues = {
    adminInsightAvailable: availableCount,
    adminInsightListings: DB.listings.length,
    adminInsightPending: pendingCount,
    adminInsightConfirmed: confirmedCount,
    adminInsightOwnersTotal: totalOwnersCount,
    adminInsightActiveListings: availableCount,
    adminInsightInactiveListings: Math.max(0, DB.listings.length - availableCount),
    adminInsightTotalBookings: DB.bookings.length
  };
  Object.keys(insightValues).forEach(function(id) {
    var node = document.getElementById(id);
    if (node) node.innerText = insightValues[id];
  });

  renderAdminDashboardMetrics();
  renderCurrentAdminSubTab();
  renderAdminReportedListings();
  var countrySection = document.getElementById('adminCountriesSection');
  if (countrySection && countrySection.style.display !== 'none') {
    var countryListings = document.getElementById('adminCountryListings');
    var countryUsers = document.getElementById('adminCountryUsers');
    if (countryListings) countryListings.innerHTML = adminDashboardCountryRows(DB.listings || [], 'country');
    if (countryUsers) countryUsers.innerHTML = adminDashboardCountryRows(DB.profiles || [], 'country_code');
  }
  var securitySection = document.getElementById('adminSecuritySection');
  if (securitySection && securitySection.style.display !== 'none') renderAdminSecurityAlerts();
  var ratingsSection = document.getElementById('adminRatingsSection');
  if (ratingsSection && ratingsSection.style.display !== 'none') renderAdminRatingsFeed();
  var activitySection = document.getElementById('adminActivitySection');
  if (activitySection && activitySection.style.display !== 'none') renderAdminActivityFeed('activity');
  var notificationsSection = document.getElementById('adminNotificationsSection');
  if (notificationsSection && notificationsSection.style.display !== 'none') renderAdminActivityFeed('notifications');
}

function renderAdminOwnersSection(query) {
  var container = document.getElementById('adminOwnersListContainer');
  if (!container) return;
  var q = String(query || '').toLowerCase().trim();
  var ownerMap = Object.create(null);
  var listings = Array.isArray(DB.listings) ? DB.listings : [];
  var bookings = Array.isArray(DB.bookings) ? DB.bookings : [];
  var profiles = Array.isArray(DB.profiles) ? DB.profiles : [];

  // Build owner records from authenticated admin data and group every listing by owner.
  profiles.forEach(function(p) {
    if (String(p.role || '').toLowerCase() !== 'owner') return;
    var key = String(p.uid || p.phone || p.id || '');
    if (!key) return;
    ownerMap[key] = {name:p.name,phone:p.phone,uid:p.uid,gmail:p.gmail,cities:[],listings:[]};
  });
  listings.forEach(function(l) {
    var key = String(l.ownerUid || l.phone || l.ownerName || '');
    if (!key) return;
    if (!ownerMap[key]) ownerMap[key] = {name:l.ownerName,phone:l.phone,uid:l.ownerUid,gmail:l.gmail,cities:[],listings:[]};
    var o = ownerMap[key];
    if (!o.name) o.name = l.ownerName;
    if (!o.phone) o.phone = l.phone;
    if (!o.gmail) o.gmail = l.gmail;
    if (l.city && o.cities.indexOf(l.city) === -1) o.cities.push(l.city);
    o.listings.push(l);
  });

  var list = Object.values(ownerMap).filter(function(o) {
    var listingText = o.listings.map(function(l){return [l.houseName,l.city,l.state,l.pin,l.id].join(' ');}).join(' ');
    return !q || [o.name,o.uid,o.phone,o.gmail,o.cities.join(' '),listingText]
      .some(function(v){ return String(v || '').toLowerCase().indexOf(q) !== -1; });
  });
  if (!list.length) {
    container.textContent = 'No owner accounts or owner listings found.';
    return;
  }

  function statusLabel(status) {
    var s = String(status || 'available').toLowerCase();
    if (['confirmed','final_confirmed'].indexOf(s) !== -1) return 'Booked';
    if (s === 'booked') return 'Unavailable';
    if (['pending','owner_accepted'].indexOf(s) !== -1) return s === 'pending' ? 'Booking request pending' : 'Owner accepted · awaiting final confirmation';
    if (s === 'unavailable') return 'Unavailable';
    return 'Available';
  }
  function isFinalBooking(b) {
    return !!(b && (['confirmed','final_confirmed','booked'].indexOf(String(b.status || '').toLowerCase()) !== -1 || b.trl));
  }

  container.innerHTML = list.map(function(o) {
    var roomMarkup = o.listings.map(function(l) {
      var related = bookings.filter(function(b) {
        return String(b.listingId || '') === String(l.id || '');
      }).sort(function(a,b){return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));});
      var latest = related[0] || null;
      var finalBooking = related.find(isFinalBooking) || null;
      var roomStatus = finalBooking ? 'Booked' : (latest ? statusLabel(latest.status) : statusLabel(l.status));
      var safeListingId = safeInlineToken(l.id);
      var safeOwnerUid = safeInlineToken(o.uid || l.ownerUid);
      var bookingMarkup = '';
      if (finalBooking) {
        bookingMarkup = '<div class="ra-admin-record-meta"><b>Booked by:</b> ' + cleanText(finalBooking.userName || 'Name not recorded') +
          ' · User ID: ' + cleanText(finalBooking.userUid || '—') + '</div>' +
          '<div class="ra-admin-record-meta"><b>Contact:</b> ' + cleanText(finalBooking.userPhone || '—') +
          (finalBooking.userGmail ? ' · ' + cleanText(finalBooking.userGmail) : '') + '</div>' +
          '<div class="ra-admin-record-meta"><b>TRL:</b> ' + cleanText(finalBooking.trl || 'Not issued') +
          ' · Confirmed: ' + cleanText(finalBooking.trlIssuedAt || finalBooking.createdAt || 'Date not recorded') + '</div>' +
          '<div class="ra-admin-record-meta"><b>Booking:</b> ' + cleanText(finalBooking.status || 'confirmed') +
          ' · Check-in: ' + cleanText(finalBooking.date || 'Not set') + '</div>';
      } else if (latest) {
        bookingMarkup = '<div class="ra-admin-record-meta"><b>Booking activity:</b> ' + cleanText(statusLabel(latest.status)) +
          ' · Personal details hidden until final confirmation</div>';
      } else {
        bookingMarkup = '<div class="ra-admin-record-meta">No booking record found.</div>';
      }
      return '<section style="margin-top:9px;padding:9px;border:1px solid #e2e8f0;border-radius:9px;background:#f8fafc;">' +
        '<div class="ra-admin-record-head"><b>' + cleanText(l.houseName || 'Room listing') + '</b><span>' + cleanText(roomStatus) + '</span></div>' +
        '<div class="ra-admin-record-meta">Listing ID: ' + cleanText(l.id || '—') + ' · ' + cleanText(l.roomType || 'Room type not recorded') + '</div>' +
        '<div class="ra-admin-record-meta">Location: ' + cleanText([l.city,l.state,l.pin].filter(Boolean).join(', ') || 'Not recorded') + '</div>' +
        '<div class="ra-admin-record-meta">Rent: ' + cleanText(l.rent ? String(l.rent) : 'Not recorded') + ' · Deposit: ' + cleanText(l.deposit ? String(l.deposit) : 'Not recorded') + '</div>' +
        bookingMarkup +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:9px;">' +
        (safeListingId ? '<button type="button" style="border:1px solid #3b8c76;border-radius:8px;padding:7px 9px;background:#173b39;color:#9ce8cf;font-size:9px;font-weight:800;" onclick="adminSetListingStatus(\'' + safeListingId + '\',\'' + (String(l.status || '').toLowerCase() === 'booked' ? 'available' : 'booked') + '\')">' + (String(l.status || '').toLowerCase() === 'booked' ? 'Make available' : 'Mark unavailable') + '</button>' : '') +
        (safeListingId ? '<button type="button" style="border:1px solid #854545;border-radius:8px;padding:7px 9px;background:#42262b;color:#ffc1bb;font-size:9px;font-weight:800;" onclick="adminDeleteListing(\'' + safeListingId + '\')">Delete listing</button>' : '') +
        '</div></section>';
    }).join('');
    return '<article class="ra-admin-record">' +
      '<div class="ra-admin-record-head"><b>' + cleanText(o.name || 'Owner account') + '</b><span>' + o.listings.length + ' listing(s)</span></div>' +
      '<div class="ra-admin-record-meta">Owner ID: ' + cleanText(o.uid || '—') + ' · ' + cleanText(o.phone || '—') + (o.gmail ? ' · ' + cleanText(o.gmail) : '') + '</div>' +
      '<div class="ra-admin-record-meta">Cities: ' + cleanText(o.cities.join(', ') || 'No published room yet') + '</div>' +
      (roomMarkup || '<div class="ra-admin-record-meta">This owner has not published a room yet.</div>') +
      (o.uid ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;"><button type="button" style="border:1px solid #3b8c76;border-radius:8px;padding:7px 10px;background:#173b39;color:#9ce8cf;font-size:10px;font-weight:800;" onclick="adminOpenUserAccount(\'' + safeInlineToken(o.uid) + '\')">Manage owner account</button><button type="button" style="border:1px solid #854545;border-radius:8px;padding:7px 10px;background:#42262b;color:#ffc1bb;font-size:10px;font-weight:800;" onclick="adminModerateUser(\'' + safeInlineToken(o.uid) + '\',\'block\')">Block owner</button></div>' : '') +
    '</article>';
  }).join('');
}
function renderAdminBookingsSection(query) {
  var container=document.getElementById('adminBookingsListContainer');
  if(!container)return;
  var q=String(query||'').toLowerCase().trim(), filter=window.adminBookingFilter||'';
  var all=Array.isArray(DB.bookings)?DB.bookings:[];
  var list=all.filter(function(b){
    var s=String(b.status||'').toLowerCase();
    if(filter==='pending'&&s!=='pending')return false;
    if(filter==='accepted'&&s!=='owner_accepted')return false;
    if(filter==='rejected'&&s!=='rejected')return false;
    if(filter==='cancelled'&&s!=='cancelled')return false;
    if(filter==='confirmed'&&!['confirmed','final_confirmed','booked'].includes(s))return false;
    if(filter==='trl'&&!b.trl)return false;
    return !q||[b.id,b.bookingId,b.trl,b.houseName,b.roomCity,b.roomState,b.roomPin,b.userName,b.userUid,b.ownerName,b.status].some(function(v){return String(v||'').toLowerCase().indexOf(q)!==-1;});
  }).slice().sort(function(x,y){return String(y.createdAt||'').localeCompare(String(x.createdAt||''));});
  var filters=[['all','All',all.length],['pending','Pending',all.filter(function(b){return b.status==='pending';}).length],['accepted','Accepted',all.filter(function(b){return b.status==='owner_accepted';}).length],['rejected','Rejected',all.filter(function(b){return b.status==='rejected';}).length],['cancelled','Cancelled',all.filter(function(b){return b.status==='cancelled';}).length],['confirmed','Confirmed',all.filter(function(b){return ['confirmed','final_confirmed','booked'].includes(String(b.status||'').toLowerCase());}).length]];
  var bar='<div class="ra-request-toolbar"><div class="ra-request-filters">'+filters.map(function(x){return '<button type="button" class="ra-filter-chip '+(filter===x[0]?'active':'')+'" onclick="adminQuickOpen(\''+x[0]+'\')">'+x[1]+' <b>'+x[2]+'</b></button>';}).join('')+'</div><button type="button" class="ra-export-btn" onclick="exportAdminBookingsCsv()">Export CSV</button></div>';
  if(!list.length){container.innerHTML=bar+'<div class="ra-table-empty">No booking requests found.</div>';return;}
  var rows=list.map(function(b,i){
    var s=String(b.status||'pending').toLowerCase(), cls=s==='confirmed'?'approved':s==='rejected'||s==='cancelled'?'rejected':s==='owner_accepted'?'accepted':'pending';
    var id=b.id||b.bookingId||b.trl||('REQ-'+String(i+1).padStart(3,'0'));
    var room=b.houseName||b.roomType||'Room booking', customer=b.userName||'Customer', owner=b.ownerName||'Owner';
    var detail=[b.trl?'TRL: '+b.trl:'',b.roomType||'',[b.roomCity,b.roomState,b.roomPin].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
    var date=b.createdAt?formatBookingLocalTime(b.createdAt,b):'Not recorded';
    var rent=b.rent||b.monthlyRent||b.amount||'';
    return '<tr><td><span class="ra-request-id">'+cleanText(String(id).slice(0,22))+'</span></td><td><b>'+cleanText(customer)+'</b><small>'+cleanText(b.userUid||'')+'</small></td><td>'+cleanText(room)+'<small>'+cleanText(detail)+'</small></td><td>'+cleanText(owner)+'</td><td>'+cleanText(date)+'</td><td>'+cleanText(rent!==''?getCurrencySymbol(b.country||'')+rent:'—')+'</td><td><span class="ra-status-badge '+cls+'">'+cleanText(s.replace(/_/g,' '))+'</span></td><td><details class="ra-row-actions"><summary aria-label="More details">•••</summary><div class="ra-row-popover"><b>'+cleanText(room)+'</b><span>Customer: '+cleanText(customer)+'</span><span>Owner: '+cleanText(owner)+'</span><span>Received: '+cleanText(date)+'</span><span>'+cleanText(detail||'No extra details')+'</span></div></details></td></tr>';
  }).join('');
  container.innerHTML=bar+'<div class="ra-table-wrap"><table class="ra-requests-table"><thead><tr><th>Request ID</th><th>Customer</th><th>Room / Service</th><th>Provider</th><th>Request Date</th><th>Rent</th><th>Status</th><th>Action</th></tr></thead><tbody>'+rows+'</tbody></table></div><p class="ra-table-foot">Showing '+list.length+' of '+all.length+' requests · Private contact details are not displayed here.</p>';
}
function exportAdminBookingsCsv(){
  var rows=Array.isArray(DB.bookings)?DB.bookings:[];
  var data=[['Request ID','Customer','Customer ID','Room','Owner','Date','Rent','Status','TRL']].concat(rows.map(function(b){return [b.id||b.bookingId||'',b.userName||'',b.userUid||'',b.houseName||b.roomType||'',b.ownerName||'',b.createdAt||'',b.rent||b.monthlyRent||b.amount||'',b.status||'',b.trl||''];}));
  var csv=data.map(function(row){return row.map(function(v){return '"'+String(v==null?'':v).replace(/"/g,'""')+'"';}).join(',');}).join('\r\n');
  var url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'})),link=document.createElement('a');
  link.href=url;link.download='rehzu-booking-requests.csv';document.body.appendChild(link);link.click();link.remove();URL.revokeObjectURL(url);
}

function renderAdminUsersSection(query) {
  var container = document.getElementById('adminUsersListContainer');
  if (!container) return;
  var q = (query || '').toLowerCase().trim();

  var userMap = {};
  DB.bookings.forEach(function(b) {
    var key = b.userUid || b.userPhone || b.userName;
    if (!userMap[key]) {
      userMap[key] = {
        name: b.userName,
        phone: b.userPhone,
        uid: b.userUid,
        gmail: b.userGmail,
        bookedCities: [],
        bookings: []
      };
    }
    if (b.roomCity && userMap[key].bookedCities.indexOf(b.roomCity) === -1) userMap[key].bookedCities.push(b.roomCity);
    userMap[key].bookings.push(b.houseName + ' (' + b.roomCity + ') - ' + b.status.toUpperCase());
  });

  DB.profiles.forEach(function(p) {
    if (!userMap[p.uid]) {
      userMap[p.uid] = {
        name: p.name,
        phone: p.phone,
        uid: p.uid,
        gmail: p.gmail,
        bookedCities: ['None yet'],
        bookings: ['No bookings yet']
      };
    }
  });

  var list = Object.values(userMap).filter(function(u) {
    if (!q) return true;
    return (u.name && u.name.toLowerCase().indexOf(q) !== -1) ||
           (u.uid && u.uid.toLowerCase().indexOf(q) !== -1) ||
           (u.bookedCities.some(function(c){ return c.toLowerCase().indexOf(q) !== -1; }));
    
  });

  if (!list.length) {
    container.innerHTML = '<div style="font-size:11px; color:#64748B; padding:12px 0;">No registered users or booking records.</div>';
    return;
  }

  container.innerHTML = list.map(function(u) {
    return '<div style="background:#F8FAFC; border:1px solid #E2E8F0; border-radius:12px; padding:10px; margin-bottom:8px; font-size:11px;">' +
      '<div style="display:flex; justify-content:space-between; font-weight:800; color:#0F172A;">' +
        '<span>👤 ' + cleanText(u.name) + ' (' + cleanText(u.uid) + ')</span>' +
        '<span style="color:#044E3B; font-weight:800;">' + (u.bookings[0] === 'No bookings yet' ? '0 Bookings' : u.bookings.length + ' Booking(s)') + '</span>' +
      '</div>' +
      '<div style="color:#64748B; margin-top:2px;">📞 ' + cleanText(u.phone) + (u.gmail ? ' • ✉️ ' + cleanText(u.gmail) : '') + '</div>' +
      '<div style="margin-top:4px; padding:4px 8px; background:#ECFDF5; border-radius:8px; color:#044E3B; font-weight:700;">' +
        '📍 Booked Locations: ' + cleanText(u.bookedCities.join(', ')) +
      '</div>' +
      '<div style="font-size:10px; color:#475569; margin-top:3px;">Bookings: ' + cleanText(u.bookings.join(' • ')) + '</div>' +
    '</div>';
  }).join('');
}

async function renderAdminModerationUsers(query) {
  var container = document.getElementById('adminModerationList');
  if (!container) return;
  container.textContent = 'Loading account status…';
  try {
    var authRes = await sb.auth.getUser();
    if (authRes.error || !authRes.data || !authRes.data.user) throw new Error('Sign-in required.');
    var check = await sb.rpc('rehzu_is_admin');
    if (check.error || check.data !== true) throw new Error('Admin access required.');
    var result = await sb.rpc('rehzu_admin_moderation_list');
    if (result.error) throw result.error;
    var q = String(query || '').toLowerCase().trim();
    var users = (result.data || []).filter(function(u) {
      return !q || [u.uid,u.name,u.phone,u.gmail,u.role].some(function(v){return String(v||'').toLowerCase().includes(q);});
    });
    if (!users.length) { container.textContent = 'No matching user/owner accounts.'; return; }
    container.innerHTML = users.map(function(u) {
      var blocked = u.status === 'blocked';
      var warning = u.warning_message ? '<div style="font-size:10px;color:#92400E;margin-top:4px;">Latest warning: '+cleanText(u.warning_message)+' ('+Number(u.warning_count||0)+' warning(s))</div>' : '';
      var safeUid = safeInlineToken(u.uid);
      var actionButton = blocked
        ? '<button onclick="adminModerateUser(&quot;'+safeUid+'&quot;,&quot;unblock&quot;)" style="border:0;border-radius:8px;padding:7px 10px;background:#047857;color:white;font-weight:800;">Unblock</button>'
        : '<button onclick="adminModerateUser(&quot;'+safeUid+'&quot;,&quot;block&quot;)" style="border:0;border-radius:8px;padding:7px 10px;background:#B91C1C;color:white;font-weight:800;">Block account</button>';
      return '<div style="background:#fff;border:1px solid #E2E8F0;border-radius:11px;padding:9px;margin:7px 0;font-size:11px;">'+
        '<div style="display:flex;justify-content:space-between;gap:6px;flex-wrap:wrap;"><b>'+cleanText(u.name||'Account')+' · '+cleanText(u.uid)+'</b>'+
        '<b style="color:'+(blocked?'#B91C1C':'#047857')+'">'+(blocked?'BLOCKED':'ACTIVE')+'</b></div>'+
        '<div style="color:#64748B;margin-top:3px;">'+cleanText(u.role||'user')+' · '+cleanText(u.phone||'')+' · '+cleanText(u.gmail||'')+'</div>'+warning+
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">'+actionButton+
        '<button onclick="adminModerateUser(&quot;'+safeUid+'&quot;,&quot;warn&quot;)" style="border:0;border-radius:8px;padding:7px 10px;background:#B45309;color:white;font-weight:800;">Send warning</button></div></div>';
    }).join('');
  } catch(err) {
    container.textContent = 'Account moderation unavailable. Confirm Admin access and database migration.';
    console.warn('Admin moderation load failed:',err);
  }
}

async function adminModerateUser(uid, action) {
  if (!uid || !['block','unblock','warn'].includes(action)) return;
  var message = null;
  if (action === 'warn') {
    message = prompt('Enter warning message (3–500 characters):');
    if (message === null) return;
    message = message.trim();
    if (message.length < 3 || message.length > 500) { alert('Warning must be 3–500 characters.'); return; }
  } else if (!confirm(action === 'block' ? 'Block this account from signing in? Existing sessions may remain active.' : 'Unblock this account?')) return;
  try {
    var authRes = await sb.auth.getUser();
    if (authRes.error || !authRes.data || !authRes.data.user) throw new Error('Sign-in required.');
    var check = await sb.rpc('rehzu_is_admin');
    if (check.error || check.data !== true) throw new Error('Admin access required.');
    var result = await sb.rpc('rehzu_admin_moderate_user',{p_uid:uid,p_action:action,p_message:message});
    if (result.error || result.data !== true) throw (result.error || new Error('Action was not saved.'));
    alert(action === 'warn' ? 'Warning saved.' : action === 'block' ? 'Account blocked from future login.' : 'Account unblocked.');
    await renderAdminModerationUsers(document.getElementById('adminSearchInput')?.value || '');
  } catch(err) {
    alert(safeUserError(err, 'Moderation action failed. Please try again.'));
    console.warn('Admin moderation action failed:',err);
  }
}

async function renderAdminReportedListings(query) {
  var container = document.getElementById('adminReportedListingsControl');
  if (!container) return;
  container.textContent = 'Loading reports…';
  try {
    var authRes = await sb.auth.getUser();
    if (authRes.error || !authRes.data || !authRes.data.user) throw new Error('Sign-in required.');
    var adminCheck = await sb.rpc('rehzu_is_admin');
    if (adminCheck.error || adminCheck.data !== true) throw new Error('Admin access required.');
    var result = await sb.rpc('rehzu_admin_list_listing_reports');
    if (result.error) throw result.error;
    var q = String(query || '').toLowerCase().trim();
    var reports = (Array.isArray(result.data) ? result.data : []).filter(function(rep) {
      return !q || [rep.house_name,rep.city,rep.owner_name,rep.reason,rep.status]
        .some(function(v){ return String(v || '').toLowerCase().indexOf(q) !== -1; });
    });
    if (!reports.length) {
      container.textContent = 'No open reports. Everything looks good.';
      return;
    }
    container.innerHTML = reports.map(function(rep) {
      return '<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:8px 0; border-bottom:1px solid #FECACA; font-size:11.5px;">' +
        '<div><b>' + cleanText(rep.house_name || 'Listing') + '</b> (' + cleanText(rep.city || '') + ') • Owner: ' + cleanText(rep.owner_name || 'Unknown') +
        '<div style="margin-top:3px;"><span style="background:#fee2e2;color:#991b1b;padding:2px 6px;border-radius:6px;">' + cleanText(rep.reason) + '</span> <span style="color:#64748B;">' + cleanText(new Date(rep.created_at).toLocaleString()) + '</span></div></div>' +
        '<div style="display:flex; gap:5px; flex-shrink:0;">' +
        '<button onclick="adminReviewListingReport(\'' + safeInlineToken(rep.report_id) + '\',\'dismissed\')" style="background:#64748B;color:#fff;border:0;border-radius:8px;padding:5px 7px;font-size:9.5px;font-weight:bold;">Dismiss</button>' +
        '<button onclick="adminReviewListingReport(\'' + safeInlineToken(rep.report_id) + '\',\'resolved\')" style="background:#047857;color:#fff;border:0;border-radius:8px;padding:5px 7px;font-size:9.5px;font-weight:bold;">Resolve</button>' +
        '</div></div>';
    }).join('');
  } catch (err) {
    container.textContent = 'Reports could not be loaded. Verify admin access and try again.';
    console.warn('Admin reports loading failed:', err);
  }
}

async function adminReviewListingReport(reportId, status) {
  if (!['dismissed','resolved'].includes(status)) return;
  if (!confirm(status === 'resolved' ? 'Mark this report as resolved?' : 'Dismiss this report?')) return;
  try {
    var authRes = await sb.auth.getUser();
    if (authRes.error || !authRes.data || !authRes.data.user) throw new Error('Sign-in required.');
    var adminCheck = await sb.rpc('rehzu_is_admin');
    if (adminCheck.error || adminCheck.data !== true) throw new Error('Admin access required.');
    var result = await sb.rpc('rehzu_admin_review_listing_report', {p_report_id: reportId, p_status: status});
    if (result.error || result.data !== true) throw (result.error || new Error('Report was not updated.'));
    await renderAdminReportedListings();
  } catch (err) {
    alert('Report status could not be updated. Please verify admin access.');
    console.warn('Admin report review failed:', err);
  }
}

function filterAdminListings(query) {
  var container = document.getElementById('adminListingsControl');
  if (!container) return;
  var q = String(query || '').toLowerCase().trim();
  var filtered = (DB.listings || []).filter(function(l) {
    return !q || [l.houseName,l.city,l.state,l.country,l.ownerName,l.ownerUid,l.status]
      .some(function(v){ return String(v || '').toLowerCase().indexOf(q) !== -1; });
  });
  if (!filtered.length) {
    container.textContent = 'No matching listings found.';
    return;
  }
  container.innerHTML = filtered.map(function(r) {
    var sym = getCurrencySymbol(r.country);
    var id = safeInlineToken(r.id);
    var isAvailable = String(r.status || '').toLowerCase() === 'available';
    var nextStatus = isAvailable ? 'booked' : 'available';
    var statusAction = '<button type="button" style="border:1px solid #3b8c76;border-radius:8px;padding:7px 9px;background:#173b39;color:#9ce8cf;font-size:9px;font-weight:800;" onclick="adminSetListingStatus(\'' + id + '\',\'' + nextStatus + '\')">' + (isAvailable ? 'Mark unavailable' : 'Reopen listing') + '</button>';
    return '<article class="ra-admin-record">' +
      '<div class="ra-admin-record-head"><b>' + cleanText(r.houseName || 'Room') + '</b><span>' + cleanText(String(r.status || 'unknown').toUpperCase()) + '</span></div>' +
      '<div class="ra-admin-record-meta">' + cleanText(r.city || '') + (r.state ? ', ' + cleanText(r.state) : '') + ' · ' + cleanText(r.country || '') + '</div>' +
      '<div class="ra-admin-record-meta">Owner: ' + cleanText(r.ownerName || '—') + ' · ' + cleanText(r.ownerUid || '—') + '</div>' +
      '<div class="ra-admin-record-meta">Rent: ' + cleanText(sym + String(r.rent || 0)) + ' · Room type: ' + cleanText(r.roomType || '—') + '</div>' +
      '<div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:9px;">' + statusAction +
      '<button type="button" style="border:1px solid #854545;border-radius:8px;padding:7px 9px;background:#42262b;color:#ffc1bb;font-size:9px;font-weight:800;" onclick="adminDeleteListing(\'' + id + '\')">Delete listing</button></div>' +
    '</article>';
  }).join('');
}

async function adminOpenUserAccount(uid) {
  if (!uid) return;
  var search = document.getElementById('adminSearchInput');
  if (search) search.value = uid;
  adminControlTab('users');
}

async function adminSetListingStatus(id, status) {
  if (!id || !['available','booked'].includes(status)) return;
  var label = status === 'booked' ? 'mark this listing unavailable' : 'reopen this listing';
  if (!confirm('Admin confirmation: ' + label + '? Active booking rules will still be enforced by the database.')) return;
  try {
    var auth = await sb.auth.getUser();
    if (auth.error || !auth.data || !auth.data.user) throw new Error('Sign in again.');
    var check = await sb.rpc('rehzu_is_admin');
    if (check.error || check.data !== true) throw new Error('Administrator access required.');
    var result = await sb.rpc('rehzu_owner_set_listing_status', {p_listing_id:id,p_status:status});
    if (result.error || result.data !== true) throw (result.error || new Error('Listing status was not changed.'));
    await syncFromSupabase();
    alert(status === 'booked' ? 'Listing marked unavailable.' : 'Listing reopened.');
  } catch (err) {
    alert(safeUserError(err,'Listing status could not be changed. Check active booking requests.'));
  }
}
async function adminDeleteListing(id) {
  if (!safeInlineToken(id)) return;
  if (!confirm("Admin confirmation: Delete this listing only if it has no booking history? Permanent TRL records are protected.")) return;
  try {
    var auth = await sb.auth.getUser();
    if (auth.error || !auth.data || !auth.data.user) throw new Error('Sign in again.');
    var check = await sb.rpc('rehzu_is_admin');
    if (check.error || check.data !== true) throw new Error('Administrator access required.');
    var deleteRes = await sb.rpc('rehzu_delete_listing', { p_listing_id: id });
    if (deleteRes.error) throw deleteRes.error;
    if (deleteRes.data !== true) throw new Error('Listing was not found or could not be deleted.');
    var flaggedIds = JSON.parse(sessionStorage.getItem('rehzu_flagged_listings') || '[]');
    flaggedIds = flaggedIds.filter(function(x){ return x !== id; });
    sessionStorage.setItem('rehzu_flagged_listings', JSON.stringify(flaggedIds));
    alert("Listing deleted. Any listing with booking history is protected.");
    await syncFromSupabase();
    renderAdminModeration();
    renderAdminOwnersSection(document.getElementById('adminSearchInput')?.value || '');
  } catch(err) {
    alert(safeUserError(err, "Delete failed. Please try again."));
  }
}


// ================= REHZO 99 COMPLAINT & GRIEVANCE DESK =================
function openSupportView() {
  (async function(){try{var auth=await sb.auth.getUser();if(auth.error||!auth.data||!auth.data.user){sessionStorage.setItem('rehzu_open_support_after_login','1');alert('Please sign in to submit and track a complaint.');openProfileModal();return;}sessionStorage.removeItem('rehzu_open_support_after_login');goView('support');await loadMyRehzuComplaints();}catch(e){alert('Support desk could not be opened. Please try again.');}})();
}
function rehzuTicketCode(id){return 'REHZO 99-'+String(id||'').replace(/-/g,'').slice(0,8).toUpperCase();}
function rehzuComplaintStatusLabel(status){return({submitted:'Pending',in_review:'In Progress',resolved:'Resolved',rejected:'Rejected'})[status]||'Pending';}
async function submitRehzuComplaint(event){if(event)event.preventDefault();var form=document.getElementById('rehzuComplaintForm');if(!form)return;var msg=document.getElementById('rehzuComplaintMessage'),btn=document.getElementById('rehzuComplaintSubmit');var subject=document.getElementById('rehzuComplaintSubject').value.trim(),details=document.getElementById('rehzuComplaintDetails').value.trim();if(subject.length<5||details.length<20){if(msg)msg.textContent='Enter a subject (5+ characters) and details (20+ characters).';return;}if(btn){btn.disabled=true;btn.textContent='Submitting…';}if(msg)msg.textContent='';try{var auth=await sb.auth.getUser();if(auth.error||!auth.data||!auth.data.user)throw new Error('Sign in required.');var result=await sb.rpc('rehzu_submit_complaint',{p_category:document.getElementById('rehzuComplaintCategory').value,p_subject:subject,p_details:details,p_related_reference:document.getElementById('rehzuComplaintReference').value.trim()||null,p_contact_phone:document.getElementById('rehzuComplaintPhone').value.trim()||null,p_contact_email:document.getElementById('rehzuComplaintEmail').value.trim()||null});if(result.error)throw result.error;if(msg)msg.textContent='Complaint submitted successfully. Your Ticket ID is '+rehzuTicketCode(result.data)+'. You can track its status below.';form.reset();await loadMyRehzuComplaints();}catch(err){console.warn('REHZO 99 complaint submit failed:',err);if(msg)msg.textContent=(err&&/limit/i.test(err.message||''))?'Daily complaint limit reached. Please try again later.':'Complaint could not be submitted. Check your sign-in and try again.';}finally{if(btn){btn.disabled=false;btn.textContent='Submit Complaint Securely';}}}
async function loadMyRehzuComplaints(){var box=document.getElementById('rehzuMyComplaints');if(!box)return;box.textContent='Loading your complaints…';try{var auth=await sb.auth.getUser();if(auth.error||!auth.data||!auth.data.user)throw new Error('Sign in required.');var result=await sb.rpc('rehzu_list_my_complaints');if(result.error)throw result.error;var rows=Array.isArray(result.data)?result.data:[];if(!rows.length){box.textContent='You have not submitted any complaints yet.';return;}box.innerHTML='';rows.forEach(function(row){var card=document.createElement('article');card.style.cssText='border:1px solid #e2e8f0;border-radius:12px;padding:12px;margin:9px 0;';var title=document.createElement('b');title.textContent=row.subject||'Complaint';var meta=document.createElement('p');meta.style.cssText='font-size:11px;color:#64748B;margin:6px 0;';meta.textContent='Ticket: '+rehzuTicketCode(row.complaint_id)+' · '+row.category+' · '+new Date(row.created_at).toLocaleString();var state=document.createElement('p');state.style.cssText='font-size:12px;font-weight:800;color:#075743;margin:4px 0;';state.textContent='Status: '+rehzuComplaintStatusLabel(row.status);card.append(title,meta,state);if(row.admin_response){var reply=document.createElement('p');reply.style.cssText='font-size:12px;background:#f0faf5;padding:9px;border-radius:8px;white-space:pre-wrap;';reply.textContent='REHZO 99 response: '+row.admin_response;card.appendChild(reply);}box.appendChild(card);});}catch(err){console.warn('REHZO 99 complaint history failed:',err);box.textContent='Complaint history could not be loaded. Please sign in again and retry.';}}
async function renderAdminComplaints(){var box=document.getElementById('adminComplaintsList');if(!box)return;box.textContent='Loading complaints…';try{var auth=await sb.auth.getUser();if(auth.error||!auth.data||!auth.data.user)throw new Error('Sign in required.');var check=await sb.rpc('rehzu_is_admin');if(check.error||check.data!==true)throw new Error('Admin access required.');var result=await sb.rpc('rehzu_admin_list_complaints');if(result.error)throw result.error;var rows=Array.isArray(result.data)?result.data:[];if(!rows.length){box.textContent='No user complaints have been submitted.';return;}box.innerHTML='';rows.forEach(function(row){var card=document.createElement('article');card.style.cssText='border:1px solid #dbe5e0;border-radius:13px;padding:12px;margin:10px 0;background:#fff;';var h=document.createElement('h4');h.style.cssText='margin:0 0 5px;color:#075743;';h.textContent=row.subject+' · '+rehzuComplaintStatusLabel(row.status);var meta=document.createElement('p');meta.style.cssText='font-size:11px;color:#64748B;margin:4px 0;';meta.textContent='Ticket '+rehzuTicketCode(row.complaint_id)+' · '+row.category+' · '+new Date(row.created_at).toLocaleString()+' · User '+row.reporter_auth_id;var details=document.createElement('p');details.style.cssText='font-size:12px;white-space:pre-wrap;margin:8px 0;';details.textContent=row.details;var contact=document.createElement('p');contact.style.cssText='font-size:11px;color:#475569;margin:4px 0;';contact.textContent='Reference: '+(row.related_reference||'—')+' · Phone: '+(row.contact_phone||'—')+' · Email: '+(row.contact_email||'—');var actions=document.createElement('div');actions.style.cssText='display:flex;gap:7px;flex-wrap:wrap;margin-top:9px;';[['in_review','Mark In Review'],['resolved','Resolve'],['rejected','Close']].forEach(function(pair){var b=document.createElement('button');b.type='button';b.textContent=pair[1];b.style.cssText='border:0;border-radius:8px;padding:8px 10px;background:#075743;color:#fff;font-size:11px;font-weight:800;';b.addEventListener('click',function(){adminUpdateRehzuComplaint(row.complaint_id,pair[0]);});actions.appendChild(b);});card.append(h,meta,details,contact);if(row.admin_response){var response=document.createElement('p');response.style.cssText='font-size:12px;background:#f0faf5;padding:8px;border-radius:8px;white-space:pre-wrap;';response.textContent='Previous response: '+row.admin_response;card.appendChild(response);}card.appendChild(actions);box.appendChild(card);});}catch(err){console.warn('Admin complaint queue failed:',err);box.textContent='Complaints could not be loaded. Verify administrator access.';}}
async function adminUpdateRehzuComplaint(id,status){if(!['in_review','resolved','rejected'].includes(status))return;var response=prompt('Optional response to the user (max 2000 characters):');if(response===null)return;if(response.length>2000){alert('Response is too long.');return;}try{var auth=await sb.auth.getUser();if(auth.error||!auth.data||!auth.data.user)throw new Error();var check=await sb.rpc('rehzu_is_admin');if(check.error||check.data!==true)throw new Error();var result=await sb.rpc('rehzu_admin_update_complaint',{p_complaint_id:id,p_status:status,p_admin_response:response.trim()||null});if(result.error||result.data!==true)throw(result.error||new Error('Update failed'));await renderAdminComplaints();}catch(err){console.warn('Admin complaint update failed:',err);alert('Complaint status could not be updated.');}}


