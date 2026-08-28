#!/usr/bin/env node
/**
 * A1 试点拟合：现有权重 vs 「加入 v4-flash 后重拟合」对比
 *
 * 回答的决策问题（300 条 pilot 是否值得全量）：
 *   1. 现有的旧 9 模型权重，在 v4-flash 上漏判得多严重？（flash 留出集 AUROC/Brier/人类侧漏检）
 *   2. 加入 v4-flash 后重拟合，能否在不伤旧域（C-ReD）表现的前提下提升 flash 检测？
 *   3. 权重方向是否稳定？（哪些特征因 v4-flash 数据发生翻转/大幅移动——即 v4-flash 与旧 AI 差异最大的维度）
 *
 * 设计：
 *   - 旧域数据：features.jsonl（人类 2956 + 旧 9 模型 26115），分层 80/20（种子 20260828，与 fit.js 相同 → 可对比 report.json）
 *   - flash 数据：answers.jsonl 特征化后按 qid 留出 25%（种子固定）——评估模型对"未见过的 v4-flash"的泛化
 *   - 两个平衡模型：
 *       OLD  = 训练集的人类 + 旧 AI（下采样至人类数）—— sanity：应与现有 calibrated-weights.js 接近
 *       NEW  = 训练集的人类 + 旧 AI（按比例减量）+ flash 训练集——比例对齐人类数
 *   - 指标：AUROC / Brier / Acc（阈值 .5），分三个评估面：旧测试集 / flash 留出集 / 人类全部
 *   - 权重对比：逐特征 OLD vs NEW（方向翻转 / 幅度变化排序列出）
 *
 * 输出：仅打印 + pilot/report-pilot.json（不写生产 calibrated-weights.js —— 决策前不动引擎）
 * 用法：node pilot-fit.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '../../../..');
require(path.join(ROOT, 'src/shared/constants.js'));
require(path.join(ROOT, 'src/engine/traces.js'));
const ZD = globalThis.ZhihuDetector;

const FEATURES = path.join(__dirname, '../features.jsonl');
const ANSWERS = path.join(__dirname, 'answers.jsonl');
const REPORT_OUT = path.join(__dirname, 'report-pilot.json');

// ---------- 工具（与 fit.js 相同实现，零依赖） ----------

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

function fitLogistic(X, y, opts) {
  const { lr = 0.5, epochs = 400, lambda = 0.01 } = opts;
  const n = X.length;
  const d = X[0].length;
  let w = new Array(d).fill(0);
  let b = 0;
  for (let e = 0; e < epochs; e++) {
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
      gw[i] = gw[i] / n + lambda * w[i];
      w[i] -= lr * gw[i];
    }
    b -= lr * (gb / n);
  }
  return { w, b };
}

async function loadJsonl(p) {
  if (!fs.existsSync(p)) return [];
  const rl = readline.createInterface({ input: fs.createReadStream(p), crlfDelay: Infinity });
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

const predict = (fit, rowsArr) => rowsArr.map((r) => sigmoid(fit.b + r.x.reduce((s, v, i) => s + fit.w[i] * v, 0)));

// ---------- 主流程 ----------

async function main() {
  const oldRows = await loadJsonl(FEATURES);
  const answers = await loadJsonl(ANSWERS);
  if (!oldRows.length || !answers.length) {
    console.error('需要 features.jsonl（旧域）与 answers.jsonl（v4-flash），先生成/特征化');
    process.exit(1);
  }

  // 清洗 LLM 输出常见的 markdown 语法标记（扩展运行时输入是知乎 DOM textContent，
  // 不含这些 ASCII 标记；特征化前剥掉，保证与部署输入同分布）
  const cleanText = (t) =>
    t
      .replace(/\*\*/g, '')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[-*]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/\n{2,}/g, '\n')
      .trim();

  // v4-flash 特征化（单一事实源 traces.js）
  const flashRows = answers.map((a) => ({
    label: 0,
    x: ZD.traces.map((t) => t.test(cleanText(a.text))),
    len: a.text.length,
    qid: a.qid,
  }));
  console.log(
    `旧域=${oldRows.length}（人类 ${oldRows.filter((r) => r.label === 1).length} / 旧AI ${
      oldRows.filter((r) => r.label === 0).length
    }） v4-flash=${flashRows.length}（平均长 ${Math.round(
      flashRows.reduce((s, r) => s + r.len, 0) / flashRows.length
    )} 字）`
  );

  // 旧域切分（与 fit.js 同种子，可对比 report.json 的 0.816/0.192）
  const { train: oldTrain, test: oldTest } = stratifiedSplit(oldRows, 0.2, 20260828);

  // flash 留出 25%（按 qid 顺序留出尾部，种子固定）
  const flashRand = rng(20260829);
  const flashShuffled = shuffle(flashRows, flashRand);
  const nFlashTest = Math.round(flashRows.length * 0.25);
  const flashTest = flashShuffled.slice(0, nFlashTest);
  const flashTrain = flashShuffled.slice(nFlashTest);

  // 特征标准化（统一用 OLD 训练集统计——两个模型同尺度可比；与 fit.js 一致）
  const D = oldRows[0].x.length;
  const mean = new Array(D).fill(0);
  const std = new Array(D).fill(0);
  for (const r of oldTrain) for (let i = 0; i < D; i++) mean[i] += r.x[i];
  for (let i = 0; i < D; i++) mean[i] /= oldTrain.length;
  for (const r of oldTrain) for (let i = 0; i < D; i++) std[i] += (r.x[i] - mean[i]) ** 2;
  for (let i = 0; i < D; i++) std[i] = Math.sqrt(std[i] / oldTrain.length) || 1;
  const stdize = (rowsArr) =>
    rowsArr.map((r) => ({
      label: r.label,
      x: r.x.map((v, i) => (v - mean[i]) / std[i]),
      len: r.len,
    }));

  const oldTrainS = stdize(oldTrain);
  const oldTestS = stdize(oldTest);
  const flashTrainS = stdize(flashTrain);
  const flashTestS = stdize(flashTest);
  // 人类全部（评估人类侧召回），来自旧域全量
  const allHumanS = stdize(oldRows.filter((r) => r.label === 1));
  // 旧 AI 全部（评估旧域判别全景）
  const allOldAiS = stdize(oldRows.filter((r) => r.label === 0));

  // ---- 模型 OLD：人类 + 旧 AI（平衡，同 fit.js） ----
  const humans = oldTrainS.filter((r) => r.label === 1);
  const ais = oldTrainS.filter((r) => r.label === 0);
  const nH = humans.length;
  const r1 = rng(42);
  const oldBalanced = [...humans, ...shuffle(ais, r1).slice(0, nH)];
  const fitOld = fitLogistic(oldBalanced.map((r) => r.x), oldBalanced.map((r) => r.label), {});

  // ---- 模型 NEW：人类 + 旧AI(减量至对齐) + flash ----
  // 平衡策略：AI 侧总量 = 人类数。旧 AI 取 (nH − flashTrain 数) 随机 + flashTrain 全部
  const nFlashT = flashTrainS.length;
  const nOldAiForNew = Math.max(0, nH - nFlashT);
  const r2 = rng(7);
  const oldAiPick = shuffle(ais, r2).slice(0, nOldAiForNew);
  const newBalanced = [...humans, ...oldAiPick, ...flashTrainS];
  const fitNew = fitLogistic(newBalanced.map((r) => r.x), newBalanced.map((r) => r.label), {});

  // ---- 反标准化回原始尺度（展示用，与部署评分一致） ----
  const bake = (fit) => ({
    w: fit.w.map((wv, i) => wv / std[i]),
    b: fit.b - fit.w.reduce((s, wv, i) => s + (wv * mean[i]) / std[i], 0),
  });
  const bakedOld = bake(fitOld);
  const bakedNew = bake(fitNew);

  // ---- 评估 ----
  const evals = {
    '旧域测试集(oldTest)': {
      old: metrics(predict(fitOld, oldTestS), oldTestS.map((r) => r.label)),
      new: metrics(predict(fitNew, oldTestS), oldTestS.map((r) => r.label)),
    },
    'v4-flash 留出25%': {
      old: metrics(predict(fitOld, flashTestS), flashTestS.map((r) => r.label)),
      new: metrics(predict(fitNew, flashTestS), flashTestS.map((r) => r.label)),
    },
    '人类全部召回': {
      old: metrics(predict(fitOld, allHumanS), allHumanS.map((r) => r.label)),
      new: metrics(predict(fitNew, allHumanS), allHumanS.map((r) => r.label)),
    },
    '旧AI全部(全量判别)': {
      old: metrics(predict(fitOld, allOldAiS), allOldAiS.map((r) => r.label)),
      new: metrics(predict(fitNew, allOldAiS), allOldAiS.map((r) => r.label)),
    },
  };

  console.log('\n========== 评估（AUROC / Brier / Acc，阈值 .5）==========');
  for (const [name, m] of Object.entries(evals)) {
    console.log(`\n${name}（n=${m.old.n}）`);
    console.log(
      `  OLD 权重: AUROC=${m.old.auroc.toFixed(4)} Brier=${m.old.brier.toFixed(4)} Acc=${m.old.accuracy.toFixed(4)}`
    );
    console.log(
      `  NEW 权重: AUROC=${m.new.auroc.toFixed(4)} Brier=${m.new.brier.toFixed(4)} Acc=${m.new.accuracy.toFixed(4)}`
    );
    console.log(
      `  差值    : AUROC=${(m.new.auroc - m.old.auroc >= 0 ? '+' : '')}${(m.new.auroc - m.old.auroc).toFixed(
        4
      )} Brier=${(m.new.brier - m.old.brier >= 0 ? '+' : '')}${(m.new.brier - m.old.brier).toFixed(4)}`
    );
  }

  // ---- 逐特征权重对比（OLD vs NEW，原始尺度） ----
  console.log('\n========== 权重对比（原始尺度，OLD → NEW）==========');
  const rows = ZD.traces.map((t, i) => {
    const wo = bakedOld.w[i];
    const wn = bakedNew.w[i];
    return {
      id: t.id,
      name: t.name,
      wOld: wo,
      wNew: wn,
      delta: wn - wo,
      flip: wo * wn < 0 && Math.abs(wo) > 0.001 && Math.abs(wn) > 0.001,
    };
  });
  // 按 |delta| 降序
  const sorted = [...rows].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  console.log('id'.padEnd(20) + 'OLD'.padEnd(10) + 'NEW'.padEnd(10) + 'Δ'.padEnd(10) + '标记');
  for (const r of sorted) {
    console.log(
      r.id.padEnd(20) +
        r.wOld.toFixed(3).padEnd(10) +
        r.wNew.toFixed(3).padEnd(10) +
        (r.delta >= 0 ? '+' : '').padEnd(9) +
        r.delta.toFixed(3) +
        (r.flip ? '  ← 方向翻转' : '')
    );
  }
  const flips = rows.filter((r) => r.flip);
  console.log(`\n方向翻转特征数: ${flips.length}${flips.length ? ' → ' + flips.map((f) => f.id).join(', ') : ''}`);

  // ---- 保存报告 ----
  const report = {
    data: 'C-ReD Q&A + v4-flash pilot（A1）',
    generated: new Date().toISOString(),
    n: { oldRows: oldRows.length, flash: flashRows.length, flashTrain: nFlashT, flashTest: nFlashTest },
    seed: { split: 20260828, flashSplit: 20260829 },
    evals,
    weightsOld: { intercept: +bakedOld.b.toFixed(6), w: bakedOld.w.map((v) => +v.toFixed(6)) },
    weightsNew: { intercept: +bakedNew.b.toFixed(6), w: bakedNew.w.map((v) => +v.toFixed(6)) },
    flips: flips.map((f) => f.id),
    note: 'pilot 仅评估对比，未写入生产 calibrated-weights.js',
  };
  fs.writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2));
  console.log(`\n报告 -> ${REPORT_OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});