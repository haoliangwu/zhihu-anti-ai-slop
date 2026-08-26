# 知乎照妖镜 — MVP Spec

> Status: ready-for-agent · 关联 ADR: 0001（人类置信度语义）、0002（两级引擎）
> 词汇表以根目录 `CONTEXT.md` 为准，术语冲突时以词汇表为准。

## 1. 目标

在知乎问题页（`zhihu.com/question/*`）上，对每条回答自动计算**人类置信度**（0–100，100=几乎确定人工），以角标标记判定等级，支持"点击看理由"与用户**覆盖**。MVP 只实现**标记**处置动作；折叠/过滤留待后续迭代。

## 2. 范围

### In（MVP）

- `zhihu.com/question/*` 页面（含滚动加载的回答卡片）
- 规则引擎初审：命中 **AI 创作痕迹** 即扣分，输出规则分 + 命中清单
- 云端二审：规则分落入模糊带（20–80，可配置）时调用 OpenAI 兼容接口（默认 DeepSeek）；**一审结果（规则分 + 命中痕迹）作为上下文随正文一起发送**，二审参考一审并须在分歧时给出理由；按正文内容哈希 + 一审摘要缓存结果
- 角标标记 + 理由面板（命中清单 / 二审依据）+ 用户覆盖（`chrome.storage.local`，按回答 ID 键）
- 选项页：阈值 / 模糊带 / API 配置（base URL、API key、模型名）/ 输入窗口 / 每页二审上限 / 覆盖管理
- 触发：页面加载分析已渲染回答；滚动（`MutationObserver`）分析新回答；选项页提供"重新分析当前页"

### Out（明确不做）

- 折叠 / 过滤处置动作；文章页、回答单页之外的其他知乎页面形态
- 盐选内容、登录墙后的全文展开
- 本地模型检测（ADR-0002 已排除）；统计面板；数据导出
- 自定义 API 域名的主机权限自动申请（MVP 仅内置声明 `api.deepseek.com`，见 §11 风险）

## 3. 判定模型

初始 100 分，命中痕迹扣分，下限 0。等级映射（阈值可配置）：

| 等级 | 条件 | 角标样式 |
|---|---|---|
| 确定 AI | `score ≤ thresholdConfirm`（默认 40） | 红色 |
| 疑似 AI | `thresholdConfirm < score ≤ thresholdSuspect`（默认 70） | 橙色 |
| 正常 | `score > thresholdSuspect` | 绿色/中性 |
| 已覆盖 | 存在用户覆盖 | 用户所选等级 + 覆盖标记 |

优先级：**覆盖 > 云端二审 > 规则初审**。

## 4. 数据流

```
发现回答卡片 (MutationObserver)
  → 提取输入窗口（≤maxChars 字，跳过标题/图/引用开头）
  → 查覆盖表：命中 → 直接渲染覆盖判定
  → 规则初审：命中痕迹扣分 → 规则分 + 命中清单
  → 规则分在模糊带 [fuzzyLow, fuzzyHigh] 且已配置 API？
      是 → 消息 SW 请求二审（限流：每页 ≤20 次、并发 2、失败降级）
            SW: 查缓存 → 调云端 LLM → 归一化 → 写缓存 → 返回
      否 → 使用规则分
  → 渲染角标；点击展开理由面板；可设置/清除覆盖
```

## 5. 规则引擎（初审）

扣分制，每条痕迹可命中多次但扣分有上限（防长文过度惩罚）。痕迹清单来源：`research/ai-detection-prompts-facts.md` 中文 AI 味特征（开局套话、连接词骨架、空洞强调、商务黑话、强化词、名词化动词、元评论、励志结尾、排比模板、伪亲密、最高级、成语堆砌、死隐喻），加统计信号（句长齐整、句号当顿号、破折号反复）。权重与命中逻辑见 `src/engine/traces.js`，总分下限 0。

**否决项**：正文提取为空 → 不判定，不显示角标。

## 6. 云端二审

- 触发：`fuzzyLow ≤ 规则分 ≤ fuzzyHigh`（默认 20–80）且选项页已配置 API key
- 接口：OpenAI 兼容 `POST {baseUrl}/chat/completions`，`response_format: {"type":"json_object"}`；默认 `https://api.deepseek.com/v1`，模型默认 `deepseek-v4-flash`
- 协议（固定输出 JSON）：
  ```json
  {"score": 0-100, "verdict": "human"|"mixed"|"ai", "ai_signals": ["..."], "human_signals": ["..."]}
  ```
  `score` 语义即**人类置信度**（与 ADR-0001 一致，二审直接输出同语义，避免换算）。<50 字 / 信息不足 → 50 分并注明。
