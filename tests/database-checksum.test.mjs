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

  it('accepts the legacy Windows checksum already stored for 0001_extensions.sql', () => {
    const migration =
      '-- 0001_extensions.sql\n' +
      '-- Server/database-only migration. Never expose database credentials to Vite/Tauri clients.\n' +
      '\n' +
      'CREATE EXTENSION IF NOT EXISTS pgcrypto;\n';

    expect(migrationChecksum(migration)).toBe(
      '2d1f9b05953f3af5f3c0bea4f51b9cb9f54ae94d4a49f04dda87256764819cb7',
    );
    expect(acceptedMigrationChecksums(migration).has(
      'e15097e676a94d441f8aaf83cbb13e9c0d699628e95cc5527488569604a1ccfb',
    )).toBe(true);
  });

  it('still rejects real SQL content changes', () => {
    const original = acceptedMigrationChecksums(lf);
    const changed = migrationChecksum('-- 0001_extensions.sql\nSELECT 2;\n');
    expect(original.has(changed)).toBe(false);
  });
});
