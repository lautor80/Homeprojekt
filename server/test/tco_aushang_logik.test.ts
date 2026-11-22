/**
 * Aushang in der Hallenbuchung – Rechenteil ohne Datenbank: wann gilt ein Aushang (aktiv, Zeitraum, Zielrollen), wann
 * öffnet er sich von selbst (einmal je Benutzer bzw. bis zur Bestätigung, oder bei jedem Aufruf), Reihenfolge, Prüfungen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuerBenutzer, gilt, kenntnisnahmen, normalisieren, oeffnetSich, pruefen, rundschreibenText, sortieren, stand, type Aushang, type Gesehen } from '../../modules/tco/server/platz/aushang.js';

const a = (id: number, rest: Partial<Aushang> = {}): Aushang => ({
  id, titel: `A${id}`, text: '', stil: 'INFO', gueltig_von: '2026-11-01', gueltig_bis: null, rollen: [], anzeige: 'EINMAL', bestaetigen: false, aktiv: true, ...rest,
});
const H = '2026-11-22';

test('gilt: aktiv, im Zeitraum (Grenzen eingeschlossen), Zielrollen', () => {
  assert.ok(gilt(a(1), H, []));
  assert.ok(!gilt(a(1, { aktiv: false }), H, []));
  assert.ok(gilt(a(1, { gueltig_von: H, gueltig_bis: H }), H, []), 'am ersten und letzten Tag');
  assert.ok(!gilt(a(1, { gueltig_von: '2026-11-23' }), H, []), 'geplant');
  assert.ok(!gilt(a(1, { gueltig_bis: '2026-11-21' }), H, []), 'abgelaufen');
  assert.ok(gilt(a(1, { rollen: ['HALLENNUTZER'] }), H, ['MITGLIED', 'HALLENNUTZER']));
  assert.ok(!gilt(a(1, { rollen: ['HALLENNUTZER'] }), H, ['MITGLIED']));
});

test('öffnet sich: einmal je Benutzer, mit Bestätigungspflicht bis zur Bestätigung, „bei jedem Aufruf“ immer', () => {
  const nie: Gesehen | undefined = undefined, gesehen: Gesehen = { gesehen: true, bestaetigt: false }, bestaetigt: Gesehen = { gesehen: true, bestaetigt: true };
  assert.deepEqual([nie, gesehen, bestaetigt].map((g) => oeffnetSich(a(1), g)), [true, false, false]);
  assert.deepEqual([nie, gesehen, bestaetigt].map((g) => oeffnetSich(a(1, { bestaetigen: true }), g)), [true, true, false]);
  assert.deepEqual([nie, gesehen, bestaetigt].map((g) => oeffnetSich(a(1, { anzeige: 'IMMER' }), g)), [true, true, true]);
});

test('Reihenfolge: kritisch vor Warnung vor Information, dann der neueste', () => {
  const l = sortieren([a(1), a(2, { stil: 'KRITISCH' }), a(3, { stil: 'WARNUNG', gueltig_von: '2026-11-02' }), a(4, { stil: 'WARNUNG', gueltig_von: '2026-11-10' }), a(5)]);
  assert.deepEqual(l.map((x) => x.id), [2, 4, 3, 5, 1]);
});

test('für einen Benutzer: alle geltenden zum Nachlesen, nur die fälligen öffnen sich', () => {
  const alle = [a(1), a(2, { bestaetigen: true }), a(3, { anzeige: 'IMMER' }), a(4, { rollen: ['TRAINER'] }), a(5, { aktiv: false })];
  const gesehen = new Map<number, Gesehen>([[1, { gesehen: true, bestaetigt: false }], [2, { gesehen: true, bestaetigt: false }], [3, { gesehen: true, bestaetigt: true }]]);
  const r = fuerBenutzer(alle, { heute: H, rollen: ['HALLENNUTZER'], gesehen });
  assert.deepEqual(r.aktuell.map((x) => x.id), [3, 2, 1]);
  assert.deepEqual(r.oeffnen.map((x) => x.id), [3, 2]);
});

test('Prüfungen, Stand und Rundschreiben-Text', () => {
  assert.equal(pruefen({ titel: ' ', gueltig_von: H, gueltig_bis: null }), 'Bitte einen Titel angeben.');
  assert.match(pruefen({ titel: 'x', gueltig_von: H, gueltig_bis: '2026-11-01' }) ?? '', /vor „gültig ab“/);
  assert.equal(pruefen({ titel: 'x', gueltig_von: H, gueltig_bis: H }), null);
  assert.deepEqual([a(1), a(1, { aktiv: false }), a(1, { gueltig_von: '2026-12-01' }), a(1, { gueltig_bis: '2026-11-02' })].map((x) => stand(x, H)), ['AKTUELL', 'AUS', 'GEPLANT', 'ABGELAUFEN']);
  assert.equal(rundschreibenText({ titel: 'Halle', text: 'Bitte fegen.\n' }, 'Der Vorstand'), '{Anrede},\n\nBitte fegen.\n\nViele Grüße\nDer Vorstand');
  assert.equal(rundschreibenText({ titel: 'Halle sauber', text: '' }, 'TC'), '{Anrede},\n\nHalle sauber\n\nViele Grüße\nTC');
});

test('für neue Hallenbucher: immer einmal mit Bestätigung; was beim Sichern mit den Kenntnisnahmen geschieht', () => {
  assert.deepEqual(normalisieren({ anzeige: 'IMMER' as const, bestaetigen: false, neue_bucher: true }), { anzeige: 'EINMAL', bestaetigen: true, neue_bucher: true });
  assert.deepEqual(normalisieren({ anzeige: 'IMMER' as const, bestaetigen: false, neue_bucher: false }), { anzeige: 'IMMER', bestaetigen: false, neue_bucher: false });
  assert.equal(kenntnisnahmen(false, true, false), 'BESTAND_MARKIEREN');
  assert.equal(kenntnisnahmen(true, false, false), 'BESTAND_LOESCHEN');
  assert.equal(kenntnisnahmen(true, true, false), null);
  assert.equal(kenntnisnahmen(false, false, false), null);
  assert.equal(kenntnisnahmen(false, true, true), 'ALLE_LOESCHEN', 'allen noch einmal zeigen geht vor');
});
