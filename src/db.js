// Database access. Uses Node's built-in SQLite (node:sqlite, Node >= 22.13) so the
// server has no native dependencies. All queries are parameterised.
// To move to Postgres later, keep this module's small surface (all/get/run/tx)
// and swap the implementation; schema.sql and migrations/ are written to port cleanly.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Applies migrations/NNN_name.sql files in order, once each. Version 1 is schema.sql. */
function migrate(raw) {
  raw.exec(readFileSync(join(here, '..', 'migrations', 'schema.sql'), 'utf8'));
  const applied = new Set(raw.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  if (!applied.has(1)) raw.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(new Date().toISOString());
  const dir = join(here, '..', 'migrations');
  const files = readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  for (const f of files) {
    const version = Number(f.slice(0, 3));
    if (applied.has(version)) continue;
    // Table rebuilds need foreign keys off (they can't be toggled inside a transaction).
    raw.exec('PRAGMA foreign_keys = OFF;');
    raw.exec('BEGIN');
    try {
      raw.exec(readFileSync(join(dir, f), 'utf8'));
      raw.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
      raw.exec('COMMIT');
    } catch (err) {
      raw.exec('ROLLBACK');
      throw new Error(`Migration ${f} failed: ${err.message}`);
    } finally {
      raw.exec('PRAGMA foreign_keys = ON;');
    }
  }
}

export function openDatabase(file = process.env.DATABASE_FILE || join(here, '..', 'data', 'agroinspo.db')) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') raw.exec('PRAGMA journal_mode = WAL;');
  migrate(raw);

  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };

  const db = {
    raw,
    all: (sql, ...params) => stmt(sql).all(...params),
    get: (sql, ...params) => stmt(sql).get(...params),
    run: (sql, ...params) => stmt(sql).run(...params),
    /** Run fn inside a transaction; rolls back on throw. Nested calls join the outer one. */
    tx(fn) {
      if (db._inTx) return fn();
      raw.exec('BEGIN');
      db._inTx = true;
      try {
        const out = fn();
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      } finally {
        db._inTx = false;
      }
    },
    close: () => raw.close()
  };
  return db;
}
