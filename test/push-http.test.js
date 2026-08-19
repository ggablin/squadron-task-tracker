// Web Push: the subscribe/unsubscribe routes, and the flush that delivers.
//
// The flush is the part worth pinning down. It decides who gets buzzed, and its
// failure modes are all silent — a wrong window wakes a member for last month's
// UTA, a missing prune retries a dead endpoint forever, and a missing stamp
// redelivers the same notification on every tick.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.ENABLE_CRON = process.env.ENABLE_CRON || 'false';

const { test } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcrypt');
const webpush = require('web-push');
const { pool, applySchema, resetDb } = require('./helpers/db');

// Real keys, generated per run: setVapidDetails validates them. lib/push.js
// reads the env lazily, so setting them before requiring it is enough.
const KEYS = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = KEYS.publicKey;
process.env.VAPID_PRIVATE_KEY = KEYS.privateKey;
process.env.VAPID_SUBJECT = 'https://108ces.up.railway.app';

const app = require('../server');
const { flushPush } = require('../lib/push');

let server, baseUrl;
const PW = 'testpass123';
const EP = 'https://fcm.googleapis.com/fcm/send/abc123';

test.before(async () => {
  await applySchema();
  await new Promise((res, rej) => {
    server = app.listen(0, e => (e ? rej(e) : res()));
    server.on('error', rej);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise(r => server.close(r)); });

function cookieFrom(res) {
  const c = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  return c.length ? c[0].split(';')[0] : null;
}

async function login(slug) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, password: PW }),
  });
  assert.strictEqual(res.status, 200, `login as ${slug}`);
  return cookieFrom(res);
}

