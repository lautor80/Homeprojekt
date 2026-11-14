/**
 * Sicherung mit Fortschritt (Hintergrundauftrag, Restdauer) und täglicher Export in die Nextcloud (WebDAV):
 * Einrichtung mit maskierten Geheimnissen, Verbindungstest, Export mit Upload und Aufbewahrung,
 * Fehlerstatus im Arbeitsvorrat, Zeitplan (fällig einmal am Tag ab Uhrzeit), PROPFIND-Auswertung.
 * Dateiweise Übertragung ohne ZIP: Ordner je Lauf, Manifest zuletzt, Prüfsummen, Prüfung der Vollständigkeit,
 * erneuter Versuch bei vorübergehender Störung, kein halber Stand nach Fehlern, Rücksicherung aus dem Ordner.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url.split('/').pop() ?? '')) throw new Error('TEST_DATABASE_URL fehlt oder enthält nicht "test".');
process.env.DATABASE_URL = url;
process.env.PORTAL_MODULES = 'tco';
process.env.BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sicherung-export-test-'));

const { sql } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { activeModules } = await import('../src/modules.js');
const { buildApp } = await import('../src/app.js');
const { faellig } = await import('../src/backup-export.js');
const { davAntwort, davBasis } = await import('../src/lib/webdav.js');
const { entpacken: lesen } = await import('../src/backup.js');
const { zipSchreiben } = await import('../src/backup-xml.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
async function call(method: string, p: string, payload?: unknown) {
  const res = await app.inject({ method: method as 'GET', url: p, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
  const set = res.headers['set-cookie'];
  if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
  const ct = String(res.headers['content-type'] ?? '');
  return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.rawPayload };
}
const B = '/api/backup';

// ---------------------------------------------------------------- WebDAV-Attrappe (Nextcloud)
const dav = { dateien: new Map<string, { daten: Buffer; zeit: Date }>(), ordner: new Set<string>(['/remote.php/dav/files/vorstand']), auth: [] as string[], voll: false,
  /** Reihenfolge der Uploads; einmalige Störung (HTTP 503) bzw. abgeschnittene Ablage für Pfade, die so enden */
  puts: [] as string[], stoerung: '', gestoert: 0, abschneiden: '' };
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const p = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/\/+$/, '');
    dav.auth.push(String(req.headers.authorization ?? ''));
    if (req.headers.authorization !== `Basic ${Buffer.from('vorstand:app-pw').toString('base64')}`) { res.writeHead(401); return res.end(); }
    if (req.method === 'MKCOL') {
      if (dav.ordner.has(p)) { res.writeHead(405); return res.end(); }
      dav.ordner.add(p); res.writeHead(201); return res.end();
    }
    if (req.method === 'PUT') {
      if (dav.voll) { res.writeHead(507); return res.end(); }
      if (dav.stoerung && p.endsWith(dav.stoerung) && dav.gestoert++ === 0) { res.writeHead(503); return res.end(); }
      if (!dav.ordner.has(path.posix.dirname(p))) { res.writeHead(409); return res.end(); }
      const daten = Buffer.concat(chunks);
      dav.puts.push(p);
      dav.dateien.set(p, { daten: dav.abschneiden && p.endsWith(dav.abschneiden) ? daten.subarray(0, daten.length - 1) : daten, zeit: new Date() });
      res.writeHead(201); return res.end();
    }
    if (req.method === 'DELETE') {
      // Ordner samt Inhalt bzw. einzelne Datei
      for (const k of [...dav.dateien.keys()]) if (k === p || k.startsWith(`${p}/`)) dav.dateien.delete(k);
      for (const k of [...dav.ordner]) if (k === p || k.startsWith(`${p}/`)) dav.ordner.delete(k);
      res.writeHead(204); return res.end();
    }
    if (req.method === 'PROPFIND') {
      if (!dav.ordner.has(p)) { res.writeHead(404); return res.end(); }
      const eintrag = (href: string, ordner: boolean, groesse = 0, zeit = new Date()) =>
        `<d:response><d:href>${encodeURI(href)}${ordner ? '/' : ''}</d:href><d:propstat><d:prop><d:getlastmodified>${zeit.toUTCString()}</d:getlastmodified>`
        + `${ordner ? '<d:resourcetype><d:collection/></d:resourcetype>' : `<d:resourcetype/><d:getcontentlength>${groesse}</d:getcontentlength>`}</d:prop></d:propstat></d:response>`;
      const kinder = [
        ...[...dav.ordner].filter((k) => path.posix.dirname(k) === p).map((k) => eintrag(k, true)),
        ...[...dav.dateien.entries()].filter(([k]) => path.posix.dirname(k) === p).map(([k, v]) => eintrag(k, false, v.daten.length, v.zeit)),
      ];
      res.writeHead(207, { 'content-type': 'application/xml' });
      return res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${eintrag(p, true)}${kinder.join('')}</d:multistatus>`);
    }
    res.writeHead(400); res.end();
  });
});
let basis = '';

before(async () => {
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  basis = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'TC Export', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, eintritt) select lpad(g::text, 10, '0'), 'Vor' || g, 'Nach' || g, '2020-01-01' from generate_series(1, 300) g`;
  await sql`analyze tco.mitglieder`;
});
after(async () => { await app?.close(); await sql.end(); server.close(); });

