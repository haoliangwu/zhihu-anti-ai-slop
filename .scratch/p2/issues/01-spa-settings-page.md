# 01 — SPA 设置页（自定义正则规则 + judge prompt + 全量配置）

Type: task
Status: resolved

## Answer

已交付：options 升级为独立 SPA 设置页（`options_ui.open_in_tab: true`，SW `action.onClicked` → `openOptionsPage`，去掉 default_popup）；新增自定义正则规则 CRUD（无效正则保存前校验，`engine.score` 合并扣分并进理由面板）、judge prompt 编辑（textarea + 恢复默认，二审改用 `settings.judgePrompt`）、hideAiBody 开关。浏览器实测：规则添加/校验/生效、提示词落库、设置页全字段渲染均通过。
Priority: P0

将配置从 popup 体验迁移为**独立静态 SPA 设置页**（`chrome.runtime.openOptionsPage()` 全页打开，`open_in_tab: true`），并新增两类深度配置：

1. **自定义正则规则**：用户可增删改"AI 创作痕迹"正则规则（名称 / 正则 / 扣分权重 / 命中上限），与内置 21 类痕迹共同参与规则初审；无效正则即时校验提示
2. **judge prompt 编辑**：二审 system 提示词可编辑（textarea + 恢复默认），正文仍单独作为 user 消息
3. **全量配置迁移**：阈值 / 模糊带 / API / 输入窗口 / 覆盖管理 等现有 popup 配置全部并入 SPA 页

## 验收

- action 点击 → 打开完整设置页（不再是 popup 弹窗）
- 自定义正则保存后，内容脚本重新分析时生效（命中扣分、进理由面板）
- 无效正则（语法错误）在保存前被拦截并提示
- judge prompt 修改后，二审请求使用新提示词；"恢复默认"还原内置提示词
- 原有全部配置项在新页面可读写，行为与 MVP 一致

## 实现要点

- manifest：去掉 `action.default_popup`，加 `options_ui.open_in_tab: true`；SW 注册 `action.onClicked` → `chrome.runtime.openOptionsPage()`
- 规则引擎：`engine.score(text, extraTraces)` 合并用户正则规则（`pattern` 编译为 RegExp 计数命中，`cap × weight` 扣分）
- 存储：`settings.customTraces: [{id, name, pattern, weight, cap}]`、`settings.judgePrompt`（默认 = 内置 CLOUD_SYSTEM_PROMPT）
- SW 二审：改用 `settings.judgePrompt` 作为 system 消息
- SPA 页可用 `<script type="module">` 或无构建多文件加载，保持零构建

## Comments

- 用户反馈：popup 窗口配置自定义正则和 judge prompt 体验太差，需要独立完整页面；SPA 页须承载 popup 的所有配置能力
