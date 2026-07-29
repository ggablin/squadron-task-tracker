# 108 CES Task Tracker — Shop Attendance Marking

**Date:** 2026-07-28
**Status:** Design approved (brainstorming). Not yet implemented.
**Author/driver:** Greg Gablin
**Base branch for implementation:** `origin/master` (currently `13debad`)

---

## 1. Goal

Let shop supervisors record UTA attendance for their members from a personal phone, replacing an Excel file in MS Teams that can only be opened on a government computer.

The spreadsheet is consumed two ways today, and both must survive the move:

1. **Tally** — someone keys the weekend's attendance into the official system for pay and points.
2. **Reference** — the squadron keeps the sheet to answer later questions about who was where.

So the feature needs a clean export for the transcribe step, per-cycle history, and a light record of who marked what.

## 2. Background

The deployed app (`108ces.up.railway.app`) already models everything this needs: `uta_cycles` with exactly one `is_current` cycle, `members` scoped by `shop_id`, and a session-based permission pattern where supervisors are pinned to their own shop while leadership switches shops via `?shop_id`. My Shop already has a supervisor-only button row (the Records link) sitting above its three all-hands sub-tabs.

Attendance is the first thing in My Shop that is both **supervisor-only** and an **editing task** rather than a reference view, which is why it belongs in that button row rather than as a fourth sub-tab.

## 3. Decisions locked (from brainstorming)

| Decision | Choice |
|---|---|
| Record role | **Both** — tally for transcription *and* squadron historical reference |
| Granularity | **Per UTA period**, count varies by cycle: 4 for a two-day UTA, 6 for Fri–Sun, 8 for an occasional four-day drill. Read from the cycle, never assumed |
| Status set | `present`, `excused`, `unexcused`, `ruta`, `at`, `deployed` |
| Unmarked state | **No row = unmarked.** There is no `unmarked` status and no implicit "present" |
| Placement | **Button row in My Shop**, beside Records — *not* a fourth sub-tab |
| Navigation | **In-app takeover view** with a back chevron, not a separate page like `/build` |
| Button sizing | New `.shop-tool-btn` variant, ~48px tall (current `.add-btn` is ~30px, under the 44px tap-target minimum) |
| Editing surface | **Per-period list** — pick a period, see the whole shop, mark it |
| Confirm surface | **Read-only members × periods grid** below the list |
| Status control | **Colored chip per row**, tapping opens the existing `.modal-sheet` picker |
| Bulk action | **Per-period "Mark all present"** only; no whole-weekend shortcut |
| Audit trail | `marked_by_id` + `updated_at` on the row; **no** append-only log table |
| Shop attribution | **Snapshot `shop_id`** on the row, not derived through `members` |
| Write window | **Live cycle only**; archived cycles are read-only |
| Export | **Client-side**, Copy (TSV) primary + CSV download |
| Member self-view | **Out of scope for v1** |

## 4. Scope

**In scope**
- `attendance` table, `uta_cycles.period_count`, and migrations.
- Period-label derivation from `start_date` + `period_count`.
- Attendance takeover view in My Shop: period switcher, member list, chip + sheet picker, per-period "Mark all present", read-only summary grid.
- `.shop-tool-btn` styling; Records and Attendance as an equal-width pair on phones.
- Four endpoints (§6), all reusing existing auth middleware.
- Client-side Copy/CSV export.
- Leadership per-shop coverage card on the Squadron tab.
- Unit tests for the pure logic in `lib/attendance.js`; endpoint tests via `test/helpers/db.js`.

**Out of scope**
- Members viewing their own attendance (§11).
- Offline queueing / background sync (§9).
- Append-only status history (§5.3).
- Any automated push into the official system of record — the transcribe step stays manual.
- Absence *reasons* beyond the six statuses and a free-text note; no medical detail.

## 5. Data model changes

### 5.1 New table

```sql
CREATE TABLE IF NOT EXISTS attendance (
  id            SERIAL PRIMARY KEY,
  uta_cycle_id  INTEGER NOT NULL REFERENCES uta_cycles(id),
  member_id     INTEGER NOT NULL REFERENCES members(id),
  shop_id       INTEGER REFERENCES shops(id),
  period        SMALLINT NOT NULL CHECK (period BETWEEN 1 AND 12),
  status        VARCHAR(12) NOT NULL CHECK (status IN
                  ('present','excused','unexcused','ruta','at','deployed')),
  note          TEXT,
  marked_by_id  INTEGER REFERENCES members(id),
  updated_at    TIMESTAMP DEFAULT NOW(),
  UNIQUE (uta_cycle_id, member_id, period)
);
CREATE INDEX IF NOT EXISTS idx_attendance_cycle_shop
  ON attendance (uta_cycle_id, shop_id);
```

