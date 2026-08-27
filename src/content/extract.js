/**
 * 知乎照妖镜 — 知乎问题页 DOM 提取
 * 选择器集中于此文件维护（知乎类名常变，单点修复）。
 * 依赖：constants.js（先加载）。
 */
(() => {
'use strict';
const ZD = globalThis.ZhihuDetector;

ZD.extract = {
  /** 回答卡片候选选择器（来自 research/zhihu-extension-facts.md） */
  CARD_SELECTOR: '.List-item, .Card.AnswerCard, .ContentItem.AnswerItem, .AnswerItem',

  /** 正文元素选择器（含折叠长文，无需展开请求） */
  BODY_SELECTOR: '.RichContent-inner, .RichContent',

  /**
   * 在 root 内查找回答卡片，去重并过滤掉不含正文的容器。
   * @param {ParentNode} root
   * @returns {Element[]}
   */
  findAnswerCards(root) {
    if (!root || !root.querySelectorAll) return [];
    const cards = [];
    const seen = new Set();
    const nodes = root.querySelectorAll(ZD.extract.CARD_SELECTOR);
    for (const node of nodes) {
      if (seen.has(node)) continue;
      // 通用去重：若 node 内部还包含更具体的回答卡片容器（如
      // .Card.AnswerCard 内嵌 .ContentItem.AnswerItem），node 只是外层
      // 容器，跳过，只保留最内层卡片，避免同一回答渲染重叠角标。
      if (node.querySelector(ZD.extract.CARD_SELECTOR)) continue;
      if (!node.querySelector(ZD.extract.BODY_SELECTOR)) continue;
      seen.add(node);
      cards.push(node);
    }
    return cards;
  },

  /**
   * 提取卡片作者：zhihu.com/people/<token> 为主键（稳定），昵称仅用于显示。
   * 来源：知乎 SSR 输出的 meta[itemprop="url"/"name"]（稳定）优先，
   *      兜底 a.UserLink-link（协议相对 //www.zhihu.com/people/…）。
   * 匿名回答：有 .AuthorInfo 但无 people 链接 → { anonymous: true }；
   * 无作者信息（非标准卡片）→ null。
   * @returns {{token:string,name:string}|{anonymous:true}|null}
   */
  getAuthor(card) {
    const info = card.querySelector('.AuthorInfo');
    if (!info) return null;

    let token = null;
    const metaUrl = info.querySelector('meta[itemprop="url"]');
    const urlContent = metaUrl && metaUrl.getAttribute('content');
    if (urlContent) {
      const m = urlContent.match(/\/people\/([^/?]+)/);
      if (m) token = m[1];
    }
    if (!token) {
      const link = info.querySelector('a[href*="/people/"]');
      const href = link && link.getAttribute('href');
      if (href) {
        const m = href.match(/\/people\/([^/?]+)/);
        if (m) token = m[1];
      }
    }
    if (!token) return { anonymous: true };

    let name = '';
    const metaName = info.querySelector('meta[itemprop="name"]');
    if (metaName && metaName.getAttribute('content')) {
      name = metaName.getAttribute('content').trim();
    }
    if (!name) {
      const link = info.querySelector('a[href*="/people/"]');
      if (link) name = link.textContent.trim();
    }
    return { token, name };
  },

  /**
   * 从卡片提取回答 ID：优先 /answer/<aid> 链接。
   * @returns {string|null}
   */
  getAnswerId(card) {
    const link = card.querySelector('a[href*="/answer/"]');
    if (link) {
      const m = link.getAttribute('href').match(/\/answer\/(\d+)/);
      if (m) return m[1];
    }
    return null;
  },

  /** 真实正文块元素：跳过内嵌卡片/图片占位(noscript)/元数据，只取正文 */
  BODY_BLOCK_SELECTOR: 'p, li, blockquote, h1, h2, h3, h4, h5, h6, pre',

  /**
   * 提取正文段落（只走块级正文元素）。
   * 知乎正文以 <p> 为主；NOSCRIPT 里的图片标记文本、内嵌卡片动态数字
   * （如"50 赞同 · 1 评论"）都被排除，避免内容级哈希不稳定。
   * @returns {string[]}
   */
  bodyParagraphs(card) {
    const bodyEl = card.querySelector(ZD.extract.BODY_SELECTOR);
    if (!bodyEl) return [];
    let paras = Array.from(bodyEl.querySelectorAll(ZD.extract.BODY_BLOCK_SELECTOR))
      .map((el) => el.textContent.trim())
      .filter(Boolean);
    if (paras.length === 0) {
      // 兜底：无块级正文时退回整段文本（按换行切分）
      paras = bodyEl.textContent
        .split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    // 跳过开头的图片占位/来源行
    while (paras.length && /^(\[图片\]|图片|图\d|via|来自|图片来源)/.test(paras[0])) paras.shift();
    // 跳过开头的引用段落（以引号起始的整段）
    while (paras.length > 1 && /^[「『“《]/.test(paras[0])) paras.shift();
    return paras;
  },

  /**
   * 回答本身字数（正文段落总长，未截断、不受 windowMode 影响）。
   * 用于判定字数下限：短回答直接跳过，不渲染角标。
   * @returns {number}
   */
  rawLength(card) {
    return ZD.extract.bodyParagraphs(card).join('\n').length;
  },

  /**
   * 提取输入窗口文本：只取真实正文块，跳过标题区、图/引用开头的空段落，
   * 按 maxChars 截断；windowMode='head' 时只看开头一两段。
   * @returns {string}
   */
  extractText(card, settings) {
    const paras = ZD.extract.bodyParagraphs(card);
    if (paras.length === 0) return '';

    let body;
    if (settings.windowMode === 'head') {
      body = paras.slice(0, 2).join('\n');
    } else {
      body = paras.join('\n');
    }
    if (settings.maxChars > 0 && body.length > settings.maxChars) {
      body = body.slice(0, settings.maxChars);
    }
    return body;
  },
};
})();
