import assert from 'node:assert/strict';

const base = 'http://127.0.0.1:8787';
const post = async (path, payload) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const data = await response.json();
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

const listed = await post('/api/rooms/list', { identity: guest.data.identity });
assert.equal(listed.response.status, 200);
assert.equal(listed.data.rooms.some((room) => room.id === created.data.roomId), true);

const denied = await post('/api/rooms/join', { identity: guest.data.identity, roomId: created.data.roomId, password: 'errada' });
assert.equal(denied.response.status, 403);
const joined = await post('/api/rooms/join', { identity: guest.data.identity, roomId: created.data.roomId, password: 'segredo' });
assert.equal(joined.response.status, 200);

const openSocket = (token) => new WebSocket(`ws://127.0.0.1:8787/ws?t=${encodeURIComponent(token)}`);
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
viewer.close(); broadcaster.close();
console.log('Smoke HTTP + salas + senha + WebSocket + relay binário: OK');



