# 统计学评分模型可行性调研（替换/增强固定句式正则引擎）

> 调研日期：2026-02 · 调研问题一句话：能否把「命中固定句式即扣固定分」的一审规则引擎，改造成「规则命中数作为特征、经统计模型校准」的 0–100 人类置信度打分，并纯 JS 跑在浏览器端？

## 1. 背景与现状（当前引擎怎么打分，为什么有偏差）

当前一审（`src/engine/rules.js` + `src/engine/traces.js`）：对每条痕迹（约 20 条正则，含「开场套话」「连接词骨架」「空洞强调」等固定句式）统计命中次数，`deduct = min(count, cap) × weight`，总分 `score = max(0, 100 − Σdeduct)`；阈值 `≤40 确定 AI、≤70 疑似 AI`，模糊带 `[20,80]` 内可选云端 LLM 二审，最终分 `0.6·cloud + 0.4·rule`（`src/shared/constants.js`、ADR-0002）。命中清单用于理由面板的可解释性（`.scratch/mvp/spec.md`）。

偏差来源（均为工程判断，非文献结论）：

1. **权重是手调整数**（12/8/7/6/5…），等价于一个未校准的线性打分器：特征空间存在，但权重未经数据拟合，分数不是概率，也没有置信度语义。
2. **固定句式 = 表面特征**：同一句式在文学/古风/正式文体中可能是自然表达（现有二审提示词已显式要求规避此类误判，见 `constants.js` CLOUD_SYSTEM_PROMPT 第 5 条）；句式可被改写绕过。
3. **短文本与长度偏差**：cap 机制缓解长文惩罚，但 <300 字文本统计信号天然稀疏；MGTBench 的消融明确「更多词数一般带来更好表现」（[arXiv:2303.14822](https://arxiv.org/abs/2303.14822)）。

用户的怀疑方向（「用统计数学模型从规则中得出相对公平的分数」）在文献里有成熟对应物：**把规则/特征向量送进逻辑回归（log-linear）或朴素贝叶斯类统计模型，输出校准概率**。下文按谱系、纯 JS 特征、升级路径、结论四部分展开。

## 2. 统计方法谱系

**2.1 困惑度 + 突发性（perplexity & burstiness）——GPTZero 初代路线。** GPTZero 2023 年 1 月首发即「统计方法」：逐句算困惑度（该句在语言模型下的负对数似然均值），突发性 = 各句困惑度的方差/波动；AI 文本普遍低困惑度、低突发性（[GPTZero 官方文档](https://gptzero.me/news/perplexity-and-burstiness-what-is-it/)；阈值语义见 [GPTZero 支持文档](https://support.gptzero.me/articles/9585228410-how-do-i-interpret-burstiness-or-perplexity)：「每句困惑度 >85 偏人类」）。**要点**：① 需要语言模型逐 token 算概率——浏览器端不可行（ADR-0002 已排除本地模型，[docs/adr/0002-two-tier-engine-rules-then-cloud.md](../adr/0002-two-tier-engine-rules-then-cloud.md)）；② GPTZero 自己已于 2023 秋弃用 P/B，转向深度多任务架构（[arXiv:2602.13042](https://arxiv.org/abs/2602.13042)），但官方明言 P/B 仍作为其升级模型的七个信号之一，且是「计算最便宜的判别方法」，被 ZeroGPT/Copyleaks/Originality 等沿用——即**统计特征作为特征之一、而非唯一手段**是最稳妥定位。

**2.2 GLTR（MIT，Gehrmann et al. 2019）。** 对每个 token 取生成分布的三类统计：top-k 概率质量、分布熵、被采样 token 的排名；人类肉眼辅助下检出率 54%→72%（[arXiv:1906.04043](https://arxiv.org/abs/1906.04043)）。特征本身需要 LM 前向传播；但**特征→判别的映射可以是普通分类器**：HC3 论文即用「GLTR Test-2 特征（Top-10/100/1000/1000+ 排名桶计数）+ 逻辑回归」，英文用 GPT-2-small、中文用 Wenzhong-GPT2-110M（[arXiv:2301.07597](https://arxiv.org/abs/2301.07597) §5.2）。这是「统计模型给规则/特征打分」的最直接先例，且就在中文问答场景验证过。

**2.3 概率曲率族（DetectGPT / Fast-DetectGPT / Binoculars）。** DetectGPT 用「扰动后对数概率下降幅度」（概率曲率）零样本判别（[arXiv:2301.11305](https://arxiv.org/abs/2301.11305)）；Fast-DetectGPT 用条件概率曲率替代扰动采样，提速约 340 倍（[arXiv:2310.05130](https://arxiv.org/abs/2310.05130)）；Binoculars 用两个相近 LM 的对数似然比，ChatGPT 样本在 0.01% 假阳性下检出 >90%（[arXiv:2401.12070](https://arxiv.org/abs/2401.12070)）。三者均需大规模 LM 的前向概率，纯客户端不可行；其中 Binoculars 在多语（含中文）上性能明显回落（SemEval-2024 多语赛道上以 7B 模型计算的统计指标，各语 F1 约 0.54–0.88，[arXiv:2402.13671](https://arxiv.org/abs/2402.13671)）。

**2.4 特征 + 分类器（logistic / 贝叶斯 / 树模型）。** HC3 的逻辑回归（见 2.2）是最佳先例；M4 基准（多生成器/多域/多语，含中文）显示判别模型在未见域/未见模型上显著退化，倾向把机器文本判成人类（[arXiv:2305.14902](https://arxiv.org/abs/2305.14902)）；SemEval-2024 Task 8 结论是「最好系统全部用 LLM」（[arXiv:2404.14183](https://arxiv.org/abs/2404.14183)），统计指标只能作廉价补充信号。朴素贝叶斯先例见 [Naive Bayes + 词对概率判别 AI 文本（UNBC 2024）](https://unbc.arcabc.ca/_flysystem/repo-bin/2024-11/unbc_59574.pdf)。综述定位：[Jawahar et al. 2020 综述](https://arxiv.org/abs/2011.01314)（特征/统计/深度三类方法全景）。

**2.5 n-gram / 熵类统计（无需神经 LM）。** Lavergne et al. 2008 用 n-gram 相对熵打分识别机器文本（PAN'08，[CEUR-WS Vol-377](https://ceur-ws.org/Vol-377/)），这是**不依赖神经 LM、只依赖语料 n-gram 表**的纯统计先例；DNA-GPT 用 n-gram 发散度做免训练判别（[arXiv:2305.17359](https://arxiv.org/abs/2305.17359)）。此类方法客户端可行，但需要背景语料与域匹配。

**2.6 中文专项证据。** C-ReD：12.86 万条中文基准（人类 12,997 / AI 115,613；人类来源含 **知乎 KOL 问答 2,956 条**、豆瓣影评、高考作文、THUCNews、ChinaXiv 摘要），9 个 LLM（含 DeepSeek），评测 OpenAI Detector / RADAR / ReMoDetect / ImBD / RoBERTa 系（[arXiv:2604.11796](https://arxiv.org/abs/2604.11796)、[GitHub](https://github.com/HeraldofLight/C-ReD)、[解读](https://papernotes.org/ACL2026/aigc_detection/c-red_a_comprehensive_chinese_benchmark_for_ai-generated_text_detection_derived_/)）——与本扩展「知乎问答 + DeepSeek」目标域几乎同构。其他中文语料：HC3 中文问答（[arXiv:2301.07597](https://arxiv.org/abs/2301.07597)）、M4 多语（[arXiv:2305.14902](https://arxiv.org/abs/2305.14902)）、LLM-Detector 中文指令微调（[arXiv:2402.01158](https://arxiv.org/abs/2402.01158)）。中文专项结论：① 无空格分词 → 需字符级处理或中文分词，LM 类特征要中文 LM（HC3 用 Wenzhong-GPT2-110M）；② 现有最强中文方案是 LLM 指令微调/集成（LLM-Detector；EnsemJudge 在 NLPCC2025 拿第一，[arXiv:2603.27949](https://arxiv.org/abs/2603.27949)），纯统计特征在中文上仅作弱信号；③ 文学/古风文本是系统性误报源（实测《滕王阁序》被多个判别工具判为 AI，[cssn.cn](https://www.cssn.cn/skgz/bwyc/202506/t20250610_5878364.shtml)）。

## 3. 纯 JS 可算的统计特征（无 LLM）

| 特征 | 文献依据 | 计算成本 | <300 字鲁棒性 | 已知误报模式 |
|---|---|---|---|---|
| 突发性（句长方差/句长波动） | GPTZero P/B 官方文档；harshaneel 句长信号；中文论文：低句长变化 + 高标点密度 → AI（[bdia.2025016](https://www.aimspress.com/article/doi/10.3934/bdia.2025016)） | O(n)，现已有「句长齐整」规则可升级为连续值 | 中：句子数 <5 时方差不稳 | 正式文体/学术文本句式均匀（现有二审提示词已预警） |
| 字符级熵 | Lavergne 相对熵（[CEUR-WS Vol-377](https://ceur-ws.org/Vol-377/)）；Shannon 熵 | O(n)，单遍字符计数 | 低：短文本熵系统性偏高，需长度归一 | 任何短文本都「随机」，区分度弱 |
| 类符/形符比（TTR）与词汇丰富度 | 风格计量学经典指标；中文 webnovel 判别表用比喻密度/极端词密度（[tance-mang](https://github.com/tance-mang/chinese-webnovel-skills/blob/main/references/ai-detector.md)） | O(n) | 低：TTR 与长度强相关，须长度分箱或 MTLD 类修正 | 口语化短句高 TTR 会误判为人类 |
| 标点密度/分布（冒号、破折号、英文引号、「句号当顿号」） | stop-slop-zh 标点类（[phrases.md](https://github.com/VincentOld/stop-slop-zh/blob/main/references/phrases.md)）；harshaneel 标点信号（[humanize](https://github.com/harshaneel/humanize)）；中文 AIMS 论文 | O(n) | 好：标点是强表面信号 | 技术/学术写作大量使用冒号破折号；现规则已有「冒号滥用」即属此类，误报已知 |
| 字符 n-gram 自重叠/重复度 | DNA-GPT 思路的无模型版：文本自身字符 bigram/trigram 自相似（[arXiv:2305.17359](https://arxiv.org/abs/2305.17359)） | O(n·k) | 中 | 排比/叠词文体（古风）误报 |
| 小 n-gram 表转移概率/相对熵（随包发布 1–3MB 中文字符 3-gram 表） | Lavergne 2008 路线（[CEUR-WS Vol-377](https://ceur-ws.org/Vol-377/)） | 预计算表 + O(n) 查表 | 中：比熵稳定 | 域不匹配（新闻语料 vs 知乎口语）导致系统性偏差 |
| 段落结构指标（编号式、总分总、小标题密度） | stop-slop-zh 结构类；中文 AI 味六特征博客（[cnblogs](https://www.cnblogs.com/jiangaigc/articles/22684257)） | O(n) | 好 | 规范文体（教程/清单式回答）误报 |

综合：除「小 n-gram 表」外全部可零依赖、微秒级纯 JS 计算；其中句长波动、标点分布、字符熵、TTR、n-gram 自重叠是**与现有 20 条正则正交**的连续信号，可直接并入特征向量。

## 4. 本扩展的升级路径对比

**方案 A：现有规则命中数 → 逻辑回归校准打分（最小改动）。** 特征 = 每条痕迹的命中数（cap 前/后均可），加截距，`p = σ(w·x + b)`，映射回 0–100 人类置信度。**这是现状的直接推广**：现扣分制本质是手调整数权重的线性模型，A 只是把权重交给数据拟合。

- 数据：C-ReD Q&A 子集（知乎 KOL 人类 2,956 条 + 多 LLM 生成，[arXiv:2604.11796](https://arxiv.org/abs/2604.11796)）即可拟合；也可用 HC3 中文问答做交叉验证；无需新采集。
- 工作量：离线拟合脚本（sklearn/纯 numpy 均可，逻辑回归无难度）+ 输出约 20 个权重常量进仓库；运行时 `sigmoid + 点积` 约十行 JS。
- 评估：留出集 Accuracy / AUROC / **Brier 分数与可靠性图**（校准性指标，见 [Guo et al. 2017](https://arxiv.org/abs/1706.04599)）；与现扣分制同数据集对比。
- 架构契合：**命中清单不变**——理由面板可显示每条特征的 log-odds 贡献（`w_i·x_i`），解释性比「固定扣分」更强；0–100 语义、阈值、模糊带、二审加权融合全部复用；用户自定义正则作为新特征自然并入。
- 风险：特征仍全来自固定句式，可被改写绕过；需接受「统计权重」可能改变用户预期中的扣分观感。

**方案 B：A + 纯 JS 统计特征。** 在 A 的特征空间加入 §3 的连续特征（句长波动、字符熵、TTR、标点密度、n-gram 自重叠，可选随包 n-gram 表）。

- 数据：同 A，但需保证统计特征分布匹配（C-ReD Q&A 与知乎现网文体有差距，建议混合少量现网抓取/用户覆盖样本）。
- 工作量：特征计算模块（约 200 行纯 JS）+ 重新拟合；n-gram 表需离线从中文语料构建。
- 评估：同 A，额外看各特征的消融与误报复盘（正式/文学文体）。
- 契合：与 A 相同；统计特征能补强「句式未被命中但节奏机械」的文本（对应现「句长齐整」规则的正交化升级）。风险：短文本（<300 字）统计不稳，MGTBench 明确长文本更准（[arXiv:2303.14822](https://arxiv.org/abs/2303.14822)），且正式文体误报需阈值调优。

**方案 C：困惑度/概率曲率类（需 LM）。** DetectGPT/Fast-DetectGPT/Binoculars 在中文上要么未验证、要么回落明显（[arXiv:2402.13671](https://arxiv.org/abs/2402.13671)），且需中文 LM 逐 token 前向——客户端不可行（ADR-0002 已排除 82–409MB 模型，[docs/adr/0002](../adr/0002-two-tier-engine-rules-then-cloud.md)）。作为**云端二审变体**可行但有代价：现有二审 LLM 本就在做同类判断，可要求其输出「困惑度/突发性」类信号并入 JSON 协议（成本不变，增益有限）；DeepSeek API 不暴露逐 token logprob，精确实现 Fast-DetectGPT 类方法不现实。折中：方案 B 的随包 n-gram 表即「无 LM 的困惑度近似」（Lavergne 路线，[CEUR-WS Vol-377](https://ceur-ws.org/Vol-377/)）。

**方案对比小结**：

| | A 校准特征 | B A+统计特征 | C 困惑度类 |
|---|---|---|---|
| 客户端可行性 | ✅ 立即可行 | ✅ 可行（有坑） | ❌ 客户端不可行；云端变体可行 |
| 数据需求 | C-ReD Q&A 即可 | C-ReD + 少量现网 | 无需（云端） |
| 工作量 | 小（离线拟合+常量） | 中（特征模块+拟合） | 中-大（云端协议改造） |
| 预期增益 | 权重公平性、可校准 | + 抗句式改写 | 理论最强但中文回落 |
| 现有架构影响 | 最小，命中清单保留 | 同 A | 需动二审协议 |

## 5. 结论与建议

**逐方案裁决**：

- **方案 A（规则特征 → 逻辑回归）**：**客户端现在就可做**。最强证据：HC3 已在中文问答上用「GLTR 排名特征 + 逻辑回归」验证过此路线（[arXiv:2301.07597](https://arxiv.org/abs/2301.07597)），C-ReD 提供同域（知乎 KOL 问答）现成标注数据（[arXiv:2604.11796](https://arxiv.org/abs/2604.11796)），运行时仅 sigmoid+点积。反方证据：特征仍限固定句式，M4 显示域/模型漂移下判别退化（[arXiv:2305.14902](https://arxiv.org/abs/2305.14902)）。
- **方案 B（加入纯 JS 统计特征）**：**可行但有条件**——特征全部有文献与廉价实现（§3），但短文本与正式文体是已知误报源（[arXiv:2303.14822](https://arxiv.org/abs/2303.14822)；[cssn.cn](https://www.cssn.cn/skgz/bwyc/202506/t20250610_5878364.shtml)），需在中文域数据上验证校准。
- **方案 C（困惑度/曲率）**：**客户端不可行**（需中文 LM 前向）；云端变体可行但增益存疑（现有 LLM 二审已覆盖，API 无 logprob）。

**推荐下一步（最小验证方案）**：

1. 离线脚本从 C-ReD 取 Q&A 子集（知乎 KOL 人类 + AI），对现有 20 条痕迹的命中数（cap 前）拟合逻辑回归；输出权重 + 截距。
2. 同数据上对比：现扣分制 vs A 模型 vs A+§3 统计特征（B），指标取 Accuracy / AUROC / Brier。
3. 若 A/B 在 AUROC 或校准（Brier）上 ≥ 现扣分制：在 `src/engine/` 新增纯 JS 评分器（sigmoid + 权重常量），理由面板显示每条特征 log-odds 贡献（命中清单形态不变），阈值/模糊带/二审加权融合原样复用；保留「现扣分制」为可回退开关。
4. 上线前在知乎现网抓取少量样本做域外校验，避免 C-ReD 文体与现网口语的分布差。

一句话结论：**把正则命中升级为统计校准打分（A/B）在纯 JS 客户端完全可行且数据现成；困惑度类（C）只适合留在云端二审侧，不值得为它改客户端架构。**

## References

- GPTZero 官方：P/B 原理与弃用声明 — https://gptzero.me/news/perplexity-and-burstiness-what-is-it/ ；支持文档（阈值语义）— https://support.gptzero.me/articles/9585228410-how-do-i-interpret-burstiness-or-perplexity ；技术报告 — https://arxiv.org/abs/2602.13042 ；多语言声明（中文需语言感知管道）— https://gptzero.me/news/what-is-the-best-ai-detector-for-multi-language-detection/
- Gehrmann, Strobelt & Rush (2019) GLTR — https://arxiv.org/abs/1906.04043
- Mitchell et al. (2023) DetectGPT — https://arxiv.org/abs/2301.11305
- Bao et al. (2023) Fast-DetectGPT — https://arxiv.org/abs/2310.05130
- Hans et al. (2024) Binoculars — https://arxiv.org/abs/2401.12070
- Guo et al. (2023) HC3（含中文 + 逻辑回归 on GLTR 特征）— https://arxiv.org/abs/2301.07597
- Wang et al. (2023) M4（多语含中文）— https://arxiv.org/abs/2305.14902
- He et al. (2023) MGTBench — https://arxiv.org/abs/2303.14822
- Wang et al. (2024) LLM-Detector（中文）— https://arxiv.org/abs/2402.01158
- Qing et al. (2026) C-ReD（中文基准，知乎 KOL 问答）— https://arxiv.org/abs/2604.11796 ；数据集 — https://github.com/HeraldofLight/C-ReD ；解读 — https://papernotes.org/ACL2026/aigc_detection/c-red_a_comprehensive_chinese_benchmark_for_ai-generated_text_detection_derived_/
- Wang et al. (2025) EnsemJudge（NLPCC2025 中文第一）— https://arxiv.org/abs/2603.27949
- SemEval-2024 Task 8（多语赛道含中文）— https://arxiv.org/abs/2404.14183 ；KInIT 提交（统计指标 Entropy/Rank/Binoculars 多语表现）— https://arxiv.org/abs/2402.13671
- Lavergne, Urvoy & Yvon (2008) n-gram 相对熵（PAN'08）— https://ceur-ws.org/Vol-377/
- Yang et al. (2023) DNA-GPT（n-gram 发散度）— https://arxiv.org/abs/2305.17359
- Jawahar et al. (2020) 综述 — https://arxiv.org/abs/2011.01314
- UNBC (2024) 朴素贝叶斯词对概率判别 — https://unbc.arcabc.ca/_flysystem/repo-bin/2024-11/unbc_59574.pdf
- 中文专项：AIMS 2025 中文论文（句长/标点特征）— https://www.aimspress.com/article/doi/10.3934/bdia.2025016 ；中文 AI 味特征（结构类）— https://www.cnblogs.com/jiangaigc/articles/22684257 ；中文 webnovel 判别表 — https://github.com/tance-mang/chinese-webnovel-skills/blob/main/references/ai-detector.md ；文学/古风误报 — https://www.cssn.cn/skgz/bwyc/202506/t20250610_5878364.shtml
- 校准指标：Guo et al. (2017) On Calibration of Modern Neural Networks — https://arxiv.org/abs/1706.04599
- 本仓库：ADR-0001（人类置信度语义）— docs/adr/0001-verdict-score-human-confidence.md ；ADR-0002（两级引擎、本地模型排除）— docs/adr/0002-two-tier-engine-rules-then-cloud.md
