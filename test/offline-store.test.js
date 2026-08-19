'use strict';
// The offline policy decisions, tested against the real public/offline.js.
//
// The IndexedDB wrapper itself needs a browser, so offline.js keeps its
// decisions in pure functions that node can drive directly. Those decisions are
// where the damage lives: sending a member with no signal to a login screen, or
// showing one member another's cached tasks on a shared phone.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadOffline() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'offline.js'), 'utf8');
  const ctx = { console, JSON, Promise, setTimeout, clearTimeout, Date, Math,
                indexedDB: undefined, window: {}, navigator: { onLine: true } };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}

test('a member with no signal but a cached identity gets the app, not the login screen', () => {
  const { bootDecision } = loadOffline();
  assert.strictEqual(bootDecision({ threw: true, hasCachedIdentity: true }), 'offline-app');
});

test('a member with no signal and nothing cached still gets the login screen', () => {
  const { bootDecision } = loadOffline();
  assert.strictEqual(bootDecision({ threw: true, hasCachedIdentity: false }), 'login');
});

test('a 401 means the session really is gone, so a cached identity must not paper over it', () => {
  const { bootDecision } = loadOffline();
  assert.strictEqual(bootDecision({ threw: false, ok: false, hasCachedIdentity: true }), 'login',
    'an expired session is not the same condition as no network');
});

test('a normal signed-in load is unaffected', () => {
  const { bootDecision } = loadOffline();
  assert.strictEqual(bootDecision({ threw: false, ok: true, hasCachedIdentity: true }), 'app');
  assert.strictEqual(bootDecision({ threw: false, ok: true, hasCachedIdentity: false }), 'app');
});

test('a cache belonging to another member is never usable — the shared-phone case', () => {
  const { cacheUsable } = loadOffline();
  assert.strictEqual(cacheUsable({ memberId: 7, tasks: [] }, 7), true);
  assert.strictEqual(cacheUsable({ memberId: 7, tasks: [] }, 9), false,
    'member 9 must never be shown member 7 cached tasks');
  assert.strictEqual(cacheUsable(null, 7), false);
  assert.strictEqual(cacheUsable({ tasks: [] }, 7), false, 'a record with no owner is not trustworthy');
});

test('the offline banner says how old the data is in words a member reads at a glance', () => {
  const { relativeTime } = loadOffline();
  const now = Date.UTC(2026, 8, 12, 12, 0, 0);
  const ago = (ms) => relativeTime(now - ms, now);
  assert.strictEqual(ago(5 * 1000), 'just now');
  assert.strictEqual(ago(1 * 60 * 1000), '1 minute ago');
  assert.strictEqual(ago(42 * 60 * 1000), '42 minutes ago');
  assert.strictEqual(ago(1 * 60 * 60 * 1000), '1 hour ago');
  assert.strictEqual(ago(5 * 60 * 60 * 1000), '5 hours ago');
  assert.strictEqual(ago(26 * 60 * 60 * 1000), 'yesterday');
  assert.strictEqual(ago(4 * 24 * 60 * 60 * 1000), '4 days ago');
});
