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
