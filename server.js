// ================================================
// SEVA YA INTERNET - MFUMO WA UVUVI GEOFENCING
// Inapokea data kutoka laptop yako via HTTP POST
// Inaonyesha dashboard kwa watu wote mtandaoni
// ================================================

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ── WebSocket kwa dashboard ──
const clients = new Set();
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
  // Tuma data iliyopo tayari kwa mtumiaji mpya
  ws.send(JSON.stringify({ type: 'init', boats: Object.values(boats), alerts: alertsLog.slice(0,20), registered: Object.values(registeredBoats) }));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch(e) {}
    }
  });
}

// ── Hifadhi ──
const boats = {};
const alertsLog = [];
const positionLog = []; // Kila "packet" iliyowahi kupokelewa (safari NZIMA ya kila boti, si matukio tu)
const POSITION_LOG_LIMIT = 5000; // kikomo cha kumbukumbu ili server isijae
let packetCount = 0;
const startTime = new Date(); // muda mfumo ulipoanza kuwa active

// ── Usajili wa Boti ──
// Boti haitaonekana kwenye dashboard mpaka isajiliwe hapa kwanza
const registeredBoats = {};
const OFFLINE_THRESHOLD_MS = 15000; // sekunde 15 bila data = "haisomi"

// ── Arifa za Email (BURE kabisa, kwa Gmail SMTP) ──
// Ili kuwezesha: nenda Railway → Variables → ongeza:
//   EMAIL_USER = anwani yako ya gmail (mfano: mfumowauvuvi@gmail.com)
//   EMAIL_APP_PASSWORD = "App Password" ya Gmail (SI password ya kawaida ya akaunti)
// Jinsi ya kupata App Password: myaccount.google.com → Security → 2-Step Verification
// (lazima iwe imewashwa kwanza) → App Passwords → tengeneza mpya → nakili herufi 16.
// Bila hizi, mfumo utaendelea kufanya kazi kawaida — email itarukwa tu.
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_APP_PASSWORD = process.env.EMAIL_APP_PASSWORD || '';

let mailTransporter = null;
if (EMAIL_USER && EMAIL_APP_PASSWORD) {
  mailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_APP_PASSWORD }
  });
}

async function sendEmail(toEmail, subject, message) {
  if (!toEmail) return; // boti haina email iliyosajiliwa
  if (!mailTransporter) {
    console.log(`📵 Email haijatumwa (huduma haijawekwa Railway Variables) → ${toEmail}: ${subject}`);
    return;
  }
  try {
    await mailTransporter.sendMail({
      from: `"Mfumo wa Uvuvi - Geofencing" <${EMAIL_USER}>`,
      to: toEmail,
      subject,
      text: message
    });
    console.log(`📩 Email imetumwa kwa ${toEmail}`);
  } catch (err) {
    console.log(`❌ Hitilafu ya kutuma Email: ${err.message}`);
  }
}
// Tunatumia huduma ya Africa's Talking (inafanya kazi vizuri Tanzania/Afrika Mashariki).
// Ili kuwezesha: nenda Railway → Variables → ongeza AT_USERNAME na AT_API_KEY
// (unazipata baada ya kujisajili africastalking.com). Bila hizo, mfumo utaendelea
// kufanya kazi kawaida — SMS itarukwa tu na ujumbe utaonekana kwenye "Deploy Logs".
const AT_USERNAME = process.env.AT_USERNAME || '';
const AT_API_KEY = process.env.AT_API_KEY || '';
const AT_SENDER_ID = process.env.AT_SENDER_ID || ''; // hiari

