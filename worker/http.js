export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

export const error = (message, status = 400, extra = {}) =>
  json({ error: message, ...extra }, status);

export async function body(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export function withSecurityHeaders(response) {
  const result = new Response(response.body, response);
  result.headers.set(
    'Content-Security-Policy',
    "frame-ancestors 'self' https://discord.com https://*.discord.com https://*.discordsays.com"
  );
  result.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  result.headers.set('X-Content-Type-Options', 'nosniff');
  result.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  result.headers.set('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  result.headers.set('X-Permitted-Cross-Domain-Policies', 'none');
  if (!result.headers.has('cache-control') && result.headers.get('content-type')?.includes('application/json')) {
    result.headers.set('Cache-Control', 'no-store');
  }
  return result;
}


