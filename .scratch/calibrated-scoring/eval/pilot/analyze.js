#!/usr/bin/env node
/**
 * A1 试点分析：v4-flash 生成样本 vs 人类 vs 旧 9 模型
 * 回答的核心问题：
 *   1. 现有权重（C-ReD 旧 9 模型拟合的 calibrated-weights.js）会把 v4-flash 判成什么分布？
 *      —— 如果普遍高分（漏判），证实"新模型骗过旧权重"的假设
 *   2. v4-flash 的特征命中分布与人类/旧 AI 有多接近？
 *      —— 命中率矩阵：人类 vs 旧 AI vs v4-flash，逐特征对比
 *   3. v4-flash 样本在现有模型下的"人类嫌疑度"打分
 * 用法：node analyze.js [answers.jsonl 路径]
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

const ANSWERS = process.argv[2] || path.join(__dirname, 'answers.jsonl');

function loadJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** 对一批文本算平均命中率/命中数向量 */
function aggregate(texts) {
  const n = texts.length;
  const hitRate = ZD.traces.map((t) => 0);
  const avgCount = ZD.traces.map((t) => 0);
  for (const text of texts) {
    ZD.traces.forEach((t, i) => {
      const c = t.test(text);
      if (c > 0) hitRate[i]++;
      avgCount[i] += c;
    });
  }
  return {
    n,
    hitRate: hitRate.map((v) => +(v / n).toFixed(3)),
    avgCount: avgCount.map((v) => +(v / n).toFixed(3)),
  };
}

/** 用现有校准权重对一批文本打分，统计等级分布 */
function scoreDistribution(texts) {
  const scores = texts.map((t) => ZD.engine.score(t).score);
  const dist = { normal: 0, suspect: 0, confirm: 0, min: 100, max: 0, avg: 0, median: 0 };
  for (const s of scores) {
    if (s > 50) dist.normal++;
    else if (s > 30) dist.suspect++;
    else dist.confirm++;
    dist.min = Math.min(dist.min, s);
    dist.max = Math.max(dist.max, s);
    dist.avg += s;
  }
  dist.avg = +(dist.avg / scores.length).toFixed(1);
  const sorted = [...scores].sort((a, b) => a - b);
  dist.median = sorted[Math.floor(sorted.length / 2)];
  dist.n = scores.length;
  return dist;
}

function loadHumanTexts() {
  // 从 features.jsonl 重建？不——直接从 dataset.jsonl 取人类文本（label=1）
  const ds = loadJsonl(path.join(__dirname, '../dataset.jsonl'));
  return ds.filter((r) => r.label === 1).map((r) => r.text);
}

function loadOldAiTexts() {
  const ds = loadJsonl(path.join(__dirname, '../dataset.jsonl'));
  return ds.filter((r) => r.label === 0).map((r) => r.text);
}

/** 清洗 LLM 输出常见的 markdown 语法标记（与 pilot-fit.js 一致：
 *  扩展运行时输入是知乎 DOM textContent，不含这些 ASCII 标记） */
function cleanText(t) {
  return t
    .replace(/\*\*/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function main() {
  const answers = loadJsonl(ANSWERS);
  if (answers.length === 0) {
    console.error('answers.jsonl 为空或不存在，先运行 generate.js');
    process.exit(1);
  }

  const flashTexts = answers.map((a) => cleanText(a.text));
  // 采同样量级的人类样本（与 flash 数一致，保证可比）——从中段均匀采样
  const humanAll = loadHumanTexts();
  const step = Math.floor(humanAll.length / flashTexts.length) || 1;
  const humanTexts = [];
  for (let i = step; i < humanAll.length && humanTexts.length < flashTexts.length; i += step) {
    humanTexts.push(humanAll[i]);
  }
  const oldAiTexts = loadOldAiTexts().slice(0, Math.min(8000, flashTexts.length * 8));

  console.log('========================================');
  console.log('样本量: v4-flash=' + flashTexts.length + ' 人类(采样)=' + humanTexts.length + ' 旧9模型(采样)=' + oldAiTexts.length);
  console.log('========================================\n');

  console.log('【1】现有权重（C-ReD 旧9模型拟合）打分分布');
  console.log('----------------------------------------');
  const humanScore = scoreDistribution(humanTexts);
  const flashScore = scoreDistribution(flashTexts);
  const oldAiScore = scoreDistribution(oldAiTexts);
  for (const [label, d] of [
    ['人类(真实)', humanScore],
    ['v4-flash(生成)', flashScore],
    ['旧9模型(生成)', oldAiScore],
  ]) {
    console.log(
      `${label.padEnd(14)}: n=${String(d.n).padEnd(5)} 正常>50:${String(d.normal).padEnd(4)} 疑似31-50:${String(d.suspect).padEnd(4)} 确定≤30:${String(d.confirm).padEnd(4)} 平均分:${d.avg} 中位:${d.median} 范围:[${d.min},${d.max}]`
    );
  }
  const flashMiss = flashScore.confirm; // 现有权重判"确定 AI"的 v4-flash 占比
  const flashNormal = flashScore.normal;
  console.log(
    `\n>> 关键：v4-flash 被现有权重判「确定 AI」=${
      flashScore.confirm
    }/${flashScore.n} (${((flashScore.confirm / flashScore.n) * 100).toFixed(1)}%)，判「正常」=${(
      (flashScore.normal / flashScore.n) * 100
    ).toFixed(1)}%`
  );

  console.log('\n【2】逐特征命中率对比（判读：flash 接近人类=漏判风险高，接近旧AI=权重有效）');
  console.log('----------------------------------------');
  const aggFlash = aggregate(flashTexts);
  const aggHuman = aggregate(humanTexts);
  const aggOld = aggregate(oldAiTexts);
  console.log('特征'.padEnd(20) + '人类'.padEnd(8) + '旧AI'.padEnd(8) + 'v4flash'.padEnd(10) + '方向');
  ZD.traces.forEach((t, i) => {
    const h = aggHuman.hitRate[i];
    const a = aggOld.hitRate[i];
    const f = aggFlash.hitRate[i];
    const dir = f > Math.max(h, a) + 0.03 ? 'FLASH←独特' : f <= Math.min(h, a) + 0.02 ? 'flash→人类侧' : '介于其间';
    console.log(t.id.padEnd(20) + String(h).padEnd(8) + String(a).padEnd(8) + String(f).padEnd(10) + dir);
  });

  console.log('\n【3】按风格的 v4-flash 分数分布（看 prompt 风格是否造成差异）');
  console.log('----------------------------------------');
  const byStyle = {};
  for (const a of answers) {
    (byStyle[a.style] = byStyle[a.style] || []).push(a.text);
  }
  for (const [style, texts] of Object.entries(byStyle)) {
    const d = scoreDistribution(texts);
    console.log(
      `${style.padEnd(12)}: n=${String(d.n).padEnd(3)} 正常:${String(d.normal).padEnd(4)} 疑似:${String(d.suspect).padEnd(4)} 确定:${String(
        d.confirm
      ).padEnd(4)} 平均:${d.avg}`
    );
  }
}

main();