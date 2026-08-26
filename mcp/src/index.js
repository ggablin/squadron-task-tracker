#!/usr/bin/env node
// squadron-tracker-mcp-server — drive the 108 CES UTA Task Tracker from Claude.
//
// A thin stdio MCP wrapper over the tracker's own HTTP API (see ../README.md).
// Every tool goes through TrackerClient, which signs in as a real member, so
// role guards, live-cycle checks, and push notifications all behave exactly as
// they do in the app. Deliberately absent: task/member/cycle deletion, cycle
// authoring/go-live, and anything wrapping the destructive import-tasks.js.

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
    'The year\'s drill weekends and TDY/training rotations, grouped by month. Optional year (default: ' +
    'current year); the response lists which years have data.',
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

// ── boot ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`squadron-tracker MCP server ready (${client.baseUrl}, user: ${client.slug || 'UNSET'})`);
