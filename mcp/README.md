# squadron-tracker-mcp-server

An MCP (Model Context Protocol) server that lets Claude read and update the
108 CES UTA Task Tracker — tasks, shop events/work orders, roster members,
rollups, the squadron calendar, and the pre-UTA build of the next cycle — by
driving the tracker's own HTTP API as a signed-in member.

**It does not touch the database.** Every call goes through the same routes the
web app uses, so role guards, live-cycle checks, attribution, and push
notifications behave exactly as if the actions were taken in the browser, by
the account whose credentials it holds.

## Setup

Requires Node ≥ 20 (the repo pins 24.x). From this directory:

```
npm install
```

Register with Claude Code (user scope — available in every project on this
machine):

```
claude mcp add squadron-tracker --scope user \
  --env TRACKER_BASE_URL=https://108ces.up.railway.app \
  --env TRACKER_SLUG=<your sign-in name> \
  --env TRACKER_PASSWORD=<your password> \
  -- node "<absolute path to this repo>/mcp/src/index.js"
```

| Env var | Meaning |
|---|---|
| `TRACKER_BASE_URL` | Tracker origin. Defaults to production; point at `https://staging-tracker-production.up.railway.app` to rehearse safely. |
| `TRACKER_SLUG` | The sign-in name of the account the server acts as. |
| `TRACKER_PASSWORD` | That account's password. Stored in `~/.claude.json` (plaintext, local machine) — same trust level as any MCP credential. Never commit it. |

Everything the server does is performed **as that account** and inherits its
role (member / supervisor / leadership) and roster-admin capability. The
account must have completed its first-login password change; until then the
API blocks writes and `tracker_whoami` says so.

## Tools (40)

**Reads** — `tracker_whoami`, `tracker_my_tasks`, `tracker_member_tasks`,
`tracker_shop_members`, `tracker_squadron_rollup`, `tracker_medical_rollup`,
`tracker_squadron_attendance`, `tracker_shop_events`, `tracker_event_log`,
`tracker_roster`, `tracker_categories`, `tracker_cycles`, `tracker_calendar`,
`tracker_duties`.

**Writes** — `tracker_set_task_state` (the checkbox — idempotent, reversible),
`tracker_flag_task`, `tracker_add_task`, `tracker_add_squadron_task` (bulk;
requires `confirm: true` because it notifies every recipient),
`tracker_create_event`, `tracker_update_event` (full replace — resend fields
you want kept), `tracker_update_event_status`, `tracker_delete_event`
(requires `confirm: true`), `tracker_add_member`, `tracker_update_member`.

### Calendar authoring

`tracker_calendar` reads two tables and both are writable:

| | Add | Update | Remove |
|---|---|---|---|
| Drill weekends | `tracker_add_drill` | `tracker_update_drill` | `tracker_remove_drill` |
| TDY / training rotations | `tracker_add_calendar_event` | `tracker_update_calendar_event` | `tracker_remove_calendar_event` |

**No-UTA months are derived, never stored.** `lib/drill-calendar.js` computes
them from the gaps between drill rows, and a drill spanning a month boundary
(30 Apr – 2 May) covers both months. So loading a year means entering only its
drills — the No-drill months fall out on their own, and no tool accepts a
`no_uta` field to set.

**These updates are PARTIAL, unlike `tracker_update_event`.** Both PATCH routes
merge what you send over the stored row and validate the result, so an omitted
field is kept, not cleared — marking a rotation complete is `status` alone.
`tracker_update_event`, for *shop* events, is a full replace. Two update tools
with opposite semantics is a genuine trap; the descriptions say so at both ends.

Drills may not overlap (a 409 names the clash) and cap at seven days. Rotations
have neither rule: two in one week, and one running across a drill, are both
normal. Prefer setting a called-off rotation to `cancelled` over deleting it —
the calendar shows cancelled rotations on purpose.

### Pre-UTA prep

