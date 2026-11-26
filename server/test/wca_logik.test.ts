/**
 * WCA Zeitenkontrolle: Fachlogik ohne Datenbank – Tempo-CSV lesen, Feiertage, Ableitungen, Prüfregeln,
 * Personensummen und das Rechenbeispiel aus der Spezifikation (anonymisierter Teamreport November 2026).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stundenLesen, tagesSpalte, tempoCsvLesen } from '../../modules/wca/server/logik/csv.js';
import { feiertageBerechnet, feiertageManuell, ostersonntag } from '../../modules/wca/server/logik/feiertage.js';
import { auswerten, imZeitraumTag, teamKurz, typAbleiten, zeitraeumeLesen, type AuswertungEingabe } from '../../modules/wca/server/logik/auswertung.js';
import { einstellungenErgaenzen, REGELN, STANDARD_EINSTELLUNGEN } from '../../modules/wca/server/logik/standard.js';
import { textAnalyse, allgemeinPruefer, regelwerkAnalyse } from '../../modules/wca/server/logik/text.js';
import { isoWocheId } from '../../modules/wca/server/logik/datum.js';
import type { Einstellungen, PersonVorgabe, RohEintrag } from '../../modules/wca/server/typen.js';

const FIXTURE = readFileSync(fileURLToPath(new URL('./fixtures/wca/teamreport_nov26.csv', import.meta.url)), 'utf8');

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

test('Parser: Teamreport November 2026 – 29 Einträge, 1 Person, Kontrollsumme ohne Warnung', () => {
  const r = tempoCsvLesen(FIXTURE, 'teamreport_nov26.csv');
  assert.equal(r.eintraege.length, 29);
  assert.deepEqual(r.personen, ['Max Muster']);
  assert.equal(r.summen['Max Muster'], 80);
  assert.deepEqual(r.warnungen, []);
  assert.equal(r.tage.length, 30);
  assert.equal(r.tage[0], '2026-11-01');
  assert.equal(r.tage[29], '2026-11-30');
  assert.ok(r.hatAccount && r.hatTeam && r.hatBereich);
  assert.deepEqual(r.berKeys, {
    'WDE Internal Projects': 'WDEINT001',
    'ATG Absences': 'ATGABS',
    'WDE - Presales': 'WDEPRESAL001',
    'WDE - Nordwerk SAP Business Technology Platform': 'WDENORDWERKS4HCTM001',
    'Walldorf Consulting Managed Services': 'WCMS',
  });
  assert.equal(r.accKeys['Training - Internal Training|Walldorf Consulting GmbH internal'], 'WDEINTADM001.1.9_I000_SAP_I');
  assert.equal(r.accKeys['Nordwerk SAP Business Technology Platform|Nordwerk Group GmbH'], 'NORDWERKS4HCTM001.1.1_T000_SAP_C');
  const e1 = r.eintraege[0];
  assert.equal(e1.text, 'ASP LEarning Joule Studio Developer Certification');
  assert.equal(e1.key, 'WDEINT001-37');
  assert.deepEqual(e1.tage, [['2026-11-11', 8]]);
  const summe = r.eintraege.reduce((n, e) => n + e.tage.reduce((m, t) => m + t[1], 0), 0);
  assert.equal(summe, 80);
  assert.ok(r.eintraege.every((e) => e.tage.length === 1));
  // Feld mit Komma in Anführungszeichen
  assert.ok(r.eintraege.some((e) => e.text === 'LDH Support bzgl EN,IS,SE Integration'));
});

test('Parser: Typ-Ableitung A/P/B/I', () => {
  const r = tempoCsvLesen(FIXTURE, 'x.csv');
  const typ = (text: string) => {
    const e = r.eintraege.find((x) => x.text === text)!;
    const acc = e.acc.split('|')[0].trim();
    const pre = /^([A-Z][A-Z0-9_]+)-\d+$/.exec(e.key)?.[1] ?? '';
    return typAbleiten(e.kat, acc, pre, e.text);
  };
  assert.equal(typ('Absence: Unplanned [1342859594] approved'), 'A');
  assert.equal(typ('FNT Custom object anlegen und Badi Programmierung'), 'P');
  assert.equal(typ('Nordwerk Q System aufbauen DRC'), 'B');
  assert.equal(typ('Zeiten buchen'), 'I');
  assert.equal(typAbleiten('Intern', 'Training', 'ATGABS', 'x'), 'A');
  assert.equal(typAbleiten('Billable', 'Projekt', 'ABC', 'x'), 'B');
  assert.equal(typAbleiten('Intern', 'Presales Kunde', '', 'x'), 'P');
});

test('Parser: Kontrollsumme weicht ab → Warnung', () => {
  const r = tempoCsvLesen(FIXTURE.replace(',Max Muster,,,,,,,,80h,,8h,', ',Max Muster,,,,,,,,81h,,9h,'), 'abw.csv');
  assert.deepEqual(r.warnungen, ['abw.csv: Max Muster: Σ 80 h ≠ 81 h']);
});

test('Parser: Formatvarianten – Semikolon, 01.11.26, ISO, TT/MM/JJJJ, 1h 30m, englische Spalten', () => {
  const de = tempoCsvLesen(
    'Benutzer;Kategorietyp;Account;Team;Zeitnachweis;Schlüssel;01.11.26;02.11.2026\n'
    + 'Erika Beispiel;Abrechenbar;Projekt|Kunde AG;WCA | Team A (#T-1);Konzept erstellt;ABC-1;1h 30m;\n'
    + 'Erika Beispiel;Intern;Admin;WCA | Team A (#T-1);Mails;;;"0,5"\n',
    'de.csv',
  );
  assert.equal(de.eintraege.length, 2);
  assert.deepEqual(de.eintraege[0].tage, [['2026-11-01', 1.5]]);
  assert.deepEqual(de.eintraege[1].tage, [['2026-11-02', 0.5]]);
  assert.equal(de.eintraege[0].acc, 'Projekt|Kunde AG');
  assert.deepEqual(de.warnungen, []);
  assert.equal(de.hatBereich, false);

  const en = tempoCsvLesen(
    'User,Category Type,Project Name,Account,Team,Jira Project,Description,Issue Key,2026-11-02,03/11/2026\n'
    + 'John Example,Billable,P1,Support|Client Ltd,Team B,Client Support,Fixed invoice output,CS-12,2h,90m\n',
    'en.csv',
  );
  assert.equal(en.eintraege.length, 1);
  const e = en.eintraege[0];
  assert.equal(e.person, 'John Example');
  assert.equal(e.kat, 'Billable');
  assert.equal(e.ber, 'Client Support');
  assert.equal(e.key, 'CS-12');
  assert.deepEqual(e.tage, [['2026-11-02', 2], ['2026-11-03', 1.5]]);

  const ohne = tempoCsvLesen('Benutzer,Zeitnachweis,01/Nov./26\nErika,Text,1h\n', 'ohne.csv');
  assert.deepEqual(ohne.warnungen, [
    'ohne.csv: keine Spalte Account – Kontierungsprüfungen eingeschränkt.',
    'ohne.csv: keine Spalte Team – Personen stehen unter „Ohne Team“.',
  ]);

  assert.equal(tagesSpalte('01/Nov./26'), '2026-11-01');
  assert.equal(tagesSpalte('01/März/26'), '2026-03-01');
  assert.equal(tagesSpalte('1-Nov-2026'), '2026-11-01');
  assert.equal(tagesSpalte('01 Dec 26'), '2026-12-01');
  assert.equal(tagesSpalte('31.02.26'), null);
  assert.equal(tagesSpalte('Erfasst'), null);
  assert.equal(stundenLesen('8h'), 8);
  assert.equal(stundenLesen('0.5h'), 0.5);
  assert.equal(stundenLesen('1,5'), 1.5);
  assert.equal(stundenLesen('90m'), 1.5);
  assert.equal(stundenLesen(''), 0);
});

test('Parser: leere oder fremde Datei → Fehler', () => {
  assert.throws(() => tempoCsvLesen('', 'leer.csv'), /Datei ist leer/);
  assert.throws(() => tempoCsvLesen('﻿  \n', 'leer.csv'), /Datei ist leer/);
  assert.throws(() => tempoCsvLesen('Name,Betrag\nA,1\n', 'fremd.csv'), /keine Tempo-Ansicht/);
  assert.throws(() => tempoCsvLesen('Benutzer,Text\nA,b\n', 'ohnetage.csv'), /keine Tempo-Ansicht/);
});

// ---------------------------------------------------------------------------
// Feiertage, Hilfen
// ---------------------------------------------------------------------------

test('Feiertage: Ostern, Bundesländer, AT/LV/LT, manuell', () => {
  assert.equal(ostersonntag(2026), '2026-04-05');
  assert.equal(ostersonntag(2025), '2025-04-20');
  assert.equal(ostersonntag(2024), '2024-03-31');
  const bw = feiertageBerechnet('DE', 2026, 'BW');
  const tage = (l: { tag: string }[]) => l.map((x) => x.tag);
  assert.ok(tage(bw).includes('2026-04-03'), 'Karfreitag');
  assert.ok(tage(bw).includes('2026-04-06'), 'Ostermontag');
  assert.ok(tage(bw).includes('2026-05-14'), 'Christi Himmelfahrt');
  assert.ok(tage(bw).includes('2026-06-04'), 'Fronleichnam BW');
  assert.equal(bw.find((x) => x.tag === '2026-11-01')?.name, 'Allerheiligen');
  assert.ok(!tage(bw).includes('2026-11-18'));
  const sn = feiertageBerechnet('DE', 2026, 'SN');
  assert.equal(sn.find((x) => x.tag === '2026-11-18')?.name, 'Buß- und Bettag');
  assert.ok(tage(sn).includes('2026-10-31') && !tage(sn).includes('2026-11-01'));
  assert.ok(tage(feiertageBerechnet('DE-BY', 2026, 'BW')).includes('2026-01-06'));
  assert.ok(tage(feiertageBerechnet('AT', 2026, '')).includes('2026-10-26'));
  assert.ok(tage(feiertageBerechnet('LV', 2025, '')).includes('2025-05-05'), '4.5. am Sonntag → Montag');
  assert.ok(tage(feiertageBerechnet('LT', 2026, '')).includes('2026-07-06'));
  assert.ok(tage(feiertageBerechnet('ES', 2026, '')).includes('2026-10-12'));
  assert.deepEqual(feiertageBerechnet('MY', 2026, ''), []);
  assert.deepEqual(feiertageManuell('* 2026-12-24 Heiligabend\nLV 2026-11-19\nquatsch'), [
    { standort: '*', tag: '2026-12-24', name: 'Heiligabend' },
    { standort: 'LV', tag: '2026-11-19', name: 'Feiertag (manuell)' },
  ]);
});

test('Hilfen: Team kürzen, ISO-Woche, Textanalyse, Einstellungen ergänzen', () => {
  assert.equal(teamKurz('WCA | Cloud Purchasing (#v2-T-6122480)'), 'Cloud Purchasing');
  assert.equal(teamKurz('WCA | Team A (#T-1)'), 'Team A');
  assert.equal(teamKurz(''), 'Ohne Team');
  assert.equal(isoWocheId('2026-11-20'), '2026-W47');
  assert.equal(isoWocheId('2027-01-01'), '2026-W53');
  const an = textAnalyse('SAP Ticket Certification', new Set(['max']), allgemeinPruefer(''));
  assert.deepEqual([an.words, an.spec, an.names], [3, 0, 0]);
  const name = textAnalyse('Max Meeting', new Set(['max']), allgemeinPruefer(''));
  assert.deepEqual([name.words, name.spec, name.names], [2, 0, 1]);
  const e = einstellungenErgaenzen({ toleranz: 0.5, wortRegeln: { F_ton: { woerter: 'mist' } } as unknown as Einstellungen['wortRegeln'] });
  assert.equal(e.toleranz, 0.5);
  assert.equal(e.bundesland, 'BW');
  assert.equal(e.wortRegeln.F_ton.woerter, 'mist');
  assert.equal(e.wortRegeln.F_ton.stufeBillable, 2);
  assert.ok(e.wortRegeln.F_pauschal);
  assert.deepEqual(einstellungenErgaenzen(null), STANDARD_EINSTELLUNGEN);
  assert.ok(REGELN.every((r) => r.name && r.erkennung && r.tipp));
});

// ---------------------------------------------------------------------------
// Rechenbeispiel (Spezifikation Abschnitt 6)
// ---------------------------------------------------------------------------

/** Rechenbeispiel wie in der Spezifikation V3: ohne AMS-Ausnahme bei R2 (eigener Test unten) */
const FIXTURE_EINST: Einstellungen = { ...STANDARD_EINSTELLUNGEN, regelwerkOhneIdMuster: '' };

