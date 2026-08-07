// Member activity — when each member was last in the app, and who has never
// shown up at all. Used by GET /api/activity.
//
// Three states, because they lead to three different conversations:
//
//   never   last_login_at IS NULL and still on an issued password. No evidence
//           they have ever opened the app. This is the chase list.
//   unknown last_login_at IS NULL but they set their own password, which only
//           they could have done — so they did sign in, before sign-ins were
//           being recorded. Self-heals the next time they log in.
//   seen    last_login_at is set. The date is the answer.
//
// Ordering puts never first, then unknown, then oldest-seen — stalest at the
// top, because the list exists to surface who is missing, not who is present.

const DAY = 86400000;

function memberState(m) {
  if (m.last_login_at) return 'seen';
  return m.activated ? 'unknown' : 'never';
}

// Returns { scope, total, seen, never, unknown, active30, shops[], members[] }.
// shopId null = whole squadron; otherwise a single shop.
async function memberActivity(db, shopId = null) {
  const { rows } = await db.query(`
    SELECT m.id, m.rank, m.first_name, m.last_name, m.role,
           m.shop_id, s.name AS shop,
           m.last_login_at,
           NOT m.must_change_password AS activated
    FROM members m
    JOIN shops s ON s.id = m.shop_id
    WHERE m.active = true AND ($1::int IS NULL OR m.shop_id = $1)
    ORDER BY CASE WHEN m.last_login_at IS NOT NULL THEN 2
                  WHEN m.must_change_password THEN 0
                  ELSE 1 END,
             m.last_login_at ASC,
             m.last_name, m.first_name
  `, [shopId]);

  const cutoff = Date.now() - 30 * DAY;
  const members = rows.map(m => ({ ...m, state: memberState(m) }));

  // A shop's "seen" count is anyone we have evidence for, dated or not — an
  // unknown-date member did sign in, so counting them as missing would overstate
  // the problem and send a supervisor after someone already using the app.
  const byShop = new Map();
  for (const m of members) {
    if (!byShop.has(m.shop_id)) {
      byShop.set(m.shop_id, { id: m.shop_id, name: m.shop, total: 0, seen: 0, active30: 0 });
    }
    const s = byShop.get(m.shop_id);
    s.total++;
    if (m.state !== 'never') s.seen++;
    if (m.last_login_at && new Date(m.last_login_at).getTime() >= cutoff) s.active30++;
  }
  const shops = [...byShop.values()].sort((a, b) =>
    (a.seen / a.total) - (b.seen / b.total) || a.name.localeCompare(b.name));

  const count = st => members.filter(m => m.state === st).length;
  return {
    scope: shopId ? 'shop' : 'squadron',
    total: members.length,
    seen: members.filter(m => m.state !== 'never').length,
    never: count('never'),
    unknown: count('unknown'),
    active30: members.filter(m =>
      m.last_login_at && new Date(m.last_login_at).getTime() >= cutoff).length,
    shops,
    members,
  };
}

module.exports = { memberActivity, memberState };
