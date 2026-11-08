/** Zentrale Paperless-Zuordnung: Vorlagen, Modifikatoren, Zusammenführen mit dem Standard */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anwenden, auswerten, vorschau, zusammenfuehren, type KontextDef } from '../src/lib/paperless-mapping.js';

const werte = { kunde: 'Holz Müller  GmbH', datei: 'Lieferschein 4711.pdf', betrag: 1344.9, angelegt_am: '2026-11-08', dokid: '4711', leer: '' };

test('auswerten: Platzhalter, Modifikatoren, Leerwerte', () => {
  assert.equal(auswerten('Auftrag {nr} – {datei|ohneEndung}', { ...werte, nr: '2026_0153' }).text, 'Auftrag 2026_0153 – Lieferschein 4711');
  assert.equal(auswerten('{kunde|upper|kurz:4}', werte).text, 'HOLZ');
  assert.equal(auswerten('{angelegt_am|datum}', werte).text, '08.11.2026');
  assert.equal(auswerten('{dokid|pad:6}', werte).text, '004711');
  assert.equal(auswerten('{betrag|betrag} EUR', werte).text, '1.344,90 EUR');
  assert.equal(auswerten('{unbekannt} {leer} x', werte).text, 'x');
  assert.equal(auswerten('{betrag}', werte).roh, 1344.9, 'Einzelplatzhalter liefert den Rohwert');
  assert.equal(auswerten('{betrag} EUR', werte).roh, undefined);
});

test('anwenden: Zahlwerte in Custom Fields, Tags, Datum nur bei gültigem ISO', () => {
  const z = anwenden({ titel: '{kunde}', tags: 'Auftrag {dokid}, Import, ', datum: '{angelegt_am}', felder: { Betrag: '{betrag}', DOKID: '{dokid|pad:6}', Leer: '{leer}' } }, werte);
  assert.equal(z.title, 'Holz Müller GmbH');
  assert.deepEqual(z.tags, ['Auftrag 4711', 'Import']);
  assert.equal(z.created, '2026-11-08');
  assert.equal(z.customFields.Betrag, 1344.9);
  assert.equal(z.customFields.DOKID, '004711');
  assert.equal(z.customFields.Leer, null);
  assert.equal(anwenden({ datum: 'heute' }, werte).created, undefined);
});

test('zusammenfuehren und vorschau', () => {
  const def: KontextDef = {
    id: 't', text: 'Test', platzhalter: [{ name: 'kunde', text: 'Kunde', beispiel: 'Beispiel AG' }, { name: 'betrag', text: 'Betrag', beispiel: 12.5 }],
    standard: { titel: 'Rechnung {kunde}', speicherpfad: 'Buchhaltung', felder: { Betrag: '{betrag}' } },
  };
  const r = zusammenfuehren(def.standard, { titel: 'RE {kunde}', felder: { Betrag: '{betrag}', Hinweis: 'neu' } });
  assert.equal(r.titel, 'RE {kunde}');
  assert.equal(r.speicherpfad, 'Buchhaltung', 'nicht überschriebene Felder bleiben Standard');
  assert.deepEqual(Object.keys(r.felder ?? {}), ['Betrag', 'Hinweis']);
  const v = vorschau(def, { titel: '' });
  assert.equal(v.title, '', 'leere Vorlage überschreibt bewusst');
  assert.equal(vorschau(def, {}).title, 'Rechnung Beispiel AG');
  assert.equal(vorschau(def, {}).customFields.Betrag, 12.5);
});
