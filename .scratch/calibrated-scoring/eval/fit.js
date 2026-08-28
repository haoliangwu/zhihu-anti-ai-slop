#!/usr/bin/env node
/**
 * 逻辑回归拟合 + 留出集评估（零依赖）：
 *  - 分层 80/20 切分（固定种子，可复现）
 *  - 两个变体：平衡训练（AI 下采样至人类数）与全量训练
 *  - 特征标准化（训练集统计），权重反标准化回原始尺度写入常量表
 *  - 指标：Accuracy / AUROC / Brier；基线 = 现加性扣分制（score/100 作伪概率）
 * 输出：src/engine/calibrated-weights.js + report.json（含可靠性图数据）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '../../..');
const IN = path.join(__dirname, 'features.jsonl');
const WEIGHTS_OUT = path.join(ROOT, 'src/engine/calibrated-weights.js');
const REPORT_OUT = path.join(__dirname, 'report.json');

// 加载扩展自身痕迹清单（取 id 顺序与权重对齐）
require(path.join(ROOT, 'src/shared/constants.js'));
require(path.join(ROOT, 'src/engine/traces.js'));
const ZD = globalThis.ZhihuDetector;

// ---------- 工具 ----------

/** mulberry32 种子随机（可复现） */
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

/** AUROC（秩法，并列取平均秩） */
function auroc(scores, labels) {
  const n = scores.length;
  const idx = scores.map((_, i) => i).sort((a, b) => scores[a] - scores[b]);
  const ranks = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && scores[idx[j + 1]] === scores[idx[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k]] = avg;
    i = j + 1;
  }
  let posSum = 0;
  let nPos = 0;
  let nNeg = 0;
  for (let k = 0; k < n; k++) {
    if (labels[k] === 1) {
      posSum += ranks[k];
      nPos++;
    } else nNeg++;
  }
  if (nPos === 0 || nNeg === 0) return NaN;
  return (posSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/** 二分类指标：acc(阈值 .5)、AUROC、Brier */
function metrics(probs, labels) {
  let correct = 0;
  let brier = 0;
  for (let k = 0; k < labels.length; k++) {
    const p = probs[k];
    if ((p >= 0.5 ? 1 : 0) === labels[k]) correct++;
    brier += (p - labels[k]) ** 2;
  }
  return {
    n: labels.length,
    accuracy: correct / labels.length,
    auroc: auroc(probs, labels),
    brier: brier / labels.length,
  };
}

/** 可靠性图数据：10 分箱，每箱 预测均值 / 实际频率 / 样本数 */
function reliability(probs, labels) {
  const bins = Array.from({ length: 10 }, () => ({ pred: 0, obs: 0, n: 0 }));
  for (let k = 0; k < labels.length; k++) {
    const b = Math.min(9, Math.floor(probs[k] * 10));
    bins[b].pred += probs[k];
    bins[b].obs += labels[k];
    bins[b].n++;
  }
  return bins.map((b) => ({
    bin: b.n ? (b.pred / b.n).toFixed(3) : null,
    observed: b.n ? +(b.obs / b.n).toFixed(3) : null,
    n: b.n,
  }));
}

/** 逻辑回归（L2，梯度下降）。返回 { w, b, lossTail } */
function fitLogistic(X, y, opts) {
  const { lr = 0.5, epochs = 400, lambda = 0.01 } = opts;
  const n = X.length;
  const d = X[0].length;
  let w = new Array(d).fill(0);
  let b = 0;
  let lossTail = [];
  for (let e = 0; e < epochs; e++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    let loss = 0;
    for (let k = 0; k < n; k++) {
      const z = b + X[k].reduce((s, x, i) => s + w[i] * x, 0);
      const p = sigmoid(z);
      const diff = p - y[k];
      for (let i = 0; i < d; i++) gw[i] += diff * X[k][i];
      gb += diff;
      loss += -y[k] * Math.log(p + 1e-12) - (1 - y[k]) * Math.log(1 - p + 1e-12);
    }
    for (let i = 0; i < d; i++) {
      gw[i] = gw[i] / n + lambda * w[i];
      w[i] -= lr * gw[i];
    }
    b -= lr * (gb / n);
    if (e >= epochs - 5) lossTail.push(+(loss / n).toFixed(4));
  }
  return { w, b, lossTail };
}

// ---------- 数据 ----------

async function load() {
  const rl = readline.createInterface({ input: fs.createReadStream(IN), crlfDelay: Infinity });
  const rows = [];
  for await (const line of rl) {
    if (line.trim()) rows.push(JSON.parse(line));
  }
  return rows;
}

function stratifiedSplit(rows, testRatio, seed) {
  const rand = rng(seed);
  const pos = shuffle(rows.filter((r) => r.label === 1), rand);
  const neg = shuffle(rows.filter((r) => r.label === 0), rand);
  const nPosTest = Math.round(pos.length * testRatio);
  const nNegTest = Math.round(neg.length * testRatio);
  const test = [...pos.slice(0, nPosTest), ...neg.slice(0, nNegTest)];
  const train = [...pos.slice(nPosTest), ...neg.slice(nNegTest)];
  return { train, test };
}

// ---------- 主流程 ----------

async function main() {
  const rows = await load();
  const D = rows[0].x.length;
  const { train, test } = stratifiedSplit(rows, 0.2, 20260828);
  console.log(`rows=${rows.length}  train=${train.length} (human=${train.filter(r=>r.label===1).length})  test=${test.length} (human=${test.filter(r=>r.label===1).length})`);

  // 训练集标准化统计
  const mean = new Array(D).fill(0);
  const std = new Array(D).fill(0);
  for (const r of train) for (let i = 0; i < D; i++) mean[i] += r.x[i];
  for (let i = 0; i < D; i++) mean[i] /= train.length;
  for (const r of train) for (let i = 0; i < D; i++) std[i] += (r.x[i] - mean[i]) ** 2;
  for (let i = 0; i < D; i++) std[i] = Math.sqrt(std[i] / train.length) || 1;

  const standardize = (rowsArr) =>
    rowsArr.map((r) => ({
      label: r.label,
      x: r.x.map((v, i) => (v - mean[i]) / std[i]),
      baseline: r.baseline,
    }));

  const trainS = standardize(train);
  const testS = standardize(test);

  // 基线（现扣分制）：score/100 作伪概率
  const baseProbs = testS.map((r) => r.baseline / 100);
  const baseLabels = testS.map((r) => r.label);
  const baseM = metrics(baseProbs, baseLabels);

  // 平衡训练：AI 下采样至人类数
  const humans = trainS.filter((r) => r.label === 1);
  const ais = trainS.filter((r) => r.label === 0);
  const nH = humans.length;
  const rand = rng(42);
  const balanced = [...humans, ...shuffle(ais, rand).slice(0, nH)];

  const fitBalanced = fitLogistic(balanced.map((r) => r.x), balanced.map((r) => r.label), {});
  const fitFull = fitLogistic(trainS.map((r) => r.x), trainS.map((r) => r.label), {});

  const predict = (fit, rowsArr) => rowsArr.map((r) => sigmoid(fit.b + r.x.reduce((s, v, i) => s + fit.w[i] * v, 0)));
  const balM = metrics(predict(fitBalanced, testS), baseLabels);
  const fullM = metrics(predict(fitFull, testS), baseLabels);

  // 平衡评估子集（全部 test 人类 + 等量随机 AI）：与部署语义一致的校准核验
  const testHumans = testS.filter((r) => r.label === 1);
  const testAis = testS.filter((r) => r.label === 0);
  const r2 = rng(7);
  const balTest = [...testHumans, ...shuffle(testAis, r2).slice(0, testHumans.length)];
  const balTestLabels = balTest.map((r) => r.label);
  const balTestM = metrics(predict(fitBalanced, balTest), balTestLabels);
  const fullOnBalTest = metrics(predict(fitFull, balTest), balTestLabels);
  const reliabilityBalancedEval = reliability(predict(fitBalanced, balTest), balTestLabels);

  // 反标准化回原始尺度（运行时只需 σ(w·x + b)，无需标准化）
  const bake = (fit) => ({
    w: fit.w.map((wv, i) => wv / std[i]),
    b: fit.b - fit.w.reduce((s, wv, i) => s + (wv * mean[i]) / std[i], 0),
  });
  const baked = bake(fitBalanced);

  const report = {
    data: 'C-ReD question-answer（人类 2956 + 9 LLM 26115）',
    split: { train: train.length, test: test.length, testHuman: test.filter(r=>r.label===1).length, seed: 20260828 },
    baseline: { ...baseM, note: '现加性扣分制（score/100 作伪概率）' },
    balancedModel: { ...balM, note: '平衡训练（AI 下采样至人类数）', lossTail: fitBalanced.lossTail },
    fullModel: { ...fullM, note: '全量训练（自然先验）', lossTail: fitFull.lossTail },
    balancedEval: {
      note: '平衡评估子集（全 test 人类 + 等量 AI）：与部署语义一致的校准核验',
      n: balTest.length,
      balancedModel: { ...balTestM },
      fullModel: { ...fullOnBalTest },
    },
    reliabilityBalanced: reliability(predict(fitBalanced, testS), baseLabels),
    reliabilityBalancedEval,
    weightsBaked: { intercept: baked.b, w: baked.w },
    weightsStd: { w: fitBalanced.w.map((v) => +v.toFixed(4)), b: +fitBalanced.b.toFixed(4) },
  };

  // 门槛判定：AUROC 或 Brier 至少一项优于基线
  const gate = {
    aurocBetter: balM.auroc > baseM.auroc,
    brierBetter: balM.brier < baseM.brier,
    pass: balM.auroc > baseM.auroc || balM.brier < baseM.brier,
  };
  report.gate = gate;

  fs.writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2));

  // 写出引擎常量表（平衡模型，原始尺度权重，运行时零标准化）
  const wMap = {};
  ZD.traces.forEach((t, i) => {
    wMap[t.id] = +baked.w[i].toFixed(6);
  });
  const weightsJs = `/**
 * 校准打分权重（方案 A 产出，逻辑回归平衡训练）
 * 拟合数据：C-ReD question-answer 子集（人类 ${train.filter(r=>r.label===1).length + test.filter(r=>r.label===1).length} + 9 LLM）
 * 拟合日期：${new Date().toISOString().slice(0, 10)} · 模型：逻辑回归（L2，平衡训练）
 * 分数：score = round(σ(Σ w_i·x_i + b) × 100)，x_i = 对应痕迹在 cap 前的命中数
 * 留出集指标与可靠性图：.scratch/calibrated-scoring/eval/report.json
 */
(() => {
'use strict';
const ZD = globalThis.ZhihuDetector;
ZD.calibratedWeights = {
  version: 1,
  fittedOn: 'C-ReD question-answer',
  fittedAt: '${new Date().toISOString().slice(0, 10)}',
  samples: { human: ${train.filter(r=>r.label===1).length + test.filter(r=>r.label===1).length}, ai: ${train.filter(r=>r.label===0).length + test.filter(r=>r.label===0).length} },
  intercept: ${+baked.b.toFixed(6)},
  weights: ${JSON.stringify(wMap, null, 2)},
};
})();
`;
  fs.writeFileSync(WEIGHTS_OUT, weightsJs);
  console.log(`weights -> ${WEIGHTS_OUT}`);

  console.log(JSON.stringify({
    baseline: { auroc: +baseM.auroc.toFixed(4), brier: +baseM.brier.toFixed(4), acc: +baseM.accuracy.toFixed(4) },
    balanced: { auroc: +balM.auroc.toFixed(4), brier: +balM.brier.toFixed(4), acc: +balM.accuracy.toFixed(4) },
    full: { auroc: +fullM.auroc.toFixed(4), brier: +fullM.brier.toFixed(4), acc: +fullM.accuracy.toFixed(4) },
    balancedEval: {
      balancedModel: { auroc: +balTestM.auroc.toFixed(4), brier: +balTestM.brier.toFixed(4), acc: +balTestM.accuracy.toFixed(4) },
      fullModel: { auroc: +fullOnBalTest.auroc.toFixed(4), brier: +fullOnBalTest.brier.toFixed(4), acc: +fullOnBalTest.accuracy.toFixed(4) },
    },
    gate,
    lossTailBalanced: fitBalanced.lossTail,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
