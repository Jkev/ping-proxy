/**
 * Prueba de logica pura (sin OLT ni red): forma de autorizar cuando el puerto pedido
 * esta vacio (fuente 'puertos_olt'). Running-configs sinteticos.
 *   node scripts/test-forma-auth-puertos.js
 */
const assert = require('assert');
const { aprenderPlantillas } = require('../olt-vsol');

let sn = 0;
const hex = () => (++sn).toString(16).toUpperCase().padStart(8, '0');
const BUENA = ['onu add {ID} profile default sn {SN}', 'onu {ID} profile line name VLAN1010', 'onu {ID} profile srv name srv_1010'];
// Forma de Colatlan: perfiles VLAN1010/srv_1010.
const buena = (id) => [`onu add ${id} profile default sn GPON${hex()}`, `onu ${id} profile line name VLAN1010`, `onu ${id} profile srv name srv_1010`];
// Variantes viejas V-SOL, distintas entre si.
const vieja = (v) => (id) => [`onu add ${id} profile default sn GPON${hex()}`, `onu ${id} profile line name LINE${v}`, `onu ${id} profile srv name SRV${v}`];
// Otra marca en bridge (no es V-SOL).
const ping = (id) => [`onu add ${id} profile default sn PING${hex()}`, `onu ${id} profile line name BRIDGE`];

const rep = (n, f) => Array.from({ length: n }, () => f);
const mezcla = (nBuena, nViejas, base = 0) => [...rep(nBuena, buena), ...Array.from({ length: nViejas }, (_, i) => vieja(base + (i % 6)))];
function config(puertos) {
  const out = [];
  for (const [p, onus] of Object.entries(puertos)) {
    out.push(`interface gpon 0/${p}`);
    onus.forEach((f, i) => out.push(...f(i + 1).map(l => ` ${l}`)));
    out.push('exit');
  }
  return out.join('\n');
}
const panelPasa = (a) => a.fuente === 'puerto_olt' || (a.total > 0 && a.coinciden / a.total >= 0.8);

let ok = 0;
function caso(nombre, fn) { fn(); ok++; console.log(`OK  ${nombre}`); }

// Colatlan: puertos claros con la buena, mas uno enorme lleno de viejas y PING que tira el
// conjunto debajo del 80% (y las V-SOL de la OLT tambien).
const colatlan = {
  1: mezcla(40, 27), 2: mezcla(30, 7), 3: mezcla(25, 10), 4: mezcla(20, 5), 5: mezcla(35, 20),
  6: [...mezcla(3, 120), ...rep(30, ping)], 7: mezcla(18, 6), 8: mezcla(22, 9), 9: mezcla(28, 12),
  10: mezcla(40, 27),
};

caso('puerto vacio + vecinos claros → puertos_olt (pasa la compuerta del panel)', () => {
  const r = aprenderPlantillas(config(colatlan), { slot: 0, ponPort: 12 });
  assert.strictEqual(r.auth.fuente, 'puertos_olt', JSON.stringify(r.auth));
  assert.deepStrictEqual(r.auth.lineas, BUENA);
  assert.strictEqual(`${r.auth.coinciden}/${r.auth.total}`, '9/10');
  assert.ok(panelPasa(r.auth));
  console.log('    ', r.auth.detalle);
});

caso('puerto con 3 ONUs revueltas → camino de siempre (puerto, se detiene), sin puertos_olt', () => {
  // Mismo config con un puerto que traiga 3 ONUs revueltas: camino de siempre, sin puertos_olt.
  const r = aprenderPlantillas(config({ ...colatlan, 12: [vieja(1), vieja(2), vieja(3)] }), { slot: 0, ponPort: 12 });
  assert.strictEqual(r.auth.fuente, 'puerto');
  assert.ok(!panelPasa(r.auth), JSON.stringify({ ...r.auth, lineas: undefined }));
});

caso('puerto con solo otra marca (<3, sin V-SOL) + vecinos claros → puertos_olt', () => {
  const r = aprenderPlantillas(config({ ...colatlan, 12: rep(2, ping) }), { slot: 0, ponPort: 12 });
  assert.strictEqual(r.auth.fuente, 'puertos_olt', JSON.stringify(r.auth));
  assert.deepStrictEqual(r.auth.lineas, BUENA);
});

caso('puerto vacio + vecinos revueltos → se detiene igual (fuente olt, no clara)', () => {
  const revuelta = {
    1: mezcla(10, 3), 2: mezcla(0, 12, 10), 3: mezcla(9, 2), 4: [...rep(8, vieja(20)), ...rep(2, buena)],
    5: mezcla(10, 1), 6: [...rep(9, vieja(21)), buena],
  };
  const r = aprenderPlantillas(config(revuelta), { slot: 0, ponPort: 12 });
  assert.strictEqual(r.auth.fuente, 'olt', JSON.stringify(r.auth));
  assert.ok(!panelPasa(r.auth));
});

caso('puerto vacio + un solo puerto con V-SOL → no alcanza (>=2 puertos), se detiene', () => {
  const r = aprenderPlantillas(config({ 1: mezcla(6, 4), 2: rep(10, ping) }), { slot: 0, ponPort: 12 });
  assert.strictEqual(r.auth.fuente, 'olt');
  assert.ok(!panelPasa(r.auth));
});

caso('puerto vacio + OLT clara → olt como siempre', () => {
  const r = aprenderPlantillas(config({ 1: mezcla(10, 1), 2: mezcla(12, 1), 3: mezcla(9, 1) }), { slot: 0, ponPort: 12 });
  assert.strictEqual(r.auth.fuente, 'olt');
  assert.deepStrictEqual(r.auth.lineas, BUENA);
});

caso('puerto con ONUs (claro) → puerto, sin cambio', () => {
  const r = aprenderPlantillas(config({ ...colatlan, 12: mezcla(9, 1, 30) }), { slot: 0, ponPort: 12 });
  assert.strictEqual(r.auth.fuente, 'puerto');
  assert.strictEqual(`${r.auth.coinciden}/${r.auth.total}`, '9/10');
});

caso('puerto con 1-2 V-SOL → la de la OLT como antes (no entra a puertos_olt)', () => {
  const r = aprenderPlantillas(config({ ...colatlan, 12: [buena, buena] }), { slot: 0, ponPort: 12 });
  assert.strictEqual(r.auth.fuente, 'olt');
});

console.log(`\n${ok} casos OK`);
