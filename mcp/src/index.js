#!/usr/bin/env node
// squadron-tracker-mcp-server — drive the 108 CES UTA Task Tracker from Claude.
//
// A thin stdio MCP wrapper over the tracker's own HTTP API (see ../README.md).
// Every tool goes through TrackerClient, which signs in as a real member, so
// role guards, live-cycle checks, and push notifications all behave exactly as
// they do in the app.
//
// The pre-UTA prep tools (below) DO author cycles, which an earlier version of
// this file ruled out wholesale. The line moved because the risk is not in
// authoring, it is in announcing: a task added to a DRAFT cycle notifies nobody
// (server.js is explicit about this), every bulk load returns a batch_id that
// DELETE /api/batches/:id reverses, and the schedule/work-order writes are gated
// by loadWritableCycle. Silent, reversible, gated.
//
// Still deliberately absent, and for reasons that have not moved:
//   go-live      - the one irreversible push to ~70 phones. It stays in /build,
//                  behind a human who meant it.
//   cycle delete - DELETE /api/cycles/:id takes the whole draft with it.
//   member delete, password reset, roster-admin toggle - destructive or
//                  credential-adjacent, with no prep workflow that needs them.
//   import-tasks.js - a destructive full-replace; sync-tasks.js is the additive
//                  path, and POST /api/cycles/:id/tasks is the additive path here.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { TrackerClient, describeError } from './client.js';

const CHARACTER_LIMIT = 25000;

const client = new TrackerClient();

const server = new McpServer({ name: 'squadron-tracker', version: '1.0.0' });

// ── response plumbing ────────────────────────────────────────────────────────

function respond(data) {
  let text = typeof data === 'string' ? data : JSON.stringify(data, null, 1);
  if (text.length > CHARACTER_LIMIT) {
    text = text.slice(0, CHARACTER_LIMIT) +
      `\n…truncated at ${CHARACTER_LIMIT} characters — narrow the request (shop_id, member_id, year) for the rest.`;
  }
  return { content: [{ type: 'text', text }] };
}

function fail(err) {
  return { content: [{ type: 'text', text: describeError(err) }], isError: true };
}

// Registration helper: shared try/catch so a thrown TrackerApiError always
// reaches the agent as actionable text instead of an MCP protocol error.
function tool(name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try { return respond(await handler(args ?? {})); }
    catch (err) { return fail(err); }
  });
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

// ── identity ─────────────────────────────────────────────────────────────────

tool('tracker_whoami', {
  title: 'Who am I',
  description:
    'Confirm the tracker connection and show the signed-in member: name, rank, role ' +
    '(member/supervisor/leadership), shop, roster-admin capability, and the current UTA cycle name. ' +
    'Call this first in a session to learn which operations the account can perform. ' +
    'Warns if the account still has a forced password change pending (writes would be blocked until ' +
    'it is completed in the web app).',
  inputSchema: {},
  annotations: READ,
}, async () => {
  const me = await client.get('/api/auth/me');
  return {
    ...me,
    base_url: client.baseUrl,
    warning: me.must_change_password
      ? 'This account has a pending forced password change — sign in once in the web app before using write tools.'
      : undefined,
  };
});

// ── task reads ───────────────────────────────────────────────────────────────

tool('tracker_my_tasks', {
  title: 'My tasks',
  description:
    'List the signed-in member\'s own tasks for the current UTA cycle. Each row: id, title, details, ' +
    'urgency, appointment fields (appt_day/appt_time/appt_location), category_code/label, ' +
    'informational (true rows have no checkbox), state (none|partial|done), note, is_flagged. ' +
    'For another member\'s list use tracker_member_tasks.',
  inputSchema: {},
  annotations: READ,
}, () => client.get('/api/tasks'));

tool('tracker_member_tasks', {
  title: 'A member\'s tasks',
  description:
    'List one member\'s tasks for the current cycle (same row shape as tracker_my_tasks). ' +
    'Requires supervisor (own shop) or leadership (any member). ' +
    'Find member ids with tracker_shop_members or tracker_roster.',
  inputSchema: {
    member_id: z.number().int().positive().describe('The member\'s id'),
  },
  annotations: READ,
}, ({ member_id }) => client.get(`/api/shop/members/${member_id}/tasks`));

tool('tracker_shop_members', {
  title: 'Shop members + progress',
  description:
    'List a shop\'s members with per-member task progress for the current cycle: id, name, rank, role, ' +
    'total_tasks, done_tasks, partial_tasks, and (for supervisor/leadership callers) activated + ' +
    'last_login_at. Defaults to the caller\'s own shop; leadership may pass shop_id to view any shop ' +
    '(shop ids from tracker_squadron_rollup or tracker_roster).',
  inputSchema: {
    shop_id: z.number().int().positive().optional()
      .describe('Leadership only: view this shop instead of your own'),
  },
  annotations: READ,
}, ({ shop_id }) => client.get('/api/shop/members', { shop_id }));

