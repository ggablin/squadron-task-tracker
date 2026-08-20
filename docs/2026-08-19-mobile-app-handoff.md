# Mobile app (PWA) — handoff

**Date:** 2026-08-19, updated 2026-08-20 (Phase 3)
**Plan this follows:** [`2026-08-17-mobile-app-pwa-plan.md`](./2026-08-17-mobile-app-pwa-plan.md)
**Master at handoff:** `198fd56`

The tracker is now an installable phone app with real push notifications and
offline reads, live for the squadron. Phases 0, 1, 2 and 3 of the plan are
shipped. Phase 4 (the offline check-off queue) is not started and stays
deliberately gated on evidence.

> **Read §4 before touching the service worker.** It now has a `fetch` handler,
> which makes it the one artifact here that a git revert cannot undo — it lives
> on each member's phone. `SW_MODE=kill` is the only way to retire it, and as of
> this writing **that switch has never been rehearsed on a real device.**

---

## 1. Where things stand

| | state |
|---|---|
| **Production** `108ces.up.railway.app` | Phases 0–3 live. Installable, push working, offline reads working. |
| **Staging** `staging-tracker-production.up.railway.app` | Tracks `master`. Own database, own VAPID keys. |
| **CI** | `.github/workflows/test.yml`, **346 tests** across 33 files, green. |
| **Deploy gate** | Branch protection requires the `test` check; Railway "Wait for CI" is on. A red suite now blocks the deploy, not just the merge. |
| **Phase 4 (offline check-off queue)** | Not started, gated. See §5. |
| **Kill-switch rehearsal** | **Not done.** See §5 and §6. |

### What a member sees now

They can add the tracker to their home screen and it opens like an app — no
browser chrome, straight to their own task list. It follows their phone's
light/dark setting. They stay signed in between drills. If they turn on alerts,
they are told when a task is assigned without opening the app. And with no signal
at drill, the app still opens and shows their task list from cache, with a banner
saying how old it is.

Nothing changed for anyone who ignores all of that. Push is opt-in behind a tap.

---

## 2. What was built

### Phase 0 — the groundwork (merged in PR #74)

The repo had **no CI at all**, and merging to `master` auto-deploys straight into
the environment the whole squadron uses. That was the real risk multiplier, more
than any single feature.

- `.github/workflows/test.yml` — runs on PRs and pushes to `master`, against a
  Postgres service container. The `push` trigger is required for Railway's "Wait
  for CI" to gate a deploy.
- `engines.node = 24.x` so CI, Railpack and the maintainer's machine agree.
- **A migration advisory lock** (`lib/db.js`, `acquireMigrationLock`). CI's very
  first run failed on a deadlock and a re-run of the identical commit passed —
  `server.js`'s boot migration races the test harness's `schema.sql`, both taking
  `AccessExclusiveLock`. A check that fails on a coin flip cannot gate anything.
  Fixed for production too: a Railway deploy briefly runs two instances and both
  execute the migration block.

### Phase 1 — installable (PR #75)

`manifest.webmanifest`, five icons, `<head>` tags, an install card in Resources
with platform-aware states, `?view=` deep links, and `rolling: true` sessions.

### Phase 2 — push notifications (PR #76)

`push_subscriptions` + `notifications.pushed_at`, three routes, `lib/push.js`,
a push-only service worker, and the alerts toggle behind the bell.

---

### Phase 3 — offline reads (PRs #77, #78, #79)

`init()` used to send **any** thrown fetch to `showLogin()`, which to a member
standing in a metal building is indistinguishable from being signed out. And
`loadTasks()`'s cold path had `try/finally` with no `catch`, so the skeleton
stayed up for good.

The worker gained a `fetch` handler with this routing table:

| Request | Strategy |
|---|---|
| Navigation to `/` | network-first, 4s timeout, cached shell behind it |
| `/api/*` | **never intercepted** |
| Other navigations (`/build`, `/records`, —) | not intercepted |
| fonts, icons, manifest, favicon | cache-first |
| `design.css`, `ui.js`, `member-browser.js`, `offline.js` | stale-while-revalidate |
| everything else | not intercepted |

