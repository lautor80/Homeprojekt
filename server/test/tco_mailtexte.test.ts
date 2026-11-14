/**
 * E-Mail-Texte des Vereins vorbelegen (#232; Einstellungen → TC Oberthal → E-Mail-Texte): Verzeichnis mit Standardtexten und
 * Platzhaltern, eigener Text sichern und zurücknehmen, Prüfung der Platzhalter, Wirkung beim Versand und als Vorbelegung.
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
const { unterlagenMail, MAILTEXTE } = await import('../../modules/tco/server/mailtexte.js');
const { mailText } = await import('../../modules/tco/server/mitglieder/dokumente.js');
const { vereinLesen } = await import('../../modules/tco/server/verein.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
async function call(method: string, path: string, payload?: unknown) {
  const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
  const set = res.headers['set-cookie'];
  if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
}
const T = '/api/m/tco/mailtexte';
interface Eintrag { schluessel: string; bereich: string; name: string; pflicht: string[]; platzhalter: { name: string }[]; standard: { betreff: string; text: string }; eigen: { betreff: string; text: string } | null; geaendert: { von: string; am: string } | null }
const liste = async () => (await call('GET', T)).body as Eintrag[];
const eintrag = async (s: string) => (await liste()).find((x) => x.schluessel === s)!;
const db = sql as never;

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
});
after(async () => { await app?.close(); await sql.end(); });

test('Verzeichnis: je Anlass Standardtext mit Platzhaltern, noch kein eigener Text', async () => {
  const l = await liste();
  assert.equal(l.length, MAILTEXTE.length);
  assert.equal(new Set(l.map((x) => x.schluessel)).size, l.length, 'Schlüssel eindeutig');
  // (ein „Rahmen“ besteht nur aus Nachricht und Gruß – er ist kurz, muss aber die Nachricht enthalten)
  const rahmen = (x: Eintrag) => x.pflicht.includes('Nachricht');
  assert.ok(l.every((x) => !x.eigen && !x.geaendert && x.standard.betreff && (rahmen(x) ? x.standard.text.includes('{Nachricht}') : x.standard.text.length > 40)), 'frisch: überall der Standardtext');
  // jeder Platzhalter des Standardtexts ist beschrieben – sonst ließe sich der Standardtext nicht unverändert sichern
  for (const x of l) {
    const im = [...new Set([...`${x.standard.betreff}\n${x.standard.text}`.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]))];
    assert.deepEqual(im.filter((k) => !x.platzhalter.some((p) => p.name === k)), [], `${x.schluessel}: Platzhalter im Standardtext ohne Beschreibung`);
    for (const p of x.pflicht) assert.ok(x.standard.text.includes(`{${p}}`), `${x.schluessel}: Pflicht-Platzhalter {${p}} im Standardtext`);
  }
  const k = l.find((x) => x.schluessel === 'mitglied.unterlage.4')!;
  assert.deepEqual([k.bereich, k.name], ['Mitglieder', 'Kündigungsbestätigung']);
  assert.match(k.standard.text, /^.*\n\nHallo \{Vorname\},/);
  assert.match(k.standard.text, /\n\n\{Unterlagen\}\n\n/);
  assert.ok(l.find((x) => x.schluessel === 'mitglied.einladung')!.standard.text.includes('{Link}'));
});

test('Eigenen Text sichern: Platzhalter geprüft, gilt beim Versand, leerer Block ohne Lücke, zurück zum Standard', async () => {
  const v = await vereinLesen();
  const standard = mailText(v, '4', 'Paula', []);
  assert.deepEqual(await unterlagenMail(db, v, '4', 'Paula', []), standard, 'ohne eigenen Text wie bisher');

  assert.equal((await call('PUT', `${T}/gibtsnicht`, { betreff: 'x', text: 'y' })).status, 404);
  assert.equal((await call('PUT', `${T}/mitglied.unterlage.4`, { betreff: '', text: 'y' })).status, 400);
  let r = await call('PUT', `${T}/mitglied.unterlage.4`, { betreff: 'x', text: 'Hallo {Vornahme}' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Unbekannte Platzhalter: \{Vornahme\}\. Möglich sind \{Vorname\}, \{Unterlagen\}/);
  r = await call('PUT', `${T}/mitglied.einladung`, { betreff: 'Zugang', text: 'Hallo {Vorname}, bitte anmelden.' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /fehlt der Platzhalter \{Link\}/);

  r = await call('PUT', `${T}/mitglied.unterlage.4`, { betreff: 'Deine Kündigung, {Vorname}', text: 'Hallo {Vorname},\n\nschade, dass du gehst.\n\n{Unterlagen}\n\nDein Verein' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const e = await eintrag('mitglied.unterlage.4');
  assert.deepEqual([e.eigen?.betreff, e.geaendert?.von], ['Deine Kündigung, {Vorname}', 'Admin']);
  assert.match(e.geaendert!.am, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await liste()).filter((x) => x.eigen).length, 1, 'nur dieser Anlass');
  // beim Versand: Werte eingesetzt; ohne Unterlagenliste bleibt keine Lücke
  assert.deepEqual(await unterlagenMail(db, v, '4', 'Paula', []), { betreff: 'Deine Kündigung, Paula', text: 'Hallo Paula,\n\nschade, dass du gehst.\n\nDein Verein' });
  const mit = await unterlagenMail(db, v, '4', 'Paula', [{ titel: 'Bestätigung', link: 'https://dokumente.example.org/share/abc' }]);
  assert.equal(mit.text, 'Hallo Paula,\n\nschade, dass du gehst.\n\nDeine Unterlage kannst du hier abrufen:\nBestätigung\nhttps://dokumente.example.org/share/abc\n\nDein Verein');
  // andere Anlässe unberührt
  assert.deepEqual(await unterlagenMail(db, v, '1', 'Paula', []), mailText(v, '1', 'Paula', []));
  assert.ok((await sql`select count(*)::int as n from core.change_header where object_type = 'TCO_MAILTEXT'`)[0].n >= 1, 'Änderungsbeleg');

  // zurück zum Standardtext
  r = await call('DELETE', `${T}/mitglied.unterlage.4`);
  assert.equal(r.status, 200);
  assert.equal((await eintrag('mitglied.unterlage.4')).eigen, null);
  assert.deepEqual(await unterlagenMail(db, v, '4', 'Paula', []), standard);
});

test('Vorbelegung in Dialogen: Einladung und Zugangslink zeigen den Text des Vereins, sonst den Standardtext', async () => {
  const std = (await eintrag('mitglied.einladung')).standard;
  let r = await call('GET', '/api/m/tco/mitglieder/einladungen/vorlage');
  assert.deepEqual([r.status, r.body.betreff, r.body.text], [200, std.betreff, std.text]);
  assert.equal((await call('PUT', `${T}/mitglied.einladung`, { betreff: 'Willkommen im Portal', text: 'Hallo {Vorname},\n\nhier ist dein Link: {Link}\n(gültig bis {GueltigBis})' })).status, 200);
  r = await call('GET', '/api/m/tco/mitglieder/einladungen/vorlage');
  assert.deepEqual([r.body.betreff, r.body.text.includes('hier ist dein Link: {Link}'), r.body.platzhalter.includes('{Link}')], ['Willkommen im Portal', true, true]);
  // Zugangslink: eigener Anlass, eigener Text
  const zstd = (await eintrag('mitglied.zugangslink')).standard;
  assert.equal((await call('GET', '/api/m/tco/mitglieder/zugang/vorlage')).body.text, zstd.text);
  assert.equal((await call('PUT', `${T}/mitglied.zugangslink`, { betreff: 'Neues Kennwort', text: 'Hallo {Vorname} ({Benutzername}): {Link}' })).status, 200);
  assert.equal((await call('GET', '/api/m/tco/mitglieder/zugang/vorlage')).body.betreff, 'Neues Kennwort');
  assert.equal((await call('DELETE', `${T}/mitglied.einladung`)).status, 200);
  assert.equal((await call('GET', '/api/m/tco/mitglieder/einladungen/vorlage')).body.text, std.text);
});

test('Automatische E-Mails aus dem Verzeichnis: Standardtext unverändert, bedingte Teile ohne Lücke, eigener Text gilt', async () => {
  const { mailtextFuellen } = await import('../../modules/tco/server/mailtexte.js');
  const v = await vereinLesen();
  // Antrag abgelehnt: mit und ohne Begründung
  let t = await mailtextFuellen(db, v, 'antrag.abgelehnt', { Name: 'Eva Lob', Nummer: 'MA-7', Begruendung: 'Begründung: Aufnahmestopp' });
  assert.equal(t.betreff, `${v.name}: Ihr Mitgliedsantrag MA-7`);
  assert.equal(t.text, `Guten Tag Eva Lob,\n\nIhr Mitgliedsantrag MA-7 konnte leider nicht angenommen werden.\n\nBegründung: Aufnahmestopp\n\nBei Fragen wenden Sie sich bitte an den Vorstand.\n\nViele Grüße\n${v.name}`);
  t = await mailtextFuellen(db, v, 'antrag.abgelehnt', { Name: 'Eva Lob', Nummer: 'MA-7', Begruendung: '' });
  assert.equal(t.text, `Guten Tag Eva Lob,\n\nIhr Mitgliedsantrag MA-7 konnte leider nicht angenommen werden.\n\nBei Fragen wenden Sie sich bitte an den Vorstand.\n\nViele Grüße\n${v.name}`);
  // Willkommen: Zeile je Mitglied, Mandat nur wenn vorhanden
  t = await mailtextFuellen(db, v, 'antrag.willkommen', { Name: 'Eva Lob', Nummer: 'MA-7', Mitglieder: 'Eva Lob: Mitgliedsnummer 801\nTom Lob: Mitgliedsnummer 802', Mandat: '' });
  assert.equal(t.text, 'Guten Tag Eva Lob,\n\nherzlich willkommen! Ihr Mitgliedsantrag MA-7 wurde angenommen.\n\nEva Lob: Mitgliedsnummer 801\nTom Lob: Mitgliedsnummer 802\n\n'
    + `Die Zugänge zum Mitgliederportal erhalten Sie in separaten E-Mails.\n\nViele Grüße\n${v.name}`);
  // Freischaltung: Satzteile der Sendestelle fügen sich in den Satz
  t = await mailtextFuellen(db, v, 'registrierung.freigeschaltet', { Name: 'Tom Lob', Adresse: ' unter https://portal.example.org', Kennwort: 'mit Ihrem Benutzernamen und dem bei der Registrierung gewählten Kennwort.', Hinweis: 'Unter „Platz buchen“ reservieren Sie Hallen- und Freiplätze.' });
  assert.equal(t.text, 'Guten Tag Tom Lob,\n\nIhr Zugang zum Portal ist freigeschaltet. Sie können sich jetzt unter https://portal.example.org anmelden – '
    + `mit Ihrem Benutzernamen und dem bei der Registrierung gewählten Kennwort.\n\nUnter „Platz buchen“ reservieren Sie Hallen- und Freiplätze.\n\nViele Grüße\n${v.name}`);
  t = await mailtextFuellen(db, v, 'registrierung.eingegangen', { Name: 'Tom Lob', Benutzername: 'tom', Pruefung: 'Wir prüfen Ihre Angaben' });
  assert.match(t.text, /\(Benutzername tom\)\. Wir prüfen Ihre Angaben und benachrichtigen Sie, sobald Ihr Zugang freigeschaltet ist\.\n\nViele Grüße/);
  t = await mailtextFuellen(db, v, 'schnupper.beitritt', { Name: 'Mia', Dabei: 'du beim Schnuppertraining dabei warst', Link: 'https://portal.example.org/beitritt?schnupper=abc' });
  assert.match(t.text, /^Hallo Mia,\n\nschön, dass du beim Schnuppertraining dabei warst! Wenn es gefallen hat/);
  assert.match(t.text, /\n\nhttps:\/\/portal\.example\.org\/beitritt\?schnupper=abc\n\nViele Grüße/);
  t = await mailtextFuellen(db, v, 'schnupper.eingang', { Name: 'Frau Lob', Kind: ' von Mia Lob', Einheiten: '3', Nummer: 'ST-4' });
  assert.match(t.betreff, /Schnuppertraining \(ST-4\)$/);
  assert.match(t.text, /vielen Dank für die Anmeldung von Mia Lob zum Schnuppertraining\.\n\nWir bieten 3 Einheiten/);

  // eigener Text des Vereins gilt; der Link bleibt Pflicht
  let r = await call('PUT', `${T}/registrierung.bestaetigen`, { betreff: 'Bitte bestätigen', text: 'Hallo {Name}, ohne Link' });
  assert.equal(r.status, 400);
  r = await call('PUT', `${T}/registrierung.bestaetigen`, { betreff: 'Bitte bestätigen, {Name}', text: 'Hallo {Name},\n\nhier bestätigen ({Stunden} h): {Link}' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  t = await mailtextFuellen(db, v, 'registrierung.bestaetigen', { Name: 'Tom Lob', Benutzername: 'tom', Stunden: '48', Link: 'https://portal.example.org/registrierung-bestaetigen?token=abc' });
  assert.deepEqual(t, { betreff: 'Bitte bestätigen, Tom Lob', text: 'Hallo Tom Lob,\n\nhier bestätigen (48 h): https://portal.example.org/registrierung-bestaetigen?token=abc' });
  assert.equal((await call('DELETE', `${T}/registrierung.bestaetigen`)).status, 200);
  t = await mailtextFuellen(db, v, 'registrierung.bestaetigen', { Name: 'Tom Lob', Benutzername: 'tom', Stunden: '48', Link: 'https://x.example/t' });
  assert.match(t.text, /über diesen Link \(48 Stunden gültig\):\n\nhttps:\/\/x\.example\/t\n\nDanach ist Ihr Zugang sofort freigeschaltet/);
  await assert.rejects(() => mailtextFuellen(db, v, 'gibt.es.nicht', {}), /gibt es nicht/);
});

test('Verzehr, Hallenrechnung, Rahmen, Vertragsangebot und Startkennwort: Standard unverändert, eigener Text gilt', async () => {
  const { mailtextFuellen } = await import('../../modules/tco/server/mailtexte.js');
  const { mailTexte } = await import('../../modules/tco/server/halle/versand.js');
  const { rechnungMailText, sammelVorlageEigen } = await import('../../modules/tco/server/halle/mailtext.js');
  const { sammelMailVorlage, sammelMailVorlageLesen } = await import('../../modules/tco/server/halle/sammelversand.js');
  const v = await vereinLesen();
  const gruss = v.ansprechpartner ?? v.name;

  // Verzehr: drei Anlässe, gleicher Betreff
  let t = await mailtextFuellen(db, v, 'verzehr.beleg', { Vorname: 'Kai', Beleg: 'Verzehrbeleg', Nummer: 'VZ-9', Betrag: '12,50 €', Bezahlt: 'bezahlt per Karte' });
  assert.deepEqual(t, { betreff: `Verzehrbeleg VZ-9 – ${v.name}`, text: `Hallo Kai,\n\nvielen Dank für deinen Besuch in unserem Clubhaus. Anbei dein Beleg VZ-9 über 12,50 € (bezahlt per Karte).\n\nViele Grüße\n${gruss}`.trim() });
  t = await mailtextFuellen(db, v, 'verzehr.abrechnung.lastschrift', { Vorname: 'Kai', Beleg: 'Verzehrabrechnung Mai 2027', Nummer: 'VZ-10', Betrag: '40,00 €', Monat: 'Mai 2027' });
  assert.equal(t.text, `Hallo Kai,\n\nanbei deine Verzehrabrechnung VZ-10 für den Mai 2027 über 40,00 €. Der Betrag wird mit der nächsten Lastschrift eingezogen.\n\nViele Grüße\n${gruss}`.trim());
  t = await mailtextFuellen(db, v, 'verzehr.abrechnung.ueberweisung', { Vorname: 'Kai', Beleg: 'Verzehrabrechnung Mai 2027', Nummer: 'VZ-10', Betrag: '40,00 €', Monat: 'Mai 2027', Faellig: '15.06.2027' });
  assert.match(t.text, /über 40,00 € mit der Bitte um Überweisung bis zum 15\.06\.2027 auf unser Vereinskonto \(Verwendungszweck: Verzehr VZ-10\)\.\n\nViele Grüße/);

  // Rahmen (Hallenschlüssel, Instandhaltung) und Hallenabo: wie bisher zusammengesetzt
  t = await mailtextFuellen(db, v, 'schluessel.rahmen', { Betreff: 'Schlüssel liegt bereit', Nachricht: 'Hallo Kai,\n\ndein Schlüssel liegt bereit.' });
  assert.deepEqual(t, { betreff: `${v.name}: Schlüssel liegt bereit`, text: `Hallo Kai,\n\ndein Schlüssel liegt bereit.\n\nViele Grüße\n${v.name}` });
  t = await mailtextFuellen(db, v, 'halle.abo', { Betreff: 'Hallenabo 27/28: bitte bestätigen', Name: 'Kai', Nachricht: 'dein Abo kannst du behalten.', Portal: '' });
  assert.deepEqual(t, { betreff: 'Hallenabo 27/28: bitte bestätigen', text: `Hallo Kai,\n\ndein Abo kannst du behalten.\n\nSportliche Grüße\n${v.name}` });
  t = await mailtextFuellen(db, v, 'halle.abo', { Betreff: 'x', Name: 'Kai', Nachricht: 'Text.', Portal: 'Zum Portal: https://portal.example.org/tco/platz-buchen?ansicht=abo' });
  assert.equal(t.text, `Hallo Kai,\n\nText.\n\nZum Portal: https://portal.example.org/tco/platz-buchen?ansicht=abo\n\nSportliche Grüße\n${v.name}`);
  assert.equal((await call('PUT', `${T}/instandhaltung.rahmen`, { betreff: '{Betreff}', text: 'Nur ein Gruß' })).status, 400, 'ohne {Nachricht} ginge die Benachrichtigung verloren');
  assert.equal((await call('PUT', `${T}/instandhaltung.rahmen`, { betreff: 'TCO – {Betreff}', text: '{Nachricht}\n\nEuer Platzwart' })).status, 200);
  assert.deepEqual(await mailtextFuellen(db, v, 'instandhaltung.rahmen', { Betreff: 'Netz gerissen', Nachricht: 'Platz 3: Netz gerissen.' }), { betreff: 'TCO – Netz gerissen', text: 'Platz 3: Netz gerissen.\n\nEuer Platzwart' });
  assert.equal((await call('DELETE', `${T}/instandhaltung.rahmen`)).status, 200);

  // Startkennwort
  t = await mailtextFuellen(db, v, 'mitglied.startkennwort', { Name: 'Kai Lob', Benutzername: 'kai.lob', Kennwort: 'abc-123' });
  assert.match(t.text, /^Guten Tag Kai Lob,\n\nfür Sie wurde ein Zugang zum Mitgliederportal angelegt\.\n\nAnmeldename: kai\.lob\nStartkennwort: abc-123\n\nBitte melden Sie sich an/);

  // Hallenrechnung: ohne eigenen Text der Standard mit Einzahl/Mehrzahl und Link
  assert.deepEqual(await rechnungMailText(db, v, 'Kai', ['2027_001'], 'https://dl.example/x'), mailTexte(v, 'Kai', ['2027_001'], 'https://dl.example/x'));
  assert.deepEqual(await rechnungMailText(db, v, '', ['2027_001', '2027_002']), mailTexte(v, '', ['2027_001', '2027_002']));
  assert.match(mailTexte(v, 'Kai', ['2027_001'], 'https://dl.example/x').text, /Vereinskonto\.\n\nDeine Rechnung kannst du 30 Tage lang über folgenden Link herunterladen:\nhttps:\/\/dl\.example\/x\n\nVielen Dank/);
  assert.equal(await sammelVorlageEigen(db), null);
  assert.deepEqual(await sammelMailVorlageLesen(db, v), sammelMailVorlage(v));
  const std = (await eintrag('halle.rechnung')).standard;
  assert.ok(std.text.includes('{Vorname}') && std.text.includes('{Rechnungsnummer}') && std.text.includes('{Download}'));
  // eigener Text: gilt für eine und mehrere Rechnungen; im Sammelversand ohne den Satz mit dem Link
  assert.equal((await call('PUT', `${T}/halle.rechnung`, { betreff: 'Hallenrechnung {Rechnungsnummer}', text: 'Hallo {Vorname},\n\nanbei {Rechnungsnummer}.\n\n{Download}\n\nDein TCO' })).status, 200);
  assert.deepEqual(await rechnungMailText(db, v, '', ['2027_001', '2027_002']), { betreff: 'Hallenrechnung 2027_001, 2027_002', text: 'Hallo zusammen,\n\nanbei 2027_001, 2027_002.\n\nDein TCO' });
  assert.equal((await rechnungMailText(db, v, 'Kai', ['2027_001'], 'https://dl.example/x')).text,
    'Hallo Kai,\n\nanbei 2027_001.\n\nDeine Rechnung kannst du 30 Tage lang über folgenden Link herunterladen:\nhttps://dl.example/x\n\nDein TCO');
  assert.deepEqual(await sammelMailVorlageLesen(db, v), { betreff: 'Hallenrechnung {Rechnungsnummer}', text: 'Hallo {Vorname},\n\nanbei {Rechnungsnummer}.\n\nDein TCO' });
  assert.equal((await call('DELETE', `${T}/halle.rechnung`)).status, 200);

  // Vertragsangebot: Vorbelegung im Dialog ist der Text des Vereins
  const A = '/api/m/tco/mitgliedsantraege/angebote/mailvorlage';
  let r = await call('GET', A);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, (await eintrag('antrag.angebot')).standard);
  assert.equal((await call('PUT', `${T}/antrag.angebot`, { betreff: '{Verein}: Angebot', text: 'Guten Tag {Name},\n\n{Link}\n\ngültig bis {GueltigBis}' })).status, 200);
  r = await call('GET', A);
  assert.deepEqual(r.body, { betreff: '{Verein}: Angebot', text: 'Guten Tag {Name},\n\n{Link}\n\ngültig bis {GueltigBis}' });
  assert.equal((await call('DELETE', `${T}/antrag.angebot`)).status, 200);
});
