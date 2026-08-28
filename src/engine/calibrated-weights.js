/**
 * 校准打分权重（方案 A 产出，逻辑回归平衡训练）
 * 拟合数据：C-ReD question-answer 子集（人类 2956 + 9 LLM）
 * 拟合日期：2026-08-28 · 模型：逻辑回归（L2，平衡训练）
 * 分数：score = round(σ(Σ w_i·x_i + b) × 100)，x_i = 对应痕迹在 cap 前的命中数
 * 留出集指标与可靠性图：.scratch/calibrated-scoring/eval/report.json
 */
(() => {
'use strict';
const ZD = globalThis.ZhihuDetector;
ZD.calibratedWeights = {
  version: 1,
  fittedOn: 'C-ReD question-answer',
  fittedAt: '2026-08-28',
  samples: { human: 2956, ai: 26115 },
  intercept: 0.722226,
  weights: {
  "opening-boilerplate": -0.564361,
  "connector-skeleton": -0.929791,
  "empty-emphatic": -0.813074,
  "biz-jargon": -0.453961,
  "intensifier": 0.288126,
  "nominalized-verb": -0.537583,
  "meta-commentary": 0.081773,
  "inspirational-closer": 1.301319,
  "tricolon": -2.074065,
  "fake-intimacy": 2.584001,
  "superlative": -1.583765,
  "idiom-cluster": -0.343614,
  "dead-metaphor": -0.053793,
  "flat-sentence": -0.558372,
  "period-as-comma": 4.409336,
  "dash-repetition": 1.123461,
  "colon-overuse": 0.256758,
  "straight-quote": -0.195102,
  "fake-colloquial": 3.9474,
  "hollow-summary": -1.21113,
  "numbered-list": 0.657379
},
};
})();
