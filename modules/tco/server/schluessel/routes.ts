import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, change, requireAuth } from '../../../../server/src/auth.js';
import { withChange } from '../../../../server/src/db.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { portalUrl } from '../../../../server/src/kennwort.js';
import { mailVerfuegbar } from '../../../../server/src/lib/mail.js';
import { DB, plAktiv, vereinLesen } from '../verein.js';
import { kontaktLesen, mailSenden } from '../kommunikation.js';
import { kandidaten } from '../halle/sammel.js';
import { belegeZuordnen } from '../fi/buchen.js';
import { ADRNR_ZU_BENUTZER } from '../platz/schluessel.js';
import { variantenLesen, varianteLoeschen, varianteSichern, varianteStandard, type Ansicht } from '../instandhaltung/varianten.js';
import { abgleichAnlegen, abgleichKontenSichern, abgleichLesen, abgleichLoesen, abgleichVerknuepfen, nachbuchen, nachbuchenLesen } from './abgleich.js';
import { belegAblegen, belegPdf, type BelegDaten } from './beleg.js';
import {
  P_SCHL, altdatenPruefen, altdatenUebernehmen, ausgabe, bestandAbleiten, cfgLesen, cfgSichern, detailLesen, empfangBestaetigen, linkErneuern, listeLesen,
  mailQuittung, mailRueckgabe, meineOffenen, personenAlle, pfandLesen, protokollLesen, quittieren, quittungInfo, rueckgabe, stornieren, vorgangLesen, type Mail,
} from './logik.js';
import { ART, SPALTEN_TEXT, STATUS, ZUSTAND, type Zustand } from './regeln.js';
import { protokoll, type Ich } from './vorgang.js';

export { P_SCHL };

/**
 * Hallenschlüssel (#215)
 *  - /schluessel…            App: Übersicht, Ausgabe, Rückgabe, Empfang bestätigen, Storno, Beleg, Altdaten, Einstellungen, Varianten
 *  - /schluessel/quittung    öffentlich (Token aus der E-Mail): Kunde quittiert den Erhalt
 *  - /schluessel/meine       angemeldeter Benutzer: eigene offene Quittungen
 */
const REPID = 'SCHLUESSEL';
const txt = (max: number) => z.string().trim().max(max);
const pId = z.object({ id: z.coerce.number().int().positive() });
const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Bitte ein Datum angeben.');
const ich = (req: FastifyRequest): Ich => ({ id: req.user!.apiKey ? null : req.user!.id, name: req.user!.displayName || req.user!.username });

const versuche = new Map<string, { n: number; bis: number }>();
function limit(ip: string, max: number) {
  const jetzt = Date.now();
  const v = versuche.get(ip);
  const cur = v && v.bis > jetzt ? v : { n: 0, bis: jetzt + 60 * 60_000 };
  cur.n++;
  versuche.set(ip, cur);
  if (cur.n > max) throw new BusinessError('Zu viele Aufrufe von dieser Verbindung. Bitte später erneut versuchen.', 429);
}
/** IP für den Nachweis kürzen (letzter Block entfällt) */
const ipKurz = (ip: string) => (ip.includes(':') ? `${ip.split(':').slice(0, 3).join(':')}:…` : ip.replace(/\.\d+$/, '.x'));

/** Mails senden (nicht kritisch) – {portal} wird ersetzt, jede Mail steht im Protokoll des Vorgangs */
async function mailsSenden(mails: Mail[], wer: Ich, log: FastifyBaseLogger): Promise<number> {
  if (!mails.length) return 0;
  let n = 0;
  try {
    if (!(await mailVerfuegbar())) return 0;
    const v = await vereinLesen();
    const url = (await portalUrl()) ?? '';
    for (const m of mails) {
      let ergebnis: string;
      try {
        await mailSenden(v, {
          modus: 'senden', anwendung: 'Hallenschlüssel', objekt: m.objekt, an: m.an, benutzer: wer.name, anhaenge: [], persoenlich: false,
          betreff: `${v.name}: ${m.betreff}`, text: `${m.text.replaceAll('{portal}', url)}\n\nViele Grüße\n${v.name}`,
        });
        n++;
        ergebnis = `an ${m.an}: ${m.betreff}`;
      } catch (e) {
        log.warn({ objekt: m.objekt, err: (e as Error).message }, 'Hallenschlüssel: E-Mail nicht gesendet');
        ergebnis = `NICHT gesendet an ${m.an} (${(e as Error).message}): ${m.betreff}`;
      }
      await withChange({ userId: wer.id, username: wer.name, action: 'SCHLUESSEL_MAIL' }, (tx) => protokoll(tx, m.vorgang_id, wer, 'MAIL', ergebnis))
        .catch((e) => log.warn(e, 'Hallenschlüssel: Protokoll E-Mail'));
    }
  } catch (e) { log.warn({ err: (e as Error).message }, 'Hallenschlüssel: E-Mail-Versand nicht möglich'); }
  return n;
}

