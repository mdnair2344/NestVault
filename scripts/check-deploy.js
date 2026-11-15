#!/usr/bin/env node
'use strict';
const base = (process.argv[2] || process.env.APP_URL || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) { console.error('Usage: EDITOR_CODE=<editor access password> npm run check:deploy -- https://your-app.vercel.app'); process.exit(2); }
if (!process.env.EDITOR_CODE) { console.error('Set EDITOR_CODE to the editor access password of the deployment: the check registers a temporary editor and a temporary viewer.'); process.exit(2); }
const results = []; let failed = 0;
const check = async (name, fn) => { try { results.push(['PASS', name, (await fn()) || '']); } catch (e) { failed++; results.push(['FAIL', name, e.message]); } };
const ok = (c, m) => { if (!c) throw Error(m); };
async function call(p, { m = 'GET', json, tok } = {}) {
  const r = await fetch(base + p, { method: m, headers: { ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
  return { status: r.status, json: j, headers: r.headers, text: t };
}
(async () => {
  const email = `smoke${Date.now()}@example.com`, pw = 'smoketest-' + Math.random().toString(36).slice(2, 10) + '1';
  let tok = '', viewer = '';
  await check('Public HTTPS URL', () => { ok(base.startsWith('https://') || /^http:\/\/localhost/.test(base), 'URL is not https'); return base.startsWith('https://') ? 'https' : 'localhost (http is fine locally)'; });
  await check('Front end is served', async () => { const r = await call('/'); ok(r.status === 200 && /NestVault/.test(r.text), 'status ' + r.status); return 'index.html'; });
  await check('Security headers', async () => { const r = await call('/'); for (const h of ['content-security-policy', 'x-frame-options', 'x-content-type-options']) ok(r.headers.get(h), 'missing ' + h); return 'CSP, X-Frame-Options, nosniff'; });
  await check('Health check /health', async () => { const r = await call('/health'); ok(r.status === 200 && r.json && r.json.ok, 'status ' + r.status); return `database ${r.json.dbMs} ms`; });
  await check('Status report /api/status', async () => { const r = await call('/api/status'); ok(r.status === 200 && r.json.database.ok, 'database not ok'); return `${r.json.platform.name}, replica set ${r.json.database.replicaSet}, ${r.json.database.members} member(s), availability ${r.json.availability24h.upPct == null ? 'n/a yet' : r.json.availability24h.upPct + '%'}`; });
  await check('Sign up', async () => { const r = await call('/api/signup', { m: 'POST', json: { email, name: 'Smoke Test', role: 'editor', code: process.env.EDITOR_CODE, phone: '9000000000', org: 'Deployment check', password: pw, confirm: pw } }); ok(r.status === 200 && r.json.token, 'status ' + r.status + ' ' + (r.json && r.json.error)); tok = r.json.token; return 'role ' + r.json.user.role; });
  await check('Sign in', async () => { const r = await call('/api/login', { m: 'POST', json: { email, password: pw } }); ok(r.status === 200 && r.json.token, 'status ' + r.status); tok = r.json.token; });
  await check('Create and pull a record (cloud sync)', async () => {
    const w = await call('/api/sync', { m: 'POST', tok, json: { changes: [{ id: 'smoke1', base: 0, rev: 1, fields: { title: 'Deployment smoke test' } }], since: 0, epoch: null } });
    ok(w.status === 200 && w.json.records.some(r => r.id === 'smoke1'), 'status ' + w.status + ' ' + (w.json && w.json.error)); return 'record stored in the cloud database';
  });
  await check('Editor cannot use the admin API (RBAC)', async () => { const r = await call('/api/admin/users', { tok }); ok(r.status === 403, 'expected 403, got ' + r.status); return '403 Administrator role required'; });
  await check('Viewer is read-only (RBAC)', async () => {
    const vm = `smokev${Date.now()}@example.com`, d = await call('/api/signup', { m: 'POST', json: { email: vm, name: 'Smoke Viewer', role: 'viewer', phone: '9000000000', org: 'Deployment check', password: pw, confirm: pw } }); ok(d.status === 200 && d.json.token, 'viewer sign-up failed: ' + d.status); viewer = d.json.token;
    const w = await call('/api/backups', { m: 'POST', tok: viewer, json: {} }); ok(w.status === 403, 'viewer write returned ' + w.status); return 'viewer write refused with 403';
  });
  await check('Live updates stream (SSE)', async () => {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 8000);
    try { const r = await fetch(base + '/api/stream', { headers: { Authorization: 'Bearer ' + tok }, signal: ac.signal }); ok(r.status === 200, 'status ' + r.status);
      const rd = r.body.getReader(); let buf = ''; const dec = new TextDecoder();
      while (!/event: hello/.test(buf)) { const x = await rd.read(); if (x.done) break; buf += dec.decode(x.value); }
      ok(/event: hello/.test(buf), 'no hello event'); return 'stream opened, hello event received'; } finally { clearTimeout(t); ac.abort(); }
  });
  await check('Cron endpoint is protected', async () => { const r = await call('/api/cron/tick'); ok(r.status === 401 || r.status === 403, 'expected 401/403, got ' + r.status); return 'refuses requests without the secret'; });
  await check('Sign out', async () => { const r = await call('/api/logout', { m: 'POST', tok }); ok(r.status === 200, 'status ' + r.status); });
  const w = Math.max(...results.map(r => r[1].length));
  console.log('\nNestVault deployment check: ' + base + '\n');
  for (const [s, n, d] of results) console.log(`  ${s}  ${n.padEnd(w)}  ${d}`);
  console.log(`\n${results.length - failed} of ${results.length} checks passed.${failed ? '' : ' The deployment is working.'}\n`);
  process.exit(failed ? 1 : 0);
})();