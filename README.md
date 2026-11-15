# NestVault

Offline-first records, an encrypted file vault, and backup / disaster recovery, on MongoDB Atlas.

* Records are saved on the device first and synced when a connection returns (priority order, bandwidth limit, conflict handling).
* Files are encrypted in the browser before upload.
* Backups, restore previews, recovery drills and monitoring show how the data would be recovered.

## Setup
1. **Atlas:** create a free M0 cluster at mongodb.com/cloud/atlas. Database Access: add a user (avoid `@ : /` in the password). Network Access: add your IP. Connect, Drivers: copy the connection string.
2. **Project** (Node 18+):
   ```
   npm install
   copy .env.example .env        (Mac/Linux: cp .env.example .env)
   ```
   Put your connection string in `MONGODB_URI` in `.env`.
3. In `.env` also set `ADMIN_CODE` and `EDITOR_CODE` (your own secret passwords). `npm start`, open http://localhost:3000, choose "Create an account", pick **Administrator** and enter `ADMIN_CODE`. The first administrator is approved automatically; every later person who registers as administrator cannot sign in until another administrator approves them under Administration. Editors register with `EDITOR_CODE`; viewers need no code. Only administrators create accounts and change roles.

**Tests** (no Atlas needed, uses an in-memory stand-in for the driver): `npm test`

## Sections
| Section | Contents |
|---|---|
| Overview | Counts, backup status for records and vault separately, recent activity |
| Records | Works offline. Search, filters, pages of 30, per-record sync status, history, share, delete to trash |
| Sync | Priority order, bandwidth limit, selective sync by category, edits merged into one change, retry with backoff, conflict resolution |
| Vault | Encrypted files up to 25 MB in 512 KB pieces, folders, tags, search, preview, verify, duplicate detection |
| Backups | Schedule (minute to monthly), retention, restore preview, restore as copies or replace, recovery test, automatic integrity check and drill |
| Trash | Restore or delete records and files permanently |
| Shared | Records others shared with you (view or edit, online only) |
| Infrastructure | Atlas status, RTO/RPO targets vs measured, recovery history, failover probe, server health |
| Account | Storage, export, signed-in devices, password, activity log |

## Reliability and testing (second review round)
* **Restore lock:** a replace-restore, a copy-restore and the ransomware drill take a per-user lock in MongoDB. While it is held, sync, record changes and uploads are refused (HTTP 423) and a second restore is refused (409). In the browser, editing is paused in every tab, other tabs' syncs wait, the pending changes are re-checked after the lock is taken and again inside the same IndexedDB transaction that clears local data, and a safety snapshot of local data is saved first (Account, "Data on this device").
* **Ownership and version guards:** every record change (sync, version restore, undelete, conflict resolution, shared edit, purge) filters on record id, owner and version, and answers 409 if the record changed meanwhile.
* **Upload validation:** an upload is a server-side session. Declared sizes must match (ciphertext = size + 51 bytes), every chunk must have its exact size, a session can be completed once, and the quota is checked and reserved under a lock, so parallel uploads cannot exceed it.
* **Backup reference audit:** every 6 hours (and on demand) each retained backup is checked: payload present, chunk counts, checksum, and every vault file it references (present, chunk count, checksum). Failures raise an alert.
* **Local-only data:** a banner and the sign-out dialog warn about unsynced changes and offer a download; Account has "Download unsynced data", import from a JSON file, and safety snapshots.
* **Resumable uploads:** the encrypted file is kept in IndexedDB until the upload completes; after a reload, "Interrupted uploads" lists it and sends only the missing pieces.
* **Password reset and email verification:** single-use, expiring links. Delivery uses `MAIL_WEBHOOK_URL`; without it the link is printed in the server console.
* **Sharing** is online only and the interface says so.

## Tests
| Command | What it runs | Needs |
|---|---|---|
| `npm test` | 27 tests: HTTP API (21), client logic (5), in-process lock and audit tests | nothing (in-memory database stand-in) |
| `npm run test:e2e` | 11 tests in a real Chromium browser: sign-up, offline queue, two devices and conflicts, vault, recovery, restore blocking, resume after reload, sign-out warning, import, password reset, editing lock | `npm install` then `npx playwright install chromium` |
| `npm run test:atlas` | the same HTTP API tests against your Atlas cluster (temporary database, dropped afterwards) | `.env` with `MONGODB_URI` |
| `npm run check:atlas` | 11 checks of the exact MongoDB driver behaviours the server relies on | `.env` with `MONGODB_URI` |

## Checklist before submitting
- [x] Restore lock and local safety snapshot
- [x] Ownership and version checks on every record change
- [x] Upload byte-count, chunk-size and quota validation
- [x] Backup blob reference audit
- [x] Browser end-to-end tests
- [x] Offline to online sync across two devices (API test and browser test)
- [x] Recovery after deleting cloud data (API test and browser test)
- [ ] Run `npm run check:atlas` and `npm run test:atlas` on your own Atlas cluster (not possible from where this was built)

## Limits
* Atlas free tier cannot trigger a failover, so the app measures one but cannot cause one.
* The MongoDB driver calls were verified against an in-memory stand-in, not a live Atlas cluster. `npm run check:atlas` verifies them on yours.
* Mail delivery is not tested; reset and verification links work, but sending needs `MAIL_WEBHOOK_URL`.
* All local records are loaded into memory in the browser; only the list display is paged.
* Unsynced changes exist only in the browser that made them; export or import is the recovery path.
* The scheduler checks every user once a minute, which suits a small deployment, not a large one.
* File data is stored base64 inside MongoDB (about 33% overhead).


## Cloud deployment (Vercel + MongoDB Atlas)
1. Push to GitHub (.env and .secret are git-ignored).
2. Atlas: Network Access, add 0.0.0.0/0. Use a strong DB password.
3. Vercel: import the repo, framework "Other". Environment variables: MONGODB_URI, JWT_SECRET, APP_URL (your Vercel URL), ADMIN_CODE, EDITOR_CODE, CRON_SECRET.
4. Sign up as Administrator with ADMIN_CODE (the first administrator is approved automatically; later ones need another administrator's approval).
5. Verify: EDITOR_CODE=your-editor-access-password npm run check:deploy -- https://your-app.vercel.app, and open /status.html
6. Optional: uptime monitor on /health every 5 min (builds the 24 h availability figure) and on /api/cron/tick?key=CRON_SECRET.
Roles: Admin (users, roles, shared access, overview), Editor (default, full use), Viewer (read-only, writes return 403).