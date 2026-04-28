const fs = require('fs');
const path = require('path');

const TOKEN = 'YnlRR3ZnSkhnV0h1MlBEQUdsdzhpdz09';
const BASE = 'https://portal.digy.mx/api/v1';
const IDS_FILE = path.join(__dirname, '.tmp_client_ids.txt');
const OUT_JSON = path.join(__dirname, '..', 'clientes-routers.json');
const OUT_CSV = path.join(__dirname, '..', 'clientes-routers.csv');
const CONCURRENCY = 12;

const ids = fs.readFileSync(IDS_FILE, 'utf8')
  .split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(Number);

async function postJson(url, body, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
}

const getClient = (idcliente) => postJson(`${BASE}/GetClientsDetails`, { token: TOKEN, idcliente });
const getRouter = (id) => postJson(`${BASE}/GetRouters`, { token: TOKEN, id });

async function pool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  let done = 0;
  async function run() {
    while (cursor < items.length) {
      const idx = cursor++;
      try { results[idx] = await worker(items[idx], idx); }
      catch (e) { results[idx] = { __error: e.message }; }
      done++;
      if (done % 25 === 0 || done === items.length) {
        process.stdout.write(`\r  ${done}/${items.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, run));
  process.stdout.write('\n');
  return results;
}

(async () => {
  console.log(`Fetching ${ids.length} clients (concurrency=${CONCURRENCY})...`);
  const clientResponses = await pool(ids, CONCURRENCY, getClient);

  const clientRows = clientResponses.map((r, i) => {
    const id = ids[i];
    if (r.__error) return { idCliente: id, error: r.__error };
    if (r.estado !== 'exito' || !Array.isArray(r.datos) || !r.datos[0]) {
      return { idCliente: id, error: 'sin_datos' };
    }
    const d = r.datos[0];
    const svc = Array.isArray(d.servicios) && d.servicios[0];
    return {
      idCliente: d.id,
      nombreCliente: d.nombre,
      estado: d.estado,
      idRouter: svc ? svc.nodo : null,
      pppuser: svc ? svc.pppuser : null,
    };
  });

  const routerIds = [...new Set(clientRows.map(c => c.idRouter).filter(v => v !== null && v !== undefined))];
  console.log(`Fetching ${routerIds.length} unique routers...`);
  const routerResponses = await pool(routerIds, 6, getRouter);

  const routerMap = new Map();
  routerResponses.forEach((r, i) => {
    if (r.__error) return;
    if (r.estado === 'exito' && Array.isArray(r.routers) && r.routers[0]) {
      routerMap.set(routerIds[i], r.routers[0]);
    }
  });

  const final = clientRows.map(c => {
    const r = c.idRouter != null ? routerMap.get(c.idRouter) : null;
    return {
      idCliente: c.idCliente,
      nombreCliente: c.nombreCliente || '',
      estado: c.estado || '',
      pppuser: c.pppuser || '',
      idRouter: c.idRouter ?? '',
      nombreRouter: r ? r.nombre : '',
      ipRouter: r ? r.ip : '',
      error: c.error || '',
    };
  });

  fs.writeFileSync(OUT_JSON, JSON.stringify(final, null, 2));

  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['idCliente','nombreCliente','estado','pppuser','idRouter','nombreRouter','ipRouter','error'];
  const csv = [header.join(',')]
    .concat(final.map(row => header.map(h => esc(row[h])).join(',')))
    .join('\n');
  fs.writeFileSync(OUT_CSV, csv);

  const errs = final.filter(f => f.error).length;
  const noRouter = final.filter(f => !f.error && !f.ipRouter).length;
  console.log(`\nTotal: ${final.length}`);
  console.log(`Con error de cliente: ${errs}`);
  console.log(`Sin IP de router: ${noRouter}`);
  console.log(`Routers únicos: ${routerMap.size}`);
  console.log(`\nArchivos generados:\n  ${OUT_JSON}\n  ${OUT_CSV}`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
