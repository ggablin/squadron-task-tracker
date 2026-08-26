// Live smoke test — spawns the real MCP server over stdio and exercises it
// end-to-end against a running tracker. Point it at STAGING, never production:
//
//   TRACKER_BASE_URL=https://staging-tracker-production.up.railway.app \
//   TRACKER_SLUG=gablin TRACKER_PASSWORD=… node test/smoke.js
//
// Reads broadly; the only write is a task-state flip that is restored to the
// exact prior state + note before the script exits.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'src', 'index.js');

const required = ['TRACKER_BASE_URL', 'TRACKER_SLUG', 'TRACKER_PASSWORD'];
for (const k of required) {
  if (!process.env[k]) { console.error(`Missing ${k} — refuse to guess. See header comment.`); process.exit(2); }
}
if (!/staging|localhost|127\.0\.0\.1/.test(process.env.TRACKER_BASE_URL)) {
  console.error(`TRACKER_BASE_URL (${process.env.TRACKER_BASE_URL}) does not look like staging — refusing to smoke-test writes there.`);
  process.exit(2);
}

let passed = 0, failed = 0;
function ok(name, detail = '') { passed++; console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`); }
function bad(name, detail) { failed++; console.error(`  ✘ ${name} — ${detail}`); }

function parse(result) {
  const text = result.content?.[0]?.text ?? '';
  try { return JSON.parse(text); } catch { return text; }
}

const client = new Client({ name: 'smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env },
  stderr: 'pipe',
});
await client.connect(transport);

try {
  // 1 — the tool surface
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  names.length >= 20 && names.includes('tracker_whoami') && names.includes('tracker_set_task_state')
    ? ok('listTools', `${names.length} tools`)
    : bad('listTools', `unexpected surface: ${names.join(', ')}`);

  const call = async (name, args = {}) => parse(await client.callTool({ name, arguments: args }));
  const callRaw = (name, args = {}) => client.callTool({ name, arguments: args });

  // 2 — identity
  const me = await call('tracker_whoami');
  me && me.slug === process.env.TRACKER_SLUG
    ? ok('tracker_whoami', `${me.rank} ${me.last_name} (${me.role}), cycle: ${me.uta_name}`)
    : bad('tracker_whoami', JSON.stringify(me).slice(0, 200));

  // 3 — reference reads
  const cats = await call('tracker_categories');
  Array.isArray(cats) && cats.length ? ok('tracker_categories', `${cats.length} categories`) : bad('tracker_categories', JSON.stringify(cats).slice(0, 200));

  const cal = await call('tracker_calendar');
  cal && Array.isArray(cal.months) ? ok('tracker_calendar', `year ${cal.year}`) : bad('tracker_calendar', JSON.stringify(cal).slice(0, 200));

  const duties = await call('tracker_duties');
  duties && Array.isArray(duties.duties) ? ok('tracker_duties', `${duties.duties.length} duties`) : bad('tracker_duties', JSON.stringify(duties).slice(0, 200));

  // 4 — role-gated reads (gablin is leadership on staging)
  const rollup = await call('tracker_squadron_rollup');
  Array.isArray(rollup) ? ok('tracker_squadron_rollup', `${rollup.length} shops`) : bad('tracker_squadron_rollup', JSON.stringify(rollup).slice(0, 200));

  const cycles = await call('tracker_cycles');
  Array.isArray(cycles) ? ok('tracker_cycles', `${cycles.length} cycles`) : bad('tracker_cycles', JSON.stringify(cycles).slice(0, 200));

  const members = await call('tracker_shop_members');
  Array.isArray(members) ? ok('tracker_shop_members', `${members.length} members`) : bad('tracker_shop_members', JSON.stringify(members).slice(0, 200));

  const events = await call('tracker_shop_events');
  Array.isArray(events) ? ok('tracker_shop_events', `${events.length} events`) : bad('tracker_shop_events', JSON.stringify(events).slice(0, 200));

  // 5 — the reversible write: flip one of my own real tasks, then restore it.
  const mine = await call('tracker_my_tasks');
  if (!Array.isArray(mine)) {
    bad('tracker_my_tasks', JSON.stringify(mine).slice(0, 200));
  } else {
    ok('tracker_my_tasks', `${mine.length} tasks`);
    const target = mine.find((t) => !t.informational);
    if (!target) {
      console.log('  – no checkable task on staging; write path skipped');
    } else {
      const original = { state: target.state, note: target.note ?? undefined };
      const flipped = target.state === 'done' ? 'none' : 'done';
      const w1 = await call('tracker_set_task_state', { task_id: target.id, state: flipped });
      w1 && w1.success ? ok('tracker_set_task_state (flip)', `task ${target.id} → ${flipped}`) : bad('tracker_set_task_state (flip)', JSON.stringify(w1).slice(0, 200));

      const after = await call('tracker_my_tasks');
      const seen = Array.isArray(after) && after.find((t) => t.id === target.id);
      seen && seen.state === flipped ? ok('write visible on re-read') : bad('write visible on re-read', JSON.stringify(seen).slice(0, 200));

      const w2 = await call('tracker_set_task_state', { task_id: target.id, state: original.state, note: original.note });
      w2 && w2.success ? ok('tracker_set_task_state (restore)', `task ${target.id} → ${original.state}`) : bad('tracker_set_task_state (restore)', JSON.stringify(w2).slice(0, 200));
    }

    // 6 — guardrails: informational rows refuse a state change with a clear message
    const info = mine.find((t) => t.informational);
    if (info) {
      const r = await callRaw('tracker_set_task_state', { task_id: info.id, state: 'done' });
      r.isError && /informational/i.test(r.content?.[0]?.text ?? '')
        ? ok('informational row refused', 'clear 400 surfaced')
        : bad('informational row refused', JSON.stringify(r.content).slice(0, 200));
    }
  }

  // 7 — bad id surfaces the API's 404 text
  const r404 = await callRaw('tracker_member_tasks', { member_id: 999999 });
  r404.isError && /404|not found/i.test(r404.content?.[0]?.text ?? '')
    ? ok('404 mapped', 'actionable error text')
    : bad('404 mapped', JSON.stringify(r404.content).slice(0, 200));
} finally {
  await client.close();
}

console.log(failed ? `\nSMOKE FAILED — ${failed} failures, ${passed} passes` : `\nSMOKE PASSED — ${passed} checks`);
process.exit(failed ? 1 : 0);
