// A public search ID authorizes only the exact proof route already admitted by
// a fresh terminal server job. Client scope and decorative proof fields never
// become verification authority.
export async function bindVerifiedJobSubmission({ submission, readSearchJob,
  policyVersion, validSinceMonth, maxAgeMs, now = Date.now }) {
  const searchId = submission?.searchId;
  if (typeof searchId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(searchId)) return null;
  const job = await readSearchJob(searchId);
  const time = now();
  if (!job || job.id !== searchId || job.policyVersion !== policyVersion ||
      job.status !== "found" || job.outcome !== "found" || job.chain?.found !== true ||
      job.start !== submission.start || job.target !== submission.target || job.range !== submission.range ||
      !validSinceMonth(job.search?.sinceMonth) || job.search?.incomplete === true ||
      !Number.isFinite(job.createdAt) || !Number.isFinite(job.updatedAt) ||
      job.updatedAt < job.createdAt || job.updatedAt > time || time - job.createdAt >= maxAgeMs) return null;
  const path = submission.path, hops = submission.hops;
  const serverPath = job.chain.path, serverHops = job.chain.hops;
  if (!Array.isArray(path) || !Array.isArray(hops) || !Array.isArray(serverPath) || !Array.isArray(serverHops) ||
      path.length < 2 || path.length > 64 || path.length !== serverPath.length ||
      hops.length !== path.length - 1 || serverHops.length !== hops.length ||
      path[0] !== job.start || path.at(-1) !== job.target || new Set(path).size !== path.length) return null;
  for (let i = 0; i < path.length; i++) {
    if (typeof path[i] !== "string" || !/^[a-z0-9_-]{1,50}$/.test(path[i]) || path[i] !== serverPath[i]) return null;
  }
  for (let i = 0; i < hops.length; i++) {
    const client = hops[i], server = serverHops[i];
    const match = typeof server?.url === "string" && server.url.match(/^https:\/\/www\.chess\.com\/game\/live\/([1-9]\d*)$/i);
    if (!match || !Number.isSafeInteger(Number(match[1])) ||
        server.from !== path[i] || server.to !== path[i + 1] ||
        client?.from !== server.from || client?.to !== server.to || client?.url !== server.url) return null;
  }
  return { searchId, sinceMonth: job.search.sinceMonth, hops: JSON.parse(JSON.stringify(serverHops)) };
}
