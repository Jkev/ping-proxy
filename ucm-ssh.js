/**
 * Driver SSH para la CLI de mantenimiento del Grandstream UCM6510/6500.
 *
 * A diferencia de un shell Unix, el SSH del UCM (dropbear) entrega una CLI
 * restringida (prompt `UCM6500 > `) con MUY pocos comandos:
 *   config | status | upgrade | reboot | reset | format all|cfg|data | link | help | exit
 * NO hay shell, NI `asterisk -rx`, NI comandos arbitrarios. Verificado 2026-07-14.
 *
 * Este módulo expone lo seguro/útil:
 *   - ucmStatus()  → parsea `status` (versiones, memoria, uptime, red). READ-ONLY.
 *   - ucmReboot()  → manda `reboot` (⚠️ reinicia el PBX). Ver nota abajo.
 *
 * Login: la autenticación es la del SSH (usuario ADMIN de la web UI). El usuario
 * de API (`cdrapi`) NO tiene shell. Tras autenticar se cae directo al prompt,
 * sin enable/config-terminal.
 */
const { Client } = require('ssh2');

const SSH_ALGORITHMS = {
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
};

// Prompt de la CLI del UCM: "UCM6500 > " (termina en "> ").
const PROMPT_RE = />\s*$/;
// Posible confirmación de comandos peligrosos (reboot/reset): "(y/n)", "yes/no".
const CONFIRM_RE = /\(y\/n\)|\[y\/n\]|yes\/no|are you sure/i;

class UcmCli {
  constructor({ host, port = 22, user, pass }) {
    this.host = host;
    this.port = port;
    this.user = user;
    this.pass = pass;
    this.conn = null;
    this.stream = null;
    this.buffer = '';
  }

  connect(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      this.conn = conn;
      let ready = false;
      conn.on('error', (err) => reject(new Error(`SSH ${this.host}:${this.port} → ${err.message}`)));
      conn.on('close', () => { if (!ready) reject(new Error(`El UCM cerró la sesión sin autenticar (¿usuario sin acceso SSH? usa el ADMIN, no el de API)`)); });
      conn.on('keyboard-interactive', (n, i, l, prompts, finish) => finish(prompts.map(() => this.pass)));
      conn.on('ready', () => {
        ready = true;
        conn.shell({ term: 'vt100', cols: 200, rows: 50 }, (err, stream) => {
          if (err) return reject(err);
          this.stream = stream;
          stream.on('data', (d) => { this.buffer += d.toString('utf8'); });
          resolve();
        });
      });
      conn.connect({
        host: this.host,
        port: this.port,
        username: this.user,
        password: this.pass,
        tryKeyboard: true,
        readyTimeout: timeoutMs,
        algorithms: SSH_ALGORITHMS,
      });
    });
  }

  /** Espera a que el buffer termine en un patrón (prompt o confirmación). */
  waitFor(re = PROMPT_RE, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        const tail = this.buffer.replace(/\r/g, '').slice(-200).trimEnd();
        if (re.test(tail)) return resolve(this.buffer.replace(/\r/g, ''));
        if (Date.now() - started > timeoutMs) {
          return reject(new Error(`Timeout esperando la CLI del UCM (último: "${tail.slice(-100)}")`));
        }
        setTimeout(tick, 120);
      };
      tick();
    });
  }

  /** Espera el prompt inicial tras autenticar. */
  async waitBanner(timeoutMs = 12000) {
    await this.waitFor(PROMPT_RE, timeoutMs);
    this.buffer = '';
  }

  /** Ejecuta un comando y devuelve su output (sin eco ni prompt final). */
  async exec(cmd, timeoutMs = 12000) {
    this.buffer = '';
    this.stream.write(cmd + '\n');
    const out = await this.waitFor(PROMPT_RE, timeoutMs);
    const lines = out.split('\n');
    if (lines.length && lines[0].trim().endsWith(cmd.trim())) lines.shift(); // quitar eco
    if (lines.length && PROMPT_RE.test(lines[lines.length - 1])) lines.pop(); // quitar prompt final
    return lines.join('\n').trim();
  }

  close() {
    try { if (this.stream) this.stream.end('exit\n'); } catch (_) {}
    try { if (this.conn) this.conn.end(); } catch (_) {}
  }
}

