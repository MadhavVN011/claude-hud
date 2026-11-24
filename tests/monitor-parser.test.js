import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeAvailable } from '../monitor/availability.ts';
import { parseLine, fileContext, projectId } from '../monitor/parser.ts';
import { event, total, hash } from '../monitor/protocol.ts';
import { privateAddress, agentConfig, serverConfig } from '../monitor/config.ts';

const at = Date.parse('2026-11-24T06:00:00Z');
const line = (changes = {}, message = {}) => JSON.stringify({ type: 'assistant', sessionId: 's', cwd: '/repo',
  timestamp: '2026-11-24T05:00:00Z', ...changes, message: { id: 'm', model: 'claude-test', usage: {
    input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 }, ...message } });
test('monitor parser extracts only privacy allowlisted counters and model', () => {
  const value = parseLine(line({ prompt: 'SECRET', uuid: 'unnecessary' }, { content: 'SECRET' }), 'project/s.jsonl', {}, at).event;
  assert.equal(total(value), 19); assert.equal(value.model, 'claude-test');
  assert.equal(JSON.stringify(value).includes('SECRET'), false);
  assert.equal(JSON.stringify(value).includes('/repo'), false);
  assert.deepEqual(event(value, at), value);
});
test('monitor parses sanitized real-format fixtures and ignores non-assistant replay blobs', () => {
  const lines = fs.readFileSync(new URL('./fixtures/monitor-transcript.jsonl', import.meta.url), 'utf8').trim().split('\n');
  const results = lines.map(l => parseLine(l, 'project/session-one.jsonl', {}, at));
  assert.equal(results[0].event, undefined); assert.equal(results[4].event, undefined);
  assert.equal(results[1].event.id, results[2].event.id);
  assert.equal(results[3].event.cacheCreation, 12);
});
test('monitor version tolerance skips malformed, ambiguous, invalid-date and synthetic records', () => {
  assert.equal(parseLine('{', 'p/s.jsonl').error, 'malformed_records');
  assert.equal(parseLine(line({}, { id: null }), 'p/s.jsonl', {}, at).error, 'unsupported_records');
  assert.equal(parseLine(line({ timestamp: null }), 'p/s.jsonl', {}, at).error, 'unsupported_records');
  assert.equal(parseLine(line({ timestamp: '2201-01-01' }), 'p/s.jsonl', {}, at).error, 'unsupported_records');
  assert.equal(parseLine(line({}, { model: '<synthetic>' }), 'p/s.jsonl', {}, at).event, undefined);
  assert.equal(parseLine(line({}, { usage: null }), 'p/s.jsonl', {}, at).event, undefined);
  assert.equal(parseLine(line({}, { usage: { input_tokens: -2, output_tokens: '5', cache_read_input_tokens: 1.1 } }), 'p/s.jsonl', {}, at).event, undefined);
});
test('monitor message IDs and request fallback survive renamed or copied transcript paths', () => {
  const a = parseLine(line(), 'first/renamed.jsonl', {}, at).event;
  const b = parseLine(line(), 'second/copied.jsonl', {}, at).event;
  assert.equal(a.id, b.id);
  assert.ok(parseLine(line({ requestId: 'request' }, { id: null }), 'p/s.jsonl', {}, at).event);
});
test('monitor cross-platform paths and parent/subagent sessions group consistently', () => {
  assert.deepEqual(fileContext('project\\parent\\subagents\\agent-1.jsonl'), { session: 'parent', project: 'project' });
  assert.deepEqual(fileContext('project/parent.jsonl'), { session: 'parent', project: 'project' });
  assert.equal(projectId('C:\\Users\\Example\\Repo\\'), projectId('c:/users/example/repo'));
  const sub = parseLine(line({ sessionId: 'child' }), 'p/parent/subagents/agent.jsonl', {}, at).event;
  assert.equal(sub.session, hash('session:parent'));
});
test('monitor project labels are hashed unless explicitly aliased; unknown models stay Unknown', () => {
  const project = projectId('/repo');
  assert.equal(parseLine(line(), 'p/s.jsonl', { [project]: 'Dashboard' }, at).event.projectLabel, 'Dashboard');
  assert.equal(parseLine(line({}, { model: null }), 'p/s.jsonl', {}, at).event.model, 'Unknown');
});
test('monitor recognizes only LAN, loopback, link-local and Tailscale private addresses', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:192.168.1.20', '10.0.0.2', '172.16.0.1', '100.64.0.1', 'fd7a:115c:a1e0::1', 'fe80::1']) assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.15.0.1', '100.63.0.1', 'example.com', 'fd77:invalid', 'fe80:invalid', '2001:4860:4860::8888']) assert.equal(privateAddress(ip), false, ip);
});
test('monitor config rejects unsafe bind addresses, weak credentials, relative paths and invalid intervals', () => {
  const config = { host: '127.0.0.1', port: 8787, database: '/tmp/test.sqlite', adminToken: 'x'.repeat(40) };
  assert.throws(() => serverConfig({ ...config, host: '8.8.8.8' }));
  assert.throws(() => serverConfig({ ...config, adminToken: 'weak' }));
  assert.throws(() => serverConfig({ ...config, database: 'relative' }));
  assert.throws(() => serverConfig({ ...config, offlineMs: 1 }));
  const agent = { server: 'http://192.168.1.2:8787', name: 'Laptop', projects: '/tmp/projects', database: '/tmp/local.sqlite' };
  assert.equal(agentConfig(agent).syncMs, 30_000);
  assert.throws(() => agentConfig({ ...agent, server: 'http://user:pass@host' }));
  assert.throws(() => agentConfig({ ...agent, server: 'http://host/path' }));
});
test('monitor executable availability checks absolute paths without executing detected files', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-availability-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const candidate = path.join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  assert.equal(claudeAvailable({ PATH: '' }, dir), false);
  fs.writeFileSync(candidate, 'THIS_MUST_NEVER_BE_EXECUTED', { mode: 0o700 });
  assert.equal(claudeAvailable({ PATH: dir }, dir), true);
  assert.equal(claudeAvailable({ PATH: '.' }, path.join(dir, 'empty-home')), false);
});