const api = (cookie, method, path, body) => fetch(`${baseUrl}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function seed() {
  await resetDb();
  const hash = await bcrypt.hash(PW, 4);
  const { rows: [shop] } = await pool.query(
    `INSERT INTO shops (name) VALUES ('Structures') RETURNING id`);
  const mk = async (slug, role) => (await pool.query(
    `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug,
                          password_hash, active, must_change_password)
     VALUES ($1, 'T', 'SrA', $2, $3, $1, $4, true, false) RETURNING id`,
    [slug, shop.id, role, hash])).rows[0].id;
  return { a: await mk('alpha', 'member'), b: await mk('bravo', 'member') };
}

const sub = (endpoint) => ({ endpoint, keys: { p256dh: 'p256dh-value', auth: 'auth-value' } });

async function notif(memberId, type = 'task_assigned', ageHours = 0) {
  const { rows: [n] } = await pool.query(
    `INSERT INTO notifications (member_id, type, title, body, link, created_at)
     VALUES ($1, $2, 'Your tasks', 'Two new items', 'member',
             NOW() - ($3 || ' hours')::interval)
     RETURNING id`, [memberId, type, String(ageHours)]);
  return n.id;
}

const subCount = async () =>
  (await pool.query('SELECT count(*)::int n FROM push_subscriptions')).rows[0].n;

// ── routes ──────────────────────────────────────────────────────────────────

test('a signed-out request cannot read the key or subscribe', async () => {
  await seed();
  const cases = [['GET', '/api/push/vapid-key', undefined],
                 ['POST', '/api/push/subscribe', sub(EP)]];
  for (const [method, path, body] of cases) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.strictEqual(res.status, 401, `${method} ${path}`);
  }
});

test('subscribing twice from one device leaves one row, not two', async () => {
  const { a } = await seed();
  const cookie = await login('alpha');
  assert.strictEqual((await api(cookie, 'POST', '/api/push/subscribe', sub(EP))).status, 200);
  assert.strictEqual((await api(cookie, 'POST', '/api/push/subscribe', sub(EP))).status, 200);
  assert.strictEqual(await subCount(), 1, 'endpoint is the key; re-registering updates in place');
  const { rows: [r] } = await pool.query('SELECT member_id FROM push_subscriptions');
  assert.strictEqual(r.member_id, a);
});

test('a shared phone moves the subscription to whoever signs in', async () => {
  const { b } = await seed();
  await api(await login('alpha'), 'POST', '/api/push/subscribe', sub(EP));
  await api(await login('bravo'), 'POST', '/api/push/subscribe', sub(EP));
  assert.strictEqual(await subCount(), 1);
  const { rows: [r] } = await pool.query('SELECT member_id FROM push_subscriptions');
  assert.strictEqual(r.member_id, b, 'the previous member must not keep getting this device');
});

test('a malformed subscription is refused rather than stored', async () => {
  await seed();
  const cookie = await login('alpha');
  const bad = [
    {},
    { endpoint: EP },
    { endpoint: 'ftp://x', keys: { p256dh: 'a', auth: 'b' } },
    { endpoint: EP, keys: { p256dh: 'a' } },
  ];
  for (const body of bad) {
    assert.strictEqual((await api(cookie, 'POST', '/api/push/subscribe', body)).status, 400,
      `should refuse ${JSON.stringify(body)}`);
  }
  assert.strictEqual(await subCount(), 0);
});

test('unsubscribe removes only your own device', async () => {
  await seed();
  const alpha = await login('alpha');
  const bravo = await login('bravo');
  await api(alpha, 'POST', '/api/push/subscribe', sub(EP));
  // bravo naming alpha's endpoint must not delete it
  assert.strictEqual((await api(bravo, 'POST', '/api/push/unsubscribe', { endpoint: EP })).status, 200);
  assert.strictEqual(await subCount(), 1, "another member's endpoint must survive");
  assert.strictEqual((await api(alpha, 'POST', '/api/push/unsubscribe', { endpoint: EP })).status, 200);
  assert.strictEqual(await subCount(), 0);
});

test('the vapid key route returns the configured public key', async () => {
  await seed();
  const body = await (await api(await login('alpha'), 'GET', '/api/push/vapid-key')).json();
  assert.strictEqual(body.key, KEYS.publicKey);
});

// ── flush ───────────────────────────────────────────────────────────────────

test('flush delivers once, then stamps so a second tick is silent', async () => {
  const { a } = await seed();
  await api(await login('alpha'), 'POST', '/api/push/subscribe', sub(EP));
  await notif(a);

  const seen = [];
  const first = await flushPush({ pool, send: (s, payload) => { seen.push(JSON.parse(payload)); } });
  assert.strictEqual(first.sent, 1);
  assert.strictEqual(seen[0].title, 'Your tasks');
  assert.strictEqual(seen[0].url, '/?view=member', 'notifications.link becomes a deep link');

  const second = await flushPush({ pool, send: () => seen.push('AGAIN') });
  assert.strictEqual(second.sent, 0, 'pushed_at must stop a redelivery');
  assert.strictEqual(seen.length, 1);
});

test('digests stay email-only, so nobody is buzzed at 21:00', async () => {
  const { a } = await seed();
  await api(await login('alpha'), 'POST', '/api/push/subscribe', sub(EP));
  await notif(a, 'completion_digest');
  const r = await flushPush({ pool, send: () => assert.fail('a digest must not push') });
  assert.strictEqual(r.sent, 0);
});

test('a new subscriber is not buzzed for notifications that predate it', async () => {
  const { a } = await seed();
  await notif(a);                      // written BEFORE the device subscribed
  await new Promise(r => setTimeout(r, 1100));
  await api(await login('alpha'), 'POST', '/api/push/subscribe', sub(EP));
  const r = await flushPush({ pool, send: () => assert.fail('must not deliver history') });
  assert.strictEqual(r.sent, 0);
});

test('anything older than the window is retired, not delivered late', async () => {
  const { a } = await seed();
  await api(await login('alpha'), 'POST', '/api/push/subscribe', sub(EP));
  await notif(a, 'task_assigned', 48);               // two days stale
  const r = await flushPush({ pool, send: () => assert.fail('stale must not deliver') });
  assert.strictEqual(r.sent, 0);
  const { rows: [n] } = await pool.query('SELECT pushed_at FROM notifications LIMIT 1');
  assert.ok(n.pushed_at, 'and it is stamped, so it never queues again');
});

test('a dead endpoint is pruned on 410 rather than retried forever', async () => {
  const { a } = await seed();
  await api(await login('alpha'), 'POST', '/api/push/subscribe', sub(EP));
  await notif(a);
  const r = await flushPush({
    pool,
    send: () => { const e = new Error('gone'); e.statusCode = 410; throw e; },
  });
  assert.strictEqual(r.pruned, 1);
  assert.strictEqual(await subCount(), 0);
});

test('a transient send failure does not prune the device', async () => {
  const { a } = await seed();
  await api(await login('alpha'), 'POST', '/api/push/subscribe', sub(EP));
  await notif(a);
  const r = await flushPush({
    pool,
    send: () => { const e = new Error('boom'); e.statusCode = 500; throw e; },
  });
  assert.strictEqual(r.pruned, 0);
  assert.strictEqual(await subCount(), 1, 'a 500 is the push service, not a dead subscription');
});

test('one member on two devices gets both', async () => {
  const { a } = await seed();
  const cookie = await login('alpha');
  await api(cookie, 'POST', '/api/push/subscribe', sub(EP));
  await api(cookie, 'POST', '/api/push/subscribe', sub(`${EP}-laptop`));
  await notif(a);
  const hit = [];
  const r = await flushPush({ pool, send: (s) => hit.push(s.endpoint) });
  assert.strictEqual(r.sent, 2);
  assert.strictEqual(new Set(hit).size, 2);
});

test('with no VAPID keys the whole thing is a no-op, not an error', async () => {
  const { a } = await seed();
  await api(await login('alpha'), 'POST', '/api/push/subscribe', sub(EP));
  await notif(a);
  const pub = process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PUBLIC_KEY;
  try {
    const r = await flushPush({ pool, send: () => assert.fail('must not send') });
    assert.strictEqual(r.skipped, 'no VAPID keys');
    const { rows: [n] } = await pool.query('SELECT pushed_at FROM notifications LIMIT 1');
    assert.strictEqual(n.pushed_at, null,
      'and nothing is stamped, so configuring keys later still delivers');
  } finally {
    process.env.VAPID_PUBLIC_KEY = pub;
  }
});
