require('dotenv').config();
const fetch = require('node-fetch');

const PROXY_URL = process.env.PROXY_URL || 'http://localhost:3001';
const API_KEY = process.env.PROXY_API_KEY;
const LIST_NAME = process.argv[2] || 'morosos';
const CONCURRENCY = parseInt(process.argv[3] || '10', 10);

const ROUTERS = [
  { id: 4, nombre: 'Colatlan / Terrero/Aguacate Colatlan', ip: '10.2.1.120' },
  { id: 5, nombre: 'Tepetzintla', ip: '10.1.1.30' },
  { id: 6, nombre: 'Montes, Ojite, Belem, San Miguel, Xuchitl, Km 33, Rancho Nuevo', ip: '10.5.1.60' },
  { id: 7, nombre: 'Temapache', ip: '10.4.1.14' },
  { id: 8, nombre: 'Llano Enmedio / Puyecaco / Tizal', ip: '10.1.1.98' },
  { id: 9, nombre: 'Palo Blanco', ip: '10.1.1.125' },
  { id: 10, nombre: 'Soledad, OJital 1, La Palma', ip: '10.2.1.125' },
  { id: 11, nombre: 'Boxter', ip: '10.2.1.124' },
  { id: 12, nombre: 'La Defensa', ip: '10.5.1.40' },
  { id: 13, nombre: 'Tincontlan', ip: '10.2.1.122' },
  { id: 14, nombre: 'Providencia Y Aquiles', ip: '10.2.1.121' },
  { id: 15, nombre: 'Mequetla', ip: '10.2.1.123' },
  { id: 16, nombre: 'Nuevo Jalisco, Moralillo, Palmareal', ip: '10.2.1.126' },
  { id: 17, nombre: 'Agua Zarca, Venustiano, Heroes', ip: '10.2.1.128' },
  { id: 18, nombre: 'Tuxpan, Chacoaco, Fidel Herrera, Cruz Naranjos, Juana Moza', ip: '10.2.1.18' },
  { id: 19, nombre: 'Concepcion', ip: '10.2.1.129' },
  { id: 20, nombre: 'Bejucal', ip: '10.2.1.130' },
  { id: 21, nombre: 'Adalberto Tejeda, La Estacion, Puerta 7', ip: '10.5.1.12' },
  { id: 22, nombre: 'Tzocohuite, Naranjo Dulce', ip: '10.5.1.13' },
  { id: 23, nombre: 'Lomas De Vinazco, Manantial, Aguacate Vinazco', ip: '10.5.1.15' },
  { id: 24, nombre: 'Chijolito, Dorado, Ahuacapa', ip: '10.5.1.14' },
  { id: 25, nombre: 'La Pita, Guaguaco, Apachahuatl', ip: '10.5.1.17' },
  { id: 26, nombre: 'La Reforma, Lechecuatitla', ip: '10.5.1.18' },
  { id: 27, nombre: 'Guayabo, Cacahuatengo', ip: '10.5.1.16' },
  { id: 28, nombre: 'La Barranca, Monte Chiquito', ip: '10.5.1.21' },
  { id: 29, nombre: 'San Fernando, Pedrera, Constitucion, Chijolito', ip: '10.5.1.28' },
  { id: 30, nombre: 'Hidalgo Amajac', ip: '10.5.1.29' },
  { id: 31, nombre: 'Peña de Afuera', ip: '10.4.1.101' },
  { id: 32, nombre: 'Kilometro 25, 31', ip: '10.4.1.102' },
  { id: 33, nombre: 'Emiliano Zapata', ip: '10.2.1.131' },
  { id: 34, nombre: 'Paso Del Perro', ip: '10.2.1.132' },
  { id: 35, nombre: 'Paso Arroyo, Tecomate, Tixtepec, Altamirano', ip: '10.2.1.133' },
  { id: 36, nombre: 'Ojital Santa Maria, Ciruelo, Habana, Esfuerzo, Cerro Plumaje', ip: '10.5.1.36' },
  { id: 37, nombre: 'Buenos Aires', ip: '10.4.1.12' },
  { id: 38, nombre: 'Ixcacuatitla', ip: '10.2.1.134' },
  { id: 39, nombre: 'Camotipan, Tlanempa, Chote, Cuatecometl', ip: '10.2.1.135' },
  { id: 40, nombre: 'Benito Juarez / Hueycuatitla', ip: '10.2.1.14' },
  { id: 41, nombre: 'Palma Real, Reforma, Paraje, Tolico', ip: '10.1.1.95' },
  { id: 42, nombre: 'Tamiahua, Tampache, Palo Blanco', ip: '10.4.1.92' },
  { id: 43, nombre: 'Espinal', ip: '10.3.1.180' },
  { id: 44, nombre: 'Tantalamos', ip: '10.4.1.96' },
  { id: 45, nombre: 'Tierra Blanca Pista', ip: '10.4.1.103' },
  { id: 46, nombre: 'El Idolo', ip: '10.4.1.97' },
  { id: 47, nombre: 'Kilometro 10, 15, 12, 8, 19', ip: '10.4.1.35' },
  { id: 48, nombre: 'Camelia, Coloman, Arroyo, Venustiano, San Lorenzo, Paso Norte', ip: '10.4.1.52' },
  { id: 49, nombre: 'Tlamaya', ip: '10.1.1.97' },
  { id: 50, nombre: 'Entabladero / Arenal/ Pacifico', ip: '10.4.1.104' },
  { id: 51, nombre: 'Coyutla, Mecatlan, Filomeno Mata', ip: '10.4.1.108' },
  { id: 52, nombre: 'Barra Galindo', ip: '10.4.1.80' },
  { id: 53, nombre: 'La Piedad', ip: '10.4.1.94' },
  { id: 54, nombre: 'Reyixtla, Xochimilco, Limon, Tecalco', ip: '10.1.1.88' },
  { id: 55, nombre: 'Potrero, Otatal', ip: '10.2.1.136' },
  { id: 57, nombre: 'La Encantada', ip: '10.4.1.105' },
  { id: 58, nombre: 'Ixcatepec', ip: '10.7.1.10' },
  { id: 59, nombre: 'Cazones, Caristay, Cabellal 1', ip: '10.4.1.109' },
  { id: 60, nombre: 'Barra de Cazones, Playa Azul, Tres Cruces y Buena Vista', ip: '10.4.1.110' },
  { id: 61, nombre: 'Cerro Azul / Juan Felipe', ip: '10.1.1.108' },
  { id: 62, nombre: 'Mesa de Ahuayo, Las Mesas', ip: '10.1.1.99' },
  { id: 63, nombre: 'La Loma, La Joya', ip: '10.4.1.98' },
  { id: 65, nombre: 'Lindero', ip: '10.4.1.85' },
  { id: 66, nombre: 'Kilometro 26 Temapache', ip: '10.4.1.16' },
  { id: 67, nombre: 'Brasilar', ip: '10.4.1.17' },
  { id: 68, nombre: 'FTTH Rancho Palmas', ip: '10.4.1.111' },
  { id: 69, nombre: 'Coyol Norte', ip: '10.4.1.112' },
  { id: 71, nombre: 'La Majahua', ip: '10.4.1.113' },
  { id: 72, nombre: 'Tierra Blanca Tepetzintla', ip: '10.1.1.81' },
  { id: 73, nombre: 'Apachi Cruz', ip: '10.1.1.86' },
  { id: 74, nombre: 'Tlacolula', ip: '10.1.1.80' },
  { id: 79, nombre: 'Sauce', ip: '10.4.1.114' },
  { id: 80, nombre: 'Tepetate, Pisa Flores y Rancho Nuevo', ip: '10.1.1.101' },
  { id: 81, nombre: 'FTTH Chintipan, Xalame', ip: '10.1.1.102' },
  { id: 82, nombre: 'FTTH Revancha', ip: '10.1.1.103' },
  { id: 83, nombre: 'El Ramal', ip: '10.4.1.115' },
  { id: 84, nombre: 'FTTH Ixtapa Chiapas', ip: '10.199.199.2' },
  { id: 85, nombre: 'Tierra Colorada', ip: '10.1.1.104' },
  { id: 86, nombre: 'Puxtla Martinica Cedral Joloapan Tres Naciones', ip: '10.3.1.181' },
  { id: 87, nombre: 'FTTH Santiago', ip: '10.5.100.22' },
  { id: 88, nombre: 'FTTH AZTLAN CHIAPAS', ip: '10.199.199.9' },
  { id: 89, nombre: 'FTTH La Ceiba Cazones', ip: '10.4.1.116' },
  { id: 90, nombre: 'FTTH Pantepec', ip: '10.3.1.182' },
  { id: 93, nombre: 'FTTH MECAPALAPA', ip: '10.3.1.183' },
  { id: 96, nombre: 'FTTH San Lorenzo Achiotepec', ip: '10.1.1.109' },
  { id: 98, nombre: 'FTTH OTLAZINTLA', ip: '10.1.1.132' },
  { id: 99, nombre: 'FFTH El Salto', ip: '10.4.1.117' },
  { id: 100, nombre: 'FTTH Zona Tohaco', ip: '10.5.1.61' },
  { id: 101, nombre: 'Zacamixtle, Ignacio Zaragoza y Monte Grande', ip: '10.1.1.110' },
  { id: 102, nombre: 'FTTH Mozutla Cazones', ip: '10.4.1.72' },
  { id: 103, nombre: 'FTTH Diaz Miron', ip: '10.3.1.206' },
];

