import { createHash, randomBytes } from 'node:crypto';

export const VERSION = '1.0.0';
export const COUNTERS = ['input', 'output', 'cacheCreation', 'cacheRead'] as const;
export type Counters = Record<(typeof COUNTERS)[number], number>;
export type UsageEvent = Counters & {
  id: string; session: string; project: string; projectLabel: string;
  model: string; at: number;
};
export const ERROR_CODES = ['projects_missing', 'scan_failed', 'read_failed', 'malformed_records',
  'unsupported_records', 'oversized_records', 'quota_invalid', 'quota_unreadable', 'sync_failed'] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export type Status = {
  hostname: string; os: string; version: string; claudeAvailable: boolean; dataAvailable: boolean;
  localEvents: number; localTokens: number; errors: Partial<Record<ErrorCode, number>>;
};
export type QuotaWindow = { used: number; resetAt: number | null };
export type Quota = { source: 'claude-code-statusline'; at: number;
  fiveHour: QuotaWindow | null; sevenDay: QuotaWindow | null };

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const secret = (): string => randomBytes(32).toString('base64url');
export const zero = (): Counters => ({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
export const total = (value: Counters): number => COUNTERS.reduce((n, k) => n + value[k], 0);
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invalid_object');
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(k => !allowed.includes(k))) throw new HttpError(400, 'unknown_field');
}
export function text(value: unknown, max = 80): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new HttpError(400, 'invalid_text');
  }
  return value.trim();
}
export function integer(value: unknown, max = 1e12): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new HttpError(400, 'invalid_number');
  }
  return value;
}
export function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new HttpError(400, 'invalid_id');
  return value;
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) {
    throw new HttpError(400, 'invalid_device_id');
  }
  return value;
}
export function event(value: unknown, now: number): UsageEvent {
  const v = object(value);
  keys(v, ['id', 'session', 'project', 'projectLabel', 'model', 'at', ...COUNTERS]);
  const at = integer(v.at, now + 300_000);
  if (at < Date.UTC(2020, 0)) throw new HttpError(400, 'invalid_timestamp');
  return { id: digest(v.id), session: digest(v.session), project: digest(v.project),
    projectLabel: text(v.projectLabel), model: text(v.model, 128), at,
    input: integer(v.input), output: integer(v.output),
    cacheCreation: integer(v.cacheCreation), cacheRead: integer(v.cacheRead) };
}
export function status(value: unknown): Status {
  const v = object(value);
  keys(v, ['hostname', 'os', 'version', 'claudeAvailable', 'dataAvailable', 'localEvents', 'localTokens', 'errors']);
  const errors = object(v.errors);
  keys(errors, ERROR_CODES);
  if (typeof v.claudeAvailable !== 'boolean' || typeof v.dataAvailable !== 'boolean') throw new HttpError(400, 'invalid_availability');
  const cleanErrors: Status['errors'] = {};
  for (const [k, n] of Object.entries(errors)) cleanErrors[k as ErrorCode] = integer(n);
  return { hostname: text(v.hostname), os: text(v.os, 30), version: text(v.version, 30),
    claudeAvailable: v.claudeAvailable, dataAvailable: v.dataAvailable, localEvents: integer(v.localEvents),
    localTokens: integer(v.localTokens, Number.MAX_SAFE_INTEGER), errors: cleanErrors };
}
export function quota(value: unknown, now: number): Quota | null {
  if (value === null || value === undefined) return null;
  const v = object(value);
  keys(v, ['source', 'at', 'fiveHour', 'sevenDay']);
  if (v.source !== 'claude-code-statusline') throw new HttpError(400, 'invalid_quota_source');
  const window = (raw: unknown): QuotaWindow | null => {
    if (raw === null) return null;
    const w = object(raw); keys(w, ['used', 'resetAt']);
    if (typeof w.used !== 'number' || !Number.isFinite(w.used) || w.used < 0 || w.used > 100) {
      throw new HttpError(400, 'invalid_quota');
    }
    return { used: w.used, resetAt: w.resetAt === null ? null : integer(w.resetAt, Date.UTC(2200, 0)) };
  };
  return { source: v.source, at: integer(v.at, now + 60_000), fiveHour: window(v.fiveHour), sevenDay: window(v.sevenDay) };
}
