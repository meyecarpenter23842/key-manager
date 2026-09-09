import { hashLicenseKey } from "./licenses.mjs";
import { compareAppVersions } from "./public-license.mjs";

function domainError(statusCode, errorCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.errorCode = errorCode;
  return error;
}

function publicResponse(context, device) {
  return {
    status: device.status,
    serverTime: new Date().toISOString(),
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
}

export class PublicLicenseService {
  constructor({ licenseRepository, deviceRepository }) {
    this.licenseRepository = licenseRepository;
    this.deviceRepository = deviceRepository;
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
    return publicResponse(context, result.device);
  }

  async validate(input) {
    const context = await this.resolve(input);
    const device = await this.deviceRepository.validateDevice({
      licenseId: context.license.licenseId,
      deviceId: input.deviceId,
      touch: false,
    });
    if (!device) throw domainError(404, "INVALID_LICENSE", "License is invalid");
    return publicResponse(context, device);
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
    return publicResponse(context, device);
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
    return publicResponse(context, device);
  }
}