function ts() {
  return new Date().toISOString().split('T')[1].slice(0, 8);
}

async function clearOne(router, idx, total) {
  const tag = `[${idx + 1}/${total}] id=${router.id} ${router.ip}`;
  const start = Date.now();
  console.log(`${ts()} ${tag} → Enviando POST /firewall/address-list/clear (list="${LIST_NAME}")`);

  try {
    const res = await fetch(`${PROXY_URL}/firewall/address-list/clear`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ ipRouter: router.ip, listName: LIST_NAME }),
    });

    const data = await res.json().catch(() => ({}));
    const elapsed = Date.now() - start;

    if (res.ok && data.success) {
      console.log(`${ts()} ${tag} ✅ OK (${elapsed}ms) — ${data.removed} entradas removidas`);
      return { router, ok: true, removed: data.removed, elapsed, message: data.message };
    } else {
      console.log(`${ts()} ${tag} ❌ FAIL (${elapsed}ms) — HTTP ${res.status}: ${data.message || 'sin mensaje'}`);
      return { router, ok: false, elapsed, status: res.status, message: data.message || `HTTP ${res.status}` };
    }
  } catch (err) {
    const elapsed = Date.now() - start;
    console.log(`${ts()} ${tag} ❌ ERROR (${elapsed}ms) — ${err.message}`);
    return { router, ok: false, elapsed, message: err.message };
  }
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function next() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx, items.length);
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(runners);
  return results;
}