/** Parsea la salida del comando `status` del UCM a un objeto. */
function parseStatus(output) {
  const clean = output.replace(/\r/g, '');
  const grab = (re) => { const m = clean.match(re); return m ? m[1].trim() : null; };
  return {
    model: grab(/Product Model:\s*(.+)/i),
    mac: grab(/MAC Address:\s*(.+)/i),
    network: {
      type: grab(/Network Type:\s*(.+)/i),
      ip: grab(/IP Address:\s*(.+)/i),
      gateway: grab(/Gateway:\s*(.+)/i),
      netmask: grab(/Netmask:\s*(.+)/i),
    },
    versions: {
      boot: grab(/Boot:\s*(.+)/i),
      core: grab(/Core:\s*(.+)/i),
      base: grab(/Base:\s*(.+)/i),
      prog: grab(/Prog:\s*(.+)/i),
    },
    memory: {
      totalKb: parseInt(grab(/MemTotal:\s*(\d+)/i) || '0', 10) || null,
      freeKb: parseInt(grab(/MemFree:\s*(\d+)/i) || '0', 10) || null,
    },
    uptime: grab(/System uptime:\s*(.+)/i),
    load: grab(/System load:\s*(.+)/i),
    raw: clean.trim(),
  };
}

/** Consulta `status` (READ-ONLY): versiones, memoria, uptime, red. */
async function ucmStatus(cfg) {
  const cli = new UcmCli(cfg);
  try {
    await cli.connect();
    await cli.waitBanner();
    const out = await cli.exec('status', 15000);
    cli.close();
    return { success: true, status: parseStatus(out) };
  } catch (e) {
    cli.close();
    return { success: false, message: e.message || 'Error consultando status del UCM' };
  }
}

/**
 * Reinicia el UCM (⚠️ DESTRUCTIVO: tira el servicio telefónico unos minutos).
 *
 * Manda `reboot` y, si el UCM pide confirmación (y/n), la responde. Como el
 * equipo se reinicia, la conexión se cae: eso se interpreta como éxito.
 *
 * ⚠️ NO verificado contra el equipo vivo (no se puede reiniciar el PBX de
 * producción para probar). El flujo de confirmación es defensivo; validar en
 * ventana de mantenimiento antes de confiar en producción.
 */
async function ucmReboot(cfg) {
  const cli = new UcmCli(cfg);
  try {
    await cli.connect();
    await cli.waitBanner();
    cli.buffer = '';
    cli.stream.write('reboot\n');
    // Esperar: o pide confirmación, o ya arrancó el reboot (cae la conexión).
    try {
      await cli.waitFor(CONFIRM_RE, 6000);
      cli.buffer = '';
      cli.stream.write('y\n'); // confirmar
    } catch (_) {
      // sin confirmación explícita: el reboot ya se disparó
    }
    // Dar un momento a que el equipo tome el comando y cierre.
    await new Promise((r) => setTimeout(r, 1500));
    cli.close();
    return { success: true, message: 'Comando de reboot enviado al UCM (la central se reiniciará; el servicio se interrumpe unos minutos)' };
  } catch (e) {
    cli.close();
    // Una caída de conexión tras mandar reboot es esperable = éxito.
    if (/closed|ECONNRESET|end|disconnect/i.test(e.message || '')) {
      return { success: true, message: 'Reboot enviado (la conexión se cerró al reiniciar el UCM)' };
    }
    return { success: false, message: e.message || 'Error enviando reboot al UCM' };
  }
}

module.exports = { UcmCli, parseStatus, ucmStatus, ucmReboot };
