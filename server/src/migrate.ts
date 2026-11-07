import fs from 'node:fs/promises';
import path from 'node:path';
import { sql } from './db.js';
import { APP_ROOT } from './config.js';
import type { ServerModule } from './module.js';

async function sqlFiles(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    return [];
  }
}

/**
 * Spielt alle noch nicht ausgeführten Migrationen ein:
 * erst der Kern, dann die aktiven Module. Alles läuft in einer Transaktion
 * (Fehler = nichts wird eingespielt). Ein Advisory-Lock verhindert parallele Ausführung.
 */
export async function migrate(modules: ServerModule[], log: (m: string) => void): Promise<void> {
  const sources: { scope: string; dir: string }[] = [
    { scope: 'core', dir: path.join(APP_ROOT, 'server', 'migrations') },
    ...modules.filter((m) => m.migrationsDir).map((m) => ({ scope: m.id, dir: m.migrationsDir! })),
  ];

  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(4711)`;
    await tx`create table if not exists public.schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )`;
    const done = new Set((await tx`select id from public.schema_migrations`).map((r) => r.id as string));

    for (const { scope, dir } of sources) {
      for (const file of await sqlFiles(dir)) {
        const id = `${scope}/${file}`;
        if (done.has(id)) continue;
        const text = await fs.readFile(path.join(dir, file), 'utf8');
        log(`Migration ${id}`);
        await tx.savepoint(async (sp) => {
          await sp.unsafe(text);
          await sp`insert into public.schema_migrations (id) values (${id})`;
        });
      }
    }
  });
}
