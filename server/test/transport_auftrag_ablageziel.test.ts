/**
 * Auftrag: Ablagefeld der Navigation und Strg+V legen beim geöffneten Auftrag ab – auch ohne Bearbeitungsmodus (Recht zum Ändern
 * genügt). Vorher fiel die Ablage ohne Bearbeitungsmodus auf die allgemeine Voreinstellung zurück (z. B. „Schriftverkehr“, ohne
 * Feld „Auftrag“) und das Dokument fehlte am Auftrag. Ohne Datenbank – nur Quelltext.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lesen = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

test('Auftrag: Ablageziel hängt am Recht zum Ändern, nicht am Bearbeitungsmodus', () => {
  const dok = lesen('modules/transport/web/AuftragDokumente.tsx');
  assert.ok(dok.includes('useAblageZiel(darfAblegen && (d?.paperless || ordner) ? ziel : null);'), 'Ziel für Navigation und Strg+V');
  assert.ok(dok.includes('{darfAblegen && (d.paperless || ordner) && <AblageFlaeche ziel={ziel}'), 'Ablagefeld im Auftrag');
  assert.ok(!dok.includes('useAblageZiel(edit &&'), 'nicht mehr an edit gebunden');
  assert.ok(lesen('modules/transport/web/AuftragDetail.tsx').includes('<AuftragDokumente nr={nr} edit={darfBearbeiten} ablegen={darfAendern} '), 'Recht transport.auftraege:edit');
});
