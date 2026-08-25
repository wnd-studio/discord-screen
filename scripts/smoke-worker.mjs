import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const base = (process.env.SMOKE_BASE || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const socketBase = base.replace(/^http/, 'ws');
const testAdmin = process.env.SMOKE_ADMIN !== 'false';
const post = async (path, payload) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const raw = await response.text();
  const data = raw ? JSON.parse(raw) : {};
  return { response, data };
};

const adminPayload = Buffer.from(JSON.stringify({
  scope: 'admin', uid: 'smoke-admin', name: 'Administrador de teste',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
})).toString('base64url');
const adminToken = `${adminPayload}.${createHmac('sha256', process.env.SMOKE_SESSION_SECRET || 'smoke-admin-secret').update(adminPayload).digest('base64url')}`;
const adminPost = async (path, payload = {}) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `discord_screen_admin=${adminToken}`,
      origin: base,
    },
    body: JSON.stringify(payload),
  });
  const raw = await response.text();
  const data = raw ? JSON.parse(raw) : {};
  return { response, data };
};

const health = await fetch(`${base}/api/health`);
assert.equal(health.status, 200);
assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
assert.match(health.headers.get('strict-transport-security') || '', /max-age=/);
assert.equal(health.headers.get('cache-control'), 'no-store');
assert.equal((await health.json()).architecture, 'cloudflare-workers-durable-objects');

const guest = await post('/api/session-guest', { name: 'Teste' });
assert.equal(guest.response.status, 200);
assert.ok(guest.data.identity);

const created = await post('/api/rooms/create', { identity: guest.data.identity, name: 'Sala teste', password: 'segredo' });
assert.equal(created.response.status, 200);
assert.ok(created.data.viewerToken);
const roomToken = JSON.parse(Buffer.from(created.data.viewerToken.split('.')[0], 'base64url').toString('utf8'));
assert.ok(roomToken.exp > Math.floor(Date.now() / 1000));
assert.ok(roomToken.exp <= Math.floor(Date.now() / 1000) + (8 * 60 * 60) + 5);

const listed = await post('/api/rooms/list', { identity: guest.data.identity });
assert.equal(listed.response.status, 200);
assert.equal(listed.data.rooms.some((room) => room.id === created.data.roomId), true);

const denied = await post('/api/rooms/join', { identity: guest.data.identity, roomId: created.data.roomId, password: 'errada' });
assert.equal(denied.response.status, 403);
const joined = await post('/api/rooms/join', { identity: guest.data.identity, roomId: created.data.roomId, password: 'segredo' });
assert.equal(joined.response.status, 200);

const privateRoom = await post('/api/rooms/create', {
  identity: guest.data.identity,
  name: 'Sala privada',
  private: true,
});
assert.equal(privateRoom.response.status, 200);
assert.equal(privateRoom.data.listed, false);
const visitor = await post('/api/session-guest', { name: 'Visitante' });
const unsignedPrivateJoin = await post('/api/rooms/join', {
  identity: visitor.data.identity,
  roomId: privateRoom.data.roomId,
});
assert.equal(unsignedPrivateJoin.response.status, 403);
assert.equal(unsignedPrivateJoin.data.reason, 'convite');
const hiddenList = await post('/api/rooms/list', { identity: guest.data.identity });
assert.equal(hiddenList.data.rooms.some((room) => room.id === privateRoom.data.roomId), false);
const inviteToken = new URL(privateRoom.data.inviteUrl).searchParams.get('convite');
const privateJoin = await post('/api/rooms/join', {
  identity: visitor.data.identity,
  roomId: privateRoom.data.roomId,
  invite: inviteToken,
});
assert.equal(privateJoin.response.status, 200);
const published = await post('/api/rooms/settings', {
  identity: guest.data.identity,
  roomId: privateRoom.data.roomId,
  listed: true,
});
assert.equal(published.response.status, 200);
assert.equal(published.data.listed, true);
const visibleList = await post('/api/rooms/list', { identity: guest.data.identity });
assert.equal(visibleList.data.rooms.some((room) => room.id === privateRoom.data.roomId), true);
assert.equal(visibleList.data.rooms.some((room) => /^(call|atividade)-/.test(room.id)), false);

