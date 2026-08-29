const fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'../../../..');
require(path.join(ROOT,'src/shared/constants.js'));require(path.join(ROOT,'src/engine/traces.js'));
const ZD=globalThis.ZhihuDetector;
const PUNCT=/[，。！？、；：""''（）《》【】…—\-\.\,\!\?\;\:\"\'\(\)\[\]\/\\]/;
const SENT_SPLIT=/[。！？!?\n]/;
function statFeatures(text){
  const chars=[...text];const n=chars.length;
  if(n<10)return[0,0,1,0,0,0];
  const sents=text.split(SENT_SPLIT).map(s=>s.trim()).filter(s=>s.length>=4);
  const slen=sents.map(s=>[...s].length);
  const sMean=slen.length?slen.reduce((a,b)=>a+b,0)/slen.length:0;
  const sVar=slen.length>1?slen.reduce((a,b)=>a+(b-sMean)**2,0)/slen.length:0;
  const sCV=sMean>0?Math.sqrt(sVar)/sMean:0;
  const freq={};for(const c of chars)freq[c]=(freq[c]||0)+1;
  let entropy=0;for(const c in freq){const p=freq[c]/n;entropy-=p*Math.log2(p);}
  const ttr=Object.keys(freq).length/n;
  let pc=0,cc=0;for(const c of chars){if(PUNCT.test(c)){pc++;if(c==='，'||c===',')cc++;}}
  return[sCV,entropy,ttr,pc/n,sMean,pc>0?cc/pc:0];
}
const text=fs.readFileSync(path.join(__dirname,'..','case-zhihu-answer.txt'),'utf8');
const s=statFeatures(text);
const names=['sCV','charEntropy','ttr','punctDensity','sMeanLen','commaRatio'];
const w_stat=[6.22225,-3.033604,-3.401066,-28.619921,0.018192,-0.177843];
const intercept=22.766538;
let z=intercept;
console.log('case stats:');
for(let i=0;i<6;i++){
  const contrib=w_stat[i]*s[i];
  console.log('  '+names[i].padEnd(14),'val='+s[i].toFixed(4).padStart(8),'  w='+w_stat[i].toFixed(4).padStart(10),'  contrib='+contrib.toFixed(4));
  z+=contrib;
}
console.log('stat-only z:',z.toFixed(4),'score:',Math.round(1/(1+Math.exp(-z))*100));
console.log('text length:',text.length,'chars');