async function belegErzeugen(id: number, benutzer: string) {
  const v = await vereinLesen();
  const daten = { ...(await vorgangLesen(DB, id)), protokoll: await protokollLesen(DB, id) } as unknown as BelegDaten;
  const k = await kontaktLesen(DB, daten.adrnr);
  const pdf = await belegPdf(v, daten, k ? { strasse: k.strasse, plz: k.plz, ort: k.ort } : null, (await cfgLesen(DB)).bedingungen_text, benutzer);
  return { v, daten, pdf };
}

/** Beleg erzeugen und in Paperless ablegen (neu oder neue Version); ohne Paperless bzw. bei Fehler nur ein Hinweis */
async function belegInPaperless(id: number, wer: Ich, log: FastifyBaseLogger): Promise<string[]> {
  try {
    const { v, daten, pdf } = await belegErzeugen(id, wer.name);
    if (!plAktiv(v)) return ['Paperless ist nicht eingerichtet – der Beleg wurde nicht abgelegt.'];
    const r = await belegAblegen(v, daten, pdf, wer.name);
    const dokid = String(r.id).padStart(6, '0');
    await withChange({ userId: wer.id, username: wer.name, action: 'SCHLUESSEL_BELEG' }, async (tx) => {
      await tx`update tco.schluessel_vorgang set doc_id = ${r.id} where id = ${id}`;
      await protokoll(tx, id, wer, 'BELEG', `Beleg in Paperless abgelegt – DOKID ${dokid}${r.neu ? '' : ', neue Version'} (${daten.status_txt})`);
      await bestandAbleiten(tx, daten.adrnr);
    });
    return r.warnungen;
  } catch (e) {
    log.warn({ vorgang: id, err: (e as Error).message }, 'Hallenschlüssel: Beleg nicht abgelegt');
    return [`Der Beleg konnte nicht in Paperless abgelegt werden: ${(e as Error).message}`];
  }
}

