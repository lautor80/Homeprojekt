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

test('Auftragsliste: Dateien auf eine Zeile ziehen legt beim Auftrag der Zeile ab (gleiche Ablage wie im Auftrag)', () => {
  const liste = lesen('modules/transport/web/AuftraegeListe.tsx');
  assert.ok(liste.includes('<div data-auftrag={row.original.auftragsnr}>'), 'Zeile der Liste trägt die Auftragsnummer');
  assert.ok(liste.includes("{...(r.isPos ? { 'data-auftrag': r.auftragsnr } : {})}"), 'Auftragszeile im Baum');
  assert.ok(liste.includes("closest?.('[role=\"row\"]')") && liste.includes("querySelector<HTMLElement>('[data-auftrag]')"), 'Zeile unter dem Mauszeiger');
  assert.ok(liste.includes("const zeilenAblage = can('transport.auftraege:edit') ?"), 'nur mit Recht zum Ändern');
  assert.ok(liste.includes('return auftragAblegen(z.nr, f, { paperless: d.paperless, ordner: !!o });'), 'gemeinsame Ablage');
  assert.ok(liste.includes('style={{ height: rahmen.hoehe }} {...zeilenAblage}>'), 'an beiden Tabellen (Liste und Baum)');
  const dok = lesen('modules/transport/web/AuftragDokumente.tsx');
  assert.ok(dok.includes('auftragAblegen(nr, eingang, { paperless: !!d?.paperless, ordner,'), 'Objektseite nutzt dieselbe Funktion');
  const gemeinsam = lesen('modules/transport/web/auftragAblage.ts');
  assert.ok(gemeinsam.includes('`${T}/auftraege/${nr}/dokumente`') && gemeinsam.includes('emlLesen('), 'Paperless-Ablage und E-Mails zerlegen');
});
