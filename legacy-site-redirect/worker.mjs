// Legacy frontend only. Fixed destination; no bindings or upstream requests.
const destination = 'https://tetizz-connections.pages.dev';
export default {
  fetch(request) {
    const incoming = new URL(request.url);
    const target = new URL(destination);
    target.pathname = incoming.pathname;
    target.search = incoming.search;
    return new Response(null, {
      status: 308,
      headers: { Location: target.href, 'Cache-Control': 'no-store' },
    });
  },
};