`public/offline.js` caches the identity and the member's own task list in
IndexedDB. Scope is deliberately narrow — supervisor rollups, attendance, roster,
`/build` and `/records` stay online-only.

---

## 3. Decisions worth not re-litigating

**Push shipped before the offline phases, and before the September drill.**
The original plan put push last. It moved first because production has **no
`SMTP_*` configured** — email has never sent, so push is the *only* out-of-app
channel that works. And it is safe to ship at any time because the service worker
has **no `fetch` handler**: it cannot intercept a page load, so it cannot strand
anyone on a stale shell. That is the risk the caching phase has to be careful
about, and it does not apply here.

**Delivery is a flush job, not a send inside `notify()`.** `lib/push.js` mirrors
`notify-emails.js`. `web-push` never runs in a request (a throw would break task
assignment), it covers both notification insert sites (`notify-digests.js` writes
rows directly), and a failed send leaves `pushed_at` NULL so the next tick
retries.

**`push_subscriptions` is keyed on `endpoint`, not member.** Browsers rotate
endpoints and a device re-registers on every load where permission stands, so
writes upsert. `member_id` is reassigned on conflict, so a shared phone follows
whoever signs in rather than notifying the member before them.

**Digests are email-only.** `PUSH_TYPES` in `lib/push.js` excludes
`completion_digest` deliberately — it is a nightly 21:00 supervisor summary and
buzzing phones for it is not wanted. One array entry if that ever changes.

**`/api/*` is never cached, and that is a safety property.** Not a performance
choice. Caching a member's task data would let a shared phone serve it to whoever
signs in next. For the same reason every cached record carries its owner's
`memberId`, is checked at read time, and is wiped at logout — including when the
logout request itself fails, which offline it always does.

**Offline is scoped to the member's own task list, nothing else.** The shop and
squadron views need a connection and now say so. Widening this means widening the
shared-device blast radius, so it should not be done casually.

**The offline banner is `position: fixed` on phones with JS-measured space
reserved for it.** Both halves matter and both were learned the hard way — see
§4.

**The theme follows the phone, until the member overrides it.** Choosing the
value the phone already uses *clears* the override and returns to automatic, so
"auto" is always one tap away. Without that there is no route back, and the first
person to touch the toggle gets stuck — which happened.

---

## 4. Things that will bite you

These each cost real time to find. They are the most valuable part of this doc.

**Status codes lie on this app.** The SPA catch-all (`server.js`) returns
`index.html` with **200 and `text/html`** for any unmatched path. A missing icon
or a typo'd manifest never 404s. **Check `content-type`, not the status code.**
`/api/*` is the exception — it has its own JSON 404 handler.

**Android renders a notification `badge` as a silhouette.** It discards colour
and paints every opaque pixel white. Passing a normal app icon produces a solid
white square, which is what shipped first. `public/icons/badge-96.png` is a
purpose-drawn glyph whose shape lives entirely in its alpha channel;
`tools/make-badge.py` asserts alpha reaches 0. See `tools/icons.md`.

**Android's gesture navigation bar is not controllable from a PWA.** There is a
manifest field for the status bar (`theme_color`) and none for the nav bar. It
follows the system theme. `.mob-nav` is forced to `#000` in dark mode under
`@media (display-mode: standalone)` to meet it — browser tabs are untouched.

**`theme-color` must follow the app, not the OS.** The app's dark mode is a
manual toggle; `design.css` keys off `[data-theme]` and never reads
`prefers-color-scheme`. Keying the meta to the OS puts a black bar above a cream
app. It is one JS-driven meta, updated by the same function that paints the theme.

**The newsletter deck must stay self-contained.** `test/newsletter-http.test.js`
asserts no `src`/`href` outside `data:` URIs, because it is emailed and saved as
PDF. A back-*link* breaks it; the back control is a `<button>`.

