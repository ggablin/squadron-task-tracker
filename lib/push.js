// lib/push.js — Web Push delivery.
//
// Two send paths share one delivery primitive (deliverOne):
//
//   · flushPush — deliberately shaped like notify-emails.js rather than a
//     direct send from notify(): a notification row is written first, then a
//     flush picks up whatever has pushed_at IS NULL. Used for task alerts,
//     which must survive a crash mid-send and never block the request that
//     triggered them.
//   · pushToMembers — a direct send to a fixed list of members, with no
//     notifications-table row at all. Used for chat, specifically so a chat
//     message can never be picked up by notify-emails.js's unfiltered
//     "email every un-emailed notification" flush.
//
// Both must stay out of the request path — see server.js's notify() and
// pushChatMessage() for the setImmediate wrapper each caller is responsible for.
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

// Attempt delivery to one subscription. Prunes it on 404/410 (dead endpoint —
// uninstalled app or a rotated endpoint), logs anything else, never throws.
// `sub` is { id, endpoint, p256dh, auth }; `id` is only used for pruning, so
// callers with no subscriptions-table row of their own (there are none today)
// could pass null.
async function deliverOne(pool, sub, payload, deliver) {
  try {
    await deliver({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
    return { ok: true, pruned: false };
  } catch (err) {
    if (err && (err.statusCode === 404 || err.statusCode === 410)) {
      await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
      return { ok: false, pruned: true };
    }
    console.error('push send failed:', String(sub.endpoint).slice(0, 48),
                  (err && (err.statusCode || err.message)) || err);
    return { ok: false, pruned: false };
  }
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
    const result = await deliverOne(
      pool, { id: r.sub_id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }, payload, deliver);
    if (result.ok) sent++;
    if (result.pruned) pruned++;
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

// Direct delivery to a fixed set of members — no notifications-table row, no
// flush, no cron catch-up. Callers (chat) accept that a send failure here is
// simply missed, same as a browser push in general; the in-app unread count
// is the source of truth, this is only the phone buzzing.
async function pushToMembers(pool, memberIds, payload, { send } = {}) {
  if (!memberIds || !memberIds.length) return { sent: 0, pruned: 0 };
  if (!enabled()) return { sent: 0, pruned: 0, skipped: 'no VAPID keys' };
  ensureVapid();
  const deliver = send || ((sub, p) => webpush.sendNotification(sub, p));
  const { rows } = await pool.query(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE member_id = ANY($1)`,
    [memberIds]);
  const body = JSON.stringify(payload);
  let sent = 0, pruned = 0;
  for (const sub of rows) {
    const result = await deliverOne(pool, sub, body, deliver);
    if (result.ok) sent++;
    if (result.pruned) pruned++;
  }
  return { sent, pruned };
}

module.exports = { flushPush, pushToMembers, PUSH_TYPES, MAX_AGE_HOURS, enabled };
