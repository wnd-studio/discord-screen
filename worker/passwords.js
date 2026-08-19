const encoder = new TextEncoder();

function encode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decode(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function derive(password, salt) {
  const material = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 120_000 }, material, 256
  ));
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: encode(salt), hash: encode(await derive(String(password), salt)) };
}

export async function passwordMatches(saved, password) {
  if (!saved) return true;
  const actual = await derive(String(password ?? ''), decode(saved.salt));
  const expected = decode(saved.hash);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual[i] ^ expected[i];
  return difference === 0;
}


