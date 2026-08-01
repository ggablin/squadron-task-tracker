# 108 CES Task Tracker — Roster Management (`/roster`)

**Date:** 2026-08-01
**Status:** Design approved (brainstorming). Not yet implemented.
**Author/driver:** Greg Gablin
**Base branch for implementation:** `origin/master`

---

## 1. Goal

Let the roster be maintained in the browser — add a member, deactivate one who has left, correct their details, and move them on the org chart — without running `import-members.js` from the maintainer's laptop.

This is the same shape of problem the Task Builder solved for tasks. Roster changes are currently a developer-shaped workflow, so in practice only Greg performs them, which means every arrival, departure and promotion waits on one person.

The immediate driver: MSgt Jonathan Fernandez (Electrical SNCOIC) retired. His account needs deactivating, a new SNCOIC needs promoting, and a new shop supervisor needs designating. Today that is three edits to a spreadsheet plus a CLI run.

## 2. Background

`members` is written by exactly one path: `import-members.js`, which upserts the whole roster from `Members.xlsx`. The application exposes **no create, update or delete endpoint for members at all** — only `POST /api/members/:id/reset-password`, `GET /api/members/:id/history`, and read-only roster queries.

Deactivation already works and is already complete. `active = false` blocks login (`WHERE m.slug = $1 AND m.active = true`), is filtered by sixteen queries across `server.js`, excludes the member from `copyForward`, and removes them from the org chart — while every row of their history survives for `/records`.

## 3. Decisions locked (from brainstorming)

| Decision | Choice |
|---|---|
| What "remove" means | **Deactivate.** Hard delete offered only when the member has zero referencing rows |
| Who can manage the roster | **A `can_manage_roster` capability flag**, not a role. Initially Gablin and McNaughton |
| Granting that capability | **In-app, by an existing holder**, with confirmation |
| Role changes | **Allowed**, with explicit confirmation when granting `leadership` |
| New member password | **Slug (last name), `must_change_password = true`** — matches how every existing account was provisioned |
| Sign-in name (slug) | **Auto-generated, disambiguated, editable afterwards** behind a warning |
| Org chart editing | **A single placement selector**, not free-text `role`/`flight`/`position` |
| Placement | **New standalone `/roster` page**, matching `/build` and `/records` |
| Member browser | **Extracted to a shared component** used by both `/roster` and `/records` |

## 4. Scope

**In scope**
- `can_manage_roster` capability, its middleware, and in-app granting by a holder.
- Create, edit, deactivate and reactivate members.
- Hard delete, guarded to unreferenced members only.
- Org chart placement as a derived, validated triple.
- `/roster` page and the extracted member browser.
- Shop composition warnings (no lead / multiple leads).

**Out of scope**
- Bulk roster import. `import-members.js` remains for initial load and mass changes.
- A full audit log. Minimal accountability only (`updated_at`, `updated_by_id`).
- Changing `SQUADRON_WIDE_SLUGS`, the existing hardcoded all-shop allowlist (`server.js`). Noted in §12.
- Self-service password reset. Unchanged.

## 5. Data model changes

### 5.1 Capability flag

```sql
ALTER TABLE members ADD COLUMN IF NOT EXISTS can_manage_roster BOOLEAN NOT NULL DEFAULT false;
```

Orthogonal to `role`. `requireRole` is unchanged (`member:0, supervisor:1, leadership:2`); a new `requireRosterAdmin` checks the flag.

This distinction is the point. **Twenty-one members currently hold `role = 'leadership'`** — the Commander, the Chief Enlisted Manager, the First Sergeant, four flight superintendents, and all nine shop NCOIC/SNCOICs. Gating on `requireRole('leadership')` would grant roster control, including deactivation and role changes, to twenty-one people rather than two. The Commander outranks McNaughton and does not manage the roster; a capability models that, a rank ladder cannot.

`canManageRoster` is read into the session at login alongside `role` and the onboarded flag, but only for cheap UI hints (`/api/auth/me`, showing or hiding the Roster button) — it is **not** the gate. `requireRosterAdmin` re-reads `can_manage_roster` and `active` from `members` on every request, by primary key. The one extra indexed lookup per roster-admin request is a deliberate trade against the alternative: a session-only gate means revoking the capability (or deactivating the holder) does nothing until their 30-day cookie happens to expire, during which a revoked admin keeps full roster control — including granting the capability back to themselves. For five routes used by two people, "revoke doesn't revoke" is not an acceptable trade for one query.

### 5.2 Accountability

```sql
ALTER TABLE members ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;
ALTER TABLE members ADD COLUMN IF NOT EXISTS updated_by_id INTEGER REFERENCES members(id);
```

