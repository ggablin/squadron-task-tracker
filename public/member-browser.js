/* member-browser.js — the shop-grouped, searchable member list shared by
   /records and /roster. Extracted from records.html so there is one
   implementation to change when the member list rendering needs to change.

   Self-contained on purpose: it carries its own escaping rather than relying
   on the host page defining one, so a new page can adopt it by adding a
   single script tag (and giving its list container the .member-list class,
   which is what design.css scopes this component's styles under).

   renderMemberBrowser(host, members, opts)
     `members` is a FLAT array — each member needs at least
     { id, rank, last_name, first_name, shop_name }, and optionally `active`
     (boolean). This matches what GET /api/roster returns. A member with no
     `active` field at all is treated as active — that matters for /records,
     whose APIs (/api/squadron/shops/:id/members, /api/shop/members) filter
     to active members server-side and never send the field, so there is
     nothing for the active/inactive split to do there.

     opts:
       onSelect(member)   — called when a row is clicked. The component owns
                             the '.sel' highlight itself (cleared from every
                             row, then added to the clicked one), so hosts
                             don't need to touch member-row classes at all.
       showInactive       — default false. When false, members with
                             active === false are excluded from the grouped
                             list entirely (and so can't be selected or
                             counted in a shop's size). Members with active
                             left unset are always shown, regardless.
       groupBadge(shopName, membersInShop) -> string|null
                          — optional per-shop badge (e.g. an inactive count),
                            evaluated once per group at render time.

   filterMemberBrowser(host, query)
     Live search over the members most recently rendered into `host` (no
     need for the host to hold onto that array itself). Matches a
     case-insensitive substring of "first last" — see mbMatches below for why
     that alone reproduces records.html's original first-name/last-name/
     full-name three-way check. Rank is never matched. Non-destructive: hides
     rows/groups via `display` rather than re-rendering, so scroll position
     and the current '.sel' selection survive typing. Returns the number of
     members still visible, for the host to fold into its own count label. */

function mbEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// host -> { members }: what the most recent renderMemberBrowser call for that
// host actually rendered (post active/inactive filtering), so
// filterMemberBrowser can match rows against real fields (not textContent,
// which would incorrectly pull rank into the search).
const mbState = new WeakMap();

// A substring match against "first last" alone reproduces records.html's
// original `${first} ${last}`.includes(q) || last.includes(q) || first.includes(q):
// both `last` and `first` are contiguous substrings of "first last" by
// construction, so anything they'd match, the combined string already matches.
function mbMatches(m, q) {
  if (!q) return true;
  return `${m.first_name} ${m.last_name}`.toLowerCase().includes(q);
}

function renderMemberBrowser(host, members, opts = {}) {
  const { onSelect, showInactive = false, groupBadge = () => null } = opts;
  const visible = members.filter(m => showInactive || m.active !== false);

  mbState.set(host, { members: visible });

  if (!visible.length) {
    host.innerHTML = '<div class="empty-state">No members found.</div>';
    return;
  }

  const groups = new Map();
  for (const m of visible) {
    const shop = m.shop_name || 'Unassigned';
    if (!groups.has(shop)) groups.set(shop, []);
    groups.get(shop).push(m);
  }

  host.innerHTML = [...groups.entries()].map(([shop, list]) => {
    const badge = groupBadge(shop, list);
    return `<div class="shop-group">
      <div class="shop-group-hd">
        <span class="sg-name">${mbEscape(shop)}</span>
        <span class="sg-count">${list.length}</span>
        ${badge ? `<span class="sg-badge">${mbEscape(badge)}</span>` : ''}
      </div>
      ${list.map(m => `
      <button class="member-row${m.active === false ? ' inactive' : ''}" data-id="${m.id}">
        <span class="rk">${mbEscape(m.rank)}</span>
        <span class="nm">${mbEscape(m.last_name)}, ${mbEscape(m.first_name)}</span>
      </button>`).join('')}
    </div>`;
  }).join('');

  host.querySelectorAll('.member-row').forEach(btn => {
    btn.addEventListener('click', () => {
      host.querySelectorAll('.member-row.sel').forEach(x => x.classList.remove('sel'));
      btn.classList.add('sel');
      const m = visible.find(x => String(x.id) === btn.dataset.id);
      if (onSelect && m) onSelect(m);
    });
  });
}

function filterMemberBrowser(host, query) {
  const state = mbState.get(host);
  const byId = new Map((state ? state.members : []).map(m => [String(m.id), m]));
  const q = String(query || '').trim().toLowerCase();

  let shown = 0;
  host.querySelectorAll('.member-row').forEach(row => {
    const m = byId.get(row.dataset.id);
    const hit = !m || mbMatches(m, q);
    row.style.display = hit ? '' : 'none';
    if (hit) shown++;
  });
  host.querySelectorAll('.shop-group').forEach(g => {
    const anyVisible = [...g.querySelectorAll('.member-row')].some(r => r.style.display !== 'none');
    g.style.display = anyVisible ? '' : 'none';
  });

  // display:none-ing every row/group (above) leaves a blank-looking area, not
  // the explicit "nothing matched" message the original page showed. Restore
  // that message on a zero-match query, and drop it again the moment a later
  // query matches something — `.empty-state` is also what renderMemberBrowser
  // itself uses for "no members at all", so re-use the same lookup rather
  // than tag our own: if one's already there (host was rendered empty to
  // begin with), searching an already-empty list is a no-op, not a duplicate.
  const existingEmpty = host.querySelector('.empty-state');
  if (!shown && !existingEmpty) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No members found.';
    host.appendChild(empty);
  } else if (shown && existingEmpty) {
    existingEmpty.remove();
  }

  return shown;
}
