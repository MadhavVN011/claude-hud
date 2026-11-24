import path from 'node:path';
import { hash, total } from './protocol.ts';
import type { UsageEvent, ErrorCode } from './protocol.ts';

const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const id = (v: unknown): string | null => typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : null;
const count = (v: unknown): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 1e12 ? v : 0;

// Do not decode Claude's lossy project-directory encoding into a fabricated path.
export function fileContext(relative: string): { session: string; project: string } {
  const parts = relative.replace(/\\/g, '/').split('/');
  const subagent = parts.indexOf('subagents');
  return { session: subagent >= 2 ? parts[subagent - 1] : path.posix.basename(parts.at(-1) ?? '', '.jsonl'),
    project: parts[0] ?? 'unknown' };
}
export function projectId(cwd: string): string {
  // Windows drive/UNC paths are case insensitive even when tested on Linux.
  const normalized = /^[a-z]:[\\/]|^\\\\/i.test(cwd)
    ? path.win32.normalize(cwd).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
    : path.posix.normalize(cwd).replace(/\/$/, '');
  return hash('project:' + normalized);
}
export function parseLine(line: string, relative: string, aliases: Record<string, string> = {}, now = Date.now()):
  { event?: UsageEvent; error?: ErrorCode } {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return { error: 'malformed_records' }; }
  const r = record(raw);
  if (!r || r.type !== 'assistant') return {};
  const message = record(r.message);
  const usage = record(message?.usage);
  if (!message || !usage || message.model === '<synthetic>') return {};
  const context = fileContext(relative);
  const messageId = id(message.id) ?? id(r.requestId);
  const sessionId = relative.replace(/\\/g, '/').includes('/subagents/')
    ? context.session : id(r.sessionId) ?? context.session;
  const at = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
  if (!messageId || !sessionId || !Number.isFinite(at) || at < Date.UTC(2020, 0) || at > now + 300_000) {
    return { error: 'unsupported_records' };
  }
  const creation = record(usage.cache_creation);
  const project = typeof r.cwd === 'string' && r.cwd ? projectId(r.cwd) : hash('project-dir:' + context.project);
  const model = typeof message.model === 'string' && /^[\w.:@/+-]{1,128}$/.test(message.model) ? message.model : 'Unknown';
  const event: UsageEvent = {
    id: hash(JSON.stringify(['event', sessionId, messageId])), session: hash('session:' + sessionId),
    project, projectLabel: aliases[project] ?? `project-${project.slice(0, 8)}`, model, at,
    input: count(usage.input_tokens), output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheCreation: usage.cache_creation_input_tokens == null
      ? count(creation?.ephemeral_5m_input_tokens) + count(creation?.ephemeral_1h_input_tokens)
      : count(usage.cache_creation_input_tokens),
  };
  if (event.cacheCreation > 1e12) return { error: 'unsupported_records' };
  // All-zero streaming placeholders do not create phantom sessions.
  if (!total(event)) return {};
  return { event };
}
