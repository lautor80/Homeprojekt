/**
 * Tabellen anpassen (Euroflex): Spalten ein-/ausblenden, Spaltenfilter, Sortierung – Stand für Ansichtsvarianten.
 * Reine Funktionen aus web/src/components/tabellenAnsicht.ts, ohne Datenbank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEERER_STAND, ausTabelle, filterText, gleich, sichtbareSpalten, spalteSetzen, spaltenId, spaltenText, standLesen, type TabellenStand,
} from '../../web/src/components/tabellenAnsicht.js';

const SPALTEN = [
  { Header: 'Status', accessor: 'status', id: 'status' },
  { Header: 'Auftrag', accessor: 'auftragsnr' },
  { Header: 'Kunde', accessor: 'kunde' },
  { Header: 'Route', accessor: 'route' },
  { Header: 'Abrechnung', id: 'abrechnung', accessor: () => '' },
  { Header: 'Ohne Accessor' },
];
const IDS = SPALTEN.map(spaltenId);

test('Spalten-Id wie react-table: id, Accessor-Text, Überschrift', () => {
  assert.deepEqual(IDS, ['status', 'auftragsnr', 'kunde', 'route', 'abrechnung', 'Ohne Accessor']);
  assert.equal(spaltenText({ id: 'x', Header: () => null }), 'x');
});

test('Ausblenden: Pflichtspalten bleiben, Filter und Sortierung der Spalte fallen weg', () => {
  let s: TabellenStand = { aus: [], filter: [{ id: 'kunde', value: 'brandt' }, { id: 'route', value: 'mannheim' }], sortierung: [{ id: 'kunde', desc: true }] };
  s = spalteSetzen(s, 'kunde', false);
  assert.deepEqual(s, { aus: ['kunde'], filter: [{ id: 'route', value: 'mannheim' }], sortierung: [] });
  s = spalteSetzen(s, 'auftragsnr', false);
  assert.deepEqual(sichtbareSpalten(SPALTEN, s, ['auftragsnr']).map(spaltenId), ['status', 'auftragsnr', 'route', 'abrechnung', 'Ohne Accessor']);
  assert.deepEqual(spalteSetzen(s, 'kunde', true).aus, ['auftragsnr']);
});

test('Stand aus einer Variante: Unbekanntes und Kaputtes fällt still weg', () => {
  const v = {
    aus: ['route', 'gibtsnicht', 'auftragsnr', 7, 'route'],
    filter: [{ id: 'kunde', value: 'Brandt' }, { id: 'route', value: 'x' }, { id: 'kunde', value: 'doppelt' }, { id: 'status', value: '  ' }, { id: 'abrechnung', value: 3 }, 'quatsch'],
    sortierung: [{ id: 'kunde', desc: true }, { id: 'route' }, { id: 'status', desc: 'ja' }],
  };
  assert.deepEqual(standLesen(v, IDS, ['auftragsnr']), {
    aus: ['route'],
    filter: [{ id: 'kunde', value: 'Brandt' }],
    sortierung: [{ id: 'kunde', desc: true }, { id: 'status', desc: false }],
  });
  assert.deepEqual(standLesen(null, IDS), LEERER_STAND);
  assert.deepEqual(standLesen('alt', IDS), LEERER_STAND);
  // ohne bekannte Spalten nur die Form prüfen (beim Laden der Variante, bevor die Tabelle sie bereinigt)
  assert.deepEqual(standLesen({ aus: ['neu'], filter: [], sortierung: [] }).aus, ['neu']);
});

test('Zustand der Tabelle übernehmen und vergleichen', () => {
  const s = ausTabelle({ ...LEERER_STAND, aus: ['route'] }, [{ id: 'kunde', value: 'brandt' }, { id: 'betrag', value: undefined }], [{ id: 'auftragsnr', desc: false }]);
  assert.deepEqual(s, { aus: ['route'], filter: [{ id: 'kunde', value: 'brandt' }], sortierung: [{ id: 'auftragsnr', desc: false }] });
  assert.ok(gleich(s, JSON.parse(JSON.stringify(s))));
  assert.ok(!gleich(s, LEERER_STAND));
  assert.equal(filterText({ ...s, filter: [...s.filter, { id: 'route', value: 'mannheim' }] }, SPALTEN), 'Kunde: brandt · Route: mannheim');
});
