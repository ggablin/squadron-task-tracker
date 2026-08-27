// Live prep-pipeline smoke test — drives the pre-UTA build tools end to end
// against a running tracker. STAGING ONLY, same guard as smoke.js:
//
//   TRACKER_BASE_URL=https://staging-tracker-production.up.railway.app \
//   TRACKER_SLUG=gablin TRACKER_PASSWORD=… node test/prep-smoke.js
//
// It creates a throwaway DRAFT cycle, seeds it, loads into it, reviews it and
// undoes a batch — then deletes the draft in a finally block. A draft notifies
// nobody, so nothing here reaches a member's phone even on staging. The cleanup
// goes over plain HTTP because cycle deletion is deliberately not an MCP tool.

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
const BASE = process.env.TRACKER_BASE_URL;
if (!/staging|localhost|127\.0\.0\.1/.test(BASE)) {
  console.error(`TRACKER_BASE_URL (${BASE}) does not look like staging — refusing to build cycles there.`);
  process.exit(2);
}

let passed = 0, failed = 0;
const ok = (n, d = '') => { passed++; console.log(`  ✔ ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d) => { failed++; console.error(`  ✘ ${n} — ${d}`); };

// MCP returns tool output as text; every tool here answers with JSON.
async function call(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  if (r.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

const transport = new StdioClientTransport({
  command: process.execPath, args: [serverPath], env: { ...process.env },
});
const client = new Client({ name: 'prep-smoke', version: '1.0.0' });
await client.connect(transport);

let cycleId = null;
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const NAME = `ZZ Prep Smoke ${stamp}`;

try {
  const me = await call(client, 'tracker_whoami');
  if (me.role !== 'leadership') {
    console.error(`This account is ${me.role}; the prep tools are leadership-only.`);
    process.exit(2);
  }
  ok('signed in', `${me.rank} ${me.last_name} (${me.role})`);

  // 1 ── open a draft, dates defaulted from the calendar
  const opened = await call(client, 'tracker_open_cycle', { name: NAME });
  cycleId = opened.cycle?.id;
  cycleId ? ok('tracker_open_cycle', `id ${cycleId}, dates from ${opened.dates_from}`)
          : bad('tracker_open_cycle', JSON.stringify(opened));
  if (!cycleId) throw new Error('no cycle to build into');
  if (opened.cycle.status && opened.cycle.status !== 'draft') {
    bad('new cycle is a draft', `status is ${opened.cycle.status}`);
  } else ok('new cycle is a draft', 'members see nothing yet');

  // 2 ── find a source cycle and read its groups
  const cycles = await call(client, 'tracker_cycles');
  const list = Array.isArray(cycles) ? cycles : (cycles.cycles || []);
  const source = list.find(c => c.id !== cycleId && (c.status === 'live' || c.status === 'archived'));
  if (!source) { bad('find a source cycle', 'no live/archived cycle on staging'); throw new Error('stop'); }
  ok('found a source cycle', `${source.name} (id ${source.id})`);

  const groups = await call(client, 'tracker_prior_groups', { cycle_id: source.id });
  Array.isArray(groups) && groups.length
    ? ok('tracker_prior_groups', `${groups.length} groups, ${groups.reduce((n, g) => n + (g.count || 0), 0)} rows`)
    : bad('tracker_prior_groups', JSON.stringify(groups).slice(0, 200));

  // 3 ── copy two of them forward
  if (Array.isArray(groups) && groups.length) {
    const pick = groups.slice(0, 2).map(g => ({ category_code: g.category_code, title: g.title }));
    const cf = await call(client, 'tracker_copy_forward', {
      cycle_id: cycleId, from_cycle_id: source.id, include: ['tasks'], groups: pick,
    });
    cf.tasks ? ok('tracker_copy_forward', `carried ${pick.length} group(s) forward`)
             : bad('tracker_copy_forward', JSON.stringify(cf).slice(0, 300));

    // the guard: asking for tasks without groups must be refused, not silent
    const guard = await call(client, 'tracker_copy_forward', {
      cycle_id: cycleId, from_cycle_id: source.id, include: ['tasks'],
    });
    guard.error ? ok('copy_forward refuses tasks without groups')
                : bad('copy_forward refuses tasks without groups', 'it accepted the call');
  }

  // 4 ── load a task group of our own
  const cats = await call(client, 'tracker_categories');
  const catList = Array.isArray(cats) ? cats : (cats.categories || []);
  const roster = await call(client, 'tracker_roster');
  const members = (Array.isArray(roster) ? roster : (roster.members || [])).filter(m => m.active !== false);
  if (catList.length && members.length) {
    const ids = members.slice(0, 3).map(m => m.id);
    const loaded = await call(client, 'tracker_load_tasks', {
      cycle_id: cycleId,
      groups: [{ title: `Prep smoke task ${stamp}`, category_code: catList[0].code, member_ids: ids }],
    });
    loaded.loaded === 1 ? ok('tracker_load_tasks', `1 group to ${ids.length} members`)
                        : bad('tracker_load_tasks', JSON.stringify(loaded).slice(0, 300));

    // re-running must not duplicate — ON CONFLICT dedupes
    const again = await call(client, 'tracker_load_tasks', {
      cycle_id: cycleId,
      groups: [{ title: `Prep smoke task ${stamp}`, category_code: catList[0].code, member_ids: ids }],
    });
    const addedTwice = again.results?.[0]?.added;
    addedTwice === 0 ? ok('re-loading the same group adds nothing', 'dedupe holds')
                     : bad('re-loading the same group adds nothing', `added ${addedTwice}`);
  }

  // 5 ── review, then undo the most recent batch
  const review = await call(client, 'tracker_review_draft', { cycle_id: cycleId });
  Array.isArray(review.batches) && review.batches.length
    ? ok('tracker_review_draft', `${review.task_rows} rows across ${review.batches.length} batch(es)`)
    : bad('tracker_review_draft', JSON.stringify(review).slice(0, 300));

  if (Array.isArray(review.batches) && review.batches.length) {
    const b = review.batches[review.batches.length - 1];
    const undone = await call(client, 'tracker_undo_batch', { batch_id: b.id });
    const after = await call(client, 'tracker_review_draft', { cycle_id: cycleId });
    after.task_rows < review.task_rows
      ? ok('tracker_undo_batch', `${review.task_rows} → ${after.task_rows} rows`)
      : bad('tracker_undo_batch', `rows unchanged at ${after.task_rows}: ${JSON.stringify(undone).slice(0, 200)}`);
  }

  // 6 ── go-live must not be reachable from here
  const { tools } = await client.listTools();
  tools.some(t => /go_?live/i.test(t.name))
    ? bad('go-live stays out of MCP', 'a go-live tool is registered')
    : ok('go-live stays out of MCP');

} catch (e) {
  bad('pipeline', e.message);
} finally {
  // Always remove the throwaway cycle, even if the run failed midway.
  if (cycleId) {
    try {
      const login = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: process.env.TRACKER_SLUG, password: process.env.TRACKER_PASSWORD }),
      });
      const cookie = (login.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
      const del = await fetch(`${BASE}/api/cycles/${cycleId}`, { method: 'DELETE', headers: { cookie } });
      del.ok ? ok('cleaned up the throwaway cycle', `deleted ${cycleId}`)
             : bad('cleaned up the throwaway cycle', `HTTP ${del.status} — delete cycle ${cycleId} by hand`);
    } catch (e) {
      bad('cleaned up the throwaway cycle', `${e.message} — delete cycle ${cycleId} by hand`);
    }
  }
  await client.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
