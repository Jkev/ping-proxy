/**
 * Driver CLI para OLTs V-SOL GPON (plataforma "gpon olt platform v1.00",
 * firmware V1.4.xR — p.ej. OLT_MECAPALAPA 10.32.184.2).
 *
 * Conecta por SSH (algoritmos legacy), entra a enable + config terminal y
 * ejecuta comandos esperando el prompt (sin sleeps fijos). Sintaxis verificada
 * contra el running-config real de producción (ver scripts/olt-probe.js):
 *
 *   interface gpon 0/X
 *     onu add <id> profile default sn <SERIAL>
 *     onu <id> desc <Nombre_Cliente>
 *     onu <id> profile line name line_VLAN1010
 *     onu <id> profile srv name srv_VLAN1010
 *
 * Comandos de lectura (en contexto interface gpon 0/X):
 *   show onu auto-find   → ONUs detectadas sin autorizar
 *   show onu info        → ONUs autorizadas (ids usados, modelo, SN)
 *   show onu state       → fase operativa (working/offline/dyinggasp)
 */

const { Client } = require('ssh2');

const SSH_ALGORITHMS = {
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
};

// Prompt del CLI: "OLT_NOMBRE# ", "OLT_NOMBRE(config)# ", "OLT_NOMBRE(config-pon-0/7)# " o "OLT_NOMBRE> "
const PROMPT_RE = /[\w.\-]+(\([\w\-\/]+\))?[#>]\s*$/;
const MORE_RE = /--More--|--\s*more\s*--|Press any key/i;

/**
 * Limpia secuencias ANSI del output del CLI. La OLT alinea columnas con
 * "cursor forward" (ESC[NNC) — se convierte a espacios para poder parsear.
 */
function stripAnsi(text) {
  return text
    .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Math.min(parseInt(n, 10), 80)))
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\r/g, '');
}

class VsolCli {
  constructor({ host, port = 22, user, pass, enablePass }) {
    this.host = host;
    this.port = port;
    this.user = user;
    this.pass = pass;
    this.enablePass = enablePass || pass;
    this.conn = null;
    this.stream = null;
    this.buffer = '';
  }

