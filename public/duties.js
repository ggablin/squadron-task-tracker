// public/duties.js — Resources → People → Additional duties.
//
// One global, dutiesInit({ canEdit }), called from setPeopleView() the first
// time a member flips the toggle. Everyone gets the list and the filter; roster
// admins also get Add and a pencil per row. The API enforces the same rule — the
// flag here only keeps controls out of everyone else's way.
//
// Rows are a divider list on the .member-row metrics rather than 52 bordered
// cards: half the scroll height, consistent with the calendar beside it, and
// clear of the identical-card-grid ban. Uses the page's openModal/closeModal
// (focus trap, role=dialog), showToast (quiet offline) and uiConfirm.
(function () {
  let all = [];
  let canEdit = false;
  let shellReady = false;
  let editingId = null;
  // Tracks whether the last /api/duties fetch actually succeeded — distinct
  // from all.length, which is legitimately 0 both when nothing has loaded
  // yet and when the squadron genuinely has zero duties on the books.
  let loaded = false;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const toast = (msg, type) => (typeof showToast === 'function' ? showToast : uiToast)(msg, type);
  const $ = (id) => document.getElementById(id);

  const PENCIL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.5 2.5l2 2L5 13H3v-2z"/><path d="M10 4l2 2"/></svg>';

  function shell() {
    $('duties-host').innerHTML = `
      ${canEdit ? '<div class="duty-admin"><button class="add-btn" type="button" id="duty-add">+ Add duty</button></div>' : ''}
      <div class="search-wrap duties-search">
        <input class="search-input" id="duty-q" type="search" placeholder="Search duties and names" autocomplete="off" aria-label="Filter duties">
        <div class="search-count" id="duty-count" aria-live="polite"></div>
      </div>
      <div class="duty-list" id="duty-list"><div class="skeleton"></div><div class="skeleton"></div></div>`;
    $('duty-q').addEventListener('input', renderList);
    if (canEdit) $('duty-add').addEventListener('click', () => openEditor(null));
    $('duty-list').addEventListener('click', (e) => {
      const btn = e.target.closest('.duty-edit');
      if (btn) openEditor(Number(btn.dataset.id));
    });
    shellReady = true;
  }

  async function load() {
    try {
      const res = await fetch('/api/duties');
      if (!res.ok) throw new Error('request failed');
      all = (await res.json()).duties;
      loaded = true;
      renderList();
    } catch (e) {
      console.error('duties', e);
      loaded = false;
      renderList();
    }
  }

  function renderList() {
    // A failed/never-attempted fetch gets the honest offline notice, not the
    // "no duties" empty state — all.length is legitimately 0 in both cases,
    // so loaded is what tells them apart. Checked ahead of the query so a
    // filter keystroke after a failure can't paper over it with a false claim.
    if (!loaded) {
      $('duty-list').innerHTML = '<div class="res-offline">The duties list needs a connection. Try again once you have signal.</div>';
      $('duty-count').textContent = '';
      return;
    }
    const q = ($('duty-q').value || '').trim().toLowerCase();
    const rows = q
      ? all.filter(d => [d.duty, d.primary_owner, d.alternate_owner]
          .some(v => (v || '').toLowerCase().includes(q)))
      : all;
    $('duty-count').textContent = q ? `${rows.length} of ${all.length} match` : `${all.length} duties`;
    if (!all.length) {
      $('duty-list').innerHTML = `<div class="res-empty">${canEdit
        ? 'No duties yet — add the first one above.'
        : 'No duties have been posted yet.'}</div>`;
      return;
    }
    if (!rows.length) {
      $('duty-list').innerHTML = '<div class="res-empty">Nothing matches that search.</div>';
      return;
    }
    $('duty-list').innerHTML = rows.map(d => `
      <div class="duty-row${d.primary_owner ? '' : ' needs-owner'}">
        <div class="duty-body">
          <div class="duty-name">${esc(d.duty)}${d.primary_owner ? ''
            : ' <span class="duty-tag">Needs owner</span>'}</div>
          <div class="duty-owners">Primary: ${esc(d.primary_owner || '—')} · Alt: ${esc(d.alternate_owner || '—')}</div>
        </div>
        ${canEdit ? `<button class="duty-edit" type="button" aria-label="Edit ${esc(d.duty)}" data-id="${d.id}">${PENCIL}</button>` : ''}
      </div>`).join('');
  }

  // ── Editor modal (admins only) ──────────────────────────────────────────
  function ensureModal() {
    if ($('duty-modal')) return;
    const el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.id = 'duty-modal';
    el.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-hdr">
          <h2 class="modal-title" id="duty-modal-title">Add duty</h2>
          <button class="modal-close" type="button" aria-label="Close" id="duty-close">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
          </button>
        </div>
        <div class="modal-field"><label for="duty-f-name">Duty</label>
          <input id="duty-f-name" type="text" maxlength="120" placeholder="Lodging Monitor"></div>
        <div class="modal-field"><label for="duty-f-primary">Primary</label>
          <input id="duty-f-primary" type="text" maxlength="200" placeholder="Leave blank if nobody holds it"></div>
        <div class="modal-field"><label for="duty-f-alternate">Alternate</label>
          <input id="duty-f-alternate" type="text" maxlength="200"></div>
        <button class="modal-submit" type="button" id="duty-save">Save</button>
        <button class="add-btn" type="button" id="duty-delete" style="display:none;width:100%;margin-top:10px;color:var(--urgent)">Delete duty</button>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => { if (e.target === el) closeModal('duty-modal'); });
    $('duty-close').addEventListener('click', () => closeModal('duty-modal'));
    $('duty-save').addEventListener('click', save);
    $('duty-delete').addEventListener('click', remove);
  }

  function openEditor(id) {
    ensureModal();
    editingId = id;
    const d = id ? all.find(x => x.id === id) : null;
    $('duty-modal-title').textContent = d ? 'Edit duty' : 'Add duty';
    $('duty-f-name').value = d ? d.duty : '';
    $('duty-f-primary').value = d ? (d.primary_owner || '') : '';
    $('duty-f-alternate').value = d ? (d.alternate_owner || '') : '';
    $('duty-delete').style.display = d ? '' : 'none';
    openModal('duty-modal');
    $('duty-f-name').focus();
  }

  async function save() {
    const body = {
      duty: $('duty-f-name').value,
      primary_owner: $('duty-f-primary').value,
      alternate_owner: $('duty-f-alternate').value,
    };
    const btn = $('duty-save');
    btn.disabled = true;
    try {
      const res = await fetch(editingId ? `/api/duties/${editingId}` : '/api/duties', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not save');
      closeModal('duty-modal');
      toast(editingId ? 'Duty updated' : 'Duty added', 'success');
      await load();
    } catch (e) {
      // 400 and 409 leave the modal open so the value can be corrected.
      toast(e.message || 'Could not save', 'error');
      if (/no longer exists/.test(e.message || '')) { closeModal('duty-modal'); await load(); }
    }
    btn.disabled = false;
  }

  async function remove() {
    const d = all.find(x => x.id === editingId);
    if (!d) return;
    if (!await uiConfirm({ title: `Delete "${d.duty}"?`,
      message: 'It disappears from the list and from the newsletter.',
      confirmLabel: 'Delete', danger: true })) return;
    try {
      const res = await fetch(`/api/duties/${editingId}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        throw new Error((await res.json().catch(() => ({}))).error || 'Could not delete');
      }
      closeModal('duty-modal');
      toast('Duty deleted', 'success');
      await load();
    } catch (e) { toast(e.message || 'Could not delete', 'error'); }
  }

  window.dutiesInit = function ({ canEdit: ce } = {}) {
    const was = canEdit;
    canEdit = !!ce;
    if (!shellReady) { shell(); load(); return; }
    // shell() only needs rebuilding when the admin controls themselves
    // change; it does not imply the data is stale, so it never resets loaded.
    if (was !== canEdit) shell();
    // Re-entry retries a failed load instead of leaving the view wedged on
    // the offline notice for the rest of the tab's life — but a successful
    // load does NOT re-fetch on re-entry, only a prior failure does. That's
    // the same loaded-flag guard calendar.js uses; Forms and the org chart
    // are different, unconditionally re-fetching every time their pane is
    // entered. Once loaded, re-entry re-renders (rather than the previous
    // total no-op) so shell() rebuilds (canEdit flips) are reflected;
    // renderList() reads the filter input in place, so a query the member
    // already typed carries forward instead of silently resetting to "all
    // 52" on every pane visit.
    if (!loaded) load(); else renderList();
  };
})();
