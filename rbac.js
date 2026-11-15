'use strict';
const ROLES = ['admin', 'editor', 'viewer'];
const DEFAULT_ROLE = 'editor';
const roleOf = u => (u && ROLES.includes(u.role) ? u.role : DEFAULT_ROLE);

// Requests a read-only viewer may still make although they are not GET.
const VIEWER_ALLOWED = [
  'POST /api/sync',                 // pull only; the sync route refuses uploaded changes
  'POST /api/logout',
  'POST /api/password',
  'POST /api/sessions/revoke-others',
  'POST /api/email/send-verification',
  'DELETE /api/sessions/',
  'DELETE /api/shares/'
];

/* null = allowed, otherwise the reason it is refused */
function denyReason(role, method, pathname) {
  if (pathname.startsWith('/api/admin/') || pathname === '/api/admin') {
    return role === 'admin' ? null : 'Administrator role required';
  }
  if (role === 'viewer' && method !== 'GET' && method !== 'HEAD') {
    const key = method + ' ' + pathname;
    if (!VIEWER_ALLOWED.some(a => key === a || (a.endsWith('/') && key.startsWith(a)))) {
      return 'Your account has the Viewer role and is read-only';
    }
  }
  return null;
}

const MATRIX = [
  { action: 'Sign in, change own password, manage own devices',        admin: true, editor: true, viewer: true },
  { action: 'View own records, vault list, backups, infrastructure',    admin: true, editor: true, viewer: true },
  { action: 'View records shared with them',                            admin: true, editor: true, viewer: true },
  { action: 'Create / edit / delete records and sync changes',          admin: true, editor: true, viewer: false },
  { action: 'Upload, delete and restore vault files',                   admin: true, editor: true, viewer: false },
  { action: 'Create backups, restore, run recovery drills',             admin: true, editor: true, viewer: false },
  { action: 'Share records and edit records shared with edit access',   admin: true, editor: true, viewer: false },
  { action: 'Manage users: create accounts, change roles, disable',     admin: true, editor: false, viewer: false },
  { action: 'Approve or reject new administrator accounts',             admin: true, editor: false, viewer: false },
  { action: 'See all sharing links and revoke any of them',             admin: true, editor: false, viewer: false },
  { action: 'System overview, audit trail of all users',                admin: true, editor: false, viewer: false }
];

module.exports = { ROLES, DEFAULT_ROLE, roleOf, denyReason, MATRIX };