/**
 * Sicherung mit einem großen Einzelwert (z. B. Logo als Data-URL in core.settings, ~77 KB):
 * Das Lesen darf danach nicht an der nächsten Tabelle hängen bleiben (Rückstau im COPY-Strom).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url.split('/').pop() ?? '')) throw new Error('TEST_DATABASE_URL fehlt oder enthält nicht "test".');
process.env.DATABASE_URL = url;
process.env.PORTAL_MODULES = 'beispiel';
process.env.BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sicherung-gross-test-'));

const { sql } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { activeModules } = await import('../src/modules.js');
const { sichern } = await import('../src/backup.js');

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
});
// hängt eine Sicherung, darf das Beenden nicht ewig auf ihre Verbindung warten
after(async () => { await sql.end({ timeout: 2 }); });

test('Sicherung liest nach einem großen Einzelwert weiter', { timeout: 60_000 }, async () => {
  for (const kb of [17, 40, 77, 150, 400]) {
    await sql`insert into core.settings (key, value) values ('org.logo', to_jsonb(repeat('x', ${kb * 1000})))
              on conflict (key) do update set value = excluded.value`;
    const gelesen: string[] = [];
    const inhalt = await Promise.race([
      sichern({ von: 'test', mitAenderungsbelegen: false, fortschritt: (f) => { if (gelesen.at(-1) !== f.tabelle) gelesen.push(f.tabelle); } }),
      new Promise<never>((_ok, fehler) => setTimeout(() => fehler(new Error(`Sicherung hängt bei ${gelesen.at(-1)} (Logo ${kb} KB)`)), 8000)),
    ]);
    assert.ok(inhalt.daten['core.settings'].length > kb * 1000);
    assert.ok(inhalt.manifest.tabellen.some((t) => t.name === 'core.users'), 'Tabellen nach core.settings wurden gelesen');
  }
});
