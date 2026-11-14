/**
 * Platzverwaltung → Termin: Stornieren/Löschen/Absagen muss die Sicherheitsabfrage erreichen und im Hochformat sichtbar
 * sein – ohne Datenbank, nur Quelltext.
 *  - Der Termin-Dialog blendet sich während der Abfrage aus (open={!weg}); UI5 meldet das als „close“. Das darf den Termin
 *    nicht schließen, sonst verschwindet die Abfrage mit und es wird nie storniert.
 *  - Der Knopf steht im Inhalt, nicht in der Fußleiste (dort fällt er im Hochformat neben drei Knöpfen weg).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const quelle = readFileSync(fileURLToPath(new URL('../../modules/tco/web/platz/Platzverwaltung.tsx', import.meta.url)), 'utf8');
const dialog = quelle.slice(quelle.indexOf('function TerminDialog('));

test('Termin-Dialog: Ausblenden für die Abfrage schließt den Termin nicht', () => {
  assert.match(dialog, /<Dialog open=\{!weg\}[^>]*onClose=\{\(\) => \{ if \(!wegRef\.current\) onClose\(\); \}\}/);
  assert.match(dialog, /const setWeg = \(v: boolean\) => \{ wegRef\.current = v; setWegRoh\(v\); \};/);
  assert.match(dialog, /<ConfirmDialog open=\{weg\}[^]*?onConfirm=\{entfernen\}/);
});

test('Termin-Dialog: Stornieren steht im Inhalt, nicht in der Fußleiste', () => {
  assert.ok(!/startContent=/.test(dialog.slice(0, dialog.indexOf('<ConfirmDialog'))), 'kein Knopf links in der Fußleiste');
  assert.match(dialog, /<Button design="Negative" icon="delete" disabled=\{busy\} onClick=\{\(\) => setWeg\(true\)\}>/);
});
