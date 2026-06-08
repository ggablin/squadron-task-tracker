// notify-emails.js — flush pending notification emails.
//
// Sends one email per un-emailed notification whose recipient has an email
// address, then stamps emailed_at so it is never re-sent. Idempotent and safe
// to re-run. Driven on a timer by server.js (node-cron) and runnable by hand:
//
//   node notify-emails.js
//
const { Pool } = require('pg');
const { sendEmail } = require('./mailer');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// pool may be injected (by the server) so we reuse its connection pool; when run
// as a CLI we create our own and close it afterward.
async function flushEmails({ pool } = {}) {
  const ownPool = !pool;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
        ? { rejectUnauthorized: false } : false,
    });
  }

  let sent = 0, skipped = 0;
  try {
    const { rows } = await pool.query(`
      SELECT n.id, n.title, n.body, m.email
      FROM notifications n
      JOIN members m ON m.id = n.member_id
      WHERE n.emailed_at IS NULL
        AND m.email IS NOT NULL AND m.email <> ''
        AND m.active = true
      ORDER BY n.created_at
      LIMIT 200
    `);

    for (const n of rows) {
      const html = `<p style="font-size:15px;font-weight:600;margin:0 0 8px">${esc(n.title)}</p>` +
                   (n.body ? `<p style="margin:0;color:#444">${esc(n.body)}</p>` : '') +
                   `<p style="margin:16px 0 0;font-size:12px;color:#999">108th CES Squadron Task Tracker</p>`;
      try {
        const ok = await sendEmail(n.email, n.title, html);
        if (ok) {
          await pool.query('UPDATE notifications SET emailed_at = NOW() WHERE id = $1', [n.id]);
          sent++;
        } else {
          skipped++; // SMTP not configured — leave emailed_at NULL to retry later
        }
      } catch (err) {
        console.error(`[notify-emails] failed sending notification ${n.id}:`, err.message);
        skipped++;
      }
    }
  } finally {
    if (ownPool) await pool.end();
  }

  if (sent || skipped) console.log(`[notify-emails] sent ${sent}, skipped ${skipped}`);
  return { sent, skipped };
}

module.exports = { flushEmails };

if (require.main === module) {
  flushEmails().catch(err => { console.error(err); process.exit(1); });
}
