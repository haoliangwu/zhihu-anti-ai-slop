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
  maxConcurrent: ZD.CLOUD_MAX_CONCURRENT,
  inFlight: 0,

  /**
   * 二审入口：缓存（键 = 正文归一化哈希 + 一审结果摘要 + 融合权重）→ 预算/并发 → 调用 API → 写缓存。
   * 返回分数为一审/二审加权融合结果（LLM 打分波动大，融合后显著降噪）。
   * @param {string} text 正文
   * @param {number} tabId
   * @param {object} settings
   * @param {{ruleScore:number, hits:Array<{id:string,name:string,deduct:number}>}} [ruleContext] 一审结果
   * @param {boolean} [force] 手动"重新判定"：跳过缓存直接调用（结果覆盖写回缓存）
   * @param {string} [dimension] 预算维度 'answer' | 'article'（回答与文章预算隔离）
   * @returns {Promise<{score:number, aiSignals:string[], humanSignals:string[], cached?:boolean}|null>}
   */
  async secondOpinion(text, tabId, settings, ruleContext, force, dimension) {
    if (!settings.cloudEnabled || !settings.apiKey) return null;
    if (!text) return null;

    // 1) 缓存命中（键 = 正文归一化哈希 + 一审结果摘要 + 融合权重 + 预算维度：
    //    正文/一审判定/权重/维度变化 → 键变化 → 自动重判；force 时跳过。
    //    维度入键保证回答与文章缓存互不污染（spec：详情页判定不得污染回答缓存）
    const contentHash = ZD.md5(
      text.replace(/\s+/g, ' ').trim() +
      '|first:' + firstPassSummary(ruleContext) +
      '|w:' + (settings.cloudScoreWeight ?? 0.6) +
      '|dim:' + (dimension || ZD.DIM.ANSWER)
    );
    if (!force) {
      const cache = await ZD.storage.getCache();
      const cached = cache[contentHash];
      if (cached && typeof cached.score === 'number') {
        // LRU：命中即刷新 ts，淘汰时按 ts 取最旧（读不刷新的纯 FIFO 会让
        // 高频回答长期占据缓存，见 spec 缓存键/淘汰约定）
        cached.ts = Date.now();
        await ZD.storage.setCacheEntry(contentHash, cached);
        return { score: cached.score, aiSignals: cached.aiSignals || [], humanSignals: cached.humanSignals || [], cached: true };
      }
    }

    // 2) 每页预算（按维度隔离：回答与文章各自独立的每页上限）
    const budget = await ZD.storage.getBudget(tabId, dimension);
    if (budget.used >= settings.cloudPerPageLimit) return null;

    // 3) 并发上限（尽力而为；SW 重启后重置为 0，可接受）
    if (ZD.cloud.inFlight >= ZD.cloud.maxConcurrent) return null;

    ZD.cloud.inFlight++;
    try {
      // 先记预算（无论成败都算一次调用，保护成本）
      await ZD.storage.setBudget(tabId, dimension, { used: budget.used + 1, ts: Date.now() });
      const result = await callApi(text, settings, ruleContext);
      if (!result) return null;
      // 加权融合：final = w·cloud + (1−w)·rule（无一审时直接用 LLM 分）
      const fused = fuseScore(ruleContext ? ruleContext.ruleScore : null, result.score, settings);
      const entry = { ...result, score: fused, ts: Date.now() };
      await ZD.storage.setCacheEntry(contentHash, entry);
      return { ...result, score: fused };
    } finally {
      ZD.cloud.inFlight--;
    }
  },
};

/**
 * 一审/二审分数加权融合（线性加权）。
 * @param {number|null} ruleScore 一审规则分（无则原样返回二审分）
 * @param {number} cloudScore 二审 LLM 分
 * @param {object} settings
 */
