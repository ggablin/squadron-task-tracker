// Schedule authoring: one scheduled event, with an audience.
//
// Timeline and schedule are not two things to author. They are one thing with
// an audience: "All" surfaces an event on the squadron timeline, a set of shops
// surfaces it on those shops' schedules. That unification happens here, so the
// builder never sees two shapes and McNaughton never has to know two tables
// exist.
//
// Storage still routes by audience -- squadron_events for All, N rows in
// shop_events for N shops -- because merging the tables would mean migrating
// live data and rewriting both member-facing renderers to produce output
// identical to what already renders correctly.
//
// The pure helpers below carry the rules worth testing without a database.

const DAY_RANK = { Friday: 1, 'Friday/Saturday': 1.5, Saturday: 2, Sunday: 3 };

function badRequest(message) {
  return Object.assign(new Error(message), { code: 'BAD_REQUEST' });
}

// ── references ─────────────────────────────────────────────────────────────
// A logical event is addressed by one opaque ref so callers never branch on
// storage:  sq:<id>   one squadron_events row (audience All)
//           grp:<id>  a group of shop_events rows authored together
//           shop:<id> a single ungrouped shop_events row (pre-existing data,
//                     authored before event_group_id existed)

function makeRef(type, id) { return `${type}:${id}`; }

function parseRef(ref) {
  const m = /^(sq|grp|shop):(\d+)$/.exec(String(ref == null ? '' : ref));
  return m ? { type: m[1], id: parseInt(m[2], 10) } : null;
}

// ── audience ───────────────────────────────────────────────────────────────

// Accepts 'all' or a list of shop ids in any shape the client sends. Returns a
// canonical form: deduped, sorted, integers only.
function normalizeAudience(audience) {
  if (audience === 'all') return { all: true, shopIds: [] };
  const list = Array.isArray(audience) ? audience : [];
  const shopIds = [...new Set(
    list.map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n > 0)
  )].sort((a, b) => a - b);
  return { all: false, shopIds };
}

// An event with no audience surfaces nowhere, which is never what was meant.
function isValidAudience(audience) {
  const a = normalizeAudience(audience);
  return a.all || a.shopIds.length > 0;
}

// ── ordering ───────────────────────────────────────────────────────────────

// Mirrors the member-facing timeline ordering so the builder lists a drill
// weekend the way members read it: day, then time, then explicit sort order.
function compareEvents(a, b) {
  const d = (DAY_RANK[a.day] ?? 4) - (DAY_RANK[b.day] ?? 4);
  if (d) return d;
  const at = a.start_time || '￿';   // untimed items sink below timed ones
  const bt = b.start_time || '￿';
  if (at !== bt) return at < bt ? -1 : 1;
  return (a.sort_order ?? 99) - (b.sort_order ?? 99);
}

// Collapse raw rows from both tables into one list of logical events.
// Shop rows sharing an event_group_id become a single event whose audience is
// the set of their shops; ungrouped rows stand alone.
function mergeSchedule(squadronRows, shopRows) {
  const out = (squadronRows || []).map(r => ({
    ref: makeRef('sq', r.id),
    audience: 'all',
    shop_ids: [],
    day: r.day, start_time: r.start_time, end_time: r.end_time,
    title: r.title, details: r.details, kind: r.kind,
    sort_order: r.sort_order,
  }));

  const groups = new Map();
  for (const r of shopRows || []) {
    const key = r.event_group_id != null ? makeRef('grp', r.event_group_id) : makeRef('shop', r.id);
    if (!groups.has(key)) {
      groups.set(key, {
        ref: key, audience: 'shops', shop_ids: [],
        day: r.day, start_time: r.start_time, end_time: r.end_time,
        title: r.title, details: r.details, kind: r.kind,
        sort_order: r.sort_order,
      });
    }
    groups.get(key).shop_ids.push(r.shop_id);
  }
  for (const g of groups.values()) {
    g.shop_ids.sort((a, b) => a - b);
    out.push(g);
  }
  return out.sort(compareEvents);
}

// Identity for copy-forward idempotency: the same slot, same title, same
// audience. Two shops running "Bay cleanup" at 0900 is one event; the same
// title for a different audience is a different event.
function scheduleKey(ev) {
  const aud = ev.audience === 'all' ? 'all' : [...(ev.shop_ids || [])].sort((a, b) => a - b).join(',');
  return [
    String(ev.day || '').trim().toLowerCase(),
    String(ev.start_time || '').trim(),
    String(ev.title || '').trim().toLowerCase(),
    aud,
  ].join('|');
}

function pendingScheduleCopy(source, target) {
  const seen = new Set((target || []).map(scheduleKey));
  const out = [];
  for (const ev of source || []) {
    const k = scheduleKey(ev);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(ev);
  }
  return out;
}

