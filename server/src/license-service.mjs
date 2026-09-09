import { createOfflineLicenseSignerFromEnv } from "./offline-license.mjs";
import { hashLicenseKey } from "./licenses.mjs";
import { compareAppVersions } from "./public-license.mjs";

function domainError(statusCode, errorCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.errorCode = errorCode;
  return error;
}

function normalizeServerTime(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw domainError(500, "SERVER_ERROR", "Server clock is invalid");
  }
  return date;
}

function publicResponse(
  context,
  device,
  { offlineSigner = null, issueOffline = false, serverTime = new Date() } = {},
) {
  const now = normalizeServerTime(serverTime);
  const response = {
    status: device.status,
    serverTime: now.toISOString(),
    application: {
      id: context.application.id,
      appCode: context.application.appCode,
      currentVersion: context.application.currentVersion,
      minimumVersion: context.application.minimumVersion,
      offlineGraceSeconds: context.application.offlineGraceSeconds,
    },
    license: {
      id: context.license.licenseId,
      type: context.license.licenseType,
      expiresAt: context.license.expiresAt,
      maxDevices: context.license.maxDevices,
    },
    device: {
      id: device.id,
      deviceId: device.deviceId,
      status: device.status,
      activatedAt: device.activatedAt,
      lastSeenAt: device.lastSeenAt,
    },
  };

  if (
    issueOffline &&
    offlineSigner &&
    Number.isInteger(context.application.offlineGraceSeconds) &&
    context.application.offlineGraceSeconds > 0
  ) {
    const entitlement = offlineSigner.issue({
      licenseId: context.license.licenseId,
      applicationId: context.application.id,
      appCode: context.application.appCode,
      deviceId: device.deviceId,
      licenseExpiresAt: context.license.expiresAt,
      offlineGraceSeconds: context.application.offlineGraceSeconds,
      issuedAt: now,
    });
    response.offline = {
      token: entitlement.token,
      algorithm: entitlement.algorithm,
      keyId: entitlement.keyId,
      issuedAt: entitlement.issuedAt,
      offlineValidUntil: entitlement.offlineValidUntil,
    };
  }

  return response;
}

export class PublicLicenseService {
  constructor({
    licenseRepository,
    deviceRepository,
    offlineSigner = undefined,
    clock = () => new Date(),
  }) {
    this.licenseRepository = licenseRepository;
    this.deviceRepository = deviceRepository;
    this.offlineSigner =
      offlineSigner === undefined ? createOfflineLicenseSignerFromEnv() : offlineSigner;
    this.clock = clock;
  }

  response(context, device, { issueOffline = false } = {}) {
    return publicResponse(context, device, {
      offlineSigner: this.offlineSigner,
      issueOffline,
      serverTime: this.clock(),
    });
  }

  async resolve(input, { checkVersion = true } = {}) {
    const keyHash = hashLicenseKey(input.licenseKey);
    if (!keyHash) throw domainError(404, "INVALID_LICENSE", "License is invalid");
    const context = await this.licenseRepository.resolveLicense({
      appCode: input.appCode,
      keyHash,
    });

    if (checkVersion && context.application.minimumVersion) {
      const comparison = compareAppVersions(input.appVersion, context.application.minimumVersion);
      if (comparison === null) {
        throw domainError(500, "SERVER_ERROR", "Application version policy is invalid");
      }
      if (comparison < 0) {
        throw domainError(426, "UPDATE_REQUIRED", "Application update is required");
      }
    }
    return context;
  }

  async activate(input, requestContext = {}) {
    const context = await this.resolve(input);
    const result = await this.deviceRepository.activateDevice({
      licenseId: context.license.licenseId,
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      os: input.os,
      appVersion: input.appVersion,
      requestId: requestContext.requestId,
      ipAddress: requestContext.ipAddress,
    });
    if (!result) throw domainError(404, "INVALID_LICENSE", "License is invalid");
    return this.response(context, result.device, { issueOffline: true });
  }

  async validate(input) {
    const context = await this.resolve(input);
    const device = await this.deviceRepository.validateDevice({
      licenseId: context.license.licenseId,
      deviceId: input.deviceId,
      touch: false,
    });
    if (!device) throw domainError(404, "INVALID_LICENSE", "License is invalid");
    return this.response(context, device, { issueOffline: true });
  }

  async heartbeat(input) {
    const context = await this.resolve(input);
    const device = await this.deviceRepository.validateDevice({
      licenseId: context.license.licenseId,
      deviceId: input.deviceId,
      touch: true,
      deviceName: input.deviceName,
      os: input.os,
      appVersion: input.appVersion,
    });
    if (!device) throw domainError(404, "INVALID_LICENSE", "License is invalid");
    return this.response(context, device, { issueOffline: true });
  }

  async deactivate(input, requestContext = {}) {
    const context = await this.resolve(input, { checkVersion: false });
    const device = await this.deviceRepository.deactivateDevice({
      licenseId: context.license.licenseId,
      deviceId: input.deviceId,
      requestId: requestContext.requestId,
      ipAddress: requestContext.ipAddress,
    });
    if (!device) throw domainError(404, "INVALID_LICENSE", "License is invalid");
    return this.response(context, device, { issueOffline: false });
  }
}
