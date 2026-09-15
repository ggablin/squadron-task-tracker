const { test } = require('node:test');
const assert = require('node:assert');
const chat = require('../lib/chat');

const squadron = { id: 1, type: 'squadron', shop_id: null, name: 'Squadron' };
const leadership = { id: 2, type: 'leadership', shop_id: null, name: 'Leadership' };
const shopA = { id: 3, type: 'shop', shop_id: 10, name: 'Structures' };
const shopB = { id: 4, type: 'shop', shop_id: 20, name: 'EA' };
const all = [squadron, leadership, shopA, shopB];

const member = { id: 1, role: 'member', shopId: 10 };
const supervisor = { id: 2, role: 'supervisor', shopId: 10 };
const leader = { id: 3, role: 'leadership', shopId: 10 };

test('a plain member sees squadron and only their own shop', () => {
  assert.deepStrictEqual(chat.visibleChannels(member, all).map(c => c.id), [1, 3]);
});

test('a supervisor has no more reach than a member', () => {
  assert.deepStrictEqual(chat.visibleChannels(supervisor, all).map(c => c.id), [1, 3]);
});

test('leadership sees every channel, including every shop and the leadership channel', () => {
  assert.deepStrictEqual(chat.visibleChannels(leader, all).map(c => c.id), [1, 2, 3, 4]);
});

test('canAccess matches visibleChannels for every role x channel pair', () => {
  for (const m of [member, supervisor, leader]) {
    for (const c of all) {
      assert.strictEqual(chat.canAccess(m, c), chat.visibleChannels(m, [c]).length === 1,
        `role=${m.role} channel=${c.type}`);
    }
  }
});

test('canPost is the same rule as canAccess in v1', () => {
  assert.strictEqual(chat.canPost, chat.canAccess);
});

test('canHide is leadership-only, independent of any channel', () => {
  assert.strictEqual(chat.canHide(member), false);
  assert.strictEqual(chat.canHide(supervisor), false);
  assert.strictEqual(chat.canHide(leader), true);
});
