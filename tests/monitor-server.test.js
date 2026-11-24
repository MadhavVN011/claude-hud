import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createMonitorServer } from '../monitor/server.ts';
import { serverConfig, agentConfig } from '../monitor/config.ts';
import { Collector } from '../monitor/collector.ts';
import { hash, secret } from '../monitor/protocol.ts';
import { csvCell } from '../monitor/store.ts';

const NOW = Date.parse('2026-11-24T06:00:00Z');
const INFO = { hostname: 'sanitized', os: 'win32', version: 'test', claudeAvailable: true, dataAvailable: true, localEvents: 1, localTokens: 19, errors: {} };
const usage = (id = 'one', at = NOW - 1000) => ({ id: hash(id), session: hash('session-' + id), project: hash('project'),
  projectLabel: 'Private project', model: 'claude-test', at, input: 10, output: 2, cacheCreation: 3, cacheRead: 4 });

async function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-server-')), logs = [], collectors = [];
  const config = serverConfig({ host: '127.0.0.1', port: 8787, database: path.join(dir, 'central.sqlite'), adminToken: secret(), ...overrides });
  let now = NOW, app;
  const start = async () => {
    app = createMonitorServer(config, { now: () => now, log: row => logs.push(row) });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  };
  await start();
  const url = () => 'http://127.0.0.1:' + app.server.address().port;
  const call = async (endpoint, { method = 'GET', token = config.adminToken, data, headers = {}, raw } = {}) => {
    const response = await fetch(url() + endpoint, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(data !== undefined || raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(data !== undefined || raw ? { body: raw ?? JSON.stringify(data) } : {}) });
    return { status: response.status, body: await response.text(), headers: response.headers };
  };
  const json = async (...args) => { const r = await call(...args); return { ...r, data: JSON.parse(r.body) }; };
  const register = async (name = 'Windows-Laptop') => {
    const invite = await json('/api/enrollments', { method: 'POST', data: { name } });
    assert.equal(invite.status, 201);
    const id = randomUUID(), result = await json('/api/register', { method: 'POST', token: invite.data.enrollment, data: { deviceId: id, status: INFO } });
    assert.equal(result.status, 200, result.body);
    return { id, token: result.data.token, enrollment: invite.data.enrollment };
  };
  const ingest = (device, events, quota = null, status = INFO) => json('/api/usage', { method: 'POST', token: device.token, data: { events, status, quota } });
  const collector = name => {
    const localDir = path.join(dir, name), projects = path.join(localDir, 'projects'); fs.mkdirSync(projects, { recursive: true });
    const c = new Collector(agentConfig({ server: url(), name, projects, database: path.join(localDir, 'spool.sqlite') }));
    collectors.push(c); return c;
  };
  t.after(async () => { for (const c of collectors) c.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { call, json, register, ingest, collector, config, logs, url,
    advance: ms => { now += ms; }, restart: async () => { await app.close(); await start(); }, store: () => app.store };
}
test('monitor authenticated device enrollment is expiring, UUID-bound, recoverable and secret-free in storage/logs', async t => {
  const s = await setup(t), a = await s.register();
  assert.equal((await s.json('/api/register', { method: 'POST', token: a.enrollment, data: { deviceId: a.id, status: INFO } })).data.token, a.token);
  assert.equal((await s.json('/api/register', { method: 'POST', token: a.enrollment, data: { deviceId: randomUUID(), status: INFO } })).status, 401);
  assert.equal((await s.json('/api/devices', { token: a.token })).status, 401);
  assert.equal((await s.json('/api/heartbeat', { method: 'POST', token: s.config.adminToken, data: { status: INFO } })).status, 401);
  const before = await s.json('/api/devices'); assert.equal(before.data[0].status, 'online');
  assert.equal(before.body.includes(a.token), false); assert.equal(before.body.includes('token_hash'), false);
  const invite = await s.json('/api/enrollments', { method: 'POST', data: { name: 'Not connected' } });
  assert.ok((await s.json('/api/devices')).data.some(d => d.status === 'never-connected'));
  s.advance(900_001);
  assert.equal((await s.json('/api/register', { method: 'POST', token: invite.data.enrollment, data: { deviceId: randomUUID(), status: INFO } })).status, 401);
  assert.equal(JSON.stringify(s.logs).includes(a.token), false);
  assert.equal(fs.readFileSync(s.config.database).includes(Buffer.from(a.token)), false);
});
test('monitor two devices, retries and copied sessions count once with per-device isolation', async t => {
  const s = await setup(t), a = await s.register('Linux-Desktop'), b = await s.register('Windows-Laptop');
  await s.ingest(a, [usage('shared')]); await s.ingest(a, [usage('shared'), { ...usage('shared'), input: 20, output: 1 }]);
  const copied = await s.ingest(b, [{ ...usage('shared'), input: 9000 }, usage('windows')]);
  assert.equal(copied.data.duplicates, 1);
  const stats = (await s.json('/api/analytics')).data;
  assert.equal(stats.totals.total, 48); assert.equal(stats.totals.sessions, 2);
  assert.equal(stats.devices.find(d => d.key === a.id).input, 20);
  assert.equal(stats.devices.find(d => d.key === b.id).input, 10);
  assert.equal(stats.activeSessions, 2); assert.equal(stats.models[0].total, 48);
});
test('monitor windows use event time, inclusive starts, exclusive ends and never upload time', async t => {
  const s = await setup(t), a = await s.register();
  const five = NOW - 18_000_000, seven = NOW - 604_800_000;
  await s.ingest(a, [usage('recent', NOW), usage('five-boundary', five), usage('before-five', five - 1),
    usage('seven-boundary', seven), usage('before-seven', seven - 1), usage('old', NOW - 40 * 86_400_000)]);
  const stats = (await s.json('/api/analytics')).data;
  assert.equal(stats.windows.fiveHour.total, 38); assert.equal(stats.windows.sevenDay.total, 76);
  assert.equal(stats.windows.all.total, 114); assert.equal(stats.windows.thirtyDay.total, 95);
  const from = new Date(five).toISOString(), to = new Date(NOW).toISOString();
  const selected = (await s.json('/api/analytics?' + new URLSearchParams({ from, to, device: a.id }))).data;
  assert.equal(selected.totals.total, 19);
  assert.equal((await s.json('/api/analytics?from=bad')).status, 400);
  assert.equal((await s.json('/api/analytics?device=invalid')).status, 400);
});
test('monitor heartbeats, error status, offline timeout, revoked access and archival retain history', async t => {
  const s = await setup(t), a = await s.register(); await s.ingest(a, [usage()]);
  s.advance(121_000); assert.equal((await s.json('/api/devices')).data[0].status, 'offline');
  assert.equal((await s.json('/api/analytics')).data.activeSessions, 0);
  await s.json('/api/heartbeat', { method: 'POST', token: a.token, data: { status: { ...INFO, errors: { read_failed: 1 } } } });
  assert.equal((await s.json('/api/devices')).data[0].status, 'error');
  await s.json('/api/devices/' + a.id, { method: 'PATCH', data: { name: 'Renamed', revoke: true } });
  assert.equal((await s.ingest(a, [usage()])).status, 401);
  assert.equal((await s.json('/api/register', { method: 'POST', token: a.enrollment, data: { deviceId: a.id, status: INFO } })).status, 401);
  assert.equal((await s.json('/api/devices/' + a.id)).data.name, 'Renamed');
  await s.json('/api/devices/' + a.id, { method: 'DELETE' });
  assert.equal((await s.json('/api/devices')).data[0].status, 'archived');
  assert.equal((await s.json('/api/analytics')).data.totals.total, 19);
});
test('monitor official quota is selected per window, never summed, and becomes unavailable when stale or reset', async t => {
  const s = await setup(t), a = await s.register(), b = await s.register();
  assert.equal((await s.json('/api/quota')).data.fiveHour, null);
  const quota = { source: 'claude-code-statusline', at: NOW, fiveHour: { used: 42, resetAt: NOW + 240_000 }, sevenDay: { used: 15, resetAt: NOW + 604_800_000 } };
  await s.ingest(a, [], quota); s.advance(1000);
  await s.ingest(b, [], { ...quota, at: NOW + 1000, fiveHour: null, sevenDay: { used: 20, resetAt: NOW + 604_800_000 } });
  let data = (await s.json('/api/quota')).data;
  assert.equal(data.fiveHour.used, 42); assert.equal(data.fiveHour.remaining, 58); assert.equal(data.sevenDay.used, 20);
  assert.equal(data.fiveHour.deviceId, a.id); assert.equal(data.sevenDay.deviceId, b.id);
  s.advance(240_000); data = (await s.json('/api/quota')).data; assert.equal(data.fiveHour, null); assert.equal(data.sevenDay.used, 20);
  s.advance(60_000); assert.equal((await s.json('/api/quota')).data.sevenDay, null);
  assert.equal((await s.ingest(a, [], { ...quota, source: 'estimated' })).status, 400);
});
test('monitor exports selected devices, ranges, model and daily summaries as CSV and JSON', async t => {
  const s = await setup(t), a = await s.register(), b = await s.register();
  await s.ingest(a, [{ ...usage('one'), projectLabel: '=UNTRUSTED()' }]); await s.ingest(b, [usage('two', NOW - 86_400_000)]);
  const json = await s.json('/api/export?' + new URLSearchParams({ device: a.id, format: 'json' }));
  assert.equal(json.data.length, 1); assert.equal(json.data[0].device, a.id);
  const csv = await s.call('/api/export?format=csv'); assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.body, /"'=UNTRUSTED\(\)"/); assert.match(csv.body, /cacheCreation/);
  assert.equal((await s.json('/api/export?group=model')).data[0].total, 38);
  assert.equal((await s.json('/api/export?group=daily')).data.length, 2);
  assert.equal((await s.json('/api/export?group=sql')).status, 400);
  assert.equal(csvCell('a"b,c'), '"a""b,c"');
  const empty = await s.call('/api/export?' + new URLSearchParams({ format: 'csv', from: new Date(NOW + 1).toISOString() }));
  assert.equal(empty.status, 400); // The default upper bound is now; inverted ranges cannot leak data.
  const noRows = await s.call('/api/export?' + new URLSearchParams({ format: 'csv', from: new Date(NOW + 1).toISOString(), to: new Date(NOW + 1000).toISOString() }));
  assert.match(noRows.body, /^"device","id"/); assert.equal(noRows.body.trim().split('\n').length, 1);
});
test('monitor server restart preserves credentials, migrations, idempotency and analytics', async t => {
  const s = await setup(t), a = await s.register(); await s.ingest(a, [usage()]);
  await s.restart(); assert.equal((await s.ingest(a, [usage()])).status, 200);
  assert.equal((await s.json('/api/analytics')).data.totals.total, 19);
  assert.equal(s.store().db.prepare('PRAGMA user_version').get().user_version, 1);
});
test('monitor rejects unknown payload fields, raw conversation content, invalid counters and oversized requests atomically', async t => {
  const s = await setup(t, { maxBodyBytes: 4096 }), a = await s.register();
  assert.equal((await s.ingest(a, [usage(), { ...usage('bad'), input: -1 }])).status, 400);
  assert.equal((await s.json('/api/analytics')).data.totals.total, 0);
  assert.equal((await s.ingest(a, [{ ...usage(), content: 'RAW_SECRET' }])).status, 400);
  assert.equal((await s.ingest(a, [usage()], null, { ...INFO, errors: { message: 'RAW_SECRET' } })).status, 400);
  assert.equal((await s.call('/api/usage', { method: 'POST', token: a.token, raw: '{bad' })).status, 400);
  assert.equal((await s.call('/api/usage', { method: 'POST', token: a.token, raw: JSON.stringify({ data: 'x'.repeat(5000) }) })).status, 413);
  assert.equal((await s.call('/api/devices', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await s.call('/api/devices', { token: '' })).status, 401);
  assert.equal((await s.call('/api/devices?token=secret')).status, 400);
  assert.equal(JSON.stringify(s.logs).includes('RAW_SECRET'), false);
});
test('monitor health/static assets have security headers, no external assets and APIs enforce rate limits', async t => {
  const s = await setup(t, { requestsPerMinute: 30 });
  assert.equal((await s.json('/health', { token: '' })).data.status, 'ok');
  const page = await s.call('/', { token: '' }); assert.match(page.body, /Device Observatory/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.doesNotMatch(page.body, /<script[^>]+src="https?:/);
  assert.equal((await s.call('/app.js', { token: '' })).status, 200);
  for (let i = 0; i < 30; i++) await s.call('/health', { token: '' });
  assert.equal((await s.call('/health', { token: '' })).status, 429);
  s.advance(60_001); assert.equal((await s.call('/health', { token: '' })).status, 200);
});
test('monitor real collectors recover a lost acknowledgement and drain queued activity from two simulated machines', async t => {
  const s = await setup(t), a = s.collector('linux'), b = s.collector('windows');
  for (const c of [a, b]) {
    const invitation = await s.json('/api/enrollments', { method: 'POST', data: { name: c.config.name } });
    await c.enroll(invitation.data.enrollment);
    fs.mkdirSync(path.join(c.config.projects, 'project'));
    fs.writeFileSync(path.join(c.config.projects, 'project', 's.jsonl'), JSON.stringify({ type: 'assistant', sessionId: 's', timestamp: '2026-11-24T05:00:00Z',
      message: { id: 'same-copied-message', model: 'claude-test', content: 'PRIVATE_NEVER_UPLOAD', usage: { input_tokens: 100, output_tokens: 10 } } }) + '\n');
    await c.scan(); assert.equal(c.pending().length, 1);
  }
  const original = a.request.bind(a); let fail = true;
  a.request = async (...args) => { const result = await original(...args); if (fail) { fail = false; throw new Error('lost_response'); } return result; };
  await assert.rejects(a.sync()); assert.equal(a.pending().length, 1);
  await a.sync(); assert.equal(a.pending().length, 0);
  await b.sync(); assert.equal(b.pending().length, 0);
  assert.equal((await s.json('/api/analytics')).data.totals.total, 110);
  const history = (await s.json('/api/devices/' + b.deviceId)).data.history;
  assert.equal(history[0].duplicates, 1); assert.equal(JSON.stringify(s.logs).includes('PRIVATE_NEVER_UPLOAD'), false);
});
test('monitor collector retains measurements during a transport outage and synchronizes after connectivity returns', async t => {
  const s = await setup(t), c = s.collector('offline');
  const invite = await s.json('/api/enrollments', { method: 'POST', data: { name: 'Offline machine' } });
  await c.enroll(invite.data.enrollment);
  const project = path.join(c.config.projects, 'p'); fs.mkdirSync(project);
  const makeLine = n => JSON.stringify({ type: 'assistant', sessionId: 'offline', timestamp: '2026-11-24T05:00:00Z',
    message: { id: 'message' + n, model: 'claude-test', usage: { input_tokens: n } } }) + '\n';
  const file = path.join(project, 'offline.jsonl'); fs.writeFileSync(file, makeLine(1));
  const server = c.config.server; c.config.server = 'http://127.0.0.1:1';
  await c.scan(); await assert.rejects(c.sync()); assert.equal(c.pending().length, 1);
  fs.appendFileSync(file, makeLine(2)); await c.scan(); assert.equal(c.pending().length, 2);
  c.config.server = server; await c.sync(); assert.equal(c.pending().length, 0);
  assert.equal((await s.json('/api/analytics')).data.totals.total, 3);
});