tool('tracker_squadron_rollup', {
  title: 'Squadron rollup',
  description:
    'Leadership only. Per-shop completion rollup for the current cycle: shop id/name, member_count, ' +
    'present_count, total/done tasks (all and present-only), and critical-task variants (crit_*). ' +
    'This is the top-level "how is the squadron doing" view.',
  inputSchema: {},
  annotations: READ,
}, () => client.get('/api/squadron'));

tool('tracker_medical_rollup', {
  title: 'Medical rollup',
  description:
    'Leadership only. Squadron-wide medical/dental readiness rollup for the current cycle, grouped by ' +
    'service (the task title carries the service name, e.g. "Dental Exam").',
  inputSchema: {},
  annotations: READ,
}, () => client.get('/api/squadron/medical'));

tool('tracker_squadron_attendance', {
  title: 'Squadron attendance',
  description:
    'Leadership only. Squadron attendance summary for the current cycle\'s drill periods.',
  inputSchema: {},
  annotations: READ,
}, () => client.get('/api/squadron/attendance'));

// ── task writes ──────────────────────────────────────────────────────────────

tool('tracker_set_task_state', {
  title: 'Check a task off (or un-check it)',
  description:
    'Set a task\'s completion state — the same upsert the app\'s checkbox performs, so it is safe to ' +
    'repeat and fully reversible. Members may update their own tasks; supervisors their shop\'s; ' +
    'leadership any. Fails with a clear message on informational rows (400), tasks outside your reach ' +
    '(403), and cycles closed to changes (403). The completion is attributed to the signed-in account. ' +
    'Task ids come from tracker_my_tasks / tracker_member_tasks.',
  inputSchema: {
    task_id: z.number().int().positive().describe('Task id'),
    state: z.enum(['none', 'partial', 'done']).describe("'done' checks off, 'none' clears, 'partial' = in progress"),
    note: z.string().max(2000).optional().describe('Optional note stored with the completion (replaces any existing note)'),
  },
  annotations: { ...WRITE, idempotentHint: true },
}, async ({ task_id, state, note }) => {
  await client.put(`/api/tasks/${task_id}`, { state, note });
  return { success: true, task_id, state, note: note ?? null };
});

tool('tracker_flag_task', {
  title: 'Flag / unflag a task',
  description:
    'Supervisor (own shop) or leadership: set or clear the priority flag on a task. Flagged tasks sort ' +
    'to the top of the member\'s category.',
  inputSchema: {
    task_id: z.number().int().positive().describe('Task id'),
    is_flagged: z.boolean().describe('true to flag, false to clear'),
  },
  annotations: { ...WRITE, idempotentHint: true },
}, async ({ task_id, is_flagged }) => {
  await client.put(`/api/tasks/${task_id}/flag`, { is_flagged });
  return { success: true, task_id, is_flagged };
});

tool('tracker_add_task', {
  title: 'Add a task for one member',
  description:
    'Create one task on the current cycle for a single member. Supervisor: own-shop members only; ' +
    'leadership: anyone. The assignee gets an in-app + push notification (unless you assign to ' +
    'yourself). category_code values come from tracker_categories. This is additive — it cannot ' +
    'touch existing tasks. For a whole shop or the squadron use tracker_add_squadron_task.',
  inputSchema: {
    member_id: z.number().int().positive().describe('Assignee member id'),
    category_code: z.string().min(1).describe('Category code from tracker_categories (e.g. cbt, medical, admin)'),
    title: z.string().min(1).max(300).describe('Task title — what the member sees'),
    details: z.string().max(2000).optional().describe('Optional details line'),
    urgency: z.enum(['overdue', 'this_uta', 'next_uta', 'future', 'info']).optional()
      .describe("Defaults to 'this_uta'"),
    appt_day: z.string().optional().describe("Optional appointment day, e.g. 'Saturday'"),
    appt_time: z.string().optional().describe("Optional appointment time, e.g. '0900'"),
    appt_location: z.string().optional().describe('Optional appointment location'),
    link_url: z.string().url().optional().describe('Optional https link shown on the task'),
  },
  annotations: WRITE,
}, (args) => client.post('/api/tasks', args));

tool('tracker_add_squadron_task', {
  title: 'Add a task for a whole shop or the squadron',
  description:
    'Leadership only. BULK create: inserts one task per active member of a shop (scope="shop" + ' +
    'shop_id) or of the entire squadron (scope="squadron"), and notifies every recipient — a ' +
    'squadron-wide task pushes to ~70 phones. Because of that blast radius, confirm must be exactly ' +
    'true, and you should restate the title and scope to the user before calling. Returns {created: N}.',
  inputSchema: {
    scope: z.enum(['squadron', 'shop']).describe("'squadron' = every active member; 'shop' = one shop"),
    shop_id: z.number().int().positive().optional().describe("Required when scope='shop'"),
    category_code: z.string().min(1).describe('Category code from tracker_categories'),
    title: z.string().min(1).max(300),
    details: z.string().max(2000).optional(),
    urgency: z.enum(['overdue', 'this_uta', 'next_uta', 'future', 'info']).optional()
      .describe("Defaults to 'this_uta'"),
    appt_day: z.string().optional(),
    appt_time: z.string().optional(),
    appt_location: z.string().optional(),
    confirm: z.literal(true).describe('Must be true — acknowledges this notifies every recipient'),
  },
  annotations: WRITE,
}, ({ confirm, ...args }) => client.post('/api/squadron/tasks', args));

