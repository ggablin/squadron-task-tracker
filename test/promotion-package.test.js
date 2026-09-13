// The promotion package checklist: the data is the FSS sheet, and the form
// matcher is what turns a Forms-tab upload into a link on the Promotion tab.
// Matching keys on the IMT / NGB number in the title, so a title like
// "HQ NJANG IMT 002 – Promotion Recommendation" links and "Promotion form 2"
// does not; that rule is what leadership was told when naming uploads.
const { test } = require('node:test');
const assert = require('node:assert');
const pp = require('../public/promotion-package.js');

test('the sheet has four eligibility gates and eleven package items in FSS order', () => {
  assert.deepStrictEqual(pp.REQUIREMENTS.map(r => r.key), ['tis', 'tig', 'pme', 'edu']);
  assert.deepStrictEqual(pp.ITEMS.map(i => i.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepStrictEqual(pp.ITEMS.map(i => i.title), [
    'Cover sheet', 'IMT 002', 'IMT 004', 'Promotion Documentation Review', 'Adverse Memo',
    'Fitness Report', 'EPB', 'vMPF RIP', 'Retraining SOU', 'NGB 1212', 'Adverse information query',
  ]);
  // Every item is either a blank form (matchable) or pulled from a named system.
  for (const it of pp.ITEMS) {
    assert.ok((it.match instanceof RegExp) !== !!it.pull, `${it.title}: exactly one of match/pull`);
    if (it.pull) assert.match(it.href, /^https:\/\//, `${it.title}: pull items link to the system`);
  }
});

test('the sub-checks carry the currency windows FSS enforces', () => {
  const by = Object.fromEntries(pp.ITEMS.map(i => [i.key, i]));
  assert.ok(by.fitness.checks.some(c => /30 days/.test(c)));
  assert.ok(by.rip.checks.some(c => /60 days/.test(c)));
  assert.ok(by.imt004.checks.some(c => /no commas/.test(c)));
  assert.strictEqual(by.ngb1212.sub, 'MSgt and above');
});

test('matchDocuments links each form item to the first title that names it', () => {
  const docs = [
    { id: 11, title: 'Promotion Package Cover Sheet' },
    { id: 12, title: 'HQ NJANG IMT 002 – Promotion Recommendation' },
    { id: 13, title: 'HQ NJANG IMT 004' },
    { id: 14, title: 'IMT 006 Promotion Documentation Review (SSgt–TSgt)' },
    { id: 15, title: 'Adverse Memo template' },
    { id: 16, title: 'Retraining Statement of Understanding' },
    { id: 17, title: 'NGB 1212' },
    { id: 18, title: 'Adverse Information Query (Excel)' },
    { id: 19, title: 'RUTA Request' },                 // unrelated, never matched
  ];
  const out = pp.matchDocuments(pp.ITEMS, docs);
  const linked = Object.fromEntries(out.map(i => [i.key, i.doc && i.doc.id]));
  assert.deepStrictEqual(linked, {
    cover: 11, imt002: 12, imt004: 13, imt006: 14, adverse: 15,
    fitness: null, epb: null, rip: null,               // pulled from systems, never a document
    sou: 16, ngb1212: 17, query: 18,
  });
});

test('matching is by number, not by loose words, and never mutates the source', () => {
  const docs = [
    { id: 1, title: 'Promotion form 2' },              // no IMT number → no link
    { id: 2, title: 'imt002' },                        // case and spacing tolerant
    { id: 3, title: 'IMT 0042 something' },            // 0042 is not 004
    { id: 4, title: 'Some adverse thing' },            // "adverse" alone is not the memo or the query
  ];
  const out = pp.matchDocuments(pp.ITEMS, docs);
  const by = Object.fromEntries(out.map(i => [i.key, i.doc && i.doc.id]));
  assert.strictEqual(by.imt002, 2);
  assert.strictEqual(by.imt004, null);
  assert.strictEqual(by.adverse, null);
  assert.strictEqual(by.query, null);
  assert.ok(pp.ITEMS.every(i => !('doc' in i)), 'ITEMS is left untouched');
  assert.deepStrictEqual(pp.matchDocuments(pp.ITEMS, null).map(i => i.doc), pp.ITEMS.map(() => null));
});

test('the section reports posted forms and links or marks each row', () => {
  const html = pp.sectionHTML(pp.matchDocuments(pp.ITEMS, [{ id: 7, title: 'HQ NJANG IMT 002' }]));
  assert.match(html, /1 of 8 forms posted/);
  assert.match(html, /href="\/api\/documents\/7\/file"/);
  assert.strictEqual((html.match(/Not uploaded yet/g) || []).length, 7);
  assert.match(html, /href="https:\/\/myfitness\.af\.mil\/"/);
  assert.match(html, /promotion-checklist\.html/);
  // Titles are escaped on the way out.
  const evil = pp.sectionHTML(pp.matchDocuments(pp.ITEMS, [{ id: 8, title: 'IMT 004 <img src=x>' }]));
  assert.ok(!evil.includes('<img'), 'document titles never reach the DOM raw');
});

test('the printable sheet carries the FSS-side tracker the app section leaves out', () => {
  const print = pp.printableHTML();
  for (const t of pp.TRACKER) assert.ok(print.includes(t), t);
  assert.match(print, /Pending corrections/);
  assert.match(print, /Member's Supervisor/);
  const section = pp.sectionHTML(pp.matchDocuments(pp.ITEMS, []));
  assert.ok(!section.includes('Corrections sent to CSS'), 'CSS workflow stays on paper');
});
