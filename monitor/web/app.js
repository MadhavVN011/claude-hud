'use strict';
const $ = id => document.getElementById(id);
const number = n => new Intl.NumberFormat().format(n ?? 0);
const compact = n => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n ?? 0);
const date = n => n ? new Date(n).toLocaleString() : 'Never';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fields = ['input', 'output', 'cacheCreation', 'cacheRead'];
let token = '', devices = [], current = null, loading = false, refreshQueued = false, generation = 0;
let detailId = null;

async function api(endpoint, options = {}) {
  const response = await fetch(endpoint, { ...options, headers: { Authorization: 'Bearer ' + token,
    ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, cache: 'no-store' });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) lock();
    throw new Error(data.error ?? `Request failed (${response.status})`);
  }
  return response;
}
function showError(error) { $('app-error').textContent = error.message; $('app-error').hidden = false; }
function lock() {
  token = ''; generation++; $('workspace').hidden = true; $('login').hidden = false;
  $('enrollment-token').value = ''; $('enrollment-result').hidden = true;
  $('admin-token').value = ''; current = null;
}
function params() {
  const p = new URLSearchParams();
  const now = Date.now(), window = $('window').value;
  const durations = { '5h': 18_000_000, '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000 };
  if (durations[window]) p.set('from', new Date(now - durations[window]).toISOString());
  if (window === 'custom') {
    const from = $('from').value, to = $('to').value;
    if (!from || !to || Date.parse(from + 'Z') >= Date.parse(to + 'Z')) throw new Error('Choose a valid UTC start and end date.');
    p.set('from', new Date(from + 'Z').toISOString()); p.set('to', new Date(to + 'Z').toISOString());
  }
  if (detailId || $('device-filter').value) p.set('device', detailId ?? $('device-filter').value);
  return p;
}
const metric = (label, value, note = '') => `<div class="stat"><div class="stat-label">${escape(label)}</div><div class="stat-number">${number(value)}</div><div class="stat-note">${escape(note)}</div></div>`;
function quotas(data) {
  $('quota-windows').innerHTML = [['fiveHour', 'Five-hour allowance'], ['sevenDay', 'Seven-day allowance']].map(([key, label]) => {
    const w = data[key];
    return `<article class="quota-window"><h3>${label}</h3>${w
      ? `<div class="quota-value">${number(w.used)}%<span>used · ${number(w.remaining)}% remaining</span></div><svg class="quota-meter" viewBox="0 0 100 4" preserveAspectRatio="none" role="img" aria-label="${w.used}% used"><rect class="track" width="100" height="4" rx="2"/><rect width="${w.used}" height="4" rx="2"/></svg><p>Resets ${w.resetAt ? escape(date(w.resetAt)) : 'Unavailable'}</p><p>Observed ${escape(date(w.observedAt))} · ${escape(w.deviceName)}</p>`
      : '<div class="quota-value">Unavailable</div><p>No fresh native observation for this window.</p>'}</article>`;
  }).join('');
  $('quota-note').textContent = `Account-wide observations from the Claude Code status line. Latest quota sync: ${date(data.lastSync)}. Freshness limit: ${Math.round(data.freshnessMs / 60_000)} minutes. Local token totals never determine this allowance.`;
}
function renderOverview(data) {
  const t = data.totals;
  const connected = devices.filter(d => ['online', 'error'].includes(d.status)).length;
  $('stats').innerHTML = [metric('Total recorded tokens', t.total, 'Selected activity window'),
    metric('Input tokens', t.input, 'Fresh input'), metric('Output tokens', t.output, 'Generated output'),
    metric('Cache read tokens', t.cacheRead, 'Previously cached input'), metric('Cache creation tokens', t.cacheCreation, 'Newly cached input'),
    metric('Connected devices', connected, `${devices.filter(d => !d.archived).length} configured`),
    metric('Active sessions', data.activeSessions, 'Recent activity on online devices'), metric('Recorded sessions', t.sessions, 'Sessions with measured tokens')].join('');
  $('activity-windows').innerHTML = [['fiveHour', 'Last 5 hours'], ['day', 'Last 24 hours'], ['sevenDay', 'Last 7 days'], ['thirtyDay', 'Last 30 days'], ['all', 'All recorded history']]
    .map(([key, label]) => `<span>${label}<strong>${number(data.windows[key].total)}</strong></span>`).join('');
  $('range-caption').textContent = $('window').selectedOptions[0].textContent;
  $('fleet-status').textContent = `${connected} connected · ${devices.filter(d => d.status === 'offline').length} offline`;
}
const find = (rows, id) => rows.find(r => r.key === id) ?? {};
function renderDevices(data) {
  const selected = $('device-filter').value;
  const visible = devices.filter(d => (!d.archived || d.id === selected) && (!selected || d.id === selected));
  $('device-cards').innerHTML = visible.length ? visible.map(d => {
    const t = find(data.devices, d.id);
    const active = find(data.activeByDevice, d.id);
    return `<a class="device-card" href="#device/${d.id}" aria-label="View ${escape(d.name)} analytics"><div class="card-head"><h3>${escape(d.name)}</h3><span class="status status-${d.status}">${d.status.replace('-', ' ')}</span></div><div class="device-os">${escape(d.os ?? 'Awaiting connection')} · ${escape(d.hostname ?? 'No hostname yet')}</div><div class="device-total">${compact(t.total)}<small>recorded tokens</small></div><div class="device-metrics"><div>Input<strong>${number(t.input)}</strong></div><div>Output<strong>${number(t.output)}</strong></div><div>Last 5 hours<strong>${number(find(data.fiveHourByDevice, d.id).total)}</strong></div><div>Last 7 days<strong>${number(find(data.sevenDayByDevice, d.id).total)}</strong></div></div><div class="device-foot">${number(active.count)} active sessions<br>Last sync ${escape(date(d.last_sync))}</div></a>`;
  }).join('') : '<div class="empty">No devices connected yet. Open Management to enroll your Linux host and Windows collectors.</div>';
}
function empty(target) { $(target).innerHTML = '<div class="empty">No recorded activity in this range.<br>Connected collectors will populate this chart.</div>'; }
function bars(target, rows, label, selected = fields) {
  if (!rows.length || !rows.some(r => selected.reduce((n, key) => n + (r[key] ?? 0), 0))) return empty(target);
  const shown = [...rows].sort((a, b) => selected.reduce((n, k) => n + (b[k] ?? 0) - (a[k] ?? 0), 0)).slice(0, 12);
  const sum = r => selected.reduce((n, k) => n + (r[k] ?? 0), 0);
  const max = Math.max(...shown.map(sum), 1), width = 560, height = shown.length * 46 + 10;
  const chart = shown.map((r, i) => {
    let x = 170; const y = i * 46 + 6;
    const rects = selected.map(key => {
      const w = (r[key] ?? 0) / max * 300, rect = `<rect class="${key}" x="${x}" y="${y + 15}" width="${w}" height="12"><title>${escape(key)}: ${number(r[key])}</title></rect>`;
      x += w; return rect;
    }).join('');
    const full = String(label(r));
    return `<g><title>${escape(full)} · ${number(sum(r))} tokens</title><text x="0" y="${y + 24}">${escape(full.length > 23 ? full.slice(0, 22) + '…' : full)}</text>${rects}<text x="485" y="${y + 25}">${compact(sum(r))}</text></g>`;
  }).join('');
  $(target).innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape($(target).parentElement.querySelector('h3').textContent)}">${chart}</svg>`;
}
function timeline(target, rows, hourly = false) {
  if (!rows.length || !rows.some(r => r.total > 0)) return empty(target);
  // Combine adjacent buckets when necessary to preserve all charted activity on a small screen.
  const size = Math.max(1, Math.ceil(rows.length / 60)), shown = [];
  for (let i = 0; i < rows.length; i += size) {
    const bucket = { key: rows[i].key, end: rows[Math.min(i + size - 1, rows.length - 1)].key, total: 0 };
    for (const k of fields) bucket[k] = 0;
    for (const r of rows.slice(i, i + size)) for (const k of [...fields, 'total']) bucket[k] += r[k];
    shown.push(bucket);
  }
  const width = 920, height = 250, max = Math.max(...shown.map(r => r.total), 1), step = 830 / shown.length;
  let svg = [0, .5, 1].map(f => `<line class="grid" x1="65" x2="905" y1="${215 - f * 190}" y2="${215 - f * 190}"/><text x="0" y="${219 - f * 190}">${compact(max * f)}</text>`).join('');
  svg += shown.map((r, i) => {
    const x = 70 + i * step; let y = 215;
    let rects = fields.map(k => { const h = r[k] / max * 190; y -= h;
      return `<rect class="${k}" x="${x}" y="${y}" width="${Math.max(1, step * .7)}" height="${h}"/>`; }).join('');
    const stamp = new Date(Number(r.key)).toISOString();
    rects = `<g><title>${stamp}${r.end !== r.key ? ' to ' + new Date(Number(r.end)).toISOString() : ''} · ${number(r.total)} tokens</title>${rects}</g>`;
    if (i % Math.max(1, Math.ceil(shown.length / 6)) === 0) rects += `<text x="${x}" y="240">${hourly ? stamp.slice(5, 16).replace('T', ' ') : stamp.slice(5, 10)}</text>`;
    return rects;
  }).join('');
  $(target).innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape($(target).parentElement.querySelector('h3').textContent)}">${svg}</svg>`;
}
function renderCharts(data) {
  const deviceName = r => devices.find(d => d.id === r.key)?.name ?? r.key;
  timeline('daily-chart', data.daily); timeline('hourly-chart', data.hourly, true);
  timeline('five-hour-chart', data.fiveHourTimeline, true); timeline('seven-day-chart', data.sevenDayTimeline);
  bars('comparison-chart', data.devices, deviceName); bars('io-chart', data.devices, deviceName, ['input', 'output']);
  bars('cache-chart', data.devices, deviceName, ['cacheCreation', 'cacheRead']);
  bars('model-chart', data.models, r => r.key, ['total']); bars('project-chart', data.projects, r => r.label, ['total']);
  $('sessions').innerHTML = data.sessions.length ? data.sessions.map(r => `<tr><td><code title="${r.key}">${r.key.slice(0, 12)}</code></td>${[...fields, 'total'].map(k => `<td>${number(r[k])}</td>`).join('')}<td>${escape(date(r.lastActivity))}</td></tr>`).join('') : '<tr><td colspan="7">No recorded sessions in this range.</td></tr>';
}
function renderManagement() {
  $('management-devices').innerHTML = devices.map(d => `<article class="panel manage-card"><div><h3>${escape(d.name)} <span class="status status-${d.status}">${d.status.replace('-', ' ')}</span></h3><p>${escape(d.os ?? 'Unknown OS')} · Heartbeat ${escape(date(d.heartbeat))} · Collector ${escape(d.version ?? 'Unavailable')}</p><p>Diagnostics: ${escape(Object.entries(d.errors).filter(([, n]) => n).map(([k, n]) => k + ': ' + n).join(', ') || 'None reported')}</p></div><div class="manage-actions"><a class="subtle" href="#device/${d.id}">Details</a><button class="subtle" data-action="rename" data-id="${d.id}">Rename</button>${!d.revoked ? `<button class="subtle" data-action="revoke" data-id="${d.id}">Revoke</button>` : ''}${!d.archived ? `<button class="subtle" data-action="archive" data-id="${d.id}">Remove</button>` : ''}</div></article>`).join('') || '<div class="empty">Create an enrollment to add your first device.</div>';
}
async function renderDetail(id) {
  const d = await (await api('/api/devices/' + encodeURIComponent(id))).json();
  if (detailId !== id) return;
  $('detail-title').textContent = d.name;
  $('device-details').innerHTML = `<dl class="detail-grid">${[['Device ID', d.id], ['Hostname', d.hostname ?? 'Unavailable'], ['Operating system', d.os ?? 'Unavailable'], ['Collector version', d.version ?? 'Unavailable'], ['Last heartbeat', date(d.heartbeat)], ['Last synchronization', date(d.last_sync)], ['Claude executable detected', d.claude_available ? 'Yes' : 'No'], ['Claude data detected', d.data_available ? 'Yes' : 'No'], ['Locally recorded events', number(d.local_events)], ['Locally recorded tokens', number(d.local_tokens)]]
    .map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl><p class="footnote">The local total includes any copied records subsequently ignored by the server. Executable and data detection do not imply that a Claude process is running.</p>`;
  $('sync-history').innerHTML = d.history.length ? d.history.map(s => `<tr><td>${escape(date(s.at))}</td><td>${number(s.received)}</td><td>${number(s.duplicates)}</td><td>${escape(s.errors)}</td></tr>`).join('') : '<tr><td colspan="4">No successful synchronization yet.</td></tr>';
}
async function refresh() {
  if (!token) return;
  if (loading) { refreshQueued = true; return; }
  loading = true; const own = generation;
  $('refresh').disabled = true;
  try {
    const query = params();
    const [fleet, analytics, quota] = await Promise.all(['/api/devices', '/api/analytics?' + query, '/api/quota'].map(async url => (await api(url)).json()));
    if (own !== generation || !token) return;
    devices = fleet; current = analytics;
    const selected = detailId ?? $('device-filter').value;
    const options = '<option value="">All devices</option>' + devices.map(d => `<option value="${d.id}">${escape(d.name)}${d.archived ? ' (archived)' : ''}</option>`).join('');
    if ($('device-filter').innerHTML !== options) { $('device-filter').innerHTML = options; $('device-filter').value = selected; }
    renderOverview(analytics); renderDevices(analytics); renderCharts(analytics); quotas(quota); renderManagement();
    if (detailId) await renderDetail(detailId);
    $('updated').textContent = 'Updated ' + new Date(analytics.at).toLocaleTimeString(); $('app-error').hidden = true;
  } catch (error) { if (token) showError(error); }
  finally {
    loading = false; $('refresh').disabled = false;
    if (refreshQueued) { refreshQueued = false; if (token) void refresh(); }
  }
}
function route() {
  const hash = location.hash.slice(1) || 'overview';
  const match = /^device\/([a-f0-9-]{36})$/.exec(hash);
  detailId = match?.[1] ?? null;
  const page = detailId ? 'detail' : ['overview', 'devices', 'analytics', 'manage'].includes(hash) ? hash : 'overview';
  const sections = { 'quota-section': ['overview'], 'overview-section': ['overview', 'detail'], 'devices-section': ['overview', 'devices'],
    'detail-section': ['detail'], 'analytics-section': ['overview', 'analytics', 'detail'], 'manage-section': ['manage'] };
  for (const [id, pages] of Object.entries(sections)) $(id).hidden = !pages.includes(page);
  document.querySelector('.toolbar').hidden = page === 'manage';
  document.querySelectorAll('[data-route]').forEach(a => a.classList.toggle('active', a.dataset.route === (page === 'detail' ? 'devices' : page)));
  $('page-title').textContent = { overview: 'Usage overview', devices: 'Your connected devices', analytics: 'Usage analytics', manage: 'Device management', detail: 'Device analytics' }[page];
  if (detailId && devices.some(d => d.id === detailId)) $('device-filter').value = detailId;
  else if (page === 'devices' && $('device-filter').value) $('device-filter').value = '';
  if (token) void refresh();
}
$('login-form').addEventListener('submit', async e => {
  e.preventDefault(); token = $('admin-token').value.trim(); $('login-error').textContent = '';
  try { await api('/api/devices'); $('admin-token').value = ''; $('login').hidden = true; $('workspace').hidden = false; route(); }
  catch (error) { token = ''; $('login-error').textContent = error.message === 'invalid_admin_credential' ? 'The administrator token was not accepted.' : error.message; }
});
$('logout').addEventListener('click', lock);
$('refresh').addEventListener('click', () => void refresh());
$('device-filter').addEventListener('change', () => {
  if (detailId) location.hash = $('device-filter').value ? 'device/' + $('device-filter').value : 'analytics';
  else void refresh();
});
$('window').addEventListener('change', () => { $('custom-range').hidden = $('window').value !== 'custom'; if ($('window').value !== 'custom') void refresh(); });
$('apply-range').addEventListener('click', () => void refresh());
window.addEventListener('hashchange', route);
$('enroll-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const result = await (await api('/api/enrollments', { method: 'POST', body: JSON.stringify({ name: $('new-device-name').value }) })).json();
    $('enrollment-token').value = result.enrollment; $('enrollment-expiry').textContent = 'Expires ' + date(result.expires) + '. Enter this token at the collector enrollment prompt. Keep it private.';
    $('enrollment-result').hidden = false; await refresh();
  } catch (error) { showError(error); }
});
$('management-devices').addEventListener('click', async e => {
  const button = e.target.closest('button[data-action]'); if (!button) return;
  const { action, id } = button.dataset, d = devices.find(d => d.id === id);
  try {
    if (action === 'rename') {
      const name = prompt('New device name', d.name); if (!name) return;
      await api('/api/devices/' + id, { method: 'PATCH', body: JSON.stringify({ name }) });
    } else {
      if (!confirm(`${action === 'archive' ? 'Remove' : 'Revoke'} ${d.name}? Its collector will lose access. Historical usage will be retained.`)) return;
      await api('/api/devices/' + id, action === 'archive' ? { method: 'DELETE' } : { method: 'PATCH', body: JSON.stringify({ revoke: true }) });
    }
    await refresh();
  } catch (error) { showError(error); }
});
document.querySelectorAll('[data-export]').forEach(button => button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    const query = params(); query.set('format', button.dataset.export); query.set('group', $('export-group').value);
    const response = await api('/api/export?' + query);
    const blob = await response.blob(), url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = `claude-usage-${query.get('group')}.${query.get('format')}`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { showError(error); }
  finally { button.disabled = false; }
}));
setInterval(() => { if (!document.hidden) void refresh(); }, 10_000);
route();
