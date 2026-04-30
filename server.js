require('dotenv').config();
const http = require('http');
const { RouterOSAPI } = require('routeros');
const cron = require('node-cron');
const fetch = require('node-fetch');

// Configuración
const PORT = 3001;
const API_KEY = process.env.PROXY_API_KEY || 'tu-api-key-secreta-aqui';
const MIKROTIK_USER = process.env.MIKROTIK_USER || 'mario';
const MIKROTIK_PASSWORD = process.env.MIKROTIK_PASSWORD || '';
const MIKROTIK_PORT = parseInt(process.env.MIKROTIK_PORT || '8728', 10);

// MapaReportesDigy API config (MIGRADO de SheetBest)
const MAPA_API_URL = process.env.MAPA_REPORTES_API_URL || 'https://mapa-reportes-digy.vercel.app';
const MAPA_API_KEY = process.env.MAPA_REPORTES_API_KEY || '';

// SmartOLT API config (solo Huawei)
const SMARTOLT_URL = process.env.SMARTOLT_URL || 'https://digynetworks.smartolt.com';
const SMARTOLT_API_KEY = process.env.SMARTOLT_API_KEY || '';

// ==================== FUNCIONES DE ESTADO DE CONEXIÓN ====================

// Parsear fecha de MikroTik (formato: "dec/30/2025 14:30:00" o "2025-12-30 14:30:00")
function parseMikroTikDate(dateStr) {
  if (!dateStr) return null;

  // Mapeo de meses abreviados
  const months = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  };

  // Intentar formato MikroTik: "dec/30/2025 14:30:00"
  const mikrotikMatch = dateStr.match(/^([a-z]{3})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/i);
  if (mikrotikMatch) {
    const [, monthStr, day, year, hours, minutes, seconds] = mikrotikMatch;
    const month = months[monthStr.toLowerCase()];
    if (month !== undefined) {
      return new Date(parseInt(year), month, parseInt(day), parseInt(hours), parseInt(minutes), parseInt(seconds));
    }
  }

  // Intentar formato ISO: "2025-12-30 14:30:00"
  const isoMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (isoMatch) {
    const [, year, month, day, hours, minutes, seconds] = isoMatch;
    return new Date(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hours), parseInt(minutes), parseInt(seconds));
  }

  // Último intento: usar Date constructor directamente
  const date = new Date(dateStr.replace(' ', 'T'));
  return isNaN(date.getTime()) ? null : date;
}

// Parsear uptime de MikroTik (formato: "1w2d12h8m50s") a "Xh Ym"
function parseMikroTikUptime(uptimeStr) {
  if (!uptimeStr) return null;
  const weeks = uptimeStr.match(/(\d+)w/);
  const days = uptimeStr.match(/(\d+)d/);
  const hours = uptimeStr.match(/(\d+)h/);
  const minutes = uptimeStr.match(/(\d+)m(?!s)/);

  const totalHours = (weeks ? parseInt(weeks[1]) * 168 : 0) +
    (days ? parseInt(days[1]) * 24 : 0) +
    (hours ? parseInt(hours[1]) : 0);
  const mins = minutes ? parseInt(minutes[1]) : 0;

  return `${totalHours}h ${mins}m`;
}

// Verificar si el usuario PPPoE tiene sesión activa y obtener su IP real
async function checkActivePPPoE(conn, pppUser, expectedIp) {
  try {
    let cleanUser = pppUser.replace(/^<?(pppoe-)?/, '').replace(/>$/, '');
    console.log(`[PPPoE] Buscando sesión activa para: ${cleanUser}`);

    // Buscar en las sesiones PPPoE activas
    const activeSessions = await conn.write('/ppp/active/print', [
      '?name=' + cleanUser,
    ]);

    if (activeSessions && activeSessions.length > 0) {
      const session = activeSessions[0];
      const actualIp = session.address;
      console.log(`[PPPoE] Sesión activa encontrada: IP=${actualIp}, caller-id=${session['caller-id']}, uptime=${session.uptime}`);

      if (actualIp !== expectedIp) {
        console.log(`[PPPoE] ⚠️ ALERTA: IP esperada (${expectedIp}) != IP activa (${actualIp})`);
      }

      return {
        active: true,
        actualIp,
        expectedIp,
        ipMismatch: actualIp !== expectedIp,
        callerId: session['caller-id'],
        uptime: session.uptime,
      };
    }

    console.log(`[PPPoE] ❌ No hay sesión activa para ${cleanUser}`);
    return { active: false, expectedIp };
  } catch (error) {
    console.error('[PPPoE] Error verificando sesión:', error.message);
    return { active: false, error: error.message };
  }
}

function extractInterfaceInfo(iface) {
  // Calcular uptime desde last-link-up-time
  let uptime = null;
  if (iface['last-link-up-time']) {
    const linkUp = parseMikroTikDate(iface['last-link-up-time']);
    if (linkUp) {
      // Usar hora de México para comparar con la hora del router (también en México)
      const nowMx = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
      const diffMs = nowMx - linkUp;
      if (diffMs >= 0) {
        const diffHrs = Math.floor(diffMs / 3600000);
        const diffMins = Math.floor((diffMs % 3600000) / 60000);
        uptime = `${diffHrs}h ${diffMins}m`;
      } else {
        // Si es negativo, la hora del router está adelantada — mostrar como recién conectado
        uptime = `0h 0m`;
        console.log(`[ConnectionInfo] Uptime negativo (${diffMs}ms), ajustando a 0h 0m. linkUp=${iface['last-link-up-time']}, nowMx=${nowMx.toISOString()}`);
      }
    }
  }

  // Convertir bytes a MB
  const rxMB = (parseInt(iface['rx-byte'] || '0', 10) / 1048576).toFixed(2);
  const txMB = (parseInt(iface['tx-byte'] || '0', 10) / 1048576).toFixed(2);

  return {
    lastLinkUpTime: iface['last-link-up-time'] || null,
    uptime,
    linkDowns: parseInt(iface['link-downs'] || '0', 10),
    rxMB: parseFloat(rxMB),
    txMB: parseFloat(txMB),
    running: iface['running'] === 'true',
    disabled: iface['disabled'] === 'true',
  };
}

