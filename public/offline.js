'use strict';
/* Offline reads: a cached identity and the member's own task list, so a phone
   with no signal at drill shows the list instead of a login screen.

   Two rules shape everything here:

   1. Written by app code only, NEVER by the service worker. The worker does not
      touch /api/, so member data can only enter storage through a deliberate
      call on this side. That is what keeps a shared phone from serving one
      member's tasks to the next.
   2. Scoped to the member's own task list. Supervisor rollups, attendance,
      roster, /build and /records stay online-only.

   The decisions live in pure functions so they can be tested without a browser;
   the IndexedDB wrapper below is the only part that needs one. */

/* ── Decisions ──────────────────────────────────────────────────────────── */

// What init() should do with the result of GET /api/auth/me.
//
// The distinction that matters: a THROWN fetch means no network, and a member
// standing in a metal building with a valid session should see their tasks. A
// 401 means the session is genuinely gone, and no amount of cached identity
// should paper over that — they have to sign in.
function bootDecision(outcome) {
  if (outcome.threw) return outcome.hasCachedIdentity ? 'offline-app' : 'login';
  return outcome.ok ? 'app' : 'login';
}

// A cached record is only ever usable by the member it was written for. Records
// carry their owner so this can be checked at read time as well as wiped at
// logout — belt and braces for the same-tab logout/login case.
function cacheUsable(record, memberId) {
  return !!record && record.memberId === memberId;
}

// "Offline — showing your tasks from {this}". Deliberately coarse: a member
// glancing at a banner needs to know whether it is minutes or days old, not the
// exact interval.
function relativeTime(fromMs, nowMs) {
  const seconds = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : minutes + ' minutes ago';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : hours + ' hours ago';
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : days + ' days ago';
}

/* ── Storage ────────────────────────────────────────────────────────────────
   Every method resolves rather than rejects. Offline support is a convenience
   layer: a browser with IndexedDB blocked (private mode, a locked-down profile)
   must fall back to the ordinary online app, not break. Nothing here is allowed
   to take the app down with it. */

const DB_NAME = 'uta-tracker';
const DB_VERSION = 1;
const IDENTITY_KEY = 'current';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (err) { return resolve(null); }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('identity')) db.createObjectStore('identity');
      if (!db.objectStoreNames.contains('taskCache')) db.createObjectStore('taskCache');
      // Phase 4's pendingWrites would be added here, behind a DB_VERSION bump.
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function tx(storeName, mode, run) {
  return openDb().then((db) => {
    if (!db) return null;
    return new Promise((resolve) => {
      let store;
      try { store = db.transaction(storeName, mode).objectStore(storeName); }
      catch (err) { return resolve(null); }
      const req = run(store);
      if (!req) return resolve(null);
      req.onsuccess = () => resolve(req.result === undefined ? null : req.result);
      req.onerror   = () => resolve(null);
    });
  }).catch(() => null);
}

const offlineStore = {
  getIdentity()      { return tx('identity', 'readonly',  (s) => s.get(IDENTITY_KEY)); },
  putIdentity(member) {
    if (!member || !member.id) return Promise.resolve(null);
    return tx('identity', 'readwrite', (s) =>
      s.put({ member: member, memberId: member.id, fetchedAt: Date.now() }, IDENTITY_KEY));
  },

  // Reads are guarded on ownership as well as wiped at logout. A record for
  // anyone but the signed-in member is dropped on sight rather than merely
  // ignored, so it cannot resurface later.
  getTasks(memberId) {
    return tx('taskCache', 'readonly', (s) => s.get(memberId)).then((rec) => {
      if (cacheUsable(rec, memberId)) return rec;
      if (rec) offlineStore.forgetTasks(memberId);
      return null;
    });
  },
  putTasks(memberId, tasks) {
    if (!memberId) return Promise.resolve(null);
    return tx('taskCache', 'readwrite', (s) =>
      s.put({ memberId: memberId, tasks: tasks || [], fetchedAt: Date.now() }, memberId));
  },
  forgetTasks(memberId) { return tx('taskCache', 'readwrite', (s) => s.delete(memberId)); },

  // Called from doLogout(), including when the logout request itself failed
  // because there was no signal. A device that has been logged out must be
  // clean whether or not the server ever heard about it.
  wipe() {
    return Promise.all([
      tx('identity',  'readwrite', (s) => s.clear()),
      tx('taskCache', 'readwrite', (s) => s.clear()),
    ]).then(() => true).catch(() => false);
  },
};
