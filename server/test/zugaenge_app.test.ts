/**
 * Zugänge und Zuordnungen an einer Stelle (#232, N3) – ohne Datenbank, nur Quelltext:
 * eine App „Zugänge“ mit den Reitern Registrierungen (Mitglieder/Hallennutzer), Zuordnung und EP3-Abgleich;
 * die Platzverwaltung behält Plätze, Belegung, Training und Abos; alte Adressen führen in die neue App.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lies = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8');

test('Zugänge: eine App mit drei Reitern, jeder mit seinem bisherigen Recht', () => {
  const app = lies('modules/tco/web/platz/ZugaengeApp.tsx');
  const modul = lies('modules/tco/web/index.ts');
  assert.deepEqual([...app.matchAll(/\{ key: '([a-z0-9]+)', text: '([^']+)'/g)].map((m) => m[2]), ['Registrierungen', 'Zuordnung', 'EP3-Abgleich']);
  assert.match(app, /const mitglied = can\('tco\.registrierung:mitglied'\);/);
  assert.match(app, /const halle = can\('tco\.platz:admin'\);/);
  assert.match(app, /useFunktion\(\)\('tco\.platz\.ep3abgleich'\)/, 'EP3-Abgleich bleibt abschaltbar');
  assert.ok(modul.includes("{ text: 'Zugänge', icon: 'add-employee', path: '/tco/zugaenge', permission: 'tco.registrierung:mitglied|tco.platz:admin' }"), 'Menüeintrag unter Mitglieder');
  assert.ok(modul.includes("{ path: '/tco/zugaenge', component: ZugaengeApp, permission: 'tco.registrierung:mitglied|tco.platz:admin' }"));
  assert.ok(!/text: 'Registrierungen'/.test(modul), 'kein eigener Menüeintrag „Registrierungen“ mehr');
  assert.match(lies('modules/tco/server/index.ts'), /area: 'Mitglieder', app: 'Zugänge'/, 'Rollenpflege nennt die App wie das Menü');
});

test('Platzverwaltung ohne Benutzer und Zugänge; alte Adressen führen in die App „Zugänge“', () => {
  const pv = lies('modules/tco/web/platz/Platzverwaltung.tsx');
  assert.deepEqual([...pv.matchAll(/<Tab data-key="([a-z]+)"/g)].map((m) => m[1]), ['plaetze', 'belegung', 'feste', 'abos']);
  assert.match(pv, /if \(tab === 'benutzer' \|\| tab === 'zugaenge'\) return <Navigate to=\{`\/tco\/zugaenge\?tab=/);
  assert.ok(lies('modules/tco/web/index.ts').includes("{ path: '/tco/registrierungen', component: ZugaengeApp, permission: 'tco.registrierung:mitglied' }"), 'alte Adresse der Registrierungen bleibt gültig');
});