async function getConnectionInfo(conn, pppUser) {
  try {
    // Limpiar el nombre de usuario
    let cleanUser = pppUser.replace(/^<?(pppoe-)?/, '').replace(/>$/, '');

    // El nombre de la interfaz tiene formato "<pppoe-username>"
    const interfaceName = `<pppoe-${cleanUser}>`;
    console.log(`[ConnectionInfo] Buscando interfaz: ${interfaceName}`);

    // Buscar la interfaz PPPoE del usuario
    const interfaces = await conn.write('/interface/print', [
      '?name=' + interfaceName,
    ]);

    if (interfaces && interfaces.length > 0) {
      const iface = interfaces[0];
      console.log(`[ConnectionInfo] Interfaz encontrada:`, JSON.stringify(iface));

      return extractInterfaceInfo(iface);
    }

    // Intentar sin brackets (por si acaso)
    const altName = `pppoe-${cleanUser}`;
    console.log(`[ConnectionInfo] Intentando sin brackets: ${altName}`);

    const altInterfaces = await conn.write('/interface/print', [
      '?name=' + altName,
    ]);

    if (altInterfaces && altInterfaces.length > 0) {
      const iface = altInterfaces[0];
      console.log(`[ConnectionInfo] Interfaz encontrada (alt):`, JSON.stringify(iface));

      return extractInterfaceInfo(iface);
    }

    console.log(`[ConnectionInfo] No se encontró interfaz para ${pppUser}`);
    return null;
  } catch (error) {
    console.error('[ConnectionInfo] Error:', error.message);
    return null;
  }
}

// Timeout wrapper para operaciones que pueden quedarse colgadas
function withTimeout(promise, ms, errorMsg = 'Timeout') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(errorMsg)), ms))
  ]);
}

// Construye la conexión al router. Si el caller pasa creds, las usa; sino fallback a globals.
function buildRouterConn(routerIp, creds) {
  return new RouterOSAPI({
    host: routerIp,
    port: (creds && creds.port) || MIKROTIK_PORT,
    user: (creds && creds.user) || MIKROTIK_USER,
    password: (creds && creds.password !== undefined) ? creds.password : MIKROTIK_PASSWORD,
    timeout: 10,
  });
}

function pickCreds(body) {
  if (!body) return null;
  const { mtUser, mtPassword, mtPort } = body;
  if (!mtUser && !mtPassword && !mtPort) return null;
  return {
    user: mtUser || undefined,
    password: mtPassword !== undefined ? mtPassword : undefined,
    port: mtPort ? parseInt(mtPort, 10) : undefined,
  };
}

async function getClientStatus(routerIp, targetIp, pppUser = null, creds = null) {
  const port = (creds && creds.port) || MIKROTIK_PORT;
  console.log(`[Status] Conectando a router ${routerIp}:${port}...`);

  // Si no hay pppUser, no podemos verificar el estado
  if (!pppUser) {
    console.log(`[Status] No se proporcionó pppUser - No monitoreable`);
    return {
      success: false,
      status: 'no_monitoreable',
      clientIp: targetIp,
      message: 'Se requiere pppUser para verificar estado de conexión',
    };
  }

  const conn = buildRouterConn(routerIp, creds);

  try {
    // Timeout de 15 segundos para la conexión
    await withTimeout(conn.connect(), 15000, 'Timeout conectando al router');
    console.log(`[Status] Conexión exitosa, verificando sesión PPPoE para ${pppUser}...`);

    // Verificar sesión PPPoE activa
    const pppoeStatus = await checkActivePPPoE(conn, pppUser, targetIp);

    // Obtener info de conexión
    const connectionInfo = await getConnectionInfo(conn, pppUser);

    await conn.close();

    // Determinar status basado en sesión PPPoE activa
    const isOnline = pppoeStatus.active === true;

    // Verificar si hay advertencias
    let warning = null;
    if (pppoeStatus.active && pppoeStatus.ipMismatch) {
      warning = `⚠️ IP INCORRECTA - El cliente tiene IP ${pppoeStatus.actualIp}, no ${targetIp}`;
      console.log(`[Status] ${warning}`);
    }

    // Preferir uptime de la sesión PPPoE activa (más preciso que last-link-up-time de la interfaz)
    if (isOnline && pppoeStatus.uptime && connectionInfo) {
      connectionInfo.uptime = parseMikroTikUptime(pppoeStatus.uptime);
    }

    if (isOnline) {
      console.log(`[Status] Cliente ONLINE - Sesión PPPoE activa, uptime: ${connectionInfo?.uptime || pppoeStatus.uptime || 'N/A'}`);
      return {
        success: true,
        status: 'online',
        latency: null,
        packetLoss: null,
        clientIp: targetIp,
        message: `Sesión PPPoE activa, uptime: ${connectionInfo?.uptime || pppoeStatus.uptime || 'N/A'}`,
        connectionInfo,
        pppoeStatus,
        warning,
      };
    } else {
      console.log(`[Status] Cliente OFFLINE - No hay sesión PPPoE activa`);
      return {
        success: true,
        status: 'offline',
        latency: null,
        packetLoss: null,
        clientIp: targetIp,
        message: 'No hay sesión PPPoE activa',
        connectionInfo,
        pppoeStatus,
      };
    }
  } catch (error) {
    console.error('[Status] Error:', error.message);
    return {
      success: false,
      status: 'error',
      clientIp: targetIp,
      message: error.message || 'Error de conexión al router',
    };
  }
}

