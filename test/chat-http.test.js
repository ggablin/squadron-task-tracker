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
