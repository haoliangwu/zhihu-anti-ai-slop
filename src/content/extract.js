/**
 * 知乎照妖镜 — 知乎问题页 DOM 提取
 * 选择器集中于此文件维护（知乎类名常变，单点修复）。
 * 依赖：constants.js（先加载）。
 */
(() => {
'use strict';
const ZD = globalThis.ZhihuDetector;

ZD.extract = {
  /** 回答/文章列表卡片候选选择器（文章卡 .ContentItem.ArticleItem 与回答卡同构：
   *  折叠摘要 RichContent + 阅读全文；纳入后 findCards 一并返回） */
  CARD_SELECTOR: '.List-item, .Card.AnswerCard, .ContentItem.AnswerItem, .AnswerItem, .ContentItem.ArticleItem, .ArticleItem',

  /** 正文元素选择器（含折叠长文，无需展开请求） */
  BODY_SELECTOR: '.RichContent-inner, .RichContent',

  /** 文章详情页容器（zhuanlan.zhihu.com 与 www.zhihu.com 的 /p/* 同构，Post-* 布局） */
  ARTICLE_CARD_SELECTOR: '.Post-Main, .Post-NormalMain',

  /** 文章正文容器（.Post-content 是外层包装、含整篇文章，正文段落在其内层 .Post-RichTextContainer） */
  ARTICLE_BODY_SELECTOR: '.Post-RichTextContainer',

  /** 文章标题（角标/面板挂载锚点：标题前） */
  ARTICLE_TITLE_SELECTOR: 'h1.Post-Title',

  /**
   * 在 root 内查找判定卡片（回答卡 + 文章列表卡），去重并过滤掉不含正文的容器。
   * @param {ParentNode} root
   * @returns {Element[]}
   */
  findCards(root) {
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

  /** 官方「包含 AI 辅助创作」创作声明文本（见 zhuanlan.zhihu.com/p/624717941 治理细则）。
   *  挂在卡片时间区 .ContentItem-time 内（SSR 首帧即存在，回答卡/文章卡/文章详情页共用）；
   *  外层 div 是 hash 类名（实测 css-18biwo），不可依赖，只匹配稳定文本。 */
  AI_DECLARATION_RE: /包含\s*AI\s*辅助创作/,

  /**
   * 卡片是否带「包含 AI 辅助创作」官方创作声明。
   * 作者已自认内容含 AI 辅助 → 跳过整条评分管线（提取/规则/二审）。
   * @param {Element} card 回答卡 / 文章列表卡 / 文章详情容器
   * @returns {boolean}
   */
  hasAiDeclaration(card) {
    if (!card) return false;
    const t = card.querySelector('.ContentItem-time');
    if (!t) return false;
    return ZD.extract.AI_DECLARATION_RE.test(t.textContent || '');
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
   * 从文章卡片提取文章 ID：/p/<id> 链接（列表卡与详情页共用同一 ID 命名空间）。
   * 优先卡片标题链接——列表卡常含多个 /p/ 链接（标题、阅读全文、相关推荐），
   * 首链接未必是卡片自身。
   * @returns {string|null}
   */
  getArticleId(card) {
    const titleLink = card.querySelector('.ContentItem-title a[href*="/p/"]');
    const link = titleLink || card.querySelector('a[href*="/p/"]');
    if (link) {
      const m = link.getAttribute('href').match(/\/p\/(\d+)/);
      if (m) return m[1];
    }
    return null;
  },

  /** 真实正文块元素：跳过内嵌卡片/图片占位(noscript)/元数据，只取正文。 */
  BODY_BLOCK_SELECTOR: 'p, li, blockquote, h1, h2, h3, h4, h5, h6',

  /** 非散文内容（代码/技术/嵌入物）：不参与任何写作特征计数。
   *  块级 pre 不在 BODY_BLOCK_SELECTOR 中（整体跳过）；行内 code 等从
   *  段落文本中剔除。理由：代码/配置不是写作痕迹，引号、冒号、编号等
   *  特征若在代码上线性计数会外推爆分（如 JSON 配置的英文引号 → 判 0 分）。
   *  注意：只按标签/知乎专用类匹配，勿用泛化的 [class*="..."] 猜测——
   *  知乎的划词高亮 .highlight-wrap 包裹的仍是作者正文（曾误伤）。 */
  NON_PROSE_SELECTOR: 'pre, code, kbd, samp, tt, math, .ztext-math, figure, figcaption, video, audio, iframe, embed, object, canvas, template, .ztext-video',

  /** 提取单块的散文文本：克隆后剔除代码/嵌入内容，避免其文本参与特征计数 */
  proseTextOf(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll(ZD.extract.NON_PROSE_SELECTOR).forEach((n) => n.remove());
    return clone.textContent.trim();
  },

  /** 剔除段尾孤悬全角冒号（冒号后紧跟换行或文末，如「prompt 如下：」+ 图片被剔除后的残渣）。
   *  issue 11：图文穿插排版的手写回答，图片/嵌入内容被 NON_PROSE_SELECTOR 剔除后文字流
   *  只剩一串指向图片的段尾冒号——不是写作痕迹，不参与任何特征计数（词法 colon-overuse
   *  与统计 punctDensity 同源豁免）。与训练语料的段尾孤悬定义（`：` 后接 \n 或文末）一致。
   *  @param {string} text */
  stripDanglingColons(text) {
    return text.replace(/：+(?=\n|$)/g, '');
  },

  /**
   * 提取正文段落（共用实现：块级正文元素优先，兜底整段切分）。
   * 知乎正文以 <p> 为主；NOSCRIPT 里的图片标记文本、内嵌卡片动态数字
   * （如"50 赞同 · 1 评论"）都被排除，避免内容级哈希不稳定。
   * @param {Element|null} bodyEl 正文容器元素
   * @returns {string[]}
   */
  paragraphsOf(bodyEl) {
    if (!bodyEl) return [];
    let paras = Array.from(bodyEl.querySelectorAll(ZD.extract.BODY_BLOCK_SELECTOR))
      // 代码/嵌入容器内的块级元素（如 pre 里的 li）一并跳过
      .filter((el) => !el.closest(ZD.extract.NON_PROSE_SELECTOR))
      .map((el) => ZD.extract.proseTextOf(el))
      .filter(Boolean);
    if (paras.length === 0) {
      // 兜底：无块级正文时退回整段文本（按换行切分），同样剔除代码/嵌入内容
      const clone = bodyEl.cloneNode(true);
      clone.querySelectorAll(ZD.extract.NON_PROSE_SELECTOR).forEach((n) => n.remove());
      paras = clone.textContent
        .split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    // 剔除段尾孤悬冒号（图片/嵌入内容被剔除后的残渣，issue 11）：两条路径统一处理
    paras = paras.map((s) => ZD.extract.stripDanglingColons(s)).filter(Boolean);
    // 跳过开头的图片占位/来源行
    while (paras.length && /^(\[图片\]|图片|图\d|via|来自|图片来源)/.test(paras[0])) paras.shift();
    // 跳过开头的引用段落（以引号起始的整段）
    while (paras.length > 1 && /^[「『“《]/.test(paras[0])) paras.shift();
    return paras;
  },

  /**
   * 提取正文段落（回答卡片）。
   * @returns {string[]}
   */
  bodyParagraphs(card) {
    return ZD.extract.paragraphsOf(card.querySelector(ZD.extract.BODY_SELECTOR));
  },

  /** 跳过与标题重复的首段（详情页/列表卡标题都可能重复出现在正文首段）。 */
  dropTitleDup(paras, titleEl) {
    if (paras.length && titleEl && paras[0] === titleEl.textContent.trim()) paras.shift();
    return paras;
  },

  /**
   * 提取文章正文段落：跳过首段标题（.Post-content 内嵌 H1 文章标题）。
   * @returns {string[]}
   */
  articleParagraphs(articleEl) {
    const bodyEl = articleEl.querySelector(ZD.extract.ARTICLE_BODY_SELECTOR);
    const paras = ZD.extract.paragraphsOf(bodyEl);
    return ZD.extract.dropTitleDup(paras, articleEl.querySelector(ZD.extract.ARTICLE_TITLE_SELECTOR));
  },

  /**
   * 回答本身字数（正文段落总长，未截断、不受 windowMode 影响）。
   * 用于判定字数下限：短回答直接跳过，不渲染角标。
   * @returns {number}
   */
  rawLength(card) {
    return ZD.extract.bodyParagraphs(card).join('\n').length;
  },

  /** 文章本身字数（不含标题，未截断） */
  articleRawLength(articleEl) {
    return ZD.extract.articleParagraphs(articleEl).join('\n').length;
  },

  /**
   * 文章列表卡正文段落（RichContent 折叠结构，与回答卡同构）。
   * 防御：折叠摘要首段若与卡片标题相同则跳过。
   * @returns {string[]}
   */
  articleListParagraphs(card) {
    const paras = ZD.extract.paragraphsOf(card.querySelector(ZD.extract.BODY_SELECTOR));
    return ZD.extract.dropTitleDup(paras, card.querySelector('.ContentItem-title'));
  },

  /** 文章列表卡本身字数（折叠摘要长度，未截断） */
  articleListRawLength(card) {
    return ZD.extract.articleListParagraphs(card).join('\n').length;
  },

  /**
   * 文章输入窗口文本（共用实现）：head = 开头两段；headtail（默认）= 头尾
   * 各取上限一半（万字长文也能覆盖结尾套话）；full = 全文截断至上限。
   * @param {string[]} paras 正文段落
   * @param {string} mode 抽样模式 'headtail' | 'full' | 'head'
   * @param {number} max 输入窗口字数上限
   * @returns {string}
   */
  windowText(paras, mode, max) {
    if (paras.length === 0) return '';
    if (mode === 'head') return paras.slice(0, 2).join('\n');
    const body = paras.join('\n');
    if (mode === 'headtail' && max > 0 && body.length > max) {
      // 省略标记计入上限：头尾各取 (max−标记长)/2，总长 ≤ max（默认 4000）
      const marker = '\n……（中段省略）……\n';
      const half = Math.floor((max - marker.length) / 2);
      return body.slice(0, half) + marker + body.slice(-half);
    }
    if (max > 0 && body.length > max) return body.slice(0, max);
    return body;
  },

  /**
   * 文章列表卡输入窗口文本（文章设置组：headtail/full/head）。
   * 折叠时 = 摘要；展开全文后文本变化 → 观察器按指纹自动重判。
   * @returns {string}
   */
  extractArticleListText(card, settings) {
    return ZD.extract.windowText(
      ZD.extract.articleListParagraphs(card),
      settings.articleWindowMode || 'headtail',
      settings.articleMaxChars || 4000
    );
  },

  /**
   * 提取文章输入窗口文本：跳过标题后按文章设置组抽样（见 windowText）。
   * @returns {string}
   */
  extractArticleText(articleEl, settings) {
    return ZD.extract.windowText(
      ZD.extract.articleParagraphs(articleEl),
      settings.articleWindowMode || 'headtail',
      settings.articleMaxChars || 4000
    );
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
