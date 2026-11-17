/**
 * Euroflex Objektseite Auftrag: „Kontakt bearbeiten“ bietet Kunde, Unternehmer (je Fahrt) und Rechnungsempfänger an
 * und wählt den gewählten Kontakt im Dialog vor. Quelltextprüfung ohne Browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const quelle = (datei: string) => readFileSync(new URL(`../../modules/transport/web/${datei}`, import.meta.url), 'utf8');

test('Menü „Kontakt bearbeiten“ mit allen Beteiligten', () => {
  const src = quelle('AuftragDetail.tsx');
  assert.match(src, /\['Kunde', a\.kunde\]/);
  assert.match(src, /'Unternehmer', a\.unternehmer\]/);
  assert.match(src, /fahrten\.map\(\(f, i\)[^\n]*`Unternehmer \(Fahrt \$\{i \+ 2\}\)`, f\.unternehmer\]/);
  assert.match(src, /\['Abw\. Rechnungsempfänger', a\.rechnungsempfaenger\]/);
  assert.match(src, /<MenuButton text="Kontakt bearbeiten"[\s\S]*?onClick: \(\) => kontaktBearbeiten\(r\.key\)/);
  assert.match(src, /<KontaktDialog modus=\{kontakt\} auswahl=\{kontakteAuftrag\} start=\{kontaktStart\}/);
});

test('KontaktDialog wählt den übergebenen Kontakt vor', () => {
  const src = quelle('KontaktDialog.tsx');
  assert.match(src, /setNr\(start && auswahl\.some\(\(x\) => x\.key === start\) \? start : auswahl\[0\]\.key\)/);
  assert.match(src, /\}, \[modus, start\]\);/);
});
