const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const CODE_RE = /^[A-Za-z0-9_-]{8,128}$/;

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...headers,
    },
  });

export function allowedOrigins(env) {
  return new Set(
    String(env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((value) => value.trim().replace(/\/+$/, ''))
      .filter(Boolean)
  );
}

function corsHeaders(origin, allowed) {
  return allowed
    ? {
        'access-control-allow-origin': origin,
        vary: 'Origin',
      }
    : {
        vary: 'Origin',
      };
}

export async function handle(
  request,
  env,
  fetchImpl = globalThis.fetch
) {
  const origins = allowedOrigins(env);
  const origin = request.headers.get('origin') || '';
  const originAllowed = origins.has(origin);
  const cors = corsHeaders(origin, originAllowed);

  if (request.method === 'OPTIONS') {
    if (!originAllowed) {
      return json(403, { error: 'origin_not_allowed' }, cors);
    }

    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
      },
    });
  }

  if (request.method !== 'POST') {
    return json(
      405,
      { error: 'method_not_allowed' },
      {
        ...cors,
        allow: 'POST, OPTIONS',
      }
    );
  }

  if (!originAllowed) {
    return json(403, { error: 'origin_not_allowed' }, cors);
  }

  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return json(500, { error: 'not_configured' }, cors);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'invalid_json' }, cors);
  }

  const code = body?.code;
  const redirectUri = body?.redirect_uri;

  if (
    typeof code !== 'string' ||
    !CODE_RE.test(code)
  ) {
    return json(400, { error: 'invalid_code' }, cors);
  }

  if (typeof redirectUri !== 'string') {
    return json(
      400,
      { error: 'invalid_redirect_uri' },
      cors
    );
  }

  let redirectOrigin;

  try {
    redirectOrigin = new URL(redirectUri).origin;
  } catch {
    return json(
      400,
      { error: 'invalid_redirect_uri' },
      cors
    );
  }

  if (!origins.has(redirectOrigin)) {
    return json(
      400,
      { error: 'invalid_redirect_uri' },
      cors
    );
  }

  let response;

  try {
    response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      }),
    });
  } catch {
    return json(
      502,
      { error: 'github_unreachable' },
      cors
    );
  }

  let data;

  try {
    data = await response.json();
  } catch {
    return json(
      502,
      { error: 'invalid_github_response' },
      cors
    );
  }

  if (!data || data.error || !data.access_token) {
    return json(
      400,
      {
        error: data?.error || 'exchange_failed',
      },
      cors
    );
  }

  return json(
    200,
    {
      access_token: data.access_token,
      token_type: data.token_type || 'bearer',
      scope: data.scope || '',
    },
    cors
  );
}