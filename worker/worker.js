const ALLOWED_ORIGIN = 'https://mdmcqueen.github.io';
const TODOIST_BASE = 'https://api.todoist.com/api/v1';

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const corsHeaders = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (origin !== ALLOWED_ORIGIN) {
      return new Response('Forbidden', { status: 403 });
    }

    const url = new URL(request.url);

    // --- calendar feed passthrough -------------------------------------
    // calendar.google.com serves the "secret address in iCal format" feeds
    // but sends no CORS headers, so the app cannot read them directly
    // (verified from the live origin: a plain fetch throws, a no-cors fetch
    // of the same host succeeds). Read the feed here and hand it back with
    // CORS so the Week/Today tabs can work without any Google sign-in.
    //
    // Deliberately NOT a general proxy: without the checks below this
    // endpoint would fetch anything on the internet for anyone who has the
    // Worker URL.
    if (url.pathname === '/ical') {
      const target = url.searchParams.get('u');
      let ok = false;
      try {
        const t = new URL(target);
        ok = t.protocol === 'https:' &&
             t.hostname === 'calendar.google.com' &&
             t.pathname.startsWith('/calendar/ical/') &&
             t.pathname.endsWith('.ics');
      } catch (_) {
        ok = false;
      }
      // The feed URL is a credential: never echo it back, never log it.
      if (!ok) {
        return new Response('bad feed url', { status: 400, headers: corsHeaders });
      }

      const feed = await fetch(target, {
        // Cached by full URL, so only a caller who already knows the secret
        // address can retrieve it. 5 minutes: calendar edits take up to that
        // long to appear. Google's own feeds are not instant either.
        cf: { cacheTtl: 300, cacheEverything: true },
      });
      if (!feed.ok) {
        return new Response('feed ' + feed.status, { status: 502, headers: corsHeaders });
      }
      return new Response(feed.body, {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/calendar; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
        },
      });
    }
    // --- end calendar feed passthrough ----------------------------------

    const todoistUrl = TODOIST_BASE + url.pathname + url.search;
    const todoistResp = await fetch(todoistUrl, {
      method: request.method,
      headers: {
        Authorization: request.headers.get('Authorization') || '',
        'Content-Type': request.headers.get('Content-Type') || '',
      },
      body: ['GET', 'HEAD'].includes(request.method) ? null : request.body,
    });

    return new Response(todoistResp.body, {
      status: todoistResp.status,
      headers: { ...Object.fromEntries(todoistResp.headers), ...corsHeaders },
    });
  },
};
