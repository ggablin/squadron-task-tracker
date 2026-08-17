# Squadron Task Tracker → Phone App (PWA) — Implementation Plan (rev. 2)

**Status:** Plan only — not yet implemented. No code has been written.
**Date:** 2026-08-17 (supersedes the 2026-08-15 version, committed as `docs/2026-08-15-mobile-app-pwa-plan.md` in `3dd9e86` on the target branch)
**Target branch:** `claude/web-to-mobile-app-jiuwzq` (currently `origin/master` + the plan commit; rebase on fresh `origin/master` before starting)
**Codebase state this was written against:** `2068bc5` (merge of PR #73) — still `origin/master` as of today
**What changed in this revision:** see Appendix C. Short version: push moved ahead of offline; the kill switch became an environment variable; the offline phases gained the boot, logout, and queue-lifecycle work they were missing; a handful of stale platform facts were corrected; a comms deliverable was added.

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

- Bottom tab nav (`public/index.html:639`, `.mob-nav`) with a desktop sidebar swap at
  `min-width: 768px` (`index.html:671`)
- `env(safe-area-inset-bottom)` handled; `viewport-fit=cover` on 5 of 6 pages; explicit
  `min-height: 44px` touch targets throughout
- ~18 `-webkit-tap-highlight-color: transparent` declarations, 31 media queries repo-wide
- Full dark mode, self-hosted fonts
- The task list already renders cache-first in memory (`loadTasks()`, `index.html:4216`),
  and the notification panel already deep-links by view name (`onNotifClick()`,
  `index.html:3870`, calls `switchView({ dataset: { view: link } })`) — both are hooks the
  offline and push work reuse rather than invent

And critically: **a PWA runs on the same origin as the API**, so the existing
`express-session` cookie keeps working with zero auth changes. That one fact is the
difference between days and weeks.

### What's missing

- No `manifest.json`, no service worker, no `theme-color`, no `apple-touch-icon`
- **No icon or image file of any kind in the repo** — zero `.png`/`.svg`/`.ico`
- No offline story: every view refetches from `/api/*`; only `theme` and `onboarded` in
  `localStorage`; **`init()` sends a member with no signal to the login screen**
  (`index.html:3979–3985` — any thrown fetch, including no network, → `showLogin()`)
- No out-of-app notification channel that works today: the email path exists in code, but
  **the production service has no `SMTP_*` variables set** (Railway config, checked
  2026-08-17: only `DATABASE_URL` and `SESSION_SECRET`), so `mailer.js` no-ops and every
  notification row sits with `emailed_at IS NULL`. Members get the in-app bell and a
  60-second poll (`index.html:3891`), nothing else. **Push would be the first working
  out-of-app channel**, which is why it moves ahead of offline in this revision.
- The session cookie is not rolling (`server.js:44–56`, no `rolling: true`), so it expires
  30 days after *login* regardless of use — for a monthly-drill app that means the installed
  icon greets many members with a login screen roughly every UTA

### Effort summary (revised order)

| Phase | Effort | Delivers |
|---|---|---|
| 0. Staging + CI + deploy gate | ~0.5 day | Safe place to test; tests block bad deploys |
| 1. Installable shell + deep links + comms | ~1 day | Home-screen icon, full-screen chrome, sticky session, install instructions to the squadron |
| 2. Web Push (push-only service worker) | ~3 days | Real phone alerts — the first out-of-app channel that actually works |
| 3. Caching service worker + offline reads | ~2–3 days | Task list readable with no signal |
| 4. Offline check-off queue (**gated**) | ~3–4 days | Check tasks off at drill, syncs later — only if Phase 3 shows the need |

**Phases 0–3 ≈ 6.5–7.5 focused days; ≈ 9.5–11.5 with Phase 4.** Four independently
shippable phases, each revertable, plus one that is decided later on evidence.

Why this order (a change from rev. 1): the original deferred push until the service worker
had "soaked for a full cycle," but the soak concern is about *caching* — a service worker
with no `fetch` handler cannot pin anyone to a stale shell (Chrome doesn't even start it for
navigations). Push is the cheaper of the two remaining goals, it is the one that brings
people back to the app (adoption is the binding constraint, MEMORY.md §2), and it turns out
to be the *only* out-of-app channel that would work in production today. Offline reads
follow; the offline write queue is the most expensive phase for the narrowest gain (tapping
a box with no signal instead of twenty minutes later) and is gated on what a real drill
shows.

---

## 2. Current-state reference

Facts an implementer needs, verified against the tree at `2068bc5`.

**Stack.** Node + Express 4 + Postgres (`pg`). No frontend framework, no bundler, no build
step, no npm frontend dependencies. 10 dependencies, all server-side, no `devDependencies`,
no `engines` pin.

**Server.** `server.js` — 2,906 lines, one file: routes, auth middleware, boot migrations,
cron. Logic layer in `lib/` (14 modules). 89 route registrations. `module.exports = app`
with a `require.main === module` guard around `app.listen` (`server.js:2882–2884`) so tests
can drive it in-process.

**Frontend.** `public/`, ~13,400 LOC:

| File | LOC | Bytes | Role |
|---|---|---|---|
| `index.html` | 7,882 | 418 KB | The entire member/supervisor/leadership SPA |
| `build.html` | 2,774 | 221 KB | `/build` task builder (leadership) |
| `roster.html` | 723 | 122 KB | Roster admin |
| `task-builder-mockup.html` | 663 | 124 KB | Unauthenticated prototype |
| `export.html` | 398 | 16 KB | Print/PDF export (already has a "← Back to app" link, line 156) |
| `records.html` | 386 | 107 KB | Records browser |
| `design.css` | 251 | 14 KB | Shared tokens + primitives (`--bg: #fdfdfa` light, `#1a1816` dark) |
| `ui.js` | 152 | 7.5 KB | `uiToast`, `uiConfirm`, `uiTrapFocus` |
| `member-browser.js` | 142 | 6.6 KB | Shared shop-grouped member list |

Inside `index.html`: CSS lines 20–2219, markup 2221–3743, three script blocks
(3744–7154, 7156–7530, 7532–7880). 209 function definitions, 57 `fetch()` call sites
(103 across all of `public/`). Line 7166 is a single 31 KB literal (PT scoring table).

> `build.html`, `roster.html`, `records.html`, and `task-builder-mockup.html` each inline
> General Sans as base64 `data:` URIs, which is why a 386-line file is 107 KB.
> `index.html` correctly links `public/fonts/*.woff2` instead.

**Auth.** Home-grown. `express-session` + `connect-pg-simple`, bcrypt cost 10, session rows
in Postgres, 30-day `httpOnly` cookie, `secure` when `NODE_ENV=production`,
`app.set('trust proxy', 1)`, **not rolling**. Middleware: `requireAuth` (`server.js:281`),
`requireRole(minRole)` (`286`), `requireRosterAdmin` (`307`), `requireOnboarded` (`371`,
returns 403 while `mustChange` is set). Role ladder `member < supervisor < leadership`.
Deliberately not CAC/.mil. `GET /api/auth/me` (`853`) returns `id, first_name, last_name,
rank, role, slug, must_change_password, shop, shop_id, uta_name, can_manage_roster` — this
payload is what Phase 3 caches as the offline identity.

**Boot path (client).** `init()` (`index.html:3979`) → `fetch('/api/auth/me')` → `showApp()`
(`4011`) on 200, `showLogin()` (`4006`) on anything else including a thrown network error.
`showApp()` fans out to `loadTasks()`, `loadShopEvents()`, `loadShopMembers()`,
`startNotifPolling()`, and `loadSquadron()` for leadership. `loadTasks()`'s cold path
(`4216–4239`) has **no catch** — offline, the skeleton stays forever. `doLogout()` (`3987`)
`await`s the logout fetch first, so offline it throws and clears nothing.

**Task write.** `PUT /api/tasks/:id` (`server.js:904–956`) → `404 Task not found` (`916`),
`400` informational (`922`), `403 Cannot update tasks outside your shop` (`929`), `403
Forbidden` (`932`), `403 This cycle is closed to changes` (`939`, from
`assertTaskInLiveCycle`'s `NOT_LIVE`), then a pure upsert:

```sql
INSERT INTO task_completions (task_id, completed_by_id, state, note, updated_at)
VALUES ($1, $2, $3, $4, NOW())
ON CONFLICT (task_id) DO UPDATE
  SET state = EXCLUDED.state, note = EXCLUDED.note,
      completed_by_id = EXCLUDED.completed_by_id, updated_at = NOW()
```

Idempotent on `task_id`. No notification, no audit row, no other side effect. The client
call site is `cycleTask()` (`index.html:4430–4463`): optimistic flip, PUT, revert on any
error.

**Static serving.** `app.use(express.static(path.join(__dirname, 'public')))` at
`server.js:2764`, then named page routes, `/newsletter` (`2823`, leadership-only, no back
link), an `app.all('/api/*')` JSON 404 (`~2848`), then `app.get('*')` → `index.html`
(`2855`).

> **⚠ The catch-all swallows missing files, and this shapes several phases.** Any
> unmatched path returns `index.html` with **200 and `Content-Type: text/html`** — verified
> against staging 2026-08-17:
>
> | Path | Status | Content-Type |
> |---|---|---|
> | `/definitely-not-real` | 200 | `text/html` |
> | `/sw.js` | 200 | `text/html` |
> | `/manifest.webmanifest` | 200 | `text/html` |
> | `/icons/icon-192.png` | 200 | `text/html` |
> | `/api/not-real` | 404 | `application/json` ← correct, has its own handler |
>
> Three consequences. **(1)** A typo'd or missing icon/manifest path does not 404 — the
> browser gets HTML and fails while parsing it, which is a miserable thing to debug. Verify
> every asset added in Phase 1 by `Content-Type`, not by status code. **(2)** The `/sw.js`
> route must sit before *both* `express.static` and the catch-all, or it serves HTML that
> the browser rejects as a worker script. **(3)** Most important, for §8.1: a cache
> predicate of `response.ok && response.type === 'basic'` is **satisfied by
> HTML-for-a-missing-asset**, so a single typo could persist an HTML body under an asset
> URL on every member's device. The predicate must also check `Content-Type`.

**Boot migrations.** `server.js:75–~220` runs one `withDeadlockRetry`-wrapped statement of
`ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` on *every* startup (retry codes
`40P01`, `55P03`, `40001`). Convention: every schema change is twinned into `schema.sql`
(fresh DBs) *and* this block (existing DBs). Ordering caution from MEMORY.md §11: anything
that `REFERENCES` a table created in the same block must come after it (`documents` at
`170`, `tasks.document_id` after it at `~209`).

**Cron.** `server.js:2889` — runs unless `ENABLE_CRON === 'false'`. Daily 21:00 digest
(`notify-digests.js`), email flush every 5 minutes (`notify-emails.js`).

**Notifications (existing).** Table at `schema.sql:187` — `id, member_id, type, title, body,
link, read_at, emailed_at, created_at`; types `tasks_live`, `task_assigned`,
`completion_digest`, `task_escalated` (the CHECK is widened at `schema.sql:202–216` and
`server.js:145`). **Two insert sites, not one:** `notify(memberIds, {...})` at
`server.js:451` (used by task assign/escalate/go-live at `998, 1060, 1366, 1431, 1465,
1504`) and a direct `INSERT` in `notify-digests.js:32` (supervisor/leadership digests,
`link = 'supervisor'`). Routes `GET /api/notifications` (`2545`), `POST
/api/notifications/read` (`2566`). Client polls every 60 s (`index.html:3891`).
`notify-emails.js` is the pattern to copy for push: it selects `WHERE emailed_at IS NULL`,
sends, stamps `emailed_at`, and is idempotent and safe to re-run; `pool` is injectable.

**Browser APIs in play (mobile-relevant).**

- `localStorage` — `theme` and `onboarded` only (`index.html:3897`, `3909`, `4003`)
- `sessionStorage` — 0. `document.cookie` — 0 (session cookie is `httpOnly`)
- `window.open(..., '_blank')` — 3: `index.html:2765` (`/newsletter`), `2775` (`/export`),
  `6440` (open a document)
- `window.location.href` navigations to `/build` (`2745`), `/records` (`2448`, `2785`),
  `/roster` (`2797`) — all three pages carry a "Tracker" back link already
- Blob/CSV downloads — `index.html:6033`, `6191`; `window.print` — `export.html:157`
- File upload — one `<input type="file">` (`index.html:6408`), posted as a raw body
  (`express.raw`, `server.js:744`), stored as Postgres `bytea`
- `navigator.clipboard.writeText` — 3 sites
- **Not used at all:** canvas, FileReader, drag-and-drop, `navigator.share`,
  IntersectionObserver, matchMedia, geolocation, WebSocket, IndexedDB, service workers

**Routing.** None client-side. Views are `display:none`-toggled panes driven by
`switchView(btn)` (`index.html:5733`), which reads `btn.dataset.view` — one of `member`,
`supervisor`, `leadership`, `resources` — and already guards `leadership` for non-leaders.

**Tests.** 28 files in `test/`, 303 `test()` calls.
`node --env-file=.env.test --test --test-concurrency=1 test/*.test.js`. `.env.test` is
gitignored; needs a throwaway Postgres via `TEST_DATABASE_URL`. HTTP tests set
`process.env.DATABASE_URL = TEST_DATABASE_URL` and `ENABLE_CRON=false` before requiring
`server.js`, apply `schema.sql` via `test/helpers/db.js` (which uses `lib/db.js`'s
`makePool` — the one place the SSL heuristic also matches `rlwy.net`), and `app.listen(0)`.
Pattern file: `test/rollout-feedback-http.test.js`.

**Deploy (checked against the live Railway config 2026-08-17).** Project
`reasonable-curiosity` (`644edd3e-…`), one environment `production`, services
`squadron-task-tracker` (`b8403488-…`) + `Postgres`. Source `ggablin/squadron-task-tracker`
branch `master`, builder **Railpack** (not Nixpacks — Railpack resolves Node to `lts` unless
`engines.node` / `.nvmrc` / `RAILPACK_NODE_VERSION` pins it, which today means Node 24, the
same major as the local machine; it also injects `NODE_ENV=production` at runtime by
default), `npm start`, domain `108ces.up.railway.app` → port 8080. **`checkSuites: false`**
— Railway's "Wait for CI" is off, so a push to `master` deploys whether or not any check
passed. Variables set explicitly: `DATABASE_URL`, `SESSION_SECRET` — **no `NODE_ENV`
(builder-supplied only), no `ENABLE_CRON`, no `SMTP_*`**. No config files (`railway.json`,
`Dockerfile`, `Procfile`), no `.github/`, no CI. A separate project `squadron-tracker-test`
exists for throwaway databases.

---

## 3. Risk analysis

### Database risk: low

Schema changes across the whole plan: `CREATE TABLE IF NOT EXISTS push_subscriptions` and
`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS pushed_at` (both Phase 2, both additive,
no backfill, both using the exact idiom the boot block already runs). **Phases 1, 3, and 4
touch no schema.** Phase 4 replays through the existing idempotent upsert; the worst
realistic outcome is a checkbox showing a wrong state, fixable by re-toggling — not
corruption, not loss.

### The service worker is the one thing that is not cleanly reversible

Everything else rolls back with a git revert and a redeploy. A service worker does not: it
persists **on each member's device**, independent of the server, and (once it has a `fetch`
handler) intercepts every request on the origin. A bad one can pin members to a stale 418 KB
shell that an ordinary refresh will not fix — on personal phones, mid-drill, with no way to
reach them.

Mitigations, in order of importance:

1. **The kill switch is an environment variable, not a git artifact.** The `/sw.js` route
   serves a self-destructing script whenever `SW_MODE=kill` is set (§7.1). Rollback is a
   Railway variable flip from a phone — no PR, no revert, no merge, no archaeology. The
   self-destruct script lives permanently in the tree next to the real one.
2. **Rehearse the switch on staging before production ever has a caching worker** — with a
   caching worker installed on real devices, flip `SW_MODE=kill`, redeploy, open the app,
   confirm the device is clean (§12.8). The escape hatch must be proven before it is needed.
3. **Ship the caching worker (Phase 3) right after a drill weekend, never before one.** Buys
   a month of low-stakes soak. (This rule does not apply to the push-only worker in Phase 2
   — it has no `fetch` handler and cannot affect page loads.)
4. **Never intercept `/api/*` in the service worker.** Safety property, not a performance
   choice — see the shared-device hazard.
5. **Cache only what deserves it.** Only `200`, same-origin, `basic`-type responses go into
   the cache — never a Railway 502 page during a deploy, never a redirect.
6. **`Cache-Control: no-store` on `sw.js`.** Browsers already bypass the HTTP cache for the
   worker script itself by default, so this is belt-and-braces rather than load-bearing —
   but it costs nothing and removes one variable from an incident.

### Shared-device data leak (the security-relevant bug to avoid)

Caching a member's task list without clearing it on logout means that on a shared phone,
member B could see member A's cached data. `index.html:4068–4076` already carries a comment
about same-tab logout/login staleness — same hazard, larger blast radius once data is
persisted.

**Rule:** all cached member data lives in IndexedDB keyed by `memberId`, written by app code
(never by the service worker), and is wiped in `doLogout()` — which must wipe *even when the
server logout call fails* (offline). Reads guard on `memberId` mismatch. Queued writes are
only ever flushed under the session of the member who queued them.

### The queue and the wipe pull in opposite directions (Phase 4)

"Wipe local state on logout" and "keep unsynced check-offs on a 401 and retry after re-login"
conflict unless re-login is *not* implemented as logout-then-login. Phase 4 therefore
re-authenticates in place (the login overlay without `doLogout()`), checks that the returned
`memberId` matches the queue's, and warns before a deliberate logout that would discard
pending writes. Spelled out in §9.4–9.5 because rev. 1 left it implicit and it would have
been built wrong.

### iOS specifics that shape the UX, not just the code

- **Home-screen web apps on iOS do not share cookies or storage with Safari** (WebKit bug
  181849, still open). Every iPhone member will land on the login screen again after
  installing. The install copy must say so, or the install step reads as broken.
- **Web Push on iOS requires the app to be on the Home Screen** (16.4+), and the permission
  request must come from a user gesture. So the iPhone sequence is: install → open the icon
  → sign in again → tap "Turn on alerts". Four steps, each of which loses people if it is
  not spelled out.
- **Uninstalled Safari use is subject to WebKit's 7-day storage cap** (script-writable
  storage can be evicted after 7 days of Safari use without visiting the site; the
  `httpOnly` session cookie is not affected; installed home-screen apps effectively are not
  either). Offline caches are therefore reliable only for installed users — one more reason
  the install push matters — and Phase 4's queue must be flushed at every foreground, not
  left to sit.

