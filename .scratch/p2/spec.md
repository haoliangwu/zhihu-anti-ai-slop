# 知乎照妖镜 — P2 Spec

> Status: ready-for-agent · 关联: `.scratch/mvp/spec.md`（MVP，已交付）、`CONTEXT.md`、ADR-0001/0002
> 最近更新：2026-08-26（按用户反馈重排优先级：SPA 设置页 P0、AI 隐藏正文 P1，其余 backlog）

## 1. 背景

MVP（标记/理由/覆盖/二审/选项页）已交付。P2 优先级由用户重新定义：**配置体验升级（SPA 设置页）最高优先**，其次**AI 判定直接隐藏正文**，其余进入 backlog。

## 2. 任务总览（按优先级）

| # | 任务 | 优先级 | 状态 |
|---|---|---|---|
| 01 | SPA 设置页（自定义正则规则 + judge prompt + 全量配置） | **P0** | ready-for-agent |
| 02 | AI 判定 → 隐藏正文 + 直接渲染原因/证据（折叠过滤二合一） | **P1** | ready-for-agent |
| 03 | 专栏文章页支持 | backlog | 用户已确认暂缓 |
| 04 | 自定义 API 域名动态权限 | backlog | 用户只用 DeepSeek，暂缓 |
| 05 | 本页判定统计面板 | backlog | 用户确认优先级低 |
| 06 | 判定/覆盖数据导出 | backlog | 用户确认优先级低 |

## 3. 各任务定义与验收

### 01 SPA 设置页（P0）

把配置从 popup 体验迁移为独立静态 SPA 页（`openOptionsPage()` 全页打开），新增：
- **自定义正则规则**：增删改 AI 痕迹正则（名称/正则/权重/命中上限），与内置 16 类合并参与初审；无效正则即时校验
- **judge prompt 编辑**：二审 system 提示词可编辑 + 恢复默认（正文仍单独 user 消息）
- 现有全部配置（阈值/模糊带/API/输入窗口/覆盖管理）并入

验收：action 点击打开完整设置页；自定义规则与 prompt 保存即生效；原有配置行为不变。详见 `issues/01-spa-settings-page.md`。

### 02 AI 判定 → 隐藏正文 + 直接渲染证据（P1）

确定/疑似 AI 回答**直接隐藏正文**，角标处**默认内联展示**原因（痕迹清单）与证据（二审依据），提供"展开原文"。覆盖为"认为人工"的不受影响；SPA 重渲染后自动重新应用。详见 `issues/02-ai-hide-body.md`。

### backlog（03–06）

- **03 专栏文章页**：`zhuanlan/p/*` matches + `.Post-RichText` + 文章维度覆盖/缓存键
- **04 动态 API 域名权限**：optional_host_permissions + 手势内 `permissions.request`（当前仅 DeepSeek 时无需）
- **05 统计面板**：本页 确定/疑似/跳过 计数汇总条
- **06 数据导出**：覆盖 + 缓存导出 JSON（仅导出）

## 4. 依赖与约束

- 01 涉及 manifest 改动（去 default_popup、options_ui.open_in_tab）、规则引擎签名扩展、SW 提示词来源切换——改动面最大，先做
- 02 依赖 01 之前的判定管线（无硬依赖），复用 DOM 注入；需在重渲染后重新应用
- 04 若未来启用需更新 CHROMEWEBSTORE.md 权限说明
- 全部完成后回归 MVP：覆盖/二审/缓存不受影响

## 5. 明确不做（P3+）

- 盐选内容/登录墙全文展开
- 本地模型检测（ADR-0002 已排除）
- 覆盖/导出数据云同步
