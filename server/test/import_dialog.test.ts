/**
 * Importe: gleiche Stelle, gleicher Knopf (#232, S4) – ohne Datenbank, nur Quelltext.
 * Laufende Importe stehen als Knopf „Importieren“ oben rechts (ImportKnopf) und zeigen denselben Ablauf
 * (ImportDialog bzw. ImportSchritte); kein Import ist mehr ein eigener Reiter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lies = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8');
const rahmen = lies('web/src/components/ImportDialog.tsx');

test('Gemeinsamer Rahmen: ein Knopf „Importieren“, vier Schritte, Kopfzeile „Importieren: …“', () => {
  assert.match(rahmen, /IMPORT_SCHRITTE = \['Quelle wählen', 'Prüfen', 'Übernehmen', 'Protokoll'\]/);
  assert.match(rahmen, /export function ImportKnopf[^]*?<Button icon="upload"[^>]*>Importieren<\/Button>/);
  assert.match(rahmen, /headerText=\{`Importieren: \$\{was\}`\}/);
});

test('Laufende Importe: Knopf oben rechts und gemeinsamer Ablauf – Jugendtraining, Spielerdaten, EP3, Bank', () => {
  const jt = lies('modules/tco/web/jt/Jugendtraining.tsx');
  const sd = lies('modules/tco/web/sport/Spielerdaten.tsx');
  const halle = lies('modules/tco/web/Hallenabrechnung.tsx');
  const fi = lies('modules/tco/web/fi/FiBelege.tsx');
  const bank = lies('modules/tco/web/fi/FiBankimport.tsx');
  // Knopf in den Aktionen der Seite
  assert.match(jt, /actions=\{importAn \? <ImportKnopf /, 'Jugendtraining');
  assert.match(sd, /actions=\{edit \? <ImportKnopf /, 'Spielerdaten');
  assert.match(halle, /<ImportKnopf tooltip="EP3-Buchungen über n8n importieren"/, 'Hallenabrechnung');
  assert.match(fi, /<ImportKnopf tooltip="Bankimport: /, 'FI Belege');
  // kein Import mehr als Reiter
  assert.ok(!/<Tab data-key="import"/.test(jt), 'Jugendtraining: kein Reiter „Import“');
  assert.ok(!/<Tab data-key="abgleich"/.test(sd), 'Spielerdaten: kein Reiter „Abgleich mit nuLiga“');
  // derselbe Ablauf
  assert.match(jt, /<ImportDialog open=\{impDlg\}/);
  assert.match(sd, /<ImportDialog open=\{edit && imp\}/);
  assert.match(halle, /headerText="Importieren: EP3-Buchungen \(n8n\)"[^]*?<ImportSchritte schritt=\{1\} \/>/);
  assert.match(bank, /'Importieren: Bankumsätze kontieren \(Bankimport\)'/);
  assert.match(bank, /\{!manuell && <ImportSchritte /);
  // gespeicherte Ansichten mit dem früheren Reiter öffnen den Dialog statt ins Leere zu zeigen
  assert.match(jt, /if \(t === 'import'\) setImpDlg\(true\); else setTab\(t\);/);
  assert.match(sd, /if \(t === 'abgleich'\) setImp\(true\); else setTab\(t as Reiter\);/);
});
