function domainError(statusCode, errorCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.errorCode = errorCode;
  return error;
}

const DEVICE_SELECT = `
  d.id,
  d.license_id AS "licenseId",
  d.device_id AS "deviceId",
  d.device_name AS "deviceName",
  d.os,
  d.app_version AS "appVersion",
  d.status,
  d.activated_at AS "activatedAt",
  d.last_seen_at AS "lastSeenAt",
  d.revoked_at AS "revokedAt"`;

const DEVICE_RETURNING = `
  id,
  license_id AS "licenseId",
  device_id AS "deviceId",
  device_name AS "deviceName",
  os,
  app_version AS "appVersion",
  status,
  activated_at AS "activatedAt",
  last_seen_at AS "lastSeenAt",
  revoked_at AS "revokedAt"`;

async function insertDeviceEvent(
  client,
  {
    licenseId,
    deviceRowId,
    eventType,
    oldValue = null,
    newValue = null,
    actorType,
    actorAdminId = null,
    metadata = {},
  },
) {
  await client.query(
    `INSERT INTO license_events (
       license_id, device_id, event_type, old_value, new_value,
       actor_type, actor_admin_id, metadata
     ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::actor_type, $7, $8::jsonb)`,
    [
      licenseId,
      deviceRowId,
      eventType,
      oldValue === null ? null : JSON.stringify(oldValue),
      newValue === null ? null : JSON.stringify(newValue),
      actorType,
      actorAdminId,
      JSON.stringify(metadata),
    ],
  );
}

async function insertDeviceAudit(
  client,
  {
    actorType,
    actorAdminId = null,
    action,
    deviceRowId,
    ipAddress = null,
    requestId = null,
    metadata = {},
  },
) {
  await client.query(
    `INSERT INTO audit_logs (
       actor_type, actor_admin_id, action, target_type, target_id,
       ip_address, request_id, metadata
     ) VALUES ($1::actor_type, $2, $3, 'DEVICE', $4, $5, $6, $7::jsonb)`,
    [actorType, actorAdminId, action, deviceRowId, ipAddress, requestId, JSON.stringify(metadata)],
  );
}

function publicDeviceValue(device) {
  return {
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    os: device.os,
    appVersion: device.appVersion,
    status: device.status,
  };
}

function assertOperationalLicense(license) {
  if (license.status === "ARCHIVED") {
    throw domainError(404, "INVALID_LICENSE", "License is invalid");
  }
  if (license.status === "REVOKED") {
    throw domainError(403, "LICENSE_REVOKED", "License is revoked");
  }
  if (
    license.status === "EXPIRED" ||
    (license.license_type === "SUBSCRIPTION" &&
      license.expires_at !== null &&
      new Date(license.expires_at) <= new Date())
  ) {
    throw domainError(403, "LICENSE_EXPIRED", "License is expired");
  }
}

async function lockLicense(client, licenseId) {
  const result = await client.query(
    `SELECT id, license_type, expires_at, max_devices, status
     FROM licenses
     WHERE id = $1
     FOR UPDATE`,
    [licenseId],
  );
  return result.rows[0] ?? null;
}

async function activeDeviceCount(client, licenseId) {
  const result = await client.query(
    `SELECT count(*)::int AS count
     FROM devices
     WHERE license_id = $1 AND status = 'ACTIVE'`,
    [licenseId],
  );
  return result.rows[0].count;
}

