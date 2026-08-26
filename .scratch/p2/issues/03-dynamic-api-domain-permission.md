# 03 — 自定义 API 域名动态权限

Type: task
Status: ready-for-agent

允许用户配置任意 https 域名作为二审 API 地址：manifest 增加 optional_host_permissions；选项页保存新 base URL 时经 SW 触发 chrome.permissions.request（必须在用户手势同一同步轮次内调用，无 await 前置——chrome-extensions skill 规则）。拒绝则提示并回退本地规则。同步更新 CHROMEWEBSTORE.md 权限说明。

## Comments

- 参考 `.scratch/p2/spec.md` §3-03