function fuseScore(ruleScore, cloudScore, settings) {
  if (typeof ruleScore !== 'number') return cloudScore;
  const w = Math.min(1, Math.max(0, settings.cloudScoreWeight ?? 0.6));
  return ZD.clampScore(w * cloudScore + (1 - w) * ruleScore);
}

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
      // 请求体 = 核心字段（model/messages/response_format，强制覆盖）+
      // 额外参数（settings.extraParams JSON config，按服务商兼容性配置）。
      // 默认 = DeepSeek 关闭思考模式 + temperature 0；留空则不发送额外参数（最兼容）。
      // 非法 JSON 忽略（降级为最兼容模式），不阻塞调用。
      body: JSON.stringify(buildRequestBody(text, settings, ruleContext)),
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const content = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;
    if (!content) return null;

    // 部分模型会返回 markdown 代码围栏包裹的 JSON（```json ... ```），剥离后再解析
    const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned);
    let score = Number(parsed.score);
    if (!Number.isFinite(score)) return null;
    score = ZD.clampScore(score); // 钳制到 0–100
    const v = parsed.verdict;
    return {
      score,
      verdict: v === ZD.VERDICT.HUMAN || v === ZD.VERDICT.MIXED || v === ZD.VERDICT.AI ? v : ZD.VERDICT.MIXED,
      aiSignals: Array.isArray(parsed.ai_signals) ? parsed.ai_signals.slice(0, 8) : [],
      humanSignals: Array.isArray(parsed.human_signals) ? parsed.human_signals.slice(0, 8) : [],
    };
  } catch {
    return null; // 网络失败 / 超时 / JSON 解析失败 → 降级
  } finally {
    clearTimeout(timer);
  }
}

/** 组装 /chat/completions 请求体：额外参数（JSON config，先铺）+ 核心字段（强制覆盖）。
 *  额外参数非法 JSON 时忽略（降级为最兼容模式），不阻塞调用。 */
function buildRequestBody(text, settings, ruleContext) {
  const body = {};
  try {
    const extra = settings.extraParams ? JSON.parse(settings.extraParams) : {};
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) Object.assign(body, extra);
  } catch {
    // 非法 JSON：调用侧兜底忽略额外参数
  }
  body.model = settings.apiModel;
  body.messages = [
    // system prompt 为动态模板：{{ai_slot_ctx}} 保留字替换为一审上下文；
    // 模板不含保留字时自动追加（保证一审信息不丢失）
    { role: 'system', content: buildSystemMessage(settings, ruleContext) },
    { role: 'user', content: text },
  ];
  body.response_format = { type: 'json_object' };
  return body;
}

/** 组装 system 消息：动态模板 + {{ai_slot_ctx}} 保留字替换/追加一审上下文 */
function buildSystemMessage(settings, ruleContext) {
  const template = settings.judgePrompt || ZD.CLOUD_SYSTEM_PROMPT;
  const ctx = buildFirstPassContext(ruleContext);
  if (!ctx) {
    // 无一审上下文时移除保留字（保留字本身不算有效指令）
    return template.split(ZD.CTX_SLOT).join('').replace(/\n{3,}/g, '\n\n').trim();
  }
  if (template.includes(ZD.CTX_SLOT)) {
    return template.split(ZD.CTX_SLOT).join(ctx);
  }
  return template + '\n\n' + ctx;
}

/** 一审（规则引擎）上下文文本：规则分 + 命中特征贡献清单（校准模式为带符号 logit 贡献） */
function buildFirstPassContext(ruleContext) {
  if (!ruleContext || typeof ruleContext.ruleScore !== 'number') return '';
  const parts = [];
  parts.push(`规则分（人类置信度）：${ruleContext.ruleScore} / 100`);
  const hits = ruleContext.hits || [];
  if (hits.length) {
    parts.push('命中的特征贡献（正 = 偏向人类，负 = 偏向 AI）：');
    hits.forEach((h) => {
      const v = Number(h.deduct);
      const sign = v >= 0 ? '+' : '';
      parts.push(`- ${h.name} ${sign}${v.toFixed(2)}`);
    });
  } else {
    parts.push('未命中任何特征。');
  }
  return parts.join('\n');
}
})();
