#!/usr/bin/env bash
set -euo pipefail
monitor_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo 'Install Node.js >=22.18 (LTS recommended) from https://nodejs.org then rerun this command.' >&2
  exit 1
fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22 || (a===22 && b<18)) process.exit(1)' || {
  echo 'Node.js >=22.18 is required.' >&2; exit 1;
}
exec node "$monitor_root/monitor/setup-linux.ts" "$@"
