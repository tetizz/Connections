// Job-owned bidirectional BFS. Queues and visited records live in native
// storage, so a large frontier is never sliced away or copied into job JSON.
const PREFIX = 'full-bfs:v1:';
// Two visited lookups per edge stay within the native 128-key batch limit.
const PAGE = 64;
const name = value => typeof value === 'string' && /^[a-z0-9_-]{1,50}$/.test(value) ? value : '';
const proof = value => typeof value === 'string' && /^https:\/\/www\.chess\.com\/game\/live\/[1-9]\d*$/.test(value) ? value : '';
const nodeKey = (side, user) => `${PREFIX}visited:${side}:${user}`;
const queueKey = (side, depth, page) => `${PREFIX}queue:${side}:${depth}:${page}`;
const stageKey = page => `${PREFIX}stage:${page}`;
const metaKey = `${PREFIX}meta`;
const otherSide = side => side === 'forward' ? 'backward' : 'forward';
const equalScope = (meta, job) => meta.start === job.start && meta.target === job.target && meta.sinceMonth === job.search?.sinceMonth;
const owns = (job, token) => job?.policyVersion === 'fresh-search-v2' && ['running','queued'].includes(job.status) &&
  job.processingToken === token && Number(job.processingUntil) > Date.now() && job.search?.sinceMonth === '0000/01';
