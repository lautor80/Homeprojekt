/**
 * Schnuppertraining – Prozesskette Anfrage → Schnuppern → Vertragsangebot → Mitgliedsantrag → Mitglied
 * (modules/tco/server/schnupper/prozess.ts), ohne Datenbank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prozessSchritte, type ProzessEingabe } from '../../modules/tco/server/schnupper/prozess.js';

const neu: ProzessEingabe = {
  status: 'NEU', eingang: '2026-05-02T14:30:00Z', einheit1: null, einheit2: null, einheiten: 0, mitglnrn: '',
  angebot: null, antrag_nr: null, antrag_status: null,
};
const angebot = { id: 7, nummer: 'VA-2026-0007', status: 'OFFEN' as const, gueltig_bis: '2026-06-20', abgelaufen: false, antrag: null };
const zustaende = (z: ProzessEingabe) => prozessSchritte(z).map((s) => s.zustand);
const infos = (z: ProzessEingabe) => prozessSchritte(z).map((s) => s.info);

test('immer fünf Schritte in fester Reihenfolge mit Titeln', () => {
  const p = prozessSchritte(neu);
  assert.deepEqual(p.map((s) => s.schritt), ['ANFRAGE', 'SCHNUPPERN', 'ANGEBOT', 'ANTRAG', 'MITGLIED']);
  assert.deepEqual(p.map((s) => s.titel), ['Anfrage', 'Schnuppern', 'Vertragsangebot', 'Mitgliedsantrag', 'Mitglied']);
});

test('neue Anmeldung: Anfrage erledigt, Schnuppern aktiv, Rest offen', () => {
  assert.deepEqual(zustaende(neu), ['erledigt', 'aktiv', 'offen', 'offen', 'offen']);
  assert.deepEqual(infos(neu), ['02.05.2026', '0 von 2 Einheiten', null, null, null]);
  // Eingang als Date (wie aus der Datenbank) und kurz nach Mitternacht Berliner Zeit
  assert.equal(prozessSchritte({ ...neu, eingang: new Date('2026-05-02T22:30:00Z') })[0].info, '03.05.2026');
  assert.equal(prozessSchritte({ ...neu, status: 'TERMIN', einheit1: '2026-05-05' })[1].info, '1 von 2 Einheiten');
  assert.equal(prozessSchritte({ ...neu, status: 'KONTAKTIERT' })[1].zustand, 'aktiv');
});

test('Schnuppern erledigt: Status, zwei Einheiten laut Trainingszeiten oder 2. Einheit eingetragen', () => {
  assert.equal(prozessSchritte({ ...neu, status: 'ABSOLVIERT' })[1].zustand, 'erledigt');
  assert.equal(prozessSchritte({ ...neu, status: 'TERMIN', einheiten: 2 })[1].zustand, 'erledigt');
  assert.equal(prozessSchritte({ ...neu, status: 'TERMIN', einheit1: '2026-05-05', einheit2: '2026-05-12' })[1].zustand, 'erledigt');
  assert.equal(prozessSchritte({ ...neu, status: 'ABSOLVIERT', einheiten: 3 })[1].info, '3 Einheiten');
});

test('absolviert mit offenem Angebot: Vertragsangebot aktiv', () => {
  const z: ProzessEingabe = { ...neu, status: 'ABSOLVIERT', einheit1: '2026-05-05', einheit2: '2026-05-12', einheiten: 2, angebot };
  assert.deepEqual(zustaende(z), ['erledigt', 'erledigt', 'aktiv', 'offen', 'offen']);
  assert.deepEqual(infos(z), ['02.05.2026', '2 von 2 Einheiten', 'VA-2026-0007 offen bis 20.06.2026', null, null]);
});

test('abgelaufenes bzw. zurückgezogenes Angebot: abgebrochen', () => {
  const z: ProzessEingabe = { ...neu, status: 'ABSOLVIERT', einheiten: 2, angebot: { ...angebot, abgelaufen: true } };
  assert.deepEqual(zustaende(z), ['erledigt', 'erledigt', 'abgebrochen', 'offen', 'offen']);
  assert.equal(prozessSchritte(z)[2].info, 'VA-2026-0007 abgelaufen am 20.06.2026');
  const r = prozessSchritte({ ...z, angebot: { ...angebot, status: 'ZURUECKGEZOGEN' } })[2];
  assert.deepEqual([r.zustand, r.info], ['abgebrochen', 'VA-2026-0007 zurückgezogen']);
});

test('Antrag in Prüfung: Angebot angenommen, Mitgliedsantrag aktiv', () => {
  const z: ProzessEingabe = {
    ...neu, status: 'ABSOLVIERT', einheiten: 2, angebot: { ...angebot, status: 'ANGENOMMEN', antrag: 'MA-2026-0004' },
    antrag_nr: 'MA-2026-0004', antrag_status: 'EINGANG',
  };
  assert.deepEqual(zustaende(z), ['erledigt', 'erledigt', 'erledigt', 'aktiv', 'offen']);
  assert.deepEqual(infos(z).slice(2), ['VA-2026-0007 angenommen', 'MA-2026-0004 in Prüfung', null]);
  // Antrag über den Beitrittslink, ohne Angebot
  const b = prozessSchritte({ ...neu, status: 'TERMIN', einheiten: 1, antrag_nr: 'MA-2026-0005', antrag_status: 'EINGANG' });
  assert.deepEqual(b.map((s) => s.zustand), ['erledigt', 'aktiv', 'erledigt', 'aktiv', 'offen']);
  assert.equal(b[2].info, 'ohne Angebot (Beitrittslink)');
  // abgelehnter Antrag
  const a = prozessSchritte({ ...z, antrag_status: 'ABGELEHNT' })[3];
  assert.deepEqual([a.zustand, a.info], ['abgebrochen', 'MA-2026-0004 abgelehnt']);
});

test('Mitglied: alle Schritte erledigt, Mitgliedsnummer als Info', () => {
  const z: ProzessEingabe = {
    ...neu, status: 'MITGLIED', einheiten: 2, mitglnrn: '1234', angebot: { ...angebot, status: 'ANGENOMMEN', antrag: 'MA-2026-0004' },
    antrag_nr: 'MA-2026-0004', antrag_status: 'UEBERNOMMEN',
  };
  assert.deepEqual(zustaende(z), ['erledigt', 'erledigt', 'erledigt', 'erledigt', 'erledigt']);
  assert.deepEqual(infos(z).slice(3), ['MA-2026-0004 übernommen', 'Nr. 1234']);
  // Beitritt ohne Angebot und ohne eingetragene Einheiten: trotzdem alles erledigt
  const o = prozessSchritte({ ...neu, status: 'MITGLIED', antrag_nr: 'MA-2026-0006', antrag_status: 'UEBERNOMMEN' });
  assert.ok(o.every((s) => s.zustand === 'erledigt'));
  assert.deepEqual([o[2].info, o[4].info], ['ohne Angebot (Beitrittslink)', null]);
});

test('abgesagt: alle noch nicht erledigten Schritte abgebrochen', () => {
  assert.deepEqual(zustaende({ ...neu, status: 'ABGESAGT' }), ['erledigt', 'abgebrochen', 'abgebrochen', 'abgebrochen', 'abgebrochen']);
  // nach zwei Einheiten abgesagt, das offene Angebot zählt nicht mehr
  const z: ProzessEingabe = { ...neu, status: 'ABGESAGT', einheit1: '2026-05-05', einheit2: '2026-05-12', angebot };
  assert.deepEqual(zustaende(z), ['erledigt', 'erledigt', 'abgebrochen', 'abgebrochen', 'abgebrochen']);
  assert.equal(prozessSchritte(z)[2].info, 'VA-2026-0007 offen bis 20.06.2026');
});
