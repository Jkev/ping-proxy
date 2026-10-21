/**
 * Prueba de logica pura (sin OLT ni red): Otlazintla PON 2 (HCBD 2026-10-21). 46 ONUs completas
 * cuyo gemport trae un `portid` distinto (lo numera la OLT) y desc con el nombre del cliente, mas
 * 2 que la OLT agrego a medias (solo `onu add … profile default`). Antes ganaban las 2 a medias.
 *   node scripts/test-forma-auth-portid.js
 */
const assert = require('assert');
const { aprenderPlantillas, parseOnuBlocks, quitarPortid } = require('../olt-vsol');

let sn = 0;
const hex = () => (++sn).toString(16).toUpperCase().padStart(8, '0');
const completa = (id, portid) => [
  `onu add ${id} profile default sn VSOL${hex()}`,
  `onu ${id} desc Cliente_${id}_Apellido`,
  `onu ${id} tcont 1 dba vlan_1010`,
  `onu ${id} gemport 1 tcont 1 gemport_name gem_1 portid ${portid}`,
  `onu ${id} gemport 1 traffic-limit downstream default`,
  `onu ${id} service ser_1 gemport 1 vlan 1010`,
  `onu ${id} service-port 1 gemport 1 uservlan 1010 vlan 1010 new_cos 0`,
  `onu ${id} portvlan veip 1 mode transparent`,
  `onu ${id} pri wan_adv add route`,
];
const aMedias = (id) => [`onu add ${id} profile default sn VSOL${hex()}`];
function config(puertos) {
  const out = [];
  for (const [p, onus] of Object.entries(puertos)) {
    out.push(`interface gpon 0/${p}`);
    onus.forEach(([id, f]) => out.push(...f(id).map(l => ` ${l}`)));
    out.push('exit');
  }
  return out.join('\n');
}
const pon2 = [];
for (let id = 1; id <= 46; id++) pon2.push([id, (i) => completa(i, 144 + i)]);
pon2.push([47, aMedias], [48, aMedias]);
const run = config({ 2: pon2, 3: [[1, (i) => completa(i, 300)], [2, (i) => completa(i, 301)]] });
const FORMA = [
  'onu add {ID} profile default sn {SN}',
  'onu {ID} tcont 1 dba vlan_1010',
  'onu {ID} gemport 1 tcont 1 gemport_name gem_1',
  'onu {ID} gemport 1 traffic-limit downstream default',
  'onu {ID} service ser_1 gemport 1 vlan 1010',
  'onu {ID} service-port 1 gemport 1 uservlan 1010 vlan 1010 new_cos 0',
  'onu {ID} portvlan veip 1 mode transparent',
];
// Lo mismo que hace la rama `dup` de oltAuthorizeAprendido: lineas de la plantilla que la ONU no tiene.
const faltanEn = (cfg, key, lineas, id) => {
  const tiene = new Set((parseOnuBlocks(cfg).get(key) || []).map(l => quitarPortid(l).trim().toLowerCase()));
  return lineas.map(l => l.replace(/\{ID\}/g, String(id))).filter(l => !/^onu\s+add\b/i.test(l) && !tiene.has(l.trim().toLowerCase()));
};

let ok = 0;
function caso(nombre, fn) { fn(); ok++; console.log(`OK  ${nombre}`); }

caso('portid distinto por ONU ya no parte la forma: gana la completa, sin portid', () => {
  const p = aprenderPlantillas(run, { slot: 0, ponPort: 2 });
  assert.deepStrictEqual(p.auth.lineas, FORMA);
  assert.strictEqual(p.auth.fuente, 'puerto');
  // La ONU 1 queda aparte: su service-port 1 coincide con su id y normalizarLinea lo marca {ID}.
  assert.strictEqual(p.auth.coinciden, 45);
  assert.strictEqual(p.auth.total, 46);
  assert.ok(!p.auth.lineas.some(l => /portid/i.test(l)));
});

caso('la ONU a medias (2:48) recibe las 6 lineas de servicio que le faltan', () => {
  const p = aprenderPlantillas(run, { slot: 0, ponPort: 2 });
  const f = faltanEn(run, '0/2:48', p.auth.lineas, 48);
  assert.strictEqual(f.length, 6);
  assert.ok(f.includes('onu 48 service-port 1 gemport 1 uservlan 1010 vlan 1010 new_cos 0'));
});

caso('una ONU completa con portid no recibe nada (no se duplica el gemport)', () => {
  const p = aprenderPlantillas(run, { slot: 0, ponPort: 2 });
  assert.deepStrictEqual(faltanEn(run, '0/2:10', p.auth.lineas, 10), []);
});

caso('puerto con solo ONUs a medias toma la forma de la OLT', () => {
  const r2 = config({ 2: [[1, aMedias], [2, aMedias], [3, aMedias]], 3: Array.from({ length: 5 }, (_, i) => [i + 1, (id) => completa(id, 400 + id)]) });
  const p = aprenderPlantillas(r2, { slot: 0, ponPort: 2 });
  assert.deepStrictEqual(p.auth.lineas, FORMA);
  assert.strictEqual(p.auth.fuente, 'olt');
});

caso('quitarPortid solo toca el gemport', () => {
  assert.strictEqual(quitarPortid('onu 5 gemport 1 tcont 1 gemport_name gem_1 portid 145'), 'onu 5 gemport 1 tcont 1 gemport_name gem_1');
  assert.strictEqual(quitarPortid('onu 5 tcont 1 dba vlan_1010'), 'onu 5 tcont 1 dba vlan_1010');
});

console.log(`\n${ok} casos OK`);
