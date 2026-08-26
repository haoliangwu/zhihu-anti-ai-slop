/**
 * 知乎照妖镜 — 规则引擎（初审）
 * 扣分制：初始 100，命中 AI 创作痕迹即扣分，总分下限 0。
 * 输出 { score, hits }，hits 为命中清单（用于"点击看理由"）。
 * 依赖：constants.js、traces.js（先加载）。
 */
'use strict';

const ZD = globalThis.ZhihuDetector;

ZD.engine = {
  /**
   * @param {string} text 输入窗口文本
   * @returns {{ score: number, hits: Array<{id,name,deduct,count}> }}
   */
  score(text) {
    const hits = [];
    let total = 0;
    for (const trace of ZD.traces) {
      const count = trace.test(text);
      if (count > 0) {
        const capped = Math.min(count, trace.cap);
        const deduct = capped * trace.weight;
        hits.push({ id: trace.id, name: trace.name, deduct, count });
        total += deduct;
      }
    }
    return { score: Math.max(0, 100 - total), hits };
  },

  /**
   * 把分数映射为等级（依赖阈值设置）。
   * @returns {{level: 'confirm-ai'|'suspect-ai'|'normal', label: string}}
   */
  levelOf(score, settings) {
    if (score <= settings.thresholdConfirm) return { level: 'confirm-ai', label: '确定 AI' };
    if (score <= settings.thresholdSuspect) return { level: 'suspect-ai', label: '疑似 AI' };
    return { level: 'normal', label: '正常' };
  },
};
