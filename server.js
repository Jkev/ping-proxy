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

// SheetBest y MikroWisp config
const SHEETBEST_API_URL = process.env.SHEETBEST_API_URL || '';
const MIKROWISP_API_URL = process.env.MIKROWISP_API_URL || '';
const MIKROWISP_TOKEN = process.env.MIKROWISP_TOKEN || '';

// ==================== FUNCIONES DE PING ====================

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
        const linkUp = new Date(iface['last-link-up-time'].replace(' ', 'T'));
        const now = new Date();
        const diffMs = now - linkUp;
        const diffHrs = Math.floor(diffMs / 3600000);
        const diffMins = Math.floor((diffMs % 3600000) / 60000);
        uptime = `${diffHrs}h ${diffMins}m`;
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
        const linkUp = new Date(iface['last-link-up-time'].replace(' ', 'T'));
        const now = new Date();
        const diffMs = now - linkUp;
        const diffHrs = Math.floor(diffMs / 3600000);
        const diffMins = Math.floor((diffMs % 3600000) / 60000);
        uptime = `${diffHrs}h ${diffMins}m`;
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

async function pingFromRouter(routerIp, targetIp, pppUser = null) {
  console.log(`[Ping] Conectando a router ${routerIp}:${MIKROTIK_PORT}...`);

  const conn = new RouterOSAPI({
    host: routerIp,
    port: MIKROTIK_PORT,
    user: MIKROTIK_USER,
    password: MIKROTIK_PASSWORD,
    timeout: 15,
  });

  try {
    await conn.connect();
    console.log(`[Ping] Conexión exitosa, ejecutando ping a ${targetIp}...`);

    // Ejecutar ping
    const result = await conn.write('/ping', [
      '=address=' + targetIp,
      '=count=3',
    ]);

    console.log(`[Ping] Resultado:`, JSON.stringify(result));

    // Obtener info de conexión si se proporcionó pppUser
    let connectionInfo = null;
    if (pppUser) {
      connectionInfo = await getConnectionInfo(conn, pppUser);
    }

    await conn.close();

    if (result && result.length > 0) {
      let received = 0;
      let totalTime = 0;

      for (const item of result) {
        if (item.time) {
          received++;
          const timeMatch = item.time.match(/(\d+)/);
          if (timeMatch) {
            totalTime += parseInt(timeMatch[1], 10);
          }
        }
      }

      const sent = 3;
      const packetLoss = ((sent - received) / sent) * 100;
      const avgLatency = received > 0 ? Math.round(totalTime / received) : 0;

      if (received > 0) {
        return {
          success: true,
          status: 'online',
          latency: avgLatency,
          packetLoss,
          clientIp: targetIp,
          message: `${received}/${sent} paquetes recibidos, latencia: ${avgLatency}ms`,
          connectionInfo,
        };
      } else {
        return {
          success: true,
          status: 'offline',
          packetLoss: 100,
          clientIp: targetIp,
          message: 'No se recibieron respuestas (100% packet loss)',
          connectionInfo,
        };
      }
    }

    return {
      success: false,
      status: 'error',
      clientIp: targetIp,
      message: 'No se obtuvieron resultados del ping',
      connectionInfo,
    };
  } catch (error) {
    console.error('[Ping] Error:', error.message);
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

async function getClientData(idCliente) {
  try {
    const response = await fetch(`${MIKROWISP_API_URL}/api/v1/GetClientsDetails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: MIKROWISP_TOKEN,
        idcliente: parseInt(idCliente, 10),
      }),
    });

    const data = await response.json();

    if (data.estado === 'exito' && data.datos?.[0]?.servicios?.[0]) {
      const servicio = data.datos[0].servicios[0];
      if (servicio.ip) {
        return {
          ip: servicio.ip,
          pppUser: servicio.pppuser || '',
        };
      }
    }
    return null;
  } catch (error) {
    console.error(`[Monitor] Error getting client data for ${idCliente}:`, error.message);
    return null;
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
  const now = new Date();
  const year = now.getFullYear();
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const seconds = now.getSeconds().toString().padStart(2, '0');
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

  if (!SHEETBEST_API_URL || !MIKROWISP_API_URL || !MIKROWISP_TOKEN) {
    console.error('[Monitor] Faltan variables de entorno para monitoreo');
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
    const idCliente = report.idCliente;
    const ipRouter = report.ipRouter;

    console.log(`\n[Monitor] [${processed}/${activeReports.length}] Procesando ticket ${idTicket}...`);

    // Parsear historial existente
    const existingHistory = parseJsonSafe(report.historialMonitoreo) || [];

    // Si no tiene ipRouter, marcar como no monitoreable
    if (!ipRouter) {
      console.log(`[Monitor] Ticket ${idTicket}: Sin ipRouter - No monitoreable`);

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

    // Obtener datos del cliente de MikroWisp
    const clientData = await getClientData(idCliente);

    if (!clientData?.ip) {
      console.log(`[Monitor] Ticket ${idTicket}: No se pudo obtener IP del cliente`);

      const newEntry = {
        timestamp: getCurrentTimestamp(),
        status: 'error',
      };

      const newLastStatus = {
        status: 'error',
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

    // Ejecutar ping
    console.log(`[Monitor] Ticket ${idTicket}: Ping a ${clientData.ip} via ${ipRouter}`);
    const pingResult = await pingFromRouter(ipRouter, clientData.ip, clientData.pppUser);

    // Crear entrada de historial
    const newEntry = {
      timestamp: getCurrentTimestamp(),
      status: pingResult.status,
      latency: pingResult.latency,
      uptime: pingResult.connectionInfo?.uptime,
    };

    // Crear último status
    const newLastStatus = {
      status: pingResult.status,
      timestamp: getCurrentTimestamp(),
      uptime: pingResult.connectionInfo?.uptime,
      latency: pingResult.latency,
    };

    console.log(`[Monitor] Ticket ${idTicket}: ${pingResult.status} ${pingResult.latency ? `(${pingResult.latency}ms)` : ''}`);

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

        console.log(`[Request] Ping desde ${ipRouter} hacia ${clientIp}${pppUser ? ` (user: ${pppUser})` : ''}`);
        const result = await pingFromRouter(ipRouter, clientIp, pppUser);

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
  console.log(`\n🚀 Ping Proxy corriendo en http://localhost:${PORT}`);
  console.log(`📡 Endpoints:`);
  console.log(`   GET  /health       - Health check`);
  console.log(`   POST /ping         - Ejecutar ping (requiere Authorization header)`);
  console.log(`   POST /monitor/run  - Ejecutar monitoreo manual (requiere Authorization header)`);
  console.log(`\n⏰ Cron job de monitoreo: cada hora`);

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
