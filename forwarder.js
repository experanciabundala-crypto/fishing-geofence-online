const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

const SERVER_URL = 'https://fishing-monitor-production.up.railway.app/api/data';
const SERIAL_PORT = 'COM4';
const BAUD_RATE = 9600;

let buf = { lat: null, lon: null };
let sentCount = 0;

async function sendToServer(lat, lon) {
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
    sendToServer(buf.lat, buf.lon); // server ndiyo itaamua status (safe/warning/violation)
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
      hupcl: false  // Hii inazuia serial kufunga haraka
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
