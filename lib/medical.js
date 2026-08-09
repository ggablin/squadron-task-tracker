// Medical services rollup — "x of y done" per service, for the squadron view.
//
// The service is the task's TITLE. That is the whole design, and it replaces an
// earlier version of this file that parsed the service out of `details`.
//
// That version was wrong, and wrong in an instructive way: it was validated
// against a preview database whose medical rows had been seeded from the
// newsletter by the same session that wrote the parser, so it only ever proved
// the parser agreed with its own fixture. On production, `details` holds
// instructions and appointment times —
//
//   "Need to get Height/Weight/Waist measured Saturday @ 1030hrs"
//   "Walk-in Saturday 0900-1400"       "See steps for completing MHA"
//
// — never a service name, so every row fell into an "Other" bucket and the card
// showed leadership things like "Need to get Height 68". Titles are the real
// thing: BCA Assessment, HIV Blood Draw, MHA, Audiogram, PHAQ, Dental Form Due,
// Mil Dental Exam, MMR. No parsing, no invented taxonomy, no guessing.

// Duty qualifications rather than something the member needs from medical.
const EXCLUDED_TITLES = new Set(['ptl training']);

// The card answers "what does the squadron owe this drill", so an item flagged
// for a later UTA is not part of the count — most of the PT tests are members
// told to book next drill in MyFitness. They are reported separately rather than
// dropped, so nothing disappears without saying so.
const DUE_NOW = new Set(['this_uta', 'overdue']);

// rows: { title, urgency, done }
function rollup(rows) {
  const services = new Map();   // title -> { total, done }
  let deferred = 0;

  for (const r of rows || []) {
    const title = (r.title || '').trim();
    if (!title || EXCLUDED_TITLES.has(title.toLowerCase())) continue;
    if (!DUE_NOW.has(r.urgency)) { deferred++; continue; }

    if (!services.has(title)) services.set(title, { total: 0, done: 0 });
    const e = services.get(title);
    e.total++;
    if (r.done) e.done++;
  }

  const out = [...services.entries()].map(([service, e]) => ({
    service,
    total: e.total,
    done: e.done,
    remaining: e.total - e.done,
    pct: e.total ? Math.round(e.done / e.total * 100) : 0,
  }));

  // Most outstanding work first — that is what the card is read for. Ties break
  // on the larger service, then alphabetically so the order is stable between
  // refreshes rather than shuffling on equal counts.
  out.sort((a, b) =>
    b.remaining - a.remaining || b.total - a.total || a.service.localeCompare(b.service));

  const total = out.reduce((s, r) => s + r.total, 0);
  const done  = out.reduce((s, r) => s + r.done, 0);

  return {
    services: out,
    total,
    done,
    pct: total ? Math.round(done / total * 100) : 0,
    deferred,
  };
}

module.exports = { rollup, EXCLUDED_TITLES, DUE_NOW };
