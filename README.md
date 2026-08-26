# 知乎照妖镜（暂定名）

知乎 AI 答案检测 Chrome 扩展（Manifest V3）：在知乎问题页为每条回答计算**人类置信度**（0–100，100 = 几乎确定人工），角标标记判定等级，支持查看理由与手动覆盖。

领域词汇与架构决策见 [CONTEXT.md](CONTEXT.md) 与 [docs/adr/](docs/adr/)，MVP 规格见 [.scratch/mvp/spec.md](.scratch/mvp/spec.md)。

## 工作原理

1. **发现回答**：内容脚本通过 `MutationObserver` 发现已渲染与滚动加载的回答卡片
2. **输入窗口**：提取正文（默认 ≤2000 字，跳过标题/图/引用开头；可切"只看开头一两段"）
3. **规则初审**：命中 AI 创作痕迹（套话、总分总骨架、空洞强调等 16 类）即扣分，输出规则分与命中清单
4. **云端二审**（可选）：规则分落入模糊带（默认 20–80）时，将正文发送至 OpenAI 兼容接口（默认 DeepSeek）复核；按回答 ID 缓存、每页限次、失败自动降级
5. **角标与覆盖**：渲染判定角标；点击展开理由面板；可覆盖为"认为人工 / 认为 AI"，记录存本机

优先级：**用户覆盖 > 云端二审 > 规则初审**。

## 安装（开发模式）

1. `chrome://extensions` → 打开"开发者模式"
2. "加载已解压的扩展程序" → 选择本目录
3. 打开任意知乎问题页（`zhihu.com/question/*`）查看效果

## 配置

点击工具栏扩展图标打开设置页：

- **判定阈值**：确定 AI（默认 ≤10）/ 疑似 AI（默认 ≤40）
- **云端二审**：启用开关、API 地址、API Key（仅存本机）、模型名、每页调用上限
- **输入窗口**：字数上限、全文/开头模式

未配置 API Key 时仅使用本地规则引擎。

## 目录结构

```
manifest.json            MV3 清单
src/
  shared/constants.js    默认配置 / 存储键 / 消息类型 / 二审提示词
  shared/storage.js      设置、覆盖、二审缓存的存储助手
  engine/traces.js       AI 创作痕迹清单（16 类，扣分制）
  engine/rules.js        规则引擎（评分 + 等级映射）
  content/extract.js     知乎 DOM 选择器与正文提取（单点维护）
  content/content.js     内容脚本主逻辑
  content/content.css    角标样式（zys- 前缀）
  cloud/second-opinion.js  云端二审（缓存/限流/调用）
  background/service-worker.js  SW：二审路由
  options/               选项页
scripts/generate-icons.py 图标生成（纯标准库）
.scratch/mvp/            MVP spec 与实现 ticket（issue tracker）
```

## 限制

- 仅支持 `zhihu.com/question/*` 问题页回答列表
- 自定义 LLM API 域名需自行在 `manifest.json` 增加 host_permissions
- 规则引擎对文学性 / 古风文本有误报风险（二审提示词已显式规避）
