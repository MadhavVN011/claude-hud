import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serviceUnit } from '../monitor/service.ts';

const cli = new URL('../monitor/cli.ts', import.meta.url);
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configDir = path.join(dir, 'claude');
  const run = (...args) => spawnSync(process.execPath, [fileURLToPath(cli), ...args, '--dir', dir], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, encoding: 'utf8' });
  return { dir, configDir, run };
}
test('monitor CLI generates private configs without printing secrets and refuses to overwrite them', t => {
  const { dir, configDir, run } = setup(t);
  const result = run('init-server'); assert.equal(result.status, 0, result.stdout);
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'server.json')));
  assert.equal(config.host, '127.0.0.1'); assert.ok(config.adminToken.length >= 32);
  assert.equal(result.stdout.includes(config.adminToken), false);
  assert.equal(run('init-server').status, 1);
  assert.equal(run('admin-token').stdout.trim(), config.adminToken);
  assert.equal(run('init-agent', '--name', 'Sanitized').status, 0);
  const agent = JSON.parse(fs.readFileSync(path.join(dir, 'agent.json')));
  assert.equal(agent.projects, path.join(configDir, 'projects')); assert.equal(agent.name, 'Sanitized');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'server.json')).mode & 0o777, 0o600);
  assert.equal(run('is-enrolled').status, 1);
});
test('monitor quota opt-in backs up and merges HUD config without changing settings or launcher', t => {
  const { dir, configDir, run } = setup(t); run('init-agent');
  const hudDir = path.join(configDir, 'plugins', 'claude-hud'); fs.mkdirSync(hudDir, { recursive: true });
  const original = { layout: 'compact', display: { showTools: true, externalUsagePath: '/some/read-only-file.json' } };
  fs.writeFileSync(path.join(hudDir, 'config.json'), JSON.stringify(original));
  const settings = '{"statusLine":{"command":"UNCHANGED_HUD_COMMAND"}}';
  fs.writeFileSync(path.join(configDir, 'settings.json'), settings);
  assert.equal(run('enable-quota').status, 0);
  const config = JSON.parse(fs.readFileSync(path.join(hudDir, 'config.json')));
  assert.equal(config.layout, 'compact'); assert.equal(config.display.showTools, true);
  assert.equal(config.display.externalUsagePath, original.display.externalUsagePath);
  assert.equal(config.display.externalUsageWritePath, path.join(dir, 'quota.json'));
  assert.equal(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'), settings);
  const backup = fs.readdirSync(hudDir).find(f => f.includes('monitor-backup'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(hudDir, backup))), original);
});
test('monitor quota opt-in refuses invalid existing config without replacing it', t => {
  const { configDir, run } = setup(t); run('init-agent');
  const hudDir = path.join(configDir, 'plugins', 'claude-hud'); fs.mkdirSync(hudDir, { recursive: true });
  const hud = path.join(hudDir, 'config.json'); fs.writeFileSync(hud, '{malformed');
  assert.equal(run('enable-quota').status, 1); assert.equal(fs.readFileSync(hud, 'utf8'), '{malformed');
});
test('monitor systemd units preserve literal paths and configure private automatic restart', () => {
  const unit = serviceUnit('agent', '/tmp/private path/$metrics/%data', '/repo/monitor/cli.ts', '/usr/bin/node');
  assert.match(unit, /ExecStart=.*"\/tmp\/private path\/\$\$metrics\/%%data\/agent.json"/);
  assert.match(unit, /ReadWritePaths="\/tmp\/private path\/\$metrics\/%%data"/);
  assert.match(unit, /Restart=on-failure/); assert.match(unit, /UMask=0077/);
  assert.match(unit, /WantedBy=default.target/); assert.throws(() => serviceUnit('agent', '/tmp/\ninvalid', '/cli'));
});