- 提示词要点（来自调研）：默认假设人工、证据优先、先证据后分数；提示文学性/古风勿误判；个人经历/口语/即兴感为人工强信号
- 限流：每页（按 tab）≤20 次（可配置）、并发 ≤2、单次超时 30s
- 降级：未配置 key / 网络失败 / 解析失败 / 超限 → 返回空，内容脚本回落到规则分
- **加权融合**：最终分 = 二审 LLM 分 × 权重 + 一审规则分 × (1−权重)（默认权重 0.6，可配置）。实测同一文本二审重复调用 std≈26，融合后 std≈1.4
- 缓存：`chrome.storage.local`，**键=正文 MD5 哈希 + 一审结果摘要**（回答被编辑或一审判定变化 → 键变化 → 自动重判），上限 500 条（LRU 淘汰）

## 7. 覆盖

- 键：回答 ID（从卡片内 `/answer/<aid>` 链接提取，回退 `data-za-extra-module` 等）
- 值：`{ verdict: 'human'|'ai', score, note, ts }`（MVP 二选一覆盖，无"混合"）
- 存储：`chrome.storage.local` 键 `overrides`；优先级最高；选项页可查看/清除

## 8. 输入窗口

- 正文来源：`.RichContent-inner`（含折叠文本，无需展开请求）；回退 `.RichContent`
- **只取块级正文**（`p/li/blockquote/标题`），排除图片占位（noscript 标记）与内嵌卡片动态元数据（如"50 赞同 · 1 评论"）——既是干净输入，也保证内容哈希稳定（实测：SPA 渐进渲染 + 动态数字是缓存 miss 主因）
- **稳定化**：分析前等待文本连续两次采样一致（最多约 2s），避免在部分渲染态取文
- **字数下限**：回答本身少于 `minChars` 字（默认 300）**跳过判定**并以灰色"跳过"角标标记（区别于"未命中"= 判了但无痕迹；按正文段落长度计，不受 head 模式/截断影响；0 关闭）
- 上限：`maxChars` 字（默认 2000，可配置 500–10000），截断
- 开头净化：跳过标题区；若以图/引用开头，跳至首个文本段
- 模式：`full`（全文）/ `head`（只看开头一两段，可配置切换）

## 9. 配置（选项页，`chrome.storage.local` 键 `settings`）

| 项 | 默认 | 说明 |
|---|---|---|
| `thresholdConfirm` | 40 | 确定 AI 阈值 |
| `thresholdSuspect` | 70 | 疑似 AI 阈值 |
| `fuzzyLow` / `fuzzyHigh` | 20 / 80 | 二审模糊带 |
| `apiBaseUrl` | `https://api.deepseek.com/v1` | OpenAI 兼容地址 |
| `apiKey` | 空 | 掩码显示，本地存储 |
| `apiModel` | `deepseek-v4-flash` | 模型名 |
| `cloudEnabled` | true | 二审开关 |
| `maxChars` | 2000 | 输入窗口字数上限 |
| `minChars` | 300 | 判定字数下限（回答少于该字数跳过，0 关闭） |
| `windowMode` | `full` | full / head |
| `cloudPerPageLimit` | 20 | 每页二审调用上限 |
| `cloudScoreWeight` | 0.6 | 二审权重：最终分 = 二审×权重 + 一审×(1−权重)，LLM 打分波动大（实测 std≈26）融合后显著降噪 |

## 10. 成功标准（可验证）

1. 打开任一问题页，已渲染回答在数秒内出现角标，滚动新回答自动补标
2. 明显 AI 味回答（套话+总分总+无细节）被标为疑似/确定 AI，命中清单可展开且可解释
3. 模糊带回答在配置 key 后获得二审判定；断网/无 key 时回落到规则分且无异常
4. 覆盖"认为人工/AI"后刷新页面仍生效；清除覆盖恢复引擎判定
5. 加载解压扩展无 console 报错；`chrome://extensions` 无权限告警

## 11. 风险与已知限制

- 知乎类名频繁变动 → 选择器集中维护于 `src/content/extract.js`，可单点修复
- 自定义 API 域名需自行在 manifest 增加 host_permissions（MVP 未做动态申请）
- 规则引擎对文学性/古风文本有误报风险 → 二审提示词显式规避；阈值可调
- 二审有成本与延迟 → 限流 + 缓存 + 降级路径兜底

## 12. 里程碑（对应 tickets）

| # | Ticket | 交付物 |
|---|---|---|
| 01 | `issues/01-rule-engine.md` | traces + rules 引擎 |
| 02 | `issues/02-content-marking.md` | 提取 + 角标 + 覆盖 |
| 03 | `issues/03-cloud-second-opinion.md` | SW + 二审 + 限流缓存 |
| 04 | `issues/04-options-page.md` | 选项页 + manifest + 图标 |
