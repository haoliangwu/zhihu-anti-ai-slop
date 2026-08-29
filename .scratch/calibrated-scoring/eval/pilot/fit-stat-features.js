#!/usr/bin/env node
/**
 * 票 10 — 方案 B 统计特征离线评估
 * 在 C-ReD 人类 + flash 上算字符级统计特征，与 21 词法命中数合并，
 * 逻辑回归平衡拟合，对比 v3（纯词法）。
 *
 * 统计特征（纯 JS，字符级，无分词依赖）：
 *  1. sentenceLengthCV   句长变异系数（std/mean）—— AI 句长齐整→低
 *  2. charEntropy         单字 Shannon 熵 —— AI 用词分布窄→低
 * 3. ttr                  type-token ratio（去重字符/总字符）—— AI 词汇多样性低→低
 *  4. punctDensity        标点/总字符 —— AI 标点规律
 *  5. sentenceMeanLen     平均句长
 *  6. commaRatio          逗号/标点总数 —— AI 逗号偏多
 *
 * 输出：三方部署分布（人类/flash/旧9LLM）+ AUROC/Brier + 权重
 */
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '../../../..');
require(path.join(ROOT, 'src/shared/constants.js'));
require(path.join(ROOT, 'src/engine/traces.js'));
require(path.join(ROOT, 'src/engine/calibrated-weights.js'));
const ZD = globalThis.ZhihuDetector;
const D_LEX = ZD.traces.length;     // 21 词法特征
const D_STAT = 6;                    // 统计特征数
const D = D_LEX + D_STAT;

