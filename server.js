// ================================================
// SEVA YA INTERNET - MFUMO WA UVUVI GEOFENCING
// Inapokea data kutoka laptop yako via HTTP POST
// Inaonyesha dashboard kwa watu wote mtandaoni
// ================================================

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

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

// ── Arifa za SMS (HIARI) ──
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
    lat:  -4.651183,
    lon:  29.440335,
    allowedError: 0.044492 // takriban mita 500
  },
  {
    id: 'B',
    name: 'Mbeya University - Eneo Lililokatazwa',
    lat: -8.943265,
    lon: 33.417655,
    allowedError: 0.044492 // takriban mita 500
  }
];

// Eneo la "onyo" (warning) ni doa kubwa kidogo kuzunguka eneo lililokatazwa
const WARNING_MARGIN = 0.0003; // takriban mita 33 za ziada

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

function checkViolation(lat, lon) {
  for (const zone of FORBIDDEN_ZONES) {
    const radiusMeters = zone.allowedError * METERS_PER_DEGREE;
    if (distanceMeters(lat, lon, zone.lat, zone.lon) <= radiusMeters) return zone;
  }
  return null;
}

function checkWarning(lat, lon) {
  for (const zone of FORBIDDEN_ZONES) {
    const radiusMeters = (zone.allowedError + WARNING_MARGIN) * METERS_PER_DEGREE;
    if (distanceMeters(lat, lon, zone.lat, zone.lon) <= radiusMeters) return zone;
  }
  return null;
}

function processBoatData(boatId, lat, lon, rawStatus) {
  const prevStatus = boats[boatId]?.status; // hali kabla ya packet hii, kutambua "transition"
  const violation = checkViolation(lat, lon);
  const warning = !violation ? checkWarning(lat, lon) : null;
  const arduinoViolation = rawStatus && /PROHIBITED|NEEDS HELP/i.test(rawStatus);
  const status = (violation || arduinoViolation) ? 'violation' : warning ? 'warning' : 'safe';

  packetCount++;
  const record = {
    id: boatId,
    name: registeredBoats[boatId]?.name || boatId,
    lat, lon, status,
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
      // Boti inaingia ukiukaji SASA HIVI (si tayari ndani) — tuma SMS mara moja tu
      const phone = registeredBoats[boatId]?.phone;
      sendSMS(phone, `ARIFA UVUVI: Boti ${boatId} imevuka mpaka - ${record.zone || 'eneo lililokatazwa'}. Muda: ${new Date(record.time).toLocaleTimeString()}`);
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
}

// ── API ──
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Laptop yako inatuma data hapa
app.post('/api/data', (req, res) => {
  const { boat_id, lat, lon, status } = req.body;
  if (!boat_id || lat === undefined || lon === undefined) {
    return res.status(400).json({ error: 'Tuma: boat_id, lat, lon' });
  }
  if (!registeredBoats[boat_id]) {
    return res.status(403).json({ error: `Boti '${boat_id}' haijasajiliwa. Sajili kwanza kwenye dashboard.` });
  }
  processBoatData(boat_id, parseFloat(lat), parseFloat(lon), status);
  res.json({ ok: true, packet: packetCount });
});

// ── Usajili wa boti ──
app.post('/api/boats/register', (req, res) => {
  const { boat_id, name, phone } = req.body;
  if (!boat_id || !boat_id.trim()) {
    return res.status(400).json({ error: 'Tuma boat_id' });
  }
  const id = boat_id.trim();
  registeredBoats[id] = {
    id,
    name: (name && name.trim()) || id,
    phone: (phone && phone.trim()) || registeredBoats[id]?.phone || '',
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
