// Cycle-rollover rules for shop events.
//
// The decision logic lives in pure functions so the rules that are easiest to
// get quietly wrong -- what qualifies to carry, and what counts as "already
// there" -- can be unit-tested without a Postgres instance. carryOpenWorkOrders
// uses those same functions rather than reimplementing them in SQL, so the
// tests cover the real path.

// A work order that is still open or in progress is unfinished business and
// follows the squadron into the next cycle. A completed one does not: in a new
// cycle it reads as outstanding work that isn't, and inflates every shop's
// work-order count.
const CARRYABLE_WO_STATUSES = ['open', 'in_progress'];

function isCarryableWorkOrder(row) {
  return !!row
    && row.event_type === 'work_order'
    && CARRYABLE_WO_STATUSES.includes(row.status);
}

// Identity of a job for carry purposes: same shop, same WO number, same title.
// wo_number is optional on the schema, so it is normalised rather than assumed
// present -- otherwise two untitled-number jobs in one shop would collide on
// null and only one would carry.
function carryKey(row) {
  return [
    row.shop_id,
    String(row.wo_number || '').trim().toLowerCase(),
    String(row.title || '').trim().toLowerCase(),
  ].join('|');
}

// Which of `source` still need carrying, given what `target` already holds.
// Idempotent by construction: running it twice yields nothing the second time.
// Also dedupes within `source`, so a shop that somehow logged the same job
// twice does not carry it twice.
function pendingCarry(source, target) {
  const seen = new Set((target || []).map(carryKey));
  const out = [];
  for (const row of source || []) {
    if (!isCarryableWorkOrder(row)) continue;
    const key = carryKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

// Copy unfinished work orders from one cycle to another. Takes a client rather
// than a pool: the caller owns the transaction, so a partial carry can never
// leave a cycle holding half its work orders.
async function carryOpenWorkOrders(client, { fromCycleId, toCycleId, createdById = null }) {
  if (!fromCycleId || !toCycleId || fromCycleId === toCycleId) return { carried: 0, rows: [] };

  const { rows: source } = await client.query(
    `SELECT shop_id, event_type, day, start_time, end_time, title, details,
            wo_number, status, sort_order
     FROM shop_events
     WHERE uta_cycle_id = $1 AND event_type = 'work_order'`, [fromCycleId]);

  const { rows: target } = await client.query(
    `SELECT shop_id, wo_number, title FROM shop_events
     WHERE uta_cycle_id = $1 AND event_type = 'work_order'`, [toCycleId]);

  const rows = [];
  for (const r of pendingCarry(source, target)) {
    const { rows: [inserted] } = await client.query(
      `INSERT INTO shop_events (uta_cycle_id, shop_id, event_type, day, start_time, end_time,
                                title, details, wo_number, status, created_by_id, sort_order)
       VALUES ($1, $2, 'work_order', $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, shop_id, wo_number, title, status`,
      [toCycleId, r.shop_id, r.day, r.start_time, r.end_time, r.title, r.details,
       r.wo_number, r.status, createdById, r.sort_order]);
    rows.push(inserted);
  }
  return { carried: rows.length, rows };
}

const WO_STATUSES = ['open', 'in_progress', 'complete'];

function isValidStatus(status) { return WO_STATUSES.includes(status); }

// Flag which of `rows` came across from `sourceRows` (the cycle they were
// carried from). Derived by comparing carry keys rather than stored in a
// column: the answer is already implied by the data, and a column would need a
// migration plus a backfill for rows that predate it.
function markCarried(rows, sourceRows) {
  const source = new Set((sourceRows || []).map(carryKey));
  return (rows || []).map(r => ({ ...r, carried: source.has(carryKey(r)) }));
}

async function listWorkOrders(db, cycleId, compareToCycleId = null) {
  const { rows } = await db.query(
    `SELECT e.id, e.shop_id, s.name AS shop_name, e.wo_number, e.title, e.details,
            e.status, e.day, e.start_time, e.end_time, e.sort_order
     FROM shop_events e
     LEFT JOIN shops s ON s.id = e.shop_id
     WHERE e.uta_cycle_id = $1 AND e.event_type = 'work_order'
     ORDER BY s.name, e.wo_number NULLS LAST, e.id`, [cycleId]);
  if (!compareToCycleId || compareToCycleId === cycleId) {
    return rows.map(r => ({ ...r, carried: false }));
  }
  const { rows: source } = await db.query(
    `SELECT shop_id, wo_number, title FROM shop_events
     WHERE uta_cycle_id = $1 AND event_type = 'work_order'`, [compareToCycleId]);
  return markCarried(rows, source);
}

function badRequest(message) {
  return Object.assign(new Error(message), { code: 'BAD_REQUEST' });
}

async function createWorkOrder(client, cycleId, payload, createdById = null) {
  const title = String(payload.title || '').trim();
  if (!title) throw badRequest('title is required');
  const shopId = parseInt(payload.shop_id, 10);
  if (!Number.isInteger(shopId) || shopId < 1) throw badRequest('A work order needs a shop');
  const status = payload.status || 'open';
  if (!isValidStatus(status)) throw badRequest('Invalid status');
  const { rows: [r] } = await client.query(
    `INSERT INTO shop_events (uta_cycle_id, shop_id, event_type, day, start_time, end_time,
                              title, details, wo_number, status, created_by_id, sort_order)
     VALUES ($1,$2,'work_order',$3,$4,$5,$6,$7,$8,$9,$10,99)
     RETURNING id, shop_id, wo_number, title, details, status`,
    [cycleId, shopId, payload.day || null, payload.start_time || null, payload.end_time || null,
     title, payload.details || null, String(payload.wo_number || '').trim() || null,
     status, createdById]);
  return r;
}

async function updateWorkOrder(client, cycleId, woId, payload) {
  const title = String(payload.title || '').trim();
  if (!title) throw badRequest('title is required');
  const status = payload.status || 'open';
  if (!isValidStatus(status)) throw badRequest('Invalid status');
  const shopId = parseInt(payload.shop_id, 10);
  if (!Number.isInteger(shopId) || shopId < 1) throw badRequest('A work order needs a shop');
  const { rows } = await client.query(
    `UPDATE shop_events
     SET shop_id = $3, title = $4, details = $5, wo_number = $6, status = $7,
         day = $8, start_time = $9, end_time = $10
     WHERE id = $1 AND uta_cycle_id = $2 AND event_type = 'work_order'
     RETURNING id, shop_id, wo_number, title, details, status`,
    [woId, cycleId, shopId, title, payload.details || null,
     String(payload.wo_number || '').trim() || null, status,
     payload.day || null, payload.start_time || null, payload.end_time || null]);
  if (!rows.length) throw Object.assign(new Error('No such work order'), { code: 'NO_EVENT' });
  return rows[0];
}

async function deleteWorkOrder(client, cycleId, woId) {
  const res = await client.query(
    `DELETE FROM shop_events WHERE id = $1 AND uta_cycle_id = $2 AND event_type = 'work_order'`,
    [woId, cycleId]);
  return res.rowCount;
}

// Every table keyed to a cycle, so discarding a draft cannot orphan rows or
// trip the foreign key on the cycle delete. shop_event_status_log is omitted
// deliberately: its FK to shop_events is ON DELETE CASCADE.
async function deleteCycleEvents(client, cycleId) {
  await client.query('DELETE FROM shop_events WHERE uta_cycle_id = $1', [cycleId]);
  await client.query('DELETE FROM squadron_events WHERE uta_cycle_id = $1', [cycleId]);
  // Attendance is written only to a live cycle, so a draft should hold none.
  // Deleted anyway: it is free when empty, and the alternative is an FK error
  // if that invariant ever changes.
  await client.query('DELETE FROM attendance WHERE uta_cycle_id = $1', [cycleId]);
}

module.exports = {
  CARRYABLE_WO_STATUSES, WO_STATUSES,
  isCarryableWorkOrder, isValidStatus, carryKey, pendingCarry, markCarried,
  carryOpenWorkOrders, deleteCycleEvents,
  listWorkOrders, createWorkOrder, updateWorkOrder, deleteWorkOrder,
};
