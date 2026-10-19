// Observed-root minimum3 authority. Never atomic/global Chess.com completeness.
import {certificateScope,eligibleCertificateJob,unpackCertificate,certificateDigest} from './two-hop-certificate.js';
const PREFIX='root-three:v1:',CHUNK=32*1024,MAX=2*1024*1024;
const bytes=s=>new TextEncoder().encode(s).length,same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const month=()=>new Date().toISOString().slice(0,7).replace('-','/');
const key=i=>PREFIX+'chunk:'+String(i).padStart(3,'0');
export const rootBoundDigest=pkg=>certificateDigest(JSON.stringify([pkg.manifest,pkg.chunks]));
export class ThreeHopWitness extends Error{constructor(chain,authority){super('Observed root minimum3 witness');this.chain=chain;this.authority=authority;}}
const name=n=>typeof n==='string'&&/^[a-z0-9_-]{1,50}$/.test(n);
const proof=p=>p&&name(p.from)&&name(p.to)&&p.from!==p.to&&/^https:\/\/www\.chess\.com\/game\/live\/[1-9]\d*$/.test(p.url)&&Number.isSafeInteger(Number(p.url.split('/').at(-1)))&&p.result==='win'&&['white','black'].includes(p.color)&&typeof p.timeClass==='string'&&p.timeClass!=='daily'&&typeof p.opening==='string'&&(p.endTime===null||Number.isFinite(p.endTime));
function fresh(m,scope,now=Date.now()){
 return m&&same(m.scope,scope)&&m.month===month()&&now>=scope.createdAt&&now<scope.createdAt+7200000&&Number.isFinite(m.indexTs)&&m.indexTs<=now&&m.indexTs+86400000>now&&Array.isArray(m.selected)&&m.selected.length>0&&new Set(m.selected).size===m.selected.length&&Array.isArray(m.months)&&m.months.length===m.selected.length&&m.months.every((r,i)=>r.url===m.selected[i]&&Number.isFinite(r.observedAt)&&r.observedAt>=scope.createdAt&&r.observedAt<=now&&Number.isFinite(r.expiresAt)&&r.expiresAt>now);
}
export function rootBoundFresh(authority,job,now=Date.now()){return authority&&eligibleCertificateJob(job,now)&&fresh(authority.start.manifest,certificateScope(job),now)&&fresh(authority.target.manifest,certificateScope(job),now);}
export function validStartScan(scan,startPackage){const m=startPackage?.manifest;return scan?.version===1&&same(scan.scope,m?.scope)&&scan.month===m.month&&scan.indexTs===m.indexTs&&same(scan.selected,m.selected)&&same(scan.months,m.months.map(r=>({url:r.url,gamesCount:r.gamesCount,observedAt:r.observedAt,expiresAt:r.expiresAt})));}
export async function unpackRootBound(startPackage,targetPackage,startScan){
 const start=await unpackCertificate(startPackage),m=targetPackage?.manifest,scope=start?.manifest.scope;
 if(!start||!validStartScan(startScan,startPackage)||!fresh(start.manifest,scope)||m?.version!==1||m.complete!==true||!fresh(m,scope)||m.startDigest!==await rootBoundDigest(startPackage)||m.startScanDigest!==await certificateDigest(JSON.stringify(startScan))||!Array.isArray(m.chunks)||!Array.isArray(targetPackage.chunks)||m.chunks.length!==targetPackage.chunks.length||m.chunks.length<1||m.chunks.length>64)return null;
 let total=bytes(JSON.stringify(m));const predecessors=[],seen=new Set(),winners=new Set(start.proofs.map(p=>p.to));
 if(bytes(JSON.stringify(m))>=80*1024||m.selected.some(u=>typeof u!=='string'||u.slice(-7)>m.month||!new RegExp('^https://api\\.chess\\.com/pub/player/'+scope.target+'/games/\\d{4}/(?:0[1-9]|1[0-2])$').test(u)))return null;
 for(let i=0;i<m.chunks.length;i++){
  const text=targetPackage.chunks[i],pin=m.chunks[i];if(typeof text!=='string'||bytes(text)>CHUNK||bytes(text)!==pin.bytes||await certificateDigest(text)!==pin.sha256)return null;
  total+=pin.bytes;if(total>MAX)return null;let rows;try{rows=JSON.parse(text);}catch{return null;}if(!Array.isArray(rows))return null;
  for(const p of rows){if(!proof(p)||p.to!==scope.target||p.from===scope.start||seen.has(p.from)||winners.has(p.from))return null;seen.add(p.from);predecessors.push(p);}
 }
 if(predecessors.length!==m.proofCount||!Number.isInteger(m.proofCount)||m.proofCount<0)return null;
 return{startScan,start:{manifest:start.manifest,proofs:start.proofs},target:{manifest:m,proofs:predecessors},startPackage,targetPackage,digest:await rootBoundDigest(targetPackage)};
}
const owns=(job,input)=>eligibleCertificateJob(job)&&same(certificateScope(job),input.scope)&&job.processingToken===input.token&&typeof input.token==='string'&&input.token.length>=8&&job.processingUntil>Date.now();
async function loadStart(txn){const manifest=await txn.get('twohop:v1:manifest');if(!Array.isArray(manifest?.chunks)||manifest.chunks.length>64)return null;const keys=manifest.chunks.map((_,i)=>'twohop:v1:chunk:'+String(i).padStart(3,'0'));const values=await txn.get(keys);if(!(values instanceof Map)||keys.some(k=>!values.has(k)))return null;return{manifest,chunks:keys.map(k=>values.get(k))};}
export async function rootBoundAction(storage,action,input){
 if(!['root-three-start-commit','root-three-start-read','root-three-commit','root-three-read'].includes(action)||typeof storage.transaction!=='function')return{accepted:false};
 return storage.transaction(async txn=>{
  const job=await txn.get('job');if(!owns(job,input))return{accepted:false};let targetPackage=input.package;
  if(action==='root-three-start-read'&&!await txn.get(PREFIX+'start-scan'))return{accepted:false};
  if(action==='root-three-read'){const manifest=await txn.get(PREFIX+'manifest');if(!Array.isArray(manifest?.chunks)||manifest.chunks.length>64)return{accepted:false};const keys=manifest.chunks.map((_,i)=>key(i)),found=await txn.get(keys);if(!(found instanceof Map)||keys.some(k=>!found.has(k)))return{accepted:false};targetPackage={manifest,chunks:keys.map(k=>found.get(k))};}
  const startPackage=await loadStart(txn);if(!startPackage||!await unpackCertificate(startPackage)||!fresh(startPackage.manifest,input.scope))return{accepted:false};
  if(action==='root-three-start-commit'||action==='root-three-start-read'){
    const scan=action==='root-three-start-commit'?input.scan:await txn.get(PREFIX+'start-scan');
    if(!validStartScan(scan,startPackage)||await rootBoundDigest(startPackage)!== (action==='root-three-start-commit'?input.startDigest:await txn.get(PREFIX+'start-digest'))||!owns(await txn.get('job'),input)||!fresh(startPackage.manifest,input.scope))return{accepted:false};
    if(action==='root-three-start-commit'){if(bytes(JSON.stringify(scan))>=80*1024)return{accepted:false};await txn.put({[PREFIX+'start-scan']:scan,[PREFIX+'start-digest']:input.startDigest});if(!owns(await txn.get('job'),input)||!fresh(startPackage.manifest,input.scope))throw Error('Start scan expired during commit');}
    return{accepted:true,startScan:scan};
  }
  const startScan=await txn.get(PREFIX+'start-scan');
  const verified=await unpackRootBound(startPackage,targetPackage,startScan);if(!verified||!rootBoundFresh(verified,job)||!same(verified.target.manifest.scope,input.scope))return{accepted:false};
  if(action==='root-three-commit'){
   // Bounded native storage, no truncation: oversized input simply has no bound.
   const previous=await txn.get(PREFIX+'manifest');if(previous&&(!Array.isArray(previous.chunks)||previous.chunks.length>64))return{accepted:false};const entries=targetPackage.chunks.map((text,i)=>[key(i),text]);
   await txn.put(Object.fromEntries(entries));await txn.put(PREFIX+'manifest',targetPackage.manifest);
   if(Array.isArray(previous?.chunks)&&previous.chunks.length>entries.length)await txn.delete(Array.from({length:previous.chunks.length-entries.length},(_,i)=>key(i+entries.length)));
   if(!owns(await txn.get('job'),input)||!rootBoundFresh(verified,job))throw Error('Root bound authority expired during commit');
  }
  if(!owns(await txn.get('job'),input)||!rootBoundFresh(verified,job))return{accepted:false};
  return{accepted:true,startPackage,targetPackage,startScan,leaseUntil:job.processingUntil};
 });
}
export function createTargetNegativeCollector(job,startPackage,startScan,lossProofs,validGames){
 let selected=[],indexTs=0,months=[],invalid=false,collectedBytes=0;const predecessors=new Map();
 return{
  begin(list,urls){selected=[...urls];indexTs=list.ts;invalid=!selected.length||new Set(selected).size!==selected.length;},
  month(row){if(invalid)return;if(row.negativeInputValid!==true||row.url!==selected[months.length]||!validGames(row.games)){invalid=true;return;}const incoming=lossProofs(job.target,row.games,row.getMonthEdges);if(!incoming){invalid=true;return;}for(const p of incoming)if(!predecessors.has(p.from)){predecessors.set(p.from,p);collectedBytes+=bytes(JSON.stringify(p))+1;}months.push({url:row.url,observedAt:row.observedAt,expiresAt:row.expiresAt});if(collectedBytes>MAX)invalid=true;},
  async finish(){if(invalid||months.length!==selected.length)return null;const chunks=[],pins=[];let rows=[],size=2,total=0;for(const p of predecessors.values()){const amount=bytes(JSON.stringify(p))+1;if(amount+2>CHUNK)return null;if(size+amount>CHUNK){chunks.push(JSON.stringify(rows));rows=[];size=2;}rows.push(p);size+=amount;}chunks.push(JSON.stringify(rows));if(chunks.length>64)return null;for(const text of chunks){total+=bytes(text);pins.push({bytes:bytes(text),sha256:await certificateDigest(text)});}const manifest={version:1,complete:true,scope:certificateScope(job),month:month(),indexTs,selected,months,startDigest:await rootBoundDigest(startPackage),startScanDigest:await certificateDigest(JSON.stringify(startScan)),proofCount:predecessors.size,chunks:pins};if(bytes(JSON.stringify(manifest))>=80*1024||total+bytes(JSON.stringify(manifest))>MAX)return null;const pkg={manifest,chunks};return await unpackRootBound(startPackage,pkg,startScan)?pkg:null;}
 };
}
