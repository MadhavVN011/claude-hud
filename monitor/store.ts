import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { database, transaction } from './sqlite.ts';
import { hash, secret, HttpError, COUNTERS } from './protocol.ts';
import type { Status, UsageEvent, Quota } from './protocol.ts';
import type { ServerConfig } from './config.ts';

const MIGRATIONS = [`
CREATE TABLE devices (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE, registered INTEGER,
 heartbeat INTEGER, last_sync INTEGER, hostname TEXT, os TEXT, version TEXT,
 claude_available INTEGER NOT NULL DEFAULT 0, data_available INTEGER NOT NULL DEFAULT 0, local_events INTEGER NOT NULL DEFAULT 0,
 local_tokens INTEGER NOT NULL DEFAULT 0, errors TEXT NOT NULL DEFAULT '{}',
 revoked INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE enrollments (
 token_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON UPDATE CASCADE,
 expires INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE events (
 id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id),
 session TEXT NOT NULL, project TEXT NOT NULL, project_label TEXT NOT NULL, model TEXT NOT NULL,
 at INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL,
 cacheCreation INTEGER NOT NULL, cacheRead INTEGER NOT NULL
);
CREATE INDEX events_device_at ON events(device_id, at);
CREATE INDEX events_at ON events(at);
CREATE INDEX events_session ON events(session);
CREATE TABLE syncs (
 id INTEGER PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), at INTEGER NOT NULL,
 received INTEGER NOT NULL, duplicates INTEGER NOT NULL, errors TEXT NOT NULL
);
CREATE INDEX syncs_device ON syncs(device_id, at);
CREATE TABLE quotas (
 device_id TEXT PRIMARY KEY REFERENCES devices(id), at INTEGER NOT NULL,
 received INTEGER NOT NULL, snapshot TEXT NOT NULL
);
`];

export type Device = {
  id: string; name: string; token_hash: string | null; registered: number | null;
  heartbeat: number | null; last_sync: number | null; hostname: string | null;
  os: string | null; version: string | null; claude_available: number; data_available: number;
  local_events: number; local_tokens: number; errors: string; revoked: number; archived: number;
};
export type Filter = { from: number; to: number; device?: string };
type Row = Record<string, string | number | null>;
const SUM = COUNTERS.map(k => `coalesce(sum(e.${k}),0) AS ${k}`).join(', ') +
  ', coalesce(sum(e.input+e.output+e.cacheCreation+e.cacheRead),0) AS total';
const GROUPS = {
  device: 'e.device_id', model: 'e.model', project: 'e.project', session: 'e.session',
  daily: 'CAST(e.at / 86400000 AS INTEGER) * 86400000',
  hourly: 'CAST(e.at / 3600000 AS INTEGER) * 3600000',
} as const;
export type Group = keyof typeof GROUPS;