function fixtureAuswerten(o: Partial<AuswertungEingabe> = {}) {
  const r = tempoCsvLesen(FIXTURE, 'teamreport_nov26.csv');
  return auswerten({
    eintraege: r.eintraege, accKeys: r.accKeys, berKeys: r.berKeys, dateien: 1, einstellungen: FIXTURE_EINST,
    vorgaben: [], heute: '2026-11-20', stichtag: '2026-11-20', zeitraum: '2026-11', ...o,
  });
}

test('Rechenbeispiel: Summen, Ableitungen und Tagesstatus (Stichtag 20.11.2026, November)', () => {
  const a = fixtureAuswerten();
  assert.equal(a.stichtag, '2026-11-20');
  assert.deepEqual(a.zeitraum, { id: '2026-11', text: 'November 2026', von: '2026-11-01', bis: '2026-11-30' });
  assert.equal(a.accountPflichtAb, '2026-11-01');
  assert.equal(a.personen.length, 1);
  const p = a.personen[0];
  assert.equal(p.team, 'Cloud Purchasing');
  assert.equal(p.standort, 'DE');
  assert.equal(p.sollTag, 8);
  assert.deepEqual(p.arbeitstage, [0, 1, 2, 3, 4]);
  assert.equal(p.von, '2026-11-02');
  assert.equal(p.bis, null);
  assert.equal(p.letzteBuchung, '2026-11-13');
  assert.equal(p.soll, 120);
  assert.equal(p.ist, 80);
  assert.equal(p.offen, 40);
  assert.equal(p.fehltage, 5);
  assert.equal(p.sollTage, 15);
  assert.equal(p.vollstaendig, false);
  assert.deepEqual([p.B, p.P, p.I, p.A], [19.5, 2, 50.5, 8]);
  assert.equal(Math.round(p.billableQuote! * 1000), 271);
  assert.equal(Math.round(p.utilization! * 1000), 299); // (19,5 + 2) / 72
  const st = (s: string) => p.tageStatus.filter((t) => t.status === s).map((t) => t.tag.slice(8));
  assert.equal(p.tageStatus.length, 30);
  assert.equal(st('vollstaendig').length, 9);
  assert.deepEqual(st('abwesend'), ['05']);
  assert.deepEqual(st('fehlt'), ['16', '17', '18', '19', '20']);
  assert.deepEqual(st('ausserhalb'), ['01']);
  assert.equal(st('zukunft').length, 10);
  assert.ok(p.tageStatus.filter((t) => t.status === 'fehlt').every((t) => t.offen === 8));
  assert.deepEqual(a.feiertage.map((f) => [f.tag, f.name]), [['2026-11-01', 'Allerheiligen']]);
  assert.equal(a.eintraege.length, 29);
  assert.equal(a.zeitraeume[0].id, '2026-11');
  assert.ok(a.zeitraeume.some((z) => z.id === '2026-W47' && z.text === 'KW 47 (16.11.–22.11.)'));
  assert.equal(a.zeitraeume[a.zeitraeume.length - 1].id, 'alle');
});