export async function schluesselRoutes(app: FastifyInstance) {
  const lesen = { preHandler: requireAuth(P_SCHL.display) };
  const schreiben = { preHandler: requireAuth(P_SCHL.edit) };
  const admin = { preHandler: requireAuth(P_SCHL.admin) };

  // ------------------------------------------------------------------ öffentlich: Quittung des Kunden
  app.get('/schluessel/quittung', async (req) => {
    limit(req.ip, 120);
    const { token } = z.object({ token: z.string().min(20).max(100) }).parse(req.query);
    const { id: _id, ...info } = await quittungInfo(DB, token);
    return { ...info, verein: (await vereinLesen()).name };
  });

  app.post('/schluessel/quittung', async (req) => {
    limit(req.ip, 30);
    const b = z.object({
      token: z.string().min(20).max(100), name: txt(100).default(''),
      zustimmung: z.literal(true, { errorMap: () => ({ message: 'Bitte bestätige den Erhalt und die Spielregeln.' }) }),
    }).parse(req.body);
    const angemeldet = req.user && !req.user.apiKey ? ich(req) : null;
    const nachweis = angemeldet ? `Portal-Benutzer ${req.user!.username}` : `Link aus der E-Mail, IP ${ipKurz(req.ip)}`;
    const wer: Ich = angemeldet ?? { id: null, name: b.name || 'Online-Quittung' };
    const r = await withChange({ userId: wer.id, username: wer.name, action: 'SCHLUESSEL_QUITTUNG' }, (tx) => quittieren(tx, b.token, angemeldet?.name ?? b.name, nachweis, angemeldet));
    await belegInPaperless(r.id, { id: wer.id, name: wer.name }, req.log);
    return { text: r.text, nummer: r.nummer };
  });

  /** eigene offene Quittungen (für den Hinweis in „Meine Mitgliedschaft“) */
  app.get('/schluessel/meine', { preHandler: requireAuth() }, async (req) => {
    if (!req.user?.id || req.user.apiKey) return [];
    const [u] = await DB`select ${DB.unsafe(ADRNR_ZU_BENUTZER('u.id'))} as adrnr from core.users u where u.id = ${req.user.id}`;
    return meineOffenen(DB, u?.adrnr ?? null);
  });

  // ------------------------------------------------------------------ App
  app.get('/schluessel', lesen, async (req) => ({
    arten: ART, status: STATUS, zustaende: ZUSTAND, pfand: await pfandLesen(DB), zeilen: await listeLesen(DB),
    darf: { edit: can(req, P_SCHL.edit), admin: can(req, P_SCHL.admin) }, ich: ich(req).name,
  }));

  /** Personen für die Ausgabe: Mitglieder und Kunden, mit Kennzeichen „hat Schlüssel“ */
  /** Auswahl für eine neue Ausgabe; mit `?alle=1` alle Personen (Mitglieder jedes Status, alle Kunden) für die Zuweisung von Altfällen */
  app.get('/schluessel/personen', schreiben, async (req) => {
    if (z.object({ alle: z.string().optional() }).parse(req.query).alle) return personenAlle(DB);
    const mit = new Set((await DB`select adrnr from tco.schluessel where ausgabe is not null and ruecknahme is null`).map((r) => r.adrnr as string));
    return (await kandidaten(DB)).map((k) => ({ adrnr: k.adrnr, name: k.name, info: k.info, hat: mit.has(k.adrnr) }));
  });

  app.get('/schluessel/:id', lesen, async (req) => {
    const { id } = pId.parse(req.params);
    const d = await detailLesen(DB, id);
    // Quittungslink nur für Bearbeiter (zum Weitergeben, wenn keine E-Mail-Adresse hinterlegt ist)
    let link: string | null = null;
    if ((d as { link_offen?: boolean }).link_offen && can(req, P_SCHL.edit)) {
      const [t] = await DB`select token from tco.schluessel_vorgang where id = ${id}`;
      link = t?.token ? `${(await portalUrl()) ?? ''}/schluessel-quittung?token=${t.token}` : null;
    }
    return { ...d, link };
  });

  app.post('/schluessel/ausgabe', schreiben, async (req) => {
    const b = z.object({
      adrnr: z.string().min(1, 'Bitte eine Person wählen.').max(20), datum, schluessel_nr: txt(30).nullish(), bemerkung: txt(500).nullish(),
      ausgegeben_von: txt(100).nullish(), mit_rechnung: z.boolean().default(true),
    }).parse(req.body);
    const wer = ich(req);
    const r = await change(req, (tx) => ausgabe(tx, b, wer), { action: 'SCHLUESSEL_AUSGABE' });
    const hinweise = await belegInPaperless(r.id, wer, req.log);
    const mails = await mailQuittung(DB, r.id);
    const n = await mailsSenden(mails, wer, req.log);
    if (!mails.length) hinweise.push('Keine E-Mail-Adresse hinterlegt – bitte den Quittungslink aus dem Vorgang weitergeben.');
    else if (!n) hinweise.push('Die E-Mail mit dem Quittungslink konnte nicht gesendet werden – bitte den Link aus dem Vorgang weitergeben.');
    return { ...r, hinweise };
  });

  app.post('/schluessel/rueckgabe', schreiben, async (req) => {
    const b = z.object({
      adrnr: z.string().min(1).max(20), datum, zustand: z.enum(Object.keys(ZUSTAND) as [Zustand, ...Zustand[]]).default('OK'), bemerkung: txt(500).nullish(),
      empfangen_von: txt(100).nullish(), gutschrift: z.boolean().default(true), bestaetigt: z.boolean().default(true),
    }).parse(req.body);
    const wer = ich(req);
    const r = await change(req, (tx) => rueckgabe(tx, b, wer), { action: 'SCHLUESSEL_RUECKGABE' });
    const hinweise = await belegInPaperless(r.id, wer, req.log);
    if (b.bestaetigt) await mailsSenden(await mailRueckgabe(DB, r.id), wer, req.log);
    return { ...r, hinweise };
  });

  /** TCO quittiert den Empfang bei der Rückgabe */
  app.post('/schluessel/:id/empfang', schreiben, async (req) => {
    const { id } = pId.parse(req.params);
    const wer = ich(req);
    const text = await change(req, (tx) => empfangBestaetigen(tx, id, wer), { action: 'SCHLUESSEL_EMPFANG', reason: String(id) });
    const hinweise = await belegInPaperless(id, wer, req.log);
    await mailsSenden(await mailRueckgabe(DB, id), wer, req.log);
    return { text, hinweise };
  });

  app.post('/schluessel/:id/link', schreiben, async (req) => {
    const { id } = pId.parse(req.params);
    const wer = ich(req);
    const r = await change(req, (tx) => linkErneuern(tx, id, wer), { action: 'SCHLUESSEL_LINK', reason: String(id) });
    const n = await mailsSenden(r.mails, wer, req.log);
    return { text: r.mails.length && !n ? 'Der Link wurde erneuert, die E-Mail konnte aber nicht gesendet werden.' : r.text };
  });

  app.post('/schluessel/:id/storno', schreiben, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ grund: txt(300).min(3, 'Bitte einen Grund für das Storno angeben.') }).parse(req.body);
    return change(req, (tx) => stornieren(tx, id, b.grund, ich(req)), { action: 'SCHLUESSEL_STORNO', reason: String(id) });
  });

  app.get('/schluessel/:id/beleg.pdf', lesen, async (req, reply) => {
    const { id } = pId.parse(req.params);
    const { daten, pdf } = await belegErzeugen(id, ich(req).name);
    return reply.type('application/pdf').header('content-disposition', `inline; filename="Hallenschluessel_${daten.nummer}.pdf"`).send(pdf);
  });

  /** Beleg (erneut) in Paperless ablegen */
  app.post('/schluessel/:id/beleg', schreiben, async (req) => {
    const { id } = pId.parse(req.params);
    if (!plAktiv(await vereinLesen())) throw new BusinessError('Paperless ist nicht eingerichtet (Administration → Anbindungen).');
    const hinweise = await belegInPaperless(id, ich(req), req.log);
    const [v] = await DB`select doc_id from tco.schluessel_vorgang where id = ${id}`;
    if (!v?.doc_id) throw new BusinessError(hinweise[0] ?? 'Der Beleg konnte nicht abgelegt werden.');
    return { text: `Beleg in Paperless abgelegt (DOKID ${String(v.doc_id).padStart(6, '0')}).`, hinweise };
  });

  /**
   * Eigenes Dokument zum Vorgang in Paperless ablegen (z. B. der Scan des alten Belegs nach der Übernahme der Altdaten):
   * Kontext wie der erzeugte Beleg; hat der Vorgang schon ein Dokument, wird es eine neue Version. Ist der Vorgang mit einer
   * FI-Buchung verknüpft, wird das Dokument auch deren Beleg.
   */
  app.post('/schluessel/:id/dokument', { ...schreiben, bodyLimit: 30 * 1024 * 1024 }, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ datei: z.string().min(1).max(200), inhalt: z.string().min(1, 'Die Datei ist leer.') }).parse(req.body);
    const v = await vereinLesen();
    if (!plAktiv(v)) throw new BusinessError('Paperless ist nicht eingerichtet (Administration → Anbindungen).');
    const daten = { ...(await vorgangLesen(DB, id)), protokoll: [] } as unknown as BelegDaten;
    if (daten.status === 'STORNIERT') throw new BusinessError('Der Vorgang ist storniert.');
    const inhalt = Buffer.from(b.inhalt.replace(/^data:[^,]*;base64,/, ''), 'base64');
    if (!inhalt.length) throw new BusinessError('Die Datei ist leer.');
    const datei = b.datei.split(/[\\/]/).pop()!;
    const wer = ich(req);
    const r = await belegAblegen(v, daten, inhalt, wer.name, datei);
    const dokid = String(r.id).padStart(6, '0');
    await change(req, async (tx) => {
      await tx`update tco.schluessel_vorgang set doc_id = ${r.id} where id = ${id}`;
      await protokoll(tx, id, wer, 'BELEG', `Dokument „${datei}“ in Paperless abgelegt – DOKID ${dokid}${r.neu ? '' : ', neue Version'}`);
      if (daten.internenr) await belegeZuordnen(tx, daten.internenr, [r.id]);
      await bestandAbleiten(tx, daten.adrnr);
    }, { action: 'SCHLUESSEL_BELEG', reason: String(id) });
    return { text: `${datei} bei ${daten.nummer} abgelegt (DOKID ${dokid}).`, doc_id: r.id, hinweise: r.warnungen };
  });

  // ------------------------------------------------------------------ Altdaten (Copy & Paste)
  /** Zeile → Adressnummer: in der Vorschau von Hand zugewiesene Mitglieder/Kunden */
  const zZuordnung = z.record(z.string().regex(/^\d+$/), z.string().min(1).max(20)).default({});
  app.post('/schluessel/altdaten/pruefen', admin, async (req) => {
    const b = z.object({ text: z.string().max(500_000), zuordnung: zZuordnung }).parse(req.body);
    return { spalten: Object.values(SPALTEN_TEXT), zeilen: await altdatenPruefen(DB, b.text, b.zuordnung), kassenkonto: (await cfgLesen(DB)).kassenkonto };
  });
  app.post('/schluessel/altdaten', admin, async (req) => {
    // gebucht wird nur auf ausdrücklichen Wunsch: alle Zeilen (`buchen`) oder einzelne (`buchen_zeilen`)
    const nr = z.array(z.number().int().positive()).max(1000);
    const b = z.object({
      text: z.string().min(1, 'Bitte die Altdaten einfügen.').max(500_000), buchen: z.boolean().default(false), buchen_zeilen: nr.optional(), zeilen: nr.optional(), zuordnung: zZuordnung,
    }).parse(req.body);
    return change(req, (tx) => altdatenUebernehmen(tx, b.text, { buchen: b.buchen, buchenZeilen: b.buchen_zeilen, zeilen: b.zeilen, zuordnung: b.zuordnung }, ich(req)), { action: 'SCHLUESSEL_ALTDATEN' });
  });

  // ------------------------------------------------------------------ Abgleich mit früheren Kontobewegungen (FI-Belege)
  app.get('/schluessel/abgleich/daten', admin, async () => abgleichLesen(DB));
  /** die beiden Konten festlegen, deren Buchungen abgeglichen werden */
  app.put('/schluessel/abgleich/konten', admin, async (req) => {
    const b = z.object({ konto1: txt(10).min(1, 'Bitte beide Konten angeben.'), konto2: txt(10).min(1, 'Bitte beide Konten angeben.') }).parse(req.body);
    return { text: await change(req, (tx) => abgleichKontenSichern(tx, b.konto1, b.konto2), { action: 'SCHLUESSEL_CFG' }) };
  });
  app.post('/schluessel/abgleich/verknuepfen', admin, async (req) => {
    const b = z.object({ paare: z.array(z.object({ internenr: z.string().min(1).max(20), vorgang_id: z.number().int().positive() })).min(1, 'Bitte mindestens eine Zeile wählen.').max(500) }).parse(req.body);
    return { text: await change(req, (tx) => abgleichVerknuepfen(tx, b.paare, ich(req)), { action: 'SCHLUESSEL_ABGLEICH' }) };
  });
  app.post('/schluessel/abgleich/anlegen', admin, async (req) => {
    const b = z.object({ internenr: z.string().min(1).max(20), richtung: z.enum(['AUSGABE', 'RUECKGABE']), adrnr: z.string().min(1).max(20) }).parse(req.body);
    return { text: await change(req, (tx) => abgleichAnlegen(tx, b.internenr, b.richtung, b.adrnr, ich(req)), { action: 'SCHLUESSEL_ABGLEICH' }) };
  });
  app.post('/schluessel/abgleich/loesen', admin, async (req) => {
    const b = z.object({ vorgang_id: z.number().int().positive() }).parse(req.body);
    return { text: await change(req, (tx) => abgleichLoesen(tx, b.vorgang_id, ich(req)), { action: 'SCHLUESSEL_ABGLEICH' }) };
  });

  // ------------------------------------------------------------------ historische Ausgaben (ohne Rechnung) nachbuchen
  /** Vorschau: Ausgaben ohne Hallenrechnung mit Stand der FI-Buchung; `konto` = Geldkonto der Buchung (Vorgabe 1200) */
  app.get('/schluessel/nachbuchen/daten', admin, async (req) => nachbuchenLesen(DB, z.object({ konto: txt(10).default('1200') }).parse(req.query).konto || '1200'));
  /** „ausgegeben von“ überschreiben, Wert setzen, je Ausgabe ohne Buchung eine FI-Buchung erzeugen und zuordnen */
  app.post('/schluessel/nachbuchen', admin, async (req) => {
    const b = z.object({
      ids: z.array(z.number().int().positive()).min(1, 'Bitte mindestens eine Ausgabe wählen.').max(2000),
      ausgegeben_von: txt(80).min(1, 'Bitte angeben, wer die Schlüssel ausgegeben hat.'), wert: z.number().positive().max(10_000), konto: txt(10).min(1),
    }).parse(req.body);
    return change(req, (tx) => nachbuchen(tx, b, ich(req)), { action: 'SCHLUESSEL_NACHBUCHEN' });
  });

  // ------------------------------------------------------------------ Einstellungen
  app.get('/schluessel/einstellungen/daten', admin, async () => ({ ...(await cfgLesen(DB)), pfand: await pfandLesen(DB) }));
  app.put('/schluessel/einstellungen/daten', admin, async (req) => {
    const b = z.object({
      bedingungen: txt(4000).default(''), quittung_tage: z.coerce.number().int().min(1).max(90), link_tage: z.coerce.number().int().min(1).max(365),
      kassenkonto: txt(10).min(1, 'Bitte das Kassenkonto angeben.'),
    }).parse(req.body);
    return { text: await change(req, (tx) => cfgSichern(tx, b), { action: 'SCHLUESSEL_CFG' }) };
  });

  // ------------------------------------------------------------------ Listenvarianten je Benutzer
  const benutzer = (req: FastifyRequest) => req.user!.username;
  app.get('/schluessel/varianten/liste', lesen, async (req) => ({
    varianten: await variantenLesen(DB, benutzer(req), REPID), standard: await varianteStandard(DB, benutzer(req), REPID),
  }));
  app.post('/schluessel/varianten/liste', lesen, async (req) => {
    const b = z.object({
      name: txt(30).min(1, 'Bitte einen Namen für die Variante angeben.'), standard: z.boolean().default(false), global: z.boolean().default(false),
      ansicht: z.object({
        alle: z.boolean().default(false), suche: txt(100).default(''),
        filter: z.record(z.string().max(40), z.string().max(200)).default({}),
        sort: z.object({ k: z.string().max(40), ab: z.boolean() }).nullable().default(null),
      }),
    }).parse(req.body);
    if (b.global && !can(req, P_SCHL.admin)) throw new BusinessError('Varianten für alle darf nur anlegen, wer die Hallenschlüssel verwaltet (Einstellungen).', 403);
    const v = await change(req, (tx) => varianteSichern(tx, benutzer(req), b, b.ansicht as Ansicht, REPID), { action: 'SCHLUESSEL_VARIANTE' });
    return { text: `Variante „${v.name}“ gesichert${b.standard ? ' (Standard)' : ''}.`, variante: v };
  });
  app.delete('/schluessel/varianten/liste', lesen, async (req) => {
    const { key } = z.object({ key: z.string().min(3).max(100) }).parse(req.body);
    if (key.startsWith('*/') && !can(req, P_SCHL.admin)) throw new BusinessError('Varianten für alle darf nur löschen, wer die Hallenschlüssel verwaltet.', 403);
    return { text: `Variante „${await change(req, (tx) => varianteLoeschen(tx, benutzer(req), key, REPID), { action: 'SCHLUESSEL_VARIANTE' })}“ gelöscht.` };
  });
}
