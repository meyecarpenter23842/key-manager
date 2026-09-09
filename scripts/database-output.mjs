export function parseMigrationRows(output) {
  if (!output) return [];

  return output.split(/\r?\n/).filter(Boolean).map((row) => {
    const [versionText, name, checksum, ...extra] = row.split('\t');
    const version = Number(versionText);

    if (
      extra.length > 0 ||
      !Number.isInteger(version) ||
      !name ||
      !checksum
    ) {
      throw new Error(`invalid schema_migrations row: ${JSON.stringify(row)}`);
    }

    return { version, name, checksum };
  });
}
