import { DurableObject } from 'cloudflare:workers';
import { json } from './http.js';

const MAX_ROOMS_PER_INSTANCE = 20;
const STALE_ROOM_GRACE_MS = 30_000;
const HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const AUDIT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const PUBLICATION_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const USER_NAME_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
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
        authorized_by TEXT,
        authorized_by_name TEXT
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
      CREATE INDEX IF NOT EXISTS usage_time ON usage_events(created_at DESC);

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
      );

      CREATE TABLE IF NOT EXISTS rate_limits (
        bucket TEXT PRIMARY KEY,
        hits INTEGER NOT NULL,
        window_start INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS changelog_channels (
        guild_id TEXT PRIMARY KEY,
        guild_name TEXT,
        channel_id TEXT NOT NULL,
        channel_name TEXT,
        configured_by TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_sent_at INTEGER,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS changelog_enabled ON changelog_channels(enabled, updated_at DESC);

      CREATE TABLE IF NOT EXISTS changelog_publications (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT,
        details TEXT,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS supporters (
        user_id TEXT PRIMARY KEY,
        tier TEXT NOT NULL,
        public_name TEXT,
        show_credit INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        expires_at INTEGER,
        created_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );`
    );

    // Atualizações sem migração manual para quem já tem o Durable Object em produção.
    for (const statement of [
      'ALTER TABLE rooms ADD COLUMN listed INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE rooms ADD COLUMN owner_id TEXT',
      'ALTER TABLE rooms ADD COLUMN guild_id TEXT',
      'ALTER TABLE rooms ADD COLUMN channel_id TEXT',
      'ALTER TABLE servers ADD COLUMN authorized_by_name TEXT',
    ]) {
      try { this.ctx.storage.sql.exec(statement); } catch {}
    }
    this.ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS rooms_guild ON rooms(guild_id)');
    this.ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS usage_time ON usage_events(created_at DESC)');
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
    this.ctx.storage.sql.exec(
      'UPDATE usage_events SET user_name = NULL WHERE created_at < ? AND user_name IS NOT NULL',
      now - USER_NAME_RETENTION_MS
    );
    this.ctx.storage.sql.exec('DELETE FROM admin_audit WHERE created_at < ?', now - AUDIT_RETENTION_MS);
    this.ctx.storage.sql.exec('DELETE FROM changelog_publications WHERE created_at < ?', now - PUBLICATION_RETENTION_MS);
    this.ctx.storage.sql.exec('DELETE FROM blocks WHERE expires_at IS NOT NULL AND expires_at <= ?', now);
    this.ctx.storage.sql.exec('DELETE FROM rate_limits WHERE window_start < ?', now - 2 * DAY_MS);
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

    if (url.pathname === '/rate/check') {
      const now = Date.now();
      const bucket = cleanText(payload.bucket, 160);
      const limit = Math.min(1000, Math.max(1, Number(payload.limit) || 30));
      const windowMs = Math.min(DAY_MS, Math.max(1000, Number(payload.windowMs) || 60_000));
      if (!bucket) return json({ allowed: false, retryAfter: 60 }, 400);
      const current = this.ctx.storage.sql.exec(
        'SELECT hits, window_start FROM rate_limits WHERE bucket = ?', bucket
      ).toArray()[0];
      if (!current || now - Number(current.window_start) >= windowMs) {
        this.ctx.storage.sql.exec(
          `INSERT INTO rate_limits (bucket, hits, window_start) VALUES (?, 1, ?)
           ON CONFLICT(bucket) DO UPDATE SET hits=1, window_start=excluded.window_start`,
          bucket, now
        );
        return json({ allowed: true, remaining: limit - 1 });
      }
      const hits = Number(current.hits) + 1;
      this.ctx.storage.sql.exec('UPDATE rate_limits SET hits = ? WHERE bucket = ?', hits, bucket);
      return json({
        allowed: hits <= limit,
        remaining: Math.max(0, limit - hits),
        retryAfter: Math.max(1, Math.ceil((windowMs - (now - Number(current.window_start))) / 1000)),
      });
    }

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
            (guild_id, name, icon, first_seen, last_seen, launches, installed, installed_at, authorized_by, authorized_by_name)
           VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?)
           ON CONFLICT(guild_id) DO UPDATE SET name=COALESCE(excluded.name, servers.name),
             icon=COALESCE(excluded.icon, servers.icon), installed=1,
             installed_at=excluded.installed_at, authorized_by=excluded.authorized_by,
             authorized_by_name=excluded.authorized_by_name`,
          guild.id, cleanText(guild.name, 100), cleanText(guild.icon, 80), at, at, at,
          data.user?.id ?? null, cleanText(data.user?.global_name || data.user?.username, 64)
        );
      } else if (payload.eventType === 'APPLICATION_DEAUTHORIZED' && guild?.id) {
        this.ctx.storage.sql.exec(
          'UPDATE servers SET installed = 0, last_seen = ? WHERE guild_id = ?', at, guild.id
        );
        this.ctx.storage.sql.exec(
          `UPDATE changelog_channels SET enabled = 0, updated_at = ?,
             last_error = 'Aplicativo removido do servidor' WHERE guild_id = ?`, at, guild.id
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

    if (url.pathname === '/supporter/get') {
      const row = this.ctx.storage.sql.exec(
        `SELECT user_id, tier, public_name, show_credit, started_at, expires_at
         FROM supporters WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
        String(payload.userId || ''), Date.now()
      ).toArray()[0];
      return json({ supporter: row ? {
        userId: row.user_id, tier: row.tier, publicName: row.public_name,
        showCredit: Boolean(row.show_credit), startedAt: row.started_at, expiresAt: row.expires_at,
      } : null });
    }

    if (url.pathname === '/supporter/public') {
      const rows = this.ctx.storage.sql.exec(
        `SELECT tier, public_name FROM supporters
         WHERE show_credit = 1 AND public_name IS NOT NULL
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY CASE tier WHEN 'founder' THEN 0 ELSE 1 END, started_at`,
        Date.now()
      ).toArray();
      return json({ supporters: rows.map((row) => ({ tier: row.tier, name: row.public_name })) });
    }

    if (url.pathname === '/supporter/put') {
      if (!/^\d{15,21}$/.test(String(payload.userId || '')) || !['supporter', 'founder'].includes(payload.tier)) {
        return json({ error: 'Cadastro de apoiador inválido.' }, 400);
      }
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `INSERT INTO supporters
          (user_id, tier, public_name, show_credit, started_at, expires_at, created_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET tier=excluded.tier, public_name=excluded.public_name,
           show_credit=excluded.show_credit, expires_at=excluded.expires_at,
           created_by=excluded.created_by, updated_at=excluded.updated_at`,
        payload.userId, payload.tier, cleanText(payload.publicName, 64), payload.showCredit ? 1 : 0,
        Number(payload.startedAt) || now, Number(payload.expiresAt) || null, payload.createdBy, now
      );
      return json({ ok: true });
    }

    if (url.pathname === '/supporter/delete') {
      this.ctx.storage.sql.exec('DELETE FROM supporters WHERE user_id = ?', String(payload.userId || ''));
      return json({ ok: true });
    }

    if (url.pathname === '/changelog/configure') {
      if (!payload.guildId || !payload.channelId || !payload.configuredBy) {
        return json({ error: 'Configuração de canal inválida.' }, 400);
      }
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `INSERT INTO changelog_channels
          (guild_id, guild_name, channel_id, channel_name, configured_by, enabled, created_at, updated_at, last_error)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL)
         ON CONFLICT(guild_id) DO UPDATE SET guild_name=excluded.guild_name,
           channel_id=excluded.channel_id, channel_name=excluded.channel_name,
           configured_by=excluded.configured_by, enabled=1, updated_at=excluded.updated_at,
           last_error=NULL`,
        payload.guildId, cleanText(payload.guildName, 100), payload.channelId,
        cleanText(payload.channelName, 100), payload.configuredBy, now, now
      );
      return json({ ok: true });
    }

    if (url.pathname === '/changelog/list') {
      const rows = this.ctx.storage.sql.exec(
        `SELECT guild_id, guild_name, channel_id, channel_name, configured_by,
                enabled, created_at, updated_at, last_sent_at, last_error
         FROM changelog_channels ORDER BY updated_at DESC`
      ).toArray().map((row) => ({
        guildId: row.guild_id, guildName: row.guild_name, channelId: row.channel_id,
        channelName: row.channel_name, configuredBy: row.configured_by,
        enabled: Boolean(row.enabled), createdAt: row.created_at, updatedAt: row.updated_at,
        lastSentAt: row.last_sent_at, lastError: row.last_error,
      }));
      return json({ channels: rows });
    }

    if (url.pathname === '/changelog/delivery') {
      this.ctx.storage.sql.exec(
        `UPDATE changelog_channels SET enabled = ?, last_sent_at = ?, last_error = ? WHERE guild_id = ?`,
        payload.disable ? 0 : 1, payload.ok ? Date.now() : null,
        payload.ok ? null : cleanText(payload.error, 240), payload.guildId
      );
      return json({ ok: true });
    }

    if (url.pathname === '/changelog/toggle') {
      const guildId = String(payload.guildId || '');
      const existing = this.ctx.storage.sql.exec(
        'SELECT guild_id FROM changelog_channels WHERE guild_id = ?', guildId
      ).toArray()[0];
      if (!existing) return json({ error: 'Canal de novidades não encontrado.' }, 404);
      this.ctx.storage.sql.exec(
        'UPDATE changelog_channels SET enabled = ?, updated_at = ?, last_error = NULL WHERE guild_id = ?',
        payload.enabled ? 1 : 0, Date.now(), guildId
      );
      return json({ ok: true });
    }

    if (url.pathname === '/changelog/published') {
      this.ctx.storage.sql.exec(
        `INSERT INTO changelog_publications
          (id, version, title, summary, details, success_count, failure_count, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        payload.id, cleanText(payload.version, 24), cleanText(payload.title, 120),
        cleanText(payload.summary, 500), String(payload.details || '').slice(0, 4000),
        Number(payload.successCount) || 0, Number(payload.failureCount) || 0,
        payload.createdBy, Date.now()
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

    if (url.pathname === '/admin/server-authorizer') {
      const guildId = cleanText(payload.guildId, 30);
      const userId = cleanText(payload.userId, 30);
      const userName = cleanText(payload.userName, 64);
      if (!guildId || !userId || !userName) return json({ error: 'Dados inválidos.' }, 400);
      this.ctx.storage.sql.exec(
        `UPDATE servers SET authorized_by_name = ?
         WHERE guild_id = ? AND authorized_by = ? AND authorized_by_name IS NULL`,
        userName, guildId, userId
      );
      return json({ ok: true });
    }

    if (url.pathname === '/admin/overview') return this.adminOverviewEfficient();

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

  async adminOverviewEfficient() {
    const now = Date.now();
    const since30d = now - 30 * DAY_MS;
    const roomRows = this.ctx.storage.sql.exec(
      `SELECT id, instance, name, owner_name, owner_id, guild_id, channel_id, is_call, created_at
       FROM rooms ORDER BY created_at DESC LIMIT 100`
    ).toArray();
    const rooms = (await Promise.all(roomRows.map(async (row) => {
      const stub = this.env.ROOMS.get(this.env.ROOMS.idFromName(row.id));
      const response = await stub.fetch('https://room.internal/admin/inspect').catch(() => null);
      if (!response?.ok) return null;
      const live = await response.json().catch(() => ({}));
      return {
        id: row.id, instance: row.instance, name: row.name, ownerName: row.owner_name,
        ownerId: row.owner_id, guildId: row.guild_id, channelId: row.channel_id,
        isCall: Boolean(row.is_call), createdAt: row.created_at, ...live,
      };
    }))).filter(Boolean);
    const servers = this.ctx.storage.sql.exec(
      `SELECT guild_id, name, icon, first_seen, last_seen, last_channel_id,
              last_channel_name, launches, installed, installed_at, authorized_by, authorized_by_name
       FROM servers ORDER BY last_seen DESC LIMIT 100`
    ).toArray().map((row) => ({
      guildId: row.guild_id, name: row.name, icon: row.icon, firstSeen: row.first_seen,
      lastSeen: row.last_seen, lastChannelId: row.last_channel_id,
      lastChannelName: row.last_channel_name, launches: Number(row.launches || 0),
      installed: Boolean(row.installed), installedAt: row.installed_at,
      authorizedBy: row.authorized_by, authorizedByName: row.authorized_by_name,
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

    // Limite rígido: o custo do painel não cresce junto com o histórico. O
    // índice por data permite buscar somente os eventos recentes necessários.
    const events = this.ctx.storage.sql.exec(
      `SELECT kind, guild_id, user_id, duration_ms, created_at, details
       FROM usage_events WHERE created_at >= ? ORDER BY created_at DESC LIMIT 2000`, since30d
    ).toArray().map((row) => ({ ...row, details: parseDetails(row.details) || {} }));
    const days = new Map();
    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, launches: 0 }));
    const users = new Set();
    const guilds = new Set();
    const kinds = new Map();
    const codecs = new Map();
    const topServersMap = new Map();
    let streamedMs = 0;
    let completed = 0;
    let withAudio = 0;
    let disconnected = 0;
    let roomClosed = 0;
    let widthSum = 0; let widthCount = 0;
    let heightSum = 0; let heightCount = 0;
    let bitrateSum = 0; let bitrateCount = 0;
    let fpsSum = 0; let fpsCount = 0;
    let callRooms = 0; let linkRooms = 0;
    for (const event of events) {
      const date = new Date(Number(event.created_at));
      const day = date.toISOString().slice(0, 10);
      const daily = days.get(day) || { day, launches: 0, rooms: 0, streams: 0, streamedMs: 0 };
      if (event.kind === 'activity_launch') {
        daily.launches++;
        const brazilHour = (date.getUTCHours() + 21) % 24;
        hours[brazilHour].launches++;
        if (event.user_id) users.add(event.user_id);
        if (event.guild_id) {
          guilds.add(event.guild_id);
          const current = topServersMap.get(event.guild_id) || { launches: 0, lastSeen: 0 };
          current.launches++;
          current.lastSeen = Math.max(current.lastSeen, Number(event.created_at));
          topServersMap.set(event.guild_id, current);
        }
      } else if (event.kind === 'room_created') {
        daily.rooms++;
        if (event.details?.isCall) callRooms++; else linkRooms++;
      } else if (event.kind === 'stream_started') daily.streams++;
      else if (event.kind === 'stream_stopped') {
        const duration = Number(event.duration_ms || 0);
        daily.streamedMs += duration;
        streamedMs += duration;
        completed++;
        if (event.details?.audio) withAudio++;
        if (event.details?.reason === 'disconnect') disconnected++;
        if (event.details?.reason === 'room_closed') roomClosed++;
        const config = event.details?.config || {};
        for (const [value, add] of [
          [config.width, (n) => { widthSum += n; widthCount++; }],
          [config.height, (n) => { heightSum += n; heightCount++; }],
          [config.bitrate, (n) => { bitrateSum += n; bitrateCount++; }],
          [config.framerate, (n) => { fpsSum += n; fpsCount++; }],
        ]) if (Number.isFinite(Number(value)) && Number(value) > 0) add(Number(value));
        const codec = cleanText(config.codec, 40) || 'não informado';
        codecs.set(codec, (codecs.get(codec) || 0) + 1);
      }
      days.set(day, daily);
      const kind = kinds.get(event.kind) || { kind: event.kind, total: 0, lastSeen: 0 };
      kind.total++;
      kind.lastSeen = Math.max(kind.lastSeen, Number(event.created_at));
      kinds.set(event.kind, kind);
    }
    const daily = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
    const last7 = now - 7 * DAY_MS;
    const previous7 = now - 14 * DAY_MS;
    const countKind = (kind, from, to = Infinity) => events.filter((event) => (
      event.kind === kind && Number(event.created_at) >= from && Number(event.created_at) < to
    )).length;
    const streamDurations = events
      .filter((event) => event.kind === 'stream_stopped' && Number.isFinite(Number(event.duration_ms)))
      .map((event) => Number(event.duration_ms));
    const serverNames = new Map(servers.map((server) => [server.guildId, server.name || 'Servidor sem nome']));
    const topServers = [...topServersMap.entries()].map(([guildId, value]) => ({
      guildId, name: serverNames.get(guildId) || 'Servidor sem nome', ...value,
    })).sort((a, b) => b.launches - a.launches).slice(0, 10);
    const changelogChannels = this.ctx.storage.sql.exec(
      `SELECT guild_id, guild_name, channel_id, channel_name, enabled, updated_at,
              last_sent_at, last_error FROM changelog_channels ORDER BY updated_at DESC LIMIT 100`
    ).toArray().map((row) => ({
      guildId: row.guild_id, guildName: row.guild_name, channelId: row.channel_id,
      channelName: row.channel_name, enabled: Boolean(row.enabled), updatedAt: row.updated_at,
      lastSentAt: row.last_sent_at, lastError: row.last_error,
    }));
    const changelogHistory = this.ctx.storage.sql.exec(
      `SELECT id, version, title, success_count, failure_count, created_by, created_at
       FROM changelog_publications ORDER BY created_at DESC LIMIT 20`
    ).toArray().map((row) => ({
      id: row.id, version: row.version, title: row.title,
      successCount: row.success_count, failureCount: row.failure_count,
      createdBy: row.created_by, createdAt: row.created_at,
    }));
    const supporters = this.ctx.storage.sql.exec(
      `SELECT user_id, tier, public_name, show_credit, started_at, expires_at, created_by, updated_at
       FROM supporters ORDER BY CASE tier WHEN 'founder' THEN 0 ELSE 1 END, updated_at DESC LIMIT 100`
    ).toArray().map((row) => ({
      userId: row.user_id, tier: row.tier, publicName: row.public_name,
      showCredit: Boolean(row.show_credit), startedAt: row.started_at, expiresAt: row.expires_at,
      createdBy: row.created_by, updatedAt: row.updated_at,
      active: row.expires_at === null || row.expires_at > now,
    }));
    const maintenance = this.ctx.storage.sql.exec(
      "SELECT value FROM settings WHERE key = 'maintenance'"
    ).toArray()[0]?.value === 'true';
    const launches30d = countKind('activity_launch', since30d);
    const streams30d = countKind('stream_started', since30d);
    const rooms30d = countKind('room_created', since30d);
    return json({
      generatedAt: now,
      approximateMetrics: events.length >= 2000,
      totals: {
        servers: servers.length,
        launches: servers.reduce((sum, server) => sum + server.launches, 0),
        launches30d, uniqueUsers30d: users.size, streams30d, streamedMs30d: streamedMs,
        activeRooms: rooms.length,
        activePeople: rooms.reduce((sum, room) => sum + Number(room.people || 0), 0),
        activeStreams: rooms.reduce((sum, room) => sum + Number(room.streams?.length || room.streamCount || 0), 0),
      },
      rooms, servers, blocks, audit, daily: daily.slice(-14), maintenance, supporters,
      analytics: {
        daily, hourly: hours,
        summary: {
          launches7d: countKind('activity_launch', last7),
          previousLaunches7d: countKind('activity_launch', previous7, last7),
          streams7d: countKind('stream_started', last7),
          previousStreams7d: countKind('stream_started', previous7, last7),
          rooms30d, activeServers30d: guilds.size, completedStreams30d: completed,
          averageStreamMs30d: streamDurations.length ? streamedMs / streamDurations.length : 0,
          longestStreamMs30d: streamDurations.length ? Math.max(...streamDurations) : 0,
        },
        topServers,
        technical: {
          completedStreams30d: completed, streamsWithAudio30d: withAudio,
          disconnectedStreams30d: disconnected, roomClosedStreams30d: roomClosed,
          averageWidth30d: widthCount ? Math.round(widthSum / widthCount) : 0,
          averageHeight30d: heightCount ? Math.round(heightSum / heightCount) : 0,
          averageBitrate30d: bitrateCount ? Math.round(bitrateSum / bitrateCount) : 0,
          averageFps30d: fpsCount ? Math.round(fpsSum / fpsCount) : 0,
          callRooms30d: callRooms, linkRooms30d: linkRooms,
          knownServers: servers.length, installedServers: servers.filter((server) => server.installed).length,
        },
        codecs: [...codecs.entries()].map(([codec, total]) => ({ codec, total })).sort((a, b) => b.total - a.total),
        eventKinds: [...kinds.values()].sort((a, b) => b.total - a.total),
        dataInventory: {
          storedEvents: events.length,
          oldestEventAt: events.length ? Math.min(...events.map((event) => Number(event.created_at))) : 0,
          newestEventAt: events.length ? Math.max(...events.map((event) => Number(event.created_at))) : 0,
          activeUsers24h: new Set(events.filter((event) => Number(event.created_at) >= now - DAY_MS).map((event) => event.user_id).filter(Boolean)).size,
          activeUsers7d: new Set(events.filter((event) => Number(event.created_at) >= last7).map((event) => event.user_id).filter(Boolean)).size,
          activeServers7d: new Set(events.filter((event) => Number(event.created_at) >= last7).map((event) => event.guild_id).filter(Boolean)).size,
        },
      },
      changelog: { channels: changelogChannels, history: changelogHistory },
    });
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
              last_channel_name, launches, installed, installed_at, authorized_by, authorized_by_name
       FROM servers ORDER BY last_seen DESC LIMIT 100`
    ).toArray().map((row) => ({
      guildId: row.guild_id, name: row.name, icon: row.icon, firstSeen: row.first_seen,
      lastSeen: row.last_seen, lastChannelId: row.last_channel_id,
      lastChannelName: row.last_channel_name, launches: row.launches,
      installed: Boolean(row.installed), installedAt: row.installed_at,
      authorizedBy: row.authorized_by, authorizedByName: row.authorized_by_name,
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
    const analyticsDaily = this.ctx.storage.sql.exec(
      `SELECT date(created_at / 1000, 'unixepoch') AS day,
              SUM(CASE WHEN kind = 'activity_launch' THEN 1 ELSE 0 END) AS launches,
              SUM(CASE WHEN kind = 'room_created' THEN 1 ELSE 0 END) AS rooms,
              SUM(CASE WHEN kind = 'stream_started' THEN 1 ELSE 0 END) AS streams,
              SUM(CASE WHEN kind = 'stream_stopped' THEN COALESCE(duration_ms, 0) ELSE 0 END) AS streamed_ms
       FROM usage_events WHERE created_at >= ?
       GROUP BY day ORDER BY day`, now - 30 * DAY_MS
    ).toArray().map((row) => ({
      day: row.day,
      launches: Number(row.launches || 0),
      rooms: Number(row.rooms || 0),
      streams: Number(row.streams || 0),
      streamedMs: Number(row.streamed_ms || 0),
    }));
    const hourly = this.ctx.storage.sql.exec(
      `SELECT CAST(strftime('%H', created_at / 1000, 'unixepoch', '-3 hours') AS INTEGER) AS hour,
              COUNT(*) AS launches
       FROM usage_events
       WHERE kind = 'activity_launch' AND created_at >= ?
       GROUP BY hour ORDER BY hour`, now - 30 * DAY_MS
    ).toArray().map((row) => ({ hour: Number(row.hour), launches: Number(row.launches || 0) }));
    const streamDuration = this.ctx.storage.sql.exec(
      `SELECT COUNT(*) AS completed,
              COALESCE(AVG(duration_ms), 0) AS average_ms,
              COALESCE(MAX(duration_ms), 0) AS longest_ms
       FROM usage_events
       WHERE kind = 'stream_stopped' AND duration_ms IS NOT NULL AND created_at >= ?`, now - 30 * DAY_MS
    ).one();
    const activitySummary = this.ctx.storage.sql.exec(
      `SELECT
         SUM(CASE WHEN kind = 'activity_launch' AND created_at >= ? THEN 1 ELSE 0 END) AS launches_7d,
         SUM(CASE WHEN kind = 'activity_launch' AND created_at >= ? AND created_at < ? THEN 1 ELSE 0 END) AS launches_previous_7d,
         SUM(CASE WHEN kind = 'stream_started' AND created_at >= ? THEN 1 ELSE 0 END) AS streams_7d,
         SUM(CASE WHEN kind = 'stream_started' AND created_at >= ? AND created_at < ? THEN 1 ELSE 0 END) AS streams_previous_7d,
         SUM(CASE WHEN kind = 'room_created' AND created_at >= ? THEN 1 ELSE 0 END) AS rooms_30d
       FROM usage_events WHERE created_at >= ?`,
      now - 7 * DAY_MS, now - 14 * DAY_MS, now - 7 * DAY_MS,
      now - 7 * DAY_MS, now - 14 * DAY_MS, now - 7 * DAY_MS,
      now - 30 * DAY_MS, now - 30 * DAY_MS
    ).one();
    const topServers = this.ctx.storage.sql.exec(
      `SELECT e.guild_id, COALESCE(s.name, 'Servidor sem nome') AS name,
              COUNT(*) AS launches, MAX(e.created_at) AS last_seen
       FROM usage_events e LEFT JOIN servers s ON s.guild_id = e.guild_id
       WHERE e.kind = 'activity_launch' AND e.guild_id IS NOT NULL AND e.created_at >= ?
       GROUP BY e.guild_id, s.name ORDER BY launches DESC, last_seen DESC LIMIT 10`, now - 30 * DAY_MS
    ).toArray().map((row) => ({
      guildId: row.guild_id,
      name: row.name,
      launches: Number(row.launches || 0),
      lastSeen: Number(row.last_seen || 0),
    }));
    const technical = this.ctx.storage.sql.exec(
      `SELECT
         COUNT(*) AS completed,
         SUM(CASE WHEN json_extract(details, '$.audio') = 1 THEN 1 ELSE 0 END) AS with_audio,
         SUM(CASE WHEN json_extract(details, '$.reason') = 'disconnect' THEN 1 ELSE 0 END) AS disconnected,
         SUM(CASE WHEN json_extract(details, '$.reason') = 'room_closed' THEN 1 ELSE 0 END) AS room_closed,
         AVG(CAST(json_extract(details, '$.config.width') AS REAL)) AS average_width,
         AVG(CAST(json_extract(details, '$.config.height') AS REAL)) AS average_height,
         AVG(CAST(json_extract(details, '$.config.bitrate') AS REAL)) AS average_bitrate,
         AVG(CAST(json_extract(details, '$.config.framerate') AS REAL)) AS average_fps
       FROM usage_events
       WHERE kind = 'stream_stopped' AND created_at >= ?`, now - 30 * DAY_MS
    ).one();
    const codecs = this.ctx.storage.sql.exec(
      `SELECT COALESCE(json_extract(details, '$.config.codec'), 'não informado') AS codec,
              COUNT(*) AS total
       FROM usage_events
       WHERE kind = 'stream_stopped' AND created_at >= ?
       GROUP BY codec ORDER BY total DESC LIMIT 8`, now - 30 * DAY_MS
    ).toArray().map((row) => ({ codec: row.codec, total: Number(row.total || 0) }));
    const eventKinds = this.ctx.storage.sql.exec(
      `SELECT kind, COUNT(*) AS total, MAX(created_at) AS last_seen
       FROM usage_events WHERE created_at >= ?
       GROUP BY kind ORDER BY total DESC`, now - 30 * DAY_MS
    ).toArray().map((row) => ({
      kind: row.kind, total: Number(row.total || 0), lastSeen: Number(row.last_seen || 0),
    }));
    const dataInventory = this.ctx.storage.sql.exec(
      `SELECT COUNT(*) AS total, MIN(created_at) AS oldest, MAX(created_at) AS newest,
              COUNT(DISTINCT CASE WHEN created_at >= ? THEN user_id END) AS users_24h,
              COUNT(DISTINCT CASE WHEN created_at >= ? THEN user_id END) AS users_7d,
              COUNT(DISTINCT CASE WHEN created_at >= ? THEN guild_id END) AS guilds_7d
       FROM usage_events`, now - DAY_MS, now - 7 * DAY_MS, now - 7 * DAY_MS
    ).one();
    const roomTypes = this.ctx.storage.sql.exec(
      `SELECT
         SUM(CASE WHEN json_extract(details, '$.isCall') = 1 THEN 1 ELSE 0 END) AS calls,
         SUM(CASE WHEN COALESCE(json_extract(details, '$.isCall'), 0) = 0 THEN 1 ELSE 0 END) AS links
       FROM usage_events WHERE kind = 'room_created' AND created_at >= ?`, now - 30 * DAY_MS
    ).one();
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

    const changelogChannels = this.ctx.storage.sql.exec(
      `SELECT guild_id, guild_name, channel_id, channel_name, enabled, updated_at,
              last_sent_at, last_error FROM changelog_channels ORDER BY updated_at DESC LIMIT 100`
    ).toArray().map((row) => ({
      guildId: row.guild_id, guildName: row.guild_name, channelId: row.channel_id,
      channelName: row.channel_name, enabled: Boolean(row.enabled), updatedAt: row.updated_at,
      lastSentAt: row.last_sent_at, lastError: row.last_error,
    }));
    const changelogHistory = this.ctx.storage.sql.exec(
      `SELECT id, version, title, success_count, failure_count, created_by, created_at
       FROM changelog_publications ORDER BY created_at DESC LIMIT 20`
    ).toArray().map((row) => ({
      id: row.id, version: row.version, title: row.title,
      successCount: row.success_count, failureCount: row.failure_count,
      createdBy: row.created_by, createdAt: row.created_at,
    }));

    const supporters = this.ctx.storage.sql.exec(
      `SELECT user_id, tier, public_name, show_credit, started_at, expires_at, created_by, updated_at
       FROM supporters ORDER BY CASE tier WHEN 'founder' THEN 0 ELSE 1 END, updated_at DESC`
    ).toArray().map((row) => ({
      userId: row.user_id, tier: row.tier, publicName: row.public_name,
      showCredit: Boolean(row.show_credit), startedAt: row.started_at, expiresAt: row.expires_at,
      createdBy: row.created_by, updatedAt: row.updated_at,
      active: row.expires_at === null || row.expires_at > now,
    }));

    return json({
      generatedAt: now, totals, rooms, servers, blocks, audit, daily, maintenance,
      supporters,
      analytics: {
        daily: analyticsDaily,
        hourly,
        summary: {
          launches7d: Number(activitySummary.launches_7d || 0),
          previousLaunches7d: Number(activitySummary.launches_previous_7d || 0),
          streams7d: Number(activitySummary.streams_7d || 0),
          previousStreams7d: Number(activitySummary.streams_previous_7d || 0),
          rooms30d: Number(activitySummary.rooms_30d || 0),
          activeServers30d: Number(this.ctx.storage.sql.exec(
            `SELECT COUNT(DISTINCT guild_id) AS total FROM usage_events
             WHERE kind = 'activity_launch' AND guild_id IS NOT NULL AND created_at >= ?`, now - 30 * DAY_MS
          ).one().total || 0),
          completedStreams30d: Number(streamDuration.completed || 0),
          averageStreamMs30d: Number(streamDuration.average_ms || 0),
          longestStreamMs30d: Number(streamDuration.longest_ms || 0),
        },
        topServers,
        technical: {
          completedStreams30d: Number(technical.completed || 0),
          streamsWithAudio30d: Number(technical.with_audio || 0),
          disconnectedStreams30d: Number(technical.disconnected || 0),
          roomClosedStreams30d: Number(technical.room_closed || 0),
          averageWidth30d: Math.round(Number(technical.average_width || 0)),
          averageHeight30d: Math.round(Number(technical.average_height || 0)),
          averageBitrate30d: Math.round(Number(technical.average_bitrate || 0)),
          averageFps30d: Math.round(Number(technical.average_fps || 0)),
          callRooms30d: Number(roomTypes.calls || 0),
          linkRooms30d: Number(roomTypes.links || 0),
          knownServers: Number(totals.servers || 0),
          installedServers: Number(this.ctx.storage.sql.exec(
            'SELECT COUNT(*) AS total FROM servers WHERE installed = 1'
          ).one().total || 0),
        },
        codecs,
        eventKinds,
        dataInventory: {
          storedEvents: Number(dataInventory.total || 0),
          oldestEventAt: Number(dataInventory.oldest || 0),
          newestEventAt: Number(dataInventory.newest || 0),
          activeUsers24h: Number(dataInventory.users_24h || 0),
          activeUsers7d: Number(dataInventory.users_7d || 0),
          activeServers7d: Number(dataInventory.guilds_7d || 0),
        },
      },
      changelog: { channels: changelogChannels, history: changelogHistory },
    });
  }
}
