// The org-chart slides, rendered from the same builder the app's org chart uses.
//
// Redrawn for September 2026 as a real chart — chain-of-command lines, the spine
// Commander → BCE OIC → Flight OIC → Superintendent → NCOICs, two-column member
// grids — after the August deck rendered the same data as rows of chips. These
// tests pin the structure that makes it a chart rather than the styling.

const { test } = require('node:test');
const assert = require('node:assert');
const S = require('../newsletter/slides');
const { buildOrgChart } = require('../newsletter/org-chart');

const m = (rank, last, over = {}) => ({ rank, first_name: 'X', last_name: last, role: 'member',
  shop_name: null, flight: null, position: null, ...over });
const lead = (rank, last, position, flight = 'Squadron Staff') =>
  m(rank, last, { role: 'leadership', position, flight, shop_name: 'C2' });

const ROWS = [
  lead('Lt Col', 'Gorey', 'Commander'), lead('CMSgt', 'Romer', 'Chief Enlisted Manager'),
  lead('MSgt', 'Burton', 'First Sergeant'), lead('Maj', 'Ye', 'BCE/Engineering OIC'),
  lead('SrA', 'Glikin', 'Admin Support Technician'),
  // Construction: OIC + Superintendent + two shops
  lead('2LT', 'Maramba', 'Flight OIC', 'Construction'),
  lead('SMSgt', 'Izzo', 'Flight Superintendent', 'Construction'),
  m('MSgt', 'Brown', { role: 'leadership', position: 'NCOIC', shop_name: 'Heavy Equipment' }),
  m('TSgt', 'Fitch', { role: 'supervisor', shop_name: 'Heavy Equipment' }),
  m('SrA', 'Farthing', { shop_name: 'Heavy Equipment' }),
  m('SMSgt', 'Gablin', { role: 'leadership', position: 'SNCOIC', shop_name: 'Structures' }),
  m('TSgt', 'Ebbert', { role: 'supervisor', shop_name: 'Structures' }),
  m('SrA', 'Becerra', { shop_name: 'Structures' }),
  // Infrastructure: Superintendent but NO OIC (Deguzman left for OTS)
  lead('SMSgt', 'King', 'Flight Superintendent', 'Infrastructure'),
  m('MSgt', 'Green', { role: 'leadership', position: 'SNCOIC', shop_name: 'HVAC' }),
  m('TSgt', 'Price', { role: 'supervisor', shop_name: 'HVAC' }),
  m('AB', 'Neal', { shop_name: 'HVAC' }),
  // R&O: OIC, Superintendent, and the UTM beside the shops
  lead('Capt', 'Monico', 'Flight OIC', 'R&O'),
  lead('MSgt', 'McNaughton', 'Flight Superintendent', 'R&O'),
  lead('MSgt', 'Sousa', 'Unit Training Manager', 'R&O'),
  m('SSgt', 'Cabbler', { role: 'leadership', position: 'NCOIC', shop_name: 'Operations' }),
  m('SrA', 'Jenkins', { shop_name: 'Operations' }),
];

function render(flight) {
  S.beginDeck(4, 'Sep 2026 UTA');
  return S.orgSlide(flight, { org: buildOrgChart(ROWS) });
}
const order = (html, ...needles) => needles.map(n => {
  const i = html.indexOf(n); assert.ok(i >= 0, `${n} is on the slide`); return i;
});

test('the spine runs Commander → BCE OIC → Flight OIC → Superintendent, in that order, once each', () => {
  const html = render('Construction');
  const [cmd, bce, oic, supt] = order(html, 'Lt Col Gorey', 'Maj Ye', '2LT Maramba', 'SMSgt Izzo');
  assert.ok(cmd < bce && bce < oic && oic < supt, 'top to bottom, the chain of command');
  assert.strictEqual(html.split('2LT Maramba').length - 1, 1, 'the OIC appears exactly once');
  assert.strictEqual(html.split('Maj Ye').length - 1, 1, 'and the BCE OIC once, not once per staff row and once in the spine');
});

test('a flight with no OIC keeps the rung and marks it vacant, as the source chart does', () => {
  const html = render('Infrastructure');
  assert.match(html, /Flight OIC/i, 'the rung is still drawn');
  assert.match(html, /Vacant/, 'and says so');
  const [oic, supt] = order(html, 'Vacant', 'SMSgt King');
  assert.ok(oic < supt, 'the vacant OIC sits above the Superintendent');
});

test('supervisors are labelled; members are rank and name with no invented skill level', () => {
  const html = render('Construction');
  assert.match(html, /Supervisor[\s\S]{0,80}TSgt Fitch/, 'a supervisor tile carries its label');
  assert.doesNotMatch(html, /Journeyman|Craftsman/, 'the tracker does not know skill levels, so the chart does not claim them');
  assert.doesNotMatch(html, /class="org-role">Member</, 'a member tile is not labelled "Member"');
  assert.match(html, /SrA Farthing/);
});

test('the UTM hangs beside the shops off the Superintendent, not in the spine', () => {
  const html = render('R&O');
  const spine = html.slice(0, html.indexOf('org-branches'));
  assert.doesNotMatch(spine, /Sousa/, 'not in the spine');
  assert.match(html.slice(html.indexOf('org-branches')), /Unit Training Manager[\s\S]{0,80}MSgt Sousa/,
    'a peer of the NCOICs under the Superintendent');
});

test('the staff row shows the CEM, First Sergeant and Admin beside the Commander on every flight', () => {
  for (const f of ['Construction', 'Infrastructure', 'R&O']) {
    const html = render(f);
    for (const who of ['CMSgt Romer', 'MSgt Burton', 'SrA Glikin']) assert.match(html, new RegExp(who), `${who} on ${f}`);
  }
});
