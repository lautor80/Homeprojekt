import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aufbewahrungText, inhaltBehalten, loeschenNachTagen, nachladenZuordnen, ZUGEORDNET_ERLEDIGT } from '../../modules/transport/server/eingang/aufbewahrung.js';
import { einstellungenMischen } from '../../modules/transport/server/mailworkflows.js';

test('Aufbewahrung: Standard dauerhaft, auch für gespeicherte Einstellungen ohne das Feld', () => {
  assert.equal(einstellungenMischen({}, {}).eingang.aufbewahrenDauerhaft, true);
  assert.equal(einstellungenMischen({ aufbewahrenTage: 90 }, {}).eingang.aufbewahrenDauerhaft, true, 'Bestand mit 90 Tagen wird dauerhaft');
  assert.equal(einstellungenMischen({ aufbewahrenDauerhaft: false, aufbewahrenTage: 30 }, {}).eingang.aufbewahrenDauerhaft, false);
  assert.deepEqual([...ZUGEORDNET_ERLEDIGT], ['uebernommen', 'abgelegt', 'dublette']);
});

test('Aufbewahrung: behalten und löschen', () => {
  assert.equal(inhaltBehalten({ aufbewahrenDauerhaft: true, aufbewahrenTage: 0 }), true);
  assert.equal(inhaltBehalten({ aufbewahrenDauerhaft: false, aufbewahrenTage: 0 }), false);
  assert.equal(inhaltBehalten({ aufbewahrenDauerhaft: false, aufbewahrenTage: 7 }), true);
  assert.equal(loeschenNachTagen({ aufbewahrenDauerhaft: true, aufbewahrenTage: 7 }), null);
  assert.equal(loeschenNachTagen({ aufbewahrenDauerhaft: false, aufbewahrenTage: 7 }), 7);
  assert.match(aufbewahrungText({ aufbewahrenDauerhaft: true, aufbewahrenTage: 7 }), /dauerhaft/);
  assert.match(aufbewahrungText({ aufbewahrenDauerhaft: false, aufbewahrenTage: 0 }), /sofort/);
  assert.match(aufbewahrungText({ aufbewahrenDauerhaft: false, aufbewahrenTage: 30 }), /30 Tage/);
});

test('Nachladen: Prüfsumme vor Dateiname, jede Lieferung nur einmal, E-Mail-PDF nicht', () => {
  const fehlend = [
    { id: 1, art: 'anhang' as const, datei: 'Scan.pdf', sha256: 'aaa' },
    { id: 2, art: 'anhang' as const, datei: 'Rechnung.PDF', sha256: 'alt' },
    { id: 3, art: 'mail' as const, datei: '2026-11-17 Betreff.pdf', sha256: 'm' },
    { id: 4, art: 'anhang' as const, datei: 'Fehlt.pdf', sha256: null },
  ];
  const geliefert = [{ name: 'rechnung.pdf', sha256: 'neu' }, { name: 'Umbenannt.pdf', sha256: 'aaa' }, { name: 'Scan.pdf', sha256: 'x' }];
  assert.deepEqual(nachladenZuordnen(fehlend, geliefert), [{ id: 1, index: 1 }, { id: 2, index: 0 }]);
  assert.deepEqual(nachladenZuordnen([], geliefert), []);
  assert.deepEqual(nachladenZuordnen(fehlend.slice(0, 1), []), []);
});
