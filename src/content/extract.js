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
      // 泛化的 .List-item 仅当其直接含正文时才视为回答卡片；
      // 若内部已包含更具体的回答卡片容器，则跳过外层。
      if (node.matches('.List-item') && node.querySelector('.Card.AnswerCard, .ContentItem.AnswerItem, .AnswerItem')) {
        continue;
      }
      if (!node.querySelector(ZD.extract.BODY_SELECTOR)) continue;
      seen.add(node);
      cards.push(node);
    }
    return cards;
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

  /**
   * 回答本身字数（原始正文长度，未截断、不受 windowMode 影响）。
   * 用于判定字数下限：短回答直接跳过，不渲染角标。
   * @returns {number}
   */
  rawLength(card) {
    const bodyEl = card.querySelector(ZD.extract.BODY_SELECTOR);
    return bodyEl ? bodyEl.textContent.trim().length : 0;
  },

  /**
   * 提取输入窗口文本：跳过标题区、图/引用开头的空段落，
   * 按 maxChars 截断；windowMode='head' 时只看开头一两段。
   * @returns {string}
   */
  extractText(card, settings) {
    const bodyEl = card.querySelector(ZD.extract.BODY_SELECTOR);
    if (!bodyEl) return '';
    const paras = bodyEl.textContent
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    // 跳过开头的图片占位/来源行
    while (paras.length && /^(\[图片\]|图片|图\d|via|来自|图片来源)/.test(paras[0])) paras.shift();
    // 跳过开头的引用段落（以引号起始的整段）
    while (paras.length > 1 && /^[「『“《]/.test(paras[0])) paras.shift();
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
