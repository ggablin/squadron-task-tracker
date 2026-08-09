// What counts as work, and what is only a notice.
//
// A task is informational when it is marked is_upcoming, carries urgency 'info',
// or belongs to Upgrade Training. These are notices about what is coming —
// "5-level eligible in October", "PT window opens next UTA" — not work to tick
// off. They are shown to the member but never checked off and never counted in
// any denominator, at any level of the rollup.
//
// Derived rather than stored. is_upcoming alone is a flag someone has to remember
// to set at creation, and on the August 2026 cycle it was false on all 113 tasks
// including every Upcoming one — so the exclusion built for exactly this was
// excluding nothing, and 11 notices sat in the squadron's denominator. Reading the
// rule from urgency and category instead means it cannot be forgotten.
//
// Lives here rather than in server.js so the newsletter's cover stat applies the
// same rule. That stat is captioned "Tasks this UTA" and its comment promises it
// is "the same three numbers leadership reads off the app" — two copies of this
// expression would eventually stop agreeing, and the newsletter is the artifact
// that goes outside the squadron.
//
// `cat` is the task_categories alias in the surrounding query, which must join
// task_categories on t.category_id. COALESCE keeps it null-safe where tasks are
// LEFT JOINed and there may be no row on that side — without it, a member with no
// tasks would evaluate to NULL rather than false.
const informationalSql = (cat = 'icat') =>
  `(t.is_upcoming OR t.urgency = 'info' OR COALESCE(${cat}.code, '') = 'upgrade')`;

module.exports = { informationalSql };
