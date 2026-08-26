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
    /** 已分析卡片，避免 MutationObserver 重复触发 */
    analyzed: new WeakSet(),
    /** 进行中的分析，按卡片去重 */
    inFlight: new Map(),
    /** 手动"重新判定"的回答 ID 集合（二审强制绕过缓存） */
    forceRejudge: new Set(),
  };

  // ---------- 云端二审请求（内容侧队列：≤2 并发，其余排队，不丢弃） ----------

  function requestSecondOpinion(text, rule, force) {
    return new Promise((resolve) => {
      // 内容侧等待比 SW 超时（CLOUD_TIMEOUT_MS）略长，保证 SW 中止后本处必然收尾
      const timer = setTimeout(() => resolve(null), ZD.CLOUD_TIMEOUT_MS + 5_000);
      try {
        chrome.runtime.sendMessage(
          {
            type: ZD.MSG.SECOND_OPINION,
            text,
            // 一审结果作为上下文传给二审
            ruleScore: rule.score,
            hits: rule.hits.map((h) => ({ id: h.id, name: h.name, deduct: h.deduct })),
            // 手动"重新判定"时强制绕过缓存重新调用
            force: !!force,
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
    request(text, rule, force) {
      return new Promise((resolve) => {
        this.queue.push({ text, rule, force, resolve });
        this.pump();
      });
    },
    pump() {
      while (this.active < this.MAX && this.queue.length) {
        const item = this.queue.shift();
        this.active++;
        requestSecondOpinion(item.text, item.rule, item.force).then((result) => {
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

  /**
   * 稳定化提取：SPA 渐进渲染时卡片内容会变化，连续两次采样一致才返回，
   * 避免在部分渲染态取文本（这是缓存哈希不稳定的主因）。
   * 最多等 4 轮（约 2s），仍不稳定则返回最后一次采样。
   */
  async function extractStableText(card) {
    let prev = ZD.extract.extractText(card, state.settings);
    for (let i = 0; i < 4; i++) {
      await sleep(500);
      const cur = ZD.extract.extractText(card, state.settings);
      if (cur === prev) return cur;
      prev = cur;
    }
    return prev;
  }

  /**
   * 分析单张回答卡片，产出结果并渲染。
   * @returns {Promise<void>}
   */
  async function analyzeCard(card) {
    if (state.inFlight.has(card)) return state.inFlight.get(card);
    const p = (async () => {
      const answerId = ZD.extract.getAnswerId(card);

      // 1) 覆盖优先（无需等待文本稳定，立即渲染）
      const override = answerId ? state.overrides[answerId] : null;
      if (override) {
        const result = {
          source: 'override',
          verdict: override.verdict,
          score: override.score,
          answerId,
          override,
        };
        renderBadge(card, result);
        state.analyzed.add(card);
        return;
      }

      // 2) 文本稳定化。正文提取为空（无正文块）→ 不判定也不显示角标
      const text = await extractStableText(card);
      if (!text) {
        state.analyzed.add(card);
        return;
      }

      // 3) 字数下限：回答本身少于 minChars 判 AI 无意义，以"跳过"角标标记（0 关闭）
      const minChars = state.settings.minChars || 0;
      if (minChars > 0 && ZD.extract.rawLength(card) < minChars) {
        state.analyzed.add(card);
        renderSkippedBadge(card, minChars);
        return;
      }

      // 4) 规则初审（含用户自定义正则规则）
      const rule = ZD.engine.score(text, state.settings.customTraces || []);
      let result = {
        source: 'rule',
        score: rule.score,
        hits: rule.hits,
        answerId,
      };

      // 5) 云端二审（模糊带 + 已配置；经内容侧队列限流，不丢弃；携带一审结果作上下文；
      //    手动"重新判定"时 force=true 强制绕过缓存）
      if (answerId && cloudEligible(rule.score, state.settings)) {
        const force = state.forceRejudge.delete(answerId);
        // 初次分析：二审等待期先渲染轻量"二审中…"角标作为反馈
        // （手动"重新判定"已有独立大 loading，不重复渲染）
        if (!force) renderPendingBadge(card, answerId);
        const cloud = await cloudQueue.request(text, rule, force);
        if (cloud) {
          result = {
            source: 'cloud',
            score: cloud.score,
            hits: rule.hits,
            cloud: { aiSignals: cloud.aiSignals || [], humanSignals: cloud.humanSignals || [] },
            answerId,
          };
        }
      }

      renderBadge(card, result);
      state.analyzed.add(card);
    })();
    state.inFlight.set(card, p);
    try {
      await p;
    } finally {
      state.inFlight.delete(card);
    }
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

  /** 移除卡片上的旧角标/面板/加载占位（重渲染前清理） */
  function clearCardUI(card) {
    card.querySelectorAll('.zys-badge, .zys-panel, .zys-rejudging').forEach((el) => el.remove());
  }

  /** 把元素插到正文前；无正文时置于卡片顶部（badge/panel/loading 统一入口） */
  function insertBeforeBody(card, el) {
    const anchor = bodyOf(card);
    if (anchor) anchor.insertAdjacentElement('beforebegin', el);
    else card.prepend(el);
  }

  /** 流式插入：badge 在上、panel 在下、正文被推下（不悬浮遮挡） */
  function insertBadgePanel(card, badge, panel) {
    insertBeforeBody(card, badge);
    insertBeforeBody(card, panel);
  }

  /** 绑定角标点击/回车切换面板 */
  function bindPanelToggle(badge, panel) {
    const toggle = () => {
      panel.hidden = !panel.hidden;
    };
    badge.addEventListener('click', toggle);
    badge.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
  }

  /** 角标分数文案：覆盖显示 人/AI，其余显示分数 */
  function badgeScoreText(result) {
    if (result.source !== 'override') return String(result.score);
    return result.verdict === ZD.VERDICT.AI ? 'AI' : '人';
  }

  /** 角标 meta 文案：已覆盖 / 二审 / N 条痕迹 / 未命中 */
  function badgeMetaText(result) {
    if (result.source === 'override') return '已覆盖';
    if (result.source === 'cloud') return '二审';
    const count = (result.hits && result.hits.length) || 0;
    return count > 0 ? `${count} 条痕迹` : '未命中';
  }

  /**
   * 二审进行中的轻量反馈角标：初次分析时规则初审已完成、云端二审尚未返回，
   * 先渲染"二审中…"（小转圈），二审完成后 renderBadge 会先清理再替换为最终角标。
   * 不可点击（无面板）；手动"重新判定"走独立的大 loading，不走到这里。
   */
  function renderPendingBadge(card, answerId) {
    clearCardUI(card);
    const badge = document.createElement('div');
    badge.className = 'zys-badge zys-pending';
    badge.dataset.zysAid = answerId || '';
    const spinner = document.createElement('span');
    spinner.className = 'zys-spinner zys-spinner-sm';
    const labelEl = document.createElement('span');
    labelEl.className = 'zys-level';
    labelEl.textContent = '二审中…';
    badge.appendChild(spinner);
    badge.appendChild(labelEl);
    insertBeforeBody(card, badge);
  }

  /** 渲染"跳过"角标：回答本身字数少于 minChars，不判定。
   * 与"未命中"区分：跳过 = 太短不判；未命中 = 判了但没命中痕迹。
   */
  function renderSkippedBadge(card, minChars) {
    clearCardUI(card);
    const badge = document.createElement('div');
    badge.className = 'zys-badge zys-level-skip';
    badge.setAttribute('tabindex', '0');

    const labelEl = document.createElement('span');
    labelEl.className = 'zys-level';
    labelEl.textContent = '跳过';
    badge.appendChild(labelEl);

    const metaEl = document.createElement('span');
    metaEl.className = 'zys-meta';
    metaEl.textContent = `少于 ${minChars} 字`;
    badge.appendChild(metaEl);

    const panel = document.createElement('div');
    panel.className = 'zys-panel';
    panel.hidden = true;
    const p = document.createElement('p');
    p.className = 'zys-empty';
    p.textContent = `回答本身不足 ${minChars} 字，跳过 AI 判定。`;
    panel.appendChild(p);
    bindPanelToggle(badge, panel);
    insertBadgePanel(card, badge, panel);
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
    clearCardUI(card);

    const lv = levelOfResult(result);
    const badge = document.createElement('div');
    badge.className = `zys-badge ${LEVEL_CLASS[lv.level]}`;
    badge.dataset.zysAid = result.answerId || '';
    badge.setAttribute('tabindex', '0');

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
        li.textContent = `${h.name} -${h.deduct} 分`;
        list.appendChild(li);
      });
      panel.appendChild(list);
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
      const mkBtn = (label, action) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.dataset.zysAction = action;
        actions.appendChild(b);
      };
      mkBtn('认为人工', ZD.VERDICT.HUMAN);
      mkBtn('认为 AI', ZD.VERDICT.AI);
      if (result.source === 'override') mkBtn('清除覆盖', 'clear');
      mkBtn('重新判定', 'rejudge');
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
    insertBadgePanel(card, badge, panel);
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

    // 重置分析状态并重跑（renderBadge 会清理 loading）
    state.analyzed.delete(card);
    state.inFlight.delete(card);
    state.forceRejudge.add(answerId);
    await analyzeCard(card);
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
    await analyzeCard(card); // 重新渲染为覆盖状态
  }

  async function clearOverride(card, answerId) {
    if (!answerId) return;
    await ZD.storage.removeOverride(answerId);
    delete state.overrides[answerId];
    state.analyzed.delete(card);
    await analyzeCard(card); // 重新按引擎判定
  }

  // 事件委托：按钮
  document.addEventListener('click', async (e) => {
    // P1：展开/收起原文
    const expandBtn = e.target.closest('[data-zys-expand]');
    if (expandBtn) {
      e.stopPropagation();
      const card = expandBtn.closest(ZD.extract.CARD_SELECTOR);
      const bodyEl = card ? bodyOf(card) : null;
      if (card && bodyEl) {
        const hidden = bodyEl.style.display === 'none';
        bodyEl.style.display = hidden ? '' : 'none';
        expandBtn.textContent = hidden ? '收起原文' : '展开原文';
      }
      return;
    }

    const btn = e.target.closest('[data-zys-action]');
    if (!btn) return;
    e.stopPropagation();
    const card = btn.closest(ZD.extract.CARD_SELECTOR);
    if (!card) return;
    const badge = card.querySelector('.zys-badge');
    const answerId = badge ? badge.dataset.zysAid : '';
    if (!answerId) return;
    switch (btn.dataset.zysAction) {
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

  function processAddedNodes(nodes) {
    const cards = [];
    for (const node of nodes) {
      if (!(node instanceof Element)) continue;
      for (const card of ZD.extract.findAnswerCards(node)) {
        if (!state.analyzed.has(card)) cards.push(card);
      }
    }
    if (cards.length) analyzeCards(cards);
  }

  async function analyzeAll() {
    const cards = ZD.extract.findAnswerCards(document).filter((c) => !state.analyzed.has(c));
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

  // ---------- 预加载：提前渲染下一批回答，减少滚动到时的判定延迟 ----------
  // 知乎懒加载阈值极贴近底部（实测距底部 1.5 屏不触发，滚到底才加载 10 个/批），
  // 答案进入 viewport 时才刚渲染、分析才开始 → 用户滚到时还在"二审中"。
  // 策略：仅在问题页/答案详情页（URL /question/ 前缀）且用户空闲时，
  // 周期性"到底部触发加载 → 恢复原位"，屏幕外提前分析；
  // 用户正在滚动或仍有未分析卡片时跳过，加载完（无新增）后退避重试。
  // SPA 导航到其他页面（如首页）时暂停，回到问题页自动恢复。

  /** 是否问题页/答案详情页（预加载只在此类页面运行） */
  function isQuestionPage() {
    return /^https:\/\/[^/]*\.?zhihu\.com\/question\//.test(location.href);
  }

  const preload = {
    /** 距上次预加载的间隔（ms）：加载成功保持节奏，无更多后退避 */
    interval: 4_000,
    /** 无更多后的退避间隔（ms） */
    IDLE_BACKOFF: 300_000,
    timer: null,
    scrolling: false,
    _scrollEndTimer: null,

    start() {
      window.addEventListener(
        'scroll',
        () => {
          this.scrolling = true;
          clearTimeout(this._scrollEndTimer);
          this._scrollEndTimer = setTimeout(() => {
            this.scrolling = false;
          }, 800);
        },
        { passive: true }
      );
      // SPA 路由变化监视：离开问题页（如回首页）暂停，回到问题页恢复
      let lastHref = location.href;
      setInterval(() => {
        if (location.href === lastHref) return;
        lastHref = location.href;
        if (isQuestionPage()) this.schedule();
        else this.stop();
      }, 1000);
      if (isQuestionPage()) this.schedule();
    },

    schedule() {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.tick(), this.interval);
    },

    stop() {
      clearTimeout(this.timer);
    },

    async tick() {
      // 非问题页（SPA 导航离开）：不预加载（URL 监视恢复时重新调度）
      if (!isQuestionPage()) return;
      // 用户正在滚动：不打扰，顺延
      if (this.scrolling) {
        this.schedule();
        return;
      }
      const cards = ZD.extract.findAnswerCards(document);
      // 已渲染卡片还有未分析的（分析进行中/二审排队）→ 等消化完再预加载
      if (cards.some((c) => !state.analyzed.has(c))) {
        this.schedule();
        return;
      }
      const count = cards.length;
      const y = window.scrollY;
      window.scrollTo(0, document.body.scrollHeight); // 触发知乎加载更多
      // 知乎懒加载监听 scroll 事件：程序化 scrollTo 本身不触发其加载逻辑，需补发
      window.dispatchEvent(new Event('scroll'));
      // 等待新卡片渲染：实测知乎加载一批约 400ms，留余量再检查
      await sleep(500);
      const countAfter = ZD.extract.findAnswerCards(document).length;
      window.scrollTo(0, y); // 恢复原滚动位置（新卡片由 MutationObserver 捕获分析）
      this.interval = countAfter > count ? 4_000 : this.IDLE_BACKOFF;
      this.schedule();
    },
  };

  // 存储变化：覆盖/设置实时生效
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[ZD.KEYS.OVERRIDES]) {
      const oldOv = changes[ZD.KEYS.OVERRIDES].oldValue || {};
      const newOv = changes[ZD.KEYS.OVERRIDES].newValue || {};
      state.overrides = newOv;
      // 只重渲染覆盖发生变化的回答卡片
      const changed = new Set([...Object.keys(oldOv), ...Object.keys(newOv)]);
      ZD.extract.findAnswerCards(document).forEach((card) => {
        const badge = card.querySelector('.zys-badge');
        const aid = badge && badge.dataset.zysAid;
        if (aid && changed.has(aid)) analyzeCard(card);
      });
    }
    if (changes[ZD.KEYS.SETTINGS]) {
      state.settings = { ...ZD.DEFAULTS, ...changes[ZD.KEYS.SETTINGS].newValue };
      state.analyzed = new WeakSet();
      analyzeAll();
    }
  });

  // ---------- 启动 ----------

  (async function init() {
    state.settings = await ZD.storage.getSettings();
    state.overrides = await ZD.storage.getOverrides();
    startObserver();
    analyzeAll();
    preload.start();
  })();
})();
