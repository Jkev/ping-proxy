/**
 * Sondeo READ-ONLY de una OLT V-SOL por SSH.
 *
 * Descubre, sin tocar configuración:
 *   - ONUs sin autorizar (`show onu auto-find`)
 *   - Estado de ONUs autorizadas (`show onu state`)
 *   - running-config (los comandos exactos con que se autorizó cada ONU:
 *     perfiles tcont/gemport/service/vlan reales de esta plaza)
 *
 * Uso:
 *   node scripts/olt-probe.js --host 10.3.1.182 --user admin --pass XXXX [--port 22] [--enable-pass XXXX]
 *   node scripts/olt-probe.js --host 10.3.1.182 --user admin --pass XXXX --cmd "show onu state"
 *
 * Toda la salida se imprime en consola y se guarda en scripts/olt-probe-<host>-<ts>.log
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const HOST = arg('host');
const PORT = parseInt(arg('port', '22'), 10);
const USER = arg('user');
const PASS = arg('pass');
const ENABLE_PASS = arg('enable-pass', PASS);
const SINGLE_CMD = arg('cmd');
const CMDS = arg('cmds'); // secuencia separada por ';' (permite entrar a contextos: "config;interface gpon 0/7;show onu state")

if (!HOST || !USER || !PASS) {
  console.error('Uso: node scripts/olt-probe.js --host <ip> --user <user> --pass <pass> [--port 22] [--enable-pass <pass>] [--cmd "show onu state"]');
  process.exit(1);
}

// Batería de comandos SOLO de lectura. Los que el firmware no reconozca
// simplemente devuelven "Unknown command" y seguimos con el siguiente.
const READONLY_COMMANDS = CMDS ? CMDS.split(';').map(s => s.trim()).filter(Boolean) : SINGLE_CMD ? [SINGLE_CMD] : [
  // desactivar paginación (candidatos según flavor del CLI)
  'terminal length 0',
  'screen-length 0 temporary',
  'no page',
  // info general
  'show system information',
  'show version',
  // ONUs sin autorizar
  'show onu auto-find',
  'show gpon onu auto-find',
  // estado de ONUs autorizadas
  'show onu state',
  // perfiles existentes (candidatos)
  'show profile line',
  'show profile srv',
  'show gpon profile line',
  'show gpon profile srv',
  'show dba-profile',
  // la verdad absoluta: cómo está configurado todo
  'show running-config',
];

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const logFile = path.join(__dirname, `olt-probe-${HOST}-${ts}.log`);
const logStream = fs.createWriteStream(logFile);

function log(line) {
  process.stdout.write(line);
  logStream.write(line);
}

const conn = new Client();

conn.on('ready', () => {
  log(`\n===== Conectado a ${HOST}:${PORT} como ${USER} =====\n`);
  conn.shell({ term: 'vt100', cols: 200, rows: 50 }, (err, stream) => {
    if (err) {
      console.error('Error abriendo shell:', err.message);
      conn.end();
      process.exit(1);
    }

    let buffer = '';
    let queue = [...READONLY_COMMANDS];
    let finished = false;

    // El prompt típico V-SOL termina en `#` (enable) o `>` (user mode).
    // También respondemos a paginación interactiva con espacio.
    const PROMPT_RE = /[\w\-()./]+[#>]\s*$/;
    const MORE_RE = /--More--|--\s*more\s*--|Press any key/i;

    let idleTimer = null;
    function scheduleNext(delay = 700) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const tail = buffer.slice(-200);
        if (MORE_RE.test(tail)) {
          stream.write(' '); // avanzar página
          return scheduleNext(500);
        }
        if (!PROMPT_RE.test(tail.trimEnd())) {
          // todavía imprime salida; esperar otro ciclo
          return scheduleNext(700);
        }
        buffer = '';
        if (queue.length === 0) {
          if (!finished) {
            finished = true;
            log('\n===== Sondeo terminado =====\n');
            stream.write('exit\n');
            setTimeout(() => conn.end(), 800);
          }
          return;
        }
        const cmd = queue.shift();
        log(`\n\n########## CMD: ${cmd} ##########\n`);
        stream.write(cmd + '\n');
        scheduleNext(900);
      }, delay);
    }

    stream.on('data', (data) => {
      const text = data.toString('utf8');
      buffer += text;
      log(text);
      scheduleNext(700);
    });

    stream.on('close', () => {
      log(`\n[stream cerrado] Log guardado en: ${logFile}\n`);
      logStream.end();
      conn.end();
      process.exit(0);
    });

    // Arranque: intentar `enable` primero (si ya está en modo enable, no estorba).
    setTimeout(() => {
      stream.write('enable\n');
      setTimeout(() => {
        // Si pidió password de enable, mandarlo; si no, se ignora como Enter.
        if (/password/i.test(buffer.slice(-100))) stream.write(ENABLE_PASS + '\n');
        scheduleNext(800);
      }, 800);
    }, 600);
  });
});

conn.on('error', (err) => {
  console.error(`Error SSH contra ${HOST}:${PORT} →`, err.message);
  process.exit(1);
});

// Algunas OLT solo aceptan keyboard-interactive: responder con el password.
conn.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
  finish(prompts.map(() => PASS));
});

conn.connect({
  host: HOST,
  port: PORT,
  username: USER,
  password: PASS,
  tryKeyboard: true,
  readyTimeout: 15000,
  // OLTs viejas: permitir algoritmos legacy (mismo set que LoginOLT, que ya
  // conectó a V-SOL con éxito)
  algorithms: {
    kex: [
      'diffie-hellman-group1-sha1',
      'diffie-hellman-group14-sha1',
      'diffie-hellman-group-exchange-sha256',
      'ecdh-sha2-nistp256',
      'ecdh-sha2-nistp384',
      'ecdh-sha2-nistp521',
    ],
    cipher: [
      'aes128-cbc', 'aes192-cbc', 'aes256-cbc', '3des-cbc',
      'aes128-ctr', 'aes192-ctr', 'aes256-ctr',
    ],
    serverHostKey: [
      'ssh-rsa', 'ssh-dss',
      'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
    ],
    hmac: ['hmac-sha1', 'hmac-sha2-256', 'hmac-sha2-512'],
  },
});