**`rolling: true` re-issues the session cookie on every response.** This broke a
`documents-http` security test asserting no `Set-Cookie` after a filename tries
to smuggle one. The test now asserts the real property — the smuggled value
absent *and* nothing but `connect.sid` set.

**The preview server caches `require`d modules.** After editing `newsletter/` or
`lib/`, restart it or you will verify the old code and believe a fix failed.

**Never pipe a background test run through `tail`.** The exit code becomes
`tail`'s, so a failing suite reports success.

**`unregister()` does not terminate a worker that is still controlling the
page.** Tearing down with `unregister()` + `caches.delete()` and then
re-registering silently reuses the *old* worker: it reports `activated`
immediately, never fires `install`, and the caches stay empty. This looks exactly
like a broken precache and is not one. **Reload the page after unregistering** so
the new worker installs against an uncontrolled client.

**`initPush()` registers the service worker.** The name says push; it also does
`navigator.serviceWorker.register('/sw.js')`, which is what precaches the shell.
`init()` calls it. `doLogin()` did not — so a member who installed the app,
signed in and closed it had a cached identity but no cached shell, and offline
the browser could not load the page at all. Fixed in #79. If you add another
path that reaches `showApp()`, it needs `initPush()` too.

**`position: sticky` is inert in this shell.** `.main` is `overflow: hidden`, so
a sticky child never pins — measured, behaves identically to normal flow. The
`.pf-mobilebar` comment already documented this and it still got missed once.
On phones the **page** scrolls; on desktop `.view` scrolls. So the offline banner
is `fixed` on phones only, and `#app` reserves its height in `--offline-h`,
measured from the banner's real `offsetHeight` rather than hardcoded — the text
wraps to two lines on a narrow phone and the safe-area inset varies by device.
A guessed constant is how the banner ended up covering the header.

**Railway's builder has been unreliable.** During this work: one deploy failed
with zero logs, one took 37 minutes, several sat queued for an hour. If a deploy
stalls, check whether the *previous* one is still serving before assuming a code
problem.

---

## 5. What is left

### Immediate — before 4 September

**Revise the comms.** [`COMMS-Sep2026-PhoneApp.md`](../../COMMS-Sep2026-PhoneApp.md)
(project folder, not the repo) still describes notifications as "coming next
month". Push shipped early and offline reads shipped after that, so it should
tell members to turn alerts on at install time and mention that the app now works
without a signal at drill. That is a stronger message and saves a second round of
comms. **Deferred as of 2026-08-20** — still unsent.

Worth pairing with a second, different message: the install post only helps
people who already use the tracker. Roughly half the squadron has never signed
in, and they need their supervisor to walk them through a first login at drill,
not an announcement.

**Send it ~4 September**, a week before the **11–13 September** UTA — a 3-day
drill, the best adoption moment available. Show MSgt McNaughton first; he
maintains the system and should not hear about it from a squadron-wide post.

### Small, worth doing

**A "send test notification" button.** Both push defects found so far needed a
real task assignment to surface. A member wondering whether their alerts work has
no way to check, and neither did the maintainer. A few lines next to the alerts
toggle.

**Rotate the preview database password.** It was exposed in a working transcript
on 2026-08-17. Throwaway data, but the database is publicly reachable and holds
the imported roster.

**Ask the designer for a genuine vector icon.** Three attempts produced: a real
4,853-path trace (wrong tone), a coarse 31-path posterisation (ragged), and a
JPEG in an SVG wrapper (the current artwork). What is committed is a 1536px
raster — sufficient, but a hard ceiling. The check is in `tools/icons.md`:
`grep -c "<image\|base64" icon.svg` must be 0.

### Rehearse the kill switch — **outstanding, and now live**

Phase 3 shipped on 2026-08-20, so the caching worker is on production and
installs on members' phones as they open the app. It is the one change here that
a git revert cannot undo.

