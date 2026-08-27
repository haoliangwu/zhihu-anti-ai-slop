# 03 — 回归与发布

Type: task
Status: ready-for-agent
Priority: P0

**Blocked by:** 01, 02

作者控制功能收尾：全量回归既有行为，更新文档，提交推送并重建发布包。

**验收：**

- [ ] 回归清单通过：卡片覆盖（认为人工/认为AI/清除）、二审（缓存命中、重新判定强制绕过）、AI 隐藏正文、首页时间线判定，均不受作者规则影响
- [ ] 作者规则在问题页、首页时间线均生效，匿名卡、无作者卡不报错
- [ ] README 更新（作者控制说明；如需配图与 docs/images 文件名一致）；CONTEXT.md 术语与 ADR 记录决策
- [ ] 提交推送 main 分支；重建 dist zip 并与仓库内构建产物 md5 一致
- [ ] 扩展重装/刷新后功能可用，console 无报错

## Comments

- 参照此前功能收尾流程（feature → 回归 → 文档 → 提交推送 → zip）
- 完成后即解锁 `.scratch/articles/` 的 01（用户要求严格顺序执行）
