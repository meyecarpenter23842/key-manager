import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsDir = join(repoRoot, 'database', 'migrations');
const testsDir = join(repoRoot, 'database', 'tests');
const mode = process.argv[2] ?? 'migrate';

function fail(message) {
  console.error(`[database] ${message}`);
  process.exit(1);
}

function orderedSqlFiles(directory) {
  const files = readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));

  let previousVersion = -1;
  const seen = new Set();

  for (const file of files) {
    const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(file);
    if (!match) {
      fail(`invalid ordered SQL filename: ${file}`);
    }

    const version = Number(match[1]);
    if (seen.has(version) || version <= previousVersion) {
      fail(`migration/test versions must be unique and ascending: ${file}`);
    }

    seen.add(version);
    previousVersion = version;
  }

  return files;
}

function connectionArgs() {
  if (process.env.DATABASE_URL) {
    return ['--dbname', process.env.DATABASE_URL];
  }

  if (process.env.PGDATABASE) {
    return [];
  }

  fail('set DATABASE_URL or PostgreSQL PG* variables before running database commands');
}

function runPsql(args = [], input = undefined, capture = false) {
  const result = spawnSync(
    'psql',
    [...connectionArgs(), '-X', '-v', 'ON_ERROR_STOP=1', ...args],
    {
      input,
      encoding: 'utf8',
      stdio: capture ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'inherit', 'inherit'],
    },
  );

  if (result.error) {
    fail(`unable to run psql: ${result.error.message}`);
  }

  if (result.status !== 0) {
    if (capture) {
      if (result.stdout) process.stderr.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    fail(`psql exited with status ${result.status}`);
  }

  return capture ? (result.stdout ?? '').trim() : '';
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function checksum(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function checkOrder() {
  const migrations = orderedSqlFiles(migrationsDir);
  const tests = orderedSqlFiles(testsDir);

  if (migrations.length === 0) fail('no migrations found');
  if (tests.length === 0) fail('no database tests found');

  console.log(`[database] ordered migrations: ${migrations.join(', ')}`);
  console.log(`[database] ordered tests: ${tests.join(', ')}`);
  return { migrations, tests };
}

function migrate(migrations) {
  runPsql(
    [],
    `CREATE TABLE IF NOT EXISTS public.schema_migrations (\n` +
      `  version integer PRIMARY KEY,\n` +
      `  name text NOT NULL UNIQUE,\n` +
      `  checksum text NOT NULL,\n` +
      `  applied_at timestamptz NOT NULL DEFAULT now()\n` +
      `);\n`,
  );

  const rows = runPsql(
    ['-At', '-F', '\t', '-c', 'SELECT version, name, checksum FROM public.schema_migrations ORDER BY version;'],
    undefined,
    true,
  );

  const applied = new Map();
  if (rows) {
    for (const row of rows.split('\n')) {
      const [versionText, name, storedChecksum] = row.split('\t');
      applied.set(Number(versionText), { name, checksum: storedChecksum });
    }
  }

  for (const file of migrations) {
    const version = Number(file.slice(0, 4));
    const content = readFileSync(join(migrationsDir, file), 'utf8');
    const currentChecksum = checksum(content);
    const existing = applied.get(version);

    if (existing) {
      if (existing.name !== file || existing.checksum !== currentChecksum) {
        fail(`applied migration ${version} does not match ${file}; never edit an applied migration`);
      }
      console.log(`[database] already applied ${file}`);
      continue;
    }

    console.log(`[database] applying ${file}`);
    runPsql(
      [],
      `BEGIN;\n` +
        `SET LOCAL search_path TO public;\n` +
        `${content}\n` +
        `INSERT INTO public.schema_migrations (version, name, checksum) VALUES (` +
        `${version}, ${sqlLiteral(file)}, ${sqlLiteral(currentChecksum)});\n` +
        `COMMIT;\n`,
    );
  }
}

function test(tests) {
  for (const file of tests) {
    console.log(`[database] testing ${file}`);
    runPsql(['-f', join(testsDir, file)]);
  }
}

const { migrations, tests } = checkOrder();

switch (mode) {
  case 'check':
    break;
  case 'migrate':
    migrate(migrations);
    break;
  case 'test':
    migrate(migrations);
    test(tests);
    break;
  default:
    fail(`unknown mode ${mode}; expected check, migrate, or test`);
}
