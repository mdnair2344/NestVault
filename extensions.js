'use strict';
// Admin API, live updates (SSE), status/availability, cron function, paginated records.
const rbac = require('./rbac');

module.exports = function (x) {
  const { R, C, B, bad, ev, nid, E, bus, M, newUser, pwOk, emailRe, profile, approvedAdmins, alert, recOut, tick, SERVERLESS } = x;

  /* ---------- 1. roles and administration ---------- */
  R('GET', '/api/roles', ({ u }) => ({ role: u.role, roles: rbac.ROLES, matrix: rbac.MATRIX }));

  const pubUser = (d, n) => ({
    id: d._id, email: d.email, name: d.name, role: rbac.roleOf(d), disabled: !!d.disabled,
    verified: !!d.verified, created: d.created || 0, records: n, phone: d.phone || '', org: d.org || '', pending: !!d.pending
  });

  R('GET', '/api/admin/overview', async () => {
    const now = Date.now(), cnt = (c, f) => c.countDocuments(f);
    const total = await cnt(C('users'), {}), admins = await cnt(C('users'), { role: 'admin' }),
      viewers = await cnt(C('users'), { role: 'viewer' }), disabled = await cnt(C('users'), { disabled: 1 }), pendingAdmins = await cnt(C('users'), { pending: 1 });
    const evs = await C('events').find({}).sort({ ts: -1 }).limit(25).toArray(), names = new Map(), recent = [];
    for (const e of evs) {
      if (!names.has(e.user_id)) { const d = await C('users').findOne({ _id: e.user_id }); names.set(e.user_id, d ? d.email : '(deleted user)'); }
      recent.push({ ts: e.ts, kind: e.kind, user: names.get(e.user_id), detail: e.detail || {} });
    }
    const l = [...M.lat].sort((a, b) => a - b);
    return {
      users: { total, admin: admins, editor: Math.max(0, total - admins - viewers), viewer: viewers, disabled, pendingAdmins },
      data: {
        records: await cnt(C('records'), { deleted: 0 }), vaultFiles: await cnt(C('vault'), { deleted: 0 }),
        backups: await cnt(B('backups'), {}), openConflicts: await cnt(C('conflicts'), { status: 'open' }),
        shares: await cnt(C('shares'), {}), activeSessions: await cnt(C('sessions'), { revoked: 0, expires: { $gt: now } })
      },
      server: {
        uptimeS: Math.round((now - M.start) / 1000), requests: M.n, errors5xx: M.err,
        avgMs: l.length ? Math.round(l.reduce((a, v) => a + v, 0) / l.length) : 0,
        p95Ms: l.length ? l[Math.floor(l.length * .95)] : 0, liveStreams: streams.n, platform: platform()
      },
      recent
    };
  });

  R('GET', '/api/admin/users', async () => {
    const list = await C('users').find({}).sort({ created: -1 }).limit(200).toArray(), out = [];
    for (const d of list) out.push(pubUser(d, await C('records').countDocuments({ user_id: d._id, deleted: 0 })));
    return out;
  });

  /* Administrators create accounts and change roles here (every /api/admin/ path is admin-only in rbac.denyReason).
     A person who REGISTERS as administrator stays pending, and cannot sign in, until another administrator approves. */
  R('POST', '/api/admin/users', async ({ u, b }) => {
    const p = profile(b), pw = String(b.password || ''), role = String(b.role || '');
    if (!rbac.ROLES.includes(role)) throw bad(400, 'Choose a role');
    if (!pwOk(pw)) throw bad(400, 'Password needs 10+ characters with letters and numbers');
    const nu = newUser(p.email, p.name, pw, role); nu.phone = p.phone; nu.org = p.org; nu.verified = 1;
    try { await C('users').insertOne(nu); } catch (e) { if (e.code === 11000) throw bad(409, 'Email already registered'); throw e; }
    await ev(u.id, 'session', { msg: `Created ${role} account for ${p.email}` });
    return pubUser(nu, 0);
  });

  R('POST', '/api/admin/users/:id/role', async ({ u, p, b }) => {
    const role = String(b.role || '');
    if (!rbac.ROLES.includes(role)) throw bad(400, 'Role must be admin, editor or viewer');
    if (p.id === u.id) throw bad(400, 'You cannot change your own role');
    const t = await C('users').findOne({ _id: p.id }); if (!t) throw bad(404, 'User not found');
    if (t.pending) throw bad(409, 'Approve or reject this administrator account first');
    if (rbac.roleOf(t) === 'admin' && role !== 'admin' && (await approvedAdmins()).length <= 1) throw bad(409, 'At least one administrator must remain');
    await C('users').updateOne({ _id: t._id }, { $set: { role } });
    await ev(t._id, 'session', { msg: `Your role was changed to ${role} by an administrator` });
    await ev(u.id, 'session', { msg: `Changed the role of ${t.email} to ${role}` });
    return { ok: true, role };
  });

  R('POST', '/api/admin/users/:id/approve', async ({ u, p }) => {
    if (p.id === u.id) throw bad(403, 'Another administrator must approve your account');
    const t = await C('users').findOne({ _id: p.id }); if (!t) throw bad(404, 'User not found');
    if (!t.pending) throw bad(409, 'This account is not waiting for approval');
    await C('users').updateOne({ _id: t._id }, { $set: { pending: 0 } });
    await ev(t._id, 'session', { msg: `Your administrator account was approved by ${u.email}` });
    await ev(u.id, 'session', { msg: `Approved the administrator account of ${t.email}` });
    return { ok: true };
  });

  R('POST', '/api/admin/users/:id/reject', async ({ u, p }) => {
    const t = await C('users').findOne({ _id: p.id }); if (!t) throw bad(404, 'User not found');
    if (!t.pending) throw bad(409, 'Only accounts waiting for approval can be rejected');
    await C('users').deleteOne({ _id: t._id });
    await ev(u.id, 'session', { msg: `Rejected the administrator request of ${t.email}` });
    return { ok: true };
  });

  R('POST', '/api/admin/users/:id/disable', async ({ u, p, b }) => {
    if (p.id === u.id) throw bad(400, 'You cannot disable your own account');
    const t = await C('users').findOne({ _id: p.id }); if (!t) throw bad(404, 'User not found');
    const off = b.disabled === false ? 0 : 1;
    await C('users').updateOne({ _id: t._id }, { $set: { disabled: off } });
    if (off) await C('sessions').updateMany({ user_id: t._id, revoked: 0 }, { $set: { revoked: 1 } });
    await ev(u.id, 'session', { msg: `${off ? 'Disabled' : 'Re-enabled'} the account of ${t.email}` });
    return { ok: true, disabled: !!off };
  });

  R('GET', '/api/admin/shares', async () => {
    const out = [];
    for (const s of await C('shares').find({}).limit(200).toArray()) {
      const r = await C('records').findOne({ _id: s.record_id }), o = await C('users').findOne({ _id: s.owner });
      out.push({ id: s.id || s._id, record: r ? r.title : '(record removed)', owner: o ? o.email : '?', with: s.email, perm: s.perm, ts: s.ts });
    }
    return out;
  });

  R('DELETE', '/api/admin/shares/:id', async ({ u, p }) => {
    const s = await C('shares').findOne({ _id: p.id }); if (!s) throw bad(404, 'Share not found');
    await C('shares').deleteOne({ _id: p.id });
    await ev(s.owner, 'session', { msg: `An administrator revoked the share with ${s.email}` });
    await ev(u.id, 'session', { msg: `Revoked a share with ${s.email}` });
    return { ok: true };
  });

  /* ---------- 2. real-time updates: Server-Sent Events ---------- */
  const streams = { n: 0, by: new Map() };
  const STREAM_MS = (+E.STREAM_MAX_S || (SERVERLESS ? 25 : 240)) * 1000, POLL = +E.STREAM_POLL_MS || 1500,
    PER_USER = 5, MAX_ALL = +E.MAX_STREAMS || 500;

  R('GET', '/api/stream', async ({ u, req, res }) => {
    if (streams.n >= MAX_ALL) throw bad(503, 'Too many live connections right now');
    if ((streams.by.get(u.id) || 0) >= PER_USER) throw bad(429, 'Too many live connections for this account');
    let last = u.data_mod || 0, closed = false, busy = false;
    res.writeHead(200, x.hdrs({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' }));
    const w = s => { if (!closed) try { res.write(s); } catch { /* socket gone */ } };
    w(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ role: u.role, mod: last, windowS: STREAM_MS / 1000 })}\n\n`);
    streams.n++; streams.by.set(u.id, (streams.by.get(u.id) || 0) + 1);
    // records other people shared with this user count too
    let owners = [], n = 0, smark = null;
    const sharedMark = async () => {
      if (n++ % 10 === 0) { try { owners = (await C('shares').find({ with: u.id }).toArray()).map(s => s.owner); } catch { /* keep old list */ } }
      if (!owners.length) return '';
      return (await C('users').find({ _id: { $in: owners } }).project({ data_mod: 1 }).toArray()).map(d => d.data_mod || 0).join(',');
    };
    const check = async src => {
      if (closed || busy) return; busy = true;
      try {
        const d = await C('users').findOne({ _id: u.id });
        if (!d || d.disabled) { w('event: bye\ndata: {"reason":"account"}\n\n'); return close(); }
        const sm = await sharedMark(), own = (d.data_mod || 0) !== last, shr = smark !== null && sm !== smark; smark = sm;
        if (own) last = d.data_mod || 0;
        if (own || shr) w(`event: change\ndata: ${JSON.stringify({ ts: Date.now(), mod: last, src, shared: shr })}\n\n`);
      } catch { /* database hiccup: next poll retries */ } finally { busy = false; }
    };
    const onBus = () => check('push'), poll = setInterval(() => check('poll'), POLL),
      beat = setInterval(() => w(': keep-alive\n\n'), 15000),
      stop = setTimeout(() => { w('event: bye\ndata: {"reason":"window"}\n\n'); close(); }, STREAM_MS);
    function close() {
      if (closed) return; closed = true; clearInterval(poll); clearInterval(beat); clearTimeout(stop);
      bus.off('u:' + u.id, onBus); streams.n--; const k = (streams.by.get(u.id) || 1) - 1; k ? streams.by.set(u.id, k) : streams.by.delete(u.id);
      try { res.end(); } catch { /* already closed */ }
    }
    bus.on('u:' + u.id, onBus); req.on('close', close); res.on('close', close);
    return { __handled: true };
  });

  /* ---------- 3. high availability: samples + public status ---------- */
  const platform = () => ({
    name: E.VERCEL ? 'Vercel (serverless)' : E.RENDER ? 'Render' : 'Node.js server',
    region: E.VERCEL_REGION || E.RENDER_REGION || '', serverless: !!SERVERLESS
  });
  let lastOk = 0, pending = [];
  async function sample(ok, ms) {
    const now = Date.now();
    if (ok && now - lastOk < 60000) return;
    if (ok) lastOk = now;
    pending.push({ _id: nid(), ts: now, ok: !!ok, ms: ms == null ? null : ms, exp: new Date(now + 7 * 864e5) });
    if (pending.length > 200) pending = pending.slice(-200);
    if (!ok) return; // cannot write while the database is down; flushed with the next healthy sample
    try { const rows = pending; pending = []; await C('health').insertMany(rows); } catch { /* retry next time */ }
  }
  let cache = { t: 0, v: null };
  async function statusReport() {
    if (cache.v && Date.now() - cache.t < 4000) return cache.v;
    const t0 = Date.now(), r = { service: 'NestVault', time: t0, platform: platform(), version: E.npm_package_version || '' };
    try {
      const h = await x.D.command({ hello: 1 }); r.database = {
        ok: true, ms: Date.now() - t0, replicaSet: h.setName || 'standalone', primary: h.primary || '',
        members: [...new Set([...(h.hosts || []), ...(h.passives || [])])].length || 1, writable: !!h.isWritablePrimary
      };
    } catch (e) { r.database = { ok: false, ms: null, error: 'unreachable' }; }
    try { const t1 = Date.now(); await x.BD.command({ ping: 1 }); r.backupStore = { ok: true, ms: Date.now() - t1, separate: !!x.client2 }; }
    catch { r.backupStore = { ok: false, ms: null, separate: !!x.client2 }; }
    r.ok = r.database.ok && r.backupStore.ok;
    r.uptimeS = Math.round((Date.now() - M.start) / 1000); r.liveStreams = streams.n;
    try {
      const rows = await C('health').find({ ts: { $gt: Date.now() - 864e5 } }).toArray(), up = rows.filter(s => s.ok).length;
      r.availability24h = { samples: rows.length, upPct: rows.length ? Math.round(up / rows.length * 10000) / 100 : null };
    } catch { r.availability24h = { samples: 0, upPct: null }; }
    sample(r.ok, r.database.ms).catch(() => {});
    cache = { t: Date.now(), v: r };
    return r;
  }
  R('GET', '/api/status', () => statusReport(), false);

  /* ---------- 4. cloud function: scheduled maintenance (Vercel Cron) ---------- */
  const cron = async ({ req }) => {
    const want = E.CRON_SECRET; if (!want) throw bad(403, 'CRON_SECRET is not configured on this server');
    const got = (req.headers.authorization || '').replace('Bearer ', '') || new URL(req.url, 'http://x').searchParams.get('key') || '';
    if (got.length !== want.length || !require('crypto').timingSafeEqual(Buffer.from(got), Buffer.from(want))) throw bad(401, 'Invalid cron key');
    const t0 = Date.now(), users = await tick(); sample(true, Date.now() - t0).catch(() => {});
    return { ok: true, users, ms: Date.now() - t0 };
  };
  R('GET', '/api/cron/tick', cron, false); R('POST', '/api/cron/tick', cron, false);

  /* ---------- 5. scalability: server-side pagination ---------- */
  R('GET', '/api/records', async ({ u, req }) => {
    const sp = new URL(req.url, 'http://x').searchParams, limit = Math.min(Math.max(+sp.get('limit') || 50, 1), 100),
      before = +sp.get('before') || 0, f = { user_id: u.id, deleted: 0 };
    if (before) f.seq = { $lt: before };
    if (sp.get('category')) f.category = String(sp.get('category')).slice(0, 40);
    if (sp.get('status')) f.status = String(sp.get('status')).slice(0, 20);
    const q = String(sp.get('q') || '').slice(0, 80);
    if (q) f.title = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const a = await C('records').find(f).sort({ seq: -1 }).limit(limit + 1).toArray(), page = a.slice(0, limit);
    return { records: page.map(recOut), next: a.length > limit ? page[page.length - 1].seq : null, limit };
  });

  return { sample, statusReport, streams, platform };
};