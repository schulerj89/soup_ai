export const leaseStoreMethods = {
  acquireLease(key, owner, ttlMs) {
    const now = this.now();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    const insert = this.db
      .prepare(
        `INSERT OR IGNORE INTO leases (key, owner, expires_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(key, owner, expiresAt, now);

    if (insert.changes > 0) {
      return true;
    }

    const row = this.db.prepare('SELECT owner, expires_at FROM leases WHERE key = ?').get(key);

    if (row && row.expires_at <= now) {
      const update = this.db
        .prepare(
          `UPDATE leases
           SET owner = ?, expires_at = ?, updated_at = ?
           WHERE key = ? AND expires_at <= ?`,
        )
        .run(owner, expiresAt, now, key, now);

      return update.changes > 0;
    }

    return false;
  },

  renewLease(key, owner, ttlMs) {
    const now = this.now();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE leases
         SET expires_at = ?,
             updated_at = ?
         WHERE key = ? AND owner = ?`,
      )
      .run(expiresAt, now, key, owner);

    return result.changes > 0;
  },

  getLease(key) {
    return this.db.prepare('SELECT * FROM leases WHERE key = ?').get(key) ?? null;
  },

  releaseLease(key, owner) {
    this.db.prepare('DELETE FROM leases WHERE key = ? AND owner = ?').run(key, owner);
  },
};
