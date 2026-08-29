#!/usr/bin/env node
/**
 * 实验：纯 flash 作 AI 重拟合（用户想法验证）
 *  - AI 样本 = flash 2956（丢弃旧 9 LLM）
 *  - 人类样本 = C-ReD 人类 2956（不变）
 *  - 平衡训练，80/20 分层切分
 *  - 三方测试：人类 test / flash test / 旧 9 LLM 全量（泛化，模型未见过）
 *  - 4 零权重特征处理同 fit.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '../../../..');
require(path.join(ROOT, 'src/shared/constants.js'));
require(path.join(ROOT, 'src/engine/traces.js'));
const ZD = globalThis.ZhihuDetector;
const D = ZD.traces.length;

// ---- utils (from fit.js) ----
function rng(seed){let a=seed>>>0;return()=>{a|=0;a=(a+0x6d2b79f5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function shuffle(arr,rand){for(let i=arr.length-1;i>0;i--){const j=Math.floor(rand()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];}return arr;}
const sigmoid=(z)=>1/(1+Math.exp(-z));
function auroc(scores,labels){const n=scores.length;const idx=scores.map((_,i)=>i).sort((a,b)=>scores[a]-scores[b]);const ranks=new Array(n);let i=0;while(i<n){let j=i;while(j+1<n&&scores[idx[j+1]]===scores[idx[i]])j++;const avg=(i+j)/2+1;for(let k=i;k<=j;k++)ranks[idx[k]]=avg;i=j+1;}let posSum=0,nPos=0,nNeg=0;for(let k=0;k<n;k++){if(labels[k]===1){posSum+=ranks[k];nPos++;}else nNeg++;}if(nPos===0||nNeg===0)return NaN;return(posSum-(nPos*(nPos+1))/2)/(nPos*nNeg);}
function metrics(probs,labels){let correct=0,brier=0;for(let k=0;k<labels.length;k++){const p=probs[k];if((p>=0.5?1:0)===labels[k])correct++;brier+=(p-labels[k])**2;}return{n:labels.length,accuracy:correct/labels.length,auroc:auroc(probs,labels),brier:brier/labels.length};}
function fitLogistic(X,y,opts){const{lr=0.5,epochs=400,lambda=0.01}=opts;const n=X.length;const d=X[0].length;let w=new Array(d).fill(0);let b=0;for(let e=0;e<epochs;e++){const gw=new Array(d).fill(0);let gb=0;for(let k=0;k<n;k++){const z=b+X[k].reduce((s,x,i)=>s+w[i]*x,0);const p=sigmoid(z);const diff=p-y[k];for(let i=0;i<d;i++)gw[i]+=diff*X[k][i];gb+=diff;}for(let i=0;i<d;i++){gw[i]=gw[i]/n+lambda*w[i];w[i]-=lr*gw[i];}b-=lr*(gb/n);}return{w,b};}

// ---- load ----
async function loadFeatures(labelFilter){
  const rl=readline.createInterface({input:fs.createReadStream(path.join(__dirname,'..','features.jsonl')),crlfDelay:Infinity});
  const rows=[];
  for await(const line of rl){if(!line.trim())continue;const r=JSON.parse(line);if(r.label!==labelFilter)continue;const x=typeof r.x==='string'?JSON.parse(r.x):r.x;rows.push({label:r.label,x});}
  return rows;
}
async function loadFlash(){
  const rl=readline.createInterface({input:fs.createReadStream(path.join(__dirname,'answers.jsonl')),crlfDelay:Infinity});
  const rows=[];
  for await(const line of rl){if(!line.trim())continue;const r=JSON.parse(line);const x=ZD.traces.map(t=>t.test(r.text));rows.push({label:0,x});}
  return rows;
}

function stratifiedSplit(pos,neg,testRatio,seed){
  const rand=rng(seed);
  const p=shuffle([...pos],rand), n=shuffle([...neg],rand);
  const nPt=Math.round(p.length*testRatio), nNt=Math.round(n.length*testRatio);
  return{train:[...p.slice(nPt),...n.slice(nNt)],test:[...p.slice(0,nPt),...n.slice(0,nNt)]};
}

async function main(){
  const humans=await loadFeatures(1);
  const oldAi=await loadFeatures(0);   // 旧9 LLM 全量，仅作泛化测试
  const flash=await loadFlash();
  console.log(`humans=${humans.length} oldAI=${oldAi.length} flash=${flash.length}`);

  // 平衡：人类 + flash，分层 80/20
  const{train,test}=stratifiedSplit(humans,flash,0.2,20260828);
  console.log(`train=${train.length} (h=${train.filter(r=>r.label===1).length},f=${train.filter(r=>r.label===0).length})  test=${test.length}`);

  // 标准化（train 统计）
  const mean=new Array(D).fill(0),std=new Array(D).fill(0);
  for(const r of train)for(let i=0;i<D;i++)mean[i]+=r.x[i];
  for(let i=0;i<D;i++)mean[i]/=train.length;
  for(const r of train)for(let i=0;i<D;i++)std[i]+=(r.x[i]-mean[i])**2;
  for(let i=0;i<D;i++)std[i]=Math.sqrt(std[i]/train.length)||1;
  const stdz=(rs)=>rs.map(r=>({label:r.label,x:r.x.map((v,i)=>(v-mean[i])/std[i])}));
  const trainS=stdz(train),testS=stdz(test),oldAiS=stdz(oldAi);

  // 平衡训练（人类+flash 各 ~2365）
  const hT=trainS.filter(r=>r.label===1),fT=trainS.filter(r=>r.label===0);
  const balanced=[...hT,...fT];
  const fit=fitLogistic(balanced.map(r=>r.x),balanced.map(r=>r.label),{});
  const predict=(rs)=>rs.map(r=>sigmoid(fit.b+r.x.reduce((s,v,i)=>s+fit.w[i]*v,0)));

  // 三方测试
  const testHuman=testS.filter(r=>r.label===1);
  const testFlash=testS.filter(r=>r.label===0);
  const mHuman=metrics(predict(testHuman),testHuman.map(r=>r.label));
  const mFlash=metrics(predict(testFlash),testFlash.map(r=>r.label));
  const mOldAi=metrics(predict(oldAiS),oldAiS.map(r=>r.label));   // 泛化：模型未见过旧AI
  const mAll=metrics(predict(testS),testS.map(r=>r.label));

  // 部署语义：分数分布（确定≤30/疑似≤50/正常）
  const buckets=(rs)=>{const probs=predict(rs);let c=0,s=0,n=0;for(const p of probs){const sc=Math.round(p*100);if(sc<=30)c++;else if(sc<=50)s++;else n++;}return{confirm:c/rs.length,suspect:s/rs.length,normal:n/rs.length};};

  console.log("\n=== 纯 flash 拟合，三方测试 ===");
  console.log("人类 test  :",JSON.stringify({n:mHuman.n,acc:+mHuman.accuracy.toFixed(4),auroc:+mHuman.auroc.toFixed(4),brier:+mHuman.brier.toFixed(4)}));
  console.log("flash test :",JSON.stringify({n:mFlash.n,acc:+mFlash.accuracy.toFixed(4),auroc:+mFlash.auroc.toFixed(4),brier:+mFlash.brier.toFixed(4)}));
  console.log("旧9LLM(泛化):",JSON.stringify({n:mOldAi.n,acc:+mOldAi.accuracy.toFixed(4),auroc:+mOldAi.auroc.toFixed(4),brier:+mOldAi.brier.toFixed(4)}));
  console.log("all test   :",JSON.stringify({n:mAll.n,acc:+mAll.accuracy.toFixed(4),auroc:+mAll.auroc.toFixed(4),brier:+mAll.brier.toFixed(4)}));

  console.log("\n=== 部署分数分布 (确定/疑似/正常) ===");
  const bh=buckets(testHuman),bf=buckets(testFlash),bo=buckets(oldAiS);
  console.log("人类   :",`确定 ${(bh.confirm*100).toFixed(1)}% / 疑似 ${(bh.suspect*100).toFixed(1)}% / 正常 ${(bh.normal*100).toFixed(1)}%`);
  console.log("flash  :",`确定 ${(bf.confirm*100).toFixed(1)}% / 疑似 ${(bf.suspect*100).toFixed(1)}% / 正常 ${(bf.normal*100).toFixed(1)}%`);
  console.log("旧9LLM :",`确定 ${(bo.confirm*100).toFixed(1)}% / 疑似 ${(bo.suspect*100).toFixed(1)}% / 正常 ${(bo.normal*100).toFixed(1)}%`);

  // 反标准化 bake + 零权重
  const ZERO=new Set(['meta-commentary','inspirational-closer','idiom-cluster','dead-metaphor']);
  const baked={w:fit.w.map((wv,i)=>wv/std[i]),b:fit.b-fit.w.reduce((s,wv,i)=>s+(wv*mean[i])/std[i],0)};
  const wMap={};ZD.traces.forEach((t,i)=>{wMap[t.id]=ZERO.has(t.id)?0:+baked.w[i].toFixed(6);});

  console.log("\n=== baked 权重 (vs v2) ===");
  require(path.join(ROOT,'src/engine/calibrated-weights.js'));
  const W2w=globalThis.ZhihuDetector.calibratedWeights.weights;
  for(const t of ZD.traces){
    const old=W2w[t.id],nw=wMap[t.id];
    if(Math.abs(old-nw)>0.001)console.log(`  ${t.id.padEnd(22)} v2=${String(old).padStart(8)} -> flash=${String(nw).padStart(8)}`);
  }
  console.log("  intercept:",+baked.b.toFixed(6),"(v2:",globalThis.ZhihuDetector.calibratedWeights.intercept,")");

  // dash-repetition 新权重
  console.log("\ndash-repetition: v2=",W2w['dash-repetition'],"-> flash=",wMap['dash-repetition']);
}
main().catch(e=>{console.error(e);process.exit(1);});
