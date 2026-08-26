# 01 — 规则引擎（初审）

Type: task
Status: resolved

## Answer

已交付：`src/engine/traces.js`（16 类 AI 创作痕迹，扣分权重与命中上限）+ `src/engine/rules.js`（评分 100 起扣、下限 0，等级映射）。冒烟测试：AI 味浓文本 39 分（疑似 AI）、人工口语 92、文学古风 100、单独"最后"不误报。

实现扣分制规则引擎：命中 AI 创作痕迹即从 100 分扣减，输出规则分 + 命中清单（每条痕迹含 id、名称、扣分值），总分下限 0。痕迹清单基于 `research/ai-detection-prompts-facts.md` 的中文 AI 味特征。

## Comments

- 交付：`src/engine/traces.js`（痕迹定义）、`src/engine/rules.js`（评分函数）