test('Rechenbeispiel: Funde – nur T3 (Niedrig), R1 und R2; keine Kontierungsfunde', () => {
  const a = fixtureAuswerten();
  const p = a.personen[0];
  const anzahl = (regel: string, stufe?: number) => a.gruppen.flatMap((g) => g.funde).filter((f) => f.regel === regel && (!stufe || f.stufe === stufe)).length;
  assert.equal(a.gruppen.flatMap((g) => g.funde).filter((f) => f.kategorie === 'K' || f.kategorie === 'P').length, 0);
  assert.equal(anzahl('T3', 1), 4);
  assert.equal(anzahl('R1', 1), 8);
  assert.equal(anzahl('R1', 2), 2);
  assert.equal(anzahl('R2', 2), 8);
  assert.equal(a.gruppen.flatMap((g) => g.funde).length, 22);
  const t3 = a.gruppen.filter((g) => g.funde.some((f) => f.regel === 'T3')).map((g) => a.eintraege[g.eintrag!].text).sort();
  assert.deepEqual(t3, ['SAP Ticket Certification', 'Zeiten Buchen + Organisation Buchungskonten', 'Zeiten buchen', 'Zeiten buchen']);
  // Stufenfilter ab Mittel: 8 Gruppen mit 10 Einzelfehlern; ab Niedrig: 16 Gruppen
  const mittel = a.gruppen.filter((g) => g.funde.some((f) => f.stufe >= 2));
  assert.equal(mittel.length, 8);
  assert.equal(mittel.flatMap((g) => g.funde.filter((f) => f.stufe >= 2)).length, 10);
  assert.equal(a.gruppen.length, 16);
  assert.deepEqual(p.kontierung, [0, 0, 0, 0]);
  assert.deepEqual(p.texte, [4, 4, 0, 0]);
  assert.deepEqual(p.regelwerk, [16, 8, 8, 0]);
  assert.equal(p.eintraegeZeitraum, 28);
  assert.equal(Math.round(p.texteUnauffaellig! * 100), 86);
  const r1 = a.gruppen.find((g) => a.eintraege[g.eintrag!].text === 'SAP-BTP-DRC Teil 3 + Vorbereitung')!;
  assert.deepEqual(r1.funde.map((f) => f.meldung).sort(), ['3 Worte (mindestens 5).', 'Text beginnt nicht mit „<ID>: “.']);
  // Regeltermine sind vom Regelwerk ausgenommen
  const regeltermin = a.eintraege.findIndex((x) => x.text === 'SAP-BTP Regeltermin Nordwerk/WCA');
  assert.ok(!a.gruppen.some((g) => g.eintrag === regeltermin));
  const info = (id: string) => a.regeln.find((r) => r.id === id)!;
  assert.deepEqual([info('T3').anzahl, info('R1').anzahl, info('R2').anzahl, info('K1').anzahl], [4, 10, 8, 0]);
  assert.equal(info('R2').stunden, 19);
  // mit Standard-Einstellungen (AMS-Muster WCMS) entfallen die R2-Funde auf WCMS-Tickets
  const std = fixtureAuswerten({ einstellungen: STANDARD_EINSTELLUNGEN });
  const r2 = std.gruppen.flatMap((g) => g.funde.filter((f) => f.regel === 'R2').map(() => std.eintraege[g.eintrag!].key));
  assert.equal(r2.length, 4);
  assert.ok(r2.every((k) => !k.startsWith('WCMS-')));
});

