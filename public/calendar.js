// public/calendar.js — Resources → Calendar.
//
// One global, calendarInit({ canEdit }), called from switchResPane('calendar').
// The API returns the year already derived (lib/drill-calendar.js): twelve month
// groups, drills and events interleaved, noUta on the month, past/next against
// today. This file only renders — no date logic in the browser.
//
// Roster admins get Add drill, Add event, and a pencil per row; the API enforces
// the same rule.
(function () {
  let data = null;          // { year, years, months }
  let canEdit = false;
  let shellReady = false;
  let editing = null;       // { kind: 'drill'|'event', id } | null
  // Tracks whether the last /api/calendar fetch actually succeeded — distinct
  // from data.months, which is legitimately empty both before a load and
  // when a year genuinely has nothing scheduled on it.
  let loaded = false;
  // In-flight de-dup, keyed by year (null = "current year" / no ?year= param):
  // a second load() for the SAME year while one is already pending reuses
  // that promise instead of firing a second GET. A load() for a DIFFERENT
  // year is never swallowed — it starts its own request. seq is a sequence
  // token: each load() takes the next number, and only the call still holding
  // the current seq when its request settles is allowed to write data/loaded
  // or call render(). That keeps the *newest* request authoritative even if
  // an older, slower one resolves after it — a stale response can never
  // clobber fresher data. lastYear remembers what the member was actually
  // looking at, so a retry after a failure returns to that year rather than
  // silently jumping back to the current one.
  let inFlight = null;
  let inFlightYear = null;
  let seq = 0;
  let lastYear = null;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const toast = (msg, type) => (typeof showToast === 'function' ? showToast : uiToast)(msg, type);
  const $ = (id) => document.getElementById(id);

  const PENCIL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.5 2.5l2 2L5 13H3v-2z"/><path d="M10 4l2 2"/></svg>';
  const STATUS_LABEL = { complete: 'Complete', cancelled: 'Cancelled' };

  function shell() {
    $('cal-host').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
    $('cal-host').addEventListener('click', (e) => {
      const y = e.target.closest('.cal-year');
      if (y) { load(Number(y.dataset.year)); return; }
      if (e.target.closest('#cal-add-drill')) { openEditor('drill', null); return; }
      if (e.target.closest('#cal-add-event')) { openEditor('event', null); return; }
      const edit = e.target.closest('.cal-edit');
      if (edit) openEditor(edit.dataset.kind, Number(edit.dataset.id));
    });
    shellReady = true;
  }

  function load(year) {
    const want = year || null;
    // Only dedupe a repeat request for the SAME year that's already in
    // flight — a tap on a different year must never be swallowed just
    // because some other fetch happens to be pending.
    if (inFlight && inFlightYear === want) return inFlight;
    const mine = ++seq;
    inFlightYear = want;
    lastYear = want;
    inFlight = fetch('/api/calendar' + (want ? `?year=${want}` : ''))
      .then(async (res) => {
        if (!res.ok) throw new Error('request failed');
        const json = await res.json();
        // Superseded by a newer load() before this one resolved — a stale
        // response must not overwrite data a fresher request already wrote
        // (or is about to write).
        if (mine !== seq) return;
        data = json;
        loaded = true;
      })
      .catch((e) => {
        if (mine !== seq) return;
        console.error('calendar', e);
        loaded = false;
      })
      .finally(() => {
        if (mine !== seq) return;
        inFlight = null;
        inFlightYear = null;
        render();
      });
    return inFlight;
  }

  function drillRow(e) {
    return `<div class="cal-row${e.past ? ' past' : ''}">
      <span class="cal-when">${esc(e.label)}</span>
      <span class="cal-what"><span class="cal-kind">UTA</span>${e.threeDay ? ' <span class="cal-meta">· 3-day</span>' : ''}${
        e.note ? ` <span class="cal-meta">· ${esc(e.note)}</span>` : ''}</span>
      ${e.next ? '<span class="cal-chip cal-chip-next">Next</span>' : ''}
      ${canEdit ? `<button class="cal-edit" type="button" aria-label="Edit the ${esc(e.label)} drill" data-kind="drill" data-id="${e.id}">${PENCIL}</button>` : ''}
    </div>`;
  }

  function eventRow(e) {
    const chip = STATUS_LABEL[e.status]
      ? `<span class="cal-chip cal-chip-${e.status}">${STATUS_LABEL[e.status]}</span>` : '';
    return `<div class="cal-row${e.past ? ' past' : ''}">
      <span class="cal-when">${esc(e.label)}</span>
      <span class="cal-what">
        <span class="cal-kind">${esc(e.title)}</span>${e.location ? ` <span class="cal-meta">· ${esc(e.location)}</span>` : ''}
        ${e.attendees ? `<span class="cal-who" title="${esc(e.attendees)}">${esc(e.attendees)}</span>` : ''}
        ${e.note ? `<span class="cal-who">${esc(e.note)}</span>` : ''}
      </span>
      ${chip}
      ${canEdit ? `<button class="cal-edit" type="button" aria-label="Edit ${esc(e.title)}, ${esc(e.label)}" data-kind="event" data-id="${e.id}">${PENCIL}</button>` : ''}
    </div>`;
  }

  function render() {
    // A failed (or not-yet-attempted) fetch gets the honest offline notice,
    // not the "nothing scheduled" empty state — data.months would read as
    // empty in both cases, so loaded is what tells them apart. Checked
    // before anything else touches data, so a year-chip click that lands
    // during a retry can't replace an honest offline message with a false
    // "nothing on the calendar" claim.
    if (!loaded) {
      // Restore the page's own default subtitle rather than blanking it —
      // #cal-sub ships with "Drill weekends and training"; only the host
      // needs to say the fetch failed.
      $('cal-sub').textContent = 'Drill weekends and training';
      $('cal-host').innerHTML = '<div class="res-offline">The calendar needs a connection. Try again once you have signal.</div>';
      return;
    }
    $('cal-sub').textContent = `CY ${data.year}`;
    // Chips only when there is more than one year to choose from — the displayed
    // year plus every year with rows. .seg-toggle rather than a new chip type:
    // it is already 44px and already announces state.
    const years = [...new Set([data.year, ...data.years])].sort((a, b) => a - b);
    const picker = years.length > 1
      ? `<div class="seg-toggle cal-years" role="group" aria-label="Year">${years.map(y =>
          `<button class="seg-btn cal-year${y === data.year ? ' active' : ''}" type="button" data-year="${y}" aria-pressed="${y === data.year}">${y}</button>`).join('')}</div>`
      : '';
    const admin = canEdit
      ? `<div class="cal-admin">
           <button class="add-btn" type="button" id="cal-add-drill">+ Add drill</button>
           <button class="add-btn" type="button" id="cal-add-event">+ Add event</button>
         </div>` : '';

    // No drills and no events: a year nobody has filled in yet. Twelve
    // "No UTA" lines would read as a schedule rather than an empty one.
    if (!data.months.some(m => m.entries.length)) {
      $('cal-host').innerHTML = picker + admin
        + `<div class="res-empty">Nothing on the calendar for ${data.year}.</div>`;
      return;
    }
    const body = data.months.map(m => `
      <div class="cal-month">
        <div class="cal-month-hd">
          <span class="cal-month-name">${esc(m.label)}</span>
          ${m.noUta ? '<span class="cal-nouta">No UTA</span>' : ''}
        </div>
        ${m.entries.map(e => (e.kind === 'drill' ? drillRow(e) : eventRow(e))).join('')}
      </div>`).join('');
    $('cal-host').innerHTML = picker + admin + `<div class="card cal-list">${body}</div>`;
  }

  // ── Editor modals (admins only) ─────────────────────────────────────────
  function ensureModal() {
    if ($('cal-modal')) return;
    const el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.id = 'cal-modal';
    el.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-hdr">
          <h2 class="modal-title" id="cal-modal-title">Add drill</h2>
          <button class="modal-close" type="button" aria-label="Close" id="cal-close">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
          </button>
        </div>
        <div class="modal-field" id="cal-f-title-wrap"><label for="cal-f-title">Title</label>
          <input id="cal-f-title" type="text" maxlength="120" placeholder="RADR"></div>
        <div class="modal-field" id="cal-f-location-wrap"><label for="cal-f-location">Location</label>
          <input id="cal-f-location" type="text" maxlength="120" placeholder="Dobbins ARB, GA"></div>
        <div class="field-row">
          <div class="modal-field"><label for="cal-f-start">Start</label><input id="cal-f-start" type="date"></div>
          <div class="modal-field"><label for="cal-f-end">End</label><input id="cal-f-end" type="date"></div>
        </div>
        <div class="modal-field" id="cal-f-attendees-wrap"><label for="cal-f-attendees">Attending</label>
          <textarea id="cal-f-attendees" rows="3" maxlength="600" placeholder="SrA Fowler / MSgt Brown"></textarea></div>
        <div class="modal-field" id="cal-f-status-wrap"><label for="cal-f-status">Status</label>
          <select id="cal-f-status">
            <option value="scheduled">Scheduled</option>
            <option value="complete">Complete</option>
            <option value="cancelled">Cancelled</option>
          </select></div>
        <div class="modal-field"><label for="cal-f-note">Note (optional)</label>
          <input id="cal-f-note" type="text" maxlength="200" placeholder="Jan &amp; Feb combined"></div>
        <button class="modal-submit" type="button" id="cal-save">Save</button>
        <button class="add-btn" type="button" id="cal-delete" style="display:none;width:100%;margin-top:10px;color:var(--urgent)">Delete</button>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => { if (e.target === el) closeModal('cal-modal'); });
    $('cal-close').addEventListener('click', () => closeModal('cal-modal'));
    $('cal-save').addEventListener('click', save);
    $('cal-delete').addEventListener('click', remove);
  }

  function findEntry(kind, id) {
    for (const m of data.months) {
      const hit = m.entries.find(e => e.kind === kind && e.id === id);
      if (hit) return hit;
    }
    return null;
  }

  function openEditor(kind, id) {
    ensureModal();
    editing = { kind, id };
    const isEvent = kind === 'event';
    const e = id ? findEntry(kind, id) : null;
    $('cal-modal-title').textContent = `${e ? 'Edit' : 'Add'} ${isEvent ? 'event' : 'drill'}`;
    // A drill is two dates and a note; an event adds title, location, attendees
    // and status. One sheet, four fields hidden for a drill.
    for (const f of ['title', 'location', 'attendees', 'status']) {
      $(`cal-f-${f}-wrap`).hidden = !isEvent;
    }
    $('cal-f-title').value = e && isEvent ? e.title : '';
    $('cal-f-location').value = e && isEvent ? (e.location || '') : '';
    $('cal-f-start').value = e ? e.start_date : '';
    $('cal-f-end').value = e ? e.end_date : '';
    $('cal-f-attendees').value = e && isEvent ? (e.attendees || '') : '';
    $('cal-f-status').value = e && isEvent ? e.status : 'scheduled';
    $('cal-f-note').value = e ? (e.note || '') : '';
    $('cal-delete').style.display = e ? '' : 'none';
    $('cal-delete').textContent = `Delete ${isEvent ? 'event' : 'drill'}`;
    openModal('cal-modal');
    (isEvent ? $('cal-f-title') : $('cal-f-start')).focus();
  }

  const pathFor = (kind) => (kind === 'event' ? '/api/calendar-events' : '/api/drill-dates');

  async function save() {
    const { kind, id } = editing;
    const body = kind === 'event'
      ? { title: $('cal-f-title').value, location: $('cal-f-location').value,
          start_date: $('cal-f-start').value, end_date: $('cal-f-end').value,
          attendees: $('cal-f-attendees').value, status: $('cal-f-status').value,
          note: $('cal-f-note').value }
      : { start_date: $('cal-f-start').value, end_date: $('cal-f-end').value, note: $('cal-f-note').value };
    const btn = $('cal-save');
    btn.disabled = true;
    // Hoisted out of the try so the catch below can see it — res itself is
    // const-scoped to the try block.
    let status = null;
    try {
      const res = await fetch(id ? `${pathFor(kind)}/${id}` : pathFor(kind), {
        method: id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      status = res.status;
      const saved = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(saved.error || 'Could not save');
      closeModal('cal-modal');
      toast(id ? 'Saved' : (kind === 'event' ? 'Event added' : 'Drill added'), 'success');
      // Show the year it belongs to, so a next-year entry is visible at once.
      await load(Number(String(saved.start_date).slice(0, 4)) || data.year);
    } catch (e) {
      // 400 and 409 leave the modal open so the dates can be corrected. A 404
      // means the row itself was deleted (another device/tab) since the editor
      // opened — recover by closing and reloading rather than leaving the
      // member stuck editing a drill/event that's already gone. Keyed off the
      // status code rather than the error text, since the text is just
      // server.js's wording and shouldn't be load-bearing for client recovery
      // logic.
      toast(e.message || 'Could not save', 'error');
      if (status === 404) { closeModal('cal-modal'); await load(data.year); }
    }
    btn.disabled = false;
  }

  async function remove() {
    const { kind, id } = editing;
    const e = findEntry(kind, id);
    if (!e) return;
    const what = kind === 'event' ? `${e.title}, ${e.label}` : `the ${e.label} drill`;
    if (!await uiConfirm({ title: `Delete ${what}?`,
      message: 'It disappears from the calendar for everyone.',
      confirmLabel: 'Delete', danger: true })) return;
    try {
      const res = await fetch(`${pathFor(kind)}/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        throw new Error((await res.json().catch(() => ({}))).error || 'Could not delete');
      }
      closeModal('cal-modal');
      toast('Deleted', 'success');
      await load(data.year);
    } catch (err) { toast(err.message || 'Could not delete', 'error'); }
  }

  window.calendarInit = function ({ canEdit: ce } = {}) {
    canEdit = !!ce;
    if (!shellReady) { shell(); load(); return; }
    // Re-entry retries a failed load instead of leaving the view wedged on
    // the offline notice for the rest of the tab's life — every sibling
    // Resources view re-fetches on entry, and this one now matches. The
    // retry uses lastYear rather than the current year, so a member who
    // lost signal while looking at CY 2025 comes back to CY 2025, not
    // wherever "today" falls. Once loaded, re-entry re-renders in place
    // rather than re-fetching: render() reads canEdit fresh each call, so a
    // permissions flip is picked up without a redundant GET. shell() itself
    // never needs rebuilding on a canEdit change — unlike duties.js, it only
    // ever mounts the skeleton and a delegated listener that reads the live
    // DOM at click time, so it doesn't go stale the way an admin-aware shell
    // would.
    if (!loaded) load(lastYear); else render();
  };

  // Logout hook (called from index.html's doLogout): clears the closure state
  // above so a same-tab sign-in as a different member starts clean instead of
  // showing the previous member's data and canEdit. Hung off the existing
  // calendarInit global rather than a second one, for the same reason
  // duties.js does — it's already the module's sole public entry point.
  // inFlight/inFlightYear are cleared too so a slow request still pending
  // from the old session can't be handed back by load()'s dedupe check to a
  // fresh load() for the same year; seq is left alone since it only needs to
  // keep increasing for that stale response's `mine !== seq` check to drop it.
  window.calendarInit.reset = function () {
    data = null;
    canEdit = false;
    shellReady = false;
    editing = null;
    loaded = false;
    inFlight = null;
    inFlightYear = null;
    lastYear = null;
  };
})();
