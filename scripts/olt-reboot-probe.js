/**
 * Descubrimiento READ-ONLY de la sintaxis del comando de REBOOT en una OLT V-SOL.
 *
 * NO reinicia nada: usa la ayuda contextual `?` del CLI para listar los
 * subcomandos disponibles bajo `onu` dentro de `interface gpon 0/<port>`, y así
 * confirmar el comando real de reboot antes de fijarlo en olt-vsol.js
 * (buildRebootCmd).
 *
 * Uso (correr desde donde haya ruta a la OLT, p.ej. portal.digy.mx):
 *   node scripts/olt-reboot-probe.js --host 10.32.184.2 --user admin --pass XXXX --pon 7 [--onu 2] [--port 22] [--enable-pass XXXX]
 *
 * Salida a consola y a scripts/olt-reboot-probe-<host>-<ts>.log
 *
 * Después de correrlo: mirar qué subcomando reinicia la ONU (reboot/reset/…) y,
 * si difiere de `onu reboot <id>`, ajustar buildRebootCmd en olt-vsol.js. La
 * PRUEBA REAL del reboot debe hacerse aparte, en ventana de mantenimiento,
 * contra una ONU de prueba, verificando con `show onu state`.
 */
const fs = require('fs');
const path = require('path');
const { VsolCli, stripAnsi } = require('../olt-vsol');

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const HOST = arg('host');
const PORT = parseInt(arg('port', '22'), 10);
const USER = arg('user');
const PASS = arg('pass');
const ENABLE_PASS = arg('enable-pass', PASS);
const PON = parseInt(arg('pon', '7'), 10);
const ONU = arg('onu', '1'); // onu-id de referencia solo para la ayuda `onu <id> ?`

if (!HOST || !USER || !PASS) {
  console.error('Uso: node scripts/olt-reboot-probe.js --host <ip> --user <user> --pass <pass> --pon <n> [--onu <id>] [--port 22] [--enable-pass <pass>]');
  process.exit(1);
}

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const logFile = path.join(__dirname, `olt-reboot-probe-${HOST}-${ts}.log`);
const logStream = fs.createWriteStream(logFile);
function log(line) { process.stdout.write(line); logStream.write(line); }

/**
 * Envía una cadena cruda (típicamente terminada en `?` de ayuda, SIN Enter),
 * espera un margen de inactividad y devuelve el output limpio. Después limpia
 * la línea con Ctrl-U para no dejar comando pendiente.
 */
function collectHelp(cli, sendStr, idleMs = 1500) {
  return new Promise((resolve) => {
    cli.buffer = '';
    cli.stream.write(sendStr);
    setTimeout(() => {
      const out = stripAnsi(cli.buffer);
      cli.stream.write('\x15'); // Ctrl-U: descarta la línea actual sin ejecutar
      setTimeout(() => { cli.buffer = ''; resolve(out); }, 300);
    }, idleMs);
  });
}

(async () => {
  const cli = new VsolCli({ host: HOST, port: PORT, user: USER, pass: PASS, enablePass: ENABLE_PASS });
  try {
    log(`\n===== Conectando a ${HOST}:${PORT} como ${USER} =====\n`);
    await cli.connect();
    await cli.login();
    log(`Conectado. Entrando a interface gpon 0/${PON}\n`);
    await cli.exec(`interface gpon 0/${PON}`);

    log(`\n########## AYUDA: "onu ?" (subcomandos de onu) ##########\n`);
    log(await collectHelp(cli, 'onu ?'));

    log(`\n\n########## AYUDA: "onu ${ONU} ?" (acciones sobre una onu) ##########\n`);
    log(await collectHelp(cli, `onu ${ONU} ?`));

    // Candidatos frecuentes: reboot / reset. Pedimos ayuda de ambos por si existen.
    log(`\n\n########## AYUDA: "onu reboot ?" ##########\n`);
    log(await collectHelp(cli, 'onu reboot ?'));

    log(`\n\n########## AYUDA: "onu ${ONU} reboot ?" ##########\n`);
    log(await collectHelp(cli, `onu ${ONU} reboot ?`));

    // Referencia read-only del estado actual (útil para elegir una ONU de prueba)
    log(`\n\n########## show onu state (referencia) ##########\n`);
    try { log(await cli.exec('show onu state')); } catch (e) { log(`(no disponible: ${e.message})\n`); }

    try { await cli.exec('exit'); } catch (_) {}
    cli.close();
    log(`\n\n===== Probe terminado. Log: ${logFile} =====\n`);
    log(`\nRevisa arriba qué subcomando reinicia la ONU y ajusta buildRebootCmd en olt-vsol.js si difiere de "onu reboot <id>".\n`);
    logStream.end();
    process.exit(0);
  } catch (e) {
    log(`\n[ERROR] ${e.message}\n`);
    cli.close();
    logStream.end();
    process.exit(1);
  }
})();
