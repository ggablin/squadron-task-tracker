// newsletter/from-sample.js
// Builds the normalized newsletter `data` object from the static May 2026 dataset in
// generate-sample-template.js (the same data imported into the live app). Emits the SAME
// shape as from-db.js by normalizing rows and delegating to the shared shapers in shape.js.

const tpl = require('../generate-sample-template');
const { buildOrgChart } = require('./org-chart');
const shape = require('./shape');

const { memberMap, cbtRows, medicalRows, adminRows, upgradeRows, mobilityRows, woData, schedData } = tpl;

// Task row layout: [slug, last, title, details, urgency, day, time, loc]
const SLUG = 0, LAST = 1, TITLE = 2, DETAILS = 3, URGENCY = 4;

// The raw template uses Excel-style urgency labels ("Overdue", "This UTA", ...). Normalize
// them to the codes the DB stores (matches import-tasks.js) so shapers behave identically.
const URG = { 'overdue': 'overdue', 'this uta': 'this_uta', 'next uta': 'next_uta', 'future': 'future', 'info': 'info' };
const urg = (raw) => URG[String(raw || '').toLowerCase()] || 'this_uta';

const rk     = (slug) => (memberMap[slug] ? memberMap[slug].rank : '');
const shopOf = (slug) => (memberMap[slug] ? memberMap[slug].shop : '');

// Convert a template task row -> normalized task object consumed by shape.js
const normTask = (r) => ({
  rank: rk(r[SLUG]), last: r[LAST], title: r[TITLE],
  details: r[DETAILS] || '', urgency: urg(r[URGENCY]), shop: shopOf(r[SLUG]),
});

// ── Org structure overrides (role/position/flight aren't in the flat template) ──
// Derived from the May 2026 org-chart slides. Everyone not listed defaults to 'member'.
// In the live app these fields come straight from the DB.
const ORG = {
  gorey:  { role: 'leadership', position: 'Commander' },
  romer:  { role: 'leadership', position: 'Chief Enlisted Manager' },
  burton: { role: 'leadership', position: 'First Sergeant' },
  glikin: { role: 'leadership', position: 'Admin Support Technician' },
  ye:     { role: 'leadership', position: 'BCE/Engineering OIC' },
  king:       { role: 'leadership', flight: 'Infrastructure', position: 'Superintendent' },
  izzo:       { role: 'leadership', flight: 'Construction',   position: 'Superintendent' },
  mcnaughton: { role: 'leadership', flight: 'R&O',            position: 'Superintendent' },
  monico:     { role: 'leadership', flight: 'R&O',            position: 'OIC' },
  sousa:      { role: 'leadership', flight: 'R&O',            position: 'Unit Training Manager' },
  tarasewicz: { role: 'leadership', flight: 'EM',             position: 'Superintendent' },
  'fernandez-g':    { role: 'leadership', position: 'NCOIC'  },
  green:            { role: 'leadership', position: 'SNCOIC' },
  'fernandez-l':    { role: 'leadership', position: 'SNCOIC' },
  mccullough:       { role: 'leadership', position: 'SNCOIC' },
  brown:            { role: 'leadership', position: 'NCOIC'  },
  gablin:           { role: 'leadership', position: 'SNCOIC' },
  cabbler:          { role: 'leadership', position: 'NCOIC'  },
  'beljour-sommer': { role: 'leadership', position: 'SNCOIC' },
  schoenfeld:       { role: 'leadership', position: 'NCOIC'  },
  grossmick: { role: 'supervisor' }, santos: { role: 'supervisor' },
  price: { role: 'supervisor' },     banks: { role: 'supervisor' },
  beltran: { role: 'supervisor' },   willerscheidt: { role: 'supervisor' },
  emerson: { role: 'supervisor' },   geant: { role: 'supervisor' },
  fitch: { role: 'supervisor' },     ewer: { role: 'supervisor' },
  ebbert: { role: 'supervisor' },    uzoma: { role: 'supervisor' },
  huertas: { role: 'supervisor' },
  reneau: { role: 'supervisor' },    mattson: { role: 'supervisor' },
  long: { role: 'supervisor' },      hankinson: { role: 'supervisor' },
};

function orgRows() {
  return Object.values(memberMap).map(m => {
    const o = ORG[m.slug] || {};
    return {
      rank: m.rank, first_name: m.first || '', last_name: m.last,
      role: o.role || 'member', shop_name: m.shop,
      flight: o.flight || null, position: o.position || null,
    };
  });
}

function buildFromSample() {
  const cbt      = cbtRows.map(normTask);
  const medical  = medicalRows.map(normTask);
  const admin    = adminRows.map(normTask);
  const upgrade  = upgradeRows.map(normTask);
  const upcoming = mobilityRows.map(normTask);

  return {
    cover: { welcome: 'Welcome to the', title: 'May 2026 RSD', dateRange: '1–3 May 2026', unit: '108 CES' },
    org: buildOrgChart(orgRows()),
    timeline: shape.shapeTimeline(schedData.slice(1).map(([shop, day, start, end, title, details, type]) =>
      ({ shop, day, start, end, title, details, type }))),
    workOrders: shape.shapeWorkOrders(woData.slice(1).map(([shop, wo, title, details]) =>
      ({ shop, wo, title, details }))),
    sgliVred: shape.shapeSgliVred(admin),
    cbts: shape.shapeCbts(cbt),
    orders: shape.shapeOrders(admin),
    epbs: shape.shapeEpbs(admin),
    medical: shape.shapeMedical(medical),
    pt: shape.shapePt(medical),
    inbound: shape.shapeInbound(upcoming),
    upgrade: shape.shapeUpgrade(upgrade),
  };
}

module.exports = { buildFromSample };
