/**
 * Schnuppertraining – Inhalt des Druckberichts (modules/tco/server/schnupper/bericht.ts), ohne Datenbank und PDF.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { berichtAbschnitte, datumText, einheitenZeilen, zeitpunktText } from '../../modules/tco/server/schnupper/bericht.js';
import type { SchnupperZeile } from '../../modules/tco/server/schnupper/logik.js';

const basis: SchnupperZeile = {
  adrnr: '0000007711', nummer: 'ST-2026-0042', status: 'TERMIN', status_txt: 'Termin vereinbart', eingang: '2026-05-02T14:30:00Z',
  vorname: 'Mia', nachname: 'Muster', email: 'eltern@example.org', mobil: '0170 1112223', alter: 9, gespielt: false, stufe: 'NEU',
  stufe_txt: 'Neu (noch nie gespielt)', termine: { tage: ['Di', 'Sa'], zeiten: ['nachmittags'], text: 'nicht vor 15 Uhr' },
  erziehungsberechtigt: 'Maria Muster', mitteilung: 'Sie freut sich sehr!', einheit1: '2026-05-05', einheit2: null, trainer: 'Tom Trainer',
  notiz: 'Schläger leihen\nmit Freundin', antrag: null, bearbeitet_am: '2026-05-03T08:05:00Z', bearbeitet_von: 'Jugendwart', mitglnrn: '',
  whatsapp: '491701112223', einheiten: 1,
};
const zusatz = { einwilligung_am: '2026-05-02T14:30:00Z', einheiten: [
  { datum: '2026-05-12', trainer: 'Tom Trainer', erfasst_von: 'tom' }, { datum: '2026-05-05', trainer: null, erfasst_von: null },
] };
const zeile = (a: ReturnType<typeof berichtAbschnitte>, titel: string, angabe: string) => a.find((x) => x.titel === titel)?.zeilen.find((z) => z[0] === angabe)?.[1];

test('Datums- und Zeitformate (Berliner Zeit)', () => {
  assert.equal(datumText('2026-05-05'), '05.05.2026');
  assert.equal(datumText(null), '–');
  assert.equal(zeitpunktText('2026-05-02T14:30:00Z'), '02.05.2026 16:30 Uhr');
  assert.equal(zeitpunktText('2026-01-10T07:00:00Z'), '10.01.2026 08:00 Uhr');
  assert.equal(zeitpunktText(new Date('2026-01-10T07:00:00Z')), '10.01.2026 08:00 Uhr');
  assert.equal(zeitpunktText(null), '–');
});

test('Alle Angaben des Schnupperantrags in Abschnitten', () => {
  const a = berichtAbschnitte(basis, zusatz, 2);
  assert.deepEqual(a.map((x) => x.titel), ['Anmeldung', 'Person und Kontakt', 'Tennis', 'Mögliche Termine', 'Mitteilung', 'Betreuung', 'Beitritt']);
  assert.equal(zeile(a, 'Anmeldung', 'Anmeldenummer'), 'ST-2026-0042');
  assert.equal(zeile(a, 'Anmeldung', 'Eingegangen am'), '02.05.2026 16:30 Uhr');
  assert.match(zeile(a, 'Anmeldung', 'Einwilligung Kontaktdaten')!, /^erteilt am 02\.05\.2026 16:30 Uhr/);
  assert.equal(zeile(a, 'Person und Kontakt', 'Alter'), '9 Jahre (minderjährig)');
  assert.equal(zeile(a, 'Person und Kontakt', 'Erziehungsberechtigte/r'), 'Maria Muster');
  assert.equal(zeile(a, 'Person und Kontakt', 'E-Mail'), 'eltern@example.org');
  assert.equal(zeile(a, 'Person und Kontakt', 'Handy'), '0170 1112223');
  assert.equal(zeile(a, 'Tennis', 'Schon Tennis gespielt'), 'nein');
  assert.equal(zeile(a, 'Tennis', 'Spielstärke'), 'Neu (noch nie gespielt)');
  assert.equal(zeile(a, 'Mögliche Termine', 'Tage'), 'Dienstag, Samstag');
  assert.equal(zeile(a, 'Mögliche Termine', 'Tageszeiten'), 'nachmittags');
  assert.equal(zeile(a, 'Mögliche Termine', 'Hinweis zu Terminen'), 'nicht vor 15 Uhr');
  assert.equal(zeile(a, 'Mitteilung', 'Mitteilung an den Verein'), 'Sie freut sich sehr!');
  assert.equal(zeile(a, 'Betreuung', '1. Einheit'), '05.05.2026');
  assert.equal(zeile(a, 'Betreuung', '2. Einheit'), '–');
  assert.equal(zeile(a, 'Betreuung', 'Geschnuppert laut Trainingszeiten'), '1 von 2 kostenlosen Einheiten');
  assert.equal(zeile(a, 'Betreuung', 'Notiz'), 'Schläger leihen\nmit Freundin');
  assert.equal(zeile(a, 'Betreuung', 'Zuletzt bearbeitet'), 'Jugendwart, 03.05.2026 10:05 Uhr');
  assert.equal(zeile(a, 'Beitritt', 'Mitgliedsantrag'), 'noch kein Mitgliedsantrag');
  assert.equal(zeile(a, 'Beitritt', 'Mitgliedsnummer'), '–');
});

test('Leere Angaben, Volljährige, zu viele Einheiten', () => {
  const a = berichtAbschnitte({
    ...basis, alter: 34, erziehungsberechtigt: null, email: '', mobil: '0171 5', mitteilung: null, termine: { tage: [], zeiten: [], text: 'flexibel' },
    gespielt: true, einheiten: 3, antrag: 'MA-2026-0007', mitglnrn: '1234', bearbeitet_von: null,
  }, { einwilligung_am: null, einheiten: [] }, 2);
  assert.equal(zeile(a, 'Person und Kontakt', 'Erziehungsberechtigte/r'), 'nicht nötig (volljährig)');
  assert.equal(zeile(a, 'Person und Kontakt', 'E-Mail'), '–');
  assert.equal(zeile(a, 'Mögliche Termine', 'Tage'), '–');
  assert.equal(zeile(a, 'Mitteilung', 'Mitteilung an den Verein'), '–');
  assert.equal(zeile(a, 'Tennis', 'Schon Tennis gespielt'), 'ja');
  assert.equal(zeile(a, 'Betreuung', 'Geschnuppert laut Trainingszeiten'), '3 von 2 kostenlosen Einheiten – mehr als kostenlos vorgesehen');
  assert.equal(zeile(a, 'Anmeldung', 'Einwilligung Kontaktdaten'), 'nicht erfasst');
  assert.deepEqual([zeile(a, 'Beitritt', 'Mitgliedsantrag'), zeile(a, 'Beitritt', 'Mitgliedsnummer')], ['MA-2026-0007', '1234']);
});

test('Eingetragene Einheiten nach Datum', () => {
  assert.deepEqual(einheitenZeilen(zusatz), [['05.05.2026', '–', '–'], ['12.05.2026', 'Tom Trainer', 'tom']]);
  assert.deepEqual(einheitenZeilen({ einwilligung_am: null, einheiten: [] }), []);
});
