# 01 — 离线拟合与评估（数据、特征、逻辑回归、对比现扣分制）

Type: task
Status: ready-for-agent
Priority: P1

**Blocked by:** 无

从公开中文基准取标注语料（优先 C-ReD Q&A 子集：知乎 KOL 人类回答 + 多 LLM 生成；不可用则 HC3 中文问答），对现有 ~20 条内置痕迹的命中数向量拟合逻辑回归，产出权重常量 + 截距，并在留出集上与现扣分制对比（Accuracy / AUROC / Brier）。**只有通过门槛（AUROC 或 Brier 至少一项优于现扣分制）才允许 02 开工。**

**验收：**

- [ ] 数据源确定并成功获取（C-ReD Q&A 或 HC3 中文问答；两者均不可获取 → 本票标记 blocked 并回报，不自行造数据）
- [ ] 特征提取与扩展实际正则一致：Node 端直接加载 `src/engine/traces.js`，对每条文本输出与内容脚本相同的命中数向量（cap 前）
- [ ] 逻辑回归拟合脚本（零依赖或最小依赖）产出 20 个权重 + 截距，写入 `src/engine/calibrated-weights.js`（常量表，注明拟合数据/日期/样本量）
- [ ] 留出集评估：现扣分制 vs 校准模型的 Accuracy / AUROC / Brier + 可靠性图数据
- [ ] 门槛判定：AUROC 或 Brier 至少一项优于现扣分制 → 02 放行；未通过 → 功能暂停、结论写回本票与调研文档
- [ ] 评估脚本与说明落库 `.scratch/calibrated-scoring/eval/`

## Comments

- 设计来源：`.scratch/calibrated-scoring/spec.md` §3/§4；调研 §4 方案 A、§5 步骤 1–3
- 先例：HC3（arXiv:2301.07597）在中文问答上用「特征 + 逻辑回归」验证过该路线
- 校准指标定义：Brier = 均方误差 (p−y)²；可靠性图 = 按预测概率分箱，画实际频率 vs 预测概率
- 实现提示：逻辑回归可用 Node 手写梯度下降（约 40 行，零依赖）；若本机有 python3 + sklearn 亦可，但产出物必须是 JS 常量表
