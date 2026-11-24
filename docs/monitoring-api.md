# Monitoring HTTP API v1

The protocol is implemented by `monitor/protocol.ts`; unknown object keys are
rejected. Agents and administrators use `Authorization: Bearer TOKEN`, never
URL parameters. POST/PATCH bodies require `Content-Type: application/json`.
All responses are JSON except static assets and CSV exports. No cross-origin
API access is enabled. The default body limit is 1 MiB, event batches are capped
at 1,000 (the collector sends 500), and per-IP requests default to 240/minute.
Times are epoch milliseconds on the wire except ISO date query parameters.

| Method and path | Authorization | Request / result |
| --- | --- | --- |
| GET /health | none | Minimal status and monitoring version |
| POST /api/enrollments | admin | `{ "name": "Windows-Laptop" }` returns pending `id`, one-use `enrollment`, and `expires` |
| POST /api/register | enrollment | `{ "deviceId": UUIDv4, "status": STATUS }` returns `deviceId`, device `token` |
| POST /api/heartbeat | device | `{ "status": STATUS }` updates heartbeat |
| POST /api/usage | device | `{ "events": [EVENT], "status": STATUS, "quota": QUOTA_OR_NULL }` returns accepted/duplicates counts and server time |
| GET /api/devices | admin | Devices including offline/never-connected/error/revoked/archived status, no credentials |
| GET /api/devices/:id | admin | Device details plus latest 100 successful sync results |
| PATCH /api/devices/:id | admin | `{ "name": "Workstation" }` and/or `{ "revoke": true }`; revocation is irreversible |
| DELETE /api/devices/:id | admin | Archive, revoke, retain history |
| GET /api/analytics | admin | Event-time aggregates and independent rolling windows |
| GET /api/quota | admin | Native observations per window or null; observation/upload timestamps and provenance |
| GET /api/export | admin | Streaming event, daily or model aggregates |

Enrollment registration can repeat for the same UUID and enrollment token until
expiry, allowing recovery from a lost reply. It cannot be reassigned to another
UUID, and revoked devices cannot use the old enrollment to regain access.

`STATUS` fields are `hostname`, `os`, `version`, `claudeAvailable` (executable
presence), `dataAvailable` (projects directory presence), `localEvents`,
`localTokens`, `errors` (allowlisted diagnostic counts).
Status errors accept only `projects_missing`, `scan_failed`, `read_failed`,
`malformed_records`, `unsupported_records`, `oversized_records`, `quota_invalid`,
`quota_unreadable`, `sync_failed`. Arbitrary error strings cannot be uploaded.

`EVENT` fields are `id`, `session`, `project` (64 lowercase hex SHA-256 digests),
`projectLabel`, `model`, `at`, `input`, `output`, `cacheCreation`, `cacheRead`.
Counters must be nonnegative safe integers no larger than 10^12 per category;
event time must be between 2020 and five minutes ahead of server time. The
server derives device identity from the credential, never a body field. Same
device/event replays merge per-counter maxima and earliest observed event time;
another device's copies are acknowledged as ignored duplicates.

`QUOTA` has `source: "claude-code-statusline"`, `at`, `fiveHour`, `sevenDay`.
Each window is null or `{ "used": PERCENT, "resetAt": EPOCH_MS_OR_NULL }`.
Percentage is validated in [0,100], never computed from activity. Credentialed
collectors are trusted to preserve local snapshot provenance; this is not an
account authentication assertion. Returned null means the metric is unavailable.

Analytics/export filters: `device=UUID`, `from=ISO_UTC`, `to=ISO_UTC`, with
inclusive `from` and exclusive `to`. Default is all observed history through now.
Rolling windows in analytics always refer to current event time, independent
of the selected custom range. Export adds `group=events|model|daily` and
`format=json|csv`. UTC daily/hourly keys are epoch bucket starts.

Device details/sync results include copied-record counts; no failure request body
or authentication token is retained in logs. Request validation happens before
transactional batch ingestion; a malformed event rejects the whole batch. A
successful response is the only acknowledgement. HTTP errors use fixed codes:
400 invalid input, 401 credential error, 403 disallowed origin/network, 404 unknown
resource, 409 identity conflict, 413 body size, 415 content type, 429 rate limit,
500 internal error. Clients should retain pending metrics on every failure.
