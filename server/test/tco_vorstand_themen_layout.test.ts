/**
 * Themenparkplatz: Das Feld „Thema“ im Dialog nutzt die ganze Breite, die Übersicht hat deutlich höhere Zeilen
 * (Titel mit zwei Zeilen Beschreibung, Stand mit Sitzung bleiben lesbar).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lies = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8');
const quelle = lies('modules/tco/web/vorstand/Themen.tsx');

test('Feld „Thema“ über die gesamte Breite', () => {
  const feld = /<FieldBox label="Thema" required wide>\s*<Input([^>]*)>/.exec(quelle);
  assert.ok(feld, 'Feld „Thema“ gefunden');
  assert.match(feld![1], /style=\{\{\s*width:\s*'100%'\s*\}\}/);
});

test('Übersicht mit deutlich größerer Zeilenhöhe', () => {
  const h = /export const THEMEN_ZEILENHOEHE = (\d+);/.exec(quelle);
  assert.ok(h, 'Zeilenhöhe festgelegt');
  assert.ok(Number(h![1]) >= 80, 'mindestens 80 px statt der Standardhöhe');
  assert.match(quelle, /rowHeight=\{THEMEN_ZEILENHOEHE\}/);
});
