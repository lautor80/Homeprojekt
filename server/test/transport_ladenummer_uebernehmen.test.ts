/**
 * Auftrag – Knopf rechts neben der Ladenummer übernimmt die Auftragsnr. Kunde (ohne Text, Beschreibung im Tooltip).
 * Ohne Datenbank – nur Quelltext.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const web = readFileSync(path.join(ROOT, 'modules/transport/web/AuftragDetail.tsx'), 'utf8');

test('Ladenummer: Knopf ohne Text mit Tooltip direkt rechts neben dem Feld', () => {
  assert.ok(web.includes("const LADENUMMER_TOOLTIP = 'Ladenummer aus der Auftragsnr. Kunde übernehmen';"), 'Tooltip-Text');
  const feld = web.indexOf('<F label="Ladenummer">');
  assert.ok(feld > 0, 'Feld Ladenummer');
  const ende = web.indexOf('</F>', feld);
  const block = web.slice(feld, ende);
  const eingabe = block.indexOf("inp('ladenummer', 30)");
  const knopf = block.indexOf('<Button icon="copy" design="Transparent"');
  assert.ok(eingabe > 0 && knopf > eingabe, 'Knopf steht rechts (nach) dem Eingabefeld');
  const btn = block.slice(knopf, block.indexOf('/>', knopf));
  assert.ok(btn.includes('tooltip={LADENUMMER_TOOLTIP}') && btn.includes('accessibleName={LADENUMMER_TOOLTIP}'), 'Tooltip und Bedienhilfe');
  assert.ok(!/>\s*[A-Za-zÄÖÜäöü]/.test(btn.slice(btn.lastIndexOf('}') + 1)), 'kein Knopftext');
  assert.ok(btn.includes('disabled={!a.ordernummer?.trim()}'), 'ohne Auftragsnr. Kunde gesperrt');
  assert.ok(block.includes('mayEdit ?'), 'nur beim Bearbeiten');
});

test('Ladenummer: Übernahme setzt die Auftragsnr. Kunde auf höchstens 30 Zeichen', () => {
  const fn = web.slice(web.indexOf('const ladenummerUebernehmen'), web.indexOf('};', web.indexOf('const ladenummerUebernehmen')));
  assert.ok(fn.includes("setStop(i, 'ladenummer', nr.slice(0, 30))"), 'kürzt auf Feldlänge');
  assert.ok(fn.includes('toast('), 'Hinweis bei Kürzung');
});
