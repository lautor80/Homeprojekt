/**
 * LSVS-Bestandsmeldung (DOSB-Schnittstelle „SV-LSB“): Zählung zum Stichtag, Hinweise, XML-Aufbau – ohne Datenbank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestandErmitteln, bestandPruefen, bestandXml, geschlechtLsvs, stichtagStandard, type BestandMitglied } from '../../modules/tco/server/mitglieder/bestand.js';

const kopf = { schluessel: 'linear', nummer: '4711', bezeichnung: 'TC Oberthal & Co', ansprechpartner: 'Torsten Laub', fachverband: '83' };
const m = (adrnr: string, geschlecht: string | null, geburtsdatum: string | null, eintritt: string | null, austritt: string | null = null): BestandMitglied =>
  ({ adrnr, vorname: `V${adrnr}`, nachname: `N${adrnr}`, geschlecht, geburtsdatum, eintritt, austritt });

const daten = [
  m('9901', '1', '1980-05-01', '2000-01-01'),
  m('9902', '2', '1980-12-31', '2010-01-01'),
  m('9903', '1', '2015-03-03', '2026-01-01'),               // Eintritt am Stichtag: zählt
  m('9904', '2', '1990-01-01', '2020-01-01', '2025-12-31'), // Kündigung zum 31.12.: zählt nicht
  m('9905', '1', '1970-01-01', '2026-02-01'),               // Eintritt nach Stichtag
  m('9906', '1', '1960-01-01', '2000-01-01', '2026-06-30'), // Austritt nach Stichtag: zählt
  m('9907', '', '2001-01-01', '2000-01-01'),                // ohne Geschlecht
  m('9908', '2', null, '2000-01-01'),                       // ohne Geburtsdatum
  m('9909', '3', '2001-07-07', '2021-01-01'),               // divers
  m('9910', '1', '1980-01-01', null),                       // kein Mitglied (ohne Eintritt)
];

test('Bestandsmeldung: Zählung je Jahrgang und Geschlecht zum Stichtag', () => {
  const b = bestandErmitteln(daten, kopf, '2026-01-01');
  assert.deepEqual(b.zeilen, [
    { jahrgang: 1960, m: 1, w: 0, d: 0 },
    { jahrgang: 1980, m: 1, w: 1, d: 0 },
    { jahrgang: 2001, m: 0, w: 0, d: 1 },
    { jahrgang: 2015, m: 1, w: 0, d: 0 },
  ]);
  assert.deepEqual(b.summe, { m: 3, w: 1, d: 1, gesamt: 5 });
  assert.deepEqual(b.hinweise.map((h) => [h.adrnr, h.grund]), [['9907', 'Geschlecht fehlt'], ['9908', 'Geburtsdatum fehlt']]);
  assert.deepEqual(b.fehlt, []);
  bestandPruefen(b);
});

test('Bestandsmeldung: XML nach Schnittstelle SV-LSB (A- und B-Meldung, Maskierung)', () => {
  const x = bestandXml(bestandErmitteln(daten, kopf, '2026-01-01'));
  assert.ok(x.startsWith('<?xml version="1.0" encoding="utf-8" ?>\n<Mitglieder>'));
  assert.match(x, /<Software>\s*<Schluessel>linear<\/Schluessel>\s*<\/Software>/);
  assert.match(x, /<Verein>\s*<Nummer>4711<\/Nummer>\s*<Bezeichnung>TC Oberthal &amp; Co<\/Bezeichnung>\s*<Ansprechpartner>Torsten Laub<\/Ansprechpartner>\s*<\/Verein>/);
  assert.equal((x.match(/<Typ>A<\/Typ>/g) ?? []).length, 4);
  assert.equal((x.match(/<Typ>B<\/Typ>/g) ?? []).length, 4);
  assert.match(x, /<Typ>A<\/Typ>\s*<Fachverband><\/Fachverband>\s*<Jahrgang>1980<\/Jahrgang>\s*<AnzahlM>1<\/AnzahlM>\s*<AnzahlW>1<\/AnzahlW>\s*<AnzahlD>0<\/AnzahlD>/);
  assert.match(x, /<Typ>B<\/Typ>\s*<Fachverband>83<\/Fachverband>\s*<Jahrgang>2001<\/Jahrgang>\s*<AnzahlM>0<\/AnzahlM>\s*<AnzahlW>0<\/AnzahlW>\s*<AnzahlD>1<\/AnzahlD>/);
  assert.ok(!/AnzahlO/.test(x));
  assert.ok(x.trimEnd().endsWith('</Mitglieder>'));
});

test('Bestandsmeldung: fehlende Kopfangaben, Geschlecht, Standard-Stichtag', () => {
  const b = bestandErmitteln(daten, { ...kopf, nummer: '' }, '2026-01-01');
  assert.deepEqual(b.fehlt, ['Vereinsnummer beim LSVS']);
  assert.throws(() => bestandPruefen(b), /Vereinsnummer beim LSVS/);
  assert.throws(() => bestandPruefen(bestandErmitteln([], kopf, '2026-01-01')), /keine Mitglieder/);
  assert.equal(geschlechtLsvs('1'), 'm');
  assert.equal(geschlechtLsvs(' 2 '), 'w');
  assert.equal(geschlechtLsvs('D'), 'd');
  assert.equal(geschlechtLsvs(null), null);
  assert.equal(stichtagStandard('2026-11-15'), '2027-01-01');
  assert.equal(stichtagStandard('2027-01-10'), '2027-01-01');
});
