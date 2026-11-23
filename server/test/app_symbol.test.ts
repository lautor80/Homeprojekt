/**
 * Symbol auf dem Home-Bildschirm: ohne Modul-Symbol bleibt die Glocke (Weiterleitung auf web/public/push-*.png),
 * index.html und App-Beschreibung verweisen auf /api/push/symbol-*.png. Ohne Datenbank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const wurzel = join(import.meta.dirname, '..', '..');

test('index.html: Apple-Symbol kommt vom Portal (Modul-Symbol oder Glocke)', () => {
  assert.match(readFileSync(join(wurzel, 'web/index.html'), 'utf8'), /rel="apple-touch-icon" href="\/api\/push\/symbol-180\.png"/);
});

test('TC Oberthal: Wappen in allen drei Größen vorhanden und quadratisch', () => {
  for (const g of [180, 192, 512]) {
    const datei = join(wurzel, `modules/tco/server/assets/app-${g}.png`);
    assert.ok(existsSync(datei), datei);
    const b = readFileSync(datei);
    assert.equal(b.readUInt32BE(16), g); assert.equal(b.readUInt32BE(20), g);
  }
  assert.match(readFileSync(join(wurzel, 'modules/tco/server/index.ts'), 'utf8'), /appSymbol: \(groesse\) => asset\(`app-\$\{groesse\}\.png`\)/);
});

test('Ersatz: Glocke bleibt für Portale ohne Modul-Symbol', () => {
  for (const g of [180, 192, 512]) assert.ok(existsSync(join(wurzel, `web/public/push-${g}.png`)));
  assert.match(readFileSync(join(wurzel, 'server/src/routes/push.ts'), 'utf8'), /reply\.redirect\(`\/push-\$\{groesse\}\.png`\)/);
});
