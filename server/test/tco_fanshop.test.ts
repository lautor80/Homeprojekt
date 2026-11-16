/**
 * Fanshop: Kachel und Menüpunkt im Bereich „Allgemein“ führen zum Onlineshop des Vereins (externe Seite, neuer Tab);
 * alle Mitglieder sehen sie. Ohne Datenbank – nur Quelltext.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lesen = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const URL_SHOP = 'https://tc-oberthal.fan12.de/';

test('Fanshop: Menüpunkt mit externer Adresse, Kachel, Seite und Recht', () => {
  const web = lesen('modules/tco/web/index.ts');
  assert.ok(web.includes(`{ text: 'Fanshop', icon: 'retail-store', path: '/tco/fanshop', extern: '${URL_SHOP}', permission: 'tco.fanshop:display' }`), 'Menüpunkt');
  // lose App direkt unter „TC Oberthal“ (Bereich „Allgemein“): steht vor der ersten Gruppe „Mein Bereich“
  assert.ok(web.indexOf("text: 'Fanshop'") < web.indexOf("text: 'Mein Bereich'"), 'steht im allgemeinen Bereich');
  assert.ok(web.includes("{ path: '/tco/fanshop', component: Fanshop, permission: 'tco.fanshop:display' }"), 'Seite für den direkten Aufruf');
  assert.match(web, /\{ text: 'Fanshop', subtitle: '[^']+', icon: 'retail-store', path: '\/tco\/fanshop', permission: 'tco\.fanshop:display' \}/, 'Kachel mit Untertitel');
  assert.ok(lesen('modules/tco/web/Fanshop.tsx').includes(`FANSHOP_URL = '${URL_SHOP}'`), 'Seite nennt dieselbe Adresse');
  assert.ok(lesen('modules/tco/server/index.ts').includes("{ area: 'Allgemein', app: 'Fanshop', id: 'tco.fanshop:display'"), 'Recht in der Rollenpflege');
});

test('Fanshop: externe Ziele öffnen in einem neuen Tab – Startseite und Seitenleiste', () => {
  assert.match(lesen('web/src/platform.ts'), /extern\?: string;/);
  assert.ok(lesen('web/src/pages/HomePage.tsx').includes("e.extern ? window.open(e.extern, '_blank', 'noopener,noreferrer') : navigate(e.path!)"));
  const shell = lesen('web/src/shell/Shell.tsx');
  assert.ok(shell.includes("if (e.extern) window.open(e.extern, '_blank', 'noopener,noreferrer'); else if (e.path) gehe(e.path);"));
  assert.equal(shell.match(/oeffne\(e\)/g)?.length, 2, 'beide Stufen der Seitenleiste');
});

test('Fanshop: alle Mitglieder – Vorgabe der Rolle „Mitglied“ und jeder Rolle mit „Meine Daten“', () => {
  const sql = lesen('modules/tco/server/migrations/094_fanshop.sql');
  assert.match(sql, /'tco\.fanshop:display' from core\.roles where id = 'MITGLIED'/);
  assert.match(sql, /'tco\.fanshop:display' from core\.role_permissions where permission = 'tco\.meinedaten:edit'/);
  assert.match(sql, /on conflict do nothing/);
});
