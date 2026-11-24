import path from 'node:path';

function quote(value: string, command = false): string {
  if (/[\r\n\x00]/.test(value)) throw new Error('invalid_service_path');
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  return '"' + (command ? escaped.replace(/\$/g, () => '$$') : escaped) + '"';
}
export function serviceUnit(role: 'server' | 'agent', dir: string, cli: string, node = process.execPath): string {
  return `[Unit]
Description=Claude HUD monitoring ${role}
After=network.target

[Service]
Type=simple
ExecStart=${[node, cli, role, '--config', path.join(dir, role + '.json')].map(arg => quote(arg, true)).join(' ')}
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${quote(dir)}

[Install]
WantedBy=default.target
`;
}
