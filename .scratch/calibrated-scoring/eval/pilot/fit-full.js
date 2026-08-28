#!/usr/bin/env node
/**
 * A2 全量拟合：OLD（C-ReD 旧9模型，reproduce report.json）vs 多策略 NEW（+ v4-flash 全量）
 *
 * 问题：flash 数据量（~2217 训练条）接近人类训练数时，"flash 优先 + 旧 AI 补足"会把
 *       旧 AI 挤到 ~150 条，旧域特征被稀释、AUROC 跌破 0.8（冒烟测试实证）。
 *
 * 方案：改为样本权重平衡的加权逻辑回归——三类（人类 / 旧AI / flash）各自的总权重质量
 *       = 人类训练数，flash 在 AI 质量中的占比 θ ∈ {0.25, 0.5, 0.75, 1.0} 四档扫描，
 *       由数据选出通过闸门的最优策略（不拍脑袋定比例）。
 *       旧 AI 全体都参与（小权重），比"重采样子集"保留更多信息。
 *
 * 闸门（每策略独立判定，「不劣于现值」用相对 OLD 的偏差线，不用绝对硬阈值）：
 *   1. 旧域（C-ReD 测试集）不劣于 OLD：AUROC ≥ OLD−0.010 且 Brier ≤ OLD+0.005
 *   2. 真实混合 AI 面（旧AI+flash 混合评估）AUROC 不劣于 OLD−0.005（扩展真实浏览场景）
 *   3. flash 留出集显著提升：Acc 高于 OLD 且 Brier 低于 OLD
 *   4. 人类全体召回可接受：Brier 增幅 ≤ 0.02
 *   同时满足的策略中选「flash Acc 增益最大」者作为推荐（best）。
 *
 * 输出：
 *   - report-full.json（默认，仅评估）
 *   - src/engine/calibrated-weights-full.js（best 策略预览常量表，不覆盖生产）
 *   - 传 --bake 时覆盖 src/engine/calibrated-weights.js（需人工/浏览器实测后再用）
 *
 * 用法：node fit-full.js [--bake]
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
const REPORT_OUT = path.join(__dirname, 'report-full.json');
const WEIGHTS_PREVIEW = path.join(ROOT, 'src/engine/calibrated-weights-full.js');
const BAKE = process.argv.includes('--bake');

// flash 在 AI 总质量中的占比扫描档位（0.1 ≈ 自然类均衡；θ 越小 flash 影响越弱）
const THETA_SWEEP = [0.1, 0.2, 0.3, 0.5, 0.75, 1.0];

// ---------- 工具（零依赖，与 fit.js / pilot-fit.js 一致） ----------

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

/**
 * 加权逻辑回归（L2，梯度下降）。
 * @param {number[][]} X 特征（标准化）
 * @param {number[]} y 标签 0/1
 * @param {number[]} [sw] 样本权重（可选，默认全 1）；梯度按 Σsw 归一
 */
