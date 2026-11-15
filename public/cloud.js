'use strict';
(function () {
  const ROLE = { admin: 'Administrator', editor: 'Editor', viewer: 'Viewer' };
  const el = id => document.getElementById(id);

  /* ---------------- roles ---------------- */
  function applyRole(role) {
    S.role = role; if (S.user) S.user.role = role;
    document.body.classList.remove('role-admin', 'role-editor', 'role-viewer'); document.body.classList.add('role-' + role);
    const b = el('roleBadge'); if (b) { b.textContent = ROLE[role] || role; b.className = 'badge r-' + role; }
    const a = el('navAdmin'); if (a) a.hidden = role !== 'admin';
    const n = el('roleNote'); if (n) n.hidden = role !== 'viewer';
    if (role !== 'admin' && S.view === 'admin') go('dashboard');
  }
  const guardWrite = name => { const f = window[name]; if (typeof f !== 'function' || f.__guarded) return; const g = async (...a) => { if (S.role === 'viewer') { toast('Viewer accounts are read-only', 'err'); return false; } return f(...a); }; g.__guarded = true; window[name] = g; };
  guardWrite('saveLocal'); guardWrite('deleteLocal');

  window.cloudEnter = function (user) {
    applyRole((user && user.role) || 'editor');
    api('/api/me').then(m => { const r = (m.user && m.user.role) || m.role || 'editor'; if (r !== S.role) { applyRole(r); saveSess(); render(); } }).catch(() => {});
    startStream();
  };
  window.cloudLeave = function () {
    stopStream(); S.role = null; document.body.classList.remove('role-admin', 'role-editor', 'role-viewer');
    for (const id of ['roleBadge', 'live']) { const e = el(id); if (e) { e.textContent = ''; e.className = ''; } }
    const n = el('roleNote'); if (n) n.hidden = true; const a = el('navAdmin'); if (a) a.hidden = true;
  };

  /* ---------------- real-time updates (SSE over fetch) ---------------- */
  let ctl = null, running = false, wake = null, deb = null;
  const setLive = (t, c) => { const e = el('live'); if (e) { e.textContent = t; e.className = c || ''; e.title = 'Real-time updates from the cloud'; } };
  const nap = ms => new Promise(r => { wake = r; setTimeout(r, ms); });
  function stopStream() { running = false; if (ctl) ctl.abort(); if (wake) wake(); }
  async function startStream() {
    if (running) return; running = true; let wait = 1000;
    while (running && S.token) {
      if (S.net === 'offline') { setLive('○ Offline', 'off'); await nap(1500); continue; }
      ctl = new AbortController();
      try {
        const r = await fetch('/api/stream', { headers: { Authorization: 'Bearer ' + S.token }, signal: ctl.signal });
        if (r.status === 401) { const ok = await refreshTok(); if (ok) continue; if (ok === false) break; throw Error('unreachable'); }
        if (!r.ok || !r.body) throw Error('stream ' + r.status);
        setLive('● Live', 'good'); wait = 1000;
        const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
        for (;;) {
          const { value, done } = await rd.read(); if (done) break;
          buf += dec.decode(value, { stream: true }); let i;
          while ((i = buf.indexOf('\n\n')) >= 0) { onEvent(buf.slice(0, i)); buf = buf.slice(i + 2); }
        }
        wait = 300;
      } catch (e) { wait = Math.min(wait * 1.6, 15000); }
      if (!running || !S.token) break;
      if (S.net !== 'offline') setLive('○ Reconnecting', 'pend');
      await nap(wait);
    }
    running = false; setLive('', '');
  }
  function onEvent(block) {
    let ev = 'message', data = '';
    for (const l of block.split('\n')) { if (l.startsWith('event:')) ev = l.slice(6).trim(); else if (l.startsWith('data:')) data += l.slice(5).trim(); }
    let j = {}; try { j = JSON.parse(data || '{}'); } catch { /* ignore */ }
    if (ev === 'hello' && j.role && j.role !== S.role) { applyRole(j.role); saveSess(); render(); }
    else if (ev === 'change') { clearTimeout(deb); deb = setTimeout(() => onChange(j), 250); }
    else if (ev === 'bye' && j.reason === 'account') api('/api/me').catch(() => {});
  }
  function onChange(j) {
    const e = el('live'); if (e) { e.classList.add('pulse'); setTimeout(() => e.classList.remove('pulse'), 900); }
    if (S.auto && S.net !== 'offline') sync(true).then(() => { if (S.view === 'shared') render(); }).catch(() => {});
    else if (S.view === 'shared') render();
  }

    /* ---------------- real network detection (replaces the old Online / Slow / Offline switch) ---------------- */
  const conn = () => navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const rtts = []; let lastEvt = 0, probing = false, ntimer = null;
  function classify(reachable, rtt) {
    if (!navigator.onLine || !reachable) return 'offline';
    const c = conn(); if (c && ['slow-2g', '2g'].includes(c.effectiveType)) return 'slow';
    if (rtt != null) { rtts.push(rtt); if (rtts.length > 3) rtts.shift(); const avg = rtts.reduce((a, b) => a + b, 0) / rtts.length; return avg > (S.net === 'slow' ? 1500 : 2500) ? 'slow' : 'online'; }
    return S.net === 'slow' ? 'slow' : 'online';
  }
  function setNet(n) {
    const prev = S.net; if (n === prev) return; S.net = n;
    if (n === 'slow' && !S.budget) { S.budget = 10; S.autoBudget = 1; } else if (n !== 'slow' && S.autoBudget) { S.budget = 0; S.autoBudget = 0; }
    badge();
    if (n === 'offline') { toast('You are offline. Changes are saved on this device and will sync later.', 'err'); if (ctl) ctl.abort(); setLive('○ Offline', 'off'); }
    else if (prev === 'offline') { if (Date.now() - lastEvt > 2000) toast('Connection restored'); if (wake) wake(); if (S.token && S.auto) { S.retry = { n: 0, at: 0 }; sync(true); } }
    if (n === 'slow') toast('Slow connection detected. The most important changes are sent first.');
    if (S.token && !['records', 'vault'].includes(S.view)) render();
  }
  async function probeNet() {
    if (probing) return; probing = true; const t0 = performance.now(); let ok = false, rtt = null;
    try { const ac = new AbortController(), to = setTimeout(() => ac.abort(), 8000); const r = await fetch('/api/config?_=' + Date.now(), { cache: 'no-store', signal: ac.signal }); clearTimeout(to); ok = r.status < 500; rtt = performance.now() - t0; } catch { ok = false; }
    probing = false; setNet(classify(ok, rtt));
  }
  const netLoop = () => { clearTimeout(ntimer); ntimer = setTimeout(async () => { await probeNet(); netLoop(); }, S.net === 'offline' ? 4000 : 15000); };
  addEventListener('online', () => { lastEvt = Date.now(); probeNet(); netLoop(); });
  addEventListener('offline', () => { lastEvt = Date.now(); setNet('offline'); netLoop(); });
  if (conn() && conn().addEventListener) conn().addEventListener('change', () => probeNet());
  setNet(navigator.onLine ? 'online' : 'offline'); probeNet(); netLoop();

  /* ---------------- admin console ---------------- */
  const roleSel = (u, self) => (self || u.pending) ? `<span class="badge r-${u.role}">${ROLE[u.role]}</span>` : `<select data-adm-role data-id="${u.id}">${['admin', 'editor', 'viewer'].map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${ROLE[r]}</option>`).join('')}</select>`;
  const evMsg = e => { const d = e.detail || {}; return h(d.msg || d.title || d.what || d.name || d.device || ''); };
  V.admin = async () => {
    if (S.role !== 'admin') return '<div class="note warn">Administrator role required.</div>';
    let ov, us, sh; try { [ov, us, sh] = await Promise.all([api('/api/admin/overview'), api('/api/admin/users'), api('/api/admin/shares')]); } catch (e) { return fail(e); }
    const U = ov.users, D = ov.data, Sv = ov.server;
    return `<h2>Administration</h2><p class="mut">Manage users and access, and watch the whole system. Every rule here is enforced by the server.</p>${offNote()}
    <h3>System overview</h3>
    <dl><dt>Users</dt><dd>${U.total} (${U.admin} administrator, ${U.editor} editor, ${U.viewer} viewer${U.disabled ? ', ' + U.disabled + ' disabled' : ''})</dd>
    <dt>Records / vault files</dt><dd>${D.records} / ${D.vaultFiles}</dd><dt>Backups / open conflicts</dt><dd>${D.backups} / ${D.openConflicts}</dd>
    <dt>Active sessions / shares</dt><dd>${D.activeSessions} / ${D.shares}</dd><dt>Live connections</dt><dd>${Sv.liveStreams}</dd>
    <dt>Requests (5xx)</dt><dd>${Sv.requests} (${Sv.errors5xx}), average ${Sv.avgMs} ms, 95th percentile ${Sv.p95Ms} ms</dd>
    <dt>Hosting</dt><dd>${h(Sv.platform.name)}${Sv.platform.region ? ', ' + h(Sv.platform.region) : ''}</dd></dl>
    ${U.pendingAdmins ? `<div class="note warn"><b>${U.pendingAdmins}</b> administrator account(s) are waiting for approval. A new administrator cannot sign in until another administrator approves.</div>` : ''}
    <h3>Users (${us.length})</h3>
    <table><tr><th>User</th><th>Role</th><th class="hide-s">Records</th><th>Status</th><th></th></tr>${us.map(u => { const self = u.id === S.user.id; return `<tr><td><b>${h(u.name)}</b>${self ? ' (you)' : ''}<br><span class="mut">${h(u.email)}${u.phone ? ' &middot; ' + h(u.phone) : ''}${u.org ? ' &middot; ' + h(u.org) : ''}</span></td><td>${roleSel(u, self)}</td><td class="hide-s">${u.records}</td><td>${u.pending ? '<span class="pend">awaiting approval</span>' : u.disabled ? '<span class="bad">disabled</span>' : '<span class="good">active</span>'}</td><td class="act">${self ? '' : u.pending ? `<button class="primary" data-act="admok" data-id="${u.id}">Approve</button> <button class="danger" data-act="admno" data-id="${u.id}">Reject</button>` : `<button data-act="admdis" data-id="${u.id}" data-off="${u.disabled ? 0 : 1}" class="${u.disabled ? '' : 'danger'}">${u.disabled ? 'Enable' : 'Disable'}</button>`}</td></tr>`; }).join('')}</table>
    <h3>Create an account</h3>
    <p class="mut">Only administrators create accounts here and change roles. People who register as administrator on the sign-up page appear above as "awaiting approval".</p>
    <form id="admform" class="box"><div class="row"><label class="grow">Full name<input name="name" required minlength="2" maxlength="60"></label><label class="grow">Email<input name="email" type="email" required></label></div>
    <div class="row"><label class="grow">Mobile number<input name="phone" type="tel" required pattern="\+?[0-9][0-9 \-]{6,14}"></label><label class="grow">Organisation, health centre or village<input name="org" required minlength="2" maxlength="80"></label></div>
    <div class="row"><label class="grow">Role<select name="role"><option value="editor">Editor</option><option value="viewer">Viewer</option><option value="admin">Administrator</option></select></label><label class="grow">Temporary password<input name="password" type="password" placeholder="10+ characters, letters and numbers" required autocomplete="new-password"></label></div>
    <button class="primary">Create account</button></form>
    <h3>Shared access (${sh.length})</h3>
    ${sh.length ? `<table><tr><th>Record</th><th>Owner</th><th>Shared with</th><th>Access</th><th></th></tr>${sh.map(s => `<tr><td>${h(s.record)}</td><td>${h(s.owner)}</td><td>${h(s.with)}</td><td>${h(s.perm)}</td><td class="act"><button class="danger" data-act="admrevoke" data-id="${s.id}">Revoke</button></td></tr>`).join('')}</table>` : '<p class="mut">No records are shared.</p>'}
    <h3>Recent activity (all users)</h3><div style="max-height:320px;overflow:auto">${ov.recent.map(e => `<div class="ev"><time>${ago(e.ts)}</time><span><b>${h(e.user)}</b> ${h(e.kind)} ${evMsg(e)}</span></div>`).join('') || '<p class="mut">Nothing yet.</p>'}</div>`;
  };
  Object.assign(act, {
    admdis: async d => { if (d.off === '1' && !confirm('Disable this account? The user is signed out on every device.')) return; try { await post(`/api/admin/users/${d.id}/disable`, { disabled: d.off === '1' }); toast(d.off === '1' ? 'Account disabled' : 'Account enabled'); render(); } catch (e) { toast(e.message, 'err'); } },
    admok: async d => { try { await post(`/api/admin/users/${d.id}/approve`, {}); toast('Administrator approved. They can sign in now.'); render(); } catch (e) { toast(e.message, 'err'); } },
    admno: async d => { if (!confirm('Reject and delete this administrator request?')) return; try { await post(`/api/admin/users/${d.id}/reject`, {}); toast('Request rejected'); render(); } catch (e) { toast(e.message, 'err'); } },
    admrevoke: async d => { if (!confirm('Revoke this share?')) return; try { await api('/api/admin/shares/' + d.id, { method: 'DELETE' }); toast('Share revoked'); render(); } catch (e) { toast(e.message, 'err'); } }
  });
  document.addEventListener('change', async e => {
    const t = e.target; if (!t.hasAttribute || !t.hasAttribute('data-adm-role')) return;
    try { const j = await post(`/api/admin/users/${t.dataset.id}/role`, { role: t.value }); toast('Role changed to ' + ROLE[j.role]); if (t.dataset.id === S.user.id) { applyRole(j.role); } render(); } catch (x) { toast(x.message, 'err'); render(); }
  });
  document.addEventListener('submit', async e => {
    if (e.target.id !== 'admform') return; e.preventDefault();
    try { await post('/api/admin/users', Object.fromEntries(new FormData(e.target))); toast('Account created'); render(); } catch (x) { toast(x.message, 'err'); }
  });

  /* ---------------- extra sections on existing screens ---------------- */
  const roleBox = r => `<h3>Your role</h3><p>You are signed in as <span class="badge r-${h(r.role)}">${h(ROLE[r.role] || r.role)}</span>. The server checks this on every request.</p>
    <table><tr><th>What you can do</th><th>Admin</th><th>Editor</th><th>Viewer</th></tr>${r.matrix.map(m => `<tr><td>${h(m.action)}</td>${['admin', 'editor', 'viewer'].map(k => `<td class="${m[k] ? 'good' : 'mut'}">${m[k] ? 'yes' : '-'}</td>`).join('')}</tr>`).join('')}</table>`;
  const _account = V.account;
  V.account = async () => { const base = await _account(); try { return base + roleBox(await api('/api/roles')); } catch { return base; } };

  const haBox = s => {
    const d = s.database, b = s.backupStore, a = s.availability24h, p = s.platform;
    return `<h3>High availability</h3>
    <p class="${s.ok ? 'good' : 'bad'}"><b>${s.ok ? 'All systems operational' : 'Degraded: a component is not responding'}</b></p>
    <dl><dt>Hosting</dt><dd>${h(p.name)}${p.region ? ', ' + h(p.region) : ''}${p.serverless ? ' (stateless functions, scale out automatically)' : ''}</dd>
    <dt>Database</dt><dd>${d.ok ? `<span class="good">up</span>, ${d.ms} ms, replica set <code>${h(d.replicaSet)}</code>, ${d.members} member(s), primary <code>${h(d.primary || '?')}</code>` : '<span class="bad">unreachable</span>'}</dd>
    <dt>Backup store</dt><dd>${b.ok ? '<span class="good">up</span>' : '<span class="bad">unreachable</span>'} (${b.separate ? 'separate cluster' : 'same cluster'})</dd>
    <dt>Availability (24 h)</dt><dd>${a.upPct == null ? 'collecting samples (needs a health check every few minutes)' : a.upPct + ' % from ' + a.samples + ' health samples'}</dd>
    <dt>Live connections</dt><dd>${s.liveStreams}</dd></dl>
    <p class="mut">How the service stays available: stateless servers on a managed platform, a replicated database with automatic primary election (retryable reads and writes, primary-preferred reads), a <code>/health</code> endpoint for monitors, backups on a separate cluster, and an offline-first browser that keeps working and syncs when the cloud is back.
    <a href="/status.html" target="_blank" rel="noopener">Open the public status page</a></p>`;
  };
  const _infra = V.infra;
  V.infra = async () => { const base = await _infra(); try { return base + haBox(await api('/api/status')); } catch { return base; } };

  /* ---------------- start-up ---------------- */
  if (S.user && S.token) window.cloudEnter(S.user);
})();