// ==================== DESCONEXIÓN PPPoE ====================

async function disconnectPPPoE(routerIp, pppUser, creds = null) {
  const port = (creds && creds.port) || MIKROTIK_PORT;
  console.log(`[Disconnect] Conectando a router ${routerIp}:${port}...`);

  if (!pppUser) {
    return { success: false, message: 'Se requiere pppUser para desconectar sesión' };
  }

  const conn = buildRouterConn(routerIp, creds);

  try {
    await withTimeout(conn.connect(), 15000, 'Timeout conectando al router');

    let cleanUser = pppUser.replace(/^<?(pppoe-)?/, '').replace(/>$/, '');
    console.log(`[Disconnect] Buscando sesión activa para: ${cleanUser}`);

    // Buscar la sesión activa
    const activeSessions = await conn.write('/ppp/active/print', [
      '?name=' + cleanUser,
    ]);

    if (!activeSessions || activeSessions.length === 0) {
      await conn.close();
      console.log(`[Disconnect] No hay sesión activa para ${cleanUser}`);
      return { success: false, message: `No hay sesión PPPoE activa para ${cleanUser}` };
    }

    const session = activeSessions[0];
    const sessionId = session['.id'];
    console.log(`[Disconnect] Sesión encontrada: id=${sessionId}, IP=${session.address}, uptime=${session.uptime}`);

    // Remover la sesión activa
    await conn.write('/ppp/active/remove', [
      '=.id=' + sessionId,
    ]);

    await conn.close();
    console.log(`[Disconnect] ✅ Sesión PPPoE de ${cleanUser} desconectada exitosamente`);

    return {
      success: true,
      message: `Sesión PPPoE de ${cleanUser} desconectada`,
      disconnectedSession: {
        name: cleanUser,
        ip: session.address,
        uptime: session.uptime,
        callerId: session['caller-id'],
      },
    };
  } catch (error) {
    console.error('[Disconnect] Error:', error.message);
    return { success: false, message: error.message || 'Error desconectando sesión' };
  }
}

// ==================== LISTAR SESIONES PPPoE ACTIVAS ====================

async function listActivePPPoESessions(routerIp, creds = null) {
  const port = (creds && creds.port) || MIKROTIK_PORT;
  console.log(`[PPPListActive] Conectando a router ${routerIp}:${port}...`);

  const conn = buildRouterConn(routerIp, creds);

  try {
    await withTimeout(conn.connect(), 15000, 'Timeout conectando al router');
    const sessions = await conn.write('/ppp/active/print');
    await conn.close();

    const normalized = (sessions || []).map(s => ({
      name: s.name || '',
      address: s.address || '',
      uptime: s.uptime || '',
      callerId: s['caller-id'] || '',
    }));

    console.log(`[PPPListActive] ${routerIp}: ${normalized.length} sesiones activas`);
    return { success: true, count: normalized.length, sessions: normalized };
  } catch (error) {
    console.error(`[PPPListActive] Error en ${routerIp}:`, error.message);
    return { success: false, count: 0, sessions: [], message: error.message || 'Error consultando sesiones' };
  }
}

// ==================== LIMPIAR ADDRESS-LIST DE FIREWALL ====================

async function clearFirewallAddressList(routerIp, listName, creds = null) {
  const port = (creds && creds.port) || MIKROTIK_PORT;
  console.log(`[FirewallAddressList] Conectando a router ${routerIp}:${port}...`);

  if (!listName) {
    return { success: false, message: 'Se requiere listName para limpiar address-list' };
  }

  const conn = buildRouterConn(routerIp, creds);

  try {
    await withTimeout(conn.connect(), 15000, 'Timeout conectando al router');
    console.log(`[FirewallAddressList] Listando entradas de "${listName}"...`);

    // Equivalente a: /ip firewall address-list print where list="morosos"
    const entries = await conn.write('/ip/firewall/address-list/print', [
      '?list=' + listName,
    ]);

    if (!entries || entries.length === 0) {
      await conn.close();
      console.log(`[FirewallAddressList] La lista "${listName}" no tiene entradas`);
      return {
        success: true,
        message: `La lista "${listName}" no tiene entradas`,
        removed: 0,
      };
    }

    console.log(`[FirewallAddressList] Encontradas ${entries.length} entradas, removiendo...`);

    // Equivalente a: /ip firewall address-list remove [find list="morosos"]
    // RouterOS API acepta múltiples ids separados por coma en un solo remove
    const ids = entries.map(e => e['.id']).join(',');
    await conn.write('/ip/firewall/address-list/remove', [
      '=.id=' + ids,
    ]);

    await conn.close();
    console.log(`[FirewallAddressList] ✅ ${entries.length} entradas removidas de "${listName}"`);

    return {
      success: true,
      message: `${entries.length} entradas removidas de address-list "${listName}"`,
      removed: entries.length,
      listName,
    };
  } catch (error) {
    console.error('[FirewallAddressList] Error:', error.message);
    return { success: false, message: error.message || 'Error limpiando address-list' };
  }
}

