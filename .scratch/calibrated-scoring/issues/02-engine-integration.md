# 02 — 引擎集成（纯 JS sigmoid 评分器、log-odds 理由面板、回退开关）

Type: task
Status: ready-for-agent
Priority: P1

**Blocked by:** 01（01 通过门槛后放行）

把 01 产出的权重常量接入一审：新增校准评分器（sigmoid + 点积）替换加性扣分；理由面板命中清单升级为逐特征对数几率贡献；保留旧扣分制为代码级回退开关；用户自定义正则保持原扣分语义叠加。

**验收：**

- [ ] `src/engine/` 新增校准评分器（约 10–20 行纯 JS）：命中数向量 → σ(w·x+b) → 0–100 人类置信度
- [ ] 与 `src/engine/calibrated-weights.js` 常量表对齐；`score()` 输出形态不变（`{score, hits}`），调用方（analyzeCard / analyzeArticle / 二审缓存键 / 云端融合）零改动
- [ ] 理由面板：命中清单显示每条特征的对数几率贡献（`w_i·x_i`，保留两位）与命中次数；标题显示校准后分数
- [ ] 用户自定义正则：按原 deduct 在 sigmoid 结果上扣减并钳制 0–100（语义与现版一致）
- [ ] 回退开关：代码级常量（默认启用校准；切回旧扣分制后全部行为与现版一致）
- [ ] 浏览器实测：问题页/文章页角标分数与面板展示正确；覆盖、作者规则、二审（缓存/重判定）、隐藏正文均不受影响

## Comments

- 设计来源：`.scratch/calibrated-scoring/spec.md` §3；调研 §4 方案 A
- 不改变：消息协议、存储格式、二审缓存键（缓存键含一审摘要；一审分变化 → 摘要变化 → 自动重判，无需迁移）
- 实现提示：校准评分器建议独立函数（如 `ZD.engine.scoreCalibrated(text, traces)`），`score()` 内部按回退开关分发；hits 结构追加 `contribution` 字段供面板展示