### The real risk multiplier is the deploy setup

There is **no CI** and Railway's **Wait for CI is off**. The 28-file test suite only runs
when someone runs it locally, and merge to `master` auto-deploys straight into the
environment the whole squadron is working in. That is already true of every change to this
repo; it just matters more for a service worker. Phase 0 fixes both halves.

### Take a Railway Postgres backup before the Phase 2 migration

Cheap insurance even though the migration is additive.

---

## 4. Rejected approach: a second repo sharing the Railway database

The instinct (isolate the risk) is right, but this shape makes things worse. Three concrete
reasons, all specific to this codebase:

1. **It isn't a separate app.** The PWA work is `<head>` tags, a service worker, and edits
   *inside* `public/index.html` — the 7,882-line file that **is** the application. A second
   repo must carry a copy of it; every feature is then written twice and the copies drift.
   That is precisely the "maintenance burden goes up" outcome MEMORY.md §2 names as the
   binding constraint.
2. **Two services would race the boot migrations.** `server.js:75` runs the migration block
   unconditionally on every startup, already wrapped in `withDeadlockRetry` because that race
   is a known problem — `test/helpers/db.js` carries its own retry for the same reason. Two
   production services booting against one database turns a handled edge case into a routine
   one.
3. **Members would get duplicate emails/digests.** Cron is opt-*out* (`server.js:2889`).
   Same class of problem for the `uta_cycles_one_current` invariant and the
   completion-write gating: two writers, one set of DB-level guarantees.

