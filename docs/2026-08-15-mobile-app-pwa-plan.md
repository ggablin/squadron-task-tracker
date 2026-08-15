# Squadron Task Tracker → Phone App (PWA) — Implementation Plan

**Status:** Plan only — approved, not yet implemented. No code has been written.
**Date:** 2026-08-15
**Target branch:** `claude/web-to-mobile-app-jiuwzq`
**Codebase state this was written against:** `2068bc5` (merge of PR #73)

---

## 1. Context

The tracker is live at `https://108ces.up.railway.app` with the full squadron and real UTA
data. Members currently reach it as a browser bookmark. The ask is to make it a real phone
app on Android and iPhone.

Three goals were confirmed, and one was explicitly ruled out:

| Goal | Wanted? |
|---|---|
| Home-screen icon, full-screen app feel | **Yes** |
| Real push notifications | **Yes** |
| Works offline at drill (poor base connectivity) | **Yes** |
| Listed in App Store / Google Play | **No** |

**All three wanted goals are reachable as an installable PWA.** No app store, no developer
accounts, no annual fees, no review cycle, and no change to the deploy flow (merge to
`master` → Railway auto-deploy). The store-packaging path is documented in Appendix B for
completeness but buys none of the three goals.

### Why this is cheap here

The app is *already* mobile-first — this is the single biggest asset:

- Bottom tab nav (`public/index.html:637`, `.mob-nav`) with a desktop sidebar swap at
  `min-width: 768px` (`index.html:668-671`)
- `env(safe-area-inset-bottom)` handled at `index.html:183`, `643`, `1698`
- `viewport-fit=cover` on 5 of 6 pages; explicit `min-height: 44px` touch targets
  (`index.html:322, 347, 393, 1142, 1162, 1464, 1480, 1778`)
- ~18 `-webkit-tap-highlight-color: transparent` declarations, 31 media queries repo-wide
- Full dark mode, self-hosted fonts

And critically: **a PWA runs on the same origin as the API**, so the existing
`express-session` cookie keeps working with zero auth changes. That one fact is the
difference between days and weeks.

### What's missing

- No `manifest.json`, no service worker, no `theme-color`, no `apple-touch-icon`
- **No icon or image file of any kind in the repo** — zero `.png`/`.svg`/`.ico`
- No offline story: every view refetches from `/api/*`; only `theme` and `onboarded` in
  `localStorage`
- Push is email + a 60-second in-app poll (`index.html:3891`), not real push

### Effort summary

| Phase | Effort | Delivers |
|---|---|---|
| 0. Staging + CI | ~0.5 day | Safe place to test; tests run on PRs |
| 1. Installable shell | ~0.5–1 day | Home-screen icon, full-screen chrome |
| 2. Service worker + offline reads | ~2–3 days | Task list readable with no signal |
| 3. Offline check-off queue | ~3–5 days | Check tasks off at drill, syncs later |
| 4. Web Push | ~3–4 days | Real phone alerts |

**Total ≈ 9–13 focused days**, in four independently shippable phases.

---

## 2. Current-state reference

Facts an implementer needs, verified against the tree.

**Stack.** Node + Express 4 + Postgres (`pg`). No frontend framework, no bundler, no build
step, no npm frontend dependencies. 10 dependencies, all server-side.

**Server.** `server.js` — 2,906 lines, one file: routes, auth middleware, boot migrations,
cron. Logic layer in `lib/` (14 modules, 1,951 LOC). 89 route registrations.

**Frontend.** `public/`, 13,371 LOC total:

| File | LOC | Bytes | Role |
|---|---|---|---|
| `index.html` | 7,882 | 418 KB | The entire member/supervisor/leadership SPA |
| `build.html` | 2,774 | 221 KB | `/build` task builder (leadership) |
| `roster.html` | 723 | 122 KB | Roster admin |
| `task-builder-mockup.html` | 663 | 124 KB | Unauthenticated prototype |
| `export.html` | 398 | 16 KB | Print/PDF export |
| `records.html` | 386 | 107 KB | Records browser |
| `design.css` | 251 | 14 KB | Shared tokens + primitives |
| `ui.js` | 152 | 7.5 KB | `uiToast`, `uiConfirm`, `uiTrapFocus` |
| `member-browser.js` | 142 | 6.6 KB | Shared shop-grouped member list |

Inside `index.html`: CSS lines 20–2219, markup 2221–3743, three script blocks
(3744–7154, 7156–7530, 7532–7880). 209 function definitions, 57 `fetch()` call sites.
Line 7166 is a single 31 KB literal (ported PT fitness scoring table).

> Note: `build.html`, `roster.html`, `records.html`, and `task-builder-mockup.html` each
> inline General Sans as base64 `data:` URIs, which is why a 386-line file is 107 KB.
> `index.html` correctly links `public/fonts/*.woff2` instead.

**Auth.** Home-grown. `express-session` + `connect-pg-simple`, bcrypt cost 10, session rows
in Postgres, 30-day `httpOnly` cookie, `secure` when `NODE_ENV=production`,
`app.set('trust proxy', 1)`. Middleware: `requireAuth` (`server.js:281`),
`requireRole(minRole)` (`286`), `requireRosterAdmin` (`~300`), `requireOnboarded` (`371`).
Role ladder `member < supervisor < leadership`. Deliberately not CAC/.mil.

**Static serving.** `app.use(express.static(path.join(__dirname, 'public')))` at
`server.js:2764`, then named page routes, then `app.get('*')` → `index.html` at `2855`.

**Boot migrations.** `server.js:75` runs an idempotent `ADD COLUMN IF NOT EXISTS` block on
*every* startup, wrapped in `withDeadlockRetry` (codes `40P01`, `55P03`, `40001`).

**Cron.** `server.js:2889` — runs unless `ENABLE_CRON === 'false'`. Daily 21:00 digest,
email flush every 5 minutes.

**Notifications (existing).** `notifications` table, types `tasks_live`, `task_assigned`,
`completion_digest`, `task_escalated`. Insert site at `server.js:457`. Routes
`GET /api/notifications`, `POST /api/notifications/read`. Client polls every 60s
(`index.html:3891`). Email via `mailer.js` / `notify-emails.js` / `notify-digests.js`.

**Browser APIs in play (mobile-relevant).**

- `localStorage` — 13 uses, only `theme` and `onboarded` (`index.html:3897`, `3909`)
- `sessionStorage` — 0. `document.cookie` — 0 (session cookie is `httpOnly`)
- `window.open(..., '_blank')` — 3: `index.html:2765` (`/newsletter`), `2775` (`/export`),
  `6440` (open a document)
- `window.location.href` download — `index.html:6441`
- Blob/CSV downloads — `index.html:6033`, `6191`
- `window.print` — `export.html:157`
- File upload — one `<input type="file">` at `index.html:6408`, posted as a **raw body**
  (`express.raw`, `server.js:744`), stored as Postgres `bytea`
- `navigator.clipboard.writeText` — 3 sites (`6016`, `6180`, `6350`)
- **Not used at all:** canvas, FileReader, drag-and-drop, `navigator.share`,
  IntersectionObserver, matchMedia, geolocation, WebSocket

**Routing.** None client-side. Views are `display:none`-toggled panes driven by
`switchView()`. No history API, no hash routing, no deep links. *(This matters for Phase 4.)*

**Tests.** 29 files in `test/`, ~303 `test()` calls, 5,272 LOC.
`node --env-file=.env.test --test --test-concurrency=1 test/*.test.js`. Needs a throwaway
Postgres via `TEST_DATABASE_URL`. Concurrency must be 1 (shared DB).

**Deploy.** Railway, project `reasonable-curiosity`, service `squadron-task-tracker` +
`Postgres`, `production` env. Nixpacks auto-detect + `npm start`. **No config files at all**
— no Dockerfile, `railway.json`, `nixpacks.toml`, or Procfile. **No `.github/` directory and
no CI.**

---

## 3. Risk analysis

### Database risk: low

The only schema change in the entire plan is `CREATE TABLE IF NOT EXISTS
push_subscriptions` in Phase 4. Purely additive — no `ALTER` on an existing table, no
backfill, no data migration. **Phases 1–3 touch no schema at all.**

Phase 3's offline queue replays through the existing `PUT /api/tasks/:id`, which writes:

```sql
INSERT INTO task_completions (task_id, completed_by_id, state, note, updated_at)
VALUES ($1, $2, $3, $4, NOW())
ON CONFLICT (task_id) DO UPDATE
  SET state = EXCLUDED.state, note = EXCLUDED.note,
      completed_by_id = EXCLUDED.completed_by_id, updated_at = NOW()
```

This is idempotent on `task_id`. Replaying a queued write is safe by construction. Worst
realistic outcome is a member's checkbox showing a wrong state, fixable by re-toggling —
not corruption, not loss.

### The service worker is the one thing that is not cleanly reversible

Everything else in this plan rolls back with a git revert and a redeploy. A service worker
does not: it persists **on each member's device**, independent of the server, and intercepts
every request on the origin. A bad one can pin members to a stale 418 KB shell that an
ordinary refresh will not fix — on personal phones, mid-drill, with no way to reach them.

Mitigations, in order of importance:

1. **Ship the kill-switch first (Phase 2a).** Before any caching logic, land a `sw.js` whose
   only behavior is to unregister itself and delete all caches. Verify the full
   register → update → unregister lifecycle on a real Android and a real iPhone. *Then* add
   caching. The escape hatch must be proven before it is needed.
2. **`Cache-Control: no-cache` on `sw.js`.** Without it, the browser can cache the service
   worker itself and you lose remote control of it. Non-negotiable.
3. **Never cache `/api/*` in the service worker.** This is a safety property, not a
   performance choice — see the shared-device hazard below.
4. **Ship right after a drill weekend, never before one.** Buys a full month of low-stakes
   soak time before anyone depends on it.

### Shared-device data leak (the security-relevant bug to avoid)

Caching a member's task list without clearing it on logout means that on a shared phone,
member B could see member A's cached data. `index.html:4072` already carries a comment about
same-tab logout/login staleness — same hazard, larger blast radius once data is persisted.

**Rule:** all cached member data lives in IndexedDB keyed by `memberId`, written by app code
(never by the service worker), and is wiped in `doLogout()` (`index.html:3988`).

### The real risk multiplier is the deploy setup

There is **no CI**. The 29-file test suite only runs when someone runs it locally, and merge
to `master` auto-deploys straight into the environment the whole squadron is working in.
That is already true of every change to this repo; it just matters more for a service
worker. Phase 0 fixes it.

### Take a Railway Postgres backup before the Phase 4 migration

Cheap insurance even though the migration is additive.

---

## 4. Rejected approach: a second repo sharing the Railway database

The instinct (isolate the risk) is right, but this shape would make things worse. Three
concrete reasons, all specific to this codebase:

1. **It isn't a separate app.** The PWA work is `<head>` tags, a service worker, and edits
   *inside* `public/index.html` — the 7,882-line file that **is** the application. A second
   repo must carry a copy of it. From then on every feature is written twice and the copies
   drift. That is precisely the "maintenance burden goes up" outcome MEMORY.md §2 names as
   the binding constraint.
2. **Two services would race the boot migrations.** `server.js:75` runs the
   `ADD COLUMN IF NOT EXISTS` block unconditionally on every startup, already wrapped in
   `withDeadlockRetry` because that race is a known problem — `test/helpers/db.js` carries
   its own retry for the same reason. Two production services booting against one database
   turns a handled edge case into a routine one.
3. **Members would get duplicate emails.** Cron is opt-**out**: `server.js:2889` runs the
   digest and email-flush jobs unless `ENABLE_CRON === 'false'`. A second service on the
   same database sends the whole squadron a second copy of every digest until someone
   notices. Same class of problem for the `uta_cycles_one_current` invariant and the
   `task_completions` immutability gating: two writers, one set of DB-level guarantees.

**Do this instead — Phase 0.**

---

## 5. Phase 0 — Staging environment + CI (~0.5 day)

Not part of the mobile feature, but it is what makes the rest safe.

### 5.1 Railway staging environment

Railway supports multiple environments per project. Create a `staging` environment in
project `reasonable-curiosity` with **its own Postgres service**, pointed at
`claude/web-to-mobile-app-jiuwzq`. Seed it with `seed.js` (destructive — that is fine, it is
a throwaway database).

Same repo, same code, isolated data. This gives a real HTTPS URL to install the PWA from on
a test phone, which local `localhost` cannot do cleanly for service-worker and push testing.

Environment variables to set on staging: `DATABASE_URL` (auto), `SESSION_SECRET` (a
*different* value from production), `NODE_ENV=production` (so the `secure` cookie path is
exercised), **`ENABLE_CRON=false`** (no digest emails from staging), and no `SMTP_HOST` (so
mail is a no-op).

> Watch the SSL heuristic documented in MEMORY.md §8: `server.js` enables Postgres SSL only
> when `DATABASE_URL` contains the literal substring `railway`. Railway's public proxy host
> is `*.rlwy.net`, which does not match. In-environment (private) URLs are fine; a local
> process connecting to a Railway DB is where this bites.

MEMORY.md §8 also documents a local `preview-run.cjs` on port 3100 against a throwaway
seeded DB. That works for logic, but it is gitignored and uncommitted, so it is not on a
fresh clone, and it is not sufficient for service-worker/push testing.

### 5.2 CI

Add `.github/workflows/test.yml` — the repo currently has no `.github/` directory at all.
A ~30-minute job:

- Trigger on `pull_request` and on push to `master`
- `services: postgres:16` with health checks
- `actions/setup-node`, `npm ci`
- Create `.env.test` with `TEST_DATABASE_URL` pointing at the service container
- Run `npm test`

This is worth doing independent of the mobile work.

---

## 6. Phase 1 — Installable shell (~0.5–1 day)

Delivers the home-screen icon and full-screen chrome. Also a **hard prerequisite for
Phase 4**: iOS only permits Web Push to a PWA the user has added to the Home Screen
(iOS 16.4+).

### 6.1 Icons — `public/icons/`

Nothing exists to start from. Generate from the existing design tokens in
`public/design.css` (cream / terracotta / sage).

| File | Size | Purpose |
|---|---|---|
| `icon-192.png` | 192×192 | Android home screen |
| `icon-512.png` | 512×512 | Android splash / store-grade |
| `icon-maskable-512.png` | 512×512 | Android adaptive masking — **~20% safe-zone padding** |
| `apple-touch-icon-180.png` | 180×180 | iOS home screen (no transparency; iOS does not mask) |
| `favicon.ico` | 32×32 | Desktop browser tab |

**Design constraint:** use a neutral typographic or geometric mark, **not** official USAF or
squadron insignia. Government emblems carry authorization questions that are not worth
inheriting, and the app currently ships no imagery at all so there is no precedent to match.

### 6.2 `public/manifest.webmanifest`

```json
{
  "name": "108th CES UTA Tracker",
  "short_name": "UTA Tracker",
  "description": "Per-person UTA task list for the 108th Civil Engineer Squadron.",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "<light --bg token from design.css>",
  "theme_color": "<light --bg token from design.css>",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/icon-maskable-512.png", "sizes": "512x512",
      "type": "image/png", "purpose": "maskable" }
  ]
}
```

`start_url: "/"` is correct: unauthenticated hits fall through `app.get('*')` to
`index.html`, which renders the login state.

### 6.3 `public/index.html` `<head>`

Current head is lines 3–18. Insert after the `<title>` (line 14), before the `design.css`
link (line 18) — so the early theme script at lines 6–13 keeps running first and the
FOUC-avoidance behavior is unchanged.

```html
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<meta name="theme-color" content="<light --bg>" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="<dark --bg>"  media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="UTA Tracker">
```

The same `<link rel="manifest">` / icon / `theme-color` block goes into `build.html`,
`records.html`, `roster.html`, and `export.html` so the icon is consistent if a leader lands
on one directly. Those pages need **nothing else** from this plan — no service worker, no
offline, no push. Also add `viewport-fit=cover` to `export.html`, the one page missing it.

### 6.4 Fix the standalone-mode escapes

Three `window.open(..., '_blank')` calls behave badly with no browser chrome to return
from — the member lands in a detached view with no back affordance:

- `index.html:2765` → `/newsletter`
- `index.html:2775` → `/export`
- `index.html:6440` → open a document

Minimum fix: for the two internal pages, add a visible in-app "Back to tracker" control on
`/newsletter` and `/export`. For the document open at `6440`, keep `_blank` (opening a PDF
externally is correct behavior) but verify on-device that the return path works.

### 6.5 Install prompt

Wire a lightweight install affordance into the existing onboarding flow (`onboarded` flag,
`index.html:3897`):

- **Android/Chrome:** capture `beforeinstallprompt`, stash the event, show a
  "Add to Home Screen" button, call `prompt()` on tap.
- **iOS Safari:** there is no `beforeinstallprompt`. Detect iOS + not-standalone
  (`navigator.standalone === false`) and show static instructions ("tap Share, then Add to
  Home Screen"). Reuse `uiToast` / the existing onboarding UI rather than building new chrome.

This matters more than it looks: it is the only path to push on iPhone.

---

## 7. Phase 2 — Service worker + offline reads (~2–3 days)

### 7.1 Phase 2a — kill-switch first (do this before anything else)

Land `public/sw.js` containing **only**:

```js
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.map(k => caches.delete(k)));
  await self.registration.unregister();
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(c => c.navigate(c.url));
})()));
```

Register it from `index.html` behind a `'serviceWorker' in navigator` guard. Deploy to
**staging**, install on a real Android and a real iPhone, confirm the device returns to a
clean no-service-worker state on next open. Keep this file in git history — it is the
rollback artifact.

### 7.2 Serving `sw.js` with automatic cache-busting

There is no bundler, so filenames are not content-hashed. Serve `sw.js` from an Express
route inserted **immediately before** `express.static` at `server.js:2764` (so it wins over
the static handler):

```js
// Served rather than static so the cache version rotates on every deploy without a
// build step, and so the no-cache header is guaranteed. Must precede express.static.
const SW_SRC = fs.readFileSync(path.join(__dirname, 'public', 'sw.js'), 'utf8');
const SW_VERSION = process.env.RAILWAY_GIT_COMMIT_SHA || 'dev';
app.get('/sw.js', (req, res) => {
  res.set({
    'Content-Type': 'application/javascript',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Service-Worker-Allowed': '/',
  });
  res.send(`const VERSION = ${JSON.stringify(SW_VERSION)};\n${SW_SRC}`);
});
```

Railway sets `RAILWAY_GIT_COMMIT_SHA` automatically, so every deploy rotates the cache name
with zero added tooling. Read the file once at boot (the app already reads from disk at
startup elsewhere); a restart happens on every deploy anyway.

### 7.3 Caching strategy

The app is auth-gated and the data is live, so strategy matters more than code volume.

| Request | Strategy | Why |
|---|---|---|
| Navigations (`index.html`) | **Network-first**, cache as fallback | Never cache-first. A stale 418 KB shell behind a session wall is the classic footgun. `compression()` at `server.js:40` exists specifically because of that payload. |
| `fonts/*.woff2` | Cache-first | Immutable |
| `design.css`, `ui.js`, `member-browser.js` | Stale-while-revalidate | Change occasionally; not content-hashed |
| `/api/*` | **Never cached by the SW** | Safety property — see §3 shared-device hazard |
| `/icons/*`, `/manifest.webmanifest` | Cache-first | Immutable in practice |

Scope the service worker to `index.html` only. `build.html`, `records.html`, `roster.html`,
and `export.html` are leadership desktop tools — explicitly out of scope for offline.

### 7.4 Offline reads — `public/offline.js`

New file, loaded from `index.html` alongside `ui.js`.

- After each successful `/api/tasks` fetch, write the payload to IndexedDB store
  `taskCache`, keyed by `memberId`, with a `fetchedAt` timestamp.
- On fetch failure, read from `taskCache` for the current member and render, with a clear
  "Offline — showing data from {relative time}" banner. Reuse `uiToast` from `public/ui.js`
  for the transient notice and add a persistent inline banner for the stale state.
- **Wipe `taskCache` (and `pendingWrites`, Phase 3) in `doLogout()` at `index.html:3988`.**
  This is the shared-device fix and is not optional.
- Also guard on `memberId` mismatch at read time — belt and braces against the same-tab
  logout/login case already flagged at `index.html:4072`.

**Scope offline strictly to the member's own task list.** Supervisor rollups, attendance,
roster, `/build`, and `/records` stay online-only.

**Bonus:** this also closes a standing MEMORY.md §10 item — the app currently refetches
everything on every tab switch.

---

## 8. Phase 3 — Offline check-off with sync-later (~3–5 days)

The genuinely new engineering, and why "works offline at drill" is the most expensive of the
three goals. **The server needs no changes** — the existing `ON CONFLICT (task_id) DO UPDATE`
makes replay idempotent by construction.

### 8.1 Queue

IndexedDB store `pendingWrites`:

```js
{ taskId, state, note, queuedAt, memberId }
```

Keyed by `taskId` so repeated toggles of the same task collapse to one pending write rather
than accumulating.

### 8.2 Intercept

Wrap the existing task-toggle call site in `index.html`. On network failure:

1. Enqueue the write.
2. Update the UI optimistically.
3. Show a per-row "pending sync" affordance — a distinct visual state, not a toast, so the
   member can see at a glance which check-offs have not reached the server.

### 8.3 Flush

- On the `online` event
- On app load / foreground
- Via the Background Sync API where available

**iOS has no Background Sync**, so on iPhone the flush happens on next foreground. Member-
facing copy must say that plainly rather than implying background syncing.

### 8.4 The edge case that matters most

`assertTaskInLiveCycle` returns `403 { error: 'This cycle is closed to changes' }`.

A member who checks tasks off offline on Sunday and syncs after the cycle closes **must be
told their check-offs were rejected** — with a list of which ones — not have them silently
vanish from the queue. This is the single most important behavior to get right in this
phase. Suggested handling:

- `403` with that error → drop from queue, surface a persistent dismissible notice naming
  the affected tasks
- `401` (session expired) → keep in queue, prompt re-login, retry after
- `5xx` / network → keep in queue, retry with backoff
- `400` (informational item — `server.js` rejects `state` changes on informational rows) →
  drop and log; should not happen since those render without a checkbox

### 8.5 Conflict policy

Last-write-wins is acceptable for a drill checklist. Send `queuedAt` in the request body so
the audit trail can reflect when the member actually tapped, even though `updated_at` is
server `NOW()`. This is additive to the request body and requires no server change to
*accept*; wiring it into the stored record would be a small follow-on.

---

## 9. Phase 4 — Real push notifications (~3–4 days)

Two-thirds of the infrastructure already exists. Only the transport is missing.

### 9.1 Dependency + keys

Add `web-push` to `package.json` (one dependency — the first new one in a while; the tree is
deliberately small at 10). Generate VAPID keys, store as Railway env vars alongside
`SESSION_SECRET` and the SMTP vars:

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT` (a `mailto:` for the maintainer)

Push must be a no-op when `VAPID_PUBLIC_KEY` is unset, mirroring how email is a no-op when
`SMTP_HOST` is unset (`mailer.js`). Staging then needs no keys.

### 9.2 Schema

```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          SERIAL PRIMARY KEY,
  member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_subs_member ON push_subscriptions (member_id);
```

Add to `schema.sql` **and** twin it into the boot-migration block in `server.js`
(~lines 74–280), matching the existing convention. **Ordering caution** — MEMORY.md §11
records that `tasks.document_id`'s `ALTER` must stay *after* the `documents` `CREATE TABLE`,
because the early `DO` block swallows errors and rolls back silently. Place this
`CREATE TABLE` after `members` exists.

`endpoint UNIQUE` plus `ON CONFLICT (endpoint) DO UPDATE` makes re-subscription idempotent —
browsers rotate endpoints and the same device will re-register.

### 9.3 Routes

All behind `requireAuth`, added near the existing `/api/notifications` routes:

- `GET  /api/push/vapid-key` → `{ key }`
- `POST /api/push/subscribe` → upsert on `endpoint`
- `POST /api/push/unsubscribe` → delete by `endpoint`

### 9.4 Send path — `lib/push.js`

New module following the existing `lib/` pattern. Exports something like
`sendToMember(memberId, { title, body, url })`.

Hook it at the existing `INSERT INTO notifications` site (`server.js:457`) so push, in-app,
and email stay in lockstep rather than drifting into three separate notification systems.

**Two rules for the hook:**

1. **Fire-and-forget with a `try`/`catch`.** Never `await` it in the request path. A
   throwing `web-push` call at `server.js:457` would break notification creation, which
   would break task-assignment flows. This is the highest-consequence line in Phase 4.
2. **Prune dead subscriptions.** On `410 Gone` / `404`, delete the row. Endpoints expire
   routinely; without pruning the table accretes garbage and every send burns time on it.

### 9.5 Client

- `push` and `notificationclick` handlers in `sw.js`
- Request permission **behind an explicit user gesture** — a toggle in the app, never on page
  load. An unprompted permission dialog is the fastest way to get permanently denied, and
  there is no recovery from that without the member digging into browser settings.
- Surface the toggle next to the existing notification bell.

### 9.6 Deep-linking gap

There is no client-side router — views are `display:none` panes driven by `switchView()`. So
`notificationclick` can currently only open `/`.

Add a `?view=` query-param read on load that calls the existing `switchView()`. A handful of
lines, but it is what makes a tapped notification land somewhere useful instead of dumping
the member on the default view. The `notifications` table already has a `link` column —
align the two.

### 9.7 Platform reality to communicate to members

- **Android/Chrome:** push works for an installed *or* browser-tab PWA.
- **iPhone:** push requires Add to Home Screen first, iOS 16.4+. No exceptions.

The onboarding flow is the natural place to prompt for installation, with **different copy
per platform**.

---

## 10. Files touched

### New

| Path | Purpose |
|---|---|
| `public/manifest.webmanifest` | PWA manifest |
| `public/sw.js` | Service worker (kill-switch first, then caching) |
| `public/icons/icon-192.png` | Android |
| `public/icons/icon-512.png` | Android |
| `public/icons/icon-maskable-512.png` | Android adaptive |
| `public/icons/apple-touch-icon-180.png` | iOS |
| `public/favicon.ico` | Desktop tab |
| `public/offline.js` | IndexedDB task cache + pending-write queue |
| `lib/push.js` | Web Push send + dead-subscription pruning |
| `test/push-http.test.js` | Push route tests |
| `.github/workflows/test.yml` | CI (Phase 0) |

### Modified

| Path | Change |
|---|---|
| `public/index.html` | `<head>` block (§6.3); SW registration; install prompt; `offline.js` include; toggle-call wrapping (§8.2); cache wipe in `doLogout()` (`:3988`); `?view=` handling; standalone-escape fixes at `:2765`, `:2775` |
| `server.js` | `/sw.js` route before `express.static` (`:2764`); push routes; `push_subscriptions` boot migration (~`:74-280`); push hook at `:457` |
| `schema.sql` | `push_subscriptions` table + index |
| `package.json` | Add `web-push` |
| `public/build.html`, `records.html`, `roster.html`, `export.html` | Icon/manifest `<head>` additions only; `viewport-fit=cover` on `export.html` |
| `MEMORY.md` | New section — it is the handoff doc, and §10/§12 need updating |

---

## 11. Rollout order to production

1. **Phase 0** — staging environment + CI. Nothing user-visible.
2. **Phase 1 alone** — manifest + icons + head meta. Zero-risk, additive; gets the icon onto
   home screens and proves the deploy path.
3. **Phase 2a — kill-switch-only service worker.** No caching. Verify the lifecycle on real
   devices. This is the safety rehearsal.
4. **Phase 2b — caching**, deployed **right after a drill weekend**.
5. **Phases 3 and 4** once the service worker has soaked for a full cycle.

Each step is independently revertable, and steps 1–2 deliver the most-wanted goal (the
home-screen icon) before any risk is taken on.

---

## 12. Verification

1. **`npm test`** — the existing 29-file suite must stay green. New push routes get an HTTP
   test following the pattern in `test/rollout-feedback-http.test.js`. Note
   `--test-concurrency=1` is required (shared DB).
2. **Lighthouse PWA audit** against the staging URL — installability, manifest validity,
   `start_url` responds offline.
3. **Real Android device:** install to home screen; confirm standalone chrome (no address
   bar); kill connectivity; check tasks off; restore connectivity; confirm the queue flushes
   and server state matches. Confirm a push arrives and the tap lands on the right view.
4. **Real iPhone:** same, plus explicitly verify (a) push works *only after* Add to Home
   Screen, and (b) the queue flushes on foreground, not in background.
5. **Shared-device check (security-relevant):** log in as member A, cache tasks offline, log
   out, log in as member B — B must never see A's cached list. Repeat in the same tab
   without a reload, per the hazard noted at `index.html:4072`.
6. **Cycle-closed check:** queue an offline check-off, close the cycle in `/build`, then
   sync — the member must get an explicit rejection notice naming the affected tasks, not a
   silent drop.
7. **Service-worker kill-switch drill:** with the SW installed on a real device, deploy the
   unregister-only `sw.js`, and confirm the device recovers to a clean no-SW state with the
   member doing nothing beyond opening the app. **Rehearse this before you need it.**
8. **Deploy check** per MEMORY.md §8: `/` → 200, `/api/auth/me` → 401.

---

## Appendix A — Open questions

- **Icon design.** Needs a decision on the mark itself. Recommendation: a typographic "108"
  or a simple geometric form in the terracotta/sage palette. Avoiding official insignia is a
  recommendation, not a hard blocker — worth a sanity check with squadron leadership if
  unit branding is wanted on members' home screens.
- **Whether to backfill `viewport-fit=cover` on `export.html`** — trivial, included above,
  flagging only because that page has the only `@media print` block and is the one place a
  layout change could surprise.

## Appendix B — The App Store path, and why it is deferred

Not among the stated goals. Recorded because maintenance appetite was left open.

### Capacitor wrapper (~1–2 additional weeks, plus permanent release burden)

Two variants:

**(a) Thin remote-URL shell** pointing `server.url` at Railway — about a day of work, but
this is exactly what Apple **Guideline 4.2 (minimum functionality)** rejects. Not a reliable
path.

**(b) Bundled assets calling the Railway API** — the real path, and where the costs live:

- The webview origin becomes `capacitor://localhost` (iOS) / `https://localhost` (Android),
  so every `/api/*` call turns **cross-origin and the session cookie stops working**.
  Options: CORS with credentials + `sameSite: 'none'` (fighting iOS WKWebView's third-party
  cookie restrictions), or — cleaner — a bearer-token branch in `requireAuth`
  (`server.js:281`). The latter is genuinely small *because* auth is centralized there, and
  can be additive: keep sessions for web, add `Authorization: Bearer` for the app.
- **73 of the 103 `fetch()` calls use hardcoded relative paths** (`fetch('/api/…')`) and need
  an API base-URL shim.
- The document open/download paths (`index.html:6440`, `6441`) and the two CSV blob
  downloads (`6033`, `6191`) need native file-handling plugins — webview downloads do not
  just work.
- `navigator.clipboard.writeText` (3 sites) needs a secure context and a direct user gesture
  on iOS.

**Then the non-engineering costs:** $99/yr Apple + $25 Google, signing certificates, a public
store listing with a privacy policy and support URL, a demo account for reviewers (awkward
for an app holding real member data), review latency on every release, and the loss of the
current merge-to-`master`-and-it's-live flow.

If a store presence ever *is* required, Apple's unlisted-app distribution and Google Play's
internal testing track are the right fit for a unit-internal tool.

### Native / React Native / Flutter rewrite: months, not worth it

The client is 13,371 lines of hand-written framework-less HTML/CSS/JS — 209 functions and
~2,200 lines of CSS in `index.html` alone, with no components to port. Reuse is effectively
zero. It would be a from-scratch rebuild of a working, live application, against the stated
constraint that maintenance burden must go **down**.
