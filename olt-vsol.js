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
const net = require('net');

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

// SINTAXIS VERIFICADA 2026-07-15 contra Mecapalapa (10.32.184.2) con el probe
// read-only `scripts/olt-reboot-probe.js`: el onu-id va ANTES de `reboot`.
//   - `onu <id> ?`      lista `reboot  Reboot onu.`
//   - `onu reboot ?`    → "% There is no matched command" (el orden inverso NO existe)
//   - `onu <id> reboot ?` → "<cr> Just Press Enter to Execute command!"
// Se ejecuta dentro del contexto `interface gpon 0/<port>`. (Acepta opcionales
// `delay`/`at`/`week_day`; sin ellos, reinicia de inmediato.)
// Nota de seguridad: si la sintaxis fuera incorrecta, VsolCli.exec() lanza
// "La OLT no reconoce el comando" en vez de ejecutar algo inesperado.
const buildRebootCmd = (onuId) => `onu ${onuId} reboot`;

// --- Dialecto por tecnología de PON ---
// GPON (V-SOL V1.4.5R / V2.x): contexto `interface gpon`, estado `show onu state`,
//   reinicio `onu <id> reboot`.
// EPON (V-SOL EPON, ej. Bejucal): contexto `interface epon`, estado `show onu status`
//   (dentro del puerto), reinicio `reset onu <id>` (verificado read-only 2026-08-28).
const isEpon = (tec) => String(tec || '').toLowerCase() === 'epon';
const interfaceKw = (tec) => (isEpon(tec) ? 'epon' : 'gpon');
const stateCmd = (tec) => (isEpon(tec) ? 'show onu status' : 'show onu state');
// EPON: reinicio por ONU vía CTC OAM (`onu <id> ctc reset`, verificado <cr> 2026-08-28).
// OJO: `reset onu auth/unauth` y `deregister onu auth/unauth` son operaciones MASIVAS
// (de-autentican todo el puerto) — NO se usan para reiniciar una sola ONU.
const buildRebootCmdFor = (tec, onuId) => (isEpon(tec) ? `onu ${onuId} ctc reset` : `onu ${onuId} reboot`);

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

/**
 * Quita las lineas de eventos asincronos que algunos firmwares vuelcan a la consola
 * (ONU Online/Offline, logs con timestamp). Rompen la deteccion del prompt cuando
 * llegan justo mientras se espera: el prompt deja de ser lo ultimo del buffer.
 * Solo afecta a la deteccion; el output que se resuelve sigue completo.
 */
function stripAsyncEvents(text) {
  return String(text).split('\n')
    .filter(l => !/ONU\s+(Online|Offline)|^\s*\[?\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}/.test(l))
    .join('\n');
}

class VsolCli {
  constructor({ host, port, user, pass, enablePass, transport = 'ssh' }) {
    this.transport = transport === 'telnet' ? 'telnet' : 'ssh';
    this.host = host;
    this.port = port || (this.transport === 'telnet' ? 23 : 22);
    this.user = user;
    this.pass = pass;
    this.enablePass = enablePass || pass;
    this.conn = null;
    this.stream = null;
    this.buffer = '';
  }

  connect(timeoutMs = 15000) {
    return this.transport === 'telnet'
      ? this._connectTelnet(timeoutMs)
      : this._connectSsh(timeoutMs);
  }

