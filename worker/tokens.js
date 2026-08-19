const encoder = new TextEncoder();

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function key(secret) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signToken(payload, secret, ttlSeconds = null) {
  const body = { ...payload };
  if (ttlSeconds) body.exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const encoded = base64url(encoder.encode(JSON.stringify(body)));
  const signature = await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(encoded));
  return `${encoded}.${base64url(new Uint8Array(signature))}`;
}

export async function verifyToken(token, secret) {
  if (!token || !secret) return null;
  const [encoded, signature, extra] = String(token).split('.');
  if (!encoded || !signature || extra) return null;
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await key(secret),
      decodeBase64url(signature),
      encoder.encode(encoded)
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64url(encoded)));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}


