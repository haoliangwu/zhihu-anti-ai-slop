# 05 — 本页判定统计面板

Type: task
Status: ready-for-agent
Priority: backlog

> 用户已决定：统计面板可做但优先级很低，进入 backlog。

页面注入轻量汇总条：已判 N / 确定 AI / 疑似 AI / 跳过 计数，随分析实时更新（实现时在内容脚本 state 增加计数 Map，按回答 ID 维度累计；注：曾计划复用 `state.results`，该字段因只写不读已于 code-review 修复中删除，勿再引用）。验收：滚动加载后计数与页面实际角标一致。

## Comments

- 参考 `.scratch/p2/spec.md` §3-04
