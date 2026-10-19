/**
 * Sesiones PPPoE reales por router («opción C» de MapaReportes-Digy).
 *
 * Cada hora (minuto 10, solo con SESIONES_ROUTERS_CRON=on) se lee `/ppp/active` de cada router
 * de MikroWisp y se le manda al panel, un POST por router, apenas se lee. El panel lo guarda en
 * `sesionesRouter/{routerId}` y su sincronización del minuto 20 decide con eso quién está
 * conectado (status_user de MikroWisp acierta 11 %).
 *
 *   GET  {base}/api/sesiones-routers/routers   → [{ id, nombre, ip, puerto }]
 *   POST {base}/api/sesiones-routers           ← { routerId, nombre, ip, consultadoEn, ok, mensaje, sesiones }
 *
 * Reglas:
 *  - Un login de API por router, pocos a la vez (SESIONES_ROUTERS_CONCURRENCIA, 3) y sin
 *    reintentos: el que falló se intenta en la siguiente hora.
 *  - Un solo recorrido a la vez (candado en memoria: el proxy es un solo proceso).
 *  - Tope de tiempo (SESIONES_ROUTERS_TOPE_MS, 7 min): lo que no alcanzó se manda como
 *    `ok: false, mensaje: 'sin turno'`. Una lectura empezada puede tardar hasta ~45 s más
 *    (15 s de conexión + 30 s del comando), así que la corrida acaba antes del minuto 20.
 *  - Un router que no responde se manda igual con `ok: false`: el panel conserva su última foto
 *    buena y deja a sus clientes «sin dato» en vez de marcarlos caídos.
 *  - SESIONES_ROUTERS_OMITIR="95,76" = routers que no hablan RouterOS (OLT Huawei, equipos sin
 *    API): se mandan como `ok: false, 'sin fuente'` sin intentar conectarse.
 *  - `name` va crudo: el panel normaliza el pppuser.
 *  - Modo prueba (`dryRun`): lee igual pero no manda nada; devuelve el resumen por router.
 */
const fetch = require('node-fetch');

const base = () => (process.env.SESIONES_ROUTERS_API_URL || process.env.MAPA_REPORTES_API_URL || 'https://mapa.dnw.mx').replace(/\/+$/, '');
const llave = () => process.env.SESIONES_ROUTERS_API_KEY || '';
const entero = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };
const omitidos = () => new Set(String(process.env.SESIONES_ROUTERS_OMITIR || '').split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite));

let enCurso = null; // { desde, dryRun }

