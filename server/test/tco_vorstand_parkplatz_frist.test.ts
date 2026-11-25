/** Themenparkplatz: Frist geparkter Themen (rot = Beginn erreicht, orange = Beginn in 30 Tagen) und Kennzahl der Übersicht */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { themaFrist, themenZaehlen } from '../../modules/tco/server/vorstand/themen.js';

const heute = '2085-11-25';

test('Frist: verspätet ab Beginn des Zeitraums, bald bis 30 Tage vorher, sonst keine', () => {
  assert.equal(themaFrist({ stand: 'GEPARKT', von: '2085-11-25' }, heute), 'VERSPAETET');
  assert.equal(themaFrist({ stand: 'GEPARKT', von: '2085-10-01' }, heute), 'VERSPAETET');
  assert.equal(themaFrist({ stand: 'GEPARKT', von: '2085-11-26' }, heute), 'BALD');
  assert.equal(themaFrist({ stand: 'GEPARKT', von: '2085-12-25' }, heute), 'BALD', 'genau 30 Tage');
  assert.equal(themaFrist({ stand: 'GEPARKT', von: '2085-12-26' }, heute), null);
  assert.equal(themaFrist({ stand: 'EINGEPLANT', von: '2085-10-01' }, heute), null, 'eingeplant hat keine Frist');
  assert.equal(themaFrist({ stand: 'GEPARKT', von: '2086-01-10' }, '2085-12-15'), 'BALD', 'über den Jahreswechsel');
});

test('Kennzahl: nur geparkte Themen', () => {
  assert.deepEqual(themenZaehlen([
    { stand: 'GEPARKT', frist: 'VERSPAETET' }, { stand: 'GEPARKT', frist: 'BALD' }, { stand: 'GEPARKT', frist: null },
    { stand: 'EINGEPLANT', frist: null },
  ]), { geparkt: 3, verspaetet: 1, bald: 1 });
});

test('Übersicht: Kachel und Reiter mit Anzahl, Symbol rot vor orange', () => {
  const q = readFileSync(fileURLToPath(new URL('../../modules/tco/web/vorstand/Vorstand.tsx', import.meta.url)), 'utf8');
  assert.match(q, /<ParkplatzKachel z=\{d\.themen\}/);
  assert.match(q, /text=\{`Themenparkplatz \(\$\{d\.themen\.geparkt\}\)`\}/);
  assert.match(q, /z\.verspaetet \? 'Negative' : z\.bald \? 'Critical' : 'Default'/);
});
