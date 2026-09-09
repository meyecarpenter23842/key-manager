import pg from "pg";

const { Pool } = pg;

export function createDatabasePool(databaseUrl) {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export class AdminRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async ping() {
    await this.pool.query("SELECT 1");
  }

  async findAdminByEmail(email) {
    const result = await this.pool.query(
      `SELECT id, email, password_hash, role, status
       FROM admins
       WHERE lower(email) = lower($1)
       LIMIT 1`,
      [email],
    );
    return result.rows[0] ?? null;
  }

  async findSessionByTokenHash(tokenHash) {
    const result = await this.pool.query(
      `SELECT
         s.id AS session_id,
         s.admin_id,
         s.expires_at,
         a.email,
         a.role,
         a.status
       FROM admin_sessions s
       JOIN admins a ON a.id = s.admin_id
       WHERE s.token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > now()
         AND a.status = 'ACTIVE'
       LIMIT 1`,
      [tokenHash],
    );
    return result.rows[0] ?? null;
  }

  async recordSuccessfulLogin({ adminId, tokenHash, expiresAt, ipAddress, userAgent, requestId }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sessionResult = await client.query(
        `INSERT INTO admin_sessions (admin_id, token_hash, expires_at, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [adminId, tokenHash, expiresAt, ipAddress, userAgent],
      );
      await client.query("UPDATE admins SET last_login_at = now() WHERE id = $1", [adminId]);
      await client.query(
        `INSERT INTO audit_logs (
           actor_type, actor_admin_id, action, target_type, target_id, ip_address, request_id, metadata
         ) VALUES ('ADMIN', $1, 'ADMIN_LOGIN_SUCCEEDED', 'ADMIN', $1, $2, $3, '{}'::jsonb)`,
        [adminId, ipAddress, requestId],
      );
      await client.query("COMMIT");
      return sessionResult.rows[0].id;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordFailedLogin({ email, ipAddress, requestId }) {
    await this.pool.query(
      `INSERT INTO audit_logs (
         actor_type, action, target_type, ip_address, request_id, metadata
       ) VALUES ('SYSTEM', 'ADMIN_LOGIN_FAILED', 'ADMIN_AUTH', $1, $2, jsonb_build_object('email', $3::text))`,
      [ipAddress, requestId, email],
    );
  }

  async revokeSession({ sessionId, adminId, requestId, ipAddress }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE admin_sessions
         SET revoked_at = COALESCE(revoked_at, now()), last_seen_at = now()
         WHERE id = $1 AND admin_id = $2`,
        [sessionId, adminId],
      );
      await client.query(
        `INSERT INTO audit_logs (
           actor_type, actor_admin_id, action, target_type, target_id, ip_address, request_id, metadata
         ) VALUES ('ADMIN', $1, 'ADMIN_LOGOUT', 'ADMIN_SESSION', $2, $3, $4, '{}'::jsonb)`,
        [adminId, sessionId, ipAddress, requestId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listAdmins() {
    const result = await this.pool.query(
      `SELECT id, email, role, status, last_login_at, created_at, updated_at
       FROM admins
       ORDER BY created_at ASC, email ASC`,
    );
    return result.rows;
  }

  async createAdmin({ email, passwordHash, role, actorAdminId, requestId, ipAddress }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `INSERT INTO admins (email, password_hash, role)
         VALUES ($1, $2, $3)
         RETURNING id, email, role, status, created_at, updated_at`,
        [email, passwordHash, role],
      );
      const admin = result.rows[0];
      await client.query(
        `INSERT INTO audit_logs (
           actor_type, actor_admin_id, action, target_type, target_id, ip_address, request_id, metadata
         ) VALUES ('ADMIN', $1, 'ADMIN_CREATED', 'ADMIN', $2, $3, $4, jsonb_build_object('role', $5::text))`,
        [actorAdminId, admin.id, ipAddress, requestId, role],
      );
      await client.query("COMMIT");
      return admin;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async bootstrapOwner({ email, passwordHash }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('key-manager-owner-bootstrap'))");
      const existingOwner = await client.query(
        "SELECT id FROM admins WHERE role = 'OWNER' AND status = 'ACTIVE' LIMIT 1 FOR UPDATE",
      );
      if (existingOwner.rowCount > 0) {
        throw new Error("an active OWNER already exists");
      }
      const result = await client.query(
        `INSERT INTO admins (email, password_hash, role)
         VALUES ($1, $2, 'OWNER')
         RETURNING id, email, role, status, created_at`,
        [email, passwordHash],
      );
      const owner = result.rows[0];
      await client.query(
        `INSERT INTO audit_logs (
           actor_type, action, target_type, target_id, metadata
         ) VALUES ('SYSTEM', 'OWNER_BOOTSTRAPPED', 'ADMIN', $1, '{}'::jsonb)`,
        [owner.id],
      );
      await client.query("COMMIT");
      return owner;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