test('Rechenbeispiel: Rückfrage-Text', () => {
  const p = fixtureAuswerten().personen[0];
  const t = p.rueckfrage;
  assert.ok(t.startsWith('Hallo Max,\n\nbei der Prüfung deiner Zeiterfassung (01.11.2026–20.11.2026, Stand 20.11.2026) sind mir folgende Punkte aufgefallen:'));
  assert.ok(t.includes('Fehlende Zeiten:\n- Mo 16.11.: 8 h offen\n- Di 17.11.: 8 h offen\n- Mi 18.11.: 8 h offen\n- Do 19.11.: 8 h offen\n- Fr 20.11.: 8 h offen'));
  assert.ok(!t.includes('Kontierung:'));
  assert.ok(t.includes('- Mi 04.11. · 2 h · Nordwerk SAP Business Technology Platform (WDENORDWERKS4HCTM001-2) · „Cloud Connector Abstimmung DRC Nordwerk“\n    → Text beginnt nicht mit „<ID>: “. Format „<ID>: Beschreibung mit mehr als fünf Wörtern“.'));
  assert.equal((t.match(/^- \S+ \d\d\.\d\d\. · /gm) ?? []).length, 8);
  assert.ok(t.trimEnd().endsWith('Danke dir!'));
});

test('Rechenbeispiel: Default-Stichtag (heute 20.11.) → Do 19.11.; Soll 112, Offen 32, 4 Fehltage', () => {
  const a = fixtureAuswerten({ stichtag: undefined, zeitraum: undefined, datenBereich: { von: '2026-11-01', bis: '2026-11-30' } });
  assert.equal(a.stichtagVorschlag, '2026-11-19');
  assert.equal(a.stichtag, '2026-11-19');
  assert.equal(a.zeitraum.id, '2026-11');
  const p = a.personen[0];
  assert.deepEqual([p.soll, p.ist, p.offen, p.fehltage], [112, 80, 32, 4]);
  // ohne Datenbereich endet der Vorschlag am letzten Buchungstag
  assert.equal(fixtureAuswerten({ stichtag: undefined }).stichtagVorschlag, '2026-11-13');
});