`SW_MODE=kill` is the entire recovery plan, and **it has never been exercised on
a real device.** `test/sw-route-http.test.js` proves the route serves the right
script; it cannot prove a phone actually drops the worker and its caches when
told to.

Do it before a drill weekend, not during one:

1. Install the app on a phone and use it once so the worker is active.
2. Set `SW_MODE=kill` on the **production** Railway service and let it redeploy.
3. Open the app once. Confirm no service worker and no caches remain.
4. Unset `SW_MODE`, redeploy, open again — the worker should reinstall cleanly.

It was deployed against the plan's stated window (the plan wanted the deploy
immediately after a drill; this went out roughly three weeks before the next
one), which is a defensible call but leaves less soak than intended. That makes
the rehearsal more valuable, not less.

### Phase 4 — offline check-off queue, deliberately not started

Plan §9, still **gated on evidence**: build it only if a drill shows that reading
offline is not enough and members genuinely need to check tasks off with no
signal. It is the most expensive phase for the narrowest gain — tapping a
checkbox now instead of twenty minutes later — and it conflicts with the
wipe-on-logout rule in ways §9.4–9.5 of the plan spells out.

Note the evidence gate is still not really satisfiable: as of the 2026-08-19
database backup, **37 of 73 active members had ever signed in**, with no logins
after 12 August and one shop at zero. It is hard to conclude anything about what
members need offline when half of them have not used the app at all.

---

## 6. Operational reference

### The kill switch

Set `SW_MODE=kill` on the Railway service. The `/sw.js` route then serves
`lib/sw/sw-kill.js`, which unregisters the worker and deletes its caches. This is
the **only** way to retire a worker already on members' phones — no PR, no
revert, flippable from a phone. Unset it to restore normal service.

### Environment variables

| Var | Production | Staging |
|---|---|---|
| `DATABASE_URL` | own DB | preview DB (`Postgres` in `squadron-tracker-test`) |
| `SESSION_SECRET` | set | different value |
| `NODE_ENV` | `production` | `production` |
| `ENABLE_CRON` | **unset → cron ON** | `false` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | set | **different pair** |
| `SMTP_*` | **not set — email has never sent** | not set |
| `SW_MODE` | unset | unset |

Production and staging VAPID keys are deliberately different: a shared pair would
let a staging test buzz real members' phones. `ENABLE_CRON=false` on staging means
the one-minute push catch-up does not run there — the inline kick from `notify()`
still fires, so a task assignment still pushes.

**If SMTP is ever configured**, run
`UPDATE notifications SET emailed_at = NOW() WHERE emailed_at IS NULL` **first**,
or the next flush emails the entire backlog since launch, 200 rows every 5 minutes.

### Staging test accounts

`gablin` / `preview123` (leadership). Every other seeded account uses **its own
username as the password** — `ebbert`, `uzoma` (supervisors), `becerra`,
`derose`, `fowler`, `glenn`, `mesa` (members). `mcnaughton` does not work; it came
through `import-members.js` with a random password.

### Verifying a deploy

```
/                 -> 200
/api/auth/me      -> 401
POST /api/auth/login {}  -> 400   (not 500: proves the pool and session came up)
/sw.js            -> content-type application/javascript, 0 fetch handlers
```

### Testing push end to end

Bulk "add a task" **deliberately does not notify its author**
(`server.js`: `.filter(id => id !== req.session.memberId)`). Assign to someone
else, or use the single Add Task against a specific member. This is the first
thing to check when a test notification does not arrive.

### Backup

A full logical backup taken before the Phase 2 migration is at
`db-backup-2026-08-19-pre-phase2.json` in the project folder — all 14 tables,
1.7 MB, document blobs base64'd. `pg_dump` is not installed on the maintainer's
machine and Railway snapshots are dashboard-only, so it was taken through the pg
driver. That file plus `schema.sql` is a complete restore.
