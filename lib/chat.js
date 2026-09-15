// lib/chat.js — squadron chat: channels, messages, read tracking.
//
// Channels are not user-creatable. They are seeded exactly once, in the boot
// that creates the table: two literal rows (squadron, leadership) plus one
// per row currently in `shops`. A shop added later needs a manual insert into
// channels, the same way everything else about a new shop is manual today.

const DDL = `
  CREATE TABLE IF NOT EXISTS channels (
    id       SERIAL PRIMARY KEY,
    type     VARCHAR(20) NOT NULL CHECK (type IN ('squadron','leadership','shop')),
    shop_id  INTEGER REFERENCES shops(id),
    name     VARCHAR(100) NOT NULL,
    CHECK ((type = 'shop') = (shop_id IS NOT NULL))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS channels_shop_key
    ON channels (shop_id) WHERE shop_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS channels_singleton_key
    ON channels (type) WHERE type IN ('squadron','leadership');

  CREATE TABLE IF NOT EXISTS messages (
    id           SERIAL PRIMARY KEY,
    channel_id   INTEGER NOT NULL REFERENCES channels(id),
    author_id    INTEGER NOT NULL REFERENCES members(id),
    body         VARCHAR(2000) NOT NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
    hidden_at    TIMESTAMP,
    hidden_by_id INTEGER REFERENCES members(id)
  );
  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (channel_id, created_at);

  CREATE TABLE IF NOT EXISTS channel_reads (
    member_id    INTEGER NOT NULL REFERENCES members(id),
    channel_id   INTEGER NOT NULL REFERENCES channels(id),
    last_read_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (member_id, channel_id)
  );
`;