// ---------------------------------------------------------------------------
// Einzelne Regeln mit konstruierten Einträgen
// ---------------------------------------------------------------------------

const INTERN_ACC = 'Admin - Others|Walldorf Consulting GmbH internal';
const KUNDE_ACC = 'Servicemanagement|Kunde Alpha GmbH';

function e(o: Partial<RohEintrag> = {}): RohEintrag {
  return {
    person: 'Erika Beispiel', kat: 'Intern', proj: '', acc: INTERN_ACC, team: 'WCA | Team A (#v2-T-1)', ber: 'WDE Internal Projects',
    text: 'Konzept Schnittstelle Lieferavis überarbeitet und abgestimmt', key: 'WDEINT001-1', zeile: 2, tage: [['2026-11-02', 8]], ...o,
  };
}
const bill = (o: Partial<RohEintrag> = {}) => e({ kat: 'Abrechenbar', acc: KUNDE_ACC, ber: 'Managed Services', key: 'WCMS-5', text: 'WCMS-5: Lieferavis Schnittstelle Mapping angepasst und getestet', ...o });

function lauf(eintraege: RohEintrag[], o: { einst?: Partial<Einstellungen>; vorgaben?: PersonVorgabe[]; stichtag?: string } = {}) {
  return auswerten({
    eintraege, accKeys: {}, berKeys: { 'WDE Internal Projects': 'WDEINT001' }, dateien: 1,
    einstellungen: einstellungenErgaenzen(o.einst ?? null), vorgaben: o.vorgaben ?? [], heute: '2026-11-20',
    stichtag: o.stichtag ?? '2026-11-06', zeitraum: '2026-11',
  });
}
const funde = (a: ReturnType<typeof auswerten>, regel: string) => a.gruppen.flatMap((g) => g.funde).filter((f) => f.regel === regel);

test('Regel K1: Error-Account', () => {
  const a = lauf([e({ acc: 'Unknown - please review', key: 'ABC-1' })]);
  const f = funde(a, 'K1');
  assert.equal(f.length, 1);
  assert.equal(f[0].stufe, 3);
  assert.equal(f[0].meldung, 'Account „Unknown - please review“ ist ein Error-Account – auf den richtigen Account umbuchen.');
  assert.equal(f[0].stunden, 8);
  assert.ok(f[0].tipp.startsWith('Auf den richtigen Account umbuchen'));
  assert.equal(funde(lauf([e({ acc: 'ATG-Clean Up Account|x' })]), 'K1').length, 1);
});

test('Regel K2: kein Account ab Account-Pflicht', () => {
  const a = lauf([e({ acc: '' })], { einst: { accountPflichtAb: '2026-11-01' } });
  assert.equal(funde(a, 'K2').length, 1);
  assert.equal(funde(lauf([e({ acc: '' })], { einst: { accountPflichtAb: '2026-12-01' } }), 'K2').length, 0);
});

test('Regel K3: Ticket auf mehreren Accounts mit anderem Kunden', () => {
  const a = lauf([
    bill({ tage: [['2026-11-02', 6]] }),
    bill({ tage: [['2026-11-03', 6]] }),
    bill({ acc: 'Servicemanagement|Kunde Beta GmbH', tage: [['2026-11-04', 2]] }),
  ]);
  const f = funde(a, 'K3');
  assert.equal(f.length, 1);
  assert.equal(f[0].stufe, 3);
  assert.equal(f[0].meldung, 'Ticket WCMS-5 läuft sonst auf „Servicemanagement | Kunde Alpha GmbH“ (12 h) – anderer Kunde.');
  assert.equal(a.eintraege[f[0].eintrag!].kunde, 'Kunde Beta GmbH');
});

test('Regel K6: Urlaub auf Arbeitskonto (abrechenbar Hoch, sonst Mittel)', () => {
  const i = funde(lauf([e({ text: 'Urlaub' })]), 'K6');
  assert.equal(i.length, 1);
  assert.equal(i[0].stufe, 2);
  assert.equal(i[0].meldung, 'Text enthält „Urlaub“, gebucht auf Arbeitskonto „Admin - Others“.');
  assert.equal(funde(lauf([bill({ text: 'Arzttermin' })]), 'K6')[0].stufe, 3);
  assert.equal(funde(lauf([e({ text: 'Übergabe der offenen Punkte nach Urlaub an Kollegen' })]), 'K6').length, 0, 'Ausnahme „nach Urlaub“');
});

