import { DurableObject } from 'cloudflare:workers';
import { json } from './http.js';
import { hashPassword, passwordMatches } from './passwords.js';

const MAX_BROADCASTERS = 4;
const MAX_VIEWERS = 50;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 60_000;
const LOCKOUT_MS = 30_000;
const EMPTY_GRACE_MS = 12_000;
const KEYFRAME = 1;
const AUDIO = 3;

const safeSend = (ws, value) => {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(value);
  } catch {}
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.meta = null;
    this.ctx.blockConcurrencyWhile(async () => {
      this.meta = await this.ctx.storage.get('meta') ?? null;
      if (this.meta) {
        this.meta.listed = this.meta.listed !== false;
        this.meta.banned = Array.isArray(this.meta.banned) ? this.meta.banned : [];
      }
    });
  }

  sockets(role = null) {
    return this.ctx.getWebSockets().filter((ws) => {
      const attachment = ws.deserializeAttachment();
      return !role || attachment?.role === role;
    });
  }

  attachment(ws) {
    return ws.deserializeAttachment() ?? {};
  }

  save(ws, attachment) {
    ws.serializeAttachment(attachment);
  }

  broadcasters() {
    return this.sockets('broadcaster').map((ws) => ({ ws, a: this.attachment(ws) }));
  }

  viewers() {
    return this.sockets('viewer').map((ws) => ({ ws, a: this.attachment(ws) }));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade') === 'websocket') return this.upgrade(request);

    if (url.pathname === '/init' && request.method === 'POST') {
      if (!this.meta) {
        const data = await request.json();
        this.meta = {
          ...data,
          password: data.password ? await hashPassword(data.password) : null,
          attempts: [],
          lockedUntil: 0,
          droppedChunks: 0,
          banned: [],
        };
        await this.ctx.storage.put('meta', this.meta);
        // Uma sala criada mas nunca conectada também precisa expirar; sem este
        // alarm ela ficaria presa no índice e consumiria o limite da instância.
        await this.ctx.storage.setAlarm(Date.now() + EMPTY_GRACE_MS);
      } else if (this.meta.isCall) {
        const data = await request.json();
        this.meta.instance = data.instance;
        await this.ctx.storage.put('meta', this.meta);
      }
      return json({ room: this.publicMeta() });
    }

    if (!this.meta) return json({ error: 'Sala não existe mais.' }, 404);
    if (url.pathname === '/meta') return json({ room: this.publicMeta() });
    if (url.pathname === '/summary') {
      const ids = new Set();
      for (const { a } of this.viewers()) ids.add(a.uid);
      for (const { a } of this.broadcasters()) ids.add(a.uid);
      return json({
        people: ids.size,
        viewers: this.viewers().length,
        maxViewers: MAX_VIEWERS,
        streams: this.broadcasters().filter(({ a }) => a.streaming).length,
      });
    }

    if (url.pathname === '/access/check' && request.method === 'POST') {
      const { uid } = await request.json().catch(() => ({}));
      if (this.meta.banned?.includes(uid)) return json({ ok: false, reason: 'removido' });
      const others = this.viewers().filter(({ a }) => a.uid !== uid);
      if (others.length >= MAX_VIEWERS) return json({ ok: false, reason: 'cheia' });
      return json({ ok: true });
    }

    if (url.pathname === '/password/check' && request.method === 'POST') {
      const { password } = await request.json().catch(() => ({}));
      const now = Date.now();
      if (this.meta.lockedUntil > now) {
        return json({ ok: false, reason: 'bloqueado', seconds: Math.ceil((this.meta.lockedUntil - now) / 1000) });
      }
      if (await passwordMatches(this.meta.password, password)) {
        this.meta.attempts = [];
        this.meta.lockedUntil = 0;
        await this.ctx.storage.put('meta', this.meta);
        return json({ ok: true });
      }
      this.meta.attempts = this.meta.attempts.filter((time) => now - time < ATTEMPT_WINDOW_MS);
      this.meta.attempts.push(now);
      if (this.meta.attempts.length >= MAX_ATTEMPTS) this.meta.lockedUntil = now + LOCKOUT_MS;
      await this.ctx.storage.put('meta', this.meta);
      return json({
        ok: false,
        reason: this.meta.lockedUntil > now ? 'bloqueado' : 'senha',
        seconds: this.meta.lockedUntil > now ? Math.ceil(LOCKOUT_MS / 1000) : undefined,
      });
    }

    if ((url.pathname === '/password/set' || url.pathname === '/settings') && request.method === 'POST') {
      const { uid, password, listed } = await request.json().catch(() => ({}));
      if (uid !== this.meta.ownerId) return json({ error: 'Só quem criou a sala pode alterar esses ajustes.' }, 403);
      this.meta.password = password ? await hashPassword(password) : null;
      if (url.pathname === '/settings') this.meta.listed = listed !== false;
      this.meta.attempts = [];
      this.meta.lockedUntil = 0;
      await this.ctx.storage.put('meta', this.meta);
      await this.registry('/settings', {
        id: this.meta.id,
        locked: Boolean(this.meta.password),
        listed: this.meta.listed !== false,
      });
      this.broadcastState();
      return json({
        ok: true,
        locked: Boolean(this.meta.password),
        listed: this.meta.listed !== false,
      });
    }

    return new Response('Not found', { status: 404 });
  }

  publicMeta() {
    return {
      id: this.meta.id,
      instance: this.meta.instance,
      name: this.meta.name,
      ownerId: this.meta.ownerId,
      ownerName: this.meta.ownerName,
      isCall: Boolean(this.meta.isCall),
      locked: Boolean(this.meta.password),
      listed: this.meta.listed !== false,
      createdAt: this.meta.createdAt,
    };
  }

  upgrade(request) {
    if (!this.meta) return new Response('Sala não existe mais.', { status: 404 });
    let auth;
    try { auth = JSON.parse(request.headers.get('x-room-auth')); } catch { return new Response('Unauthorized', { status: 401 }); }
    if (this.meta.banned?.includes(auth.uid)) return new Response('Removido', { status: 403 });
    const role = auth.role === 'broadcaster' ? 'broadcaster' : 'viewer';
    if (role === 'broadcaster') {
      const current = this.broadcasters();
      if (current.some(({ a }) => a.uid === auth.uid)) return new Response('Você já está transmitindo.', { status: 409 });
      if (current.length >= MAX_BROADCASTERS) return new Response('Limite de transmissões atingido.', { status: 409 });
      const used = new Set(current.map(({ a }) => a.slot));
      auth.slot = [0, 1, 2, 3].find((slot) => !used.has(slot));
      auth.streaming = false;
      auth.config = null;
      auth.audioConfig = null;
    } else {
      const previous = this.viewers().filter(({ a }) => a.uid === auth.uid);
      const others = this.viewers().filter(({ a }) => a.uid !== auth.uid);
      if (others.length >= MAX_VIEWERS) return new Response('Sala cheia', { status: 409 });
      for (const { ws } of previous) ws.close(1000, 'Conexão substituída');
      auth.watching = [];
      auth.primed = [];
    }
    auth.role = role;
    auth.name = String(auth.name ?? 'Convidado').slice(0, 32);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [role]);
    this.save(server, auth);
    this.ctx.storage.deleteAlarm();
    if (role === 'broadcaster') safeSend(server, JSON.stringify({ type: 'slot', slot: auth.slot }));
    else {
      safeSend(server, JSON.stringify(this.roomState()));
      for (const { a } of this.broadcasters()) {
        if (a.streaming) safeSend(server, JSON.stringify({ type: 'stream-start', slot: a.slot, userId: a.uid }));
      }
    }
    this.broadcastState();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const a = this.attachment(ws);
    if (typeof message !== 'string') {
      if (a.role === 'broadcaster') this.relayChunk(a, message);
      return;
    }
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    if (a.role === 'broadcaster') this.broadcasterMessage(ws, a, msg);
    else await this.viewerMessage(ws, a, msg);
  }

  broadcasterMessage(ws, a, msg) {
    if (msg.type === 'start') {
      a.streaming = true; a.config = null; a.audioConfig = null; this.save(ws, a);
      for (const viewer of this.sockets('viewer')) {
        const va = this.attachment(viewer); va.watching = va.watching.filter((slot) => slot !== a.slot); va.primed = va.primed.filter((slot) => slot !== a.slot); this.save(viewer, va);
        safeSend(viewer, JSON.stringify({ type: 'stream-start', slot: a.slot, userId: a.uid }));
      }
      this.broadcastState();
    } else if (msg.type === 'config' && msg.config) {
      a.config = msg.config; this.save(ws, a);
      for (const viewer of this.sockets('viewer')) {
        const va = this.attachment(viewer); va.primed = va.primed.filter((slot) => slot !== a.slot); this.save(viewer, va);
        if (va.watching.includes(a.slot)) safeSend(viewer, JSON.stringify({ type: 'config', slot: a.slot, config: a.config }));
      }
    } else if (msg.type === 'audio-config' && msg.config) {
      a.audioConfig = msg.config; this.save(ws, a);
      for (const viewer of this.sockets('viewer')) if (this.attachment(viewer).watching.includes(a.slot)) safeSend(viewer, JSON.stringify({ type: 'audio-config', slot: a.slot, config: a.audioConfig }));
    } else if (msg.type === 'stop') this.stopStream(ws, a);
  }

  async viewerMessage(ws, a, msg) {
    if (msg.type === 'rename' && typeof msg.name === 'string') {
      const name = msg.name.replace(/\s+/g, ' ').trim().slice(0, 32);
      if (name) { a.name = name; this.save(ws, a); this.broadcastState(); }
    } else if (msg.type === 'watch' && Number.isInteger(msg.slot) && !a.watching.includes(msg.slot)) {
      const broadcaster = this.broadcasters().find(({ a: ba }) => ba.slot === msg.slot && ba.streaming);
      if (!broadcaster) return;
      a.watching.push(msg.slot); a.primed = a.primed.filter((slot) => slot !== msg.slot); this.save(ws, a);
      if (broadcaster.a.config) safeSend(ws, JSON.stringify({ type: 'config', slot: msg.slot, config: broadcaster.a.config }));
      if (broadcaster.a.audioConfig) safeSend(ws, JSON.stringify({ type: 'audio-config', slot: msg.slot, config: broadcaster.a.audioConfig }));
      safeSend(broadcaster.ws, JSON.stringify({ type: 'need-keyframe' })); this.broadcastState();
    } else if (msg.type === 'unwatch' && Number.isInteger(msg.slot)) {
      const before = a.watching.length; a.watching = a.watching.filter((slot) => slot !== msg.slot); a.primed = a.primed.filter((slot) => slot !== msg.slot); this.save(ws, a);
      if (a.watching.length !== before) this.broadcastState();
    } else if (msg.type === 'stop-broadcast') {
      const broadcaster = this.broadcasters().find(({ a: ba }) => ba.uid === a.uid);
      if (broadcaster) safeSend(broadcaster.ws, JSON.stringify({ type: 'stop-request' }));
    } else if (msg.type === 'kick' && a.uid === this.meta.ownerId) {
      const target = String(msg.userId ?? '');
      if (!target || target === this.meta.ownerId) return;
      if (!this.meta.banned.includes(target)) {
        this.meta.banned.push(target);
        await this.ctx.storage.put('meta', this.meta);
      }
      for (const socket of this.ctx.getWebSockets()) {
        if (this.attachment(socket).uid !== target) continue;
        safeSend(socket, JSON.stringify({ type: 'kicked' }));
        socket.close(1008, 'Removido pelo dono da sala');
      }
      this.broadcastState();
    }
  }

  relayChunk(broadcaster, message) {
    const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
    if (bytes.length < 2 || bytes[0] !== broadcaster.slot) return;
    const type = bytes[1];
    for (const viewer of this.sockets('viewer')) {
      const a = this.attachment(viewer);
      if (!a.watching.includes(broadcaster.slot)) continue;
      if (type !== AUDIO && type !== KEYFRAME && !a.primed.includes(broadcaster.slot)) continue;
      const limit = type === KEYFRAME ? MAX_BUFFERED_BYTES * 2 : MAX_BUFFERED_BYTES;
      if (viewer.bufferedAmount > limit) { this.meta.droppedChunks++; continue; }
      safeSend(viewer, message);
      if (type === KEYFRAME && !a.primed.includes(broadcaster.slot)) { a.primed.push(broadcaster.slot); this.save(viewer, a); }
    }
  }

  stopStream(ws, a) {
    if (!a.streaming) return;
    a.streaming = false; a.config = null; a.audioConfig = null; this.save(ws, a);
    for (const viewer of this.sockets('viewer')) {
      const va = this.attachment(viewer); va.watching = va.watching.filter((slot) => slot !== a.slot); va.primed = va.primed.filter((slot) => slot !== a.slot); this.save(viewer, va);
      safeSend(viewer, JSON.stringify({ type: 'stream-stop', slot: a.slot }));
    }
    this.broadcastState();
  }

  webSocketClose(ws) { this.disconnected(ws); }
  webSocketError(ws) { this.disconnected(ws); }

  disconnected(ws) {
    const a = this.attachment(ws);
    if (a.role === 'broadcaster' && a.streaming) {
      for (const viewer of this.sockets('viewer')) safeSend(viewer, JSON.stringify({ type: 'stream-stop', slot: a.slot }));
    }
    this.broadcastState();
    if (this.ctx.getWebSockets().length <= 1) this.ctx.storage.setAlarm(Date.now() + EMPTY_GRACE_MS);
  }

  roomState() {
    const participants = new Map();
    for (const { a } of this.viewers()) participants.set(a.uid, { id: a.uid, name: a.name, avatar: a.avatar ?? null, broadcasting: false });
    for (const { a } of this.broadcasters()) participants.set(a.uid, { id: a.uid, name: a.name, avatar: a.avatar ?? null, broadcasting: true });
    const broadcasters = this.broadcasters();
    return {
      type: 'state',
      room: {
        id: this.meta.id,
        name: this.meta.name,
        ownerId: this.meta.ownerId,
        locked: Boolean(this.meta.password),
        listed: this.meta.listed !== false,
        maxViewers: MAX_VIEWERS,
      },
      broadcasting: broadcasters.length > 0,
      viewers: this.viewers().length,
      participants: [...participants.values()].sort((x, y) => Number(y.broadcasting) - Number(x.broadcasting)),
      streams: broadcasters.filter(({ a }) => a.streaming).map(({ a }) => ({
        slot: a.slot, userId: a.uid,
        watchers: this.viewers().filter(({ a: va }) => va.watching.includes(a.slot)).map(({ a: va }) => ({ id: va.uid, name: va.name, avatar: va.avatar ?? null })),
      })),
    };
  }

  broadcastState() {
    if (!this.meta) return;
    const message = JSON.stringify(this.roomState());
    for (const ws of this.ctx.getWebSockets()) safeSend(ws, message);
  }

  async alarm() {
    if (this.ctx.getWebSockets().length) return;
    await this.registry('/delete', { id: this.meta.id });
    await this.ctx.storage.deleteAll();
    this.meta = null;
  }

  registry(path, payload) {
    const registry = this.env.ROOM_INDEX.get(this.env.ROOM_INDEX.idFromName('global'));
    return registry.fetch(`https://registry.internal${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
  }
}
