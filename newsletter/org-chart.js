// newsletter/org-chart.js
// Shared flight -> shop -> member assembly. Used by BOTH the live API route in
// server.js and the newsletter generator, so the org-chart slides match the app.
// Mirrors the logic that originally lived inline in server.js (/api/squadron/org-chart).

const SHOP_TO_FLIGHT = {
  'WFSM': 'Infrastructure', 'HVAC': 'Infrastructure',
  'Electrical': 'Infrastructure', 'Power Pro': 'Infrastructure',
  'Structures': 'Construction', 'Heavy Equipment': 'Construction',
  'Operations': 'R&O', 'EA': 'R&O',
  'EM': 'EM', 'C2': 'Squadron Staff',
};

const FLIGHT_ORDER = ['Infrastructure', 'Construction', 'R&O', 'EM'];

// rows: [{ rank, first_name, last_name, role, shop_name, flight, position }]
// returns { staff:[person], flights:[{ name, leaders:[person], shops:[{ name, ncoic, supervisors:[], members:[] }] }] }
function buildOrgChart(rows) {
  const staff = [];
  const flightMap = new Map();
  for (const f of FLIGHT_ORDER) {
    flightMap.set(f, { name: f, leaders: [], shops: new Map() });
  }

  for (const r of rows) {
    const person = {
      rank: r.rank, first_name: r.first_name, last_name: r.last_name,
      position: r.position || null, shop: r.shop_name,
    };

    const memberFlight = r.flight || SHOP_TO_FLIGHT[r.shop_name] || 'Squadron Staff';

    // Squadron Staff -> top banner
    if (memberFlight === 'Squadron Staff') {
      if (r.role === 'leadership') staff.push(person);
      continue;
    }

    const flight = flightMap.get(memberFlight);
    if (!flight) continue;

    // Flight-level leaders (superintendent, OIC, UTM): explicit flight + leadership, not a shop NCOIC
    if (r.flight && r.role === 'leadership' && !['NCOIC', 'SNCOIC'].includes(r.position)) {
      flight.leaders.push(person);
      continue;
    }

    const shopName = r.shop_name;
    if (!shopName || shopName === 'C2') continue;

    if (!flight.shops.has(shopName)) {
      flight.shops.set(shopName, { name: shopName, ncoic: null, supervisors: [], members: [] });
    }
    const shop = flight.shops.get(shopName);

    if (r.role === 'leadership' && (r.position === 'NCOIC' || r.position === 'SNCOIC')) {
      shop.ncoic = person;
    } else if (r.role === 'supervisor') {
      shop.supervisors.push(person);
    } else {
      shop.members.push(person);
    }
  }

  const posOrder = { 'Commander': 0, 'Chief Enlisted Manager': 1, 'First Sergeant': 2, 'BCE/Engineering OIC': 3 };
  staff.sort((a, b) => (posOrder[a.position] ?? 99) - (posOrder[b.position] ?? 99));

  const flights = FLIGHT_ORDER.map(name => {
    const f = flightMap.get(name);
    return { name: f.name, leaders: f.leaders, shops: Array.from(f.shops.values()) };
  });

  return { staff, flights };
}

module.exports = { buildOrgChart, SHOP_TO_FLIGHT, FLIGHT_ORDER };
