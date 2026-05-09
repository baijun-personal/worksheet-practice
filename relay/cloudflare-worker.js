// worksheet-openai-proxy — Cloudflare Worker
// ------------------------------------------------------------
// Forwards POSTs from the worksheet-practice app to OpenAI's
// chat/completions endpoint. The OpenAI key never leaves the Worker.
// The frontend authenticates with a per-deploy token in the
// X-Proxy-Token header.
//
// Cloudflare secrets required (Workers → Settings → Variables):
//   OPENAI_API_KEY  — your real OpenAI sk-... key
//   PROXY_TOKEN     — any random string; share with the device(s)
//                     that should be allowed to use this Worker
//
// Frontend config (Setup → Advanced settings → API mode = Proxy):
//   Proxy URL    = https://<your-worker>.workers.dev
//   Proxy token  = same value as PROXY_TOKEN secret
//
// CORS: only the GitHub Pages origin (and localhost for dev) are
// echoed back; other origins get a generic value. CORS is NOT the
// security boundary — the token check is.

const ALLOWED_ORIGINS = [
  'https://baijun-personal.github.io',
  'http://localhost:8765',
  'http://localhost:5173',
  'http://127.0.0.1:8765',
];

const UPSTREAM = 'https://api.openai.com/v1/chat/completions';

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Proxy-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function jsonResponse(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed. Use POST.' }, 405, cors);
    }

    // Auth: required token
    const token = request.headers.get('X-Proxy-Token') || '';
    if (!env.PROXY_TOKEN) {
      return jsonResponse(
        { error: 'Server misconfigured: PROXY_TOKEN secret is not set on the Worker.' },
        500, cors,
      );
    }
    if (token !== env.PROXY_TOKEN) {
      return jsonResponse({ error: 'Unauthorized' }, 401, cors);
    }

    if (!env.OPENAI_API_KEY) {
      return jsonResponse(
        { error: 'Server misconfigured: OPENAI_API_KEY secret is not set on the Worker.' },
        500, cors,
      );
    }

    // Read the body and forward it as-is to OpenAI. We don't parse or
    // mutate it — fewer surprises if OpenAI adds new fields, and it
    // keeps the Worker stateless.
    let body;
    try {
      body = await request.text();
    } catch (e) {
      return jsonResponse(
        { error: 'Could not read request body', detail: String(e && e.message || e) },
        400, cors,
      );
    }

    if (!body) {
      return jsonResponse({ error: 'Empty request body' }, 400, cors);
    }

    let upstream;
    try {
      upstream = await fetch(UPSTREAM, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body,
      });
    } catch (e) {
      return jsonResponse(
        {
          error: 'Upstream fetch to OpenAI failed',
          detail: String(e && e.message || e),
        },
        502, cors,
      );
    }

    // Pass the upstream response through. We override CORS headers
    // (the upstream's CORS is for its own origin) and the Content-Type
    // (default to JSON if missing). Status + body are preserved.
    const responseBody = await upstream.arrayBuffer();
    return new Response(responseBody, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: {
        ...cors,
        'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
      },
    });
  },
};
