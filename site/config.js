// The hosted site uses a same-origin service binding. Local static servers and
// older static hosts can still use the independently deployed Pages API.
window.CONNECTIONS_CACHE_API = /(^|\.)tetizz-connections\.pages\.dev$/.test(window.location.hostname)
  ? new URL('/api', window.location.origin).href
  : 'https://tetizz-connections-api.pages.dev';
