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
            ) AS unread_count
       FROM channels c
       LEFT JOIN channel_reads cr ON cr.channel_id = c.id AND cr.member_id = $2
       LEFT JOIN messages m ON m.channel_id = c.id
      WHERE c.id = ANY($1)
      GROUP BY c.id`, [ids, member.id]);
  const byId = new Map(unread.map(r => [r.channel_id, Number(r.unread_count)]));
  return mine.map(c => ({ ...c, unread_count: byId.get(c.id) || 0 }));
}

module.exports = { DDL, ensureTable, canAccess, visibleChannels, canPost, canHide, getChannel, listChannels };
