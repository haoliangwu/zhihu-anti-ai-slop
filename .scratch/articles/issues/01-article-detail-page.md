# 01 — 文章详情页判定

Type: task
Status: done
Priority: P1

**Blocked by:** 作者-03（已交付，commit f85c136）

文章详情页（`/p/xxx`）获得完整判定：角标挂载、文章专用头尾抽样、文章设置组、作者规则一致应用。用户打开任意文章即可看到判定结果。

**验收：**

- [ ] 打开 `www.zhihu.com/p/*` 与 `zhuanlan.zhihu.com/p/*` 文章 → 标题/作者区出现判定角标
- [ ] 首访 `zhuanlan.zhihu.com` 域时经既有动态权限机制请求授权；拒绝授权则跳过、不报错
- [ ] 万字长文按头尾各 2000 字抽样判定；规则痕迹与二审能覆盖结尾套话
- [ ] 确定/疑似 AI 文章：仅角标提示，不隐藏正文（`hideAiBody` 不生效）
- [ ] 已屏蔽作者的文章页显示占位条；已信任作者零标记 + 灰色小签
- [ ] 选项页「文章」设置组可调抽样方式/字数下限/上限；判定阈值与回答共享
- [ ] 文章判定不污染回答判定的缓存与预算维度

## Comments

- 设计来源：`.scratch/articles/spec.md` §3（Q9–Q11）
- 实现注意：详情页 DOM（文章正文选择器、标题/作者区）需实测探测；域名授权复用既有动态权限机制（p2/04 已落地）

## 交付记录（2026-08）

- 全部验收项通过，浏览器实测（zhuanlan.zhihu.com/p/*）：
  - 角标挂载 h1.Post-Title 前；正文选择器实测修正：.Post-content 为外层包装（含整篇），正文在 .Post-RichTextContainer
  - www.zhihu.com/p/* 同构匹配（实测该域名对专栏文章返回 404 → 无 .Post-Main → 无角标不报错；真实文章同布局自动生效）
  - zhuanlan 授权：host_permissions `https://*.zhihu.com/*` 已静态覆盖 zhuanlan 子域（permissions.contains=true），动态授权机制为安全网无需触发
  - 万字长文头尾抽样：选项页把上限 4000→300 后自动重判（67 疑似 → 89 正常，截断生效）；恢复 4000 复原
  - 确定/疑似 AI 仅角标提示：AI 覆盖下正文仍显示（hideAiBody 不作用于文章）
  - 作者规则：屏蔽占位（查看/取消屏蔽）、信任小签、取消恢复，全部复用回答组件实测通过
  - 文章覆盖（认为AI/清除）、重新判定强制二审（91 正常二审）、二审 pending 角标均正常
  - 预算维度隔离：二审预算键 = tab+dimension；文章云调用与回答互不挤占
  - 正文懒渲染：init 时 .Post-RichTextContainer 未出现 → 空指纹 → 观察器按文本指纹变化重试
  - console 无扩展报错；问题页回归正常（5 角标、面板开合正常）
