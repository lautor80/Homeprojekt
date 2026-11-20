/**
 * Kündigung und Mitgliedergruppen: Wer seine Mitgliedschaft kündigt, verliert ab diesem Zeitpunkt alle
 * Gruppenzuordnungen (Freigabe der Kündigung aus „Meine Mitgliedschaft“, Vorgang „Kündigung“, Austritt im
 * Mitgliedsstamm) – mit Änderungsbeleg und Hinweis in der Rückmeldung. Gekündigte lassen sich keiner Gruppe mehr
 * zuordnen, bis die Kündigung zurückgenommen ist. Der regelmäßige Lauf trägt Altfälle aus.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url.split('/').pop() ?? '')) throw new Error('TEST_DATABASE_URL fehlt oder enthält nicht "test".');
process.env.DATABASE_URL = url;
process.env.PORTAL_MODULES = 'tco';

const { sql, withChange } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { activeModules } = await import('../src/modules.js');
const { buildApp } = await import('../src/app.js');

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
const G = '/api/m/tco/gruppen';
const M = '/api/m/tco/mitglieder';
// eigene Adressnummern (kollisionsfrei zu den übrigen tco-Tests)
const KAI = '0000000951', LIA = '0000000952', MIA = '0000000953', NILS = '0000000954', OLE = '0000000955';

const gruppenVon = async (adrnr: string) => (await sql`select gruppe_id::int as g from tco.kal_gruppe_mitglieder where adrnr = ${adrnr} order by gruppe_id`).map((r) => r.g as number);
/** Änderungsbelege „Zuordnung gelöscht“ zu einem Mitglied (Schlüssel gruppe_id/adrnr) */
const belege = (adrnr: string) => sql`select action from core.change_header
                                        where table_name = 'tco.kal_gruppe_mitglieder' and change_ind = 'D' and object_key like ${`%/${adrnr}`}`;
