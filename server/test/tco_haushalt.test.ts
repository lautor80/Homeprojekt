/**
 * Integrationstest Haushaltsplan: Ist-Werte wie im Jahresabschluss, Vorschlag je Konto (Hochrechnung über den
 * Jahresverlauf, Sondereffekte, Fachdaten, wenig Historie), Plan anlegen und bearbeiten, Statusfolge und Nachtrag,
 * Soll-Ist, Liquidität, Vorhaben, Überwachung (Arbeitsvorrat), PDF, Einstellungen und Berechtigungen.
 *
 * Eigene Testdaten: Konten mit der Endung 91/92 und die Geschäftsjahre 2091–2097 – weit weg von allen anderen Tests.
 * „Heute“ ist in den Rechentests der 15.11.2096 (Planung im Herbst für 2097).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url.split('/').pop() ?? '')) throw new Error('TEST_DATABASE_URL fehlt oder enthält nicht "test".');
process.env.DATABASE_URL = url;
process.env.PORTAL_MODULES = 'tco';

const { sql } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { activeModules } = await import('../src/modules.js');
const { buildApp } = await import('../src/app.js');
const { withChange } = await import('../src/db.js');
const { jahreswerteLesen } = await import('../../modules/tco/server/abschluss/logik.js');
const { kontoart, geldkonten } = await import('../../modules/tco/server/finanz/logik.js');
const hh = await import('../../modules/tco/server/haushalt/logik.js');

let app: Awaited<ReturnType<typeof buildApp>>;
const db = sql as any;
const HEUTE = '2096-11-15';
const WINTER = [0.16, 0.14, 0.11, 0.06, 0.04, 0.03, 0.03, 0.03, 0.05, 0.09, 0.12, 0.14];

function client() {
  let cookie = '';
  return async (method: string, path: string, payload?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    const ct = String(res.headers['content-type'] ?? '');
    return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body, raw: res.rawPayload, ct };
  };
}
const call = client();
const H = '/api/m/tco/haushalt';
const tx = <T>(fn: (t: any) => Promise<T>) => withChange({ userId: null, username: 'test' }, fn as any) as Promise<T>;
const nah = (a: number, b: number, eps = 0.011) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);

let nr = 0;
/** Buchung mit Gegenbuchung auf dem Geldkonto 1291 (Einnahme: Haben auf dem Konto, Ausgabe: Soll) */
async function buche(konto: string, datum: string, betrag: number, o: { haben?: boolean; ohneJahr?: boolean; gegen?: string } = {}) {
  const n = `9${String(++nr).padStart(9, '0')}`;
  const j = o.ohneJahr ? null : Number(datum.slice(0, 4)), m = o.ohneJahr ? null : Number(datum.slice(5, 7));
  const haben = o.haben ?? kontoart(konto, null) === 'E';
  const gegen = o.gegen ?? '1291';
  await sql`insert into tco.fibuchungen (internenr, konto, posnr, jahr, monat, datum, text, betrag, soll, haben, gkonto)
            values (${n}, ${konto}, 0, ${j}, ${m}, ${datum}, 'Haushaltstest', ${betrag}, ${haben ? 0 : betrag}, ${haben ? betrag : 0}, ${gegen}),
                   (${n}, ${gegen}, 1, ${j}, ${m}, ${datum}, 'Haushaltstest', ${betrag}, ${haben ? betrag : 0}, ${haben ? 0 : betrag}, ${konto})`;
}
const tag = (j: number, m: number, t = 10) => `${j}-${String(m).padStart(2, '0')}-${String(t).padStart(2, '0')}`;

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'TC Oberthal', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });

  await sql`insert into tco.fikonten (konto, name, kennzahl, verrechnung) values
    ('1291', 'Testbank', 'BA', null), ('1391', 'Testdarlehen', 'BK', null),
    ('8091', 'Mitgliedsbeiträge Test', 'A1', null), ('8191', 'Spenden Test', 'A1', null), ('8391', 'Hallenmiete Test', 'C1', null),
    ('8012', 'Sonderkonto', 'D1', null), ('4091', 'Verbandsabgabe Test', 'A2', null), ('4391', 'Energie Halle Test', 'C2', null),
    ('4392', 'Gas Halle Test', 'C2', '4391'), ('6091', 'Neues Konto Test', 'A2', null), ('6191', 'Ungenutzt Test', 'A2', null),
    ('9091', 'Außerhalb der Bereiche', 'A1', null), ('5091', 'Ohne Bereich Test', null, null)`;
  await sql`insert into tco.fibankab (jahr, konto, anfangsbestand) values (2091, '1291', 10000), (2091, '1391', -30000)`;

  for (let j = 2091; j <= 2096; j++) {
    const i = j - 2091;
    const bis = j === 2096 ? 11 : 12;                  // 2096 läuft: gebucht bis Mitte November
    for (let m = 1; m <= bis; m++) {
      const teil = j === 2096 && m === 11 ? 0.5 : 1;   // der November ist erst zur Hälfte gebucht
      // Beiträge im Januar und Juli, jedes Jahr 1.000 mehr
      if (m === 1 || m === 7) await buche('8091', tag(j, m), (20000 + i * 1000) / 2);
      // Hallenmiete und Gas nach dem Winterverlauf, Strom gleichmäßig
      await buche('8391', tag(j, m), Math.round((10000 + i * 500) * WINTER[m - 1] * teil));
      await buche('4392', tag(j, m), Math.round(6000 * WINTER[m - 1] * teil));
      if (teil === 1) await buche('4391', tag(j, m), 300);
      // Tilgung 250 je Monat: Soll auf dem Darlehen, Haben auf der Bank
      if (teil === 1) await buche('1391', tag(j, m), 250, { haben: false });
      // Spenden im Dezember; 2094 eine Spendenaktion
      if (m === 12) await buche('8191', tag(j, m), j === 2094 ? 9000 : 2000);
      // Verbandsabgabe im März (2093 ohne Jahr/Monat gebucht – das Jahr kommt ersatzweise aus dem Datum)
      if (m === 3) await buche('4091', tag(j, m), 1500, { ohneJahr: j === 2093 });
      // Sonderkonto 8012: nur die Haben-Seite zählt
      if (m === 8) { await buche('8012', tag(j, m), 100); await buche('8012', tag(j, m, 11), 30, { haben: false }); }
      if (m === 5) { await buche('9091', tag(j, m), 77, { haben: true }); await buche('5091', tag(j, m), 40); }
    }
  }
  // Fehlbuchung mit Storno im Folgemonat: Jahreswert unverändert, im Monatsverlauf zählt das Storno im Mai
  await buche('4091', tag(2095, 4), 200);
  await buche('4091', tag(2095, 5), 200, { haben: true });
  // neues Konto, erst seit 2096 bebucht
  for (let m = 1; m <= 10; m++) await buche('6091', tag(2096, m), 100);
});
after(async () => {
  await app?.close();
  await sql.end();
});

