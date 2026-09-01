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
    for (let intento = 1; intento <= 3; intento++) {
      const out = await cli.exec('show onu state', 20000);
      const leidas = parseOnuState(out);
      const total = totalDeclarado(out);
      if (leidas.length > state.length) { state = leidas; esperados = total; }
      // El pie solo se imprime cuando el volcado terminó: su AUSENCIA ya
      // significa que vino cortado. Tratar `null` como "sin checksum" era el
      // error — es justo el caso malo.
      if (total != null && leidas.length >= total) { parcial = false; break; }
      parcial = true;
      if (intento < 3) console.warn(`[olt] ${oltCfg.host} pon ${ponPort}: volcado cortado (${leidas.length}/${total ?? 'sin pie'}), reintento ${intento + 1}/3`);
    }
    if (parcial) {
      console.warn(`[olt] ${oltCfg.host} pon ${ponPort}: sigue incompleta tras 3 intentos (${state.length}/${esperados})`);
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

module.exports = {
  VsolCli,
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
