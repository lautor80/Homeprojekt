/**
 * Euroflex Posteingang – Eingangsrechnungen: Seiten einordnen, PDF aufteilen (Rechnung / Ablieferbelege, eigener
 * Transportauftrag entfällt), Firmierung prüfen, Reklamation als Entwurf. Doku: docs/euroflex-mailworkflows.md.
 *   reine Tests:  tsx --test server/test/transport_eingangsrechnung.test.ts
 *   PDF-Werkzeuge (poppler-utils) und Datenbank werden übersprungen, wenn sie fehlen.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import * as P from '../../modules/transport/server/eingang/rechnungspruefung.js';
import { einstellungenMischen } from '../../modules/transport/server/mailworkflows.js';

const url = process.env.TEST_DATABASE_URL;
const mitDb = !!url && /test/i.test(url.split('/').pop() ?? '');
const ohneDb = { skip: mitDb ? false : 'TEST_DATABASE_URL fehlt – nur reine Tests' };
const hat = (programm: string) => { try { execFileSync(programm, ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } };
const mitPoppler = ['pdfinfo', 'pdftotext', 'pdfseparate', 'pdfunite'].every(hat);
const ohnePoppler = { skip: mitPoppler ? false : 'poppler-utils fehlt – Zerlegen wird nur lokal bzw. im Container geprüft' };

const FIRMA = { name: 'Euroflex Logistik GmbH', strasse: 'Musterweg 7', plz: '66649', ort: 'Oberthal', ustid: 'DE 999 888 777' };
const ALT = [{ name: 'Benjamin Hartyniuk Euroflex', ustid: 'DE 814480003' }];

const RECHNUNG = (empfaenger: string) => `Spedition Beispiel GmbH · Hafenstr. 1 · 20457 Hamburg
${empfaenger}

Rechnung
Rechnungs-Nr.: RE-2099-4711        Rechnungsdatum: 17.11.2099
Leistungsdatum: 14.11.2099         Ihr Auftrag 2098_8001
Pos. 1  Transport Oberthal – Hamburg          850,00
Nettobetrag 850,00   USt 19 % 161,50   Gesamtbetrag 1.011,50 EUR
Zahlbar innerhalb 14 Tagen ohne Abzug.   IBAN DE00 1234 5678 9000 0000 00`;
const LIEFERSCHEIN = `Lieferschein / Delivery Note
Auftrags-Nr. 2098_8001
Ware vollständig und unbeschädigt erhalten:   Datum   Unterschrift / Stempel Empfänger`;
const TRANSPORTAUFTRAG = `Euroflex Logistik GmbH
Auftrags-Nr. 2098_8001
Bitte immer auf der Rechnung angeben
Transportauftrag   Transport Order
Sehr geehrte Damen und Herren,
hiermit beauftragen wir Sie mit dem folgenden Transport:
Frachtpreis 850,00 EUR zzgl. USt`;
const TRANSPORTAUFTRAG_FOLGE = `Transportauftrag 2098_8001 · Fortsetzung
Auftragsbedingungen
Zahlbar 30 Tage nach Rechnungseingang. Es gilt die Umsatzsteuer.`;

// ---------------------------------------------------------------- reine Logik
test('Seiten einordnen: Rechnung, Folgeseite, Ablieferbeleg (Schlagwort und Scan), eigener Transportauftrag samt Folgeseite', () => {
  const s = P.seitenEinordnen([
    RECHNUNG('Euroflex Logistik GmbH\nMusterweg 7\n66649 Oberthal'),
    'Seite 2 von 2\nÜbertrag 850,00  Gesamtbetrag 1.011,50  zahlbar bis 01.12.2099  IBAN DE00',
    LIEFERSCHEIN, '', 'CMR  Internationaler Frachtbrief  Stempel', TRANSPORTAUFTRAG, TRANSPORTAUFTRAG_FOLGE,
  ]);
  assert.deepEqual(s.map((x) => x.art).join(''), 'RRAAATT');
  assert.equal(s.every((x) => x.sicher), true, JSON.stringify(s));
  const a = P.aufteilung(s);
  assert.deepEqual([a.rechnung, a.ablieferbelege, a.transportauftrag, a.noetig, a.sicher, a.rolle], [[1, 2], [3, 4, 5], [6, 7], true, true, 'rechnung']);
  assert.equal(P.aufteilungText(a), 'Original (unverändert) – aufgeteilt in Rechnung (S. 1–2) und Ablieferbelege (S. 3–5); eigener Transportauftrag (S. 6–7) entfernt.');
  assert.equal(P.seitenText([5, 1, 2, 3, 7]), '1–3, 5, 7');
  assert.equal(P.teilDateiname('Scan 17.11.PDF', 'rechnung'), 'Scan 17.11 – Rechnung.pdf');
  assert.equal(P.teilDateiname('RE4711.pdf', 'ablieferbeleg'), 'RE4711 – Ablieferbelege.pdf');
});

test('Seiten einordnen: Zweifel bleiben ein Vorschlag (nicht sicher); Rechnung, die den Transportauftrag nur erwähnt, bleibt Rechnung', () => {
  // Rechnung nennt „gemäß Transportauftrag“ und „Lieferschein-Nr.“ – trotzdem Rechnung
  const erwaehnt = P.seitenEinordnen([`${RECHNUNG('Euroflex Logistik GmbH 66649 Oberthal')}\ngemäß Ihrem Transportauftrag 2098_8001, Lieferschein-Nr. 55`]);
  assert.deepEqual([erwaehnt[0].art, erwaehnt[0].sicher], ['R', true]);
  // viel Text ohne jedes Merkmal direkt nach der Rechnung (AGB des Rechnungsstellers?) → Vorschlag, nicht sicher
  const agb = P.seitenEinordnen([RECHNUNG('x'), `Allgemeine Geschäftsbedingungen ${'Der Frachtführer haftet nach den gesetzlichen Bestimmungen. '.repeat(12)}`]);
  assert.deepEqual([agb[1].art, agb[1].sicher], ['A', false]);
  assert.equal(P.aufteilung(agb).sicher, false);
  // Lieferschein mit „Rechnung folgt“ und Fußzeile (USt-IdNr., IBAN): Vorschlag Ablieferbeleg, nicht sicher
  const beleg = P.seitenEinordnen(['Lieferschein 4711\nRechnung folgt gesondert.\nUSt-IdNr. DE123456789  IBAN DE00 0000']);
  assert.deepEqual([beleg[0].art, beleg[0].sicher], ['A', false]);
  // Transportauftrag aus dem früheren System (anderes Layout, nennt Rechnung, USt und Zahlungsziel): Vorschlag T, nie „sicher Rechnung“
  const fremd = P.seitenEinordnen(['Speditionsauftrag 2098_8001\nFrachtpreis netto 850,00 zzgl. USt\nRechnung bitte mit Auftragsnummer, Zahlungsziel 30 Tage, IBAN bitte angeben']);
  assert.deepEqual([fremd[0].art, fremd[0].sicher], ['T', false]);
  // nur Ablieferbelege: nichts zu trennen; ein beliebiges Dokument (Bestellung) bekommt keine Rolle
  const nurBelege = P.aufteilung(P.seitenEinordnen([LIEFERSCHEIN, 'CMR Frachtbrief']));
  assert.deepEqual([nurBelege.noetig, nurBelege.rolle], [false, 'ablieferbeleg']);
  assert.equal(P.aufteilung(P.seitenEinordnen(['Bestellung über Frachtkosten Nr. 77 – bitte bestätigen'])).rolle, null);
  assert.equal(P.aufteilung(P.seitenEinordnen([TRANSPORTAUFTRAG])).rolle, 'transportauftrag');
  // Rechnung + Transportauftrag ohne Belege: es entsteht nur die Rechnung
  const rt = P.aufteilung(P.seitenEinordnen([RECHNUNG('x'), TRANSPORTAUFTRAG]));
  assert.deepEqual([rt.rechnung, rt.ablieferbelege, rt.transportauftrag, rt.noetig], [[1], [], [2], true]);
});

test('Firmierung: aktuell, frühere (Name, andere Reihenfolge, USt-IdNr.), Ansprechpartner zählt nicht, unklar', () => {
  const pruefen = (empfaenger: string, firma = FIRMA) => P.firmierungPruefen(RECHNUNG(empfaenger), firma, ALT);
  assert.equal(pruefen('Euroflex Logistik GmbH\nMusterweg 7\nD-66649 Oberthal').ergebnis, 'ok');
  // der Inhaber als Ansprechpartner macht eine richtig adressierte Rechnung nicht falsch
  assert.equal(pruefen('Euroflex Logistik GmbH\nz. Hd. Benjamin Hartyniuk\nMusterweg 7\n66649 Oberthal').ergebnis, 'ok');
  const alt = pruefen('Benjamin Hartyniuk\nEuroflex\nMusterweg 7\n66649 Oberthal');
  assert.deepEqual([alt.ergebnis, alt.alt], ['alt', 'Benjamin Hartyniuk Euroflex']);
  assert.match(alt.text, /frühere Firmierung „Benjamin Hartyniuk Euroflex“ statt „Euroflex Logistik GmbH“/);
  assert.equal(pruefen('Euroflex Inh. Benjamin Hartyniuk\n66649 Oberthal').ergebnis, 'alt', 'andere Reihenfolge, Zusatz „Inh.“');
  // USt-IdNr. der früheren Firmierung entscheidet – auch wenn der neue Name schon stimmt
  const ust = pruefen('Euroflex Logistik GmbH\n66649 Oberthal\nIhre USt-IdNr.: DE 814 480 003');
  assert.equal(ust.ergebnis, 'alt');
  assert.match(ust.text, /USt-IdNr\. DE 814480003/);
  // weder noch: unklar; richtige Firma mit fremder PLZ: unklar
  assert.equal(pruefen('Eurofix Transporte\n12345 Irgendwo').ergebnis, 'unklar');
  assert.match(pruefen('Euroflex Logistik GmbH\nAlte Str. 1\n12345 Irgendwo').text, /Anschrift \(PLZ 66649\)/);
  assert.equal(pruefen('Musterweg 7 66649 Oberthal\nUSt-IdNr. DE999888777').ergebnis, 'unklar', 'nur die eigene USt-IdNr. reicht nicht');
  // „GmbH“ eines anderen Namens in der Nähe macht den aktuellen Namen nicht passend
  assert.equal(pruefen('Benjamin Hartyniuk Euroflex\nSpedition Müller GmbH').ergebnis, 'alt');
  // aktueller Name steckt im früheren („Euroflex“): der längere entscheidet
  assert.equal(pruefen('Benjamin Hartyniuk Euroflex\n66649 Oberthal', { ...FIRMA, name: 'Euroflex' }).ergebnis, 'alt');
  assert.equal(pruefen('Euroflex\nMusterweg 7\n66649 Oberthal', { ...FIRMA, name: 'Euroflex' }).ergebnis, 'ok');
  // ohne Firmenname in den Stammdaten bzw. ohne lesbaren Text wird nicht geraten
  assert.match(pruefen('x', { ...FIRMA, name: ' ' }).text, /fehlt der Firmenname/);
  assert.match(P.firmierungPruefen('  ', FIRMA, ALT).text, /kein Text lesbar/);
  assert.equal(P.ustidNormal(' de 814.480-003 '), 'DE814480003');
});

test('Reklamation: Betreff ohne AW:/WG:, aktuelle Firmendaten im Text; Einstellungen mit Standard und Prüfung', () => {
  const m = P.reklamationMail({ betreff: 'AW: WG: Rechnung RE-2099-4711', firma: FIRMA, alt: 'Benjamin Hartyniuk Euroflex' });
  assert.equal(m.betreff, 'Bitte um Rechnungskorrektur – Rechnung RE-2099-4711');
  assert.match(m.text, /frühere Firmierung „Benjamin Hartyniuk Euroflex“ adressiert/);
  assert.match(m.text, /Euroflex Logistik GmbH\nMusterweg 7\n66649 Oberthal\nUSt-IdNr\.: DE 999 888 777/);
  const std = einstellungenMischen({}, {}).eingang;
  assert.deepEqual([std.rechnungAufteilen, std.firmierungPruefen, std.firmierungAktion, std.fruehereFirmierungen], [true, true, 'markieren', []]);
  const e = einstellungenMischen({ firmierungAktion: 'entwurf', rechnungAufteilen: false, fruehereFirmierungen: [{ name: ' Benjamin Hartyniuk Euroflex ', ustid: ' DE814480003 ' }, { ustid: 'DE1' }] }, {}).eingang;
  assert.deepEqual([e.firmierungAktion, e.rechnungAufteilen, e.fruehereFirmierungen], ['entwurf', false, [{ name: 'Benjamin Hartyniuk Euroflex', ustid: 'DE814480003' }, { name: '', ustid: 'DE1' }]]);
  // ungültige Aktion bzw. leere Firmierung: der ganze Abschnitt fällt auf den Standard zurück (wie bei den übrigen Feldern)
  assert.equal(einstellungenMischen({ firmierungAktion: 'senden' }, {}).eingang.firmierungAktion, 'markieren');
});

// ---------------------------------------------------------------- PDF-Werkzeuge (poppler-utils)

/** kleines PDF mit einer Seite je Text (Helvetica, eine Zeile je Zeile) – ohne PDF-Bibliothek */
function pdfBauen(seiten: string[]): Buffer {
  const esc = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '?');
  const obj: string[] = [];
  const n = seiten.length;
  obj[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  obj[2] = `<< /Type /Pages /Count ${n} /Kids [${seiten.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] >>`;
  obj[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  seiten.forEach((text, i) => {
    const zeilen = text.split('\n').map((z, k) => `${k ? '0 -14 Td ' : ''}(${esc(z)}) Tj`).join('\n');
    const strom = `BT /F1 10 Tf 50 780 Td\n${zeilen}\nET`;
    obj[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    obj[5 + i * 2] = `<< /Length ${strom.length} >>\nstream\n${strom}\nendstream`;
  });
  let aus = '%PDF-1.4\n';
  const pos: number[] = [];
  for (let i = 1; i < obj.length; i++) { pos[i] = aus.length; aus += `${i} 0 obj\n${obj[i]}\nendobj\n`; }
  const xref = aus.length;
  aus += `xref\n0 ${obj.length}\n0000000000 65535 f \n${pos.slice(1).map((p) => `${String(p).padStart(10, '0')} 00000 n \n`).join('')}`;
  aus += `trailer\n<< /Size ${obj.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(aus, 'latin1');
}
const ascii = (t: string) => t.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[–·]/g, '-');

test('PDF seitenweise lesen und zerlegen: Rechnung + Lieferschein + Transportauftrag → zwei Teile, Transportauftrag entfällt', ohnePoppler, async () => {
  const T = await import('../src/lib/texterkennung.js');
  // erst das Modul (Reihenfolge der Importe wie im Server), dann die Analyse
  await import('../../modules/transport/server/index.js');
  const { pdfAnalysieren } = await import('../../modules/transport/server/eingang/rechnung.js');
  const alles = pdfBauen([RECHNUNG('Benjamin Hartyniuk Euroflex\nMusterweg 7\n66649 Oberthal'), LIEFERSCHEIN, 'CMR Frachtbrief Nr. 9', TRANSPORTAUFTRAG].map(ascii));
  assert.equal(await T.pdfSeitenzahl(alles), 4);
  const st = await T.pdfSeitenTexte(alles);
  assert.equal(st?.seiten.length, 4);
  assert.match(st!.seiten[0], /Rechnungs-Nr\.: RE-2099-4711/);
  assert.match(st!.seiten[3], /Transport Order/);
  assert.equal(await T.pdfHatERechnung(alles), false);

  const o = { aufteilen: true, pruefen: true, firma: FIRMA, fruehere: ALT };
  const an = (await pdfAnalysieren('Scan 4711.pdf', alles, o))!;
  assert.equal(an.seiten.map((s) => s.art).join(''), 'RAAT');
  assert.deepEqual(an.teile.map((t) => [t.rolle, t.datei, t.seiten.length]), [['rechnung', 'Scan 4711 – Rechnung.pdf', 1], ['ablieferbeleg', 'Scan 4711 – Ablieferbelege.pdf', 2]]);
  assert.equal(an.hinweis, 'Original (unverändert) – aufgeteilt in Rechnung (S. 1) und Ablieferbelege (S. 2–3); eigener Transportauftrag (S. 4) entfernt.');
  assert.equal(an.teile[0].pruefung?.ergebnis, 'alt');
  assert.equal(an.teile[1].pruefung, null);
  // die Teile sind echte PDFs mit genau diesen Seiten; der Transportauftrag steht in keinem
  assert.equal(await T.pdfSeitenzahl(an.teile[0].daten), 1);
  assert.equal(await T.pdfSeitenzahl(an.teile[1].daten), 2);
  const beleg = (await T.pdfSeitenTexte(an.teile[1].daten))!.seiten;
  assert.match(beleg[0], /Lieferschein/);
  assert.match(beleg[1], /CMR/);
  assert.doesNotMatch(beleg.join(' ') + (await T.pdfSeitenTexte(an.teile[0].daten))!.seiten.join(' '), /Transport Order/);

  // abgeschaltet: einordnen und prüfen ja, teilen nein
  const aus = (await pdfAnalysieren('Scan.pdf', alles, { ...o, aufteilen: false }))!;
  assert.deepEqual([aus.teile.length, aus.rolle, aus.pruefung?.ergebnis, aus.hinweis], [0, 'rechnung', 'alt', null]);
  // nicht eindeutig: kein Teil, Hinweis auf „Aufteilen…“
  const unklar = (await pdfAnalysieren('Scan.pdf', pdfBauen([RECHNUNG('x'), `Bedingungen\n${'Der Frachtfuehrer haftet nach dem Gesetz.\n'.repeat(14)}`].map(ascii)), o))!;
  assert.equal(unklar.teile.length, 0);
  assert.match(unklar.hinweis ?? '', /Aufteilung ist nicht eindeutig/);
  // von Hand: Seite 2 gehört zur Rechnung, Seite 3 ist Beleg
  const hand = (await pdfAnalysieren('Scan.pdf', alles, { ...o, arten: ['R', 'R', 'A', 'T'] }))!;
  assert.deepEqual(hand.teile.map((t) => t.seiten.length), [2, 1]);
  await assert.rejects(pdfAnalysieren('Scan.pdf', alles, { ...o, arten: ['R', 'A'] }), /hat 4 Seiten/);
  await assert.rejects(pdfAnalysieren('Scan.pdf', alles, { ...o, arten: ['A', 'A', 'A', 'A'] }), /nichts aufzuteilen/);
  // nur Belege bzw. kein PDF: nichts zu tun
  assert.equal((await pdfAnalysieren('Belege.pdf', pdfBauen([LIEFERSCHEIN, 'CMR'].map(ascii)), o))!.teile.length, 0);
  assert.equal(await pdfAnalysieren('kaputt.pdf', Buffer.from('%PDF-1.4 kaputt'), o), null);
  // E-Rechnung: nie zerlegen
  assert.equal(await T.pdfHatERechnung(Buffer.concat([alles, Buffer.from('\n% /F (factur-x.xml)\n')])), true);
});

// ---------------------------------------------------------------- mit Datenbank
let sql: typeof import('../src/db.js')['sql'];
let app: Awaited<ReturnType<typeof import('../src/app.js')['buildApp']>>;
let cookie = '';
let port = 0;
const T = '/api/m/transport';
const entwuerfe: { absender: string; an: string[]; betreff: string; text: string; anhaenge: string[]; objekt: string }[] = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.url === '/webhook/euroflex-mailversand') {
      const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      for (const m of b.mails ?? []) entwuerfe.push({ absender: b.absender, an: m.an, betreff: m.betreff, text: m.text, anhaenge: (b.anhaenge ?? []).map((a: { dateiname: string }) => a.dateiname), objekt: b.objekt });
      return send(200, { status: b.modus === 'senden' ? 'gesendet' : 'entwurf', postfach: b.absender, mails: (b.mails ?? []).map((m: { nr: number; rolle: string; an: string[] }) => ({ nr: m.nr, rolle: m.rolle, an: m.an.join(', '), status: 'entwurf', message_id: `<R${m.nr}@example.org>` })) });
    }
    send(200, {});
  });
});
async function admin(method: string, path: string, payload?: unknown) {
  const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
  const set = res.headers['set-cookie'];
  if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
  const ct = String(res.headers['content-type'] ?? '');
  return { status: res.statusCode, body: ct.includes('json') && res.body ? JSON.parse(res.body) : res.body };
}

before(async () => {
  if (!mitDb) return;
  process.env.DATABASE_URL = url;
  process.env.PORTAL_MODULES = 'transport';
  ({ sql } = await import('../src/db.js'));
  const { migrate } = await import('../src/migrate.js');
  const { activeModules } = await import('../src/modules.js');
  const { buildApp } = await import('../src/app.js');
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  port = (server.address() as { port: number }).port;
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'Euroflex', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'geheim-geheim' });
  await sql`update transport.firma set name = ${FIRMA.name}, strasse = ${FIRMA.strasse}, plz = ${FIRMA.plz}, ort = ${FIRMA.ort}, ustid = ${FIRMA.ustid} where id = 1`;
  await sql`insert into transport.adressen (adrnr, kundenname, email) values (980001, 'Spedition Beispiel GmbH', 'rechnung@spedition-beispiel.test')`;
  await sql`insert into transport.auftraege (auftragsnr, kunde, unternehmer) values ('2098_8001', 980001, 980001)`;
});
after(async () => {
  if (!mitDb) return;
  await app?.close();
  await sql.end();
  server.close();
});

test('Migration belegt die frühere Firmierung vor; Einstellungen lassen sich sichern', ohneDb, async () => {
  let r = await admin('GET', `${T}/workflow-einstellungen`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.eingang.fruehereFirmierungen, [{ name: 'Benjamin Hartyniuk Euroflex', ustid: 'DE814480003' }]);
  assert.deepEqual([r.body.eingang.firmierungAktion, r.body.eingang.rechnungAufteilen, r.body.eingang.firmierungPruefen], ['markieren', true, true]);
  r = await admin('PUT', `${T}/workflow-einstellungen`, { ...r.body, eingang: { ...r.body.eingang, ocr: false, firmierungAktion: 'entwurf', fruehereFirmierungen: [...r.body.eingang.fruehereFirmierungen, { name: '', ustid: '' }] } });
  assert.equal(r.status, 400, 'leere frühere Firmierung');
  r = await admin('GET', `${T}/workflow-einstellungen`);
  r = await admin('PUT', `${T}/workflow-einstellungen`, { ...r.body, eingang: { ...r.body.eingang, ocr: false, firmierungAktion: 'entwurf' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await admin('GET', `${T}/workflow-einstellungen`)).body.eingang.firmierungAktion, 'entwurf');
});

test('Aufgeteiltes PDF: Original bleibt (nicht ablegbar), Teile offen; Firmierung in Liste und Hinweis; Reklamation als Entwurf; Ablage schließt ab', ohneDb, async () => {
  const V = await import('../../modules/transport/server/eingang/verarbeitung.js');
  const [v] = await sql`
    insert into transport.eing_vorgaenge (postfach, message_id, von, betreff, status, hinweis, auftragsnr, punkte)
    values ('buchhaltung@euroflex-rechnung.test', 'rechnung-1@test', 'rechnung@spedition-beispiel.test', 'AW: Rechnung RE-2099-4711', 'neu', 'Vorschlag 2098_8001 – bitte die Ablage bestätigen.', '2098_8001', 90)
    returning id::int as id`;
  const id = v.id as number;
  const alt = P.firmierungPruefen(RECHNUNG('Benjamin Hartyniuk Euroflex\n66649 Oberthal'), FIRMA, ALT);
  const seiten = P.seitenEinordnen([RECHNUNG('x'), LIEFERSCHEIN, TRANSPORTAUFTRAG]);
  const orig = await V.dokumentAnlegen(id, {
    art: 'anhang', datei: 'Scan 4711.pdf', mime: 'application/pdf', daten: Buffer.from('%PDF-1.4 Original'), ocr: 'Rechnung', hinweis: P.aufteilungText(P.aufteilung(seiten)),
    rolle: 'rechnung', seiten, pruefung: alt,
    teile: [
      { rolle: 'rechnung', datei: 'Scan 4711 – Rechnung.pdf', daten: Buffer.from('%PDF-1.4 Rechnung'), ocr: 'Rechnung RE-2099-4711', seiten: [seiten[0]], pruefung: alt },
      { rolle: 'ablieferbeleg', datei: 'Scan 4711 – Ablieferbelege.pdf', daten: Buffer.from('%PDF-1.4 Belege'), ocr: 'Lieferschein', seiten: [seiten[1]], pruefung: null },
    ],
  });
  // Hinweis am Vorgang, ohne Anbindung kein Entwurf – der Fehler steht im Hinweis, die Verarbeitung läuft weiter
  await V.firmierungMelden(id, true);
  assert.equal(await V.abschliessen(id), 'pruefen');
  let [vg] = await sql`select hinweis, reklamation_am from transport.eing_vorgaenge where id = ${id}`;
  assert.match(vg.hinweis, /^Vorschlag 2098_8001 – bitte die Ablage bestätigen\. Rechnungsempfänger prüfen – „Scan 4711 – Rechnung\.pdf“: Rechnung an die frühere Firmierung „Benjamin Hartyniuk Euroflex“/);
  assert.match(vg.hinweis, /Reklamations-Entwurf nicht angelegt: .*nicht eingerichtet/);
  assert.equal(vg.reklamation_am, null);

  // Liste und Detail
  const liste = await admin('GET', `${T}/eingang/vorgaenge?status=pruefen`);
  assert.equal(liste.body.vorgaenge.find((x: { id: number }) => x.id === id).firmierung, 'alt');
  let d = await admin('GET', `${T}/eingang/vorgaenge/${id}`);
  assert.deepEqual(d.body.dokumente.map((x: any) => [x.datei, x.status, x.rolle, x.teil_von, x.pruefung?.ergebnis ?? null, x.seitenzahl]), [
    ['Scan 4711.pdf', 'ignoriert', 'original', null, 'alt', 3],
    ['Scan 4711 – Rechnung.pdf', 'neu', 'rechnung', orig, 'alt', 1],
    ['Scan 4711 – Ablieferbelege.pdf', 'neu', 'ablieferbeleg', orig, null, 1],
  ]);
  // das Original bleibt herunterladbar und zählt nicht zur Speicherwarnung
  assert.equal((await admin('GET', `${T}/eingang/dokumente/${orig}/datei`)).body, '%PDF-1.4 Original');
  assert.equal((await admin('GET', `${T}/eingang/speicher`)).body.dateien, 2);

  // Reklamation von Hand: Entwurf im Eingangspostfach an den Absender, Rechnung im Anhang, nur eine E-Mail (keine Kopie)
  let r = await admin('POST', `${T}/eingang/vorgaenge/${id}/reklamation`, {});
  assert.equal(r.status, 400, 'ohne Anbindung');
  r = await admin('PUT', '/api/verbindungen/transport.mail', { url: `http://127.0.0.1:${port}/webhook/euroflex-mailversand`, auth_art: 'header', header_name: 'X-Euroflex-Key', geheimnis: 'k', einstellungen: { kopie_an: 'ablage@example.org' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await admin('POST', `${T}/eingang/vorgaenge/${id}/reklamation`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Reklamation an rechnung@spedition-beispiel\.test als Entwurf im Postfach buchhaltung@euroflex-rechnung\.test abgelegt/);
  assert.deepEqual(entwuerfe, [{
    absender: 'buchhaltung@euroflex-rechnung.test', an: ['rechnung@spedition-beispiel.test'], betreff: 'Bitte um Rechnungskorrektur – Rechnung RE-2099-4711',
    text: entwuerfe[0]?.text, anhaenge: ['Scan 4711 – Rechnung.pdf'], objekt: '2098_8001',
  }]);
  assert.match(entwuerfe[0].text, /Euroflex Logistik GmbH\nMusterweg 7\n66649 Oberthal/);
  d = await admin('GET', `${T}/eingang/vorgaenge/${id}`);
  assert.equal(d.body.reklamation_von, 'Admin');
  assert.match(d.body.reklamation_am, /^\d{4}-\d\d-\d\d \d\d:\d\d$/);
  // automatisch nur einmal: ein zweiter Lauf legt keinen weiteren Entwurf an
  await V.firmierungMelden(id, true);
  assert.equal(entwuerfe.length, 1);

  // Ablage ohne Auswahl: beide Teile, das Original nicht; der Vorgang ist abgeschlossen
  r = await admin('POST', `${T}/eingang/vorgaenge/${id}/ablegen`, { auftragsnr: '2098_8001' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.status, r.body.wartet], ['abgelegt', 2]);
  assert.deepEqual((await sql`select datei, status, inhalt is not null as inhalt from transport.eing_dokumente where vorgang_id = ${id} order by id`).map((x) => [x.datei, x.status, x.inhalt]),
    [['Scan 4711.pdf', 'ignoriert', true], ['Scan 4711 – Rechnung.pdf', 'wartet', true], ['Scan 4711 – Ablieferbelege.pdf', 'wartet', true]]);
  assert.deepEqual((await admin('GET', `${T}/auftraege/2098_8001/eingang`)).body.map((x: { datei: string }) => x.datei), ['Scan 4711 – Rechnung.pdf', 'Scan 4711 – Ablieferbelege.pdf']);
  // liegt ein Teil am Auftrag, lässt sich die Aufteilung nicht mehr ändern
  r = await admin('DELETE', `${T}/eingang/dokumente/${orig}/aufteilen`);
  assert.equal(r.status, 400);
  assert.match(r.body.message, /lässt sich nicht mehr ändern/);
});

test('Aufteilung zurücknehmen; ignorieren löscht auch das Original; Teile lassen sich nicht weiter teilen', ohneDb, async () => {
  const V = await import('../../modules/transport/server/eingang/verarbeitung.js');
  const [v] = await sql`
    insert into transport.eing_vorgaenge (postfach, message_id, von, betreff, status) values ('buchhaltung@euroflex-rechnung.test', 'rechnung-2@test', 'rechnung@spedition-beispiel.test', 'Rechnung', 'neu')
    returning id::int as id`;
  const id = v.id as number;
  const seiten = P.seitenEinordnen([RECHNUNG('Euroflex Logistik GmbH 66649 Oberthal'), LIEFERSCHEIN]);
  const teile = () => [
    { rolle: 'rechnung' as const, datei: 'RE – Rechnung.pdf', daten: Buffer.from('%PDF-1.4 R2'), ocr: '', seiten: [seiten[0]], pruefung: null },
    { rolle: 'ablieferbeleg' as const, datei: 'RE – Ablieferbelege.pdf', daten: Buffer.from('%PDF-1.4 B2'), ocr: '', seiten: [seiten[1]], pruefung: null },
  ];
  const orig = await V.dokumentAnlegen(id, { art: 'anhang', datei: 'RE.pdf', mime: 'application/pdf', daten: Buffer.from('%PDF-1.4 O2'), ocr: '', hinweis: 'Original (unverändert) – aufgeteilt', seiten, teile: teile() });
  await V.abschliessen(id);
  const [teil] = await sql`select id::int as id from transport.eing_dokumente where teil_von = ${orig} order by id limit 1`;
  let r = await admin('GET', `${T}/eingang/dokumente/${teil.id}/seiten`);
  assert.equal(r.status, 400);
  assert.match(r.body.message, /bereits ein Teil/);
  r = await admin('GET', `${T}/eingang/dokumente/${orig}/seiten`);
  assert.deepEqual([r.body.aufgeteilt, r.body.seiten.map((s: { art: string }) => s.art).join('')], [true, 'RA']);
  assert.equal((await admin('POST', `${T}/eingang/dokumente/${orig}/aufteilen`, { arten: ['R'] })).status, 400, 'mindestens zwei Seiten');

  r = await admin('DELETE', `${T}/eingang/dokumente/${orig}/aufteilen`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await sql`select datei, status, rolle, hinweis from transport.eing_dokumente where vorgang_id = ${id}`).map((x) => [x.datei, x.status, x.rolle, x.hinweis]), [['RE.pdf', 'neu', 'rechnung', null]]);
  assert.equal((await admin('DELETE', `${T}/eingang/dokumente/${orig}/aufteilen`)).status, 400, 'nicht (mehr) aufgeteilt');

  // wieder aufgeteilt und dann die ganze E-Mail ignoriert: auch der Inhalt des Originals wird gelöscht
  await sql`update transport.eing_dokumente set status = 'ignoriert', rolle = 'original' where id = ${orig}`;
  for (const t of teile()) await V.teilAnlegen(id, orig, t);
  r = await admin('POST', `${T}/eingang/vorgaenge/${id}/ignorieren`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'ignoriert');
  assert.deepEqual((await sql`select status, inhalt is not null as inhalt from transport.eing_dokumente where vorgang_id = ${id} order by id`).map((x) => [x.status, x.inhalt]),
    [['ignoriert', false], ['ignoriert', false], ['ignoriert', false]]);
});
