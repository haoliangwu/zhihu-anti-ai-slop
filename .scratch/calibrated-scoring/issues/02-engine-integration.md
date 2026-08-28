# 02 — 引擎集成（纯 JS sigmoid 评分器、log-odds 理由面板、回退开关）

Type: task
Status: done
Priority: P1

**Blocked by:** 01（01 通过门槛后放行，已交付）

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

## 交付记录（2026-08）

- **引擎**：`src/engine/rules.js` 新增校准评分器 `scoreCalibrated`（σ(Σw·x+b)，内置痕迹按学习权重贡献 logit，自定义正则按原 deduct 叠加钳制）；`USE_CALIBRATED` 代码级回退开关；`scoreDeduct` 保留原逻辑。`src/engine/calibrated-weights.js` v2：4 个噪声特征置零（元评论/励志结尾/成语堆砌/死隐喻）
- **阈值随模型数据落地（用户确认）**：constants.js DEFAULTS → 确定≤30 / 疑似≤50 / 模糊带 [30,50]；storage.js `getSettings` 增加 settingsVersion 迁移——仅当存储阈值仍是旧默认（40/70/[20,80]，用户未自定义）才自动升级，尊重自定义
- **面板**：content.js `hitText`——校准模式显示带符号贡献（`冒号滥用 ×9：+2.31`，正=偏人类）+ 语义说明行；回退模式保持 `-X 分`。二审消息载荷/云端上下文（buildFirstPassContext）同步改为带符号贡献
- **顺带修复（验证中发现）**：二审模型返回 markdown 代码围栏包裹的 JSON（```json ... ```），`callApi` 严格 JSON.parse 抛错 → 二审静默失败。修复：解析前剥离围栏。另：本机测试配置的模型名 `mimo-v2.5` 在 opencode.ai 网关不存在（列表为 minimax-m2.5），已改
- **浏览器实测**：问题页 10 角标校准分（73/63/74 正常，新阈值下无一误标疑似）；面板贡献正确（含人类信号方向）；覆盖回路（认为 AI → 清除）正常；文章页 98 正常 + 贡献清单（9 冒号 +2.31 人类）；重判定强制二审全链路通（82正常二审）；控制台无扩展报错
- 门槛结论：01 通过 → 02 交付；回退开关验证：不加载权重文件时回退路径与旧行为一致