test('Regel P1: Tag mit sehr vielen Stunden', () => {
  const a = lauf([e({ tage: [['2026-11-02', 6]] }), e({ text: 'Workshop Lieferavis Mapping Kunde vorbereitet', tage: [['2026-11-02', 5]] })]);
  const f = funde(a, 'P1');
  assert.equal(f.length, 1);
  assert.equal(f[0].stufe, 1);
  assert.equal(f[0].meldung, '11 h an einem Tag.');
  assert.equal(f[0].eintrag, null);
  assert.equal(f[0].tag, '2026-11-02');
  const g = a.gruppen.find((x) => x.funde.includes(f[0]))!;
  assert.equal(g.id, 'dErika Beispiel_2026-11-02');
  const hoch = lauf([e({ tage: [['2026-11-02', 7]] }), e({ text: 'Workshop Lieferavis Mapping Kunde vorbereitet', tage: [['2026-11-02', 6]] })]);
  assert.equal(funde(hoch, 'P1')[0].stufe, 2);
});

test('Regel P2/P3: lange Einzelbuchung, Buchung am Wochenende und Feiertag', () => {
  const a = lauf([e({ tage: [['2026-11-02', 9]] }), e({ tage: [['2026-11-07', 3]] })], { stichtag: '2026-11-09' });
  assert.equal(funde(a, 'P2')[0].meldung, '9 h in einer Buchung.');
  assert.equal(funde(a, 'P3')[0].meldung, '3 h an einem Wochenende.');
  const ft = lauf([e({ tage: [['2026-10-30', 8]] }), e({ tage: [['2026-11-03', 2]] })], { einst: { feiertage: 'DE 2026-11-03 Betriebsausflug' } });
  assert.equal(funde(ft, 'P3')[0].meldung, '2 h an Betriebsausflug.');
});

test('Regel T1: Platzhalter und leerer Text', () => {
  const p = funde(lauf([e({ text: 'tbd' })]), 'T1');
  assert.equal(p.length, 1);
  assert.equal(p[0].meldung, 'Platzhalter „tbd“.');
  assert.equal(p[0].stufe, 2);
  assert.equal(funde(lauf([bill({ text: 'dito' })]), 'T1')[0].stufe, 3);
  assert.equal(funde(lauf([e({ text: '' })]), 'T1')[0].meldung, 'Kein Text.');
});

test('Regel T2/T3/T9: nur IDs, nur Allgemeinbegriffe, nur Personenname', () => {
  assert.equal(funde(lauf([e({ text: 'WCMS-17' })]), 'T2').length, 1);
  const t3 = funde(lauf([bill({ text: 'Meeting und Abstimmung', tage: [['2026-11-02', 4]] })]), 'T3');
  assert.equal(t3[0].stufe, 3, 'abrechenbar + ≥ 4 h');
  assert.equal(funde(lauf([e({ text: 'Abstimmung Ole' })]), 'T9').length, 1);
});

test('Regel T4: Kalender- oder Mailtext', () => {
  const f = funde(lauf([bill({ text: 'Hallo zusammen, anbei die Einladung zur Teams-Besprechung' })]), 'T4');
  assert.equal(f.length, 1);
  assert.equal(f[0].stufe, 3);
  assert.equal(f[0].meldung, 'Einladungs- oder Mailtext statt Tätigkeitsbeschreibung.');
});

test('Regel T6: gleicher Text an vielen Tagen', () => {
  const tage = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
  const a = lauf(tage.map((t) => e({ tage: [[t, 2]] })));
  const f = funde(a, 'T6');
  assert.equal(f.length, 5);
  assert.equal(f[0].meldung, 'Gleicher Text an 5 Tagen (10 h).');
  assert.equal(f[0].stufe, 1);
  assert.equal(funde(lauf(tage.map((t) => e({ text: 'Daily Standup Projekt Lieferavis', tage: [[t, 2]] }))), 'T6').length, 0, 'Regeltermin');
});

test('Regel R2 und abgeschaltete Regel', () => {
  const ohneId = bill({ key: 'ALPHA-5', text: 'Lieferavis Schnittstelle Mapping angepasst und getestet' });
  const a = lauf([ohneId, bill({ key: 'ALPHA-5', text: 'ALPHA-5: Lieferavis Schnittstelle Mapping angepasst und getestet' })]);
  const f = funde(a, 'R2');
  assert.equal(f.length, 1);
  assert.equal(a.eintraege[f[0].eintrag!].text, 'Lieferavis Schnittstelle Mapping angepasst und getestet');
  assert.equal(funde(a, 'R1').length, 0);
  const aus = lauf([ohneId], { einst: { aus: { R2: true } } });
  assert.equal(funde(aus, 'R2').length, 0);
  assert.equal(aus.regeln.find((r) => r.id === 'R2')!.aktiv, false);
  assert.equal(funde(lauf([ohneId], { einst: { regelwerkAb: '2026-12-01' } }), 'R2').length, 0, 'vor Gültigkeit');
});

test('Regel R2: lockere ID-Schreibweisen', () => {
  const rest = 'Lieferavis Schnittstelle Mapping angepasst und getestet';
  for (const kopf of ['ALPHA-5: ', 'ALPHA-5 ', '<ALPHA-5> ', '<ALPHA-5>: ', '<<ALPHA-5>> ', '[ALPHA-5] – ', '(ALPHA-5) ', 'ALPHA-5 - ', 'ALPHA-5 | ', 'ALPHA-5, ALPHA-6: ', 'INC123456 ']) {
    const r = regelwerkAnalyse(kopf + rest);
    assert.equal(r.lead, true, kopf);
    assert.equal(r.wc, 6, kopf);
  }
  for (const t of [rest, 'SAP-BTP-DRC Teil 3 + Vorbereitung', 'ALPHA5 Mapping angepasst', 'Q1-Planung Mapping angepasst']) {
    assert.equal(regelwerkAnalyse(t).lead, false, t);
  }
  const a = lauf([bill({ key: 'ALPHA-5', text: '<<ALPHA-5>> ' + rest })]);
  assert.equal(funde(a, 'R2').length, 0);
});

