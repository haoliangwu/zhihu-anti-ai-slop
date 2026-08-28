# 校准打分评估（票 01：离线拟合与评估）

复现步骤与结果记录。数据来源：**C-ReD**（HeraldofLight/C-ReD，arXiv:2604.11796）question-answer 子集——知乎 KOL 人类回答 2,956 条 + 9 个 LLM 生成 26,115 条（claude-3.5-haiku / deepseek-r1 / deepseek-v3 / doubao-1.5-pro / gemini-2.5-flash / gpt-3.5-turbo / gpt-4o / qwen-2.5 / qwen-3），label 1=人类、0=AI。

## 复现步骤

```bash
# 1) 下载 C-ReD question-answer 10 个 CSV 到 eval/data/（本目录 data/ 已 gitignore）
#    https://github.com/HeraldofLight/C-ReD/tree/main/benchmark%20data/question%20answer
# 2) CSV → dataset.jsonl（gitignore）
python3 convert.py
# 3) 特征提取：直接加载扩展自身 src/shared/constants.js + src/engine/traces.js（单一事实源），
#    每条样本输出 21 维命中数向量（cap 前）+ 现扣分制基线分
node features.js
# 4) 逻辑回归拟合 + 留出集评估（分层 80/20，种子可复现；平衡/全量两变体）
node fit.js          # 产出 src/engine/calibrated-weights.js + report.json
# 5) 种子鲁棒性检查（5 种子权重符号稳定性）
node robustness.js
```

## 结果（留出集，n=5814，人类 591 / AI 5223）

| 模型 | Accuracy | AUROC | Brier |
|---|---|---|---|
| 现扣分制基线（score/100 伪概率） | 0.102* | 0.676 | 0.687 |
| **平衡训练（交付）** | 0.619 | **0.816** | **0.192** |
| 全量训练（自然先验） | 0.902 | 0.815 | 0.079 |

\* 基线 Accuracy 语义失真（分数量纲非概率，阈值 0.5 无意义）；判别力看 AUROC、校准看 Brier，两项均为对齐比较。

**平衡评估子集（全 test 人类 + 等量 AI，与部署语义一致）**：平衡模型 AUROC 0.824 / Brier 0.166 / Acc 0.750；全量模型 Brier 0.329 / Acc 0.523（先验错配失真）→ **交付平衡模型**。

**门槛判定：通过**（AUROC 0.816 > 0.676 且 Brier 0.192 < 0.687）。

## 关键发现（影响票 02 的设计决策）

1. **符号翻转是数据驱动且稳定**：C-ReD Q&A 域里人类知乎 KOL 比被提示词约束的 9 个 LLM **更常使用**冒号（`colon-overuse` +0.29~+0.36）、句号当顿号（+0.17~+0.23）、伪口语（+0.03~+0.08）、伪亲密称呼（+0.03~+0.12）、破折号反复、编号式结构、强化词——旧引擎给「冒号滥用」扣 3 分是**域偏差**，校准模型自动纠正。
2. **5 个特征符号不稳定**（元评论/励志结尾/成语堆砌/死隐喻）：基率≈0、|w|≤0.09，属噪声特征，对分数贡献可忽略（可考虑在 02 中置零）。
3. 强 AI 信号（tricolon -2.07、superlative -1.58、hollow-summary -1.21、connector-skeleton -0.93、empty-emphatic -0.81）符号稳定、方向符合直觉。
4. 鲁棒性：5 种子 AUROC 0.782–0.792，16/21 特征符号稳定。

## 局限

- 拟合用的是 C-ReD 全文本；运行时输入窗口截断至 2000 字——特征计数在超长文本上略有差异（均值长度 400–760，影响小）。
- 域 = 知乎问答（与目标同构），但 9 个 LLM 的提示词风格统一（要求"清晰明了"）；对未见过 LLM / 改写文本的泛化未验证。
- 平衡模型的概率是先验中性（50/50）的"证据强度"，非知乎现网先验下的后验——分数语义 = 人类置信度，与 ADR-0001 一致。
