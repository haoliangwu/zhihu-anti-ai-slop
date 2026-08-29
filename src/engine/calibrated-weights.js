/**
 * 校准打分权重（flash-domain 重拟合 + 统计特征，v4）
 * 拟合数据：C-ReD question-answer 人类 2956 + deepseek-v4-flash 2956（旧 9 LLM 退出训练集）
 * 拟合日期：2026-08-29 · 模型：逻辑回归（L2，平衡训练，7 种子 baked 均值）
 * 分数：score = round(σ(Σ w_i·x_i + Σ sw_j·stat_j + b) × 100)
 *   x_i = 词法痕迹命中数（cap 前），stat_j = 4 个统计特征值
 * 置零特征：meta-commentary / inspirational-closer / idiom-cluster / dead-metaphor / fake-colloquial
 *   （前 4 为基率≈0 噪声；fake-colloquial 跨种子 sd>|mean| 不稳，见 issue 09）
 * 统计特征：句长波动(sCV) / 标点密度 / 平均句长 / 逗号占比
 *   （charEntropy/ttr 经评估有长度混淆——长文误报，已弃用）
 * 决策记录：issue 06（旧 9 LLM 人类化）→ issue 09（flash-domain 重拟合 v3）
 *   → issue 10（统计特征 v4，flash 漏判 38%→21%）
 * 旧域（旧 9 LLM）泛化已知限制：检测器押注国内主用 flash 类新模型；
 *   统计特征对旧 AI 亦有判别力（旧 AI 正常 74%→45%）
 * 评估：.scratch/calibrated-scoring/eval/pilot/fit-stat-features-v4b.js
 */
(() => {
'use strict';
const ZD = globalThis.ZhihuDetector;
ZD.calibratedWeights = {
  version: 4,
  fittedOn: 'C-ReD question-answer (human + deepseek-v4-flash) + statistical features',
  fittedAt: '2026-08-29',
  samples: { human: 2956, ai: 2956 },
  intercept: -0.497462,
  weights: {
  "opening-boilerplate": 2.493395,
  "connector-skeleton": -0.150179,
  "empty-emphatic": 1.327863,
  "biz-jargon": -1.530372,
  "intensifier": 0.612397,
  "nominalized-verb": 1.14417,
  "meta-commentary": 0,
  "inspirational-closer": 0,
  "tricolon": -1.400286,
  "fake-intimacy": 2.877432,
  "superlative": -0.920542,
  "idiom-cluster": 0,
  "dead-metaphor": 0,
  "flat-sentence": -0.248799,
  "period-as-comma": 3.468484,
  "dash-repetition": -2.674277,
  "colon-overuse": -0.211563,
  "straight-quote": 0.108025,
  "fake-colloquial": 0,
  "hollow-summary": -0.638509,
  "numbered-list": -0.363613
},
  /** 统计特征权重（顺序与 ZD.statFeatureNames / ZD.computeStatFeatures 一致） */
  statWeights: [4.938495, -18.439033, 0.019459, -0.317733],
};
})();
