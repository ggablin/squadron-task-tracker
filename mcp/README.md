# squadron-tracker-mcp-server

An MCP (Model Context Protocol) server that lets Claude read and update the
108 CES UTA Task Tracker — tasks, shop events/work orders, roster members,
rollups — by driving the tracker's own HTTP API as a signed-in member.

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

## Tools (24)

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

**Deliberately not exposed** — task/member/duty/cycle deletion, cycle
authoring and go-live, placement/role changes, sign-in-name edits, and
anything wrapping the destructive `import-tasks.js` full-replace. Use `/build`
and `/roster` in the web app for those. Widening the surface is one
`tool(...)` registration in `src/index.js`; keep the confirm-parameter pattern
for anything with blast radius.

## Tests

```
npm test        # unit tests — stubbed fetch, no network
npm run smoke   # live end-to-end against STAGING (refuses non-staging URLs)
```

The smoke test needs `TRACKER_BASE_URL` (staging), `TRACKER_SLUG`, and
`TRACKER_PASSWORD` in the environment. Its only write is flipping one of the
account's own tasks, which it restores to the exact prior state before exiting.
Staging accounts are listed in `docs/2026-08-19-mobile-app-handoff.md`.

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