if (testAdmin) {
  const anonymousAdmin = await post('/api/admin/overview', {});
  assert.equal(anonymousAdmin.response.status, 401);
  const stalePayload = Buffer.from(JSON.stringify({
    scope: 'admin', uid: 'smoke-admin', name: 'Administrador antigo',
    iat: Math.floor(Date.now() / 1000) - (5 * 60 * 60),
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  const staleToken = `${stalePayload}.${createHmac('sha256', process.env.SMOKE_SESSION_SECRET || 'smoke-admin-secret').update(stalePayload).digest('base64url')}`;
  const staleAdmin = await fetch(`${base}/api/admin/overview`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `discord_screen_admin=${staleToken}`, origin: base }, body: '{}',
  });
  assert.equal(staleAdmin.status, 401);
  const liveOverview = await adminPost('/api/admin/overview');
  assert.equal(liveOverview.response.status, 200);
  assert.equal(liveOverview.data.rooms.some((room) => room.id === created.data.roomId), true);
  assert.equal(liveOverview.data.bot.configured, false);
  assert.equal(liveOverview.data.bot.valid, false);
}

// Em desenvolvimento conseguimos emitir uma identidade de Activity sem falar
// com o Discord. Em produção essa rota retorna 404 e o teste é simplesmente
// ignorado. Quando disponível, comprova que a sala da call não vaza no lobby e
// não pode ser apagada manualmente.
const devCall = await post('/api/session-dev', {
  instance_id: `smoke-${Date.now()}`,
  name: 'Teste da call',
  call: '123456789012345678',
  guild_id: '987654321098765432',
  guild_name: 'Servidor do smoke',
  channel_name: 'Sala de estudos',
});
if (devCall.response.status === 200) {
  const callRoom = await post('/api/rooms/call', { identity: devCall.data.identity });
  assert.equal(callRoom.response.status, 200);
  const callList = await post('/api/rooms/list', { identity: devCall.data.identity });
  assert.equal(callList.data.rooms.some((room) => room.id === callRoom.data.roomId), false);
  const deleteCall = await post('/api/rooms/delete', {
    identity: devCall.data.identity,
    roomId: callRoom.data.roomId,
  });
  assert.equal(deleteCall.response.status, 403);

}

const openSocket = (token) => new WebSocket(`${socketBase}/ws?t=${encodeURIComponent(token)}`);
const waitJson = (ws, type) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('WebSocket timeout')), 5000);
  ws.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    const message = JSON.parse(event.data);
    if (message.type === type) { clearTimeout(timeout); resolve(message); }
  });
  ws.addEventListener('error', reject);
});

if (devCall.response.status === 200) {
  // Hierarquia da Activity: um moderador recebe o cargo no token assinado e
  // consegue remover um usuário comum da mesma sala da chamada.
  const moderationCall = `moderation-${Date.now()}`;
  const moderatorIdentity = await post('/api/session-dev', {
    instance_id: `smoke-mod-${Date.now()}`, name: 'Moderador', call: moderationCall,
    guild_id: '987654321098765432', access: 'moderator',
  });
  const regularIdentity = await post('/api/session-dev', {
    instance_id: `smoke-user-${Date.now()}`, name: 'Usuário', call: moderationCall,
    guild_id: '987654321098765432', access: 'user',
  });
  assert.equal(moderatorIdentity.data.user.access, 'moderator');
  const moderatorRoom = await post('/api/rooms/call', { identity: moderatorIdentity.data.identity });
  const regularRoom = await post('/api/rooms/call', { identity: regularIdentity.data.identity });
  const moderatorSocket = openSocket(moderatorRoom.data.viewerToken);
  const regularSocket = openSocket(regularRoom.data.viewerToken);
  await Promise.all([waitJson(moderatorSocket, 'state'), waitJson(regularSocket, 'state')]);
  const moderatedKick = waitJson(regularSocket, 'kicked');
  moderatorSocket.send(JSON.stringify({ type: 'kick', userId: regularIdentity.data.user.id }));
  await moderatedKick;
  moderatorSocket.close();
}

