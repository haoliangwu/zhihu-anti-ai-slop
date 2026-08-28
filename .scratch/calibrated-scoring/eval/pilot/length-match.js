#!/usr/bin/env node
/**
 * 长度匹配分析：排除"长度伪信号"后，flash vs 人类 的判别力还剩多少
 *
 * 背景（冒烟测试实证）：A2 flash 平均 ~660 字（long bucket 平均 837），旧 C-ReD AI 平均 ~130 字
 * （提示词限定字数），人类中位 444 字——三维长度错位。冒号/破折号等特征计数随长度线性增长，
 * θ 扫描里 flash 判别提升可能部分来自长度而非写作特征。
 *
 * 做法：把三群体都截到同一长度区间 [lo, hi]（默认 300–700 字，人类 p25–p75 重叠区），
 * 在长度匹配的样本上重算：
 *   1. 现有权重打分分布（flash vs 人类）——长度匹配后 flash 还像不像人类
 *   2. 逐特征命中率（flash vs 人类，长度匹配）——破折号/冒号等信号在长度匹配后是否仍在
 *   3. 按长度桶的 flash 分数趋势——验证"长=AI"伪信号是否存在
 *
 * 用法：node length-match.js [lo] [hi]（默认 300 700）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../../..');
require(path.join(ROOT, 'src/shared/constants.js'));
require(path.join(ROOT, 'src/engine/traces.js'));
require(path.join(ROOT, 'src/engine/calibrated-weights.js'));
require(path.join(ROOT, 'src/engine/rules.js'));
const ZD = globalThis.ZhihuDetector;

const LO = Number(process.argv[2]) || 300;
const HI = Number(process.argv[3]) || 700;

function loadJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function cleanText(t) {
  return t
    .replace(/\*\*/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function inRange(t) {
  const len = cleanText(t).length;
  return len >= LO && len <= HI;
}

function scoreDist(texts) {
  const scores = texts.map((t) => ZD.engine.score(cleanText(t)).score);
  const dist = { normal: 0, suspect: 0, confirm: 0, total: scores.length, avg: 0, median: 0, min: 100, max: 0 };
  for (const s of scores) {
    if (s > 50) dist.normal++;
    else if (s > 30) dist.suspect++;
    else dist.confirm++;
    dist.avg += s;
    dist.min = Math.min(dist.min, s);
    dist.max = Math.max(dist.max, s);
  }
  dist.avg = +(dist.avg / scores.length).toFixed(1);
  const sorted = [...scores].sort((a, b) => a - b);
  dist.median = sorted[Math.floor(sorted.length / 2)];
  dist.normalPct = +(dist.normal / scores.length * 100).toFixed(1);
  dist.confirmPct = +(dist.confirm / scores.length * 100).toFixed(1);
  return dist;
}

function hitRates(texts) {
  const n = texts.length;
  const rates = ZD.traces.map(() => 0);
  for (const t of texts) {
    const c = cleanText(t);
    ZD.traces.forEach((tr, i) => {
      if (tr.test(c) > 0) rates[i]++;
    });
  }
  return rates.map((v) => +(v / n).toFixed(3));
}