// ── shop events / work orders ────────────────────────────────────────────────

tool('tracker_shop_events', {
  title: 'Shop schedule / work orders / emphasis items',
  description:
    'List a shop\'s events for the current cycle: id, event_type (schedule|work_order|emphasis), day, ' +
    'start_time, end_time, title, details, wo_number, status (open|in_progress|complete). Defaults to ' +
    'the caller\'s shop; leadership may pass shop_id.',
  inputSchema: {
    shop_id: z.number().int().positive().optional()
      .describe('Leadership only: view this shop instead of your own'),
  },
  annotations: READ,
}, ({ shop_id }) => client.get('/api/shop/events', { shop_id }));

tool('tracker_event_log', {
  title: 'Event status history',
  description:
    'The status-change log for one shop event/work order (newest first): status, note, timestamp, who. ' +
    'Own shop, or leadership for any shop.',
  inputSchema: {
    event_id: z.number().int().positive().describe('Event id from tracker_shop_events'),
  },
  annotations: READ,
}, ({ event_id }) => client.get(`/api/shop/events/${event_id}/log`));

tool('tracker_create_event', {
  title: 'Create a shop event',
  description:
    'Add a schedule item, work order, or emphasis item to a shop for the current cycle. Supervisor: ' +
    'own shop; leadership: any shop (pass shop_id); Operations/work control: work orders anywhere. ' +
    'Returns the created row.',
  inputSchema: {
    event_type: z.enum(['schedule', 'work_order', 'emphasis']),
    title: z.string().min(1).max(300),
    shop_id: z.number().int().positive().optional().describe('Target shop; defaults to your own'),
    day: z.string().optional().describe("e.g. 'Saturday'"),
    start_time: z.string().optional().describe("e.g. '0900'"),
    end_time: z.string().optional(),
    details: z.string().max(2000).optional(),
    wo_number: z.string().optional().describe('Work-order number, for work_order rows'),
  },
  annotations: WRITE,
}, (args) => client.post('/api/shop/events', args));

tool('tracker_update_event', {
  title: 'Edit a shop event (full replace)',
  description:
    'Rewrite an event\'s fields. IMPORTANT: this is a FULL REPLACE of event_type, title, day, ' +
    'start_time, end_time, details, and wo_number — any optional field you omit is CLEARED, so read ' +
    'the current row from tracker_shop_events first and resend every field you want to keep. Status is ' +
    'deliberately not editable here — use tracker_update_event_status so the history log stays true.',
  inputSchema: {
    event_id: z.number().int().positive(),
    event_type: z.enum(['schedule', 'work_order', 'emphasis']),
    title: z.string().min(1).max(300),
    day: z.string().optional(),
    start_time: z.string().optional(),
    end_time: z.string().optional(),
    details: z.string().max(2000).optional(),
    wo_number: z.string().optional(),
  },
  annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
}, ({ event_id, ...args }) => client.put(`/api/shop/events/${event_id}`, args));

tool('tracker_update_event_status', {
  title: 'Update event / work-order status',
  description:
    'Set an event\'s status (open|in_progress|complete) with a required note; both land in the ' +
    'permanent status log with your name. Any member may update their own shop\'s events; leadership ' +
    'any shop; work control any shop\'s work orders.',
  inputSchema: {
    event_id: z.number().int().positive(),
    status: z.enum(['open', 'in_progress', 'complete']),
    note: z.string().min(1).max(2000).describe('Required — what changed (goes in the history log)'),
  },
  annotations: { ...WRITE, idempotentHint: true },
}, async ({ event_id, status, note }) => client.put(`/api/shop/events/${event_id}/status`, { status, note }));

tool('tracker_delete_event', {
  title: 'Delete a shop event',
  description:
    'Permanently delete a shop event and its status history. This cannot be undone, so confirm must be ' +
    'exactly true and you should name the event to the user before calling. Same reach rules as ' +
    'tracker_create_event.',
  inputSchema: {
    event_id: z.number().int().positive(),
    confirm: z.literal(true).describe('Must be true — deletion is permanent'),
  },
  annotations: { ...WRITE, destructiveHint: true },
}, async ({ event_id }) => {
  await client.delete(`/api/shop/events/${event_id}`);
  return { success: true, deleted_event_id: event_id };
});

// ── roster ───────────────────────────────────────────────────────────────────

tool('tracker_roster', {
  title: 'Full roster (admin)',
  description:
    'Roster admins only. The full squadron roster — members (id, name, rank, shop, role, flight, ' +
    'position, slug, email, active, can_manage_roster), the shops list (use these ids for shop_id ' +
    'params), valid flights, and valid placements with their positions.',
  inputSchema: {},
  annotations: READ,
}, () => client.get('/api/roster'));

