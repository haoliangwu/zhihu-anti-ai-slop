# Chrome Web Store Listing — 知乎照妖镜

> Last Updated: 2026-08-26

## Store Listing

**Extension Name** [REQUIRED]
知乎照妖镜 — 知乎 AI 答案检测

**Short Description** [REQUIRED]
在知乎问题页为每条回答标记"人类置信度"，一眼识别疑似 AI 生成内容，支持查看判定理由与手动覆盖。

**Detailed Description** [REQUIRED]
在知乎问题页为每条回答给出"人类置信度"判定（0–100，100 = 几乎确定人工），并用角标标记判定等级：红色确定 AI、橙色疑似 AI、绿色正常。

主要功能：
- 自动分析页面已加载的回答，滚动加载的新回答自动补标
- 点击角标查看判定理由：本地规则命中的 AI 创作痕迹清单
- 模糊判定的回答可请求云端 LLM 复核（默认 DeepSeek，需在设置中配置 API Key，仅在模糊带内发送正文）
- 对判定结果不满意？一键覆盖为"认为人工 / 认为 AI"，记录保存在本机，刷新页面仍生效
- 设置页可调阈值、模糊带、分析字数上限等

使用方法：
1. 安装扩展，打开任意知乎问题页
2. 每条回答上方自动出现判定角标
3. 点击角标展开理由面板，可手动覆盖判定
4. 在设置中配置 API Key 后，模糊判定启用云端复核

隐私说明：
- 默认仅本地规则分析，不发送任何内容
- 仅在启用云端复核且判定落入模糊带时，将回答正文发送至你配置的 LLM 服务商
- API Key 仅保存在本机浏览器，不同步、不上传

**Category** [REQUIRED]
Productivity

**Single Purpose** [REQUIRED]
在知乎问题页标记回答的人类置信度，帮助识别疑似 AI 生成内容。

**Primary Language** [REQUIRED]
中文（简体）

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | icons/icon-128.png |
| Screenshot 1 [REQUIRED] | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 2 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 3 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | |
| Small Promo Tile [RECOMMENDED] | 440×280 | ⬜ Not created | |

### Screenshot Notes
- Screenshot 1：问题页多条回答带角标（红/橙/绿）的整体效果
- Screenshot 2：展开的理由面板（痕迹清单 + 覆盖按钮）
- Screenshot 3：设置页（阈值 / API 配置）

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| storage | permissions | 保存用户设置（阈值/API 配置）、判定覆盖记录与二审缓存到本机 |
| https://*.zhihu.com/* | host_permissions | 在知乎问题页注入内容脚本，读取回答正文并在页面上渲染判定角标 |
| https://api.deepseek.com/* | host_permissions | 云端二审（默认 DeepSeek API）发送模糊带内回答正文，用于 LLM 复核判定 |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** Yes

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Website content | Yes（回答正文，仅模糊带内） | Yes（发送至用户配置的 LLM 服务商） | 云端二审判定 | No（用户自选服务商） |
| Authentication info | Yes（API Key） | No（仅存本机） | 调用用户配置的 LLM 服务 | No |

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL** [REQUIRED]
<!-- 待提供：需托管公开 URL（GitHub Pages 或自建页面），内容覆盖"仅在模糊带内发送正文、Key 仅存本机、不收集个人身份信息"。 -->

## Distribution

**Visibility**: Public
**Regions**: All regions

## Developer Info

**Publisher Name** [REQUIRED]
<!-- 待填 -->

**Contact Email** [REQUIRED]
<!-- 待填 -->

**Support URL / Email** [RECOMMENDED]
<!-- 待填：GitHub Issues 或邮箱 -->

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 0.1.0 | 2026-08-26 | MVP：规则初审 + 角标标记 + 覆盖 + 云端二审（DeepSeek）+ 选项页 | Draft |

## Review Notes

### Known Issues / Limitations
- 自定义 LLM API 域名需手动在 manifest 增加 host_permissions（MVP 未实现动态申请）
- 规则引擎对文学性/古风文本存在误报风险，阈值可调
- 二审仅覆盖模糊带（默认 20–80），且有每页调用上限与缓存

### Rejection History
<!-- 暂无 -->