async function readMany(storage, keys) {
  if (!keys.length) return new Map();
  const values = await storage.get(keys);
  return values instanceof Map ? values : new Map(keys.map(key => [key, values?.[key]]));
}
async function append(storage, meta, side, user, updates) {
  const layer = meta.layers[side], offset = layer.next++;
  const key = queueKey(side, layer.depth + 1, Math.floor(offset / PAGE));
  const page = updates[key] || await storage.get(key) || [];
  page.push(user); updates[key] = page;
}
async function initialize(storage, job) {
  let meta = await storage.get(metaKey);
  if (meta) return equalScope(meta, job) ? meta : null;
  meta = {schema:1,start:job.start,target:job.target,sinceMonth:job.search.sinceMonth,version:0,
    active:'', incomplete:false, incompleteCount:0, expanded:0, visited:2, best:null, staged:null,
    layers:{forward:{depth:0,count:1,cursor:0,next:0},backward:{depth:0,count:1,cursor:0,next:0}}};
  await storage.put({[metaKey]:meta,
    [nodeKey('forward',job.start)]:{link:'',url:'',depth:0},
    [nodeKey('backward',job.target)]:{link:'',url:'',depth:0},
    [queueKey('forward',0,0)]:[job.start],[queueKey('backward',0,0)]:[job.target]});
  return meta;
}
async function reconstruct(storage, meta, meeting, overrides = {}) {
  const get = async (side,user) => overrides[nodeKey(side,user)] || await storage.get(nodeKey(side,user));
  const before=[], after=[], left=[], right=[];
  let current=meeting;
  const seen=new Set();
  while(current!==meta.start) {
    if(!current||seen.has(current))return null;
    seen.add(current);const row=await get('forward',current);if(!row?.link||!proof(row.url))return null;
    before.push({from:row.link,to:current,url:row.url});left.push(current);current=row.link;
  }
  left.push(meta.start);left.reverse();before.reverse();current=meeting;seen.clear();
  while(current!==meta.target) {
    if(!current||seen.has(current))return null;
    seen.add(current);const row=await get('backward',current);if(!row?.link||!proof(row.url))return null;
    after.push({from:current,to:row.link,url:row.url});right.push(row.link);current=row.link;
  }
  const path=[...left,...right];if(new Set(path).size!==path.length)return null;
  return {path,hops:[...before,...after]};
}
function choose(meta) {
  const f=meta.layers.forward,b=meta.layers.backward;
  const forward=f.count-f.cursor,backward=b.count-b.cursor;
  if(!forward&&!backward)return '';
  if(!forward||!backward) {
    if(!meta.incomplete)return '';
    return forward?'forward':'backward';
  }
  if(meta.prefer&&meta.layers[meta.prefer].count>meta.layers[meta.prefer].cursor) {
    const preferred=meta.prefer;meta.prefer='';return preferred;
  }
  return forward<=backward?'forward':'backward';
}
async function deferCurrent(storage,meta,node) {
  const side=meta.active,layer=meta.layers[side],offset=layer.count++;
  const key=queueKey(side,layer.depth,Math.floor(offset/PAGE));
  const page=await storage.get(key)||[];page.push(node);await storage.put(key,page);
  const pendingKey=nodeKey('incomplete',node);
  if(!await storage.get(pendingKey)){await storage.put(pendingKey,true);meta.incompleteCount++;}
  meta.incomplete=true;layer.cursor++;meta.active='';meta.prefer=otherSide(side);meta.staged=null;
}
function result(meta) {
  return {accepted:true, version:meta.version, expanded:meta.expanded, visited:meta.visited,
    incomplete:meta.incomplete, best:meta.best?.chain || null, terminal:meta.terminal || null};
}
export async function pagedSearchAction(storage, action, input = {}) {
  if(typeof storage.transaction!=='function')return{accepted:false};
  return storage.transaction(async () => {
    const job=await storage.get('job');
    if(!owns(job,input.token))return{accepted:false};
    const meta=await initialize(storage,job);if(!meta)return{accepted:false};
    if(action==='full-bfs-load') {
      if(meta.terminal)return result(meta);
      if(!meta.active) {
        meta.active=choose(meta);
        if(!meta.active) {
          if(meta.incomplete)return {...result(meta),waiting:true};
          meta.terminal={status:meta.best?'found':'not_found',shortestVerified:Boolean(meta.best&&!meta.incomplete)};
          await storage.put(metaKey,meta);return result(meta);
        }
      }
      const layer=meta.layers[meta.active],page=await storage.get(queueKey(meta.active,layer.depth,Math.floor(layer.cursor/PAGE)));
      const user=page?.[layer.cursor%PAGE];if(!name(user))return{accepted:false};
      await storage.put(metaKey,meta);
      return {...result(meta),side:meta.active,node:user,staged:Boolean(meta.staged),depth:layer.depth};
    }
    if(input.version!==meta.version)return{accepted:false};
    const side=meta.active,layer=meta.layers[side];if(!side||!layer)return{accepted:false};
    if(action==='full-bfs-defer') {
      const page=await storage.get(queueKey(side,layer.depth,Math.floor(layer.cursor/PAGE)));
      if(meta.staged||input.node!==page?.[layer.cursor%PAGE])return{accepted:false};
      await deferCurrent(storage,meta,input.node);meta.version++;await storage.put(metaKey,meta);return result(meta);
    }
    if(action==='full-bfs-stage') {
      if(meta.staged)return{accepted:false};
      const page=await storage.get(queueKey(side,layer.depth,Math.floor(layer.cursor/PAGE)));
      if(input.node!==page?.[layer.cursor%PAGE]||!Array.isArray(input.edges))return{accepted:false};
      const rows=[],seen=new Set();
      for(const row of input.edges) {
        if(!Array.isArray(row)||!name(row[0])||!proof(row[1]))return{accepted:false};
        if(!seen.has(row[0])){seen.add(row[0]);rows.push([row[0],row[1]]);}
      }
      for(let offset=0;offset<rows.length;offset+=PAGE)await storage.put(stageKey(offset/PAGE),rows.slice(offset,offset+PAGE));
      meta.staged={node:input.node,count:rows.length,cursor:0,incomplete:Boolean(input.incomplete)};
      await storage.put(`${PREFIX}observation:${input.node}`,{
        observedAt:Number.isFinite(input.observedAt)?input.observedAt:Date.now(),
        expiresAt:Number.isFinite(input.expiresAt)?input.expiresAt:0,
        complete:!input.incomplete,
      });
      // Partial upstream histories are retried, never accepted as negative evidence.
      const pendingKey=nodeKey('incomplete',input.node);
      if(input.incomplete&&!await storage.get(pendingKey)) {
        await storage.put(pendingKey,true);meta.incompleteCount++;
      }
      meta.incomplete=meta.incompleteCount>0;
      meta.version++;await storage.put(metaKey,meta);return result(meta);
    }
    if(action!=='full-bfs-advance'||!meta.staged)return{accepted:false};
    const staged=meta.staged, rows=staged.cursor<staged.count?await storage.get(stageKey(Math.floor(staged.cursor/PAGE))):[];
    if(!Array.isArray(rows))return{accepted:false};
    const other=otherSide(side),updates={},current=await storage.get(nodeKey(side,staged.node));
    if(!current)return{accepted:false};
    const keys=rows.flatMap(([user])=>[nodeKey(side,user),nodeKey(other,user)]);
    const existing=await readMany(storage,keys);
    for(const [user,url] of rows) {
      const ownKey=nodeKey(side,user);if(existing.has(ownKey))continue;
      updates[ownKey]={link:staged.node,url,depth:current.depth+1};meta.visited++;
      const opposite=existing.get(nodeKey(other,user));
      if(opposite) {
        const length=current.depth+1+opposite.depth;
        if(!meta.best||length<meta.best.length) {
          const chain=await reconstruct(storage,meta,user,updates);
          if(chain)meta.best={length,chain};
        }
      }
      await append(storage,meta,side,user,updates);
    }
    staged.cursor+=rows.length;
    if(staged.cursor>=staged.count) {
      // Keep incomplete nodes in this layer so missing archives can be retried.
      if(staged.incomplete) {
        await deferCurrent(storage,meta,staged.node);meta.version++;
        await storage.put({...updates,[metaKey]:meta});
        return {...result(meta),retry:true};
      }
      const pendingKey=nodeKey('incomplete',staged.node);
      if(await storage.get(pendingKey)) {
        await storage.delete(pendingKey);meta.incompleteCount=Math.max(0,meta.incompleteCount-1);
      }
      meta.incomplete=meta.incompleteCount>0;
      meta.expanded++;layer.cursor++;meta.staged=null;
      if(layer.cursor>=layer.count) {
        if(meta.best&&!meta.incomplete)meta.terminal={status:'found',shortestVerified:true};
        layer.depth++;layer.count=layer.next;layer.cursor=0;layer.next=0;meta.active='';
      }
      meta.active='';
    }
    // Current depths are fully discovered radii: only complete histories move
    // a layer forward. Any shorter path must intersect those two discovered
    // balls, so a witnessed path within their sum plus one is already optimal.
    // Pending histories at the current radii cannot hide a shorter path.
    if(meta.best&&meta.best.length<=meta.layers.forward.depth+meta.layers.backward.depth+1)
      meta.terminal={status:'found',shortestVerified:true};
    meta.version++;await storage.put({...updates,[metaKey]:meta});return result(meta);
  });
}
