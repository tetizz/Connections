// Browser API requests stay on the same Pages origin. The existing private
// backend remains the only search, storage and proof authority.
const INTERNAL_ORIGIN = 'https://connections-cache.tetizz.workers.dev';

export default {
  async fetch(request, env) {
    const source = new URL(request.url);
    if (source.pathname !== '/api' && !source.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }
    const destination = new URL(INTERNAL_ORIGIN);
    destination.pathname = source.pathname.slice(4) || '/';
    destination.search = source.search;
    try {
      const forwarded = new Request(destination, request);
      return await env.CONNECTIONS.fetch(new Request(forwarded, {redirect:'manual'}));
    } catch {
      return new Response(JSON.stringify({
        error:'The search service is temporarily unavailable. Retrying the same search is safe.',
        code:'SEARCH_SERVICE_UNAVAILABLE',
        retryable:true,
      }), {status:503,headers:{
        'Content-Type':'application/json; charset=utf-8',
        'Cache-Control':'no-store',
        'Retry-After':'3',
      }});
    }
  },
};