test('Regel R2: AMS-Tickets (Muster „Ohne ID-Pflicht“) brauchen keine ID am Anfang', () => {
  const text = 'Lieferavis Schnittstelle Mapping angepasst und getestet';
  assert.equal(funde(lauf([bill({ key: 'WCMS-5', text })]), 'R2').length, 0, 'Standard WCMS');
  assert.equal(funde(lauf([bill({ key: 'WCMS-5', text })], { einst: { regelwerkOhneIdMuster: '' } }), 'R2').length, 1, 'Muster leer');
  assert.equal(funde(lauf([bill({ key: 'ALPHA-5', text })], { einst: { regelwerkOhneIdMuster: 'AL*' } }), 'R2').length, 0, 'eigenes Muster');
  assert.equal(funde(lauf([bill({ key: 'ALPHA-5', text })]), 'R2').length, 1, 'kein AMS-Ticket');
  // R1 (Wortzahl) gilt für AMS-Tickets weiterhin
  assert.equal(funde(lauf([bill({ key: 'WCMS-5', text: 'Mapping angepasst' })]), 'R1').length, 1);
});

test('Regel F_*: Wortlisten (nur abrechenbar, eigene Wortliste)', () => {
  assert.equal(funde(lauf([e({ text: 'Zeiten buchen für Projekt Lieferavis Schnittstelle' })]), 'F_intern').length, 0);
  const f = funde(lauf([bill({ text: 'WCMS-5: Zeiten buchen für Projekt Lieferavis Schnittstelle' })]), 'F_intern');
  assert.equal(f.length, 1);
  assert.equal(f[0].meldung, '„Zeiten buchen“ lädt zu Rückfragen ein.');
  const eigen = lauf([e({ text: 'Konzept Lieferavis Murks beseitigt und dokumentiert' })], {
    einst: { wortRegeln: { F_ton: { ...STANDARD_EINSTELLUNGEN.wortRegeln.F_ton, woerter: 'murks*' } } },
  });
  assert.equal(funde(eigen, 'F_ton')[0].meldung, '„Murks“ lädt zu Rückfragen ein.');
});

test('Personenvorgabe: Soll 4 h je Tag, Ausblenden, Arbeitstage', () => {
  const daten = [e({ tage: [['2026-11-02', 4]] }), e({ tage: [['2026-11-03', 4]] })];
  const ohne = lauf(daten, { stichtag: '2026-11-04' }).personen[0];
  assert.equal(ohne.sollTag, 8);
  assert.deepEqual([ohne.soll, ohne.offen, ohne.fehltage], [24, 16, 3]);
  const v: PersonVorgabe = { person: 'Erika Beispiel', standort: null, sollTag: 4, arbeitstage: null, von: null, bis: null, ausblenden: false };
  const mit = lauf(daten, { stichtag: '2026-11-04', vorgaben: [v] }).personen[0];
  assert.equal(mit.sollTag, 4);
  assert.deepEqual([mit.soll, mit.ist, mit.offen, mit.fehltage], [12, 8, 4, 1]);
  assert.equal(mit.tageStatus.find((t) => t.tag === '2026-11-02')!.status, 'vollstaendig');
  assert.equal(mit.tageStatus.find((t) => t.tag === '2026-11-04')!.status, 'fehlt');
  const tage = lauf(daten, { stichtag: '2026-11-04', vorgaben: [{ ...v, arbeitstage: [0, 1] }] }).personen[0];
  assert.deepEqual([tage.soll, tage.offen], [8, 0]);
  assert.equal(tage.tageStatus.find((t) => t.tag === '2026-11-04')!.status, 'frei');
  const weg = lauf(daten, { vorgaben: [{ ...v, ausblenden: true, standort: 'at' }] }).personen[0];
  assert.equal(weg.ausgeblendet, true);
  assert.equal(weg.standort, 'AT');
  assert.equal(weg.standortAbgeleitet, 'DE');
});

test('Erkannter Feiertag: ≥ 3 aktive Personen, kaum jemand gebucht', () => {
  const personen = ['Anna Eins', 'Bert Zwei', 'Cora Drei', 'Dana Vier'];
  const tage = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09', '2026-11-11', '2026-11-12', '2026-11-13'];
  const daten = personen.flatMap((p) => tage.map((t) => e({ person: p, tage: [[t, 8]] })));
  const a = lauf(daten, { stichtag: '2026-11-13' });
  const f = a.feiertage.find((x) => x.tag === '2026-11-10');
  assert.equal(f?.quelle, 'erkannt');
  assert.ok(a.personen.every((p) => p.offen === 0 && p.tageStatus.find((t) => t.tag === '2026-11-10')!.status === 'feiertag'));
});