async function clearFirewallAddressListBatch(routers, listName, concurrency) {
  console.log(`[FirewallAddressListBatch] Iniciando: ${routers.length} routers, list="${listName}", concurrencia=${concurrency}`);
  const t0 = Date.now();
  const results = new Array(routers.length);
  let cursor = 0;
  let processed = 0;

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= routers.length) return;
      const ipRouter = routers[idx];
      const start = Date.now();
      try {
        const r = await clearFirewallAddressList(ipRouter, listName);
        const elapsed = Date.now() - start;
        results[idx] = {
          ipRouter,
          success: r.success === true,
          removed: r.removed || 0,
          message: r.message,
          elapsed,
        };
      } catch (err) {
        results[idx] = {
          ipRouter,
          success: false,
          removed: 0,
          message: err.message || 'Error desconocido',
          elapsed: Date.now() - start,
        };
      }
      processed++;
      console.log(`[FirewallAddressListBatch] [${processed}/${routers.length}] ${ipRouter}: ${results[idx].success ? '✅' : '❌'} (${results[idx].elapsed}ms)`);
    }
  }

  const runners = Array.from({ length: Math.min(concurrency, routers.length) }, () => worker());
  await Promise.all(runners);

  const ok = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  const totalRemoved = ok.reduce((sum, r) => sum + (r.removed || 0), 0);
  const totalElapsed = Date.now() - t0;

  console.log(`[FirewallAddressListBatch] Completado en ${(totalElapsed / 1000).toFixed(1)}s — ${ok.length} ok, ${failed.length} fail, ${totalRemoved} entradas removidas`);

  return {
    success: true,
    summary: {
      total: results.length,
      ok: ok.length,
      failed: failed.length,
      totalRemoved,
      elapsedMs: totalElapsed,
    },
    listName,
    results,
  };
}

// ==================== REMOVE ADDRESS-LIST POR COMMENT ====================

async function removeAddressListByComments(routerIp, comments, creds = null) {
  const list = Array.isArray(comments) ? comments.filter(Boolean) : (comments ? [comments] : []);
  const port = (creds && creds.port) || MIKROTIK_PORT;
  console.log(`[FirewallAddressListByComment] Conectando a router ${routerIp}:${port} (${list.length} comments)...`);

  if (list.length === 0) {
    return { success: false, message: 'Se requiere al menos un comment' };
  }

  const conn = buildRouterConn(routerIp, creds);

  try {
    await withTimeout(conn.connect(), 15000, 'Timeout conectando al router');

    // Equivalente a: /ip firewall address-list print where comment="<c>"  (por cada comment)
    const allEntries = [];
    const perComment = {};
    for (const c of list) {
      const entries = await conn.write('/ip/firewall/address-list/print', ['?comment=' + c]);
      perComment[c] = entries.length;
      if (entries.length > 0) allEntries.push(...entries);
    }

    if (allEntries.length === 0) {
      await conn.close();
      console.log(`[FirewallAddressListByComment] ${routerIp}: ningún comment coincide`);
      return {
        success: true,
        message: `Ningún comment coincide en ${routerIp}`,
        removed: 0,
        perComment,
      };
    }

    console.log(`[FirewallAddressListByComment] ${routerIp}: ${allEntries.length} entradas, removiendo...`);

    // Equivalente a: /ip firewall address-list remove [find comment="..."]
    const ids = allEntries.map(e => e['.id']).join(',');
    await conn.write('/ip/firewall/address-list/remove', ['=.id=' + ids]);

    await conn.close();
    console.log(`[FirewallAddressListByComment] ✅ ${routerIp}: ${allEntries.length} entradas removidas`);

    return {
      success: true,
      message: `${allEntries.length} entradas removidas en ${routerIp}`,
      removed: allEntries.length,
      perComment,
    };
  } catch (error) {
    console.error(`[FirewallAddressListByComment] ${routerIp} error:`, error.message);
    try { await conn.close(); } catch (_) {}
    return { success: false, message: error.message || 'Error removiendo por comment' };
  }
}

async function removeAddressListByCommentsBatch(groups, concurrency) {
  console.log(`[FirewallAddressListByCommentBatch] Iniciando: ${groups.length} routers, concurrencia=${concurrency}`);
  const t0 = Date.now();
  const results = new Array(groups.length);
  let cursor = 0;
  let processed = 0;

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= groups.length) return;
      const { ipRouter, comments } = groups[idx];
      const start = Date.now();
      try {
        const r = await removeAddressListByComments(ipRouter, comments);
        const elapsed = Date.now() - start;
        results[idx] = {
          ipRouter,
          commentsRequested: Array.isArray(comments) ? comments.length : 1,
          success: r.success === true,
          removed: r.removed || 0,
          message: r.message,
          perComment: r.perComment,
          elapsed,
        };
      } catch (err) {
        results[idx] = {
          ipRouter,
          commentsRequested: Array.isArray(comments) ? comments.length : 1,
          success: false,
          removed: 0,
          message: err.message || 'Error desconocido',
          elapsed: Date.now() - start,
        };
      }
      processed++;
      console.log(`[FirewallAddressListByCommentBatch] [${processed}/${groups.length}] ${ipRouter}: ${results[idx].success ? '✅' : '❌'} removed=${results[idx].removed} (${results[idx].elapsed}ms)`);
    }
  }

  const runners = Array.from({ length: Math.min(concurrency, groups.length) }, () => worker());
  await Promise.all(runners);

  const ok = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  const totalRemoved = ok.reduce((sum, r) => sum + (r.removed || 0), 0);
  const totalElapsed = Date.now() - t0;

  console.log(`[FirewallAddressListByCommentBatch] Completado en ${(totalElapsed / 1000).toFixed(1)}s — ${ok.length} ok, ${failed.length} fail, ${totalRemoved} entradas removidas`);

  return {
    success: true,
    summary: {
      total: results.length,
      ok: ok.length,
      failed: failed.length,
      totalRemoved,
      elapsedMs: totalElapsed,
    },
    results,
  };
}

