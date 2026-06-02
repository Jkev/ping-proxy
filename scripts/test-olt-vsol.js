/** Prueba READ-ONLY del módulo olt-vsol contra una OLT real. */
const { oltAutoFind, oltOnuState } = require('../olt-vsol');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const cfg = {
  host: arg('host'),
  port: parseInt(arg('port', '22'), 10),
  user: arg('user'),
  pass: arg('pass'),
  ponCount: parseInt(arg('pon-count', '16'), 10),
};

(async () => {
  console.time('autofind');
  const af = await oltAutoFind(cfg);
  console.timeEnd('autofind');
  console.log('AUTO-FIND:', JSON.stringify(af, null, 2));

  console.time('state');
  const st = await oltOnuState(cfg, parseInt(arg('pon', '7'), 10));
  console.timeEnd('state');
  console.log('STATE pon 7:', JSON.stringify(st, null, 2));
})();
