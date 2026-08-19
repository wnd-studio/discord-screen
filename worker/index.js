import { json, error, body, withSecurityHeaders } from './http.js';
import { signToken, verifyToken } from './tokens.js';
export { Room } from './room.js';
export { RoomRegistry } from './registry.js';

const WEB_INSTANCE = 'web';
const ROOM_NAME_MAX = 40;

function originFor(request, env) {
  return String(env.PUBLIC_ORIGIN || new URL(request.url).origin).replace(/\/+$/, '');
}

function roomStub(env, id) {
  return env.ROOMS.get(env.ROOMS.idFromName(id));
}

function registry(env) {
  return env.ROOM_INDEX.get(env.ROOM_INDEX.idFromName('global'));
}

async function internal(stub, path, payload = null, method = 'POST') {
  const response = await stub.fetch(`https://internal${path}`, payload === null ? {} : {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function identityOf(data, env) {
  const identity = await verifyToken(data.identity, env.SESSION_SECRET);
  return identity?.scope === 'identity' ? identity : null;
}

async function issueIdentity(env, instance, uid, name, avatar, ttl = 8 * 60 * 60, extra = {}) {
  return {
    user: { id: uid, name, avatar },
    instance,
    identity: await signToken(
      { instance, uid, name, av: avatar, scope: 'identity', ...extra },
      env.SESSION_SECRET,
      ttl
    ),
  };
}

async function issueRoomTokens(request, env, roomId, me) {
  const base = { room: roomId, uid: me.uid, name: me.name, avatar: me.av ?? null };
  const viewerToken = await signToken({ ...base, role: 'viewer' }, env.SESSION_SECRET);
  const broadcasterToken = await signToken({ ...base, role: 'broadcaster' }, env.SESSION_SECRET);
  return {
    roomId,
    viewerToken,
    shareUrl: `${originFor(request, env)}/share.html?t=${encodeURIComponent(broadcasterToken)}`,
  };
}

async function discordToken(env, parameters) {
  return fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      ...parameters,
    }),
  }).then((response) => response.json());
}

async function inVoiceChannel(env, guildId, channelId, userId) {
  if (!env.DISCORD_BOT_TOKEN || !guildId || !channelId) return 'indisponivel';
  try {
    const response = await fetch(`https://discord.com/api/v10/guilds/${guildId}/voice-states/${userId}`, {
      headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
    });
    if (response.status === 404) {
      const problem = await response.json().catch(() => ({}));
      return problem.code === 10004 ? 'indisponivel' : 'fora';
    }
    if (!response.ok) return 'indisponivel';
    return (await response.json()).channel_id === channelId ? 'ok' : 'fora';
  } catch {
    return 'indisponivel';
  }
}

