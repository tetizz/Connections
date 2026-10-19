// Optional job-owned observed monthly adjacency, never shared route authority.
import {certificateScope,eligibleCertificateJob,certificateDigest} from './two-hop-certificate.js';
const PREFIX='month-history:v1:', LEDGER=PREFIX+'ledger';
export const MONTH_HISTORY_LIMITS=Object.freeze({valueBytes:80*1024,totalBytes:16*1024*1024,reserveBytes:64*1024,players:160,playerBytes:2*1024*1024,monthChunks:64});
const bytes=s=>new TextEncoder().encode(s).length, same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const currentMonth=()=>new Date().toISOString().slice(0,7).replace('-','/');
const validName=n=>typeof n==='string'&&/^[a-z0-9_-]{1,50}$/.test(n);
const validURL=u=>typeof u==='string'&&/^https:\/\/www\.chess\.com\/game\/live\/[1-9]\d*$/.test(u)&&Number.isSafeInteger(Number(u.split('/').at(-1)));
function validDirection(rows){return Array.isArray(rows)&&new Set(rows.map(r=>r?.[0])).size===rows.length&&rows.every(r=>Array.isArray(r)&&r.length===2&&validName(r[0])&&Array.isArray(r[1])&&r[1].length>0&&r[1].every(validURL));}
function validContext(c,now=Date.now(),fresh=true) {return c?.version===1&&validName(c.username)&&typeof c.month==='string'&&/^\d{4}\/(?:0[1-9]|1[0-2])$/.test(c.month)&&(!fresh||c.month===currentMonth())&&Number.isFinite(c.indexTs)&&c.indexTs>0&&(!fresh||(c.indexTs<=now&&c.indexTs+86400000>now))&&Array.isArray(c.selected)&&c.selected.length<=1200&&new Set(c.selected).size===c.selected.length&&c.selected.every(u=>typeof u==='string'&&new RegExp('^https://api\\.chess\\.com/pub/player/'+c.username+'/games/\\d{4}/(?:0[1-9]|1[0-2])$').test(u));}
function validRow(r,c,now=Date.now()) {return r&&c.selected.includes(r.url)&&Number.isFinite(r.observedAt)&&r.observedAt<=now&&r.observedAt>=c.scope.createdAt&&Number.isFinite(r.expiresAt)&&r.expiresAt>now&&r.expiresAt<=r.observedAt+7*86400000&&validDirection(r.beatenByMe)&&validDirection(r.beatMe);}
function owns(job,input){return eligibleCertificateJob(job)&&same(certificateScope(job),input.scope)&&job.processingToken===input.token&&typeof input.token==='string'&&input.token.length>=8&&job.processingUntil>Date.now();}
const stem=(name,url)=>PREFIX+name+':'+url.slice(-7).replace('/','-')+':';
async function unpack(pkg,c){
 if(!pkg||!same(pkg.context,c)||!Array.isArray(pkg.chunks)||!Array.isArray(pkg.hashes)||pkg.chunks.length!==pkg.hashes.length||pkg.chunks.length>MONTH_HISTORY_LIMITS.monthChunks)return null;
 let size=0;for(let i=0;i<pkg.chunks.length;i++){const text=pkg.chunks[i];if(typeof text!=='string'||bytes(text)>MONTH_HISTORY_LIMITS.valueBytes||await certificateDigest(text)!==pkg.hashes[i])return null;size+=bytes(text);if(size>MONTH_HISTORY_LIMITS.playerBytes)return null;}
 if(size>MONTH_HISTORY_LIMITS.playerBytes)return null;
 let rows;try{rows=JSON.parse(pkg.chunks.join(''));}catch{return null;}
 if(!Array.isArray(rows)||rows.length!==1||!c.selected.includes(rows[0]?.url)||!validDirection(rows[0].beatenByMe)||!validDirection(rows[0].beatMe))return null;
 return rows;
}
export async function monthHistoryAction(storage,action,input){
 if(!['month-history-read','month-history-commit'].includes(action)||!validContext(input.context)||!same(input.context.scope,input.scope)||typeof storage.transaction!=='function')return{accepted:false};
 const c=input.context;let verified=null;
 if(action==='month-history-commit'){verified=await unpack(input.package,c);if(!verified||!validRow(verified[0],c))return{accepted:false};}
 const result=await storage.transaction(async txn=>{
  if(!owns(await txn.get('job'),input)||!validContext(c))return{accepted:false};
  const ledger=(await txn.get(LEDGER))??{};if(!ledger||typeof ledger!=='object'||Array.isArray(ledger)||Object.keys(ledger).length>160||Object.entries(ledger).some(([n,v])=>!validName(n)||!Number.isSafeInteger(v.bytes)||v.bytes<0||v.bytes>MONTH_HISTORY_LIMITS.playerBytes||!Number.isInteger(v.count)||v.count<0||v.count>1024))return{accepted:false};
  const manifestKey=PREFIX+c.username+':manifest',old=await txn.get(manifestKey);
  const validManifest=m=>m&&validContext(m.context,Date.now(),false)&&m.context.username===c.username&&m.months&&typeof m.months==='object'&&!Array.isArray(m.months)&&Object.keys(m.months).length<=1200&&Object.entries(m.months).every(([url,p])=>m.context.selected.includes(url)&&Array.isArray(p.hashes)&&p.hashes.length<=MONTH_HISTORY_LIMITS.monthChunks&&p.hashes.every(h=>/^[a-f0-9]{64}$/.test(h))&&Number.isSafeInteger(p.bytes)&&p.bytes>=0&&p.bytes<=MONTH_HISTORY_LIMITS.playerBytes);
  if(old&&(!validManifest(old)||bytes(JSON.stringify(old))+bytes(manifestKey)+Object.values(old.months).reduce((n,p)=>n+p.bytes,0)>MONTH_HISTORY_LIMITS.playerBytes))return{accepted:false};
  if(action==='month-history-read'){
   if(!old||!same(old.context,c))return{accepted:false};
   const packages=[];let total=0;
   for(const [url,pin] of Object.entries(old.months)){
    const keys=pin.hashes.map((_,i)=>stem(c.username,url)+i),found=await txn.get(keys);
    if(!(found instanceof Map)||keys.some(k=>!found.has(k)))return{accepted:false};
    const chunks=keys.map(k=>found.get(k));if(chunks.some(x=>typeof x!=='string'))return{accepted:false};
    total+=chunks.reduce((n,x)=>n+bytes(x),0);if(total>MONTH_HISTORY_LIMITS.playerBytes)return{accepted:false};
    packages.push({context:c,hashes:pin.hashes,chunks});
   }
   return{accepted:true,packages};
  }
  if(!validRow(verified[0],c))return{accepted:false};
  const url=verified[0].url,pkg=input.package,chunkBytes=pkg.chunks.reduce((n,x,i)=>n+bytes(x)+bytes(stem(c.username,url)+i),0);
  const sameContext=old&&same(old.context,c),months=sameContext?{...old.months}:{};
  months[url]={hashes:pkg.hashes,bytes:chunkBytes};const manifest={context:c,months};
  const size=bytes(JSON.stringify(manifest))+bytes(manifestKey)+Object.values(months).reduce((n,p)=>n+p.bytes,0),count=Object.values(months).reduce((n,p)=>n+p.hashes.length,0);
  const previous=ledger[c.username];if(!previous&&Object.keys(ledger).length>=160)return{accepted:false};
  const total=Object.values(ledger).reduce((n,v)=>n+v.bytes,0)-(previous?.bytes??0)+size;
  if(size>MONTH_HISTORY_LIMITS.playerBytes||total>MONTH_HISTORY_LIMITS.totalBytes-MONTH_HISTORY_LIMITS.reserveBytes||count>1024||bytes(JSON.stringify(manifest))>=MONTH_HISTORY_LIMITS.valueBytes)return{accepted:false};
  ledger[c.username]={bytes:size,count};if(bytes(JSON.stringify(ledger))>=MONTH_HISTORY_LIMITS.reserveBytes)return{accepted:false};
  // Only this month's adjacency chunks are written. Prior months stay immutable.
  const chunkEntries=pkg.chunks.map((text,i)=>[stem(c.username,url)+i,text]);
  for(let i=0;i<chunkEntries.length;i+=64)await txn.put(Object.fromEntries(chunkEntries.slice(i,i+64)));
  await txn.put({[LEDGER]:ledger,[manifestKey]:manifest});
  const obsolete=[];
  if(old)for(const [oldURL,pin]of Object.entries(old.months)){
   const keep=sameContext&&oldURL!==url?pin.hashes.length:oldURL===url?pkg.chunks.length:0;
   for(let i=keep;i<pin.hashes.length;i++)obsolete.push(stem(c.username,oldURL)+i);
  }
  for(let i=0;i<obsolete.length;i+=64)await txn.delete(obsolete.slice(i,i+64));
  if(!owns(await txn.get('job'),input)||!validContext(c)||!validRow(verified[0],c))throw new Error('Checkpoint authority changed before commit');
  return{accepted:true};
 });
 if(action==='month-history-read'&&result.accepted){for(const pkg of result.packages)if(!await unpack(pkg,c))return{accepted:false};}
 return result;
}
export function createMonthHistoryHooks(job,username,request,signal){
 let context=null,rows=new Map(),disabled=false;
 const check=()=>{if(signal?.aborted)throw signal.reason??new Error('Aborted');};
 const call=async(action,payload)=>{check();let result;try{result=await request(action,{scope:certificateScope(job),token:job.processingToken,...payload});}catch{result={accepted:false};}check();return result;};
 return{
  get active(){return !disabled&&context!==null;},
  async begin(list,selected){check();context={version:1,scope:certificateScope(job),username,month:currentMonth(),indexTs:list.ts,selected:[...selected]};if(!validContext(context)){disabled=true;return;}const r=await call('month-history-read',{context});rows=new Map();if(r.accepted)for(const pkg of r.packages){const part=await unpack(pkg,context);if(!part){rows.clear();break;}for(const row of part)if(validRow(row,context)&&!rows.has(row.url))rows.set(row.url,row);}check();},
  async read(url){check();if(disabled||!context||!validContext(context))return null;const r=rows.get(url);return r&&validRow(r,context)?{edges:{beatenByMe:new Map(r.beatenByMe.map(([name,urls])=>[name,[...urls]])),beatMe:new Map(r.beatMe.map(([name,urls])=>[name,[...urls]]))},expiresAt:r.expiresAt}:null;},
  async month({url,edges,expiresAt,observedAt}){
   check();if(disabled||!context||!validContext(context))return;
   // Snapshot only the new month's arrays; callers cannot mutate retained proof input.
   const snapshot=direction=>[...direction].map(([name,urls])=>[name,[...urls]]);
   const row={url,expiresAt,observedAt,beatenByMe:snapshot(edges.beatenByMe),beatMe:snapshot(edges.beatMe)};
   if(!validRow(row,context))return;rows.set(url,row);
   const body=JSON.stringify([row]);if(bytes(body)>MONTH_HISTORY_LIMITS.playerBytes){disabled=true;rows.clear();return;}
   const chunks=[];for(let i=0;i<body.length;i+=16384)chunks.push(body.slice(i,i+16384));
   if(chunks.length>MONTH_HISTORY_LIMITS.monthChunks){disabled=true;return;}
   const hashes=[];for(const chunk of chunks)hashes.push(await certificateDigest(chunk));check();
   const result=await call('month-history-commit',{context,package:{context,chunks,hashes}});if(!result.accepted)disabled=true;
  }
 };
}