tool('tracker_add_member', {
  title: 'Add a member to the roster',
  description:
    'Roster admins only. Create a member. A sign-in name (slug) is generated from the last name, and ' +
    'the initial password IS that slug with a forced change on first login — tell the user the slug ' +
    'from the response so they can pass it to the new member. Placement determines role: shop_member, ' +
    'shop_supervisor, shop_lead (position NCOIC|SNCOIC), flight_leader (needs flight + position), ' +
    'squadron_staff (position e.g. Commander, First Sergeant). Get shop ids, flights, and placement ' +
    'details from tracker_roster.',
  inputSchema: {
    last_name: z.string().min(1).max(100),
    first_name: z.string().min(1).max(100),
    rank: z.string().min(1).max(20).describe('e.g. SrA, TSgt, MSgt, Capt'),
    shop_id: z.number().int().positive(),
    placement: z.enum(['shop_member', 'shop_supervisor', 'shop_lead', 'flight_leader', 'squadron_staff']),
    position: z.string().optional().describe('Required for shop_lead / flight_leader / squadron_staff — valid values per placement come from tracker_roster'),
    flight: z.string().optional().describe('Required for flight_leader: Infrastructure | Construction | R&O | EM'),
    email: z.string().email().optional(),
  },
  annotations: WRITE,
}, (args) => client.post('/api/roster/members', args));

tool('tracker_update_member', {
  title: 'Edit a roster member',
  description:
    'Roster admins only. Update a member\'s basic fields — only the fields you pass are changed. ' +
    'Setting active=false deactivates the member (hides them and their tasks from rollups; they can ' +
    'no longer sign in) — state that plainly to the user before doing it; the API refuses to ' +
    'deactivate the last roster admin. Placement/role changes and sign-in-name edits are deliberately ' +
    'not exposed here — use the web roster page for those.',
  inputSchema: {
    member_id: z.number().int().positive(),
    last_name: z.string().min(1).max(100).optional(),
    first_name: z.string().min(1).max(100).optional(),
    rank: z.string().min(1).max(20).optional(),
    shop_id: z.number().int().positive().optional().describe('Move the member to another shop'),
    email: z.string().email().nullable().optional().describe('null clears the email'),
    active: z.boolean().optional().describe('false deactivates — see description'),
  },
  annotations: { ...WRITE, idempotentHint: true },
}, ({ member_id, ...args }) => client.patch(`/api/roster/members/${member_id}`, args));

// ── reference data ───────────────────────────────────────────────────────────

tool('tracker_categories', {
  title: 'Task categories',
  description: 'List task categories: {code, label}. Codes are what tracker_add_task and tracker_add_squadron_task take.',
  inputSchema: {},
  annotations: READ,
}, () => client.get('/api/categories'));

tool('tracker_cycles', {
  title: 'UTA cycles',
  description:
    'Leadership only. List UTA cycles with status (draft/live/archived) and drill dates. Read-only — ' +
    'cycle authoring and go-live stay in the /build page on purpose.',
  inputSchema: {},
  annotations: READ,
}, () => client.get('/api/cycles'));

tool('tracker_calendar', {
  title: 'Drill calendar',
  description:
    'The year\'s drill weekends and TDY/training rotations, grouped by month, with each entry\'s id. ' +
    'noUta marks a month no drill touches — it is derived from the gaps between drills, never stored, ' +
    'so it is not something to set. Write with tracker_add_drill / tracker_update_drill / ' +
    'tracker_remove_drill for the drill weekends, and tracker_add_calendar_event / ' +
    'tracker_update_calendar_event / tracker_remove_calendar_event for the rotations. Optional year ' +
    '(default: current year); the response lists which years have data.',
  inputSchema: {
    year: z.number().int().min(2000).max(2100).optional(),
  },
  annotations: READ,
}, ({ year }) => client.get('/api/calendar', { year }));

tool('tracker_duties', {
  title: 'Additional duties',
  description: 'The squadron\'s additional-duties list (duty, primary/alternate holders). Read-only here; edited on the Resources → People page.',
  inputSchema: {},
  annotations: READ,
}, () => client.get('/api/duties'));

// ── calendar authoring ───────────────────────────────────────────────────────
// The two halves tracker_calendar reads. Drill weekends (drill_dates) are the
// UTA schedule itself; calendar events (calendar_events) are the TDY and
// training rotations that sit alongside them. Roster admins only, both.
//
// NOTE the merge semantics, which are the OPPOSITE of tracker_update_event:
// both updates here are PARTIAL — the server merges the fields you send over
// the stored row and validates the result, so omitting a field KEEPS it. Do not
// resend a whole row out of habit; that is the shop-event contract, not this one.
//
// No-UTA months are never written. lib/drill-calendar.js derives them from the
// gaps between drill rows, and a drill spanning a month boundary covers both
// months — so adding a year means adding only its drills.

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

