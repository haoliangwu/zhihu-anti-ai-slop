#!/usr/bin/env node
/**
 * 特征提取（单一事实源）：直接加载扩展自身的 constants.js + traces.js，
 * 对每条样本计算与内容脚本完全一致的命中数向量（cap 前）与现扣分制基线分。
 * 输出 features.jsonl：{ label, x: number[21], baseline: number }
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '../../..');
require(path.join(ROOT, 'src/shared/constants.js'));
require(path.join(ROOT, 'src/engine/traces.js'));
const ZD = globalThis.ZhihuDetector;

const IN = path.join(__dirname, 'dataset.jsonl');
const OUT = path.join(__dirname, 'features.jsonl');

/** 与 src/engine/rules.js score() 相同的加性扣分逻辑（基线） */
function baselineScore(text) {
  let total = 0;
  for (const trace of ZD.traces) {
    const count = trace.test(text);
    if (count > 0) total += Math.min(count, trace.cap) * trace.weight;
  }
  return Math.max(0, 100 - total);
}

async function main() {
  const rl = readline.createInterface({ input: fs.createReadStream(IN), crlfDelay: Infinity });
  const out = fs.createWriteStream(OUT);
  let n = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const { text, label } = JSON.parse(line);
    const x = ZD.traces.map((t) => t.test(text)); // cap 前命中数
    out.write(JSON.stringify({ label, x, baseline: baselineScore(text) }) + '\n');
    n++;
  }
  out.end();
  await new Promise((r) => out.on('finish', r));
  console.log(`features written: ${n} rows -> ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
