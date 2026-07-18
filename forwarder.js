const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

const SERVER_URL = 'https://fishing-monitor-production.up.railway.app/api/data';
const SERIAL_PORT = 'COM4';
const BAUD_RATE = 9600;
const SEND_INTERVAL_MS = 1000; // tuma usomaji mpya zaidi kila sekunde 1

let buf = { lat: null, lon: null };
let latest = null;       // usomaji wa hivi karibuni zaidi uliopokelewa
let sending = false;     // kuzuia kutuma request mbili kwa wakati mmoja
let sentCount = 0;

async function sendLatest() {
  if (sending) return;      // request nyingine bado inaendelea, ruka mzunguko huu
  if (!latest) return;      // hakuna data mpya
  const { lat, lon } = latest;
  latest = null;             // futa mara moja, ili tusirudie kutuma ile ile
  sending = true;
  try {
    const res = await fetch(SERVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boat_id: 'BOAT-001', lat, lon })
    });
    if (res.ok) {
      sentCount++;
      console.log(`✅ Imetumwa #${sentCount} | Lat:${lat} Lon:${lon}`);
    } else {
      const body = await res.text().catch(() => '');
      console.log(`⚠️  Server imekataa (HTTP ${res.status}): ${body}`);
    }
  } catch (err) {
    console.log(`❌ Haiwezi kutuma: ${err.message}`);
  } finally {
    sending = false;
  }
}

function processLine(line) {
  line = line.trim();
  if (!line) return;

  const latMatch = line.match(/LATITUDE\s*(?:RECEIVED)?\s*:\s*([-\d.]+)/i);
  if (latMatch) { buf.lat = parseFloat(latMatch[1]); return; }

  const lonMatch = line.match(/LONGITUDE\s*(?:RECEIVED)?\s*:\s*([-\d.]+)/i);
  if (lonMatch) { buf.lon = parseFloat(lonMatch[1]); }

  if (buf.lat !== null && buf.lon !== null) {
    latest = { lat: buf.lat, lon: buf.lon }; // hifadhi tu ya hivi karibuni, si kutuma mara moja
    buf = { lat: null, lon: null };
  }
}

function connect() {
  console.log(`🔌 Inaunganika na ${SERIAL_PORT}...`);
  try {
    const port = new SerialPort({
      path: SERIAL_PORT,
      baudRate: BAUD_RATE,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      rtscts: false,
      xon: false,
      xoff: false,
      hupcl: false
    });

    const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

    port.on('open', () => {
      console.log(`✅ ${SERIAL_PORT} imefunguliwa! Inapokea data...`);
    });

    parser.on('data', processLine);

    port.on('error', (err) => {
      console.log(`❌ ${err.message}`);
      setTimeout(connect, 3000);
    });

    port.on('close', () => {
      console.log('🔄 Serial imefungwa — inajaribu tena...');
      setTimeout(connect, 3000);
    });
  } catch (err) {
    console.log(`❌ ${err.message}`);
    setTimeout(connect, 3000);
  }
}

console.log('╔══════════════════════════════════════════╗');
console.log('║   FORWARDER - Laptop → Internet          ║');
console.log(`║   COM4 @ 9600 baud                      ║`);
console.log('╚══════════════════════════════════════════╝\n');

connect();
setInterval(sendLatest, SEND_INTERVAL_MS); // tuma usomaji mpya zaidi kila sekunde 1
