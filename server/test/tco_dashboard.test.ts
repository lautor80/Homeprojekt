/**
 * Integrationstest Vereinsübersicht (Dashboard): Endpunkt liefert alle Bereiche, Kennzahlen und
 * Diagrammdaten stimmen mit kleinen Testdaten überein, Details und Beitragsstufenwechsel, Berechtigung.
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
const { dashboardRoutes } = await import('../../modules/tco/server/dashboard/routes.js');

let app: Awaited<ReturnType<typeof buildApp>>;
function client() {
  let cookie = '';
  return async (method: string, path: string, payload?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
}
const admin = client();
const D = '/api/m/tco/dashboard';
const J = new Date().getFullYear();

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  // solange die Routen nicht in modules/tco/server/index.ts registriert sind, hier nachregistrieren
  if (!app.hasRoute({ method: 'GET', url: '/api/m/tco/dashboard' })) {
    await app.register(async (scope) => dashboardRoutes(scope), { prefix: '/api/m/tco' });
  }
  await admin('POST', '/api/setup', { orgName: 'TC Oberthal', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });

  // Mitglieder: 3 aktive (eine Jugendliche wird nächstes Jahr 18), 1 ausgetreten im Geschäftsjahr, 1 ohne Eintritt
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, geburtsdatum, eintritt, austritt, mitglnrn) values
            ('1', 'Anna', 'Alt', '1980-05-05', '2010-01-01', null, '0001'),
            ('2', 'Bernd', 'Bach', '1975-02-02', ${`${J - 1}-03-01`}, null, '0002'),
            ('3', 'Jana', 'Jung', ${`${J - 17}-06-15`}, ${`${J}-02-01`}, null, '0003'),
            ('4', 'Willi', 'Weg', '1960-01-01', '2005-01-01', ${`${J}-06-30`}, '0004'),
            ('5', 'Ohne', 'Eintritt', null, null, null, '0005')`;
  await sql`insert into tco.vertraege (adrnr, vertragnr, art, artname, sollstellung, vertragbegin, vertragende, betrag) values
            ('1', '1', '1', 'Erwachsene', 'J', '2010-01-01', null, 120),
            ('2', '1', '1', 'Erwachsene', 'J', ${`${J - 1}-03-01`}, null, 120),
            ('3', '1', '3', 'Jugendliche', 'J', ${`${J}-02-01`}, null, 40),
            ('3', '2', '90', 'Jugendtraining', 'M', ${`${J}-02-01`}, null, 15)`;
  // Clubhaus: zwei Monate Forderungen
  await sql`insert into tco.forderungen (jahr, monat, rechnung, ekbrutto, vkbrutto, reinigung, provision, forderung, einzahlungen, offene_posten, waers) values
            (${J}, 1, 'R1', 100, 300, 20, 30, 150, 150, 0, 'EUR'),
            (${J}, 2, 'R2', 200, 500, 20, 50, 230, 100, 130, 'EUR')`;
  // Finanzen: Bank 1000 (Geld) mit Anfangsbestand, Einnahme 8005, Ausgabe 3200, Darlehen 1500 (BK)
  await sql`insert into tco.fikonten (konto, name, kennzahl) values ('1000', 'Bank', 'BA'), ('8005', 'Beiträge', null), ('3200', 'Getränke', null), ('1500', 'Darlehen', 'BK')`;
  await sql`insert into tco.fibankab (jahr, konto, anfangsbestand) values (${J}, '1000', 1000), (${J}, '1500', -5000)`;
  await sql`insert into tco.fibuchungen (internenr, konto, posnr, jahr, monat, datum, text, betrag, gkonto, soll, haben) values
            ('1', '1000', 1, ${J}, 1, ${`${J}-01-10`}, 'Beitrag', 600, '8005', 600, 0),
            ('1', '8005', 2, ${J}, 1, ${`${J}-01-10`}, 'Beitrag', 600, '1000', 0, 600),
            ('2', '3200', 1, ${J}, 2, ${`${J}-02-05`}, 'Getränke', 150, '1000', 150, 0),
            ('2', '1000', 2, ${J}, 2, ${`${J}-02-05`}, 'Getränke', 150, '3200', 0, 150)`;
  // Jugend: Stundenrückmeldungen zweier Trainer
  await sql`insert into tco.jrueckm (zalias, adrnr, datum, trainingsart, anzahl) values
            ('MAX MUSTER', '1', ${`${J}-01-08`}, 'Jugendtraining', 1.5), ('MAX MUSTER', '1', ${`${J}-01-15`}, 'Jugendtraining', 1.5),
            ('EVA ELSTER', '2', ${`${J}-02-03`}, 'Jugendtraining', 2)`;
  // Halle: Abo (3), Einzel (1), Abo als Einzelabrechnung (status_abw), Storno (2) zählt nicht
  await sql`insert into tco.bookings (bid, datum, time_start, time_ende, status) values
            ('B1', ${`${J}-01-05`}, '18:00', '19:00', '3'), ('B2', ${`${J}-01-06`}, '18:00', '19:30', '1'),
            ('B3', ${`${J}-01-07`}, '18:00', '20:00', '3'), ('B4', ${`${J}-01-08`}, '18:00', '19:00', '2')`;
  await sql`insert into tco.bookings_ch (bid, status_abw) values ('B3', '1')`;
});
after(async () => { await app?.close(); await sql.end(); });

test('Dashboard: Bereiche, Kennzahlen und Diagrammdaten', async () => {
  const r = await admin('GET', `${D}?jahr=${J}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body;
  assert.equal(d.jahr, J);
  assert.ok(d.jahre.includes(J));
  assert.deepEqual(d.bereiche.map((b: any) => b.key), ['MITGLIEDER', 'CLUBHAUS', 'FINANZEN', 'JUGEND', 'HALLE']);
  const kpi = (k: string) => d.bereiche.flatMap((b: any) => b.kpis).find((x: any) => x.key === k);

  // Mitglieder: 4 mit Eintritt - 1 Austritt = 3; im Jahr J: 1 Eintritt, 1 Austritt, Saldo 0
  assert.equal(kpi('MTG_GESAMT').value, '3');
  assert.equal(kpi('MTG_GESAMT').delta, '(±0)');
  assert.equal(kpi('MTG_EINTRITT').value, '1');
  assert.equal(kpi('MTG_AUSTRITT').value, '1');
  assert.equal(kpi('MTG_AUSTRITT').state, 'None');
  assert.equal(kpi('MTG_JUBILAEUM').value, '1');
  assert.equal(kpi('MTG_JUBILAEUM').hasDetail, true);

  // Clubhaus: Forderung 380, Einzahlungen 250 (65 %), Rohertrag 800-300-40-80 = 380
  assert.equal(kpi('CLUB_FORD').value, '380,00');
  assert.equal(kpi('CLUB_FORD').details, '2 Rechnungen');
  assert.equal(kpi('CLUB_EINZ').details, '65 % der Forderungen');
  assert.equal(kpi('CLUB_UMSATZ').value, '380,00');
  assert.equal(kpi('CLUB_UMSATZ').state, 'Positive');

  // Finanzen: Einnahmen 600, Ausgaben 150, Gewinn 450; Bank AB 1000 + 600 - 150 = 1450
  assert.equal(kpi('FIN_GEWINN').value, '450,00');
  assert.equal(kpi('FIN_GEWINN').details, 'Einnahmen 600,00 / Ausgaben 150,00');
  assert.equal(kpi('FIN_SALDO').value, '1.450,00');
  assert.equal(kpi('FIN_SALDO').details, 'Anfangsbestand 1.000,00 EUR');
  const fin = d.charts.finanzen;
  assert.equal(fin.anfangsbestand, 1000);
  assert.equal(fin.kontostand, 1450);
  assert.equal(fin.einnahmen, 600);
  assert.equal(fin.ausgaben, 150);
  assert.equal(fin.verlauf.length, 12);
  assert.equal(fin.verlauf[0].einnahmen, 600);
  assert.equal(fin.verlauf[1].bestand, 1450);
  assert.deepEqual(fin.konten.map((k: any) => k.key), ['1000']);
  // Liquidität: Geld 1450 + Forderungen 130 (Stand 02/J) + Kredit -5000
  assert.equal(fin.liquiditaet.geld, 1450);
  assert.equal(fin.liquiditaet.forderung, 130);
  assert.equal(fin.liquiditaet.kredit, -5000);
  assert.equal(fin.liquiditaet.liquiditaet, -3420);

  // Jugend: 3 Std im Januar + 2 im Februar = 5 im Jahr
  assert.equal(kpi('JUG_TRAINING').details, `5 Std im Jahr ${J}`);
  const jug = d.charts.jugend;
  assert.deepEqual(jug.jahreSel, [String(J)]);
  assert.equal(jug.stacks.length, 2);
  assert.equal(jug.stacks[0].text, `Max Muster (3 Std)`);
  assert.equal(jug.values.find((v: any) => v.grp === 1 && v.stack === 'MAX MUSTER').value, 3);

  // Halle: Abo 1 Std, Einzel 1,5 + 2 (Abo mit Einzelabrechnung) = 3,5 Std; Storno zählt nicht
  const hal = d.charts.halle;
  assert.equal(hal.values.find((v: any) => v.stack === 'ABO').value, 1);
  assert.equal(hal.values.find((v: any) => v.stack === 'EINZEL').value, 3.5);
  assert.equal(hal.bars[0].text, `${J}: 4,5 Std`);
  assert.equal(hal.jahreVerlauf.data.at(-1).val1, 4.5);

  // Mitgliederentwicklung je Monat: Bestand zu Jahresbeginn 3 (1, 2, 4), Februar +1, Juni -1
  const mm = d.charts.mitgliederMonate.data;
  assert.equal(mm[0].val_line, 3);
  assert.equal(mm[1].bar_pos, 1);
  assert.equal(mm[5].bar_neg, -1);
  assert.equal(mm[11].val_line, 3);
  // Clubhaus-Diagramm: Februar VK 500, Rohertrag 230
  assert.deepEqual(d.charts.clubhaus.data[1], { label: '02', val1: 500, val2: 230 });

  // Umschalten Jugend-Ansicht „Gesamtstunden“ und ungültige Jahresauswahl fällt auf das Geschäftsjahr zurück
  const g = await admin('GET', `${D}?jahr=${J}&jugAnsicht=GESAMT&jugJahre=1999`);
  assert.equal(g.body.charts.jugend.stacks.length, 1);
  assert.deepEqual(g.body.charts.jugend.jahreSel, [String(J)]);
});

test('Dashboard: Details und Beitragsstufenwechsel', async () => {
  let r = await admin('GET', `${D}/detail/CLUB_UMSATZ?jahr=${J}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.zeilen.length, 2);
  assert.deepEqual(r.body.zeilen[1].cols, [`02/${J}`, '500,00', '200,00', '70,00', '230,00']);

  r = await admin('GET', `${D}/detail/CLUB_OP?jahr=${J}`);
  assert.equal(r.body.zeilen.length, 1);
  assert.equal(r.body.info, '1 offene Rechnung(en).');

  r = await admin('GET', `${D}/detail/MTG_JUBILAEUM`);
  assert.equal(r.body.mode, 'BSW');
  assert.equal(r.body.zeilen.length, 1);
  assert.equal(r.body.zeilen[0].cols[0], 'Jung, Jana');
  assert.equal(r.body.zeilen[0].state, 'Critical');
  assert.equal(r.body.stichtag, `${J}-12-31`);
  assert.deepEqual(r.body.stufen.map((s: any) => s.key), ['1']);

  // Stichtag vor Vertragsbeginn wird abgelehnt
  r = await admin('POST', `${D}/beitragswechsel`, { stichtag: `${J}-01-15`, zeilen: [{ adrnr: '3', vertragnr: '1', art: '1', name: 'Jung, Jana' }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, 0);
  assert.match(r.body.fehler[0], /vor dem Vertragsbeginn/);

  // Wechsel zum Jahresende: Jugendvertrag endet, neuer Vertrag 3 ab 01.01.
  r = await admin('POST', `${D}/beitragswechsel`, { stichtag: `${J}-12-31`, zeilen: [{ adrnr: '3', vertragnr: '1', art: '1', name: 'Jung, Jana' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, 1);
  assert.match(r.body.text, /Erwachsene - 120,00 EUR J/);
  const v = await sql`select vertragnr, art, vertragbegin, vertragende, betrag::float8 as betrag from tco.vertraege where adrnr = '3' order by vertragnr`;
  assert.equal(v.find((x) => x.vertragnr === '1')!.vertragende, `${J}-12-31`);
  const neu = v.find((x) => x.vertragnr === '3')!;
  assert.equal(neu.art, '1');
  assert.equal(neu.vertragbegin, `${J + 1}-01-01`);
  assert.equal(neu.betrag, 120);
  // Kachel zeigt danach 0 Mitglieder
  r = await admin('GET', `${D}?jahr=${J}`);
  assert.equal(r.body.bereiche[0].kpis.find((k: any) => k.key === 'MTG_JUBILAEUM').value, '0');
  // Änderungsbeleg vorhanden
  const [a] = await sql`select count(*)::int as n from core.change_header where action = 'BEITRAGSWECHSEL' and object_type = 'MITGLIED'`;
  assert.ok(a.n >= 2, 'Änderungsbelege für Vertragsende und neuen Vertrag');
});

test('Dashboard: Buchungen ohne Beleg im laufenden Monat, Abgleich Gewinn/Ergebnis (#25)', async () => {
  const heute = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10);
  const mon = Number(heute.slice(5, 7));
  // laufender Monat: eine Buchung ohne Beleg, eine mit Beleg, ein Paar Buchung/Storno; Erlös gegen Darlehen (kein Geldkonto)
  await sql`insert into tco.fibuchungen (internenr, konto, posnr, jahr, monat, datum, text, betrag, gkonto, soll, haben, storno_zu) values
            ('91', '1000', 0, ${J}, ${mon}, ${heute}, 'ohne', 10, '8005', 10, 0, null), ('91', '8005', 0, ${J}, ${mon}, ${heute}, 'ohne', 10, '1000', 0, 10, null),
            ('92', '1000', 0, ${J}, ${mon}, ${heute}, 'mit', 20, '8005', 20, 0, null), ('92', '8005', 0, ${J}, ${mon}, ${heute}, 'mit', 20, '1000', 0, 20, null),
            ('93', '1000', 0, ${J}, ${mon}, ${heute}, 'storniert', 5, '3200', 0, 5, null), ('93', '3200', 0, ${J}, ${mon}, ${heute}, 'storniert', 5, '1000', 5, 0, null),
            ('94', '1000', 0, ${J}, ${mon}, ${heute}, 'Storno', 5, '3200', 5, 0, '93'), ('94', '3200', 0, ${J}, ${mon}, ${heute}, 'Storno', 5, '1000', 0, 5, '93'),
            ('95', '8005', 0, ${J}, ${mon}, ${heute}, 'Umbuchung', 50, '1500', 0, 50, null), ('95', '1500', 0, ${J}, ${mon}, ${heute}, 'Umbuchung', 50, '8005', 50, 0, null)`;
  await sql`insert into tco.fipapermap (internenr, konto, doknr) values ('92', '', '000123')`;
  try {
    const r = await admin('GET', `${D}?jahr=${J}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const kpi = (k: string) => r.body.bereiche.flatMap((b: any) => b.kpis).find((x: any) => x.key === k);
    // 91 und 95 ohne Beleg; 92 hat Beleg; 93/94 Storno-Paar zählt nicht
    assert.equal(kpi('FIN_OHNE_BELEG').value, '2');
    assert.equal(kpi('FIN_OHNE_BELEG').todo, false);
    assert.equal(kpi('FIN_OHNE_BELEG').state, 'Critical');
    // Gewinn 450 + 10 + 20 + 50 = 530; die 50 gegen das Darlehen fehlen im Ergebnis der Card
    assert.equal(kpi('FIN_GEWINN').value, '530,00');
    assert.match(kpi('FIN_GEWINN').details, /davon ohne Geldkonto 50,00/);
    assert.equal(r.body.charts.finanzen.ergebnis, 480);
  } finally {
    await sql`delete from tco.fipapermap where internenr = '92'`;
    await sql`delete from tco.fibuchungen where internenr in ('91', '92', '93', '94', '95')`;
  }
});

test('Dashboard: Berechtigung', async () => {
  assert.equal((await admin('POST', '/api/admin/roles', { id: 'DASH_LESER', name: 'Übersicht lesen', permissions: ['tco.dashboard:display'] })).status, 200);
  assert.equal((await admin('POST', '/api/admin/users', { username: 'leser', displayName: 'Lea Leser', password: 'start-passwort', roles: ['DASH_LESER'] })).status, 200);
  const leser = client();
  assert.equal((await leser('POST', '/api/auth/login', { username: 'leser', password: 'start-passwort' })).status, 200);
  assert.equal((await leser('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);
  assert.equal((await leser('GET', `${D}?jahr=${J}`)).status, 200);
  assert.equal((await leser('GET', `${D}/detail/MTG_JUBILAEUM`)).status, 200);
  assert.equal((await leser('POST', `${D}/beitragswechsel`, { stichtag: `${J}-12-31`, zeilen: [{ adrnr: '3', vertragnr: '1', art: '1' }] })).status, 403);
  const niemand = client();
  assert.equal((await niemand('GET', D)).status, 401);
});
