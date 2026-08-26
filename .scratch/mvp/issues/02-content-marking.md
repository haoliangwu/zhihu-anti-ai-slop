# 02 — 内容脚本：提取 + 角标 + 覆盖

Type: task
Status: resolved

## Answer

已交付：`src/content/extract.js`（回答卡片/回答 ID/正文提取，选择器单点维护）、`src/content/content.js`（MutationObserver 增量分析、rAF 分批渲染、角标/理由面板/覆盖、storage 变更联动）、`src/content/content.css`（zys- 前缀样式）。

内容脚本在问题页发现回答卡片，提取输入窗口（`.RichContent-inner`，≤maxChars，跳过标题/图/引用开头），运行规则初审，渲染角标；点击展开理由面板（命中清单 + 二审依据），支持设置/清除覆盖（`chrome.storage.local` 键 `overrides`，按回答 ID）。滚动通过 MutationObserver 增量分析，DOM 写入按批 + rAF 节流。

## Comments

- 交付：`src/content/extract.js`、`src/content/content.js`、`src/content/content.css`
