# 09 — 破折号特征 → flash-domain 重拟合（v3）

Type: feature
Status: done
Priority: P2

**发现途径：** 一审优化审查 P2。issue 06 实证 v4-flash 唯二独有信号之一为破折号反复（flash 40% vs 人类 3.8%），但 `dash-repetition` 校准权重为 +1.123（正=人类信号），与 flash 实证方向相反。根因排查揭示旧 9 LLM 训练集已过时，词法特征集体失效。

## 根因（实证）

dash-repetition 三方命中率（`——` ≥2 次）：

| | 命中率 |
|---|---|
| human | 3.42% (101/2956) |
| 旧 9 LLM | 1.30% (340/26115) |
| flash | **45.77%** (1353/2956) |

旧 LLM 命中率(1.3%) < 人类(3.4%) → v2 拟合为**人类信号**(+1.123，符合旧数据)；flash 45.8% 反转。**单一权重无法兼顾旧 LLM 与 flash**——分布漂移，非 test 漏匹配、非权重 bug。

## 方向探索

### B 方案（dash 固定扣分）实证否决

dash 退出学习权重 + 固定扣 N（10–30）模拟：

| 扣分 | flash 正常(漏判) | 人类正常 | 旧AI 正常 |
|---|---|---|---|
| 基线 v2 | 82.2% | 88.5% | 39.9% |
| 扣30 | 52.7% | 85.9% | 39.5% |

**否决**：flash 漏判仍 52.7%（dash 仅覆盖 45.77% flash），且人类误伤 -2.6pp，需引入双轨制（内置 trace 固定扣分路径，破坏 spec 单一性）。单词法特征固定扣分性价比不足。

### flash-domain 重拟合（采用）

用户决策：国内现网主用 flash 类新模型，旧 9 LLM 差多代已过时，纯 flash 作 AI 重拟合可接受旧 LLM 泛化 tradeoff。

## 落地（v3）

**拟合**：人类 2956 + flash 2956，平衡训练，7 种子（20260828/1/42/7/123/999/5555）分层 80/20 切分，baked 权重取均值。脚本：`eval/pilot/fit-flash-only.js`。

**种子稳健性**（7 种子）：

| | humanAcc | flashAcc |
|---|---|---|
| 范围 | 88.0–90.9% | 59.1–64.0% |

8/9 关键特征稳定（sd < |mean|）；**fake-colloquial 不稳**（mean -0.34, sd 0.47，跨种子符号翻转）→ 置零，并入噪声特征集（共 5 个置零）。

**关键权重翻转**（v2 → v3）：

| 特征 | v2 | v3 | 说明 |
|---|---|---|---|
| dash-repetition | +1.123 | **-2.646** | flash AI 信号确认（根因修复） |
| opening-boilerplate | -0.564 | +2.670 | flash 上翻转 |
| biz-jargon | -0.454 | -1.586 | 增强 AI 信号 |
| fake-colloquial | +3.947 | 0 | 不稳置零 |

**三方部署分布**（v3 全量）：

| | 确定 AI | 疑似 | 正常 |
|---|---|---|---|
| 人类 | 4.6% | 6.4% | 89.0% |
| flash | 52.4% | 9.5% | 38.1% |
| 旧 9 LLM | 12.1% | 13.5% | 74.3%（泛化崩，已知 tradeoff） |

flash 漏判（正常）82.2% → 38.1%；确定 AI 6.0% → 52.4%。

## 验收

- [x] 种子稳健性：7 种子 8/9 关键特征稳定，fake-colloquial 不稳已置零
- [x] 已知误报案 `eval/case-zhihu-answer.txt`（v2 26 分确定 AI）→ v3 45 分疑似（送二审挽救）
- [x] 引擎加载验证：version 3，flash 味文本 0 分确定 AI，dash 命中负贡献 -2.65，fake-colloquial 短路无命中
- [x] `node --check` 通过
- [x] `src/engine/calibrated-weights.js` 烤进 v3，注释含决策记录与已知 tradeoff

## 已知限制

- **旧 9 LLM 泛化崩塌**（正常 74.3%）：检测器押注国内主用 flash 类新模型，旧代 AI 不再是现网主要检测目标。ADR-0005 已知限制类。
- **flash 漏判仍 38%**：词法层极限，下一台阶为方案 B 统计特征（issue 10）。

## 交付记录（2026-08-29）

- 实证脚本 `eval/pilot/fit-flash-only.js`（拟合 + 三方测试 + 跨种子稳健性）
- 烤 `src/engine/calibrated-weights.js` v3（5 置零特征，7 种子 baked 均值）
- 旧域（旧 9 LLM）泛化 tradeoff 记录待补 ADR-0005
