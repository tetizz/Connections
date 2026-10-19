// Pages advanced mode: the existing backend remains the sole API authority.
// This origin identifies the internal service request, not a public network hop.
const INTERNAL_ORIGIN = 'https://connections-cache.tetizz.workers.dev';

export default {
  fetch(request, env) {
    const source = new URL(request.url);
    const destination = new URL(INTERNAL_ORIGIN);
    destination.pathname = source.pathname;
    destination.search = source.search;
    const forwarded = new Request(destination, request);
    // Preserve redirects, streams and any runtime-owned upgrade response intact.
    return env.CONNECTIONS.fetch(new Request(forwarded, { redirect: 'manual' }));
  },
};