async function api(request, env, url) {
  const data = request.method === 'POST' ? await body(request) : {};

  if (url.pathname === '/api/health') return json({ ok: true, architecture: 'cloudflare-workers-durable-objects' });
  if (url.pathname === '/api/config') return json({ clientId: env.DISCORD_CLIENT_ID || null, asset: null }, 200, { 'cache-control': 'no-store' });

  if (url.pathname === '/api/token' && request.method === 'POST') {
    if (!data.code) return error('code obrigatorio');
    if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) return error('Credenciais do Discord não configuradas.', 500);
    if (data.client_id && data.client_id !== env.DISCORD_CLIENT_ID) return error('A Activity e o Worker usam Client IDs diferentes.', 409);
    const token = await discordToken(env, { code: data.code });
    if (!token.access_token) return error(`O Discord recusou o login: ${token.error_description || token.error || 'motivo não informado'}`, 401);
    return json({ access_token: token.access_token });
  }

  if (url.pathname === '/api/session' && request.method === 'POST') {
    if (!data.access_token || !data.instance_id) return error('access_token e instance_id obrigatorios');
    const me = await fetch('https://discord.com/api/users/@me', { headers: { authorization: `Bearer ${data.access_token}` } }).then((r) => r.json());
    if (!me?.id) return error('token invalido', 401);
    const presence = await inVoiceChannel(env, data.guild_id, data.channel_id, me.id);
    if (presence === 'fora') return error('Entre na call antes de abrir a atividade.', 403);
    const identity = await issueIdentity(env, data.instance_id, me.id, me.global_name || me.username, me.avatar ?? null, 8 * 60 * 60, presence === 'ok' ? { call: data.channel_id } : {});
    return json({ ...identity, call: presence === 'ok' ? data.channel_id : null });
  }

  if (url.pathname === '/api/session-dev' && request.method === 'POST') {
    if (env.ENVIRONMENT === 'production') return new Response(null, { status: 404 });
    return json(await issueIdentity(env, data.instance_id || 'dev', `dev-${data.name || 'Dev'}`, data.name || 'Dev', null, 8 * 60 * 60, data.call ? { call: data.call } : {}));
  }

  if (url.pathname === '/api/session-guest' && request.method === 'POST') {
    const clean = String(data.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 32);
    const name = clean || `Convidado ${Math.floor(Math.random() * 9000 + 1000)}`;
    return json(await issueIdentity(env, WEB_INSTANCE, `guest-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`, name, null, 30 * 24 * 60 * 60));
  }

  if (url.pathname === '/api/rooms/list' && request.method === 'POST') {
    const me = await identityOf(data, env);
    const { response, data: listed } = await internal(registry(env), '/list', { instance: me?.instance ?? WEB_INSTANCE });
    return json(listed, response.status);
  }

  if (url.pathname === '/api/rooms/create' && request.method === 'POST') {
    const me = await identityOf(data, env);
    if (!me) return error('identidade invalida ou expirada', 401);
    const chosen = String(data.name ?? '').replace(/\s+/g, ' ').trim();
    const room = {
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 12), instance: me.instance,
      name: (chosen || `Sala de ${me.name}`).slice(0, ROOM_NAME_MAX), ownerId: me.uid,
      ownerName: me.name, password: data.password || null, isCall: false, createdAt: Date.now(),
    };
    const put = await internal(registry(env), '/put', { ...room, locked: Boolean(room.password) });
    if (!put.response.ok) return json(put.data, put.response.status);
    await internal(roomStub(env, room.id), '/init', room);
    return json(await issueRoomTokens(request, env, room.id, me));
  }

  if (url.pathname === '/api/rooms/call' && request.method === 'POST') {
    const me = await identityOf(data, env);
    if (!me) return error('identidade invalida ou expirada', 401);
    const id = me.call ? `call-${me.call}` : `atividade-${me.instance}`;
    const room = { id, instance: me.instance, name: 'Sala da call', ownerId: null, ownerName: 'a call', password: null, isCall: true, createdAt: Date.now() };
    await internal(registry(env), '/put', { ...room, locked: false });
    await internal(roomStub(env, id), '/init', room);
    return json(await issueRoomTokens(request, env, id, me));
  }

  if (url.pathname === '/api/rooms/join' && request.method === 'POST') {
    const me = await identityOf(data, env);
    if (!me) return error('identidade invalida ou expirada', 401);
    const stub = roomStub(env, String(data.roomId || 'missing'));
    const meta = await internal(stub, '/meta', null, 'GET');
    if (!meta.response.ok) return error('Sala não existe mais.', 404);
    const room = meta.data.room;
    const expectedCall = me.call ? `call-${me.call}` : `atividade-${me.instance}`;
    if (room.isCall && room.id !== expectedCall) return error('Entre na call para acessar esta sala.', 403);
    if (!room.isCall && room.instance !== me.instance) return error('Sala não existe mais.', 404);
    if (!room.isCall) {
      const checked = await internal(stub, '/password/check', { password: data.password });
      if (!checked.data.ok) return error(checked.data.reason === 'bloqueado' ? `Muitas tentativas. Tente de novo em ${checked.data.seconds}s.` : 'Senha incorreta.', checked.data.reason === 'bloqueado' ? 429 : 403, { reason: checked.data.reason });
    }
    return json(await issueRoomTokens(request, env, room.id, me));
  }

  if (url.pathname === '/api/rooms/password' && request.method === 'POST') {
    const me = await identityOf(data, env);
    if (!me) return error('identidade invalida ou expirada', 401);
    const stub = roomStub(env, String(data.roomId || 'missing'));
    const meta = await internal(stub, '/meta', null, 'GET');
    if (!meta.response.ok || meta.data.room.instance !== me.instance) return error('Sala não existe mais.', 404);
    const result = await internal(stub, '/password/set', { uid: me.uid, password: data.password || null });
    return json(result.data, result.response.status);
  }

  const avatar = url.pathname.match(/^\/api\/avatar\/(\d{15,21})\/((?:a_)?[0-9a-f]{32})$/);
  if (avatar) {
    const upstream = await fetch(`https://cdn.discordapp.com/avatars/${avatar[1]}/${avatar[2]}.png?size=128`, { cf: { cacheTtl: 86400, cacheEverything: true } });
    if (!upstream.ok) return new Response(null, { status: 404 });
    const response = new Response(upstream.body, upstream);
    response.headers.set('cache-control', 'public, max-age=86400, immutable');
    response.headers.set('content-type', 'image/png');
    return response;
  }

  return error('Rota não encontrada.', 404);
}