// ==================== CREAR USER EN MIKROTIK ====================

async function createMikrotikUser(routerIp, name, password, group, creds = null) {
  const port = (creds && creds.port) || MIKROTIK_PORT;
  console.log(`[CreateUser] Conectando a router ${routerIp}:${port}...`);

  if (!name || !password || !group) {
    return { success: false, message: 'Se requieren name, password y group' };
  }

  const conn = buildRouterConn(routerIp, creds);

  try {
    await withTimeout(conn.connect(), 15000, 'Timeout conectando al router');

    // Verificar si ya existe
    const existing = await conn.write('/user/print', ['?name=' + name]);
    if (existing && existing.length > 0) {
      await conn.close();
      console.log(`[CreateUser] El usuario "${name}" ya existe en ${routerIp}`);
      return { success: false, message: `El usuario "${name}" ya existe`, alreadyExists: true };
    }

    // Crear usuario: /user add name=... password=... group=...
    await conn.write('/user/add', [
      '=name=' + name,
      '=password=' + password,
      '=group=' + group,
    ]);

    await conn.close();
    console.log(`[CreateUser] ✅ Usuario "${name}" creado en ${routerIp}`);

    return {
      success: true,
      message: `Usuario "${name}" creado en ${routerIp}`,
      router: routerIp,
      name,
      group,
    };
  } catch (error) {
    console.error('[CreateUser] Error:', error.message);
    try { await conn.close(); } catch (_) {}
    return { success: false, message: error.message || 'Error creando usuario' };
  }
}

// ==================== REBOOT ONT VÍA SMARTOLT (HUAWEI) ====================

// Cache de OLTs: IP → olt_id
let oltsCache = null;
let oltsCacheTime = 0;
const OLTS_CACHE_TTL = 3600000; // 1 hora

async function getOltsMap() {
  if (oltsCache && Date.now() - oltsCacheTime < OLTS_CACHE_TTL) return oltsCache;

  try {
    const res = await fetch(`${SMARTOLT_URL}/api/system/get_olts`, {
      headers: { 'X-Token': SMARTOLT_API_KEY },
    });
    const data = await res.json();
    if (!data.status) return null;

    // Mapear IP → olt_id
    const map = {};
    for (const olt of data.response) {
      map[olt.ip] = olt.id;
      map[olt.name] = olt.id;
    }
    oltsCache = map;
    oltsCacheTime = Date.now();
    return map;
  } catch (err) {
    console.error('[SmartOLT] Error obteniendo OLTs:', err.message);
    return null;
  }
}

async function findOnuByUsername(oltId, pppUser) {
  let cleanUser = pppUser.replace(/^<?(pppoe-)?/, '').replace(/>$/, '');
  console.log(`[SmartOLT] Buscando ONU con username=${cleanUser} en OLT ${oltId}...`);

  try {
    const res = await fetch(`${SMARTOLT_URL}/api/onu/get_all_onus_details?olt_id=${oltId}`, {
      headers: { 'X-Token': SMARTOLT_API_KEY },
    });
    const data = await res.json();

    if (!data.status || !data.onus) {
      console.log('[SmartOLT] No se obtuvieron ONUs');
      return null;
    }

    const onu = data.onus.find(o => o.username === cleanUser);
    if (onu) {
      console.log(`[SmartOLT] ONU encontrada: id=${onu.unique_external_id}, sn=${onu.sn}, nombre=${onu.name}`);
      return onu;
    }

    console.log(`[SmartOLT] No se encontró ONU con username=${cleanUser}`);
    return null;
  } catch (err) {
    console.error('[SmartOLT] Error buscando ONU:', err.message);
    return null;
  }
}

async function rebootOnt(routerIp, pppUser) {
  console.log(`[RebootONT] Iniciando reboot para ${pppUser} en router ${routerIp}...`);

  if (!SMARTOLT_API_KEY) {
    return { success: false, message: 'SmartOLT API key no configurada' };
  }

  if (!pppUser) {
    return { success: false, message: 'Se requiere pppUser para reboot ONT' };
  }

  try {
    // 1. Obtener lista de OLTs de SmartOLT
    const oltsMap = await getOltsMap();
    if (!oltsMap) {
      return { success: false, message: 'No se pudo obtener lista de OLTs de SmartOLT' };
    }

    // 2. routerIp es el MikroTik (BNG), NO la OLT — no se puede mapear directo.
    //    Iterar sobre todas las OLTs Huawei buscando el ONU por pppUser.
    const uniqueOltIds = [...new Set(Object.values(oltsMap))];
    console.log(`[RebootONT] Buscando ONU ${pppUser} en ${uniqueOltIds.length} OLT(s) de SmartOLT...`);

    let onu = null;
    let foundOltId = null;
    for (const oltId of uniqueOltIds) {
      const candidate = await findOnuByUsername(oltId, pppUser);
      if (candidate) {
        onu = candidate;
        foundOltId = oltId;
        break;
      }
    }

    if (!onu) {
      return {
        success: false,
        message: `ONU con username ${pppUser} no encontrada en ninguna OLT Huawei (routerIp ${routerIp}). ` +
                 `Probablemente el cliente está detrás de un OLT V-sol (no soportado por SmartOLT).`
      };
    }

    // 3. Reboot
    const onuId = onu.unique_external_id;
    console.log(`[RebootONT] Enviando reboot a ONU ${onuId} (${onu.sn}) en OLT ${foundOltId}...`);

    const rebootRes = await fetch(`${SMARTOLT_URL}/api/onu/reboot/${onuId}`, {
      method: 'POST',
      headers: { 'X-Token': SMARTOLT_API_KEY },
    });
    const rebootData = await rebootRes.json();

    if (rebootData.status) {
      console.log(`[RebootONT] ✅ Reboot enviado exitosamente a ONU ${onuId}`);
      return {
        success: true,
        message: `Reboot enviado a ONU ${onu.sn} (${onu.name})`,
        onu: {
          id: onuId,
          sn: onu.sn,
          name: onu.name,
          username: onu.username,
          oltName: onu.olt_name,
        },
      };
    } else {
      console.log(`[RebootONT] ❌ Error en reboot: ${rebootData.error}`);
      return { success: false, message: rebootData.error || 'Error enviando reboot' };
    }
  } catch (err) {
    console.error('[RebootONT] Error:', err.message);
    return { success: false, message: err.message || 'Error en reboot ONT' };
  }
}

