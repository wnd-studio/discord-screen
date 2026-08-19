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
  return result;
}