### 5.2 Cycle change

```sql
ALTER TABLE uta_cycles ADD COLUMN IF NOT EXISTS period_count SMALLINT DEFAULT 4;
```

Goes in the existing idempotent `DO $$ ... EXCEPTION WHEN others THEN NULL; END $$;` migration block in `schema.sql`, matching how every prior column was added.

### 5.3 Rationale for the four non-obvious choices

**No row means unmarked.** There is deliberately no `unmarked` enum value. If an unmarked period defaulted to "present," a supervisor who never opened the app would generate a clean full-attendance record for their entire shop, and nobody could tell the difference between "everyone showed up" and "nobody reported." Row-presence-as-marked is also what makes the leadership coverage card (§7.4) possible.

**`period_count` on the cycle.** UTAs are not a fixed length: two days is four periods, Fri–Sun is six, and an occasional four-day drill is eight. Nothing in the schema, API, or UI may hard-code any of those — the count is read from the cycle everywhere, and every loop, denominator, and export column derives from it.

The two-layer validation matters here. The `CHECK (period BETWEEN 1 AND 12)` is only a garbage guard, deliberately loose enough that no realistic drill length ever requires a migration; it is **not** the real limit. The real limit is enforced in the API, which rejects any `period > cycle.period_count`. Putting the true bound in the database would mean a schema change every time drill length varies, which is precisely the trap this design exists to avoid.

**`shop_id` snapshotted.** Deriving the shop by joining through `members` would silently re-attribute a member's past attendance to their new shop the day they transfer. One column preserves correct history, which the "reference later" requirement depends on.

**No append-only log.** `marked_by_id` + `updated_at` answers "who set this and when," which is the stated need. A full log answers "it was Present at 0912 and changed to Unexcused at 1400," which attendance rarely needs — corrections are typically typo fixes, not meaningful state progressions. `shop_event_status_log` is the precedent if this is ever wanted; adding it later is a pure addition, not a migration of existing rows.

## 6. API surface

All four reuse `requireAuth`, `requireRole('supervisor')`, and `requireOnboarded` exactly as `/api/shop/events` does. No new authorization concept is introduced.

```
GET   /api/shop/attendance[?shop_id=]   → { cycle, periods[], members[], rows[], coverage }
PUT   /api/shop/attendance              → upsert one { member_id, period, status, note }
POST  /api/shop/attendance/present      → { period } — fill unmarked rows only
GET   /api/squadron/attendance          → per-shop coverage (leadership only)
```

**Shop scoping.** Supervisors may only read and write rows for members whose `shop_id` matches `req.session.shopId`; leadership may target any shop through the existing `?shop_id` switcher. This mirrors the check already in `/api/shop/members/:id/tasks` verbatim.

**Write window.** `PUT` and `POST` reject any cycle whose `status` is not `live` with 403. Archived cycles remain readable so history and export keep working.

**Upsert.** `INSERT ... ON CONFLICT (uta_cycle_id, member_id, period) DO UPDATE SET status, note, marked_by_id, updated_at` — the same additive pattern `tasks` uses. Re-marking is idempotent, so a retry over a flaky connection is always safe.

**"Mark all present" never overwrites.** The bulk endpoint inserts only for (member, period) pairs with no existing row, so an exception already recorded survives a later bulk tap. It returns the rows it actually created.

## 7. Frontend surfaces

All changes are in `public/index.html`, following the file's existing conventions.

### 7.1 Button row

`#shop-records-link` becomes a two-button row holding Records and Attendance, both gated to `['supervisor','leadership']` by the existing `applyRole()`. New `.shop-tool-btn` class: ~48px tall, 14px text, 18px icons, `flex: 1` on phones so the pair splits the width evenly, auto width on desktop. The three existing sub-tabs are untouched.

### 7.2 Attendance takeover view

Replaces the My Shop content area; back chevron returns to the tabs.

- **Period switcher** — prev/next through periods 1..`period_count`, labelled from `start_date` (e.g. "UTA 3 · Saturday AM"), with an `n/total marked` coverage readout.
- **Mark all present** — one tap, fills unmarked rows for the visible period only.
- **Member list** — one full-width row per active shop member, status shown as a colored chip. Colour encodes *whether it needs follow-up*, not merely whether the member was there: quiet/`--ok` for `present`; amber/`--warn` for `excused`, `ruta`, `at`, `deployed` (absent but authorized); red/`--urgent` for `unexcused` alone; outline for unmarked. Ten identical dropdowns communicate nothing at a glance; ten chips make the exceptions visible without reading.
- **Status sheet** — tapping a chip opens the existing `.modal-sheet` with the six statuses and an optional note field.
- **Summary grid** — read-only members × periods with single-letter codes, for confirming nothing is missing and for reading across during transcription. It must sit in its own `overflow-x: auto` container: a name column plus eight single-character columns still fits a 375px screen, but only just, and the grid is the one element here whose width grows with drill length. Scoping the scroll to the grid means a longer drill degrades into a swipeable table instead of making the whole page scroll sideways.
- **Export** — Copy (TSV to clipboard, pastes straight into Excel) and Download CSV. Both generated client-side from data already loaded; no endpoint.

