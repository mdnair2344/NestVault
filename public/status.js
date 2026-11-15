'use strict';
document.documentElement.dataset.theme = localStorage.nvTheme || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
const $ = id => document.getElementById(id);
const cell = (tr, t, cls) => { const td = tr.insertCell(); if (cls) { const d = document.createElement('span'); d.className = 'dot ' + cls; td.append(d); } td.append(t); return td; };
const row = (name, ok, text, detail) => { const tr = $('rows').insertRow(); cell(tr, name); cell(tr, text, ok ? 'ok' : 'bad'); cell(tr, detail || ''); };
const dur = s => s < 90 ? s + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : (s / 3600).toFixed(1) + ' h';
async function load() {
  let s = null;
  try { const r = await fetch('/api/status', { cache: 'no-store' }); s = await r.json(); } catch { /* unreachable */ }
  const rows = $('rows'), meta = $('meta'); rows.textContent = ''; meta.textContent = '';
  const b = $('banner');
  if (!s) { b.className = 'note bad'; b.textContent = 'The service is not responding.'; row('Web app and API', false, 'down', 'No answer from the server'); }
  else {
    b.className = 'note ' + (s.ok ? 'ok' : 'warn'); b.textContent = s.ok ? 'All systems operational.' : 'Some components are degraded.';
    row('Web app and API', true, 'operational', 'Up for ' + dur(s.uptimeS));
    row('Database (MongoDB Atlas)', s.database.ok, s.database.ok ? 'operational' : 'down', s.database.ok ? s.database.ms + ' ms, replica set ' + s.database.replicaSet + ', ' + s.database.members + ' member(s)' : 'Unreachable');
    row('Backup store', s.backupStore.ok, s.backupStore.ok ? 'operational' : 'down', s.backupStore.separate ? 'Separate cluster' : 'Same cluster as the database');
    const a = s.availability24h, add = (k, v) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; meta.append(dt, dd); };
    add('Availability (24 h)', a.upPct == null ? 'collecting samples' : a.upPct + ' % (' + a.samples + ' samples)');
    add('Hosting', s.platform.name + (s.platform.region ? ', ' + s.platform.region : ''));
    add('Live connections', String(s.liveStreams));
  }
  $('checked').textContent = 'Last checked ' + new Date().toLocaleTimeString();
}
load(); setInterval(load, 10000);