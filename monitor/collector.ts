import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay, setImmediate as yieldIO } from 'node:timers/promises';
import { database, transaction } from './sqlite.ts';
import { parseLine } from './parser.ts';
import { claudeAvailable } from './availability.ts';
import { hash, quota, VERSION, COUNTERS } from './protocol.ts';
import type { UsageEvent, Status, ErrorCode, Quota } from './protocol.ts';
import type { AgentConfig } from './config.ts';

const MIGRATIONS = [`
CREATE TABLE metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE files (path TEXT PRIMARY KEY,identity TEXT NOT NULL,offset INTEGER NOT NULL,
 size INTEGER NOT NULL,mtime REAL NOT NULL,prefix TEXT NOT NULL,suffix TEXT NOT NULL,
 discarding INTEGER NOT NULL DEFAULT 0,errors TEXT NOT NULL DEFAULT '{}');
CREATE TABLE outbox (id TEXT PRIMARY KEY,payload TEXT NOT NULL,dirty INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 1);
CREATE INDEX pending_events ON outbox(dirty);
`];
type Cursor = { identity: string; offset: number; size: number; mtime: number; prefix: string;
  suffix: string; discarding: number; errors: string };
type Pending = { id: string; payload: string; revision: number };
const MAX_LINE = 8 * 1024 * 1024;

