/**
 * 知乎照妖镜 — 内容脚本主逻辑
 * 流程：发现回答卡片 → 提取输入窗口 → 查覆盖 → 规则初审 →
 *      （模糊带且已配置 API）请求云端二审 → 渲染角标 / 理由面板 / 覆盖。
 * 依赖（按 manifest 加载顺序）：constants.js, storage.js, traces.js,
 *      rules.js, extract.js。
 */
'use strict';

(() => {
  const ZD = globalThis.ZhihuDetector;

  const state = {
    settings: { ...ZD.DEFAULTS },
    overrides: {},
    /** 作者规则 { blocked: {token:{name,ts}}, trusted: {token:{name,ts}} }
     *  硬规则：优先级 作者级 > 卡片覆盖 > 引擎判定 */
    authorRules: { [ZD.AUTHOR_KIND.BLOCKED]: {}, [ZD.AUTHOR_KIND.TRUSTED]: {} },
    /** 已分析卡片，避免 MutationObserver 重复触发 */
    analyzed: new WeakSet(),
    /** 进行中的分析，按卡片去重 */
    inFlight: new Map(),
    /** 手动"重新判定"的回答 ID 集合（二审强制绕过缓存） */
    forceRejudge: new Set(),
    /** 作者规则已应用（屏蔽/信任）的卡片：正文变化不触发重分析，
     *  规则由存储变化驱动，与内容无关 */
    ruleApplied: new WeakSet(),
    /** 卡片 → 最近一次分析时的正文输入窗口文本。
     *  正文变化重分析的指纹：只有输入窗口文本真的变化才重分析，
     *  避免知乎在 .RichContent 内追加操作栏/热评等 UI 节点触发无谓重分析。 */
    cardText: new WeakMap(),
    /** 文章详情页状态（同一时刻至多一篇；SPA 导航时按 pathname 重建） */
    article: { id: null, card: null, analyzed: false, text: '', inFlight: null },
    /** 上次见到的 pathname（文章页 SPA 导航检测） */
    lastPath: location.pathname,
  };

  // ---------- 云端二审请求（内容侧队列：≤2 并发，其余排队，不丢弃） ----------

  function requestSecondOpinion(text, rule, force, dimension) {
    return new Promise((resolve) => {
      // 内容侧等待比 SW 超时（CLOUD_TIMEOUT_MS）略长，保证 SW 中止后本处必然收尾
      const timer = setTimeout(() => resolve(null), ZD.CLOUD_TIMEOUT_MS + 5_000);
      try {
        chrome.runtime.sendMessage(
          {
            type: ZD.MSG.SECOND_OPINION,
            text,
            // 一审结果作为上下文传给二审（校准模式 = 带符号贡献，回退 = 扣分）
            ruleScore: rule.score,
            hits: rule.hits.map((h) => ({
              id: h.id,
              name: h.name,
              deduct: h.contribution !== undefined ? h.contribution : -h.deduct,
            })),
            // 手动"重新判定"时强制绕过缓存重新调用
            force: !!force,
            // 预算维度：文章与回答隔离
            dimension: dimension || ZD.DIM.ANSWER,
          },
          (resp) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) return resolve(null);
            resolve(resp && resp.ok ? resp : null);
          }
        );
      } catch {
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  const cloudQueue = {
    queue: [],
    active: 0,
    MAX: ZD.CLOUD_MAX_CONCURRENT,
    request(text, rule, force, dimension) {
      return new Promise((resolve) => {
        this.queue.push({ text, rule, force, dimension, resolve });
        this.pump();
      });
    },
    pump() {
      while (this.active < this.MAX && this.queue.length) {
        const item = this.queue.shift();
        this.active++;
        requestSecondOpinion(item.text, item.rule, item.force, item.dimension).then((result) => {
          this.active--;
          item.resolve(result);
          this.pump();
        });
      }
    },
  };

  // ---------- 分析管线 ----------

  function cloudEligible(ruleScore, settings) {
    return (
      settings.cloudEnabled &&
      !!settings.apiKey &&
      ruleScore >= settings.fuzzyLow &&
      ruleScore <= settings.fuzzyHigh
    );
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 覆盖判定结果（卡片/文章覆盖分支统一构造） */
  function overrideResult(overrideKey, override) {
    return {
      source: 'override',
      verdict: override.verdict,
      score: override.score,
      answerId: overrideKey,
      override,
    };
  }

  /** 云端二审融合结果（卡片/文章二审返回后统一构造） */
  function cloudResult(overrideKey, rule, cloud) {
    return {
      source: 'cloud',
      score: cloud.score,
      ruleScore: rule.score, // 一审规则分（角标显示"一审(融合)"，如 50(67)）
      hits: rule.hits,
      cloud: { aiSignals: cloud.aiSignals || [], humanSignals: cloud.humanSignals || [] },
      answerId: overrideKey,
    };
  }

  /**
   * 稳定化提取：SPA 渐进渲染时内容会变化，连续两次采样一致才返回，
   * 避免在部分渲染态取文本（这是缓存哈希不稳定的主因）。
   * 最多等 4 轮（约 2s），仍不稳定则返回最后一次采样。
   * @param {() => string} extractor 每次采样的提取函数（回答/文章各自封装）
   */
  async function extractStableText(extractor) {
    let prev = extractor();
    for (let i = 0; i < 4; i++) {
      await sleep(500);
      const cur = extractor();
      if (cur === prev) return cur;
      prev = cur;
    }
    return prev;
  }

  /**
   * 卡片输入窗口提取（按类型路由）：文章列表卡走文章设置组（headtail 抽样、
   * 文章上限/下限），回答卡走回答设置组。正文变化重分析指纹也用它，
   * 保证指纹与判定使用同一输入窗口。
   */
  function extractCardText(card) {
    return isArticleListCard(card)
      ? ZD.extract.extractArticleListText(card, state.settings)
      : ZD.extract.extractText(card, state.settings);
  }

  /** 文章列表卡识别（与详情页容器 .Post-Main 区分） */
  function isArticleListCard(card) {
    return !!card.classList.contains('ArticleItem');
  }

  /**
   * 分析单张回答/文章卡片，产出结果并渲染。
   * 文章列表卡与回答卡共用管线，差异：ID 命名空间（'p'+文章ID）、
   * 文章设置组（抽样/上限/下限）、二审预算维度（article 隔离）。
   * @returns {Promise<void>}
   */
  async function analyzeCard(card) {
    if (state.inFlight.has(card)) return state.inFlight.get(card);
    const p = (async () => {
      const isArticle = isArticleListCard(card);
      const rawId = isArticle ? ZD.extract.getArticleId(card) : ZD.extract.getAnswerId(card);
      const overrideKey = isArticle && rawId ? articleOverrideKey(rawId) : rawId;

      // 0) 作者级硬规则（优先级最高，先于卡片覆盖与引擎判定）：
      //    屏蔽 → 整卡占位；信任 → 零判定小签。均不产生任何提取与判定调用。
      if (applyAuthorRuleIfAny(card)) return;

      // 1) 覆盖优先（无需等待文本稳定，立即渲染）
      const override = overrideKey ? state.overrides[overrideKey] : null;
      if (override) {
        renderBadge(card, overrideResult(overrideKey, override));
        state.analyzed.add(card);
        state.cardText.set(card, extractCardText(card));
        return;
      }

      // 2) 文本稳定化。正文提取为空（无正文块）→ 不判定也不显示角标
      const text = await extractStableText(() => extractCardText(card));
      if (!text) {
        state.analyzed.add(card);
        state.cardText.set(card, '');
        return;
      }

      // 3) 字数下限：内容本身少于 minChars 判 AI 无意义，以"跳过"角标标记（0 关闭）。
      //    回答用回答下限、文章列表卡用文章下限（折叠摘要常 <300 → 跳过）
      const minChars = isArticle ? state.settings.articleMinChars || 0 : state.settings.minChars || 0;
      const rawLen = isArticle ? ZD.extract.articleListRawLength(card) : ZD.extract.rawLength(card);
      if (minChars > 0 && rawLen < minChars) {
        state.analyzed.add(card);
        state.cardText.set(card, text);
        renderSkippedBadge(card, minChars, isArticle ? '文章' : undefined);
        return;
      }

      // 4) 规则初审（含用户自定义正则规则）
      const rule = ZD.engine.score(text, state.settings.customTraces || []);
      let result = {
        source: 'rule',
        score: rule.score,
        hits: rule.hits,
        answerId: overrideKey,
      };

      // 5) 云端二审：已配置 API 且（手动"重新判定"强制 或 分数落入模糊带）。
      //    经内容侧队列限流，不丢弃；携带一审结果作上下文。
      //    文章卡二审走 article 预算维度（与回答隔离）。
      const forceRejudge = state.forceRejudge.delete(overrideKey);
      const cloudOn = state.settings.cloudEnabled && !!state.settings.apiKey;
      if (overrideKey && cloudOn && (forceRejudge || cloudEligible(rule.score, state.settings))) {
        // 初次分析：二审等待期先渲染"规则分 + 二审中"角标作为反馈
        // （手动"重新判定"已有独立大 loading，不重复渲染）
        if (!forceRejudge) renderPendingBadge(card, overrideKey, rule.score);
        const cloud = await cloudQueue.request(text, rule, forceRejudge, isArticle ? ZD.DIM.ARTICLE : ZD.DIM.ANSWER);
        if (cloud) result = cloudResult(overrideKey, rule, cloud);
      }

      renderBadge(card, result);
      state.analyzed.add(card);
      state.cardText.set(card, text);
    })();
    state.inFlight.set(card, p);
    try {
      await p;
    } finally {
      state.inFlight.delete(card);
    }
  }

  // ---------- 文章详情页判定 ----------

  /** 是否文章详情页（/p/<id>；www 与 zhuanlan.zhihu.com 同构 Post-* 布局） */
  function isArticlePage() {
    return /^\/p\/\d+/.test(location.pathname);
  }

  /** 文章容器识别：含文章标题且无回答正文（回答卡与文章卡不重叠） */
  function isArticleCard(card) {
    return !!card.querySelector(ZD.extract.ARTICLE_TITLE_SELECTOR) && !card.querySelector(ZD.extract.BODY_SELECTOR);
  }

  /** 文章覆盖键：'p'+id 前缀隔离命名空间（与回答 ID 不冲突） */
  function articleOverrideKey(articleId) {
    return 'p' + articleId;
  }

  /** 事件元素所属容器：回答卡或文章卡（两者共用同一套面板/占位组件） */
  function cardOf(el) {
    return el.closest(ZD.extract.CARD_SELECTOR) || el.closest(ZD.extract.ARTICLE_CARD_SELECTOR);
  }

  /**
   * 文章详情页判定管线：作者规则 → 覆盖 → 文章专用提取（跳标题 + 头尾抽样）→
   * 一审 → 二审（预算维度隔离，不消耗回答的每页上限）。
   * hideAiBody 不作用于文章正文（仅角标提示，不藏文）。
   * @param {boolean} [force] 跳过幂等守卫（路径变化/规则与设置变化/重新判定时）
   */
  async function analyzeArticle(force) {
    if (!isArticlePage()) return;
    const m = location.pathname.match(/^\/p\/(\d+)/);
    if (!m) return;
    const articleId = m[1];
    const card = document.querySelector(ZD.extract.ARTICLE_CARD_SELECTOR);
    if (!card) return; // 404 / 未渲染：无角标不报错

    // in-flight 去重：文章管线无并发保护时，MutationObserver 在"重新判定中"
    // 再次触发 analyzeArticle 会开第二条无 force 管道——它消费不到 forceRejudge，
    // 会以一审结果 renderBadge 立即清掉 loading，而 force 管道的二审请求仍在
    // SW 侧飞行（表象 = 加载动画马上终止，但 sw.js 请求还在加载）。
    // 普通触发复用现有管道；手动"重新判定"（force）等当前管道收尾后再重跑。
    if (state.article.inFlight) {
      if (!force) return state.article.inFlight;
      try {
        await state.article.inFlight;
      } catch {
        // 旧管道内部自行吞错，此处只需等待其 UI 收尾
      }
      return analyzeArticle(true);
    }

    const p = (async () => {
      // 幂等：同一篇文章同一容器已分析则跳过（SPA 渐进渲染期间的重复触发）
      if (!force && state.article.analyzed && state.article.id === articleId && state.article.card === card) return;
      state.article.id = articleId;
      state.article.card = card;
      state.article.analyzed = false;

    // 0) 作者规则（复用回答卡组件；占位条/信任小签同样作用于文章容器）
    if (applyAuthorRuleIfAny(card)) {
      state.article.analyzed = true;
      return;
    }

    // 1) 覆盖（'p'+id 命名空间，与回答覆盖互不干扰）
    const overrideKey = articleOverrideKey(articleId);
    const override = state.overrides[overrideKey];
    if (override) {
      renderBadge(card, overrideResult(overrideKey, override));
      state.article.analyzed = true;
      return;
    }

    // 2) 提取：文章专用（跳标题、头尾抽样、文章设置组），稳定化防渐进渲染。
    //    正文可能懒渲染（init 时 .Post-content 未出现 → 文本为空）：此时记录空指纹，
    //    观察器发现正文文本变化后再重试。
    const text = await extractStableText(() => ZD.extract.extractArticleText(card, state.settings));
    state.article.text = text;
    if (!text) {
      state.article.analyzed = true;
      return;
    }

    // 3) 字数下限（文章设置组独立）
    const minChars = state.settings.articleMinChars || 0;
    if (minChars > 0 && ZD.extract.articleRawLength(card) < minChars) {
      state.article.analyzed = true;
      renderSkippedBadge(card, minChars, '文章');
      return;
    }

    // 4) 规则初审（阈值与回答共享）
    const rule = ZD.engine.score(text, state.settings.customTraces || []);
    let result = { source: 'rule', score: rule.score, hits: rule.hits, answerId: overrideKey };

    // 5) 云端二审（维度 = article，预算独立；手动"重新判定"强制绕过缓存）
    const forceRejudge = state.forceRejudge.delete(overrideKey);
    const cloudOn = state.settings.cloudEnabled && !!state.settings.apiKey;
    if (cloudOn && (forceRejudge || cloudEligible(rule.score, state.settings))) {
      if (!forceRejudge) renderPendingBadge(card, overrideKey, rule.score);
      const cloud = await cloudQueue.request(text, rule, forceRejudge, ZD.DIM.ARTICLE);
      if (cloud) result = cloudResult(overrideKey, rule, cloud);
    }

    renderBadge(card, result);
      state.article.analyzed = true;
    })();
    state.article.inFlight = p;
    try {
      await p;
    } finally {
      // 只有仍持有该管道时才清空（新 force 管道接管后由它自己管理）
      if (state.article.inFlight === p) state.article.inFlight = null;
    }
  }
  /** 清理文章规则 UI（离开文章页时调用） */
  function cleanupArticleUI(card) {
    if (!card) return;
    clearCardUI(card);
    clearPanels(card);
  }

  /** 分批处理一组卡片，rAF 节流避免阻塞主线程 */
  async function analyzeCards(cards) {
    const BATCH = 20;
    for (let i = 0; i < cards.length; i += BATCH) {
      await new Promise((r) =>
        requestAnimationFrame(() => {
          cards.slice(i, i + BATCH).forEach((c) => analyzeCard(c));
          r();
        })
      );
    }
  }

  // ---------- 角标渲染 ----------

  const LEVEL_CLASS = {
    [ZD.LEVEL.CONFIRM_AI]: 'zys-level-confirm-ai',
    [ZD.LEVEL.SUSPECT_AI]: 'zys-level-suspect-ai',
    [ZD.LEVEL.NORMAL]: 'zys-level-normal',
    [ZD.LEVEL.SKIP]: 'zys-level-skip',
  };

  /** 卡片正文元素（未渲染正文时返回 null） */
  function bodyOf(card) {
    return card.querySelector(ZD.extract.BODY_SELECTOR);
  }

  /** 移除卡片上的角标/面板/加载占位（全量清理；"重新判定"等需要换 loading 的场景） */
  function clearCardUI(card) {
    card.querySelectorAll('.zys-badge, .zys-panel, .zys-rejudging').forEach((el) => el.remove());
  }

  /** 只清面板/加载占位与作者规则 UI（render 路径：角标节点原位复用，不删除重建，避免闪动；
   *  作者规则 UI 是独立元素，正常判定渲染前必须移除并恢复卡片内容显示） */
  function clearPanels(card) {
    card.querySelectorAll('.zys-panel, .zys-rejudging, .zys-blocked, .zys-trusted, .zys-trusted-panel').forEach((el) => el.remove());
    card.classList.remove('zys-rule-blocked', 'zys-viewing');
  }

  /** 取卡片现有角标节点，无则创建并插入；原位更新统一入口 */
  function badgeOf(card) {
    const existing = card.querySelector('.zys-badge');
    if (existing) return existing;
    const badge = document.createElement('div');
    badge.className = 'zys-badge';
    badge.setAttribute('tabindex', '0');
    insertBeforeBody(card, badge);
    return badge;
  }

  /** 把元素插到正文前；无正文时置于卡片顶部（badge/panel/loading 统一入口）。
   *  文章详情页容器无回答正文 → 插到标题前（角标/面板在标题/作者区旁）。 */
  function insertBeforeBody(card, el) {
    const anchor = bodyOf(card);
    if (anchor) anchor.insertAdjacentElement('beforebegin', el);
    else {
      const title = card.querySelector(ZD.extract.ARTICLE_TITLE_SELECTOR);
      if (title) title.insertAdjacentElement('beforebegin', el);
      else card.prepend(el);
    }
  }

  // ---------- 作者规则 UI ----------

  /** 查询作者 token 命中的规则 */
  function authorRuleFor(token) {
    if (!token) return null;
    if (state.authorRules[ZD.AUTHOR_KIND.BLOCKED][token]) return { kind: ZD.AUTHOR_KIND.BLOCKED, entry: state.authorRules[ZD.AUTHOR_KIND.BLOCKED][token] };
    if (state.authorRules[ZD.AUTHOR_KIND.TRUSTED][token]) return { kind: ZD.AUTHOR_KIND.TRUSTED, entry: state.authorRules[ZD.AUTHOR_KIND.TRUSTED][token] };
    return null;
  }

  /**
   * 应用作者规则 UI（屏蔽占位 / 信任小签）+ 昵称补全 + 状态标记。
   * 幂等：同一作者已有规则 UI 则保留现状（[查看] 展开态不被打断）。
   */
  function applyAuthorRuleUI(card, author, rule) {
    // 昵称补全：选项页按主页链接添加的作者无昵称，首次在页面遇到时从 DOM 补全
    //（仅名称变化时写一次；storage 监听触发重扫后名称一致即终止，无循环）
    const entry = rule.entry;
    if (author.name && entry.name !== author.name) {
      state.authorRules[rule.kind][author.token] = { ...entry, name: author.name };
      chrome.storage.local.set({ [ZD.KEYS.AUTHOR_RULES]: state.authorRules });
    }
    if (rule.kind === ZD.AUTHOR_KIND.BLOCKED) renderBlockedBar(card, author, entry);
    else renderTrustedChip(card, author, entry);
    state.analyzed.add(card);
    state.ruleApplied.add(card);
  }

  /**
   * 分析/渲染时刻的作者规则守卫：卡片作者命中规则 → 立即应用规则 UI。
   * 解决竞态——规则变化时卡片若正处于云端二审管道中（in-flight），旧管道
   * 完成后仍会执行 render*，若不在渲染前再查一次规则，会把新渲染的
   * 占位条/信任小签清掉并显示旧判定。
   * @returns {boolean} 规则已应用（调用方应停止渲染）
   */
  function applyAuthorRuleIfAny(card) {
    const author = ZD.extract.getAuthor(card);
    if (!author || author.anonymous) return false;
    const rule = authorRuleFor(author.token);
    if (!rule) return false;
    applyAuthorRuleUI(card, author, rule);
    return true;
  }

  /**
   * 屏蔽占位条：整卡被占位层覆盖（正文/操作区不可见、不可交互），
   * 仅显示「已屏蔽作者 X」+ [查看][取消屏蔽]。幂等：同一作者已有占位条
   * （含 [查看] 展开态）则保留现状，避免重分析/规则重扫打断查看。
   */
  function renderBlockedBar(card, author, entry) {
    const existing = card.querySelector('.zys-blocked');
    if (existing && existing.dataset.zysToken === author.token) return;
    clearCardUI(card);
    clearPanels(card);
    card.classList.add('zys-rule-blocked');

    const bar = document.createElement('div');
    bar.className = 'zys-blocked';
    bar.dataset.zysToken = author.token;
    const label = document.createElement('span');
    label.className = 'zys-blocked-label';
    label.textContent = `已屏蔽作者 ${entry.name || author.name || '（未知昵称）'}`;
    const viewBtn = document.createElement('button');
    viewBtn.type = 'button';
    viewBtn.dataset.zysBlockView = '1';
    viewBtn.textContent = '查看';
    const unblockBtn = document.createElement('button');
    unblockBtn.type = 'button';
    unblockBtn.dataset.zysUnblock = '1';
    unblockBtn.textContent = '取消屏蔽';
    bar.appendChild(label);
    bar.appendChild(viewBtn);
    bar.appendChild(unblockBtn);
    card.prepend(bar);
  }

  /**
   * 信任小签：极低调灰色「已信任」，一轮不跑（零角标）；点击展开小面板，
   * 可取消信任 / 改为屏蔽。幂等逻辑同屏蔽占位条。
   */
  function renderTrustedChip(card, author, entry) {
    const existing = card.querySelector('.zys-trusted');
    if (existing && existing.dataset.zysToken === author.token) return;
    clearCardUI(card);
    clearPanels(card);

    const chip = document.createElement('div');
    chip.className = 'zys-trusted';
    chip.dataset.zysToken = author.token;
    chip.dataset.zysName = entry.name || author.name || '';
    chip.setAttribute('tabindex', '0');
    chip.textContent = '已信任';

    const panel = document.createElement('div');
    panel.className = 'zys-trusted-panel';
    panel.hidden = true;
    const hint = document.createElement('p');
    hint.className = 'zys-empty';
    hint.textContent = `已信任作者 ${entry.name || author.name || '（未知昵称）'}：跳过全部检测，直接视为人工。`;
    const actions = document.createElement('div');
    actions.className = 'zys-actions';
    const untrustBtn = document.createElement('button');
    untrustBtn.type = 'button';
    untrustBtn.dataset.zysUntrust = '1';
    untrustBtn.textContent = '取消信任';
    const blockBtn = document.createElement('button');
    blockBtn.type = 'button';
    blockBtn.dataset.zysBlockAuthor = '1';
    blockBtn.textContent = '屏蔽该作者';
    actions.appendChild(untrustBtn);
    actions.appendChild(blockBtn);
    panel.appendChild(hint);
    panel.appendChild(actions);

    const toggle = () => {
      panel.hidden = !panel.hidden;
    };
    chip.addEventListener('click', toggle);
    chip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });

    insertBeforeBody(card, chip);
    insertBeforeBody(card, panel);
  }

  /** 已绑定过切换监听的面板角标（原位复用时只更新面板引用，不重复绑定） */
  const boundBadges = new WeakSet();

  /** 绑定角标点击/回车切换面板 */
  function bindPanelToggle(badge, panel) {
    badge._zysPanel = panel; // 角标节点复用时指向最新面板
    if (boundBadges.has(badge)) return;
    boundBadges.add(badge);
    badge.addEventListener('click', () => {
      if (badge._zysPanel) badge._zysPanel.hidden = !badge._zysPanel.hidden;
    });
    badge.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (badge._zysPanel) badge._zysPanel.hidden = !badge._zysPanel.hidden;
      }
    });
  }

  /** 角标分数文案：覆盖显示 人/AI；二审显示"一审分(融合分)"如 50(67)；其余显示分数 */
  function badgeScoreText(result) {
    if (result.source === 'override') return result.verdict === ZD.VERDICT.AI ? 'AI' : '人';
    if (result.source === 'cloud' && typeof result.ruleScore === 'number') {
      return `${result.ruleScore}(${result.score})`;
    }
    return String(result.score);
  }

  /** 角标 meta 文案：已覆盖 / 二审 / N 条痕迹 / 未命中 */
  function badgeMetaText(result) {
    if (result.source === 'override') return '已覆盖';
    if (result.source === 'cloud') return '二审';
    const count = (result.hits && result.hits.length) || 0;
    return count > 0 ? `${count} 条痕迹` : '未命中';
  }

  /** 命中清单文案：校准模式 = 带符号贡献（正=偏人类），回退模式 = 扣分 */
  function hitText(h) {
    if (h.contribution !== undefined) {
      const v = h.contribution;
      const sign = v >= 0 ? '+' : '';
      // 统计特征（票 10）：连续值无命中次数，显示数值；词法特征显示 ×次数
      if (h.value !== undefined) return `${h.name} ${h.value}：${sign}${v.toFixed(2)}`;
      return `${h.name} ×${h.count}：${sign}${Number.isInteger(v) ? v : v.toFixed(2)}`;
    }
    return `${h.name} -${h.deduct} 分`;
  }

  /**
   * 二审进行中的反馈角标：初次分析时规则初审已完成、云端二审尚未返回，
   * 直接显示规则一审分数 + "二审中"标签（灰调），二审完成后原位更新为
   * 融合分与最终判定——角标从开始就有数字，只微调不跳变。
   * 已有判定角标的卡片（正文变化重分析）不降级为"二审中"，保留旧结果直至新结果就绪。
   * 不可点击（无面板）；手动"重新判定"走独立的大 loading，不走到这里。
   */
  function renderPendingBadge(card, answerId, ruleScore) {
    if (applyAuthorRuleIfAny(card)) return; // 渲染时刻作者规则优先（竞态守卫）
    if (card.querySelector('.zys-badge')) return;
    clearPanels(card);
    const badge = badgeOf(card);
    badge.className = 'zys-badge zys-pending';
    badge.dataset.zysAid = answerId || '';
    badge.textContent = '';
    const scoreEl = document.createElement('span');
    scoreEl.className = 'zys-score';
    scoreEl.textContent = String(ruleScore);
    const labelEl = document.createElement('span');
    labelEl.className = 'zys-level';
    labelEl.textContent = '二审中';
    badge.appendChild(scoreEl);
    badge.appendChild(labelEl);
  }

  /** 面板操作按钮（统一构造；action 为 zysAction 取值或判定 verdict） */
  function actionButton(label, action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.dataset.zysAction = action;
    return b;
  }

  /** 面板操作区追加作者级按钮（匿名/无作者卡不显示）。返回是否追加成功。 */
  function appendAuthorActions(actions, card) {
    const author = ZD.extract.getAuthor(card);
    if (!author || author.anonymous || !author.token) return false;
    actions.appendChild(actionButton('屏蔽该作者', 'block-author'));
    actions.appendChild(actionButton('信任该作者', 'trust-author'));
    return true;
  }

  /** 渲染"跳过"角标：内容本身字数少于 minChars，不判定。
   * 与"未命中"区分：跳过 = 太短不判；未命中 = 判了但没命中痕迹。
   * 角标节点原位复用（跳过 ↔ 判定 双向切换不删除重建）。
   * @param {string} [noun] 内容类型称谓（回答 / 文章）
   */
  function renderSkippedBadge(card, minChars, noun) {
    if (applyAuthorRuleIfAny(card)) return; // 渲染时刻作者规则优先（竞态守卫）
    clearPanels(card);
    const badge = badgeOf(card);
    badge.className = 'zys-badge zys-level-skip';
    badge.dataset.zysAid = badge.dataset.zysAid || '';
    badge.textContent = '';

    const labelEl = document.createElement('span');
    labelEl.className = 'zys-level';
    labelEl.textContent = '跳过';
    badge.appendChild(labelEl);

    const metaEl = document.createElement('span');
    metaEl.className = 'zys-meta';
    metaEl.textContent = `少于 ${minChars} 字`;
    badge.appendChild(metaEl);

    const nounText = noun || '回答';
    const panel = document.createElement('div');
    panel.className = 'zys-panel';
    panel.hidden = true;
    const p = document.createElement('p');
    p.className = 'zys-empty';
    p.textContent = `${nounText}本身不足 ${minChars} 字，跳过 AI 判定。`;
    panel.appendChild(p);
    // 跳过卡同样可操作作者（屏蔽/信任），与判定卡面板一致
    const actions = document.createElement('div');
    actions.className = 'zys-actions';
    if (appendAuthorActions(actions, card)) panel.appendChild(actions);
    bindPanelToggle(badge, panel);
    insertBeforeBody(card, panel);
  }

  function levelOfResult(result) {
    if (result.source === 'override') {
      return result.verdict === ZD.VERDICT.AI
        ? { level: ZD.LEVEL.CONFIRM_AI, label: '覆盖·认为 AI' }
        : { level: ZD.LEVEL.NORMAL, label: '覆盖·认为人工' };
    }
    return ZD.engine.levelOf(result.score, state.settings);
  }

  function renderBadge(card, result) {
    if (applyAuthorRuleIfAny(card)) return; // 渲染时刻作者规则优先（竞态守卫）
    clearPanels(card); // 只清面板；角标节点原位更新（二审中→最终、跳过→判定，不闪动）

    const lv = levelOfResult(result);
    const badge = badgeOf(card);
    badge.className = `zys-badge ${LEVEL_CLASS[lv.level]}`;
    badge.dataset.zysAid = result.answerId || '';
    badge.textContent = '';

    const scoreEl = document.createElement('span');
    scoreEl.className = 'zys-score';
    scoreEl.textContent = badgeScoreText(result);
    badge.appendChild(scoreEl);

    const labelEl = document.createElement('span');
    labelEl.className = 'zys-level';
    labelEl.textContent = lv.label;
    badge.appendChild(labelEl);

    const metaEl = document.createElement('span');
    metaEl.className = 'zys-meta';
    metaEl.textContent = badgeMetaText(result);
    badge.appendChild(metaEl);

    // 理由面板
    const panel = document.createElement('div');
    panel.className = 'zys-panel';
    panel.hidden = true;
    const isCloud = result.source === 'cloud';
    // 二审面板含较长的 judge 反馈，直接占满父容器（100%）；一审痕迹面板保持自适应
    if (isCloud) panel.classList.add('zys-panel-full');

    const titleEl = document.createElement('div');
    titleEl.className = 'zys-panel-title';
    titleEl.textContent = `判定：${lv.label}` + (isCloud ? `（云端二审，人类置信度 ${result.score}）` : `（人类置信度 ${result.score}）`);
    panel.appendChild(titleEl);

    if (result.hits && result.hits.length > 0) {
      const list = document.createElement('ul');
      list.className = 'zys-hits';
      result.hits.forEach((h) => {
        const li = document.createElement('li');
        li.textContent = hitText(h);
        // 校准模式按贡献符号着色（正=偏人类绿、负=偏 AI 红）；
        // 回退扣分制 / 自定义规则扣分（negative contribution）统一按负面红色。
        if (h.contribution !== undefined) {
          li.classList.add(h.contribution >= 0 ? 'zys-contrib-pos' : 'zys-contrib-neg');
        } else {
          li.classList.add('zys-contrib-neg');
        }
        list.appendChild(li);
      });
      panel.appendChild(list);
      // 校准模式：解释带符号贡献的语义（正=偏人类；自定义规则扣分为分数尺度）
      if (result.hits[0].contribution !== undefined) {
        const note = document.createElement('p');
        note.className = 'zys-empty';
        note.textContent = '特征贡献：正 = 偏向人类，负 = 偏向 AI；分数 = 校准概率 × 100';
        panel.appendChild(note);
      }
    } else if (result.source !== 'override') {
      const p = document.createElement('p');
      p.className = 'zys-empty';
      p.textContent = '未命中明显的 AI 创作痕迹。';
      panel.appendChild(p);
    }

    if (result.cloud) {
      // 只渲染有内容的信号；AI/人工倾向均为空则不显示证据块。
      // 分段标识：每类倾向一个区块标题 + 逐条列表，便于审查。
      const ai = (result.cloud.aiSignals || []).filter(Boolean);
      const human = (result.cloud.humanSignals || []).filter(Boolean);
      if (ai.length || human.length) {
        const cloudEl = document.createElement('div');
        cloudEl.className = 'zys-cloud';
        const addSection = (title, items) => {
          const t = document.createElement('div');
          t.className = 'zys-evidence-title';
          t.textContent = title;
          cloudEl.appendChild(t);
          const ul = document.createElement('ul');
          ul.className = 'zys-evidence-list';
          items.forEach((s) => {
            const li = document.createElement('li');
            li.textContent = s;
            ul.appendChild(li);
          });
          cloudEl.appendChild(ul);
        };
        if (ai.length) addSection('AI 倾向', ai);
        if (human.length) addSection('人工倾向', human);
        panel.appendChild(cloudEl);
      }
    }

    if (result.answerId) {
      const actions = document.createElement('div');
      actions.className = 'zys-actions';
      actions.appendChild(actionButton('认为人工', ZD.VERDICT.HUMAN));
      actions.appendChild(actionButton('认为 AI', ZD.VERDICT.AI));
      if (result.source === 'override') actions.appendChild(actionButton('清除覆盖', 'clear'));
      actions.appendChild(actionButton('重新判定', 'rejudge'));
      // 作者级操作（匿名卡无作者可操作，不显示）
      appendAuthorActions(actions, card);
      panel.appendChild(actions);
    }

    // P1：AI 判定 → 隐藏正文；原因与证据点击角标才展开（所有面板统一收起）
    const bodyEl = bodyOf(card);
    const isAiLevel = lv.level === ZD.LEVEL.CONFIRM_AI || lv.level === ZD.LEVEL.SUSPECT_AI;
    const hideBody = isAiLevel && state.settings.hideAiBody;
    if (bodyEl) bodyEl.style.display = hideBody ? 'none' : ''; // 重渲染时重置可见性（SPA 后自动重新应用）
    if (hideBody && bodyEl) {
      const expandBtn = document.createElement('button');
      expandBtn.type = 'button';
      expandBtn.dataset.zysExpand = '1';
      expandBtn.textContent = '展开原文';
      expandBtn.className = 'zys-expand-btn';
      panel.appendChild(expandBtn);
    }

    bindPanelToggle(badge, panel);
    insertBeforeBody(card, panel);
  }

  // ---------- 覆盖操作 ----------

  /**
   * 手动重新判定：隐藏旧结果并显示加载动画，重置分析状态，
   * 强制二审绕过缓存重新调用；完成后新角标淡入。
   */
  async function rejudge(card, answerId) {
    if (!answerId) return;

    // 隐藏旧结果，显示"重新判定中"加载动画
    clearCardUI(card);
    const loading = document.createElement('div');
    loading.className = 'zys-rejudging';
    const spinner = document.createElement('span');
    spinner.className = 'zys-spinner';
    const label = document.createElement('span');
    label.className = 'zys-rejudging-label';
    label.textContent = '重新判定中…';
    loading.appendChild(spinner);
    loading.appendChild(label);
    insertBeforeBody(card, loading);

    // 重置分析状态并重跑（render 会清理 loading）；文章容器走文章管线
    state.analyzed.delete(card);
    state.inFlight.delete(card);
    state.forceRejudge.add(answerId);
    await rerunPipeline(card);
  }

  async function applyOverride(card, answerId, verdict) {
    if (!answerId) return;
    const override = {
      verdict,
      score: verdict === ZD.VERDICT.AI ? Math.min(state.settings.thresholdConfirm, 10) : 100,
      note: 'manual',
      ts: Date.now(),
    };
    await ZD.storage.setOverride(answerId, override);
    state.overrides[answerId] = override;
    await rerunPipeline(card); // 重新渲染为覆盖状态
  }

  async function clearOverride(card, answerId) {
    if (!answerId) return;
    await ZD.storage.removeOverride(answerId);
    delete state.overrides[answerId];
    state.analyzed.delete(card);
    await rerunPipeline(card); // 重新按引擎判定
  }

  /** 手动操作后的重跑分发：文章容器走文章管线（覆盖操作同样适用，
   *  否则 .Post-Main 被当回答卡分析——取错 answerId / 误触发 hideAiBody） */
  async function rerunPipeline(card) {
    if (isArticleCard(card)) await analyzeArticle(true);
    else await analyzeCard(card);
  }

  // 事件委托：按钮
  document.addEventListener('click', async (e) => {
    // P1：展开/收起原文
    const expandBtn = e.target.closest('[data-zys-expand]');
    if (expandBtn) {
      e.stopPropagation();
      const card = cardOf(expandBtn);
      const bodyEl = card ? bodyOf(card) : null;
      if (card && bodyEl) {
        const hidden = bodyEl.style.display === 'none';
        bodyEl.style.display = hidden ? '' : 'none';
        expandBtn.textContent = hidden ? '收起原文' : '展开原文';
      }
      return;
    }

    // 屏蔽占位条：查看/收起正文（临时展开，页面重分析后仍保持屏蔽）
    const viewBtn = e.target.closest('[data-zys-block-view]');
    if (viewBtn) {
      e.stopPropagation();
      const card = cardOf(viewBtn);
      if (card) {
        const viewing = card.classList.toggle('zys-viewing');
        viewBtn.textContent = viewing ? '收起' : '查看';
      }
      return;
    }

    // 屏蔽占位条：取消屏蔽（规则移除由 storage.onChanged 驱动重扫）
    const unblockBtn = e.target.closest('[data-zys-unblock]');
    if (unblockBtn) {
      e.stopPropagation();
      const card = cardOf(unblockBtn);
      const bar = unblockBtn.closest('.zys-blocked');
      const token = bar && bar.dataset.zysToken;
      if (card && token) await ZD.storage.removeAuthorRule(ZD.AUTHOR_KIND.BLOCKED, token);
      return;
    }

    // 信任面板：取消信任 / 屏蔽该作者（按钮都位于 .zys-trusted 小签面板内）
    const chipBtn = e.target.closest('[data-zys-untrust], [data-zys-block-author]');
    if (chipBtn) {
      e.stopPropagation();
      const card = cardOf(chipBtn);
      const chip = card && card.querySelector('.zys-trusted');
      const token = chip && chip.dataset.zysToken;
      if (card && token) {
        if (chipBtn.dataset.zysUntrust) await ZD.storage.removeAuthorRule(ZD.AUTHOR_KIND.TRUSTED, token);
        else await ZD.storage.setAuthorRule(ZD.AUTHOR_KIND.BLOCKED, token, chip.dataset.zysName);
      }
      return;
    }

    const btn = e.target.closest('[data-zys-action]');
    if (!btn) return;
    e.stopPropagation();
    const card = cardOf(btn);
    if (!card) return;

    // 作者级操作不需要回答 ID（跳过卡面板同样可用；匿名卡按钮不渲染，此处兜底防错）
    const action = btn.dataset.zysAction;
    if (action === 'block-author' || action === 'trust-author') {
      const a = ZD.extract.getAuthor(card);
      if (a && !a.anonymous && a.token) {
        const kind = action === 'block-author' ? ZD.AUTHOR_KIND.BLOCKED : ZD.AUTHOR_KIND.TRUSTED;
        await ZD.storage.setAuthorRule(kind, a.token, a.name);
      }
      return;
    }

    const badge = card.querySelector('.zys-badge');
    const answerId = badge ? badge.dataset.zysAid : '';
    if (!answerId) return;
    switch (action) {
      case ZD.VERDICT.HUMAN:
        await applyOverride(card, answerId, ZD.VERDICT.HUMAN);
        break;
      case ZD.VERDICT.AI:
        await applyOverride(card, answerId, ZD.VERDICT.AI);
        break;
      case 'clear':
        await clearOverride(card, answerId);
        break;
      case 'rejudge':
        await rejudge(card, answerId);
        break;
    }
  });

  // ---------- 触发：初始 + 滚动 + 消息 ----------

  /** 按作者 token 集合重扫页面卡片（规则变化即时生效）。
   *  跳过无作者/匿名卡；命中 token 的卡片重置后立即重跑 analyzeCard（同步触发，
   *  不等旧分析管道——渲染时刻的 applyAuthorRuleIfAny 守卫保证旧管道完成后
   *  渲染的是规则 UI 而非被覆盖的旧判定）。 */
  function reapplyAuthorRules(tokens) {
    for (const card of ZD.extract.findCards(document)) {
      const author = ZD.extract.getAuthor(card);
      if (!author || author.anonymous || !author.token) continue;
      if (!tokens.has(author.token)) continue;
      state.analyzed.delete(card);
      state.inFlight.delete(card);
      state.ruleApplied.delete(card);
      analyzeCard(card);
    }
  }

  /** 正文变化重分析防抖（按卡片）：知乎渐进渲染（分段补全/图片懒加载等）
   *  会产生多次正文变更，合并为一次重分析，避免角标反复原位更新造成闪动。 */
  const reanalyzeTimers = new Map();

  function scheduleReanalyze(card) {
    const timer = reanalyzeTimers.get(card);
    if (timer) clearTimeout(timer);
    reanalyzeTimers.set(
      card,
      setTimeout(() => {
        reanalyzeTimers.delete(card);
        state.analyzed.delete(card);
        state.inFlight.delete(card);
        analyzeCards([card]);
      }, 700)
    );
  }

  function processAddedNodes(nodes) {
    // 文章详情页：SPA 导航（pathname 变化）或文章容器出现/替换 → 分析；
    // 离开文章页 → 清理文章规则 UI
    const pathChanged = location.pathname !== state.lastPath;
    state.lastPath = location.pathname;
    if (isArticlePage()) {
      const cur = document.querySelector(ZD.extract.ARTICLE_CARD_SELECTOR);
      if (pathChanged) analyzeArticle(true);
      else if (cur && cur !== state.article.card) analyzeArticle();
      else if (!state.article.analyzed) analyzeArticle();
      // 正文懒渲染：文本指纹变化（如 .Post-content 延迟出现）→ 重试
      else if (state.article.card && ZD.extract.extractArticleText(state.article.card, state.settings) !== state.article.text) {
        analyzeArticle(true);
      }
    } else if (state.article.analyzed && state.article.card) {
      cleanupArticleUI(state.article.card);
      state.article = { id: null, card: null, analyzed: false, text: '', inFlight: null };
    }

    const cards = [];
    const seen = new Set();
    for (const node of nodes) {
      if (!(node instanceof Element)) continue;
      // 正文区域变化（如首页"阅读全文"展开折叠预览 / 问题页折叠长文展开）：
      // 该卡片已按摘要分析过 → 文本真的变化时防抖后按全文重新分析
      if (node.closest(ZD.extract.BODY_SELECTOR)) {
        const card = node.closest(ZD.extract.CARD_SELECTOR);
        // 作者规则已应用的卡片（屏蔽/信任）不随正文变化重分析：
        // 规则由存储变化驱动，与内容无关（也避免重渲染打断占位条 [查看] 态）
        if (card && state.analyzed.has(card) && !state.ruleApplied.has(card) && !seen.has(card)) {
          seen.add(card);
          // 只有正文输入窗口文本真的变化（如折叠预览展开）才重分析。
          // 知乎会在 .RichContent 内追加操作栏/热评/Sticky 等 UI 节点，
          // 这类非正文变化若触发重分析，会把打开的理由面板重建为收起态、
          // 角标闪动，表现为"弹窗自动消失"。
          if (extractCardText(card) === state.cardText.get(card)) {
            continue;
          }
          scheduleReanalyze(card);
          continue;
        }
      }
      for (const card of ZD.extract.findCards(node)) {
        if (!state.analyzed.has(card) && !seen.has(card)) {
          seen.add(card);
          cards.push(card);
        }
      }
      // 新增节点在卡片内部（正文晚于卡壳渲染，如文章列表卡摘要后置）：
      // findCards 只查后代、找不到祖先卡 → 向上回溯最近未分析的卡片
      const anc = node.closest(ZD.extract.CARD_SELECTOR);
      if (anc && !state.analyzed.has(anc) && !seen.has(anc) && anc.querySelector(ZD.extract.BODY_SELECTOR)) {
        seen.add(anc);
        cards.push(anc);
      }
    }
    if (cards.length) analyzeCards(cards);
  }

  async function analyzeAll() {
    const cards = ZD.extract.findCards(document).filter((c) => !state.analyzed.has(c));
    if (cards.length) await analyzeCards(cards);
  }

  function startObserver() {
    let pending = false;
    const queued = [];
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((n) => queued.push(n));
      }
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        const batch = queued.splice(0, queued.length);
        processAddedNodes(batch);
      }, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // 存储变化：覆盖/设置实时生效
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[ZD.KEYS.OVERRIDES]) {
      const oldOv = changes[ZD.KEYS.OVERRIDES].oldValue || {};
      const newOv = changes[ZD.KEYS.OVERRIDES].newValue || {};
      state.overrides = newOv;
      // 只重渲染覆盖发生变化的回答卡片
      const changed = new Set([...Object.keys(oldOv), ...Object.keys(newOv)]);
      ZD.extract.findCards(document).forEach((card) => {
        const badge = card.querySelector('.zys-badge');
        const aid = badge && badge.dataset.zysAid;
        if (aid && changed.has(aid)) analyzeCard(card);
      });
      // 文章覆盖（'p'+id 命名空间）
      if (state.article.id) {
        const key = articleOverrideKey(state.article.id);
        if (changed.has(key)) analyzeArticle(true);
      }
    }
    if (changes[ZD.KEYS.SETTINGS]) {
      state.settings = { ...ZD.DEFAULTS, ...changes[ZD.KEYS.SETTINGS].newValue };
      state.analyzed = new WeakSet();
      analyzeAll();
      analyzeArticle(true); // 文章设置/阈值变化 → 文章重判
    }
    if (changes[ZD.KEYS.AUTHOR_RULES]) {
      const oldRules = changes[ZD.KEYS.AUTHOR_RULES].oldValue || { [ZD.AUTHOR_KIND.BLOCKED]: {}, [ZD.AUTHOR_KIND.TRUSTED]: {} };
      const newRules = changes[ZD.KEYS.AUTHOR_RULES].newValue || { [ZD.AUTHOR_KIND.BLOCKED]: {}, [ZD.AUTHOR_KIND.TRUSTED]: {} };
      state.authorRules = newRules;
      // 只重扫规则发生变化的作者（含跨页：选项页操作同样实时生效）
      const changed = new Set([
        ...Object.keys(oldRules.blocked),
        ...Object.keys(oldRules.trusted),
        ...Object.keys(newRules.blocked),
        ...Object.keys(newRules.trusted),
      ]);
      reapplyAuthorRules(changed);
      // 文章详情页作者规则即时生效
      const articleCard = document.querySelector(ZD.extract.ARTICLE_CARD_SELECTOR);
      if (articleCard) {
        const a = ZD.extract.getAuthor(articleCard);
        if (a && a.token && changed.has(a.token)) analyzeArticle(true);
      }
    }
  });

  // ---------- 启动 ----------

  (async function init() {
    state.settings = await ZD.storage.getSettings();
    state.overrides = await ZD.storage.getOverrides();
    state.authorRules = await ZD.storage.getAuthorRules();
    startObserver();
    analyzeAll();
    analyzeArticle();
  })();
})();