**Do this instead — Phase 0.**

---

## 5. Phase 0 — Staging environment + CI + deploy gate (~0.5 day)

Not part of the mobile feature, but it is what makes the rest safe.

### 5.1 Railway staging environment

Create a `staging` environment in project `reasonable-curiosity` with **its own Postgres
service**, source branch `claude/web-to-mobile-app-jiuwzq`. Seed it with `seed.js`
(destructive — fine, it is a throwaway database; per MEMORY.md §8 run
`import-members.js` over it afterwards for a multi-shop fixture). Same repo, same code,
isolated data, and a real HTTPS URL to install the PWA from on a test phone — `localhost`
cannot do service-worker and push testing cleanly.

**Set these variables *before* the first deploy boots**, because cron registers at startup
and the email flush runs within five minutes:

| Var | Staging value | Why |
|---|---|---|
| `DATABASE_URL` | auto (staging Postgres) | |
| `SESSION_SECRET` | a *different* value from production | |
| `NODE_ENV` | `production` | exercises the `secure` cookie path |
| `ENABLE_CRON` | `false` | no digests, no email flush, no push catch-up from staging |
| `SMTP_HOST` etc. | **unset** | mail is a no-op |
| `SW_MODE` | unset (later: `kill` for the rehearsal) | §7.1 |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | **a staging keypair, not production's** | push has to be testable from staging (§12.4–5); rev. 1 said staging needs no keys and then asked staging to prove push works |

**Never clone production data into staging.** With real member emails and cron on, staging
would email the squadron; the seeded fixture has neither. The same caution applies to
Railway *PR environments* — they duplicate the base environment's variables, so if that
feature is ever switched on, `ENABLE_CRON=false` and no SMTP must be baked into whatever
they inherit from.

Cost: a second Node service plus a second Postgres is roughly the same footprint as
production, against a stated ceiling of ~$10/month total. Either tear the staging Postgres
down between phases, or house staging in the existing `squadron-tracker-test` project so
production's project stays clean — the plan is indifferent, the budget may not be.

> SSL heuristic (MEMORY.md §8): `server.js:32` enables Postgres SSL only when
> `DATABASE_URL` contains the substring `railway`; Railway's public proxy host is
> `*.rlwy.net`. In-environment (private) URLs are fine. `lib/db.js`'s `makePool` already
> matches both — a small follow-on is to make `server.js` use it.

### 5.2 CI

Add `.github/workflows/test.yml` (the repo has no `.github/` directory at all):

```yaml
name: test
on:
  pull_request:
  push:
    branches: [master]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: tracker_test
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s --health-timeout 5s --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: printf 'TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/tracker_test\n' > .env.test
      - run: npm test
```

Also add `"engines": { "node": "24.x" }` to `package.json` so CI, Railpack, and local runs
agree on a Node major (local is 24.14; Railpack's `lts` default resolves to 24 today but
will move on its own; `--env-file` in the test script needs ≥ 20.6). Cheap, and it removes
a whole class of "works on my machine."

### 5.2a Make the suite deterministic first — CI that flakes is worse than no CI

The very first CI run failed on `error: deadlock detected`, and a re-run of the **identical
commit** passed. `test/helpers/db.js` already documented the race: requiring `server.js`
fires its boot migration unawaited while the harness applies `schema.sql` on a second
connection, both take `AccessExclusiveLock` on the same tables, and Postgres kills one side.
Retrying made it survivable, not reliable — *"red on the roll of a dice."* CI makes it
**more** likely, not less: a local Postgres container is faster than Railway over a proxy,
so the two racers collide more often.

A flaky check cannot be a merge gate, so this is a prerequisite for §5.3, not a nicety. The
fix is a Postgres advisory lock (`lib/db.js`, `acquireMigrationLock`) held across both
writers, so they queue rather than collide. It is held on a dedicated connection because
advisory locks are session-scoped, and Postgres drops it automatically if the process dies,
so a crashed migration cannot wedge the next boot. `withDeadlockRetry` stays as a second
line of defence.

