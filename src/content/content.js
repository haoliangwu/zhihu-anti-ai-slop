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
    /** answerId -> 最近一次分析结果（含云端结果，用于重渲染） */
    results: new Map(),
    /** 已分析卡片，避免 MutationObserver 重复触发 */
    analyzed: new WeakSet(),
    /** 进行中的分析，按卡片去重 */
    inFlight: new Map(),
  };

  // ---------- 云端二审请求（内容侧队列：≤2 并发，其余排队，不丢弃） ----------

  function requestSecondOpinion(text) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 35_000);
      try {
        chrome.runtime.sendMessage(
          { type: ZD.MSG.SECOND_OPINION, text },
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
    MAX: 2,
    request(text) {
      return new Promise((resolve) => {
        this.queue.push({ text, resolve });
        this.pump();
      });
    },
    pump() {
      while (this.active < this.MAX && this.queue.length) {
        const item = this.queue.shift();
        this.active++;
        requestSecondOpinion(item.text).then((result) => {
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
        state.results.set(answerId || card, result);
        renderBadge(card, result);
        state.analyzed.add(card);
        return;
      }

      // 2) 文本稳定化 + 字数下限（短文本判 AI 无意义，0 关闭；以"跳过"角标标记）
      const text = await extractStableText(card);
      const minChars = state.settings.minChars || 0;
      if (!text || (minChars > 0 && ZD.extract.rawLength(card) < minChars)) {
        state.analyzed.add(card);
        renderSkippedBadge(card, minChars);
        return;
      }

      // 3) 规则初审（含用户自定义正则规则）
      const rule = ZD.engine.score(text, state.settings.customTraces || []);
      let result = {
        source: 'rule',
        score: rule.score,
        hits: rule.hits,
        answerId,
      };

      // 4) 云端二审（模糊带 + 已配置；经内容侧队列限流，不丢弃）
      if (answerId && cloudEligible(rule.score, state.settings)) {
        const cloud = await cloudQueue.request(text);
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

      state.results.set(answerId || card, result);
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

  const LEVEL_CLASS = { 'confirm-ai': 'zys-level-confirm-ai', 'suspect-ai': 'zys-level-suspect-ai', normal: 'zys-level-normal', skip: 'zys-level-skip' };

  /**
   * 渲染"跳过"角标：回答本身字数少于 minChars，不判定。
   * 与"未命中"区分：跳过 = 太短不判；未命中 = 判了但没命中痕迹。
   */
  function renderSkippedBadge(card, minChars) {
    card.querySelectorAll('.zys-badge').forEach((el) => el.remove());
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
    badge.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
    });
    badge.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        panel.hidden = !panel.hidden;
      }
    });

    // 流式插入：badge 在上、panel 在下、正文在下方被推开（不悬浮遮挡）
    const anchor = card.querySelector(ZD.extract.BODY_SELECTOR);
    if (anchor) {
      anchor.insertAdjacentElement('beforebegin', badge);
      anchor.insertAdjacentElement('beforebegin', panel);
    } else {
      card.prepend(badge);
      card.prepend(panel);
    }
  }

  function levelOfResult(result) {
    if (result.source === 'override') {
      return result.verdict === 'ai'
        ? { level: 'confirm-ai', label: '覆盖·认为 AI' }
        : { level: 'normal', label: '覆盖·认为人工' };
    }
    return ZD.engine.levelOf(result.score, state.settings);
  }

  function renderBadge(card, result) {
    // 移除旧角标与旧面板
    card.querySelectorAll('.zys-badge, .zys-panel').forEach((el) => el.remove());

    const lv = levelOfResult(result);
    const badge = document.createElement('div');
    badge.className = `zys-badge ${LEVEL_CLASS[lv.level]}`;
    badge.dataset.zysAid = result.answerId || '';
    badge.setAttribute('tabindex', '0');

    const scoreEl = document.createElement('span');
    scoreEl.className = 'zys-score';
    scoreEl.textContent = result.source === 'override' ? (result.verdict === 'ai' ? 'AI' : '人') : String(result.score);
    badge.appendChild(scoreEl);

    const labelEl = document.createElement('span');
    labelEl.className = 'zys-level';
    labelEl.textContent = lv.label;
    badge.appendChild(labelEl);

    const reasonCount = (result.hits && result.hits.length) || 0;
    const metaEl = document.createElement('span');
    metaEl.className = 'zys-meta';
    metaEl.textContent =
      result.source === 'override'
        ? '已覆盖'
        : result.source === 'cloud'
          ? '二审'
          : reasonCount > 0
            ? `${reasonCount} 条痕迹`
            : '未命中';
    badge.appendChild(metaEl);

    // 理由面板
    const panel = document.createElement('div');
    panel.className = 'zys-panel';
    panel.hidden = true;

    const titleEl = document.createElement('div');
    titleEl.className = 'zys-panel-title';
    titleEl.textContent = `判定：${lv.label}` + (result.source === 'cloud' ? `（云端二审，人类置信度 ${result.score}）` : `（人类置信度 ${result.score}）`);
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
      const cloudEl = document.createElement('div');
      cloudEl.className = 'zys-cloud';
      const ai = result.cloud.aiSignals.join('；');
      const human = result.cloud.humanSignals.join('；');
      cloudEl.textContent = `二审证据 — AI 倾向：${ai || '无'}；人工倾向：${human || '无'}`;
      panel.appendChild(cloudEl);
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
      mkBtn('认为人工', 'human');
      mkBtn('认为 AI', 'ai');
      if (result.source === 'override') mkBtn('清除覆盖', 'clear');
      panel.appendChild(actions);
    }

    // P1：AI 判定 → 隐藏正文 + 原因与证据默认可见
    const bodyEl = card.querySelector(ZD.extract.BODY_SELECTOR);
    const isAiLevel = lv.level === 'confirm-ai' || lv.level === 'suspect-ai';
    if (bodyEl) {
      // 每次重渲染重置正文可见性（SPA 重渲染后自动重新应用处置）
      bodyEl.style.display = isAiLevel && state.settings.hideAiBody ? 'none' : '';
    }
    if (isAiLevel) {
      panel.hidden = false; // 直接渲染原因与证据，无需点击
      if (bodyEl && state.settings.hideAiBody) {
        const expandBtn = document.createElement('button');
        expandBtn.type = 'button';
        expandBtn.dataset.zysExpand = '1';
        expandBtn.textContent = '展开原文';
        expandBtn.className = 'zys-expand-btn';
        panel.appendChild(expandBtn);
      }
    }

    badge.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
    });
    badge.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        panel.hidden = !panel.hidden;
      }
    });

    // 流式插入：badge 在上、panel 在下、正文在下方被推开（不悬浮遮挡）
    const anchor = card.querySelector(ZD.extract.BODY_SELECTOR);
    if (anchor) {
      anchor.insertAdjacentElement('beforebegin', badge);
      anchor.insertAdjacentElement('beforebegin', panel);
    } else {
      card.prepend(badge);
      card.prepend(panel);
    }
  }

  // ---------- 覆盖操作 ----------

  async function applyOverride(card, answerId, verdict) {
    if (!answerId) return;
    const override = {
      verdict,
      score: verdict === 'ai' ? Math.min(state.settings.thresholdConfirm, 10) : 100,
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
    state.results.delete(answerId);
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
      const bodyEl = card ? card.querySelector(ZD.extract.BODY_SELECTOR) : null;
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
    const action = btn.dataset.zysAction;
    if (action === 'human') await applyOverride(card, answerId, 'human');
    else if (action === 'ai') await applyOverride(card, answerId, 'ai');
    else if (action === 'clear') await clearOverride(card, answerId);
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

  // 消息：选项页"重新分析当前页"
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === ZD.MSG.REANALYZE) {
      state.analyzed = new WeakSet();
      state.results.clear();
      analyzeAll();
      sendResponse({ ok: true });
    }
  });

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
      state.results.clear();
      analyzeAll();
    }
  });

  // ---------- 启动 ----------

  (async function init() {
    state.settings = await ZD.storage.getSettings();
    state.overrides = await ZD.storage.getOverrides();
    startObserver();
    analyzeAll();
  })();
})();
