/**
 * Aushang in der Hallenbuchung (API): Pflege mit Prüfungen und Bildern, Anzeige in „Platz buchen“ nach Zeitraum und
 * Zielrollen, einmal je Benutzer bzw. bis zur Bestätigung, „allen noch einmal zeigen“, Nachweis wer gesehen/bestätigt hat,
 * Übernahme als Rundschreiben-Entwurf, Berechtigungen.
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

let app: Awaited<ReturnType<typeof buildApp>>;
function client() {
  let cookie = '';
  return async (method: string, path: string, payload?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    const ct = String(res.headers['content-type'] ?? '');
    return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body, roh: res.rawPayload, typ: ct };
  };
}
const admin = client();
async function anmelden(name: string) {
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { username: name, password: 'start-passwort' })).status, 200);
  assert.equal((await c('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);
  return c;
}
const T = '/api/m/tco';
const tag = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('sv-SE');
const PNG = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('aushang-bild')]).toString('base64')}`;
const PDF = `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n%%EOF').toString('base64')}`;
const basis = { titel: 'Halle', text: 'Bitte **sauber** verlassen.', stil: 'INFO', anzeige: 'EINMAL', bestaetigen: false, aktiv: true, gueltig_von: tag(-1), gueltig_bis: null as string | null, rollen: [] as string[] };

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  for (const [id, permissions] of [['AUSPFLEGE', ['tco.platz:admin', 'tco.platz:aushang']], ['AUSBUCHER', ['tco.platzbuchung:edit']], ['AUSLESER', ['tco.mitglieder:display']]] as const) {
    assert.equal((await admin('POST', '/api/admin/roles', { id, name: id, permissions })).status, 200);
  }
  for (const [u, roles] of [['auspfleger', ['AUSPFLEGE']], ['ausbucher', ['AUSBUCHER']], ['ausfremd', ['AUSLESER']]] as const) {
    assert.equal((await admin('POST', '/api/admin/users', { username: u, displayName: `${u} Name`, password: 'start-passwort', roles })).status, 200);
  }
});
after(async () => { await app?.close(); await sql.end(); });

test('Aushang: Rechte, Pflege, Bilder, Anzeige je Benutzer, Bestätigung, erneut zeigen, Nachweis, Rundschreiben, Löschen', async () => {
  const pfleger = await anmelden('auspfleger'), bucher = await anmelden('ausbucher'), fremd = await anmelden('ausfremd');
  // Rechte
  assert.equal((await fremd('GET', `${T}/platz/aushaenge`)).status, 403);
  assert.equal((await bucher('GET', `${T}/aushaenge`)).status, 403);
  assert.equal((await bucher('POST', `${T}/aushaenge`, basis)).status, 403);
  const katalog = JSON.stringify((await admin('GET', '/api/admin/permissions')).body);
  assert.ok(katalog.includes('tco.platz:aushang'));

  // Prüfungen
  assert.equal((await pfleger('POST', `${T}/aushaenge`, { ...basis, titel: ' ' })).status, 400);
  assert.equal((await pfleger('POST', `${T}/aushaenge`, { ...basis, gueltig_bis: tag(-5) })).status, 400);

  const neu = async (x: Partial<typeof basis>) => {
    const r = await pfleger('POST', `${T}/aushaenge`, { ...basis, ...x });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.id as number;
  };
  const warnung = await neu({ titel: 'Verschmutzung', stil: 'WARNUNG', bestaetigen: true });
  const immer = await neu({ titel: 'Netz kaputt', anzeige: 'IMMER' });
  const trainer = await neu({ titel: 'Nur Trainer', rollen: ['TRAINERROLLE'] });
  await neu({ titel: 'Ab morgen', gueltig_von: tag(1) });
  await neu({ titel: 'Abgelaufen', gueltig_von: tag(-10), gueltig_bis: tag(-2) });
  await neu({ titel: 'Aus', aktiv: false });

  // Bilder: nur JPG/PNG/WebP
  assert.equal((await pfleger('POST', `${T}/aushaenge/${warnung}/bilder`, { dateiname: 'beleg.pdf', data: PDF })).status, 400);
  let r = await pfleger('POST', `${T}/aushaenge/${warnung}/bilder`, { dateiname: 'dreck.png', data: PNG });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const bild = r.body.bilder[0].id as number;
  r = await pfleger('POST', `${T}/aushaenge/${trainer}/bilder`, { dateiname: 'trainer.png', data: PNG });
  const trainerBild = r.body.bilder[0].id as number;

  // Anzeige für den Bucher: Warnung vor Info, nur geltende, beide öffnen sich
  r = await bucher('GET', `${T}/platz/aushaenge`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.aktuell.map((a: { titel: string }) => a.titel), ['Verschmutzung', 'Netz kaputt']);
  assert.deepEqual(r.body.oeffnen, [warnung, immer]);
  assert.deepEqual(r.body.aktuell[0].bilder.map((b: { dateiname: string }) => b.dateiname), ['dreck.png']);
  // Bild laden: eigenes ja, das eines Aushangs für andere Rollen nicht
  r = await bucher('GET', `${T}/platz/aushaenge/${warnung}/bilder/${bild}`);
  assert.equal(r.status, 200);
  assert.match(r.typ, /image\/png/);
  assert.equal((await bucher('GET', `${T}/platz/aushaenge/${trainer}/bilder/${trainerBild}`)).status, 404);
  assert.equal((await fremd('GET', `${T}/platz/aushaenge/${warnung}/bilder/${bild}`)).status, 403);
  assert.equal((await pfleger('GET', `${T}/platz/aushaenge/${trainer}/bilder/${trainerBild}`)).status, 200, 'Verwaltung sieht alle Bilder');

  // gesehen, aber nicht bestätigt: öffnet sich wieder; bestätigt: nicht mehr; „bei jedem Aufruf“ immer
  assert.equal((await bucher('POST', `${T}/platz/aushaenge/${warnung}/gesehen`, { bestaetigt: false })).status, 200);
  assert.deepEqual((await bucher('GET', `${T}/platz/aushaenge`)).body.oeffnen, [warnung, immer]);
  await bucher('POST', `${T}/platz/aushaenge/${warnung}/gesehen`, { bestaetigt: true });
  await bucher('POST', `${T}/platz/aushaenge/${immer}/gesehen`, {});
  r = await bucher('GET', `${T}/platz/aushaenge`);
  assert.deepEqual(r.body.oeffnen, [immer]);
  assert.equal(r.body.aktuell[0].bestaetigt, true);
  // erneutes „gesehen ohne Bestätigung“ nimmt die Bestätigung nicht zurück
  await bucher('POST', `${T}/platz/aushaenge/${warnung}/gesehen`, { bestaetigt: false });
  assert.deepEqual((await bucher('GET', `${T}/platz/aushaenge`)).body.oeffnen, [immer]);

  // Verwaltung: Zähler und Nachweis
  r = await pfleger('GET', `${T}/aushaenge`);
  const w = r.body.liste.find((a: { id: number }) => a.id === warnung);
  assert.deepEqual([w.gesehen, w.bestaetigt, w.stand], [1, 1, 'AKTUELL']);
  assert.deepEqual(r.body.liste.map((a: { titel: string; stand: string }) => [a.titel, a.stand]).filter(([t]: string[]) => ['Ab morgen', 'Abgelaufen', 'Aus'].includes(t)).sort(),
    [['Ab morgen', 'GEPLANT'], ['Abgelaufen', 'ABGELAUFEN'], ['Aus', 'AUS']]);
  assert.equal(r.body.rundschreiben, false, 'ohne Rundschreiben-Recht kein Knopf');
  r = await pfleger('GET', `${T}/aushaenge/${warnung}/gesehen`);
  assert.equal(r.body.zeilen.length, 1);
  assert.equal(r.body.zeilen[0].name, 'ausbucher Name');
  assert.ok(r.body.zeilen[0].bestaetigt_am);

  // geändert ohne „neu anzeigen“: Stand bleibt; mit: alle sehen ihn noch einmal
  assert.equal((await pfleger('PUT', `${T}/aushaenge/${warnung}`, { ...basis, titel: 'Verschmutzung!', stil: 'WARNUNG', bestaetigen: true })).status, 200);
  assert.deepEqual((await bucher('GET', `${T}/platz/aushaenge`)).body.oeffnen, [immer]);
  assert.equal((await pfleger('PUT', `${T}/aushaenge/${warnung}`, { ...basis, titel: 'Verschmutzung!', stil: 'WARNUNG', bestaetigen: true, neu_anzeigen: true })).status, 200);
  assert.deepEqual((await bucher('GET', `${T}/platz/aushaenge`)).body.oeffnen, [warnung, immer]);

  // Zielrolle: der Bucher bekommt die Rolle dazu → er sieht auch den Aushang für Trainer
  await sql`insert into core.roles (id, name) values ('TRAINERROLLE', 'Trainer (Test)') on conflict do nothing`;
  await sql`insert into core.user_roles (user_id, role_id) select id, 'TRAINERROLLE' from core.users where username = 'ausbucher'`;
  const bucher2 = client();
  assert.equal((await bucher2('POST', '/api/auth/login', { username: 'ausbucher', password: 'neues-passwort' })).status, 200);
  assert.ok((await bucher2('GET', `${T}/platz/aushaenge`)).body.aktuell.some((a: { titel: string }) => a.titel === 'Nur Trainer'));

  // als Rundschreiben: nur mit Rundschreiben-Recht; Empfänger = Rollen mit „Platz buchen“ bzw. die Zielrollen
  assert.equal((await pfleger('POST', `${T}/aushaenge/${warnung}/rundschreiben`)).status, 403);
  r = await admin('POST', `${T}/aushaenge/${warnung}/rundschreiben`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let [rs] = await sql`select betreff, text, auswahl from tco.rundschreiben where id = ${r.body.id}`;
  assert.equal(rs.betreff, 'Verschmutzung!');
  assert.match(rs.text as string, /^\{Anrede\},\n\nBitte \*\*sauber\*\* verlassen\./);
  assert.ok((rs.auswahl as { rollen: string[] }).rollen.includes('AUSBUCHER'));
  assert.ok((rs.auswahl as { rollen: string[] }).rollen.includes('HALLENNUTZER'));
  assert.equal((rs.auswahl as { alle: boolean }).alle, false);
  assert.deepEqual((await sql`select dateiname, mime from tco.rundschreiben_anhaenge where rundschreiben_id = ${r.body.id}`).map((x) => [x.dateiname, x.mime]), [['dreck.png', 'image/png']]);
  r = await admin('POST', `${T}/aushaenge/${trainer}/rundschreiben`);
  [rs] = await sql`select auswahl from tco.rundschreiben where id = ${r.body.id}`;
  assert.deepEqual((rs.auswahl as { rollen: string[] }).rollen, ['TRAINERROLLE']);

  // Bild entfernen, Aushang löschen (samt Bildern und Nachweis)
  r = await pfleger('DELETE', `${T}/aushaenge/${warnung}/bilder/${bild}`);
  assert.deepEqual(r.body.bilder, []);
  assert.equal((await pfleger('DELETE', `${T}/aushaenge/${warnung}`)).status, 200);
  assert.equal((await sql`select count(*)::int as n from tco.aushang_gesehen where aushang_id = ${warnung}`)[0].n, 0);
  assert.equal((await pfleger('GET', `${T}/aushaenge/${warnung}/gesehen`)).status, 404);
});
