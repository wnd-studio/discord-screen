import { json, error, body, withSecurityHeaders } from './http.js';
import { signToken, verifyToken } from './tokens.js';
import { applicationMetadata, currentGuild, guildRole, isApplicationAdmin, verifyDiscordRequest } from './discord.js';
export { Room } from './room.js';
export { RoomRegistry } from './registry.js';

const WEB_INSTANCE = 'web';
const ROOM_NAME_MAX = 40;
const ROOM_TOKEN_TTL = 8 * 60 * 60;
const ADMIN_TOKEN_TTL = 4 * 60 * 60;
const ADMIN_COOKIE = 'discord_screen_admin';
const OAUTH_STATE_COOKIE = 'discord_screen_oauth_state';
const INSTALL_STATE_COOKIE = 'discord_screen_install_state';
const CHANGELOG_SETUP_TTL = 20 * 60;
const DISCORD_MESSAGE_PERMISSIONS = 1024 + 2048 + 16384;
const BOT_STATUS_CACHE_MS = 60_000;
let botStatusCache = null;

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
  if (token?.scope !== 'admin') return null;
  if (!token.iat || Math.floor(Date.now() / 1000) - Number(token.iat) > ADMIN_TOKEN_TTL) return null;
  // A conta já foi validada contra o Discord no callback do OAuth. Repetir a
  // consulta em toda requisição fazia uma sessão recém-criada parecer inválida
  // quando a API do Discord oscilava ou outra instância do Worker ainda não
  // tinha o cache. A assinatura e o prazo curto da sessão são a autoridade aqui.
  return token;
}

