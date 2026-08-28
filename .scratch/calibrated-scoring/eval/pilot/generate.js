#!/usr/bin/env node
/**
 * 用 deepseek-v4-flash 对知乎问题生成回答（A1 pilot 300 + A2 全量 2956 共用）
 *  - 任务源：questions-full.json（2956 = pilot 300 原序 + 新增唯一标题 + 二刷补齐）
 *            不存在时回退 questions.json（pilot 300）
 *  - 长度分层：buckets.json（可选）按人类长度分布 short 12% / mid 25% / long 63%，
 *              prompt 目标字数随桶走（100-200 / 200-400 / 400-700），避免"长文本=AI"长度伪信号
 *  - 风格：4 种轮换（direct / colloquial / professional / story）——贴近真实 v4-flash 输出分布
 *  - API：官方 https://api.deepseek.com/v1，模型 deepseek-v4-flash，
 *         key 从环境变量 DEEPSEEK_API_KEY 读取（不落盘、不进库）
 *  - 并发 argv[2]（默认 4）+ 失败重试 3 次（指数退避）+ 断点续跑（answers.jsonl 已有 qid 跳过，
 *    pilot 300 条原样保留，qid 与 questions-full.json 前 300 一致）
 * 输出：answers.jsonl  { qid, question, style, model, text }（追加写入）
 * 用法：DEEPSEEK_API_KEY=sk-... node generate.js [并发数]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) {
  console.error('缺少 DEEPSEEK_API_KEY 环境变量');
  process.exit(1);
}

const BASE = 'https://api.deepseek.com/v1';
const MODEL = 'deepseek-v4-flash';
const CONCURRENCY = Number(process.argv[2]) || 4;
const MAX_ATTEMPTS = 3;

// 全量任务清单优先；pilot 场景回退 questions.json
const TASK_FILE = fs.existsSync(path.join(__dirname, 'questions-full.json'))
  ? 'questions-full.json'
  : 'questions.json';
const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, TASK_FILE), 'utf8'));

// 长度分层桶（可选）：桶序与 qid 对齐
const BUCKETS = fs.existsSync(path.join(__dirname, 'buckets.json'))
  ? JSON.parse(fs.readFileSync(path.join(__dirname, 'buckets.json'), 'utf8'))
  : null;
const BUCKET_TARGET = { short: '100-200 字', mid: '200-400 字', long: '400-700 字' };

const OUT = path.join(__dirname, 'answers.jsonl');

const STYLES = [
  {
    id: 'direct',
    system:
      '你是知乎用户，正在回答一个问题。直接回答问题本身，观点明确，不要任何开场白、套话、自问自答或励志总结。',
  },
  {
    id: 'colloquial',
    system:
      '你是知乎用户，正在回答一个问题。用口语化、自然的知乎风格回答，像真人随手写的，可以有语气词和个人观点，不要书面腔、不要结构化模板。',
  },
  {
    id: 'professional',
    system:
      '你是某个领域的专业人士，正在知乎上回答一个问题。从专业角度给出有条理的分析，逻辑清楚，但不要用“首先其次综上所述”这类模板腔。',
  },
  {
    id: 'story',
    system:
      '你是知乎用户，正在回答一个问题。以第一人称讲述相关经历或见闻来回应，像在分享真实故事，细节具体，不要升华成鸡汤或总结。',
  },
];

// 断点续跑：读已完成的 qid（pilot 300 条原样跳过）
const done = new Set();
if (fs.existsSync(OUT)) {
  for (const line of fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean)) {
    try {
      done.add(JSON.parse(line).qid);
    } catch {}
  }
}

async function callOne(question, style, target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const resp = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: style.system },
          {
            role: 'user',
            content: `问题：${question}\n\n请用${target}回答。只输出回答正文，不要任何其他内容。`,
          },
        ],
        // 关闭思考模式（v4-flash 默认思考，thinking 会吃光 max_tokens 导致 content 为空）；
        // 扩展二审已实测此参数格式（constants.js extraParams）。关闭后 temperature 才生效。
        thinking: { type: 'disabled' },
        temperature: 0.8,
        max_tokens: 1600,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${err.slice(0, 160)}`);
    }
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('empty content');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const tasks = QUESTIONS.map((q, i) => ({
    qid: i,
    question: q,
    style: STYLES[i % STYLES.length],
    target: BUCKETS ? BUCKET_TARGET[BUCKETS[i]] || '100-500 字' : '100-500 字',
  })).filter((t) => !done.has(t.qid));
  const bucketCount = BUCKETS
    ? { short: tasks.filter((t) => t.target === BUCKET_TARGET.short).length,
        mid: tasks.filter((t) => t.target === BUCKET_TARGET.mid).length,
        long: tasks.filter((t) => t.target === BUCKET_TARGET.long).length }
    : null;
  console.log(
    `taskFile=${TASK_FILE} total=${QUESTIONS.length} done=${done.size} remaining=${tasks.length} concurrency=${CONCURRENCY} model=${MODEL}` +
      (bucketCount ? ` buckets=${JSON.stringify(bucketCount)}` : '')
  );
  if (tasks.length === 0) {
    console.log('全部已完成，无剩余任务');
    return;
  }

  const out = fs.createWriteStream(OUT, { flags: 'a' });
  let ok = 0;
  let fail = 0;
  const queue = [...tasks];

  async function worker() {
    while (queue.length) {
      const t = queue.shift();
      let text = null;
      for (let a = 0; a < MAX_ATTEMPTS && !text; a++) {
        try {
          text = await callOne(t.question, t.style, t.target);
        } catch (e) {
          console.error(`qid=${t.qid} 尝试${a + 1}/3 失败: ${e.message}`);
          if (a < MAX_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 1500 * (a + 1)));
        }
      }
      if (text) {
        out.write(JSON.stringify({ qid: t.qid, question: t.question, style: t.style.id, model: MODEL, text }) + '\n');
        ok++;
      } else {
        fail++;
      }
      if ((ok + fail) % 50 === 0) console.log(`progress: ok=${ok} fail=${fail} (${ok + fail}/${tasks.length})`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  out.end();
  await new Promise((r) => out.on('finish', r));
  console.log(`生成完成: ok=${ok} fail=${fail} -> ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});