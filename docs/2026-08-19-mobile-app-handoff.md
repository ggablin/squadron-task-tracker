# Mobile app (PWA) — handoff

**Date:** 2026-08-19
**Plan this follows:** [`2026-08-17-mobile-app-pwa-plan.md`](./2026-08-17-mobile-app-pwa-plan.md)
**Master at handoff:** `bcb096c`

The tracker is now an installable phone app with real push notifications, live for
the squadron. Phases 0, 1 and 2 of the plan are shipped. Phases 3 and 4 (offline)
are not started and are deliberately gated on evidence.

---

## 1. Where things stand

| | state |
|---|---|
| **Production** `108ces.up.railway.app` | Phases 0–2 live. Installable, push working. |
| **Staging** `staging-tracker-production.up.railway.app` | Tracks `master`. Own database, own VAPID keys. |
| **CI** | `.github/workflows/test.yml`, **315 tests** across 30 files, green. |
| **Deploy gate** | Branch protection requires the `test` check; Railway "Wait for CI" is on. A red suite now blocks the deploy, not just the merge. |
| **Phase 3/4 (offline)** | Not started. See §5. |

### What a member sees now

They can add the tracker to their home screen and it opens like an app — no
browser chrome, straight to their own task list. It follows their phone's
light/dark setting. They stay signed in between drills. And if they turn on
alerts, they are told when a task is assigned without opening the app.

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

**Railway's builder has been unreliable.** During this work: one deploy failed
with zero logs, one took 37 minutes, several sat queued for an hour. If a deploy
stalls, check whether the *previous* one is still serving before assuming a code
problem.

---

## 5. What is left

### Immediate — before 4 September

**Revise the comms.** [`COMMS-Sep2026-PhoneApp.md`](../../COMMS-Sep2026-PhoneApp.md)
(project folder, not the repo) still describes notifications as "coming next
month". Push shipped early, so it should tell members to turn alerts on at install
time. That is a stronger message and saves a second round of comms.

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

### Phases 3 and 4 — offline, deliberately not started

Plan §8 and §9. **Gated on evidence**: ship Phase 3 (offline reads) only after a
drill shows members actually need it, and Phase 4 (the offline check-off queue)
only if Phase 3 proves insufficient. Phase 4 is the most expensive phase for the
narrowest gain — tapping a checkbox with no signal instead of twenty minutes
later.

**If Phase 3 does go ahead, two things are non-negotiable:**

1. **Deploy right after a drill weekend, never before one.** A caching worker is
   the one thing that is not cleanly revertible — it lives on members' phones.
   Next windows: after 13 September, or after 18 October.
2. **Rehearse the kill switch on staging first** with a caching worker actually
   installed on a real device.

The plan also records an offline-boot gap the first draft missed: `init()` sends
any thrown fetch to the login screen, so offline reads need a cached identity and
an explicit offline branch, or a member with no signal simply sees a login page.

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
