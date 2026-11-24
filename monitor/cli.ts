import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { secret, VERSION } from './protocol.ts';
import { agentConfig, serverConfig, readConfig, writePrivate, defaultDir } from './config.ts';
import { Collector } from './collector.ts';
import { createMonitorServer, logger } from './server.ts';

async function readSecret(): Promise<string> {
  if (!process.stdin.isTTY) {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk.toString(); if (input.length > 1024) throw new Error('secret_too_large');
    }
    return input.trim();
  }
  process.stderr.write('Enrollment token (hidden): ');
  process.stdin.setRawMode(true); process.stdin.resume();
  return await new Promise((resolve, reject) => {
    let value = '';
    const end = () => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); process.stderr.write('\n'); };
    const onData = (chunk: Buffer) => {
      for (const c of chunk.toString()) {
        if (c === '\u0003') { end(); reject(new Error('cancelled')); return; }
        if (c === '\r' || c === '\n') { end(); resolve(value.trim()); return; }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else if (/[A-Za-z0-9_-]/.test(c)) value += c;
        if (value.length > 256) { end(); reject(new Error('secret_too_large')); return; }
      }
    };
    process.stdin.on('data', onData);
  });
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  const { values } = parseArgs({ args: argv.slice(1), options: {
    dir: { type: 'string', default: defaultDir() }, config: { type: 'string' },
    host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '8787' },
    server: { type: 'string' }, name: { type: 'string' },
  }, strict: true });
  const dir = path.resolve(values.dir!), defaultFile = (name: string) => path.join(dir, name + '.json');
  if (command === 'init-server') {
    const config = serverConfig({ host: values.host, port: Number(values.port), database: path.join(dir, 'server.sqlite'), adminToken: secret() });
    writePrivate(values.config ?? defaultFile('server'), config);
    logger({ event: 'server_config_created', config: values.config ?? defaultFile('server'), version: VERSION });
    return;
  }
  if (command === 'init-agent') {
    const config = agentConfig({ server: values.server ?? 'http://127.0.0.1:8787', name: values.name ?? os.hostname(),
      projects: path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects'),
      database: path.join(dir, 'collector.sqlite'), quotaPath: path.join(dir, 'quota.json') });
    writePrivate(values.config ?? defaultFile('agent'), config);
    logger({ event: 'agent_config_created', config: values.config ?? defaultFile('agent') });
    return;
  }
  if (command === 'admin-token') {
    // Explicit human retrieval, separate from structured service logs. Never use this in a service unit.
    process.stdout.write(serverConfig(readConfig(values.config ?? defaultFile('server'))).adminToken + '\n');
    return;
  }
  if (command === 'server') {
    const config = serverConfig(readConfig(values.config ?? defaultFile('server')));
    const app = createMonitorServer(config);
    app.server.listen(config.port, config.host); await once(app.server, 'listening');
    logger({ event: 'server_listening', host: config.host, port: config.port });
    let stopping = false;
    const stop = () => {
      if (stopping) return; stopping = true;
      void app.close().then(() => logger({ event: 'server_stopped' })).catch(() => { process.exitCode = 1; });
    };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    return;
  }
  if (['agent', 'once', 'enroll', 'enroll-local', 'is-enrolled', 'enable-quota'].includes(command)) {
    const config = agentConfig(readConfig(values.config ?? defaultFile('agent')));
    if (command === 'enable-quota') {
      if (!config.quotaPath) throw new Error('quota_path_required');
      fs.mkdirSync(path.dirname(config.quotaPath), { recursive: true, mode: 0o700 });
      const root = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
      const hud = path.join(root, 'plugins', 'claude-hud', 'config.json');
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(hud)) {
        existing = readConfig(hud) as Record<string, unknown>;
        if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('invalid_hud_config');
        fs.copyFileSync(hud, hud + `.monitor-backup-${Date.now()}`);
      }
      const display = existing.display;
      if (display !== undefined && (!display || typeof display !== 'object' || Array.isArray(display))) throw new Error('invalid_hud_display');
      const next = { ...existing, display: { ...display as object, externalUsageWritePath: config.quotaPath } };
      fs.mkdirSync(path.dirname(hud), { recursive: true, mode: 0o700 });
      const temp = hud + `.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, hud);
      logger({ event: 'quota_bridge_enabled', config: hud });
      return;
    }
    const collector = new Collector(config);
    try {
      if (command === 'is-enrolled') { process.exitCode = collector.get('token') ? 0 : 1; return; }
      if (command === 'enroll') { await collector.enroll(await readSecret()); logger({ event: 'device_enrolled', device: collector.deviceId }); return; }
      if (command === 'enroll-local') {
        const hostConfig = serverConfig(readConfig(defaultFile('server')));
        const response = await fetch(config.server + '/api/enrollments', { method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + hostConfig.adminToken },
          body: JSON.stringify({ name: config.name }), signal: AbortSignal.timeout(10_000), redirect: 'error' });
        if (!response.ok) throw new Error('local_enrollment_failed');
        const result = await response.json() as { enrollment: string };
        await collector.enroll(result.enrollment); logger({ event: 'device_enrolled', device: collector.deviceId }); return;
      }
      if (command === 'once') { await collector.scan(); await collector.sync(); logger({ event: 'collector_synced', device: collector.deviceId }); return; }
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try { await collector.run(controller.signal, logger); }
      finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    } finally { collector.close(); }
    return;
  }
  process.stdout.write(`Claude HUD Monitor ${VERSION}\n\nCommands: init-server, init-agent, server, agent, once, enroll, enroll-local, is-enrolled, enable-quota, admin-token\nOptions: --dir PATH, --config PATH, --host LAN_IP, --port PORT, --server URL, --name NAME\nSee docs/monitoring.md for installation and security.\n`);
  if (command && command !== 'help') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // Do not expose filesystem paths, fetch errors, or request headers through arbitrary exceptions.
  void main().catch(() => { logger({ event: 'command_failed', code: 'check_config_credentials_and_connectivity' }); process.exitCode = 1; });
}
