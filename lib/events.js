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
  CARRYABLE_WO_STATUSES,
  isCarryableWorkOrder, carryKey, pendingCarry,
  carryOpenWorkOrders, deleteCycleEvents,
};