// Seed-on-create. The boot block calls this on every start; it only does
// anything in the boot that finds `channels` absent. Guards on `channels`
// alone — messages/channel_reads never need seed rows, they start empty.
async function ensureTable(db) {
  const { rows } = await db.query(`SELECT to_regclass('public.channels') AS t`);
  if (rows[0].t) return { created: false };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(DDL);
    await client.query(
      `INSERT INTO channels (type, name) VALUES ('squadron', 'Squadron'), ('leadership', 'Leadership')`);
    const { rowCount } = await client.query(
      `INSERT INTO channels (type, shop_id, name) SELECT 'shop', id, name FROM shops`);
    await client.query('COMMIT');
    return { created: true, seeded: 2 + rowCount };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// True when `member` ({ id, role, shopId }) may read (and, in v1, post to)
// `channel`. Leadership's reach mirrors mayTouchEvent's precedent in
// server.js: it spans every shop, not just its own.
function canAccess(member, channel) {
  if (channel.type === 'squadron') return true;
  if (channel.type === 'leadership') return member.role === 'leadership';
  return channel.shop_id === member.shopId || member.role === 'leadership';
}

function visibleChannels(member, channels) {
  return channels.filter(c => canAccess(member, c));
}

// Identical to canAccess in v1 — no channel is read-only for anyone who can
// see it. A named export of its own so call sites read as intent, not as a
// coincidence, and so a future v1.1 (e.g. leadership can read but not post
// into a shop it doesn't own) has one place to diverge.
const canPost = canAccess;

function canHide(member) {
  return member.role === 'leadership';
}

async function getChannel(db, id) {
  const { rows } = await db.query(
    `SELECT id, type, shop_id, name FROM channels WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function listChannels(db, member) {
  const { rows: all } = await db.query(
    `SELECT id, type, shop_id, name FROM channels
      ORDER BY CASE type WHEN 'squadron' THEN 0 WHEN 'leadership' THEN 1 ELSE 2 END, name`);
  const mine = visibleChannels(member, all);
  if (!mine.length) return [];
  const ids = mine.map(c => c.id);
  const { rows: unread } = await db.query(
    `SELECT c.id AS channel_id,
            COUNT(m.id) FILTER (
              WHERE m.hidden_at IS NULL
                AND m.created_at > COALESCE(cr.last_read_at, TO_TIMESTAMP(0))
                AND m.author_id != $2
            ) AS unread_count
       FROM channels c
       LEFT JOIN channel_reads cr ON cr.channel_id = c.id AND cr.member_id = $2
       LEFT JOIN messages m ON m.channel_id = c.id
      WHERE c.id = ANY($1)
      GROUP BY c.id`, [ids, member.id]);
  const byId = new Map(unread.map(r => [r.channel_id, Number(r.unread_count)]));
  return mine.map(c => ({ ...c, unread_count: byId.get(c.id) || 0 }));
}

async function listMessages(db, channelId, { since, canSeeHidden } = {}) {
  const params = [channelId];
  let where = 'msg.channel_id = $1';
  if (!canSeeHidden) where += ' AND msg.hidden_at IS NULL';
  if (since) { params.push(since); where += ` AND msg.id > $${params.length}`; }
  // Newest 50 first, then re-sorted ascending — LIMIT has to apply to the
  // DESC ordering to get the newest window; the outer sort is what callers
  // and every test actually depend on (ascending by id).
  const { rows } = await db.query(
    `SELECT * FROM (
       SELECT msg.id, msg.channel_id, msg.author_id, msg.body, msg.created_at,
              msg.hidden_at, msg.hidden_by_id,
              m.rank AS author_rank, m.last_name AS author_name
         FROM messages msg
         JOIN members m ON m.id = msg.author_id
        WHERE ${where} ORDER BY msg.id DESC LIMIT 50
     ) t ORDER BY t.id ASC`, params);
  return rows.map(r => ({
    id: r.id, channel_id: r.channel_id, author_id: r.author_id,
    author_rank: r.author_rank, author_name: r.author_name,
    created_at: r.created_at,
    hidden: !!r.hidden_at,
    body: r.hidden_at ? null : r.body,
  }));
}

function validateBody(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: false, error: 'Message cannot be empty' };
  if (s.length > 2000) return { ok: false, error: 'Message must be 2000 characters or fewer' };
  return { ok: true, value: s };
}

async function postMessage(db, channelId, authorId, body) {
  const { rows } = await db.query(
    `INSERT INTO messages (channel_id, author_id, body)
     VALUES ($1, $2, $3) RETURNING id, channel_id, author_id, body, created_at`,
    [channelId, authorId, body]);
  return rows[0];
}

async function markRead(db, memberId, channelId) {
  await db.query(
    `INSERT INTO channel_reads (member_id, channel_id, last_read_at) VALUES ($1, $2, NOW())
     ON CONFLICT (member_id, channel_id) DO UPDATE SET last_read_at = NOW()`,
    [memberId, channelId]);
}

// Who should be pushed for a new message in `channel`, excluding its author.
// Mirrors canAccess's reach exactly: a shop channel's recipients are that
// shop's members plus every leadership member, same as who can read it.
async function recipientsFor(db, channel, excludeMemberId) {
  let sql, params;
  if (channel.type === 'squadron') {
    sql = `SELECT id FROM members WHERE active AND id != $1`;
    params = [excludeMemberId];
  } else if (channel.type === 'leadership') {
    sql = `SELECT id FROM members WHERE active AND role = 'leadership' AND id != $1`;
    params = [excludeMemberId];
  } else {
    sql = `SELECT id FROM members WHERE active AND (shop_id = $2 OR role = 'leadership') AND id != $1`;
    params = [excludeMemberId, channel.shop_id];
  }
  const { rows } = await db.query(sql, params);
  return rows.map(r => r.id);
}

// Idempotent: hiding an already-hidden message returns found:true,
// changed:false rather than erroring — two leadership members hiding the
// same message moments apart must both see success, not a race-lost 404/409.
async function hideMessage(db, messageId, hiddenById) {
  const { rows } = await db.query(
    `UPDATE messages SET hidden_at = NOW(), hidden_by_id = $2
      WHERE id = $1 AND hidden_at IS NULL
      RETURNING id`, [messageId, hiddenById]);
  if (rows.length) return { found: true, changed: true };
  const { rows: exists } = await db.query(`SELECT id FROM messages WHERE id = $1`, [messageId]);
  return { found: exists.length > 0, changed: false };
}

module.exports = {
  DDL, ensureTable, canAccess, visibleChannels, canPost, canHide,
  getChannel, listChannels, listMessages, validateBody, postMessage, markRead, recipientsFor, hideMessage,
};
