# 03 — 云端二审 + service worker

Type: task
Status: ready-for-agent

Service worker 接收内容脚本的二审请求：查缓存（`chrome.storage.local`，按回答 ID，上限 500 LRU）→ 调用 OpenAI 兼容 `/chat/completions`（默认 DeepSeek，`response_format: json_object`）→ 归一化为人类置信度 → 写缓存。限流：每页 ≤20 次（`chrome.storage.session` 按 tab 计数）、并发 ≤2、单次 30s 超时；任何失败降级返回空。

## Comments

- 交付：`src/background/service-worker.js`、`src/cloud/second-opinion.js`