  connect(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      this.conn = conn;
      const onError = (err) => reject(new Error(`SSH ${this.host}:${this.port} → ${err.message}`));
      conn.on('error', onError);
      conn.on('keyboard-interactive', (n, i, l, prompts, finish) => finish(prompts.map(() => this.pass)));
      conn.on('ready', () => {
        conn.shell({ term: 'vt100', cols: 250, rows: 100 }, (err, stream) => {
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

  /** Espera hasta que el buffer termine en prompt (o en un patrón dado). */
  waitFor(re = PROMPT_RE, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        const clean = stripAnsi(this.buffer);
        const tail = clean.slice(-300).trimEnd();
        if (MORE_RE.test(tail)) {
          this.stream.write(' '); // avanzar paginación
        } else if (re.test(tail)) {
          return resolve(clean);
        }
        if (Date.now() - started > timeoutMs) {
          return reject(new Error(`Timeout esperando prompt de la OLT (último output: "${tail.slice(-120)}")`));
        }
        setTimeout(tick, 120);
      };
      tick();
    });
  }

  /** Ejecuta un comando y devuelve su output (sin el eco ni el prompt final). */
  async exec(cmd, timeoutMs = 12000) {
    this.buffer = '';
    this.stream.write(cmd + '\n');
    const out = await this.waitFor(PROMPT_RE, timeoutMs);
    const lines = out.split('\n');
    // quitar eco del comando (primera línea) y prompt final (última línea)
    if (lines.length && lines[0].trim().endsWith(cmd.trim())) lines.shift();
    if (lines.length && PROMPT_RE.test(lines[lines.length - 1].trim())) lines.pop();
    const body = lines.join('\n');
    if (/%\s*Unknown command/i.test(body)) throw new Error(`La OLT no reconoce el comando: "${cmd}"`);
    if (/%\s*Command incomplete/i.test(body)) throw new Error(`Comando incompleto: "${cmd}"`);
    return body;
  }

  /** Login completo: espera banner, entra a enable y config terminal. */
  async login() {
    await this.waitFor(/[#>]\s*$/, 15000);
    this.buffer = '';
    this.stream.write('enable\n');
    // puede pedir Password: o pasar directo a '#'
    await this.waitFor(/(password\s*:\s*|#\s*)$/i, 8000);
    if (/password\s*:\s*$/i.test(stripAnsi(this.buffer).trimEnd())) {
      this.buffer = '';
      this.stream.write(this.enablePass + '\n');
      await this.waitFor(/#\s*$/, 8000);
    }
    await this.exec('config terminal');
  }

  close() {
    try { if (this.stream) this.stream.end('exit\n'); } catch (_) {}
    try { if (this.conn) this.conn.end(); } catch (_) {}
  }
}

// ==================== PARSERS ====================

// SN estilo GPON: 4 letras + 8 hex (HWTCxxxxxxxx, GPON00700948, VSOL007e31de, MONU00296561, ZTEG...)
const SN_RE = /\b([A-Za-z]{4}[0-9a-fA-F]{8})\b/;

/** Parsea "show onu auto-find": ONUs detectadas sin autorizar en el puerto. */
function parseAutoFind(output, ponPort) {
  const onus = [];
  for (const line of output.split('\n')) {
    const sn = line.match(SN_RE);
    if (!sn) continue;
    if (/serial\s*number/i.test(line)) continue; // header
    onus.push({ ponPort, sn: sn[1], raw: line.trim() });
  }
  return onus;
}

/** Parsea "show onu info": [{ onuId, model, sn }] — ids usados del puerto. */
function parseOnuInfo(output) {
  const onus = [];
  for (const line of output.split('\n')) {
    const m = line.match(/GPON\d+\/\d+:(\d+)\s+(\S+)/i);
    if (!m) continue;
    const sn = line.match(SN_RE);
    onus.push({ onuId: parseInt(m[1], 10), model: m[2], sn: sn ? sn[1] : null });
  }
  return onus;
}

/** Parsea "show onu state": [{ onuId, adminState, omccState, phase, sn }] */
function parseOnuState(output) {
  const onus = [];
  for (const line of output.split('\n')) {
    const m = line.match(/GPON\d+\/\d+:(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/i);
    if (!m) continue;
    onus.push({
      onuId: parseInt(m[1], 10),
      adminState: m[2],
      omccState: m[3],
      phase: m[4],
      sn: m[5],
    });
  }
  return onus;
}

/** Nombre/desc seguro para el CLI: sin espacios ni caracteres raros. */
function sanitizeDesc(desc) {
  return String(desc || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // acentos
    .replace(/[^\w]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 32) || 'Sin_Nombre';
}

// ==================== OPERACIONES ====================

/**
 * Lista ONUs sin autorizar. `ponPorts` = array de puertos a revisar (1-based).
 */
async function oltAutoFind(oltCfg, ponPorts = null) {
  const ports = ponPorts && ponPorts.length ? ponPorts : Array.from({ length: oltCfg.ponCount || 16 }, (_, i) => i + 1);
  const cli = new VsolCli(oltCfg);
  try {
    await cli.connect();
    await cli.login();
    const found = [];
    for (const p of ports) {
      await cli.exec(`interface gpon 0/${p}`);
      const out = await cli.exec('show onu auto-find');
      found.push(...parseAutoFind(out, p));
      await cli.exec('exit');
    }
    cli.close();
    return { success: true, onus: found };
  } catch (e) {
    cli.close();
    return { success: false, message: e.message || 'Error en auto-find', onus: [] };
  }
}

/** Estado de las ONUs de un puerto (para verificar tras autorizar). */
async function oltOnuState(oltCfg, ponPort) {
  const cli = new VsolCli(oltCfg);
  try {
    await cli.connect();
    await cli.login();
    await cli.exec(`interface gpon 0/${ponPort}`);
    const state = parseOnuState(await cli.exec('show onu state'));
    const info = parseOnuInfo(await cli.exec('show onu info'));
    cli.close();
    const byId = new Map(info.map(o => [o.onuId, o]));
    return {
      success: true,
      onus: state.map(s => ({ ...s, model: byId.get(s.onuId)?.model || null })),
    };
  } catch (e) {
    cli.close();
    return { success: false, message: e.message || 'Error consultando estado', onus: [] };
  }
}

/**
 * Autoriza una ONU detectada en auto-find:
 *   1. Busca el primer onuId libre del puerto (show onu info)
 *   2. onu add <id> profile default sn <SN> + desc + perfiles line/srv
 *   3. Verifica que la ONU quedó en la lista (show onu info)
 *   4. Guarda la config (write / copy run start — best effort)
 */
async function oltAuthorizeOnu(oltCfg, { ponPort, sn, desc, lineProfile, srvProfile, save = true }) {
  if (!ponPort || !sn) return { success: false, message: 'Faltan ponPort y sn' };
  if (!lineProfile || !srvProfile) return { success: false, message: 'Faltan lineProfile y srvProfile' };

  const cli = new VsolCli(oltCfg);
  try {
    await cli.connect();
    await cli.login();
    await cli.exec(`interface gpon 0/${ponPort}`);

    // ¿Ya está autorizada? (idempotencia)
    const existing = parseOnuInfo(await cli.exec('show onu info'));
    const dup = existing.find(o => o.sn && o.sn.toLowerCase() === sn.toLowerCase());
    if (dup) {
      cli.close();
      return { success: true, alreadyExists: true, onuId: dup.onuId, ponPort, sn, message: `La ONU ${sn} ya estaba autorizada como GPON0/${ponPort}:${dup.onuId}` };
    }

    // primer id libre
    const used = new Set(existing.map(o => o.onuId));
    let onuId = 1;
    while (used.has(onuId)) onuId++;

    const cleanDesc = sanitizeDesc(desc);
    await cli.exec(`onu add ${onuId} profile default sn ${sn}`, 20000);
    await cli.exec(`onu ${onuId} desc ${cleanDesc}`);
    await cli.exec(`onu ${onuId} profile line name ${lineProfile}`, 20000);
    await cli.exec(`onu ${onuId} profile srv name ${srvProfile}`, 20000);

    // verificación
    const after = parseOnuInfo(await cli.exec('show onu info'));
    const added = after.find(o => o.onuId === onuId && o.sn && o.sn.toLowerCase() === sn.toLowerCase());
    if (!added) {
      cli.close();
      return { success: false, message: `Se enviaron los comandos pero la ONU ${sn} no aparece en show onu info — revisar manualmente`, onuId, ponPort };
    }

    // guardar config (candidatos según flavor; best effort, no rompe si falla)
    let saved = false;
    if (save) {
      await cli.exec('exit'); // salir del contexto pon
      for (const cmd of ['write', 'copy running-config startup-config', 'write file']) {
        try {
          await cli.exec(cmd, 30000);
          saved = true;
          break;
        } catch (_) { /* probar siguiente */ }
      }
    }

    cli.close();
    return {
      success: true,
      onuId,
      ponPort,
      sn,
      desc: cleanDesc,
      saved,
      message: `ONU ${sn} autorizada como GPON0/${ponPort}:${onuId} (${cleanDesc})${saved ? ' y config guardada' : ' — ADVERTENCIA: no se pudo guardar la config'}`,
    };
  } catch (e) {
    cli.close();
    return { success: false, message: e.message || 'Error autorizando ONU' };
  }
}

module.exports = {
  VsolCli,
  stripAnsi,
  parseAutoFind,
  parseOnuInfo,
  parseOnuState,
  sanitizeDesc,
  oltAutoFind,
  oltOnuState,
  oltAuthorizeOnu,
};
