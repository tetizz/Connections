// Pages advanced mode: the existing backend remains the sole API authority.
// This origin identifies the internal service request, not a public network hop.
const INTERNAL_ORIGIN = 'https://connections-cache.tetizz.workers.dev';

export default {
  async fetch(request, env) {
    const source = new URL(request.url);
    const destination = new URL(INTERNAL_ORIGIN);
    destination.pathname = source.pathname;
    destination.search = source.search;
    const forwarded = new Request(destination, request);
    // Preserve redirects, streams and any runtime-owned upgrade response intact.
    try {
      return await env.CONNECTIONS.fetch(new Request(forwarded, { redirect: 'manual' }));
    } catch {
      // A runtime/service failure must still be readable by the browser so it
      // can retry the same search ID instead of silently changing engines.
      return new Response(JSON.stringify({
        error: 'The search service is temporarily unavailable. Retrying the same search is safe.',
        code: 'SEARCH_SERVICE_UNAVAILABLE',
        retryable: true,
      }), {
        status: 503,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Retry-After': '3',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Accept, Content-Type, X-Owner-Code',
        },
      });
    }
  },
};
