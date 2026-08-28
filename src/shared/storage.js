/**
 * 知乎照妖镜 — 存储助手
 * 依赖：constants.js（先加载）。
 * 提供：设置读写、覆盖读写、作者规则读写、二审缓存读写、二审预算读写。
 */
(() => {
'use strict';
const ZD = globalThis.ZhihuDetector;
const { KEYS, DEFAULTS } = ZD;

/** 二审预算键：tab + 维度（answer/article 隔离，互不挤占） */
function budgetKey(tabId, dim) {
  return String(tabId) + ':' + (dim || ZD.DIM.ANSWER);
}

ZD.storage = {
  /**
   * 读取设置，未保存项取默认值。
   * 版本化迁移（settingsVersion）：
   *  v2（校准引擎）：旧阈值默认值（40/70/[20,80]）与校准分数尺度不兼容；
   *    仅当存储值仍是旧默认（用户未自定义过阈值）时自动升级为 30/50/[30,50]。
   *  v3（文章跳过字数）：旧默认 300 → 800（折叠摘要常 <800 字），仅当仍是旧默认时升级。
   *  原则：只迁移未被用户自定义过的字段，尊重显式配置。
   */
  async getSettings() {
    const raw = await chrome.storage.local.get(KEYS.SETTINGS);
    const saved = raw[KEYS.SETTINGS] || {};
    const settings = { ...DEFAULTS, ...saved };
    const version = saved.settingsVersion === undefined ? 0 : saved.settingsVersion;
    let migrated = false;
    if (version < 2) {
      // v2：旧默认阈值（仅当存储值全部仍是旧默认才迁移，尊重用户自定义）
      const PREV = { thresholdConfirm: 40, thresholdSuspect: 70, fuzzyLow: 20, fuzzyHigh: 80 };
      const untouched = Object.entries(PREV).every(([k, v]) => saved[k] === undefined || saved[k] === v);
      if (untouched) {
        settings.thresholdConfirm = DEFAULTS.thresholdConfirm;
        settings.thresholdSuspect = DEFAULTS.thresholdSuspect;
        settings.fuzzyLow = DEFAULTS.fuzzyLow;
        settings.fuzzyHigh = DEFAULTS.fuzzyHigh;
      }
      migrated = true;
    }
    if (version < 3) {
      // v3：文章跳过字数旧默认 300 → 800（仅当仍是旧默认才迁移）
      if (saved.articleMinChars === 300) settings.articleMinChars = DEFAULTS.articleMinChars;
      migrated = true;
    }
    if (migrated) {
      settings.settingsVersion = 3;
      await chrome.storage.local.set({ [KEYS.SETTINGS]: settings });
    }
    return settings;
  },

  /** 保存设置（完整替换） */
  async saveSettings(settings) {
    await chrome.storage.local.set({ [KEYS.SETTINGS]: settings });
  },

  /** 读取全部覆盖 { answerId: {verdict,score,note,ts} } */
  async getOverrides() {
    const raw = await chrome.storage.local.get(KEYS.OVERRIDES);
    return raw[KEYS.OVERRIDES] || {};
  },

  /** 写入单条覆盖 */
  async setOverride(answerId, override) {
    const overrides = await ZD.storage.getOverrides();
    overrides[answerId] = override;
    await chrome.storage.local.set({ [KEYS.OVERRIDES]: overrides });
  },

  /** 清除单条覆盖 */
  async removeOverride(answerId) {
    const overrides = await ZD.storage.getOverrides();
    if (!(answerId in overrides)) return;
    delete overrides[answerId];
    await chrome.storage.local.set({ [KEYS.OVERRIDES]: overrides });
  },

  /** 读取作者规则 { blocked: {token:{name,ts}}, trusted: {token:{name,ts}} } */
  async getAuthorRules() {
    const raw = await chrome.storage.local.get(KEYS.AUTHOR_RULES);
    return raw[KEYS.AUTHOR_RULES] || { [ZD.AUTHOR_KIND.BLOCKED]: {}, [ZD.AUTHOR_KIND.TRUSTED]: {} };
  },

  /** 写入单条作者规则（kind: ZD.AUTHOR_KIND.*）。
   *  同一 token 在另一列表自动移除，保证两列表互斥（作者级规则唯一语义）。 */
  async setAuthorRule(kind, token, name) {
    const rules = await ZD.storage.getAuthorRules();
    const other = kind === ZD.AUTHOR_KIND.BLOCKED ? ZD.AUTHOR_KIND.TRUSTED : ZD.AUTHOR_KIND.BLOCKED;
    if (rules[other]) delete rules[other][token];
    rules[kind][token] = { name: name || '', ts: Date.now() };
    await chrome.storage.local.set({ [KEYS.AUTHOR_RULES]: rules });
  },

  /** 移除单条作者规则（不存在时静默） */
  async removeAuthorRule(kind, token) {
    const rules = await ZD.storage.getAuthorRules();
    if (!(rules[kind] && token in rules[kind])) return;
    delete rules[kind][token];
    await chrome.storage.local.set({ [KEYS.AUTHOR_RULES]: rules });
  },

  /** 读取二审缓存 { answerId: {score, aiSignals, humanSignals, ts} } */
  async getCache() {
    const raw = await chrome.storage.local.get(KEYS.CACHE);
    return raw[KEYS.CACHE] || {};
  },

  /** 写入二审缓存，超限按 ts 淘汰最旧条目（LRU：命中即刷新 ts，见 secondOpinion 缓存命中分支） */
  async setCacheEntry(answerId, entry) {
    const cache = await ZD.storage.getCache();
    cache[answerId] = entry;
    const ids = Object.keys(cache);
    if (ids.length > ZD.CACHE_LIMIT) {
      const sorted = ids.sort((a, b) => (cache[a].ts || 0) - (cache[b].ts || 0));
      for (const id of sorted.slice(0, ids.length - ZD.CACHE_LIMIT)) delete cache[id];
    }
    await chrome.storage.local.set({ [KEYS.CACHE]: cache });
  },

  /** 读取某 tab + 维度（answer/article）的本页二审预算（chrome.storage.session，SW 重启后仍有效）。
   *  回答与文章预算隔离，互不挤占（文章判定不消耗回答的每页调用上限）。 */
  async getBudget(tabId, dim) {
    const raw = await chrome.storage.session.get(KEYS.BUDGET);
    const budgets = raw[KEYS.BUDGET] || {};
    return budgets[budgetKey(tabId, dim)] || { used: 0, ts: 0 };
  },

  /** 写回某 tab + 维度的预算 */
  async setBudget(tabId, dim, budget) {
    const raw = await chrome.storage.session.get(KEYS.BUDGET);
    const budgets = raw[KEYS.BUDGET] || {};
    budgets[budgetKey(tabId, dim)] = budget;
    await chrome.storage.session.set({ [KEYS.BUDGET]: budgets });
  },
};
})();