### 7.3 Why per-period rather than a grid

A members × periods editing grid mirrors the spreadsheet, but six columns of tap targets on a 375px screen means horizontal scrolling and mis-taps — and the phone is the entire reason for the feature. The per-period list matches how the work actually happens: most people are present most periods, so the dominant flow is *mark all present, then fix the exceptions*. For a nine-person shop with two exceptions across a six-period weekend that is roughly ten taps total.

### 7.4 Leadership roll-up

One card on the Squadron tab, inside the existing leadership-gated `#sq-rollups`, listing each shop's coverage for the current cycle sorted least-complete first. This answers the question the spreadsheet cannot: not "who was absent" but "which shops haven't reported yet."

## 8. Key flows

1. **Normal marking.** Supervisor opens My Shop → Attendance → period defaults to the first incomplete one → taps "Mark all present" → taps the one or two exceptions → chip updates optimistically → advances to the next period.
2. **Correction.** Supervisor returns to the period, taps the chip, picks the correct status. Upsert overwrites; `marked_by_id` and `updated_at` change.
3. **Transcription.** Supervisor or McNaughton opens the view at a desk, taps Copy, pastes into Excel, keys it into the official system.
4. **Leadership chase.** Sunday afternoon, leadership opens Squadron, sees which shops are short, and follows up.

## 9. Edge cases & error handling

| Case | Handling |
|---|---|
| Member added to shop mid-cycle | Appears unmarked in every period; coverage denominator grows. No backfill. |
| Member changes shops mid-cycle | Existing rows keep their snapshotted `shop_id`; new marks record the new shop. |
| Inactive member | Excluded from the list and the coverage denominator, matching `/api/shop/members`. |
| Archived cycle | Readable and exportable; all writes 403. |
| Two supervisors marking at once | Last write wins via upsert. Acceptable — shops have one supervisor. |
| Write fails (no signal) | Chip reverts, `showToast` reports it. Idempotent upsert means retry is safe. |
| No signal at all | **Not handled in v1.** No offline queue. A shop bay with no bars is a walk-ten-feet problem, not an architecture problem. Revisit only if it actually bites. |
| `period_count` changed after marking | Rows above the new count are retained but hidden; no destructive cleanup. |

## 10. Testing

Following the split already in the repo:

- **`lib/attendance.js` (pure, unit-tested):** period-label derivation from `start_date` + `period_count` — covering 4-, 6-, and 8-period cycles and a non-Friday start, since drill length is the one input most likely to be assumed constant by mistake — plus coverage math and the "fill unmarked only" set logic.
- **Endpoint tests** via the existing `test/helpers/db.js` harness: supervisor cannot write outside their shop; leadership can; archived cycles reject writes; upsert is idempotent; bulk present does not overwrite an existing exception; **a period above the cycle's `period_count` is rejected, and period 8 is accepted on an 8-period cycle.** That last pair is the regression guard against re-introducing a fixed period ceiling.

**Prerequisite:** the suite requires `TEST_DATABASE_URL`, which is currently unset — `npm test` fails on import for every file today, on master as well as any branch. This must be set before implementation, since unlike the PFRA work this feature has real server-side logic worth testing.

## 11. Out of scope / future

- **Member self-view.** Cheap to add and there's a fair argument for the correction loop it creates. Deferred because marks are provisional until the weekend closes, and surfacing a half-entered record to ~70 people invites disputes about data that isn't final. Revisit after a cycle or two of real use.
- **Append-only status history** (§5.3).
- **Offline queueing** (§9).
- **Automated feed into the official system.** The transcribe step stays manual by design.

## 12. Confirmed assumptions (approved 2026-07-28)

1. The Excel is both a tally for official transcription and a squadron historical reference.
2. Attendance is recorded per UTA period at two periods per day, so a cycle has 4, 6, or occasionally 8 periods for a two-, three-, or four-day drill. Any even count is supported without a schema change; only the API's `period <= period_count` check bounds it.
3. The status vocabulary is exactly: present, excused, unexcused, RUTA, AT, deployed.
4. Supervisors mark their own shop; leadership may mark any shop via the existing switcher.
5. Members do not see their own attendance in v1.
6. Existing style tokens are correct; only the tool buttons need to be larger.
