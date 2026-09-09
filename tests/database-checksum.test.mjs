import { describe, expect, it } from 'vitest';

import {
  acceptedMigrationChecksums,
  migrationChecksum,
  normalizeSqlForChecksum,
} from '../scripts/database-checksum.mjs';

describe('migration checksum portability', () => {
  const lf = '-- 0001_extensions.sql\nSELECT 1;\n';
  const crlf = lf.replaceAll('\n', '\r\n');

  it('normalizes Windows and Unix line endings to the same canonical checksum', () => {
    expect(normalizeSqlForChecksum(crlf)).toBe(lf);
    expect(migrationChecksum(crlf)).toBe(migrationChecksum(lf));
  });

  it('accepts both canonical LF and legacy CRLF hashes for an unchanged migration', () => {
    const candidates = acceptedMigrationChecksums(lf);
    expect(candidates.size).toBe(2);
    expect(candidates).toEqual(acceptedMigrationChecksums(crlf));
  });

  it('still rejects real SQL content changes', () => {
    const original = acceptedMigrationChecksums(lf);
    const changed = migrationChecksum('-- 0001_extensions.sql\nSELECT 2;\n');
    expect(original.has(changed)).toBe(false);
  });
});