This also fixes the **production** case the original comment names: a Railway deploy briefly
runs two instances, and both execute the boot migration block unconditionally.

Covered by `test/migration-lock.test.js`, which asserts the mechanism (a second acquirer
blocks; releasing frees the lock in `pg_locks`; sequential acquires don't leak) rather than
the symptom — a test that only fails sometimes is worse than no test.

### 5.3 Make CI actually gate deploys

Two switches, both a minute each:

- **GitHub branch protection on `master`:** require the `test` check to pass before merge.
- **Railway → service `squadron-task-tracker` → Settings → "Wait for CI"** (currently
  `checkSuites: false`). With it on, a push to `master` puts the deployment in `WAITING`
  while the workflow runs and skips it if the workflow fails. Requirements per Railway's
  docs: a workflow in the repo with a `push` trigger for the branch (the YAML above has
  it), and accepting the updated GitHub App permissions when prompted. It applies to
  pushes — which is exactly the half branch protection alone does not cover.

### 5.4 Set `NODE_ENV=production` on the production service explicitly

Railpack injects it at runtime by default, so the `secure` cookie flag is on in production
today — but it is on because of a builder default, not because anyone set it. Set it
explicitly (the plan already does on staging) so a builder change or a future Dockerfile
can't silently drop it. Zero-risk hardening; do it alongside the staging setup.

---

## 6. Phase 1 — Installable shell, deep links, sticky session, comms (~1 day)

Delivers the home-screen icon and full-screen chrome. Also a **hard prerequisite for
Phase 2 on iPhone**: iOS only permits Web Push to a PWA the user has added to the Home
Screen (16.4+).

### 6.1 Icons — `public/icons/`

Nothing exists to start from. Generate from the design tokens in `public/design.css` (cream
`#fdfdfa` / terracotta / sage).

| File | Size | Purpose |
|---|---|---|
| `icon-192.png` | 192×192 | Android home screen; also the notification icon |
| `icon-512.png` | 512×512 | Android splash |
| `icon-maskable-512.png` | 512×512 | Android adaptive masking — **~20% safe-zone padding** |
| `apple-touch-icon-180.png` | 180×180 | iOS home screen (no transparency; iOS does not mask) |
| `favicon.ico` | 32×32 | Desktop browser tab |

**Design constraint:** a neutral typographic or geometric mark ("108" in the palette is the
recommendation), **not** official USAF or squadron insignia. Government emblems carry
authorization questions not worth inheriting; the app ships no imagery today so there is no
precedent to match. Sanity-check with squadron leadership only if unit branding on members'
home screens is actually wanted (Appendix A).

### 6.2 `public/manifest.webmanifest`

```json
{
  "id": "/",
  "name": "108th CES UTA Tracker",
  "short_name": "UTA Tracker",
  "description": "Per-person UTA task list for the 108th Civil Engineer Squadron.",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#fdfdfa",
  "theme_color": "#fdfdfa",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/icon-maskable-512.png", "sizes": "512x512",
      "type": "image/png", "purpose": "maskable" }
  ]
}
```

Notes: `id` gives Chrome a stable app identity if `start_url` ever changes. **No
`orientation` key** (rev. 1 had `portrait`) — the app has a real desktop layout at 768px+
and supervisors on tablets should get it. `start_url: "/"` is correct: unauthenticated hits
fall through `app.get('*')` to `index.html`, which renders the login state.
`express.static` serves `.webmanifest` with the right MIME type; nothing else needed.

### 6.3 `public/index.html` `<head>`

Current head is lines 3–18. Insert after the `<title>` (line 14), before the `design.css`
link (line 18) — so the early theme script at lines 6–13 keeps running first and the
FOUC-avoidance behaviour is unchanged.

```html
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<meta name="theme-color" content="#fdfdfa" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1a1816" media="(prefers-color-scheme: dark)">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="UTA Tracker">
```

The icon / `theme-color` lines (not the manifest, not the `*-capable` metas) also go into
`build.html`, `records.html`, `roster.html`, and `export.html` so the tab icon is consistent
when a leader lands on one directly. Those pages need **nothing else** from this plan — no
service worker, no offline, no push. Also add `viewport-fit=cover` to `export.html`, the
one page missing it (it has the only `@media print` block — check the print layout after).

### 6.4 Standalone-mode escapes

In standalone mode there is no browser chrome to return from. Of the three
`window.open(..., '_blank')` calls:

- `index.html:2765` → `/newsletter`: the rendered newsletter has no way back. Add a small
  fixed "← Tracker" link to `newsletter/render.js`'s page shell (leadership only sees this).
- `index.html:2775` → `/export`: **already has** "← Back to app" (`export.html:156`). No
  change.
- `index.html:6440` → open a document: keep `_blank` (opening a PDF externally is correct)
  and verify on both platforms that the return path works (Android opens a Custom Tab with a
  close control; confirm what iOS standalone does).

`/build`, `/records`, `/roster` navigate in-window and already carry a "Tracker" back link.

### 6.5 Install affordance — onboarding *and* a persistent home

Chrome fires `beforeinstallprompt` without a service worker now (Chrome 108+ on Android),
but only after its engagement heuristics are met (the user has tapped the page and spent
~30 seconds on it, at any time). So the prompt often is *not* available on the very first
open — the install button must not live only in the one-time onboarding hint.

- **Persistent home:** a "UTA Tracker on your phone" card in the Resources view
  (`#view-resources`, `index.html:2826`, next to the existing tool cards) with three states:
  installed ("Installed ✓ — Reload app" — the reload button is the only recovery a stuck
  standalone iOS app has, since there is no address bar), installable ("Install app" → calls
  the stashed `beforeinstallprompt`), or iOS-not-installed (static instructions).
- **Onboarding:** reuse the existing hint (`syncOnboardHint`, `index.html:3905`) to point at
  that card once, with the same platform copy.
- **Detection:** `matchMedia('(display-mode: standalone)').matches || navigator.standalone
  === true` for "installed"; `/iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)` for iOS. Note
  matchMedia is currently unused in the codebase — this is its first use.
- **iOS copy must include the re-login step:** "Tap Share → Add to Home Screen. Then open
  the new icon and sign in once more — the app keeps its own sign-in, separate from Safari."
  Same share sheet in Chrome/Edge on iOS, so the copy needs no browser branching.

### 6.6 `?view=` deep link (moved up from Phase 4)

A handful of lines, and it makes TeamApp and newsletter links land a member on their list
long before push exists. Right after `showApp()` in `init()`:

```js
const VIEWS = ['member', 'supervisor', 'leadership', 'resources'];
function applyDeepLink(url = new URL(location.href)) {
  const wanted = url.searchParams.get('view');
  if (VIEWS.includes(wanted)) switchView({ dataset: { view: wanted } });   // same shape onNotifClick already uses
  if (wanted) history.replaceState(null, '', location.pathname);           // don't re-apply on reload
}
```

`switchView()` already downgrades `leadership` for non-leaders. `notifications.link` values
(`'member'`, `'supervisor'`) are the same vocabulary, so Phase 2's notification taps reuse
this without translation.

### 6.7 Make the session rolling

`server.js:44–56`, add `rolling: true` to the session options. Today the browser cookie
expires 30 days after login regardless of use (the store row is touched, the cookie is not
re-sent), which on a monthly-drill cadence means the installed icon opens to a login screen
for many members every UTA. With `rolling: true` an active member never re-authenticates;
`connect-pg-simple` already supports `touch`. One line; the largest single contributor to
"feels like an app" per unit of effort in this plan.

### 6.8 Comms deliverable

The plan is engineering-only without this, and adoption is the binding constraint. Ship
with Phase 1:

- A **TeamApp News post** (chat scrolls; News persists) titled "The UTA Tracker is now a
  phone app," with two short platform blocks — Android: Chrome menu → *Install app* / *Add
  to Home screen*; iPhone: Safari Share → *Add to Home Screen* → open the icon → sign in
  again — and one line about what is coming ("phone alerts next month").
- The same two blocks as one slide in the next newsletter.
- Both link to `https://108ces.up.railway.app/?view=member`.

Phase 2 ships a follow-up post ("turn on alerts: open the bell → *Turn on phone alerts*").

---

## 7. Phase 2 — Real push notifications, with a push-only service worker (~3 days)

Two-thirds of the infrastructure already exists. Only the transport is missing — and,
per §1, the *only* out-of-app transport that would currently work in production.

### 7.1 Serving `sw.js`: versioning and the kill switch

There is no bundler, so nothing is content-hashed. Serve the worker from an Express route
inserted **immediately before** `express.static` at `server.js:2764` so it wins over the
static handler. Keep the source **outside `public/`** so there is exactly one way it can be
served:

```
lib/sw/sw.js        — the real worker (Phase 2: push handlers only; Phase 3 adds fetch)
lib/sw/sw-kill.js   — the self-destruct script, permanent
```

```js
// Served rather than static so (a) the cache version rotates on every deploy without a
// build step, (b) the no-store header is guaranteed, and (c) SW_MODE=kill can swap in the
// self-destruct script from a Railway variable with no code change. Must precede
// express.static.
const SW_SRC  = fs.readFileSync(path.join(__dirname, 'lib', 'sw', 'sw.js'), 'utf8');
const SW_KILL = fs.readFileSync(path.join(__dirname, 'lib', 'sw', 'sw-kill.js'), 'utf8');
const SW_VERSION = process.env.RAILWAY_GIT_COMMIT_SHA || String(Date.now());  // dev: rotates per boot
app.get('/sw.js', (req, res) => {
  const body = process.env.SW_MODE === 'kill' ? SW_KILL : SW_SRC;
  res.set({
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  res.send(`const VERSION = ${JSON.stringify(SW_VERSION)};\n${body}`);
});
```

Railway sets `RAILWAY_GIT_COMMIT_SHA` at runtime (confirmed in Railway's docs), so every
deploy is a byte-different worker and every client updates on next open. Flipping `SW_MODE`
triggers a redeploy on Railway, which is exactly what you want.

`lib/sw/sw-kill.js` — the well-known self-destroying worker, plus cache deletion (which
`unregister()` alone does not do):

```js
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.map(k => caches.delete(k)));
  await self.registration.unregister();
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(c => c.navigate(c.url));
})()));
```

Register from `index.html` behind `'serviceWorker' in navigator`, after `init()` has run:
`navigator.serviceWorker.register('/sw.js')`. Also listen for `controllerchange` and do
nothing (log only) — do **not** auto-reload the page on update; a member mid-check-off must
not lose the page under them.

### 7.2 Dependency + keys

Add `web-push` to `package.json` (the first new dependency in a while; the tree is
deliberately small at 10). Generate two VAPID keypairs — one production, one staging — and
store them as Railway variables:

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT` (`mailto:` for the maintainer)

Push is a no-op when `VAPID_PUBLIC_KEY` is unset, mirroring how email is a no-op when
`SMTP_HOST` is unset. Local dev and CI run without keys; **staging runs with its own**.

### 7.3 Schema

Append to `schema.sql` (after the `session` table, line 294) **and** twin into the boot
block in `server.js` at the end of the same `withDeadlockRetry` statement (after the
`tasks.document_id` ALTER, ~line 209), where `members` and `notifications` are guaranteed
to exist:

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
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS pushed_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_notifications_unpushed ON notifications (pushed_at) WHERE pushed_at IS NULL;
```

`endpoint UNIQUE` plus `ON CONFLICT (endpoint) DO UPDATE SET member_id = EXCLUDED.member_id,
p256dh = …, auth = …` makes re-subscription idempotent — browsers rotate endpoints and the
same device re-registers; if a different member logs in on the same device, the row moves
to them. `pushed_at` mirrors `emailed_at`, and its partial index mirrors
`idx_notifications_unemailed` (`schema.sql:200`).

### 7.4 Routes

All behind `requireAuth`, next to the existing `/api/notifications` routes (`server.js:2545`):

- `GET  /api/push/vapid-key` → `{ key: process.env.VAPID_PUBLIC_KEY || null }` (`null` →
  the client hides the toggle)
- `POST /api/push/subscribe` — body is `PushSubscription.toJSON()` (`{ endpoint, keys:
  { p256dh, auth } }`); validate the three strings; upsert on `endpoint` with
  `member_id = req.session.memberId`, `user_agent = req.get('user-agent')`
- `POST /api/push/unsubscribe` — `{ endpoint }`; `DELETE … WHERE endpoint = $1 AND
  member_id = $2`

### 7.5 Send path — `lib/push.js`, modelled on `notify-emails.js`

Rev. 1 hooked `web-push` directly into `notify()` (`server.js:451`) as fire-and-forget. That
misses the second insert site (`notify-digests.js:32`), puts a third-party network call in
the request path (its "highest-consequence line"), and diverges from how the email channel
already works. Instead, copy the email flush exactly:

```js
// lib/push.js
const webpush = require('web-push');
const PUSH_TYPES = ['tasks_live', 'task_assigned', 'task_escalated'];   // completion_digest stays email-only (Appendix A)
const enabled = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
let vapidConfigured = false;
function ensureVapid() {   // lazy, so require-order and test env setup never matter
  if (vapidConfigured) return;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  vapidConfigured = true;
}

// pool and send are injectable (tests pass a stub sender). Idempotent, safe to re-run.
async function flushPush({ pool, send = (sub, payload) => webpush.sendNotification(sub, payload) }) {
  if (!enabled()) return { sent: 0, pruned: 0, skipped: 'no VAPID keys' };
  ensureVapid();
  const { rows } = await pool.query(`
    SELECT n.id, n.title, n.body, n.link, s.id AS sub_id, s.endpoint, s.p256dh, s.auth
    FROM notifications n
    JOIN push_subscriptions s ON s.member_id = n.member_id
    WHERE n.pushed_at IS NULL
      AND n.type = ANY($1)
      AND n.created_at >= s.created_at                    -- a new subscriber never gets history
      AND n.created_at > NOW() - INTERVAL '24 hours'      -- and nothing stale ever goes out
    ORDER BY n.created_at
    LIMIT 500`, [PUSH_TYPES]);
  let sent = 0, pruned = 0;
  const done = new Set();
  for (const r of rows) {
    const payload = JSON.stringify({ title: r.title, body: r.body, url: r.link ? `/?view=${r.link}` : '/', tag: `n-${r.id}` });
    try { await send({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, payload); sent++; }
    catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) { await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [r.sub_id]); pruned++; }
      else console.error('push send failed:', r.endpoint.slice(0, 40), err.statusCode || err.message);
    }
    done.add(r.id);
  }
  if (done.size) await pool.query('UPDATE notifications SET pushed_at = NOW() WHERE id = ANY($1)', [[...done]]);
  // Keep the partial index small: anything older than the window will never be pushed.
  await pool.query(`UPDATE notifications SET pushed_at = created_at WHERE pushed_at IS NULL AND created_at <= NOW() - INTERVAL '24 hours'`);
  return { sent, pruned };
}
module.exports = { flushPush, PUSH_TYPES };
```

Two triggers, so it is immediate *and* self-healing:

1. In `notify()` (`server.js:451`), after the INSERT succeeds:
   `setImmediate(() => flushPush({ pool }).catch(e => console.error('push flush failed:', e.message)));`
   — nothing in the request path awaits it, and a throwing `web-push` cannot break
   task-assignment flows.
2. In the cron block (`server.js:2889`), `cron.schedule('* * * * *', …flushPush…)` as
   catch-up — covers the digest insert site (if `completion_digest` is ever added to
   `PUSH_TYPES`), and any kick that failed.

Dead subscriptions are pruned on `404`/`410` inside the same loop. Endpoints expire
routinely; without pruning the table accretes garbage and every send burns time on it.

### 7.6 Client

In `lib/sw/sw.js` (Phase 2 content — no `fetch` handler yet):

```js
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  const d = e.data ? e.data.json() : {};
  // Always show something: Chrome penalises silent pushes and iOS requires a visible notification.
  e.waitUntil(self.registration.showNotification(d.title || 'UTA Tracker', {
    body: d.body || '', icon: '/icons/icon-192.png', tag: d.tag, data: { url: d.url || '/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const w = wins.find(c => new URL(c.url).origin === self.location.origin);
    if (w) { await w.focus(); w.postMessage({ type: 'open-view', url }); }   // no navigate(): keeps the member's page
    else await self.clients.openWindow(url);
  })());
});
```

In `index.html`:

- `navigator.serviceWorker.addEventListener('message', e => { if (e.data?.type === 'open-view') applyDeepLink(new URL(e.data.url)); })`
  — reuses §6.6.
- A **"Phone alerts" toggle inside the notification panel** (`#notif-panel`,
  `index.html:3688`), next to the bell everyone already knows. Hidden when
  `/api/push/vapid-key` returns `null`; on iOS-not-installed it renders as text: "Add this
  app to your Home Screen first to turn on alerts."
- Permission is requested **only inside the toggle's tap handler** — never on load. An
  unprompted dialog is the fastest route to a permanent "blocked" that no code can undo.
  On grant: `reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey:
  urlBase64ToUint8Array(key) })` → `POST /api/push/subscribe` with `sub.toJSON()`.
- On every app load where `Notification.permission === 'granted'`, re-POST the current
  subscription (endpoints rotate; the upsert makes this free).
- Toggle off → `sub.unsubscribe()` + `POST /api/push/unsubscribe`.

### 7.7 Platform reality to communicate to members

- **Android/Chrome:** push works for an installed *or* browser-tab PWA.
- **iPhone:** push requires Add to Home Screen first, iOS 16.4+, then sign in again inside
  the installed app, then the toggle. No exceptions. The Phase 1 card and the Phase 2 comms
  post carry this copy verbatim.

### 7.8 Tests — `test/push-http.test.js`

Following `test/rollout-feedback-http.test.js`:

- `POST /api/push/subscribe` twice with the same endpoint → one row; as a different member →
  the row's `member_id` moves.
- `POST /api/push/unsubscribe` deletes only the caller's row.
- `GET /api/push/vapid-key` → `{ key: null }` when unset (CI has no keys).
- `flushPush({ pool, send: stub })`: sends one payload per (notification × subscription) for
  `PUSH_TYPES` only; stamps `pushed_at`; skips `completion_digest`; skips notifications older
  than the subscription; deletes the subscription when the stub throws `{ statusCode: 410 }`;
  returns `{ skipped: 'no VAPID keys' }` when keys are unset. For the enabled cases, set
  `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` from
  `webpush.generateVAPIDKeys()` at the top of the test file (real keys — `setVapidDetails`
  validates them, and `ensureVapid()` runs lazily so order doesn't matter).

---

## 8. Phase 3 — Caching service worker + offline reads (~2–3 days)

Ship **right after a drill weekend.** Rehearse the kill switch on staging first (§12.8).

### 8.1 `lib/sw/sw.js` gains a `fetch` handler

Strategy, keyed on the fact that the app is auth-gated and the data is live:

| Request | Strategy | Why |
|---|---|---|
| Navigation to `/` | **Network-first with a 4 s timeout**, cache as fallback (`ignoreSearch`) | Never cache-first: a stale 418 KB shell behind a session wall is the classic footgun. The timeout is for the real drill condition — one bar, requests hang — not just clean offline. `ignoreSearch` so `/?view=member` falls back to the cached `/`. |
| Any other navigation (`/build`, `/records`, `/roster`, `/export`, `/newsletter`, `/task-builder-mockup`) | **Not intercepted** | Leadership desktop tools, out of scope for offline |
| `/api/*` | **Not intercepted** | Safety property (§3) |
| `fonts/*.woff2`, `/icons/*`, `/manifest.webmanifest`, `/favicon.ico` | Cache-first | Immutable in practice |
| `design.css`, `ui.js`, `member-browser.js`, `offline.js` | Stale-while-revalidate | Change occasionally; not content-hashed |
| Anything else (non-GET, cross-origin, document downloads) | **Not intercepted** | |

Rules inside the handler: cache only `response.ok && response.type === 'basic'` **and a
`Content-Type` matching what was asked for** — see the catch-all warning in §2, which makes
the first two conditions true for a missing asset that came back as `index.html`. Without
the content-type check a single typo'd path persists an HTML body under an asset URL on
every member's device, which is precisely the failure the kill switch exists for and is not
worth spending. Cache names `shell-${VERSION}` / `assets-${VERSION}`; on `activate`, delete
every cache not matching the current `VERSION` then `clients.claim()`; precache `/`, the
four SWR files, the manifest and `icon-192` on `install` using `cache: 'reload'` requests,
and **fail the install if any precache response is not the expected type** — a failed
install leaves the old worker in place, which is the safe outcome.

### 8.2 `public/offline.js` — identity + task cache

New file, loaded from `index.html` alongside `ui.js`. Small IndexedDB wrapper (`uta-tracker`
DB) with stores `identity` (one record: `{ member, fetchedAt }`), `taskCache` (key
`memberId`: `{ tasks, fetchedAt }`), and — Phase 4 — `pendingWrites`. Written by app code
only, never by the service worker.

**The offline boot branch — the piece rev. 1 was missing.** `init()` becomes:

```js
async function init() {
  let res;
  try { res = await fetchWithTimeout('/api/auth/me', 8000); }
  catch {                                             // network failure or timeout — NOT a 401
    const cached = await offlineStore.getIdentity();
    if (cached) { currentMember = cached.member; setOffline(true, cached.fetchedAt); showApp(); }
    else showLogin();
    return;
  }
  if (res.ok) { currentMember = await res.json(); await offlineStore.putIdentity(currentMember); showApp(); }
  else showLogin();                                   // 401: session really is gone
}
```

`fetchWithTimeout` is an `AbortController` wrapper used by `init()`, `loadTasks()`, and
`cycleTask()` — the app's own requests must give up promptly on a hanging network, or
"offline" never triggers at drill.

Then:

- `loadTasks()`: after each successful `/api/tasks`,
  `offlineStore.putTaskCache(currentMember.id, tasks)`. On the cold path, **add the missing
  catch**: read `taskCache` for
  `currentMember.id`, render it, and call `setOffline(true, fetchedAt)`; if there is no
  cache, render the existing empty-state copy with an offline explanation instead of a
  skeleton forever.
- `setOffline(on, since)`: a persistent inline banner ("Offline — showing your tasks from
  {relative time}"), a global flag that makes `showToast(_, 'error')` a no-op while offline
  (every fan-out call in `showApp()` fails at once otherwise), and `startNotifPolling()` /
  `loadNotifications()` failures stay silent. Listen for `online` → clear the state and
  `loadTasks(true)`; `offline` → set it.
- **Wipe `identity`, `taskCache`, and `pendingWrites` in `doLogout()`** — and make
  `doLogout()` offline-safe: `try { await fetchWithTimeout('/api/auth/logout', 5000, {
  method: 'POST' }) } catch {}` before the local wipe, so a logout with no signal still
  clears the device.
- Read-time guard: `taskCache` for a `memberId` other than `currentMember.id` is ignored
  and deleted — belt and braces against the same-tab logout/login case at
  `index.html:4068`.

**Scope offline strictly to the member's own task list.** Supervisor rollups, attendance,
roster, `/build`, and `/records` stay online-only. (Rev. 1 claimed this also closes the
MEMORY.md §10 "refetches on every tab switch" item; it doesn't by itself — the in-memory
SWR in `loadTasks()` already handles most of that — so the claim is dropped.)

---

## 9. Phase 4 — Offline check-off with sync-later (~3–4 days, **gated**)

**Gate:** ship this only after Phase 3 has been live through a drill and members (or
supervisors watching completion) actually report wanting to check off with no signal.
"Works offline" is met for reading by Phase 3; this phase is the expensive part of the
goal and rev. 1 under-specified its hardest parts. **The server needs one additive change**
(§9.4); the write itself remains the existing idempotent upsert. **Background Sync is
dropped** from scope: it forces a second, service-worker-side flush implementation with all
of §9.4's semantics and no UI, iOS doesn't support it, and the app-load/foreground flush
below is the path every device takes anyway.

### 9.1 Queue

IndexedDB store `pendingWrites`, keyed by `taskId`, so repeated toggles of one task collapse
to one pending write:

```js
{ taskId, memberId, title, state, note, queuedAt }   // title kept so a 404 can still be named to the member
```

### 9.2 Intercept, overlay, and the pending state

Wrap `cycleTask()` (`index.html:4430`): on a **network** failure (`TypeError` or timeout —
not an HTTP error, which keeps the existing revert path) → enqueue, keep the optimistic
UI, mark the row with a distinct "pending sync" state (a visual on the row, not a toast, so
the member can see at a glance which check-offs have not reached the server).

**Overlay on every render.** Whenever `currentTasks` is populated — from the network or from
`taskCache` — apply `applyPending(tasks, pending)` before `buildTasks()`, so a reload while
offline (or a refetch that lands before the flush) never shows a check-off "undone."

### 9.3 Flush

`flushQueue()` runs on: the `online` event, `visibilitychange` → visible, and app load once
identity is confirmed. Order on reconnect is **flush first, then `loadTasks(true)`**. Only
writes whose `memberId === currentMember.id` are sent; any others are dropped with a
notice. iOS has no background execution here, so member-facing copy says "syncs when you
open the app," never "syncs in the background."

### 9.4 Response handling — the edge case that matters most

A member who checks tasks off offline on Sunday and syncs after the cycle closes **must be
told their check-offs were rejected, by name** — not have them vanish from the queue. The
handler can answer in more ways than rev. 1 listed (`server.js:904–956`), and matching prose
strings is brittle, so:

**Server (additive):** add a machine-readable `code` next to each `error` in `PUT
/api/tasks/:id`: `NOT_FOUND` (404), `INFORMATIONAL` (400), `OUT_OF_SHOP` and `FORBIDDEN`
(403), `NOT_LIVE` (403). No behaviour change; existing clients ignore the field.

**Client — a pure function, unit-tested:**

```js
// status is the HTTP status, or 0 when fetch threw (no network / timeout).
function classify(status, body) {
  if (status >= 200 && status < 300) return 'done';
  if (status === 401) return 'reauth';
  if (status === 403 && body?.code === 'NOT_LIVE') return 'reject:cycle-closed';
  if (status === 404) return 'reject:gone';            // task deleted or renumbered (import-tasks.js is a full replace)
  if (status === 400) return 'reject:informational';   // shouldn't happen: informational rows render without a checkbox
  if (status === 403) return 'reject:forbidden';
  if (status === 0 || status >= 500) return 'retry';   // network / server: keep, back off
  return 'reject:other';
}
```

- `done` → delete from queue, clear the pending marker.
- `retry` → keep; next trigger.
- `reject:*` → delete from queue, add to a `rejections` list rendered as a **persistent,
  dismissible notice naming the tasks** ("These check-offs didn't sync because the cycle
  closed: …"), and revert the row.
- `reauth` → stop flushing; open the login overlay **in place** (`showLogin()`, which only
  toggles overlays — *not* `doLogout()`, which wipes). After `doLogin()` → `showApp()`, if
  the new `memberId` matches the queue's, flush; if not, discard the queue with a notice.

### 9.5 Logout guard

If `pendingWrites` is non-empty when the member taps log out: `uiConfirm` — "You have N
check-offs that haven't synced yet. Log out anyway? They will be lost." Yes → wipe as
normal.

### 9.6 Conflict policy

Last-write-wins is acceptable for a drill checklist. Send `queuedAt` in the request body so
an audit trail *could* reflect when the member actually tapped (the server ignores unknown
fields today; wiring it into the stored record is a small follow-on).

### 9.7 Tests — `test/offline-queue.test.js`

Structure `public/offline.js` so `classify()`, `applyPending()`, and the enqueue-collapse
logic are pure functions exported under `if (typeof module !== 'undefined') module.exports =
…` and testable under `node:test` without a browser: the full `classify` table above;
`applyPending` overlays state and marks rows pending; enqueueing the same `taskId` twice
yields one record with the later state. This is the most logic-dense client code in the
plan and the repo has zero client-side tests today.

---

## 10. Files touched

### New

| Path | Phase | Purpose |
|---|---|---|
| `.github/workflows/test.yml` | 0 | CI |
| `test/migration-lock.test.js` | 0 | Proves the advisory lock serializes schema writers (§5.2a) |
| `public/manifest.webmanifest` | 1 | PWA manifest |
| `public/icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon-180.png` | 1 | Icons |
| `public/favicon.ico` | 1 | Desktop tab |
| `lib/sw/sw.js` | 2, 3 | Service worker source (push handlers in 2, fetch handler in 3) |
| `lib/sw/sw-kill.js` | 2 | Self-destruct script, permanent |
| `lib/push.js` | 2 | `flushPush()` + pruning |
| `test/push-http.test.js` | 2 | Push routes + flush |
| `public/offline.js` | 3, 4 | IndexedDB identity/task cache; pending-write queue |
| `test/offline-queue.test.js` | 4 | `classify` / `applyPending` / collapse |

### Modified

| Path | Change |
|---|---|
| `package.json` | `engines.node` (0); `web-push` (2) |
| `lib/db.js` | `acquireMigrationLock` + `MIGRATION_LOCK_KEY` (0, §5.2a) |
| `test/helpers/db.js` | `applySchema` takes the migration lock (0, §5.2a) |
| `server.js` | `rolling: true` in the session options at `:44–56` (1); `/sw.js` route before `express.static` at `:2764` (2); push routes near `:2545` (2); `push_subscriptions` + `pushed_at` at the end of the boot-migration statement, ~`:209` (2); `notify()` at `:451` kicks `flushPush` (2); cron catch-up at `:2889` (2); `code` fields in `PUT /api/tasks/:id` at `:904–956` (4) |
| `schema.sql` | `push_subscriptions`, `pushed_at`, indexes (2) |
| `public/index.html` | `<head>` block (1); Resources install card + onboarding pointer (1); `applyDeepLink` (1); SW registration + `message` listener (2); alerts toggle in `#notif-panel` (2); `offline.js` include, `init()` offline branch, `fetchWithTimeout`, `loadTasks` cold-path catch, `setOffline`, `doLogout` wipe + offline-safety (3); `cycleTask` wrap, overlay, flush, rejections notice, logout guard (4) |
| `newsletter/render.js` | "← Tracker" link in the page shell (1) |
| `public/build.html`, `records.html`, `roster.html`, `export.html` | Icon/`theme-color` `<head>` additions only; `viewport-fit=cover` on `export.html` (1) |
| `MEMORY.md` | New section per phase — it is the handoff doc; §8 (env vars: `NODE_ENV`, `SW_MODE`, `VAPID_*`, staging), §10, §12 need updating |

Railway (not files): staging environment + variables (0); "Wait for CI" on (0);
`NODE_ENV=production` on production (0/1); `VAPID_*` on production (2); `SW_MODE` only ever
set to `kill`, then removed.

---

## 11. Rollout order to production

1. **Phase 0** — staging, CI, the migration-lock fix that makes the suite deterministic
   (§5.2a — a prerequisite for Wait-for-CI and branch protection, both of which are useless
   against a flaky check), then Wait-for-CI, `engines`, `NODE_ENV`. Nothing user-visible.
2. **Phase 1** — manifest + icons + head meta + install card + deep link + rolling session +
   comms post. Additive; gets the icon onto home screens and proves the deploy path.
3. **Phase 2** — push-only worker + `lib/push.js` + toggle, after the backup. Comms
   follow-up ("turn on alerts"). Any week; no fetch handler means no soak requirement.
4. **Phase 3** — caching worker + offline reads, deployed **right after a drill weekend**,
   after the kill-switch rehearsal on staging.
5. **Phase 4** — only if the gate in §9 is met, and only after Phase 3 has been through a
   drill.

Each step is independently revertable; step 2 delivers the most-wanted goal and step 3 the
one that changes behaviour most, before any caching risk is taken on.

---

## 12. Verification

1. **`npm test`** stays green locally and in CI (`--test-concurrency=1`, shared DB). New
   files: `test/push-http.test.js` (Phase 2), `test/offline-queue.test.js` (Phase 4).
2. **Installability** — Chrome DevTools → Application → *Manifest* shows no installability
   warnings and the icons render; *Service Workers* shows the worker and its `VERSION`.
   (Lighthouse's PWA category was removed in Lighthouse 12, May 2024 — it is not a check
   any more.)
3. **Real Android device:** install from staging; standalone chrome (no address bar);
   `?view=member` link from a chat message lands on the task list; the Resources card
   reports "Installed"; reload button works.
4. **Real iPhone:** Add to Home Screen from Safari; open the icon; **confirm the login
   screen appears (storage is separate) and that the copy said it would**; sign in; the
   session persists across days (rolling); alerts toggle is hidden/explained in Safari and
   present in the installed app.
5. **Push (Phase 2), both devices, from staging with staging keys:** toggle on → row in
   `push_subscriptions`; assign a task in `/build` → notification arrives; tap → app opens
   or focuses on the linked view; toggle off → row gone; delete the app on the phone → next
   flush prunes the row (410). On iOS, verify push does **not** work from Safari and does
   from the installed app.
6. **Offline reads (Phase 3):** load the app online, airplane mode, force-quit, reopen → task
   list renders with the offline banner and a relative time; the notification bell doesn't
   error; log out in airplane mode → local data gone; sign in as another member online →
   never sees the first member's cache (repeat same-tab without a reload).
7. **Slow-network drill:** throttle to 2G/high latency in DevTools (and, on a device, one
   bar) — the shell and task list appear from cache within the timeout rather than hanging.
8. **Kill-switch drill (before Phase 3 goes to production):** with the caching worker
   installed on both devices from staging, set `SW_MODE=kill` on staging, redeploy, open
   the app once → DevTools/Safari show no registered worker and no caches; unset the
   variable, redeploy, open → the worker reinstalls cleanly. **Rehearse this before you
   need it.**
9. **Queue (Phase 4):** airplane mode; check three tasks off; kill and reopen → still shown
   checked and pending; restore signal → they flush and the server matches; close the cycle
   in `/build`, queue one offline, sync → explicit rejection notice naming the task; expire
   the session (delete the row) and sync → in-place login, then flush; log out with pending
   writes → confirmation dialog.
10. **Deploy check** per MEMORY.md §8: `/` → 200, `/api/auth/me` → 401, `/sw.js` → 200 with
    `Cache-Control: no-store` and the current commit SHA in line 1.

---

## Appendix A — Open questions

- **Icon design.** Recommendation: a typographic "108" or a simple geometric form in the
  terracotta/sage palette; no official insignia unless leadership specifically wants it.
- **Should `completion_digest` push?** The digest is a supervisor/leadership summary that
  arrives at 21:00; the plan defaults it to email-only (`PUSH_TYPES` in `lib/push.js`) so
  supervisors are not buzzed nightly. Adding it is one array entry.
- **Does Phase 4 happen at all?** Decided after Phase 3 has been through a drill (§9 gate).
- **Email.** Out of scope, but noted: the production service has no SMTP configured, so
  every notification since launch has `emailed_at IS NULL`. If SMTP is ever configured, run
  `UPDATE notifications SET emailed_at = created_at WHERE emailed_at IS NULL` first, or the
  next flush emails the entire backlog 200 at a time.

## Appendix B — The App Store path, and why it is deferred

Not among the stated goals. Recorded because maintenance appetite was left open.

**Capacitor wrapper (~1–2 additional weeks, plus permanent release burden).** A thin
remote-URL shell is exactly what Apple Guideline 4.2 (minimum functionality) rejects. The
real path — bundled assets calling the Railway API — moves the webview to
`capacitor://localhost` / `https://localhost`, so every `/api/*` call becomes cross-origin
and the session cookie stops working (CORS + `sameSite: 'none'` against WKWebView's
third-party-cookie rules, or a bearer-token branch in `requireAuth` — small *because* auth
is centralised at `server.js:281`), plus an API base-URL shim for the 73 hardcoded
`fetch('/api/…')` calls, native plugins for the document/CSV download paths, and clipboard
gesture rules on iOS. Then $99/yr Apple + $25 Google, certificates, a public listing with
privacy policy and support URL, a reviewer demo account against real member data, review
latency on every release, and the loss of merge-to-`master`-and-it's-live. If a store
presence is ever *required*, Apple unlisted distribution and Google Play internal testing
are the right fit for a unit-internal tool.

**Native / React Native / Flutter rewrite: months, not worth it.** The client is 13,400
lines of hand-written framework-less HTML/CSS/JS with no components to port; reuse is
effectively zero, against the stated constraint that maintenance burden must go *down*.

## Appendix C — What changed from the 2026-08-15 plan, and why

| Change | Reason |
|---|---|
| Push (old Phase 4) is now Phase 2, ahead of the caching worker; the "soak" rule now applies only to the caching worker | A push-only worker has no `fetch` handler and cannot cause the stale-shell failure the soak guards against; production has no SMTP, so push is the first out-of-app channel that would work; adoption is the binding constraint |
| Offline check-off (old Phase 3) is now Phase 4 and gated on evidence; Background Sync dropped | Most expensive phase, narrowest gain; Background Sync doubles the flush implementation and iOS lacks it |
| Kill switch is `SW_MODE=kill` on the `/sw.js` route; SW source moved to `lib/sw/`; the production "kill-switch-first" deploy step is gone, replaced by a staging rehearsal | Rollback becomes a variable flip; deploying a self-destruct to a fleet with no worker proved nothing |
| Offline boot branch, cached identity, `fetchWithTimeout`, `loadTasks` cold-path catch, offline state/toast suppression, offline-safe `doLogout` added to Phase 3 | `init()` sends any thrown fetch to the login screen; the cold path has no catch; `doLogout` throws offline — none of which rev. 1 addressed, so offline reads could not have worked as written |
| Queue lifecycle spelled out: overlay on render, flush-before-refetch, memberId check, in-place re-auth, logout guard, `404`/other-`403` handling, `code` field from the server, pure-function tests | Rev. 1's status table missed 404 and two 403s, matched a prose string, and its 401 path would have wiped the queue |
| Push delivery is a `pushed_at` flush job kicked from `notify()` (mirrors `notify-emails.js`), not a fire-and-forget call inside `notify()`; digest insert site acknowledged; history/staleness guards | Two insert sites, not one; keeps `web-push` out of the request path; reuses a proven idiom; a new subscriber must not receive the backlog |
| Staging gets its own VAPID keys; env-var ordering before first boot; never clone prod data; cost note | Rev. 1 said staging needs no keys and then asked staging to verify push; cron + inherited variables can email the squadron |
| Railway "Wait for CI", branch protection, `engines.node`, explicit `NODE_ENV=production`, builder corrected to Railpack | CI that doesn't gate is decoration; the live config shows `checkSuites: false`, and `NODE_ENV` is only present because Railpack injects it |
| `rolling: true`; `?view=` deep link moved to Phase 1; persistent install card in Resources with reload; iOS re-login copy; comms deliverable | Monthly-cadence cookie expiry, engagement heuristics on `beforeinstallprompt`, iOS storage isolation, and adoption as the binding constraint |
| Manifest: `id` added, `orientation` removed; `mobile-web-app-capable` added; real colour values | Tablets get the desktop layout; stable identity |
| Lighthouse PWA audit replaced with DevTools checks | Category removed in Lighthouse 12 |
| Small corrections: `export.html` already has a back link; only `/newsletter` needs one; 28 test files; `switchView` takes an element; `Service-Worker-Allowed` dropped; `no-cache` on `sw.js` described as belt-and-braces; the "closes the §10 refetch item" claim dropped | Accuracy |
