/** Vorstandssitzungen: Verlauf eines Themas über mehrere Sitzungen – Reihenfolge, Aufteilung, Kurzform (ohne Datenbank) */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titelSchluessel, verlaufKurz, verlaufTeilen } from '../../modules/tco/server/vorstand/regeln.js';

const p = (top_id: number, sitzung_id: number, datum: string) => ({ top_id, sitzung_id, datum });

test('Verlauf aus Sicht eines Punkts: früher und später, chronologisch, ohne den Punkt selbst', () => {
  const liste = [p(40, 4, '2085-12-05'), p(10, 1, '2085-11-21'), p(70, 7, '2086-01-10'), p(41, 4, '2085-12-05'), p(50, 5, '2085-12-05')];
  const v = verlaufTeilen(liste, p(41, 4, '2085-12-05'));
  assert.deepEqual(v.vorher.map((x) => x.top_id), [10, 40], 'gleiche Sitzung: kleinere Id zuerst');
  assert.deepEqual(v.nachher.map((x) => x.top_id), [50, 70], 'gleicher Tag, spätere Sitzung');
  assert.deepEqual(verlaufTeilen([p(1, 1, '2085-01-01')], p(1, 1, '2085-01-01')), { vorher: [], nachher: [] });
});

test('Kurzform für das Protokoll', () => {
  assert.equal(verlaufKurz([
    { sitzung_nr: 'VS 2085/01', datum: '2085-11-21', status: 'VERTAGT' },
    { sitzung_nr: 'VS 2085/02', datum: '2085-12-05', status: 'ERLEDIGT' },
  ]), 'VS 2085/01 vom 21.11.2085 (vertagt); VS 2085/02 vom 05.12.2085 (abgeschlossen)');
  assert.equal(verlaufKurz([]), '');
});

test('Titel gleichnamiger Punkte: Groß-/Kleinschreibung und Leerraum egal', () => {
  assert.equal(titelSchluessel('  Winterhallenrunde   Altenkessel '), titelSchluessel('winterhallenrunde altenkessel'));
  assert.notEqual(titelSchluessel('Winterhallenrunde Altenkessel'), titelSchluessel('Winterhallenrunde Oberthal'));
});
