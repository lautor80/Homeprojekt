/**
 * Integrationstest Buchungssperre (Mahnwesen): Kennzeichen „Buchungssperre“ an der Stufe, Sperre nur für neue Hallenstunden
 * (Freiplätze bleiben frei), Hinweis nach der Anmeldung mit Bestätigung je Sitzung, Mahnsperre hebt die Sperre auf,
 * Teilzahlung reicht nicht, mit dem vollständigen Zahlungseingang ist das Mitglied automatisch wieder freigegeben.
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
const { heute, addTage } = await import('../../modules/tco/server/format.js');

let app: Awaited<ReturnType<typeof buildApp>>;
function client() {
  let cookie = '';
  return async (method: string, path: string, payload?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    const ct = String(res.headers['content-type'] ?? '');
    return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body };
  };
}
const admin = client();
const T = '/api/m/tco';
const P = `${T}/platz`;
const M = `${T}/mahnung`;
const SINA = '0000000871', TOM = '0000000872';
const RG = '2026_8701';
let H = '';
const tag = (n: number) => addTage(H, n);
let halle = 0, frei = 0;

const PLATZ = {
  name: 'Sperrhalle', art: 'HALLE', aliase: '', sort: 1, gueltig_von: '2026-01-01', gueltig_bis: '9999-12-31', wochentage: '1234567',
  zeit_von: '08:00', zeit_bis: '22:00', raster: 60, dauer_min: 60, dauer_max: 120, vorlauf_min: 1, vorlauf_max: 14, storno_frist: 24,
  max_offen: 0, abrechnen: true, aktiv: true, hinweis: null,
};

async function anmelden(name: string, kennwort = 'start-passwort') {
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { username: name, password: kennwort })).status, 200);
  if (kennwort === 'start-passwort') assert.equal((await c('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);
  return c;
}
const userId = async (name: string) => (await sql`select id::text as id from core.users where username = ${name}`)[0].id as string;
const einstellungen = async (stufen: { buchungssperre: boolean }[]) => {
  const c = (await admin('GET', `${M}/einstellungen`)).body;
  const r = await admin('PUT', `${M}/einstellungen`, {
    ...c, zahlungsziel_tage: c.zahlungsziel_tage ?? '',
    stufen: c.stufen.map((s: Record<string, unknown>, i: number) => ({ ...s, buchungssperre: stufen[i]?.buchungssperre ?? false })),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
};
/** zugestellte Stufe einer Rechnung (wie nach einem Mahnlauf) */
async function gemahnt(stufe: number, name: string, vorTagen: number) {
  const [l] = await sql`insert into tco.mahn_lauf (art, modus, status, stichtag, gestartet_von) values ('MANUELL', 'SENDEN', 'FERTIG', ${H}, 'test') returning id`;
  await sql`insert into tco.mahn_posten (lauf_id, art, nr, schuldner, name, betrag, faellig, stufe, stufe_name, status, weg, erledigt_am, frist)
            values (${l.id}, 'HALLE', ${RG}, ${SINA}, 'Sina Satz', 80, ${tag(-26)}, ${stufe}, ${name}, 'GESENDET', 'MAIL', now() - make_interval(days => ${vorTagen}), ${tag(-vorTagen + 10)})`;
}
let sina: ReturnType<typeof client>;
const sperre = async (c = sina) => (await c('GET', `${P}/buchungssperre`)).body as { gesperrt: boolean; posten: { nr: string; betrag: number }[]; text: string | null; bestaetigt: boolean };
const hallenBuchung = (von: string, c = sina, platz = halle) => c('POST', `${P}/buchungen`, { platz_id: platz, datum: tag(3), von, bis: `${String(Number(von.slice(0, 2)) + 1).padStart(2, '0')}:00` });

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Kai Kasse', password: 'geheim-geheim' });
  H = heute();
  await sql`update tco.verein set iban = 'DE02120300000000202051', zahlungsziel_tage = 14 where id = 1`;
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, eintritt, email) values
    (${SINA}, 'Sina', 'Satz', '2020-01-01', 'sina@sperre-test.example'), (${TOM}, 'Tom', 'Tiebreak', '2020-01-01', 'tom@sperre-test.example')`;
  for (const [key, preis] of [['001', 18], ['005', 20], ['010', 20]] as const) {
    await sql`insert into tco.produkte (prod_key, valid_from, valid_to, text, preis, typ) values (${key}, '2020-01-01', '9999-12-31', ${`Test ${key}`}, ${preis}, '2') on conflict do nothing`;
    for (const t of ['MONTAG', 'DIENSTAG', 'MITTWOCH', 'DONNERSTAG', 'FREITAG', 'SAMSTAG', 'SONNTAG']) {
      await sql`insert into tco.prmatrix (prod_key, valid_from, valid_to, tag, zeit_von, zeit_bis) values (${key}, '2020-01-01', '9999-12-31', ${t}, '07:00', '23:00') on conflict do nothing`;
    }
  }
  let r = await admin('POST', `${P}/admin/plaetze`, PLATZ);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  halle = r.body.id;
  r = await admin('POST', `${P}/admin/plaetze`, { ...PLATZ, name: 'Sperrplatz', art: 'FREI', sort: 2, abrechnen: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  frei = r.body.id;
  assert.equal((await admin('POST', '/api/admin/roles', { id: 'SPIELER87', name: 'Spieler', permissions: ['tco.platzbuchung:edit'] })).status, 200);
  for (const [u, a] of [['sina', SINA], ['tom', TOM]] as const) {
    assert.equal((await admin('POST', '/api/admin/users', { username: u, displayName: u, password: 'start-passwort', roles: ['SPIELER87'] })).status, 200);
    assert.equal((await admin('PUT', `${P}/admin/benutzer`, { benutzer_id: await userId(u), adrnr: a })).status, 200);
  }
  sina = await anmelden('sina');
  // Hallenrechnung: versendet vor 40 Tagen, fällig vor 26 Tagen
  await sql`insert into tco.rgkopf (rgnr_txt, jahr, rgnr, kunde, adrnr, betrag, status, angelegt_am, gedruckt, versendet) values
    (${RG}, 2026, 8701, 'SINA SATZ', ${SINA}, 80, '3', ${tag(-45)}, ${tag(-40)}, ${tag(-40)})`;
});
after(async () => { await app?.close(); await sql.end(); });

test('Ohne Kennzeichen an einer Stufe: keine Buchungssperre, auch nicht nach Mahnungen', async () => {
  const c = (await admin('GET', `${M}/einstellungen`)).body;
  assert.deepEqual(c.stufen.map((s: { buchungssperre: boolean }) => s.buchungssperre), [false, false, false], 'nach der Installation aus');
  await gemahnt(1, 'Zahlungserinnerung', 20);
  await gemahnt(2, '1. Mahnung', 5);
  assert.deepEqual(await sperre(), { gesperrt: false, posten: [], text: null, bestaetigt: false });
  const r = await hallenBuchung('09:00');
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('Kennzeichen ab Stufe: gesperrt nur ab der gekennzeichneten Stufe, nur für neue Hallenstunden', async () => {
  // Kennzeichen an der 2. Mahnung: Sina hat erst die 1. Mahnung – nicht gesperrt
  await einstellungen([{ buchungssperre: false }, { buchungssperre: false }, { buchungssperre: true }]);
  assert.equal((await sperre()).gesperrt, false);
  // Kennzeichen an der 1. Mahnung (gilt „ab“, also auch für die 2.): gesperrt
  await einstellungen([{ buchungssperre: false }, { buchungssperre: true }, { buchungssperre: false }]);
  const s = await sperre();
  assert.deepEqual([s.gesperrt, s.posten.map((p) => [p.nr, p.betrag]), s.bestaetigt], [true, [[RG, 80]], false]);
  assert.match(s.text ?? '', /2026_8701 \(offen 80,00 €\) bezahlt ist.*automatisch wieder freigegeben/);

  // neue Hallenbuchung abgelehnt, auch die Prüfung im Dialog meldet es; Freiplatz bleibt buchbar
  let r = await hallenBuchung('11:00');
  assert.equal(r.status, 403);
  assert.match(r.body.message, /Neue Hallenstunden können erst wieder gebucht werden/);
  r = await sina('POST', `${P}/pruefen`, { platz_id: halle, datum: tag(3), von: '11:00', bis: '12:00' });
  assert.match(r.body.fehler ?? '', /Neue Hallenstunden/);
  r = await sina('GET', `${P}/tag?datum=${tag(3)}`);
  assert.match(r.body.buchungssperre ?? '', /2026_8701/);
  r = await hallenBuchung('11:00', sina, frei);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // Abo-Bewerbung für die Halle ebenfalls gesperrt
  r = await sina('POST', `${P}/abowunsch`, { platz_id: halle, wochentag: 2, von: '18:00', bis: '19:00' });
  assert.equal(r.status, 403);
  // bestehende Buchung bleibt änderbar (Prüfung beim Ändern ohne Sperre)
  r = await sina('POST', `${P}/pruefen`, { platz_id: halle, datum: tag(3), von: '13:00', bis: '14:00', bid: 'X' });
  assert.ok(!/Neue Hallenstunden/.test(r.body.fehler ?? ''));

  // andere Mitglieder sind nicht betroffen
  const tom = await anmelden('tom');
  assert.equal((await sperre(tom)).gesperrt, false);
  assert.equal((await hallenBuchung('15:00', tom)).status, 200);

  // Mahnwesen zeigt die Sperre am Posten und als Kennzahl
  r = await admin('GET', M);
  assert.equal(r.body.posten.find((p: { nr: string }) => p.nr === RG).buchungssperre, true);
  assert.equal(r.body.kennzahlen.buchungssperre, 1);
});

test('Hinweis nach der Anmeldung: muss bestätigt werden, einmal je Sitzung', async () => {
  assert.equal((await sperre()).bestaetigt, false);
  assert.equal((await sina('POST', `${P}/buchungssperre/bestaetigen`, {})).status, 200);
  assert.equal((await sperre()).bestaetigt, true);
  const [g] = await sql`select posten from tco.buchungssperre_gesehen where user_id = ${await userId('sina')}`;
  assert.equal(g.posten, RG);
  // neue Anmeldung: Hinweis erscheint wieder; bestätigt bleibt die Sperre trotzdem bestehen
  const neu = await anmelden('sina', 'neues-passwort');
  const s = await sperre(neu);
  assert.deepEqual([s.gesperrt, s.bestaetigt], [true, false]);
  assert.equal((await hallenBuchung('16:00', sina)).status, 403);
});

test('Mahnsperre hebt die Buchungssperre auf; Teilzahlung reicht nicht; Zahlungseingang gibt automatisch frei', async () => {
  let r = await admin('POST', `${M}/sperren`, { ebene: 'SCHULDNER', schluessel: SINA, name: 'Sina Satz', grund: 'Ratenzahlung vereinbart' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await sperre()).gesperrt, false);
  const [sp] = await sql`select id from tco.mahn_sperre where schluessel = ${SINA}`;
  assert.equal((await admin('POST', `${M}/sperren/${sp.id}/aufheben`, {})).status, 200);
  assert.equal((await sperre()).gesperrt, true);

  // Teilzahlung: Rest 30 € bleibt offen – weiter gesperrt
  await sql`insert into tco.rgtz (rgnr_txt, fibeleg, betrag) values (${RG}, 'F8701A', 50)`;
  await sql`update tco.rgkopf set status = '5' where rgnr_txt = ${RG}`;
  const s = await sperre();
  assert.deepEqual([s.gesperrt, s.posten.map((p) => p.betrag)], [true, [30]]);
  assert.equal((await hallenBuchung('17:00')).status, 403);

  // vollständig bezahlt: ohne weiteres Zutun wieder frei
  await sql`insert into tco.rgtz (rgnr_txt, fibeleg, betrag) values (${RG}, 'F8701B', 30)`;
  await sql`update tco.rgkopf set status = '4', bezahlt = ${H} where rgnr_txt = ${RG}`;
  assert.deepEqual(await sperre(), { gesperrt: false, posten: [], text: null, bestaetigt: true });
  r = await hallenBuchung('17:00');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await sina('GET', `${P}/tag?datum=${tag(3)}`);
  assert.equal(r.body.buchungssperre, null);
});
