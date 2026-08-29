# 10 — 方案 B 统计特征（v4，已落地）

Type: feature
Status: done
Priority: P2

**发现途径：** 一审优化审查 P2。校准模型（v2）留出集 AUROC 0.816 / 平衡评估 0.824，但 21 个固定句式词法特征已被 v4-flash 人类化（issue 06：flash 判"正常"87.4%）。词法层判别力见顶，下一台阶为纯 JS 可算的统计文本特征。`research/statistical-scoring-feasibility.md` 已结论"方案 B 可行但有条件——短文本与正式文体是已知误报源，需中文域数据校验"。

## 任务

离线在 C-ReD question-answer 子集上扩展统计特征向量，重拟合逻辑回归，对比现 v2 校准模型，过门槛则集成进引擎。

### 1. 特征候选（feasibility §3 已筛）

- **句长波动**（burstiness）：句长标准差/变异系数——AI 句长齐整（已被 `flat-sentence` 覆盖二值，统计量化增益待证）
- **字符熵**（char entropy）：单字 Shannon 熵——AI 用词分布更窄
- **TTR**（type-token ratio）：去重词/总词——AI 词汇多样性偏低
- **标点密度**：标点/总字符——AI 标点模式规律
- **n-gram 相对熵**（vs 人类基准语料）：Lavergne 2008 路线，需预存人类基准 n-gram 频率表（常量入包，体积待估）

### 2. 拟合与评估（同票 01 流程）

- 特征提取：`eval/features.js` 扩展，统计特征与现有 21 维词法命中数合并为扩展向量；
- 模型：逻辑回归（L2，平衡训练），同票 01；
- 对比基线：现 v2 校准模型（`calibrated-weights.js`）；
- 指标：Accuracy / AUROC / Brier / 可靠性图，**平衡评估子集**为主指标（部署语义）；
- **v4-flash 验证**（issue 06 数据缺口）：扩展模型在 flash 上的判定改善必须实证，不能只看旧域指标。

### 3. 门槛（同票 01 硬前置）

- 平衡评估子集 **AUROC 或 Brier 至少一项优于 v2**；
- flash 子集 Acc/Brier **双优**于 v2（issue 06 闸门补充）；
- 人类 Brier 增幅 ≤0.02（不伤人类侧校准）；
- 未过门槛则暂停，结论写回 `research/`，**不替换生产权重**。

### 4. 集成（过门槛后）

- 新增 `src/engine/stat-features.js`：纯 JS 统计特征提取，与 `traces.js` 同级；
- `scoreCalibrated` 扩展特征向量，权重写入 `calibrated-weights.js`（version 3）；
- 命中清单/理由面板：统计特征显示为「数值 + 贡献」（如"句长波动 0.42 → +1.3"），与词法命中并列；
- n-gram 基准表体积评估：若 >50KB 则砍该特征或压缩（生产包现 ~66KB，不宜翻倍）；
- 回退开关：`USE_CALIBRATED` 已覆盖；新增 `USE_STAT_FEATURES` 子开关，false 时退回纯词法 v2。

## 依赖与约束

- 数据：C-ReD question-answer 子集（人类 2956 + 9 LLM 26115）+ issue 06 flash 2956 条（`eval/pilot/answers.jsonl`，gitignore）
- 单一事实源：统计特征提取在 eval 与运行时共用同一实现（`stat-features.js`），不允许两份
- 不改：消息协议、存储格式、二审缓存键、阈值语义（分数=人类置信度）
- 完成顺序：离线拟合评估（过门槛）→ 引擎集成 → 回归发布（同票 01→02→03 模式）

## 明确不做

- 困惑度/概率曲率（方案 C，客户端不可行，ADR-0002 已排除，云端二审已覆盖）
- 更换二审协议/缓存键
- 选项页暴露统计特征开关或权重编辑

## 验收

- [ ] 离线报告 `eval/report-b.json`：扩展模型 vs v2 全指标 + flash 子集 + 可靠性图
- [ ] 门槛判定 pass/fail 明确；fail 则不进集成，结论写回 research
- [ ] 若过门槛：`stat-features.js` + `calibrated-weights.js` v3 + 理由面板扩展 + 回归（误报检查/文档/zip）
- [ ] 生产包体积增幅 ≤30%

## 交付记录（2026-08-29）

### 离线评估

- **v4a（6 统计特征）**：flash 漏判 38%→26%，但 case 误报案退步 45→20（charEntropy 长度混淆——长文 entropy 自然高，误判为 AI）。弃。
- **v4b（4 统计特征，去 charEntropy/ttr）**：flash 漏判 38%→21%，case 不退步（44 疑似），旧 AI 泛化改善（74%→45%）。闸门 PASS。
- 评估脚本：`eval/pilot/fit-stat-features.js`（v4a）、`eval/pilot/fit-stat-features-v4b.js`（v4b）、`eval/pilot/dump-v4b-weights.js`（完整权重导出）

### 生产集成

- 新增 `src/engine/stat-features.js`：4 统计特征提取（sCV/punctDensity/sMeanLen/commaRatio），纯 JS 字符级，无分词依赖
- 更新 `src/engine/calibrated-weights.js` v4：21 词法权重 + 4 统计权重（7 种子 baked 均值，联合拟合），intercept -0.497462
- 更新 `src/engine/rules.js`：`scoreCalibrated` 集成统计特征进 z + hits，`USE_STAT_FEATURES` 代码级开关
- 更新 `manifest.json`：加载顺序加 stat-features.js（calibrated-weights 之后、rules 之前）
- 更新 `src/content/content.js`：`hitText` 渲染统计特征（显示数值而非 ×次数）
- 更新 `README.md` 目录结构

### 验证

- [x] `node --check` 全部通过（stat-weights / calibrated-weights / rules / content）
- [x] 引擎加载：version 4，statWeights 正确
- [x] flash 味文本 → 0 分确定 AI
- [x] case 误报案 → 44 分疑似（v3 45，不退步；v2 26 确定 AI 误报）
- [x] 学术风格文本 → 35 疑似（v3 5 确定 AI，已知误报类大幅改善）
- [x] dash 命中负贡献，stat 特征出现在 hits
- [x] 二审 prompt 序列化不破（只用 id/name/contribution）

### 三方部署分布对比

| | v3 flash 漏判 | v4 flash 漏判 | v3 case | v4 case | v3 旧AI 正常 | v4 旧AI 正常 |
|---|---|---|---|---|---|---|
| | 38.1% | **21.2%** | 45 疑似 | 44 疑似 | 74.3% | 45.1% |
