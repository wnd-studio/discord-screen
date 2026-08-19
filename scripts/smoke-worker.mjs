import assert from 'node:assert/strict';

const base = (process.env.SMOKE_BASE || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const socketBase = base.replace(/^http/, 'ws');
const post = async (path, payload) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const raw = await response.text();
  const data = raw ? JSON.parse(raw) : {};
  return { response, data };
};

const health = await fetch(`${base}/api/health`);
assert.equal(health.status, 200);
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

// Em desenvolvimento conseguimos emitir uma identidade de Activity sem falar
// com o Discord. Em produção essa rota retorna 404 e o teste é simplesmente
// ignorado. Quando disponível, comprova que a sala da call não vaza no lobby e
// não pode ser apagada manualmente.
const devCall = await post('/api/session-dev', {
  instance_id: `smoke-${Date.now()}`,
  name: 'Teste da call',
  call: '123456789012345678',
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

viewer.close();
broadcaster.close();
visitorSocket.close();
console.log(`Smoke completo em ${base}: OK`);
