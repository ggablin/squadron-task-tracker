// lib/push.js — Web Push delivery.
//
// Deliberately shaped like notify-emails.js rather than like a direct send from
// notify(): a notification row is written first, then a flush picks up whatever
// has pushed_at IS NULL. That buys three things the direct approach does not:
//
//   · web-push never runs inside a request. A throw at the notify() call site
//     would break task assignment, which is the highest-consequence path here.
//   · Both insert sites are covered. notify() in server.js is not the only one —
//     notify-digests.js writes completion_digest rows directly.
//   · It is self-healing. A failed send leaves pushed_at NULL and the next timer
//     tick retries it, with no bespoke retry logic.
const webpush = require('web-push');

// Digests are a nightly supervisor summary; buzzing phones at 21:00 for them is
// not wanted. Add 'completion_digest' here if that ever changes.
const PUSH_TYPES = ['tasks_live', 'task_assigned', 'task_escalated'];

// Anything older than this is abandoned rather than delivered. A member who
// re-subscribes should not be buzzed for last month's UTA, and a flush that has
// been failing for a day should give up rather than accumulate a backlog that
// arrives all at once.
const MAX_AGE_HOURS = 24;

const enabled = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

// Lazy, so the module can be required before the env is populated (tests do
// exactly that) and so an unset key set is simply a no-op rather than a throw.
let configured = false;
function ensureVapid() {
  if (configured) return;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'https://108ces.up.railway.app',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  configured = true;
}

// send is injectable so tests can drive the whole flush without a push service.
async function flushPush({ pool, send } = {}) {
  if (!pool) throw new Error('flushPush needs a pool');
  if (!enabled()) return { sent: 0, pruned: 0, skipped: 'no VAPID keys' };
  ensureVapid();
  const deliver = send || ((sub, payload) => webpush.sendNotification(sub, payload));

  const { rows } = await pool.query(`
    SELECT n.id, n.title, n.body, n.link,
           s.id AS sub_id, s.endpoint, s.p256dh, s.auth
      FROM notifications n
      JOIN push_subscriptions s ON s.member_id = n.member_id
     WHERE n.pushed_at IS NULL
       AND n.type = ANY($1)
       AND n.created_at >= s.created_at          -- no backlog for a new subscriber
       AND n.created_at > NOW() - ($2 || ' hours')::interval
     ORDER BY n.created_at
     LIMIT 500
  `, [PUSH_TYPES, String(MAX_AGE_HOURS)]);

  let sent = 0, pruned = 0;
  const done = new Set();
  for (const r of rows) {
    const payload = JSON.stringify({
      title: r.title,
      body: r.body || '',
      // notifications.link already stores the view names the SPA switches on, so
      // a tap can land on the right pane. See applyDeepLink() in index.html.
      url: r.link ? `/?view=${encodeURIComponent(r.link)}` : '/',
      tag: `n-${r.id}`,
    });
    try {
      await deliver({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, payload);
      sent++;
    } catch (err) {
      // 404/410 mean the subscription is dead — the app was uninstalled or the
      // browser rotated the endpoint. Drop it, or the table accretes garbage and
      // every later flush burns a request on it.
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [r.sub_id]);
        pruned++;
      } else {
        console.error('push send failed:', String(r.endpoint).slice(0, 48),
                      (err && (err.statusCode || err.message)) || err);
      }
    }
    // Stamped whether or not the send worked: a row that failed for this
    // subscription should not be retried forever against a broken endpoint. The
    // age window above is the safety net for a transient outage.
    done.add(r.id);
  }
  if (done.size) {
    await pool.query('UPDATE notifications SET pushed_at = NOW() WHERE id = ANY($1)', [[...done]]);
  }
  // Retire anything past the window so the partial index stays small.
  await pool.query(`
    UPDATE notifications SET pushed_at = created_at
     WHERE pushed_at IS NULL AND created_at <= NOW() - ($1 || ' hours')::interval
  `, [String(MAX_AGE_HOURS)]);

  return { sent, pruned };
}

module.exports = { flushPush, PUSH_TYPES, MAX_AGE_HOURS, enabled };
