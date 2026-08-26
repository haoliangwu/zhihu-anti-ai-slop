/**
 * 知乎照妖镜 — 共享常量与默认配置
 * 经典脚本（非模块）：通过 globalThis.ZhihuDetector 命名空间在
 * content script / service worker / options 页面间共享。
 */
'use strict';

globalThis.ZhihuDetector = globalThis.ZhihuDetector || {};

Object.assign(globalThis.ZhihuDetector, {
  /** 存储键 */
  KEYS: {
    SETTINGS: 'settings',
    OVERRIDES: 'overrides',
    CACHE: 'secondOpinionCache',
    BUDGET: 'secondOpinionBudget', // chrome.storage.session，按 tab 计
  },

  /** 默认配置（选项页可覆盖，存 chrome.storage.local[KEYS.SETTINGS]） */
  DEFAULTS: {
    thresholdConfirm: 40,   // ≤ 此值 → 确定 AI
    thresholdSuspect: 70,   // ≤ 此值 → 疑似 AI
    fuzzyLow: 20,           // 二审模糊带下界
    fuzzyHigh: 80,          // 二审模糊带上界
    apiBaseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    apiModel: 'deepseek-v4-flash',
    cloudEnabled: true,
    maxChars: 2000,         // 输入窗口字数上限
    minChars: 300,          // 判定字数下限：正文少于该字数直接跳过判定（0 关闭）
    windowMode: 'full',     // 'full' | 'head'（只看开头一两段）
    cloudPerPageLimit: 20,  // 每页二审调用上限
    hideAiBody: true,       // P1：AI 判定直接隐藏正文（0 关闭）
    /** 用户自定义 AI 创作痕迹正则规则：[{id, name, pattern, weight, cap}] */
    customTraces: [],
    /** 二审 system 提示词（可编辑，默认 = CLOUD_SYSTEM_PROMPT） */
    judgePrompt: '',
  },

  /** 消息类型 */
  MSG: {
    SECOND_OPINION: 'SECOND_OPINION',
    REANALYZE: 'REANALYZE',
  },

  /** 二审缓存上限（LRU 淘汰） */
  CACHE_LIMIT: 500,

  /** 二审单次超时（ms） */
  CLOUD_TIMEOUT_MS: 30_000,

  /** 二审提示词系统消息 */
  CLOUD_SYSTEM_PROMPT: [
    '你是"知乎 AI 答案检测器"的二审校验器。规则初审分数落在模糊带，需要你独立判断一段知乎回答正文是"人类撰写"还是"AI 生成"。',
    '要求：',
    '1. 默认假设文本是人类撰写，除非有强证据表明是 AI。',
    '2. 证据优先：先评估证据，再给分数；输出严格 JSON，不要多余文字。',
    '3. 正文少于 50 字或信息量过低时：score 给 50，verdict 给 "mixed"，并在 ai_signals 注明"信息不足"。',
    '4. 注意：文学性/古风/文言文本不要误判为 AI；观点鲜明、有个人经历细节、口语化、即兴感、轻微不完美是人类强信号；工整总分总结构、套话堆砌、无具体细节是 AI 信号。',
    '5. score 语义为"人类置信度"：100 = 几乎确定人工，0 = 几乎确定 AI。',
  ].join('\n'),
});