Set on every mutation. Two columns, no new table.

### 5.3 Migrations

Both blocks are idempotent `ADD COLUMN IF NOT EXISTS`, added to `schema.sql` **and** the `server.js` boot-migration block, matching the pattern established by `uta_cycles.status` and `tasks.batch_id`.

Seeding is a one-off statement run against production alongside the deploy:

```sql
UPDATE members SET can_manage_roster = true WHERE slug IN ('gablin', 'mcnaughton');
```

### 5.4 Unchanged

`active` keeps its current meaning and every existing query that filters on it. No table is added. No member-facing query changes.

## 6. The at-least-one-active-holder invariant

**At least one active member must hold `can_manage_roster` at all times.** Losing the last holder locks the squadron out of roster management entirely and requires direct database access to recover.

Three operations can violate it and are refused:

1. Revoking the flag from the last active holder.
2. Deactivating the last active holder.
3. Hard-deleting the last active holder.

Unlike the one-live-cycle rule — which `uta_cycles_one_current` enforces declaratively with a partial unique index — "at least one row is true" has no clean constraint form in Postgres. It is therefore enforced in the application, **inside the same transaction as the write**, with the holder count taken `FOR UPDATE` so two concurrent revocations cannot both observe a count of two and both proceed.

The refusal returns a specific message, not a bare `403`: *"You're the only person who can manage the roster. Grant it to someone else first."*

## 7. Org chart placement

### 7.1 Why placement is derived, not typed

`GET /api/squadron/org-chart` classifies every active member from the combination of `role`, `flight` and `position`:

- `role='leadership'` and `position` exactly `'NCOIC'` or `'SNCOIC'` → the shop's lead
- `role='leadership'`, `flight` set, any other position → flight leader, a level above the shops
- `role='supervisor'` → shop supervisor
- otherwise → ordinary shop member

Three properties make free-text editing unsafe:

**The fields are coupled.** Setting `position='NCOIC'` without `role='leadership'` renders the person as an ordinary member. Setting `role='leadership'` with a `flight` and no position promotes them to *flight leader*. Neither errors; both misplace the person.

**`shop.ncoic` is a single slot**, assigned `shop.ncoic = person`. Two active leadership members in one shop with an NCOIC/SNCOIC position and **one silently disappears from the chart** — no error, no duplicate, just absent. This is precisely the transient state of a succession.

**Matching is exact string comparison.** `position` is `VARCHAR(50)` free text compared against `'NCOIC'`, `'SNCOIC'`, `'Commander'`, `'Chief Enlisted Manager'`, `'First Sergeant'` and `'BCE/Engineering OIC'`. A trailing space or different casing silently reclassifies someone. The live roster contains eleven distinct position values; fifty-three members have none.

### 7.2 The placement model

The client sends one `placement` value. The server derives and validates the triple.

| Placement | `role` | `flight` | `position` |
|---|---|---|---|
| Shop member | `member` | cleared | cleared |
| Shop supervisor | `supervisor` | cleared | cleared |
| Shop lead | `leadership` | cleared | `NCOIC` or `SNCOIC` |
| Flight leader | `leadership` | chosen from `FLIGHT_ORDER` | chosen list |
| Squadron staff | `leadership` | `Squadron Staff` | chosen list |

`flight` is normally derivable from shop through the server's existing `SHOP_TO_FLIGHT` map and is only an explicit choice for the last two rows.

Clearing `flight` for the first three placements is behaviour-neutral, and this was checked against the live roster rather than assumed: all nine current shop leads store a `flight` that exactly matches what `SHOP_TO_FLIGHT` derives from their shop. Since the org chart resolves `memberFlight = r.flight || SHOP_TO_FLIGHT[shop]`, clearing the stored value yields the identical result while removing a field that can drift out of agreement with the shop.

Allowed `position` values per placement:

- **Shop lead** — `NCOIC`, `SNCOIC`
- **Flight leader** — `Flight Superintendent`, `Flight OIC`, `Unit Training Manager`
- **Squadron staff** — `Commander`, `Chief Enlisted Manager`, `First Sergeant`, `BCE/Engineering OIC`, `Admin Support Technician`

### 7.3 Shop composition warnings

The roster view flags any shop with **zero leads** or **two or more leads**. Warnings, never blocks — a half-finished succession is a legitimate temporary state and the order of edits must not matter. The two-lead case is the one that currently causes a silent disappearance from the org chart, so surfacing it is the point.

## 8. API surface

