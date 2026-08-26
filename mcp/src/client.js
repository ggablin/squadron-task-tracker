// TrackerClient — a cookie-jar HTTP client for the tracker's own API.
//
// The app has no token auth, only express-session cookies, so this client signs
// in exactly like the browser does (POST /api/auth/login), holds the session
// cookie, and re-authenticates once on any 401 before giving up. Every write
// therefore runs through the same route guards, cycle checks, and notification
// side effects the web UI gets — nothing here talks to the database directly.

const DEFAULT_BASE_URL = 'https://108ces.up.railway.app';
const REQUEST_TIMEOUT_MS = 15000;

export class TrackerApiError extends Error {
  constructor(status, body, path) {
    const detail = body && (body.message || body.error) ? `${body.message || body.error}` : `HTTP ${status}`;
    super(detail);
    this.name = 'TrackerApiError';
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

export class TrackerClient {
  constructor({ baseUrl, slug, password } = {}) {
    this.baseUrl = (baseUrl || process.env.TRACKER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.slug = slug ?? process.env.TRACKER_SLUG;
    this.password = password ?? process.env.TRACKER_PASSWORD;
    this.cookie = null;
    this.identity = null;
    // Injectable for tests.
    this.fetch = globalThis.fetch;
  }

  assertConfigured() {
    if (!this.slug || !this.password || this.password === 'CHANGE_ME') {
      throw new Error(
        'Tracker credentials are not configured. Set TRACKER_SLUG and TRACKER_PASSWORD ' +
        'in the MCP server registration (claude mcp add … --env TRACKER_PASSWORD=…, or edit ' +
        'the squadron-tracker entry in ~/.claude.json), then restart the session.'
      );
    }
  }

  async login() {
    this.assertConfigured();
    const res = await this.fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: this.slug, password: this.password }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await readJson(res);
    if (!res.ok) throw new TrackerApiError(res.status, body, '/api/auth/login');

    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);
    if (setCookies.length) {
      this.cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
    }
    if (!this.cookie) throw new Error('Login succeeded but no session cookie was returned');
    this.identity = body;
    return body;
  }

  // method, path, { query, body } → parsed JSON (null for empty bodies).
  // Retries exactly once through a fresh login when the session has expired.
  async request(method, path, { query, body } = {}, _retried = false) {
    if (!this.cookie) await this.login();

    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    const res = await this.fetch(url, {
      method,
      headers: {
        Cookie: this.cookie,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.status === 401 && !_retried) {
      this.cookie = null;
      await this.login();
      return this.request(method, path, { query, body }, true);
    }

    const parsed = await readJson(res);
    if (!res.ok) throw new TrackerApiError(res.status, parsed, path);
    return parsed;
  }

  get(path, query) { return this.request('GET', path, { query }); }
  post(path, body) { return this.request('POST', path, { body }); }
  put(path, body) { return this.request('PUT', path, { body }); }
  patch(path, body) { return this.request('PATCH', path, { body }); }
  delete(path) { return this.request('DELETE', path, {}); }
}

async function readJson(res) {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { return { error: text.slice(0, 300) }; }
}

// One place that turns any failure into text an agent can act on.
export function describeError(err) {
  if (err instanceof TrackerApiError) {
    const hints = {
      401: 'The stored TRACKER_SLUG / TRACKER_PASSWORD were rejected — update them in the MCP registration.',
      403: err.body && /password/i.test(err.message)
        ? 'This account still has a forced password change pending — sign in once in the web app first.'
        : 'The signed-in account does not have permission for this operation.',
      404: 'Check the id — it may belong to a different cycle, or the row was deleted.',
    };
    return `Error (${err.status}) on ${err.path}: ${err.message}${hints[err.status] ? ` — ${hints[err.status]}` : ''}`;
  }
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return `Error: the tracker did not respond within ${REQUEST_TIMEOUT_MS / 1000}s — Railway may be mid-deploy; try again shortly.`;
  }
  if (err && err.cause && err.cause.code) {
    return `Error: could not reach the tracker (${err.cause.code}) — check TRACKER_BASE_URL and network.`;
  }
  return `Error: ${err && err.message ? err.message : String(err)}`;
}