// ==================== FUNCIONES DE MONITOREO AUTOMÁTICO ====================

// MIGRADO: Ahora usa API de MapaReportesDigy
async function fetchReports() {
  try {
    // Usar el nuevo endpoint de pending-monitoring de MapaReportesDigy
    const response = await fetch(`${MAPA_API_URL}/api/tickets/pending-monitoring`, {
      method: 'GET',
      headers: {
        'X-API-Key': MAPA_API_KEY,
        'X-Service-Name': 'ping-proxy'
      }
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();

    // El endpoint devuelve { success, tickets, total }
    if (data.success && Array.isArray(data.tickets)) {
      return data.tickets;
    }

    return [];
  } catch (error) {
    console.error('[Monitor] Error fetching reports:', error.message);
    return [];
  }
}

// MIGRADO: Ahora actualiza via API de MapaReportesDigy
async function updateReportMonitoring(ticketId, updates) {
  try {
    const response = await fetch(`${MAPA_API_URL}/api/tickets/${ticketId}/monitoring`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': MAPA_API_KEY,
        'X-Service-Name': 'ping-proxy'
      },
      body: JSON.stringify(updates),
    });

    return response.ok;
  } catch (error) {
    console.error(`[Monitor] Error updating report ${ticketId}:`, error.message);
    return false;
  }
}

