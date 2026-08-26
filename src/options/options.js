/**
 * 知乎照妖镜 — 选项页逻辑
 * 依赖：constants.js、storage.js（按 HTML 顺序加载）。
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
  ];

  let currentSettings = { ...ZD.DEFAULTS };

  function fillForm(settings) {
    currentSettings = settings;
    for (const f of FIELDS) {
      $(f).value = settings[f];
    }
    $('cloudEnabled').checked = !!settings.cloudEnabled;
    $('apiKey').value = settings.apiKey || '';
    $('windowMode').value = settings.windowMode || 'full';
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

  async function save() {
    const s = collectForm();
    const err = validate(s);
    if (err) {
      setStatus(err, false);
      return;
    }
    await ZD.storage.saveSettings(s);
    currentSettings = s;
    setStatus('已保存', true);
  }

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
