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
    /** 卡片 → 最近一次分析时的正文输入窗口文本。
     *  正文变化重分析的指纹：只有输入窗口文本真的变化才重分析，
     *  避免知乎在 .RichContent 内追加操作栏/热评等 UI 节点触发无谓重分析。 */
    cardText: new WeakMap(),
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
        state.cardText.set(card, ZD.extract.extractText(card, state.settings));
        return;
      }

      // 2) 文本稳定化。正文提取为空（无正文块）→ 不判定也不显示角标
      const text = await extractStableText(card);
      if (!text) {
        state.analyzed.add(card);
        state.cardText.set(card, '');
        return;
      }

      // 3) 字数下限：回答本身少于 minChars 判 AI 无意义，以"跳过"角标标记（0 关闭）
      const minChars = state.settings.minChars || 0;
      if (minChars > 0 && ZD.extract.rawLength(card) < minChars) {
        state.analyzed.add(card);
        state.cardText.set(card, text);
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

      // 5) 云端二审：已配置 API 且（手动"重新判定"强制 或 分数落入模糊带）。
      //    经内容侧队列限流，不丢弃；携带一审结果作上下文。
      //    手动"重新判定"（force）：一审为正则匹配、幂等，重跑必然同分且
      //    正常（>模糊带上限）回答原不会进二审 → 强制二审绕过模糊带与缓存，
      //    得到新的 judge 结论（force 也用于二审侧跳过缓存读）
      const force = state.forceRejudge.delete(answerId);
      const cloudOn = state.settings.cloudEnabled && !!state.settings.apiKey;
      if (answerId && cloudOn && (force || cloudEligible(rule.score, state.settings))) {
        // 初次分析：二审等待期先渲染"规则分 + 二审中"角标作为反馈
        // （手动"重新判定"已有独立大 loading，不重复渲染）
        if (!force) renderPendingBadge(card, answerId, rule.score);
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
      state.cardText.set(card, text);
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

  /** 移除卡片上的角标/面板/加载占位（全量清理；"重新判定"等需要换 loading 的场景） */
  function clearCardUI(card) {
    card.querySelectorAll('.zys-badge, .zys-panel, .zys-rejudging').forEach((el) => el.remove());
  }

  /** 只清面板与加载占位（render 路径：角标节点原位复用，不删除重建，避免闪动） */
  function clearPanels(card) {
    card.querySelectorAll('.zys-panel, .zys-rejudging').forEach((el) => el.remove());
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
   * 二审进行中的反馈角标：初次分析时规则初审已完成、云端二审尚未返回，
   * 直接显示规则一审分数 + "二审中"标签（灰调），二审完成后原位更新为
   * 融合分与最终判定——角标从开始就有数字，只微调不跳变。
   * 已有判定角标的卡片（正文变化重分析）不降级为"二审中"，保留旧结果直至新结果就绪。
   * 不可点击（无面板）；手动"重新判定"走独立的大 loading，不走到这里。
   */
  function renderPendingBadge(card, answerId, ruleScore) {
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

  /** 渲染"跳过"角标：回答本身字数少于 minChars，不判定。
   * 与"未命中"区分：跳过 = 太短不判；未命中 = 判了但没命中痕迹。
   * 角标节点原位复用（跳过 ↔ 判定 双向切换不删除重建）。
   */
  function renderSkippedBadge(card, minChars) {
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

    const panel = document.createElement('div');
    panel.className = 'zys-panel';
    panel.hidden = true;
    const p = document.createElement('p');
    p.className = 'zys-empty';
    p.textContent = `回答本身不足 ${minChars} 字，跳过 AI 判定。`;
    panel.appendChild(p);
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
    const cards = [];
    const seen = new Set();
    for (const node of nodes) {
      if (!(node instanceof Element)) continue;
      // 正文区域变化（如首页"阅读全文"展开折叠预览 / 问题页折叠长文展开）：
      // 该卡片已按摘要分析过 → 文本真的变化时防抖后按全文重新分析
      if (node.closest(ZD.extract.BODY_SELECTOR)) {
        const card = node.closest(ZD.extract.CARD_SELECTOR);
        if (card && state.analyzed.has(card) && !seen.has(card)) {
          seen.add(card);
          // 只有正文输入窗口文本真的变化（如折叠预览展开）才重分析。
          // 知乎会在 .RichContent 内追加操作栏/热评/Sticky 等 UI 节点，
          // 这类非正文变化若触发重分析，会把打开的理由面板重建为收起态、
          // 角标闪动，表现为"弹窗自动消失"。
          if (ZD.extract.extractText(card, state.settings) === state.cardText.get(card)) {
            continue;
          }
          scheduleReanalyze(card);
          continue;
        }
      }
      for (const card of ZD.extract.findAnswerCards(node)) {
        if (!state.analyzed.has(card) && !seen.has(card)) {
          seen.add(card);
          cards.push(card);
        }
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
  })();
})();