function getCurrentTimestamp() {
  // Usar zona horaria de México
  const now = new Date();
  const mexicoTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  const year = mexicoTime.getFullYear();
  const month = (mexicoTime.getMonth() + 1).toString().padStart(2, '0');
  const day = mexicoTime.getDate().toString().padStart(2, '0');
  const hours = mexicoTime.getHours().toString().padStart(2, '0');
  const minutes = mexicoTime.getMinutes().toString().padStart(2, '0');
  const seconds = mexicoTime.getSeconds().toString().padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// MIGRADO: Ciclo de monitoreo actualizado para usar API de MapaReportesDigy
async function runMonitoringCycle() {
  console.log('\n========================================');
  console.log('[Monitor] Iniciando ciclo de monitoreo...');
  console.log('[Monitor] Timestamp:', getCurrentTimestamp());
  console.log('========================================\n');

  if (!MAPA_API_URL || !MAPA_API_KEY) {
    console.error('[Monitor] Falta MAPA_API_URL o MAPA_API_KEY para monitoreo');
    return;
  }

  // fetchReports ahora devuelve tickets del endpoint pending-monitoring
  // Cada ticket tiene: id, idTicket, idCliente, nombreCliente, ipClient, pppUser, ipRouter, routerMkt, estado
  const tickets = await fetchReports();
  console.log(`[Monitor] Tickets pendientes de monitoreo: ${tickets.length}`);

  let processed = 0;
  let updated = 0;
  let errors = 0;

  for (const ticket of tickets) {
    processed++;
    const ticketId = ticket.id;        // ID del documento en Firebase
    const idTicket = ticket.idTicket;  // ID de MikroWisp
    const ipRouter = ticket.ipRouter;
    const ipClient = ticket.ipClient;
    const pppUser = ticket.pppUser;

    console.log(`\n[Monitor] [${processed}/${tickets.length}] Procesando ticket ${idTicket} (doc: ${ticketId})...`);

    // Si no tiene ipRouter o ipClient, marcar como no monitoreable
    if (!ipRouter || !ipClient) {
      const reason = !ipRouter ? 'Sin ipRouter' : 'Sin ipClient';
      console.log(`[Monitor] Ticket ${idTicket}: ${reason} - No monitoreable`);

      const newEntry = {
        timestamp: new Date(),
        status: 'no_monitoreable',
      };

      const newLastStatus = {
        status: 'no_monitoreable',
        timestamp: new Date(),
      };

      const success = await updateReportMonitoring(ticketId, {
        lastStatusPing: newLastStatus,
        historialMonitoreo: [newEntry],
      });

      if (success) updated++;
      else errors++;
      continue;
    }

    // Obtener estado del cliente
    console.log(`[Monitor] Ticket ${idTicket}: Verificando estado de ${pppUser || ipClient} via ${ipRouter}`);
    const statusResult = await getClientStatus(ipRouter, ipClient, pppUser);

    // Crear entrada de historial
    const newEntry = {
      timestamp: new Date(),
      status: statusResult.status,
      uptime: statusResult.connectionInfo?.uptime || statusResult.pppoeStatus?.uptime,
      rxMB: statusResult.connectionInfo?.rxMB,
      txMB: statusResult.connectionInfo?.txMB,
    };

    // Crear último status
    const newLastStatus = {
      status: statusResult.status,
      timestamp: new Date(),
      uptime: statusResult.connectionInfo?.uptime || statusResult.pppoeStatus?.uptime,
    };

    // Determinar si bloquear cierre (noCerrar) - online con uptime < 1 hora
    let noCerrar = false;
    if (statusResult.status === 'online') {
      const uptimeStr = newLastStatus.uptime || '';
      // Parsear uptime en formato "Xh Ym"
      const hoursMatch = uptimeStr.match(/(\d+)h/);
      const hours = hoursMatch ? parseInt(hoursMatch[1], 10) : 0;
      noCerrar = hours < 1;
    }

    // Determinar si hay bajo consumo
    const rxMB = statusResult.connectionInfo?.rxMB || 0;
    const txMB = statusResult.connectionInfo?.txMB || 0;
    const bajoConsumo = rxMB < 100 && txMB < 100;

    console.log(`[Monitor] Ticket ${idTicket}: ${statusResult.status} (uptime: ${newEntry.uptime || 'N/A'}, noCerrar: ${noCerrar}, bajoConsumo: ${bajoConsumo})`);

    // Actualizar via API de MapaReportesDigy
    const success = await updateReportMonitoring(ticketId, {
      lastStatusPing: newLastStatus,
      historialMonitoreo: [newEntry],
      noCerrar,
      bajoConsumo,
    });

    if (success) {
      updated++;
      console.log(`[Monitor] Ticket ${idTicket}: Actualizado correctamente`);
    } else {
      errors++;
      console.log(`[Monitor] Ticket ${idTicket}: Error al actualizar`);
    }

    // Pequeña pausa para no saturar las APIs
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('\n========================================');
  console.log('[Monitor] Ciclo completado');
  console.log(`[Monitor] Procesados: ${processed}`);
  console.log(`[Monitor] Actualizados: ${updated}`);
  console.log(`[Monitor] Errores: ${errors}`);
  console.log('========================================\n');
}

// ==================== SERVIDOR HTTP ====================

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    return;
  }

  // Endpoint para ejecutar monitoreo manualmente
  if (req.method === 'POST' && req.url === '/monitor/run') {
    // Verificar API key
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Unauthorized' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Monitoreo iniciado' }));

    // Ejecutar en background
    runMonitoringCycle().catch(console.error);
    return;
  }

  // Ping endpoint
  if (req.method === 'POST' && req.url === '/ping') {
    // Verificar API key
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        const { ipRouter, clientIp, pppUser } = parsed;
        const creds = pickCreds(parsed);

        if (!ipRouter || !clientIp) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            message: 'Faltan parámetros: ipRouter, clientIp'
          }));
          return;
        }

        console.log(`[Request] Verificando estado de ${pppUser || clientIp} via ${ipRouter}`);
        const result = await getClientStatus(ipRouter, clientIp, pppUser, creds);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        console.error('[Error]', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Error interno' }));
      }
    });
    return;
  }

  // Desconectar sesión PPPoE
  if (req.method === 'POST' && req.url === '/ppp/disconnect') {
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        const { ipRouter, pppUser } = parsed;
        const creds = pickCreds(parsed);

        if (!ipRouter || !pppUser) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            message: 'Faltan parámetros: ipRouter, pppUser'
          }));
          return;
        }

        console.log(`[Request] Desconectando PPPoE ${pppUser} en ${ipRouter}`);
        const result = await disconnectPPPoE(ipRouter, pppUser, creds);

        res.writeHead(result.success ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        console.error('[Error]', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Error interno' }));
      }
    });
    return;
  }

  // Listar sesiones PPPoE activas de un router
  if (req.method === 'POST' && req.url === '/ppp/list-active') {
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        const { ipRouter } = parsed;
        const creds = pickCreds(parsed);

        if (!ipRouter) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            message: 'Falta parámetro: ipRouter'
          }));
          return;
        }

        console.log(`[Request] Listando sesiones PPPoE activas en ${ipRouter}`);
        const result = await listActivePPPoESessions(ipRouter, creds);

        res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        console.error('[Error]', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Error interno' }));
      }
    });
    return;
  }

  // Limpiar address-list de firewall (ej: morosos)
  if (req.method === 'POST' && req.url === '/firewall/address-list/clear') {
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        const { ipRouter, listName } = parsed;
        const creds = pickCreds(parsed);

        if (!ipRouter || !listName) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            message: 'Faltan parámetros: ipRouter, listName'
          }));
          return;
        }

        console.log(`[Request] Limpiando address-list "${listName}" en ${ipRouter}`);
        const result = await clearFirewallAddressList(ipRouter, listName, creds);

        res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        console.error('[Error]', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Error interno' }));
      }
    });
    return;
  }

  // Limpiar address-list en batch (varios routers a la vez)
  if (req.method === 'POST' && req.url === '/firewall/address-list/clear-batch') {
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { listName, routers, concurrency } = JSON.parse(body);

        if (!listName || !Array.isArray(routers) || routers.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            message: 'Faltan parámetros: listName (string), routers (array no vacío de IPs)'
          }));
          return;
        }

        // Validar que todas las entradas sean strings
        if (!routers.every(r => typeof r === 'string' && r.length > 0)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            message: 'routers debe ser un array de IPs (strings)'
          }));
          return;
        }

        // Concurrencia: default 10, mínimo 1, máximo 20
        const conc = Math.min(Math.max(parseInt(concurrency || 10, 10) || 10, 1), 20);

        console.log(`[Request] Batch clear address-list "${listName}" en ${routers.length} routers (concurrencia=${conc})`);
        const result = await clearFirewallAddressListBatch(routers, listName, conc);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        console.error('[Error]', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Error interno: ' + error.message }));
      }
    });
    return;
  }

  // Remove address-list por comment (un router, uno o varios comments)
  if (req.method === 'POST' && req.url === '/firewall/address-list/remove-by-comment') {
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        const { ipRouter, comment, comments } = parsed;
        const list = Array.isArray(comments) ? comments : (comment ? [comment] : []);
        const creds = pickCreds(parsed);

        if (!ipRouter || list.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            message: 'Faltan parámetros: ipRouter, comment (string) o comments (array)'
          }));
          return;
        }

        console.log(`[Request] Remove address-list por comment en ${ipRouter} (${list.length} comments)`);
        const result = await removeAddressListByComments(ipRouter, list, creds);

        res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        console.error('[Error]', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Error interno' }));
      }
    });
    return;
  }

  // Remove address-list por comment en batch (varios routers con sus comments)
  if (req.method === 'POST' && req.url === '/firewall/address-list/remove-by-comment-batch') {
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { groups, concurrency } = JSON.parse(body);

        if (!Array.isArray(groups) || groups.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            message: 'Falta parámetro: groups (array no vacío de { ipRouter, comments[] })'
          }));
          return;
        }

        const valid = groups.every(g =>
          g && typeof g.ipRouter === 'string' && g.ipRouter.length > 0 &&
          Array.isArray(g.comments) && g.comments.length > 0 &&
          g.comments.every(c => typeof c === 'string' && c.length > 0)
        );
        if (!valid) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            message: 'Cada group debe tener { ipRouter: string, comments: string[] no vacío }'
          }));
          return;
        }

        const conc = Math.min(Math.max(parseInt(concurrency || 10, 10) || 10, 1), 20);
        const totalComments = groups.reduce((s, g) => s + g.comments.length, 0);
        console.log(`[Request] Batch remove address-list por comment: ${groups.length} routers, ${totalComments} comments (concurrencia=${conc})`);
        const result = await removeAddressListByCommentsBatch(groups, conc);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        console.error('[Error]', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Error interno: ' + error.message }));
      }
    });
    return;
  }

  // Reboot ONT vía SmartOLT (Huawei)
  if (req.method === 'POST' && req.url === '/ont/reboot') {
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { ipRouter, pppUser } = JSON.parse(body);

        if (!ipRouter || !pppUser) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            message: 'Faltan parámetros: ipRouter, pppUser'
          }));
          return;
        }

        console.log(`[Request] Reboot ONT ${pppUser} en ${ipRouter}`);
        const result = await rebootOnt(ipRouter, pppUser);

        res.writeHead(result.success ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        console.error('[Error]', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Error interno' }));
      }
    });
    return;
  }

  // Crear usuario en MikroTik (/user add)
  if (req.method === 'POST' && req.url === '/user/create') {
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        const { ipRouter, name, password, group } = parsed;
        const creds = pickCreds(parsed);

        if (!ipRouter || !name || !password || !group) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            message: 'Faltan parámetros: ipRouter, name, password, group'
          }));
          return;
        }

        console.log(`[Request] Crear user "${name}" group="${group}" en ${ipRouter}`);
        const result = await createMikrotikUser(ipRouter, name, password, group, creds);

        res.writeHead(result.success ? 200 : (result.alreadyExists ? 409 : 502), { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        console.error('[Error]', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Error interno' }));
      }
    });
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'Not found' }));
});

