'use strict';
// 迁移单测：模拟 6 种存储态，验证 v4 迁移（fuzzyLow 30→15）只动"仍是旧默认"的配置
// 运行：node .scratch/calibrated-scoring/tests/migrate-settings-test.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '../../..'); // tests → calibrated-scoring → .scratch → repo root
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(k) { const o = {}; if (k in store) o[k] = store[k]; return o; },
      async set(v) { Object.assign(store, v); },
    },
    session: { async get() { return {}; }, async set() {} },
  },
};
eval(fs.readFileSync(path.join(ROOT, 'src/shared/constants.js'), 'utf8'));
eval(fs.readFileSync(path.join(ROOT, 'src/shared/storage.js'), 'utf8'));
const ZD = globalThis.ZhihuDetector;

async function run(name, saved) {
  store.settings = saved;
  const s = await ZD.storage.getSettings();
  console.log(
    name.padEnd(26),
    'v=' + s.settingsVersion,
    'confirm=' + s.thresholdConfirm,
    'suspect=' + s.thresholdSuspect,
    'fuzzyLow=' + s.fuzzyLow,
    'fuzzyHigh=' + s.fuzzyHigh,
    'artMin=' + s.articleMinChars
  );
}

(async () => {
  console.log('DEFAULTS.fuzzyLow =', ZD.DEFAULTS.fuzzyLow, '/ fuzzyHigh =', ZD.DEFAULTS.fuzzyHigh);
  await run('v0 legacy defaults', { thresholdConfirm: 40, thresholdSuspect: 70, fuzzyLow: 20, fuzzyHigh: 80 });
  await run('v2 default state', { settingsVersion: 2, thresholdConfirm: 30, thresholdSuspect: 50, fuzzyLow: 30, fuzzyHigh: 50 });
  await run('v3 default state', { settingsVersion: 3, thresholdConfirm: 30, thresholdSuspect: 50, fuzzyLow: 30, fuzzyHigh: 50, articleMinChars: 800 });
  await run('custom fuzzyLow=25', { settingsVersion: 3, thresholdConfirm: 30, thresholdSuspect: 50, fuzzyLow: 25, fuzzyHigh: 50 });
  await run('custom fuzzyHigh=40', { settingsVersion: 3, thresholdConfirm: 30, thresholdSuspect: 50, fuzzyLow: 30, fuzzyHigh: 40 });
  await run('fresh install', undefined);
  // 断言
  const cases = [
    ['v0 legacy defaults', (s) => s.fuzzyLow === 15 && s.fuzzyHigh === 50 && s.thresholdConfirm === 30],
    ['v2 default state', (s) => s.fuzzyLow === 15],
    ['v3 default state', (s) => s.fuzzyLow === 15],
    ['custom fuzzyLow=25', (s) => s.fuzzyLow === 25],          // 自定义不迁移
    ['custom fuzzyHigh=40', (s) => s.fuzzyLow === 30 && s.fuzzyHigh === 40], // 自定义不迁移
    ['fresh install', (s) => s.fuzzyLow === 15],
  ];
  const redo = [];
  for (const [name, fn] of cases) {
    const saved = {
      'v0 legacy defaults': { thresholdConfirm: 40, thresholdSuspect: 70, fuzzyLow: 20, fuzzyHigh: 80 },
      'v2 default state': { settingsVersion: 2, thresholdConfirm: 30, thresholdSuspect: 50, fuzzyLow: 30, fuzzyHigh: 50 },
      'v3 default state': { settingsVersion: 3, thresholdConfirm: 30, thresholdSuspect: 50, fuzzyLow: 30, fuzzyHigh: 50, articleMinChars: 800 },
      'custom fuzzyLow=25': { settingsVersion: 3, thresholdConfirm: 30, thresholdSuspect: 50, fuzzyLow: 25, fuzzyHigh: 50 },
      'custom fuzzyHigh=40': { settingsVersion: 3, thresholdConfirm: 30, thresholdSuspect: 50, fuzzyLow: 30, fuzzyHigh: 40 },
      'fresh install': undefined,
    }[name];
    store.settings = saved;
    const s = await ZD.storage.getSettings();
    if (!fn(s)) redo.push(name + ' → ' + JSON.stringify(s));
  }
  if (redo.length) { console.log('\nFAIL:', redo.join('\n')); process.exit(1); }
  console.log('\nALL 6 CASES PASS');
})();