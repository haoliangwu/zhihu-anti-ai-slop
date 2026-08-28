# 06 — v4-flash 数据缺口实证与全量重拟合评估（A1 pilot + A2 全量）

Type: research
Status: done
Priority: P1

**发现途径：** 用户指出训练集 9 个 LLM 均为旧代模型，扩展默认检测的 deepseek-v4-flash 零样本（C-ReD: deepseek-v3/r1、qwen-2.5/3、doubao-1.5-pro、gpt-3.5/4o、claude-3.5-haiku、gemini-2.5-flash）。

## 结论（数据锁定，2026-08-29）

1. **现有权重对 v4-flash 实质失效**：长度匹配 [300,700] 下 flash 判「正常」87.4%（人类 87.1%、旧AI 35.7%），判「确定 AI」仅 6.0%。flash 特征向量到人类距离 0.477、到旧 AI 0.735——**v4-flash 在 21 个固定句式特征上已人类化**。
2. **唯二独有信号**：破折号反复 40%（人类 3.8%）、冒号滥用 67.5%（人类 43.3%）；其余 18 特征塌向人类侧。
3. **θ 扫描重拟合（加权平衡逻辑回归，flash 占 AI 质量 θ=0.1~1.0）全部 6 档未过闸门**：
   - 闸门：旧域 AUROC ≥ OLD−0.010 且 Brier ≤ OLD+0.005；混合 AI 面 AUROC ≥ OLD−0.005；flash Acc/Brier 双优；人类 Brier 增幅 ≤0.02
   - θ=0.1 最接近：混合面 AUROC **0.7904 vs OLD 0.7632（+0.027）**、flash Acc 0.434（OLD 0.108，4 倍）、旧域 Brier 0.1915 优于 OLD；**唯一缺口旧域 AUROC −0.014（超偏差线 0.004）**
   - θ 升则旧域（尤其旧 AI）崩塌（θ=1 时旧 AI 全量 Acc 0.60→0.22）
4. **生产权重未替换**（`calibrated-weights.js` 维持 v2）。A1 时 300 条 flash 补入显示"旧域不伤"属小样本假象——全量后 flash 与旧 AI 抢 AI 侧质量份额，代价显现。

## 数据与脚本

- 生成：`eval/pilot/generate.js`（官方 api.deepseek.com/v1 + deepseek-v4-flash、thinking:disabled、4 风格、长度分层、断点续跑），**2956 条零失败**；生成数据 `answers.jsonl` gitignore 不入库
- 分析：`eval/pilot/length-match.js`（长度匹配排除伪信号）、`eval/pilot/analyze.js`（分布对比）
- 拟合：`eval/pilot/fit-full.js`（θ 扫描 + 相对闸门 + 混合 AI 面；`--bake` 才覆盖生产权重）
- 报告：`eval/pilot/REPORT.md`（A1）、`eval/pilot/REPORT-FULL.md`（A2）、`eval/pilot/report-full.json`（数值全量）
- 成本：约 2.9M token ≈ ¥5 量级（thinking:disabled 关键，否则推理 token 吃量翻倍）

## 后续方向（待用户决策）

- **A. 接受现状**：权重维持 v2，flash 漏判 87% 记录为已知限制（类比 ADR-0005 学术误报条目）
- **B. θ=0.1 折中替换**：混合面 +0.027 / flash Acc 4 倍，代价旧域 AUROC −0.014（需放宽闸门）
- **C. 破折号专属特征立项**：40% vs 3.8% 是最强稳定信号，新增可解释特征（不依赖重拟合全流程）
- **D. 方案 B 统计特征**：句长波动/字符熵/标点密度（flash 已人类化，统计信号是下一台阶）