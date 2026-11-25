/** Themenparkplatz der Vorstandssitzungen: Stand, Zeitraum und Reihenfolge der Vorschläge (ohne Datenbank) */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imZeitraum, themaStand, vorschlagOrdnung, zeitraumPruefen } from '../../modules/tco/server/vorstand/themen.js';

test('Stand ergibt sich aus Abschluss und Tagesordnungspunkt', () => {
  assert.equal(themaStand({ abgeschlossen: false, top_status: null }), 'GEPARKT');
  assert.equal(themaStand({ abgeschlossen: false, top_status: 'OFFEN' }), 'EINGEPLANT');
  assert.equal(themaStand({ abgeschlossen: false, top_status: 'ERLEDIGT' }), 'BESPROCHEN');
  assert.equal(themaStand({ abgeschlossen: false, top_status: 'VERTAGT' }), 'GEPARKT', 'vertagt = wieder geparkt');
  assert.equal(themaStand({ abgeschlossen: true, top_status: null }), 'ABGESCHLOSSEN');
});

test('Sitzung im Zeitraum (Grenzen eingeschlossen)', () => {
  const t = { von: '2026-12-01', bis: '2027-01-31' };
  assert.ok(imZeitraum(t, '2026-12-01'));
  assert.ok(imZeitraum(t, '2027-01-31'));
  assert.ok(imZeitraum(t, '2026-12-21'));
  assert.ok(!imZeitraum(t, '2026-11-30'));
  assert.ok(!imZeitraum(t, '2027-02-01'));
});

test('Vorschläge nach Priorität, dann früherem Ende, dann älterem Thema', () => {
  const l = [
    { id: 4, prioritaet: 2, bis: '2027-01-31' }, { id: 1, prioritaet: 3, bis: '2026-12-31' },
    { id: 3, prioritaet: 1, bis: '2027-03-01' }, { id: 2, prioritaet: 2, bis: '2026-12-31' }, { id: 5, prioritaet: 2, bis: '2026-12-31' },
  ];
  assert.deepEqual([...l].sort(vorschlagOrdnung).map((x) => x.id), [3, 2, 5, 4, 1]);
});

test('Zeitraum ist Pflicht und darf nicht rückwärts laufen', () => {
  assert.throws(() => zeitraumPruefen('', '2026-12-01'), /Zeitraum/);
  assert.throws(() => zeitraumPruefen('2026-12-02', '2026-12-01'), /vor dem Beginn/);
  assert.doesNotThrow(() => zeitraumPruefen('2026-12-01', '2026-12-01'));
});