  _connectSsh(timeoutMs = 15000) {
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

  /**
   * Transporte Telnet crudo (OLTs viejas sin SSH, ej. Bejucal). Un net.Socket con
   * negociación mínima IAC: rechaza todas las opciones (WONT/DONT) y limpia los
   * bytes de control antes de acumular en el buffer. El login por usuario/clave lo
   * hace después _interactiveLogin(), igual que en SSH con login interactivo.
   */
  _connectTelnet(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      this.conn = socket;
      let settled = false;
      const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
      socket.setTimeout(timeoutMs);
      socket.on('timeout', () => { socket.destroy(); done(reject, new Error(`Telnet ${this.host}:${this.port} → timeout de conexión`)); });
      socket.on('error', (err) => done(reject, new Error(`Telnet ${this.host}:${this.port} → ${err.message}`)));
      socket.on('data', (buf) => {
        const clean = this._telnetStrip(buf, socket);
        if (clean.length) this.buffer += clean.toString('utf8');
      });
      socket.connect(this.port, this.host, () => {
        socket.setTimeout(0);
        this.stream = { write: (s) => socket.write(s) };
        done(resolve);
      });
    });
  }

  /** Procesa secuencias IAC de Telnet: rechaza toda opción y devuelve el texto limpio. */
  _telnetStrip(buf, socket) {
    const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
    const out = [];
    const resp = [];
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === IAC) {
        const cmd = buf[i + 1];
        if (cmd === DO) { resp.push(IAC, WONT, buf[i + 2]); i += 2; }
        else if (cmd === WILL) { resp.push(IAC, DONT, buf[i + 2]); i += 2; }
        else if (cmd === DONT || cmd === WONT) { i += 2; }
        else if (cmd === SB) { i += 2; while (i < buf.length && !(buf[i] === IAC && buf[i + 1] === SE)) i++; i += 1; }
        else { i += 1; }
      } else {
        out.push(buf[i]);
      }
    }
    if (resp.length) { try { socket.write(Buffer.from(resp)); } catch (_) {} }
    return Buffer.from(out);
  }

  /** Espera hasta que el buffer termine en prompt (o en un patrón dado). */
  waitFor(re = PROMPT_RE, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        const clean = stripAnsi(this.buffer);
        // Quitar líneas de eventos asíncronos que algunos firmwares vuelcan a la
        // consola (ONU Online/Offline, logs con timestamp) y que rompen la detección
        // del prompt si llegan justo mientras esperamos. Solo afecta a la detección;
        // el output que se resuelve sigue completo.
        const filtered = stripAsyncEvents(clean);
        const tail = filtered.slice(-300).trimEnd();
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

  /** Ejecuta un comando ignorando si la OLT no lo reconoce (best-effort). */
  async _execSafe(cmd, timeoutMs = 6000) {
    try { return await this.exec(cmd, timeoutMs); } catch (_) { return ''; }
  }

  /**
   * Login interactivo por prompts (usuario/clave). Cubre:
   *   - Telnet (Bejucal): el servicio pide "Login:" y "Password:".
   *   - SSH con login de aplicación (Pantepec V2.x): tras la auth SSH la OLT
   *     vuelve a pedir "Login:"/"Password:" en texto.
   *   - V-SOL clásico (Mecapalapa/Otlazintla): entra directo a "[#>]" y aquí
   *     simplemente resuelve sin escribir nada.
   */
  _interactiveLogin(timeoutMs = 18000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      let sentUser = false;
      let sentPass = false;
      const tick = () => {
        // Mismo filtro que waitFor: una OLT con una ONU flapeando vuelca eventos
        // detras del prompt y el login se quedaba esperando para siempre (Tamiahua).
        const tail = stripAsyncEvents(stripAnsi(this.buffer)).slice(-200).trimEnd();
        const low = tail.toLowerCase();
        if (/[#>]\s*$/.test(tail)) return resolve();
        if (/(login incorrect|authentication failed|access denied|permission denied)/i.test(low)) {
          return reject(new Error('La OLT rechazó el usuario o la contraseña'));
        }
        if (!sentUser && /(login|username)\s*:\s*$/i.test(low)) {
          this.buffer = ''; sentUser = true; this.stream.write(this.user + '\n');
        } else if (sentUser && !sentPass && /password\s*:\s*$/i.test(low)) {
          this.buffer = ''; sentPass = true; this.stream.write(this.pass + '\n');
        }
        if (Date.now() - started > timeoutMs) {
          return reject(new Error(`Timeout en el login de la OLT (último: "${tail.slice(-100)}")`));
        }
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  /** Login completo: login interactivo (si aplica), enable y config terminal. */
  async login() {
    await this._interactiveLogin();
    // Quitar paginación para firmwares que la traen activa (ignora si no existe el comando).
    await this._execSafe('terminal length 0');
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
    try {
      if (this.transport === 'telnet') {
        if (this.conn) this.conn.destroy();
      } else {
        if (this.stream) this.stream.end('exit\n');
        if (this.conn) this.conn.end();
      }
    } catch (_) {}
  }
}

// ==================== PARSERS ====================

// SN estilo GPON: 4 de fabricante + 8 hex (HWTCxxxxxxxx, GPON00700948, VSOL007e31de, MONU00296561, ZTEG...).
// El fabricante puede llevar digitos (`V25092679417` = V250 + 92679417): exigir 4
// LETRAS hacia que el auto-find descartara esos modems y devolviera 0 en silencio.
const SN_RE = /\b([A-Za-z][A-Za-z0-9]{3}[0-9a-fA-F]{8})\b/;

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
/**
 * Total de ONUs que la propia OLT declara al pie de `show onu state`.
 *
 * Sirve de checksum: si lo parseado no llega a ese total, el volcado vino
 * cortado. Pasa de verdad — la OLT se atora a media lista y vuelve al prompt
 * sola (medido en Reyixtla: ~25% de las lecturas, y las cortadas tardan 2.4s
 * contra 0.96s de una completa). Nada del cliente escribe durante el volcado,
 * así que no hay forma de evitarlo desde aquí: solo detectarlo y reintentar.
 *
 * Los tres dialectos lo imprimen distinto:
 *   V1.4.5R  "pon: 1 total: 2 working: 2"
 *   V2.x     "ONU Number: 46/53"
 *   chasis   "total-3,  logging-0,  syncMib-0,  working-3, ..."
 * Devuelve null si no se reconoce ninguno (entonces no hay checksum).
 */
function totalDeclarado(output) {
  const txt = String(output || '');
  let m = txt.match(/ONU\s+Number:\s*\d+\s*\/\s*(\d+)/i);
  if (m) return parseInt(m[1], 10);
  m = txt.match(/\bpon:\s*\d+\s+total:\s*(\d+)/i);
  if (m) return parseInt(m[1], 10);
  m = txt.match(/\btotal-(\d+)/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

function parseOnuState(output) {
  const onus = [];
  for (const line of output.split('\n')) {
    // Formato V1.4.5R (Mecapalapa/Otlazintla): "GPON0/1:1  enable enable working <sn>"
    let m = line.match(/[GE]PON\d+\/\d+:(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/i);
    if (m) {
      onus.push({ onuId: parseInt(m[1], 10), adminState: m[2], omccState: m[3], phase: m[4], sn: m[5] });
      continue;
    }
    // Formato V2.x (Pantepec): OnuIndex "marco/tarjeta/puerto:onu" y columna Channel en vez de SN.
    //   "1/1/1:1   enable   enable   working   1(GPON)"
    m = line.match(/^\s*\d+\/\d+\/\d+:(\d+)\s+(enable|disable)\s+(\S+)\s+(\S+)/i);
    if (m) {
      onus.push({ onuId: parseInt(m[1], 10), adminState: m[2], omccState: m[3], phase: m[4], sn: null });
      continue;
    }
    // Formato chasis (Díaz Mirón, CBG1601): ONU-Index es un número pelón dentro del puerto.
    //   "1   enable   enable   working   HWTC12345678"
    m = line.match(/^\s*(\d+)\s+(enable|disable)\s+(enable|disable)\s+(\S+)\s*([A-Za-z]{4}[0-9a-fA-F]{8})?/);
    if (m) {
      onus.push({ onuId: parseInt(m[1], 10), adminState: m[2], omccState: m[3], phase: m[4], sn: m[5] || null });
      continue;
    }
  }
  return onus;
}

/**
 * Estado de ONUs en OLTs EPON (`show onu status` dentro de `interface epon`):
 *   ONU-ID     Status    MAC Address        Distance ...
 *   EPON0/1:1  offline   c4:70:0b:3a:39:50  ...
 * Normaliza phase: online -> "working", offline -> "offline" (para reusar la
 * lógica de "working" del resto del código). El SN no lo lista (trae MAC).
 */
function parseOnuStateEpon(output) {
  const onus = [];
  for (const line of output.split('\n')) {
    const m = line.match(/EPON\d+\/\d+:(\d+)\s+(online|offline)\s+([0-9a-fA-F:]{17})?/);
    if (!m) continue;
    onus.push({
      onuId: parseInt(m[1], 10),
      adminState: 'enable',
      omccState: m[2] === 'online' ? 'enable' : 'disable',
      phase: m[2] === 'online' ? 'working' : 'offline',
      sn: null,
      mac: m[3] || null,
    });
  }
  return onus;
}

/** Normaliza un usuario PPPoE: quita el envoltorio `<pppoe-...>` de MikroTik. */
function cleanPppoe(user) {
  return String(user || '').replace(/^<?(pppoe-)?/, '').replace(/>$/, '').trim();
}

/**
 * Parsea `show running-config` completo → una entrada por ONU con todo lo que
 * necesitamos para ubicarla y cruzarla con MikroWisp:
 *   [{ slot, port, onuId, sn, desc, pppoeUser, pppoePwd, mode }]
 *
 * El PPPoE del cliente SOLO aparece aquí (no en show onu info/state), y solo
 * para ONUs provisionadas en modo router (con líneas `wan_adv ... pppoe`). Las
 * ONUs en modo bridge quedan con `pppoeUser: null` y `mode: 'bridge'`.
 *
 * Estructura relevante del running-config (dentro de `interface gpon 0/<port>`):
 *   onu add <id> profile default sn <SN>
 *   onu <id> desc <Nombre>
 *   onu <id> pri wan_adv index 1 route ipv4 pppoe ... user <USER> pwd <PWD> ...
 */
function parseRunningConfig(output) {
  const byKey = new Map(); // `${port}:${onuId}` → registro
  let curSlot = 0;
  let curPort = null;
  const clean = stripAnsi(output);

  const ensure = (onuId) => {
    const key = `${curPort}:${onuId}`;
    let rec = byKey.get(key);
    if (!rec) {
      rec = { slot: curSlot, port: curPort, onuId, sn: null, desc: null, pppoeUser: null, pppoePwd: null, mode: 'bridge' };
      byKey.set(key, rec);
    }
    return rec;
  };

  for (const raw of clean.split('\n')) {
    const line = raw.trim();

    const ctx = line.match(/^interface\s+[ge]pon\s+(\d+)\/(\d+)/i);
    if (ctx) { curSlot = parseInt(ctx[1], 10); curPort = parseInt(ctx[2], 10); continue; }
    if (curPort == null) continue;

    let m;
    // onu add <id> profile default sn <SN>
    if ((m = line.match(/^onu\s+add\s+(\d+)\b.*\bsn\s+([A-Za-z0-9]+)/i))) {
      ensure(parseInt(m[1], 10)).sn = m[2];
      continue;
    }
    // onu <id> desc <texto>
    if ((m = line.match(/^onu\s+(\d+)\s+desc(?:ription)?\s+(.+)$/i))) {
      ensure(parseInt(m[1], 10)).desc = m[2].trim();
      continue;
    }
    // onu <id> pri wan_adv ... pppoe ... user <USER> pwd <PWD>
    if ((m = line.match(/^onu\s+(\d+)\s+pri\s+wan_(?:adv|conn)\b.*\bpppoe\b.*\buser\s+(\S+)\s+pwd\s+(\S+)/i))) {
      const rec = ensure(parseInt(m[1], 10));
      // no pisar un PPPoE ya leido: en EPON hay varias lineas wan_conn por ONU
      if (rec.pppoeUser) continue;
      rec.pppoeUser = m[2];
      rec.pppoePwd = m[3];
      rec.mode = 'router';
      continue;
    }
  }

  return Array.from(byKey.values()).sort((a, b) => a.port - b.port || a.onuId - b.onuId);
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
  // EPON usa `interface epon` y las OLTs de chasis su slot (Díaz Mirón = 2); el
  // comando `show onu auto-find` es el mismo en los dos dialectos.
  const kw = interfaceKw(oltCfg.tec);
  const slot = parseInt(oltCfg.slot, 10) || 0;
  try {
    await cli.connect();
    await cli.login();
    const found = [];
    // Lo que la OLT imprimio y no se reconocio como ONU: si el resultado sale
    // vacio, esto dice si de verdad no hay nada o si el formato cambio.
    const sinReconocer = [];
    for (const p of ports) {
      await cli.exec(`interface ${kw} ${slot}/${p}`);
      const out = await cli.exec('show onu auto-find');
      const onus = parseAutoFind(out, p);
      found.push(...onus);
      if (!onus.length) {
        const lineas = stripAnsi(out).split('\n').map(l => l.trim()).filter(Boolean);
        if (lineas.length) sinReconocer.push({ ponPort: p, lineas: lineas.slice(0, 15) });
      }
      await cli.exec('exit');
    }
    cli.close();
    return { success: true, onus: found, ...(found.length ? {} : { sinReconocer }) };
  } catch (e) {
    cli.close();
    return { success: false, message: e.message || 'Error en auto-find', onus: [] };
  }
}

/** Estado de las ONUs de un puerto (para verificar tras autorizar). */
async function oltOnuState(oltCfg, ponPort) {
  const cli = new VsolCli(oltCfg);
  const tec = oltCfg.tec;
  const slot = parseInt(oltCfg.slot, 10) || 0; // 0 en OLTs tipo caja; >0 en chasis (ej. Díaz Mirón slot 2)
  try {
    await cli.connect();
    await cli.login();
    await cli.exec(`interface ${interfaceKw(tec)} ${slot}/${ponPort}`);
    if (isEpon(tec)) {
      const state = parseOnuStateEpon(await cli.exec('show onu status'));
      cli.close();
      return { success: true, onus: state.map(s => ({ ...s, model: null })) };
    }
    // Lectura con checksum: la OLT declara cuántas ONUs hay al pie. Si el
    // volcado vino cortado se reintenta; sin esto el panel muestra media lista
    // como si fuera la lista entera (y una ONU ausente se lee como "no existe").
    let state = [];
    let esperados = null;
    let parcial = false;
    // 5 intentos: hay OLTs que se atoran seguido (Camotipán falla 3 seguidos con
    // frecuencia). Entre intentos se le da un respiro corto — insistir de
    // inmediato sobre una OLT que acaba de ahogarse tiende a fallar otra vez.
    const INTENTOS = 5;
    for (let intento = 1; intento <= INTENTOS; intento++) {
      if (intento > 1) await new Promise(r => setTimeout(r, 400));
      const out = await cli.exec('show onu state', 20000);
      const leidas = parseOnuState(out);
      const total = totalDeclarado(out);
      if (leidas.length > state.length) { state = leidas; esperados = total; }
      // El pie solo se imprime cuando el volcado terminó: su AUSENCIA ya
      // significa que vino cortado. Tratar `null` como "sin checksum" era el
      // error — es justo el caso malo.
      if (total != null && leidas.length >= total) { parcial = false; break; }
      parcial = true;
      if (intento < INTENTOS) console.warn(`[olt] ${oltCfg.host} pon ${ponPort}: volcado cortado (${leidas.length}/${total ?? 'sin pie'}), reintento ${intento + 1}/${INTENTOS}`);
    }
    if (parcial) {
      console.warn(`[olt] ${oltCfg.host} pon ${ponPort}: sigue incompleta tras ${INTENTOS} intentos (${state.length}/${esperados})`);
    }
    // `show onu info` (modelo) no existe en todos los firmwares (ej. chasis Díaz Mirón) → best-effort.
    let info = [];
    try { info = parseOnuInfo(await cli.exec('show onu info')); } catch (_) { /* sin modelo */ }
    cli.close();
    const byId = new Map(info.map(o => [o.onuId, o]));
    return {
      success: true,
      onus: state.map(s => ({ ...s, model: byId.get(s.onuId)?.model || null })),
      // Se informan para que quien consuma pueda distinguir "el puerto tiene 27
      // ONUs" de "solo alcanzamos a leer 27 de 79". Campos extra: los clientes
      // viejos los ignoran.
      ...(esperados != null ? { esperados } : {}),
      ...(parcial ? { parcial: true } : {}),
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
  // La autorizacion EPON usa otra sintaxis que todavia no esta verificada: mejor
  // negarse que mandarle a la OLT comandos de GPON.
  if (isEpon(oltCfg.tec)) return { success: false, message: 'La autorizacion automatica en OLTs EPON aun no esta soportada' };
  const slot = parseInt(oltCfg.slot, 10) || 0;
  const pon = `GPON${slot}/${ponPort}`;

  const cli = new VsolCli(oltCfg);
  try {
    await cli.connect();
    await cli.login();
    await cli.exec(`interface gpon ${slot}/${ponPort}`);

    // ¿Ya está autorizada? (idempotencia)
    const existing = parseOnuInfo(await cli.exec('show onu info'));
    const dup = existing.find(o => o.sn && o.sn.toLowerCase() === sn.toLowerCase());
    if (dup) {
      cli.close();
      return { success: true, alreadyExists: true, onuId: dup.onuId, ponPort, sn, message: `La ONU ${sn} ya estaba autorizada como ${pon}:${dup.onuId}` };
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
      message: `ONU ${sn} autorizada como ${pon}:${onuId} (${cleanDesc})${saved ? ' y config guardada' : ' — ADVERTENCIA: no se pudo guardar la config'}`,
    };
  } catch (e) {
    cli.close();
    return { success: false, message: e.message || 'Error autorizando ONU' };
  }
}

/**
 * Lista TODAS las ONUs de la OLT con su PPPoE cruzable (una sesión SSH,
 * un solo `show running-config`). Base para el match con MikroWisp y para
 * poblar la UI / selección manual.
 */
async function oltListOnusFull(oltCfg) {
  const cli = new VsolCli(oltCfg);
  try {
    await cli.connect();
    await cli.login();
    const cfg = await cli.exec('show running-config', 45000);
    cli.close();
    return { success: true, onus: parseRunningConfig(cfg) };
  } catch (e) {
    cli.close();
    return { success: false, message: e.message || 'Error consultando running-config', onus: [] };
  }
}

/**
 * Ejecuta el reboot de una ONU concreta (contexto `interface gpon <slot>/<port>`).
 * `slot` = tarjeta (0 en OLTs tipo caja; 1..N en chasis con varias tarjetas).
 */
/**
 * Envía el comando de reinicio tolerando firmwares que, tras ejecutarlo, emiten
 * eventos asíncronos y/o cierran la sesión (ej. chasis Díaz Mirón: "Logout" +
 * "ONU Offline ..."). Conserva la salvaguarda: si la OLT dice "Unknown command"
 * NO lo da por bueno. Si no hay error y aparece evidencia de ejecución (o vence el
 * plazo sin prompt), se considera enviado.
 */
function sendRebootCmd(cli, cmd, timeoutMs = 18000) {
  return new Promise((resolve, reject) => {
    cli.buffer = '';
    cli.stream.write(cmd + '\n');
    const started = Date.now();
    const tick = () => {
      const clean = stripAnsi(cli.buffer);
      if (/%\s*Unknown command|%\s*There is no matched|Command incomplete/i.test(clean)) {
        return reject(new Error(`La OLT no reconoce el comando: "${cmd}"`));
      }
      const tail = clean.slice(-300).trimEnd();
      if (PROMPT_RE.test(tail)) return resolve(clean);                       // prompt normal (caso común)
      if (/reboot\s*OK|ONU\s*Offline|log\s*out|Logout/i.test(clean)) return resolve(clean); // ejecutó aunque cierre sesión/emita evento
      if (Date.now() - started > timeoutMs) return resolve(clean);           // enviado sin error de comando
      setTimeout(tick, 150);
    };
    tick();
  });
}

async function rebootInSession(cli, slot, port, onuId, tec) {
  await cli.exec(`interface ${interfaceKw(tec)} ${slot}/${port}`);
  const out = await sendRebootCmd(cli, buildRebootCmdFor(tec, onuId), 20000);
  let state = null;
  try {
    const raw = await cli.exec(stateCmd(tec));
    const parsed = isEpon(tec) ? parseOnuStateEpon(raw) : parseOnuState(raw);
    state = parsed.find(s => s.onuId === onuId) || null;
  } catch (_) { /* la verificación es best-effort */ }
  try { await cli.exec('exit'); } catch (_) {}
  return { cliOutput: (out || '').trim().slice(0, 300), state };
}

/**
 * Reinicia una ONU por (tarjeta, puerto, onu-id) directos. Modo usado por
 * LoginOLT, que ya conoce la ubicación de la ONU listada.
 * `slot`/tarjeta es opcional y default 0 (OLT tipo caja) por compatibilidad.
 */
async function oltRebootOnu(oltCfg, { slot = 0, port, onuId }) {
  if (port == null || onuId == null) return { success: false, message: 'Faltan port y onuId' };
  const s = parseInt(slot, 10) || 0;
  const p = parseInt(port, 10);
  const id = parseInt(onuId, 10);
  const cli = new VsolCli(oltCfg);
  try {
    await cli.connect();
    await cli.login();
    const { cliOutput, state } = await rebootInSession(cli, s, p, id, oltCfg.tec);
    cli.close();
    const tag = interfaceKw(oltCfg.tec).toUpperCase();
    return { success: true, slot: s, port: p, onuId: id, message: `Comando de reboot enviado a ${tag}${s}/${p}:${id}`, cliOutput, state };
  } catch (e) {
    cli.close();
    return { success: false, message: e.message || 'Error enviando reboot' };
  }
}

/**
 * Reinicia la ONU de un cliente cruzando su PPPoE de MikroWisp contra el
 * running-config de la OLT. Modo usado por MapaReportes-Digy.
 *
 * - 1 coincidencia exacta → reinicia (en la misma sesión SSH).
 * - 0 coincidencias → { needsSelection: true, candidates } (posible bridge o
 *   usuario distinto). NO reinicia a ciegas.
 * - >1 coincidencias → { ambiguous: true, candidates }.
 */
async function oltFindAndRebootByPppoe(oltCfg, pppUser) {
  const target = cleanPppoe(pppUser).toLowerCase();
  if (!target) return { success: false, message: 'Falta pppUser' };
  const cli = new VsolCli(oltCfg);
  try {
    await cli.connect();
    await cli.login();
    const cfg = await cli.exec('show running-config', 45000);
    const onus = parseRunningConfig(cfg);
    const matches = onus.filter(o => o.pppoeUser && o.pppoeUser.toLowerCase() === target);

    if (matches.length === 0) {
      cli.close();
      // no exponemos el pwd en los candidatos
      const candidates = onus.map(({ slot, port, onuId, sn, desc, pppoeUser, mode }) => ({ slot, port, onuId, sn, desc, pppoeUser, mode }));
      return {
        success: false,
        needsSelection: true,
        message: `No se encontró ninguna ONU con PPPoE "${target}" en la OLT. Puede estar en modo bridge (el PPPoE no es visible en la OLT) o el usuario difiere. Seleccione la ONU manualmente.`,
        candidates,
      };
    }
    if (matches.length > 1) {
      cli.close();
      const candidates = matches.map(({ slot, port, onuId, sn, desc, pppoeUser, mode }) => ({ slot, port, onuId, sn, desc, pppoeUser, mode }));
      return { success: false, ambiguous: true, message: `Se encontraron ${matches.length} ONUs con el mismo PPPoE "${target}"`, candidates };
    }

    const t = matches[0];
    const { cliOutput, state } = await rebootInSession(cli, t.slot, t.port, t.onuId, oltCfg.tec);
    cli.close();
    return {
      success: true,
      matched: { slot: t.slot, port: t.port, onuId: t.onuId, sn: t.sn, desc: t.desc, pppoeUser: t.pppoeUser, mode: t.mode },
      message: `Reboot enviado a "${target}" → GPON${t.slot}/${t.port}:${t.onuId}`,
      cliOutput,
      state,
    };
  } catch (e) {
    cli.close();
    return { success: false, message: e.message || 'Error en reboot por PPPoE' };
  }
}

// ==================== ALTA DE SERVICIO (plantillas aprendidas de la OLT) ====================
//
// La config de una ONU nueva no se inventa: se copia de lo que la propia OLT ya
// tiene. Hay dos estilos de autorizacion en el parque (perfiles `profile line/srv`
// o el bloque tcont/gemport/service/service-port/portvlan escrito por ONU) y la
// config del modem (`pri wan_adv` / `pri wifi_ssid`) se repite casi identica en
// miles de ONUs. Se normaliza cada bloque cambiando lo que es propio del cliente
// (id, SN, desc, usuario, clave, SSID, clave WiFi) por marcadores, y la plantilla
// es la forma MAS COMUN. Su frecuencia viaja en la respuesta: si la plantilla
// ganadora la tienen 9 de 10 ONUs, el generador esta bien; si la tienen 2 de 10,
// hay que mirarla antes de mandarla.

/**
 * Agrupa el running-config por ONU: { 'slot/port:onuId' → [lineas `onu ...`] }.
 * Conserva el orden en que la OLT las imprime (es el orden en que se aplicaron).
 */
function parseOnuBlocks(output) {
  const blocks = new Map();
  let curSlot = 0;
  let curPort = null;
  for (const raw of stripAnsi(output).split('\n')) {
    const line = raw.trim();
    const ctx = line.match(/^interface\s+[ge]pon\s+(\d+)\/(\d+)/i);
    if (ctx) { curSlot = parseInt(ctx[1], 10); curPort = parseInt(ctx[2], 10); continue; }
    if (/^(interface|exit)\b/i.test(line)) { curPort = null; continue; }
    if (curPort == null) continue;
    const m = line.match(/^onu\s+(?:add\s+)?(\d+)\b/i);
    if (!m) continue;
    const key = `${curSlot}/${curPort}:${parseInt(m[1], 10)}`;
    if (!blocks.has(key)) blocks.set(key, []);
    blocks.get(key).push(line);
  }
  return blocks;
}

const esLineaPri = (l) => /^onu\s+\d+\s+pri\b/i.test(l);
const esLineaDesc = (l) => /^onu\s+\d+\s+desc(?:ription)?\b/i.test(l);

/**
 * Cambia lo propio de la ONU/cliente por marcadores para poder comparar bloques.
 * El `service-port` del estilo "bloque" suele numerarse igual que la ONU: si
 * coincide con su id tambien se marca, o cada bloque quedaria distinto.
 */
function normalizarLinea(line, onuId) {
  return line
    .replace(/(\bservice-port\s+)(\d+)\b/i,(m, pre, n) => (parseInt(n, 10) === onuId ? `${pre}{ID}` : m))
    .replace(/^onu\s+add\s+\d+\b/i, 'onu add {ID}')
    .replace(/^onu\s+\d+\b/i, 'onu {ID}')
    .replace(/\bsn\s+[A-Za-z0-9]+/i, 'sn {SN}')
    .replace(/(\bpppoe\b.*\buser\s+)\S+(\s+pwd\s+)\S+/i, '$1{USER}$2{PWD}')
    // ssid 1-4 son la banda de 2.4 GHz y 5-8 la de 5 GHz en los doble banda (V364, V222, H223)
    .replace(/(\bwifi_ssid\s+(\d+)\s+name\s+)\S+/i, (m, pre, n) => `${pre}${parseInt(n, 10) >= 5 ? '{SSID5}' : '{SSID}'}`)
    .replace(/(\bshared_key\s+)\S+/i, '$1{WIFIKEY}');
}

/** La forma mas comun de una lista de bloques normalizados. */
function formaMasComun(bloques) {
  const cuenta = new Map();
  for (const b of bloques) {
    if (!b.length) continue;
    const k = b.join('\n');
    cuenta.set(k, (cuenta.get(k) || 0) + 1);
  }
  let mejor = null;
  let n = 0;
  for (const [k, c] of cuenta) if (c > n) { mejor = k; n = c; }
  return {
    lineas: mejor ? mejor.split('\n') : [],
    coinciden: n,
    total: bloques.filter(b => b.length).length,
    variantes: cuenta.size,
  };
}

/**
 * Aprende de un running-config:
 *   - auth: el bloque de autorizacion (todo menos desc y pri) mas comun del
 *     PUERTO pedido; si el puerto no tiene ONUs, el de toda la OLT.
 *   - pri:  la config de modem mas comun de la OLT (solo ONUs en modo router),
 *     aprendida de ONUs del MISMO MODELO que la destino (`onuId`). El modelo es
 *     la linea `pri equid VSOLV414`: puertos LAN y WiFi cambian por modelo y
 *     mezclarlos daba 67 variantes en Tuxpan con la ganadora en un 14%. La linea
 *     `equid` nunca entra a la plantilla: cada ONU conserva la suya.
 *   - estilo: 'perfiles' | 'bloque', leido de la plantilla de auth.
 */
const EQUID_RE = /^onu\s+\d+\s+pri\s+equid\s+(\S+)/i;

function aprenderPlantillas(output, { slot = 0, ponPort = null, onuId = null } = {}) {
  const blocks = parseOnuBlocks(output);
  const equidDe = (lines) => { for (const l of lines) { const m = l.match(EQUID_RE); if (m) return m[1]; } return null; };
  const destino = onuId != null ? blocks.get(`${slot}/${ponPort}:${onuId}`) : null;
  const modelo = destino ? equidDe(destino) : null;
  const auth = [];
  const authPuerto = [];
  const pri = [];
  const priModelo = [];
  for (const [key, lines] of blocks) {
    const id = parseInt(key.split(':')[1], 10);
    const norm = (l) => normalizarLinea(l, id);
    const a = lines.filter(l => !esLineaPri(l) && !esLineaDesc(l)).map(norm);
    const p = lines.filter(l => esLineaPri(l) && !EQUID_RE.test(l)).map(norm);
    auth.push(a);
    if (ponPort != null && key.startsWith(`${slot}/${ponPort}:`)) authPuerto.push(a);
    if (p.some(l => l.includes('{USER}'))) {
      pri.push(p);
      if (modelo && equidDe(lines) === modelo) priModelo.push(p);
    }
  }
  const authFuente = authPuerto.filter(b => b.length).length ? 'puerto' : 'olt';
  const authPlantilla = formaMasComun(authFuente === 'puerto' ? authPuerto : auth);
  const estilo = authPlantilla.lineas.some(l => /\bprofile\s+line\b/i.test(l)) ? 'perfiles' : 'bloque';
  // Con menos de 3 del mismo modelo no hay forma "mas comun" confiable: se usa la de
  // toda la OLT y se dice, para que la persona la revise.
  const priFuente = priModelo.length >= 3 ? 'modelo' : 'olt';
  return {
    onus: blocks.size,
    auth: { ...authPlantilla, fuente: authFuente, estilo },
    pri: { ...formaMasComun(priFuente === 'modelo' ? priModelo : pri), fuente: priFuente, modelo: modelo || null },
  };
}

/** Valores que van pegados al CLI: sin espacios ni nada que la OLT pueda leer como otro argumento. */
const VALOR_CLI_RE = /^[A-Za-z0-9_.@\-]+$/;

function llenarPlantilla(lineas, valores) {
  return lineas.map(l => l.replace(/\{(ID|SN|USER|PWD|SSID5|SSID|WIFIKEY)\}/g, (_, k) => {
    const v = valores[k];
    if (v == null || v === '') throw new Error(`Falta el valor ${k} para la plantilla`);
    return String(v);
  }));
}

/** Ejecuta un comando y trata cualquier `% ...` de la OLT como error (no solo Unknown/Incomplete). */
async function execEstricto(cli, cmd, timeoutMs = 20000) {
  const out = await cli.exec(cmd, timeoutMs);
  const err = out.split('\n').map(l => l.trim()).find(l => /^%\s*\S/.test(l) || /\b(error|failed|invalid)\b/i.test(l));
  if (err) throw new Error(`La OLT rechazo "${cmd}": ${err}`);
  return out;
}

async function guardarConfig(cli) {
  for (const cmd of ['write', 'copy running-config startup-config', 'write file']) {
    try { await cli.exec(cmd, 30000); return true; } catch (_) { /* probar siguiente */ }
  }
  return false;
}

/** Plantillas aprendidas de la OLT (solo lectura). */
async function oltPlantilla(oltCfg, { ponPort = null, onuId = null } = {}) {
  const cli = new VsolCli(oltCfg);
  try {
    await cli.connect();
    await cli.login();
    const cfg = await cli.exec('show running-config', 60000);
    cli.close();
    const slot = parseInt(oltCfg.slot, 10) || 0;
    return { success: true, ...aprenderPlantillas(cfg, { slot, ponPort, onuId }) };
  } catch (e) {
    cli.close();
    return { success: false, message: e.message || 'Error leyendo running-config' };
  }
}

/**
 * Autoriza una ONU copiando el estilo de autorizacion del puerto.
 * Idempotente por SN. Con `dryRun` solo lee (show onu info + running-config)
 * y devuelve los comandos que mandaria.
 */
async function oltAuthorizeAprendido(oltCfg, { ponPort, sn, desc, dryRun = false, save = true }) {
  if (!ponPort || !sn) return { success: false, message: 'Faltan ponPort y sn' };
  if (!VALOR_CLI_RE.test(sn)) return { success: false, message: `SN invalido: "${sn}"` };
  if (isEpon(oltCfg.tec)) return { success: false, message: 'La autorizacion automatica en OLTs EPON aun no esta soportada' };
  const slot = parseInt(oltCfg.slot, 10) || 0;
  const pon = `GPON${slot}/${ponPort}`;
  const cli = new VsolCli(oltCfg);
  try {
    await cli.connect();
    await cli.login();
    const cfg = await cli.exec('show running-config', 60000);
    const plantilla = aprenderPlantillas(cfg, { slot, ponPort });
    if (!plantilla.auth.lineas.length) {
      cli.close();
      return { success: false, message: 'La OLT no tiene ninguna ONU de la cual copiar la autorizacion' };
    }
    if (!plantilla.auth.lineas.some(l => /^onu add \{ID\}/.test(l))) {
      cli.close();
      return { success: false, message: 'La plantilla aprendida no trae la linea `onu add`: revisar la OLT a mano', plantilla: plantilla.auth };
    }

    await cli.exec(`interface gpon ${slot}/${ponPort}`);
    const existing = parseOnuInfo(await cli.exec('show onu info'));
    const dup = existing.find(o => o.sn && o.sn.toLowerCase() === sn.toLowerCase());
    if (dup) {
      cli.close();
      return { success: true, alreadyExists: true, onuId: dup.onuId, ponPort, sn, plantilla: plantilla.auth, message: `La ONU ${sn} ya estaba autorizada como ${pon}:${dup.onuId}` };
    }
    const used = new Set(existing.map(o => o.onuId));
    let onuId = 1;
    while (used.has(onuId)) onuId++;

    const cleanDesc = sanitizeDesc(desc);
    const auth = llenarPlantilla(plantilla.auth.lineas, { ID: onuId, SN: sn });
    // el `onu add` primero (sin el la ONU no existe) y la desc justo despues, como la escribe soporte
    const iAdd = auth.findIndex(l => /^onu\s+add\b/i.test(l));
    const comandos = [auth[iAdd], `onu ${onuId} desc ${cleanDesc}`, ...auth.filter((_, i) => i !== iAdd)];

    if (dryRun) {
      cli.close();
      return { success: true, dryRun: true, onuId, ponPort, sn, comandos, plantilla: plantilla.auth };
    }

    const enviados = [];
    for (const cmd of comandos) {
      await execEstricto(cli, cmd);
      enviados.push(cmd);
    }
    const after = parseOnuInfo(await cli.exec('show onu info'));
    const added = after.find(o => o.onuId === onuId && o.sn && o.sn.toLowerCase() === sn.toLowerCase());
    if (!added) {
      cli.close();
      return { success: false, message: `Se enviaron los comandos pero la ONU ${sn} no aparece en show onu info — revisar manualmente`, onuId, ponPort, comandos: enviados };
    }
    let saved = false;
    if (save) { await cli.exec('exit'); saved = await guardarConfig(cli); }
    cli.close();
    return {
      success: true, onuId, ponPort, sn, desc: cleanDesc, saved, comandos: enviados, plantilla: plantilla.auth,
      message: `ONU ${sn} autorizada como ${pon}:${onuId} (${plantilla.auth.estilo})${saved ? ' y config guardada' : ' — ADVERTENCIA: no se pudo guardar la config'}`,
    };
  } catch (e) {
    cli.close();
    return { success: false, message: e.message || 'Error autorizando ONU' };
  }
}

/**
 * Escribe PPPoE + WiFi en una ONU V-SOL con los `pri` de la plantilla de la OLT.
 * Antes de escribir devuelve el respaldo: las lineas que esa ONU tenia, para
 * poder regresarlas. Con `dryRun` no escribe nada.
 */
async function oltConfigurarWan(oltCfg, { ponPort, onuId, pppUser, pppPass, ssid, ssid5, wifiKey, dryRun = false, save = true }) {
  if (!ponPort || !onuId) return { success: false, message: 'Faltan ponPort y onuId' };
  // SSID de 5 GHz: solo lo usan los modelos doble banda; sin el, la misma red en las dos bandas
  ssid5 = ssid5 || ssid;
  for (const [k, v] of Object.entries({ pppUser, pppPass, ssid, ssid5, wifiKey })) {
    if (!v || !VALOR_CLI_RE.test(String(v))) return { success: false, message: `${k} vacio o con caracteres que la OLT no acepta (solo letras, numeros, _ . @ -)` };
  }
  if (String(wifiKey).length < 8) return { success: false, message: 'La clave WiFi debe tener al menos 8 caracteres' };
  if (isEpon(oltCfg.tec)) return { success: false, message: 'La config de modem en OLTs EPON aun no esta soportada' };
  const slot = parseInt(oltCfg.slot, 10) || 0;
  const cli = new VsolCli(oltCfg);
  try {
    await cli.connect();
    await cli.login();
    const cfg = await cli.exec('show running-config', 60000);
    const plantilla = aprenderPlantillas(cfg, { slot, ponPort, onuId });
    if (!plantilla.pri.lineas.length) {
      cli.close();
      return { success: false, message: 'La OLT no tiene ninguna ONU en modo router de la cual copiar la config' };
    }
    const respaldo = parseOnuBlocks(cfg).get(`${slot}/${ponPort}:${onuId}`) || [];
    if (!respaldo.length) {
      cli.close();
      return { success: false, message: `No existe la ONU ${slot}/${ponPort}:${onuId} en la OLT (autorizala primero)` };
    }
    const comandos = llenarPlantilla(plantilla.pri.lineas, { ID: onuId, USER: pppUser, PWD: pppPass, SSID: ssid, SSID5: ssid5, WIFIKEY: wifiKey });
    // Los `pri wan_adv` solo quedan en la OLT hasta el commit: sin el, el modem
    // sigue con su WAN de fabrica (tr069, VLAN 46). Es el "Submit" de la web.
    // Verificado en Tuxpan 2026-10-05 (`onu <id> pri wan_adv ?` lista `commit`).
    // El WiFi no tiene commit propio. No entra a la plantilla porque el
    // running-config no lo guarda.
    if (comandos.some(l => /\bpri\s+wan_adv\b/i.test(l))) comandos.push(`onu ${onuId} pri wan_adv commit`);
    // Modelos con la sintaxis vieja (`wan_conn`, p.ej. V342): su commit es otro (manual V1600D 17.6.13).
    if (comandos.some(l => /\bpri\s+wan_conn\b/i.test(l))) comandos.push(`onu ${onuId} pri wan_conn commit`);
    const yaTeniaPri = respaldo.some(esLineaPri);

    if (dryRun) {
      cli.close();
      return { success: true, dryRun: true, comandos, respaldo, yaTeniaPri, plantilla: plantilla.pri };
    }

    await cli.exec(`interface gpon ${slot}/${ponPort}`);
    const enviados = [];
    try {
      for (const cmd of comandos) {
        await execEstricto(cli, cmd);
        enviados.push(cmd);
      }
    } catch (e) {
      cli.close();
      return { success: false, message: e.message, comandos: enviados, pendientes: comandos.slice(enviados.length), respaldo };
    }
    let saved = false;
    if (save) { await cli.exec('exit'); saved = await guardarConfig(cli); }
    cli.close();
    return {
      success: true, comandos: enviados, respaldo, yaTeniaPri, saved, plantilla: plantilla.pri,
      message: `Config de modem enviada a GPON${slot}/${ponPort}:${onuId}${saved ? ' y guardada' : ' — ADVERTENCIA: no se pudo guardar la config'}`,
    };
  } catch (e) {
    cli.close();
    return { success: false, message: e.message || 'Error configurando la ONU' };
  }
}

// ==================== DIAGNOSTICO ACOTADO A UNA ONU ====================
// Para mapear la sintaxis `pri` (p.ej. el equivalente CLI del "Submit" del
// running-config en la web de la OLT) sin abrir una consola libre:
//   - ayuda: solo lineas que terminan en `?`, mandadas SIN Enter y borradas con
//     Ctrl-U (mismo metodo de scripts/olt-reboot-probe.js): nunca se ejecutan.
//   - comando: UNA linea que empiece con `onu <onuId> pri` o sea `onu <onuId> reboot`,
//     dentro de su puerto. Nada de otras ONUs, nada fuera del contexto del puerto.

function ayudaCruda(cli, linea, idleMs = 1500) {
  return new Promise((resolve) => {
    cli.buffer = '';
    cli.stream.write(linea);
    setTimeout(() => {
      const out = stripAnsi(cli.buffer);
      cli.stream.write('\x15'); // Ctrl-U: descarta la linea sin ejecutarla
      setTimeout(() => { cli.buffer = ''; resolve(out); }, 300);
    }, idleMs);
  });
}

async function oltAyudaOnu(oltCfg, { ponPort, consultas = [] }) {
  if (!ponPort || !consultas.length) return { success: false, message: 'Faltan ponPort y consultas' };
  const malas = consultas.filter(q => !/^[\w .\-\/]*\?$/.test(q) || /[\r\n;|]/.test(q));
  if (malas.length) return { success: false, message: `Solo consultas que terminan en "?": ${malas.join(' | ')}` };
  const slot = parseInt(oltCfg.slot, 10) || 0;
  const cli = new VsolCli(oltCfg);
  try {
    await cli.connect();
    await cli.login();
    await cli.exec(`interface ${interfaceKw(oltCfg.tec)} ${slot}/${ponPort}`);
    const respuestas = [];
    for (const q of consultas.slice(0, 20)) respuestas.push({ consulta: q, salida: (await ayudaCruda(cli, q)).trim().slice(0, 4000) });
    cli.close();
    return { success: true, respuestas };
  } catch (e) {
    cli.close();
    return { success: false, message: e.message || 'Error consultando ayuda' };
  }
}

async function oltComandoOnu(oltCfg, { ponPort, onuId, comando, save = false }) {
  const id = parseInt(onuId, 10);
  const cmd = String(comando || '').trim();
  if (!ponPort || !id || !cmd) return { success: false, message: 'Faltan ponPort, onuId y comando' };
  if (/[\r\n;|?]/.test(cmd) || !new RegExp(`^onu\\s+${id}\\s+(pri\\b|reboot$)`, 'i').test(cmd)) {
    return { success: false, message: `Solo un comando "onu ${id} pri ..." o "onu ${id} reboot"` };
  }
  const slot = parseInt(oltCfg.slot, 10) || 0;
  const cli = new VsolCli(oltCfg);
  try {
    await cli.connect();
    await cli.login();
    await cli.exec(`interface ${interfaceKw(oltCfg.tec)} ${slot}/${ponPort}`);
    let salida = '';
    let error = null;
    try { salida = await cli.exec(cmd, 30000); } catch (e) { error = e.message; }
    const rechazo = salida.split('\n').map(l => l.trim()).find(l => /^%\s*\S/.test(l) || /\b(error|failed|invalid)\b/i.test(l));
    let saved = false;
    if (!error && !rechazo && save) { await cli.exec('exit'); saved = await guardarConfig(cli); }
    cli.close();
    return { success: !error && !rechazo, comando: cmd, salida: salida.trim().slice(0, 4000), message: error || rechazo || 'Comando enviado', saved };
  } catch (e) {
    cli.close();
    return { success: false, message: e.message || 'Error enviando comando' };
  }
}

module.exports = {
  VsolCli,
  oltAyudaOnu,
  oltComandoOnu,
  parseOnuBlocks,
  aprenderPlantillas,
  oltPlantilla,
  oltAuthorizeAprendido,
  oltConfigurarWan,
  stripAnsi,
  parseAutoFind,
  parseOnuInfo,
  parseOnuState,
  totalDeclarado,
  parseRunningConfig,
  cleanPppoe,
  sanitizeDesc,
  oltAutoFind,
  oltOnuState,
  oltAuthorizeOnu,
  oltListOnusFull,
  oltRebootOnu,
  oltFindAndRebootByPppoe,
};