const neueGruppe = async (name: string, parent_id: number | null = null) => {
  const r = await admin('POST', G, { name, parent_id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.id as number;
};

let herren = 0, h40 = 0, training = 0;

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, mitglnrn, eintritt, geburtsdatum, email, zahlungsart) values
              (${KAI}, 'Kai', 'Kündiger', '951', '2020-01-01', '1980-01-01', 'kai@example.org', 'U'),
              (${LIA}, 'Lia', 'Lob', '952', '2020-01-01', '1981-01-01', null, 'U'),
              (${MIA}, 'Mia', 'Matchball', '953', '2020-01-01', '1982-01-01', null, 'U'),
              (${NILS}, 'Nils', 'Netzroller', '954', '2020-01-01', '1983-01-01', null, 'U'),
              (${OLE}, 'Ole', 'Out', '955', '2020-01-01', '1984-01-01', null, 'U')`;
  await sql`insert into tco.mitgliedera (adrnr) values (${KAI}), (${LIA}), (${MIA}), (${NILS}), (${OLE})`;
  await sql`insert into tco.vertraege (adrnr, vertragnr, art, artname, sollstellung, vertragbegin, betrag) values
              (${KAI}, '1', '10', 'Erwachsene', 'jährlich', '2020-01-01', 120), (${MIA}, '1', '10', 'Erwachsene', 'jährlich', '2020-01-01', 120)`;
  // Kai hat einen Portalbenutzer („Meine Mitgliedschaft“)
  assert.equal((await admin('POST', '/api/admin/users', { username: 'kai', displayName: 'Kai', password: 'start-passwort', roles: ['MITGLIED'] })).status, 200);
  await sql`insert into tco.mitglied_benutzer (benutzer_id, adrnr) select id, ${KAI} from core.users where username = 'kai' on conflict (benutzer_id) do update set adrnr = excluded.adrnr`;
  herren = await neueGruppe('KG Herren');
  h40 = await neueGruppe('KG Herren 40', herren);
  training = await neueGruppe('KG Training');
});
after(async () => { await app?.close(); await sql.end(); });

test('Kündigung über „Meine Mitgliedschaft“: Einreichen ändert nichts, mit der Freigabe aus allen Gruppen ausgetragen', async () => {
  for (const g of [h40, training]) assert.equal((await admin('POST', `${G}/${g}/mitglieder`, { adrnrs: [KAI] })).status, 200);
  assert.deepEqual(await gruppenVon(KAI), [h40, training].sort((a, b) => a - b));

  const kai = client();
  assert.equal((await kai('POST', '/api/auth/login', { username: 'kai', password: 'start-passwort' })).status, 200);
  assert.equal((await kai('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);
  let r = await kai('POST', `${M}/meine/kuendigung`, { art: 'MITGLIEDSCHAFT', bestaetigung: true, grund: 'Umzug' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.id as number;
  // eingereicht, aber noch nicht freigegeben: die Kündigung steht noch nicht fest (sie kann abgelehnt werden)
  assert.equal((await gruppenVon(KAI)).length, 2, 'Einreichen ändert an den Gruppen nichts');

  r = await admin('POST', `${M}/kuendigungen/${id}/freigeben`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Aus 2 Gruppen ausgetragen\./);
  assert.deepEqual(await gruppenVon(KAI), [], 'nach der Freigabe in keiner Gruppe mehr');
  const b = await belege(KAI);
  assert.equal(b.length, 2, 'je entfernter Zuordnung ein Änderungsbeleg');
  assert.ok(b.every((x) => x.action === 'KUENDIGUNG'), JSON.stringify(b));

  // gekündigt: keine neue Zuordnung – weder in der Gruppenpflege noch im Mitgliedsstamm noch selbst
  r = await admin('POST', `${G}/${training}/mitglieder`, { adrnrs: [KAI] });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.message, /Kai Kündiger \(Austritt \d\d\.\d\d\.\d{4}\) hat die Mitgliedschaft gekündigt und kann keiner Gruppe mehr zugeordnet werden/);
  r = await admin('POST', `${G}/${training}/mitglieder`, { adrnrs: [OLE, KAI] });
  assert.equal(r.status, 400, 'mehrere: nichts wird aufgenommen');
  assert.deepEqual(await gruppenVon(OLE), []);
  assert.equal((await admin('POST', `${M}/m/${KAI}/gruppen`, { gruppe: h40 })).status, 400);
  assert.equal((await kai('POST', `${M}/meine/gruppen`, { gruppe: training })).status, 400);
  assert.deepEqual(await gruppenVon(KAI), []);
});

test('Austritt im Mitgliedsstamm (auch künftig) trägt aus; Rücknahme erlaubt die Zuordnung wieder', async () => {
  assert.equal((await admin('POST', `${G}/${h40}/mitglieder`, { adrnrs: [LIA] })).status, 200);
  const kuenftig = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
  let r = await admin('POST', `${M}/m/${LIA}/austritt`, { austritt: kuenftig });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Aus 1 Gruppe ausgetragen\./);
  assert.deepEqual(await gruppenVon(LIA), []);
  assert.equal((await belege(LIA)).length, 1);
  assert.equal((await admin('POST', `${G}/${h40}/mitglieder`, { adrnrs: [LIA] })).status, 400);
  // Kündigung zurückgenommen (Austritt entfernt): wieder zuordenbar, die alte Zuordnung kehrt nicht von selbst zurück
  r = await admin('POST', `${M}/m/${LIA}/austritt`, { austritt: null });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.doesNotMatch(r.body.text, /ausgetragen/);
  assert.deepEqual(await gruppenVon(LIA), []);
  assert.equal((await admin('POST', `${G}/${h40}/mitglieder`, { adrnrs: [LIA] })).status, 200);
  assert.deepEqual(await gruppenVon(LIA), [h40]);
});

test('Vorgang „Kündigung“: Prüfen kündigt das Austragen an, Ausführen trägt aus', async () => {
  for (const g of [h40, training]) assert.equal((await admin('POST', `${G}/${g}/mitglieder`, { adrnrs: [MIA] })).status, 200);
  const eingang = new Date().toISOString().slice(0, 10);
  const ende = `${Number(eingang.slice(0, 4)) + 1}-12-31`;
  const g = { typ: 'KUENDIGUNG', adrnr: MIA, umfang: 'MITGLIEDSCHAFT', eingang, ende };
  let r = await admin('POST', `${M}/vorgang/pruefen`, g);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.schritte.includes('Aus 2 Gruppen austragen'), JSON.stringify(r.body.schritte));
  assert.equal((await gruppenVon(MIA)).length, 2, 'Prüfen ändert nichts');
  r = await admin('POST', `${M}/vorgang`, g);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.schritte.includes('Aus 2 Gruppen ausgetragen'), JSON.stringify(r.body.schritte));
  assert.deepEqual(await gruppenVon(MIA), []);
  assert.equal((await belege(MIA)).length, 2);
});

test('Regelmäßiger Lauf: Altfälle (Austritt ohne Austragen, z. B. Import) verlieren ihre Gruppen – idempotent, mit Beleg', async () => {
  const { ausgetreteneSperrenMelden } = await import('../../modules/tco/server/mitglieder/selbst.js');
  // Altfall: Austritt direkt gesetzt, Zuordnungen bestehen weiter; Ole bleibt aktiv
  await sql`insert into tco.kal_gruppe_mitglieder (gruppe_id, adrnr) values (${h40}, ${NILS}), (${training}, ${NILS}), (${training}, ${OLE})`;
  await sql`update tco.mitglieder set austritt = current_date + 10 where adrnr = ${NILS}`;
  const lauf = () => withChange({ userId: null, username: 'system', action: 'AUSTRITT_SPERRE' }, (tx) => ausgetreteneSperrenMelden(tx as never));
  let r = await lauf();
  assert.deepEqual(r.gruppen.filter((x) => x.adrnr === NILS), [{ adrnr: NILS, anzahl: 2 }]);
  assert.deepEqual(await gruppenVon(NILS), []);
  assert.deepEqual(await gruppenVon(OLE), [training], 'aktive Mitglieder bleiben');
  const b = await belege(NILS);
  assert.equal(b.length, 2);
  assert.ok(b.every((x) => x.action === 'AUSTRITT_SPERRE'));
  r = await lauf();
  assert.deepEqual(r.gruppen, [], 'zweiter Lauf ändert nichts');
});

test('Regelwerk nimmt gekündigte Mitglieder nicht auf', async () => {
  // Regel „ab 18 Jahre“ für Training: Nils (gekündigt, Austritt künftig) bleibt draußen
  let r = await admin('PUT', `${G}/regeln`, { gruppe_id: training, regeln: [{ gruppe_id: training, alter_von: 18, alter_bis: null }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await admin('POST', `${G}/regeln/anwenden`, { gruppe_id: training });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const neu = r.body.gruppen.flatMap((g: { aufgenommen: { adrnr: string }[] }) => g.aufgenommen.map((p) => p.adrnr));
  assert.ok(!neu.includes(NILS) && !neu.includes(KAI), JSON.stringify(neu));
  assert.deepEqual(await gruppenVon(NILS), []);
});