function main() {
  const answers = loadJsonl(path.join(__dirname, 'answers.jsonl'));
  const ds = loadJsonl(path.join(__dirname, '../dataset.jsonl'));
  const humans = ds.filter((r) => r.label === 1).map((r) => r.text);
  const oldAi = ds.filter((r) => r.label === 0).map((r) => r.text);
  const flash = answers.map((a) => a.text);

  // 各群体自身长度分布
  const lenStat = (texts) => {
    const lens = texts.map((t) => t.length).sort((a, b) => a - b);
    return `n=${lens.length} p25=${lens[Math.floor(lens.length * 0.25)]} p50=${lens[Math.floor(lens.length * 0.5)]} p75=${lens[Math.floor(lens.length * 0.75)]}`;
  };
  console.log('长度分布:');
  console.log('  人类        :', lenStat(humans));
  console.log('  旧 AI       :', lenStat(oldAi));
  console.log('  v4-flash    :', lenStat(flash));

  const hIn = humans.filter(inRange);
  const fIn = flash.filter(inRange);
  const oIn = oldAi.filter(inRange);
  console.log(`\n长度匹配区间 [${LO}, ${HI}] 字: 人类 ${hIn.length} / 旧AI ${oIn.length} / flash ${fIn.length}`);

  // 1) 现有权重打分分布（长度匹配后）
  console.log('\n【1】现有权重打分分布（长度匹配后）');
  console.log('群体'.padEnd(12) + 'n'.padEnd(6) + '正常%'.padEnd(8) + '确定AI%'.padEnd(9) + '平均分'.padEnd(8) + '中位');
  for (const [label, ts] of [
    ['人类', hIn],
    ['旧AI', oIn],
    ['flash', fIn],
  ]) {
    if (ts.length === 0) continue;
    const d = scoreDist(ts);
    console.log(
      label.padEnd(12) +
        String(ts.length).padEnd(6) +
        d.normalPct + '%'.padEnd(7) +
        d.confirmPct + '%'.padEnd(8) +
        String(d.avg).padEnd(8) +
        d.median
    );
  }

  // 2) 逐特征命中率（长度匹配后 flash vs 人类 vs 旧AI）
  if (fIn.length && hIn.length) {
    console.log('\n【2】逐特征命中率（长度匹配后）');
    console.log('特征'.padEnd(20) + '人类'.padEnd(8) + '旧AI'.padEnd(8) + 'flash'.padEnd(10));
    const rh = hitRates(hIn);
    const ro = hitRates(oIn);
    const rf = hitRates(fIn);
    ZD.traces.forEach((t, i) => {
      console.log(t.id.padEnd(20) + String(rh[i]).padEnd(8) + String(ro[i]).padEnd(8) + String(rf[i]));
    });
    // 判别力摘要：长度匹配后 flash 特征向量与谁更接近（欧氏距离）
    const distToHuman = Math.sqrt(rf.reduce((s, v, i) => s + (v - rh[i]) ** 2, 0));
    const distToOldAi = Math.sqrt(rf.reduce((s, v, i) => s + (v - ro[i]) ** 2, 0));
    console.log(
      `\nflash 特征向量距离 → 人类 ${distToHuman.toFixed(3)} / 旧AI ${distToOldAi.toFixed(3)}（更小=更像谁）`
    );
    console.log(
      distToHuman < distToOldAi
        ? '→ 长度匹配后 flash 仍更接近人类（判别只能靠少数独有特征）'
        : '→ 长度匹配后 flash 更接近旧 AI（特征层面可判别）'
    );
  }

  // 3) flash 分数按长度桶趋势（验证"长=AI"伪信号）
  if (flash.length >= 30) {
    console.log('\n【3】flash 分数按长度桶（验证长度伪信号）');
    const buckets = [
      ['<300', (t) => cleanText(t).length < 300],
      ['300-500', (t) => { const l = cleanText(t).length; return l >= 300 && l < 500; }],
      ['500-700', (t) => { const l = cleanText(t).length; return l >= 500 && l < 700; }],
      ['700-900', (t) => { const l = cleanText(t).length; return l >= 700 && l < 900; }],
      ['>=900', (t) => cleanText(t).length >= 900],
    ];
    for (const [label, pred] of buckets) {
      const ts = flash.filter(pred);
      if (ts.length === 0) continue;
      const d = scoreDist(ts);
      console.log(
        label.padEnd(8) +
          'n=' + String(ts.length).padEnd(5) +
          '平均=' + String(d.avg).padEnd(6) +
          '正常=' + d.normalPct + '% 确定AI=' + d.confirmPct + '%'
      );
    }
  }
}

main();