export class DeviceRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async listDevices({ q = "", licenseId = null, status = null, limit = 25, offset = 0 }) {
    const where = `
      WHERE ($1 = ''
        OR strpos(lower(d.device_id), lower($1)) > 0
        OR strpos(lower(coalesce(d.device_name, '')), lower($1)) > 0
        OR strpos(lower(coalesce(d.os, '')), lower($1)) > 0
        OR strpos(lower(coalesce(d.app_version, '')), lower($1)) > 0
        OR strpos(lower(l.license_key_preview), lower($1)) > 0
        OR strpos(lower(a.name), lower($1)) > 0
        OR strpos(lower(a.app_code), lower($1)) > 0
        OR strpos(lower(coalesce(c.name, '')), lower($1)) > 0)
        AND ($2::uuid IS NULL OR d.license_id = $2::uuid)
        AND ($3::text IS NULL OR d.status::text = $3)`;
    const from = `FROM devices d
      JOIN licenses l ON l.id = d.license_id
      JOIN applications a ON a.id = l.application_id
      LEFT JOIN customers c ON c.id = l.customer_id`;
    const params = [q, licenseId, status];
    const [countResult, rowsResult] = await Promise.all([
      this.pool.query(`SELECT count(*)::int AS total ${from} ${where}`, params),
      this.pool.query(
        `SELECT ${DEVICE_SELECT},
           l.license_key_preview AS "licenseKeyPreview",
           a.id AS "applicationId",
           a.name AS "applicationName",
           a.app_code AS "appCode",
           c.id AS "customerId",
           c.name AS "customerName"
         ${from}
         ${where}
         ORDER BY d.last_seen_at DESC, d.activated_at DESC
         LIMIT $4 OFFSET $5`,
        [...params, limit, offset],
      ),
    ]);
    return { items: rowsResult.rows, total: countResult.rows[0].total, limit, offset };
  }

  async getDeviceById(id) {
    const result = await this.pool.query(`SELECT ${DEVICE_SELECT} FROM devices d WHERE d.id = $1`, [id]);
    return result.rows[0] ?? null;
  }

  async activateDevice({
    licenseId,
    deviceId,
    deviceName = null,
    os = null,
    appVersion = null,
    requestId = null,
    ipAddress = null,
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const license = await lockLicense(client, licenseId);
      if (!license) {
        await client.query("ROLLBACK");
        return null;
      }
      assertOperationalLicense(license);

      const existingResult = await client.query(
        `SELECT ${DEVICE_SELECT}
         FROM devices d
         WHERE d.license_id = $1 AND d.device_id = $2
         FOR UPDATE`,
        [licenseId, deviceId],
      );
      if (existingResult.rowCount > 0) {
        const existing = existingResult.rows[0];
        if (existing.status === "REVOKED") {
          throw domainError(409, "DEVICE_REVOKED", "Device is revoked");
        }
        if (existing.status === "ACTIVE") {
          const updateResult = await client.query(
            `UPDATE devices
             SET device_name = COALESCE($3, device_name),
                 os = COALESCE($4, os),
                 app_version = COALESCE($5, app_version),
                 last_seen_at = now()
             WHERE license_id = $1 AND device_id = $2
             RETURNING ${DEVICE_RETURNING}`,
            [licenseId, deviceId, deviceName, os, appVersion],
          );
          await client.query("COMMIT");
          return { device: updateResult.rows[0], created: false, reactivated: false };
        }

        const activeCount = await activeDeviceCount(client, licenseId);
        if (activeCount >= license.max_devices) {
          throw domainError(409, "DEVICE_LIMIT_REACHED", "Device limit reached");
        }
        const reactivateResult = await client.query(
          `UPDATE devices
           SET status = 'ACTIVE',
               device_name = COALESCE($3, device_name),
               os = COALESCE($4, os),
               app_version = COALESCE($5, app_version),
               activated_at = now(),
               last_seen_at = now(),
               revoked_at = NULL
           WHERE license_id = $1 AND device_id = $2
           RETURNING ${DEVICE_RETURNING}`,
          [licenseId, deviceId, deviceName, os, appVersion],
        );
        const device = reactivateResult.rows[0];
        await insertDeviceEvent(client, {
          licenseId,
          deviceRowId: device.id,
          eventType: "DEVICE_ACTIVATED",
          oldValue: publicDeviceValue(existing),
          newValue: publicDeviceValue(device),
          actorType: "LICENSE_API",
          metadata: {
            reactivated: true,
            activeDeviceCountBefore: activeCount,
            maxDevices: license.max_devices,
          },
        });
        await insertDeviceAudit(client, {
          actorType: "LICENSE_API",
          action: "DEVICE_ACTIVATED",
          deviceRowId: device.id,
          ipAddress,
          requestId,
          metadata: { licenseId, deviceId, reactivated: true },
        });
        await client.query("COMMIT");
        return { device, created: false, reactivated: true };
      }

      const activeCount = await activeDeviceCount(client, licenseId);
      if (activeCount >= license.max_devices) {
        throw domainError(409, "DEVICE_LIMIT_REACHED", "Device limit reached");
      }

      const insertResult = await client.query(
        `INSERT INTO devices (license_id, device_id, device_name, os, app_version)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${DEVICE_RETURNING}`,
        [licenseId, deviceId, deviceName, os, appVersion],
      );
      const device = insertResult.rows[0];
      await insertDeviceEvent(client, {
        licenseId,
        deviceRowId: device.id,
        eventType: "DEVICE_ACTIVATED",
        newValue: publicDeviceValue(device),
        actorType: "LICENSE_API",
        metadata: { activeDeviceCountBefore: activeCount, maxDevices: license.max_devices },
      });
      await insertDeviceAudit(client, {
        actorType: "LICENSE_API",
        action: "DEVICE_ACTIVATED",
        deviceRowId: device.id,
        ipAddress,
        requestId,
        metadata: { licenseId, deviceId },
      });
      await client.query("COMMIT");
      return { device, created: true, reactivated: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async validateDevice({
    licenseId,
    deviceId,
    touch = false,
    deviceName = null,
    os = null,
    appVersion = null,
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const license = await lockLicense(client, licenseId);
      if (!license) {
        await client.query("ROLLBACK");
        return null;
      }
      assertOperationalLicense(license);

      const deviceResult = await client.query(
        `SELECT ${DEVICE_SELECT}
         FROM devices d
         WHERE d.license_id = $1 AND d.device_id = $2
         FOR UPDATE`,
        [licenseId, deviceId],
      );
      if (deviceResult.rowCount === 0) {
        throw domainError(404, "INVALID_LICENSE", "License is not activated on this device");
      }
      const device = deviceResult.rows[0];
      if (device.status === "REVOKED") {
        throw domainError(409, "DEVICE_REVOKED", "Device is revoked");
      }
      if (device.status !== "ACTIVE") {
        throw domainError(404, "INVALID_LICENSE", "License is not active on this device");
      }

      if (!touch) {
        await client.query("COMMIT");
        return device;
      }

      const updateResult = await client.query(
        `UPDATE devices
         SET device_name = COALESCE($3, device_name),
             os = COALESCE($4, os),
             app_version = COALESCE($5, app_version),
             last_seen_at = now()
         WHERE license_id = $1 AND device_id = $2
         RETURNING ${DEVICE_RETURNING}`,
        [licenseId, deviceId, deviceName, os, appVersion],
      );
      await client.query("COMMIT");
      return updateResult.rows[0];
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deactivateDevice({ licenseId, deviceId, requestId = null, ipAddress = null }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const license = await lockLicense(client, licenseId);
      if (!license) {
        await client.query("ROLLBACK");
        return null;
      }
      assertOperationalLicense(license);

      const deviceResult = await client.query(
        `SELECT ${DEVICE_SELECT}
         FROM devices d
         WHERE d.license_id = $1 AND d.device_id = $2
         FOR UPDATE`,
        [licenseId, deviceId],
      );
      if (deviceResult.rowCount === 0) {
        throw domainError(404, "INVALID_LICENSE", "License is not activated on this device");
      }
      const before = deviceResult.rows[0];
      if (before.status === "REVOKED") {
        throw domainError(409, "DEVICE_REVOKED", "Device is revoked");
      }
      if (before.status === "INACTIVE") {
        await client.query("COMMIT");
        return before;
      }

      const updateResult = await client.query(
        `UPDATE devices
         SET status = 'INACTIVE', last_seen_at = now(), revoked_at = NULL
         WHERE id = $1
         RETURNING ${DEVICE_RETURNING}`,
        [before.id],
      );
      const device = updateResult.rows[0];
      await insertDeviceEvent(client, {
        licenseId,
        deviceRowId: device.id,
        eventType: "DEVICE_DEACTIVATED",
        oldValue: publicDeviceValue(before),
        newValue: publicDeviceValue(device),
        actorType: "LICENSE_API",
      });
      await insertDeviceAudit(client, {
        actorType: "LICENSE_API",
        action: "DEVICE_DEACTIVATED",
        deviceRowId: device.id,
        ipAddress,
        requestId,
        metadata: { licenseId, deviceId },
      });
      await client.query("COMMIT");
      return device;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeDevice({ id, actorAdminId, requestId = null, ipAddress = null }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const lookupResult = await client.query("SELECT license_id FROM devices WHERE id = $1", [id]);
      if (lookupResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return null;
      }
      const licenseId = lookupResult.rows[0].license_id;

      await client.query("SELECT id FROM licenses WHERE id = $1 FOR UPDATE", [licenseId]);
      const deviceResult = await client.query(
        `SELECT ${DEVICE_SELECT}
         FROM devices d
         WHERE d.id = $1 AND d.license_id = $2
         FOR UPDATE`,
        [id, licenseId],
      );
      if (deviceResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return null;
      }
      const before = deviceResult.rows[0];
      if (before.status === "REVOKED") {
        await client.query("COMMIT");
        return before;
      }

      const updateResult = await client.query(
        `UPDATE devices
         SET status = 'REVOKED', revoked_at = now()
         WHERE id = $1
         RETURNING ${DEVICE_RETURNING}`,
        [id],
      );
      const device = updateResult.rows[0];
      await insertDeviceEvent(client, {
        licenseId,
        deviceRowId: device.id,
        eventType: "DEVICE_REVOKED",
        oldValue: publicDeviceValue(before),
        newValue: publicDeviceValue(device),
        actorType: "ADMIN",
        actorAdminId,
      });
      await insertDeviceAudit(client, {
        actorType: "ADMIN",
        actorAdminId,
        action: "DEVICE_REVOKED",
        deviceRowId: device.id,
        ipAddress,
        requestId,
        metadata: { licenseId, deviceId: device.deviceId },
      });
      await client.query("COMMIT");
      return device;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
