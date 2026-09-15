// Squadron chat: channels, messages, moderation, read tracking.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.ENABLE_CRON = process.env.ENABLE_CRON || 'false';

const { test } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcrypt');
const { pool, applySchema, resetDb } = require('./helpers/db');
const chat = require('../lib/chat');
const app = require('../server');

let server, baseUrl;

function cookieFrom(res) {
  const c = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  return c.length ? c[0].split(';')[0] : null;
}

const PW = 'testpass123';

async function login(slug) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, password: PW }),
  });
  assert.strictEqual(res.status, 200, `login as ${slug} should succeed`);
  return cookieFrom(res);
}

const api = (method, path, cookie, body) => fetch(`${baseUrl}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

// One leadership member, one supervisor and one member in Structures; one
// member in EA (a second shop, to prove cross-shop isolation); plus the four
// channels those shops and roles need. must_change_password=false so
// requireOnboarded never confounds a 403.
async function seed() {
  await resetDb();
  const hash = await bcrypt.hash(PW, 4);
  const { rows: [shopA] } = await pool.query(`INSERT INTO shops (name) VALUES ('Structures') RETURNING id`);
  const { rows: [shopB] } = await pool.query(`INSERT INTO shops (name) VALUES ('EA') RETURNING id`);
  const add = (slug, role, shopId) => pool.query(
    `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash, active, must_change_password)
     VALUES ($1,'Test','SrA',$2,$3,$1,$4,true,false) RETURNING id`, [slug, shopId, role, hash]);
  const { rows: [leader] } = await add('leadtest', 'leadership', shopA.id);
  const { rows: [sup] } = await add('suptest', 'supervisor', shopA.id);
  const { rows: [memA] } = await add('matest', 'member', shopA.id);
  const { rows: [memB] } = await add('mbtest', 'member', shopB.id);
  const { rows: [squadronCh] } = await pool.query(
    `INSERT INTO channels (type, name) VALUES ('squadron','Squadron') RETURNING id`);
  const { rows: [leadershipCh] } = await pool.query(
    `INSERT INTO channels (type, name) VALUES ('leadership','Leadership') RETURNING id`);
  const { rows: [shopACh] } = await pool.query(
    `INSERT INTO channels (type, shop_id, name) VALUES ('shop',$1,'Structures') RETURNING id`, [shopA.id]);
  const { rows: [shopBCh] } = await pool.query(
    `INSERT INTO channels (type, shop_id, name) VALUES ('shop',$1,'EA') RETURNING id`, [shopB.id]);
  return {
    shopA: shopA.id, shopB: shopB.id,
    leaderId: leader.id, supId: sup.id, memAId: memA.id, memBId: memB.id,
    squadronCh: squadronCh.id, leadershipCh: leadershipCh.id, shopACh: shopACh.id, shopBCh: shopBCh.id,
  };
}

test('signed out: GET /api/chat/channels is 401', async () => {
  await seed();
  assert.strictEqual((await api('GET', '/api/chat/channels', null)).status, 401);
});

test('a shop-A member sees squadron and shop-A only; leadership sees all four', async () => {
  const ids = await seed();
  const memA = await login('matest');
  const listA = await (await api('GET', '/api/chat/channels', memA)).json();
  assert.deepStrictEqual(listA.channels.map(c => c.id).sort((a, b) => a - b),
    [ids.squadronCh, ids.shopACh].sort((a, b) => a - b));

  const memB = await login('mbtest');
  const listB = await (await api('GET', '/api/chat/channels', memB)).json();
  assert.deepStrictEqual(listB.channels.map(c => c.id).sort((a, b) => a - b),
    [ids.squadronCh, ids.shopBCh].sort((a, b) => a - b));

  const leader = await login('leadtest');
  const listL = await (await api('GET', '/api/chat/channels', leader)).json();
  assert.strictEqual(listL.channels.length, 4);
});

test('unread_count is 0 with no messages and no reads', async () => {
  await seed();
  const memA = await login('matest');
  const { channels } = await (await api('GET', '/api/chat/channels', memA)).json();
  assert.ok(channels.every(c => c.unread_count === 0));
});

test('unread_count counts messages after last_read_at, excludes hidden ones', async () => {
  const ids = await seed();
  await pool.query(
    `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, 'hello')`,
    [ids.shopACh, ids.leaderId]);
  await pool.query(
    `INSERT INTO messages (channel_id, author_id, body, hidden_at, hidden_by_id)
     VALUES ($1, $2, 'bad', NOW(), $2)`, [ids.shopACh, ids.leaderId]);
  const memA = await login('matest');
  const { channels } = await (await api('GET', '/api/chat/channels', memA)).json();
  const shopA = channels.find(c => c.id === ids.shopACh);
  assert.strictEqual(shopA.unread_count, 1, 'the hidden message must not count');
});

test('unread_count with a real prior read: counts only after last_read_at', async () => {
  const ids = await seed();
  await pool.query(
    `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, 'before')`,
    [ids.shopACh, ids.leaderId]);
  await pool.query(
    `INSERT INTO channel_reads (member_id, channel_id, last_read_at) VALUES ($1, $2, NOW())`,
    [ids.memAId, ids.shopACh]);
  await pool.query(
    `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, 'after')`,
    [ids.shopACh, ids.leaderId]);
  const memA = await login('matest');
  const { channels } = await (await api('GET', '/api/chat/channels', memA)).json();
  const shopA = channels.find(c => c.id === ids.shopACh);
  assert.strictEqual(shopA.unread_count, 1, 'only the after-read message counts');
});

test.before(async () => {
  // Requiring server.js above kicked off its boot migration, which creates and
  // seeds channels. This file drops and re-creates that table with raw DDL,
  // which takes no lock, so the boot has to be finished first.
  await app.ready;
  await applySchema();
  await new Promise((resolve, reject) => {
    server = app.listen(0, err => (err ? reject(err) : resolve()));
    server.on('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => { await new Promise(r => server.close(r)); });

test('seed-on-create: two literal channels plus one per shop, exactly once', async () => {
  await pool.query('DROP TABLE IF EXISTS channel_reads, messages, channels CASCADE');
  await pool.query(`UPDATE members SET shop_id = NULL`);
  await pool.query(`DELETE FROM shops`);
  await pool.query(`INSERT INTO shops (name) VALUES ('Structures'), ('EA')`);

  assert.deepStrictEqual(await chat.ensureTable(pool), { created: true, seeded: 4 });
  const count = async () => Number((await pool.query('SELECT COUNT(*) FROM channels')).rows[0].count);
  assert.strictEqual(await count(), 4);

  const { rows: types } = await pool.query(
    `SELECT type, shop_id, name FROM channels ORDER BY type, name`);
  assert.deepStrictEqual(types.map(r => r.type), ['leadership', 'shop', 'shop', 'squadron']);

  assert.deepStrictEqual(await chat.ensureTable(pool), { created: false });
  assert.strictEqual(await count(), 4, 'a second boot adds nothing');

  await pool.query(`DELETE FROM channels WHERE type = 'shop' AND name = 'EA'`);
  assert.deepStrictEqual(await chat.ensureTable(pool), { created: false });
  assert.strictEqual(await count(), 3, 'a deleted channel never comes back');
});

test('at most one squadron channel and one leadership channel', async () => {
  await pool.query('DROP TABLE IF EXISTS channel_reads, messages, channels CASCADE');
  await chat.ensureTable(pool);
  await assert.rejects(
    () => pool.query(`INSERT INTO channels (type, name) VALUES ('squadron', 'Squadron 2')`),
    /duplicate key value|channels_singleton_key/);
});

test('a shop channel requires a shop_id, and a non-shop channel forbids one', async () => {
  await pool.query('DROP TABLE IF EXISTS channel_reads, messages, channels CASCADE');
  await chat.ensureTable(pool);
  await assert.rejects(
    () => pool.query(`INSERT INTO channels (type, name) VALUES ('shop', 'Orphan')`),
    /violates check constraint/);
  const { rows: [shop] } = await pool.query(`SELECT id FROM shops LIMIT 1`);
  await assert.rejects(
    () => pool.query(`INSERT INTO channels (type, shop_id, name) VALUES ('squadron', $1, 'Bad')`, [shop.id]),
    /violates check constraint/);
});
