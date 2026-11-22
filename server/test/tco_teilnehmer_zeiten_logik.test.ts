/**
 * Trainingszeiten je Saison (Teilnehmer Jugendtraining): Saisonbestimmung, Texte, Prüfung der Eingaben – ohne Datenbank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saisonAm, saisonText, vorjahresSaison, zeitenPruefen, zeitenText } from '../../modules/tco/server/teilnehmer/zeiten.js';

test('Saison zum Datum: April–September Sommer, Oktober–März Winter (Jahr des Beginns)', () => {
  assert.deepEqual(saisonAm('2026-04-01'), { jahr: 2026, saison: 'SOMMER' });
  assert.deepEqual(saisonAm('2026-09-30'), { jahr: 2026, saison: 'SOMMER' });
  assert.deepEqual(saisonAm('2026-10-01'), { jahr: 2026, saison: 'WINTER' });
  assert.deepEqual(saisonAm('2026-11-22'), { jahr: 2026, saison: 'WINTER' });
  assert.deepEqual(saisonAm('2027-03-31'), { jahr: 2026, saison: 'WINTER' });
});

test('Saisontexte und Vorjahr', () => {
  assert.equal(saisonText({ jahr: 2027, saison: 'SOMMER' }), 'Sommer 2027');
  assert.equal(saisonText({ jahr: 2026, saison: 'WINTER' }), 'Winter 2026/27');
  assert.equal(saisonText({ jahr: 2099, saison: 'WINTER' }), 'Winter 2099/00');
  assert.deepEqual(vorjahresSaison({ jahr: 2027, saison: 'SOMMER' }), { jahr: 2026, saison: 'SOMMER' });
});

test('zeitenPruefen: vereinheitlicht, sortiert Mo–So, prüft Uhrzeit, Ende und Überschneidung', () => {
  const z = zeitenPruefen([
    { wochentag: 7, von: '10:00', bis: '11:00', bemerkung: '  Platz 2 ' },
    { wochentag: 1, von: '9:30', bis: '10:30:00', bemerkung: '' },
    { wochentag: 1, von: '08:00', bis: '09:30', bemerkung: '' },
  ]);
  assert.deepEqual(z.map((x) => [x.wochentag, x.von, x.bis]), [[1, '08:00', '09:30'], [1, '09:30', '10:30'], [7, '10:00', '11:00']]);
  assert.equal(z[2].bemerkung, 'Platz 2');
  assert.equal(zeitenText(z), 'Mo 08:00–09:30, Mo 09:30–10:30, So 10:00–11:00');
  assert.deepEqual(zeitenPruefen([]), []);

  assert.throws(() => zeitenPruefen([{ wochentag: 8, von: '10:00', bis: '11:00', bemerkung: '' }]), /Wochentag/);
  assert.throws(() => zeitenPruefen([{ wochentag: 2, von: '25:00', bis: '26:00', bemerkung: '' }]), /HH:MM/);
  assert.throws(() => zeitenPruefen([{ wochentag: 2, von: '17:00', bis: '17:00', bemerkung: '' }]), /Ende muss nach dem Beginn/);
  assert.throws(() => zeitenPruefen([
    { wochentag: 3, von: '16:00', bis: '17:30', bemerkung: '' },
    { wochentag: 3, von: '17:00', bis: '18:00', bemerkung: '' },
  ]), /Mittwoch: 16:00–17:30 und 17:00–18:00 überschneiden sich/);
  // gleiche Uhrzeit an verschiedenen Tagen ist erlaubt
  assert.equal(zeitenPruefen([
    { wochentag: 2, von: '16:00', bis: '17:00', bemerkung: '' }, { wochentag: 4, von: '16:00', bis: '17:00', bemerkung: '' },
  ]).length, 2);
});
