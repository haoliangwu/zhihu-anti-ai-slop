#!/usr/bin/env node
/**
 * 种子鲁棒性检查：同一特征集、不同切分/下采样种子下重拟合平衡模型，
 * 观察权重符号是否稳定——尤其低基率特征（伪口语/伪亲密/句号当顿号等）
 * 的巨大权重若是少数样本驱动，符号会随种子翻转。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '../../..');
const IN = path.join(__dirname, 'features.jsonl');
require(path.join(ROOT, 'src/shared/constants.js'));
require(path.join(ROOT, 'src/engine/traces.js'));
const ZD = globalThis.ZhihuDetector;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

function fitLogistic(X, y) {
  const n = X.length;
  const d = X[0].length;
  let w = new Array(d).fill(0);
  let b = 0;
  for (let e = 0; e < 400; e++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let k = 0; k < n; k++) {
      const z = b + X[k].reduce((s, x, i) => s + w[i] * x, 0);
      const p = sigmoid(z);
      const diff = p - y[k];
      for (let i = 0; i < d; i++) gw[i] += diff * X[k][i];
      gb += diff;
    }
    for (let i = 0; i < d; i++) {
      gw[i] = gw[i] / n + 0.01 * w[i];
      w[i] -= 0.5 * gw[i];
    }
    b -= 0.5 * (gb / n);
  }
  return { w, b };
}

(async () => {
  const rl = readline.createInterface({ input: fs.createReadStream(IN), crlfDelay: Infinity });
  const rows = [];
  for await (const line of rl) if (line.trim()) rows.push(JSON.parse(line));
  const D = rows[0].x.length;

  const seeds = [1, 2, 3, 4, 5];
  const wByFeature = ZD.traces.map(() => []);
  const aurocs = [];
  for (const seed of seeds) {
    const rand = rng(seed);
    const pos = shuffle(rows.filter((r) => r.label === 1), rand);
    const neg = shuffle(rows.filter((r) => r.label === 0), rand);
    const nPosTest = Math.round(pos.length * 0.2);
    const nNegTest = Math.round(neg.length * 0.2);
    const train = [...pos.slice(nPosTest), ...neg.slice(nNegTest)];
    const test = [...pos.slice(0, nPosTest), ...neg.slice(0, nNegTest)];
    const mean = new Array(D).fill(0);
    const std = new Array(D).fill(0);
    for (const r of train) for (let i = 0; i < D; i++) mean[i] += r.x[i];
    for (let i = 0; i < D; i++) mean[i] /= train.length;
    for (const r of train) for (let i = 0; i < D; i++) std[i] += (r.x[i] - mean[i]) ** 2;
    for (let i = 0; i < D; i++) std[i] = Math.sqrt(std[i] / train.length) || 1;
    const norm = (arr) => arr.map((r) => ({ label: r.label, x: r.x.map((v, i) => (v - mean[i]) / std[i]) }));
    const trainS = norm(train);
    const testS = norm(test);
    const humans = trainS.filter((r) => r.label === 1);
    const ais = shuffle(trainS.filter((r) => r.label === 0), rng(seed * 7 + 3)).slice(0, humans.length);
    const fit = fitLogistic([...humans, ...ais].map((r) => r.x), [...humans, ...ais].map((r) => r.label));
    const probs = testS.map((r) => sigmoid(fit.b + r.x.reduce((s, v, i) => s + fit.w[i] * v, 0)));
    // AUROC
    const idx = probs.map((_, i) => i).sort((a, b) => probs[a] - probs[b]);
    let posSum = 0, nP = 0, nN = 0;
    const testLabels = testS.map((r) => r.label);
    for (let k = 0; k < idx.length; k++) {
      if (testLabels[idx[k]] === 1) { posSum += k + 1; nP++; } else nN++;
    }
    aurocs.push((posSum - (nP * (nP + 1)) / 2) / (nP * nN));
    fit.w.forEach((v, i) => wByFeature[i].push(v));
  }

  console.log('AUROC across seeds:', aurocs.map((v) => v.toFixed(4)).join(' '));
  console.log('\n标准化权重（5 种子 min/max/符号一致?）—— 负 = AI 信号');
  ZD.traces.forEach((t, i) => {
    const vals = wByFeature[i];
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const stable = (lo < 0 && hi < 0) || (lo > 0 && hi > 0);
    console.log(
      (t.id.padEnd(22)),
      'min=' + lo.toFixed(3).padStart(8),
      'max=' + hi.toFixed(3).padStart(8),
      stable ? 'stable ' : 'UNSTABLE',
      stable ? '' : `  <- 符号随种子翻转`
    );
  });
})();
