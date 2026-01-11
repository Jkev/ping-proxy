require('dotenv').config();
const http = require('http');
const { RouterOSAPI } = require('routeros');
const cron = require('node-cron');
const fetch = require('node-fetch');

// Configuración
const PORT = 3001;
const API_KEY = process.env.PROXY_API_KEY || 'tu-api-key-secreta-aqui';
const MIKROTIK_USER = process.env.MIKROTIK_USER || 'mario';
const MIKROTIK_PASSWORD = process.env.MIKROTIK_PASSWORD || 'dnw.25%#D2o%';
const MIKROTIK_PORT = parseInt(process.env.MIKROTIK_PORT || '8728', 10);

// SheetBest config (ya no se necesita MikroWisp - ipClient viene de SheetBest)
const SHEETBEST_API_URL = process.env.SHEETBEST_API_URL || '';

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

      // Calcular uptime desde last-link-up-time
      let uptime = null;
      if (iface['last-link-up-time']) {
        const linkUp = parseMikroTikDate(iface['last-link-up-time']);
        if (linkUp) {
          const now = new Date();
          const diffMs = now - linkUp;
          const diffHrs = Math.floor(diffMs / 3600000);
          const diffMins = Math.floor((diffMs % 3600000) / 60000);
          uptime = `${diffHrs}h ${diffMins}m`;
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

    // Intentar sin brackets (por si acaso)
    const altName = `pppoe-${cleanUser}`;
    console.log(`[ConnectionInfo] Intentando sin brackets: ${altName}`);

    const altInterfaces = await conn.write('/interface/print', [
      '?name=' + altName,
    ]);

    if (altInterfaces && altInterfaces.length > 0) {
      const iface = altInterfaces[0];
      console.log(`[ConnectionInfo] Interfaz encontrada (alt):`, JSON.stringify(iface));

      // Calcular uptime desde last-link-up-time
      let uptime = null;
      if (iface['last-link-up-time']) {
        const linkUp = parseMikroTikDate(iface['last-link-up-time']);
        if (linkUp) {
          const now = new Date();
          const diffMs = now - linkUp;
          const diffHrs = Math.floor(diffMs / 3600000);
          const diffMins = Math.floor((diffMs % 3600000) / 60000);
          uptime = `${diffHrs}h ${diffMins}m`;
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

async function getClientStatus(routerIp, targetIp, pppUser = null) {
  console.log(`[Status] Conectando a router ${routerIp}:${MIKROTIK_PORT}...`);

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

  const conn = new RouterOSAPI({
    host: routerIp,
    port: MIKROTIK_PORT,
    user: MIKROTIK_USER,
    password: MIKROTIK_PASSWORD,
    timeout: 10,
  });

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

    if (isOnline) {
      console.log(`[Status] Cliente ONLINE - Sesión PPPoE activa, uptime: ${pppoeStatus.uptime || connectionInfo?.uptime || 'N/A'}`);
      return {
        success: true,
        status: 'online',
        latency: null,
        packetLoss: null,
        clientIp: targetIp,
        message: `Sesión PPPoE activa, uptime: ${pppoeStatus.uptime || connectionInfo?.uptime || 'N/A'}`,
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

// ==================== FUNCIONES DE MONITOREO AUTOMÁTICO ====================

async function fetchReports() {
  try {
    const response = await fetch(SHEETBEST_API_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error('[Monitor] Error fetching reports:', error.message);
    return [];
  }
}

async function updateReportInSheetBest(idTicket, updates) {
  try {
    const response = await fetch(`${SHEETBEST_API_URL}/idTicket/${idTicket}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });

    return response.ok;
  } catch (error) {
    console.error(`[Monitor] Error updating report ${idTicket}:`, error.message);
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

function parseJsonSafe(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

async function runMonitoringCycle() {
  console.log('\n========================================');
  console.log('[Monitor] Iniciando ciclo de monitoreo...');
  console.log('[Monitor] Timestamp:', getCurrentTimestamp());
  console.log('========================================\n');

  if (!SHEETBEST_API_URL) {
    console.error('[Monitor] Falta SHEETBEST_API_URL para monitoreo');
    return;
  }

  const reports = await fetchReports();
  console.log(`[Monitor] Total de reportes: ${reports.length}`);

  // Filtrar reportes activos (no resueltos/cerrados)
  const activeReports = reports.filter(r => {
    const estado = (r.estado || '').toLowerCase();
    return !['resuelto', 'cerrado'].includes(estado);
  });

  console.log(`[Monitor] Reportes activos: ${activeReports.length}`);

  let processed = 0;
  let updated = 0;
  let errors = 0;

  for (const report of activeReports) {
    processed++;
    const idTicket = report.idTicket;
    const ipRouter = report.ipRouter;
    const ipClient = report.ipClient;
    const pppUser = report.pppUser;

    console.log(`\n[Monitor] [${processed}/${activeReports.length}] Procesando ticket ${idTicket}...`);

    // Parsear historial existente
    const existingHistory = parseJsonSafe(report.historialMonitoreo) || [];

    // Si no tiene ipRouter o ipClient, marcar como no monitoreable
    if (!ipRouter || !ipClient) {
      const reason = !ipRouter ? 'Sin ipRouter' : 'Sin ipClient';
      console.log(`[Monitor] Ticket ${idTicket}: ${reason} - No monitoreable`);

      const newEntry = {
        timestamp: getCurrentTimestamp(),
        status: 'no_monitoreable',
      };

      const newLastStatus = {
        status: 'no_monitoreable',
        timestamp: getCurrentTimestamp(),
      };

      const success = await updateReportInSheetBest(idTicket, {
        lastStatusPing: JSON.stringify(newLastStatus),
        historialMonitoreo: JSON.stringify([...existingHistory, newEntry]),
      });

      if (success) updated++;
      else errors++;
      continue;
    }

    // Obtener estado del cliente (usando ipClient y pppUser directamente de SheetBest)
    console.log(`[Monitor] Ticket ${idTicket}: Verificando estado de ${pppUser || ipClient} via ${ipRouter}`);
    const statusResult = await getClientStatus(ipRouter, ipClient, pppUser);

    // Crear entrada de historial
    const newEntry = {
      timestamp: getCurrentTimestamp(),
      status: statusResult.status,
      uptime: statusResult.connectionInfo?.uptime || statusResult.pppoeStatus?.uptime,
      rxMB: statusResult.connectionInfo?.rxMB,
      txMB: statusResult.connectionInfo?.txMB,
    };

    // Crear último status
    const newLastStatus = {
      status: statusResult.status,
      timestamp: getCurrentTimestamp(),
      uptime: statusResult.connectionInfo?.uptime || statusResult.pppoeStatus?.uptime,
    };

    console.log(`[Monitor] Ticket ${idTicket}: ${statusResult.status} (uptime: ${newEntry.uptime || 'N/A'})`);

    // Actualizar en SheetBest
    const success = await updateReportInSheetBest(idTicket, {
      lastStatusPing: JSON.stringify(newLastStatus),
      historialMonitoreo: JSON.stringify([...existingHistory, newEntry]),
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
        const { ipRouter, clientIp, pppUser } = JSON.parse(body);

        if (!ipRouter || !clientIp) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            message: 'Faltan parámetros: ipRouter, clientIp'
          }));
          return;
        }

        console.log(`[Request] Verificando estado de ${pppUser || clientIp} via ${ipRouter}`);
        const result = await getClientStatus(ipRouter, clientIp, pppUser);

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

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'Not found' }));
});

// ==================== INICIAR SERVIDOR Y CRON ====================

server.listen(PORT, () => {
  console.log(`\n🚀 Status Proxy corriendo en http://localhost:${PORT}`);
  console.log(`📡 Endpoints:`);
  console.log(`   GET  /health       - Health check`);
  console.log(`   POST /ping         - Verificar estado PPPoE (requiere Authorization header)`);
  console.log(`   POST /monitor/run  - Ejecutar monitoreo manual (requiere Authorization header)`);
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