function fitLogistic(X, y, opts) {
  const { lr = 0.5, epochs = 400, lambda = 0.01, sw = null } = opts;
  const n = X.length;
  const d = X[0].length;
  const totalW = sw ? sw.reduce((s, v) => s + v, 0) : n;
  let w = new Array(d).fill(0);
  let b = 0;
  for (let e = 0; e < epochs; e++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let k = 0; k < n; k++) {
      const z = b + X[k].reduce((s, x, i) => s + w[i] * x, 0);
      const p = sigmoid(z);
      const diff = (p - y[k]) * (sw ? sw[k] : 1);
      for (let i = 0; i < d; i++) gw[i] += diff * X[k][i];
      gb += diff;
    }
    for (let i = 0; i < d; i++) {
      gw[i] = gw[i] / totalW + lambda * w[i];
      w[i] -= lr * gw[i];
    }
    b -= lr * (gb / totalW);
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

const predict = (fit, rowsArr) =>
  rowsArr.map((r) => sigmoid(fit.b + r.x.reduce((s, v, i) => s + fit.w[i] * v, 0)));

/** 清洗 LLM markdown 标记（扩展运行时输入是知乎 DOM textContent） */
function cleanText(t) {
  return t
    .replace(/\*\*/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// ---------- 主流程 ----------

async function main() {
  const oldRows = await loadJsonl(FEATURES);
  const answers = await loadJsonl(ANSWERS);
  if (!oldRows.length || !answers.length) {
    console.error('需要 features.jsonl（旧域）与 answers.jsonl（v4-flash 全量），先生成/特征化');
    process.exit(1);
  }

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

  // flash 留出 25%（与 pilot-fit 同种子，pilot 结论可对照）
  const flashRand = rng(20260829);
  const flashShuffled = shuffle(flashRows, flashRand);
  const nFlashTest = Math.round(flashRows.length * 0.25);
  const flashTest = flashShuffled.slice(0, nFlashTest);
  const flashTrain = flashShuffled.slice(nFlashTest);

  // 特征标准化（统一 OLD 训练集统计；与 fit.js 一致）
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
  const allHumanS = stdize(oldRows.filter((r) => r.label === 1));
  const allOldAiS = stdize(oldRows.filter((r) => r.label === 0));

  // 真实混合 AI 面（部署相关）：旧域测试集人类 + 旧域测试集AI + flash 留出——
  // 扩展在真实浏览中遇到的是旧AI与新flash的混合，混合 AUROC 才是"人排在人上"的全景指标
  const oldTestHumans = oldTestS.filter((r) => r.label === 1);
  const oldTestAis = oldTestS.filter((r) => r.label === 0);
  const mixedRows = [...oldTestHumans, ...oldTestAis, ...flashTestS];

  // ---- 训练数据构成加权（类别质量平衡）----
  const humans = oldTrainS.filter((r) => r.label === 1);
  const ais = oldTrainS.filter((r) => r.label === 0);
  const nH = humans.length;
  const nF = flashTrainS.length;
  const nO = ais.length;

  // OLD：重采样平衡（同 fit.js，人类 nH + 旧AI nH 子集），权重 1
  const r1 = rng(42);
  const oldBalanced = [...humans, ...shuffle(ais, r1).slice(0, nH)];
  const fitOld = fitLogistic(oldBalanced.map((r) => r.x), oldBalanced.map((r) => r.label), {});
  console.log(`\nOLD 平衡：人类 ${nH} + 旧AI ${nH}（重采样，同 fit.js）`);

  // 评估面基准（OLD 模型）
  const evalsurfaces = {
    '旧域测试集(oldTest)': { rows: oldTestS, labels: oldTestS.map((r) => r.label) },
    '真实混合AI面(旧AI+flash)': { rows: mixedRows, labels: mixedRows.map((r) => r.label) },
    'v4-flash 留出25%': { rows: flashTestS, labels: flashTestS.map((r) => r.label) },
    '人类全部召回': { rows: allHumanS, labels: allHumanS.map((r) => r.label) },
    '旧AI全部(全量判别)': { rows: allOldAiS, labels: allOldAiS.map((r) => r.label) },
  };
  const oldEval = {};
  for (const [name, s] of Object.entries(evalsurfaces)) {
    oldEval[name] = metrics(predict(fitOld, s.rows), s.labels);
  }

  console.log('\n========== OLD 基线 ==========');
  for (const [name, m] of Object.entries(oldEval)) {
    console.log(
      `  ${name.padEnd(22)}（n=${m.n}）: AUROC=${Number.isFinite(m.auroc) ? m.auroc.toFixed(4) : 'NaN'} Brier=${m.brier.toFixed(
        4
      )} Acc=${m.accuracy.toFixed(4)}`
    );
  }

  // ---- θ 扫描：加权平衡训练（三类各自质量 = nH，flash 占 AI 质量 θ）----
  const strategies = {};
  for (const theta of THETA_SWEEP) {
    const massFlash = nH * theta;
    const massOld = nH * (1 - theta);
    // 旧 AI 全体参与（小权重），保留信息
    const sw = [
      ...humans.map(() => 1),
      ...ais.map(() => (nO > 0 ? massOld / nO : 0)),
      ...flashTrainS.map(() => (nF > 0 ? massFlash / nF : 0)),
    ];
    const X = [...humans.map((r) => r.x), ...ais.map((r) => r.x), ...flashTrainS.map((r) => r.x)];
    const y = [...humans.map((r) => r.label), ...ais.map((r) => r.label), ...flashTrainS.map((r) => r.label)];
    const fit = fitLogistic(X, y, { sw });
    const ev = {};
    for (const [name, s] of Object.entries(evalsurfaces)) {
      ev[name] = metrics(predict(fit, s.rows), s.labels);
    }
    const gate = {
      // 相对偏差门槛（"不劣于现值"语义，非绝对硬线）：旧域 AUROC ≥ OLD−0.010 且 Brier ≤ OLD+0.005
      oldDomainNotWorse:
        ev['旧域测试集(oldTest)'].auroc >= oldEval['旧域测试集(oldTest)'].auroc - 0.01 &&
        ev['旧域测试集(oldTest)'].brier <= oldEval['旧域测试集(oldTest)'].brier + 0.005,
      // 真实混合 AI 面（旧AI+flash，部署场景）：AUROC ≥ OLD−0.005
      mixedAiNotWorse:
        ev['真实混合AI面(旧AI+flash)'].auroc >= oldEval['真实混合AI面(旧AI+flash)'].auroc - 0.005,
      flashImproved:
        ev['v4-flash 留出25%'].accuracy > oldEval['v4-flash 留出25%'].accuracy &&
        ev['v4-flash 留出25%'].brier < oldEval['v4-flash 留出25%'].brier,
      humanRecallOk:
        ev['人类全部召回'].brier - oldEval['人类全部召回'].brier <= 0.02,
      pass: false,
    };
    gate.pass =
      gate.oldDomainNotWorse && gate.mixedAiNotWorse && gate.flashImproved && gate.humanRecallOk;
    strategies[theta] = {
      theta,
      masses: { human: nH, flash: +massFlash.toFixed(0), oldAi: +massOld.toFixed(0) },
      ev,
      gate,
      fit,
    };
  }

  console.log('\n========== θ 扫描评估 ==========');
  console.log(
    'θ(flash占AI质量) | 旧域AUROC | 旧域Brier | flashAcc | flashBrier | 人类Brier | 人类ΔBrier | 闸门'
  );
  for (const theta of THETA_SWEEP) {
    const s = strategies[theta];
    const o = s.ev['旧域测试集(oldTest)'];
    const f = s.ev['v4-flash 留出25%'];
    const h = s.ev['人类全部召回'];
    console.log(
      `${'θ=' + theta}        | ${o.auroc.toFixed(4)}   | ${o.brier.toFixed(4)}   | ${f.accuracy.toFixed(
        4
      )}   | ${f.brier.toFixed(4)}   | ${h.brier.toFixed(4)}   | ${(h.brier - oldEval['人类全部召回'].brier).toFixed(
        4
      )}    | ${s.gate.pass ? 'PASS' : 'fail'}`
    );
  }

  // ---- 推荐：通过闸门的 θ 中 flash Acc 增益最大者 ----
  const passing = THETA_SWEEP.filter((t) => strategies[t].gate.pass);
  const bestTheta = passing.length
    ? passing.reduce((a, b) =>
        strategies[b].ev['v4-flash 留出25%'].accuracy > strategies[a].ev['v4-flash 留出25%'].accuracy ? b : a
      )
    : null;
  console.log(`\n通过闸门的策略: ${passing.length ? passing.map((t) => 'θ=' + t).join(', ') : '无'}`);
  console.log(`推荐: ${bestTheta !== null ? 'θ=' + bestTheta : '无（不替换权重）'}`);

  const fitNew = bestTheta !== null ? strategies[bestTheta].fit : null;

  // ---- 反标准化（部署尺度）----
  const bake = (fit) => ({
    w: fit.w.map((wv, i) => wv / std[i]),
    b: fit.b - fit.w.reduce((s, wv, i) => s + (wv * mean[i]) / std[i], 0),
  });
  const bakedOld = bake(fitOld);
  const bakedNew = fitNew ? bake(fitNew) : null;

  // ---- 权重对比（best vs OLD）----
  if (bakedNew) {
    console.log('\n========== 权重对比（原始尺度，OLD → θ=' + bestTheta + '）==========');
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
    const sorted = [...rows].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    console.log('id'.padEnd(20) + 'OLD'.padEnd(10) + 'NEW'.padEnd(10) + 'Δ'.padEnd(10) + '标记');
    for (const r of sorted) {
      console.log(
        r.id.padEnd(20) +
          r.wOld.toFixed(3).padEnd(10) +
          r.wNew.toFixed(3).padEnd(10) +
          (r.delta >= 0 ? '+' : '').padStart(1).padEnd(9) +
          r.delta.toFixed(3) +
          (r.flip ? '  ← 方向翻转' : '')
      );
    }
    const flips = rows.filter((r) => r.flip);
    console.log(
      `\n方向翻转特征数: ${flips.length}${flips.length ? ' → ' + flips.map((f) => f.id).join(', ') : ''}`
    );
  }

  // ---- 输出 ----
  const ZERO_FEATURES = new Set(['meta-commentary', 'inspirational-closer', 'idiom-cluster', 'dead-metaphor']);
  const nHumanAll = oldRows.filter((r) => r.label === 1).length;
  const nAiAll = oldRows.filter((r) => r.label === 0).length + flashRows.length;
  const report = {
    data: 'C-ReD Q&A + v4-flash 全量（A2）',
    generated: new Date().toISOString(),
    n: {
      oldRows: oldRows.length,
      flash: flashRows.length,
      flashTrain: nF,
      flashTest: nFlashTest,
      humanAll: nHumanAll,
      humanTrain: nH,
      oldAiTrain: nO,
    },
    seed: { split: 20260828, flashSplit: 20260829, balancedPick: 42 },
    thetaSweep: THETA_SWEEP,
    oldEval,
    strategies: Object.fromEntries(
      THETA_SWEEP.map((t) => {
        const s = strategies[t];
        return [
          'theta_' + t,
          { masses: s.masses, ev: s.ev, gate: s.gate },
        ];
      })
    ),
    bestTheta,
    flips:
      bakedNew && fitNew
        ? ZD.traces
            .map((t, i) => ({ id: t.id, wo: bakedOld.w[i], wn: bakedNew.w[i] }))
            .filter((r) => r.wo * r.wn < 0 && Math.abs(r.wo) > 0.001 && Math.abs(r.wn) > 0.001)
            .map((r) => r.id)
        : [],
    weightsNew:
      bakedNew && fitNew
        ? { intercept: +bakedNew.b.toFixed(6), w: bakedNew.w.map((v) => +v.toFixed(6)) }
        : null,
    note: '多策略 θ 扫描（加权平衡）；best 通过闸门者；未 --bake 不写生产权重',
  };
  fs.writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2));
  console.log(`\n报告 -> ${REPORT_OUT}`);

  if (bakedNew) {
    const wMap = {};
    ZD.traces.forEach((t, i) => {
      wMap[t.id] = ZERO_FEATURES.has(t.id) ? 0 : +bakedNew.w[i].toFixed(6);
    });
    const weightsJs = `/**
 * 校准打分权重（A2：C-ReD 旧9模型 + deepseek-v4-flash 全量重拟合，加权平衡逻辑回归）
 * 拟合数据：C-ReD question-answer（人类 ${nHumanAll}）+ 旧9LLM（${oldRows.filter((r) => r.label === 0).length}）+ v4-flash（${flashRows.length}）
 * 拟合日期：${new Date().toISOString().slice(0, 10)} · 模型：逻辑回归（L2，加权平衡，θ=${bestTheta}）
 * 分数：score = round(σ(Σ w_i·x_i + b) × 100)，x_i = 对应痕迹在 cap 前的命中数
 * 置零特征：${[...ZERO_FEATURES].join(' / ')}（基率≈0、种子符号不稳的噪声特征）
 * 来源：.scratch/calibrated-scoring/eval/pilot/（generate → fit-full，report-full.json）
 * 注意：此文件由 fit-full.js 预览生成；--bake 才覆盖生产 calibrated-weights.js
 */
(() => {
'use strict';
const ZD = globalThis.ZhihuDetector;
ZD.calibratedWeights = {
  version: 3,
  fittedOn: 'C-ReD question-answer + deepseek-v4-flash',
  fittedAt: '${new Date().toISOString().slice(0, 10)}',
  samples: { human: ${nHumanAll}, ai: ${nAiAll} },
  intercept: ${+bakedNew.b.toFixed(6)},
  weights: ${JSON.stringify(wMap, null, 2)},
};
})();
`;
    fs.writeFileSync(WEIGHTS_PREVIEW, weightsJs);
    console.log(`\n预览权重（θ=${bestTheta}）-> ${WEIGHTS_PREVIEW}`);

    if (BAKE) {
      const PROD = path.join(ROOT, 'src/engine/calibrated-weights.js');
      fs.copyFileSync(WEIGHTS_PREVIEW, PROD);
      console.log(`--bake: 已覆盖生产权重 -> ${PROD}`);
    } else {
      console.log('(未传入 --bake，生产权重未改动)');
    }
  } else {
    console.log('\n无通过闸门的策略 → 不产出权重文件，生产权重未改动');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});