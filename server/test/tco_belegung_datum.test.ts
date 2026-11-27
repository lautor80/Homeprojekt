/**
 * Platzverwaltung → Belegung: Der gewählte Tag und die angezeigte Belegung passen zusammen
 * (modules/tco/web/platz/belegungDatum.ts) – reine Funktionen und Quelltext, ohne Datenbank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { datumLesen, passtZuTagen } from '../../modules/tco/web/platz/belegungDatum.js';

test('Datumsfeld: ISO und Anzeigeformat werden gelesen, Unlesbares nicht', () => {
  assert.equal(datumLesen('2026-12-04'), '2026-12-04');
  assert.equal(datumLesen('Fr., 04.12.2026'), '2026-12-04');
  assert.equal(datumLesen('Fr, 04.12.2026'), '2026-12-04');
  assert.equal(datumLesen('Fri, 04.12.2026'), '2026-12-04');
  assert.equal(datumLesen(' 4.12.2026 '), '2026-12-04');
  assert.equal(datumLesen('31.02.2026'), null, 'den Tag gibt es nicht');
  assert.equal(datumLesen('2026-13-01'), null);
  assert.equal(datumLesen('104.12.2026'), null);
  assert.equal(datumLesen(''), null);
  assert.equal(datumLesen(undefined), null);
});

test('Belegung wird nur gezeigt, wenn sie zu den gewählten Tagen gehört', () => {
  assert.equal(passtZuTagen([{ datum: '2026-12-04' }], ['2026-12-04']), true);
  assert.equal(passtZuTagen([{ datum: '2026-11-27' }], ['2026-12-04']), false, 'ältere Antwort für heute unter dem neuen Datum');
  assert.equal(passtZuTagen([{ datum: '2026-12-04' }], ['2026-12-04', '2026-12-05']), false);
  assert.equal(passtZuTagen(null, ['2026-12-04']), false);
});

test('Belegung: nur die jüngste Antwort zählt, das Datumsfeld wird selbst gelesen, der Tag steht im Spaltenkopf', () => {
  const q = readFileSync(fileURLToPath(new URL('../../modules/tco/web/platz/Platzverwaltung.tsx', import.meta.url)), 'utf8');
  const belegung = q.slice(q.indexOf('function Belegung('), q.indexOf('function EintragDialog('));
  assert.match(belegung, /const nr = \+\+ladeNr\.current;/);
  assert.match(belegung, /if \(nr === ladeNr\.current\) setTagListe\(liste\)/);
  assert.match(belegung, /!passtZuTagen\(tagListe, daten\)/);
  assert.match(belegung, /onChange=\{\(e\) => datumWaehlen\(/);
  assert.ok(!/e\.detail\.valid && e\.detail\.value && setDatum/.test(belegung), 'nicht mehr von „valid“ des Feldes abhängig');
  assert.ok(!/tage === 1 \? p\.name :/.test(belegung), 'auch bei einem Tag steht das Datum im Spaltenkopf');
});