// ---- stats ----
function rng(s){let a=s>>>0;return()=>{a|=0;a=(a+0x6d2b79f5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function shuffle(a,r){for(let i=a.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
const sig=z=>1/(1+Math.exp(-z));
function auroc(scores,labels){const n=scores.length;const idx=scores.map((_,i)=>i).sort((a,b)=>scores[a]-scores[b]);const ranks=new Array(n);let i=0;while(i<n){let j=i;while(j+1<n&&scores[idx[j+1]]===scores[idx[i]])j++;const avg=(i+j)/2+1;for(let k=i;k<=j;k++)ranks[idx[k]]=avg;i=j+1;}let posSum=0,nPos=0,nNeg=0;for(let k=0;k<n;k++){if(labels[k]===1){posSum+=ranks[k];nPos++;}else nNeg++;}if(nPos===0||nNeg===0)return NaN;return(posSum-(nPos*(nPos+1))/2)/(nPos*nNeg);}
function metrics(probs,labels){let correct=0,brier=0;for(let k=0;k<labels.length;k++){const p=probs[k];if((p>=0.5?1:0)===labels[k])correct++;brier+=(p-labels[k])**2;}return{n:labels.length,accuracy:correct/labels.length,auroc:auroc(probs,labels),brier:brier/labels.length};}
function fitLogistic(X,y,opts){const{lr=0.5,epochs=400,lambda=0.01}=opts;const n=X.length;const d=X[0].length;let w=new Array(d).fill(0);let b=0;for(let e=0;e<epochs;e++){const gw=new Array(d).fill(0);let gb=0;for(let k=0;k<n;k++){const z=b+X[k].reduce((s,x,i)=>s+w[i]*x,0);const p=sig(z),df=p-y[k];for(let i=0;i<d;i++)gw[i]+=df*X[k][i];gb+=df;}for(let i=0;i<d;i++){gw[i]=gw[i]/n+lambda*w[i];w[i]-=lr*gw[i];}b-=lr*(gb/n);}return{w,b};}

// ---- 统计特征提取 ----
const PUNCT = /[，。！？、；：""''（）《》【】…—\-\.\,\!\?\;\:\"\'\(\)\[\]\/\\]/;
const SENT_SPLIT = /[。！？!?\n]/;

function statFeatures(text) {
  const chars = [...text];
  const n = chars.length;
  if (n < 10) return [0,0,1,0,0,0];

  // 句子切分
  const sents = text.split(SENT_SPLIT).map(s=>s.trim()).filter(s=>s.length>=4);
  const slen = sents.map(s=>[...s].length);
  const sMean = slen.length ? slen.reduce((a,b)=>a+b,0)/slen.length : 0;
  const sVar = slen.length>1 ? slen.reduce((a,b)=>a+(b-sMean)**2,0)/slen.length : 0;
  const sCV = sMean>0 ? Math.sqrt(sVar)/sMean : 0;

  // 字符熵
  const freq = {};
  for (const c of chars) freq[c] = (freq[c]||0)+1;
  let entropy = 0;
  for (const c in freq) { const p = freq[c]/n; entropy -= p*Math.log2(p); }

  // TTR
  const ttr = Object.keys(freq).length / n;

  // 标点密度
  let punctCount = 0, commaCount = 0;
  for (const c of chars) {
    if (PUNCT.test(c)) { punctCount++; if(c==='，'||c===',') commaCount++; }
  }
  const punctDensity = punctCount/n;
  const commaRatio = punctCount>0 ? commaCount/punctCount : 0;

  return [sCV, entropy, ttr, punctDensity, sMean, commaRatio];
}

// ---- 数据加载 ----
async function loadDataset(labelFilter) {
  const rl = readline.createInterface({input: fs.createReadStream(path.join(__dirname,'..','dataset.jsonl')), crlfDelay: Infinity});
  const rows = [];
  for await (const line of rl) {
    if(!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.label !== labelFilter) continue;
    const lex = ZD.traces.map(t => t.test(r.text));
    const stat = statFeatures(r.text);
    rows.push({label: r.label, x: [...lex, ...stat]});
  }
  return rows;
}
async function loadFlash() {
  const rl = readline.createInterface({input: fs.createReadStream(path.join(__dirname,'answers.jsonl')), crlfDelay: Infinity});
  const rows = [];
  for await (const line of rl) {
    if(!line.trim()) continue;
    const r = JSON.parse(line);
    const lex = ZD.traces.map(t => t.test(r.text));
    const stat = statFeatures(r.text);
    rows.push({label: 0, x: [...lex, ...stat]});
  }
  return rows;
}

const ZERO_LEX = new Set(["meta-commentary","inspirational-closer","idiom-cluster","dead-metaphor","fake-colloquial"]);

async function main() {
  const humans = await loadDataset(1);
  const oldAi = await loadDataset(0);
  const flash = await loadFlash();
  console.log(`humans=${humans.length} oldAI=${oldAi.length} flash=${flash.length}`);

  // 统计特征三方均值（观察信号方向）
  const statMean = (rows) => {
    const s = new Array(D_STAT).fill(0);
    for (const r of rows) for (let i=0;i<D_STAT;i++) s[i]+=r.x[D_LEX+i];
    return s.map(v=>v/rows.length);
  };
  const sH=statMean(humans), sF=statMean(flash), sO=statMean(oldAi);
  const statNames=['sCV','entropy','ttr','punctDensity','sMeanLen','commaRatio'];
  console.log("\n=== 统计特征三方均值 ===");
  console.log("feature".padEnd(14), "human".padStart(10), "flash".padStart(10), "oldAI".padStart(10), "flash-human".padStart(12));
  for(let i=0;i<D_STAT;i++){
    console.log(statNames[i].padEnd(14), sH[i].toFixed(4).padStart(10), sF[i].toFixed(4).padStart(10), sO[i].toFixed(4).padStart(10), (sF[i]-sH[i]).toFixed(4).padStart(12));
  }

  // 拟合：人类+flash 平衡，7 种子 baked 均值
  const seeds=[20260828,1,42,7,123,999,5555];
  const wsum=new Array(D).fill(0); let bsum=0;
  let lastFit=null;
  for(const s of seeds){
    const rand=rng(s);
    const h=shuffle([...humans],rand),f=shuffle([...flash],rand);
    const nHt=Math.round(h.length*0.2),nFt=Math.round(f.length*0.2);
    const train=[...h.slice(nHt),...f.slice(nFt)],test=[...h.slice(0,nHt),...f.slice(0,nFt)];
    const mean=new Array(D).fill(0),std=new Array(D).fill(0);
    for(const r of train)for(let i=0;i<D;i++)mean[i]+=r.x[i];
    for(let i=0;i<D;i++)mean[i]/=train.length;
    for(const r of train)for(let i=0;i<D;i++)std[i]+=(r.x[i]-mean[i])**2;
    for(let i=0;i<D;i++)std[i]=Math.sqrt(std[i]/train.length)||1;
    const stdz=rs=>rs.map(r=>({label:r.label,x:r.x.map((v,i)=>(v-mean[i])/std[i])}));
    const trS=stdz(train),teS=stdz(test);
    const fitM=fitLogistic(trS.map(r=>r.x),trS.map(r=>r.label),{});
    for(let i=0;i<D;i++)wsum[i]+=fitM.w[i]/std[i];
    bsum+=fitM.b-fitM.w.reduce((s,wv,i)=>s+(wv*mean[i])/std[i],0);
    lastFit={fitM,teS,mean,std};
  }
  const w=wsum.map(v=>v/seeds.length);
  const b=bsum/seeds.length;
  // 词法零权重置零
  ZD.traces.forEach((t,i)=>{if(ZERO_LEX.has(t.id))w[i]=0;});

  // 用最后一个种子的 test 做指标（代表单次）
  const {fitM,teS}=lastFit;
  const predictStd=(rs)=>rs.map(r=>sig(fitM.b+r.x.reduce((s,v,i)=>s+fitM.w[i]*v,0)));
  const th=teS.filter(r=>r.label===1),tf=teS.filter(r=>r.label===0);
  const mH=metrics(predictStd(th),th.map(r=>r.label));
  const mF=metrics(predictStd(tf),tf.map(r=>r.label));

  // 全量 baked 部署分布
  const scoreRow=(r)=>{const z=b+r.x.reduce((s,v,i)=>s+w[i]*v,0);return Math.round(sig(z)*100);};
  const buckets=(rs)=>{let c=0,s=0,n=0;for(const r of rs){const sc=scoreRow(r);if(sc<=30)c++;else if(sc<=50)s++;else n++;}return{confirm:c,n:rs.length};};
  const bh=buckets(humans),bf=buckets(flash),bo=buckets(oldAi);

  console.log("\n=== v3 (纯词法) 回顾 ===");
  console.log("  flash 正常(漏判): 38.1%  人类正常: 89.0%  旧AI 正常: 74.3%");

  console.log("\n=== v4 (词法+统计) 三方部署分布 ===");
  console.log("  human  :", `确定 ${(bh.confirm/bh.n*100).toFixed(1)}% / 正常 ${((bh.n-bh.confirm)/bh.n*100).toFixed(1)}%`);
  console.log("  flash  :", `确定 ${(bf.confirm/bf.n*100).toFixed(1)}% / 正常 ${((bf.n-bf.confirm)/bf.n*100).toFixed(1)}%`);
  console.log("  oldAI  :", `确定 ${(bo.confirm/bo.n*100).toFixed(1)}% / 正常 ${((bo.n-bo.confirm)/bo.n*100).toFixed(1)}%`);

  console.log("\n=== test 指标（种子 20260828）===");
  console.log("  human:", JSON.stringify({acc:+mH.accuracy.toFixed(4),brier:+mH.brier.toFixed(4)}));
  console.log("  flash:", JSON.stringify({acc:+mF.accuracy.toFixed(4),brier:+mF.brier.toFixed(4)}));

  console.log("\n=== baked 权重（统计部分）===");
  const statNames2=['sCV','charEntropy','ttr','punctDensity','sMeanLen','commaRatio'];
  for(let i=0;i<D_STAT;i++){
    const idx=D_LEX+i;
    console.log("  "+statNames2[i].padEnd(14), +w[idx].toFixed(6));
  }
  console.log("  intercept:", +b.toFixed(6));

  // 闸门判定
  const flashNormal = (bf.n-bf.confirm)/bf.n;
  const v3FlashNormal = 0.381;
  const gate = flashNormal < v3FlashNormal;
  console.log("\n=== 闸门 ===");
  console.log(`  flash 漏判: v3 ${v3FlashNormal*100}% -> v4 ${(flashNormal*100).toFixed(1)}% ${gate?'✅ PASS':'❌ FAIL'}`);

  // case 验证
  const caseText=fs.readFileSync(path.join(__dirname,'..','case-zhihu-answer.txt'),'utf8');
  const caseLex=ZD.traces.map(t=>t.test(caseText));
  const caseStat=statFeatures(caseText);
  const caseZ=b+[...caseLex,...caseStat].reduce((s,v,i)=>s+w[i]*v,0);
  console.log("\ncase-zhihu-answer.txt:", Math.round(sig(caseZ)*100), "(v3: 45 疑似)");
}
main().catch(e=>{console.error(e);process.exit(1);});
