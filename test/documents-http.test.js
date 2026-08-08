// Squadron forms on the Resources tab.
//
// Upload/edit/remove is gated on can_manage_roster — the two squadron admins —
// not on role. "Leadership" is twenty-one people; posting a document that every
// member is expected to trust is a narrower job than that.
//
// The risky part of this feature is not the upload, it is the download: these
// bytes come from a person and are served back from the app's own origin. If a
// browser can be talked into treating one as HTML, script inside it runs with
// every member's session cookie. Two defences are tested here — the server only
// stores something that really is a PDF, and it serves it so it can only ever be
// read as one.
//
// DATABASE_URL must point at the same throwaway Postgres as TEST_DATABASE_URL
// before requiring server.js, since the app builds its pool at module-load time.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.ENABLE_CRON = process.env.ENABLE_CRON || 'false';

const { test } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcrypt');
const { pool, applySchema, resetDb } = require('./helpers/db');
const app = require('../server');

let server, baseUrl;

test.before(async () => {
  await applySchema();
  await new Promise((resolve, reject) => {
    server = app.listen(0, err => (err ? reject(err) : resolve()));
    server.on('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => { await new Promise(r => server.close(r)); });

function cookieFrom(res) {
  const c = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  return c.length ? c[0].split(';')[0] : null;
}

const PW = 'testpass123';

async function login(slug) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, password: PW }),
  });
  assert.strictEqual(res.status, 200, `login as ${slug} should succeed`);
  return cookieFrom(res);
}

async function seed() {
  await resetDb();
  const hash = await bcrypt.hash(PW, 10);
  const { rows: [{ id: shop }] } = await pool.query(
    `INSERT INTO shops (name) VALUES ('Structures') RETURNING id`);
  const add = (slug, role, admin = false) => pool.query(
    `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash, active,
                          must_change_password, can_manage_roster)
     VALUES ($1,'Test','SSgt',$2,$3,$4,$5,true,false,$6)`, [slug, shop, role, slug, hash, admin]);
  await add('admintest', 'leadership', true);   // the capability holder
  await add('leadtest', 'leadership', false);   // leadership WITHOUT the flag
  await add('suptest', 'supervisor');
  await add('memtest', 'member');
}

// A minimal but genuine PDF: the magic bytes are what the server checks.
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

function upload(cookie, body, qs = 'title=RUTA%20Request&filename=ruta.pdf') {
  return fetch(`${baseUrl}/api/documents?${qs}`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/pdf' },
    body,
  });
}

test('a squadron admin can upload a form and every member can then see and open it', async () => {
  await seed();
  const lead = await login('admintest');
  const up = await upload(lead, PDF,
    'title=RUTA%20Request&filename=ruta.pdf&category=Forms&description=Submit%2030%20days%20out');
  assert.strictEqual(up.status, 201);
  const doc = await up.json();
  assert.strictEqual(doc.title, 'RUTA Request');
  assert.strictEqual(doc.byte_size, PDF.length);

  // A plain member sees it in the list and can fetch the bytes.
  const memCookie = await login('memtest');
  const list = await (await fetch(`${baseUrl}/api/documents`, { headers: { Cookie: memCookie } })).json();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].title, 'RUTA Request');
  assert.ok(!('content' in list[0]), 'the listing must not carry the file bytes');

  const file = await fetch(`${baseUrl}/api/documents/${doc.id}/file`, { headers: { Cookie: memCookie } });
  assert.strictEqual(file.status, 200);
  assert.strictEqual(file.headers.get('content-type'), 'application/pdf');
  assert.strictEqual(Buffer.from(await file.arrayBuffer()).equals(PDF), true);
});

test('a stored file is served so it can never be read as HTML', async () => {
  await seed();
  const lead = await login('admintest');
  const { id } = await (await upload(lead, PDF)).json();
  const res = await fetch(`${baseUrl}/api/documents/${id}/file`, { headers: { Cookie: lead } });

  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff',
    'without nosniff a browser may sniff the body and run it as HTML on this origin');
  assert.match(res.headers.get('content-security-policy') || '', /sandbox/);
  assert.match(res.headers.get('content-disposition') || '', /^inline; filename="ruta\.pdf"$/);
});

