# Claude HUD

A Claude Code plugin that shows what's happening: context usage, rate limits, active tools, running agents, and todo progress, always visible below your input.

This edition also includes an **optional LAN monitoring server and multi-device
dashboard**. Keep the terminal HUD as it is, and compare recorded token activity
from Linux, Windows, and macOS collectors in one private dashboard. SQLite keeps
history; shared subscription quota comes only from native Claude Code rate-limit
observations, separately from device activity. No cloud account or new runtime
dependencies are required.

See the [monitoring setup guide](docs/monitoring.md) for Linux host installation,
Windows collectors, automatic startup, security, exports, and limitations, and
the [audit and architecture](docs/monitoring-design.md) for implementation details.

[![License](https://img.shields.io/github/license/jarrodwatts/claude-hud?v=2)](LICENSE)
[![Stars](https://img.shields.io/github/stars/jarrodwatts/claude-hud)](https://github.com/jarrodwatts/claude-hud/stargazers)

![Claude HUD in action](claude-hud-preview-5-2.png)

> 🌐 English | [中文文档](README.zh.md)

## Install

Inside Claude Code, run:

```
/plugin marketplace add jarrodwatts/claude-hud
/plugin install claude-hud
/reload-plugins
/hud
```

`/hud` checks your setup and points your status line at the HUD, after asking you. It needs Node.js 22.18 or later; if yours is older, `/hud` finds a newer one on your machine or helps you install one.

<details>
<summary><strong>Prefer the terminal?</strong></summary>

```bash
claude plugin marketplace add jarrodwatts/claude-hud
claude plugin install claude-hud@claude-hud
```

Then run `/reload-plugins` and `/hud` inside a session.

</details>

**Updates:** Claude Code doesn't auto-update third-party plugins by default. To turn it on, run `/plugin`, open **Marketplaces**, select **claude-hud**, and choose **Enable auto-update**. Or update by hand with `claude plugin marketplace update claude-hud` and `claude plugin update claude-hud@claude-hud`, then `/reload-plugins`. You don't need to set it up again.

## What You See

The default is two lines:

```
[Opus] │ my-project git:(main*)
Context █████░░░░░ 45% │ Usage ██░░░░░░░░ 25% (resets in 1h 30m)
```

- **Line 1**: model, a provider label when one is detected (`Bedrock`, `Vertex`, `MiniMax`), project path, and git branch.
- **Line 2**: context used (green, then yellow, then red as it fills) and your subscriber rate limits.

Optional lines include tools, agents and todos, plus about a hundred other options:

```
◐ Edit: auth.ts | ✓ Read ×3 | ✓ Grep ×2        ← tools
◐ explore [haiku]: Finding auth code (2m 15s)    ← agents
▸ Fix authentication bug (2/5)                   ← todos
```

## Change It, Fix It, Report It

Ask Claude, or type `/hud` and say what you want: "show tool activity", "use the compact layout", "the HUD is blank", "the context bar looks wrong". Claude looks up the options, shows you a preview, and saves the change once you approve it. `/hud` also undoes the last change, replays the last real render to explain what you see, and, for a real bug, writes a scrubbed report that you read in full before anything is filed.

Settings live in `~/.claude/plugins/claude-hud/config.json` (under `$CLAUDE_CONFIG_DIR` if set). To turn the HUD off for one session, start Claude Code with `CLAUDE_HUD_DISABLE=1`.

## Multi-device dashboard

From this checkout, with Node.js 22.18 or later:

```bash
# Linux host: install server + local collector as user systemd services.
bash scripts/monitor-linux.sh --host 0.0.0.0 --name Linux-Desktop
# Enable the user services to start before login after a reboot.
sudo loginctl enable-linger "$USER"
# Retrieve the administrator token privately for dashboard login.
node monitor/cli.ts admin-token
```

Open `http://LINUX_HOST_IP:8787`, sign in, then create separate device enrollments
in Management. On each Windows machine, from its checkout:

```powershell
& .\scripts\monitor-windows.ps1 -Server 'http://LINUX_HOST_IP:8787' -Name 'Windows-Laptop'
```

Enter that device's enrollment token at the hidden prompt. The Windows installer
creates a task that starts the collector at login and restarts it after failure.
Use a second enrollment and `-Name 'Windows-PC'` on another computer. Keep the
checkout at a stable path. Firewall access should be restricted to your LAN.

Shared quota is initially **Unavailable**. On a machine running the existing HUD,
opt into its native snapshot bridge:

```bash
node monitor/cli.ts enable-quota
```

This backs up and merges the HUD configuration's `externalUsageWritePath`. It
preserves all other HUD settings. Start an active Claude Code subscriber session
to produce a snapshot. Metrics upload every 30 seconds by default; quota
observations expire after five minutes or at their reset time. HTTP is
unencrypted: use only a trusted LAN, or add HTTPS/private Tailscale access as
described in the [full guide](docs/monitoring.md).

## Security

The HUD's logic runs in a locked-down Node process. Node's permission model blocks it from starting programs, reading your credentials, and writing anywhere but its own data folder. An import fence keeps Node's network modules and globals out of its reach; that fence blocks every way out found so far, and is tested against each one on every change. A small separate file runs the fixed `git`, `jj` and memory commands it needs. The HUD reads Claude Code's stdin, the session transcript, Claude config files, and git or jj metadata for the current directory, and calls no undocumented APIs.

`--extra-cmd` runs a shell command on every refresh and puts its output on the first line. It is ignored unless `CLAUDE_HUD_ALLOW_EXTRA_CMD=1` is set in the HUD's environment. Treat it as arbitrary code execution and never use a command from an untrusted source.

## Requirements

- Claude Code v2.1.260 or later
- Node.js 22.18 or later (Bun can start the HUD, which then runs on Node)

## Development

```bash
git clone https://github.com/jarrodwatts/claude-hud
cd claude-hud
npm ci && npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=jarrodwatts/claude-hud&type=Date)](https://star-history.com/#jarrodwatts/claude-hud&Date)
