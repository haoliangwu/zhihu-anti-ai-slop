# 01 — 离线拟合与评估（数据、特征、逻辑回归、对比现扣分制）

Type: task
Status: done
Priority: P1

**Blocked by:** 无（已交付）

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

## 交付记录（2026-08）

- **数据**：C-ReD question-answer 子集（知乎 KOL 人类 2,956 + 9 LLM 26,115 = 29,071 条），CSV 下载至 `eval/data/`（gitignore，不入库）
- **特征**：`eval/features.js` 直接加载扩展自身 `src/engine/traces.js`（单一事实源），21 维命中数向量（cap 前）+ 现扣分制基线分；`eval/convert.py` CSV→JSONL
- **拟合**：`eval/fit.js` 零依赖逻辑回归（梯度下降 + L2），分层 80/20（种子 20260828）；产出 `src/engine/calibrated-weights.js`（平衡模型，原始尺度权重，运行时零标准化）
- **留出集（n=5814，人类 591）**：基线 AUROC 0.676 / Brier 0.687；**平衡模型 AUROC 0.816 / Brier 0.192 / Acc 0.619**；全量模型 AUROC 0.815 / Brier 0.079 / Acc 0.902
- **平衡评估子集（与部署语义一致）**：平衡模型 AUROC 0.824 / Brier 0.166 / Acc 0.750；全量模型 Brier 0.329 失真 → **交付平衡模型**（先验中性，分数 = 人类置信度，符合 ADR-0001）
- **门槛：通过**（AUROC 且 Brier 均优于基线）→ 02 放行
- **鲁棒性（`eval/robustness.js`，5 种子）**：AUROC 稳定 0.782–0.792；16/21 特征符号稳定；5 个不稳定（元评论/励志结尾/成语堆砌/死隐喻）均为基率≈0、|w|≤0.09 噪声特征
- **关键发现（供 02 决策）**：`colon-overuse`（冒号）、`period-as-comma`（句号当顿号）、`fake-colloquial`、`fake-intimacy` 等在本域被拟合为**人类信号**且符号跨种子稳定——C-ReD Q&A 域人类知乎 KOL 比提示词约束的 LLM 更常使用这些模式；旧引擎「冒号滥用扣 3 分」属域偏差。详见 `eval/README.md`
- 复现：`python3 convert.py && node features.js && node fit.js && node robustness.js`