async function main() {
  if (!API_KEY) {
    console.error('❌ Falta PROXY_API_KEY en variables de entorno (.env)');
    process.exit(1);
  }

  console.log('========================================');
  console.log(`  Batch clear address-list "${LIST_NAME}"`);
  console.log('========================================');
  console.log(`Proxy URL    : ${PROXY_URL}`);
  console.log(`Routers      : ${ROUTERS.length}`);
  console.log(`Concurrencia : ${CONCURRENCY}`);
  console.log(`Inicio       : ${new Date().toISOString()}`);
  console.log('========================================\n');

  const t0 = Date.now();
  const results = await runWithConcurrency(ROUTERS, CONCURRENCY, clearOne);
  const totalElapsed = Date.now() - t0;

  const ok = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);
  const totalRemoved = ok.reduce((sum, r) => sum + (r.removed || 0), 0);

  console.log('\n========================================');
  console.log('  RESULTADOS');
  console.log('========================================');
  console.log(`Total          : ${results.length}`);
  console.log(`✅ Exitosos     : ${ok.length}`);
  console.log(`❌ Fallidos     : ${failed.length}`);
  console.log(`Entradas borradas (sumadas): ${totalRemoved}`);
  console.log(`Tiempo total   : ${(totalElapsed / 1000).toFixed(1)}s`);
  console.log('========================================\n');

  if (ok.length > 0) {
    console.log('--- ✅ EXITOSOS ---');
    for (const r of ok) {
      console.log(`  id=${String(r.router.id).padStart(3)}  ${r.router.ip.padEnd(18)}  removed=${String(r.removed).padStart(4)}  (${r.elapsed}ms)  ${r.router.nombre}`);
    }
    console.log('');
  }

  if (failed.length > 0) {
    console.log('--- ❌ FALLIDOS ---');
    for (const r of failed) {
      console.log(`  id=${String(r.router.id).padStart(3)}  ${r.router.ip.padEnd(18)}  (${r.elapsed}ms)  ${r.router.nombre}`);
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
