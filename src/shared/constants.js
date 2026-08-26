/**
 * 知乎照妖镜 — 共享常量与默认配置
 * 经典脚本（非模块）：通过 globalThis.ZhihuDetector 命名空间在
 * content script / service worker / options 页面间共享。
 */
'use strict';

globalThis.ZhihuDetector = globalThis.ZhihuDetector || {};

Object.assign(globalThis.ZhihuDetector, {
  /** 存储键 */
  KEYS: {
    SETTINGS: 'settings',
    OVERRIDES: 'overrides',
    CACHE: 'secondOpinionCache',
    BUDGET: 'secondOpinionBudget', // chrome.storage.session，按 tab 计
  },

  /** 默认配置（选项页可覆盖，存 chrome.storage.local[KEYS.SETTINGS]） */
  DEFAULTS: {
    thresholdConfirm: 40,   // ≤ 此值 → 确定 AI
    thresholdSuspect: 70,   // ≤ 此值 → 疑似 AI
    fuzzyLow: 20,           // 二审模糊带下界
    fuzzyHigh: 80,          // 二审模糊带上界
    apiBaseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    apiModel: 'deepseek-v4-flash',
    cloudEnabled: true,
    maxChars: 2000,         // 输入窗口字数上限
    minChars: 300,          // 判定字数下限：正文少于该字数直接跳过判定（0 关闭）
    windowMode: 'full',     // 'full' | 'head'（只看开头一两段）
    cloudPerPageLimit: 20,  // 每页二审调用上限
    /** 二审权重（0-1）：最终分 = 二审分×权重 + 一审规则分×(1-权重)，
     *  LLM 打分波动大（实测 std≈26），加权融合可显著降噪 */
    cloudScoreWeight: 0.6,
    hideAiBody: true,       // P1：AI 判定直接隐藏正文（0 关闭）
    /** 用户自定义 AI 创作痕迹正则规则：[{id, name, pattern, weight, cap}] */
    customTraces: [],
    /** 二审 system 提示词（可编辑，默认 = CLOUD_SYSTEM_PROMPT） */
    judgePrompt: '',
    /** 二审额外请求参数（JSON 字符串，合并进 /chat/completions body 的顶层字段）。
     *  默认 = DeepSeek：关闭思考模式（其下 temperature 等参数不生效）+ temperature 0；
     *  留空 '' 则不发送任何额外参数，兼容性最好（纯 OpenAI / 严格校验的服务商）。
     *  非法 JSON 在设置页保存时拦截，调用侧兜底忽略。 */
    extraParams: '{"thinking":{"type":"disabled"},"temperature":0}',
  },

  /** 消息类型 */
  MSG: {
    SECOND_OPINION: 'SECOND_OPINION',
  },

  /** 判定结论取值（覆盖记录 / 二审输出 / 消息统一使用，避免散落字面量） */
  VERDICT: { AI: 'ai', HUMAN: 'human', MIXED: 'mixed' },

  /** 判定等级（角标样式与文案的键） */
  LEVEL: { CONFIRM_AI: 'confirm-ai', SUSPECT_AI: 'suspect-ai', NORMAL: 'normal', SKIP: 'skip' },

  /** 二审并发上限：内容侧发送队列与 SW 侧执行共用同一上限 */
  CLOUD_MAX_CONCURRENT: 2,

  /** 二审缓存上限（LRU 淘汰，命中即刷新 ts） */
  CACHE_LIMIT: 500,

  /** 二审单次超时（ms） */
  CLOUD_TIMEOUT_MS: 30_000,

  /** 钳制到 0–100 并取整（判定分统一出口） */
  clampScore(v) {
    return Math.max(0, Math.min(100, Math.round(v)));
  },

  /** system prompt 模板保留字：代表动态拼接的一审（规则引擎）上下文 */
  CTX_SLOT: '{{ai_slot_ctx}}',

  /** 二审提示词系统消息（判定逻辑参考 stop-slop-zh 的中文 AI 写作信号分类；
   *  模板支持 {{ai_slot_ctx}} 保留字，调用时替换为一审结果） */
  CLOUD_SYSTEM_PROMPT: [
    '你是"知乎 AI 答案判定"的云端二审校验器。规则初审分数落在模糊带，需要你独立判断一段知乎回答正文是"人类撰写"还是"AI 生成"。',
    '判定方法：逐类检查以下 AI 写作信号，命中则记入 ai_signals；同时寻找人类写作信号记入 human_signals。先评估证据，再给分数。',
    '',
    'AI 信号（按类别）：',
    '1. 标点滥用：滥用冒号「：」引出解释/列举/定义；滥用破折号「——」做补充说明或戏剧性停顿；用英文双引号 " " 标注概念/术语（人类倾向用「」或不加）。',
    '2. 套话与连接词：废话连接词（说白了、本质上、换句话说、不可否认）；总结套话（综上所述、总的来说、总而言之、一言以蔽之）；编号过渡（首先/其次/最后、第一/第二/第三、一方面/另一方面）。',
    '3. AI 信号词：值得注意的是、不难发现、显而易见、毋庸置疑、众所周知、需要指出的是、让我们来看看、接下来让我们。',
    '4. 时代套话与空洞归纳：在当今…的时代、随着…的快速发展/不断进步、在这个…的大背景下；这意味着、这说明了什么、由此可见。',
    '5. 虚假强调与伪口语：毫无疑问、可以说、事实上/实际上（未引用具体事实或无对比时）；那么问题来了、你可能会问、这就引出了一个问题、答案可能出乎你的意料。',
    '6. 结构八股：编号式组织（判断一/判断二、"第一…第二…第三"）；大段 bullet 罗列；频繁小标题；"总分总"模板（开头"本文将讨论 A/B/C" + 分述 + 总结收尾）；工整排比堆砌。',
    '',
    '人类信号：',
    '- 口语化与个人视角：具体个人经历、时间地点细节、自嘲或承认不确定（如"说实话我也不确定"）、情绪化表达。',
    '- 自然节奏：句式长短错落、偶尔的轻微不完美、即兴感，而非机械匀称。',
    '- 具体性：真实数据/场景/人名/事件，而非泛泛而谈。',
    '- 结构自然：开头用反差数据或具体事件切入，结尾回扣开头，中间自然过渡而非机械分块。',
    '',
    '判定原则：',
    '1. 默认假设文本是人类撰写，除非有强证据表明是 AI。',
    '2. 证据优先：先评估证据，再给分数；输出严格 JSON，不要多余文字。',
    '3. 命中多个类别的 AI 信号才算强证据；单一弱信号（如一个破折号）不构成判 AI 的依据。',
    '4. 正文少于 50 字或信息量过低时：score 给 50，verdict 给 "mixed"，并在 ai_signals 注明"信息不足"。',
    '5. 注意：文学性/古风/文言文本不要误判为 AI（排比、对仗是其文体特征而非 AI 信号）；专业性/学术性文本可保留规范表达。',
    '6. 参考一审（规则引擎）结果：见下方 {{ai_slot_ctx}} 处的一审规则分与命中痕迹清单。一审命中多项痕迹、扣分严重时，应倾向 AI 判定，除非正文存在明确的人工证据足以推翻；若你的判断与一审明显分歧（如一审低分你却判高分），必须在 ai_signals/human_signals 中给出推翻一审的具体理由。',
    '7. score 语义为"人类置信度"：100 = 几乎确定人工，0 = 几乎确定 AI。',
    '',
    '【一审（规则引擎）结果】',
    '{{ai_slot_ctx}}',
  ].join('\n'),
});