test('Ist-Werte: Monatswerte ergeben je Konto und Jahr genau den Jahreswert des Jahresabschlusses', async () => {
  const { werte } = await jahreswerteLesen(db, 2091, 2096);
  const ist = await hh.monatswerteLesen(db, 2091, 2096);
  assert.ok(werte.length >= 40);
  for (const w of werte) {
    const m = ist.konten.get(w.konto)?.jahre.get(w.jahr);
    assert.ok(m, `${w.konto}/${w.jahr} fehlt`);
    nah(m!.reduce((s, x) => s + x, 0), w.wert);
  }
  // und umgekehrt kein Konto/Jahr, das der Jahresabschluss nicht kennt
  for (const k of ist.konten.values()) for (const j of k.jahre.keys()) assert.ok(werte.some((w) => w.konto === k.konto && w.jahr === j), `${k.konto}/${j}`);
  // Verrechnungskonto verdichtet, 8012 nur Haben, Jahr aus dem Datum, Storno im Monat der Stornobuchung
  assert.ok(!ist.konten.has('4392'));
  nah(ist.konten.get('4391')!.jahre.get(2095)!.reduce((s, x) => s + x, 0), 3600 + 6000);
  nah(ist.konten.get('8012')!.jahre.get(2095)!.reduce((s, x) => s + x, 0), 100);
  assert.equal(ist.konten.get('4091')!.jahre.get(2093)![2], 1500);
  assert.deepEqual(ist.konten.get('4091')!.jahre.get(2095)!.slice(2, 5), [1500, 200, -200]);
  // Geld- und Darlehensbewegung für die Liquidität
  assert.equal(ist.darlehen.get(2095)![0], 250);
  assert.equal(ist.konten.get('1291')!.art, 'G');
});

test('Grundlage im Herbst: Stand Oktober, Hochrechnung über den Jahresverlauf, Rest statt Division, wenig Historie', async () => {
  const g = await hh.grundlageLesen(db, 2097, HEUTE);
  assert.equal(g.basisjahr, 2096);
  assert.equal(g.stand_monat, 10);                       // der halb gebuchte November zählt nicht
  assert.deepEqual(g.jahre, [2091, 2092, 2093, 2094, 2095, 2096]);
  const k = (nr: string) => g.konten.find((x) => x.konto === nr)!;
  // nur Einnahme-/Ausgabekonten, Einnahmen zuerst; Verrechnungskonto verdichtet; 6191 ohne Buchung nicht dabei
  assert.deepEqual(g.konten.map((x) => x.konto), ['8012', '8091', '8191', '8391', '4091', '4391', '5091', '6091']);
  assert.deepEqual([k('8091').art, k('8091').bereich, k('4391').art, k('4391').bereich, k('5091').bereich], ['E', 'A', 'A', 'C', '']);

  // Hallenmiete 2096: bis Oktober 74 % des Jahres → Hochrechnung 12.500 (linear wären es 11.100)
  const halle = k('8391');
  assert.equal(halle.hoch!.art, 'VERLAUF');
  nah(halle.hoch!.anteil, 0.74, 0.002);
  nah(halle.hoch!.wert, 12500, 15);
  nah((halle.ist_stand * 12) / 10, 11100, 15);
  assert.equal(halle.wenig_historie, false);
  assert.ok(halle.treffer.HOCH !== null && halle.treffer.TREND !== null);
  // Verbandsabgabe ist im März bezahlt: Anteil 1 → Ist
  assert.equal(k('4091').hoch!.wert, 1500);
  // Spenden kommen im Dezember: Anteil 0 → nicht teilen, sondern den üblichen Rest erwarten (Mittel der letzten drei Jahre)
  assert.equal(k('8191').hoch!.art, 'REST');
  nah(k('8191').hoch!.wert, (2000 + 9000 + 2000) / 3);
  // Energie: Verrechnungskonto verdichtet (Strom 300 je Monat + Gas nach Winterverlauf)
  nah(k('4391').ist[2095], 9600);
  nah(k('4391').hoch!.wert, 9600, 40);
  // neues Konto: gleichmäßig hochgerechnet, kein Trend, keine Trefferquote – und so gekennzeichnet
  const neu = k('6091');
  assert.equal(neu.wenig_historie, true);
  assert.deepEqual([neu.hoch!.art, neu.hoch!.wert, neu.werte.TREND, neu.beste], ['LINEAR', 1200, null, 'HOCH']);
  assert.deepEqual(neu.treffer, { HOCH: null, AVG3: null, MED5: null, TREND: null });
  // Ausreißer wird vorgeschlagen, entscheiden muss der Kassenwart
  assert.deepEqual(k('8191').ausreisser.map((a) => a.jahr), [2094]);
  assert.deepEqual(k('8391').ausreisser, []);
  // Hinweise: Konto außerhalb der Kontenbereiche und Konto ohne Tätigkeitsbereich
  assert.ok(g.hinweise.some((h) => /9091/.test(h) && /nicht im Haushaltsplan/.test(h)), g.hinweise.join('\n'));
  assert.ok(g.hinweise.some((h) => /ohne Tätigkeitsbereich/.test(h) && /5091/.test(h)));
});

test('Sondereffekt: Jahr mit Begründung aus der Grundlage nehmen; Vorgängerkonto', async () => {
  await tx((t) => hh.sondereffektSetzen(t, '8191', 2094, 'Spendenaktion Hallendach', 'test'));
  let g = await hh.grundlageLesen(db, 2097, HEUTE);
  let k = g.konten.find((x) => x.konto === '8191')!;
  assert.deepEqual(k.sonder, [{ jahr: 2094, grund: 'Spendenaktion Hallendach' }]);
  assert.ok(!k.zaehlt.includes(2094));
  assert.equal(k.ist[2094], 9000);                        // angezeigt wird das Jahr weiter
  assert.deepEqual(k.ausreisser, []);
  nah(k.hoch!.wert, 2000);                                // üblicher Rest ohne die Spendenaktion
  nah(k.werte.MED5!, 2000);
  // Begründung ist Pflicht (Datenbank), leer = wieder aufnehmen
  await assert.rejects(sql`insert into tco.hh_sondereffekt (konto, jahr, grund) values ('8391', 2092, ' ')`);
  await tx((t) => hh.sondereffektSetzen(t, '8191', 2094, null, 'test'));
  assert.deepEqual((await hh.grundlageLesen(db, 2097, HEUTE)).konten.find((x) => x.konto === '8191')!.sonder, []);
  await tx((t) => hh.sondereffektSetzen(t, '8191', 2094, 'Spendenaktion Hallendach', 'test'));

  // Vorgänger: 6091 übernimmt bis 2095 die Historie von 4091
  await tx((t) => hh.vorgaengerSetzen(t, '6091', '4091', 2096));
  g = await hh.grundlageLesen(db, 2097, HEUTE);
  k = g.konten.find((x) => x.konto === '6091')!;
  assert.equal(k.ist[2095], 1500);
  assert.equal(k.wenig_historie, false);
  assert.deepEqual(k.vorgaenger, { konto: '4091', ab_jahr: 2096 });
  await assert.rejects(tx((t) => hh.vorgaengerSetzen(t, '6091', '6091', 2096)), /eigener Vorgänger/);
  await assert.rejects(tx((t) => hh.vorgaengerSetzen(t, '6091', '0000', 2096)), /Kontenstamm/);
  await tx((t) => hh.vorgaengerSetzen(t, '6091', null, null));
  assert.equal((await hh.grundlageLesen(db, 2097, HEUTE)).konten.find((x) => x.konto === '6091')!.wenig_historie, true);
});

