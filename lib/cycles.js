async function listCycles(db) {
  const { rows } = await db.query(`
    SELECT c.id, c.name, c.status, c.is_current,
           COUNT(t.id)::int AS task_count
    FROM uta_cycles c LEFT JOIN tasks t ON t.uta_cycle_id = c.id
    GROUP BY c.id ORDER BY c.created_at DESC, c.id DESC`);
  return rows;
}

async function createDraft(db, name) {
  const { rows } = await db.query(
    `INSERT INTO uta_cycles (name, status, is_current) VALUES ($1,'draft',false)
     RETURNING id, name, status, is_current`, [name]);
  return rows[0];
}

module.exports = { listCycles, createDraft };
