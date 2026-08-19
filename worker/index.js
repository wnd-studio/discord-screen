import { json, error, body, withSecurityHeaders } from './http.js';
import { signToken, verifyToken } from './tokens.js';
import { applicationMetadata, currentGuild, isApplicationAdmin, verifyDiscordRequest } from './discord.js';
export { Room } from './room.js';
export { RoomRegistry } from './registry.js';

const WEB_INSTANCE = 'web';
const ROOM_NAME_MAX = 40;
const ROOM_TOKEN_TTL = 8 * 60 * 60;
const ADMIN_TOKEN_TTL = 12 * 60 * 60;
const ADMIN_COOKIE = 'discord_screen_admin';
const OAUTH_STATE_COOKIE = 'discord_screen_oauth_state';

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

function cookies(request) {
  return Object.fromEntries(
    String(request.headers.get('cookie') || '').split(';').map((part) => {
      const at = part.indexOf('=');
      return at < 0 ? [part.trim(), ''] : [part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1))];
    }).filter(([name]) => name)
  );
}

async function adminOf(request, env) {
  const token = await verifyToken(cookies(request)[ADMIN_COOKIE], env.SESSION_SECRET);
  return token?.scope === 'admin' ? token : null;
}

async function blockFor(env, userId, guildId = null) {
  const result = await internal(registry(env), '/block/check', { userId, guildId });
  return result.data.blocked ? result.data.block : null;
}

async function maintenanceEnabled(env) {
  const result = await internal(registry(env), '/setting/get', { key: 'maintenance' });
  return result.data.value === 'true';
}

