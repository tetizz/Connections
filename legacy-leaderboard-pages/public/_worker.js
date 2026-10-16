// Preserve the legacy API through an internal service binding; no data migration.
const INTERNAL_ORIGIN = 'https://chess-connections-leaderboard.tetizz.workers.dev';

export default {
  fetch(request, env) {
    const source = new URL(request.url);
    const destination = new URL(INTERNAL_ORIGIN);
    destination.pathname = source.pathname;
    destination.search = source.search;
    const forwarded = new Request(destination, request);
    return env.LEGACY_LEADERBOARD.fetch(new Request(forwarded, { redirect: 'manual' }));
  },
};