test('a filename cannot inject a header or escape into a path', async () => {
  await seed();
  const lead = await login('admintest');
  const nasty = encodeURIComponent('../../etc/pa"sswd\r\nSet-Cookie: x=1.pdf');
  const { id } = await (await upload(lead, PDF, `title=Odd&filename=${nasty}`)).json();
  const res = await fetch(`${baseUrl}/api/documents/${id}/file`, { headers: { Cookie: lead } });

  const cd = res.headers.get('content-disposition');
  assert.ok(!/[\r\n]/.test(cd), 'no CR/LF may survive into the header');
  assert.ok(!cd.includes('..') && !cd.includes('/'), 'no path parts may survive');
  assert.strictEqual((cd.match(/"/g) || []).length, 2, 'exactly the two delimiting quotes');
  assert.strictEqual(res.headers.get('set-cookie'), null, 'no injected header');
});

test('a file whose bytes contradict its extension is refused, and stores nothing', async () => {
  await seed();
  const lead = await login('admintest');
  const html = Buffer.from('<script>alert(document.cookie)</script>');
  for (const name of ['totally.pdf', 'invoice.docx', 'sheet.xlsx', 'photo.png']) {
    const res = await upload(lead, html, `title=Sneaky&filename=${name}`);
    assert.strictEqual(res.status, 400, `${name} must be refused`);
    assert.match((await res.json()).error, /do not match its type/i);
  }
  const list = await (await fetch(`${baseUrl}/api/documents`, { headers: { Cookie: lead } })).json();
  assert.strictEqual(list.length, 0, 'nothing may be stored when the check fails');
});

// Word/Excel/PowerPoint and images, alongside PDF.
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);           // docx/xlsx/pptx
const OLE = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]); // doc/xls/ppt
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);

