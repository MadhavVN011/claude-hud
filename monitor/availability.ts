import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Probe only file presence/permissions. Never execute a program found through an untrusted PATH.
export function claudeAvailable(env = process.env, home = os.homedir(), platform = process.platform): boolean {
  const p = platform === 'win32' ? path.win32 : path;
  const directories = (env.PATH ?? '').split(platform === 'win32' ? ';' : ':').filter(dir => p.isAbsolute(dir));
  directories.push(p.join(home, '.local', 'bin'));
  if (platform === 'win32' && env.APPDATA) directories.push(p.join(env.APPDATA, 'npm'));
  const names = platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude'];
  for (const dir of directories) for (const name of names) {
    try {
      const file = p.join(dir, name);
      if (!fs.statSync(file).isFile()) continue;
      fs.accessSync(file, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return true;
    } catch { /* not installed at this candidate */ }
  }
  return false;
}