async function pedirRouters() {
  const res = await fetch(`${base()}/api/sesiones-routers/routers`, {
    headers: { 'X-API-Key': llave() },
    timeout: 30000,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || !json.success || !Array.isArray(json.routers)) {
    throw new Error(`GET routers: HTTP ${res.status} ${(json && json.message) || ''}`.trim());
  }
  return json.routers;
}

async function enviar(cuerpo) {
  try {
    const res = await fetch(`${base()}/api/sesiones-routers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': llave() },
      body: JSON.stringify(cuerpo),
      timeout: 30000,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || !json.success) {
      return { enviado: false, error: `HTTP ${res.status} ${(json && json.message) || ''}`.trim() };
    }
    return { enviado: true, sospechosa: !!json.sospechosa };
  } catch (e) {
    return { enviado: false, error: e.message || String(e) };
  }
}

/**
 * @param {object} o
 * @param {(ip: string, creds: object|null) => Promise<{success: boolean, sessions: any[], message?: string}>} o.listarSesiones
 * @param {boolean} [o.dryRun]          no manda nada al panel
 * @param {boolean} [o.incluirNombres]  (solo dryRun) devuelve los `name` de cada router
 * @param {number[]} [o.ids]            solo estos routers
 */
async function correrSesionesRouters({ listarSesiones, dryRun = false, incluirNombres = false, ids = null }) {
  if (!llave()) return { success: false, message: 'SESIONES_ROUTERS_API_KEY no configurada' };
  if (enCurso) return { success: false, message: `ya hay una corrida en curso desde ${enCurso.desde}` };
  const t0 = Date.now();
  enCurso = { desde: new Date(t0).toISOString(), dryRun };
  const TAG = dryRun ? '[SesionesRouters:prueba]' : '[SesionesRouters]';
  try {
    let routers = await pedirRouters();
    if (Array.isArray(ids) && ids.length) {
      const quiero = new Set(ids.map(Number));
      routers = routers.filter((r) => quiero.has(Number(r.id)));
    }
    const concurrencia = entero(process.env.SESIONES_ROUTERS_CONCURRENCIA, 3);
    const tope = entero(process.env.SESIONES_ROUTERS_TOPE_MS, 7 * 60 * 1000);
    const omitir = omitidos();
    console.log(`${TAG} ${routers.length} routers, ${concurrencia} a la vez, tope ${Math.round(tope / 1000)} s`);

    const resultados = [];
    // Los omitidos no gastan turno: se resuelven primero y nunca caen en «sin turno».
    const pendientes = [...routers].sort((a, b) => Number(omitir.has(Number(b.id))) - Number(omitir.has(Number(a.id))));

    const procesar = async (r) => {
      const fila = { id: r.id, nombre: r.nombre || null, ip: r.ip, puerto: r.puerto || null };
      let ok = false, mensaje = null, sesiones = [], ms = 0;
      if (omitir.has(Number(r.id))) {
        mensaje = 'sin fuente: el router no habla RouterOS API';
      } else {
        const inicio = Date.now();
        const lectura = await listarSesiones(r.ip, r.puerto ? { port: Number(r.puerto) } : null)
          .catch((e) => ({ success: false, sessions: [], message: e.message }));
        ms = Date.now() - inicio;
        ok = !!lectura.success;
        mensaje = ok ? null : String(lectura.message || 'sin detalle').slice(0, 300);
        sesiones = ok ? (lectura.sessions || []).map((s) => ({ name: s.name, address: s.address || null, uptime: s.uptime || null })) : [];
      }
      const consultadoEn = new Date().toISOString();
      Object.assign(fila, { ok, mensaje, ms, total: sesiones.length });
      if (dryRun) {
        if (incluirNombres) fila.nombres = sesiones.map((s) => s.name);
      } else {
        const envio = await enviar({ routerId: Number(r.id), nombre: r.nombre || null, ip: r.ip, consultadoEn, ok, mensaje, sesiones });
        Object.assign(fila, envio);
      }
      resultados.push(fila);
    };

    const trabajador = async () => {
      while (pendientes.length) {
        if (Date.now() - t0 > tope) return;
        await procesar(pendientes.shift());
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrencia, pendientes.length) }, trabajador));

    // Lo que no alcanzó: se avisa para que el panel no lo tome por una foto vieja sin explicación.
    for (const r of pendientes) {
      const fila = { id: r.id, nombre: r.nombre || null, ip: r.ip, puerto: r.puerto || null, ok: false, mensaje: 'sin turno', ms: 0, total: 0 };
      if (!dryRun) Object.assign(fila, await enviar({ routerId: Number(r.id), nombre: r.nombre || null, ip: r.ip, consultadoEn: new Date().toISOString(), ok: false, mensaje: 'sin turno', sesiones: [] }));
      resultados.push(fila);
    }

    resultados.sort((a, b) => a.id - b.id);
    const resumen = {
      routers: resultados.length,
      ok: resultados.filter((x) => x.ok).length,
      fallaron: resultados.filter((x) => !x.ok).length,
      sesiones: resultados.reduce((s, x) => s + (x.total || 0), 0),
      ...(dryRun ? {} : { enviados: resultados.filter((x) => x.enviado).length, sospechosas: resultados.filter((x) => x.sospechosa).length }),
      ms: Date.now() - t0,
    };
    console.log(`${TAG} fin: ${JSON.stringify(resumen)}`);
    for (const x of resultados.filter((y) => !y.ok || (!dryRun && !y.enviado))) {
      console.log(`${TAG}   router ${x.id} ${x.nombre || ''} ${x.ip}: ${x.ok ? 'leído' : x.mensaje}${!dryRun && !x.enviado ? ` / no enviado: ${x.error}` : ''}`);
    }
    return { success: true, dryRun, resumen, resultados };
  } catch (e) {
    console.error(`${TAG} error:`, e.message);
    return { success: false, message: e.message };
  } finally {
    enCurso = null;
  }
}

module.exports = { correrSesionesRouters };
