import { DurableObject } from 'cloudflare:workers';
import { json } from './http.js';

const MAX_ROOMS_PER_INSTANCE = 20;

export class RoomRegistry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        instance TEXT NOT NULL,
        name TEXT NOT NULL,
        owner_name TEXT NOT NULL,
        locked INTEGER NOT NULL DEFAULT 0,
        listed INTEGER NOT NULL DEFAULT 1,
        is_call INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      ); CREATE INDEX IF NOT EXISTS rooms_instance ON rooms(instance);`
    );
    // A tabela já existe nas contas que receberam a primeira versão.
    try {
      this.ctx.storage.sql.exec('ALTER TABLE rooms ADD COLUMN listed INTEGER NOT NULL DEFAULT 1');
    } catch {}
  }

  async fetch(request) {
    const url = new URL(request.url);
    const payload = request.method === 'POST' ? await request.json().catch(() => ({})) : {};

    if (url.pathname === '/list') {
      const rows = this.ctx.storage.sql.exec(
        `SELECT id, name, owner_name, locked, created_at
         FROM rooms WHERE instance = ? AND is_call = 0 AND listed = 1 ORDER BY created_at`,
        payload.instance
      ).toArray();
      const rooms = await Promise.all(rows.map(async (row) => {
        const stub = this.env.ROOMS.get(this.env.ROOMS.idFromName(row.id));
        const live = await stub.fetch('https://room.internal/summary').then((r) => r.json()).catch(() => ({}));
        return {
          id: row.id,
          name: row.name,
          owner: row.owner_name,
          locked: Boolean(row.locked),
          people: live.people ?? 0,
          streams: live.streams ?? 0,
        };
      }));
      return json({ rooms });
    }

    if (url.pathname === '/put') {
      const count = this.ctx.storage.sql.exec(
        'SELECT COUNT(*) AS total FROM rooms WHERE instance = ? AND is_call = 0', payload.instance
      ).one().total;
      if (!payload.isCall && count >= MAX_ROOMS_PER_INSTANCE) {
        return json({ error: 'Limite de salas abertas atingido. Feche uma antes de criar outra.' }, 409);
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO rooms (id, instance, name, owner_name, locked, listed, is_call, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET instance=excluded.instance, name=excluded.name,
           owner_name=excluded.owner_name, locked=excluded.locked, listed=excluded.listed`,
        payload.id, payload.instance, payload.name, payload.ownerName,
        payload.locked ? 1 : 0, payload.listed === false ? 0 : 1,
        payload.isCall ? 1 : 0, payload.createdAt
      );
      return json({ ok: true });
    }

    if (url.pathname === '/locked') {
      this.ctx.storage.sql.exec('UPDATE rooms SET locked = ? WHERE id = ?', payload.locked ? 1 : 0, payload.id);
      return json({ ok: true });
    }

    if (url.pathname === '/settings') {
      this.ctx.storage.sql.exec(
        'UPDATE rooms SET locked = ?, listed = ? WHERE id = ?',
        payload.locked ? 1 : 0, payload.listed === false ? 0 : 1, payload.id
      );
      return json({ ok: true });
    }

    if (url.pathname === '/delete') {
      this.ctx.storage.sql.exec('DELETE FROM rooms WHERE id = ?', payload.id);
      return json({ ok: true });
    }

    return new Response('Not found', { status: 404 });
  }
}