test('Fachdaten: Beitragsforecast je Erlöskonto – nur wo die Zuordnung eindeutig ist', async () => {
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, eintritt) values ('0000009101', 'Hans', 'Haushalt', '2090-01-01'), ('0000009102', 'Paula', 'Plan', '2090-01-01')`;
  await sql`insert into tco.beitrag (art, bezeichnung, turnus, erloeskonto) values ('10', 'Erwachsene', 'halbjährlich', '8091'), ('95', 'Sonderumlage', 'jährlich', '8091'), ('20', 'Ohne Konto', 'jährlich', '')`;
  await sql`insert into tco.beitrag_pr (art, gueltig_ab, gueltig_bis, betrag) values ('10', '2000-01-01', '2096-12-31', 100), ('10', '2097-01-01', '9999-12-31', 120), ('20', '2000-01-01', '9999-12-31', 50)`;
  await sql`insert into tco.vertraege (adrnr, vertragnr, art, artname, sollstellung, vertragbegin, vertragende, betrag) values
    ('0000009101', '1', '10', 'Erwachsene', 'halbjährlich', '2090-01-01', null, 100),
    ('0000009102', '1', '10', 'Erwachsene', 'halbjährlich', '2090-01-01', '2097-03-31', 100),
    ('0000009102', '2', '20', 'Ohne Konto', 'jährlich', '2090-01-01', null, 50)`;
  // Art 95 zeigt auf dasselbe Konto, wird vom Forecast aber nicht gerechnet → nicht eindeutig, keine Fachdaten
  let f = await hh.fachdatenLesen(db, 2097);
  assert.equal(f.konten.has('8091'), false);
  assert.ok(f.hinweise.some((h) => /8091/.test(h) && /95/.test(h)), f.hinweise.join('\n'));
  assert.ok(f.hinweise.some((h) => /ohne Erlöskonto/.test(h) && /20/.test(h)));
  assert.equal((await hh.grundlageLesen(db, 2097, HEUTE)).konten.find((x) => x.konto === '8091')!.fach, null);

  // eindeutig: Januar zwei Verträge zu 120, Juli nur noch einer (Austritt zum 31.03.) → 360
  await sql`update tco.beitrag set aktiv = false where art = '95'`;
  f = await hh.fachdatenLesen(db, 2097);
  assert.deepEqual([f.konten.get('8091')!.monate[0], f.konten.get('8091')!.monate[6], f.konten.get('8091')!.arten], [240, 120, ['10']]);
  const k = (await hh.grundlageLesen(db, 2097, HEUTE)).konten.find((x) => x.konto === '8091')!;
  assert.equal(k.fach, 360);
  assert.equal(k.beste, 'FACH');
  nah(k.profil_fach![0], 240 / 360, 1e-9);
  // Erlöskonto eines Produkts ist nie eindeutig
  await sql`insert into tco.produkte (prod_key, valid_from, valid_to, erloeskonto) values ('HHTEST', '2000-01-01', '9999-12-31', '8091')`.catch(async () => {
    const spalten = (await sql`select column_name, is_nullable, column_default from information_schema.columns where table_schema = 'tco' and table_name = 'produkte'`);
    throw new Error('Testprodukt lässt sich nicht anlegen: ' + JSON.stringify(spalten));
  });
  assert.equal((await hh.fachdatenLesen(db, 2097)).konten.has('8091'), false);
  await sql`delete from tco.produkte where prod_key = 'HHTEST'`;
});

let planId = 0;

test('Plan anlegen: Vorschlag je Konto mit der treffsichersten Methode; „Ist Vorjahr“ stimmt mit dem Jahresabschluss überein', async () => {
  planId = await tx((t) => hh.planAnlegen(t, 2097, 'test', HEUTE));
  await assert.rejects(tx((t) => hh.planAnlegen(t, 2097, 'test', HEUTE)), /gibt es bereits/);
  const s = await hh.planLesen(db, planId, HEUTE);
  assert.deepEqual([s.plan.jahr, s.plan.fassung, s.plan.status, s.aenderbar, s.basisjahr, s.stand_monat], [2097, 1, 'ENTWURF', true, 2096, 10]);
  assert.match(s.stand_text, /2091 bis Oktober 2096/);
  assert.deepEqual(s.positionen.map((p) => p.konto), ['8012', '8091', '8191', '8391', '4091', '4391', '5091', '6091']);

  // „Ist Vorjahr“ (2095) und alle weiteren Jahre: genau die Jahreswerte der bestehenden Funktion des Jahresabschlusses
  const { werte } = await jahreswerteLesen(db, 2091, 2095);
  let verglichen = 0;
  for (const p of s.positionen) {
    for (let j = 2091; j <= 2095; j++) {
      const jw = werte.find((w) => w.konto === p.konto && w.jahr === j)?.wert ?? 0;
      assert.equal(p.grundlage!.ist[j], jw, `Konto ${p.konto}, ${j}`);
      verglichen++;
    }
  }
  assert.equal(verglichen, 40);
  // und in Summe das Ergebnis der Einnahmen-Ausgaben-Rechnung für die Konten mit Tätigkeitsbereich
  const { earBerechnen } = await import('../../modules/tco/server/abschluss/logik.js');
  const ear = earBerechnen(werte, 2095);
  const mitBereich = s.positionen.filter((p) => p.bereich);
  nah(mitBereich.filter((p) => p.art === 'A').reduce((a, p) => a + p.grundlage!.ist[2095], 0), ear.aus);
  nah(mitBereich.filter((p) => p.art === 'E').reduce((a, p) => a + p.grundlage!.ist[2095], 0), ear.ein - 77);   // 9091 liegt außerhalb der Kontenbereiche

  const p = (nr: string) => s.positionen.find((x) => x.konto === nr)!;
  // Fachdaten vorbelegt, ohne Preissteigerung; Vorschläge auf 10 € gerundet
  assert.deepEqual([p('8091').methode, p('8091').vorschlag, p('8091').planwert], ['FACH', 360, 360]);
  assert.deepEqual([p('6091').methode, p('6091').planwert, p('6091').manuell], ['HOCH', 1200, false]);
  for (const x of s.positionen) {
    assert.equal(x.methode, x.grundlage!.beste);
    assert.equal(x.planwert % 10, 0);
    nah(x.monate.reduce((a, b) => a + b, 0), x.planwert);
  }
  // Beiträge laut Verträgen im Januar und Juli, Hallenmiete nach dem Winterverlauf
  assert.deepEqual([p('8091').monate[0], p('8091').monate[6], p('8091').monate[3]], [240, 120, 0]);
  nah(p('8391').monate[0] / p('8391').planwert, 0.16, 0.002);
  // Summen und Tätigkeitsbereiche
  nah(s.summen.einnahmen, s.positionen.filter((x) => x.art === 'E').reduce((a, x) => a + x.planwert, 0));
  nah(s.summen.ergebnis, s.summen.einnahmen - s.summen.ausgaben);
  assert.deepEqual(s.bereiche.map((b) => b.bereich), ['A', 'B', 'C', 'D', '']);
  nah(s.bereiche.find((b) => b.bereich === 'C')!.ergebnis, p('8391').planwert - p('4391').planwert);
});

test('Plan bearbeiten: Methode wechseln, Planwert überschreiben, Preissteigerung, Monatsverlauf, neu berechnen', async () => {
  const lesen = () => hh.planLesen(db, planId, HEUTE);
  const p = async (nr: string) => (await lesen()).positionen.find((x) => x.konto === nr)!;
  // Methode wechseln setzt den Planwert auf den Vorschlag der Methode
  await tx((t) => hh.positionAendern(t, planId, '4391', { methode: 'AVG3' }, HEUTE));
  let e = await p('4391');
  assert.deepEqual([e.methode, e.manuell], ['AVG3', false]);
  nah(e.vorschlag!, Math.round(e.grundlage!.werte.AVG3! / 10) * 10);
  assert.equal(e.planwert, e.vorschlag);
  // Trend gibt es für das neue Konto nicht
  await assert.rejects(tx((t) => hh.positionAendern(t, planId, '6091', { methode: 'TREND' }, HEUTE)), /liefert für Konto 6091 keinen Wert/);
  await assert.rejects(tx((t) => hh.positionAendern(t, planId, '0000', { planwert: 1 }, HEUTE)), /nicht enthalten/);

  // Preissteigerung 5 %: nur Ausgaben, nicht die Fachdaten
  const vorher = await lesen();
  await tx((t) => hh.kopfAendern(t, planId, { preissteigerung: 5 }));
  let s = await lesen();
  for (const x of s.positionen) {
    const alt = vorher.positionen.find((y) => y.konto === x.konto)!;
    if (x.art === 'A') assert.equal(x.planwert, Math.round((x.vorschlag! * 1.05) / 10) * 10, x.konto);
    else assert.equal(x.planwert, alt.planwert, x.konto);
  }
  // Zuschlag je Konto geht vor
  await tx((t) => hh.positionAendern(t, planId, '4391', { zuschlag: 10 }, HEUTE));
  e = await p('4391');
  assert.equal(e.planwert, Math.round((e.vorschlag! * 1.1) / 10) * 10);

  // Planwert überschreiben: bleibt beim Neuberechnen stehen, der Vorschlag daneben nicht
  await tx((t) => hh.positionAendern(t, planId, '4091', { planwert: 1800, notiz: 'Verband erhöht die Abgabe' }, HEUTE));
  e = await p('4091');
  assert.deepEqual([e.planwert, e.manuell, e.notiz], [1800, true, 'Verband erhöht die Abgabe']);
  await assert.rejects(tx((t) => hh.positionAendern(t, planId, '4091', { planwert: -1 }, HEUTE)), /nicht negativ/);
  await tx((t) => hh.neuBerechnen(t, planId, { methode: 'MED5', auchManuelle: false }, HEUTE));
  s = await lesen();
  assert.deepEqual([s.positionen.find((x) => x.konto === '4091')!.planwert, s.positionen.find((x) => x.konto === '4091')!.manuell], [1800, true]);
  assert.equal(s.positionen.find((x) => x.konto === '8391')!.methode, 'MED5');
  assert.equal(s.positionen.find((x) => x.konto === '8091')!.methode, 'FACH');      // Fachdaten bleiben
  // „treffsicherste“ und auch die von Hand geänderten
  await tx((t) => hh.neuBerechnen(t, planId, { methode: 'BESTE', auchManuelle: true }, HEUTE));
  s = await lesen();
  for (const x of s.positionen) assert.deepEqual([x.methode, x.manuell], [x.grundlage!.beste, false], x.konto);

  // Monatsverlauf von Hand: Summe muss dem Planwert entsprechen; null = wieder berechnen
  e = await p('4091');
  const hand = [0, 0, 0, 0, 0, e.planwert, 0, 0, 0, 0, 0, 0];
  await assert.rejects(tx((t) => hh.monateSetzen(t, planId, '4091', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), /Monatsbeträge ergeben/);
  await tx((t) => hh.monateSetzen(t, planId, '4091', hand));
  e = await p('4091');
  assert.deepEqual([e.monate, e.monate_fest, e.monate_von_hand], [hand, true, true]);
  // neuer Planwert zieht die von Hand verteilten Monate anteilig mit
  await tx((t) => hh.positionAendern(t, planId, '4091', { planwert: 2000 }, HEUTE));
  assert.equal((await p('4091')).monate[5], 2000);
  await tx((t) => hh.monateSetzen(t, planId, '4091', null));
  e = await p('4091');
  // wieder nach dem Jahresverlauf: fast alles im März (die Fehlbuchung vom April 2095 hinterlässt dort einen kleinen Anteil)
  assert.equal(e.monate_fest, false);
  assert.ok(e.monate[2] > 1900 && e.monate[2] + e.monate[3] === 2000, JSON.stringify(e.monate));

  // Konto von Hand aufnehmen (ohne Buchungen → Manuell) und wieder entfernen
  await tx((t) => hh.positionHinzufuegen(t, planId, '6191', HEUTE));
  e = await p('6191');
  assert.deepEqual([e.methode, e.planwert, e.grundlage, e.art], ['MANUELL', 0, null, 'A']);
  await assert.rejects(tx((t) => hh.positionHinzufuegen(t, planId, '6191', HEUTE)), /bereits/);
  await assert.rejects(tx((t) => hh.positionHinzufuegen(t, planId, '4392', HEUTE)), /Verrechnungskonto 4391/);
  await assert.rejects(tx((t) => hh.positionHinzufuegen(t, planId, '1291', HEUTE)), /weder Einnahme- noch Ausgabekonto/);
  await tx((t) => hh.positionAendern(t, planId, '6191', { planwert: 500 }, HEUTE));
  await tx((t) => hh.positionEntfernen(t, planId, '6191'));
  assert.equal((await lesen()).positionen.some((x) => x.konto === '6191'), false);
  assert.deepEqual((await lesen()).fehlende, []);
});

test('Vorhaben und Liquiditätsvorschau: Geldbestand je Monatsende, Tilgung aus den Darlehenskonten, Mindestreserve', async () => {
  const lesen = () => hh.planLesen(db, planId, HEUTE);
  let s = await lesen();
  const l = s.liquiditaet;
  // Tilgung: 250 je Monat aus der Bewegung des Darlehenskontos (Kennzahl BK)
  assert.deepEqual([l.tilgung.quelle, l.tilgung.summe, l.tilgung.monate[0], l.tilgung.hinweis], ['DARLEHEN', 3000, 250, null]);
  // Anfangsbestand: Geldbestand Ende Oktober + erwartetes Ergebnis November/Dezember − Tilgung
  assert.equal(l.anfang_herkunft.quelle, 'HOCHRECHNUNG');
  const g = await hh.grundlageLesen(db, 2097, HEUTE);
  const bew = g.daten.geld.get(2096)!.slice(0, 10).reduce((a, b) => a + b, 0);
  const ab = (await geldkonten(db, 2096)).reduce((a, x) => a + x.anfangsbestand, 0);
  let rest = 0;
  for (const k of g.konten) rest += (k.art === 'E' ? 1 : -1) * Math.max(0, k.hoch!.wert - k.ist_stand);
  nah(l.anfang, ab + bew + rest - 500, 0.02);
  // Bestand je Monat = Vormonat + Einnahmen − Ausgaben − Tilgung; ohne Mindestreserve keine Bewertung
  let b = l.anfang;
  for (const m of l.monate) { b = Math.round((b + m.einnahmen - m.ausgaben - m.tilgung) * 100) / 100; nah(m.bestand, b); assert.equal(m.ausreichend, null); }
  nah(l.monate.reduce((a, m) => a + m.einnahmen, 0), s.summen.einnahmen);
  nah(l.monate.reduce((a, m) => a + m.ausgaben, 0), s.summen.ausgaben);
  assert.equal(l.tiefster, Math.min(...l.monate.map((m) => m.bestand)));
  assert.ok(l.ist.every((x) => x === null));                    // das Planjahr hat noch nicht begonnen

  // Vorhaben: eingeplant zählt in Summen und im Monat der Liquidität, ausgeplant nicht
  const v1 = await tx((t) => hh.vorhabenSichern(t, planId, { bezeichnung: 'LED-Beleuchtung Halle', art: 'A', monat: 8, betrag: 18000, konto: '4391', eingeplant: true }));
  await tx((t) => hh.vorhabenSichern(t, planId, { bezeichnung: 'Zuschuss Sportstättenförderung', art: 'E', monat: 10, betrag: 6000, eingeplant: true }));
  const v3 = await tx((t) => hh.vorhabenSichern(t, planId, { bezeichnung: 'Grundsanierung Platz 3', art: 'A', monat: 4, betrag: 7500, eingeplant: false }));
  await assert.rejects(tx((t) => hh.vorhabenSichern(t, planId, { bezeichnung: 'Falsch', art: 'E', monat: 1, betrag: 1, konto: '4391', eingeplant: true })), /kein Einnahmekonto/);
  const mit = await lesen();
  assert.deepEqual([mit.summen.vorhaben_e, mit.summen.vorhaben_a], [6000, 18000]);
  nah(mit.summen.ausgaben, s.summen.ausgaben + 18000);
  nah(mit.summen.ergebnis, s.summen.ergebnis - 12000);
  nah(mit.liquiditaet.monate[7].ausgaben, l.monate[7].ausgaben + 18000);
  nah(mit.liquiditaet.monate[11].bestand, l.monate[11].bestand - 12000);
  nah(mit.liquiditaet.monate[3].ausgaben, l.monate[3].ausgaben);
  await tx((t) => hh.vorhabenSichern(t, planId, { id: v3, bezeichnung: 'Grundsanierung Platz 3', art: 'A', monat: 4, betrag: 7500, eingeplant: true }));
  nah((await lesen()).summen.vorhaben_a, 25500);
  await tx((t) => hh.vorhabenLoeschen(t, planId, v3));
  assert.equal((await lesen()).vorhaben.length, 2);
  assert.ok(v1 > 0);

  // Mindestreserve und Tilgung als Eingabe am Plan
  await tx((t) => hh.kopfAendern(t, planId, { mindestreserve: mit.liquiditaet.tiefster + 1000, tilgung: 6000 }));
  s = await lesen();
  assert.deepEqual([s.liquiditaet.tilgung.quelle, s.liquiditaet.tilgung.monate[0], s.liquiditaet.tilgung.summe], ['PLAN', 500, 6000]);
  assert.ok(s.liquiditaet.monate.some((m) => m.ausreichend === false) && s.liquiditaet.monate.some((m) => m.ausreichend === true));
  await tx((t) => hh.kopfAendern(t, planId, { tilgung: null, anfangsbestand: 50000 }));
  s = await lesen();
  assert.deepEqual([s.liquiditaet.anfang, s.liquiditaet.anfang_herkunft.quelle, s.liquiditaet.tilgung.quelle], [50000, 'PLAN', 'DARLEHEN']);
  await tx((t) => hh.kopfAendern(t, planId, { anfangsbestand: null, mindestreserve: null }));
  // Mindestreserve aus den Einstellungen gilt, wenn am Plan keine steht
  await tx((t) => hh.cfgSichern(t, { ...s.cfg, mindestreserve: -999999 }));
  assert.ok((await lesen()).liquiditaet.monate.every((m) => m.ausreichend === true));
  await tx((t) => hh.cfgSichern(t, { ...s.cfg, mindestreserve: null }));
});

test('Statusfolge: beschlossen ist unveränderlich (auch in der Datenbank), Monatsverlauf festgeschrieben, Nachtrag als neue Fassung', async () => {
  await assert.rejects(tx((t) => hh.statusSetzen(t, planId, 'GENEHMIGT', '2096-12-01', 'Vorstand', HEUTE)), /zuerst vom Vorstand beschlossen/);
  await assert.rejects(tx((t) => hh.nachtragAnlegen(t, planId, 'zu früh', 'test', HEUTE)), /erst nach dem Beschluss/);
  const vorher = await hh.planLesen(db, planId, HEUTE);
  const p = await tx((t) => hh.statusSetzen(t, planId, 'BESCHLOSSEN', '2096-12-01', 'Vorstand', HEUTE));
  assert.deepEqual([p.status, p.status_text, p.beschlossen_am, p.beschlossen_von], ['BESCHLOSSEN', 'vom Vorstand beschlossen', '2096-12-01', 'Vorstand']);
  // jede Änderung wird abgewiesen
  await assert.rejects(tx((t) => hh.positionAendern(t, planId, '4091', { planwert: 1 }, HEUTE)), /kann nicht mehr geändert werden/);
  await assert.rejects(tx((t) => hh.neuBerechnen(t, planId, { methode: 'BESTE', auchManuelle: true }, HEUTE)), /Nachtrag/);
  await assert.rejects(tx((t) => hh.kopfAendern(t, planId, { preissteigerung: 9 })), /Nachtrag/);
  await assert.rejects(tx((t) => hh.vorhabenSichern(t, planId, { bezeichnung: 'X', art: 'A', monat: 1, betrag: 1, eingeplant: true })), /Nachtrag/);
  await assert.rejects(tx((t) => hh.monateSetzen(t, planId, '4091', null)), /Nachtrag/);
  await assert.rejects(tx((t) => hh.planLoeschen(t, planId)), /Nachtrag/);
  await assert.rejects(tx((t) => hh.statusSetzen(t, planId, 'BESCHLOSSEN', '2096-12-02', 'x', HEUTE)), /bereits/);
  // auch an der Anwendung vorbei: die Datenbank schützt Positionen, Monatswerte und Vorhaben
  await assert.rejects(sql`update tco.hh_position set planwert = 1 where plan_id = ${planId}`, /beschlossen/);
  await assert.rejects(sql`delete from tco.hh_vorhaben where plan_id = ${planId}`, /beschlossen/);
  await assert.rejects(sql`insert into tco.hh_position (plan_id, konto, methode) values (${planId}, '6191', 'MANUELL')`, /beschlossen/);
  await assert.rejects(sql`update tco.hh_monat set betrag = 0 where plan_id = ${planId}`, /beschlossen/);

  // Der Monatsverlauf ist festgeschrieben: Später – mit neuen Buchungen und anderem Datenstand – bleibt die Fassung, wie sie war
  const spaeter = await hh.planLesen(db, planId, '2097-06-15');
  assert.equal(spaeter.aenderbar, false);
  for (const x of spaeter.positionen) {
    const alt = vorher.positionen.find((y) => y.konto === x.konto)!;
    assert.deepEqual([x.planwert, x.methode, x.monate, x.monate_fest, x.monate_von_hand], [alt.planwert, alt.methode, alt.monate, true, false], x.konto);
  }
  nah(spaeter.summen.ergebnis, vorher.summen.ergebnis);

  // genehmigen (optionaler Schritt), dann Nachtrag
  const g = await tx((t) => hh.statusSetzen(t, planId, 'GENEHMIGT', '2097-03-20', 'Mitgliederversammlung', HEUTE));
  assert.deepEqual([g.status, g.genehmigt_am], ['GENEHMIGT', '2097-03-20']);
  await assert.rejects(tx((t) => hh.nachtragAnlegen(t, planId, '  ', 'test', HEUTE)), /begründen/);
  const n = await tx((t) => hh.nachtragAnlegen(t, planId, 'Heizung der Halle ausgefallen', 'Kassenwart', '2097-06-15'));
  await assert.rejects(tx((t) => hh.nachtragAnlegen(t, planId, 'noch einer', 'test', HEUTE)), /bereits einen Nachtrag im Entwurf/);
  const nachtrag = await hh.planLesen(db, n, '2097-06-15');
  assert.deepEqual([nachtrag.plan.fassung, nachtrag.plan.status, nachtrag.plan.begruendung, nachtrag.aenderbar], [2, 'ENTWURF', 'Heizung der Halle ausgefallen', true]);
  assert.deepEqual(nachtrag.positionen.map((x) => [x.konto, x.planwert, x.monate]), spaeter.positionen.map((x) => [x.konto, x.planwert, x.monate]));
  assert.equal(nachtrag.vorhaben.length, 2);
  assert.deepEqual(nachtrag.fassungen.map((f) => [f.fassung, f.status]), [[2, 'ENTWURF'], [1, 'GENEHMIGT']]);
  // die alte Fassung gilt weiter, bis der Nachtrag beschlossen ist
  assert.equal((await hh.gueltigerPlan(db, 2097))!.fassung, 1);
  await tx((t) => hh.positionAendern(t, n, '4391', { planwert: 15000, notiz: 'neue Heizung' }, '2097-06-15'));
  await tx((t) => hh.statusSetzen(t, n, 'BESCHLOSSEN', '2097-06-20', 'Vorstand', '2097-06-15'));
  assert.equal((await hh.gueltigerPlan(db, 2097))!.fassung, 2);
  assert.equal((await hh.planLesen(db, planId, HEUTE)).positionen.find((x) => x.konto === '4391')!.planwert, vorher.positionen.find((x) => x.konto === '4391')!.planwert);
  // ein Entwurf lässt sich löschen
  const e = await tx((t) => hh.planAnlegen(t, 2098, 'test', HEUTE));
  assert.equal((await tx((t) => hh.planLoeschen(t, e))).jahr, 2098);
  assert.equal((await hh.planListe(db)).some((x) => x.jahr === 2098), false);
});

test('Soll-Ist im laufenden Jahr: Hochrechnung, Bewertung nach Toleranz, Überschreitungen im Arbeitsvorrat', async () => {
  // Plan 2096 (im Herbst 2095 erstellt und beschlossen), dann das Jahr 2096 bis Mitte November betrachtet
  const id = await tx((t) => hh.planAnlegen(t, 2096, 'test', '2095-11-15'));
  await tx((t) => hh.positionAendern(t, id, '8391', { planwert: 12500 }, '2095-11-15'));     // trifft die Hochrechnung
  await tx((t) => hh.positionAendern(t, id, '4391', { planwert: 9000 }, '2095-11-15'));      // Hochrechnung 9.600 → +6,7 % → beobachten
  await tx((t) => hh.positionAendern(t, id, '4091', { planwert: 1000 }, '2095-11-15'));      // 1.500 gebucht → überschritten
  await tx((t) => hh.positionAendern(t, id, '8191', { planwert: 4000 }, '2095-11-15'));      // erwartet 2.000 → deutlich unter Plan
  await tx((t) => hh.vorhabenSichern(t, id, { bezeichnung: 'Sonderabgabe Verband', art: 'A', monat: 3, betrag: 100, konto: '4091', eingeplant: true }));

  // Entwurf: nur Vorschau, noch kein Maßstab für den Arbeitsvorrat
  let s = await hh.sollIst(db, 2096, HEUTE);
  assert.deepEqual([s.vorlaeufig, s.plan!.id, s.stand_monat], [true, id, 10]);
  assert.deepEqual(await hh.aufgaben(db, HEUTE), []);
  await tx((t) => hh.statusSetzen(t, id, 'BESCHLOSSEN', '2095-12-01', 'Vorstand', '2095-11-15'));

  s = await hh.sollIst(db, 2096, HEUTE);
  assert.equal(s.vorlaeufig, false);
  assert.match(s.stand_text, /bis Oktober 2096/);
  const z = (nr: string) => s.zeilen.find((x) => x.konto === nr)!;
  assert.deepEqual([z('8391').bewertung.stufe, z('8391').bewertung.state, z('8391').hoch_art], ['IM_PLAN', 'Positive', 'VERLAUF']);
  nah(z('8391').hochrechnung, 12500, 15);
  assert.deepEqual([z('4391').bewertung.stufe, z('4391').bewertung.state], ['BEOBACHTEN', 'Critical']);
  // Plan des Kontos = Planwert + eingeplantes Vorhaben auf dem Konto
  assert.deepEqual([z('4091').plan, z('4091').ist, z('4091').hochrechnung, z('4091').bewertung.stufe, z('4091').bewertung.text, z('4091').bewertung.prozent],
    [1100, 1500, 1500, 'UEBERSCHRITTEN', 'Budget überschritten', 36.4]);
  assert.deepEqual([z('8191').bewertung.stufe, z('8191').bewertung.text, z('8191').ist], ['UEBERSCHRITTEN', 'deutlich unter Plan', 0]);
  // 6091 wurde erst 2096 bebucht und stand nicht im Plan: als „nicht geplant“ sichtbar
  assert.deepEqual([z('6091').geplant, z('6091').plan, z('6091').ist, z('6091').bewertung.text], [false, 0, 1000, 'nicht geplant']);
  assert.deepEqual([s.ueberschritten, s.beobachten], [3, 1]);
  // die Hochrechnung liegt nie unter dem, was schon gebucht ist (der halbe November zählt beim Ist mit)
  for (const x of s.zeilen) assert.ok(x.hochrechnung >= x.ist - 0.005, x.konto);
  // aufgelaufener Verlauf: Plan zwölf Monate, Ist bis zum laufenden Monat
  assert.equal(s.verlauf.A.plan.length, 12);
  nah(s.verlauf.A.plan[11], s.summen.A.plan);
  assert.deepEqual(s.verlauf.A.ist.map((x) => x === null), [...Array(11).fill(false), true]);
  nah(s.verlauf.A.ist[10]!, s.summen.A.ist);
  nah(s.ergebnis.plan, s.summen.E.plan - s.summen.A.plan);

  // strengere Toleranz aus den Einstellungen wirkt sofort
  await tx((t) => hh.cfgSichern(t, { ...s.cfg, toleranz_gelb: 1, toleranz_rot: 2 }));
  assert.equal((await hh.sollIst(db, 2096, HEUTE)).zeilen.find((x) => x.konto === '4391')!.bewertung.stufe, 'UEBERSCHRITTEN');
  await assert.rejects(tx((t) => hh.cfgSichern(t, { ...s.cfg, toleranz_gelb: 10, toleranz_rot: 5 })), /nicht kleiner/);
  await tx((t) => hh.cfgSichern(t, { ...s.cfg, toleranz_gelb: 5, toleranz_rot: 10 }));

  // Arbeitsvorrat: je überschrittenem Ausgabenbudget ein Eintrag – Einnahmen unter Plan sind keine „Überschreitung“
  const a = await hh.aufgaben(db, HEUTE);
  assert.deepEqual(a.map((x) => x.key), ['HH:4091', 'HH:6091']);
  assert.deepEqual([a[0].bereich, a[0].state, a[0].pfad, a[0].betrag], ['Kassenwart', 'Negative', '/tco/haushalt?tab=sollist', 400]);
  assert.match(a[0].text, /Plan 2096: 1\.100,00 € · gebucht 1\.500,00 €/);
  assert.match(a[1].text, /nicht geplant/);
  // abgeschlossenes Jahr: Hochrechnung = Ist
  const alt = await hh.sollIst(db, 2096, '2097-02-01');
  assert.equal(alt.stand_monat, 12);
  for (const x of alt.zeilen) assert.equal(x.hochrechnung, x.ist, x.konto);
  // Jahr ohne Plan
  assert.equal((await hh.sollIst(db, 2093, HEUTE)).plan, null);
});

test('Oberfläche/API: anlegen, ändern, Soll-Ist, PDF, Einstellungen, Funktionsschalter – und FI bleibt unberührt', async () => {
  const [vor] = await sql`select count(*)::int as n, coalesce(sum(soll), 0)::float8 as s, coalesce(sum(haben), 0)::float8 as h, md5(string_agg(internenr || konto || posnr, ',' order by internenr, konto, posnr)) as p from tco.fibuchungen`;
  let r = await call('GET', `${H}/init`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.plaene.map((p: any) => [p.jahr, p.fassung, p.status]), [[2097, 2, 'BESCHLOSSEN'], [2097, 1, 'GENEHMIGT'], [2096, 1, 'BESCHLOSSEN']]);
  assert.deepEqual([r.body.cfg.toleranz_gelb, r.body.cfg.toleranz_rot, r.body.cfg.mindestreserve, r.body.cfg.grundlage_ab, r.body.ueberwachung], [5, 10, null, null, true]);
  assert.ok(r.body.konten.some((k: any) => k.konto === '6191' && k.art === 'A') && !r.body.konten.some((k: any) => k.konto === '4392' || k.konto === '1291'));

  // Plan 2099 über die API (aus Sicht von „heute“ liegt das Basisjahr in der Zukunft: Vorschlag aus den Vorjahren, keine Hochrechnung)
  r = await call('POST', `${H}/plan`, { jahr: 2099 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.id;
  assert.equal((await call('POST', `${H}/plan`, { jahr: 2099 })).status, 400);
  r = await call('GET', `${H}/plan/${id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.stand_monat, 0);
  assert.deepEqual(r.body.jahre, [2092, 2093, 2094, 2095, 2096, 2097, 2098]);
  const halle = r.body.positionen.find((p: any) => p.konto === '8391');
  assert.equal(halle.grundlage.werte.HOCH, null);
  assert.ok(halle.planwert > 0);

  r = await call('PUT', `${H}/plan/${id}/position`, { konto: '8391', methode: 'AVG3' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('PUT', `${H}/plan/${id}/position`, { konto: '8391', planwert: '12.345,50', notiz: 'Preise steigen' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('PUT', `${H}/plan/${id}`, { preissteigerung: 3, mindestreserve: '5.000', tilgung: null });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await call('PUT', `${H}/plan/${id}/position`, { konto: '8391', planwert: 'abc' })).status, 400);
  assert.equal((await call('POST', `${H}/plan/${id}/vorhaben`, { bezeichnung: 'Flutlicht', art: 'A', monat: 5, betrag: '2.500,00', eingeplant: true })).status, 200);
  assert.equal((await call('POST', `${H}/plan/${id}/vorhaben`, { bezeichnung: '', art: 'A', monat: 13, betrag: 1 })).status, 400);
  assert.equal((await call('POST', `${H}/plan/${id}/berechnen`, { methode: 'BESTE' })).status, 200);
  assert.equal((await call('POST', `${H}/sondereffekt`, { konto: '8391', jahr: 2092, grund: 'Halle drei Monate gesperrt' })).status, 200);
  r = await call('GET', `${H}/plan/${id}`);
  const p = r.body.positionen.find((x: any) => x.konto === '8391');
  assert.deepEqual([p.planwert, p.manuell, p.notiz, p.grundlage.sonder.length], [12345.5, true, 'Preise steigen', 1]);
  assert.deepEqual([r.body.plan.preissteigerung, r.body.plan.mindestreserve, r.body.summen.vorhaben_a], [3, 5000, 2500]);
  assert.equal((await call('POST', `${H}/sondereffekt`, { konto: '8391', jahr: 2092, grund: '' })).status, 200);

  // Soll-Ist und Kennzahl (heute gibt es keinen Plan für das laufende Kalenderjahr)
  r = await call('GET', `${H}/sollist?jahr=2096`);
  assert.equal(r.status, 200);
  assert.equal(r.body.plan.jahr, 2096);
  r = await call('GET', `${H}/kennzahl`);
  assert.deepEqual([r.status, r.body.plan, r.body.ueberschritten, r.body.aktiv], [200, false, 0, true]);
  r = await call('GET', '/api/arbeitsvorrat');
  assert.equal(r.status, 200);
  assert.equal(JSON.stringify(r.body).includes('"HH:'), false);
  // Funktionsschalter „Überwachung der Budgets“: abgeschaltet gibt es weder Kennzahl noch Einträge
  assert.equal((await call('PUT', '/api/funktionen', { id: 'tco.haushalt.ueberwachung', aktiv: false })).status, 200);
  assert.equal((await call('GET', `${H}/kennzahl`)).body.aktiv, false);
  assert.deepEqual(await hh.aufgaben(db, HEUTE), []);
  assert.equal((await call('PUT', '/api/funktionen', { id: 'tco.haushalt.ueberwachung', aktiv: true })).status, 200);
  assert.equal((await hh.aufgaben(db, HEUTE)).length, 2);

  // PDF für die Mitgliederversammlung
  r = await call('GET', `${H}/plan/${planId}/pdf`);
  assert.equal(r.status, 200);
  assert.match(r.ct, /application\/pdf/);
  assert.equal(r.raw.subarray(0, 5).toString(), '%PDF-');
  assert.ok(r.raw.length > 5000);
  assert.equal((await call('GET', `${H}/plan/999999/pdf`)).status, 404);
  // Paperless ist im Test nicht eingerichtet
  r = await call('POST', `${H}/plan/${planId}/paperless`);
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Paperless/);

  // Statusfolge über die API
  assert.equal((await call('POST', `${H}/plan/${id}/genehmigen`, {})).status, 400);
  r = await call('POST', `${H}/plan/${id}/beschliessen`, { datum: '2098-12-01' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('PUT', `${H}/plan/${id}/position`, { konto: '8391', planwert: 1 });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Nachtrag/);
  assert.equal((await call('POST', `${H}/plan/${id}/loeschen`, { grund: 'Test' })).status, 400);
  r = await call('POST', `${H}/plan/${id}/nachtrag`, { begruendung: 'Flutlicht wird teurer' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await call('POST', `${H}/plan/${r.body.id}/loeschen`, { grund: 'doch nicht' })).status, 200);

  // Einstellungen
  r = await call('PUT', `${H}/einstellungen`, { toleranz_gelb: 4, toleranz_rot: 8, mindestreserve: '20.000', ausreisser_prozent: 40, grundlage_ab: 2093, preissteigerung: 2, genehmigung_mv: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await call('GET', `${H}/einstellungen`)).body, { toleranz_gelb: 4, toleranz_rot: 8, mindestreserve: 20000, ausreisser_prozent: 40, grundlage_ab: 2093, preissteigerung: 2, genehmigung_mv: false });
  assert.equal((await call('PUT', `${H}/einstellungen`, { toleranz_gelb: 9, toleranz_rot: 8, mindestreserve: '', ausreisser_prozent: 40, grundlage_ab: '', preissteigerung: 2, genehmigung_mv: true })).status, 400);
  // „Grundlage ab Jahr“: frühere Jahre zählen nicht mehr; neue Pläne übernehmen die Preissteigerung
  const g = await hh.grundlageLesen(db, 2097, HEUTE);
  assert.deepEqual(g.jahre, [2093, 2094, 2095, 2096]);
  const neu = await tx((t) => hh.planAnlegen(t, 2095, 'test', '2094-11-15'));
  assert.equal((await hh.planLesen(db, neu, '2094-11-15')).plan.preissteigerung, 2);
  await tx((t) => hh.planLoeschen(t, neu));
  assert.equal((await call('PUT', `${H}/einstellungen`, { toleranz_gelb: 5, toleranz_rot: 10, mindestreserve: null, ausreisser_prozent: 50, grundlage_ab: null, preissteigerung: 0, genehmigung_mv: true })).status, 200);

  // Änderungsbelege zum Plan
  const belege = await sql`select object_type, count(*)::int as n from core.change_header where object_type like 'HH_%' group by 1`;
  for (const typ of ['HH_PLAN', 'HH_SONDEREFFEKT', 'HH_CFG']) assert.ok(belege.some((b) => b.object_type === typ && b.n > 0), `keine Änderungsbelege für ${typ}`);
  const [beschluss] = await sql`select count(*)::int as n from core.change_header where object_type = 'HH_PLAN' and action = 'HH_BESCHLUSS'`;
  assert.ok(beschluss.n > 0);
  // Der Haushaltsplan liest FI nur: keine Buchung geändert, hinzugefügt oder gelöscht
  const [nach] = await sql`select count(*)::int as n, coalesce(sum(soll), 0)::float8 as s, coalesce(sum(haben), 0)::float8 as h, md5(string_agg(internenr || konto || posnr, ',' order by internenr, konto, posnr)) as p from tco.fibuchungen`;
  assert.deepEqual(nach, vor);
});

test('Haushaltsplan: Berechtigungen display / edit / admin', async () => {
  assert.equal((await call('POST', '/api/admin/roles', { id: 'HH_LESER', name: 'Haushalt lesen', permissions: ['tco.haushalt:display'] })).status, 200);
  assert.equal((await call('POST', '/api/admin/roles', { id: 'HH_PLANER', name: 'Haushalt planen', permissions: ['tco.haushalt:display', 'tco.haushalt:edit'] })).status, 200);
  for (const [name, rolle] of [['hhleser', 'HH_LESER'], ['hhplaner', 'HH_PLANER']]) {
    assert.equal((await call('POST', '/api/admin/users', { username: name, displayName: name, password: 'start-passwort', roles: [rolle] })).status, 200);
  }
  const anmelden = async (name: string) => {
    const c = client();
    assert.equal((await c('POST', '/api/auth/login', { username: name, password: 'start-passwort' })).status, 200);
    assert.equal((await c('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);
    return c;
  };
  const leser = await anmelden('hhleser'), planer = await anmelden('hhplaner');
  const [e] = await sql`select id from tco.hh_plan where status = 'BESCHLOSSEN' and jahr = 2099`;
  assert.equal((await leser('GET', `${H}/init`)).status, 200);
  assert.equal((await leser('GET', `${H}/plan/${planId}`)).status, 200);
  assert.equal((await leser('GET', `${H}/sollist?jahr=2096`)).status, 200);
  assert.equal((await leser('GET', `${H}/plan/${planId}/pdf`)).status, 200);
  assert.equal((await leser('POST', `${H}/plan`, { jahr: 2094 })).status, 403);
  assert.equal((await leser('PUT', `${H}/plan/${planId}/position`, { konto: '8391', planwert: 1 })).status, 403);
  assert.equal((await leser('POST', `${H}/sondereffekt`, { konto: '8391', jahr: 2092, grund: 'x' })).status, 403);
  assert.equal((await leser('POST', `${H}/plan/${planId}/paperless`)).status, 403);
  assert.equal((await leser('GET', `${H}/einstellungen`)).status, 403);
  // planen ja – beschließen, Nachtrag, löschen und Einstellungen nur mit :admin
  const r = await planer('POST', `${H}/plan`, { jahr: 2094 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await planer('POST', `${H}/plan/${r.body.id}/berechnen`, {})).status, 200);
  assert.equal((await planer('POST', `${H}/plan/${r.body.id}/beschliessen`, {})).status, 403);
  assert.equal((await planer('POST', `${H}/plan/${e.id}/nachtrag`, { begruendung: 'x' })).status, 403);
  assert.equal((await planer('POST', `${H}/plan/${r.body.id}/loeschen`, { grund: 'x' })).status, 403);
  assert.equal((await planer('PUT', `${H}/einstellungen`, {})).status, 403);
  assert.equal((await call('POST', `${H}/plan/${r.body.id}/loeschen`, { grund: 'Test beendet' })).status, 200);
});
