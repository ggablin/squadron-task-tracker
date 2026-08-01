// lib/roster.js — roster management: placement derivation, slug generation,
// the admin-capability invariant, and member CRUD.
//
// The org chart (GET /api/squadron/org-chart) classifies members from the
// combination of role, flight and position, and those fields fail silently when
// set inconsistently: position is free text compared against exact strings, and
// shop.ncoic is a single slot, so two leads in one shop makes one disappear.
// Callers therefore never set the triple directly — they send a placement and
// this module derives it.

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

module.exports = {
  RosterError, FLIGHTS, PLACEMENTS, derivePlacement, placementOf, nextSlug,
  LAST_ADMIN_MESSAGE, lockActiveAdminIds, assertNotLastAdmin,
};
