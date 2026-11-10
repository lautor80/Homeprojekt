/**
 * Rollenpflege als Matrix mit Prüfungen (#46): Überlappungen, überflüssige Zuordnungen, Funktionstrennung,
 * Voraussetzungen, unbekannte Rechte; Sichern mehrerer Rollen in einem Schritt.
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
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
}
const admin = client();
const R = '/api/admin/roles';
type B = { art: string; stufe: string; rollen: string[]; rechte: string[]; benutzer?: string[]; text: string };
const befunde = async (c = admin, rollen?: unknown) => (await c('POST', `${R}/pruefung`, rollen ? { rollen } : {})).body.befunde as B[];
const finde = (l: B[], art: string, ...rollen: string[]) => l.find((b) => b.art === art && rollen.every((r) => b.rollen.includes(r)));
const rechte = async (id: string) => (await sql`select permission from core.role_permissions where role_id = ${id} order by 1`).map((x) => x.permission as string);

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  const rolle = (id: string, permissions: string[]) => admin('POST', R, { id, name: id.toLowerCase(), permissions });
  await rolle('KASSE', ['tco.fi:display', 'tco.fi:buchen', 'tco.mitglieder:display', 'tco.halle:display']);
  await rolle('KASSE2', ['tco.fi:display', 'tco.fi:buchen', 'tco.mitglieder:display', 'tco.halle:display']);
  await rolle('LESER', ['tco.fi:display', 'tco.mitglieder:display']);
  await rolle('FAST', ['tco.fi:display', 'tco.fi:buchen', 'tco.mitglieder:display', 'tco.clubhaus:display']);
  await rolle('TRAINER', ['tco.jtmeine:edit']);
  await rolle('JUGEND', ['tco.jt:display', 'tco.jt:edit']);
  await rolle('THEKE', ['tco.verzehr:theke', 'tco.verzehr:admin', 'tco.verzehr:display']);
  await rolle('LEER', []);
  await rolle('PFLEGE', ['core.roles:display', 'core.roles:edit']);
  for (const [u, roles] of [['doppelt', ['KASSE', 'LESER']], ['trainer', ['TRAINER', 'JUGEND']], ['pfleger', ['PFLEGE']]] as const) {
    assert.equal((await admin('POST', '/api/admin/users', { username: u, displayName: `Name ${u}`, password: 'start-passwort', roles })).status, 200);
    await sql`update core.users set must_change_password = false where username = ${u}`;
  }
  // Altlasten, wie sie die Einzelpflege zulässt: unbekannte Kennung, Recht ohne Voraussetzung
  await sql`insert into core.role_permissions (role_id, permission) values ('LEER', 'tco.gibtsnicht:edit')`;
  await sql`insert into core.role_permissions (role_id, permission) values ('TRAINER', 'tco.halle:edit')`;
});
after(async () => { await app?.close(); await sql.end(); });

test('Prüfung: Überlappungen zwischen Rollen und überflüssige Zuordnungen', async () => {
  const l = await befunde();
  assert.equal(finde(l, 'GLEICH', 'KASSE', 'KASSE2')?.stufe, 'FEHLER');
  assert.deepEqual(finde(l, 'ENTHALTEN', 'LESER', 'KASSE')?.rollen, ['LESER', 'KASSE'], 'kleinere Rolle zuerst');
  assert.match(finde(l, 'UEBERLAPPUNG', 'KASSE', 'FAST')!.text, /teilen 3 Rechte \(60 % Überlappung\)/);
  assert.equal(finde(l, 'UEBERLAPPUNG', 'KASSE', 'LESER'), undefined, 'enthalten wird nicht zusätzlich als Überlappung gemeldet');
  assert.deepEqual(finde(l, 'BENUTZER_DOPPELT', 'LESER', 'KASSE')?.benutzer, ['Name doppelt']);
  assert.ok(l.findIndex((b) => b.stufe === 'HINWEIS') > l.findIndex((b) => b.stufe === 'FEHLER'), 'Fehler zuerst');
});

test('Prüfung: Funktionstrennung, Voraussetzungen, unbekannte Rechte, leere Rollen', async () => {
  const l = await befunde();
  assert.deepEqual(finde(l, 'TRENNUNG', 'THEKE')?.rechte, ['tco.verzehr:theke', 'tco.verzehr:admin']);
  const tb = finde(l, 'TRENNUNG_BENUTZER', 'TRAINER', 'JUGEND')!;
  assert.deepEqual([tb.benutzer, tb.stufe], [['Name trainer'], 'WARNUNG']);
  assert.deepEqual(finde(l, 'VORAUSSETZUNG', 'TRAINER')?.rechte, ['tco.halle:edit']);
  assert.deepEqual(finde(l, 'UNBEKANNT', 'LEER')?.rechte, ['tco.gibtsnicht:edit']);
  assert.ok(finde(l, 'OHNE_BENUTZER', 'FAST'));
  assert.ok(l.find((b) => b.art === 'UNVERGEBEN')!.rechte.includes('core.backup:restore'));
  assert.ok(!l.some((b) => b.rollen.includes('ADMIN')), 'ADMIN nimmt an Vergleichen nicht teil');
  // Entwurf aus der Matrix: noch nicht gesicherter Stand wird geprüft, gespeichert wird nichts
  const e = await befunde(admin, [{ id: 'KASSE2', permissions: ['tco.clubhaus:display'] }, { id: 'LEER', permissions: [] }]);
  assert.equal(finde(e, 'GLEICH', 'KASSE', 'KASSE2'), undefined);
  assert.ok(finde(e, 'LEER', 'LEER'));
  assert.equal((await rechte('KASSE2')).length, 4);
  const r = await admin('POST', `${R}/pruefung`);
  assert.equal(r.body.fehler, r.body.befunde.filter((b: B) => b.stufe === 'FEHLER').length);
});

test('Matrix sichern: mehrere Rollen in einem Schritt, Schutzregeln, kein stilles Überschreiben', async () => {
  const M = `${R}/matrix`;
  const vorher = { KASSE2: await rechte('KASSE2'), FAST: await rechte('FAST') };
  let r = await admin('PUT', M, { rollen: [
    { id: 'KASSE2', vorher: vorher.KASSE2, permissions: ['tco.clubhaus:display'] },
    { id: 'FAST', vorher: vorher.FAST, permissions: [...vorher.FAST, 'tco.halle:display'] },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([await rechte('KASSE2'), (await rechte('FAST')).length], [['tco.clubhaus:display'], 5]);

  // veralteter Stand → 409, nichts gesichert (auch die andere Rolle des Aufrufs nicht)
  r = await admin('PUT', M, { rollen: [
    { id: 'LESER', vorher: await rechte('LESER'), permissions: [] },
    { id: 'KASSE2', vorher: vorher.KASSE2, permissions: [] },
  ] });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal((await rechte('LESER')).length, 2);

  const m = (id: string, permissions: string[], v: string[]) => admin('PUT', M, { rollen: [{ id, vorher: v, permissions }] });
  assert.equal((await m('KASSE2', ['tco.gibtsnicht:edit'], ['tco.clubhaus:display'])).status, 400, 'unbekanntes Recht');
  assert.equal((await m('ADMIN', [], ['*'])).status, 400, 'Systemrolle');
  // vorhandene unbekannte Kennung darf bleiben oder entfernt werden
  assert.equal((await m('LEER', [], ['tco.gibtsnicht:edit'])).status, 200);
  // „nur Admin“-Rollen: Administrator ja, aber keine core-Rechte; Rollenpfleger ohne ADMIN nicht
  const hn = await rechte('HALLENNUTZER');
  assert.equal((await m('HALLENNUTZER', [...hn, 'core.users:display'], hn)).status, 400);
  assert.equal((await m('HALLENNUTZER', [...hn, 'tco.halle:display'], hn)).status, 200);
  assert.equal((await m('HALLENNUTZER', hn, [...hn, 'tco.halle:display'])).status, 200);
  const pfleger = client();
  assert.equal((await pfleger('POST', '/api/auth/login', { username: 'pfleger', password: 'start-passwort' })).status, 200);
  r = await pfleger('PUT', M, { rollen: [{ id: 'HALLENNUTZER', vorher: hn, permissions: [] }] });
  assert.equal(r.status, 403);
  assert.equal((await pfleger('PUT', M, { rollen: [{ id: 'LEER', vorher: [], permissions: ['tco.fi:display'] }] })).status, 200);
  assert.equal((await pfleger('POST', `${R}/pruefung`)).status, 200);
  const ohne = client();
  assert.equal((await ohne('POST', '/api/auth/login', { username: 'doppelt', password: 'start-passwort' })).status, 200);
  assert.equal((await ohne('POST', `${R}/pruefung`)).status, 403);
  assert.equal((await ohne('PUT', M, { rollen: [{ id: 'LEER', vorher: ['tco.fi:display'], permissions: [] }] })).status, 403);
});

test('Verprobung: wirksame Rechte ausgewählter Benutzer mit Matrix-Entwurf und probeweiser Zuordnung', async () => {
  const V = `${R}/verprobung`;
  const id = async (u: string) => (await sql`select id::text from core.users where username = ${u}`)[0].id as string;
  const [trainer, doppelt, adminId] = [await id('trainer'), await id('doppelt'), await id('admin')];

  // heutiger Stand: Rollen, Herkunft der Rechte, Funktionstrennung über zwei Rollen
  let r = await admin('POST', V, { benutzer: [trainer] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let t = r.body[0];
  assert.deepEqual([t.rollenJetzt, t.rollenProbe, t.dazu, t.weg], [['JUGEND', 'TRAINER'], ['JUGEND', 'TRAINER'], [], []]);
  assert.deepEqual(t.rechte.find((x: any) => x.id === 'tco.jt:edit').rollen, ['JUGEND']);
  assert.ok(t.befunde.some((b: any) => b.stufe === 'WARNUNG' && /Funktionstrennung/.test(b.text)));
  assert.ok(t.apps.some((a: string) => /Jugend/.test(a)));

  // Entwurf der Matrix: JUGEND ohne „abrechnen“ → Recht fällt weg, Warnung verschwindet; gespeichert wird nichts
  r = await admin('POST', V, { benutzer: [trainer], rollen: [{ id: 'JUGEND', permissions: ['tco.jt:display'] }] });
  t = r.body[0];
  assert.deepEqual(t.weg, ['tco.jt:edit']);
  assert.equal(t.anzahlProbe, t.anzahlJetzt - 1);
  assert.ok(!t.befunde.some((b: any) => /Funktionstrennung/.test(b.text)));
  assert.equal((await rechte('JUGEND')).length, 2);

  // probeweise Zuordnung: zusätzlich bzw. statt der bisherigen Rollen; mehrere Benutzer auf einmal
  r = await admin('POST', V, { benutzer: [doppelt, trainer], zuordnung: { rollen: ['THEKE'], modus: 'ZUSAETZLICH' } });
  assert.deepEqual(r.body.map((x: any) => x.username).sort(), ['doppelt', 'trainer']);
  const d = r.body.find((x: any) => x.username === 'doppelt');
  assert.deepEqual(d.rollenProbe, ['KASSE', 'LESER', 'THEKE']);
  assert.ok(d.dazu.includes('tco.verzehr:theke'));
  assert.ok(d.befunde.some((b: any) => /LESER ist überflüssig/.test(b.text)));
  r = await admin('POST', V, { benutzer: [doppelt], zuordnung: { rollen: ['LESER'], modus: 'ERSETZEN' } });
  assert.deepEqual([r.body[0].rollenProbe, r.body[0].weg.includes('tco.fi:buchen'), r.body[0].dazu], [['LESER'], true, []]);
  assert.deepEqual((await sql`select role_id from core.user_roles where user_id = ${doppelt}::uuid order by 1`).map((x) => x.role_id), ['KASSE', 'LESER'], 'Zuordnung unverändert');

  // Administrator: alle Rechte
  r = await admin('POST', V, { benutzer: [adminId] });
  assert.deepEqual([r.body[0].allesJetzt, r.body[0].allesProbe], [true, true]);

  // Berechtigung: Rollen anzeigen UND Benutzer anzeigen
  const pfleger = client();
  assert.equal((await pfleger('POST', '/api/auth/login', { username: 'pfleger', password: 'start-passwort' })).status, 200);
  assert.equal((await pfleger('POST', V, { benutzer: [trainer] })).status, 403);
  assert.equal((await admin('POST', V, { benutzer: [] })).status, 400);
});
