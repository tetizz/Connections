// One optional record per operation; dimensions and numeric fields are fixed.
const routes = new Set(['/health','/games','/profile','/leaderboard','/suggest','/search/start','/search/job','/search/warm','/share','/submit','/analytics','/analytics/event']);
const counts = ['cache_fresh','cache_stale','cache_miss','cooldown','cold_fill_owned','cold_fill_shared','cold_fill_overflow','upstream_attempts','upstream_429','upstream_5xx','upstream_transport_errors','partial_enrichment'];
const durations = ['upstream_wall_ms','json_parse_wall_ms'];
const bounded = value => Number.isFinite(value) ? Math.min(3600000, Math.max(0, value)) : 0;
export function requestDimensions(request) {
  const pathname = new URL(request.url).pathname;
  return { route: routes.has(pathname) ? pathname : 'other', method: ['GET','POST','HEAD','OPTIONS'].includes(request.method) ? request.method : 'OTHER' };
}
export function createPerformanceMetrics(env, dimensions, { now = () => performance.now(), emit = value => console.log(value) } = {}) {
  if (env?.PERFORMANCE_METRICS !== 'true' && env?.PERFORMANCE_METRICS !== true) return null;
  const started = now(), values = Object.fromEntries([...counts, ...durations].map(key => [key, 0]));
  let finished = false;
  return {
    now,
    count(key) { if (counts.includes(key)) values[key] = Math.min(1000000, values[key] + 1); },
    duration(key, elapsed) { if (durations.includes(key)) values[key] = bounded(values[key] + bounded(elapsed)); },
    finish(status) {
      if (finished) return; finished = true;
      const handler=dimensions.handler === 'scheduled' ? 'scheduled' : 'fetch';
      const detailed=handler==='fetch'&&['/games','/profile'].includes(dimensions.route);
      const record = { event:'connections_performance_v1', handler, detail_scope:detailed?'primary-cache-and-upstream':'route-only',
        route:routes.has(dimensions.route) ? dimensions.route : 'other',
        method:['GET','POST','HEAD','OPTIONS'].includes(dimensions.method) ? dimensions.method : 'OTHER',
        status:Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500,
        [handler==='fetch'?'response_wall_ms':'operation_wall_ms']:bounded(now()-started),
        ...Object.fromEntries(Object.entries(values).map(([key,value])=>[key,detailed?value:null])) };
      try { emit(record); } catch { /* Diagnostics must not affect the response. */ }
    },
  };
}
