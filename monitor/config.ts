import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isIP } from 'node:net';
import { object, keys, text, integer } from './protocol.ts';

export type ServerConfig = {
  host: string; port: number; database: string; adminToken: string;
  offlineMs: number; activeMs: number; quotaFreshMs: number; maxBodyBytes: number;
  requestsPerMinute: number;
};
export type AgentConfig = {
  server: string; name: string; projects: string; database: string;
  syncMs: number; heartbeatMs: number; quotaPath: string | null;
  projectAliases: Record<string, string>;
};
export const defaultDir = (): string => path.join(os.homedir(), '.claude-hud-monitor');
export function privateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^::ffff:/, '');
  if (isIP(ip) === 6 && (ip === '::1' || /^(fc|fd)[0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip))) return true;
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
    || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}
function absolute(value: unknown): string {
  const p = text(value, 4096);
  if (!path.isAbsolute(p)) throw new Error('Configuration paths must be absolute');
  return p;
}
function interval(value: unknown, min: number, max = 86_400_000): number {
  const n = integer(value, max);
  if (n < min) throw new Error('Configuration interval is too small');
  return n;
}
export function serverConfig(raw: unknown): ServerConfig {
  const v = object(raw);
  keys(v, ['host', 'port', 'database', 'adminToken', 'offlineMs', 'activeMs', 'quotaFreshMs', 'maxBodyBytes', 'requestsPerMinute']);
  const host = text(v.host);
  if (host !== '0.0.0.0' && !privateAddress(host)) throw new Error('Bind to a literal private LAN or loopback IP');
  const port = interval(v.port, 1, 65535);
  const adminToken = text(v.adminToken, 256);
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(adminToken)) throw new Error('Admin token must have at least 32 URL-safe characters');
  return { host, port, database: absolute(v.database), adminToken,
    offlineMs: interval(v.offlineMs ?? 120_000, 10_000), activeMs: interval(v.activeMs ?? 900_000, 10_000),
    quotaFreshMs: interval(v.quotaFreshMs ?? 300_000, 10_000),
    maxBodyBytes: interval(v.maxBodyBytes ?? 1_048_576, 4096, 8_388_608),
    requestsPerMinute: interval(v.requestsPerMinute ?? 240, 30, 100_000) };
}
export function agentConfig(raw: unknown): AgentConfig {
  const v = object(raw);
  keys(v, ['server', 'name', 'projects', 'database', 'syncMs', 'heartbeatMs', 'quotaPath', 'projectAliases']);
  const url = new URL(text(v.server, 2048));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Server must be an HTTP(S) origin without credentials');
  }
  const aliases: Record<string, string> = {};
  for (const [k, val] of Object.entries(object(v.projectAliases ?? {}))) {
    if (!/^[a-f0-9]{64}$/.test(k)) throw new Error('Project aliases must use hashed IDs');
    aliases[k] = text(val);
  }
  return { server: url.origin, name: text(v.name), projects: absolute(v.projects), database: absolute(v.database),
    syncMs: interval(v.syncMs ?? 30_000, 1000), heartbeatMs: interval(v.heartbeatMs ?? 30_000, 1000),
    quotaPath: v.quotaPath == null ? null : absolute(v.quotaPath), projectAliases: aliases };
}
export function readConfig(file: string): unknown { return JSON.parse(fs.readFileSync(file, 'utf8')); }
export function writePrivate(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