async function requestFingerprint(request, env) {
  const value = `${request.headers.get('cf-connecting-ip') || 'unknown'}:${request.headers.get('user-agent') || ''}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
  return [...bytes.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function enforceRateLimit(request, env, group, limit, windowMs = 60_000) {
  const fingerprint = await requestFingerprint(request, env);
  const checked = await internal(registry(env), '/rate/check', {
    bucket: `${group}:${fingerprint}`, limit, windowMs,
  });
  if (checked.data.allowed !== false) return null;
  return error('Muitas tentativas. Aguarde um pouco e tente novamente.', 429, {
    reason: 'limite', retryAfter: checked.data.retryAfter,
  });
}

function validMutationOrigin(request, env) {
  return request.headers.get('origin') === originFor(request, env);
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
  const supporterResult = /^\d{15,21}$/.test(String(uid))
    ? await internal(registry(env), '/supporter/get', { userId: uid })
    : null;
  const supporter = supporterResult?.data?.supporter
    ? { tier: supporterResult.data.supporter.tier, expiresAt: supporterResult.data.supporter.expiresAt }
    : null;
  const access = extra.access || 'user';
  return {
    user: { id: uid, name, avatar, supporter, access },
    instance,
    identity: await signToken(
      { instance, uid, name, av: avatar, scope: 'identity', sup: supporter, access, ...extra },
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
    supporter: me.sup ?? null,
    access: me.access ?? 'user',
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

function encodeHeaderJson(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function discordBot(env, path, options = {}) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, status: 503, data: { message: 'Bot não configurado.' } };
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    ...options,
    headers: {
      authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  return { response, ok: response.ok, status: response.status, data: await response.json().catch(() => ({})) };
}

async function sendDiscordMessage(env, channelId, payload) {
  let result = await discordBot(env, `/channels/${encodeURIComponent(channelId)}/messages`, {
    method: 'POST', body: JSON.stringify({ ...payload, allowed_mentions: { parse: [] } }),
  });
  if (result.status === 429 && Number(result.data.retry_after) <= 10) {
    await new Promise((resolve) => setTimeout(resolve, Math.ceil(Number(result.data.retry_after) * 1000)));
    result = await discordBot(env, `/channels/${encodeURIComponent(channelId)}/messages`, {
      method: 'POST', body: JSON.stringify({ ...payload, allowed_mentions: { parse: [] } }),
    });
  }
  return result;
}

async function botDiagnostics(env) {
  if (!env.DISCORD_BOT_TOKEN) return { configured: false, valid: false, checkedAt: Date.now() };
  if (botStatusCache?.expiresAt > Date.now()) return botStatusCache.value;
  const [user, guilds] = await Promise.all([
    discordBot(env, '/users/@me'),
    discordBot(env, '/users/@me/guilds'),
  ]);
  const value = {
    configured: true,
    valid: user.ok,
    id: user.ok ? user.data.id : null,
    name: user.ok ? user.data.global_name || user.data.username : null,
    guildCount: guilds.ok && Array.isArray(guilds.data) ? guilds.data.length : null,
    error: user.ok ? null : user.data?.message || `Discord respondeu ${user.status}`,
    checkedAt: Date.now(),
  };
  botStatusCache = { value, expiresAt: Date.now() + BOT_STATUS_CACHE_MS };
  return value;
}

function changelogEmbed({ version, title, summary, details, url }) {
  const description = [summary, details].filter(Boolean).join('\n\n').slice(0, 4000);
  return {
    embeds: [{
      title: `${version ? `Versão ${version} · ` : ''}${title}`.slice(0, 256),
      description,
      color: 0x5865f2,
      url: url || undefined,
      footer: { text: 'WND Studio · Discord Screen' },
      timestamp: new Date().toISOString(),
    }],
    components: url ? [{
      type: 1,
      components: [{ type: 2, style: 5, label: 'Abrir aplicativo', url }],
    }] : [],
  };
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
    const [overview, application, bot] = await Promise.all([
      internal(registry(env), '/admin/overview', {}),
      applicationMetadata(env),
      botDiagnostics(env),
    ]);
    const webhookConfigured = Boolean(application?.event_webhooks_types?.length)
      || application?.event_webhooks_status === 2;
    if (env.DISCORD_BOT_TOKEN) {
      const missingAuthorizers = (overview.data.servers || [])
        .filter((server) => server.authorizedBy && !server.authorizedByName)
        .slice(0, 10);
      await Promise.all(missingAuthorizers.map(async (server) => {
        const result = await discordBot(env, `/users/${encodeURIComponent(server.authorizedBy)}`);
        const userName = result.ok
          ? String(result.data.global_name || result.data.username || '').trim().slice(0, 64)
          : '';
        if (!userName) return;
        server.authorizedByName = userName;
        await internal(registry(env), '/admin/server-authorizer', {
          guildId: server.guildId, userId: server.authorizedBy, userName,
        });
      }));
    }
    const alerts = [];
    if (!bot.valid) alerts.push({ level: 'error', message: 'O bot do Discord não está respondendo corretamente.' });
    if (!webhookConfigured) alerts.push({ level: 'warning', message: 'O Discord ainda não confirmou o webhook de eventos.' });
    if (Number(overview.data.totals?.activePeople || 0) >= 40) {
      alerts.push({ level: 'warning', message: 'Uso simultâneo elevado: acompanhe salas e transmissões ativas.' });
    }
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
      botConfigured: Boolean(env.DISCORD_BOT_TOKEN),
      bot,
      operations: {
        sessionHours: ADMIN_TOKEN_TTL / 3600,
        usageRetentionDays: 90,
        nameRetentionDays: 30,
        auditRetentionDays: 180,
        rateLimits: true,
        webhookConfigured,
        alerts,
      },
      installUrl: `${originFor(request, env)}/changelog/install`,
    }, overview.response.status);
  }

  if (url.pathname === '/api/admin/changelog/publish' && request.method === 'POST') {
    if (!validMutationOrigin(request, env)) return error('Origem inválida.', 403);
    if (!env.DISCORD_BOT_TOKEN) return error('Configure DISCORD_BOT_TOKEN antes de publicar.', 503);

    const publication = {
      version: String(data.version || '').trim().slice(0, 24),
      title: String(data.title || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      summary: String(data.summary || '').trim().slice(0, 500),
      details: String(data.details || '').trim().slice(0, 3500),
      url: originFor(request, env),
    };
    if (!publication.title || (!publication.summary && !publication.details)) {
      return error('Preencha o título e a descrição da atualização.');
    }

    const listed = await internal(registry(env), '/changelog/list', {});
    const targets = (listed.data.channels || []).filter((channel) => channel.enabled);
    let successCount = 0;
    let failureCount = 0;
    for (const target of targets) {
      const sent = await sendDiscordMessage(env, target.channelId, changelogEmbed(publication));
      const ok = sent.ok;
      if (ok) successCount++;
      else failureCount++;
      await internal(registry(env), '/changelog/delivery', {
        guildId: target.guildId,
        ok,
        disable: [403, 404].includes(sent.status),
        error: ok ? null : sent.data?.message || `Discord respondeu ${sent.status}`,
      });
    }
    const publicationId = crypto.randomUUID();
    await internal(registry(env), '/changelog/published', {
      id: publicationId, ...publication, successCount, failureCount, createdBy: admin.uid,
    });
    await audit(env, admin, 'publish-changelog', 'application', publicationId, {
      version: publication.version, successCount, failureCount,
    });
    return json({ ok: true, targets: targets.length, successCount, failureCount });
  }

  if (url.pathname !== '/api/admin/action' || request.method !== 'POST') {
    return error('Rota administrativa não encontrada.', 404);
  }
  if (!validMutationOrigin(request, env)) return error('Origem inválida.', 403);

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

  if (data.action === 'set-supporter') {
    const userId = String(data.userId || '').trim();
    const tier = data.tier === 'founder' ? 'founder' : 'supporter';
    if (!/^\d{15,21}$/.test(userId)) return error('Informe um ID válido de usuário do Discord.');
    const durationDays = Math.min(3650, Math.max(1, Number(data.durationDays) || 90));
    const expiresAt = tier === 'founder' ? null : Date.now() + durationDays * 24 * 60 * 60 * 1000;
    const result = await internal(registry(env), '/supporter/put', {
      userId, tier, publicName: data.publicName, showCredit: data.showCredit === true,
      expiresAt, createdBy: admin.uid,
    });
    if (!result.response.ok) return json(result.data, result.response.status);
    await audit(env, admin, 'set-supporter', 'user', userId, { tier, expiresAt });
    return json({ ok: true, expiresAt });
  }

  if (data.action === 'remove-supporter') {
    const userId = String(data.userId || '').trim();
    if (!/^\d{15,21}$/.test(userId)) return error('Apoiador inválido.');
    await internal(registry(env), '/supporter/delete', { userId });
    await audit(env, admin, 'remove-supporter', 'user', userId);
    return json({ ok: true });
  }

  if (data.action === 'toggle-changelog-channel') {
    const guildId = String(data.guildId || '').trim();
    if (!/^\d{15,21}$/.test(guildId)) return error('Servidor inválido.');
    const enabled = data.enabled === true;
    const result = await internal(registry(env), '/changelog/toggle', { guildId, enabled });
    if (!result.response.ok) return json(result.data, result.response.status);
    await audit(env, admin, 'toggle-changelog-channel', 'guild', guildId, { enabled });
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

async function changelogApi(request, env, url, data) {
  const setupToken = request.method === 'GET' ? url.searchParams.get('s') : data.setupToken;
  const setup = await verifyToken(setupToken, env.SESSION_SECRET);
  const allowedGuilds = [...new Set([
    ...(Array.isArray(setup?.guilds) ? setup.guilds : []),
    setup?.guild,
  ].filter(Boolean).map(String))];
  if (setup?.scope !== 'changelog-setup' || !allowedGuilds.length || !setup.uid) {
    return error('Esta configuração expirou. Instale novamente para continuar.', 401);
  }
  if (!env.DISCORD_BOT_TOKEN) return error('O bot ainda não foi configurado pelo proprietário.', 503);

  const botGuildsResult = await discordBot(env, '/users/@me/guilds');
  const botGuilds = Array.isArray(botGuildsResult.data)
    ? botGuildsResult.data.filter((guild) => allowedGuilds.includes(String(guild.id)))
    : [];
  const requestedGuild = String(
    request.method === 'GET' ? url.searchParams.get('guild') || '' : data.guildId || ''
  );
  const guildId = requestedGuild || (botGuilds.length === 1 ? String(botGuilds[0].id) : '');

  if (request.method === 'GET' && !guildId) {
    return json({ guilds: botGuilds.map((guild) => ({ id: guild.id, name: guild.name })), channels: [] });
  }
  if (!allowedGuilds.includes(guildId) || !botGuilds.some((guild) => String(guild.id) === guildId)) {
    return error('Escolha um servidor válido onde o aplicativo esteja instalado.', 403);
  }

  const channelsResult = await discordBot(env, `/guilds/${encodeURIComponent(guildId)}/channels`);
  if (!channelsResult.ok || !Array.isArray(channelsResult.data)) {
    return error('Não foi possível acessar os canais. Confira se o aplicativo continua instalado.', 403);
  }
  const guild = botGuilds.find((item) => String(item.id) === guildId);
  const channels = channelsResult.data
    .filter((channel) => [0, 5].includes(channel.type))
    .sort((a, b) => Number(a.position || 0) - Number(b.position || 0))
    .map((channel) => ({ id: channel.id, name: channel.name, type: channel.type }));

  if (request.method === 'GET') {
    return json({
      guild: { id: guild.id, name: guild.name },
      guilds: botGuilds.map((item) => ({ id: item.id, name: item.name })),
      channels,
    });
  }
  if (request.method !== 'POST') return error('Método inválido.', 405);

  const channel = channels.find((item) => item.id === String(data.channelId || ''));
  if (!channel) return error('Escolha um canal de texto válido.');
  const test = await sendDiscordMessage(env, channel.id, {
    embeds: [{
      title: 'Canal de novidades configurado',
      description: 'As próximas atualizações do **Discord Screen** serão publicadas aqui. Você poderá alterar ou desativar esta configuração pelo aplicativo.',
      color: 0x23a55a,
      footer: { text: 'WND Studio · Discord Screen' },
    }],
  });
  if (!test.ok) {
    return error(
      test.status === 403
        ? 'Não consigo enviar mensagens nesse canal. Libere “Ver canal”, “Enviar mensagens” e “Inserir links” para o aplicativo.'
        : `O Discord recusou a mensagem de teste: ${test.data?.message || test.status}`,
      409
    );
  }
  await internal(registry(env), '/changelog/configure', {
    guildId,
    guildName: guild.name,
    channelId: channel.id,
    channelName: channel.name,
    configuredBy: setup.uid,
  });
  return json({ ok: true, guildName: guild.name, channelName: channel.name });
}

async function api(request, env, url) {
  const data = request.method === 'POST' ? await body(request) : {};

  let limited = null;
  if (request.method === 'POST' && ['/api/token', '/api/session', '/api/session-guest'].includes(url.pathname)) {
    limited = await enforceRateLimit(request, env, 'session', 40);
  } else if (request.method === 'POST' && ['/api/rooms/create', '/api/rooms/join'].includes(url.pathname)) {
    limited = await enforceRateLimit(request, env, 'rooms', 80);
  } else if (request.method === 'POST' && url.pathname.startsWith('/api/admin/')) {
    limited = await enforceRateLimit(request, env, 'admin', 120);
  }
  if (limited) return limited;

  if (url.pathname.startsWith('/api/admin/')) return adminApi(request, env, url, data);
  if (url.pathname.startsWith('/api/changelog/')) return changelogApi(request, env, url, data);

  if (url.pathname === '/api/health') return json({
    ok: true,
    architecture: 'cloudflare-workers-durable-objects',
    features: ['admin-dashboard', 'usage-history', 'discord-event-webhooks', 'discord-changelog-notifications'],
  });
  if (url.pathname === '/api/config') return json({
    clientId: env.DISCORD_CLIENT_ID || null,
    supportUrl: env.SUPPORT_URL || 'https://github.com/wnd-studio/discord-screen',
    asset: null,
  }, 200, { 'cache-control': 'no-store' });

  if (url.pathname === '/api/supporters/public' && request.method === 'GET') {
    const result = await internal(registry(env), '/supporter/public', {});
    return json({ supporters: result.data.supporters || [] }, result.response.status, { 'cache-control': 'public, max-age=300' });
  }

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
      access: await isApplicationAdmin(env, me.id) ? 'project_admin' : guildRole(guild),
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
      access: ['project_admin', 'server_admin', 'moderator'].includes(data.access) ? data.access : 'user',
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
  // Cabeçalhos aceitam somente bytes ASCII. Codificar evita falhas quando o
  // nome do usuário contém acentos, emojis ou outros caracteres do Discord.
  headers.set('x-room-auth', encodeHeaderJson(auth));
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
  if (url.pathname === '/changelog/install') {
    if (!env.DISCORD_BOT_TOKEN) {
      return Response.redirect(`${origin}/changelog/setup?erro=bot_nao_configurado`, 302);
    }
    const state = await signToken(
      { scope: 'changelog-install', nonce: crypto.randomUUID() },
      env.SESSION_SECRET,
      10 * 60
    );
    const target = new URL('https://discord.com/oauth2/authorize');
    target.searchParams.set('client_id', env.DISCORD_CLIENT_ID || '');
    target.searchParams.set('redirect_uri', redirectUri);
    target.searchParams.set('response_type', 'code');
    target.searchParams.set('scope', 'identify guilds bot');
    target.searchParams.set('permissions', String(DISCORD_MESSAGE_PERMISSIONS));
    target.searchParams.set('state', state);
    target.searchParams.set('integration_type', '0');
    const response = new Response(null, { status: 302, headers: { location: target.toString() } });
    response.headers.append(
      'set-cookie',
      `${INSTALL_STATE_COOKIE}=${encodeURIComponent(state)}; Path=/auth/callback; Max-Age=600; HttpOnly; Secure; SameSite=Lax`
    );
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
  const installFlow = state?.scope === 'changelog-install';
  if (adminFlow && cookies(request)[OAUTH_STATE_COOKIE] !== stateToken) {
    return Response.redirect(`${origin}/admin?erro=estado_invalido`, 302);
  }
  if (installFlow && cookies(request)[INSTALL_STATE_COOKIE] !== stateToken) {
    return Response.redirect(`${origin}/changelog/setup?erro=estado_invalido`, 302);
  }
  const failureTarget = adminFlow
    ? `${origin}/admin`
    : installFlow ? `${origin}/changelog/setup` : `${origin}/`;
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

  if (installFlow) {
    const hintedGuildId = String(token.guild?.id || url.searchParams.get('guild_id') || '');
    const guilds = await fetch('https://discord.com/api/users/@me/guilds', {
      headers: { authorization: `Bearer ${token.access_token}` },
    }).then((response) => response.ok ? response.json() : []).catch(() => []);
    const manageableGuilds = guilds.filter((guild) => {
      if (guild?.owner === true) return true;
      try {
        const permissions = BigInt(guild?.permissions || '0');
        return Boolean(permissions & 8n) || Boolean(permissions & 32n);
      } catch { return false; }
    });
    const botGuildsResult = await discordBot(env, '/users/@me/guilds');
    if (!botGuildsResult.ok) {
      return Response.redirect(`${origin}/changelog/setup?erro=bot_invalido`, 302);
    }
    const botGuildIds = new Set(
      Array.isArray(botGuildsResult.data) ? botGuildsResult.data.map((guild) => String(guild.id)) : []
    );
    let candidates = manageableGuilds.filter((guild) => botGuildIds.has(String(guild.id)));
    if (hintedGuildId && candidates.some((guild) => String(guild.id) === hintedGuildId)) {
      candidates = candidates.filter((guild) => String(guild.id) === hintedGuildId);
    }
    if (!candidates.length) {
      return Response.redirect(`${origin}/changelog/setup?erro=sem_permissao`, 302);
    }
    const setup = await signToken(
      { scope: 'changelog-setup', uid: me.id, guilds: candidates.slice(0, 50).map((guild) => String(guild.id)) },
      env.SESSION_SECRET,
      CHANGELOG_SETUP_TTL
    );
    const response = new Response(null, {
      status: 302,
      headers: { location: `${origin}/changelog/setup?s=${encodeURIComponent(setup)}` },
    });
    response.headers.append(
      'set-cookie',
      `${INSTALL_STATE_COOKIE}=; Path=/auth/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
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
    else if (['/auth/login', '/auth/callback', '/admin/login', '/admin/logout', '/changelog/install'].includes(pathname)) response = await oauth(request, env, url);
    else {
      if (pathname === '/termos') url.pathname = '/termos.html';
      if (pathname === '/privacidade') url.pathname = '/privacidade.html';
      if (pathname === '/changelog/setup') url.pathname = '/changelog.html';
      response = await env.ASSETS.fetch(new Request(url, request));
    }
    return withSecurityHeaders(response);
  },
};
