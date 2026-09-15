# 108 CES Task Tracker — Squadron Chat (TeamApp replacement)

**Date:** 2026-09-15
**Status:** Design approved in chat (brainstorming, architectural path). Not yet implemented.
**Author/driver:** Greg Gablin
**Base branch for implementation:** `origin/master` at `d5c5746`
**Source:** Recurring member feedback that in-app chat is the most-requested next feature, specifically to let the squadron drop TeamApp. No written feature-suggestion doc for this one — captured directly in a brainstorming session.

---

## 1. Goal

Members can post and read group messages inside the app they already have installed, so the squadron can retire TeamApp. Three channel types — squadron-wide, a leadership-only channel, and one per shop — cover how TeamApp is actually used today (group chat/announcements), without building a DM system nobody asked for.

McNaughton's workload is unaffected either way: this is a member-to-member feature, not something he authors or maintains per cycle.

## 2. Background

### Why this shape, not a generic chat app

TeamApp today is a single scrolling group chat, which is why rollout announcements have also needed a separate "News" post to persist ([[squadron-comms-channel]] in prior notes) — a scrolling feed isn't a record. Three fixed, static channels (not user-creatable, no DMs) is the minimum structure that:

- Keeps routine shop chatter out of the squadron-wide feed (the same reasoning the app already applies to task views: a shop's own status vs. the rolled-up view).
- Gives leadership a private channel without giving every member a DM system whose privacy/moderation surface nobody has asked for.
- Fits entirely on top of infrastructure that already exists and is already running in production: session auth, the PWA install base (PWA Phases 0–3, PRs #74–79), and web-push delivery (VAPID configured, `push_subscriptions` live).

### What the codebase already decided

- **`members.role`** is a three-level rank — `member` (0) < `supervisor` (1) < `leadership` (2) — checked via `requireRole(minRole)` (`server.js:379-385`). Per the comment at `server.js:387-390`, **`role='leadership'` is already held by 21 people: the Commander, Chief, First Sergeant, the four flight superintendents, and all nine shop NCOICs.** Shop leads are `leadership`, not `supervisor`, in this system — `supervisor` is a separate, lower tier for in-shop capability short of being the shop's lead. This spec's moderation rule rides directly on that existing tier; no new role.
- **Permission checks read live state, not session-cached state**, for anything that can change between logins (`requireRosterAdmin`, `managesWorkOrders`) — the session's role/shop are the exception, cached at login and refreshed by `requireRole`'s reliance on `req.session.role`. Channel access follows the same session fields the rest of the app already trusts for `role`/`shopId` (`server.js:380`, `:456`).
- **`mayTouchEvent`** (`server.js:451-458`) already establishes the precedent this spec reuses: leadership's reach spans every shop; everyone else is held to their own. Chat's access model is the same shape.
- **Push is not a standalone "send to member" primitive** — it is a batch flush (`lib/push.js`) over rows in the `notifications` table, deliberately kept out of the request path (`lib/push.js:1-12`): `notify()` (`server.js:550-569`) inserts, then `setImmediate`s a `flushPush`, with a per-minute cron (`server.js:3379-3380`) as the catch-up. Critically, `flushEmails` (`notify-emails.js:31-40`) has **no type filter** — it emails every un-emailed notification row regardless of `type`. Routing chat through the `notifications` table would (a) put every chat message into the same bell/inbox surface as task alerts, which already has its own semantics, and (b) silently become emailable the day SMTP is ever configured ([[production-has-no-smtp]] — a live possibility, not hypothetical). §7 below adds a small standalone push path instead, reusing the delivery code but not the table.
- **Railway's filesystem is ephemeral** — anything that must persist goes to Postgres (the `documents` table stores PDFs as `BYTEA` for exactly this reason, `schema.sql:246-249`). Not directly relevant with text-only messages, but why attachments were declined for v1 rather than deferred as "easy to add later."
- **Main nav** is `data-view` driven (`public/index.html:2672-2685` desktop sidebar, `:3893-3909` mobile), currently `member` / `supervisor` / `leadership` / `resources`, switched by `switchView()`. Chat becomes a fifth `data-view="chat"`, visible unconditionally like `member` and `resources` (everyone has at least the squadron channel).

## 3. Decisions locked

| Decision | Choice |
|---|---|
| Moderation authority | `requireRole('leadership')` — the existing tier (21 people), not a new role |
| Moderation scope | Squadron-wide: any leadership member may hide any message in any channel |
| Channel types | Squadron-wide (1) · Leadership-only (1) · Per-shop (9) — no flight tier |
| Shop channel read access | That shop's members, plus every leadership member (consistent with their moderation reach) |
| Shop channel post access | Same as read — leadership may also post into any shop channel, not just read it. Simplest single rule; revisit if it turns out leadership posting in shops they don't own is unwanted |
| Direct messages | None in v1 |
| Attachments | Text only, 2000-char cap |
| Delete semantics | Soft-hide (`hidden_at`/`hidden_by_id`), never a hard delete — keeps an audit trail |
| Unhide | Out of scope for v1 (manual DB fix in the rare case it's needed) |
| Real-time delivery | Client polling (`since=`) while a channel is open. No WebSockets, no SSE |
| Push trigger | Every message, every channel type, fired to all recipients except the author |
| Push mechanism | New standalone `pushToMembers()` in `lib/push.js`, **not** routed through the `notifications` table |
| Read tracking | Per-member-per-channel `last_read_at`, independent of the `notifications` table's `read_at` |
| Channel creation | Seeded once at boot (seed-on-create, same pattern as `additional_duties`/`drill_dates`); not user-creatable in v1. A new shop needs a manual channel row, same as it already needs manual everything else |

**Flagged for review, not fully resolved:** giving leadership push (not just read/moderate reach) for every shop's routine traffic means a flight superintendent gets buzzed for all nine shops, not just their own. "Push on every message" was chosen deliberately to match TeamApp's behavior and avoid guessing at traffic patterns ahead of real usage — but this specific interaction (full read reach + push-everything) is the most likely thing to feel wrong in practice. Easiest first fix if it does: push follows a member's own shop + squadron + leadership channels only; reading/moderating other shops' channels is unaffected either way, since that's a pull (open the app), not a push.

## 4. Scope

**In scope**

- Three tables (`channels`, `messages`, `channel_reads`), twinned migrations, seed-on-create.
- `lib/chat.js` (access derivation, message CRUD) and a small addition to `lib/push.js`.
- Five routes in `server.js` (§6).
- A fifth main-nav tab, `public/chat.js`, matching the `duties.js`/`calendar.js` module shape.
- Tests (§9).

**Out of scope** — see §10.

## 5. Data model

### 5.1 `channels`

```sql
CREATE TABLE IF NOT EXISTS channels (
  id       SERIAL PRIMARY KEY,
  type     VARCHAR(20) NOT NULL CHECK (type IN ('squadron','leadership','shop')),
  shop_id  INTEGER REFERENCES shops(id),
  name     VARCHAR(100) NOT NULL,
  CHECK ((type = 'shop') = (shop_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS channels_shop_key
  ON channels (shop_id) WHERE shop_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS channels_singleton_key
  ON channels (type) WHERE type IN ('squadron','leadership');
```

The two unique indexes make the "exactly one squadron channel, exactly one leadership channel, at most one per shop" rule a database guarantee, not just an application convention. Eleven rows total at seed time (1 + 1 + 9).

### 5.2 `messages`

```sql
CREATE TABLE IF NOT EXISTS messages (
  id           SERIAL PRIMARY KEY,
  channel_id   INTEGER NOT NULL REFERENCES channels(id),
  author_id    INTEGER NOT NULL REFERENCES members(id),
  body         VARCHAR(2000) NOT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  hidden_at    TIMESTAMP,
  hidden_by_id INTEGER REFERENCES members(id)
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (channel_id, created_at);
```

`hidden_at IS NULL` means visible, same convention as `notifications.read_at`. A hidden message's row is never deleted, so "who hid what, when" is always answerable.

### 5.3 `channel_reads`

```sql
CREATE TABLE IF NOT EXISTS channel_reads (
  member_id    INTEGER NOT NULL REFERENCES members(id),
  channel_id   INTEGER NOT NULL REFERENCES channels(id),
  last_read_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (member_id, channel_id)
);
```

Unread count for a channel = messages with `created_at > last_read_at` (or all of them, if no row exists yet) and `hidden_at IS NULL`. Deliberately separate from `notifications` — a continuous stream with per-member read state is a different shape than a one-shot system alert, and conflating them would mean every chat message either needs a `notifications` row (pulling in the email-flush landmine from §2) or the bell UI needs to learn to filter a type it was never designed to show alongside task alerts.

### 5.4 Migrations and seeding

Both `CREATE TABLE`s go in `schema.sql` (after `shops` and `members`) and the `server.js` boot block, following the `ensureTable(db, defaults)` seed-on-create pattern already established for `additional_duties`/`drill_dates`/`calendar_events`: create only if `to_regclass` is null, then seed only in the boot that creates it. `data/channels.js` holds the seed rows — squadron, leadership, and one per row currently in `shops`.

## 6. Access control — `lib/chat.js`

Pure functions over a member's `{ role, shopId, id }` (the same fields already on `req.session`), no database, so routes and tests share one source of truth:

- **`visibleChannels(member, allChannels)`** — squadron: always. leadership: `role === 'leadership'`. shop: `channel.shop_id === member.shopId` **or** `role === 'leadership'`.
- **`canPost(member, channel)`** — identical to `visibleChannels` for v1 (no read-only channels).
- **`canHide(member)`** — `role === 'leadership'`, independent of channel.

Routes call these before touching the database; a `false` is a 403, not a filtered result — a member should get a clear "not allowed" on `POST /api/chat/channels/:leadershipChannelId/messages`, not a silent no-op.

## 7. Push delivery — addition to `lib/push.js`

`flushPush` stays exactly as it is; it is not touched. Alongside it:

```js
// New: deliver directly to a set of members, no notifications-table row.
// Mirrors flushPush's per-subscription try/catch/prune, but is not driven by
// a table flush and never runs inside the request path — callers must wrap
// it the way notify() wraps flushPush (setImmediate + .catch).
async function pushToMembers(pool, memberIds, payload, { send } = {}) { ... }
```

Refactor: the existing per-subscription "deliver, catch 404/410 → prune, otherwise log" block inside `flushPush`'s loop becomes a small shared helper both functions call, so the pruning behavior has one implementation, not two.

In `server.js`, a new `pushChatMessage(recipientIds, payload)` mirrors `notify()`'s shape exactly (`server.js:550-569`) — `setImmediate(() => require('./lib/push').pushToMembers(pool, recipientIds, payload).catch(...))` — called right after a message insert commits, never awaited in the request path. Recipients are every member with read access to that channel (§6), minus the author. Payload: `{ title: <channel name>, body: <first ~120 chars of the message>, url: '/?view=chat&channel=<id>', tag: 'chat-<channel_id>' }` — same `url`/`tag` shape `flushPush` already uses for task pushes, so `applyDeepLink()` in `index.html` needs one more case, not a new mechanism.

## 8. API surface

All routes `requireAuth`. Per the existing convention (`server.js:460-464`), `requireOnboarded` gates writes only — a member still on their default password can read chat like anything else, just not post — so it's on the three `POST`s and not the two `GET`s. Errors are `{ error: '<message>' }`, matching the rest of the app.

| Route | Gate | Behaviour |
|---|---|---|
| `GET /api/chat/channels` | auth | Channels visible to caller (§6), each with `unread_count` |
| `GET /api/chat/channels/:id/messages?since=` | auth + `visibleChannels` | Messages after id `since` (or latest 50 if omitted), ascending. Hidden messages excluded unless caller passes `canHide` — leadership sees them with `hidden: true` and no body, for audit context |
| `POST /api/chat/channels/:id/messages` | auth + onboarded + `canPost` | **201**; **400** empty or >2000 chars; fires `pushChatMessage` after insert |
| `POST /api/chat/channels/:id/read` | auth + onboarded + `visibleChannels` | Upserts `channel_reads.last_read_at = NOW()` |
| `POST /api/chat/messages/:id/hide` | auth + onboarded + `requireRole('leadership')` | Sets `hidden_at`/`hidden_by_id`; **404** unknown; idempotent |

## 9. Frontend

- **Nav**: fifth `data-view="chat"` button in both `.mob-nav` and the desktop sidebar (`index.html:2672-2685`, `:3893-3909`), visible unconditionally.
- **`public/chat.js`**: one module, `chatInit({ canHide })`, following the `duties.js`/`calendar.js` shape — one exposed global, `defer`-loaded.
- **Channel list**: squadron and leadership (if visible) pinned above the 1-9 shop channels, unread counts as a badge on the `.mob-nav`/sidebar item and per-row in the list, same visual language the app already uses for counts elsewhere.
- **Thread view**: scrolling list, newest at the bottom, an input bar pinned to the bottom. Poll `?since=<last id>` every ~12s while the view is open and on window focus; stop polling when the view isn't active. A leadership viewer sees a hidden-message placeholder (`Message hidden by <name>`) instead of the body.
- **Hide action**: a 44px control per message, leadership-only, behind `uiConfirm` — matches the delete-confirmation pattern already used in the resources editors.
- States: `.skeleton` while loading, a quiet offline note on failure (online-only, like the resources/calendar views), empty state per channel (`No messages yet — say hi`).

## 10. Key flows

1. **A shop has a question during drill.** Member opens Chat → their shop channel is already selected (or one tap away) → posts → the rest of the shop gets a push within seconds, the same shop's supervisor and NCOIC included automatically since they're shop members too.
2. **Leadership needs to coordinate without the whole squadron seeing it.** The Leadership channel is invisible to `member`/`supervisor` roles entirely — it doesn't appear in their channel list, and a direct URL/API hit 403s.
3. **Someone posts something that shouldn't be there.** Any of the 21 leadership members opens the message's hide control, confirms, and it's gone from every member's view immediately — but still in the database with who/when for later reference.
4. **A member checks in after drill.** Chat tab shows unread badges per channel; opening a channel marks it read; the squadron-wide badge clears without needing to scroll through everything TeamApp would have piled up.

## 11. Edge cases

- A member's shop transfers mid-cycle → their channel access changes on the next request (session `shopId` is what's actually checked — see §2 caveat that this one field is session-cached, not read live like `can_manage_roster`; a transfer takes effect at next login, consistent with how `role`/`shopId` already behave everywhere else in the app, not a new inconsistency).
- Two leadership members hide the same message within moments of each other → second call is a no-op 200, not a 404 or 409.
- A member posts, then is deactivated before the push flush runs → `pushToMembers` simply finds no subscriptions or a member the join excludes; no special case needed.
- Empty body, or body that's only whitespace → 400.
- A dead push subscription (410) is pruned by `pushToMembers` exactly as `flushPush` already prunes them — one shared code path, so this isn't new behavior to verify separately.
- Squadron-wide channel, 69 recipients, one message → 69 push attempts. Not a volume problem at this scale; noted here only so it isn't mistaken for a bug during testing.

## 12. Testing

- **`test/chat.test.js`** (unit): `visibleChannels`/`canPost`/`canHide` across all three roles × all three channel types — this is the access-control matrix that matters most, since it's the first feature where one member's free text is read by others.
- **`test/chat-http.test.js`**: 401 signed out; the same matrix as an HTTP 403 check per route; post/list/read round-trip; hide requires leadership and is idempotent; hidden messages excluded for non-leadership and shown-but-redacted for leadership; 400s on empty/oversized body; seed-on-create creates exactly 11 channels once and doesn't reseed.
- **`lib/push.js`**: existing `flushPush` tests must still pass unchanged after the refactor (regression check on the extracted helper); new tests for `pushToMembers` — delivers to the right subscriptions, prunes on 410, never touches the `notifications` table.
- **Front end**: manual verification per the handoff practice already used for resources/calendar — phone width, both roles, dark mode, polling starts/stops with view visibility, push arrival while backgrounded.

## 13. Rollout and housekeeping

Spec committed on `claude/squadron-chat-design`, off `origin/master` at `d5c5746`. Implementation continues on the same branch (or a fresh one off the same commit, at the implementation planner's discretion), one PR, CI gates the deploy. No existing table changes — this is additive only. Reverting removes three unused tables and one nav tab; harmless.

Docs in the same PR: this repo's `MEMORY.md`.

## 14. Out of scope / future

- **Direct messages.** Explicitly declined for v1 (§3) — revisit only if channels prove insufficient.
- **Attachments.** Text only; the `documents`-table `BYTEA` pattern is the template if this changes.
- **@mentions, reactions, message editing, typing indicators, read receipts beyond your own unread count.**
- **Per-channel mute / configurable push.** "Push on every message" is the v1 default; per-member preferences are a natural v1.1 if squadron-wide proves too noisy.
- **Flight-level channels.** `members.flight` is free text today with no referential integrity; not worth a fourth channel tier without evidence anyone wants one.
- **Unhide.** A hidden message stays hidden; reversing one is a manual DB operation until there's a real need for a UI.
- **Retention / archival.** No expiry in v1 — at this member count and text-only, years of history is a trivial amount of data. Revisit if that assumption ever stops holding.
