export const leaseStoreMethods = {
  acquireLease(key, owner, ttlMs) {
    const now = this.now();
    const expiresAt = new Date(new Date(now).getTime() + ttlMs).toISOString();

    this.db.exec('BEGIN IMMEDIATE');

    try {
      const insert = this.db
        .prepare(
          `INSERT OR IGNORE INTO leases (key, owner, expires_at, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(key, owner, expiresAt, now);

      if (insert.changes > 0) {
        this.db.exec('COMMIT');
        return true;
      }

      const update = this.db
        .prepare(
          `UPDATE leases
           SET owner = ?, expires_at = ?, updated_at = ?
           WHERE key = ? AND expires_at <= ?`,
        )
        .run(owner, expiresAt, now, key, now);

      this.db.exec('COMMIT');
      return update.changes > 0;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  },

  renewLease(key, owner, ttlMs) {
    const now = this.now();
    const expiresAt = new Date(new Date(now).getTime() + ttlMs).toISOString();
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
    const result = this.db.prepare('DELETE FROM leases WHERE key = ? AND owner = ?').run(key, owner);
    return result.changes > 0;
  },
};
