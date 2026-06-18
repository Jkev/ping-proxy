require('dotenv').config();
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const PROXY_URL = process.env.PROXY_URL || 'http://localhost:3001';
const API_KEY = process.env.PROXY_API_KEY;

// CLI: node scripts/remove-by-comment-batch.js [commentPrefix] [concurrency] [--dry-run] [--input=file.json]
const args = process.argv.slice(2);
const flags = args.filter(a => a.startsWith('--'));
const positional = args.filter(a => !a.startsWith('--'));
const COMMENT_PREFIX = positional[0] || 'Corte_Servicio_';
const CONCURRENCY = parseInt(positional[1] || '10', 10);
const DRY_RUN = flags.includes('--dry-run');
const inputArg = flags.find(f => f.startsWith('--input='));
const INPUT = inputArg ? inputArg.split('=')[1] : path.join(__dirname, '..', 'clientes-routers.json');

function ts() {
  return new Date().toISOString().split('T')[1].slice(0, 8);
}

function loadAndGroup() {
  if (!fs.existsSync(INPUT)) {
    console.error(`No se encontró el archivo de entrada: ${INPUT}`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  // El address-list `morosos` del MikroTik se llavea por comment="Corte_Servicio_<idservicio>"
  // (NO idCliente ni pppuser). Por eso exigimos y usamos idservicio.
  const valid = data.filter(d => d.idservicio && d.ipRouter && !d.error);

  const byIp = new Map();
  for (const c of valid) {
    if (!byIp.has(c.ipRouter)) {
      byIp.set(c.ipRouter, { ipRouter: c.ipRouter, nombreRouter: c.nombreRouter || '', comments: [], clientes: [] });
    }
    const g = byIp.get(c.ipRouter);
    const comment = `${COMMENT_PREFIX}${c.idservicio}`;
    g.comments.push(comment);
    g.clientes.push({ idCliente: c.idCliente, idservicio: c.idservicio, nombre: c.nombreCliente, comment });
  }

  return { groups: Array.from(byIp.values()), totalClientes: valid.length };
}

async function main() {
  if (!API_KEY) {
    console.error('Falta PROXY_API_KEY en variables de entorno (.env)');
    process.exit(1);
  }

  const { groups, totalClientes } = loadAndGroup();
  const totalComments = groups.reduce((s, g) => s + g.comments.length, 0);

  console.log('========================================');
  console.log(`  Batch remove address-list por comment`);
  console.log('========================================');
  console.log(`Proxy URL      : ${PROXY_URL}`);
  console.log(`Input          : ${INPUT}`);
  console.log(`Comment prefix : "${COMMENT_PREFIX}"  (ej: ${COMMENT_PREFIX}<idservicio>)`);
  console.log(`Clientes       : ${totalClientes}`);
  console.log(`Routers        : ${groups.length}`);
  console.log(`Comments total : ${totalComments}`);
  console.log(`Concurrencia   : ${CONCURRENCY}`);
  console.log(`Dry-run        : ${DRY_RUN ? 'SI (no se enviará nada)' : 'no'}`);
  console.log(`Inicio         : ${new Date().toISOString()}`);
  console.log('========================================\n');

  console.log('--- Distribución por router (top 15) ---');
  const sorted = [...groups].sort((a, b) => b.comments.length - a.comments.length);
  for (const g of sorted.slice(0, 15)) {
    console.log(`  ${String(g.comments.length).padStart(3)}  ${g.ipRouter.padEnd(18)}  ${g.nombreRouter}`);
  }
  if (sorted.length > 15) console.log(`  ...y ${sorted.length - 15} routers más`);
  console.log('');

  if (DRY_RUN) {
    const sample = groups[0];
    console.log('--- Sample group (primer router) ---');
    console.log(`  ipRouter: ${sample.ipRouter}`);
    console.log(`  comments[0..4]: ${sample.comments.slice(0, 5).join(', ')}${sample.comments.length > 5 ? ', ...' : ''}`);
    console.log('\nDry-run completo. No se envió nada.');
    return;
  }

  // Payload para /firewall/address-list/remove-by-comment-batch
  const payload = {
    groups: groups.map(g => ({ ipRouter: g.ipRouter, comments: g.comments })),
    concurrency: CONCURRENCY,
  };

  console.log(`${ts()} → POST ${PROXY_URL}/firewall/address-list/remove-by-comment-batch`);
  const t0 = Date.now();
  let res, data;
  try {
    res = await fetch(`${PROXY_URL}/firewall/address-list/remove-by-comment-batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(payload),
    });
    data = await res.json();
  } catch (err) {
    console.error(`${ts()} Error de red: ${err.message}`);
    process.exit(2);
  }
  const elapsed = Date.now() - t0;

  console.log(`${ts()} ← HTTP ${res.status}  (${(elapsed / 1000).toFixed(1)}s)`);
  console.log('');

  if (!res.ok || !data.success) {
    console.error('Respuesta de error:', JSON.stringify(data, null, 2));
    process.exit(1);
  }

  const { summary, results } = data;
  console.log('========================================');
  console.log('  RESULTADOS');
  console.log('========================================');
  console.log(`Total routers        : ${summary.total}`);
  console.log(`✅ Exitosos           : ${summary.ok}`);
  console.log(`❌ Fallidos           : ${summary.failed}`);
  console.log(`Entradas removidas   : ${summary.totalRemoved}`);
  console.log(`Tiempo total servidor: ${(summary.elapsedMs / 1000).toFixed(1)}s`);
  console.log(`Tiempo total cliente : ${(elapsed / 1000).toFixed(1)}s`);
  console.log('========================================\n');

  const ok = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  if (ok.length > 0) {
    console.log('--- ✅ EXITOSOS ---');
    for (const r of ok) {
      console.log(`  ${r.ipRouter.padEnd(18)}  comments=${String(r.commentsRequested).padStart(3)}  removed=${String(r.removed).padStart(4)}  (${r.elapsed}ms)`);
    }
    console.log('');
  }

  if (failed.length > 0) {
    console.log('--- ❌ FALLIDOS ---');
    for (const r of failed) {
      console.log(`  ${r.ipRouter.padEnd(18)}  comments=${String(r.commentsRequested).padStart(3)}  (${r.elapsed}ms)`);
      console.log(`        → ${r.message}`);
    }
    console.log('');
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
