// Additional duties — the "who do I see about X" list under Resources → People.
//
// Owners are free text on purpose: the squadron's list names state employees,
// 'EVERYONE', and people who are not in the roster. A NULL primary_owner is the
// one structured fact, and it means "needs owner" everywhere it is rendered.

const DEFAULTS = require('../data/additional-duties');

const DDL = `
  CREATE TABLE IF NOT EXISTS additional_duties (
    id              SERIAL PRIMARY KEY,
    duty            VARCHAR(120) NOT NULL,
    primary_owner   VARCHAR(200),
    alternate_owner VARCHAR(200),
    updated_by_id   INTEGER REFERENCES members(id),
    updated_at      TIMESTAMP DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS additional_duties_duty_key
    ON additional_duties (lower(duty));
`;

const COLS = 'id, duty, primary_owner, alternate_owner';

// The one place the default rows are written. Shared by ensureTable (the boot
// path) and seedIfEmpty (the seed.js path) so the two can never drift.
async function insertDefaults(client, defaults) {
  for (const d of defaults) {
    await client.query(
      `INSERT INTO additional_duties (duty, primary_owner, alternate_owner) VALUES ($1, $2, $3)`,
      [d.duty, d.primary, d.alternate]);
  }
}

// Seed-on-create. The boot block calls this on every start; it only does
// anything in the boot that finds the table absent. A database that already has
// the table — including one where an admin has since deleted rows — is left
// exactly as it is.
async function ensureTable(db, defaults = DEFAULTS) {
  const { rows } = await db.query(`SELECT to_regclass('public.additional_duties') AS t`);
  if (rows[0].t) return { created: false };
  // CREATE and seed inside one transaction, on one client. Postgres DDL is
  // transactional, so a crash or a bad row mid-seed rolls the table back with
  // it and the next boot starts clean. Without this, a half-written table
  // would satisfy the to_regclass guard above forever and the missing rows
  // would never arrive — on the first production boot, silently.
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(DDL);
    await insertDefaults(client, defaults);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { created: true, seeded: defaults.length };
}

// The seed.js path, and the counterpart to ensureTable rather than a variant of
// it. seed.js applies the whole of schema.sql, which carries a twin CREATE of
// this table — empty. That satisfies ensureTable's to_regclass guard on every
// later boot, so a database provisioned through seed.js would otherwise stay
// blank forever, with no error and nothing to notice: People simply renders
// nothing. This is the only moment it can be filled.
//
// Takes seed.js's OWN client, not the pool. seed.js runs inside one open
// transaction, and the CREATEs above are still uncommitted; a second connection
// issuing DML against them would block until that transaction ended — which it
// never would, because it is waiting on us.
//
// Empty-not-absent is the test, so an existing populated table is left alone.
// Unlike ensureTable this is not a boot path, so "the admin deleted every row"
// cannot arise between runs of a command someone typed on purpose.
async function seedIfEmpty(client, defaults = DEFAULTS) {
  const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM additional_duties');
  if (rows[0].n > 0) return { seeded: 0 };
  await insertDefaults(client, defaults);
  return { seeded: defaults.length };
}

async function list(db) {
  const { rows } = await db.query(`SELECT ${COLS} FROM additional_duties ORDER BY lower(duty)`);
  return rows;
}

// Returns undefined when the value is too long, so the caller can 400 on it.
const clean = (v, max) => {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? undefined : (s || null);
};

// partial=false: a create, duty required. partial=true: a PATCH, only the keys
// present are validated and at least one must be.
function validate(body, { partial }) {
  const value = {};
  if ('duty' in body || !partial) {
    const s = String(body.duty == null ? '' : body.duty).trim();
    if (!s) return { ok: false, error: 'A duty name is required' };
    if (s.length > 120) return { ok: false, error: 'The duty name must be 120 characters or fewer' };
    value.duty = s;
  }
  for (const k of ['primary_owner', 'alternate_owner']) {
    if (!(k in body)) continue;
    const v = clean(body[k], 200);
    if (v === undefined) {
      return { ok: false, error: `${k === 'primary_owner' ? 'Primary' : 'Alternate'} must be 200 characters or fewer` };
    }
    value[k] = v;
  }
  if (partial && !Object.keys(value).length) return { ok: false, error: 'Nothing to update' };
  return { ok: true, value };
}

function duplicate(err) {
  if (err && err.code === '23505' && err.constraint === 'additional_duties_duty_key') {
    return Object.assign(new Error('A duty with that name already exists'), { code: 'DUPLICATE' });
  }
  return err;
}

async function create(db, value, byId) {
  try {
    const { rows } = await db.query(
      `INSERT INTO additional_duties (duty, primary_owner, alternate_owner, updated_by_id)
       VALUES ($1, $2, $3, $4) RETURNING ${COLS}`,
      [value.duty, value.primary_owner ?? null, value.alternate_owner ?? null, byId]);
    return rows[0];
  } catch (err) { throw duplicate(err); }
}

async function update(db, id, value, byId) {
  const sets = [], vals = [];
  const bind = (v) => { vals.push(v); return `$${vals.length}`; };
  for (const k of ['duty', 'primary_owner', 'alternate_owner']) {
    if (k in value) sets.push(`${k} = ${bind(value[k])}`);
  }
  sets.push(`updated_by_id = ${bind(byId)}`, `updated_at = NOW()`);
  try {
    const { rows } = await db.query(
      `UPDATE additional_duties SET ${sets.join(', ')} WHERE id = ${bind(id)} RETURNING ${COLS}`, vals);
    return rows[0] || null;
  } catch (err) { throw duplicate(err); }
}

async function remove(db, id) {
  const { rowCount } = await db.query(`DELETE FROM additional_duties WHERE id = $1`, [id]);
  return rowCount > 0;
}

module.exports = { DDL, ensureTable, seedIfEmpty, list, validate, create, update, remove };