const viewer = openSocket(joined.data.viewerToken);
await waitJson(viewer, 'state');
const broadcasterToken = new URL(created.data.shareUrl).searchParams.get('t');
const broadcaster = openSocket(broadcasterToken);
const slot = (await waitJson(broadcaster, 'slot')).slot;
const streamStarted = waitJson(viewer, 'stream-start');
broadcaster.send(JSON.stringify({ type: 'start' }));
await streamStarted;
const keyframeRequested = waitJson(broadcaster, 'need-keyframe');
viewer.send(JSON.stringify({ type: 'watch', slot }));
await keyframeRequested;
const receivedFrame = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Binary relay timeout')), 5000);
  viewer.addEventListener('message', async (event) => {
    if (typeof event.data === 'string') return;
    const bytes = new Uint8Array(await event.data.arrayBuffer());
    if (bytes[0] === slot && bytes[1] === 1) { clearTimeout(timeout); resolve(); }
  });
});
broadcaster.send(Uint8Array.from([slot, 1, 42]));
await receivedFrame;

// Segundo plano: áudio continua, mas nenhum quadro de vídeo atravessa o relay.
const audioOnlyConfirmed = waitJson(viewer, 'audio-only');
viewer.send(JSON.stringify({ type: 'audio-only', slot, enabled: true }));
await audioOnlyConfirmed;
let leakedVideo = false;
const receivedAudio = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Audio-only relay timeout')), 5000);
  const listener = async (event) => {
    if (typeof event.data === 'string') return;
    const bytes = new Uint8Array(await event.data.arrayBuffer());
    if (bytes[0] !== slot) return;
    if (bytes[1] === 1 || bytes[1] === 2) leakedVideo = true;
    if (bytes[1] === 3) {
      clearTimeout(timeout);
      viewer.removeEventListener('message', listener);
      resolve();
    }
  };
  viewer.addEventListener('message', listener);
});
broadcaster.send(Uint8Array.from([slot, 1, 43]));
broadcaster.send(Uint8Array.from([slot, 3, 44]));
await receivedAudio;
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(leakedVideo, false);

const videoResumed = waitJson(viewer, 'audio-only');
const resumeKeyframe = waitJson(broadcaster, 'need-keyframe');
viewer.send(JSON.stringify({ type: 'audio-only', slot, enabled: false }));
await Promise.all([videoResumed, resumeKeyframe]);

// Se o primeiro quadro-chave da retomada se perder, o espectador pode pedir
// outro sem refazer a assinatura do stream nem reiniciar a conexão.
const retryKeyframe = waitJson(broadcaster, 'need-keyframe');
viewer.send(JSON.stringify({ type: 'request-keyframe', slot }));
await retryKeyframe;

const visitorJoin = await post('/api/rooms/join', {
  identity: visitor.data.identity,
  roomId: created.data.roomId,
  password: 'segredo',
});
assert.equal(visitorJoin.response.status, 200);
const visitorSocket = openSocket(visitorJoin.data.viewerToken);
await waitJson(visitorSocket, 'state');
const kicked = waitJson(visitorSocket, 'kicked');
viewer.send(JSON.stringify({ type: 'kick', userId: visitor.data.user.id }));
await kicked;
const blocked = await post('/api/rooms/join', {
  identity: visitor.data.identity,
  roomId: created.data.roomId,
  password: 'segredo',
});
assert.equal(blocked.response.status, 403);
assert.equal(blocked.data.reason, 'removido');

const forbiddenDelete = await post('/api/rooms/delete', {
  identity: visitor.data.identity,
  roomId: created.data.roomId,
});
assert.equal(forbiddenDelete.response.status, 403);

const viewerDeleted = waitJson(viewer, 'room-deleted');
const broadcasterDeleted = waitJson(broadcaster, 'room-deleted');
const deleted = await post('/api/rooms/delete', {
  identity: guest.data.identity,
  roomId: created.data.roomId,
});
assert.equal(deleted.response.status, 200);
assert.equal(deleted.data.ok, true);
await Promise.all([viewerDeleted, broadcasterDeleted]);

const gone = await post('/api/rooms/join', {
  identity: guest.data.identity,
  roomId: created.data.roomId,
  password: 'segredo',
});
assert.equal(gone.response.status, 404);

const deletedPrivate = await post('/api/rooms/delete', {
  identity: guest.data.identity,
  roomId: privateRoom.data.roomId,
});
assert.equal(deletedPrivate.response.status, 200);

