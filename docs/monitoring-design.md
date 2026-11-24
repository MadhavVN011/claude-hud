# Monitoring audit and design

## Audit (2026-11-24)

The initial working tree was clean (HEAD `24602c1`). The repository is an ESM Node
22.18+ plugin with erasable TypeScript, no runtime dependencies and no build.
`hud.mjs` starts the permission-limited logic in `src/main.ts`; `collector.mjs`
owns fixed subprocess probes and filesystem grants. `fence.mjs` prevents network
access by the HUD logic. The committed `dist/index.js` and `src/index.ts` are
launcher compatibility stubs. Installation writes Claude Code's statusLine
command through `install.mjs`; plugin updates retain that launcher.

The HUD receives model/context/cost/prompt-cache/rate_limits from stdin. Its
incremental transcript parser derives tool/agent/task/todo activity and per-message
token maxima. Configuration, git/jj probes, authentication display, renderers,
local cost ledgers, command workflows, translations, snapshots and sandbox
verification are existing upstream features. They remain independent of monitoring.
There are no usage collection hooks to replace. The plugin runs as a status line.

`src/external-usage.ts` and `collector.mjs` already export stdin rate limits via
`display.externalUsageWritePath`, without credentials or a network request.
This is the quota bridge. [Anthropic's status-line documentation](https://code.claude.com/docs/en/statusline)
documents five_hour/seven_day used_percentage and reset times; windows may be
absent independently. These are account-wide observations, never derived from
transcript token counts. A snapshot is not proof of current server-side quota:
the dashboard displays its source, observation age, and freshness explicitly.

Sanitized repository fixtures and structural inspection of local JSONL files
confirmed assistant/message/usage, sessionId, timestamp, message.id, requestId,
uuid, cwd, model, cache_creation and extra unknown fields. Unknown fields are
ignored. The parser accepts only assistant usage records, handles cache creation
breakdowns as a fallback, and skips ambiguous ID-less or timestamp-less records
with diagnostics rather than inventing totals. Nested subagent JSONL is included
and grouped under the parent session where directory structure establishes it.

Baseline: 459 tests, 454 pass, 5 skip, 0 failures on Node 26.13.0. Existing
owner verification and CI were inspected; the monitoring code lives outside
`src/` so it neither widens the cage nor changes its architecture diagram.

## Modules

- `monitor/config.ts`, `protocol.ts`: validated config, wire schema and privacy boundary.
- `monitor/parser.ts`: tolerant pure transcript adapter and stable identifiers.
- `monitor/collector.ts`: incremental file cursors, SQLite outbox, retries, heartbeat.
- `monitor/store.ts`: migrations, credentials, idempotency, SQL analytics and exports.
- `monitor/server.ts`: bounded authenticated LAN HTTP API, static dashboard, logging.
- `monitor/cli.ts`: init, enrollment, server/collector execution and quota bridge setup.
- `monitor/web/`: responsive self-hosted HTML/CSS/JS, authenticated fetch, SVG charts.
- `scripts/monitor-*`: Linux user systemd and Windows scheduled-task installers.

No cloud service, Python, dependency installation, or HUD rebuild is required.
Server and collector run independently with private config files. A storage
class owns all database queries so a future PostgreSQL adapter can preserve the
HTTP protocol and collector without changing HUD logic.

## API

`GET /health` is an anonymous minimal liveness check. Every other API requires
a bearer token. Dashboard/admin access uses a distinct random administrator token.
The browser retains it in memory only and sends it in request headers.

| Endpoint | Credential | Behavior |
| --- | --- | --- |
| POST /api/enrollments | admin | Pre-create a named never-connected device and one-use expiring enrollment token |
| POST /api/register | enrollment | Bind persistent UUID and exchange enrollment for revocable agent credential |
| POST /api/heartbeat | device | Update availability, local metrics, diagnostics and heartbeat |
| POST /api/usage | device | Atomically upsert absolute message counters and synchronization history |
| GET /api/devices | admin | Status, heartbeat, sync time, version, availability |
| GET /api/devices/:id | admin | Details and bounded synchronization history |
| PATCH /api/devices/:id | admin | Rename or revoke |
| DELETE /api/devices/:id | admin | Archive and revoke; retain usage and history |
| GET /api/analytics | admin | Windows, totals, device/model/project/session and hourly/daily aggregates |
| GET /api/quota | admin | Freshest supported snapshot independently per quota window |
| GET /api/export | admin | Filtered events/model/daily summaries in JSON or CSV |

Date filters are ISO timestamps, UTC, with inclusive start and exclusive end.
The rolling five-hour window is activity in the past five hours; it is not a
claim about the subscription's billing window. Active session means a recorded
assistant event within the configurable activity timeout on an online device.

## Database and synchronization

Both databases use numbered transactional migrations, foreign keys, WAL and a
busy timeout. Central tables: devices, enrollments, events, syncs, quotas.
Local tables: metadata (persistent UUID/credential), files (offset/signature),
outbox (absolute per-message maxima and dirty flag). Parsing and file checkpoints
commit together. Acknowledgement clears dirty rows only after a successful
response; a lost response replays safely. Deleted/truncated transcripts never
delete already measured usage. Content is never persisted to the outbox.

Event identity is SHA-256 of the session and assistant message ID (request ID
fallback). Raw identifiers, cwd, project folders and file paths stay local.
Project identities are hashed; optional local aliases are explicitly configured.
The server gives a globally unique event to its first reporting device. Same-device
retries merge per-counter maxima; another device cannot modify the event. Copied
transcripts generate duplicate diagnostics, not duplicated totals. This cannot
prove physical origin for a copied history; first reporter attribution is explicit.
Restoring a collector database preserves its device identity. Do not clone it to
another machine. Enrollment is recoverable after a lost response using the same
device UUID and enrollment token until expiry.

Read cursors validate file identity and a bounded prefix; rewrites trigger replay.
Incomplete trailing lines remain unread until newline completion. Overlong or
malformed records are skipped with counts. The outbox survives host downtime and
retries with bounded exponential backoff and jitter. Heartbeats run independently
of upload backlog, with configurable intervals and offline timeout.

## Security and validation

Loopback binding is the safe default. Explicit LAN binding accepts only private,
loopback or link-local addresses and filters remote addresses. Bearer credentials
are random, server-side SHA-256 hashes; enrollment secrets expire. Request bodies,
batch sizes, metadata and diagnostics are bounded and strictly allowlisted.
Only fixed diagnostic codes cross the network. Queries use bound values, grouping
names are allowlisted, CORS is same-origin, headers restrict framing/scripts,
and logs contain event/status/error codes, never request bodies or tokens.
HTTP offers no encryption; trusted LAN firewall rules and an HTTPS reverse proxy
or private Tailscale address are documented deployment options.

Verification covers pure parsing, incremental spool/restarts/partial writes,
multiple simulated devices, authentication/revocation/limits, window boundaries,
exports, restart persistence, quota staleness and existing HUD regression tests.
Native Windows startup and real multi-machine networking require manual checks.