test('Freigabe: freigegebener Text wird für Regel und Account nicht mehr gemeldet', () => {
  const FEHL = 'Unknown - please review';
  const roh = [
    e({ acc: FEHL, key: 'FRG-1', text: 'Freigabe  Testtext Lieferavis', tage: [['2026-11-02', 4]] }),
    e({ acc: FEHL, key: 'FRG-2', text: 'Anderer Text zur Freigabe Lieferavis', tage: [['2026-11-03', 4]] }),
    e({ acc: 'Unknown - please review|Kunde Gamma', key: 'FRG-3', text: 'Freigabe Testtext Lieferavis', tage: [['2026-11-04', 4]] }),
  ];
  const vorher = lauf(roh);
  const k1 = funde(vorher, 'K1');
  assert.equal(k1.length, 3);
  assert.ok(k1.every((f) => f.freigebbar));
  assert.equal(vorher.freigegeben, 0);
  assert.equal(vorher.eintraege.find((x) => x.key === 'FRG-1')?.acc, FEHL);

  // Groß-/Kleinschreibung und Leerzeichen egal; nur gleiche Regel, gleicher Account, gleicher Text
  const nachher = auswerten({
    eintraege: roh, accKeys: {}, berKeys: { 'WDE Internal Projects': 'WDEINT001' }, dateien: 1, einstellungen: einstellungenErgaenzen(null),
    vorgaben: [], heute: '2026-11-20', stichtag: '2026-11-06', zeitraum: '2026-11',
    freigaben: [{ regel: 'K1', acc: ` ${FEHL} `, text: 'freigabe testtext   LIEFERAVIS ' }, { regel: 'T1', acc: FEHL, text: 'Anderer Text zur Freigabe Lieferavis' }],
  });
  const rest = funde(nachher, 'K1');
  assert.equal(rest.length, 2);
  assert.deepEqual(rest.map((f) => nachher.eintraege[f.eintrag!].key).sort(), ['FRG-2', 'FRG-3']);
  assert.equal(nachher.freigegeben, 1);

  // Tagesfunde ohne Rückmeldung (P1) lassen sich nicht freigeben
  const p1 = funde(lauf([e({ tage: [['2026-11-02', 7]] }), e({ key: 'WDEINT001-2', tage: [['2026-11-02', 6]] })]), 'P1');
  assert.equal(p1.length, 1);
  assert.equal(p1[0].freigebbar, false);
});

// ---------------------------------------------------------------------------
// Mehrere Zeiträume
// ---------------------------------------------------------------------------

test('Zeiträume: mehrere kommagetrennt – sortiert, angrenzende verschmolzen, „alle“ umfasst alles, Ungültiges entfällt', () => {
  const z = zeitraeumeLesen('2026-11,2026-09,2026-W40', '2026-01-05', '2026-11-20')!;
  assert.equal(z.id, '2026-09,2026-W40,2026-11');
  assert.equal(z.text, 'September 2026 + KW 40 (28.09.–04.10.) + November 2026');
  assert.deepEqual(z.teile, [{ von: '2026-09-01', bis: '2026-10-04' }, { von: '2026-11-01', bis: '2026-11-30' }]);
  assert.deepEqual([z.von, z.bis], ['2026-09-01', '2026-11-30']);
  assert.ok(imZeitraumTag(z, '2026-10-04') && !imZeitraumTag(z, '2026-10-05') && imZeitraumTag(z, '2026-11-01'));
  assert.deepEqual(zeitraeumeLesen('2026-11', null, '2026-11-20'), { id: '2026-11', text: 'November 2026', von: '2026-11-01', bis: '2026-11-30' }, 'einer ohne Teile');
  assert.equal(zeitraeumeLesen('2026-10,alle', '2026-01-05', '2026-11-20')!.id, 'alle');
  assert.equal(zeitraeumeLesen('2026-11,2026-11,2026-13', null, '2026-11-20')!.id, '2026-11', 'doppelt/ungültig entfällt');
  assert.equal(zeitraeumeLesen('2026-13', null, '2026-11-20'), null);
});

test('Auswertung über zwei Wochen mit Lücke = Summe der Einzelwochen, Tage dazwischen zählen nicht', () => {
  const w45 = fixtureAuswerten({ zeitraum: '2026-W45' }).personen[0];
  const w47 = fixtureAuswerten({ zeitraum: '2026-W47' }).personen[0];
  const a = fixtureAuswerten({ zeitraum: '2026-W47,2026-W45' });
  const p = a.personen[0];
  assert.equal(a.zeitraum.id, '2026-W45,2026-W47');
  assert.deepEqual(a.zeitraum.teile, [{ von: '2026-11-02', bis: '2026-11-08' }, { von: '2026-11-16', bis: '2026-11-22' }]);
  assert.equal(p.ist, w45.ist + w47.ist);
  assert.equal(p.soll, w45.soll + w47.soll);
  assert.equal(p.offen, w45.offen + w47.offen);
  assert.equal(p.tageStatus.length, 14);
  assert.ok(!p.tageStatus.some((t) => t.tag >= '2026-11-09' && t.tag <= '2026-11-15'), 'KW 46 nicht enthalten');
  assert.ok(a.eintraege.every((x) => x.tage.every(([t]) => t < '2026-11-09' || t > '2026-11-15')));
  assert.match(p.rueckfrage, /02\.11\.2026–08\.11\.2026, 16\.11\.2026–20\.11\.2026, Stand 20\.11\.2026/);
});
