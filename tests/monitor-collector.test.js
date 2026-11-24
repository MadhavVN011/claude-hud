import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Collector } from '../monitor/collector.ts';
import { agentConfig } from '../monitor/config.ts';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-monitor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = agentConfig({ server: 'http://127.0.0.1:8787', name: 'Test', projects: path.join(dir, 'projects'), database: path.join(dir, 'spool.sqlite'), quotaPath: path.join(dir, 'quota.json') });
  const project = path.join(config.projects, 'sanitized'); fs.mkdirSync(project, { recursive: true });
  return { config, project, file: path.join(project, 's.jsonl') };
}
function record(id, input = 100, output = 10, extra = {}) {
  return JSON.stringify({ type: 'assistant', sessionId: 's', timestamp: '2026-01-01T01:00:00Z', cwd: '/private/project',
    message: { id, model: 'claude-test', content: 'NEVER_PERSIST_ME', usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 } }, ...extra });
}
test('monitor incremental outbox merges non-adjacent duplicate maxima, acknowledges updates and survives restart', async t => {
  const { config, file } = setup(t); let c = new Collector(config);
  fs.writeFileSync(file, record('a') + '\n' + record('b') + '\n' + record('a', 120, 5) + '\n');
  await c.scan(); assert.equal(c.pending().length, 2); assert.equal(c.info().localTokens, 340);
  const first = c.pending(); c.acknowledge(first); assert.equal(c.pending().length, 0);
  fs.appendFileSync(file, record('a', 120, 15) + '\n'); await c.scan();
  assert.equal(c.pending().length, 1); assert.equal(JSON.parse(c.pending()[0].payload).output, 15);
  // A late acknowledgement must not clear a new revision.
  c.acknowledge(first); assert.equal(c.pending().length, 1);
  const deviceId = c.deviceId; c.close(); c = new Collector(config);
  try { assert.equal(c.deviceId, deviceId); assert.equal(c.pending().length, 1); await c.scan(); assert.equal(c.info().localEvents, 2); }
  finally { c.close(); }
  assert.equal(fs.readFileSync(config.database).includes(Buffer.from('NEVER_PERSIST_ME')), false);
  assert.equal(fs.readFileSync(config.database).includes(Buffer.from('/private/project')), false);
});
test('monitor partial writes including split UTF-8 are read only after newline completion', async t => {
  const { config, file } = setup(t), c = new Collector(config); t.after(() => c.close());
  const line = Buffer.from(record('utf8', 100, 10, { content: '你好' }) + '\n');
  const index = line.indexOf(Buffer.from('你好')) + 1;
  fs.writeFileSync(file, line.subarray(0, index)); await c.scan(); assert.equal(c.pending().length, 0);
  fs.appendFileSync(file, line.subarray(index, line.length - 1)); await c.scan(); assert.equal(c.pending().length, 0);
  fs.appendFileSync(file, '\n'); await c.scan(); assert.equal(c.pending().length, 1);
});
test('monitor incomplete scan checkpoints resume even when file metadata is unchanged', async t => {
  const { config, file } = setup(t); let c = new Collector(config);
  fs.writeFileSync(file, record('a') + '\n' + record('b') + '\n'); await c.scan();
  c.db.prepare('DELETE FROM outbox WHERE id=?').run(c.pending()[1].id);
  // Simulate a committed first chunk followed by process termination before the second chunk.
  const offset = Buffer.byteLength(record('a') + '\n');
  c.db.prepare('UPDATE files SET offset=?,prefix=?,suffix=?').run(offset,
    (await import('../monitor/protocol.ts')).hash(Buffer.from(record('a') + '\n').toString('base64')),
    (await import('../monitor/protocol.ts')).hash(Buffer.from(record('a') + '\n').toString('base64')));
  c.close(); c = new Collector(config);
  try { await c.scan(); assert.equal(c.info().localEvents, 2); } finally { c.close(); }
});
test('monitor rewrites, truncation, file replacement, copied files and deletion retain measured history', async t => {
  const { config, file, project } = setup(t), c = new Collector(config); t.after(() => c.close());
  fs.writeFileSync(file, record('a') + '\n'); await c.scan();
  fs.writeFileSync(file, record('a', 200) + '\n'); await c.scan(); assert.equal(c.info().localTokens, 260);
  fs.copyFileSync(file, path.join(project, 'copy.jsonl')); await c.scan(); assert.equal(c.info().localEvents, 1);
  fs.unlinkSync(file); fs.writeFileSync(file, record('b') + '\n'); await c.scan(); assert.equal(c.info().localEvents, 2);
  fs.writeFileSync(file, ''); await c.scan(); fs.unlinkSync(file); await c.scan(); assert.equal(c.info().localEvents, 2);
});
test('monitor malformed and oversized records are diagnosed and later valid lines still collect', async t => {
  const { config, file } = setup(t), c = new Collector(config); t.after(() => c.close());
  fs.writeFileSync(file, '{malformed}\n' + 'x'.repeat(8 * 1024 * 1024 + 1) + '\n' + record('ok') + '\n');
  await c.scan(); assert.equal(c.pending().length, 1); assert.equal(c.info().errors.malformed_records, 1);
  assert.equal(c.info().errors.oversized_records, 1);
});
test('monitor includes nested subagents without creating extra parent sessions and skips symlinks', async t => {
  const { config, file, project } = setup(t), c = new Collector(config); t.after(() => c.close());
  fs.writeFileSync(file, record('a') + '\n');
  const subdir = path.join(project, 's', 'subagents'); fs.mkdirSync(subdir, { recursive: true });
  fs.writeFileSync(path.join(subdir, 'agent-1.jsonl'), record('b', 100, 10, { sessionId: 'child', isSidechain: true }) + '\n');
  if (process.platform !== 'win32') fs.symlinkSync(config.projects, path.join(project, 'loop'));
  await c.scan(); assert.equal(c.pending().length, 2);
  assert.equal(new Set(c.pending().map(r => JSON.parse(r.payload).session)).size, 1);
});
test('monitor absent data and invalid quota snapshot report bounded codes without content', async t => {
  const { config } = setup(t), c = new Collector(config); t.after(() => c.close());
  fs.rmSync(config.projects, { recursive: true }); await c.scan(); assert.equal(c.info().dataAvailable, false);
  assert.equal(c.info().errors.projects_missing, 1); assert.equal(c.readQuota(), null);
  fs.writeFileSync(config.quotaPath, '{bad secret'); assert.equal(c.readQuota(), null);
  assert.equal(c.info().errors.quota_invalid, 1);
  const now = Date.now(); fs.writeFileSync(config.quotaPath, JSON.stringify({ updated_at: new Date(now).toISOString(),
    five_hour: { used_percentage: 42, resets_at: new Date(now + 60_000).toISOString() }, seven_day: { used_percentage: null, resets_at: null }, balance_label: 'DO_NOT_UPLOAD' }));
  const q = c.readQuota(now); assert.equal(q.fiveHour.used, 42); assert.equal(q.sevenDay, null);
  assert.equal(JSON.stringify(q).includes('DO_NOT_UPLOAD'), false);
});
