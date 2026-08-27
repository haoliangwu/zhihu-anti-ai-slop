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
  let traceEditId = null; // 编辑中的规则 id（null = 新增模式）

  function fillForm(settings) {
    currentSettings = settings;
    for (const f of FIELDS) {
      $(f).value = settings[f];
    }
    $('cloudEnabled').checked = !!settings.cloudEnabled;
    $('apiKey').value = settings.apiKey || '';
    $('windowMode').value = settings.windowMode || 'full';
    $('hideAiBody').checked = settings.hideAiBody !== false;
    // 提示词总显示完整内容：未设置（''）时展示内置默认，用户可直接基于它修改
    $('judgePrompt').value = settings.judgePrompt || ZD.CLOUD_SYSTEM_PROMPT;
    // 额外请求参数：直接显示存储值（默认 = DeepSeek 的 thinking disabled + temperature 0；
    // 留空 = 不发送额外参数）
    $('extraParams').value = settings.extraParams || '';
    // 二审权重滑块（0-100 显示，存储 0-1）
    const w = Math.round((settings.cloudScoreWeight ?? 0.6) * 100);
    $('cloudScoreWeight').value = w;
    $('cloudScoreWeightVal').textContent = w + '%';
    renderTraces(settings.customTraces || []);
    renderBuiltinTraces();
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
    s.cloudScoreWeight = Number($('cloudScoreWeight').value) / 100;
    // 覆盖形态：与内置默认完全一致时存 ''（等同使用内置），否则存全文
    const prompt = $('judgePrompt').value.trim();
    s.judgePrompt = prompt === ZD.CLOUD_SYSTEM_PROMPT ? '' : prompt;
    s.extraParams = $('extraParams').value.trim();
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
    if (s.extraParams) {
      try {
        const parsed = JSON.parse(s.extraParams);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return '额外参数需为 JSON 对象（如 {"temperature": 0}）；留空则不发送额外参数';
        }
      } catch (e) {
        return `额外参数 JSON 无效：${e.message}`;
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
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'mini';
      edit.textContent = '编辑';
      edit.addEventListener('click', () => startEditTrace(t));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'mini';
      del.textContent = '删除';
      del.addEventListener('click', () => {
        const next = (currentSettings.customTraces || []).filter((x) => x.id !== t.id);
        currentSettings.customTraces = next;
        if (traceEditId === t.id) resetTraceForm(); // 删除正在编辑的规则 → 退出编辑态
        renderTraces(next);
      });
      li.appendChild(info);
      li.appendChild(edit);
      li.appendChild(del);
      list.appendChild(li);
    }
  }

  /** 进入编辑态：回填表单，提交按钮改为"保存修改" */
  function startEditTrace(t) {
    traceEditId = t.id;
    $('traceFormTitle').textContent = '编辑规则';
    $('addTraceBtn').textContent = '保存修改';
    $('cancelEditBtn').hidden = false;
    $('traceName').value = t.name;
    $('tracePattern').value = t.pattern;
    $('traceWeight').value = t.weight;
    $('traceCap').value = t.cap;
    $('traceError').hidden = true;
  }

  /** 退出编辑态并清空表单 */
  function resetTraceForm() {
    traceEditId = null;
    $('traceFormTitle').textContent = '新增规则';
    $('addTraceBtn').textContent = '添加规则';
    $('cancelEditBtn').hidden = true;
    $('traceName').value = '';
    $('tracePattern').value = '';
    $('traceError').hidden = true;
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
    // 编辑态：原地替换该规则（id 不变，缓存键不受影响）；否则新增
    let next;
    if (traceEditId) {
      next = (currentSettings.customTraces || []).map((x) =>
        x.id === traceEditId ? { ...x, name, pattern, weight, cap } : x
      );
    } else {
      traceDraftId++;
      next = [...(currentSettings.customTraces || []), { id: `custom-${Date.now()}-${traceDraftId}`, name, pattern, weight, cap }];
    }
    currentSettings.customTraces = next;
    renderTraces(next);
    resetTraceForm(); // 清空表单并退出编辑态
  }

  // ---------- 内置规则展示 ----------

  function renderBuiltinTraces() {
    const list = $('builtinTraceList');
    list.textContent = '';
    for (const t of ZD.traces) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'ov-info';
      name.textContent = `${t.name} — 每次扣 ${t.weight} 分（上限 ${t.cap} 次）`;
      li.appendChild(name);
      list.appendChild(li);
    }
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
      info.textContent = `回答 ${answerId} — ${ov.verdict === ZD.VERDICT.AI ? '认为 AI' : '认为人工'}（${when}）`;
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

  // ---------- 作者管理 ----------

  /**
   * 从输入解析作者 token（people 主键）。
   * 接受：完整/协议相对主页链接、people/xxx 片段、或裸 token。
   * @returns {string|null} 非法格式返回 null
   */
  function parseAuthorInput(raw) {
    const s = (raw || '').trim();
    if (!s) return null;
    const m = s.match(/(?:zhihu\.com|zhuanlan\.zhihu\.com)\/people\/([A-Za-z0-9_-]+)/);
    if (m) return m[1];
    const m2 = s.match(/people\/([A-Za-z0-9_-]+)/);
    if (m2) return m2[1];
    if (/^[A-Za-z0-9_-]{3,64}$/.test(s)) return s;
    return null;
  }

  async function renderAuthorRules() {
    const rules = await ZD.storage.getAuthorRules();
    const list = $('authorList');
    const empty = $('authorEmpty');
    list.textContent = '';
    const entries = [];
    for (const [token, e] of Object.entries(rules.blocked || {})) entries.push({ token, kind: 'blocked', ...e });
    for (const [token, e] of Object.entries(rules.trusted || {})) entries.push({ token, kind: 'trusted', ...e });
    entries.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    empty.hidden = entries.length > 0;
    for (const en of entries) {
      const li = document.createElement('li');
      const info = document.createElement('span');
      info.className = 'ov-info author-list-info';
      const nameEl = document.createElement('b');
      nameEl.textContent = en.name || '（未知昵称）';
      const kindEl = document.createElement('span');
      kindEl.className = 'author-kind ' + (en.kind === 'blocked' ? 'kind-blocked' : 'kind-trusted');
      kindEl.textContent = en.kind === 'blocked' ? '屏蔽' : '信任';
      const tokenEl = document.createElement('code');
      tokenEl.textContent = 'people/' + en.token;
      const whenEl = document.createElement('span');
      whenEl.className = 'author-when';
      whenEl.textContent = en.ts ? new Date(en.ts).toLocaleString('zh-CN') : '未知时间';
      info.append(nameEl, ' ', kindEl, ' ', tokenEl, ' ', whenEl);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'mini';
      del.textContent = '移除';
      del.addEventListener('click', async () => {
        await ZD.storage.removeAuthorRule(en.kind, en.token);
        await renderAuthorRules();
        setStatus('已移除作者规则', true);
      });
      li.appendChild(info);
      li.appendChild(del);
      list.appendChild(li);
    }
  }

  async function addAuthor() {
    const raw = $('authorUrl').value;
    const kind = $('authorKind').value;
    const token = parseAuthorInput(raw);
    const errEl = $('authorError');
    if (!token) {
      errEl.textContent = '无法识别作者主页：需为 zhihu.com/people/xxx 格式（可粘贴完整链接或 people/xxx）。';
      errEl.hidden = false;
      return;
    }
    errEl.hidden = true;
    // 昵称由卡片操作时自动补全（按链接添加时未知）
    await ZD.storage.setAuthorRule(kind, token, '');
    $('authorUrl').value = '';
    await renderAuthorRules();
    setStatus(`已${kind === 'blocked' ? '屏蔽' : '信任'}作者（页面即时生效）`, true);
  }

  // ---------- 二审缓存管理 ----------

  async function renderCacheInfo() {
    const cache = await ZD.storage.getCache();
    const el = $('cacheInfo');
    if (el) el.textContent = `二审缓存 ${Object.keys(cache).length} 条（按内容哈希，回答被编辑或规则/权重变化自动失效）`;
  }

  async function clearCache() {
    await chrome.storage.local.remove(ZD.KEYS.CACHE);
    await renderCacheInfo();
    setStatus('二审缓存已清除', true);
  }

  /**
   * 重置配置：全部设置项恢复默认（含 API Key / 自定义规则 / 二审提示词）。
   * 不影响覆盖记录与二审缓存（属用户数据，非配置）。需二次确认。
   */
  async function resetSettings() {
    const ok = confirm(
      '确定要将所有配置恢复为默认值吗？\n\n' +
        '将重置：判定阈值、模糊带、API 地址与 Key、模型、每页调用上限、二审权重、\n' +
        '输入窗口、自定义规则、二审提示词等全部设置项。\n' +
        '不影响：回答覆盖记录与二审缓存。\n\n' +
        '此操作不可撤销，确定继续？'
    );
    if (!ok) return;
    currentSettings = { ...ZD.DEFAULTS };
    await ZD.storage.saveSettings(currentSettings);
    fillForm(currentSettings);
    setStatus('已重置为默认配置', true);
  }

  // ---------- 事件绑定 ----------

  $('saveBtn').addEventListener('click', save);
  $('resetBtn').addEventListener('click', resetSettings);
  $('toggleKey').addEventListener('click', () => {
    const key = $('apiKey');
    const show = key.type === 'password';
    key.type = show ? 'text' : 'password';
    $('toggleKey').textContent = show ? '隐藏' : '显示';
  });
  $('resetPrompt').addEventListener('click', () => {
    $('judgePrompt').value = ZD.CLOUD_SYSTEM_PROMPT;
    setStatus('已恢复默认提示词（保存后生效）', true);
  });
  $('addTraceBtn').addEventListener('click', addTrace);
  $('cancelEditBtn').addEventListener('click', resetTraceForm);
  $('clearCacheBtn').addEventListener('click', clearCache);
  $('addAuthorBtn').addEventListener('click', addAuthor);
  $('authorUrl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addAuthor();
  });
  $('cloudScoreWeight').addEventListener('input', () => {
    $('cloudScoreWeightVal').textContent = $('cloudScoreWeight').value + '%';
  });

  // 存储变化：其他页面修改设置/覆盖/作者规则/缓存时同步刷新
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[ZD.KEYS.SETTINGS]) fillForm(changes[ZD.KEYS.SETTINGS].newValue || ZD.DEFAULTS);
    if (changes[ZD.KEYS.OVERRIDES]) renderOverrides();
    if (changes[ZD.KEYS.AUTHOR_RULES]) renderAuthorRules();
    if (changes[ZD.KEYS.CACHE]) renderCacheInfo();
  });

  // ---------- 启动 ----------

  (async function init() {
    const settings = await ZD.storage.getSettings();
    fillForm(settings);
    await renderOverrides();
    await renderAuthorRules();
    await renderCacheInfo();
  })();
})();
