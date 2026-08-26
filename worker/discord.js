const API = 'https://discord.com/api/v10';
const CACHE_MS = 10 * 60 * 1000;

let credentialsCache = null;

function basicAuth(clientId, clientSecret) {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

function configuredAdminIds(env) {
  return String(env.ADMIN_DISCORD_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

async function fetchCredentials(env) {
  if (credentialsCache && credentialsCache.expiresAt > Date.now()) return credentialsCache;
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) return null;

  const tokenResponse = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: basicAuth(env.DISCORD_CLIENT_ID, env.DISCORD_CLIENT_SECRET),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'identify' }),
  });
  const token = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !token.access_token) return null;

  const headers = { authorization: `Bearer ${token.access_token}` };
  const [applicationResponse, ownerResponse] = await Promise.all([
    fetch(`${API}/oauth2/applications/@me`, { headers }),
    fetch(`${API}/users/@me`, { headers }),
  ]);
  const application = await applicationResponse.json().catch(() => ({}));
  const owner = await ownerResponse.json().catch(() => ({}));

  const ids = new Set(configuredAdminIds(env));
  if (application.owner?.id) ids.add(application.owner.id);
  if (owner?.id) ids.add(owner.id);
  for (const member of application.team?.members || []) {
    if (member.membership_state === 2 && member.user?.id) ids.add(member.user.id);
  }

  credentialsCache = {
    application,
    owner,
    adminIds: ids,
    expiresAt: Date.now() + CACHE_MS,
  };
  return credentialsCache;
}

export async function isApplicationAdmin(env, userId) {
  if (!userId) return false;
  if (configuredAdminIds(env).includes(String(userId))) return true;
  try {
    return Boolean((await fetchCredentials(env))?.adminIds.has(String(userId)));
  } catch {
    return false;
  }
}

export async function applicationMetadata(env) {
  try {
    return (await fetchCredentials(env))?.application ?? null;
  } catch {
    return null;
  }
}

async function publicApplication(clientId) {
  if (!clientId) return null;
  try {
    const response = await fetch(`${API}/oauth2/applications/${encodeURIComponent(clientId)}/rpc`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function currentGuild(accessToken, guildId) {
  if (!accessToken || !guildId) return null;
  try {
    const response = await fetch(`${API}/users/@me/guilds`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const guilds = await response.json();
    const guild = guilds.find((item) => item.id === String(guildId));
    if (!guild) return null;
    return {
      id: guild.id,
      name: guild.name,
      icon: guild.icon ?? null,
      owner: guild.owner === true,
      permissions: String(guild.permissions || '0'),
    };
  } catch {
    return null;
  }
}

const ADMINISTRATOR = 8n;
const MANAGE_GUILD = 32n;
const MODERATION_PERMISSIONS = 2n | 4n | 16n | 8192n | 1099511627776n;

/**
 * Converte as permissões oficiais do servidor em uma função simples da
 * atividade. O resultado entra em tokens assinados; o cliente nunca escolhe o
 * próprio nível de acesso.
 */
export function guildRole(guild) {
  if (!guild) return 'user';
  let permissions = 0n;
  try { permissions = BigInt(guild.permissions || '0'); } catch {}
  if (guild.owner || (permissions & (ADMINISTRATOR | MANAGE_GUILD))) return 'server_admin';
  if (permissions & MODERATION_PERMISSIONS) return 'moderator';
  return 'user';
}

function hexBytes(value) {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2) return null;
  return Uint8Array.from(value.match(/.{2}/g), (pair) => Number.parseInt(pair, 16));
}

export async function verifyDiscordRequest(request, rawBody, env) {
  const signature = hexBytes(request.headers.get('x-signature-ed25519') || '');
  const timestamp = request.headers.get('x-signature-timestamp') || '';
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)
    || Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > 5 * 60) return false;
  let publicKeyHex = env.DISCORD_PUBLIC_KEY || '';
  if (!publicKeyHex) {
    const application = await publicApplication(env.DISCORD_CLIENT_ID) || await applicationMetadata(env);
    publicKeyHex = application?.verify_key || '';
  }
  const publicKey = hexBytes(publicKeyHex);
  if (!signature || !timestamp || !publicKey) return false;

  try {
    const key = await crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);
    return crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      signature,
      new TextEncoder().encode(timestamp + rawBody)
    );
  } catch {
    return false;
  }
}