Building the next cycle, in the order it is worked. These tools are
**bulk-shaped, not CRUD-shaped** — prep is "load forty tasks", not "edit one";
single-row corrections belong in `/build`, where you are already looking at the
draft.

| Step | Tool | Notes |
|---|---|---|
| Open a draft | `tracker_open_cycle` | Dates default to the next drill weekend on the calendar |
| See what recurred | `tracker_prior_groups` | The menu copy-forward picks from |
| Seed from last cycle | `tracker_copy_forward` | Tasks, schedule and WOs; the biggest saving in prep |
| Load the delta | `tracker_load_tasks`, `tracker_load_schedule`, `tracker_load_work_orders` | Bulk, ≤ 50 per call |
| Correct | `tracker_edit_task_group`, `tracker_delete_task_group` | Keyed on `{category_code, title}` |
| Review | `tracker_review_draft` | Groups + schedule + WOs + batches in one read |
| Undo a load | `tracker_undo_batch` | Reverses exactly one batch |

Why this is safe to automate, and where the line sits: a task added to a
**draft** notifies nobody (go-live is what announces them), every bulk load
returns a `batch_id` that `tracker_undo_batch` reverses, and schedule/work-order
writes are refused on an archived cycle. Silent, reversible, gated.

Copy-forward carries each group to whoever held it last cycle **and is still
active**, so departed members drop out on their own.

**Deliberately not exposed** — **go-live**, the one irreversible push to ~70
phones; it stays in `/build`, behind a human who meant it. Also cycle deletion,
member deletion, password reset, the roster-admin toggle, placement/role
changes, sign-in-name edits, and anything wrapping the destructive
`import-tasks.js` full-replace. `test/tools.test.js` asserts go-live's absence,
so re-adding it fails a test rather than slipping through review. Widening the
surface is one `tool(...)` registration in `src/index.js`; keep the
confirm-parameter pattern for anything with blast radius.

## Tests

```
npm test        # unit tests — stubbed fetch + tool registration, no network
npm run smoke   # live end-to-end against STAGING (refuses non-staging URLs)
npm run smoke:prep  # live pre-UTA prep pipeline against STAGING; cleans up after itself
```

`npm test` covers two things: `client.test.js` stubs fetch to exercise the
session/retry/error logic, and `tools.test.js` boots the real server over stdio
with fake credentials and inspects the registered tool list. The second needs no
tracker — registration happens at boot — so a malformed `inputSchema` fails in
CI rather than in front of someone mid-UTA.

Both smoke tests need `TRACKER_BASE_URL` (staging), `TRACKER_SLUG`, and
`TRACKER_PASSWORD` in the environment, and both refuse to run against a URL that
does not look like staging. `smoke`'s only write is flipping one of the account's
own tasks, which it restores to the exact prior state before exiting.
`smoke:prep` creates a throwaway **draft** cycle named `ZZ Prep Smoke <stamp>`,
runs the whole prep pipeline through it, and deletes it in a `finally` block — a
draft notifies nobody, so nothing it does reaches a member's phone. It also
exercises the calendar tools against far-future 2099 dates, removing those rows
through the remove tools on the way out, which covers the confirm gate too. If a
run is killed mid-way it prints the ids to delete by hand. It needs a leadership
account with roster-admin rights and at least one live or archived cycle to copy
from. Staging accounts are listed in `docs/2026-08-19-mobile-app-handoff.md`.

These tests are not part of the root `npm test` suite (they need no database)
and do not run in CI.

## Design notes

- **Session auth, no app changes.** The app has no API tokens; the client
  (`src/client.js`) does `POST /api/auth/login`, holds the `connect.sid`
  cookie (30-day rolling), and re-logins exactly once on a 401 before
  surfacing the error.
- **Errors are text an agent can act on.** API error bodies (`{error}` /
  `{error, message}`) pass through verbatim with status-specific hints
  (credentials, pending password change, permissions, stale ids).
- **Responses are JSON text**, truncated at 25k characters with guidance to
  narrow the query.
- The server itself is plain-JS ESM with no build step, matching the repo.
