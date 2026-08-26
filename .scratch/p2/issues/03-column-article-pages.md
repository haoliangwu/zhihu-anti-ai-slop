# 02 — 专栏文章页支持

Type: task
Status: ready-for-agent
Priority: backlog

> 用户已决定：专栏文章页进入 backlog。

支持 `zhuanlan.zhihu.com/p/*` 与 `zhihu.com/p/*` 文章页：manifest 增加 matches、正文取 `.Post-RichText`（research 已记录）、覆盖/缓存键改用内容哈希或文章 URL（文章无回答 ID）。验收：文章页出现角标与理由面板，覆盖/缓存按文章维度生效。

## Comments

- 参考 `.scratch/p2/spec.md` §3-02
