const fs = require('fs');
const path = require('path');
const { makePool } = require('../../lib/db');

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Set TEST_DATABASE_URL to a throwaway Railway/local Postgres');

const pool = makePool(url);

async function applySchema() {
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

async function resetDb() {
  const { rows } = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  // Empty public schema means applySchema() hasn't run yet (or TEST_DATABASE_URL points at an empty DB); nothing to truncate.
  if (!rows.length) return;
  const list = rows.map(r => `"${r.tablename.replace(/"/g, '""')}"`).join(', ');
  await pool.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

// Inserts a minimal known world; returns ids for assertions.
async function seedFixtures() {
  const { rows: [shop] } = await pool.query(
    `INSERT INTO shops (name) VALUES ('Structures') RETURNING id`);
  const { rows: [cat] } = await pool.query(
    `INSERT INTO task_categories (code, label, sort_order) VALUES ('admin','Admin',1) RETURNING id`);
  const { rows: [lead] } = await pool.query(
    `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash, active)
     VALUES ('mcnaughton','Ann','MSgt',$1,'leadership','mcnaughton','x',true) RETURNING id`, [shop.id]);
  const { rows: [m1] } = await pool.query(
    `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash, active)
     VALUES ('becerra','Joe','SrA',$1,'member','becerra','x',true) RETURNING id`, [shop.id]);
  const { rows: [m2] } = await pool.query(
    `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash, active)
     VALUES ('derose','Kim','SSgt',$1,'member','derose','x',true) RETURNING id`, [shop.id]);
  return { shopId: shop.id, catId: cat.id, catCode: 'admin', leadId: lead.id, m1: m1.id, m2: m2.id };
}

module.exports = { pool, applySchema, resetDb, seedFixtures };
