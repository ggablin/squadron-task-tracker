// Tool-registration tests. These boot the real server over stdio with fake
// credentials and never reach the tracker: registration happens at boot, so a
// malformed inputSchema fails here rather than in front of a user mid-UTA.
//
// The absence assertions matter as much as the presence ones. go-live is the
// one irreversible push to ~70 phones and is deliberately not exposed; a future
// edit that adds it should fail a test, not slip through review.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'src', 'index.js');

let client, tools;

before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      // Port 9 is discard. Nothing here is ever dialled — listing tools makes
      // no HTTP call — but a real-looking base URL would be a worse default.
      TRACKER_BASE_URL: 'http://127.0.0.1:9',
      TRACKER_SLUG: 'nobody',
      TRACKER_PASSWORD: 'not-a-real-password',
    },
  });
  client = new Client({ name: 'tools-test', version: '1.0.0' });
  await client.connect(transport);
  ({ tools } = await client.listTools());
});

after(async () => { await client?.close(); });

const byName = (n) => tools.find(t => t.name === n);

const PREP = [
  'tracker_open_cycle', 'tracker_prior_groups', 'tracker_copy_forward',
  'tracker_load_tasks', 'tracker_load_schedule', 'tracker_load_work_orders',
  'tracker_edit_task_group', 'tracker_delete_task_group', 'tracker_review_draft',
  'tracker_undo_batch',
];

const CALENDAR = [
  'tracker_add_drill', 'tracker_update_drill', 'tracker_remove_drill',
  'tracker_add_calendar_event', 'tracker_update_calendar_event',
  'tracker_remove_calendar_event',
];

test('the server boots and registers its tools', () => {
  assert.ok(tools.length >= 40, `expected at least 40 tools, got ${tools.length}`);
});

test('every prep tool is registered', () => {
  for (const name of PREP) assert.ok(byName(name), `${name} is missing`);
});

test('every calendar tool is registered', () => {
  for (const name of CALENDAR) assert.ok(byName(name), `${name} is missing`);
});

test('both halves of the calendar are writable', () => {
  // tracker_calendar reads drill_dates AND calendar_events. Exposing a writer
  // for only one half is the trap this pairing exists to close.
  for (const half of ['drill', 'calendar_event']) {
    for (const verb of ['add', 'update', 'remove']) {
      assert.ok(byName(`tracker_${verb}_${half}`), `tracker_${verb}_${half} is missing`);
    }
  }
});

test('calendar deletions require an explicit confirm', () => {
  for (const name of ['tracker_remove_drill', 'tracker_remove_calendar_event']) {
    const schema = byName(name).inputSchema;
    assert.ok(schema.required.includes('confirm'), `${name} should require confirm`);
    assert.equal(byName(name).annotations?.destructiveHint, true, `${name} should be destructive`);
  }
});

test('calendar updates are partial, so only the id is required', () => {
  // These PATCH routes merge over the stored row — the opposite of
  // tracker_update_event's full replace. Requiring any other field here would
  // push callers into resending whole rows and silently clobbering fields.
  assert.deepEqual(byName('tracker_update_drill').inputSchema.required, ['drill_id']);
  assert.deepEqual(byName('tracker_update_calendar_event').inputSchema.required, ['event_id']);
});

test('no tool invites writing a No-UTA month', () => {
  // noUta is derived from gaps between drills. A tool accepting it would be
  // offering to set something the app computes.
  const offenders = tools.filter(t =>
    Object.keys(t.inputSchema?.properties ?? {}).some(k => /^no_?uta$/i.test(k)));
  assert.deepEqual(offenders.map(t => t.name), [],
    'No-UTA months are derived, not stored');
});

test('every tool has a non-trivial description', () => {
  // A tool the agent cannot tell apart from its neighbour is a tool it will
  // misuse; 40 characters is a floor, not a target.
  for (const t of tools) {
    assert.ok((t.description || '').length > 40,
      `${t.name} needs a fuller description (${(t.description || '').length} chars)`);
  }
});

test('go-live and the other withheld operations are not exposed', () => {
  const leaked = tools
    .map(t => t.name)
    .filter(n => /go_?live|delete_cycle|reset_password|import_tasks|delete_member/i.test(n));
  assert.deepEqual(leaked, [], `these must stay out of MCP: ${leaked.join(', ')}`);
});

test('destructive prep tools are annotated as destructive', () => {
  for (const name of ['tracker_delete_task_group', 'tracker_undo_batch']) {
    assert.equal(byName(name).annotations?.destructiveHint, true,
      `${name} should carry destructiveHint so clients can prompt for it`);
  }
});

test('read-only prep tools are annotated read-only', () => {
  for (const name of ['tracker_prior_groups', 'tracker_review_draft']) {
    assert.equal(byName(name).annotations?.readOnlyHint, true, `${name} should be readOnly`);
  }
});

test('the loaders take a cycle_id and a bounded bulk array', () => {
  for (const [name, arrayField] of [
    ['tracker_load_tasks', 'groups'],
    ['tracker_load_schedule', 'items'],
    ['tracker_load_work_orders', 'items'],
  ]) {
    const schema = byName(name).inputSchema;
    assert.ok(schema.properties.cycle_id, `${name} needs cycle_id`);
    const arr = schema.properties[arrayField];
    assert.equal(arr.type, 'array', `${name}.${arrayField} should be an array`);
    // Bounded on purpose: an unbounded load is one typo away from a runaway
    // write, and 50 groups is far past any real UTA.
    assert.equal(arr.maxItems, 50, `${name}.${arrayField} should cap at 50`);
    assert.deepEqual(schema.required.includes('cycle_id'), true);
  }
});

test('tracker_open_cycle requires only a name, so dates can default from the calendar', () => {
  const schema = byName('tracker_open_cycle').inputSchema;
  assert.deepEqual(schema.required, ['name']);
  for (const f of ['start_date', 'end_date']) {
    assert.ok(schema.properties[f], `${f} should still be accepted as an override`);
  }
});

test('task groups are addressed by their natural key, not an id', () => {
  for (const name of ['tracker_edit_task_group', 'tracker_delete_task_group']) {
    const req = byName(name).inputSchema.required;
    assert.ok(req.includes('category_code') && req.includes('title'),
      `${name} should key on {category_code, title}`);
  }
});

test('tracker_copy_forward can select what it carries forward', () => {
  const schema = byName('tracker_copy_forward').inputSchema;
  assert.deepEqual(schema.properties.include.items.enum, ['tasks', 'schedule', 'work_orders']);
  for (const f of ['cycle_id', 'from_cycle_id', 'include']) {
    assert.ok(schema.required.includes(f), `${f} should be required`);
  }
});