tool('tracker_add_drill', {
  title: 'Add a drill weekend',
  description:
    'Put a drill weekend on the squadron calendar. Dates are YYYY-MM-DD and a drill runs at most seven ' +
    'days. Months with NO drill are not entered and must not be: the app derives them from the gaps, ' +
    'and a drill spanning a month boundary (30 Apr–2 May) covers both months, so entering the drills ' +
    'alone produces the right No-UTA months by itself. Use note for the combined-month label, e.g. ' +
    '"Apr & May combined". Refused with a 409 naming the clash if the dates overlap an existing drill. ' +
    'Roster admins only.',
  inputSchema: {
    start_date: ISO_DATE.describe('First day of the drill'),
    end_date: ISO_DATE.describe('Last day; same as start_date for a one-day drill'),
    note: z.string().max(80).optional().describe('e.g. "Apr & May combined"'),
  },
  annotations: WRITE,
}, ({ start_date, end_date, note }) =>
  client.post('/api/drill-dates', { start_date, end_date, note: note ?? null }));

tool('tracker_update_drill', {
  title: 'Correct a drill weekend',
  description:
    'Change a drill\'s dates or its note. PARTIAL update — send only what changes; anything omitted is ' +
    'kept, NOT cleared. (tracker_update_event, for shop events, is the opposite: a full replace. Do not ' +
    'carry that habit here.) The merged row is validated as a whole and checked for overlap against the ' +
    'other drills, so a one-field edit cannot produce an impossible drill. The id comes from ' +
    'tracker_calendar. Roster admins only.',
  inputSchema: {
    drill_id: z.number().int().positive().describe('From tracker_calendar'),
    start_date: ISO_DATE.optional(),
    end_date: ISO_DATE.optional(),
    note: z.string().max(80).nullable().optional().describe('Pass null to clear the note'),
  },
  annotations: WRITE,
}, ({ drill_id, ...body }) => client.patch(`/api/drill-dates/${drill_id}`, body));

tool('tracker_remove_drill', {
  title: 'Remove a drill weekend',
  description:
    'Delete a drill weekend from the calendar — a cancelled UTA, or a row entered by mistake. Deleting ' +
    'the only drill covering a month turns that month into a No-UTA month, since coverage is derived; ' +
    'that is usually the intent when a drill is cancelled, but check the month before removing one that ' +
    'was merely mis-dated, which tracker_update_drill fixes without the side effect. confirm must be ' +
    'exactly true and you should name the drill to the user first. Roster admins only.',
  inputSchema: {
    drill_id: z.number().int().positive().describe('From tracker_calendar'),
    confirm: z.literal(true).describe('Must be true — deletion is permanent'),
  },
  annotations: { ...WRITE, destructiveHint: true },
}, ({ drill_id }) => client.delete(`/api/drill-dates/${drill_id}`)
  .then(() => ({ deleted: drill_id })));

tool('tracker_add_calendar_event', {
  title: 'Add a TDY or training rotation',
  description:
    'Put a school, TDY or training rotation on the squadron calendar — RADR, Silver Flag, REOTS, a DFT ' +
    'and so on. Unlike drills these may overlap each other and overlap a drill, because two rotations ' +
    'in the same week is normal; there is no clash check and no length cap. attendees is free text ' +
    '(up to 600 characters), conventionally rank-and-surname separated by " / ". An event is listed ' +
    'under the month it STARTS in, so a fortnight-long DFT appears once. Roster admins only.',
  inputSchema: {
    title: z.string().min(1).max(120).describe('e.g. "Silver Flag"'),
    start_date: ISO_DATE,
    end_date: ISO_DATE,
    location: z.string().max(120).optional().describe('e.g. "Tyndall AFB, FL"'),
    attendees: z.string().max(600).optional().describe('Free text, e.g. "TSgt Grossmick / TSgt Price"'),
    status: z.enum(['scheduled', 'complete', 'cancelled']).optional().describe("Defaults to 'scheduled'"),
    note: z.string().max(200).optional(),
  },
  annotations: WRITE,
}, (body) => client.post('/api/calendar-events', body));

tool('tracker_update_calendar_event', {
  title: 'Update a TDY or training rotation',
  description:
    'Change a rotation — most often its status, as one completes or is cancelled. PARTIAL update: send ' +
    'only what changes and the rest is kept, NOT cleared. (tracker_update_event, for shop events, is a ' +
    'full replace; this is not.) So marking a rotation complete is status alone, with no need to resend ' +
    'the attendee list. The id comes from tracker_calendar. Roster admins only.',
  inputSchema: {
    event_id: z.number().int().positive().describe('From tracker_calendar'),
    title: z.string().min(1).max(120).optional(),
    start_date: ISO_DATE.optional(),
    end_date: ISO_DATE.optional(),
    location: z.string().max(120).nullable().optional(),
    attendees: z.string().max(600).nullable().optional(),
    status: z.enum(['scheduled', 'complete', 'cancelled']).optional(),
    note: z.string().max(200).nullable().optional(),
  },
  annotations: WRITE,
}, ({ event_id, ...body }) => client.patch(`/api/calendar-events/${event_id}`, body));

