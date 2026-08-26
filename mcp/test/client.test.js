// Unit tests for TrackerClient — stubbed fetch, no network, no database.
// Run: node --test test/client.test.js   (from mcp/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrackerClient, TrackerApiError, describeError } from '../src/client.js';

function jsonResponse(status, body, setCookies = []) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      getSetCookie: () => setCookies,
      get: (name) => (name.toLowerCase() === 'set-cookie' ? setCookies[0] ?? null : null),
    },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

function makeClient(script) {
  const calls = [];
  const client = new TrackerClient({ baseUrl: 'https://example.test', slug: 'gablin', password: 'pw' });
  client.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const step = script.shift();
    assert.ok(step, `unexpected fetch call to ${url}`);
    return step(String(url), opts);
  };
  return { client, calls };
}

const LOGIN_OK = (cookie = 'connect.sid=abc123') => (url, opts) => {
  assert.match(url, /\/api\/auth\/login$/);
  assert.equal(JSON.parse(opts.body).slug, 'gablin');
  return jsonResponse(200, { id: 1, role: 'leadership' }, [`${cookie}; Path=/; HttpOnly`]);
};

test('login captures the session cookie and sends it on requests', async () => {
  const { client, calls } = makeClient([
    LOGIN_OK(),
    (url, opts) => {
      assert.match(url, /\/api\/tasks$/);
      assert.equal(opts.headers.Cookie, 'connect.sid=abc123');
      return jsonResponse(200, [{ id: 7 }]);
    },
  ]);
  const rows = await client.get('/api/tasks');
  assert.deepEqual(rows, [{ id: 7 }]);
  assert.equal(calls.length, 2);
});

test('query params are appended and nullish ones dropped', async () => {
  const { client, calls } = makeClient([
    LOGIN_OK(),
    (url) => jsonResponse(200, []),
  ]);
  await client.get('/api/shop/events', { shop_id: 4, year: undefined });
  assert.match(calls[1].url, /\/api\/shop\/events\?shop_id=4$/);
});

test('a 401 mid-session triggers exactly one re-login and retry', async () => {
  const { client, calls } = makeClient([
    LOGIN_OK('connect.sid=old'),
    () => jsonResponse(401, { error: 'Unauthorized' }),
    LOGIN_OK('connect.sid=new'),
    (url, opts) => {
      assert.equal(opts.headers.Cookie, 'connect.sid=new');
      return jsonResponse(200, { ok: true });
    },
  ]);
  const out = await client.get('/api/auth/me');
  assert.deepEqual(out, { ok: true });
  assert.equal(calls.length, 4);
});

test('a 401 that survives re-login is raised, not looped', async () => {
  const { client, calls } = makeClient([
    LOGIN_OK(),
    () => jsonResponse(401, { error: 'Unauthorized' }),
    LOGIN_OK(),
    () => jsonResponse(401, { error: 'Unauthorized' }),
  ]);
  await assert.rejects(() => client.get('/api/auth/me'), (err) => {
    assert.ok(err instanceof TrackerApiError);
    assert.equal(err.status, 401);
    return true;
  });
  assert.equal(calls.length, 4);
});

test('API errors carry the server message and status', async () => {
  const { client } = makeClient([
    LOGIN_OK(),
    () => jsonResponse(403, { error: 'This cycle is closed to changes' }),
  ]);
  await assert.rejects(() => client.put('/api/tasks/9', { state: 'done' }), (err) => {
    assert.equal(err.status, 403);
    assert.equal(err.message, 'This cycle is closed to changes');
    return true;
  });
});

test('204 and empty bodies parse to null', async () => {
  const { client } = makeClient([
    LOGIN_OK(),
    () => jsonResponse(204, undefined),
  ]);
  assert.equal(await client.delete('/api/duties/3'), null);
});

test('failed login is a TrackerApiError, not a cookie crash', async () => {
  const { client } = makeClient([
    () => jsonResponse(401, { error: 'Invalid username or password' }),
  ]);
  await assert.rejects(() => client.get('/api/tasks'), (err) => {
    assert.equal(err.message, 'Invalid username or password');
    return true;
  });
});

test('missing credentials produce the setup message without any fetch', async () => {
  const client = new TrackerClient({ baseUrl: 'https://example.test', slug: 'gablin', password: 'CHANGE_ME' });
  client.fetch = async () => { throw new Error('should not fetch'); };
  await assert.rejects(() => client.get('/api/tasks'), /TRACKER_PASSWORD/);
});

test('describeError maps statuses to actionable hints', () => {
  assert.match(describeError(new TrackerApiError(403, { error: 'Forbidden' }, '/api/cycles')), /permission/);
  assert.match(describeError(new TrackerApiError(401, { error: 'Unauthorized' }, '/x')), /TRACKER_SLUG/);
  assert.match(describeError(Object.assign(new Error('t'), { name: 'TimeoutError' })), /did not respond/);
});
