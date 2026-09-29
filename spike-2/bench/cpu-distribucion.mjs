import { readFileSync } from "node:fs";
const s = readFileSync(process.argv[2], "utf8");
const objs = []; let d=0, ini=-1, enStr=false, esc=false;
for (let i=0;i<s.length;i++){const c=s[i];
  if(esc){esc=false;continue;} if(c==="\\"){esc=true;continue;}
  if(c==='"'){enStr=!enStr;continue;} if(enStr)continue;
  if(c==="{"){if(d===0)ini=i;d++;} else if(c==="}"){d--;if(d===0&&ini>=0){objs.push(s.slice(ini,i+1));ini=-1;}}}
const ev=[];
for(const o of objs){let j;try{j=JSON.parse(o);}catch{continue;}
  if(typeof j.cpuTime!=="number"||!j.event?.request?.url)continue;
  ev.push({t:j.eventTimestamp,p:new URL(j.event.request.url).pathname,cpu:j.cpuTime,out:j.outcome});}
ev.sort((a,b)=>a.t-b.t);
const g=new Map();
for(const e of ev){if(!g.has(e.p))g.set(e.p,[]);g.get(e.p).push(e.cpu);}
const q=(a,p)=>{const x=[...a].sort((m,n)=>m-n);return x[Math.min(x.length-1,Math.floor(p*x.length))];};
console.log("ruta".padEnd(20),"n".padEnd(5),"primeras5".padEnd(22),"resto_p50".padEnd(10),"resto_p99".padEnd(10),"resto_max".padEnd(10),">10ms_resto");
for(const [p,a] of [...g.entries()].sort()){
  const prim=a.slice(0,5), resto=a.slice(5);
  const sobre=resto.filter(x=>x>10).length;
  console.log(p.padEnd(20),String(a.length).padEnd(5),
    ("["+prim.join(",")+"]").padEnd(22),
    (resto.length?q(resto,0.5)+"ms":"-").padEnd(10),
    (resto.length>=100?q(resto,0.99)+"ms":"n/a").padEnd(10),
    (resto.length?Math.max(...resto)+"ms":"-").padEnd(10),
    resto.length?`${sobre}/${resto.length} (${(100*sobre/resto.length).toFixed(1)}%)`:"-");
}