// ── database ───────────────────────────────────────────────────────────────

async function listSchedule(db, cycleId) {
  const { rows: squadronRows } = await db.query(
    `SELECT id, day, start_time, end_time, title, details, kind, sort_order
     FROM squadron_events WHERE uta_cycle_id = $1`, [cycleId]);
  const { rows: shopRows } = await db.query(
    `SELECT id, event_group_id, shop_id, day, start_time, end_time, title, details, kind, sort_order
     FROM shop_events WHERE uta_cycle_id = $1 AND event_type = 'schedule'`, [cycleId]);
  return mergeSchedule(squadronRows, shopRows);
}

async function createEvent(client, cycleId, payload, createdById = null) {
  const title = String(payload.title || '').trim();
  if (!title) throw badRequest('title is required');
  if (!isValidAudience(payload.audience)) {
    throw badRequest('An event needs an audience: "all" or at least one shop');
  }
  const a = normalizeAudience(payload.audience);
  const { day = null, start_time = null, end_time = null, details = null, kind = null } = payload;

  if (a.all) {
    const { rows: [r] } = await client.query(
      `INSERT INTO squadron_events (uta_cycle_id, day, start_time, end_time, title, details, kind, created_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [cycleId, day, start_time, end_time, title, details, kind, createdById]);
    return { ref: makeRef('sq', r.id), audience: 'all', shop_ids: [] };
  }

  const ids = [];
  for (const shopId of a.shopIds) {
    const { rows: [r] } = await client.query(
      `INSERT INTO shop_events (uta_cycle_id, shop_id, event_type, day, start_time, end_time,
                                title, details, kind, created_by_id, sort_order)
       VALUES ($1,$2,'schedule',$3,$4,$5,$6,$7,$8,$9,99) RETURNING id`,
      [cycleId, shopId, day, start_time, end_time, title, details, kind, createdById]);
    ids.push(r.id);
  }
  // The group id is the first row's own id: unique by construction, no extra
  // sequence to migrate. Single-shop events get one too, so editing is uniform.
  const groupId = Math.min(...ids);
  await client.query(
    `UPDATE shop_events SET event_group_id = $1 WHERE id = ANY($2::int[])`, [groupId, ids]);
  return { ref: makeRef('grp', groupId), audience: 'shops', shop_ids: a.shopIds };
}

async function deleteEvent(client, ref) {
  const r = parseRef(ref);
  if (!r) throw badRequest('Malformed event reference');
  if (r.type === 'sq') {
    const res = await client.query('DELETE FROM squadron_events WHERE id = $1', [r.id]);
    return res.rowCount;
  }
  if (r.type === 'grp') {
    const res = await client.query(
      `DELETE FROM shop_events WHERE event_group_id = $1 AND event_type = 'schedule'`, [r.id]);
    return res.rowCount;
  }
  const res = await client.query(
    `DELETE FROM shop_events WHERE id = $1 AND event_type = 'schedule'`, [r.id]);
  return res.rowCount;
}

// Changing an audience crosses tables (All lives in squadron_events, shops in
// shop_events), so an update is a delete plus a create inside the caller's
// transaction. Schedule rows are referenced by nothing else -- the status log
// is a work-order concern -- so recreating them loses nothing but the row id,
// and the caller gets the new ref back.
async function updateEvent(client, cycleId, ref, payload, createdById = null) {
  const existing = parseRef(ref);
  if (!existing) throw badRequest('Malformed event reference');
  const removed = await deleteEvent(client, ref);
  if (!removed) throw Object.assign(new Error('No such event'), { code: 'NO_EVENT' });
  return createEvent(client, cycleId, payload, createdById);
}

async function copyForward(client, { fromCycleId, toCycleId, refs = null, createdById = null }) {
  if (!fromCycleId || !toCycleId || fromCycleId === toCycleId) return { copied: 0, events: [] };
  const source = await listSchedule(client, fromCycleId);
  const wanted = refs ? source.filter(e => refs.includes(e.ref)) : source;
  const target = await listSchedule(client, toCycleId);

  const events = [];
  for (const ev of pendingScheduleCopy(wanted, target)) {
    events.push(await createEvent(client, toCycleId, {
      audience: ev.audience === 'all' ? 'all' : ev.shop_ids,
      day: ev.day, start_time: ev.start_time, end_time: ev.end_time,
      title: ev.title, details: ev.details, kind: ev.kind,
    }, createdById));
  }
  return { copied: events.length, events };
}

module.exports = {
  makeRef, parseRef, normalizeAudience, isValidAudience,
  compareEvents, mergeSchedule, scheduleKey, pendingScheduleCopy,
  listSchedule, createEvent, updateEvent, deleteEvent, copyForward,
};
