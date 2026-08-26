# 04 — 自定义 API 域名动态权限

Type: task
Status: resolved
Priority: P2

> 用户已确认：支持自定义 API 地址，则必须动态申请域名权限（否则配置了也调不通）。

允许用户配置任意 https 域名作为二审 API 地址：manifest 增加 optional_host_permissions；选项页保存新 base URL 时经 SW 触发 chrome.permissions.request（必须在用户手势同一同步轮次内调用，无 await 前置——chrome-extensions skill 规则）。拒绝则提示并回退本地规则。同步更新 CHROMEWEBSTORE.md 权限说明。

## Comments

- 参考 `.scratch/p2/spec.md` §3-03

## Answer

已交付：manifest 增加 `optional_host_permissions: ["https://*/*"]`；选项页保存时从 apiBaseUrl 解析主机模式（仅 https），同步发起 `chrome.permissions.request`（保持用户手势，静态已授权域名直接 resolve 不弹窗），拒绝则提示"未授权该域名，二审不可用，可在扩展详情页授权"并降级本地规则。CHROMEWEBSTORE.md 权限说明已更新。实测：DeepSeek 域名 contains=true/request 直接通过；OpenAI 域名 contains=false/request 触发权限对话框。
