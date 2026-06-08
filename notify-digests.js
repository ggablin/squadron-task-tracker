// notify-digests.js — periodic completion digests for supervisors & leadership.
//
// For each supervisor / leadership member, summarizes task completions since
// that recipient's last digest (or the start of the current cycle on first run)
// and writes one completion_digest notification. The email channel picks it up
// separately. Recipients with no new completions are skipped.
//
//   Supervisor → completions in their own shop.
//   Leadership → per-shop breakdown plus a squadron roll-up, in one digest.
//
// Driven on a timer by server.js (node-cron) and runnable by hand:
//
//   node notify-digests.js
//
const { Pool } = require('pg');

const plural = n => (n === 1 ? '' : 's');

// pool may be injected (by the server) so we reuse its connection pool; when run
// as a CLI we create our own and close it afterward.
async function runDigests({ pool } = {}) {
  const ownPool = !pool;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
        ? { rejectUnauthorized: false } : false,
    });
  }

  const insertDigest = (memberId, title, body) => pool.query(
    `INSERT INTO notifications (member_id, type, title, body, link)
     VALUES ($1, 'completion_digest', $2, $3, 'supervisor')`,
    [memberId, title, body]
  );

  let written = 0;
  try {
    const { rows: recipients } = await pool.query(`
      SELECT id, role, shop_id FROM members
      WHERE active = true AND role IN ('supervisor','leadership')
    `);

    // Fallback window start = current cycle start (covers everything on first run).
    const { rows: [cyc] } = await pool.query(
      `SELECT start_date FROM uta_cycles WHERE is_current = true LIMIT 1`
    );
    const cycleStart = (cyc && cyc.start_date) || new Date(0);

    for (const r of recipients) {
      const { rows: [last] } = await pool.query(
        `SELECT MAX(created_at) AS t FROM notifications
         WHERE member_id = $1 AND type = 'completion_digest'`,
        [r.id]
      );
      const since = last.t || cycleStart;

      if (r.role === 'supervisor') {
        if (!r.shop_id) continue;
        const { rows: [c] } = await pool.query(`
          SELECT COUNT(*)::int AS n
          FROM task_completions tc
          JOIN tasks t   ON t.id = tc.task_id
          JOIN members m ON m.id = t.member_id
          WHERE tc.state = 'done' AND tc.updated_at > $1 AND m.shop_id = $2
        `, [since, r.shop_id]);
        if (c.n > 0) {
          await insertDigest(
            r.id,
            `${c.n} task${plural(c.n)} completed in your shop`,
            `Since your last digest, your shop completed ${c.n} task${plural(c.n)}.`
          );
          written++;
        }
      } else { // leadership
        const { rows: shops } = await pool.query(`
          SELECT s.name, COUNT(*)::int AS n
          FROM task_completions tc
          JOIN tasks t   ON t.id = tc.task_id
          JOIN members m ON m.id = t.member_id
          JOIN shops s   ON s.id = m.shop_id
          WHERE tc.state = 'done' AND tc.updated_at > $1
          GROUP BY s.name
          ORDER BY n DESC, s.name
        `, [since]);
        const total = shops.reduce((a, b) => a + b.n, 0);
        if (total > 0) {
          const breakdown = shops.map(s => `${s.name}: ${s.n}`).join(' · ');
          await insertDigest(
            r.id,
            `${total} task${plural(total)} completed squadron-wide`,
            `${breakdown}. Squadron total: ${total}.`
          );
          written++;
        }
      }
    }
  } finally {
    if (ownPool) await pool.end();
  }

  console.log(`[notify-digests] wrote ${written} digest${plural(written)}`);
  return { written };
}

module.exports = { runDigests };

if (require.main === module) {
  runDigests().catch(err => { console.error(err); process.exit(1); });
}
