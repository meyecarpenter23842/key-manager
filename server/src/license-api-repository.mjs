function domainError(statusCode, errorCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.errorCode = errorCode;
  return error;
}

export class LicenseApiRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async resolveLicense({ appCode, keyHash }) {
    const applicationResult = await this.pool.query(
      `SELECT id,
              app_code AS "appCode",
              status,
              current_version AS "currentVersion",
              minimum_version AS "minimumVersion",
              offline_grace_seconds AS "offlineGraceSeconds"
       FROM applications
       WHERE app_code = $1`,
      [appCode],
    );
    if (applicationResult.rowCount === 0) {
      throw domainError(403, "WRONG_APPLICATION", "License is not valid for this application");
    }
    const application = applicationResult.rows[0];
    if (application.status !== "ACTIVE") {
      throw domainError(403, "APPLICATION_DISABLED", "Application is disabled");
    }

    const licenseResult = await this.pool.query(
      `SELECT l.id AS "licenseId",
              l.application_id AS "applicationId",
              l.license_type AS "licenseType",
              l.expires_at AS "expiresAt",
              l.max_devices AS "maxDevices",
              l.status AS "licenseStatus"
       FROM licenses l
       WHERE l.license_key_hash = $1`,
      [keyHash],
    );
    if (licenseResult.rowCount === 0) {
      throw domainError(404, "INVALID_LICENSE", "License is invalid");
    }
    const license = licenseResult.rows[0];
    if (license.applicationId !== application.id) {
      throw domainError(403, "WRONG_APPLICATION", "License is not valid for this application");
    }
    if (license.licenseStatus === "ARCHIVED") {
      throw domainError(404, "INVALID_LICENSE", "License is invalid");
    }
    if (license.licenseStatus === "REVOKED") {
      throw domainError(403, "LICENSE_REVOKED", "License is revoked");
    }
    if (
      license.licenseStatus === "EXPIRED" ||
      (license.licenseType === "SUBSCRIPTION" &&
        license.expiresAt !== null &&
        new Date(license.expiresAt) <= new Date())
    ) {
      throw domainError(403, "LICENSE_EXPIRED", "License is expired");
    }

    return { application, license };
  }
}
