/**
 * 知乎照妖镜 — 云端二审（仅在 service worker 中运行）
 * 依赖：constants.js、storage.js（先 importScripts 加载）。
 * 限流：每页（按 tab）调用上限、全局并发上限、单次 30s 超时。
 * 任何失败返回 null，由内容脚本回落规则分。
 */
(() => {
'use strict';
const ZD = globalThis.ZhihuDetector;

ZD.cloud = {
  maxConcurrent: 2,
  inFlight: 0,

  /**
   * 二审入口：缓存（键 = 正文归一化哈希 + 一审结果摘要）→ 预算/并发 → 调用 API → 写缓存。
   * @param {string} text 正文
   * @param {number} tabId
   * @param {object} settings
   * @param {{ruleScore:number, hits:Array<{id:string,name:string,deduct:number}>}} [ruleContext] 一审结果
   * @returns {Promise<{score:number, aiSignals:string[], humanSignals:string[], cached?:boolean}|null>}
   */
  async secondOpinion(text, tabId, settings, ruleContext) {
    if (!settings.cloudEnabled || !settings.apiKey) return null;
    if (!text) return null;

    // 1) 缓存命中（键 = 正文归一化哈希 + 一审结果摘要：
    //    正文或一审判定变化 → 键变化 → 自动重判；二审必须看到一审结果）
    const contentHash = ZD.md5(text.replace(/\s+/g, ' ').trim() + '|first:' + firstPassSummary(ruleContext));
    const cache = await ZD.storage.getCache();
    const cached = cache[contentHash];
    if (cached && typeof cached.score === 'number') {
      return { score: cached.score, aiSignals: cached.aiSignals || [], humanSignals: cached.humanSignals || [], cached: true };
    }

    // 2) 每页预算
    const budget = await ZD.storage.getBudget(tabId);
    if (budget.used >= settings.cloudPerPageLimit) return null;

    // 3) 并发上限（尽力而为；SW 重启后重置为 0，可接受）
    if (ZD.cloud.inFlight >= ZD.cloud.maxConcurrent) return null;

    ZD.cloud.inFlight++;
    try {
      // 先记预算（无论成败都算一次调用，保护成本）
      await ZD.storage.setBudget(tabId, { used: budget.used + 1, ts: Date.now() });
      const result = await callApi(text, settings, ruleContext);
      if (!result) return null;
      await ZD.storage.setCacheEntry(contentHash, { ...result, ts: Date.now() });
      return result;
    } finally {
      ZD.cloud.inFlight--;
    }
  },
};

/** 一审结果摘要（用于缓存键：规则分 + 命中规则 id，排序保证稳定） */
function firstPassSummary(ruleContext) {
  if (!ruleContext) return '';
  const ids = (ruleContext.hits || []).map((h) => h.id).sort().join(',');
  return `${ruleContext.ruleScore}:${ids}`;
}

/** 调用 OpenAI 兼容 /chat/completions，解析并归一化为人类置信度 */
async function callApi(text, settings, ruleContext) {
  const baseUrl = settings.apiBaseUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ZD.CLOUD_TIMEOUT_MS);
  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.apiModel,
        messages: [
          // 用户可编辑提示词；未设置（''）时用内置默认
          { role: 'system', content: settings.judgePrompt || ZD.CLOUD_SYSTEM_PROMPT },
          { role: 'user', content: buildUserMessage(text, ruleContext) },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const content = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;
    if (!content) return null;

    const parsed = JSON.parse(content);
    let score = Number(parsed.score);
    if (!Number.isFinite(score)) return null;
    score = Math.max(0, Math.min(100, Math.round(score))); // 钳制到 0–100
    return {
      score,
      verdict: parsed.verdict === 'human' || parsed.verdict === 'mixed' || parsed.verdict === 'ai' ? parsed.verdict : 'mixed',
      aiSignals: Array.isArray(parsed.ai_signals) ? parsed.ai_signals.slice(0, 8) : [],
      humanSignals: Array.isArray(parsed.human_signals) ? parsed.human_signals.slice(0, 8) : [],
    };
  } catch {
    return null; // 网络失败 / 超时 / JSON 解析失败 → 降级
  } finally {
    clearTimeout(timer);
  }
}

/** 组装 user 消息：一审（规则引擎）结果 + 待复核正文 */
function buildUserMessage(text, ruleContext) {
  const parts = [];
  if (ruleContext) {
    parts.push('【一审（规则引擎）结果】');
    parts.push(`规则分（人类置信度）：${ruleContext.ruleScore} / 100`);
    const hits = ruleContext.hits || [];
    if (hits.length) {
      parts.push('命中的 AI 创作痕迹：');
      hits.forEach((h) => parts.push(`- ${h.name} -${h.deduct} 分`));
    } else {
      parts.push('未命中任何 AI 创作痕迹。');
    }
    parts.push('');
    parts.push('【待复核正文】');
  }
  parts.push(text);
  return parts.join('\n');
}
})();