async function abwarten(id: string) {
  const staende: any[] = [];
  for (let i = 0; i < 200; i++) {
    const r = await call('GET', `${B}/job/${id}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    staende.push(r.body);
    if (r.body.fertig) return { j: r.body, staende };
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error('Auftrag wird nicht fertig');
}

test('Sicherung als Hintergrundauftrag mit Fortschritt und Restdauer', async () => {
  let r = await call('POST', `${B}/start`, { format: 'portal', passwort: 'kurz' });
  assert.equal(r.status, 400);
  r = await call('POST', `${B}/start`, { format: 'zip', mitAenderungsbelegen: false, notiz: 'mit Fortschritt' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.fertig, false);
  assert.ok(r.body.prozent >= 0 && r.body.prozent < 100);
  const { j, staende } = await abwarten(r.body.id);
  assert.equal(j.fehler, null);
  assert.equal(j.prozent, 100);
  assert.equal(j.phase, 'fertig');
  assert.match(j.ergebnis.name, /^portal_.*\.zip$/);
  assert.match(j.ergebnis.text, /als ZIP mit XML/);
  // Prozent steigt nie
  for (let i = 1; i < staende.length; i++) assert.ok(staende[i].prozent >= staende[i - 1].prozent);
  r = await call('GET', B);
  assert.ok(r.body.dateien.some((d: any) => d.name === j.ergebnis.name));
  assert.equal(r.body.laufend, null);
  assert.equal((await call('GET', `${B}/job/00000000-0000-4000-8000-000000000000`)).status, 404);
});

test('Nextcloud-Export: Einrichtung, Test, Export, Aufbewahrung, Fehler', async () => {
  let r = await call('GET', `${B}/nextcloud`);
  assert.equal(r.status, 200);
  assert.equal(r.body.aktiv, false);
  assert.ok(r.body.fehlt.includes('App-Passwort'));
  const cfg = { aktiv: true, url: basis, benutzer: 'vorstand', passwort: 'app-pw', ordner: 'Vorstand/Sicherungen/', uhrzeit: '02:30', format: 'portal', datei_passwort: 'sehr-geheim', mit_aenderungsbelegen: false, aufbewahrung_tage: 7 };
  r = await call('PUT', `${B}/nextcloud`, { ...cfg, passwort: '' });
  assert.equal(r.status, 400, 'aktiv ohne Passwort');
  r = await call('PUT', `${B}/nextcloud`, cfg);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.passwort, '********');
  assert.equal(r.body.datei_passwort, '********');
  assert.equal(r.body.ordner, '/Vorstand/Sicherungen');
  // Maske lässt Geheimnisse unverändert; Änderungsbeleg ohne Klartext
  r = await call('PUT', `${B}/nextcloud`, { ...cfg, passwort: '********', datei_passwort: '********', uhrzeit: '03:15' });
  assert.equal(r.status, 200);
  const [g] = await sql`select datei_passwort, uhrzeit from core.backup_export`;
  assert.deepEqual({ ...g }, { datei_passwort: 'sehr-geheim', uhrzeit: '03:15' });
  // Nextcloud: ein Zugang (#232, S2) – Adresse, Benutzer und App-Passwort stehen in der Anbindung „nextcloud“, nicht mehr bei der Sicherung
  const zugang = async () => ({ ...(await sql`select url, auth_art, auth_user, geheimnis from core.verbindungen where id = 'nextcloud'`)[0] });
  assert.deepEqual(await zugang(), { url: basis, auth_art: 'basic', auth_user: 'vorstand', geheimnis: 'app-pw' });
  assert.deepEqual({ ...(await sql`select url, benutzer, passwort from core.backup_export`)[0] }, { url: '', benutzer: '', passwort: '' }, 'bei der Sicherung steht kein Zugang mehr');
  // die Seite „Sicherung“ schickt den Zugang nicht mehr mit: er bleibt, wie er ist
  r = await call('PUT', `${B}/nextcloud`, { aktiv: true, ordner: cfg.ordner, uhrzeit: '03:15', format: cfg.format, datei_passwort: '********', mit_aenderungsbelegen: cfg.mit_aenderungsbelegen, aufbewahrung_tage: cfg.aufbewahrung_tage });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.url, r.body.benutzer, r.body.passwort], [basis, 'vorstand', '********']);
  assert.deepEqual(await zugang(), { url: basis, auth_art: 'basic', auth_user: 'vorstand', geheimnis: 'app-pw' });
  // unter Schnittstellen → Nextcloud geändert: die Sicherung liest sofort den neuen Zugang
  assert.equal((await call('PUT', '/api/verbindungen/nextcloud', { auth_user: 'anderer', geheimnis: 'neu-pw' })).status, 200);
  assert.deepEqual([(await call('GET', `${B}/nextcloud`)).body.benutzer, (await zugang()).geheimnis], ['anderer', 'neu-pw']);
  assert.equal((await call('PUT', '/api/verbindungen/nextcloud', { auth_user: 'vorstand', geheimnis: 'app-pw' })).status, 200);
  const belege = await sql`select field, old_value, new_value from core.change_item i join core.change_header h on h.id = i.header_id where h.object_type = 'BACKUP_EXPORT'`;
  assert.ok(belege.length > 0);
  assert.ok(!JSON.stringify(belege).includes('app-pw') && !JSON.stringify(belege).includes('sehr-geheim'), 'Geheimnisse nicht im Änderungsbeleg');

  // Verbindungstest legt den Ordner an; falsches Passwort wird klar gemeldet
  r = await call('POST', `${B}/nextcloud/testen`, { ...cfg, passwort: 'falsch' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Anmeldung abgelehnt/);
  r = await call('POST', `${B}/nextcloud/testen`, { ...cfg, passwort: '********', datei_passwort: '********' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(dav.ordner.has('/remote.php/dav/files/vorstand/Vorstand/Sicherungen'));

  // alte automatische Sicherung (wird gelöscht) und fremde Datei (bleibt)
  const alt = '/remote.php/dav/files/vorstand/Vorstand/Sicherungen/portal_2020-01-01_023000_automatisch.portal';
  const fremd = '/remote.php/dav/files/vorstand/Vorstand/Sicherungen/Notizen.txt';
  dav.dateien.set(alt, { daten: Buffer.from('alt'), zeit: new Date(Date.now() - 30 * 86_400_000) });
  dav.dateien.set(fremd, { daten: Buffer.from('x'), zeit: new Date(Date.now() - 300 * 86_400_000) });

  r = await call('POST', `${B}/nextcloud/jetzt`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.art, 'nextcloud');
  const { j } = await abwarten(r.body.id);
  assert.equal(j.fehler, null, j.fehler);
  assert.equal(j.ergebnis.geloescht, 1);
  const hoch = [...dav.dateien.keys()].find((k) => /_automatisch\.portal$/.test(k) && k !== alt)!;
  assert.ok(hoch, 'Sicherung hochgeladen');
  assert.ok(!dav.dateien.has(alt), 'alte automatische Sicherung gelöscht');
  assert.ok(dav.dateien.has(fremd), 'fremde Datei bleibt');
  // hochgeladene Datei ist verschlüsselt und mit dem Datei-Passwort lesbar
  const datei = dav.dateien.get(hoch)!.daten;
  assert.equal(datei[5], 1);
  const inhalt = lesen(datei, 'sehr-geheim');
  assert.equal(inhalt.manifest.art, 'automatisch');
  assert.ok(inhalt.manifest.tabellen.some((t: any) => t.name === 'tco.mitglieder' && t.zeilen === 300));
  r = await call('GET', `${B}/nextcloud`);
  assert.equal(r.body.letzter_fehler, false);
  assert.equal(r.body.letzte_datei, path.posix.basename(hoch));
  assert.match(r.body.letzte_meldung, /hochgeladen .*verschlüsselt.*1 ältere Sicherung\(en\) gelöscht/);

  // Fehlerfall: Speicher voll → Status und Arbeitsvorrat
  dav.voll = true;
  r = await call('POST', `${B}/nextcloud/jetzt`);
  const f = (await abwarten(r.body.id)).j;
  assert.match(f.fehler, /Kein Speicherplatz/);
  r = await call('GET', `${B}/nextcloud`);
  assert.equal(r.body.letzter_fehler, true);
  // Arbeitsvorrat des Kerns auf der Startseite (#232, V2) – nicht mehr in der Liste des Vereinsmoduls
  r = await call('GET', '/api/arbeitsvorrat');
  const kern = r.body.gruppen.find((g: any) => g.modul === 'core');
  const av = kern?.aufgaben.find((a: any) => a.key === 'BACKUP_EXPORT');
  assert.ok(av, JSON.stringify(r.body));
  assert.equal(kern.name, 'Portal');
  assert.equal(av.bereich, 'Administration');
  r = await call('GET', '/api/m/tco/dashboard/arbeitsvorrat');
  assert.ok(!r.body.some((a: any) => a.key === 'BACKUP_EXPORT'), 'steht nur noch im Arbeitsvorrat des Kerns');
  assert.match(av.titel, /fehlgeschlagen/);
  assert.equal(av.pfad, '/admin/sicherung');
  dav.voll = false;
});

test('Nextcloud-Export dateiweise ohne ZIP: Ordner je Lauf, Manifest zuletzt, geprüft, rücksicherbar', async () => {
  const W = '/remote.php/dav/files/vorstand/Vorstand/Sicherungen';
  const cfg = { aktiv: true, url: basis, benutzer: 'vorstand', passwort: '********', ordner: '/Vorstand/Sicherungen', uhrzeit: '02:30', format: 'dateien', datei_passwort: '********', mit_aenderungsbelegen: false, aufbewahrung_tage: 7 };
  let r = await call('PUT', `${B}/nextcloud`, cfg);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.format, 'dateien');
  assert.equal(r.body.datei_passwort, '', 'dateiweise ist unverschlüsselt – kein Datei-Passwort');
  assert.equal((await call('PUT', `${B}/nextcloud`, { ...cfg, format: 'tar' })).status, 400);

  // alter Ordner einer dateiweisen Sicherung (wird gelöscht), fremder Ordner und die .portal-Datei von eben (bleiben)
  const altOrdner = `${W}/portal_2020-01-01_023000_automatisch`;
  dav.ordner.add(altOrdner); dav.ordner.add(`${altOrdner}/daten`);
  dav.dateien.set(`${altOrdner}/manifest.xml`, { daten: Buffer.from('alt'), zeit: new Date() });
  dav.ordner.add(`${W}/Protokolle`);
  dav.dateien.set(`${W}/Protokolle/2020.txt`, { daten: Buffer.from('x'), zeit: new Date() });
  const portalDatei = [...dav.dateien.keys()].find((k) => /_automatisch\.portal$/.test(k))!;
  assert.ok(portalDatei);

  // eine vorübergehende Störung (HTTP 503) beim Upload einer Datei wird durch einen erneuten Versuch überbrückt
  dav.puts.length = 0; dav.stoerung = '/daten/tco/mitglieder.xml'; dav.gestoert = 0;
  r = await call('POST', `${B}/nextcloud/jetzt`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { j, staende } = await abwarten(r.body.id);
  dav.stoerung = '';
  assert.equal(j.fehler, null, j.fehler);
  assert.equal(dav.gestoert, 2, 'nach der Störung erneut gesendet');
  for (let i = 1; i < staende.length; i++) assert.ok(staende[i].prozent >= staende[i - 1].prozent);
  assert.match(j.ergebnis.name, /^portal_\d{4}-\d{2}-\d{2}_\d{6}_automatisch$/);
  assert.match(j.ergebnis.text, /Dateien einzeln.*Vollständigkeit geprüft.*1 ältere Sicherung\(en\) gelöscht/);
  assert.equal(j.ergebnis.geloescht, 1);
  const ziel = `${W}/${j.ergebnis.name}`;
  // kein ZIP: jede Tabelle als eigene Datei, Manifest als letzte Datei
  assert.ok(dav.puts.every((p) => p.startsWith(`${ziel}/`) && !p.endsWith('.zip')), 'nur Einzeldateien im Ordner des Laufs');
  assert.equal(dav.puts.at(-1), `${ziel}/manifest.xml`);
  assert.ok(dav.puts.includes(`${ziel}/daten/tco/mitglieder.xml`) && dav.puts.includes(`${ziel}/daten/core/users.xml`));
  assert.ok(!dav.puts.some((p) => /change_(header|item)\.xml$/.test(p)), 'ohne Änderungsbelege');
  assert.match(dav.dateien.get(`${ziel}/daten/tco/mitglieder.xml`)!.daten.toString('utf8'), /<tabelle name="tco.mitglieder" zeilen="300">/);
  // Prüfsummen stimmen für jede Datei
  const summen = dav.dateien.get(`${ziel}/pruefsummen.sha256`)!.daten.toString('utf8').trim().split('\n').map((z) => z.split('  '));
  assert.equal(summen.length, dav.puts.length - 1, 'alle Dateien außer der Prüfsummendatei selbst');
  const { createHash } = await import('node:crypto');
  for (const [summe, datei] of summen) assert.equal(createHash('sha256').update(dav.dateien.get(`${ziel}/${datei}`)!.daten).digest('hex'), summe, datei);
  // Aufbewahrung: alter Sicherungsordner weg, fremder Ordner und andere Sicherungen bleiben
  assert.ok(!dav.ordner.has(altOrdner) && !dav.dateien.has(`${altOrdner}/manifest.xml`), 'alter Sicherungsordner gelöscht');
  assert.ok(dav.ordner.has(`${W}/Protokolle`) && dav.dateien.has(`${W}/Protokolle/2020.txt`), 'fremder Ordner bleibt');
  assert.ok(dav.dateien.has(portalDatei), 'aktuelle .portal-Sicherung bleibt');
  r = await call('GET', `${B}/nextcloud`);
  assert.equal(r.body.letzter_fehler, false);
  assert.equal(r.body.letzte_datei, j.ergebnis.name);

  // Rücksicherung: der Ordner, als ZIP heruntergeladen (mit Ordnernamen als Präfix), ist eine gültige Sicherung
  const ordnerName = j.ergebnis.name as string;
  const zip = zipSchreiben([...dav.dateien.entries()].filter(([k]) => k.startsWith(`${ziel}/`)).map(([k, v]) => ({ name: `${ordnerName}/${k.slice(ziel.length + 1)}`, daten: v.daten })));
  const inhalt = lesen(zip);
  assert.equal(inhalt.manifest.art, 'automatisch');
  assert.ok(inhalt.manifest.tabellen.some((t: any) => t.name === 'tco.mitglieder' && t.zeilen === 300));
  assert.equal(inhalt.daten['tco.mitglieder'].split('\n').length - 1, 300);

  // kommt eine Datei nicht vollständig an, schlägt der Export fehl und hinterlässt keinen halben Stand
  const vorher = [...dav.ordner].filter((k) => path.posix.dirname(k) === W).sort();
  dav.abschneiden = '/daten/tco/mitglieder.xml';
  r = await call('POST', `${B}/nextcloud/jetzt`);
  const f = (await abwarten(r.body.id)).j;
  dav.abschneiden = '';
  assert.match(f.fehler, /unvollständig.*daten\/tco\/mitglieder\.xml: \d+ statt \d+ Bytes/);
  assert.deepEqual([...dav.ordner].filter((k) => path.posix.dirname(k) === W).sort(), vorher, 'angefangener Ordner wieder entfernt');
  assert.equal((await call('GET', `${B}/nextcloud`)).body.letzter_fehler, true);
});

test('Zeitplan: einmal täglich ab der Uhrzeit (Europe/Berlin)', () => {
  const c = { aktiv: true, url: 'https://c.de', benutzer: 'u', passwort: 'p', ordner: '/x', uhrzeit: '02:30', format: 'portal' as const, datei_passwort: '', mit_aenderungsbelegen: false, aufbewahrung_tage: 7,
    letzter_lauf: null as string | null, letzter_erfolg: null, letzte_meldung: null, letzte_datei: null, letzte_dauer_s: null, letzter_fehler: false };
  // 01:00 UTC = 02:00 MEZ → noch nicht; 02:00 UTC = 03:00 MEZ → fällig
  assert.equal(faellig(c, new Date('2026-11-10T01:00:00Z')), false);
  assert.equal(faellig(c, new Date('2026-11-10T02:00:00Z')), true);
  assert.equal(faellig({ ...c, letzter_lauf: '2026-11-10T01:45:00Z' }, new Date('2026-11-10T22:00:00Z')), false, 'heute schon gelaufen');
  assert.equal(faellig({ ...c, letzter_lauf: '2026-11-09T01:45:00Z' }, new Date('2026-11-10T02:00:00Z')), true);
  assert.equal(faellig({ ...c, aktiv: false }, new Date('2026-11-10T02:00:00Z')), false);
  assert.equal(faellig({ ...c, passwort: '' }, new Date('2026-11-10T02:00:00Z')), false, 'unvollständig');
});

test('WebDAV: Adresse und PROPFIND-Antwort', () => {
  assert.equal(davBasis('https://cloud.tc.de/', 'vor stand'), 'https://cloud.tc.de/remote.php/dav/files/vor%20stand');
  assert.equal(davBasis('https://cloud.tc.de/remote.php/webdav', 'x'), 'https://cloud.tc.de/remote.php/webdav');
  // aus dem Browser kopierte Adresse der Dateien-App → Nextcloud-Adresse
  assert.equal(davBasis('https://cloud.tc.de/index.php/apps/files/files/145339?dir=/30%29%20Vorstand/99%29%20Datensicherung', 'u'), 'https://cloud.tc.de/remote.php/dav/files/u');
  assert.equal(davBasis('https://tc.de/nextcloud/apps/files/?dir=/x', 'u'), 'https://tc.de/nextcloud/remote.php/dav/files/u');
  const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
    <d:response><d:href>/remote.php/dav/files/u/Ordner%20A/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
    <d:response><d:href>/remote.php/dav/files/u/Ordner%20A/portal_2026-11-09_023000_automatisch.portal</d:href><d:propstat><d:prop>
      <d:getlastmodified>Mon, 09 Nov 2026 01:30:05 GMT</d:getlastmodified><d:getcontentlength>1234</d:getcontentlength><d:resourcetype/></d:prop></d:propstat></d:response>
    <d:response><d:href>/remote.php/dav/files/u/Ordner%20A/Unterordner/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
  </d:multistatus>`;
  assert.deepEqual(davAntwort(xml, 'https://c.de/remote.php/dav/files/u/Ordner%20A'), [
    { name: 'portal_2026-11-09_023000_automatisch.portal', ordner: false, groesse: 1234, geaendert: '2026-11-09T01:30:05.000Z' },
    { name: 'Unterordner', ordner: true, groesse: 0, geaendert: null },
  ]);
});