All endpoints require `requireAuth`, `requireRosterAdmin` and `requireOnboarded`. Namespaced `/api/roster/*` so the gate is legible at the route.

```
GET    /api/roster                    all members, active and inactive
POST   /api/roster/members            create
PATCH  /api/roster/members/:id        attributes, placement, active
DELETE /api/roster/members/:id        hard delete, guarded
PATCH  /api/roster/members/:id/admin  grant / revoke can_manage_roster
```

The capability flag has its own endpoint and is **never** writable through `PATCH /api/roster/members/:id`. Even with in-app granting, the ordinary edit path cannot alter access control.

**Create** generates the slug, hashes the last name as the initial password with `bcrypt` (cost 10, matching `import-members.js`), and sets `must_change_password = true`. The response includes the generated slug so the form can show the member what they will type.

**Hard delete detects "unused" by attempting it.** `members(id)` is referenced by **twelve columns across nine tables** — `tasks.member_id`, `tasks.flagged_by_id`, `tasks.created_by_id`, `task_completions.completed_by_id`, `shop_events.created_by_id`, `shop_event_status_log.updated_by_id`, `squadron_events.created_by_id`, `task_batches.created_by_id`, `members.updated_by_id` (a self-reference), `notifications.member_id`, `attendance.member_id`, `attendance.marked_by_id`. Hand-listing them guarantees drift. Instead the delete runs in a transaction and catches Postgres `23503` (foreign key violation), rolls back, and returns *"This member has history. Deactivate instead."* Every one of those constraints defaults to `NO ACTION`, including the nullable `*_by_id` columns, so any referencing row anywhere blocks the delete and the check stays correct when a tenth table is added.

(An earlier draft of this section said "thirteen columns across eight tables." Three independent recounts against `schema.sql` during implementation — a reviewer, an implementer, and a re-reviewer — agreed on twelve across nine. The figure is descriptive only; nothing in the code enumerates these columns, which is the entire point of catching `23503` instead.)

**Validation is server-side** and mirrors §7.2 exactly: `role` against the existing CHECK values, `position` against the allowed set for the submitted placement, `flight` against `FLIGHT_ORDER` plus `'Squadron Staff'`, `shop_id` against `shops`. A hand-crafted request cannot write `position = 'Ncoic'`.

**Slug conflicts** surface as a specific message. Generation lowercases the last name, appends the first initial if taken (`fernandez-g`), then a numeral. The database `UNIQUE` constraint remains the arbiter; a `23505` violation returns the friendly conflict rather than a 500, which also covers two members being created concurrently.

## 9. Frontend surfaces

### 9.1 `/roster` (new page)

**Shell gating differs from the other leadership pages.** `/build` and `/records` serve their shell to any logged-in member and rely on the APIs to `403`. `/roster` redirects unless the session holds `can_manage_roster` — the page lists every member including inactive ones, and there is no reason to serve the frame to seventy-one people who cannot use it.

Layout mirrors `/records`: searchable member browser left, detail panel right.

The browser lists **active and inactive together**, inactive de-emphasised, with a filter to hide them. Each shop group header carries its composition warning from §7.3.

The detail panel is one form in create or edit mode: last name, first name, rank, shop, **placement**, email, sign-in name and active. Sign-in name shows its generated value on create and carries a warning on edit that it changes how the member signs in.

The **roster-admin toggle sits outside that form**, visible only to holders. It issues its own request to `PATCH /api/roster/members/:id/admin` and is never part of the form's save payload, so §8's guarantee holds at the UI as well as the API: the ordinary edit path cannot alter access control.

Deactivate, hard delete, granting the admin flag, and granting `leadership` all route through `uiConfirm` from the shared layer.

**Delete is always offered, and the refusal is the affordance.** Because §8 detects "unreferenced" by attempting the delete and catching the foreign-key violation, the server cannot report deletability in advance without the hand-maintained column list that approach exists to avoid. So the control is always present; on `23503` the dialog becomes *"This member has history and can't be deleted. Deactivate instead?"* with deactivate as the confirming action. One click either way, and no second source of truth about what is referenced.

A third button joins Task Builder and Records in Leadership Tools, shown only to holders.

### 9.2 Extracted member browser

The shop-grouped searchable list currently inside `records.html` moves to `public/member-browser.js`, with its styles joining `design.css`. Not into `ui.js` — that file is primitives (toast, confirm dialog, focus trap) and a component of this size would blur its purpose.

```js
renderMemberBrowser(host, members, { onSelect, showInactive, groupBadge })
```

`/records` passes a callback that loads history. `/roster` passes one that loads the edit form, plus `groupBadge` for composition warnings.

