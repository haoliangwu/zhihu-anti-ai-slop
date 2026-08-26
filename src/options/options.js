/**
 * 知乎照妖镜 — 选项页（SPA）逻辑
 * 依赖：constants.js、storage.js（按 HTML 顺序加载）。
 * 配置项：阈值 / 模糊带 / API（key 掩码）/ 二审提示词 / 输入窗口 /
 *         AI 隐藏正文 / 自定义正则规则（CRUD + 校验）/ 覆盖管理。
 */
'use strict';

(() => {
  const ZD = globalThis.ZhihuDetector;

  const $ = (id) => document.getElementById(id);

  const FIELDS = [
    'thresholdConfirm',
    'thresholdSuspect',
    'fuzzyLow',
    'fuzzyHigh',
    'apiBaseUrl',
    'apiModel',
    'cloudPerPageLimit',
    'maxChars',
    'minChars',
  ];

  let currentSettings = { ...ZD.DEFAULTS };
  let traceDraftId = 0; // 新增规则的临时 id（保存时替换为时间戳 id）

  function fillForm(settings) {
    currentSettings = settings;
    for (const f of FIELDS) {
      $(f).value = settings[f];
    }
    $('cloudEnabled').checked = !!settings.cloudEnabled;
    $('apiKey').value = settings.apiKey || '';
    $('windowMode').value = settings.windowMode || 'full';
    $('hideAiBody').checked = settings.hideAiBody !== false;
    $('judgePrompt').value = settings.judgePrompt || '';
    renderTraces(settings.customTraces || []);
  }

  function collectForm() {
    const s = { ...currentSettings };
    for (const f of FIELDS) {
      const el = $(f);
      if (el.type === 'number') s[f] = Number(el.value);
      else s[f] = el.value.trim();
    }
    s.cloudEnabled = $('cloudEnabled').checked;
    s.apiKey = $('apiKey').value.trim();
    s.windowMode = $('windowMode').value;
    s.hideAiBody = $('hideAiBody').checked;
    s.judgePrompt = $('judgePrompt').value.trim();
    s.customTraces = collectTraces();
    return s;
  }

  function validate(s) {
    if (s.thresholdConfirm < 0 || s.thresholdSuspect > 100 || s.thresholdConfirm >= s.thresholdSuspect) {
      return '阈值需满足 0 ≤ 确定阈值 < 疑似阈值 ≤ 100';
    }
    if (s.fuzzyLow < 0 || s.fuzzyHigh > 100 || s.fuzzyLow > s.fuzzyHigh) {
      return '模糊带需满足 0 ≤ 下限 ≤ 上限 ≤ 100';
    }
    if (s.cloudEnabled && !s.apiKey) {
      return '启用云端二审时需填写 API Key';
    }
    for (const t of s.customTraces) {
      try {
        new RegExp(t.pattern);
      } catch {
        return `自定义规则"${t.name}"的正则无效：${t.pattern}`;
      }
    }
    return null;
  }

  function setStatus(text, ok) {
    const el = $('status');
    el.textContent = text;
    el.className = 'status ' + (ok ? 'ok' : 'err');
    clearTimeout(setStatus._t);
    setStatus._t = setTimeout(() => {
      el.textContent = '';
      el.className = 'status';
    }, 3000);
  }

  /**
   * 从 API 地址提取主机权限模式（仅支持 https）。
   * @returns {string|null} 如 'https://api.openai.com/*'；非法或非 https 返回 null
   */
  function hostPatternFromUrl(urlStr) {
    try {
      const u = new URL(urlStr);
      if (u.protocol !== 'https:') return null;
      return `${u.protocol}//${u.host}/*`;
    } catch {
      return null;
    }
  }

  async function save() {
    const s = collectForm();
    const err = validate(s);
    if (err) {
      setStatus(err, false);
      return;
    }

    // 动态申请自定义 API 域名的主机权限（同步发起 request 以保持用户手势；
    // 已静态授权/已授权域名直接 resolve，不弹窗）
    let permNote = '';
    if (s.cloudEnabled && s.apiKey && s.apiBaseUrl) {
      const pattern = hostPatternFromUrl(s.apiBaseUrl);
      if (!pattern) {
        setStatus('API 地址需为 https:// 协议', false);
        return;
      }
      try {
        const granted = await chrome.permissions.request({ origins: [pattern] });
        if (!granted) {
          permNote = '（未授权 ' + pattern.replace('/*', '') + '，二审将不可用；可在 chrome://extensions 详情页授权）';
        }
      } catch {
        permNote = '（权限申请失败，二审可能不可用）';
      }
    }

    await ZD.storage.saveSettings(s);
    currentSettings = s;
    setStatus('已保存' + permNote, true);
  }

  // ---------- 自定义规则 CRUD ----------

  function renderTraces(traces) {
    const list = $('traceList');
    const empty = $('traceEmpty');
    list.textContent = '';
    empty.hidden = traces.length > 0;
    for (const t of traces) {
      const li = document.createElement('li');
      const info = document.createElement('span');
      info.className = 'ov-info';
      info.textContent = `${t.name} — /${t.pattern}/ × ${t.weight} 分（上限 ${t.cap} 次）`;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'mini';
      del.textContent = '删除';
      del.addEventListener('click', () => {
        const next = (currentSettings.customTraces || []).filter((x) => x.id !== t.id);
        currentSettings.customTraces = next;
        renderTraces(next);
      });
      li.appendChild(info);
      li.appendChild(del);
      list.appendChild(li);
    }
  }

  function collectTraces() {
    return currentSettings.customTraces || [];
  }

  function addTrace() {
    const name = $('traceName').value.trim();
    const pattern = $('tracePattern').value.trim();
    const weight = Number($('traceWeight').value);
    const cap = Number($('traceCap').value);
    const errEl = $('traceError');

    if (!name || !pattern) {
      errEl.textContent = '名称与正则均不能为空';
      errEl.hidden = false;
      return;
    }
    try {
      new RegExp(pattern); // 语法校验
    } catch (e) {
      errEl.textContent = `正则无效：${e.message}`;
      errEl.hidden = false;
      return;
    }
    if (!Number.isFinite(weight) || weight < 1 || !Number.isFinite(cap) || cap < 1) {
      errEl.textContent = '扣分与上限需为正整数';
      errEl.hidden = false;
      return;
    }

    errEl.hidden = true;
    traceDraftId++;
    const trace = { id: `custom-${Date.now()}-${traceDraftId}`, name, pattern, weight, cap };
    const next = [...(currentSettings.customTraces || []), trace];
    currentSettings.customTraces = next;
    renderTraces(next);
    // 清空表单
    $('traceName').value = '';
    $('tracePattern').value = '';
  }

  // ---------- 覆盖管理 ----------

  async function renderOverrides() {
    const overrides = await ZD.storage.getOverrides();
    const list = $('overrideList');
    const empty = $('overrideEmpty');
    list.textContent = '';
    const entries = Object.entries(overrides).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
    empty.hidden = entries.length > 0;
    for (const [answerId, ov] of entries) {
      const li = document.createElement('li');
      const info = document.createElement('span');
      info.className = 'ov-info';
      const when = ov.ts ? new Date(ov.ts).toLocaleString('zh-CN') : '未知时间';
      info.textContent = `回答 ${answerId} — ${ov.verdict === 'ai' ? '认为 AI' : '认为人工'}（${when}）`;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'mini';
      del.textContent = '清除';
      del.addEventListener('click', async () => {
        await ZD.storage.removeOverride(answerId);
        await renderOverrides();
      });
      li.appendChild(info);
      li.appendChild(del);
      list.appendChild(li);
    }
  }

  async function reanalyze() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      setStatus('未找到当前标签页', false);
      return;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { type: ZD.MSG.REANALYZE });
      setStatus('已触发重新分析', true);
    } catch {
      setStatus('当前页面不是知乎问题页，或内容脚本未就绪', false);
    }
  }

  // ---------- 事件绑定 ----------

  $('saveBtn').addEventListener('click', save);
  $('reanalyzeBtn').addEventListener('click', reanalyze);
  $('toggleKey').addEventListener('click', () => {
    const key = $('apiKey');
    const show = key.type === 'password';
    key.type = show ? 'text' : 'password';
    $('toggleKey').textContent = show ? '隐藏' : '显示';
  });
  $('resetPrompt').addEventListener('click', () => {
    $('judgePrompt').value = '';
    setStatus('已恢复内置默认提示词（保存后生效）', true);
  });
  $('addTraceBtn').addEventListener('click', addTrace);

  // 存储变化：其他页面修改设置/覆盖时同步刷新
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[ZD.KEYS.SETTINGS]) fillForm(changes[ZD.KEYS.SETTINGS].newValue || ZD.DEFAULTS);
    if (changes[ZD.KEYS.OVERRIDES]) renderOverrides();
  });

  // ---------- 启动 ----------

  (async function init() {
    const settings = await ZD.storage.getSettings();
    fillForm(settings);
    await renderOverrides();
  })();
})();
