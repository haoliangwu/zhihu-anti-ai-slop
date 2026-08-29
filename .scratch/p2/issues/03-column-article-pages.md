# 03 — 专栏文章页支持

Type: task
Status: done
Priority: backlog

> 用户已决定：专栏文章页进入 backlog；经 `.scratch/articles/` 功能实现后标记 done（2026 文章功能发布）。

支持 `zhuanlan.zhihu.com/p/*` 与 `zhihu.com/p/*` 文章页：manifest 增加 matches、正文取 `.Post-RichText`（research 已记录）、覆盖/缓存键改用内容哈希或文章 URL（文章无回答 ID）。验收：文章页出现角标与理由面板，覆盖/缓存按文章维度生效。

## Comments

- 参考 `.scratch/p2/spec.md` §3-02
- 被 `.scratch/articles/` 新功能取代（文章详情页 + 列表卡片判定，含作者规则一致应用）。本票保持 backlog 状态不再推进，正文选择器结论（`.Post-RichText`）可作实现参考。