**`/records` behaviour must be unchanged.** That is the regression bar for the extraction and is verifiable by diffing its rendered DOM before and after.

### 9.3 Member app

Two additive changes, and no member-facing SQL is touched.

`GET /api/auth/me` gains a `can_manage_roster` boolean, read from the session rather than from its query — the value is already there from login. `index.html` gains a Roster button in Leadership Tools that stays hidden unless that boolean is true.

Nothing a member sees or does changes.

## 10. Key flows

**Retiring Jon Fernandez (the driving example).** Three independent edits, in any order:

1. Open Fernandez, set inactive. He can no longer sign in, leaves every roster and rollup, drops off the org chart, and is skipped by `copyForward`. All of his task history remains in `/records`.
2. Open the incoming SNCOIC, set placement to **Shop lead / SNCOIC**. The server writes `role='leadership'`, `position='SNCOIC'`.
3. Open the incoming supervisor, set placement to **Shop supervisor**. The server writes `role='supervisor'`.

Between steps 2 and 1 the Electrical shop momentarily holds two leads; between 1 and 2 it holds none. Both are flagged in the browser and neither is blocked.

**Adding a new arrival.** Create with name, rank, shop and placement. Slug is generated and shown. They sign in with their last name and are forced to choose a password on first login — the same experience as every existing account.

**Granting roster management.** A holder opens a member and enables the toggle, confirming a dialog that names what it unlocks. Revoking the last active holder is refused per §6.

## 11. Edge cases and error handling

- **Last active holder** — revoke, deactivate and delete all refused with the specific message (§6).
- **Member with history** — delete refused, deactivate offered (§8).
- **Slug collision** — friendly conflict; generation already disambiguates the live Fowler ×2 and Fernandez ×2 cases.
- **Missing `first_name`** — one active member has none. Slug disambiguation and display must not assume it exists.
- **Inactive member matched or referenced** — reported distinctly rather than silently ignored.
- **Reactivation** — restores login and roster membership; their historical tasks were never removed, so nothing needs rebuilding.
- **Shop change mid-cycle** — tasks are per-member, not per-shop, so a member carries their tasks with them. Shop rollups shift accordingly, which is correct.
- **Self-edit** — a holder may edit their own record but cannot revoke their own flag or deactivate themselves while they are the last active holder.

## 12. Testing

`node:test` against a disposable Postgres via `TEST_DATABASE_URL`, matching the existing 86-test suite.

**Invariant (§6)** — revoking the last holder's flag refused; deactivating the last holder refused; deleting the last holder refused; two concurrent revocations cannot both succeed; revoking a non-last holder succeeds.

**Delete guard** — a member referenced from each of the nine tables is refused and the transaction rolls back cleanly; a freshly created, unreferenced member is deleted.

**Placement derivation** — each placement writes the correct triple; a request carrying a `position` outside the allowed set for its placement is rejected. Paired with org-chart assertions: Shop lead lands in `shop.ncoic`, Flight leader lands in `flight.leaders`, Shop supervisor lands in `shop.supervisors`.

**Slug** — generation disambiguates against the real Fowler and Fernandez collisions and against a member with no `first_name`; a duplicate returns the conflict, not a 500.

**Deactivation semantics** — an inactive member cannot log in, is excluded from `copyForward`, is absent from the org chart, and their history still resolves in `/records`. This last assertion is the guarantee the whole design rests on.

**Authorisation** — every `/api/roster/*` endpoint rejects a `leadership` session without the flag, confirming the twenty-one-versus-two distinction actually holds.

## 13. Migration, rollout and git base

Branch from freshly-fetched `origin/master`.

1. Deploy the migration (idempotent, no data change).
2. Run the seeding statement (§5.3) for `gablin` and `mcnaughton`.
3. Verify both accounts see the Roster button and no other leadership account does.

`import-members.js` is untouched and remains available for bulk work. No rollback is needed beyond reverting the deploy: the two new columns are additive and ignored by every existing query.

## 14. Out of scope / future

- **Bulk roster import in-browser.** `import-members.js` covers initial load and mass changes.
- **Full audit log.** `updated_at` / `updated_by_id` give minimal accountability; a change-history table can be added later without disturbing this design.
- **`SQUADRON_WIDE_SLUGS`.** `server.js` hardcodes `new Set(['gablin'])` to grant all-shop access. It is the same category of problem `can_manage_roster` solves and should probably become a flag too, but it is a separate concern and changing it here would widen the blast radius of this work.
- **Retiring the `role` column in favour of capabilities.** The placement model already hides `role` from the user. If more capabilities appear, revisiting the ladder becomes worthwhile.
