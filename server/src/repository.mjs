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

function domainError(statusCode, errorCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.errorCode = errorCode;
  return error;
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

async function insertLicenseEvent(
  client,
  { licenseId, eventType, oldValue = null, newValue = null, actorAdminId, metadata = {} },
) {
  await client.query(
    `INSERT INTO license_events (
       license_id, event_type, old_value, new_value, actor_type, actor_admin_id, metadata
     ) VALUES ($1, $2, $3::jsonb, $4::jsonb, 'ADMIN', $5, $6::jsonb)`,
    [
      licenseId,
      eventType,
      oldValue === null ? null : JSON.stringify(oldValue),
      newValue === null ? null : JSON.stringify(newValue),
      actorAdminId,
      JSON.stringify(metadata),
    ],
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
  icon_data_url AS "iconDataUrl",
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

const EFFECTIVE_LICENSE_STATUS = `(CASE
  WHEN l.status = 'ACTIVE' AND l.license_type = 'SUBSCRIPTION' AND l.expires_at <= now()
    THEN 'EXPIRED'::license_status
  ELSE l.status
END)`;

const LICENSE_SELECT = `
  l.id,
  l.application_id AS "applicationId",
  l.customer_id AS "customerId",
  l.license_key_preview AS "licenseKeyPreview",
  l.license_type AS "licenseType",
  l.expires_at AS "expiresAt",
  l.max_devices AS "maxDevices",
  ${EFFECTIVE_LICENSE_STATUS} AS status,
  l.note,
  l.created_at AS "createdAt",
  l.updated_at AS "updatedAt",
  a.name AS "applicationName",
  a.app_code AS "appCode",
  a.icon_data_url AS "applicationIconDataUrl",
  c.name AS "customerName",
  c.phone AS "customerPhone",
  c.email AS "customerEmail",
  c.company AS "customerCompany",
  (SELECT count(*)::int FROM devices d WHERE d.license_id = l.id) AS "deviceCount",
  (SELECT count(*)::int FROM devices d WHERE d.license_id = l.id AND d.status = 'ACTIVE') AS "activeDeviceCount"`;

async function selectLicense(client, id, { forUpdate = false } = {}) {
  const result = await client.query(
    `SELECT ${LICENSE_SELECT}
     FROM licenses l
     JOIN applications a ON a.id = l.application_id
     LEFT JOIN customers c ON c.id = l.customer_id
     WHERE l.id = $1
     ${forUpdate ? "FOR UPDATE OF l" : ""}`,
    [id],
  );
  return result.rows[0] ?? null;
}

function eventLicenseValue(license) {
  return {
    licenseType: license.licenseType,
    expiresAt: license.expiresAt,
    maxDevices: license.maxDevices,
    status: license.status,
  };
}

function effectiveStatus(row, now = new Date()) {
  if (
    row.status === "ACTIVE" &&
    row.license_type === "SUBSCRIPTION" &&
    row.expires_at !== null &&
    new Date(row.expires_at) <= now
  ) {
    return "EXPIRED";
  }
  return row.status;
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
      await insertAudit(client, {
        actorAdminId,
        action: "ADMIN_CREATED",
        targetType: "ADMIN",
        targetId: admin.id,
        ipAddress,
        requestId,
        metadata: { role },
      });
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
      if (existingOwner.rowCount > 0) throw new Error("an active OWNER already exists");
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
           offline_grace_seconds, default_device_limit, default_duration_days, allow_lifetime,
           icon_data_url
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
          data.iconDataUrl,
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
             allow_lifetime = $11,
             icon_data_url = $12
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
          next.iconDataUrl,
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

  async listLicenses({
    q = "",
    qHash = null,
    applicationId = null,
    customerId = null,
    licenseType = null,
    status = null,
    expiringWithinDays = null,
    limit = 25,
    offset = 0,
  }) {
    const where = `
      WHERE (
        $1 = ''
        OR strpos(lower(l.license_key_preview), lower($1)) > 0
        OR strpos(lower(a.name), lower($1)) > 0
        OR strpos(lower(a.app_code), lower($1)) > 0
        OR strpos(lower(coalesce(c.name, '')), lower($1)) > 0
        OR strpos(lower(coalesce(c.phone, '')), lower($1)) > 0
        OR strpos(lower(coalesce(c.email, '')), lower($1)) > 0
        OR strpos(lower(coalesce(c.company, '')), lower($1)) > 0
        OR ($7::bytea IS NOT NULL AND l.license_key_hash = $7::bytea)
      )
      AND ($2::uuid IS NULL OR l.application_id = $2::uuid)
      AND ($3::uuid IS NULL OR l.customer_id = $3::uuid)
      AND ($4::text IS NULL OR l.license_type::text = $4)
      AND ($5::text IS NULL OR ${EFFECTIVE_LICENSE_STATUS}::text = $5)
      AND (
        $6::int IS NULL
        OR (
          l.status = 'ACTIVE'
          AND l.license_type = 'SUBSCRIPTION'
          AND l.expires_at > now()
          AND l.expires_at <= now() + ($6::int * interval '1 day')
        )
      )`;
    const params = [
      q,
      applicationId,
      customerId,
      licenseType,
      status,
      expiringWithinDays,
      qHash,
    ];
    const from = `FROM licenses l
      JOIN applications a ON a.id = l.application_id
      LEFT JOIN customers c ON c.id = l.customer_id`;
    const [countResult, rowsResult] = await Promise.all([
      this.pool.query(`SELECT count(*)::int AS total ${from} ${where}`, params),
      this.pool.query(
        `SELECT ${LICENSE_SELECT}
         ${from}
         ${where}
         ORDER BY l.updated_at DESC, l.created_at DESC
         LIMIT $8 OFFSET $9`,
        [...params, limit, offset],
      ),
    ]);
    return { items: rowsResult.rows, total: countResult.rows[0].total, limit, offset };
  }

  async getLicenseById(id) {
    return selectLicense(this.pool, id);
  }

  async getLicenseDetail(id) {
    const license = await this.getLicenseById(id);
    if (!license) return null;
    const [deviceResult, eventResult] = await Promise.all([
      this.pool.query(
        `SELECT
           id,
           device_id AS "deviceId",
           device_name AS "deviceName",
           os,
           app_version AS "appVersion",
           status,
           activated_at AS "activatedAt",
           last_seen_at AS "lastSeenAt",
           revoked_at AS "revokedAt"
         FROM devices
         WHERE license_id = $1
         ORDER BY activated_at DESC`,
        [id],
      ),
      this.pool.query(
        `SELECT
           e.id,
           e.event_type AS "eventType",
           e.old_value AS "oldValue",
           e.new_value AS "newValue",
           e.actor_type AS "actorType",
           e.actor_admin_id AS "actorAdminId",
           a.email AS "actorEmail",
           e.metadata,
           e.created_at AS "createdAt"
         FROM license_events e
         LEFT JOIN admins a ON a.id = e.actor_admin_id
         WHERE e.license_id = $1
         ORDER BY e.created_at DESC`,
        [id],
      ),
    ]);
    return {
      ...license,
      application: {
        id: license.applicationId,
        name: license.applicationName,
        appCode: license.appCode,
        iconDataUrl: license.applicationIconDataUrl,
      },
      customer: license.customerId
        ? {
            id: license.customerId,
            name: license.customerName,
            phone: license.customerPhone,
            email: license.customerEmail,
            company: license.customerCompany,
          }
        : null,
      devices: deviceResult.rows,
      events: eventResult.rows,
    };
  }

  async getLicenseKeyMaterial(id) {
    const result = await this.pool.query(
      `SELECT
         license_key_hash AS "licenseKeyHash",
         license_key_ciphertext AS "licenseKeyCiphertext"
       FROM licenses
       WHERE id = $1
       LIMIT 1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async recordLicenseKeyReveal({ id, actorAdminId, requestId, ipAddress }) {
    await insertAudit(this.pool, {
      actorAdminId,
      action: "LICENSE_KEY_REVEALED",
      targetType: "LICENSE",
      targetId: id,
      ipAddress,
      requestId,
      metadata: {},
    });
  }

  async createLicense({
    data,
    keyHash,
    keyPreview,
    keyCiphertext,
    actorAdminId,
    requestId,
    ipAddress,
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const appResult = await client.query(
        `SELECT id, app_code, status, default_device_limit, default_duration_days, allow_lifetime
         FROM applications
         WHERE id = $1
         FOR SHARE`,
        [data.applicationId],
      );
      if (appResult.rowCount === 0) {
        throw domainError(404, "APPLICATION_NOT_FOUND", "Application not found");
      }
      const application = appResult.rows[0];
      if (application.status !== "ACTIVE") {
        throw domainError(409, "APPLICATION_DISABLED", "Cannot create a license for a disabled application");
      }
      if (data.licenseType === "LIFETIME" && !application.allow_lifetime) {
        throw domainError(409, "LIFETIME_NOT_ALLOWED", "Lifetime licenses are disabled for this application");
      }
      if (data.customerId !== null) {
        const customerResult = await client.query("SELECT id FROM customers WHERE id = $1", [
          data.customerId,
        ]);
        if (customerResult.rowCount === 0) {
          throw domainError(404, "CUSTOMER_NOT_FOUND", "Customer not found");
        }
      }

      const maxDevices = data.maxDevices ?? application.default_device_limit;
      const durationDays =
        data.licenseType === "SUBSCRIPTION"
          ? (data.durationDays ?? application.default_duration_days)
          : null;
      const insertResult = await client.query(
        `INSERT INTO licenses (
           application_id, customer_id, license_key_hash, license_key_preview,
           license_key_ciphertext, license_type, expires_at, max_devices, status, note,
           created_by_admin_id
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           CASE WHEN $6::license_type = 'SUBSCRIPTION'
             THEN now() + make_interval(days => $7::int)
             ELSE NULL
           END,
           $8, 'ACTIVE', $9, $10
         )
         RETURNING id`,
        [
          data.applicationId,
          data.customerId,
          keyHash,
          keyPreview,
          keyCiphertext,
          data.licenseType,
          durationDays,
          maxDevices,
          data.note,
          actorAdminId,
        ],
      );
      const license = await selectLicense(client, insertResult.rows[0].id);
      await insertLicenseEvent(client, {
        licenseId: license.id,
        eventType: "LICENSE_CREATED",
        newValue: eventLicenseValue(license),
        actorAdminId,
        metadata: {
          applicationId: data.applicationId,
          customerId: data.customerId,
        },
      });
      await insertAudit(client, {
        actorAdminId,
        action: "LICENSE_CREATED",
        targetType: "LICENSE",
        targetId: license.id,
        ipAddress,
        requestId,
        metadata: {
          applicationId: data.applicationId,
          customerId: data.customerId,
          licenseType: license.licenseType,
          maxDevices: license.maxDevices,
        },
      });
      await client.query("COMMIT");
      return license;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async renewLicense({ id, renewal, actorAdminId, requestId, ipAddress }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const beforeResult = await client.query(
        `SELECT l.id, l.license_type, l.expires_at, l.status, a.allow_lifetime
         FROM licenses l
         JOIN applications a ON a.id = l.application_id
         WHERE l.id = $1
         FOR UPDATE OF l`,
        [id],
      );
      if (beforeResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return null;
      }
      const beforeRow = beforeResult.rows[0];
      const beforeStatus = effectiveStatus(beforeRow);
      if (beforeStatus === "ARCHIVED") {
        throw domainError(409, "LICENSE_ARCHIVED", "Archived licenses cannot be renewed");
      }

      const oldValue = {
        licenseType: beforeRow.license_type,
        expiresAt: beforeRow.expires_at,
        status: beforeStatus,
      };
      let eventType;
      let metadata;

      if (renewal.toLifetime) {
        if (beforeRow.license_type === "LIFETIME") {
          throw domainError(409, "ALREADY_LIFETIME", "License is already lifetime");
        }
        if (!beforeRow.allow_lifetime) {
          throw domainError(409, "LIFETIME_NOT_ALLOWED", "Lifetime licenses are disabled for this application");
        }
        await client.query(
          `UPDATE licenses
           SET license_type = 'LIFETIME',
               expires_at = NULL,
               status = CASE WHEN status = 'REVOKED' THEN 'REVOKED'::license_status ELSE 'ACTIVE'::license_status END
           WHERE id = $1`,
          [id],
        );
        eventType = "LICENSE_CHANGED_TO_LIFETIME";
        metadata = {};
      } else {
        if (beforeRow.license_type !== "SUBSCRIPTION") {
          throw domainError(409, "LIFETIME_CANNOT_RENEW", "Lifetime licenses do not have an expiry to renew");
        }
        await client.query(
          `UPDATE licenses
           SET expires_at = (CASE WHEN expires_at > now() THEN expires_at ELSE now() END)
             + make_interval(days => $2::int),
               status = CASE WHEN status = 'REVOKED' THEN 'REVOKED'::license_status ELSE 'ACTIVE'::license_status END
           WHERE id = $1`,
          [id, renewal.durationDays],
        );
        eventType = "LICENSE_RENEWED";
        metadata = { durationDays: renewal.durationDays };
      }

      const license = await selectLicense(client, id);
      await insertLicenseEvent(client, {
        licenseId: id,
        eventType,
        oldValue,
        newValue: eventLicenseValue(license),
        actorAdminId,
        metadata,
      });
      await insertAudit(client, {
        actorAdminId,
        action: eventType,
        targetType: "LICENSE",
        targetId: id,
        ipAddress,
        requestId,
        metadata,
      });
      await client.query("COMMIT");
      return license;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeLicense({ id, actorAdminId, requestId, ipAddress }) {
    return this.#changeLicenseStatus({
      id,
      action: "revoke",
      actorAdminId,
      requestId,
      ipAddress,
    });
  }

  async reactivateLicense({ id, actorAdminId, requestId, ipAddress }) {
    return this.#changeLicenseStatus({
      id,
      action: "reactivate",
      actorAdminId,
      requestId,
      ipAddress,
    });
  }

  async archiveLicense({ id, actorAdminId, requestId, ipAddress }) {
    return this.#changeLicenseStatus({
      id,
      action: "archive",
      actorAdminId,
      requestId,
      ipAddress,
    });
  }

  async #changeLicenseStatus({ id, action, actorAdminId, requestId, ipAddress }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const rowResult = await client.query(
        `SELECT id, license_type, expires_at, status
         FROM licenses
         WHERE id = $1
         FOR UPDATE`,
        [id],
      );
      if (rowResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return null;
      }
      const row = rowResult.rows[0];
      const oldStatus = effectiveStatus(row);
      let newStatus;
      let eventType;

      if (action === "revoke") {
        if (oldStatus === "ARCHIVED") {
          throw domainError(409, "LICENSE_ARCHIVED", "Archived licenses cannot be revoked");
        }
        if (oldStatus === "REVOKED") {
          const license = await selectLicense(client, id);
          await client.query("COMMIT");
          return license;
        }
        newStatus = "REVOKED";
        eventType = "LICENSE_REVOKED";
      } else if (action === "reactivate") {
        if (row.status !== "REVOKED") {
          throw domainError(409, "LICENSE_NOT_REVOKED", "Only revoked licenses can be reactivated");
        }
        newStatus =
          row.license_type === "SUBSCRIPTION" && new Date(row.expires_at) <= new Date()
            ? "EXPIRED"
            : "ACTIVE";
        eventType = "LICENSE_REACTIVATED";
      } else {
        if (oldStatus === "ARCHIVED") {
          const license = await selectLicense(client, id);
          await client.query("COMMIT");
          return license;
        }
        newStatus = "ARCHIVED";
        eventType = "LICENSE_ARCHIVED";
      }

      await client.query("UPDATE licenses SET status = $2 WHERE id = $1", [id, newStatus]);
      const license = await selectLicense(client, id);
      await insertLicenseEvent(client, {
        licenseId: id,
        eventType,
        oldValue: { status: oldStatus },
        newValue: { status: license.status },
        actorAdminId,
      });
      await insertAudit(client, {
        actorAdminId,
        action: eventType,
        targetType: "LICENSE",
        targetId: id,
        ipAddress,
        requestId,
      });
      await client.query("COMMIT");
      return license;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async updateLicenseDeviceLimit({ id, maxDevices, actorAdminId, requestId, ipAddress }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const licenseResult = await client.query(
        `SELECT id, max_devices, status
         FROM licenses
         WHERE id = $1
         FOR UPDATE`,
        [id],
      );
      if (licenseResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return null;
      }
      const row = licenseResult.rows[0];
      if (row.status === "ARCHIVED") {
        throw domainError(409, "LICENSE_ARCHIVED", "Archived licenses cannot change device limit");
      }
      const deviceCountResult = await client.query(
        `SELECT count(*)::int AS count
         FROM devices
         WHERE license_id = $1 AND status = 'ACTIVE'`,
        [id],
      );
      const activeDeviceCount = deviceCountResult.rows[0].count;
      if (maxDevices < activeDeviceCount) {
        throw domainError(
          409,
          "DEVICE_LIMIT_BELOW_ACTIVE_COUNT",
          "maxDevices cannot be lower than the active device count",
        );
      }
      if (row.max_devices === maxDevices) {
        const license = await selectLicense(client, id);
        await client.query("COMMIT");
        return license;
      }

      await client.query("UPDATE licenses SET max_devices = $2 WHERE id = $1", [id, maxDevices]);
      const license = await selectLicense(client, id);
      await insertLicenseEvent(client, {
        licenseId: id,
        eventType: "DEVICE_LIMIT_CHANGED",
        oldValue: { maxDevices: row.max_devices },
        newValue: { maxDevices: license.maxDevices },
        actorAdminId,
        metadata: { activeDeviceCount },
      });
      await insertAudit(client, {
        actorAdminId,
        action: "DEVICE_LIMIT_CHANGED",
        targetType: "LICENSE",
        targetId: id,
        ipAddress,
        requestId,
        metadata: { activeDeviceCount, oldMaxDevices: row.max_devices, maxDevices },
      });
      await client.query("COMMIT");
      return license;
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
           ${EFFECTIVE_LICENSE_STATUS} AS status,
           l.note,
           l.created_at AS "createdAt",
           l.updated_at AS "updatedAt",
           a.id AS "applicationId",
           a.name AS "applicationName",
           a.app_code AS "appCode",
           a.icon_data_url AS "applicationIconDataUrl",
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
          iconDataUrl: license.applicationIconDataUrl,
        },
        deviceCount: license.deviceCount,
        activeDeviceCount: license.activeDeviceCount,
        devices: devicesByLicense.get(license.id) ?? [],
        renewalHistory: renewalsByLicense.get(license.id) ?? [],
      })),
    };
  }
}
