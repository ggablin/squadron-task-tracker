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

module.exports = { RosterError, FLIGHTS, PLACEMENTS, derivePlacement, placementOf };
