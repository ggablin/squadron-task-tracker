// lib/roster.js — roster management: placement derivation, slug generation,
// the admin-capability invariant, and member CRUD.
//
// The org chart (GET /api/squadron/org-chart) classifies members from the
// combination of role, flight and position, and those fields fail silently when
// set inconsistently: position is free text compared against exact strings, and
// shop.ncoic is a single slot, so two leads in one shop makes one disappear.
// Callers therefore never set the triple directly — they send a placement and
// this module derives it.

const bcrypt = require('bcrypt');

class RosterError extends Error {
  constructor(message, code = 'ROSTER_ERROR', status = 400) {
    super(message);
    this.name = 'RosterError';
    this.code = code;
    this.status = status;
  }
}

const FLIGHTS = ['Infrastructure', 'Construction', 'R&O', 'EM'];

const PLACEMENTS = {
  shop_member:     { role: 'member',     positions: [] },
  shop_supervisor: { role: 'supervisor', positions: [] },
  shop_lead:       { role: 'leadership', positions: ['NCOIC', 'SNCOIC'] },
  flight_leader:   { role: 'leadership', needsFlight: true,
                     positions: ['Flight Superintendent', 'Flight OIC', 'Unit Training Manager'] },
  squadron_staff:  { role: 'leadership', fixedFlight: 'Squadron Staff',
                     positions: ['Commander', 'Chief Enlisted Manager', 'First Sergeant',
                                 'BCE/Engineering OIC', 'Admin Support Technician'] },
};

function derivePlacement(placement, { position = null, flight = null } = {}) {
  const p = PLACEMENTS[placement];
  if (!p) throw new RosterError(`Unknown placement: ${placement}`, 'BAD_PLACEMENT');

  let outPosition = null;
  if (p.positions.length) {
    if (!p.positions.includes(position)) {
      throw new RosterError(
        `position must be one of: ${p.positions.join(', ')}`, 'BAD_POSITION');
    }
    outPosition = position;
  }

  let outFlight = null;
  if (p.fixedFlight) outFlight = p.fixedFlight;
  else if (p.needsFlight) {
    if (!FLIGHTS.includes(flight)) {
      throw new RosterError(`flight must be one of: ${FLIGHTS.join(', ')}`, 'BAD_FLIGHT');
    }
    outFlight = flight;
  }

  return { role: p.role, flight: outFlight, position: outPosition };
}

// Reverse of derivePlacement, for populating the edit form. Mirrors the order of
// checks in the org-chart endpoint: the NCOIC/SNCOIC test must come before the
// flight-leader test, exactly as the org chart's !['NCOIC','SNCOIC'] guard does.
function placementOf(m) {
  if (m.flight === 'Squadron Staff') return 'squadron_staff';
  if (m.role === 'leadership' && ['NCOIC', 'SNCOIC'].includes(m.position)) return 'shop_lead';
  if (m.role === 'leadership' && m.flight) return 'flight_leader';
  if (m.role === 'supervisor') return 'shop_supervisor';
  return 'shop_member';
}

// Sign-in names must be unique (members.slug UNIQUE). The live roster already
// contains two Fowlers and two Fernandezes, and one member with no first_name,
// so neither the bare surname nor the initial can be assumed available.
async function nextSlug(db, lastName, firstName) {
  const base = String(lastName || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!base) throw new RosterError('Last name is required', 'BAD_NAME');

  const initial = String(firstName || '').trim().toLowerCase().charAt(0);
  const candidates = [base];
  if (initial) candidates.push(`${base}-${initial}`);
  for (let n = 2; n <= 99; n++) candidates.push(`${base}-${n}`);

  const { rows } = await db.query(`SELECT slug FROM members WHERE slug = ANY($1)`, [candidates]);
  const taken = new Set(rows.map(r => r.slug));
  const free = candidates.find(c => !taken.has(c));
  if (!free) throw new RosterError('Could not generate a unique sign-in name', 'SLUG_EXHAUSTED');
  return free;
}

const LAST_ADMIN_MESSAGE =
  "You're the only person who can manage the roster. Grant it to someone else first.";

// "At least one row is true" has no clean declarative form in Postgres, unlike
// the one-live-cycle rule that uta_cycles_one_current enforces with a partial
// unique index. So the invariant is enforced here, inside the caller's
// transaction. FOR UPDATE is what stops two concurrent revocations from both
// observing a count of two and both proceeding.
async function lockActiveAdminIds(client) {
  const { rows } = await client.query(
    `SELECT id FROM members WHERE can_manage_roster = true AND active = true ORDER BY id FOR UPDATE`);
  return rows.map(r => r.id);
}

// Throws if removing this member's capability (by revoke, deactivate or delete)
// would leave zero active holders.
async function assertNotLastAdmin(client, memberId) {
  const ids = await lockActiveAdminIds(client);
  if (ids.length === 1 && ids[0] === Number(memberId)) {
    throw new RosterError(LAST_ADMIN_MESSAGE, 'LAST_ADMIN', 409);
  }
}