function blockedResponse(block) {
  const target = block?.subject_type === 'guild' ? 'Este servidor' : 'Sua conta';
  return error(`${target} está bloqueado${block?.reason ? `: ${block.reason}` : '.'}`, 403, { reason: 'bloqueado' });
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

async function issueRoomTokens(request, env, roomId, me, room = null) {
  const base = {
    room: roomId,
    uid: me.uid,
    name: me.name,
    avatar: me.av ?? null,
    guild: me.guild ?? room?.guildId ?? null,
  };
  const viewerToken = await signToken(
    { ...base, role: 'viewer' }, env.SESSION_SECRET, ROOM_TOKEN_TTL
  );
  const broadcasterToken = await signToken(
    { ...base, role: 'broadcaster' }, env.SESSION_SECRET, ROOM_TOKEN_TTL
  );
  const inviteToken = await signToken(
    { room: roomId, scope: 'invite' }, env.SESSION_SECRET, ROOM_TOKEN_TTL
  );
  return {
    roomId,
    roomName: room?.name ?? null,
    listed: room?.listed !== false,
    viewerToken,
    shareUrl: `${originFor(request, env)}/share.html?t=${encodeURIComponent(broadcasterToken)}`,
    inviteUrl: `${originFor(request, env)}/?sala=${encodeURIComponent(roomId)}&convite=${encodeURIComponent(inviteToken)}`,
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

async function audit(env, admin, action, targetType, targetId, details = {}) {
  await internal(registry(env), '/admin/audit', {
    adminId: admin.uid,
    adminName: admin.name,
    action,
    targetType,
    targetId,
    details,
  });
}

async function closeRoomAsAdmin(env, roomId, reason) {
  return internal(roomStub(env, String(roomId || 'missing')), '/admin/delete', { reason });
}

async function closeManyRooms(env, roomIds, reason) {
  return Promise.allSettled(roomIds.map((roomId) => closeRoomAsAdmin(env, roomId, reason)));
}

async function adminApi(request, env, url, data) {
  if (url.pathname === '/api/admin/dev-login' && env.ENVIRONMENT !== 'production') {
    const userId = data.userId || url.searchParams.get('userId');
    if (!await isApplicationAdmin(env, userId)) return error('Administrador de desenvolvimento inválido.', 403);
    const session = await signToken({ scope: 'admin', uid: userId, name: 'Administrador local', avatar: null }, env.SESSION_SECRET, ADMIN_TOKEN_TTL);
    return new Response(null, {
      status: 302,
      headers: {
        location: `${originFor(request, env)}/admin`,
        'set-cookie': `${ADMIN_COOKIE}=${encodeURIComponent(session)}; Path=/; Max-Age=${ADMIN_TOKEN_TTL}; HttpOnly; SameSite=Lax`,
      },
    });
  }
  const admin = await adminOf(request, env);
  if (!admin) return error('Entre com a conta proprietária do aplicativo.', 401, { login: '/admin/login' });

  if (url.pathname === '/api/admin/me') {
    return json({ user: { id: admin.uid, name: admin.name, avatar: admin.avatar ?? null } });
  }

  if (url.pathname === '/api/admin/overview') {
    const overview = await internal(registry(env), '/admin/overview', {});
    const application = await applicationMetadata(env);
    return json({
      ...overview.data,
      application: application ? {
        id: application.id,
        name: application.name,
        approximateGuildCount: application.approximate_guild_count ?? null,
        approximateUserInstallCount: application.approximate_user_install_count ?? null,
        webhookStatus: application.event_webhooks_status ?? null,
        webhookTypes: application.event_webhooks_types ?? [],
      } : null,
    }, overview.response.status);
  }

  if (url.pathname !== '/api/admin/action' || request.method !== 'POST') {
    return error('Rota administrativa não encontrada.', 404);
  }
  const requestOrigin = request.headers.get('origin');
  if (requestOrigin && requestOrigin !== originFor(request, env)) return error('Origem inválida.', 403);

  const reason = String(data.reason || 'Ação administrativa').replace(/\s+/g, ' ').trim().slice(0, 240);
  if (data.action === 'close-room') {
    const result = await closeRoomAsAdmin(env, data.roomId, reason);
    if (!result.response.ok) return json(result.data, result.response.status);
    await audit(env, admin, 'close-room', 'room', data.roomId, { reason });
    return json({ ok: true });
  }

  if (data.action === 'kick-user') {
    const result = await internal(roomStub(env, String(data.roomId || 'missing')), '/admin/kick', {
      userId: data.userId,
      reason,
      banRoom: false,
    });
    if (!result.response.ok) return json(result.data, result.response.status);
    await audit(env, admin, 'kick-user', 'user', data.userId, { roomId: data.roomId, reason });
    return json({ ok: true, disconnected: result.data.disconnected ?? 0 });
  }

  if (data.action === 'block-user' || data.action === 'block-guild') {
    const subjectType = data.action === 'block-user' ? 'user' : 'guild';
    const subjectId = String(subjectType === 'user' ? data.userId : data.guildId || '');
    if (!subjectId) return error('Alvo inválido.');
    const durationHours = Number(data.durationHours);
    const expiresAt = Number.isFinite(durationHours) && durationHours > 0
      ? Date.now() + Math.min(durationHours, 24 * 365) * 60 * 60 * 1000
      : null;
    await internal(registry(env), '/block/put', {
      subjectType,
      subjectId,
      reason,
      expiresAt,
      createdBy: admin.uid,
    });
    const roomIds = (await internal(registry(env), '/admin/room-ids', {
      guildId: subjectType === 'guild' ? subjectId : null,
    })).data.roomIds || [];
    if (subjectType === 'guild') {
      await closeManyRooms(env, roomIds, `Servidor bloqueado: ${reason}`);
    } else {
      await Promise.allSettled(roomIds.map((roomId) => internal(roomStub(env, roomId), '/admin/kick', {
        userId: subjectId,
        reason,
        banRoom: false,
      })));
    }
    await audit(env, admin, data.action, subjectType, subjectId, { reason, expiresAt });
    return json({ ok: true });
  }

  if (data.action === 'unblock') {
    await internal(registry(env), '/block/delete', {
      subjectType: data.subjectType,
      subjectId: data.subjectId,
    });
    await audit(env, admin, 'unblock', data.subjectType, data.subjectId);
    return json({ ok: true });
  }

  if (data.action === 'maintenance') {
    const enabled = data.enabled === true;
    await internal(registry(env), '/setting/put', { key: 'maintenance', value: String(enabled) });
    if (enabled) {
      const roomIds = (await internal(registry(env), '/admin/room-ids', {})).data.roomIds || [];
      await closeManyRooms(env, roomIds, 'Aplicativo em manutenção');
    }
    await audit(env, admin, 'maintenance', 'application', env.DISCORD_CLIENT_ID, { enabled });
    return json({ ok: true, enabled });
  }

  return error('Ação administrativa desconhecida.', 400);
}

async function discordEvents(request, env) {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const rawBody = await request.text();
  if (!await verifyDiscordRequest(request, rawBody, env)) {
    return new Response('Invalid request signature', { status: 401 });
  }
  let payload;
  try { payload = JSON.parse(rawBody); } catch { return error('JSON inválido.'); }
  if (payload.type === 0) {
    return new Response(null, { status: 204, headers: { 'content-type': 'application/json' } });
  }
  if (payload.type === 1 && payload.event?.type) {
    await internal(registry(env), '/installation', {
      eventType: payload.event.type,
      createdAt: Date.parse(payload.event.timestamp) || Date.now(),
      data: payload.event.data || {},
    });
  }
  return new Response(null, { status: 204, headers: { 'content-type': 'application/json' } });
}

async function api(request, env, url) {
  const data = request.method === 'POST' ? await body(request) : {};

  if (url.pathname.startsWith('/api/admin/')) return adminApi(request, env, url, data);

  if (url.pathname === '/api/health') return json({
    ok: true,
    architecture: 'cloudflare-workers-durable-objects',
    features: ['admin-dashboard', 'usage-history', 'discord-event-webhooks'],
  });
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
    if (await maintenanceEnabled(env)) return error('O aplicativo está em manutenção. Tente novamente em alguns minutos.', 503, { reason: 'manutencao' });
    const me = await fetch('https://discord.com/api/users/@me', { headers: { authorization: `Bearer ${data.access_token}` } }).then((r) => r.json());
    if (!me?.id) return error('token invalido', 401);
    const blocked = await blockFor(env, me.id, data.guild_id);
    if (blocked) return blockedResponse(blocked);
    const guild = await currentGuild(data.access_token, data.guild_id);
    const presence = await inVoiceChannel(env, data.guild_id, data.channel_id, me.id);
    if (presence === 'fora') return error('Entre na call antes de abrir a atividade.', 403);
    await internal(registry(env), '/usage/launch', {
      guildId: data.guild_id || null,
      guildName: guild?.name || null,
      guildIcon: guild?.icon || null,
      channelId: data.channel_id || null,
      channelName: data.channel_name || null,
      instance: data.instance_id,
      userId: me.id,
      userName: me.global_name || me.username,
      verifiedGuild: Boolean(guild),
    });
    const context = {
      guild: data.guild_id || null,
      channel: data.channel_id || null,
      ...(presence === 'ok' ? { call: data.channel_id } : {}),
    };
    const identity = await issueIdentity(env, data.instance_id, me.id, me.global_name || me.username, me.avatar ?? null, 8 * 60 * 60, context);
    return json({ ...identity, call: presence === 'ok' ? data.channel_id : null });
  }

  if (url.pathname === '/api/session-dev' && request.method === 'POST') {
    if (env.ENVIRONMENT === 'production') return new Response(null, { status: 404 });
    const uid = data.user_id || `dev-${data.name || 'Dev'}`;
    const context = {
      ...(data.call ? { call: data.call } : {}),
      guild: data.guild_id || null,
      channel: data.channel_id || data.call || null,
    };
    await internal(registry(env), '/usage/launch', {
      guildId: data.guild_id || null, guildName: data.guild_name || null,
      channelId: data.channel_id || data.call || null, channelName: data.channel_name || null,
      instance: data.instance_id || 'dev', userId: uid, userName: data.name || 'Dev', verifiedGuild: true,
    });
    return json(await issueIdentity(env, data.instance_id || 'dev', uid, data.name || 'Dev', null, 8 * 60 * 60, context));
  }

  if (url.pathname === '/api/session-guest' && request.method === 'POST') {
    if (await maintenanceEnabled(env)) return error('O aplicativo está em manutenção. Tente novamente em alguns minutos.', 503, { reason: 'manutencao' });
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
    const blocked = await blockFor(env, me.uid, me.guild);
    if (blocked) return blockedResponse(blocked);
    const chosen = String(data.name ?? '').replace(/\s+/g, ' ').trim();
    const room = {
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 12), instance: me.instance,
      name: (chosen || `Sala de ${me.name}`).slice(0, ROOM_NAME_MAX), ownerId: me.uid,
      ownerName: me.name, password: data.password || null, listed: data.private !== true,
      guildId: me.guild ?? null, channelId: me.channel ?? null,
      isCall: false, createdAt: Date.now(),
    };
    const put = await internal(registry(env), '/put', { ...room, locked: Boolean(room.password) });
    if (!put.response.ok) return json(put.data, put.response.status);
    await internal(roomStub(env, room.id), '/init', room);
    return json(await issueRoomTokens(request, env, room.id, me, room));
  }

  if (url.pathname === '/api/rooms/call' && request.method === 'POST') {
    const me = await identityOf(data, env);
    if (!me) return error('identidade invalida ou expirada', 401);
    const blocked = await blockFor(env, me.uid, me.guild);
    if (blocked) return blockedResponse(blocked);
    const id = me.call ? `call-${me.call}` : `atividade-${me.instance}`;
    const room = {
      id, instance: me.instance, name: 'Sala da call', ownerId: null, ownerName: 'a call',
      password: null, listed: false, isCall: true, createdAt: Date.now(),
      guildId: me.guild ?? null, channelId: me.channel ?? me.call ?? null,
    };
    await internal(registry(env), '/put', { ...room, locked: false });
    await internal(roomStub(env, id), '/init', room);
    const access = await internal(roomStub(env, id), '/access/check', { uid: me.uid });
    if (!access.data.ok) return error(
      access.data.reason === 'cheia' ? 'Sala cheia. Tente novamente em instantes.' : 'Você foi removido desta sala.',
      access.data.reason === 'cheia' ? 409 : 403,
      { reason: access.data.reason }
    );
    return json(await issueRoomTokens(request, env, id, me, room));
  }

  if (url.pathname === '/api/rooms/join' && request.method === 'POST') {
    const me = await identityOf(data, env);
    if (!me) return error('identidade invalida ou expirada', 401);
    const blocked = await blockFor(env, me.uid, me.guild);
    if (blocked) return blockedResponse(blocked);
    const stub = roomStub(env, String(data.roomId || 'missing'));
    const meta = await internal(stub, '/meta', null, 'GET');
    if (!meta.response.ok) return error('Sala não existe mais.', 404);
    const room = meta.data.room;
    const expectedCall = me.call ? `call-${me.call}` : `atividade-${me.instance}`;
    if (room.isCall && room.id !== expectedCall) return error('Entre na call para acessar esta sala.', 403);
    if (!room.isCall && room.instance !== me.instance) return error('Sala não existe mais.', 404);
    if (!room.isCall && room.listed === false && room.ownerId !== me.uid) {
      const invite = await verifyToken(data.invite, env.SESSION_SECRET);
      if (invite?.scope !== 'invite' || invite.room !== room.id) {
        return error('Este convite é inválido ou expirou. Peça um link novo.', 403, { reason: 'convite' });
      }
    }
    if (!room.isCall) {
      const checked = await internal(stub, '/password/check', { password: data.password });
      if (!checked.data.ok) return error(checked.data.reason === 'bloqueado' ? `Muitas tentativas. Tente de novo em ${checked.data.seconds}s.` : 'Senha incorreta.', checked.data.reason === 'bloqueado' ? 429 : 403, { reason: checked.data.reason });
    }
    const access = await internal(stub, '/access/check', { uid: me.uid });
    if (!access.data.ok) return error(
      access.data.reason === 'cheia' ? 'Sala cheia. O limite atual é de 50 espectadores.' : 'Você foi removido desta sala.',
      access.data.reason === 'cheia' ? 409 : 403,
      { reason: access.data.reason }
    );
    return json(await issueRoomTokens(request, env, room.id, me, room));
  }

  if ((url.pathname === '/api/rooms/password' || url.pathname === '/api/rooms/settings') && request.method === 'POST') {
    const me = await identityOf(data, env);
    if (!me) return error('identidade invalida ou expirada', 401);
    const stub = roomStub(env, String(data.roomId || 'missing'));
    const meta = await internal(stub, '/meta', null, 'GET');
    if (!meta.response.ok || meta.data.room.instance !== me.instance) return error('Sala não existe mais.', 404);
    const result = await internal(stub, '/settings', {
      uid: me.uid,
      password: data.password || null,
      listed: url.pathname === '/api/rooms/settings' ? data.listed !== false : meta.data.room.listed !== false,
    });
    return json(result.data, result.response.status);
  }

  if (url.pathname === '/api/rooms/delete' && request.method === 'POST') {
    const me = await identityOf(data, env);
    if (!me) return error('identidade invalida ou expirada', 401);
    const stub = roomStub(env, String(data.roomId || 'missing'));
    const meta = await internal(stub, '/meta', null, 'GET');
    if (!meta.response.ok || meta.data.room.instance !== me.instance) {
      return error('Sala não existe mais.', 404);
    }
    const result = await internal(stub, '/delete', { uid: me.uid });
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
  const blocked = await blockFor(env, auth.uid, auth.guild);
  if (blocked) return new Response('Blocked', { status: 403 });
  const headers = new Headers(request.headers);
  headers.set('x-room-auth', JSON.stringify(auth));
  return roomStub(env, auth.room).fetch(new Request(`https://room.internal/ws`, { method: request.method, headers }));
}

async function oauth(request, env, url) {
  const origin = originFor(request, env);
  const redirectUri = `${origin}/auth/callback`;
  if (url.pathname === '/admin/logout') {
    const response = new Response(null, { status: 302, headers: { location: `${origin}/admin` } });
    response.headers.append('set-cookie', `${ADMIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    return response;
  }
  if (url.pathname === '/auth/login' || url.pathname === '/admin/login') {
    const target = new URL('https://discord.com/oauth2/authorize');
    target.searchParams.set('client_id', env.DISCORD_CLIENT_ID || '');
    target.searchParams.set('redirect_uri', redirectUri);
    target.searchParams.set('response_type', 'code');
    target.searchParams.set('scope', 'identify');
    const response = Response.redirect(target, 302);
    if (url.pathname === '/admin/login') {
      const state = await signToken({ scope: 'admin-oauth', nonce: crypto.randomUUID() }, env.SESSION_SECRET, 10 * 60);
      target.searchParams.set('state', state);
      const withState = new Response(null, { status: 302, headers: { location: target.toString() } });
      withState.headers.append(
        'set-cookie',
        `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}; Path=/auth/callback; Max-Age=600; HttpOnly; Secure; SameSite=Lax`
      );
      return withState;
    }
    return response;
  }

  const stateToken = url.searchParams.get('state');
  const state = await verifyToken(stateToken, env.SESSION_SECRET);
  const adminFlow = state?.scope === 'admin-oauth';
  if (adminFlow && cookies(request)[OAUTH_STATE_COOKIE] !== stateToken) {
    return Response.redirect(`${origin}/admin?erro=estado_invalido`, 302);
  }
  const failureTarget = adminFlow ? `${origin}/admin` : `${origin}/`;
  if (!url.searchParams.get('code')) return Response.redirect(`${failureTarget}?erro=sem_codigo`, 302);
  const token = await discordToken(env, { redirect_uri: redirectUri, code: url.searchParams.get('code') });
  if (!token.access_token) return Response.redirect(`${failureTarget}?erro=troca_falhou`, 302);
  const me = await fetch('https://discord.com/api/users/@me', { headers: { authorization: `Bearer ${token.access_token}` } }).then((r) => r.json());
  if (!me?.id) return Response.redirect(`${failureTarget}?erro=perfil_falhou`, 302);

  if (adminFlow) {
    if (!await isApplicationAdmin(env, me.id)) {
      return Response.redirect(`${origin}/admin?erro=sem_acesso`, 302);
    }
    const session = await signToken({
      scope: 'admin', uid: me.id, name: me.global_name || me.username, avatar: me.avatar ?? null,
    }, env.SESSION_SECRET, ADMIN_TOKEN_TTL);
    const response = new Response(null, { status: 302, headers: { location: `${origin}/admin` } });
    response.headers.append(
      'set-cookie',
      `${ADMIN_COOKIE}=${encodeURIComponent(session)}; Path=/; Max-Age=${ADMIN_TOKEN_TTL}; HttpOnly; Secure; SameSite=Lax`
    );
    response.headers.append(
      'set-cookie',
      `${OAUTH_STATE_COOKIE}=; Path=/auth/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
    );
    return response;
  }

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
    else if (pathname === '/api/discord/events') response = await discordEvents(request, env);
    else if (pathname.startsWith('/api/')) response = await api(request, env, url);
    else if (['/auth/login', '/auth/callback', '/admin/login', '/admin/logout'].includes(pathname)) response = await oauth(request, env, url);
    else {
      if (pathname === '/termos') url.pathname = '/termos.html';
      if (pathname === '/privacidade') url.pathname = '/privacidade.html';
      response = await env.ASSETS.fetch(new Request(url, request));
    }
    return withSecurityHeaders(response);
  },
};
