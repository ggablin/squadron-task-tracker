// Who counts as "present at drill", for the two-way completion percentages.
//
// The Squadron rollups show completion two ways: for everyone, and for only the
// members actually at drill — a shop is not "behind" because half of it is on a
// RUTA. The rule, decided with the First Sergeant's feedback: a member is
// PRESENT unless attendance explicitly says otherwise. Concretely —
//
//   · any period marked Present or AGR/AT/Orders  → present
//   · rows exist but none of them is a present status → not present
//   · no attendance rows at all                    → present
//
// The last case is deliberate: a row's absence means UNMARKED, never absent
// (lib/attendance.js), so before anyone marks attendance the two percentages
// are identical, and they diverge only as real absences get recorded. The
// alternative — requiring positive marks — would report "0 members present"
// all month until drill weekend, which reads as broken.
//
// Expressed as a GROUP BY join rather than per-row EXISTS probes so the rollup
// queries can aggregate over it with a plain FILTER clause.

// Statuses that mean the member is at drill (or constructively so). Everything
// else in lib/attendance.js's STATUS_DEFS — RUTA/Excused, Unexcused, AWOL,
// Maternity, Transfer, Separated, Equivalent Training — means away.
const PRESENT_STATUSES = ['present', 'agr_at_orders'];

const CURRENT_CYCLE_SQL = `(SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1)`;

// LEFT JOIN fragment: one row per member who has any attendance this cycle,
// carrying whether any of it is a present status. Join it to the members alias
// and read presence with presentExpr().
const presenceJoinSql = (alias = 'att', memberCol = 'm.id', cycleSql = CURRENT_CYCLE_SQL) => `
      LEFT JOIN (
        SELECT a.member_id,
               bool_or(a.status IN ('${PRESENT_STATUSES.join("','")}')) AS any_present
        FROM attendance a
        WHERE a.uta_cycle_id = ${cycleSql}
        GROUP BY a.member_id
      ) ${alias} ON ${alias}.member_id = ${memberCol}`;

// Boolean expression for the joined alias: unmarked (no row → NULL) is present.
const presentExpr = (alias = 'att') => `COALESCE(${alias}.any_present, true)`;

module.exports = { PRESENT_STATUSES, presenceJoinSql, presentExpr };