const afterDelete = await post('/api/rooms/list', { identity: guest.data.identity });
assert.equal(afterDelete.data.rooms.some((room) => room.id === created.data.roomId), false);
assert.equal(afterDelete.data.rooms.some((room) => room.id === privateRoom.data.roomId), false);

if (testAdmin) {
  const adminRoom = await post('/api/rooms/create', {
    identity: guest.data.identity,
    name: 'Sala da administração',
  });
  assert.equal(adminRoom.response.status, 200);
  const adminViewer = openSocket(adminRoom.data.viewerToken);
  await waitJson(adminViewer, 'state');
  const adminClosed = waitJson(adminViewer, 'room-deleted');
  const closeResult = await adminPost('/api/admin/action', {
    action: 'close-room', roomId: adminRoom.data.roomId, reason: 'Teste automático',
  });
  assert.equal(closeResult.response.status, 200);
  await adminClosed;

  const blockedTarget = await post('/api/session-dev', {
    instance_id: 'web', user_id: 'blocked-test-user', name: 'Usuário bloqueado',
  });
  assert.equal(blockedTarget.response.status, 200);
  const blockResult = await adminPost('/api/admin/action', {
    action: 'block-user', userId: 'blocked-test-user', reason: 'Teste de bloqueio',
  });
  assert.equal(blockResult.response.status, 200);
  const deniedBlocked = await post('/api/rooms/create', {
    identity: blockedTarget.data.identity, name: 'Não deve criar',
  });
  assert.equal(deniedBlocked.response.status, 403);
  const unblockResult = await adminPost('/api/admin/action', {
    action: 'unblock', subjectType: 'user', subjectId: 'blocked-test-user',
  });
  assert.equal(unblockResult.response.status, 200);

  const maintenanceOn = await adminPost('/api/admin/action', { action: 'maintenance', enabled: true });
  assert.equal(maintenanceOn.response.status, 200);
  const maintenanceDenied = await post('/api/session-guest', { name: 'Durante manutenção' });
  assert.equal(maintenanceDenied.response.status, 503);
  const maintenanceOff = await adminPost('/api/admin/action', { action: 'maintenance', enabled: false });
  assert.equal(maintenanceOff.response.status, 200);

  const supporterId = '123456789012345678';
  const supporterSaved = await adminPost('/api/admin/action', {
    action: 'set-supporter', userId: supporterId, tier: 'founder',
    publicName: 'Apoiador de teste', showCredit: true,
  });
  assert.equal(supporterSaved.response.status, 200);
  const supporterSession = await post('/api/session-dev', {
    instance_id: 'web', user_id: supporterId, name: 'Apoiador de teste',
  });
  assert.equal(supporterSession.response.status, 200);
  assert.equal(supporterSession.data.user.supporter.tier, 'founder');
  const publicSupporters = await fetch(`${base}/api/supporters/public`).then((response) => response.json());
  assert.equal(publicSupporters.supporters.some((item) => item.name === 'Apoiador de teste'), true);
  const supporterRemoved = await adminPost('/api/admin/action', {
    action: 'remove-supporter', userId: supporterId,
  });
  assert.equal(supporterRemoved.response.status, 200);

  const finalOverview = await adminPost('/api/admin/overview');
  assert.equal(finalOverview.response.status, 200);
  assert.ok(finalOverview.data.audit.length >= 4);
  assert.ok(finalOverview.data.totals.launches >= 1);
  assert.ok(Array.isArray(finalOverview.data.analytics.daily));
  assert.ok(finalOverview.data.analytics.hourly.length <= 24);
  assert.ok(finalOverview.data.analytics.summary.launches7d >= 1);
  assert.ok(finalOverview.data.analytics.technical.completedStreams30d >= 1);
  assert.ok(Array.isArray(finalOverview.data.analytics.eventKinds));
  assert.ok(finalOverview.data.analytics.dataInventory.storedEvents >= 1);
  assert.equal('userId' in finalOverview.data.analytics.summary, false);
  assert.equal(finalOverview.data.servers.some((server) => server.guildId === '987654321098765432'), true);
  assert.equal('authorizedByName' in finalOverview.data.servers[0], true);
  adminViewer.close();
}

viewer.close();
broadcaster.close();
visitorSocket.close();
console.log(`Smoke completo em ${base}: OK`);
