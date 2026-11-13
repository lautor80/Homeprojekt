/**
 * Instandhaltung (#205): fachliche Regeln ohne Datenbank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aufgabeState, empfaenger, eskalationFaellig, feldAenderungen, fotoLesen, prioritaetVorschlag, ueberfaellig, istOffen, kurz, meldungsNummer, wechselFehler, zustaendigRang,
} from '../../modules/tco/server/instandhaltung/regeln.js';

test('Arbeitsvorrat: Farbe nach Auswirkung', () => {
  assert.equal(aufgabeState('SICHERHEIT'), 'Negative');
  assert.equal(aufgabeState('UNBESPIELBAR'), 'Critical');
  assert.equal(aufgabeState('EINGESCHRAENKT'), 'Information');
  assert.equal(aufgabeState('OPTISCH'), 'Information');
});

test('Nummer und Kurztext', () => {
  assert.equal(meldungsNummer(2026, 7), 'SM-2026-0007');
  assert.equal(meldungsNummer(2026, 12345), 'SM-2026-12345');
  assert.equal(kurz('  Netz   hängt durch '), 'Netz hängt durch');
  const k = kurz('Das Netz auf Platz drei hängt in der Mitte deutlich durch und die Kurbel ist abgebrochen', 40);
  assert.ok(k.length <= 40 && k.endsWith('…'), k);
  assert.ok(!k.includes('Kurbel'));
});

test('Statuswechsel', () => {
  assert.equal(wechselFehler('NEU', 'IN_ARBEIT'), null);
  assert.equal(wechselFehler('NEU', 'ERLEDIGT'), null);
  assert.equal(wechselFehler('ERLEDIGT', 'IN_ARBEIT'), null, 'wieder öffnen');
  assert.match(wechselFehler('ERLEDIGT', 'ABGELEHNT', { erledigung: 'x' })!, /wieder geöffnet/);
  assert.match(wechselFehler('NEU', 'DUPLIKAT')!, /Duplikat/);
  assert.equal(wechselFehler('NEU', 'DUPLIKAT', { duplikatVon: 3 }), null);
  assert.match(wechselFehler('NEU', 'ABGELEHNT', { erledigung: '  ' })!, /Grund/);
  assert.match(wechselFehler('NEU', 'QUATSCH')!, /Unbekannt/);
  assert.ok(istOffen('WARTET') && !istOffen('DUPLIKAT'));
});

test('Eskalation nach 24 h nur bei offenem Sicherheitsrisiko', () => {
  const jetzt = new Date('2026-11-13T12:00:00Z');
  const alt = '2026-11-12T10:00:00Z';
  assert.equal(eskalationFaellig({ auswirkung: 'SICHERHEIT', status: 'NEU', status_am: alt, erinnert_am: null }, jetzt), true);
  assert.equal(eskalationFaellig({ auswirkung: 'SICHERHEIT', status: 'NEU', status_am: '2026-11-13T00:00:00Z', erinnert_am: null }, jetzt), false);
  assert.equal(eskalationFaellig({ auswirkung: 'SICHERHEIT', status: 'NEU', status_am: alt, erinnert_am: '2026-11-13T08:00:00Z' }, jetzt), false);
  assert.equal(eskalationFaellig({ auswirkung: 'SICHERHEIT', status: 'NEU', status_am: alt, erinnert_am: '2026-11-12T11:00:00Z' }, jetzt), true);
  assert.equal(eskalationFaellig({ auswirkung: 'SICHERHEIT', status: 'ERLEDIGT', status_am: alt, erinnert_am: null }, jetzt), false);
  assert.equal(eskalationFaellig({ auswirkung: 'UNBESPIELBAR', status: 'NEU', status_am: alt, erinnert_am: null }, jetzt), false);
});

test('Empfänger: Listen zusammenführen, ungültige und doppelte entfernen', () => {
  assert.deepEqual(empfaenger('a@x.de, B@x.de; kaputt', null, 'b@x.de', ''), ['a@x.de', 'B@x.de']);
});

test('Fotos: nur Bilder in erlaubter Größe', () => {
  const png = `data:image/png;base64,${Buffer.from('bild').toString('base64')}`;
  assert.equal(fotoLesen(png).mime, 'image/png');
  assert.throws(() => fotoLesen('data:application/pdf;base64,AAAA'), /nur Fotos/);
  assert.throws(() => fotoLesen(`data:image/jpeg;base64,${Buffer.alloc(2000).toString('base64')}`, 1000), /zu groß/);
});

test('Zuständigkeit: Ort und/oder Kategorie, spezifischer zuerst', () => {
  assert.equal(zustaendigRang({ anlage_id: 1, kategorie_id: 5 }, 1, 5), 0);
  assert.equal(zustaendigRang({ anlage_id: null, kategorie_id: 5 }, 1, 5), 1);
  assert.equal(zustaendigRang({ anlage_id: 1, kategorie_id: null }, 1, 5), 2);
  assert.equal(zustaendigRang({ anlage_id: 2, kategorie_id: null }, 1, 5), null);
  assert.equal(zustaendigRang({ anlage_id: 1, kategorie_id: 6 }, 1, 5), null);
  assert.equal(zustaendigRang({ anlage_id: null, kategorie_id: null }, 1, 5), null);
});

test('Protokoll: geänderte Felder mit alt → neu', () => {
  assert.deepEqual(feldAenderungen({ kosten: null, firma: 'A', stunden: '2.00', erledigung: null, paperless: '' }, { kosten: 80, firma: 'A', stunden: 2, erledigung: null, paperless: null }),
    ['Istkosten: – → 80,00 €']);
  assert.deepEqual(feldAenderungen({ firma: 'A' }, { firma: 'B', stunden: 1.5 }), ['Fremdfirma: A → B', 'Helferstunden: – → 1,5 h']);
});

test('Priorität, Termine und Überfälligkeit', () => {
  assert.equal(prioritaetVorschlag('SICHERHEIT'), 'SEHR_HOCH');
  assert.equal(prioritaetVorschlag('OPTISCH'), 'MITTEL');
  assert.deepEqual(feldAenderungen({ prioritaet: 'MITTEL', geplant_bis: null, ende_ist: null }, { prioritaet: 'HOCH', geplant_bis: '2026-11-20', ende_ist: null }),
    ['Priorität: Mittel → Hoch', 'Geplantes Ende: – → 20.11.2026']);
  assert.equal(ueberfaellig({ status: 'IN_ARBEIT', geplant_bis: '2026-11-10' }, '2026-11-13'), true);
  assert.equal(ueberfaellig({ status: 'ERLEDIGT', geplant_bis: '2026-11-10' }, '2026-11-13'), false);
  assert.equal(ueberfaellig({ status: 'NEU', geplant_bis: '2026-11-13' }, '2026-11-13'), false);
});
