# 01 — 「包含 AI 辅助创作」声明卡跳过检测直接出结论

Type: task
Status: resolved

## Answer

已交付（实测于知乎问题页 /question/4044820145，样本答案 ID 2078517282599448863）：

- 声明检测挂在卡片时间区 `.ContentItem-time`（SSR 首帧即存在）：匹配官方短语 `包含 AI 辅助创作`（外层 hash 类名 `css-18biwo` 不可依赖，只匹配稳定文本）。
- 声明卡跳过整条评分管线（不提取/不跑规则/不进二审/不消费预算/minChars 与正文变化重分析均跳过），渲染紫调角标「声明 / AI / 作者声明」+ 面板引用声明原文。
- 用户拍板 1A/2B：三个判定按钮全禁用（作者已自认含 AI，"认为人工"与声明冲突、"重新判定"无意义）；手动覆盖优先于声明（已有覆盖时显示覆盖结果）。
- `declaredHideBody` 默认 false = 声明卡正文展开不折叠（已自认 AI 不主动藏文）；勾选后行为同 hideAiBody。
- 声明翻转（作者后续添加/移除）自动重扫：**全卡快照对比**方案。初版只收集 addedNodes、移除声明不触发重扫（实证暴露）；改为每批 mutation 后对已分析卡全量比对声明状态，防抖重扫，添加/移除/替换三方向统一覆盖。双向翻转实机验证通过。

## 验收

- 声明卡：角标「声明 / AI / 作者声明」，正文默认展开，面板含声明原文与"检测已跳过"
- 三个判定按钮 disabled，屏蔽/信任该作者保留
- 手动覆盖优先于声明（2B）
- 移除声明 → 自动回到正常判定；重新添加 → 回到声明卡
- 其他回答卡照常判定
- 文章详情页/文章列表卡共用同一检测（`.ContentItem-time` 通用）

## 实现要点

- `src/content/extract.js`：`AI_DECLARATION_RE` + `hasAiDeclaration(card)`
- `src/content/content.js`：声明分支插在覆盖之后、提取之前（回答/文章双管线）；`renderDeclarationBadge`；`cardDeclared` WeakMap + 全卡快照翻转检测
- `src/shared/constants.js`：`LEVEL.DECLARED`、`declaredHideBody`（默认 false）
- `src/content/content.css`：`.zys-level-declared` 紫调、`.zys-declared-quote`、`button:disabled` 置灰
- `src/options/options.html/js`：`declaredHideBody` 开关

## Comments

- 用户建议：声明卡跳过检测评分，直接将"已声明"结论提示出来
- 用户拍板：Q1=A 三个判定按钮全禁用；Q2=B 手动覆盖优先于声明
- 用户拍板：声明卡默认展开正文不折叠，`declaredHideBody` 默认 false
- 实机验证中发现并修复：初版翻转检测依赖批次节点（`anc.closest`），声明被整体移除时节点已脱离 DOM → 改为全卡快照对比