'use strict';
// Where the tool pages send a member who taps "back".
//
// All five back controls pointed at "/", which applyDeepLink treats as the
// member view — so a leader three pages deep in the tools kept getting dumped
// on My Tasks. These pin the contract: back returns you to the tab you left.
//
// Static-content assertions on purpose: the pages are static files and the
// newsletter shell is a template literal, so the contract lives in the bytes
// this repo ships, not in anything a server computes.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('build and roster send a leader back to the Squadron tab, not My Tasks', () => {
  for (const p of ['public/build.html', 'public/roster.html']) {
    const html = read(p);
    assert.match(html, /class="back-link" href="\/\?view=leadership"/,
      `${p}: the back link must carry ?view=leadership`);
  }
});

test('records defaults to the Squadron tab and honours where you actually came from', () => {
  const html = read('public/records.html');
  assert.match(html, /class="back-link" href="\/\?view=leadership"/,
    'default destination is the leadership view');
  assert.match(html, /searchParams\.get\(\s*'from'\s*\)/,
    'a ?from= param must be read, so a supervisor who came from My Shop returns there');
});

test('index sends its origin along when navigating to records', () => {
  const html = read('public/index.html');
  assert.match(html, /'\/records\?from=supervisor'/,
    'the My Shop tools button must say it came from the supervisor view');
  assert.match(html, /'\/records\?from=leadership'/,
    'the leadership tools card must say it came from the leadership view');
});

test('export sends the leader back to the Squadron tab', () => {
  assert.match(read('public/export.html'), /href="\/\?view=leadership"/);
});

test('the newsletter back button lands on the Squadron tab', () => {
  // A source assertion: the shell is a template literal in render.js, and the
  // deck must stay src/href-free (see test/newsletter-http.test.js), so the
  // destination lives in a button onclick.
  assert.match(read('newsletter/render.js'), /location\.href='\/\?view=leadership'/);
});