async function websocket(request, env, url) {
  const auth = await verifyToken(url.searchParams.get('t'), env.SESSION_SECRET);
  if (!auth?.room || !['viewer', 'broadcaster'].includes(auth.role)) return new Response('Unauthorized', { status: 401 });
  const headers = new Headers(request.headers);
  headers.set('x-room-auth', JSON.stringify(auth));
  return roomStub(env, auth.room).fetch(new Request(`https://room.internal/ws`, { method: request.method, headers }));
}

async function oauth(request, env, url) {
  const origin = originFor(request, env);
  const redirectUri = `${origin}/auth/callback`;
  if (url.pathname === '/auth/login') {
    const target = new URL('https://discord.com/oauth2/authorize');
    target.searchParams.set('client_id', env.DISCORD_CLIENT_ID || '');
    target.searchParams.set('redirect_uri', redirectUri);
    target.searchParams.set('response_type', 'code');
    target.searchParams.set('scope', 'identify');
    return Response.redirect(target, 302);
  }
  if (!url.searchParams.get('code')) return Response.redirect(`${origin}/?erro=sem_codigo`, 302);
  const token = await discordToken(env, { redirect_uri: redirectUri, code: url.searchParams.get('code') });
  if (!token.access_token) return Response.redirect(`${origin}/?erro=troca_falhou`, 302);
  const me = await fetch('https://discord.com/api/users/@me', { headers: { authorization: `Bearer ${token.access_token}` } }).then((r) => r.json());
  if (!me?.id) return Response.redirect(`${origin}/?erro=perfil_falhou`, 302);
  const identity = await issueIdentity(env, WEB_INSTANCE, me.id, me.global_name || me.username, me.avatar ?? null);
  return Response.redirect(`${origin}/#identity=${encodeURIComponent(identity.identity)}`, 302);
}

export default {
  async fetch(request, env) {
    if (!env.SESSION_SECRET) return error('SESSION_SECRET não configurado.', 503);
    const original = new URL(request.url);
    const pathname = original.pathname.replace(/^\/\.proxy(?=\/|$)/, '') || '/';
    const url = new URL(request.url); url.pathname = pathname;
    let response;
    if (pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') response = await websocket(request, env, url);
    else if (pathname.startsWith('/api/')) response = await api(request, env, url);
    else if (pathname === '/auth/login' || pathname === '/auth/callback') response = await oauth(request, env, url);
    else {
      if (pathname === '/termos') url.pathname = '/termos.html';
      if (pathname === '/privacidade') url.pathname = '/privacidade.html';
      response = await env.ASSETS.fetch(new Request(url, request));
    }
    return withSecurityHeaders(response);
  },
};