tool('tracker_remove_calendar_event', {
  title: 'Remove a TDY or training rotation',
  description:
    'Delete a rotation from the calendar. For one that was called off, prefer setting status to ' +
    '"cancelled" via tracker_update_calendar_event — the calendar shows cancelled rotations on purpose, ' +
    'so the squadron can see that it was scheduled and did not happen. Delete is for rows entered in ' +
    'error. confirm must be exactly true and you should name the event to the user first. Roster admins ' +
    'only.',
  inputSchema: {
    event_id: z.number().int().positive().describe('From tracker_calendar'),
    confirm: z.literal(true).describe('Must be true — deletion is permanent'),
  },
  annotations: { ...WRITE, destructiveHint: true },
}, ({ event_id }) => client.delete(`/api/calendar-events/${event_id}`)
  .then(() => ({ deleted: event_id })));

// ── pre-UTA prep ─────────────────────────────────────────────────────────────
// The build-a-cycle pipeline, in the order it is worked: open a draft, see what
// recurred, seed from it, load the delta, review, undo anything wrong. Go-live
// is the deliberate gap at the end.
//
// These tools are bulk-shaped, not CRUD-shaped, because prep is "load forty
// tasks", not "edit one". Single-row corrections go through /build, which is
// where you are already looking at the draft.

// Task groups are addressed by their natural key — {category_code, title} —
// not by id, because that is how the server addresses them too.
const GROUP_KEY = {
  category_code: z.string().min(1).describe('Category code, e.g. "CBT" — see tracker_categories'),
  title: z.string().min(1).describe('The group title, matched exactly'),
};

// GET /api/cycles/:id/groups embeds every member of every group, with their own
// urgency and appointment fields riding along for the /build drill-down. A real
// cycle's worth of that is tens of thousands of characters, which the 25k
// response cap then truncates mid-JSON — so the caller gets an unparseable
// string instead of the group list. Project it down to what choosing "does this
// recur?" actually needs; members are available on request, one group at a time.
function slimGroups(groups, includeMembers = false) {
  if (!Array.isArray(groups)) return groups;
  return groups.map(({ members, ...g }) => ({
    ...g,
    member_count: g.count ?? (Array.isArray(members) ? members.length : undefined),
    ...(includeMembers && Array.isArray(members)
      ? { members: members.map(m => ({ id: m.id, name: `${m.rank || ''} ${m.last_name || ''}`.trim() })) }
      : {}),
  }));
}

tool('tracker_open_cycle', {
  title: 'Open a draft UTA cycle',
  description:
    'Create a new DRAFT cycle to build the next UTA into. Nothing in a draft is visible to members and ' +
    'nothing notifies them until go-live, which stays in the /build page on purpose. Omit the dates and ' +
    'the next drill weekend on the squadron calendar is used, so they need not be retyped; pass them ' +
    'explicitly to override. Leadership only. Returns the cycle, whose id every other prep tool takes.',
  inputSchema: {
    name: z.string().min(1).describe('Cycle name, e.g. "Sep 2026 UTA"'),
    start_date: z.string().optional().describe('YYYY-MM-DD; defaults to the next drill weekend'),
    end_date: z.string().optional().describe('YYYY-MM-DD; defaults to the next drill weekend'),
  },
  annotations: WRITE,
}, async ({ name, start_date, end_date }) => {
  let source = 'supplied';
  if (!start_date && !end_date) {
    // Scan this year then next: the next drill is often in January.
    const thisYear = new Date().getUTCFullYear();
    for (const y of [thisYear, thisYear + 1]) {
      const cal = await client.get('/api/calendar', { year: y });
      const next = cal.months.flatMap(m => m.entries).find(e => e.kind === 'drill' && e.next);
      if (next) {
        start_date = next.start_date; end_date = next.end_date;
        source = `next drill weekend on the ${y} calendar (${next.label})`;
        break;
      }
    }
    if (!start_date) {
      return { error: 'No upcoming drill weekend is on the calendar, so the dates could not be ' +
                      'defaulted. Pass start_date and end_date, or add the drill first.' };
    }
  }
  const cycle = await client.post('/api/cycles', { name, start_date, end_date });
  return { cycle, dates_from: source,
           next: 'Use tracker_prior_groups to see what recurred last cycle, then tracker_copy_forward.' };
});

tool('tracker_prior_groups', {
  title: 'Task groups from a past cycle',
  description:
    'The task groups of an earlier cycle — category, title, how many members had each, plus whether ' +
    'details or urgency varied across them (details_mixed / urgency_mixed). This is the menu ' +
    'tracker_copy_forward picks from: read it first to decide what recurs this UTA and what does not. ' +
    'Returns group summaries with a member_count; set include_members to also list who held each one, ' +
    'which is much larger and may need a narrower request. Leadership only.',
  inputSchema: {
    cycle_id: z.number().int().positive().describe('The cycle to read groups FROM — usually last UTA'),
    include_members: z.boolean().optional()
      .describe('Also name the members in each group — verbose; off by default'),
  },
  annotations: READ,
}, async ({ cycle_id, include_members }) =>
  slimGroups(await client.get(`/api/cycles/${cycle_id}/groups`), include_members === true));

