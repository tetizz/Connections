// Job-owned observed input evidence. Never shared route/edge cache authority.
const PREFIX = 'twohop:v1:';
const CHUNK = 32 * 1024, MAX_CHUNKS = 64, MAX_TOTAL = 2 * 1024 * 1024;
const JOB_TTL = 2 * 60 * 60 * 1000, INDEX_TTL = 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();
const bytes = value => encoder.encode(value).length;
const monthNow = () => new Date().toISOString().slice(0, 7).replace('-', '/');
const key = index => `${PREFIX}chunk:${String(index).padStart(3, '0')}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export async function certificateDigest(value) {
  const raw = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(raw)].map(n => n.toString(16).padStart(2, '0')).join('');
}
export function certificateScope(job) {
  return {id:job.id, createdAt:job.createdAt, policyVersion:job.policyVersion,
    start:job.start, target:job.target, range:job.range, sinceMonth:job.search?.sinceMonth};
}
export function eligibleCertificateJob(job, now = Date.now()) {
  return job && job.policyVersion === 'fresh-search-v2' && ['all','auto'].includes(job.range) && job.search?.sinceMonth === '0000/01' &&
    !job.refreshCached && ['queued','running'].includes(job.status) &&
    Number.isFinite(job.createdAt) && now >= job.createdAt && now < job.createdAt + JOB_TTL;
}
function owns(job, input) {
  return eligibleCertificateJob(job) && same(certificateScope(job), input.scope) &&
    typeof input.token === 'string' && input.token.length >= 8 &&
    job.processingToken === input.token && Number(job.processingUntil) > Date.now();
}
function validManifest(m) {
  const now = Date.now();
  return m?.schema === 1 && m.complete === true && m.month === monthNow() &&
    m.scope?.sinceMonth === '0000/01' && now < m.scope.createdAt + JOB_TTL &&
    Number.isFinite(m.indexTs) && m.indexTs <= now && m.indexTs + INDEX_TTL > now &&
    Array.isArray(m.selected) && m.selected.length > 0 && new Set(m.selected).size === m.selected.length &&
    Array.isArray(m.months) && m.months.length === m.selected.length &&
    m.months.every((row,i) => row && row.url === m.selected[i] && Number.isFinite(row.observedAt) && row.observedAt >= m.scope.createdAt && row.observedAt <= now &&
      Number.isFinite(row.expiresAt) && ['cache','provider'].includes(row.source) &&
      Number.isInteger(row.gamesCount) && row.gamesCount >= 0 && Number.isInteger(row.winnerCount) && row.winnerCount >= 0 && row.winnerCount <= row.gamesCount && row.directAbsent === true &&
      (row.kind === 'historical' ? Number.isFinite(row.expiresAt) && row.expiresAt > now :
        row.kind === 'job-current-observation' && row.url.slice(-7) === m.month &&
        ['provider','cache'].includes(row.source) && (row.source !== 'cache' || row.expiresAt > row.observedAt))) &&
    Array.isArray(m.chunks) && m.chunks.length > 0 && m.chunks.length <= MAX_CHUNKS &&
    m.chunks.every(row => row && Number.isInteger(row.bytes) && row.bytes > 0 && row.bytes <= CHUNK && /^[0-9a-f]{64}$/.test(row.sha256)) &&
    Number.isInteger(m.proofCount) && m.proofCount > 0 && Number.isFinite(m.scanEndedAt) && m.scanEndedAt <= now;
}
export async function unpackCertificate(pkg) {
  if (!pkg || !validManifest(pkg.manifest) || !Array.isArray(pkg.chunks) || pkg.chunks.length !== pkg.manifest.chunks.length) return null;
  let total = bytes(JSON.stringify(pkg.manifest));
  const proofs = [], seen = new Set();
  for (let i=0;i<pkg.chunks.length;i++) {
    const body = pkg.chunks[i], pin = pkg.manifest.chunks[i];
    if (typeof body !== 'string' || bytes(body) !== pin.bytes || await certificateDigest(body) !== pin.sha256) return null;
    total += pin.bytes;
    if (total > MAX_TOTAL) return null;
    let rows; try { rows = JSON.parse(body); } catch { return null; }
    if (!Array.isArray(rows)) return null;
    for (const row of rows) {
      if (!row || row.from !== pkg.manifest.scope.start || typeof row.to !== 'string' || seen.has(row.to) ||
          !/^[a-z0-9_-]{1,50}$/.test(row.to) || row.to === row.from || row.to === pkg.manifest.scope.target ||
          !/^https:\/\/www\.chess\.com\/game\/live\/[1-9]\d*$/.test(row.url) ||
          row.result !== 'win' || !['white','black'].includes(row.color) || row.timeClass === 'daily' ||
          typeof row.timeClass !== 'string' || typeof row.opening !== 'string' ||
          !(row.endTime === null || Number.isFinite(row.endTime))) return null;
      seen.add(row.to); proofs.push(row);
    }
  }
  return proofs.length === pkg.manifest.proofCount ? {manifest:pkg.manifest, proofs} : null;
}
export async function certificateAction(storage, action, input) {
  if (!['twohop-commit','twohop-read'].includes(action) || typeof storage.transaction !== 'function') return {accepted:false};
  if (action === 'twohop-commit') {
    const verified = await unpackCertificate(input.package);
    if (!verified || !same(input.scope, verified.manifest.scope)) return {accepted:false};
    return storage.transaction(async txn => {
      const job = await txn.get('job');
      if (!owns(job, input) || !validManifest(verified.manifest)) return {accepted:false};
      const entries = {[`${PREFIX}manifest`]:input.package.manifest};
      input.package.chunks.forEach((body,i) => {entries[key(i)] = body;});
      await txn.put(entries);
      const unused = Array.from({length:MAX_CHUNKS-input.package.chunks.length},(_,i)=>key(i+input.package.chunks.length));
      if (unused.length) await txn.delete(unused);
      return {accepted:true};
    });
  }
  const pkg = await storage.transaction(async txn => {
    const job = await txn.get('job');
    if (!owns(job, input)) return null;
    const manifest = await txn.get(`${PREFIX}manifest`);
    if (!validManifest(manifest) || !same(manifest.scope, input.scope)) return null;
    const keys = manifest.chunks.map((_,i)=>key(i));
    const found = await txn.get(keys);
    if (!(found instanceof Map)) return null;
    return {manifest, chunks:keys.map(k=>found.get(k))};
  });
  return await unpackCertificate(pkg) ? {accepted:true, package:pkg} : {accepted:false};
}
export function startCertificateCollector(job, winProofs, validGames) {
  let selected = null, indexTs = 0, invalid = false, collectedBytes = 0;
  const months = [], winners = new Map(), scope = certificateScope(job), month = monthNow();
  return {
    begin(list, urls) {
      selected = [...urls]; indexTs = list.ts;
      if (!selected.length || bytes(JSON.stringify(selected)) > MAX_TOTAL || new Set(selected).size !== selected.length || selected.some(url=>url.slice(-7)>month)) invalid = true;
    },
    month(row) {
      if (invalid || !selected || row.url !== selected[months.length] || !validGames(row.games)) {invalid=true;return;}
      const kind = row.url.slice(-7) < month ? 'historical' : 'job-current-observation';
      if (kind === 'historical' && row.expiresAt <= Date.now()) {invalid=true;return;}
      const proofs = winProofs(job.start, row.games, row.getMonthEdges);
      if (!proofs) {invalid=true;return;}
      for (const proof of proofs) if (!winners.has(proof.to)) {
        if (proof.to === job.target) {invalid=true;return;}
        const body = JSON.stringify(proof); collectedBytes += bytes(body) + 1;
        if (collectedBytes > MAX_TOTAL) {invalid=true;winners.clear();return;}
        winners.set(proof.to, proof);
      }
      months.push({url:row.url, observedAt:row.observedAt, expiresAt:row.expiresAt, source:row.source, kind,
        gamesCount:row.games.length,winnerCount:proofs.length,directAbsent:true});
    },
    async finish() {
      if (invalid || !selected || months.length !== selected.length || !winners.size) return null;
      const chunks = []; let rows = [], size = 2;
      for (const proof of winners.values()) {
        const amount = bytes(JSON.stringify(proof)) + (rows.length ? 1 : 0);
        if (amount + 2 > CHUNK) return null;
        if (size + amount > CHUNK) {chunks.push(JSON.stringify(rows));rows=[];size=2;}
        rows.push(proof); size += amount;
      }
      if (rows.length) chunks.push(JSON.stringify(rows));
      if (chunks.length > MAX_CHUNKS) return null;
      const pins = [];
      for (const body of chunks) pins.push({bytes:bytes(body), sha256:await certificateDigest(body)});
      const manifest = {schema:1, complete:true, scope, month, selected, indexTs, months,
        scanEndedAt:Date.now(), proofCount:winners.size, chunks:pins};
      const pkg = {manifest,chunks};
      return await unpackCertificate(pkg) ? pkg : null;
    },
  };
}
export class TwoHopWitness extends Error {
  constructor(chain) {super('Two-hop witness within completed observed start scope');this.chain=chain;}
}