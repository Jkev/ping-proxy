/**
 * Sondeo READ-ONLY de una OLT V-SOL por TELNET (puerto 23).
 * Mismo objetivo que olt-probe.js pero para cuando el SSH de la OLT
 * usa credenciales/banderas distintas.
 *
 * Uso:
 *   node scripts/olt-probe-telnet.js --host 10.3.1.182 --user admin --pass XXXX [--port 23] [--cmd "show onu state"]
 */
const net = require('net');
const fs = require('fs');
const path = require('path');

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const HOST = arg('host');
const PORT = parseInt(arg('port', '23'), 10);
const USER = arg('user');
const PASS = arg('pass');
const ENABLE_PASS = arg('enable-pass', PASS);
const SINGLE_CMD = arg('cmd');

if (!HOST || !USER || !PASS) {
  console.error('Uso: node scripts/olt-probe-telnet.js --host <ip> --user <u> --pass <p> [--port 23] [--cmd "..."]');
  process.exit(1);
}

const READONLY_COMMANDS = SINGLE_CMD ? [SINGLE_CMD] : [
  'terminal length 0',
  'screen-length 0 temporary',
  'no page',
  'show system information',
  'show version',
  'show onu auto-find',
  'show gpon onu auto-find',
  'show onu state',
  'show profile line',
  'show profile srv',
  'show dba-profile',
  'show running-config',
];

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const logFile = path.join(__dirname, `olt-probe-telnet-${HOST}-${ts}.log`);
const logStream = fs.createWriteStream(logFile);
function log(line) { process.stdout.write(line); logStream.write(line); }

const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;

const sock = net.createConnection({ host: HOST, port: PORT });
sock.setTimeout(20000);

let buffer = '';
let stage = 'login'; // login → password → enable → commands → done
let queue = [...READONLY_COMMANDS];
let idleTimer = null;

const PROMPT_RE = /[\w\-()./]+[#>]\s*$/;
const MORE_RE = /--More--|--\s*more\s*--|Press any key/i;

// Responde negociación telnet: rechazar todas las opciones (modo NVT plano).
function handleTelnetNegotiation(data) {
  const out = [];
  let i = 0;
  const reply = [];
  while (i < data.length) {
    if (data[i] === IAC && i + 1 < data.length) {
      const cmd = data[i + 1];
      if (cmd === DO || cmd === DONT) { reply.push(IAC, WONT, data[i + 2]); i += 3; continue; }
      if (cmd === WILL || cmd === WONT) { reply.push(IAC, DONT, data[i + 2]); i += 3; continue; }
      if (cmd === SB) { // subnegociación: saltar hasta IAC SE
        let j = i + 2;
        while (j < data.length - 1 && !(data[j] === IAC && data[j + 1] === SE)) j++;
        i = j + 2; continue;
      }
      i += 2; continue;
    }
    out.push(data[i]); i++;
  }
  if (reply.length) sock.write(Buffer.from(reply));
  return Buffer.from(out).toString('utf8');
}

function send(line) { sock.write(line + '\r\n'); }

function scheduleNext(delay = 800) {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const tail = buffer.slice(-200);

    if (stage === 'login') {
      if (/(login|username|user name)\s*:?\s*$/i.test(tail.trimEnd())) {
        send(USER); stage = 'password'; buffer = '';
        return scheduleNext(800);
      }
      return scheduleNext(800);
    }
    if (stage === 'password') {
      if (/password\s*:?\s*$/i.test(tail.trimEnd())) {
        send(PASS); stage = 'enable'; buffer = '';
        return scheduleNext(1000);
      }
      return scheduleNext(800);
    }
    if (stage === 'enable') {
      if (/password\s*:?\s*$/i.test(tail.trimEnd())) { send(ENABLE_PASS); buffer = ''; return scheduleNext(900); }
      if (PROMPT_RE.test(tail.trimEnd())) {
        if (/>\s*$/.test(tail.trimEnd())) { send('enable'); buffer = ''; return scheduleNext(900); }
        stage = 'commands'; buffer = '';
        return scheduleNext(300);
      }
      // login fallido vuelve a pedir Login:
      if (/(login|username)\s*:?\s*$/i.test(tail.trimEnd())) {
        log('\n[!] Credenciales rechazadas por telnet\n');
        sock.end(); return;
      }
      return scheduleNext(900);
    }
    if (stage === 'commands') {
      if (MORE_RE.test(tail)) { sock.write(' '); return scheduleNext(500); }
      if (!PROMPT_RE.test(tail.trimEnd())) return scheduleNext(800);
      buffer = '';
      if (queue.length === 0) {
        stage = 'done';
        log('\n===== Sondeo terminado =====\n');
        send('exit');
        setTimeout(() => sock.end(), 800);
        return;
      }
      const cmd = queue.shift();
      log(`\n\n########## CMD: ${cmd} ##########\n`);
      send(cmd);
      return scheduleNext(1000);
    }
  }, delay);
}

sock.on('connect', () => {
  log(`\n===== Telnet conectado a ${HOST}:${PORT} =====\n`);
  scheduleNext(1000);
});

sock.on('data', (data) => {
  const text = handleTelnetNegotiation(data);
  if (text) { buffer += text; log(text); }
  scheduleNext(800);
});

sock.on('timeout', () => {
  log(`\n[timeout] Sin actividad. Etapa: ${stage}. Log: ${logFile}\n`);
  sock.destroy(); process.exit(stage === 'done' ? 0 : 1);
});

sock.on('error', (err) => {
  console.error(`Error telnet contra ${HOST}:${PORT} →`, err.message);
  process.exit(1);
});

sock.on('close', () => {
  log(`\n[conexión cerrada] Log guardado en: ${logFile}\n`);
  logStream.end();
  process.exit(0);
});