async function sendSMS(phone, message) {
  if (!phone) return; // boti haina namba ya simu iliyosajiliwa
  if (!AT_USERNAME || !AT_API_KEY) {
    console.log(`📵 SMS haijatumwa (huduma ya SMS haijawekwa Railway Variables) → ${phone}: ${message}`);
    return;
  }
  try {
    const params = new URLSearchParams();
    params.append('username', AT_USERNAME);
    params.append('to', phone);
    params.append('message', message);
    if (AT_SENDER_ID) params.append('from', AT_SENDER_ID);
    const res = await fetch('https://api.africastalking.com/version1/messaging', {
      method: 'POST',
      headers: {
        apiKey: AT_API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: params
    });
    if (res.ok) console.log(`📩 SMS imetumwa kwa ${phone}`);
    else console.log(`⚠️  SMS imeshindikana (HTTP ${res.status}) kwa ${phone}`);
  } catch (err) {
    console.log(`❌ Hitilafu ya kutuma SMS: ${err.message}`);
  }
}

// ── Maeneo Yaliyokatazwa ──
// Kila eneo ni "point" + eneo dogo (radius) kuzunguka, kufanana na mantiki ya Arduino
// (targetLat, targetLon, allowedError) kwenye sketch ya LoRa Receiver
const FORBIDDEN_ZONES = [
  {
    id: 'A',
    name: 'Kasekera - Eneo Lililokatazwa',
    type: 'polygon',
    // Pointi za mpaka wa eneo la ziwa (zimepangwa kuzunguka ili kutengeneza umbo
    // sahihi lisilojichanganya). Ongeza/toa/badilisha pointi hapa kadri
    // unavyopata coordinates sahihi zaidi za mpaka wa maji.
    points: [
      [-4.964751, 29.360054],
      [-4.924290, 29.580567],
      [-4.928056, 29.600438],
      [-4.791019, 29.563467],
      [-4.445203, 29.658402],
      [-4.445203, 29.416750]
    ]
  },
  {
    id: 'B',
    name: 'Mbeya University - Eneo Lililokatazwa (Trial)',
    lat: -8.943265,
    lon: 33.417655,
    allowedError: 0.044921 // takriban mita 5000 (radius, duara kamili — trial tu, si majini)
  },
  {
    id: 'C',
    name: 'Eneo C - Lililokatazwa',
    type: 'polygon',
    points: [
      [-7.766939, 31.975949],
      [-7.862681, 32.161464],
      [-7.780456, 32.221747],
      [-7.613026, 32.034364]
    ]
  }
];

// Eneo la "onyo" (warning), kwa duara: doa kubwa kidogo kuzunguka eneo lililokatazwa.
// Kwa polygon: kuongeza pointi kidogo kutoka centroid (makadirio ya "buffer" ya nje).
const WARNING_MARGIN = 0.0003; // takriban mita 33 za ziada (kwa zones za duara)
const WARNING_MARGIN_METERS = 300; // kwa zones za polygon (ongezeko la nje)

// Umbali wa kweli (mita) kati ya pointi mbili za lat/lon, kwa kutumia mkabala
// uleule (~111320m kwa degree 1 ya latitude) unaotumika kwenye ramani (index.html),
// na kusahihisha longitude kwa cos(latitude) ili duara la ukaguzi lilingane
// KABISA na duara jekundu linaloonyeshwa kwa mtumiaji.
const METERS_PER_DEGREE = 111320;
function distanceMeters(lat1, lon1, lat2, lon2) {
  const dLat = (lat1 - lat2) * METERS_PER_DEGREE;
  const dLon = (lon1 - lon2) * METERS_PER_DEGREE * Math.cos(lat2 * Math.PI / 180);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

// Kagua kama pointi (lat,lon) iko NDANI ya polygon (ray-casting algorithm) —
// inafanya kazi kwa umbo lolote la mipaka isiyo ya kawaida (kama mpaka wa ziwa).
function pointInPolygon(lat, lon, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [lat_i, lon_i] = points[i];
    const [lat_j, lon_j] = points[j];
    const intersect =
      (lat_i > lat) !== (lat_j > lat) &&
      lon < ((lon_j - lon_i) * (lat - lat_i)) / (lat_j - lat_i) + lon_i;
    if (intersect) inside = !inside;
  }
  return inside;
}

// Tengeneza polygon "iliyopanuliwa" (buffer) kutoka centroid, kwa ajili ya eneo la onyo.
function bufferedPolygon(points, marginMeters) {
  const clat = points.reduce((s, p) => s + p[0], 0) / points.length;
  const clon = points.reduce((s, p) => s + p[1], 0) / points.length;
  return points.map(([lat, lon]) => {
    const distM = distanceMeters(lat, lon, clat, clon);
    if (distM === 0) return [lat, lon];
    const scale = (distM + marginMeters) / distM;
    return [clat + (lat - clat) * scale, clon + (lon - clon) * scale];
  });
}

// Mwelekeo (bearing, digrii) kutoka pointi 1 kwenda pointi 2. 0=Kaskazini, 90=Mashariki...
function bearingDegrees(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  const brng = Math.atan2(y, x) * 180 / Math.PI;
  return (brng + 360) % 360;
}

// Je, bearing fulani iko ndani ya (center ± spread) digrii?
function bearingWithinRange(bearing, center, spread) {
  let diff = Math.abs(bearing - center) % 360;
  if (diff > 180) diff = 360 - diff;
  return diff <= spread;
}

// Je, pointi (lat,lon) iko ndani ya "eneo" la zone (duara/sekta AU polygon)?
function withinZone(lat, lon, zone, marginMeters) {
  if (zone.type === 'polygon') {
    const poly = marginMeters > 0 ? bufferedPolygon(zone.points, marginMeters) : zone.points;
    return pointInPolygon(lat, lon, poly);
  }
  const radiusMeters = zone.allowedError * METERS_PER_DEGREE + marginMeters;
  if (distanceMeters(lat, lon, zone.lat, zone.lon) > radiusMeters) return false;
  if (zone.waterBearingCenter != null) {
    const brg = bearingDegrees(zone.lat, zone.lon, lat, lon);
    if (!bearingWithinRange(brg, zone.waterBearingCenter, zone.waterBearingSpread)) return false;
  }
  return true;
}

function checkViolation(lat, lon) {
  for (const zone of FORBIDDEN_ZONES) {
    if (withinZone(lat, lon, zone, 0)) return zone;
  }
  return null;
}

function checkWarning(lat, lon) {
  for (const zone of FORBIDDEN_ZONES) {
    const marginMeters = zone.type === 'polygon' ? WARNING_MARGIN_METERS : (WARNING_MARGIN * METERS_PER_DEGREE);
    if (withinZone(lat, lon, zone, marginMeters)) return zone;
  }
  return null;
}

function processBoatData(boatId, lat, lon, rawStatus, tamperFlag, needHelpFlag) {
  const prevStatus = boats[boatId]?.status; // hali kabla ya packet hii, kutambua "transition"
  const violation = checkViolation(lat, lon);
  const warning = !violation ? checkWarning(lat, lon) : null;
  const arduinoViolation = rawStatus && /PROHIBITED|NEEDS HELP/i.test(rawStatus);
  const status = (violation || arduinoViolation) ? 'violation' : warning ? 'warning' : 'safe';

  // MPYA — kufuatilia "transition" ya tamper/need-help kwa uhuru, bila kugusa status hapo juu
  const prevTampered = boats[boatId]?.tampered || false;
  const prevNeedHelp = boats[boatId]?.needHelp || false;

  packetCount++;
  const record = {
    id: boatId,
    name: registeredBoats[boatId]?.name || boatId,
    lat, lon, status,
    tampered: !!tamperFlag,   // MPYA
    needHelp: !!needHelpFlag, // MPYA
    zone: violation?.name || warning?.name || (arduinoViolation ? 'Eneo Lililokatazwa' : null),
    time: new Date().toISOString(),
    packet: packetCount
  };

  boats[boatId] = record;
  broadcast({ type: 'boat_update', boat: record });

  // Hifadhi kwenye "safari nzima" (positionLog) — hii ndiyo inayowezesha
  // ripoti kamili ya alipokuwa boti, si matukio ya ukiukaji tu.
  positionLog.push(record);
  if (positionLog.length > POSITION_LOG_LIMIT) positionLog.shift();

  if (status === 'violation') {
    const alert = { type:'alert', level:'danger',
      message:`🚨 ${boatId} amevuka mpaka! ${record.zone || ''}`,
      boat: record, time: record.time };
    alertsLog.unshift(alert);
    broadcast(alert);
    console.log(`🚨 UKIUKAJI! ${boatId} | Lat:${lat} Lon:${lon}`);
    if (prevStatus !== 'violation') {
      // Boti inaingia ukiukaji SASA HIVI (si tayari ndani) — tuma arifa mara moja tu
      const phone = registeredBoats[boatId]?.phone;
      const email = registeredBoats[boatId]?.email;
      const msg = `ARIFA UVUVI: Boti ${boatId} imevuka mpaka - ${record.zone || 'eneo lililokatazwa'}. Muda: ${new Date(record.time).toLocaleString()}`;
      sendSMS(phone, msg);
      sendEmail(email, `🚨 Arifa ya Ukiukaji - ${boatId}`, msg + `\n\nKuratibu: ${lat}, ${lon}`);
    }
  } else if (status === 'warning') {
    const alert = { type:'alert', level:'warning',
      message:`⚠️ ${boatId} inakaribia ${record.zone}`,
      boat: record, time: record.time };
    alertsLog.unshift(alert);
    broadcast(alert);
    console.log(`⚠️  ONYO! ${boatId} | Lat:${lat} Lon:${lon}`);
  } else {
    console.log(`✅ SALAMA | ${boatId} | Lat:${lat} Lon:${lon} | #${packetCount}`);
  }

  // ── MPYA: TAMPER — huru kabisa, haiathiri status/violation/warning hapo juu ──
  if (tamperFlag && !prevTampered) {
    const alert = { type:'alert', level:'warning',
      message:`🔧 ${boatId} - kifaa kimeguswa (tamper detected)!`,
      boat: record, time: record.time };
    alertsLog.unshift(alert);
    broadcast(alert);
    console.log(`🔧 TAMPER! ${boatId} | Lat:${lat} Lon:${lon}`);
    const phone = registeredBoats[boatId]?.phone;
    const email = registeredBoats[boatId]?.email;
    const msg = `ONYO: Kifaa cha boti ${boatId} kimeguswa/kimebadilishwa (tamper). Kuratibu: ${lat}, ${lon}. Muda: ${new Date(record.time).toLocaleString()}`;
    sendSMS(phone, msg);
    sendEmail(email, `🔧 Onyo la Tamper - ${boatId}`, msg);
  }

  // ── MPYA: NEEDS HELP / SOS — huru kabisa, haiathiri status/violation/warning hapo juu ──
  if (needHelpFlag && !prevNeedHelp) {
    const alert = { type:'alert', level:'danger',
      message:`🆘 ${boatId} INAOMBA MSAADA WA DHARURA (SOS)!`,
      boat: record, time: record.time };
    alertsLog.unshift(alert);
    broadcast(alert);
    console.log(`🆘 SOS! ${boatId} | Lat:${lat} Lon:${lon}`);
    const phone = registeredBoats[boatId]?.phone;
    const email = registeredBoats[boatId]?.email;
    const msg = `DHARURA: Boti ${boatId} imeomba MSAADA (SOS)! Kuratibu: ${lat}, ${lon}. Muda: ${new Date(record.time).toLocaleString()}`;
    sendSMS(phone, msg);
    sendEmail(email, `🆘 DHARURA - ${boatId} Inaomba Msaada`, msg);
  }
}

// ── API ──
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Laptop yako inatuma data hapa
app.post('/api/data', (req, res) => {
  const { boat_id, lat, lon, status, tamper, need_help } = req.body;
  if (!boat_id || lat === undefined || lon === undefined) {
    return res.status(400).json({ error: 'Tuma: boat_id, lat, lon' });
  }
  if (!registeredBoats[boat_id]) {
    return res.status(403).json({ error: `Boti '${boat_id}' haijasajiliwa. Sajili kwanza kwenye dashboard.` });
  }
  processBoatData(boat_id, parseFloat(lat), parseFloat(lon), status, !!tamper, !!need_help);
  res.json({ ok: true, packet: packetCount });
});

// ── Usajili wa boti ──
app.post('/api/boats/register', (req, res) => {
  const { boat_id, name, phone, email } = req.body;
  if (!boat_id || !boat_id.trim()) {
    return res.status(400).json({ error: 'Tuma boat_id' });
  }
  const id = boat_id.trim();
  registeredBoats[id] = {
    id,
    name: (name && name.trim()) || id,
    phone: (phone && phone.trim()) || registeredBoats[id]?.phone || '',
    email: (email && email.trim()) || registeredBoats[id]?.email || '',
    registeredAt: registeredBoats[id]?.registeredAt || new Date().toISOString()
  };
  // Tengeneza boti ionekane mara moja kwenye dashboard ikiwa "haisomi" mpaka ituma data
  if (!boats[id]) {
    boats[id] = { id, name: registeredBoats[id].name, lat: null, lon: null, status: 'offline', zone: null, time: null, packet: 0 };
  } else {
    boats[id].name = registeredBoats[id].name;
  }
  broadcast({ type: 'boat_update', boat: boats[id] });
  res.json({ ok: true, boat: registeredBoats[id] });
});

app.get('/api/boats/registered', (req, res) => res.json(Object.values(registeredBoats)));

app.delete('/api/boats/register/:id', (req, res) => {
  const id = req.params.id;
  delete registeredBoats[id];
  delete boats[id];
  broadcast({ type: 'boat_removed', boat_id: id });
  res.json({ ok: true });
});

app.get('/api/boats', (req, res) => res.json(Object.values(boats)));
app.get('/api/alerts', (req, res) => res.json(alertsLog.slice(0, 50)));
app.get('/api/zones', (req, res) => res.json(FORBIDDEN_ZONES));
app.get('/api/full-history', (req, res) => res.json({
  startTime: startTime.toISOString(),
  alerts: alertsLog,
  positions: positionLog,
  registered: Object.values(registeredBoats)
}));
app.get('/api/status', (req, res) => res.json({
  online: true,
  boats: Object.keys(boats).length,
  packets: packetCount,
  clients: clients.size,
  uptime: Math.floor(process.uptime()) + 's'
}));

// ── Angalia boti zilizosajiliwa lakini hazitumi data (zimekatika) ──
setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(registeredBoats)) {
    const b = boats[id];
    if (!b) continue;
    const lastSeen = b.time ? new Date(b.time).getTime() : 0;
    const isStale = (now - lastSeen) > OFFLINE_THRESHOLD_MS;
    if (isStale && b.status !== 'offline') {
      b.status = 'offline';
      broadcast({ type: 'boat_update', boat: b });
      console.log(`⚪ ${id} haisomi tena (hakuna data > 15s)`);
    }
  }
}, 5000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   MFUMO WA UVUVI - ONLINE SERVER        ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Port: ${PORT}                               ║`);
  console.log('╚══════════════════════════════════════════╝\n');
  console.log('Inasubiri data kutoka laptop...');
});
