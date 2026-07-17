/**
 * Sondeo READ-ONLY por SSH del Grandstream UCM6510 (dropbear en :22).
 *
 * Objetivo: descubrir SIN cambiar nada qué ofrece la shell SSH del UCM antes de
 * construir el módulo/endpoints en el ping-proxy:
 *   - ¿Es un shell completo (BusyBox/bash) o una CLI restringida?
 *   - ¿Se puede ejecutar el CLI de Asterisk (`asterisk -rx "..."`)?
 *   - Estado de almacenamiento (df/du) — relevante para el CDR muerto desde dic-2025.
 *   - Estado del CDR en Asterisk.
 *
 * TODO lo que ejecuta es de LECTURA. No reinicia, no limpia, no escribe config.
 *
 * Uso:
 *   node scripts/ucm-ssh-probe.js --host 124.114.104.101 --user <user> --pass <pass> [--port 22]
 *   node scripts/ucm-ssh-probe.js --host ... --user ... --pass ... --cmds "id;df -h"
 *
 * El reporte se escribe (síncrono) en scripts/ucm-ssh-probe-<host>-<ts>.log
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const HOST = arg('host', '124.114.104.101');
const PORT = parseInt(arg('port', '22'), 10);
const USER = arg('user');
const PASS = arg('pass');
const CMDS = arg('cmds');

if (!USER || !PASS) {
  console.error('Uso: node scripts/ucm-ssh-probe.js --host <ip> --user <user> --pass <pass> [--port 22] [--cmds "a;b;c"]');
  process.exit(1);
}

const READONLY_COMMANDS = CMDS ? CMDS.split(';').map(s => s.trim()).filter(Boolean) : [
  'help',
  'id',
  'whoami',
  'uname -a',
  'cat /etc/version 2>/dev/null || cat /etc/os-release 2>/dev/null',
  'df -h',
  'du -sh /var/log 2>/dev/null; du -sh /cdr 2>/dev/null; du -sh /var/lib/asterisk 2>/dev/null',
  'free -m 2>/dev/null || head /proc/meminfo',
  'asterisk -rx "core show version"',
  'asterisk -rx "core show uptime"',
  'asterisk -rx "cdr show status"',
  'asterisk -rx "queue show"',
  'ls -la /',
];

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const logFile = path.join(__dirname, `ucm-ssh-probe-${HOST}-${ts}.log`);

let out = '';
const log = (line) => { out += line; };
let exited = false;
function flushAndExit(code) {
  if (exited) return;
  exited = true;
  try { fs.writeFileSync(logFile, out); } catch (_) {}
  process.stdout.write(out + `\n[log: ${logFile}]\n`);
  process.exit(code);
}

process.on('unhandledRejection', () => {});
process.on('uncaughtException', (e) => { log(`\n[uncaught] ${e.message}\n`); flushAndExit(1); });

const conn = new Client();
let ready = false;

conn.on('ready', () => {
  ready = true;
  log(`\n===== Conectado a ${HOST}:${PORT} como ${USER} =====\n`);
  conn.shell({ term: 'vt100', cols: 200, rows: 50 }, (err, stream) => {
    if (err) { log(`Error abriendo shell: ${err.message}\n`); flushAndExit(1); return; }

    const queue = [...READONLY_COMMANDS];
    let finished = false;
    let idleTimer = null;

    function scheduleNext(delay = 1200) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (queue.length === 0) {
          if (!finished) {
            finished = true;
            log('\n===== Sondeo terminado =====\n');
            try { stream.write('exit\n'); } catch (_) {}
            setTimeout(() => conn.end(), 800);
          }
          return;
        }
        const cmd = queue.shift();
        log(`\n\n########## CMD: ${cmd} ##########\n`);
        stream.write(cmd + '\n');
        scheduleNext(1600);
      }, delay);
    }

    stream.on('data', (data) => { log(data.toString('utf8')); scheduleNext(1200); });
    stream.on('close', () => { log(`\n[stream cerrado]\n`); conn.end(); flushAndExit(0); });

    scheduleNext(1500);
  });
});

conn.on('error', (err) => { log(`\n[ERROR SSH ${HOST}:${PORT}] ${err.level || ''} ${err.message}\n`); flushAndExit(1); });
// Handshake OK pero la sesión se cierra SIN 'ready' = autenticación no aceptada
// (el server cerró tras el handshake). Típico de un usuario sin acceso a shell.
conn.on('close', () => {
  if (!ready) { log(`\n[ERROR] El UCM cerró la sesión tras el handshake SIN autenticar. El usuario "${USER}" no tiene acceso a shell SSH (¿usuario de API sin SSH, o SSH deshabilitado para esa cuenta?). Usa las credenciales de ADMIN.\n`); flushAndExit(1); }
});
conn.on('keyboard-interactive', (n, i, l, prompts, finish) => finish(prompts.map(() => PASS)));

conn.connect({
  host: HOST,
  port: PORT,
  username: USER,
  password: PASS,
  tryKeyboard: true,
  readyTimeout: 15000,
  algorithms: {
    kex: [
      'curve25519-sha256', 'curve25519-sha256@libssh.org',
      'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
      'diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1',
      'diffie-hellman-group-exchange-sha256',
    ],
    cipher: [
      'aes128-ctr', 'aes192-ctr', 'aes256-ctr',
      'aes128-cbc', 'aes192-cbc', 'aes256-cbc', '3des-cbc',
    ],
    serverHostKey: ['ssh-rsa', 'ssh-dss', 'ecdsa-sha2-nistp256', 'ssh-ed25519'],
    hmac: ['hmac-sha2-256', 'hmac-sha2-512', 'hmac-sha1'],
  },
});
