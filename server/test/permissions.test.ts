/**
 * Berechtigungskatalog: Gliederung nach Menübereich → App, Voraussetzungen, Abgleich mit der Navigation.
 * Läuft ohne Datenbankzugriff (die Module werden nur geladen, nicht migriert).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url.split('/').pop() ?? '')) throw new Error('TEST_DATABASE_URL fehlt oder enthält nicht "test".');
process.env.DATABASE_URL = url;
process.env.PORTAL_MODULES = 'beispiel,transport,tco';

const { permissionCatalog } = await import('../src/modules.js');
const { gliedern } = await import('../src/permissions.js');
const { sql } = await import('../src/db.js');
const { APP_ROOT } = await import('../src/config.js');

test('gliedern: Bereich/App in Deklarationsreihenfolge, Anzeigen als automatische Voraussetzung', async () => {
  const areas = gliedern('Modul', [
    { id: 'm.a:display', text: 'A anzeigen', area: 'B1', app: 'A' },
    { id: 'm.a:edit', text: 'A ändern', area: 'B1', app: 'A' },
    { id: 'm.c:edit', text: 'C ändern', area: 'B2', app: 'C', requires: ['m.a:display'] },
    { id: 'm.x:run', text: 'ohne Angaben' },
  ]);
  assert.deepEqual(areas.map((a) => a.name), ['B1', 'B2', 'Modul']);
  assert.deepEqual(areas[0].apps[0].permissions.map((p) => p.requires), [[], ['m.a:display']]);
  assert.deepEqual(areas[1].apps[0].permissions[0].requires, ['m.a:display']);
  assert.equal(areas[2].apps[0].name, 'Allgemein');
  await sql.end();
});

test('Katalog: jede Berechtigung genau einmal, mit Bereich/App, Voraussetzungen existieren', () => {
  const katalog = permissionCatalog();
  const alle = katalog.flatMap((g) => g.areas.flatMap((a) => a.apps.flatMap((app) => app.permissions)));
  const ids = new Set(alle.map((p) => p.id));
  assert.equal(ids.size, alle.length, 'Berechtigung doppelt deklariert');
  assert.equal(alle.length, katalog.reduce((n, g) => n + g.permissions.length, 0), 'flache Liste und Gliederung weichen ab');

  for (const g of katalog) {
    for (const p of g.permissions) {
      if (g.module === 'beispiel') continue;
      assert.ok(p.area, `${p.id}: Menübereich fehlt`);
      assert.ok(p.app, `${p.id}: App fehlt`);
    }
  }
  for (const p of alle) for (const r of p.requires) assert.ok(ids.has(r), `${p.id} setzt unbekannte Berechtigung ${r} voraus`);

  // TC Oberthal: Bereiche in Menü-Reihenfolge
  const tco = katalog.find((g) => g.module === 'tco')!;
  assert.deepEqual(tco.areas.map((a) => a.name), ['Vereinsübersicht', 'Einstellungen', 'Mitglieder', 'Sport', 'Jugend', 'Tennishalle', 'Clubhaus', 'Instandhaltung', 'Finanzen', 'Dokumente', 'Datenschutz']);
  const bank = tco.areas.find((a) => a.name === 'Datenschutz')!.apps[0].permissions;
  assert.deepEqual(bank.find((p) => p.id === 'tco.bankdaten:edit')!.requires.sort(), ['tco.bankdaten:display', 'tco.mitglieder:edit']);
  const halle = tco.areas.find((a) => a.name === 'Tennishalle')!.apps.find((a) => a.name === 'Hallenabrechnung')!;
  assert.deepEqual(halle.permissions.find((p) => p.id === 'tco.halle:versand')!.requires, ['tco.halle:display']);
  const preise = tco.areas.find((a) => a.name === 'Tennishalle')!.apps.find((a) => a.name === 'Hallenpreise')!;
  assert.deepEqual(preise.permissions[0].requires, ['tco.halle:display']);
});

test('Navigation: jede Berechtigung aus Menü/Routen/Kacheln steht im Katalog', () => {
  const ids = new Set(permissionCatalog().flatMap((g) => g.permissions.map((p) => p.id)));
  for (const datei of ['web/src/pages/HomePage.tsx', 'web/src/shell/Shell.tsx', 'modules/tco/web/index.ts', 'modules/transport/web/index.ts', 'modules/beispiel/web/index.ts']) {
    const text = readFileSync(path.join(APP_ROOT, datei), 'utf8');
    for (const [, wert] of text.matchAll(/permission:\s*'([^']+)'/g)) for (const id of wert.split('|')) assert.ok(ids.has(id), `${datei}: ${id} fehlt im Katalog`);
  }
});