tool('tracker_copy_forward', {
  title: 'Seed a draft from a previous cycle',
  description:
    'Copy recurring work from a previous cycle into a draft — the single biggest saving in prep, since ' +
    'most of a UTA repeats. Choose any combination of tasks, schedule and work_orders via `include`. ' +
    'For tasks, each group carries forward to whoever held it last cycle AND IS STILL ACTIVE, so ' +
    'departed members drop out by themselves; pass member_ids on a group only to override that. ' +
    'Every copied task group lands as its own batch, so tracker_undo_batch reverses any one of them ' +
    'independently. Leadership only.',
  inputSchema: {
    cycle_id: z.number().int().positive().describe('The DRAFT cycle to copy INTO'),
    from_cycle_id: z.number().int().positive().describe('The cycle to copy FROM'),
    include: z.array(z.enum(['tasks', 'schedule', 'work_orders'])).min(1)
      .describe('Which kinds of work to carry forward'),
    groups: z.array(z.object({
      ...GROUP_KEY,
      member_ids: z.array(z.number().int().positive()).optional()
        .describe('Override the inherited roster for this group'),
    })).optional().describe('Required when include has "tasks" — from tracker_prior_groups'),
    schedule_refs: z.array(z.string()).optional()
      .describe('Limit the schedule copy to these refs; omit to copy all of them'),
  },
  annotations: WRITE,
}, async ({ cycle_id, from_cycle_id, include, groups, schedule_refs }) => {
  const out = {};
  if (include.includes('tasks')) {
    if (!groups || !groups.length) {
      return { error: 'include has "tasks", so `groups` is required — read tracker_prior_groups ' +
                      `for cycle ${from_cycle_id} and pass the ones that recur.` };
    }
    out.tasks = await client.post(`/api/cycles/${cycle_id}/copy-forward`, { from_cycle_id, groups });
  }
  if (include.includes('schedule')) {
    out.schedule = await client.post(`/api/cycles/${cycle_id}/schedule/copy-forward`,
      { from_cycle_id, ...(schedule_refs ? { refs: schedule_refs } : {}) });
  }
  if (include.includes('work_orders')) {
    out.work_orders = await client.post(`/api/cycles/${cycle_id}/work-orders/copy-forward`,
      { from_cycle_id });
  }
  return out;
});

tool('tracker_load_tasks', {
  title: 'Load task groups into a draft',
  description:
    'Add task groups to a cycle in bulk — the delta that tracker_copy_forward did not already cover. ' +
    'Each group is one task assigned to many members and lands as its own batch, reversible with ' +
    'tracker_undo_batch. Re-running is safe: a member who already holds an identical task is skipped, ' +
    'not duplicated. Adding to a DRAFT notifies nobody; adding to the LIVE cycle notifies each member ' +
    'who actually received a row, so check tracker_cycles for the status before loading. Leadership only.',
  inputSchema: {
    cycle_id: z.number().int().positive(),
    groups: z.array(z.object({
      title: z.string().min(1),
      category_code: z.string().min(1).describe('See tracker_categories'),
      details: z.string().optional(),
      member_ids: z.array(z.number().int().positive()).min(1)
        .describe('Everyone who gets this task — see tracker_roster'),
      link_url: z.string().optional(),
      document_id: z.number().int().positive().optional(),
    })).min(1).max(50),
  },
  annotations: WRITE,
}, async ({ cycle_id, groups }) => {
  const results = [];
  for (const g of groups) {
    const { member_ids, ...rest } = g;
    try {
      const r = await client.post(`/api/cycles/${cycle_id}/tasks`,
        { ...rest, assignments: [{ member_ids }] });
      results.push({ title: g.title, ...r });
    } catch (err) {
      // Report and keep going: one bad category should not strand the rest of a
      // forty-group load, and every batch already written stays undoable.
      results.push({ title: g.title, failed: describeError(err) });
    }
  }
  const failed = results.filter(r => r.failed).length;
  return { loaded: results.length - failed, failed, results };
});

tool('tracker_load_schedule', {
  title: 'Load schedule items into a draft',
  description:
    'Add schedule items to a cycle in bulk. Audience is either "all" (a squadron-wide event) or a list ' +
    'of shop ids, which writes one row per shop tied together as one editable event. Times are "0900" ' +
    'style, day is a weekday name. Refused on an archived cycle. Leadership only.',
  inputSchema: {
    cycle_id: z.number().int().positive(),
    items: z.array(z.object({
      title: z.string().min(1),
      audience: z.union([z.literal('all'), z.array(z.number().int().positive()).min(1)])
        .describe('"all", or the shop ids that see this item'),
      day: z.string().optional().describe("e.g. 'Saturday'"),
      start_time: z.string().optional().describe("e.g. '0900'"),
      end_time: z.string().optional(),
      details: z.string().optional(),
      kind: z.string().optional(),
    })).min(1).max(50),
  },
  annotations: WRITE,
}, async ({ cycle_id, items }) => {
  const results = [];
  for (const it of items) {
    try { results.push({ title: it.title, ...await client.post(`/api/cycles/${cycle_id}/schedule`, it) }); }
    catch (err) { results.push({ title: it.title, failed: describeError(err) }); }
  }
  const failed = results.filter(r => r.failed).length;
  return { loaded: results.length - failed, failed, results };
});