// ==================== INICIAR SERVIDOR Y CRON ====================

server.listen(PORT, () => {
  console.log(`\n🚀 Status Proxy corriendo en http://localhost:${PORT}`);
  console.log(`📡 Endpoints:`);
  console.log(`   GET  /health       - Health check`);
  console.log(`   POST /ping            - Verificar estado PPPoE (requiere Authorization header)`);
  console.log(`   POST /ppp/disconnect  - Desconectar sesión PPPoE MikroTik (requiere Authorization header)`);
  console.log(`   POST /ont/reboot      - Reboot ONT vía SmartOLT Huawei (requiere Authorization header)`);
  console.log(`   POST /firewall/address-list/clear       - Limpiar address-list MikroTik (requiere Authorization header)`);
  console.log(`   POST /firewall/address-list/clear-batch - Limpiar address-list en varios routers (requiere Authorization header)`);
  console.log(`   POST /firewall/address-list/remove-by-comment       - Remove entries por comment (requiere Authorization header)`);
  console.log(`   POST /firewall/address-list/remove-by-comment-batch - Remove por comment en varios routers (requiere Authorization header)`);
  console.log(`   POST /monitor/run     - Ejecutar monitoreo manual (requiere Authorization header)`);
  console.log(`\n📊 Modo: Verificación de sesión PPPoE (sin ping ICMP)`);
  console.log(`⏰ Cron job de monitoreo: cada hora`);

  // Configurar cron job para ejecutar cada hora
  // '0 * * * *' = minuto 0 de cada hora
  cron.schedule('0 * * * *', () => {
    console.log('\n[Cron] Ejecutando monitoreo programado...');
    runMonitoringCycle().catch(console.error);
  });

  console.log(`\n✅ Servidor listo y cron configurado\n`);

  // Ejecutar monitoreo inicial al arrancar (opcional - descomenta si lo deseas)
  // console.log('[Startup] Ejecutando monitoreo inicial...');
  // runMonitoringCycle().catch(console.error);
});