export class Store {
  readonly db;
  readonly config: ServerConfig;
  constructor(config: ServerConfig) { this.config = config; this.db = database(config.database, MIGRATIONS); }
  close(): void { this.db.close(); }
  admin(token: string): boolean {
    return timingSafeEqual(Buffer.from(hash(token)), Buffer.from(hash(this.config.adminToken)));
  }
  authenticate(token: string): string | null {
    const row = this.db.prepare('SELECT id FROM devices WHERE token_hash=? AND revoked=0 AND archived=0').get(hash(token));
    return row ? String(row.id) : null;
  }
  enrollment(name: string, now: number): { id: string; enrollment: string; expires: number } {
    return transaction(this.db, () => {
      const id = randomUUID(), enrollment = secret(), expires = now + 900_000;
      this.db.prepare('INSERT INTO devices(id,name) VALUES(?,?)').run(id, name);
      this.db.prepare('INSERT INTO enrollments(token_hash,device_id,expires) VALUES(?,?,?)').run(hash(enrollment), id, expires);
      return { id, enrollment, expires };
    });
  }
  register(enrollment: string, id: string, info: Status, now: number): { token: string; deviceId: string } {
    return transaction(this.db, () => {
      const row = this.db.prepare(`SELECT e.*,d.revoked,d.archived FROM enrollments e
        JOIN devices d ON d.id=e.device_id WHERE e.token_hash=?`).get(hash(enrollment));
      if (!row || Number(row.expires) < now || row.revoked || row.archived || (row.consumed && row.device_id !== id)) {
        throw new HttpError(401, 'invalid_enrollment');
      }
      // Repeatable only for the same UUID after a lost registration response. No cleartext credential storage.
      const token = createHmac('sha256', this.config.adminToken).update(enrollment + ':' + id).digest('base64url');
      if (!row.consumed) {
        if (this.db.prepare('SELECT id FROM devices WHERE id=? AND id<>?').get(id, String(row.device_id))) {
          throw new HttpError(409, 'device_exists');
        }
        this.db.prepare('UPDATE devices SET id=?,token_hash=?,registered=? WHERE id=?')
          .run(id, hash(token), now, String(row.device_id));
        this.db.prepare('UPDATE enrollments SET consumed=1 WHERE token_hash=?').run(hash(enrollment));
      }
      this.heartbeat(id, info, now);
      return { token, deviceId: id };
    });
  }
  heartbeat(id: string, info: Status, now: number): void {
    this.db.prepare(`UPDATE devices SET heartbeat=?,hostname=?,os=?,version=?,claude_available=?,data_available=?,
      local_events=?,local_tokens=?,errors=? WHERE id=?`)
      .run(now, info.hostname, info.os, info.version, Number(info.claudeAvailable), Number(info.dataAvailable), info.localEvents,
        info.localTokens, JSON.stringify(info.errors), id);
  }
  ingest(id: string, events: UsageEvent[], info: Status, snapshot: Quota | null, now: number): { accepted: number; duplicates: number } {
    return transaction(this.db, () => {
      const owner = this.db.prepare('SELECT device_id FROM events WHERE id=?');
      const upsert = this.db.prepare(`INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        input=max(events.input,excluded.input), output=max(events.output,excluded.output),
        cacheCreation=max(events.cacheCreation,excluded.cacheCreation), cacheRead=max(events.cacheRead,excluded.cacheRead),
        at=min(events.at,excluded.at),
        model=CASE WHEN events.model='Unknown' THEN excluded.model ELSE events.model END,
        project_label=excluded.project_label
        WHERE events.device_id=excluded.device_id`);
      let duplicates = 0;
      for (const e of events) {
        const existing = owner.get(e.id);
        if (existing && existing.device_id !== id) { duplicates++; continue; }
        upsert.run(e.id, id, e.session, e.project, e.projectLabel, e.model, e.at,
          e.input, e.output, e.cacheCreation, e.cacheRead);
      }
      this.heartbeat(id, info, now);
      this.db.prepare('UPDATE devices SET last_sync=? WHERE id=?').run(now, id);
      this.db.prepare('INSERT INTO syncs(device_id,at,received,duplicates,errors) VALUES(?,?,?,?,?)')
        .run(id, now, events.length, duplicates, JSON.stringify(info.errors));
      this.db.prepare('DELETE FROM syncs WHERE device_id=? AND id NOT IN (SELECT id FROM syncs WHERE device_id=? ORDER BY id DESC LIMIT 1000)').run(id, id);
      if (snapshot) {
        this.db.prepare(`INSERT INTO quotas VALUES(?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET
          at=excluded.at,received=excluded.received,snapshot=excluded.snapshot WHERE excluded.at>=quotas.at`)
          .run(id, snapshot.at, now, JSON.stringify(snapshot));
      }
      return { accepted: events.length - duplicates, duplicates };
    });
  }
  devices(now: number): Array<Omit<Device, 'token_hash' | 'errors'> & { errors: unknown; status: string }> {
    return (this.db.prepare('SELECT * FROM devices ORDER BY archived,name,id').all() as Device[]).map(row => {
      const { token_hash: _, errors, ...safe } = row;
      const parsed = JSON.parse(errors) as Status['errors'];
      const state = row.archived ? 'archived' : row.revoked ? 'revoked' : !row.registered ? 'never-connected'
        : row.heartbeat === null || now - row.heartbeat > this.config.offlineMs ? 'offline'
          : Object.values(parsed).some(n => n > 0) ? 'error' : 'online';
      return { ...safe, errors: parsed, status: state };
    });
  }
  detail(id: string, now: number): unknown {
    const device = this.devices(now).find(d => d.id === id);
    if (!device) throw new HttpError(404, 'device_not_found');
    return { ...device, history: this.db.prepare('SELECT at,received,duplicates,errors FROM syncs WHERE device_id=? ORDER BY id DESC LIMIT 100').all(id) };
  }
  manage(id: string, changes: { name?: string; revoke?: boolean; archive?: boolean }): void {
    if (!this.db.prepare('SELECT id FROM devices WHERE id=?').get(id)) throw new HttpError(404, 'device_not_found');
    transaction(this.db, () => {
      if (changes.name) this.db.prepare('UPDATE devices SET name=? WHERE id=?').run(changes.name, id);
      if (changes.revoke || changes.archive) this.db.prepare('UPDATE devices SET revoked=1,token_hash=NULL WHERE id=?').run(id);
      if (changes.archive) this.db.prepare('UPDATE devices SET archived=1 WHERE id=?').run(id);
    });
  }
  private where(filter: Filter): { sql: string; args: (string | number)[] } {
    return { sql: 'e.at>=? AND e.at<?' + (filter.device ? ' AND e.device_id=?' : ''),
      args: [filter.from, filter.to, ...(filter.device ? [filter.device] : [])] };
  }
  aggregate(filter: Filter, group?: Group, limit?: number): Row[] {
    const { sql, args } = this.where(filter);
    const dim = group ? GROUPS[group] : null;
    const rows = this.db.prepare(`SELECT ${dim ? dim + ' AS key,' : ''} ${SUM},count(*) AS messages,
      count(DISTINCT e.session) AS sessions,max(e.at) AS lastActivity
      ${group === 'project' ? ',max(e.project_label) AS label' : ''}
      FROM events e WHERE ${sql} ${dim ? 'GROUP BY ' + dim : ''}
      ${dim ? 'ORDER BY ' + (group === 'session' ? 'lastActivity' : 'key') + (limit ? ' DESC' : '') : ''}
      ${limit ? 'LIMIT ?' : ''}`)
      .all(...args, ...(limit ? [limit] : [])) as Row[];
    return limit ? rows.reverse() : rows;
  }
  analytics(filter: Filter, now: number): unknown {
    const windows: Record<string, Row> = {};
    for (const [name, duration] of Object.entries({ fiveHour: 18_000_000, day: 86_400_000,
      sevenDay: 604_800_000, thirtyDay: 2_592_000_000, all: now + 1 })) {
      windows[name] = this.aggregate({ ...filter, from: Math.max(0, now - duration), to: now + 1 })[0];
    }
    const active = this.db.prepare(`SELECT count(*) AS count FROM (SELECT e.device_id,e.session FROM events e
      JOIN devices d ON d.id=e.device_id WHERE e.at>=? AND e.at<=? AND d.heartbeat>=?
      AND d.revoked=0 AND d.archived=0 ${filter.device ? 'AND e.device_id=?' : ''}
      GROUP BY e.device_id,e.session)`)
      .get(now - this.config.activeMs, now, now - this.config.offlineMs, ...(filter.device ? [filter.device] : []));
    const byWindow = (duration: number) => this.aggregate({ ...filter, from: now - duration, to: now + 1 }, 'device');
    const devices = this.aggregate(filter, 'device');
    const activeByDevice = this.db.prepare(`SELECT e.device_id AS key,count(DISTINCT e.session) AS count FROM events e
      JOIN devices d ON d.id=e.device_id WHERE e.at>=? AND e.at<=? AND d.heartbeat>=? AND d.revoked=0 AND d.archived=0
      GROUP BY e.device_id`).all(now - this.config.activeMs, now, now - this.config.offlineMs);
    return { at: now, filter, totals: this.aggregate(filter)[0], windows, activeSessions: Number(active?.count ?? 0),
      devices, fiveHourByDevice: byWindow(18_000_000), sevenDayByDevice: byWindow(604_800_000), activeByDevice,
      models: this.aggregate(filter, 'model'), projects: this.aggregate(filter, 'project'),
      // Session detail and chart rows are capped; full history remains available through streamed exports.
      sessions: this.aggregate(filter, 'session', 2000),
      daily: this.aggregate(filter, 'daily'), hourly: this.aggregate(filter, 'hourly', 2000),
      fiveHourTimeline: this.aggregate({ ...filter, from: now - 18_000_000, to: now + 1 }, 'hourly'),
      sevenDayTimeline: this.aggregate({ ...filter, from: now - 604_800_000, to: now + 1 }, 'daily') };
  }
  quotas(now: number): unknown {
    const rows = this.db.prepare(`SELECT q.*,d.name FROM quotas q JOIN devices d ON d.id=q.device_id
      WHERE d.revoked=0 AND d.archived=0 ORDER BY q.at DESC`).all();
    const select = (key: 'fiveHour' | 'sevenDay') => {
      for (const row of rows) {
        const snapshot = JSON.parse(String(row.snapshot)) as Quota;
        const w = snapshot[key];
        if (!w || now - snapshot.at >= this.config.quotaFreshMs || snapshot.at > now + 60_000 || (w.resetAt !== null && w.resetAt <= now)) continue;
        return { ...w, remaining: 100 - w.used, observedAt: snapshot.at, receivedAt: row.received,
          deviceId: row.device_id, deviceName: row.name, source: snapshot.source };
      }
      return null;
    };
    return { fiveHour: select('fiveHour'), sevenDay: select('sevenDay'),
      lastSync: rows.length ? Math.max(...rows.map(r => Number(r.received))) : null,
      lastObservation: rows.length ? Math.max(...rows.map(r => Number(r.at))) : null,
      freshnessMs: this.config.quotaFreshMs };
  }
  *exportRows(filter: Filter, group: 'events' | 'model' | 'daily'): Generator<Row> {
    const { sql, args } = this.where(filter);
    const query = group === 'events'
      ? `SELECT e.device_id AS device,e.id,e.session,e.project,e.project_label AS projectLabel,e.model,e.at,
          e.input,e.output,e.cacheCreation,e.cacheRead,(e.input+e.output+e.cacheCreation+e.cacheRead) AS total
          FROM events e WHERE ${sql} ORDER BY e.at,e.id`
      : `SELECT ${GROUPS[group]} AS key,${SUM} FROM events e WHERE ${sql} GROUP BY ${GROUPS[group]} ORDER BY key`;
    // A dedicated read transaction gives a consistent export while collectors keep ingesting.
    const reader = this.config.database === ':memory:' ? this.db : new DatabaseSync(this.config.database, { readOnly: true });
    try {
      if (reader !== this.db) reader.exec('BEGIN');
      for (const row of reader.prepare(query).iterate(...args)) yield row as Row;
    } finally {
      if (reader !== this.db) { reader.exec('ROLLBACK'); reader.close(); }
    }
  }
}

export function csvCell(value: unknown): string {
  let str = value === null || value === undefined ? '' : String(value);
  // Spreadsheet applications may execute formulas even in quoted cells.
  if (/^[=+@\-\t\r]/.test(str)) str = "'" + str;
  return '"' + str.replace(/"/g, '""') + '"';
}
