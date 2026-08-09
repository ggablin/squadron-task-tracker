// Medical service rollup — "how many people need each service this UTA".
//
// The service is not a column. McNaughton types it into the task's details as a
// slash-separated list, because one member commonly owes several:
//
//   "PHAQ / DHA3"          "MMR / HIV Blood Draw"
//   "Audiogram / DHA3 / PHAQ"        "PHAQ / Mil Dental Exam 11 Sep @ 1020hrs"
//
// Reading what he already writes is deliberate. A structured per-service field
// would be a new thing to fill in every cycle, and his workload is the constraint
// this whole app exists to reduce — a rollup that costs him nothing is worth more
// than a tidier schema he has to feed.
//
// The cost is that this is parsing prose, so the rules below are forgiving and
// nothing is ever dropped: anything unrecognised keeps its own name and lands in
// "Other", where it is visible and can be mapped later.

// "Mil Dental Exam 11 Sep @ 1020hrs" — the appointment rides along with the
// service name. Strip it so the same service with two appointment times is one
// row rather than two.
const APPT_TAIL = /\s+\d{1,2}\s+[A-Z][a-z]{2}\.?\s*@?\s*\d{3,4}\s*hrs?\.?\s*$/i;

// A PT test's details hold the due month ("Due Sep 2026"), not a service, so the
// title is the service. Everything else names its services in details.
function splitServices(title, details) {
  const t = (title || '').trim();
  if (/^pt\s*test$/i.test(t)) return ['PT Test'];
  if (!details || !details.trim()) return ['Unspecified'];
  const out = details.split('/')
    .map(s => s.trim().replace(APPT_TAIL, '').trim())
    .filter(Boolean);
  return out.length ? out : ['Unspecified'];
}

// Order matters: DHA3 must reach Health Assessments before /dental/ claims it.
//
// DHA3 is bucketed as an assessment rather than as dental work because the source
// newsletter does not say which it is — it appears only in a list beside PHAQ and
// Audiogram. "Assessment" holds whether DHA is Dental or Deployment Health
// Assessment; calling it dental work would be asserting something unverified.
// Move it to Dental here if the squadron confirms otherwise.
const GROUPS = [
  ['Immunizations', [
    /^mmr$/i, /flu/i, /tdap/i, /hep\s*[ab]/i, /varicella/i, /covid/i,
    /typhoid/i, /anthrax/i, /smallpox/i, /immuniz/i, /vaccin/i, /\bshot\b/i,
  ]],
  ['Labs & Bloodwork', [
    /hiv/i, /blood\s*draw/i, /^labs?$/i, /^dna$/i, /titer/i, /^g6pd$/i,
  ]],
  ['Health Assessments', [
    /^phaq?$/i, /^pha$/i, /^mha$/i, /^dha\s*\d*$/i,
    /health\s*assessment/i, /questionnaire/i,
  ]],
  ['Dental', [/dental/i]],
  ['Fitness', [/^pt\s*test$/i, /fitness/i, /^pft$/i]],
  ['Screenings', [/audiogram/i, /hearing/i, /vision/i, /optometr/i, /eye\s*exam/i]],
];

function groupFor(service) {
  for (const [name, patterns] of GROUPS) {
    if (patterns.some(re => re.test(service))) return name;
  }
  return 'Other';
}

// rows: { member_id, title, details, done }
// Counts DISTINCT MEMBERS, not task rows — the question is "how many people need
// immunizations", and a member owing PHAQ and DHA3 is one person in Health
// Assessments, not two.
function rollup(rows) {
  const byService = new Map();   // service -> { people:Set, done:Set }
  const byGroup   = new Map();   // group   -> Set of member ids
  const everyone  = new Set();

  for (const r of rows || []) {
    everyone.add(r.member_id);
    for (const service of splitServices(r.title, r.details)) {
      if (!byService.has(service)) byService.set(service, { people: new Set(), done: new Set() });
      const e = byService.get(service);
      e.people.add(r.member_id);
      if (r.done) e.done.add(r.member_id);

      const g = groupFor(service);
      if (!byGroup.has(g)) byGroup.set(g, new Set());
      byGroup.get(g).add(r.member_id);
    }
  }

  const services = [...byService.entries()].map(([service, e]) => ({
    service,
    group: groupFor(service),
    people: e.people.size,
    done: e.done.size,
  }));

  // Groups by size, services within a group by size — the biggest number is the
  // one the Chief is reading for.
  const groups = [...byGroup.entries()]
    .map(([group, people]) => ({
      group,
      people: people.size,
      services: services.filter(s => s.group === group)
        .sort((a, b) => b.people - a.people || a.service.localeCompare(b.service)),
    }))
    .sort((a, b) => b.people - a.people || a.group.localeCompare(b.group));

  return { groups, totalMembers: everyone.size };
}

module.exports = { splitServices, groupFor, rollup, GROUPS };
