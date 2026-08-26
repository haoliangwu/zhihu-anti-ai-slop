# 01 — 规则引擎（初审）

Type: task
Status: ready-for-agent

实现扣分制规则引擎：命中 AI 创作痕迹即从 100 分扣减，输出规则分 + 命中清单（每条痕迹含 id、名称、扣分值），总分下限 0。痕迹清单基于 `research/ai-detection-prompts-facts.md` 的中文 AI 味特征。

## Comments

- 交付：`src/engine/traces.js`（痕迹定义）、`src/engine/rules.js`（评分函数）
