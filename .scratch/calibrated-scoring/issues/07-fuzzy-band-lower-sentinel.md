# 07 — 模糊带下界下探 30→15（确定区左段防误报）

Type: bug
Status: done
Priority: P1

**发现途径：** 票 02 校准引擎上线后，实测 C-ReD 系手写回答得 26 分（证据充分判「确定 AI」），但人工复核该回答实为人类写作——26 分落入确定区左段（≤30）却未送二审，属校准误报且无挽救路径（边界仅覆盖疑似区 30–50）。

## 根因

1. 阈值随校准模型落地为 确定 ≤30 / 疑似 ≤50（票 02，ADR-0005），模糊带默认 [30,50] **== 疑似区**；
2. 二审只在 `ruleScore ∈ [fuzzyLow, fuzzyHigh]` 时触发（`content.js:103-104`），确定区左段 [15,29] 的分数被直接标注「确定 AI」，其中含校准误报（人类误报 3.7% 即落于此段）；
3. 旧模糊带默认 [20,80] 是加性扣分尺度时代的语义，与校准分数分布不兼容（人类中位 67、确定线 30），左段下探空间此前未利用。

## 修复

- `src/shared/constants.js`：`DEFAULTS.fuzzyLow` 30 → **15**（注释写明：下限低于确定阈值，确定区左段 15–29 分入带送二审挽救；<15 证据充分不再外发）。
- `src/shared/storage.js`：新增 **v4 设置迁移**——仅当 fuzzyLow/fuzzyHigh 仍是旧默认 30/50（用户未自定义任一）时把 fuzzyLow 下探到 15；判据用迁移后的 `settings` 值，天然覆盖 v0 旧默认（20/80）经 v2 迁移到 30/50 再下探的级联场景；尊重显式自定义。
- `src/options/options.html`：模糊带 hint 补充 15–50 语义说明。
- 文档同步：README / CONTEXT.md / ADR-0005 / CHROMEWEBSTORE（商店已知限制）四处的模糊带表述 30–50 → 15–50。

## 验收

- [x] 迁移单测 `tests/migrate-settings-test.js` 6 用例全过（v0/v2/v3 默认态 → 15；自定义 fuzzyLow=25 / fuzzyHigh=40 不迁移；fresh install → 15）——测试含路径 bug 修复（ROOT 退 4 级 → 3 级）。
- [x] `content.js:103-104` 触发条件确认使用 `settings.fuzzyLow/fuzzyHigh`，默认值变更即生效。
- [x] 26 分手写回答语料留存 `eval/case-zhihu-answer.txt`（入带即送二审的断言语料）。

## 交付记录（2026-08）

- 修改 `constants.js` + `storage.js` + `options.html`，同步四处文档；迁移测试落地并跑通。
- 与票 05 / 票 06 同期的误报诊断链路的收尾：票 05 修显示语义、票 06 证数据缺口（权重未替换）、本票把确定区左段误报送二审挽救，属误报处置的「可调阈值/二审」路径（ADR-0005 已知误报类）。