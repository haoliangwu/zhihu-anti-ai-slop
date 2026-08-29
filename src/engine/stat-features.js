/**
 * 知乎照妖镜 — 统计文本特征（票 10，方案 B）
 * 纯 JS 字符级统计特征，与词法命中数正交，补强"句式未命中但节奏机械"的文本。
 * 依赖：constants.js（先加载，提供命名空间 ZD）。
 *
 * 4 个特征（经离线评估筛选，去 charEntropy/ttr——长度混淆变量致长文误报）：
 *  0. sentenceLengthCV   句长变异系数（std/mean）—— 人类句长多变→高
 *  1. punctDensity       标点/总字符 —— AI 标点规律→高（负权）
 *  2. sentenceMeanLen    平均句长（字符数）—— 人类句长→高（弱信号）
 *  3. commaRatio         逗号/标点总数 —— AI 逗号占比低（弱信号）
 */
(() => {
'use strict';
const ZD = globalThis.ZhihuDetector;

const PUNCT_RE = /[，。！？、；：""''（）《》【】…—\-.\,\!\?\;\:\"\'\(\)\[\]\/\\]/;
const SENT_SPLIT_RE = /[。！？!?\n]/;

/**
 * 统计特征名称（与 calibrated-weights.js statWeights 数组顺序一致）。
 * @type {string[]}
 */
ZD.statFeatureNames = ['句长波动', '标点密度', '平均句长', '逗号占比'];

/**
 * 提取 4 个统计特征值。
 * @param {string} text 输入窗口文本
 * @returns {number[]} [sCV, punctDensity, sMeanLen, commaRatio]
 */
ZD.computeStatFeatures = function (text) {
  const chars = [...text];
  const n = chars.length;
  if (n < 10) return [0, 0, 0, 0];

  // 句子切分（按句末标点 + 换行），过滤过短碎片
  const sents = text.split(SENT_SPLIT_RE).map(s => s.trim()).filter(s => s.length >= 4);
  const slen = sents.map(s => [...s].length);
  const sMean = slen.length ? slen.reduce((a, b) => a + b, 0) / slen.length : 0;
  const sVar = slen.length > 1
    ? slen.reduce((a, b) => a + (b - sMean) ** 2, 0) / slen.length
    : 0;
  const sCV = sMean > 0 ? Math.sqrt(sVar) / sMean : 0;

  // 标点统计
  let punctCount = 0, commaCount = 0;
  for (const c of chars) {
    if (PUNCT_RE.test(c)) {
      punctCount++;
      if (c === '，' || c === ',') commaCount++;
    }
  }
  const punctDensity = punctCount / n;
  const commaRatio = punctCount > 0 ? commaCount / punctCount : 0;

  return [sCV, punctDensity, sMean, commaRatio];
};
})();