const ROSTER_COLUMNS = `
  m.id, m.last_name, m.first_name, m.rank, m.shop_id, s.name AS shop_name,
  m.role, m.flight, m.position, m.slug, m.email, m.active, m.can_manage_roster`;

async function listRoster(db) {
  const { rows } = await db.query(
    `SELECT ${ROSTER_COLUMNS} FROM members m
     LEFT JOIN shops s ON s.id = m.shop_id
     ORDER BY m.active DESC, s.name NULLS LAST, m.last_name, m.first_name`);
  return rows.map(r => ({ ...r, placement: placementOf(r) }));
}

async function getMember(db, id) {
  const { rows } = await db.query(
    `SELECT ${ROSTER_COLUMNS} FROM members m
     LEFT JOIN shops s ON s.id = m.shop_id WHERE m.id = $1`, [id]);
  if (!rows.length) throw new RosterError('Member not found', 'NOT_FOUND', 404);
  return { ...rows[0], placement: placementOf(rows[0]) };
}

// Initial password is the member's slug (the unit's standing provisioning
// convention: password = surname, must_change_password = true), so a batch of
// new arrivals can be created without a channel to hand each one a secret.
async function createMember(db, input, actorId) {
  // Derive first: an invalid placement must fail before any write.
  const triple = derivePlacement(input.placement, {
    position: input.position ?? null,
    flight: input.flight ?? null,
  });
  const slug = await nextSlug(db, input.last_name, input.first_name);
  const hash = await bcrypt.hash(slug, 10);

  try {
    const { rows: [row] } = await db.query(
      `INSERT INTO members
         (last_name, first_name, rank, shop_id, role, flight, position,
          slug, password_hash, must_change_password, active, email, updated_at, updated_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,true,$10,NOW(),$11)
       RETURNING id`,
      [String(input.last_name || '').trim(), String(input.first_name || '').trim(),
       String(input.rank || '').trim(), input.shop_id || null,
       triple.role, triple.flight, triple.position,
       slug, hash, input.email || null, actorId || null]);
    return await getMember(db, row.id);
  } catch (e) {
    if (e.code === '23505') {
      throw new RosterError('That sign-in name is already taken', 'SLUG_TAKEN', 409);
    }
    throw e;
  }
}

// can_manage_roster is deliberately absent from this list. The capability is
// changed only through setRosterAdmin, so the ordinary edit path cannot alter
// access control even if a payload carries the field.
const EDITABLE = ['last_name', 'first_name', 'rank', 'shop_id', 'email', 'slug'];

async function updateMember(db, id, input, actorId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Normalise once so the guard and the write can never disagree. Branching
    // the guard on `=== false` while writing `!!input.active` let falsy-but-
    // not-strictly-false values (0, null, "", NaN) skip assertNotLastAdmin yet
    // still coerce to false on write — a full lockout reachable by sending
    // JSON `0` instead of `false`.
    const activeVal = input.active !== undefined ? !!input.active : undefined;

    if (activeVal === false) await assertNotLastAdmin(client, id);

    const sets = [];
    const vals = [];
    for (const col of EDITABLE) {
      if (input[col] === undefined) continue;
      if (col === 'shop_id') {
        vals.push(input[col] || null);
      } else {
        // Explicit null must become SQL NULL, not the string "null" —
        // String(null) stringifies before .trim() can rescue it.
        vals.push(input[col] === null ? null : String(input[col]).trim());
      }
      sets.push(`${col} = $${vals.length}`);
    }
    if (activeVal !== undefined) {
      vals.push(activeVal);
      sets.push(`active = $${vals.length}`);
    }
    if (input.placement !== undefined) {
      const t = derivePlacement(input.placement, {
        position: input.position ?? null,
        flight: input.flight ?? null,
      });
      vals.push(t.role);     sets.push(`role = $${vals.length}`);
      vals.push(t.flight);   sets.push(`flight = $${vals.length}`);
      vals.push(t.position); sets.push(`position = $${vals.length}`);
    }
    if (!sets.length) { await client.query('ROLLBACK'); return await getMember(db, id); }

    vals.push(actorId || null);
    sets.push(`updated_by_id = $${vals.length}`);
    sets.push(`updated_at = NOW()`);

    vals.push(id);
    const { rowCount } = await client.query(
      `UPDATE members SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    if (!rowCount) throw new RosterError('Member not found', 'NOT_FOUND', 404);

    await client.query('COMMIT');
    return await getMember(db, id);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') {
      throw new RosterError('That sign-in name is already taken', 'SLUG_TAKEN', 409);
    }
    throw e;
  } finally { client.release(); }
}

module.exports = {
  RosterError, FLIGHTS, PLACEMENTS, derivePlacement, placementOf, nextSlug,
  LAST_ADMIN_MESSAGE, lockActiveAdminIds, assertNotLastAdmin,
  listRoster, getMember, createMember, updateMember,
};
