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

async function insertAudit(
  client,
  {
    actorAdminId,
    action,
    targetType,
    targetId,
    ipAddress,
    requestId,
    metadata = {},
  },
) {
  await client.query(
    `INSERT INTO audit_logs (
       actor_type, actor_admin_id, action, target_type, target_id, ip_address, request_id, metadata
     ) VALUES ('ADMIN', $1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [actorAdminId, action, targetType, targetId, ipAddress, requestId, JSON.stringify(metadata)],
  );
}

const APPLICATION_SELECT = `
  id,
  name,
  app_code AS "appCode",
  description,
  current_version AS "currentVersion",
  minimum_version AS "minimumVersion",
  status,
  offline_grace_seconds AS "offlineGraceSeconds",
  default_device_limit AS "defaultDeviceLimit",
  default_duration_days AS "defaultDurationDays",
  allow_lifetime AS "allowLifetime",
  created_at AS "createdAt",
  updated_at AS "updatedAt"`;

const CUSTOMER_SELECT = `
  id,
  name,
  phone,
  email,
  company,
  note,
  created_at AS "createdAt",
  updated_at AS "updatedAt"`;

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

  async listApplications({ q = "", status = null, limit = 25, offset = 0 }) {
    const where = `
      WHERE ($1 = '' OR strpos(lower(name), lower($1)) > 0 OR strpos(lower(app_code), lower($1)) > 0)
        AND ($2::text IS NULL OR status::text = $2)`;
    const [countResult, rowsResult] = await Promise.all([
      this.pool.query(`SELECT count(*)::int AS total FROM applications ${where}`, [q, status]),
      this.pool.query(
        `SELECT ${APPLICATION_SELECT}
         FROM applications
         ${where}
         ORDER BY updated_at DESC, name ASC
         LIMIT $3 OFFSET $4`,
        [q, status, limit, offset],
      ),
    ]);
    return { items: rowsResult.rows, total: countResult.rows[0].total, limit, offset };
  }

  async getApplicationById(id) {
    const result = await this.pool.query(
      `SELECT ${APPLICATION_SELECT} FROM applications WHERE id = $1 LIMIT 1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async createApplication({ data, actorAdminId, requestId, ipAddress }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `INSERT INTO applications (
           name, app_code, description, current_version, minimum_version, status,
           offline_grace_seconds, default_device_limit, default_duration_days, allow_lifetime
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${APPLICATION_SELECT}`,
        [
          data.name,
          data.appCode,
          data.description,
          data.currentVersion,
          data.minimumVersion,
          data.status,
          data.offlineGraceSeconds,
          data.defaultDeviceLimit,
          data.defaultDurationDays,
          data.allowLifetime,
        ],
      );
      const application = result.rows[0];
      await insertAudit(client, {
        actorAdminId,
        action: "APPLICATION_CREATED",
        targetType: "APPLICATION",
        targetId: application.id,
        ipAddress,
        requestId,
        metadata: { appCode: application.appCode },
      });
      await client.query("COMMIT");
      return application;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async updateApplication({ id, patch, actorAdminId, requestId, ipAddress }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const beforeResult = await client.query(
        `SELECT ${APPLICATION_SELECT} FROM applications WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (beforeResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return null;
      }
      const before = beforeResult.rows[0];
      const next = { ...before, ...patch };
      const result = await client.query(
        `UPDATE applications
         SET name = $2,
             app_code = $3,
             description = $4,
             current_version = $5,
             minimum_version = $6,
             status = $7,
             offline_grace_seconds = $8,
             default_device_limit = $9,
             default_duration_days = $10,
             allow_lifetime = $11
         WHERE id = $1
         RETURNING ${APPLICATION_SELECT}`,
        [
          id,
          next.name,
          next.appCode,
          next.description,
          next.currentVersion,
          next.minimumVersion,
          next.status,
          next.offlineGraceSeconds,
          next.defaultDeviceLimit,
          next.defaultDurationDays,
          next.allowLifetime,
        ],
      );
      const application = result.rows[0];
      const changedFields = Object.keys(patch).filter((key) => before[key] !== application[key]);
      await insertAudit(client, {
        actorAdminId,
        action:
          before.status !== application.status
            ? "APPLICATION_STATUS_CHANGED"
            : "APPLICATION_UPDATED",
        targetType: "APPLICATION",
        targetId: application.id,
        ipAddress,
        requestId,
        metadata: { changedFields },
      });
      await client.query("COMMIT");
      return application;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listCustomers({ q = "", limit = 25, offset = 0 }) {
    const where = `
      WHERE ($1 = ''
        OR strpos(lower(name), lower($1)) > 0
        OR strpos(lower(coalesce(phone, '')), lower($1)) > 0
        OR strpos(lower(coalesce(email, '')), lower($1)) > 0
        OR strpos(lower(coalesce(company, '')), lower($1)) > 0)`;
    const [countResult, rowsResult] = await Promise.all([
      this.pool.query(`SELECT count(*)::int AS total FROM customers ${where}`, [q]),
      this.pool.query(
        `SELECT ${CUSTOMER_SELECT}
         FROM customers
         ${where}
         ORDER BY updated_at DESC, name ASC
         LIMIT $2 OFFSET $3`,
        [q, limit, offset],
      ),
    ]);
    return { items: rowsResult.rows, total: countResult.rows[0].total, limit, offset };
  }

  async getCustomerById(id) {
    const result = await this.pool.query(
      `SELECT ${CUSTOMER_SELECT} FROM customers WHERE id = $1 LIMIT 1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async createCustomer({ data, actorAdminId, requestId, ipAddress }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `INSERT INTO customers (name, phone, email, company, note)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${CUSTOMER_SELECT}`,
        [data.name, data.phone, data.email, data.company, data.note],
      );
      const customer = result.rows[0];
      await insertAudit(client, {
        actorAdminId,
        action: "CUSTOMER_CREATED",
        targetType: "CUSTOMER",
        targetId: customer.id,
        ipAddress,
        requestId,
      });
      await client.query("COMMIT");
      return customer;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async updateCustomer({ id, patch, actorAdminId, requestId, ipAddress }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const beforeResult = await client.query(
        `SELECT ${CUSTOMER_SELECT} FROM customers WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (beforeResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return null;
      }
      const before = beforeResult.rows[0];
      const next = { ...before, ...patch };
      const result = await client.query(
        `UPDATE customers
         SET name = $2, phone = $3, email = $4, company = $5, note = $6
         WHERE id = $1
         RETURNING ${CUSTOMER_SELECT}`,
        [id, next.name, next.phone, next.email, next.company, next.note],
      );
      const customer = result.rows[0];
      const changedFields = Object.keys(patch).filter((key) => before[key] !== customer[key]);
      await insertAudit(client, {
        actorAdminId,
        action: "CUSTOMER_UPDATED",
        targetType: "CUSTOMER",
        targetId: customer.id,
        ipAddress,
        requestId,
        metadata: { changedFields },
      });
      await client.query("COMMIT");
      return customer;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getCustomerDetail(id) {
    const customer = await this.getCustomerById(id);
    if (!customer) return null;

    const [licenseResult, deviceResult, renewalResult] = await Promise.all([
      this.pool.query(
        `SELECT
           l.id,
           l.license_key_preview AS "licenseKeyPreview",
           l.license_type AS "licenseType",
           l.expires_at AS "expiresAt",
           l.max_devices AS "maxDevices",
           l.status,
           l.note,
           l.created_at AS "createdAt",
           l.updated_at AS "updatedAt",
           a.id AS "applicationId",
           a.name AS "applicationName",
           a.app_code AS "appCode",
           count(d.id)::int AS "deviceCount",
           count(d.id) FILTER (WHERE d.status = 'ACTIVE')::int AS "activeDeviceCount"
         FROM licenses l
         JOIN applications a ON a.id = l.application_id
         LEFT JOIN devices d ON d.license_id = l.id
         WHERE l.customer_id = $1
         GROUP BY l.id, a.id
         ORDER BY l.created_at DESC`,
        [id],
      ),
      this.pool.query(
        `SELECT
           d.id,
           d.license_id AS "licenseId",
           d.device_id AS "deviceId",
           d.device_name AS "deviceName",
           d.os,
           d.app_version AS "appVersion",
           d.status,
           d.activated_at AS "activatedAt",
           d.last_seen_at AS "lastSeenAt",
           d.revoked_at AS "revokedAt"
         FROM devices d
         JOIN licenses l ON l.id = d.license_id
         WHERE l.customer_id = $1
         ORDER BY d.activated_at DESC`,
        [id],
      ),
      this.pool.query(
        `SELECT
           e.id,
           e.license_id AS "licenseId",
           e.event_type AS "eventType",
           e.old_value AS "oldValue",
           e.new_value AS "newValue",
           e.actor_type AS "actorType",
           e.actor_admin_id AS "actorAdminId",
           a.email AS "actorEmail",
           e.metadata,
           e.created_at AS "createdAt"
         FROM license_events e
         JOIN licenses l ON l.id = e.license_id
         LEFT JOIN admins a ON a.id = e.actor_admin_id
         WHERE l.customer_id = $1
           AND e.event_type IN ('LICENSE_RENEWED', 'LICENSE_CHANGED_TO_LIFETIME')
         ORDER BY e.created_at DESC`,
        [id],
      ),
    ]);

    const devicesByLicense = new Map();
    for (const device of deviceResult.rows) {
      const list = devicesByLicense.get(device.licenseId) ?? [];
      list.push(device);
      devicesByLicense.set(device.licenseId, list);
    }
    const renewalsByLicense = new Map();
    for (const event of renewalResult.rows) {
      const list = renewalsByLicense.get(event.licenseId) ?? [];
      list.push(event);
      renewalsByLicense.set(event.licenseId, list);
    }

    return {
      ...customer,
      licenses: licenseResult.rows.map((license) => ({
        id: license.id,
        licenseKeyPreview: license.licenseKeyPreview,
        licenseType: license.licenseType,
        expiresAt: license.expiresAt,
        maxDevices: license.maxDevices,
        status: license.status,
        note: license.note,
        createdAt: license.createdAt,
        updatedAt: license.updatedAt,
        application: {
          id: license.applicationId,
          name: license.applicationName,
          appCode: license.appCode,
        },
        deviceCount: license.deviceCount,
        activeDeviceCount: license.activeDeviceCount,
        devices: devicesByLicense.get(license.id) ?? [],
        renewalHistory: renewalsByLicense.get(license.id) ?? [],
      })),
    };
  }
}
