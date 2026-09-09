import { describe, expect, it } from 'vitest';

import { parseMigrationRows } from '../scripts/database-output.mjs';

describe('psql migration row parsing', () => {
  const firstChecksum = 'e15097e676a94d441f8aaf83cbb13e9c0d699628e95cc5527488569604a1ccfb';
  const secondChecksum = 'c85837273e968ce980c5934d200da4f4182669a934145532eab96415e958be08';

  it('parses Windows CRLF output without retaining carriage returns', () => {
    const rows = parseMigrationRows(
      `1\t0001_extensions.sql\t${firstChecksum}\r\n` +
        `2\t0002_types.sql\t${secondChecksum}\r\n`,
    );

    expect(rows).toEqual([
      { version: 1, name: '0001_extensions.sql', checksum: firstChecksum },
      { version: 2, name: '0002_types.sql', checksum: secondChecksum },
    ]);
  });

  it('parses Unix LF output identically', () => {
    const rows = parseMigrationRows(
      `1\t0001_extensions.sql\t${firstChecksum}\n` +
        `2\t0002_types.sql\t${secondChecksum}\n`,
    );

    expect(rows[0].checksum).toBe(firstChecksum);
    expect(rows[1].checksum).toBe(secondChecksum);
  });

  it('rejects malformed migration metadata rows', () => {
    expect(() => parseMigrationRows('1\t0001_extensions.sql')).toThrow(
      'invalid schema_migrations row',
    );
  });
});