export class Collector {
  readonly db;
  readonly deviceId: string;
  readonly config: AgentConfig;
  private scanErrors: Status['errors'] = {};
  private scanning = false;
  constructor(config: AgentConfig) {
    this.config = config;
    this.db = database(config.database, MIGRATIONS);
    const existing = this.get('deviceId');
    this.deviceId = existing ?? randomUUID();
    if (!existing) this.set('deviceId', this.deviceId);
  }
  close(): void { this.db.close(); }
  get(key: string): string | null { return String(this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value ?? '') || null; }
  set(key: string, value: string): void {
    this.db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
  private merge(value: UsageEvent): void {
    const row = this.db.prepare('SELECT payload FROM outbox WHERE id=?').get(value.id);
    if (row) {
      const old = JSON.parse(String(row.payload)) as UsageEvent;
      value.at = Math.min(old.at, value.at);
      for (const k of COUNTERS) value[k] = Math.max(old[k], value[k]);
      if (old.model !== 'Unknown') value.model = old.model;
      // A later cwd inside a session is not a reason to reattribute an existing request.
      value.project = old.project;
      if (JSON.stringify(value) === row.payload) return;
    }
    this.db.prepare(`INSERT INTO outbox(id,payload) VALUES(?,?) ON CONFLICT(id)
      DO UPDATE SET payload=excluded.payload,dirty=1,revision=outbox.revision+1`).run(value.id, JSON.stringify(value));
  }
  private guard(fd: number, start: number, length: number): string {
    const buf = Buffer.alloc(length); const read = fs.readSync(fd, buf, 0, length, start);
    return hash(buf.subarray(0, read).toString('base64'));
  }
  private async scanFile(file: string, relative: string, signal?: AbortSignal): Promise<void> {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) return;
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      let old = this.db.prepare('SELECT * FROM files WHERE path=?').get(relative) as Cursor | undefined;
      const guardLength = Math.min(old?.offset ?? 0, 4096);
      if (old && (old.identity !== identity || stat.size < old.offset || stat.size < old.size
        || (stat.size === old.size && stat.mtimeMs !== old.mtime)
        || old.prefix !== this.guard(fd, 0, guardLength)
        || old.suffix !== this.guard(fd, Math.max(0, old.offset - guardLength), guardLength))) old = undefined;
      if (old && old.offset === stat.size && stat.size === old.size && stat.mtimeMs === old.mtime) return;
      let position = old?.offset ?? 0, committed = position, carry = Buffer.alloc(0), discarding = old?.discarding === 1;
      const errors: Status['errors'] = old ? JSON.parse(old.errors) as Status['errors'] : {};
      const increment = (code: ErrorCode) => { errors[code] = (errors[code] ?? 0) + 1; };
      const save = () => {
        const length = Math.min(committed, 4096);
        this.db.prepare(`INSERT INTO files VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET
          identity=excluded.identity,offset=excluded.offset,size=excluded.size,mtime=excluded.mtime,
          prefix=excluded.prefix,suffix=excluded.suffix,discarding=excluded.discarding,errors=excluded.errors`)
          .run(relative, identity, committed, stat.size, stat.mtimeMs, this.guard(fd, 0, length),
            this.guard(fd, Math.max(0, committed - length), length), Number(discarding), JSON.stringify(errors));
      };
      while (position < stat.size) {
        if (signal?.aborted) return;
        const chunk = Buffer.alloc(Math.min(256 * 1024, stat.size - position));
        const read = fs.readSync(fd, chunk, 0, chunk.length, position);
        if (!read) break;
        position += read;
        let buffer = Buffer.concat([carry, chunk.subarray(0, read)]);
        transaction(this.db, () => {
          let start = 0, newline: number;
          while ((newline = buffer.indexOf(10, start)) !== -1) {
            const length = newline - start;
            if (!discarding) {
              if (length > MAX_LINE) increment('oversized_records');
              else {
                const parsed = parseLine(buffer.subarray(start, newline).toString('utf8'), relative, this.config.projectAliases);
                if (parsed.error) increment(parsed.error);
                if (parsed.event) this.merge(parsed.event);
              }
            }
            discarding = false;
            start = newline + 1;
          }
          carry = Buffer.from(buffer.subarray(start));
          if (carry.length > MAX_LINE || discarding) {
            if (!discarding) increment('oversized_records');
            discarding = true; carry = Buffer.alloc(0);
          }
          committed = position - carry.length;
          save();
        });
        buffer = Buffer.alloc(0);
        await yieldIO();
      }
      // Empty files also need a checkpoint. Incomplete last lines are intentionally not consumed.
      transaction(this.db, save);
    } finally { fs.closeSync(fd); }
  }
  async scan(signal?: AbortSignal): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    this.scanErrors = Object.fromEntries(Object.entries(this.scanErrors)
      .filter(([code]) => ['sync_failed', 'quota_invalid', 'quota_unreadable'].includes(code)));
    const walk = async (directory: string): Promise<void> => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
      catch { this.scanErrors.scan_failed = (this.scanErrors.scan_failed ?? 0) + 1; return; }
      for (const entry of entries) {
        if (signal?.aborted) return;
        if (entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          try { await this.scanFile(file, path.relative(this.config.projects, file).split(path.sep).join('/'), signal); }
          catch { this.scanErrors.read_failed = (this.scanErrors.read_failed ?? 0) + 1; }
        }
        await yieldIO();
      }
    };
    try {
      if (!fs.existsSync(this.config.projects)) this.scanErrors.projects_missing = 1;
      else await walk(this.config.projects);
    } finally { this.scanning = false; }
  }
  info(): Status {
    const counters = this.db.prepare(`SELECT count(*) AS count, coalesce(sum(
      json_extract(payload,'$.input')+json_extract(payload,'$.output')+
      json_extract(payload,'$.cacheCreation')+json_extract(payload,'$.cacheRead')),0) AS tokens FROM outbox`).get();
    const errors = { ...this.scanErrors };
    for (const row of this.db.prepare('SELECT errors FROM files').all()) {
      for (const [code, n] of Object.entries(JSON.parse(String(row.errors)) as Status['errors'])) {
        errors[code as ErrorCode] = (errors[code as ErrorCode] ?? 0) + n;
      }
    }
    const cleanHost = os.hostname().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) || 'Unknown';
    return { hostname: cleanHost, os: os.platform(), version: VERSION,
      claudeAvailable: claudeAvailable(), dataAvailable: fs.existsSync(this.config.projects), localEvents: Number(counters?.count ?? 0),
      localTokens: Number(counters?.tokens ?? 0), errors };
  }
  pending(limit = 500): Pending[] { return this.db.prepare('SELECT id,payload,revision FROM outbox WHERE dirty=1 ORDER BY rowid LIMIT ?').all(limit) as Pending[]; }
  acknowledge(rows: Pending[]): void {
    transaction(this.db, () => {
      const stmt = this.db.prepare('UPDATE outbox SET dirty=0 WHERE id=? AND revision=?');
      for (const r of rows) stmt.run(r.id, r.revision);
    });
  }
  readQuota(now = Date.now()): Quota | null {
    if (!this.config.quotaPath) return null;
    try {
      if (fs.statSync(this.config.quotaPath).size > 16384) throw new Error('oversized');
      const raw = JSON.parse(fs.readFileSync(this.config.quotaPath, 'utf8'));
      const window = (value: { used_percentage?: unknown; resets_at?: unknown } | null | undefined) => {
        if (!value || value.used_percentage == null) return null;
        return { used: value.used_percentage, resetAt: value.resets_at == null ? null : Date.parse(String(value.resets_at)) };
      };
      const parsed = quota({ source: 'claude-code-statusline', at: Date.parse(raw.updated_at),
        fiveHour: window(raw.five_hour), sevenDay: window(raw.seven_day) }, now);
      delete this.scanErrors.quota_invalid; delete this.scanErrors.quota_unreadable;
      return parsed;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') this.scanErrors[code ? 'quota_unreadable' : 'quota_invalid'] = 1;
      else { delete this.scanErrors.quota_invalid; delete this.scanErrors.quota_unreadable; }
      return null;
    }
  }
  async request(endpoint: string, payload: unknown, token = this.get('token')): Promise<Record<string, unknown>> {
    if (!token) throw new Error('not_enrolled');
    const response = await fetch(this.config.server + endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    return await response.json() as Record<string, unknown>;
  }
  async enroll(enrollment: string): Promise<void> {
    // Save before sending so a lost response can be retried using the same enrollment and UUID.
    this.set('enrollment', enrollment);
    const result = await this.request('/api/register', { deviceId: this.deviceId, status: this.info() }, enrollment);
    if (typeof result.token !== 'string' || result.deviceId !== this.deviceId) throw new Error('invalid_registration_response');
    transaction(this.db, () => { this.set('token', result.token as string); this.db.prepare('DELETE FROM metadata WHERE key=?').run('enrollment'); });
  }
  async heartbeat(): Promise<void> { await this.request('/api/heartbeat', { status: this.info() }); }
  async sync(): Promise<number> {
    const rows = this.pending();
    const result = await this.request('/api/usage', { events: rows.map(r => JSON.parse(r.payload)),
      quota: this.readQuota(), status: this.info() });
    if (Number(result.accepted) + Number(result.duplicates) !== rows.length) throw new Error('invalid_acknowledgement');
    this.acknowledge(rows);
    this.set('lastSync', String(Date.now()));
    delete this.scanErrors.sync_failed;
    return rows.length;
  }
  async run(signal: AbortSignal, log: (record: Record<string, unknown>) => void): Promise<void> {
    if (!this.get('token') && this.get('enrollment')) await this.enroll(this.get('enrollment')!);
    if (!this.get('token')) throw new Error('not_enrolled');
    const wait = async (ms: number) => { try { await delay(ms, undefined, { signal }); } catch { /* shutdown */ } };
    const heartbeats = async () => {
      while (!signal.aborted) {
        try { await this.heartbeat(); } catch { log({ event: 'heartbeat_failed' }); }
        await wait(this.config.heartbeatMs);
      }
    };
    const collection = async () => {
      while (!signal.aborted) {
        await this.scan(signal);
        await wait(this.config.syncMs);
      }
    };
    const uploads = async () => {
      let failures = 0;
      while (!signal.aborted) {
        try {
          // Bound each flush so a large first import never prevents another scan.
          let uploaded = 0;
          for (let i = 0; i < 20 && !signal.aborted; i++) {
            const count = await this.sync(); uploaded += count;
            if (count < 500) break;
          }
          failures = 0; log({ event: 'collector_synced', device: this.deviceId, uploaded });
        } catch {
          failures++; this.scanErrors.sync_failed = 1;
          log({ event: 'collector_retry', attempt: failures });
        }
        const backoff = failures ? Math.min(300_000, this.config.syncMs * 2 ** Math.min(failures, 5)) : this.config.syncMs;
        await wait(backoff + (failures ? Math.floor(Math.random() * 1000) : 0));
      }
    };
    await Promise.all([heartbeats(), collection(), uploads()]);
  }
}
