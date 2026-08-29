const fs=require('fs'),path=require('path'),readline=require('readline');
const ROOT=path.resolve(__dirname,'../../../..');
require(path.join(ROOT,'src/shared/constants.js'));
require(path.join(ROOT,'src/engine/traces.js'));
const ZD=globalThis.ZhihuDetector;
const D_LEX=ZD.traces.length;
const D_STAT=4;
const D=D_LEX+D_STAT;
const PUNCT=/[，。！？、；：""''（）《》【】…—\-\.\,\!\?\;\:\"\'\(\)\[\]\/\\]/;
const SENT_SPLIT=/[。！？!?\n]/;
function statFeatures(text){const chars=[...text];const n=chars.length;if(n<10)return[0,0,0,0];const sents=text.split(SENT_SPLIT).map(s=>s.trim()).filter(s=>s.length>=4);const slen=sents.map(s=>[...s].length);const sMean=slen.length?slen.reduce((a,b)=>a+b,0)/slen.length:0;const sVar=slen.length>1?slen.reduce((a,b)=>a+(b-sMean)**2,0)/slen.length:0;const sCV=sMean>0?Math.sqrt(sVar)/sMean:0;let pc=0,cc=0;for(const c of chars){if(PUNCT.test(c)){pc++;if(c==='，'||c===',')cc++;}}return[sCV,pc/n,sMean,pc>0?cc/pc:0];}
function rng(s){let a=s>>>0;return()=>{a|=0;a=(a+0x6d2b79f5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function shuffle(a,r){for(let i=a.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
const sig=z=>1/(1+Math.exp(-z));
function fitLogistic(X,y){const n=X.length,d=X[0].length,w=new Array(d).fill(0);let b=0;const lr=0.5,lambda=0.01,epochs=400;for(let e=0;e<epochs;e++){const gw=new Array(d).fill(0);let gb=0;for(let k=0;k<n;k++){const z=b+X[k].reduce((s,x,i)=>s+w[i]*x,0);const p=sig(z),df=p-y[k];for(let i=0;i<d;i++)gw[i]+=df*X[k][i];gb+=df;}for(let i=0;i<d;i++){gw[i]=gw[i]/n+lambda*w[i];w[i]-=lr*gw[i];}b-=lr*(gb/n);}return{w,b};}
async function loadDataset(lf){const rl=readline.createInterface({input:fs.createReadStream(path.join(__dirname,'..','dataset.jsonl')),crlfDelay:Infinity});const rows=[];for await(const l of rl){if(!l.trim())continue;const r=JSON.parse(l);if(r.label!==lf)continue;rows.push({label:r.label,x:[...ZD.traces.map(t=>t.test(r.text)),...statFeatures(r.text)]});}return rows;}
async function loadFlash(){const rl=readline.createInterface({input:fs.createReadStream(path.join(__dirname,'answers.jsonl')),crlfDelay:Infinity});const rows=[];for await(const l of rl){if(!l.trim())continue;const r=JSON.parse(l);rows.push({label:0,x:[...ZD.traces.map(t=>t.test(r.text)),...statFeatures(r.text)]});}return rows;}
const ZERO=new Set(['meta-commentary','inspirational-closer','idiom-cluster','dead-metaphor','fake-colloquial']);
async function main(){
  const humans=await loadDataset(1),flash=await loadFlash();
  const seeds=[20260828,1,42,7,123,999,5555];
  const wsum=new Array(D).fill(0);let bsum=0;
  for(const s of seeds){
    const rand=rng(s);const h=shuffle([...humans],rand),f=shuffle([...flash],rand);
    const nHt=Math.round(h.length*0.2),nFt=Math.round(f.length*0.2);
    const train=[...h.slice(nHt),...f.slice(nFt)];
    const mean=new Array(D).fill(0),std=new Array(D).fill(0);
    for(const r of train)for(let i=0;i<D;i++)mean[i]+=r.x[i];
    for(let i=0;i<D;i++)mean[i]/=train.length;
    for(const r of train)for(let i=0;i<D;i++)std[i]+=(r.x[i]-mean[i])**2;
    for(let i=0;i<D;i++)std[i]=Math.sqrt(std[i]/train.length)||1;
    const trS=train.map(r=>({x:r.x.map((v,i)=>(v-mean[i])/std[i])}));
    const fitM=fitLogistic(trS.map(r=>r.x),train.map(r=>r.label));
    for(let i=0;i<D;i++)wsum[i]+=fitM.w[i]/std[i];
    bsum+=fitM.b-fitM.w.reduce((s,wv,i)=>s+(wv*mean[i])/std[i],0);
  }
  const w=wsum.map(v=>v/seeds.length);
  const b=bsum/seeds.length;
  ZD.traces.forEach((t,i)=>{if(ZERO.has(t.id))w[i]=0;});
  console.log('=== v4b full baked weights ===');
  console.log('intercept:',+b.toFixed(6));
  for(let i=0;i<D_LEX;i++){
    console.log('  '+ZD.traces[i].id.padEnd(22),+w[i].toFixed(6));
  }
  console.log('=== stat weights ===');
  const sn=['sCV','punctDensity','sMeanLen','commaRatio'];
  for(let i=0;i<D_STAT;i++)console.log('  '+sn[i].padEnd(22),+w[D_LEX+i].toFixed(6));
  const caseText=fs.readFileSync(path.join(__dirname,'..','case-zhihu-answer.txt'),'utf8');
  const caseX=[...ZD.traces.map(t=>t.test(caseText)),...statFeatures(caseText)];
  console.log('\ncase:',Math.round(sig(b+caseX.reduce((s,v,i)=>s+w[i]*v,0))*100));
}
main().catch(e=>{console.error(e);process.exit(1);});
