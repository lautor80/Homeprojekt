/**
 * Vermietung – Mieteingang in den Folgemonat kopieren: Monat und Eingangsdatum +1 Monat, Aufteilung übernommen,
 * bei abweichendem Betrag bleibt die Kaltmiete gleich. Ohne Datenbank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aufteilungFesteMiete, datumFolgemonat, folgemonatVorlage, naechsterMonat } from '../../modules/miete/web/folgemonat.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('Folgemonat: Monatserster, Jahreswechsel', () => {
  assert.equal(naechsterMonat('2026-03-01'), '2026-04-01');
  assert.equal(naechsterMonat('2026-12-01'), '2027-01-01');
});

test('Eingangsdatum: gleicher Tag im Folgemonat, am Monatsende gekappt', () => {
  assert.equal(datumFolgemonat('2026-05-03'), '2026-06-03');
  assert.equal(datumFolgemonat('2026-01-31'), '2026-02-28');
  assert.equal(datumFolgemonat('2028-01-30'), '2028-02-29');
  assert.equal(datumFolgemonat('2026-12-15'), '2027-01-15');
});

test('Vorlage übernimmt Mietverhältnis, Betrag, Aufteilung und Notiz – ohne id', () => {
  const v = folgemonatVorlage({ vertrag_id: 7, datum: '2026-10-31', monat: '2026-10-01', betrag: 950, anteil_miete: 750, anteil_nk: 200, notiz: 'Dauerauftrag' });
  assert.deepEqual(v, { vertrag_id: 7, monat: '2026-11-01', datum: '2026-11-30', betrag: 950, anteil_miete: 750, anteil_nk: 200, notiz: 'Dauerauftrag' });
  assert.ok(!('id' in v));
});

test('Abweichender Betrag: Kaltmiete bleibt gleich, Differenz geht in den Abschlag', () => {
  assert.deepEqual(aufteilungFesteMiete(980, 750), { miete: 750, nk: 230 });
  assert.deepEqual(aufteilungFesteMiete(900.1, 750), { miete: 750, nk: 150.1 });
  assert.deepEqual(aufteilungFesteMiete(750, 750), { miete: 750, nk: 0 });
});

test('Oberfläche: Kopierknopf je Zeile, Kopie ohne Soll-Vorbelegung', () => {
  const s = readFileSync(path.join(ROOT, 'modules/miete/web/Einnahmen.tsx'), 'utf8');
  assert.ok(s.includes('icon="copy" tooltip="In den Folgemonat kopieren"'));
  assert.ok(s.includes('oeffnen(folgemonatVorlage(x), true)'));
  assert.ok(s.includes('if (!z.id && !kopie && s)'), 'Soll überschreibt die Kopie nicht');
  assert.ok(s.includes('aufteilungFesteMiete(b, zahl(f.miete))'));
});
