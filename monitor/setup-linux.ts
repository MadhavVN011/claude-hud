import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { main } from './cli.ts';
import { defaultDir, readConfig, serverConfig, agentConfig } from './config.ts';
import { Collector } from './collector.ts';
import { serviceUnit } from './service.ts';

const { values } = parseArgs({ options: { host: { type: 'string', default: '127.0.0.1' },
  port: { type: 'string', default: '8787' }, dir: { type: 'string', default: defaultDir() },
  name: { type: 'string', default: os.hostname() }, server: { type: 'string' },
  'agent-only': { type: 'boolean', default: false }, uninstall: { type: 'boolean', default: false } } });
const dir = path.resolve(values.dir!), units = path.join(os.homedir(), '.config', 'systemd', 'user');
const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
function systemctl(...args: string[]) {
  const result = spawnSync('systemctl', ['--user', ...args], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('systemd_user_failed');
}
function quote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
function installUnit(role: 'server' | 'agent'): void {
  fs.mkdirSync(units, { recursive: true });
  fs.writeFileSync(path.join(units, `claude-hud-monitor-${role}.service`), serviceUnit(role, dir, cli), { mode: 0o600 });
}
async function setup() {
  if (process.platform !== 'linux') throw new Error('linux_required');
  if (values.uninstall) {
    for (const role of values['agent-only'] ? ['agent'] : ['server', 'agent']) {
      if (fs.existsSync(path.join(units, `claude-hud-monitor-${role}.service`))) {
        systemctl('disable', '--now', `claude-hud-monitor-${role}.service`);
        fs.unlinkSync(path.join(units, `claude-hud-monitor-${role}.service`));
      }
    }
    systemctl('daemon-reload'); console.log('Services removed. Configuration and historical data retained in ' + dir); return;
  }
  if (!values['agent-only']) {
    if (!fs.existsSync(path.join(dir, 'server.json'))) await main(['init-server', '--dir', dir, '--host', values.host!, '--port', values.port!]);
    installUnit('server'); systemctl('daemon-reload'); systemctl('enable', '--now', 'claude-hud-monitor-server.service');
    systemctl('restart', 'claude-hud-monitor-server.service');
  }
  const hostConfig = !values['agent-only'] ? serverConfig(readConfig(path.join(dir, 'server.json'))) : null;
  const agentHost = hostConfig?.host === '0.0.0.0' ? '127.0.0.1' : hostConfig?.host;
  const server = values.server ?? (hostConfig ? `http://${agentHost?.includes(':') ? '[' + agentHost + ']' : agentHost}:${hostConfig.port}` : 'http://127.0.0.1:8787');
  if (!fs.existsSync(path.join(dir, 'agent.json'))) await main(['init-agent', '--dir', dir, '--server', server, '--name', values.name!]);
  const config = agentConfig(readConfig(path.join(dir, 'agent.json')));
  const collector = new Collector(config); const enrolled = Boolean(collector.get('token')); collector.close();
  if (!enrolled) {
    if (!values['agent-only']) {
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try { ready = (await fetch(config.server + '/health', { signal: AbortSignal.timeout(1000) })).ok; } catch { /* wait for startup */ }
        if (ready) break;
        await delay(200);
      }
      if (!ready) throw new Error('server_not_ready');
      await main(['enroll-local', '--dir', dir]);
    } else await main(['enroll', '--dir', dir]);
  }
  installUnit('agent'); systemctl('daemon-reload'); systemctl('enable', '--now', 'claude-hud-monitor-agent.service');
  systemctl('restart', 'claude-hud-monitor-agent.service');
  console.log('Monitoring installed. Config: ' + dir);
  console.log('Enable startup before login: sudo loginctl enable-linger ' + os.userInfo().username);
  if (hostConfig) console.log('Retrieve your dashboard token: node monitor/cli.ts admin-token --dir ' + quote(dir));
  console.log('Native quota bridge is opt-in: node monitor/cli.ts enable-quota --dir ' + quote(dir));
}
void setup().catch(() => { console.error('Installation failed. Check Node >=22.18, systemctl --user, configuration, enrollment and journalctl --user -u claude-hud-monitor-server. Existing data is retained.'); process.exitCode = 1; });