test('Word, Excel, PowerPoint and images upload and come back with their own type', async () => {
  await seed();
  const lead = await login('admintest');
  const cases = [
    ['ruta.docx', ZIP, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['roster.xlsx', ZIP, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['brief.pptx', ZIP, 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['legacy.doc', OLE, 'application/msword'],
    ['legacy.xls', OLE, 'application/vnd.ms-excel'],
    ['diagram.png', PNG, 'image/png'],
    ['scan.jpg', JPG, 'image/jpeg'],
  ];
  for (const [name, body, mime] of cases) {
    const up = await upload(lead, body, `title=${encodeURIComponent(name)}&filename=${name}`);
    assert.strictEqual(up.status, 201, `${name} should upload`);
    const { id } = await up.json();
    const res = await fetch(`${baseUrl}/api/documents/${id}/file`, { headers: { Cookie: lead } });
    assert.strictEqual(res.headers.get('content-type'), mime, `${name} served as ${mime}`);
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('only formats a browser renders safely open inline; the rest are forced to download',
  async () => {
    await seed();
    const lead = await login('admintest');
    const expect = [
      ['form.pdf', PDF, 'inline'], ['diagram.png', PNG, 'inline'], ['scan.jpg', JPG, 'inline'],
      // A browser can be talked into rendering an Office file; keep it out of the tab.
      ['ruta.docx', ZIP, 'attachment'], ['roster.xlsx', ZIP, 'attachment'],
      ['brief.pptx', ZIP, 'attachment'], ['legacy.doc', OLE, 'attachment'],
    ];
    for (const [name, body, disp] of expect) {
      const { id } = await (await upload(lead, body, `title=${name}&filename=${name}`)).json();
      const res = await fetch(`${baseUrl}/api/documents/${id}/file`, { headers: { Cookie: lead } });
      assert.match(res.headers.get('content-disposition'), new RegExp('^' + disp + ';'),
        `${name} should be ${disp}`);
    }
  });

test('an extension we do not accept is refused even when the bytes are a real file', async () => {
  await seed();
  const lead = await login('admintest');
  // An SVG is a real image and a script container; it must not get in.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.strictEqual((await upload(lead, svg, 'title=Logo&filename=logo.svg')).status, 400);
  // A genuine zip that is not an Office document.
  assert.strictEqual((await upload(lead, ZIP, 'title=Archive&filename=stuff.zip')).status, 400);
});

test('a file with no extension is taken as a PDF only when it really is one', async () => {
  await seed();
  const lead = await login('admintest');
  // Nothing is guessed here: the name defaults to .pdf, and the signature check
  // then has to agree, so an extensionless upload is accepted only on its bytes.
  const ok = await upload(lead, PDF, 'title=No%20ext&filename=README');
  assert.strictEqual(ok.status, 201);
  assert.strictEqual((await ok.json()).filename, 'README.pdf');

  assert.strictEqual((await upload(lead, ZIP, 'title=No%20ext&filename=archive')).status, 400,
    'an extensionless file that is not a PDF must still be refused');
});

test('?download=1 forces a download even for a format that would open inline', async () => {
  await seed();
  const lead = await login('admintest');
  const { id } = await (await upload(lead, PDF)).json();
  const res = await fetch(`${baseUrl}/api/documents/${id}/file?download=1`, { headers: { Cookie: lead } });
  assert.match(res.headers.get('content-disposition'), /^attachment;/);
});

test('an upload with no title is refused', async () => {
  await seed();
  const res = await upload(await login('admintest'), PDF, 'title=%20%20&filename=x.pdf');
  assert.strictEqual(res.status, 400);
});

test('only a squadron admin may upload, edit or remove — leadership alone is not enough', async () => {
  await seed();
  const lead = await login('admintest');
  const { id } = await (await upload(lead, PDF)).json();

  for (const who of ['leadtest', 'suptest', 'memtest']) {
    const cookie = await login(who);
    assert.strictEqual((await upload(cookie, PDF, 'title=Nope&filename=n.pdf')).status, 403,
      `${who} must not upload`);
    const patch = await fetch(`${baseUrl}/api/documents/${id}`, {
      method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed' }),
    });
    assert.strictEqual(patch.status, 403, `${who} must not rename`);
    const del = await fetch(`${baseUrl}/api/documents/${id}`, { method: 'DELETE', headers: { Cookie: cookie } });
    assert.strictEqual(del.status, 403, `${who} must not remove`);
  }
});

test('a signed-out request gets nothing — not the list, not the bytes', async () => {
  await seed();
  const { id } = await (await upload(await login('admintest'), PDF)).json();
  assert.strictEqual((await fetch(`${baseUrl}/api/documents`)).status, 401);
  assert.strictEqual((await fetch(`${baseUrl}/api/documents/${id}/file`)).status, 401);
});

test('removing a form hides it from members but keeps the bytes recoverable', async () => {
  await seed();
  const lead = await login('admintest');
  const { id } = await (await upload(lead, PDF)).json();

  assert.strictEqual((await fetch(`${baseUrl}/api/documents/${id}`, {
    method: 'DELETE', headers: { Cookie: lead } })).status, 200);

  const list = await (await fetch(`${baseUrl}/api/documents`, { headers: { Cookie: lead } })).json();
  assert.strictEqual(list.length, 0);
  assert.strictEqual((await fetch(`${baseUrl}/api/documents/${id}/file`, { headers: { Cookie: lead } })).status, 404);

  const { rows } = await pool.query('SELECT active, octet_length(content) AS n FROM documents WHERE id = $1', [id]);
  assert.strictEqual(rows[0].active, false);
  assert.strictEqual(Number(rows[0].n), PDF.length, 'a soft delete must not discard the file');
});

test('a malformed id is rejected rather than treated as a miss', async () => {
  await seed();
  const cookie = await login('admintest');
  for (const bad of ['abc', '-1', '0']) {
    assert.strictEqual((await fetch(`${baseUrl}/api/documents/${bad}/file`, { headers: { Cookie: cookie } })).status,
      400, `id=${bad} should 400`);
  }
});

test('metadata can be edited without disturbing the stored file', async () => {
  await seed();
  const lead = await login('admintest');
  const { id } = await (await upload(lead, PDF)).json();
  const res = await fetch(`${baseUrl}/api/documents/${id}`, {
    method: 'PATCH', headers: { Cookie: lead, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'RUTA Request (2026)', category: 'Leave & Absence' }),
  });
  assert.strictEqual(res.status, 200);
  const doc = await res.json();
  assert.strictEqual(doc.title, 'RUTA Request (2026)');
  assert.strictEqual(doc.category, 'Leave & Absence');

  const file = await fetch(`${baseUrl}/api/documents/${id}/file`, { headers: { Cookie: lead } });
  assert.strictEqual(Buffer.from(await file.arrayBuffer()).equals(PDF), true);
});
