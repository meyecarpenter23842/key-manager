import { createHash } from 'node:crypto';

function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function normalizeSqlForChecksum(content) {
  return content.replace(/\r\n?/g, '\n');
}

export function migrationChecksum(content) {
  return sha256(normalizeSqlForChecksum(content));
}

export function acceptedMigrationChecksums(content) {
  const normalized = normalizeSqlForChecksum(content);
  return new Set([
    sha256(content),
    sha256(normalized),
    sha256(normalized.replaceAll('\n', '\r\n')),
  ]);
}
