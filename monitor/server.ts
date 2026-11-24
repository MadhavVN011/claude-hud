import http from 'node:http';
import fs from 'node:fs';
import { Store, csvCell } from './store.ts';
import type { Filter } from './store.ts';
import type { ServerConfig } from './config.ts';
import { privateAddress } from './config.ts';
import { HttpError, object, keys, text, uuid, event, status, quota, VERSION } from './protocol.ts';

export type Logger = (record: Record<string, unknown>) => void;
export const logger: Logger = record => process.stdout.write(JSON.stringify({ time: new Date().toISOString(), ...record }) + '\n');
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
function json(response: http.ServerResponse, code: number, value: unknown): void {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}
async function body(request: http.IncomingMessage, max: number): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw new HttpError(415, 'json_required');
  if (Number(request.headers['content-length'] ?? 0) > max) throw new HttpError(413, 'body_too_large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, 'body_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'invalid_json'); }
}
export function filterParams(params: URLSearchParams, now: number): Filter {
  const date = (key: string, fallback: number): number => {
    const val = params.get(key);
    if (val === null) return fallback;
    if (!/^\d{4}-\d\d-\d\dT/.test(val)) throw new HttpError(400, 'invalid_date');
    const ms = Date.parse(val);
    if (!Number.isFinite(ms) || ms < 0 || ms > Date.UTC(2200, 0)) throw new HttpError(400, 'invalid_date');
    return ms;
  };
  const from = date('from', 0), to = date('to', now + 1);
  if (from >= to) throw new HttpError(400, 'invalid_date_range');
  const device = params.get('device');
  return { from, to, ...(device ? { device: uuid(device) } : {}) };
}
export function createMonitorServer(config: ServerConfig, options: { now?: () => number; log?: Logger } = {}) {
  const store = new Store(config), clock = options.now ?? Date.now, log = options.log ?? logger;
  const buckets = new Map<string, { at: number; count: number }>();
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 15_000, headersTimeout: 10_000 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    const run = async () => {
      const now = clock(), remote = req.socket.remoteAddress ?? '';
      if (!privateAddress(remote)) throw new HttpError(403, 'lan_only');
      if (req.headers.origin && ![`http://${req.headers.host}`, `https://${req.headers.host}`].includes(req.headers.origin)) {
        throw new HttpError(403, 'origin_denied');
      }
      for (const [key, bucket] of buckets) if (now - bucket.at >= 60_000) buckets.delete(key);
      const bucket = buckets.get(remote) ?? { at: now, count: 0 };
      if (buckets.size >= 10_000 && !buckets.has(remote)) throw new HttpError(429, 'rate_limited');
      buckets.set(remote, bucket);
      if (++bucket.count > config.requestsPerMinute) {
        res.setHeader('Retry-After', '60'); throw new HttpError(429, 'rate_limited');
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.searchParams.has('token') || url.searchParams.has('authorization')) throw new HttpError(400, 'credentials_in_url');
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok', version: VERSION });
      const asset = ASSETS.get(url.pathname);
      if (asset && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': asset[1] });
        res.end(fs.readFileSync(new URL('./web/' + asset[0], import.meta.url)));
        return;
      }
      const token = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(req.headers.authorization ?? '')?.[1];
      if (!token) throw new HttpError(401, 'authentication_required');
      if (req.method === 'POST' && url.pathname === '/api/register') {
        const data = object(await body(req, config.maxBodyBytes)); keys(data, ['deviceId', 'status']);
        const registered = store.register(token, uuid(data.deviceId), status(data.status), now);
        log({ event: 'device_registered', device: registered.deviceId });
        return json(res, 200, registered);
      }
      if (url.pathname === '/api/heartbeat' || url.pathname === '/api/usage') {
        if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
        const id = store.authenticate(token);
        if (!id) throw new HttpError(401, 'invalid_device_credential');
        const data = object(await body(req, config.maxBodyBytes));
        keys(data, url.pathname === '/api/usage' ? ['events', 'status', 'quota'] : ['status']);
        const info = status(data.status);
        if (url.pathname === '/api/heartbeat') {
          store.heartbeat(id, info, now); return json(res, 200, { ok: true, at: now });
        }
        if (!Array.isArray(data.events) || data.events.length > 1000) throw new HttpError(400, 'invalid_batch');
        const events = data.events.map(e => event(e, now)), snapshot = quota(data.quota, now);
        const result = store.ingest(id, events, info, snapshot, now);
        log({ event: 'usage_received', device: id, received: events.length, duplicates: result.duplicates });
        return json(res, 200, { ...result, at: now });
      }
      if (!store.admin(token)) throw new HttpError(401, 'invalid_admin_credential');
      if (req.method === 'POST' && url.pathname === '/api/enrollments') {
        const data = object(await body(req, 4096)); keys(data, ['name']);
        return json(res, 201, store.enrollment(text(data.name), now));
      }
      if (req.method === 'GET' && url.pathname === '/api/devices') return json(res, 200, store.devices(now));
      const deviceMatch = /^\/api\/devices\/([^/]+)$/.exec(url.pathname);
      if (deviceMatch) {
        const id = uuid(deviceMatch[1]);
        if (req.method === 'GET') return json(res, 200, store.detail(id, now));
        if (req.method === 'DELETE') { store.manage(id, { archive: true }); return json(res, 200, { archived: true, historyRetained: true }); }
        if (req.method === 'PATCH') {
          const data = object(await body(req, 4096)); keys(data, ['name', 'revoke']);
          if (data.revoke !== undefined && data.revoke !== true) throw new HttpError(400, 'revoke_must_be_true');
          store.manage(id, { ...(data.name !== undefined ? { name: text(data.name) } : {}), ...(data.revoke === true ? { revoke: true } : {}) });
          return json(res, 200, { ok: true });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/analytics') return json(res, 200, store.analytics(filterParams(url.searchParams, now), now));
      if (req.method === 'GET' && url.pathname === '/api/quota') return json(res, 200, store.quotas(now));
      if (req.method === 'GET' && url.pathname === '/api/export') {
        const filter = filterParams(url.searchParams, now);
        const format = url.searchParams.get('format') ?? 'json', group = url.searchParams.get('group') ?? 'events';
        if (!['csv', 'json'].includes(format) || !['events', 'model', 'daily'].includes(group)) throw new HttpError(400, 'invalid_export');
        res.writeHead(200, { 'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="claude-usage-${group}.${format}"` });
        const write = async (s: string) => {
          if (res.destroyed) throw new HttpError(499, 'client_disconnected');
          if (!res.write(s)) await new Promise<void>((resolve, reject) => {
            const cleanup = () => { res.off('drain', drain); res.off('close', closed); res.off('error', failed); };
            const drain = () => { cleanup(); resolve(); };
            const closed = () => { cleanup(); reject(new HttpError(499, 'client_disconnected')); };
            const failed = () => { cleanup(); reject(new HttpError(499, 'client_disconnected')); };
            res.once('drain', drain); res.once('close', closed); res.once('error', failed);
          });
        };
        let first = true;
        if (format === 'json') await write('[');
        const columns = group === 'events'
          ? ['device', 'id', 'session', 'project', 'projectLabel', 'model', 'at', 'input', 'output', 'cacheCreation', 'cacheRead', 'total']
          : ['key', 'input', 'output', 'cacheCreation', 'cacheRead', 'total'];
        if (format === 'csv') await write(columns.map(csvCell).join(',') + '\r\n');
        for (const row of store.exportRows(filter, group as 'events' | 'model' | 'daily')) {
          if (format === 'csv') {
            await write(columns.map(key => csvCell(row[key])).join(',') + '\r\n');
          } else await write((first ? '' : ',') + JSON.stringify(row));
          first = false;
        }
        res.end(format === 'json' ? ']\n' : '');
        return;
      }
      throw new HttpError(404, 'not_found');
    };
    void run().catch(error => {
      const code = error instanceof HttpError ? error.status : 500;
      log({ event: 'request_rejected', status: code, code: error instanceof HttpError ? error.code : 'internal_error' });
      if (!res.headersSent && !res.destroyed) json(res, code, { error: error instanceof HttpError ? error.code : 'internal_error' });
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 5000;
  const close = (): Promise<void> => new Promise((resolve, reject) => {
    const force = setTimeout(() => server.closeAllConnections(), 5000); force.unref();
    server.close(error => { clearTimeout(force); store.close(); if (error) reject(error); else resolve(); });
  });
  return { server, store, close };
}
