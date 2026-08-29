# 08 — 零权重特征短路（推理侧 test() 跳过）

Type: refactor
Status: done
Priority: P3

**发现途径：** 一审优化空间审查。校准模式 4 个置零噪声特征（元评论/励志结尾/成语堆砌/死隐喻）在 `scoreCalibrated` 循环中仍跑 `trace.test()` 正则，命中后因 `contribution === 0` 才被丢弃——正则匹配属纯浪费。

## 根因

- `rules.js:scoreCalibrated` 循环逐条调用 `countHits(trace, text)` → 触发 `trace.test()` 全文正则；
- 4 个置零特征的 `W.weights[id] === 0`，旧逻辑在算出 `contribution === 0` 后 `continue`，但 `test()` 已执行；
- 21 条特征里 4 条占 ~19%，纯词法正则在小窗口上成本虽低，但属可消除的恒定开销，且代码意图更清晰（零权重 = 完全不参与）。

## 修复

`src/engine/rules.js` `scoreCalibrated` 循环头：先取 `w = W.weights[trace.id] || 0`，`w === 0` 即 `continue`，跳过 `countHits` / `test()`。

```js
for (const trace of builtin) {
  const w = W.weights[trace.id] || 0;
  if (w === 0) continue; // 置零的噪声特征跳过 test()（推理侧减负，不影响 eval 流水线）
  const count = countHits(trace, text);
  if (count === 0) continue;
  const contribution = count * w;
  hits.push({ id: trace.id, name: trace.name, count, contribution });
  z += contribution;
}
```

注：eval 流水线（`eval/features.js`）特征提取走 `t.test(text)` 直计命中数向量，不经 `scoreCalibrated`，故拟合/评估语义不变。

## 验收

- [x] `node --check src/engine/rules.js` 通过
- [x] 实证：命中零权重特征（元评论"让我们来探讨"）+ 非零特征（开场套话/商务黑话）的回答 → 零权重特征不在 hits，分数由非零特征贡献，行为与改前等价

## 交付记录（2026-08-29）

- 改 `src/engine/rules.js` 一处循环；零风险（test() 纯正则无副作用，hits 输出等价）
