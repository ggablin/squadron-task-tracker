/* ══════════════════════════════════════════════════════════════════════════
   108th CES Task Tracker — shared UI primitives
   ══════════════════════════════════════════════════════════════════════════
   Loaded by index.html, build.html and records.html. Pairs with design.css.

   Provides:
     uiToast(msg, type)      — announced status message
     uiConfirm(opts)         — Promise<boolean>, replaces native confirm()
     uiTrapFocus(el, onExit) — dialog focus management, returns a release fn

   Everything here is namespaced ui* so it can't collide with the page-local
   helpers that already exist (index.html's showToast, build.html's toast).
   ══════════════════════════════════════════════════════════════════════════ */

/* ── Toast ────────────────────────────────────────────────────────────────
   The container is created on demand and marked as a live region. Before this,
   the toast was the app's only feedback for every save and every failure and
   was never announced, so a screen-reader user checking off a task got silence.
   Success is polite (don't interrupt); failure is assertive (they need to know
   the write didn't land).
   ───────────────────────────────────────────────────────────────────────── */
function uiToastContainer() {
  let c = document.getElementById('toast-container');
  if (!c) {
    c = document.createElement('div');
    c.id = 'toast-container';
    c.className = 'toast-container';
    document.body.appendChild(c);
  }
  // Set every time: the container may pre-exist in the page markup.
  c.setAttribute('aria-live', 'polite');
  c.setAttribute('aria-atomic', 'false');
  return c;
}

function uiToast(msg, type) {
  const c = uiToastContainer();
  const t = document.createElement('div');
  t.className = 'toast toast-' + (type === 'error' ? 'error' : 'success');
  // An error has to cut through whatever is being read; a success can wait.
  if (type === 'error') t.setAttribute('role', 'alert');
  t.textContent = msg;
  c.appendChild(t);
  t.addEventListener('animationend', e => {
    if (e.animationName === 'toastOut') t.remove();
  });
}

/* ── Focus management ─────────────────────────────────────────────────────
   Moves focus into the dialog, keeps Tab inside it, restores focus to whatever
   was focused before on release, and closes on Escape.

   The focusable list is re-read on every Tab rather than captured once, because
   several dialogs show and hide controls based on a <select> (the Add Shop Item
   type switcher) — a snapshot taken at open time goes stale and lets Tab escape.
   ───────────────────────────────────────────────────────────────────────── */
const UI_FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])'
].join(',');

function uiTrapFocus(el, onExit) {
  const previous = document.activeElement;
  const visible = () => [...el.querySelectorAll(UI_FOCUSABLE)].filter(n => n.offsetParent !== null);

  const first = visible()[0];
  if (first) first.focus();
  else { el.setAttribute('tabindex', '-1'); el.focus(); }

  const onKey = e => {
    if (e.key === 'Escape' && onExit) { e.preventDefault(); onExit(); return; }
    if (e.key !== 'Tab') return;
    const f = visible();
    if (!f.length) return;
    const a = f[0], z = f[f.length - 1];
    // activeElement can sit outside the dialog entirely (focus was never moved
    // in, or a control was removed) — pull it back rather than letting Tab walk
    // the page behind the dialog.
    if (!el.contains(document.activeElement)) { e.preventDefault(); a.focus(); return; }
    if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
    else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
  };

  document.addEventListener('keydown', onKey, true);

  return function release() {
    document.removeEventListener('keydown', onKey, true);
    if (previous && document.contains(previous)) previous.focus();
  };
}

/* ── Confirm dialog ───────────────────────────────────────────────────────
   Drop-in async replacement for native confirm().

     if (!await uiConfirm({ title: 'Go live?', message: '…' })) return;

   `danger: true` turns the primary action red for destructive operations.
   ───────────────────────────────────────────────────────────────────────── */
function uiConfirm(opts) {
  const o = typeof opts === 'string' ? { message: opts } : (opts || {});
  return new Promise(resolve => {
    const back = document.createElement('div');
    back.className = 'ui-confirm-backdrop open';
    back.setAttribute('data-danger', o.danger ? 'true' : 'false');

    const titleId = 'ui-confirm-t-' + Math.random().toString(36).slice(2, 8);
    const box = document.createElement('div');
    box.className = 'ui-confirm';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', titleId);

    const h = document.createElement('div');
    h.className = 'ui-confirm-title';
    h.id = titleId;
    h.textContent = o.title || 'Are you sure?';

    const p = document.createElement('div');
    p.className = 'ui-confirm-msg';
    p.textContent = o.message || '';

    const actions = document.createElement('div');
    actions.className = 'ui-confirm-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ui-confirm-cancel';
    cancel.textContent = o.cancelLabel || 'Cancel';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'ui-confirm-ok';
    ok.textContent = o.confirmLabel || 'Confirm';
    actions.append(cancel, ok);

    box.append(h);
    if (o.message) box.append(p);
    box.append(actions);
    back.append(box);
    document.body.appendChild(back);

    let release = null;
    const done = value => {
      if (release) release();
      back.remove();
      resolve(value);
    };
    release = uiTrapFocus(box, () => done(false));

    cancel.addEventListener('click', () => done(false));
    ok.addEventListener('click', () => done(true));
    back.addEventListener('click', e => { if (e.target === back) done(false); });
  });
}
