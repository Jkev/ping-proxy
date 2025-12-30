require('dotenv').config();
const http = require('http');
const { RouterOSAPI } = require('routeros');

// Configuración
const PORT = 3001;
const API_KEY = process.env.PROXY_API_KEY || 'tu-api-key-secreta-aqui';
const MIKROTIK_USER = process.env.MIKROTIK_USER || 'mario';
const MIKROTIK_PASSWORD = process.env.MIKROTIK_PASSWORD || 'dnw.25%#D2o%';
const MIKROTIK_PORT = parseInt(process.env.MIKROTIK_PORT || '8728', 10);

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

      return {
        lastLinkUpTime: iface['last-link-up-time'] || null,
        uptime,
        linkDowns: parseInt(iface['link-downs'] || '0', 10),
        rxBytes: parseInt(iface['rx-byte'] || '0', 10),
        txBytes: parseInt(iface['tx-byte'] || '0', 10),
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

      return {
        lastLinkUpTime: iface['last-link-up-time'] || null,
        uptime,
        linkDowns: parseInt(iface['link-downs'] || '0', 10),
        rxBytes: parseInt(iface['rx-byte'] || '0', 10),
        txBytes: parseInt(iface['tx-byte'] || '0', 10),
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

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
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

server.listen(PORT, () => {
  console.log(`🚀 Ping Proxy corriendo en http://localhost:${PORT}`);
  console.log(`📡 Endpoints:`);
  console.log(`   GET  /health - Health check`);
  console.log(`   POST /ping   - Ejecutar ping (requiere Authorization header)`);
  console.log(`                  Body: { ipRouter, clientIp, pppUser? }`);
});
