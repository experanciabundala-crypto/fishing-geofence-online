const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

const SERVER_URL = 'https://fishing-geofence-online-production.up.railway.app/api/data';
const SERIAL_PORT = 'COM4';
const BAUD_RATE = 9600;

let buf = { lat: null, lon: null };
let lastStatus = 'safe';
let tamperFlag = false;   // MPYA — bendera huru, haiathiri lastStatus
let needHelpFlag = false; // MPYA — bendera huru, haiathiri lastStatus
let lastPacketSize = null; // MPYA — kwa ajili ya kuonyesha kwenye dashboard
let lastRssi = null;       // MPYA — kwa ajili ya kuonyesha kwenye dashboard
let sentCount = 0;

async function sendToServer(lat, lon, status, tamper, needHelp, packetSize, rssi) {
  try {
    const res = await fetch(SERVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boat_id: 'BOAT-001', lat, lon, status, tamper, need_help: needHelp, packet_size: packetSize, rssi })
    });
    if (res.ok) {
      sentCount++;
      const extra = `${tamper ? ' | TAMPER' : ''}${needHelp ? ' | SOS' : ''}`;
      console.log(`✅ Imetumwa #${sentCount} | Lat:${lat} Lon:${lon} | ${status}${extra}`);
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

  // MPYA — kusoma "Packet size: 37 | RSSI: -53" kutoka Serial Monitor ya Arduino
  const sigMatch = line.match(/Packet size:\s*(\d+)\s*\|\s*RSSI:\s*(-?\d+)/i);
  if (sigMatch) { lastPacketSize = parseInt(sigMatch[1], 10); lastRssi = parseInt(sigMatch[2], 10); return; }

  const latMatch = line.match(/LATITUDE\s*(?:RECEIVED)?\s*:\s*([-\d.]+)/i);
  if (latMatch) { buf.lat = parseFloat(latMatch[1]); return; }

  const lonMatch = line.match(/LONGITUDE\s*(?:RECEIVED)?\s*:\s*([-\d.]+)/i);
  if (lonMatch) { buf.lon = parseFloat(lonMatch[1]); }

  if (/PROHIBITED|NEEDS HELP/i.test(line)) lastStatus = 'violation';
  else if (/SAFE/i.test(line)) lastStatus = 'safe';

  // MPYA — hazibadilishi kabisa lastStatus wala mtiririko wa juu, ni flags za ziada tu
  if (/TAMPER/i.test(line)) tamperFlag = true;
  if (/NEEDS HELP/i.test(line)) needHelpFlag = true;

  if (buf.lat !== null && buf.lon !== null) {
    sendToServer(buf.lat, buf.lon, lastStatus, tamperFlag, needHelpFlag, lastPacketSize, lastRssi);
    buf = { lat: null, lon: null };
    lastStatus = 'safe';
    tamperFlag = false;   // MPYA
    needHelpFlag = false; // MPYA
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
console.log(`║   ${SERIAL_PORT} @ ${BAUD_RATE} baud                      ║`);
console.log('╚══════════════════════════════════════════╝\n');
connect();