tool('tracker_load_work_orders', {
  title: 'Load work orders into a draft',
  description:
    'Add work orders to a cycle in bulk. One row per shop, so each needs its own shop_id. Refused on an ' +
    'archived cycle. Leadership only.',
  inputSchema: {
    cycle_id: z.number().int().positive(),
    items: z.array(z.object({
      title: z.string().min(1),
      shop_id: z.number().int().positive(),
      wo_number: z.string().optional(),
      day: z.string().optional(),
      start_time: z.string().optional(),
      end_time: z.string().optional(),
      details: z.string().optional(),
      status: z.string().optional().describe("Defaults to 'open'"),
    })).min(1).max(50),
  },
  annotations: WRITE,
}, async ({ cycle_id, items }) => {
  const results = [];
  for (const it of items) {
    try { results.push({ title: it.title, ...await client.post(`/api/cycles/${cycle_id}/work-orders`, it) }); }
    catch (err) { results.push({ title: it.title, failed: describeError(err) }); }
  }
  const failed = results.filter(r => r.failed).length;
  return { loaded: results.length - failed, failed, results };
});

tool('tracker_edit_task_group', {
  title: 'Edit a task group',
  description:
    'Change the details, urgency or attached link/document of every task in a group at once — for fixing ' +
    'a typo or re-prioritising after a load. Only the fields you pass are changed. Raising urgency on a ' +
    'LIVE cycle notifies the affected members, so it is not a silent edit there. Leadership only.',
  inputSchema: {
    cycle_id: z.number().int().positive(),
    ...GROUP_KEY,
    details: z.string().optional(),
    urgency: z.string().optional().describe('See the /build page for the valid values'),
    link_url: z.string().optional(),
    document_id: z.number().int().positive().optional(),
  },
  annotations: WRITE,
}, ({ cycle_id, ...body }) => client.put(`/api/cycles/${cycle_id}/groups`, body));

tool('tracker_delete_task_group', {
  title: 'Delete a task group',
  description:
    'Remove a whole task group from a cycle — the wrong group loaded, or work that turned out not to ' +
    'apply. Refused when members have already completed some of it unless force is true, which is the ' +
    'guard doing its job: check who completed it before overriding. Prefer tracker_undo_batch for ' +
    'something you have just loaded, since it reverses exactly that load. Leadership only.',
  inputSchema: {
    cycle_id: z.number().int().positive(),
    ...GROUP_KEY,
    force: z.boolean().optional().describe('Delete even though there are completions'),
  },
  annotations: { ...WRITE, destructiveHint: true },
}, ({ cycle_id, ...body }) => client.post(`/api/cycles/${cycle_id}/groups/delete`, body));

tool('tracker_review_draft', {
  title: 'Review a draft before go-live',
  description:
    'Everything loaded into a cycle, in one read: task groups with their member counts, the schedule, ' +
    'the work orders, and the batch history showing what each load added. This is the last check before ' +
    'someone opens /build and goes live — read it back and confirm it says what the newsletter says. ' +
    'Leadership only.',
  inputSchema: { cycle_id: z.number().int().positive() },
  annotations: READ,
}, async ({ cycle_id }) => {
  // Independent reads; one failing (an empty draft has no schedule yet) should
  // not blank the other three.
  const [groups, schedule, workOrders, batches] = await Promise.all([
    client.get(`/api/cycles/${cycle_id}/groups`).catch(describeError),
    client.get(`/api/cycles/${cycle_id}/schedule`).catch(describeError),
    client.get(`/api/cycles/${cycle_id}/work-orders`).catch(describeError),
    client.get(`/api/cycles/${cycle_id}/batches`).catch(describeError),
  ]);
  const rows = Array.isArray(groups) ? groups.reduce((n, g) => n + (g.count || 0), 0) : null;
  // Slimmed for the same reason as tracker_prior_groups: a full draft's member
  // payload would truncate this response and take the schedule and batches with it.
  return { cycle_id, task_groups: slimGroups(groups), task_rows: rows, schedule,
           work_orders: workOrders, batches,
           note: 'Go-live is not available here — open /build to publish this cycle.' };
});

tool('tracker_undo_batch', {
  title: 'Undo a load',
  description:
    'Reverse one bulk load, removing exactly the task rows it added and nothing else. The id comes from ' +
    'the batches list in tracker_review_draft. Refused when members have already completed some of those ' +
    'tasks unless force is true — on a draft that cannot happen, so an unforced undo of a draft load is ' +
    'always clean. Leadership only.',
  inputSchema: {
    batch_id: z.number().int().positive().describe('From tracker_review_draft'),
    force: z.boolean().optional().describe('Undo even though there are completions'),
  },
  annotations: { ...WRITE, destructiveHint: true },
}, ({ batch_id, force }) =>
  client.delete(`/api/batches/${batch_id}${force ? '?force=true' : ''}`));

// ── boot ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`squadron-tracker MCP server ready (${client.baseUrl}, user: ${client.slug || 'UNSET'})`);
