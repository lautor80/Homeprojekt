/** WCA Zeitenkontrolle: Drilldown je Person (Kategorie → Projekt → Tätigkeit), rein ohne Datenbank */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baum, baumFelderLesen, BAUM_STANDARD } from '../../modules/wca/web/ansicht.js';
import type { AuswEintrag } from '../../modules/wca/server/typen.js';

function e(o: Partial<AuswEintrag>): AuswEintrag {
  return {
    person: 'Dora Drill', team: 'Team D', typ: 'I', kat: 'Intern', accName: 'Admin - Others', kunde: 'Walldorf intern', accKey: 'ADM1',
    ber: 'WDE Internal Projects', berKey: 'WDEINT001', key: 'WDEINT001-9', text: 'Teamrunde', acc: 'Admin - Others|Walldorf intern',
    errorAccount: false, ohneAccount: false, intern: true, tage: [['2026-11-02', 1]], stunden: 1, ...o,
  };
}

test('Drilldown: Kategorie → Projekt → Tätigkeit, gleiche Texte zusammengefasst, sortiert nach Stunden', () => {
  const liste = [
    e({ tage: [['2026-11-02', 1]], stunden: 1 }),
    e({ text: ' teamrunde  ', key: 'WDEINT001-10', tage: [['2026-11-03', 1.5]], stunden: 1.5 }),
    e({ typ: 'B', accName: 'Servicemanagement', kunde: 'Kunde Drill GmbH', acc: 'Servicemanagement|Kunde Drill GmbH', ber: 'Managed Services',
        key: 'DRL-1', text: 'DRL-1: Mapping angepasst', tage: [['2026-11-02', 6], ['2026-11-03', 6]], stunden: 12 }),
    e({ typ: 'B', accName: 'Rollout', kunde: 'Kunde Drill GmbH', acc: 'Rollout|Kunde Drill GmbH', key: 'DRL-2', text: 'DRL-2: Schulung', tage: [['2026-11-04', 3]], stunden: 3 }),
    e({ ohneAccount: true, accName: 'Kein Account', kunde: '', acc: '', ber: 'Innovation Lab', text: 'Prototyp', tage: [['2026-11-05', 2]], stunden: 2 }),
    e({ typ: 'A', accName: 'ATG Absence', acc: 'ATG Absence|x', text: 'Urlaub', tage: [['2026-11-06', 8]], stunden: 8 }),
    e({ stunden: 0, tage: [] }),
  ].map((x, i) => ({ e: x, i }));
  const b = baum(liste);
  assert.deepEqual(b.map((k) => [k.text, k.stunden]), [['Billable', 15], ['Intern', 4.5], ['Abwesenheit', 8]]);
  const bill = b[0];
  assert.deepEqual(bill.kinder.map((k) => [k.text, k.zusatz, k.stunden, k.tage]), [
    ['Servicemanagement', 'Kunde Drill GmbH · Managed Services', 12, 2],
    ['Rollout', 'Kunde Drill GmbH · WDE Internal Projects', 3, 1],
  ]);
  const intern = b[1];
  assert.deepEqual(intern.kinder.map((k) => k.text), ['Admin - Others', 'Innovation Lab']);
  const runde = intern.kinder[0].kinder;
  assert.equal(runde.length, 1, 'gleicher Text (Leerzeichen, Groß/klein) = eine Tätigkeit');
  assert.deepEqual([runde[0].text, runde[0].zusatz, runde[0].stunden, runde[0].tage, runde[0].eintraege], ['Teamrunde', 'WDEINT001-9, WDEINT001-10', 2.5, 2, [0, 1]]);
  assert.equal(intern.kinder[1].zusatz, '', 'ohne Account: Bereich als Projekt');
  assert.equal(intern.tage, 3);
});

test('Drilldown: frei wählbare Felder – Reihenfolge bestimmt die Gruppierung, Zeitfelder teilen nach Tagen auf', () => {
  const liste = [
    e({ typ: 'B', accName: 'Servicemanagement', kunde: 'Kunde Drill GmbH', acc: 'Servicemanagement|Kunde Drill GmbH', ber: 'Managed Services',
        key: 'DRL-1', text: 'Mapping', tage: [['2026-10-30', 2], ['2026-11-02', 6]], stunden: 8 }),
    e({ typ: 'I', key: 'WDEINT001-9', text: 'Teamrunde', tage: [['2026-11-02', 1]], stunden: 1 }),
    e({ typ: 'B', accName: 'Rollout', kunde: 'Kunde Drill GmbH', acc: 'Rollout|Kunde Drill GmbH', ber: 'Managed Services', key: 'DRL-2',
        text: 'Schulung', tage: [['2026-11-03', 3]], stunden: 3 }),
  ].map((x, i) => ({ e: x, i }));

  // Monat → Kategorie: chronologisch, Stunden je Monat aufgeteilt
  const m = baum(liste, ['monat', 'kategorie']);
  assert.deepEqual(m.map((k) => [k.text, k.stunden, k.tage]), [['Oktober 2026', 2, 1], ['November 2026', 10, 2]]);
  assert.deepEqual(m[1].kinder.map((k) => [k.text, k.stunden]), [['Billable', 9], ['Intern', 1]]);
  assert.deepEqual(m[1].kinder[0].eintraege, [0, 2]);

  // Kunde → Projekt: Kunde nicht mehr als Zusatz am Projekt
  const k = baum(liste, ['kunde', 'projekt']);
  assert.deepEqual(k.map((x) => x.text), ['Kunde Drill GmbH', 'Walldorf intern']);
  assert.deepEqual(k[0].kinder.map((x) => [x.text, x.zusatz, x.stunden]), [['Servicemanagement', 'Managed Services', 8], ['Rollout', 'Managed Services', 3]]);

  // Tag → Ticket (Blatt), Ticket nicht als Zusatz
  const t = baum(liste, ['tag', 'ticket', 'taetigkeit']);
  assert.deepEqual(t.map((x) => x.text), ['Fr 30.10.2026', 'Mo 02.11.2026', 'Di 03.11.2026']);
  assert.deepEqual(t[1].kinder.map((x) => [x.text, x.stunden]), [['DRL-1', 6], ['WDEINT001-9', 1]]);
  assert.equal(t[1].kinder[0].kinder[0].zusatz, '');

  // KW
  assert.deepEqual(baum(liste, ['woche']).map((x) => [x.text, x.stunden]), [['KW 44/2026', 2], ['KW 45/2026', 10]]);

  // Standard und gespeicherte Auswahl
  assert.deepEqual(baum(liste).map((x) => x.feld), ['kategorie', 'kategorie']);
  assert.deepEqual(baumFelderLesen(['tag', 'quatsch', 'tag', 'kunde']), ['tag', 'kunde']);
  assert.deepEqual(baumFelderLesen([]), BAUM_STANDARD);
  assert.deepEqual(baumFelderLesen('x'), BAUM_STANDARD);
});
