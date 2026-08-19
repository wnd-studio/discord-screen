import { DurableObject } from 'cloudflare:workers';
import { json } from './http.js';

const MAX_ROOMS_PER_INSTANCE = 20;
const STALE_ROOM_GRACE_MS = 30_000;
const HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const cleanText = (value, max = 120) => {
  const result = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  return result || null;
};

const parseDetails = (value) => {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
};

export class RoomRegistry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        instance TEXT NOT NULL,
        name TEXT NOT NULL,
        owner_name TEXT NOT NULL,
        owner_id TEXT,
        guild_id TEXT,
        channel_id TEXT,
        locked INTEGER NOT NULL DEFAULT 0,
        listed INTEGER NOT NULL DEFAULT 1,
        is_call INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS rooms_instance ON rooms(instance);

      CREATE TABLE IF NOT EXISTS servers (
        guild_id TEXT PRIMARY KEY,
        name TEXT,
        icon TEXT,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        last_channel_id TEXT,
        last_channel_name TEXT,
        launches INTEGER NOT NULL DEFAULT 0,
        installed INTEGER NOT NULL DEFAULT 0,
        installed_at INTEGER,
        authorized_by TEXT
      );
      CREATE INDEX IF NOT EXISTS servers_last_seen ON servers(last_seen DESC);

      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        room_id TEXT,
        guild_id TEXT,
        channel_id TEXT,
        user_id TEXT,
        user_name TEXT,
        duration_ms INTEGER,
        created_at INTEGER NOT NULL,
        details TEXT
      );
      CREATE INDEX IF NOT EXISTS usage_kind_time ON usage_events(kind, created_at DESC);
      CREATE INDEX IF NOT EXISTS usage_guild_time ON usage_events(guild_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS admin_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_id TEXT NOT NULL,
        admin_name TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        details TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_time ON admin_audit(created_at DESC);

      CREATE TABLE IF NOT EXISTS blocks (
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        reason TEXT,
        expires_at INTEGER,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(subject_type, subject_id)
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );`
    );

    // Atualizações sem migração manual para quem já tem o Durable Object em produção.
    for (const statement of [
      'ALTER TABLE rooms ADD COLUMN listed INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE rooms ADD COLUMN owner_id TEXT',
      'ALTER TABLE rooms ADD COLUMN guild_id TEXT',
      'ALTER TABLE rooms ADD COLUMN channel_id TEXT',
    ]) {
      try { this.ctx.storage.sql.exec(statement); } catch {}
    }
    this.ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS rooms_guild ON rooms(guild_id)');
  }

  addEvent(payload) {
    this.ctx.storage.sql.exec(
      `INSERT INTO usage_events
       (kind, room_id, guild_id, channel_id, user_id, user_name, duration_ms, created_at, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      cleanText(payload.kind, 40), cleanText(payload.roomId, 80), cleanText(payload.guildId, 30),
      cleanText(payload.channelId, 30), cleanText(payload.userId, 40), cleanText(payload.userName, 64),
      Number.isFinite(payload.durationMs) ? Math.max(0, Math.round(payload.durationMs)) : null,
      Number(payload.createdAt) || Date.now(), payload.details ? JSON.stringify(payload.details).slice(0, 4000) : null
    );
  }

  cleanupHistory() {
    const row = this.ctx.storage.sql.exec(
      "SELECT value FROM settings WHERE key = 'last_cleanup'"
    ).toArray()[0];
    const now = Date.now();
    if (row && now - Number(row.value) < DAY_MS) return;
    this.ctx.storage.sql.exec('DELETE FROM usage_events WHERE created_at < ?', now - HISTORY_RETENTION_MS);
    this.ctx.storage.sql.exec('DELETE FROM blocks WHERE expires_at IS NOT NULL AND expires_at <= ?', now);
    this.ctx.storage.sql.exec(
      `INSERT INTO settings (key, value, updated_at) VALUES ('last_cleanup', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      String(now), now
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    const payload = request.method === 'POST' ? await request.json().catch(() => ({})) : {};

    if (url.pathname === '/list') return this.listRooms(payload.instance);

    if (url.pathname === '/put') {
      const count = this.ctx.storage.sql.exec(
        'SELECT COUNT(*) AS total FROM rooms WHERE instance = ? AND is_call = 0', payload.instance
      ).one().total;
      const exists = this.ctx.storage.sql.exec('SELECT id FROM rooms WHERE id = ?', payload.id).toArray()[0];
      if (!payload.isCall && !exists && count >= MAX_ROOMS_PER_INSTANCE) {
        return json({ error: 'Limite de salas abertas atingido. Feche uma antes de criar outra.' }, 409);
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO rooms
          (id, instance, name, owner_name, owner_id, guild_id, channel_id, locked, listed, is_call, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET instance=excluded.instance, name=excluded.name,
           owner_name=excluded.owner_name, owner_id=excluded.owner_id,
           guild_id=COALESCE(excluded.guild_id, rooms.guild_id),
           channel_id=COALESCE(excluded.channel_id, rooms.channel_id),
           locked=excluded.locked, listed=excluded.listed`,
        payload.id, payload.instance, payload.name, payload.ownerName,
        payload.ownerId ?? null, payload.guildId ?? null, payload.channelId ?? null,
        payload.locked ? 1 : 0, payload.listed === false ? 0 : 1,
        payload.isCall ? 1 : 0, payload.createdAt
      );
      if (!exists) this.addEvent({
        kind: 'room_created', roomId: payload.id, guildId: payload.guildId,
        channelId: payload.channelId, userId: payload.ownerId, userName: payload.ownerName,
        createdAt: payload.createdAt, details: { name: payload.name, isCall: Boolean(payload.isCall) },
      });
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
      const room = this.ctx.storage.sql.exec(
        'SELECT id, guild_id, channel_id, owner_id, owner_name FROM rooms WHERE id = ?', payload.id
      ).toArray()[0];
      this.ctx.storage.sql.exec('DELETE FROM rooms WHERE id = ?', payload.id);
      if (room) this.addEvent({
        kind: 'room_deleted', roomId: room.id, guildId: room.guild_id,
        channelId: room.channel_id, userId: room.owner_id, userName: room.owner_name,
        details: { reason: cleanText(payload.reason, 120) },
      });
      return json({ ok: true });
    }

    if (url.pathname === '/usage/launch') {
      this.cleanupHistory();
      const now = Number(payload.createdAt) || Date.now();
      if (payload.guildId) {
        this.ctx.storage.sql.exec(
          `INSERT INTO servers
            (guild_id, name, icon, first_seen, last_seen, last_channel_id, last_channel_name, launches)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)
           ON CONFLICT(guild_id) DO UPDATE SET
             name=COALESCE(excluded.name, servers.name), icon=COALESCE(excluded.icon, servers.icon),
             last_seen=excluded.last_seen, last_channel_id=excluded.last_channel_id,
             last_channel_name=COALESCE(excluded.last_channel_name, servers.last_channel_name),
             launches=servers.launches + 1`,
          payload.guildId, cleanText(payload.guildName, 100), cleanText(payload.guildIcon, 80),
          now, now, payload.channelId ?? null, cleanText(payload.channelName, 100)
        );
      }
      this.addEvent({
        kind: 'activity_launch', guildId: payload.guildId, channelId: payload.channelId,
        userId: payload.userId, userName: payload.userName, createdAt: now,
        details: { instance: cleanText(payload.instance, 160), verifiedGuild: Boolean(payload.verifiedGuild) },
      });
      return json({ ok: true });
    }

    if (url.pathname === '/event') {
      this.addEvent(payload);
      return json({ ok: true });
    }

    if (url.pathname === '/installation') {
      const data = payload.data || {};
      const guild = data.guild;
      const at = Number(payload.createdAt) || Date.now();
      if (payload.eventType === 'APPLICATION_AUTHORIZED' && guild?.id) {
        this.ctx.storage.sql.exec(
          `INSERT INTO servers
            (guild_id, name, icon, first_seen, last_seen, launches, installed, installed_at, authorized_by)
           VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)
           ON CONFLICT(guild_id) DO UPDATE SET name=COALESCE(excluded.name, servers.name),
             icon=COALESCE(excluded.icon, servers.icon), installed=1,
             installed_at=excluded.installed_at, authorized_by=excluded.authorized_by`,
          guild.id, cleanText(guild.name, 100), cleanText(guild.icon, 80), at, at, at, data.user?.id ?? null
        );
      }
      this.addEvent({
        kind: payload.eventType === 'APPLICATION_AUTHORIZED' ? 'application_authorized' : 'application_deauthorized',
        guildId: guild?.id, userId: data.user?.id, userName: data.user?.global_name || data.user?.username,
        createdAt: at, details: { integrationType: data.integration_type, scopes: data.scopes || [] },
      });
      return json({ ok: true });
    }

    if (url.pathname === '/block/check') {
      this.ctx.storage.sql.exec('DELETE FROM blocks WHERE expires_at IS NOT NULL AND expires_at <= ?', Date.now());
      const checks = [];
      if (payload.userId) checks.push(['user', payload.userId]);
      if (payload.guildId) checks.push(['guild', payload.guildId]);
      for (const [type, id] of checks) {
        const block = this.ctx.storage.sql.exec(
          'SELECT subject_type, subject_id, reason, expires_at FROM blocks WHERE subject_type = ? AND subject_id = ?',
          type, id
        ).toArray()[0];
        if (block) return json({ blocked: true, block });
      }
      return json({ blocked: false });
    }

    if (url.pathname === '/block/put') {
      if (!['user', 'guild'].includes(payload.subjectType) || !payload.subjectId) {
        return json({ error: 'Bloqueio inválido.' }, 400);
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO blocks (subject_type, subject_id, reason, expires_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(subject_type, subject_id) DO UPDATE SET reason=excluded.reason,
           expires_at=excluded.expires_at, created_by=excluded.created_by, created_at=excluded.created_at`,
        payload.subjectType, payload.subjectId, cleanText(payload.reason, 240),
        Number(payload.expiresAt) || null, payload.createdBy, Date.now()
      );
      return json({ ok: true });
    }

    if (url.pathname === '/block/delete') {
      this.ctx.storage.sql.exec(
        'DELETE FROM blocks WHERE subject_type = ? AND subject_id = ?', payload.subjectType, payload.subjectId
      );
      return json({ ok: true });
    }

    if (url.pathname === '/setting/get') {
      const row = this.ctx.storage.sql.exec('SELECT value FROM settings WHERE key = ?', payload.key).toArray()[0];
      return json({ value: row?.value ?? null });
    }

    if (url.pathname === '/setting/put') {
      this.ctx.storage.sql.exec(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        payload.key, String(payload.value ?? ''), Date.now()
      );
      return json({ ok: true });
    }

    if (url.pathname === '/admin/audit') {
      this.ctx.storage.sql.exec(
        `INSERT INTO admin_audit
          (admin_id, admin_name, action, target_type, target_id, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        payload.adminId, cleanText(payload.adminName, 64), payload.action,
        payload.targetType ?? null, payload.targetId ?? null,
        payload.details ? JSON.stringify(payload.details).slice(0, 4000) : null, Date.now()
      );
      return json({ ok: true });
    }

    if (url.pathname === '/admin/room-ids') {
      const rows = payload.guildId
        ? this.ctx.storage.sql.exec('SELECT id FROM rooms WHERE guild_id = ?', payload.guildId).toArray()
        : this.ctx.storage.sql.exec('SELECT id FROM rooms').toArray();
      return json({ roomIds: rows.map((row) => row.id) });
    }

    if (url.pathname === '/admin/overview') return this.adminOverview();

    return new Response('Not found', { status: 404 });
  }

  async listRooms(instance) {
    const rows = this.ctx.storage.sql.exec(
      `SELECT id, name, owner_name, locked, created_at
       FROM rooms WHERE instance = ? AND is_call = 0 AND listed = 1 ORDER BY created_at`,
      instance
    ).toArray();
    const rooms = await Promise.all(rows.map(async (row) => {
      const stub = this.env.ROOMS.get(this.env.ROOMS.idFromName(row.id));
      const response = await stub.fetch('https://room.internal/summary').catch(() => null);
      if (!response?.ok) {
        if (response?.status === 404 && Date.now() - Number(row.created_at) >= STALE_ROOM_GRACE_MS) {
          this.ctx.storage.sql.exec('DELETE FROM rooms WHERE id = ?', row.id);
        }
        return null;
      }
      const live = await response.json().catch(() => ({}));
      if (Number(live.people ?? 0) === 0 && Date.now() - Number(row.created_at) >= STALE_ROOM_GRACE_MS) {
        return null;
      }
      return {
        id: row.id, name: row.name, owner: row.owner_name, locked: Boolean(row.locked),
        people: live.people ?? 0, streams: live.streams ?? 0,
      };
    }));
    return json({ rooms: rooms.filter(Boolean) });
  }

  async adminOverview() {
    this.cleanupHistory();
    const now = Date.now();
    const roomRows = this.ctx.storage.sql.exec(
      `SELECT id, instance, name, owner_name, owner_id, guild_id, channel_id, is_call, created_at
       FROM rooms ORDER BY created_at DESC LIMIT 100`
    ).toArray();
    const rooms = (await Promise.all(roomRows.map(async (row) => {
      const stub = this.env.ROOMS.get(this.env.ROOMS.idFromName(row.id));
      const response = await stub.fetch('https://room.internal/admin/inspect').catch(() => null);
      if (!response?.ok) {
        if (response?.status === 404 && now - Number(row.created_at) >= STALE_ROOM_GRACE_MS) {
          this.ctx.storage.sql.exec('DELETE FROM rooms WHERE id = ?', row.id);
        }
        return null;
      }
      const live = await response.json().catch(() => ({}));
      return {
        id: row.id, instance: row.instance, name: row.name, ownerName: row.owner_name,
        ownerId: row.owner_id, guildId: row.guild_id, channelId: row.channel_id,
        isCall: Boolean(row.is_call), createdAt: row.created_at, ...live,
      };
    }))).filter(Boolean);

    const servers = this.ctx.storage.sql.exec(
      `SELECT guild_id, name, icon, first_seen, last_seen, last_channel_id,
              last_channel_name, launches, installed, installed_at, authorized_by
       FROM servers ORDER BY last_seen DESC LIMIT 100`
    ).toArray().map((row) => ({
      guildId: row.guild_id, name: row.name, icon: row.icon, firstSeen: row.first_seen,
      lastSeen: row.last_seen, lastChannelId: row.last_channel_id,
      lastChannelName: row.last_channel_name, launches: row.launches,
      installed: Boolean(row.installed), installedAt: row.installed_at, authorizedBy: row.authorized_by,
    }));
    const blocks = this.ctx.storage.sql.exec(
      `SELECT subject_type, subject_id, reason, expires_at, created_by, created_at
       FROM blocks ORDER BY created_at DESC LIMIT 100`
    ).toArray().map((row) => ({
      subjectType: row.subject_type, subjectId: row.subject_id, reason: row.reason,
      expiresAt: row.expires_at, createdBy: row.created_by, createdAt: row.created_at,
    }));
    const audit = this.ctx.storage.sql.exec(
      `SELECT admin_id, admin_name, action, target_type, target_id, details, created_at
       FROM admin_audit ORDER BY created_at DESC LIMIT 50`
    ).toArray().map((row) => ({
      adminId: row.admin_id, adminName: row.admin_name, action: row.action,
      targetType: row.target_type, targetId: row.target_id,
      details: parseDetails(row.details), createdAt: row.created_at,
    }));
    const daily = this.ctx.storage.sql.exec(
      `SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS launches
       FROM usage_events WHERE kind = 'activity_launch' AND created_at >= ?
       GROUP BY day ORDER BY day`, now - 14 * DAY_MS
    ).toArray();
    const totals = {
      servers: this.ctx.storage.sql.exec('SELECT COUNT(*) AS total FROM servers').one().total,
      launches: this.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM usage_events WHERE kind = 'activity_launch'"
      ).one().total,
      launches30d: this.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM usage_events WHERE kind = 'activity_launch' AND created_at >= ?", now - 30 * DAY_MS
      ).one().total,
      uniqueUsers30d: this.ctx.storage.sql.exec(
        "SELECT COUNT(DISTINCT user_id) AS total FROM usage_events WHERE kind = 'activity_launch' AND created_at >= ?", now - 30 * DAY_MS
      ).one().total,
      streams30d: this.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM usage_events WHERE kind = 'stream_started' AND created_at >= ?", now - 30 * DAY_MS
      ).one().total,
      streamedMs30d: this.ctx.storage.sql.exec(
        "SELECT COALESCE(SUM(duration_ms), 0) AS total FROM usage_events WHERE kind = 'stream_stopped' AND created_at >= ?", now - 30 * DAY_MS
      ).one().total,
      activeRooms: rooms.length,
      activePeople: rooms.reduce((sum, room) => sum + Number(room.people || 0), 0),
      activeStreams: rooms.reduce((sum, room) => sum + Number(room.streams?.length || room.streamCount || 0), 0),
    };
    const maintenance = this.ctx.storage.sql.exec(
      "SELECT value FROM settings WHERE key = 'maintenance'"
    ).toArray()[0]?.value === 'true';

    return json({ generatedAt: now, totals, rooms, servers, blocks, audit, daily, maintenance });
  }
}
