import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { DB, plAktiv, vereinLesen, type Db } from '../verein.js';
import { tcoHinweis } from '../hinweise.js';
import { mitgliedDokumentPruefen } from '../dokumentfreigabe.js';
import { condense, heute } from '../format.js';
import { kontaktLesen, mailSenden, whatsappLink } from '../kommunikation.js';
import {
  austrittSichern, bankSichern, betragAm, DATUM_TYP, detailLesen, kanalSetzen, kopfSichern, leer, listeLesen, mitgliedLesen, mitgliedNeu,
  normName, notizAnlegen, notizLoeschen, sepaManuell, STATUS, trainerSetzen, vertragAendern, vertragNeu, vertragsarten,
  vertragsbeginn, vertragsZahler, zahlerAuswahl, zahlerVorschlag, ZAHLUNGSARTEN, ZAHLUNGSWEISEN,
} from './logik.js';
import { ART_TEXT, ARTEN, druckdatenLesen, unterlagePdf } from './pdf.js';
import { dateiAblegen, dokumenteLesen, freigabelinks, korrName, mailText, plPruefen, SPEICHERPFAD, unterlageAblegen } from './dokumente.js';
import { mapLesen, parse, zahlerErmitteln } from './antrag.js';
import { istMaskiert, maskIban, maskText, type Feldschutz } from '../../../../server/src/schutz.js';
import { einladen, einladungLesen, einladungVorlage, einloesen, EINLADUNG_PLATZHALTER, kandidaten as einladungKandidaten } from './einladung.js';
import { abgleichen, namenLesen, vorlage as zugangVorlage, zugangSenden, PLATZHALTER } from './zugangslink.js';
import { bankdatenErforderlich, bankSchutz, doktypMitBankdaten, P_BANK } from '../bankdaten.js';
import { blzDateiLesen, blzImport, blzStand, ibanPruefen, sepaNeu } from './bank.js';
import type { Verein } from '../verein.js';
import { kontextAblegen } from '../../../../server/src/lib/paperless-mapping.js';
import { K } from '../paperless-kontexte.js';
import {
  ausgetreteneSperren, ausgetreteneSperrenMelden, bankAendern, benutzerKandidaten, eigeneAdrnr, kontaktSichern, meineLesen, mitgliederBenutzerAnlegen, P_SELBST,
} from './selbst.js';
import { ep3Anlegen } from '../platz/registrierung.js';
import { mappingUebernehmen, mappingVorschlaege, zuordnungLesen, zuordnungSetzen, zuordnungSuchen } from './zuordnung.js';
import { withChange } from '../../../../server/src/db.js';
import { funktionAktiv, modulId } from '../../../../server/src/funktionsschalter.js';
import { unterlageVersenden, vorgang, vorgangKontext, VORGANG_TEXT, type Vorgang } from './vorgaenge.js';
import { selbstKontext, selbstVorgang } from './selbstvorgang.js';
import { ablehnen, ablehnungMitteilen, abschliessen, bestaetigungPdf, bestaetigungSenden, einreichen, freigeben, kuendigungLesen } from './kuendigung.js';
import { gruppenLesen, gruppenMitgliedEntfernen, gruppenMitgliedSetzen, mitgliedGruppen, personenDerGruppe } from '../gruppen/logik.js';

export const P_MG = { display: 'tco.mitglieder:display', edit: 'tco.mitglieder:edit' };

const benutzer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';
const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');
const datumOpt = datum.nullish().or(z.literal('').transform(() => null)).transform((x) => x || null);
const adrnr = z.string().min(1).max(20);
const pAdr = z.object({ adrnr });
const art = z.enum(ARTEN);
const docId = z.coerce.number().int().positive();
const txt = z.string().default('');

/** Daten-URL oder Base64 → Buffer */
const binaer = (s: string) => Buffer.from(s.replace(/^data:[^,]*;base64,/, ''), 'base64');

// ---------------------------------------------------------------- Schutz der Bankdaten (siehe ../bankdaten.ts)
type Detail = Awaited<ReturnType<typeof detailLesen>>;

/** Detail ohne Bankdaten-Berechtigung: IBAN/BIC maskiert, freier Kontoinhaber-Text maskiert */
function detailSchuetzen(d: Detail, s: Feldschutz): Detail & { bankKlar: boolean } {
  if (s.klar) return { ...d, bankKlar: true };
  const freitext = !!d.bank.abwkontoinh && !d.bank.adrnrkih;
  return {
    ...d, bankKlar: false,
    bank: {
      ...d.bank, iban: s.iban(d.bank.iban), bic: s.bic(d.bank.bic), abwkontoinh: s.text(d.bank.abwkontoinh),
      kontoinhaber: freitext ? maskText(d.bank.kontoinhaber) : d.bank.kontoinhaber,
      zahler: d.bank.zahler ? { ...d.bank.zahler, iban: s.iban(d.bank.zahler.iban) } : null,
    },
  };
}

/** Druckdaten für die Voransicht ohne Berechtigung: Bankverbindung maskiert (auch die des Zahlers) */
function druckSchuetzen(d: Awaited<ReturnType<typeof druckdatenLesen>>, s: Feldschutz) {
  if (s.klar) return d;
  const bank = (x: Record<string, any>): Record<string, any> => ({ ...x, iban1: s.iban(x.iban1), bic1: s.bic(x.bic1), abwkontoinh: s.text(x.abwkontoinh) });
  const freitext = !!leer(d.m.abwkontoinh) && !leer(d.m.adrnrkih);
  return { ...d, m: bank(d.m), zahler: d.zahler ? bank(d.zahler) : null, kontoinhaber: freitext ? maskText(d.kontoinhaber) : d.kontoinhaber };
}

/** Dokument gehört zu einem Mitglied; Dokumente mit Bankdaten nur mit Berechtigung */
async function dokFreigeben(req: FastifyRequest, v: Verein, id: number) {
  const { typ } = await mitgliedDokumentPruefen(DB, v, id);
  if (doktypMitBankdaten(typ)) bankdatenErforderlich(bankSchutz(req), `Das Dokument (${typ})`);
}

const kopfSchema = z.object({
  anrede: txt, vorname: txt, nachname: txt, strasse: txt, plz: txt, ort: txt, telefon: txt, mobil: txt, email: txt,
  geburtsdatum: datumOpt, eintritt: datumOpt, datenschutz: z.boolean().default(false), bildrechte: z.boolean().default(false),
});

const neuSchema = kopfSchema.omit({ eintritt: true }).extend({
  eintritt: datum,
  zahlungsart: z.enum(['L', 'U', 'B']), zahlungsweise: txt, iban: txt, bic: txt, bank: txt,
  sepa: z.boolean().default(true), sepa_datum: datumOpt,
  zahler_modus: z.enum(['SELBST', 'BESTEHEND', 'NEU']).default('SELBST'), zahler_adrnr: z.string().nullish().transform((x) => x ?? null),
  z_anrede: txt, z_vorname: txt, z_nachname: txt, z_strasse: txt, z_plz: txt, z_ort: txt, z_email: txt,
  vertraege: z.array(z.object({ art: z.string().min(1), beginn: datumOpt, betrag: z.coerce.number(), turnus: txt })),
  antrag_docid: z.coerce.number().int().positive().nullish(),
});

/**
 * Neuanlage mit maskierter IBAN/BIC (Benutzer ohne Bankdaten-Berechtigung, Vorbelegung aus Zahler oder
 * Aufnahmeantrag): Der Klartext wird serverseitig aus derselben Quelle übernommen und nie an die
 * Oberfläche gegeben. Eine selbst eingetippte IBAN ist nie maskiert und wird unverändert verwendet.
 */
async function maskierteBankdatenAufloesen(n: z.infer<typeof neuSchema>): Promise<void> {
  if (!istMaskiert(n.iban) && !istMaskiert(n.bic)) return;
  let quelle: { iban: string; bic: string } | null = null;
  if (n.zahler_modus === 'BESTEHEND' && n.zahler_adrnr) {
    const [z] = await DB`select iban1, bic1 from tco.mitglieder where adrnr = ${n.zahler_adrnr}`;
    if (z && leer(z.iban1)) quelle = { iban: leer(z.iban1), bic: leer(z.bic1) };
  }
  if (!quelle && n.antrag_docid) {
    const d = await plPruefen(await vereinLesen()).dokument(n.antrag_docid).catch(() => null);
    if (d && leer(d.content)) {
      const { antrag } = parse(String(d.content), await mapLesen(DB));
      if (antrag.iban) quelle = { iban: antrag.iban, bic: antrag.bic };
    }
  }
  if (!quelle) throw new BusinessError('Die IBAN ist maskiert und kann keiner Quelle zugeordnet werden – bitte die vollständige IBAN eingeben.');
  if (istMaskiert(n.iban)) n.iban = quelle.iban;
  if (istMaskiert(n.bic)) n.bic = quelle.bic;
}

/** täglicher Lauf: Benutzer ausgetretener Mitglieder sperren */
let austrittLauf: ReturnType<typeof setInterval> | null = null;
async function austrittSperrenLauf(log: FastifyInstance['log']) {
  // Funktionsschalter (#232, F1): Der Lauf ruht nur, wenn das ganze Vereinsmodul abgeschaltet ist – ist allein die App
  // „Mitglieder“ aus, werden Benutzer ausgetretener Mitglieder weiterhin gesperrt (Schutzfunktion).
  if (!funktionAktiv(modulId('tco'))) return;
  try {
    const r = await withChange({ userId: null, username: 'system', action: 'AUSTRITT_SPERRE' }, (tx) => ausgetreteneSperrenMelden(tx));
    if (r.gesperrt.length || r.rolleEntzogen.length) log.info(r, 'Benutzer ausgetretener Mitglieder gesperrt');
  } catch (e) { log.warn(e, 'Sperre ausgetretener Mitglieder fehlgeschlagen'); }
}

export async function mitgliederRoutes(app: FastifyInstance) {
  if (!austrittLauf && process.env.NODE_ENV !== 'test' && !process.env.TEST_DATABASE_URL) {
    setTimeout(() => austrittSperrenLauf(app.log), 15_000).unref();
    austrittLauf = setInterval(() => austrittSperrenLauf(app.log), 6 * 3600_000);
    austrittLauf.unref();
  }
  const lesen = { preHandler: requireAuth(P_MG.display) };
  const schreiben = { preHandler: requireAuth(P_MG.edit) };
  const selbst = { preHandler: requireAuth(P_SELBST) };
  const benutzerId = (req: FastifyRequest) => {
    if (!req.user?.id) throw new BusinessError('Bitte mit einem persönlichen Benutzer anmelden.', 403);
    return req.user.id;
  };

  /** Ereignis aus „Meine Mitgliedschaft“ im Arbeitsvorrat melden (#232, V1): Kassenwart, Absprung zum Mitglied */
  const selbstHinweis = async (tx: Db, req: FastifyRequest, h: { quelle: string; art: string; text: string; adrnr?: string; objekt?: string; state?: 'Information' | 'Critical' }) => {
    const eigene = await eigeneAdrnr(tx, benutzerId(req));
    const a = h.adrnr ?? eigene;
    await tcoHinweis(tx, {
      quelle: h.quelle, objekt: h.objekt ?? a, bereich: 'Kassenwart', recht: P_MG.display, art: h.art, state: h.state, icon: 'employee',
      titel: a === eigene ? `${benutzer(req)} (Mitglied ${a})` : `${benutzer(req)} für Mitglied ${a}`, text: h.text, pfad: `/tco/mitglieder?adrnr=${a}`,
    });
  };

  // ---------------------------------------------------------------- „Meine Mitgliedschaft“ (nur eigene Daten)
  app.get('/mitglieder/meine', selbst, async (req) => meineLesen(DB, benutzerId(req)));
  app.put('/mitglieder/meine/kontakt', selbst, async (req) => {
    const k = z.object({ strasse: txt, plz: txt, ort: txt, telefon: txt, mobil: txt, email: txt, bildrechte: z.boolean().default(false) }).parse(req.body);
    return { text: await change(req, async (tx) => {
      const text = await kontaktSichern(tx, benutzerId(req), k);
      await selbstHinweis(tx, req, { quelle: 'MG_KONTAKT', art: 'Kontaktdaten geändert', text: 'Anschrift, E-Mail oder Telefon über „Meine Mitgliedschaft“ geändert.' });
      return text;
    }, { action: 'SELBSTAUSKUNFT' }) };
  });
  app.put('/mitglieder/meine/bank', selbst, async (req) => {
    const b = z.object({ iban: z.string().min(1, 'Bitte die IBAN angeben.'), bic: txt, bank: txt }).parse(req.body);
    if (istMaskiert(b.iban)) throw new BusinessError('Bitte die vollständige neue IBAN eingeben.');
    return { text: await change(req, async (tx) => {
      const text = await bankAendern(tx, benutzerId(req), b);
      await selbstHinweis(tx, req, { quelle: 'MG_BANK', art: 'Bankverbindung geändert', state: 'Critical', text: `Neue Bankverbindung über „Meine Mitgliedschaft“ eingetragen (IBAN ${maskIban(b.iban.replace(/\s+/g, ''))}).` });
      return text;
    }, { action: 'SELBSTAUSKUNFT', reason: 'Bankverbindung' }) };
  });
  app.get('/mitglieder/meine/dokumente', selbst, async (req) => {
    const v = await vereinLesen();
    if (!plAktiv(v)) return { dokumente: [], hinweis: 'Die Dokumentenablage ist nicht eingerichtet.' };
    const m = await mitgliedLesen(DB, await eigeneAdrnr(DB, benutzerId(req)));
    const r = await dokumenteLesen(v, m).catch(() => null);
    if (!r) return { dokumente: [], hinweis: 'Die Dokumentenablage ist gerade nicht erreichbar.' };
    return { dokumente: r.dokumente.map(({ id, titel, erstellt, typ, datei }) => ({ id, titel, erstellt, typ, datei })), hinweis: null };
  });
  app.get('/mitglieder/meine/dokumente/:id', selbst, async (req, reply) => {
    const { id } = z.object({ id: docId }).parse(req.params);
    const v = await vereinLesen();
    const m = await mitgliedLesen(DB, await eigeneAdrnr(DB, benutzerId(req)));
    // nur Dokumente des eigenen Korrespondenten
    const r = await dokumenteLesen(v, m);
    if (!r.dokumente.some((d) => d.id === id)) throw new BusinessError('Dokument nicht gefunden.', 404);
    const d = await plPruefen(v).download(id);
    return reply.type(d.contentType).header('content-disposition', `inline; filename="${encodeURIComponent(d.filename)}"`).send(d.data);
  });

  /** eigene Gruppen: der Baum der Gruppen (ohne die Mitglieder der Gruppen) und die eigenen Zuordnungen */
  app.get('/mitglieder/meine/gruppen', selbst, async (req) => {
    const a = await eigeneAdrnr(DB, benutzerId(req));
    return {
      gruppen: (await gruppenLesen(DB)).map(({ id, parent_id, name, ebene, aktiv }) => ({ id, parent_id, name, ebene, aktiv })),
      meine: await mitgliedGruppen(DB, a),
    };
  });
  /** sich selbst einer Gruppe zuordnen oder daraus austragen; die Rolle (z. B. Mannschaftsführer) vergibt der Verein */
  app.post('/mitglieder/meine/gruppen', selbst, async (req) => {
    const b = z.object({ gruppe: z.coerce.number().int().positive(), entfernen: z.boolean().default(false) }).parse(req.body);
    const a = await eigeneAdrnr(DB, benutzerId(req));
    const g = (await gruppenLesen(DB)).find((x) => x.id === b.gruppe);
    if (!g) throw new BusinessError('Gruppe nicht gefunden.', 404);
    if (b.entfernen) {
      await change(req, async (tx) => {
        await gruppenMitgliedEntfernen(tx, b.gruppe, a);
        await selbstHinweis(tx, req, { quelle: 'MG_GRUPPE', objekt: `${a}:${b.gruppe}`, art: 'Gruppe: Mitglied trägt sich ein oder aus', text: `Aus der Gruppe „${g.name}“ ausgetragen.` });
      }, { action: 'SELBSTAUSKUNFT', reason: 'Gruppe' });
      return { text: `Du bist aus „${g.name}“ ausgetragen.` };
    }
    if (!g.aktiv) throw new BusinessError(`Die Gruppe „${g.name}“ ist nicht mehr aktiv.`);
    // bereits zugeordnet: nichts ändern (die Rolle bleibt)
    if (!g.mitglieder.some((m) => m.adrnr === a)) {
      await change(req, async (tx) => {
        await gruppenMitgliedSetzen(tx, b.gruppe, a, null);
        await selbstHinweis(tx, req, { quelle: 'MG_GRUPPE', objekt: `${a}:${b.gruppe}`, art: 'Gruppe: Mitglied trägt sich ein oder aus', text: `In die Gruppe „${g.name}“ eingetragen.` });
      }, { action: 'SELBSTAUSKUNFT', reason: 'Gruppe' });
    }
    return { text: `Du bist in „${g.name}“ eingetragen.` };
  });

  // Geführte Vorgänge (#154): Beitragswechsel und Jugendtraining selbst abschließen – auch für Personen, die über mich zahlen
  const selbstSchema = z.object({ typ: z.enum(['BEITRAGSWECHSEL', 'JUGENDTRAINING']), adrnr, art: z.string().trim().min(1, 'Bitte eine Beitragsart wählen') });
  app.get('/mitglieder/meine/vorgang', selbst, async (req) => selbstKontext(DB, benutzerId(req)));
  app.post('/mitglieder/meine/vorgang/pruefen', selbst, async (req) => selbstVorgang(DB, benutzerId(req), selbstSchema.parse(req.body), false, benutzer(req)));
  app.post('/mitglieder/meine/vorgang', selbst, async (req) => {
    const e = selbstSchema.parse(req.body);
    const id = benutzerId(req);
    const p = await change(req, async (tx) => {
      const x = await selbstVorgang(tx, id, e, true, benutzer(req));
      await selbstHinweis(tx, req, { quelle: 'MG_VORGANG', adrnr: e.adrnr, objekt: `${e.adrnr}:${e.typ}`, art: `${VORGANG_TEXT[e.typ]} durch das Mitglied`, text: x.text });
      return x;
    }, { action: e.typ, reason: `${VORGANG_TEXT[e.typ]} über „Meine Mitgliedschaft“` });
    // Mitgliederinformation mit den neuen Verträgen: ablegen und an das angemeldete Mitglied senden (Kopie an den Verein)
    const unterlage = await unterlageVersenden(DB, await vereinLesen(), e.adrnr, p.unterlage, p.text, 'Portal', p.eigene);
    return { ...p, text: `${VORGANG_TEXT[e.typ]} ausgeführt: ${p.text}`, unterlage };
  });

  app.post('/mitglieder/meine/kuendigung', selbst, async (req) => {
    const k = z.object({
      art: z.enum(['MITGLIEDSCHAFT', 'VERTRAG']), adrnr: z.string().nullish(), vertragnr: z.string().nullish(), grund: z.string().max(500).nullish(),
      /** Mehrfachauswahl im Dialog „Kündigen“ */
      vertraege: z.array(z.object({ adrnr: z.string().min(1).max(20), vertragnr: z.string().min(1).max(20) })).min(1, 'Bitte mindestens einen Vertrag wählen.').max(30).optional(),
      bestaetigung: z.literal(true, { errorMap: () => ({ message: 'Bitte die Kündigung bestätigen.' }) }),
    }).parse(req.body);
    // Freigabe durch den Vorstand (#232): hier wird nur eingereicht – ausgeführt wird die Kündigung mit der Freigabe (kuendigung.ts)
    const v = await vereinLesen();
    const r = await change(req, (tx) => einreichen(tx, benutzerId(req), k, v, benutzer(req)), { action: 'KUENDIGUNG_EINGEREICHT', reason: k.grund ?? null });
    return { id: r.id, eingereicht: true, text: `Deine Kündigung ist eingegangen und wird vom Vorstand freigegeben. Danach erhältst du die Kündigungsbestätigung per E-Mail. Eingereicht: ${r.text}` };
  });

  // ---------------------------------------------------------------- Kündigungen freigeben (Vorstand, #232) – aus dem Arbeitsvorrat
  const kid = (req: FastifyRequest) => z.object({ id: z.coerce.number().int().positive() }).parse(req.params).id;
  app.get('/mitglieder/kuendigungen/:id', schreiben, async (req) => kuendigungLesen(DB, kid(req)));
  /** Freigabe: Die Kündigung wird ausgeführt (Kündigungsdatum = Tag des Eingangs); danach zeigt die Oberfläche die Bestätigung zur Prüfung */
  app.post('/mitglieder/kuendigungen/:id/freigeben', schreiben, async (req) => {
    const id = kid(req);
    const v = await vereinLesen();
    const r = await change(req, (tx) => freigeben(tx, id, v, benutzer(req)), { action: 'KUENDIGUNG', reason: `Freigabe Kündigung ${id}` });
    return { text: `Freigegeben: ${r.text} Bitte die Kündigungsbestätigung prüfen und senden.` };
  });
  app.get('/mitglieder/kuendigungen/:id/pdf', schreiben, async (req, reply) => {
    const d = await bestaetigungPdf(DB, kid(req), await vereinLesen());
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${encodeURIComponent(d.dateiname)}"`).send(d.pdf);
  });
  /** Bestätigung ablegen und an das Mitglied senden – oder ohne E-Mail abschließen (dann selbst zustellen) */
  app.post('/mitglieder/kuendigungen/:id/senden', schreiben, async (req) => {
    const id = kid(req);
    const { ohneMail } = z.object({ ohneMail: z.boolean().default(false) }).parse(req.body ?? {});
    const r = await bestaetigungSenden(DB, id, await vereinLesen(), benutzer(req), ohneMail);
    await change(req, (tx) => abschliessen(tx, id, r), { action: 'KUENDIGUNG_BESTAETIGUNG', reason: r.fertig ? (r.gesendet ? 'gesendet' : 'ohne E-Mail abgeschlossen') : 'E-Mail nicht gesendet' });
    return {
      fertig: r.fertig, gesendet: r.gesendet, hinweise: r.hinweise,
      text: r.gesendet ? 'Die Kündigungsbestätigung wurde an das Mitglied gesendet.' : r.fertig ? 'Ohne E-Mail abgeschlossen – bitte die Bestätigung selbst zustellen.' : 'Die Kündigungsbestätigung wurde nicht gesendet.',
    };
  });
  app.post('/mitglieder/kuendigungen/:id/ablehnen', schreiben, async (req) => {
    const id = kid(req);
    const { grund } = z.object({ grund: z.string().trim().min(3, 'Bitte einen Grund angeben – das Mitglied erhält ihn per E-Mail.').max(500) }).parse(req.body);
    const k = await change(req, (tx) => ablehnen(tx, id, grund, benutzer(req)), { action: 'KUENDIGUNG_ABGELEHNT', reason: grund });
    const hinweise = await ablehnungMitteilen(DB, await vereinLesen(), k, grund, benutzer(req));
    return { hinweise, text: `Kündigung abgelehnt.${hinweise.length ? '' : ' Das Mitglied wurde per E-Mail unterrichtet.'}` };
  });

  // ---------------------------------------------------------------- Administration → Benutzer und Rechte → Benutzer: einzelner Benutzer aus Mitglied/EP3-Kunde
  app.get('/mitglieder/benutzer-kandidaten', { preHandler: requireAuth('core.users:edit') }, async (req) => {
    const { suche } = z.object({ suche: z.string().max(80).default('') }).parse(req.query);
    return benutzerKandidaten(DB, suche);
  });
  app.post('/mitglieder/benutzer-einzeln', { preHandler: requireAuth('core.users:edit') }, async (req) => {
    const b = z.object({ art: z.enum(['MITGLIED', 'EP3']), schluessel: z.string().min(1), mail: z.boolean().default(true) }).parse(req.body);
    if (b.art === 'EP3') {
      const r = await change(req, (tx) => ep3Anlegen(tx, b.schluessel), { action: 'EP3_BENUTZER', reason: b.schluessel });
      return { ...r, rolle: 'Hallennutzer' };
    }
    const v = await vereinLesen();
    const r = await change(req, (tx) => mitgliederBenutzerAnlegen(tx, v, { mail: b.mail, adrnr: b.schluessel }), { action: 'MITGLIEDER_BENUTZER', reason: b.schluessel });
    if (r.hochgestuft) return { text: 'Vorhandener Hallennutzer (EP3) wurde dem Mitglied zugeordnet und zur Rolle Mitglied hochgestuft.', username: null, startkennwort: null, rolle: 'Mitglied' };
    const a = r.angelegt[0];
    if (!a) throw new BusinessError(r.uebersprungen[0] ?? 'Kein Benutzer angelegt.');
    return { text: `Benutzer ${a.username} angelegt (Rolle Mitglied) – ${a.hinweis}.`, username: a.username, startkennwort: a.startkennwort, rolle: 'Mitglied' };
  });

  // ---------------------------------------------------------------- Administration → Benutzer und Rechte → Benutzer: Zuordnung Mitglied / EP3-Kunde
  const uid = z.object({ id: z.string().uuid() });
  app.get('/mitglieder/benutzer/:id/zuordnung', { preHandler: requireAuth('core.users:display') }, async (req) => zuordnungLesen(DB, uid.parse(req.params).id));
  app.put('/mitglieder/benutzer/:id/zuordnung', { preHandler: requireAuth('core.users:edit') }, async (req) => {
    const { id } = uid.parse(req.params);
    const b = z.object({ adrnr: z.string().nullish(), zuid: z.string().nullish(), rolleMitglied: z.boolean().default(true) }).parse(req.body);
    const ziel = { ...(b.adrnr !== undefined ? { adrnr: b.adrnr || null } : {}), ...(b.zuid !== undefined ? { zuid: b.zuid || null } : {}), rolleMitglied: b.rolleMitglied };
    return { text: await change(req, (tx) => zuordnungSetzen(tx, id, ziel), { action: 'BENUTZER_ZUORDNUNG' }) };
  });
  app.get('/mitglieder/zuordnung-suche', { preHandler: requireAuth('core.users:edit') }, async (req) => {
    const { suche } = z.object({ suche: z.string().max(80).default('') }).parse(req.query);
    return zuordnungSuchen(DB, suche);
  });
  app.get('/mitglieder/benutzer-mapping', { preHandler: requireAuth('core.users:edit') }, async () => mappingVorschlaege(DB));
  app.post('/mitglieder/benutzer-mapping', { preHandler: requireAuth('core.users:edit') }, async (req) => {
    const b = z.object({
      liste: z.array(z.object({ benutzerId: z.string().uuid(), adrnr: z.string().nullish(), zuid: z.string().nullish() })).min(1, 'Bitte mindestens eine Zuordnung wählen.'),
      rolleMitglied: z.boolean().default(true),
    }).parse(req.body);
    return { text: await change(req, (tx) => mappingUebernehmen(tx, b.liste, b.rolleMitglied), { action: 'BENUTZER_MAPPING' }) };
  });

  // ---------------------------------------------------------------- Administration → Benutzer und Rechte → Benutzer: Mitglieder als Benutzer anlegen
  app.post('/mitglieder/benutzer-anlegen', { preHandler: requireAuth('core.users:edit') }, async (req) => {
    const o = z.object({ mail: z.boolean().default(true) }).parse(req.body ?? {});
    const v = await vereinLesen();
    const r = await change(req, (tx) => mitgliederBenutzerAnlegen(tx, v, o), { action: 'MITGLIEDER_BENUTZER' });
    const offen = r.angelegt.filter((a) => a.startkennwort).length;
    return {
      ...r,
      text: `${r.angelegt.length} Benutzer angelegt (Rolle Mitglied)${r.hochgestuft ? `, ${r.hochgestuft} vorhandene Hallennutzer zu Mitgliedern hochgestuft` : ''}`
        + `${r.gesendet ? `, ${r.gesendet} Startkennwörter per E-Mail gesendet` : ''}${offen ? `, ${offen} Startkennwörter zum Weitergeben (Liste herunterladen)` : ''}`
        + `${r.uebersprungen.length ? `, ${r.uebersprungen.length} übersprungen` : ''}.`,
    };
  });

  // ---------------------------------------------------------------- Einladung zum Vereinsportal (QR-Code, Sammellauf)
  app.get('/mitglieder/einladungen', { preHandler: requireAuth('core.users:edit') }, async () => einladungKandidaten(DB));
  /** Vorschlag für Betreff und Text der Einladungsmail (im Dialog änderbar) und die Adresse für „Kopie an mich“ */
  app.get('/mitglieder/einladungen/vorlage', { preHandler: requireAuth('core.users:edit') }, async (req) => (
    { ...einladungVorlage(await vereinLesen()), platzhalter: EINLADUNG_PLATZHALTER, cc: req.user?.email ?? null }));
  /** Kopie an den Versender: seine E-Mail-Adresse aus der Benutzerverwaltung */
  const ccAnMich = (req: FastifyRequest, an: boolean) => {
    if (!an) return null;
    const e = (req.user?.email ?? '').trim();
    if (!e) throw new BusinessError('Für „Kopie an mich“ ist bei deinem Benutzer keine E-Mail-Adresse hinterlegt (Administration → Benutzer und Rechte → Benutzer).');
    return e;
  };
  app.post('/mitglieder/einladungen', { preHandler: requireAuth('core.users:edit') }, async (req) => {
    const o = z.object({
      adrnrs: z.array(z.string().min(1)).nullish(), tage: z.coerce.number().int().min(1).max(90).default(30), brief: z.boolean().default(false),
      /** angepasster Betreff/Text der E-Mail (Platzhalter {Vorname} {Name} {Link} {GueltigBis}); ohne Angabe der feste Text */
      betreff: z.string().trim().max(200).nullish(), text: z.string().trim().max(20_000).nullish(),
      cc: z.boolean().default(false),
    }).parse(req.body ?? {});
    let vorlage: { betreff: string; text: string } | null = null;
    if (o.text || o.betreff) {
      if (!o.betreff || !o.text) throw new BusinessError('Bitte Betreff und Text der E-Mail angeben.');
      if (!o.text.includes('{Link}')) throw new BusinessError('Der Text muss den Platzhalter {Link} enthalten – dort steht der persönliche Link.');
      vorlage = { betreff: o.betreff, text: o.text };
    }
    const cc = ccAnMich(req, o.cc);
    const v = await vereinLesen();
    const r = await change(req, (tx) => einladen(tx, v, { adrnrs: o.adrnrs ?? null, tage: o.tage, brief: o.brief, wer: benutzer(req), vorlage, cc }), { action: 'EINLADUNG' });
    return {
      ...r,
      text: `${r.gesendet} Einladung${r.gesendet === 1 ? '' : 'en'} per E-Mail gesendet${r.briefe ? `, ${r.briefe} Brief${r.briefe === 1 ? '' : 'e'} zum Drucken (PDF)` : ''}`
        + `${r.fehler.length ? ` – ${r.fehler.length} Mail(s) fehlgeschlagen, stattdessen als Brief` : ''}.`,
    };
  });
  // ---------------------------------------------------------------- Zugangslinks an Personen aus einer Liste (#105)
  app.get('/mitglieder/zugang/vorlage', { preHandler: requireAuth('core.users:edit') }, async (req) => ({ ...zugangVorlage(await vereinLesen()), platzhalter: PLATZHALTER, cc: req.user?.email ?? null }));
  app.post('/mitglieder/zugang/abgleich', { preHandler: requireAuth('core.users:edit') }, async (req) => {
    const { text } = z.object({ text: z.string().max(50_000) }).parse(req.body);
    const namen = namenLesen(text);
    if (!namen.length) throw new BusinessError('Im eingefügten Text wurden keine Namen gefunden.');
    if (namen.length > 300) throw new BusinessError('Höchstens 300 Namen auf einmal.');
    return abgleichen(DB, namen);
  });
  app.post('/mitglieder/zugang/senden', { preHandler: requireAuth('core.users:edit'), bodyLimit: 15 * 1024 * 1024 }, async (req) => {
    const b = z.object({
      empfaenger: z.array(z.string().regex(/^[UM]:.+$/)).min(1, 'Bitte mindestens einen Empfänger auswählen.').max(300),
      betreff: z.string().trim().min(1, 'Bitte einen Betreff angeben.').max(200),
      text: z.string().trim().min(1).max(20_000),
      tage: z.coerce.number().int().min(1).max(60).default(14),
      pdf: z.object({ name: z.string().min(1), data: z.string().min(1) }).nullish(),
      cc: z.boolean().default(false),
    }).parse(req.body);
    const cc = ccAnMich(req, b.cc);
    if (!b.text.includes('{Link}')) throw new BusinessError('Der Text muss den Platzhalter {Link} enthalten – dort steht der persönliche Link.');
    let pdf: { dateiname: string; inhalt: Buffer } | null = null;
    if (b.pdf) {
      const inhalt = Buffer.from(b.pdf.data.replace(/^data:[^,]*,/, ''), 'base64');
      if (inhalt.subarray(0, 4).toString() !== '%PDF') throw new BusinessError('Der Anhang ist keine PDF-Datei.');
      if (inhalt.length > 10 * 1024 * 1024) throw new BusinessError('Der Anhang ist größer als 10 MB.');
      pdf = { dateiname: b.pdf.name.replace(/[\\/]/g, '_').replace(/(\.pdf)?$/i, '.pdf'), inhalt };
    }
    const v = await vereinLesen();
    const zeilen: { key: string; ok: boolean; name: string; an: string; art: string; text: string }[] = [];
    // je Empfänger eigene Transaktion: ein Fehler hält die übrigen nicht auf
    for (const key of [...new Set(b.empfaenger)]) {
      try {
        const r = await change(req, (tx) => zugangSenden(tx, v, key, { betreff: b.betreff, text: b.text, tage: b.tage, pdf, wer: benutzer(req), cc }),
          { action: 'ZUGANGSLINK', reason: key });
        zeilen.push({ key, ok: true, ...r, text: r.art === 'BENUTZER' ? 'Kennwort-Link gesendet' : 'Einladung gesendet (noch kein Benutzer)' });
      } catch (e) {
        if (!(e instanceof BusinessError)) throw e;
        zeilen.push({ key, ok: false, name: '', an: '', art: '', text: e.message });
      }
    }
    const ok = zeilen.filter((x) => x.ok).length;
    return { zeilen, text: `${ok} von ${zeilen.length} E-Mail(s) gesendet.` };
  });

  /** öffentlich: Einladung prüfen und einlösen (Benutzer mit Rolle Mitglied) */
  const einladungVersuche = new Map<string, { n: number; bis: number }>();
  const einladungLimit = (ip: string) => {
    const jetzt = Date.now();
    const x = einladungVersuche.get(ip);
    const cur = x && x.bis > jetzt ? x : { n: 0, bis: jetzt + 3600_000 };
    cur.n++;
    einladungVersuche.set(ip, cur);
    if (cur.n > 30) throw new BusinessError('Zu viele Versuche. Bitte später erneut versuchen.', 429);
  };
  app.get('/einladung', async (req) => {
    einladungLimit(req.ip);
    const { token } = z.object({ token: z.string().max(100) }).parse(req.query);
    return { ...(await einladungLesen(DB, token)), verein: (await vereinLesen()).name };
  });
  app.post('/einladung', async (req) => {
    einladungLimit(req.ip);
    const b = z.object({
      token: z.string().max(100),
      benutzername: z.string().trim().min(3, 'Benutzername: mindestens 3 Zeichen').max(50).regex(/^[a-zA-Z0-9._@+-]+$/, 'Benutzername: nur Buchstaben, Ziffern, . _ - @'),
      passwort: z.string().max(200),
      datenschutz: z.literal(true, { errorMap: () => ({ message: 'Bitte der Verarbeitung der Daten zustimmen.' }) }),
    }).parse(req.body);
    const r = await withChange({ userId: null, username: 'Einladung', action: 'EINLADUNG_EINGELOEST' }, async (tx) => {
      const x = await einloesen(tx, b.token, b);
      await tcoHinweis(tx, {
        quelle: 'MG_ZUGANG', objekt: x.username, bereich: 'Kassenwart', recht: P_MG.display, art: 'Mitglied hat seinen Zugang eingerichtet', icon: 'add-employee',
        titel: x.name, text: `Benutzer „${x.username}“ über den Einladungslink angelegt.`, pfad: '/tco/mitglieder',
      });
      return x;
    });
    return { text: `Willkommen, ${r.name}! Ihr Zugang ist eingerichtet – melden Sie sich jetzt mit „${r.username}“ und Ihrem Kennwort an.` };
  });

  // ---------------------------------------------------------------- Liste / Stammdaten der Auswahl
  app.get('/mitglieder/liste', lesen, async (req) => {
    const q = z.object({
      status: z.enum(STATUS).default('AKTIV'), datumTyp: z.enum(DATUM_TYP).default('EINGETRETEN'),
      von: datumOpt, bis: datumOpt, suche: z.string().nullish(),
      // Mitgliedergruppe (einschließlich ihrer Untergruppen)
      gruppe: z.coerce.number().int().positive().optional(),
    }).parse(req.query);
    return listeLesen(DB, { ...q, nur: q.gruppe ? await personenDerGruppe(DB, q.gruppe) : null });
  });

  app.get('/mitglieder/auswahl', lesen, async (req) => {
    const q = z.object({ ohne: z.string().nullish() }).parse(req.query);
    const { arten, turnusse } = await vertragsarten(DB);
    const sb = bankSchutz(req);
    return {
      zahler: (await zahlerAuswahl(DB, q.ohne ?? undefined)).map((z) => ({ ...z, iban: sb.iban(z.iban) })), vtZahler: await vertragsZahler(DB), arten, turnusse,
      zahlungsarten: ZAHLUNGSARTEN, zahlungsweisen: ZAHLUNGSWEISEN, unterlagen: ART_TEXT, paperless: plAktiv(await vereinLesen()),
    };
  });

  app.get('/mitglieder/vertragsbeginn', lesen, async (req) => {
    const q = z.object({ eintritt: datum, art: z.string().min(1) }).parse(req.query);
    const beginn = vertragsbeginn(q.eintritt, q.art);
    return { beginn, betrag: beginn ? await betragAm(DB, q.art, beginn) : null };
  });

  // ---------------------------------------------------------------- Objektseite
  app.get('/mitglieder/m/:adrnr', lesen, async (req) => detailSchuetzen(await detailLesen(DB, pAdr.parse(req.params).adrnr), bankSchutz(req)));

  app.put('/mitglieder/m/:adrnr/kopf', schreiben, async (req) => {
    const { adrnr: a } = pAdr.parse(req.params);
    await change(req, (tx) => kopfSichern(tx, a, kopfSchema.parse(req.body)));
    return { text: 'Stammdaten gesichert.' };
  });

  // Bankverbindung ändern: Mitglieder pflegen UND Bankdaten ändern (setzt den Klartext voraus)
  app.put('/mitglieder/m/:adrnr/bank', schreiben, async (req, reply) => {
    if (!can(req, P_BANK.edit)) return reply.code(403).send({ message: `Keine Berechtigung (${P_BANK.edit}).` });
    const { adrnr: a } = pAdr.parse(req.params);
    const b = z.object({ zahlungsart: z.string(), zahlungsweise: txt, iban: txt, bic: txt, bank: txt, abwkontoinh: txt, adrnrkih: txt }).parse(req.body);
    if ([b.iban, b.bic, b.abwkontoinh].some(istMaskiert)) throw new BusinessError('Maskierte Bankdaten können nicht gespeichert werden – bitte die vollständigen Werte eingeben.');
    await change(req, (tx) => bankSichern(tx, a, b));
    return { text: 'Bankverbindung gesichert.' };
  });

  app.post('/mitglieder/m/:adrnr/austritt', schreiben, async (req) => {
    const { adrnr: a } = pAdr.parse(req.params);
    const b = z.object({ austritt: datumOpt }).parse(req.body);
    return { text: await change(req, async (tx) => {
      const t = await austrittSichern(tx, a, b.austritt);
      // Austritt in der Vergangenheit: Benutzer sofort sperren (sonst übernimmt das der tägliche Lauf nach dem Austrittsdatum)
      const s = await ausgetreteneSperren(tx, a);
      return t + (s.gesperrt.length ? ` Benutzer ${s.gesperrt.join(', ')} gesperrt.` : '') + (s.rolleEntzogen.length ? ` Rolle Mitglied entzogen (${s.rolleEntzogen.join(', ')}).` : '');
    }, { action: 'AUSTRITT' }) };
  });

  // ---------------------------------------------------------------- Geführte Vorgänge (#154)
  const vorgangSchema = z.discriminatedUnion('typ', [
    z.object({
      typ: z.literal('BEITRAGSWECHSEL'), adrnr, vertragnr: z.string().min(1, 'Bitte den bisherigen Vertrag wählen'), art: z.string().trim().min(1, 'Bitte die neue Beitragsart wählen'),
      ab: datum, turnus: z.string().nullish(), betrag: z.number().min(0).nullish(), notiz: z.string().max(500).nullish(), unterlage: z.boolean().default(false),
    }),
    z.object({
      typ: z.literal('JUGENDTRAINING'), adrnr, art: z.string().nullish(), beginn: datum, turnus: z.string().nullish(), betrag: z.number().min(0).nullish(),
      zahler: z.string().nullish(), notiz: z.string().max(500).nullish(), unterlage: z.boolean().default(false),
    }),
    z.object({
      typ: z.literal('KUENDIGUNG'), adrnr, umfang: z.enum(['MITGLIEDSCHAFT', 'VERTRAG']), vertragnr: z.string().nullish(), eingang: datum, ende: datum,
      grund: z.string().max(500).nullish(), unterlage: z.boolean().default(false),
    }),
  ]);
  app.get('/mitglieder/m/:adrnr/vorgang', schreiben, async (req) => vorgangKontext(DB, pAdr.parse(req.params).adrnr, await vereinLesen()));
  /** prüfen: dieselbe Logik ohne Schreiben – geplante Änderungen und Hinweise */
  app.post('/mitglieder/vorgang/pruefen', schreiben, async (req) => vorgang(DB, vorgangSchema.parse(req.body) as Vorgang, false, benutzer(req)));
  app.post('/mitglieder/vorgang', schreiben, async (req) => {
    const g = vorgangSchema.parse(req.body) as Vorgang;
    const p = await change(req, async (tx) => {
      const r = await vorgang(tx, g, true, benutzer(req));
      // Austritt in der Vergangenheit: Benutzer sofort sperren (sonst übernimmt das der tägliche Lauf)
      if (g.typ === 'KUENDIGUNG' && g.umfang === 'MITGLIEDSCHAFT') {
        const s = await ausgetreteneSperren(tx, g.adrnr);
        if (s.gesperrt.length) r.schritte.push(`Benutzer ${s.gesperrt.join(', ')} gesperrt`);
      }
      return r;
    }, { action: g.typ, reason: VORGANG_TEXT[g.typ] });
    const unterlage = g.unterlage ? await unterlageVersenden(DB, await vereinLesen(), g.adrnr, p.unterlage, p.text, benutzer(req)) : null;
    return { ...p, text: `${VORGANG_TEXT[g.typ]} ausgeführt: ${p.text}`, unterlage };
  });

  app.post('/mitglieder/m/:adrnr/trainer', schreiben, async (req) => {
    const { adrnr: a } = pAdr.parse(req.params);
    const b = z.object({ trainer: z.boolean() }).parse(req.body);
    await change(req, (tx) => trainerSetzen(tx, a, b.trainer));
    return { text: b.trainer ? 'Als Trainer gekennzeichnet.' : 'Trainer-Kennzeichen entfernt.' };
  });

  /** Mitgliedergruppen: Mitglied einer Gruppe zuordnen (mit Rolle, z. B. Mannschaftsführer) oder daraus entfernen */
  app.post('/mitglieder/m/:adrnr/gruppen', schreiben, async (req) => {
    const { adrnr: a } = pAdr.parse(req.params);
    const b = z.object({ gruppe: z.coerce.number().int().positive(), rolle: z.string().max(60).nullish(), entfernen: z.boolean().default(false) }).parse(req.body);
    if (b.entfernen) {
      await change(req, (tx) => gruppenMitgliedEntfernen(tx, b.gruppe, a), { action: 'GRUPPE' });
      return { text: 'Aus der Gruppe entfernt.' };
    }
    const oben = await change(req, (tx) => gruppenMitgliedSetzen(tx, b.gruppe, a, b.rolle ?? null), { action: 'GRUPPE' });
    return { text: `Gruppenzuordnung gesichert.${oben ? ' Die Zuordnung zur übergeordneten Gruppe entfällt – das Mitglied gehört über die Untergruppe dazu.' : ''}` };
  });

  app.post('/mitglieder/m/:adrnr/kanal', schreiben, async (req) => {
    const { adrnr: a } = pAdr.parse(req.params);
    const b = z.object({ kanal: z.enum(['E', 'W', '']) }).parse(req.body);
    await change(req, (tx) => kanalSetzen(tx, a, b.kanal, benutzer(req)));
    return { text: b.kanal === 'E' ? 'Versandweg E-Mail gesichert.' : b.kanal === 'W' ? 'Versandweg WhatsApp gesichert.' : 'Versandweg zurückgesetzt.' };
  });

  app.post('/mitglieder/m/:adrnr/schluessel', schreiben, async (req): Promise<never> => {
    const { adrnr: a } = pAdr.parse(req.params);
    // Die Schlüsseldaten im Mitgliederstamm sind reine Anzeige: Ausgabe und Rückgabe pflegt nur die App „Hallenschlüssel“ (#215)
    throw new BusinessError(`Die Schlüsseldaten von ${a} lassen sich im Mitgliederstamm nicht ändern – bitte die App „Hallenschlüssel“ verwenden.`);
  });

  app.post('/mitglieder/m/:adrnr/notizen', schreiben, async (req) => {
    const { adrnr: a } = pAdr.parse(req.params);
    const b = z.object({ text: z.string().max(4000) }).parse(req.body);
    await change(req, (tx) => notizAnlegen(tx, a, b.text, benutzer(req)));
    return { text: 'Notiz angelegt.' };
  });

  app.post('/mitglieder/m/:adrnr/notizen/loeschen', schreiben, async (req) => {
    const { adrnr: a } = pAdr.parse(req.params);
    const b = z.object({ id: z.string().min(1) }).parse(req.body);
    await change(req, (tx) => notizLoeschen(tx, a, b.id));
    return { text: 'Notiz gelöscht.' };
  });

  // ---------------------------------------------------------------- IBAN prüfen, Bankleitzahlen-Verzeichnis, neues SEPA-Mandat
  /** IBAN verproben und BIC/Kreditinstitut ermitteln – auf Knopfdruck, speichert nichts */
  app.post('/mitglieder/bank/pruefen', schreiben, async (req) => {
    const b = z.object({ iban: z.string().max(60) }).parse(req.body);
    if (istMaskiert(b.iban)) throw new BusinessError('Eine maskierte IBAN kann nicht geprüft werden – bitte die vollständige IBAN eingeben.');
    return ibanPruefen(DB, b.iban);
  });
  app.get('/mitglieder/bank/blz', lesen, async () => blzStand(DB));
  /** Bankleitzahlendatei der Bundesbank laden (ersetzt das Verzeichnis) */
  app.post('/mitglieder/bank/blz', { ...schreiben, bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    if (!can(req, P_BANK.edit)) return reply.code(403).send({ message: `Keine Berechtigung (${P_BANK.edit}).` });
    const b = z.object({ datei: z.string().min(1, 'Bitte die Bankleitzahlendatei auswählen.').max(11_000_000) }).parse(req.body);
    const eintraege = blzDateiLesen(Buffer.from(b.datei, 'base64'));
    return { text: await change(req, (tx) => blzImport(tx, eintraege), { action: 'BLZ_IMPORT' }), ...(await blzStand(DB)) };
  });
  /** neues SEPA-Mandat für den Zahler des Mitglieds */
  app.post('/mitglieder/m/:adrnr/sepa', schreiben, async (req, reply) => {
    if (!can(req, P_BANK.edit)) return reply.code(403).send({ message: `Keine Berechtigung (${P_BANK.edit}).` });
    const { adrnr: a } = pAdr.parse(req.params);
    const b = z.object({ datum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish() }).parse(req.body ?? {});
    return change(req, (tx) => sepaNeu(tx, a, b.datum ?? null), { action: 'SEPA_NEU' });
  });

  app.post('/mitglieder/sepa/:adrnr/manuell', schreiben, async (req) => {
    const { adrnr: a } = pAdr.parse(req.params);
    const b = z.object({ aktiv: z.boolean() }).parse(req.body);
    return { text: await change(req, (tx) => sepaManuell(tx, a, b.aktiv), { action: b.aktiv ? 'SEPA_MANUELL' : 'SEPA_MANUELL_AUS' }) };
  });

  // ---------------------------------------------------------------- Verträge
  app.post('/mitglieder/m/:adrnr/vertraege', schreiben, async (req) => {
    const { adrnr: a } = pAdr.parse(req.params);
    const b = z.object({ art: z.string().min(1, 'Bitte eine Vertragsart wählen.'), beginn: datum, ende: datumOpt, turnus: txt, betrag: z.coerce.number(), zahler: z.string().nullish() }).parse(req.body);
    const vnr = await change(req, (tx) => vertragNeu(tx, { adrnr: a, ...b }));
    return { text: `Vertrag ${vnr} angelegt.` };
  });

  app.put('/mitglieder/vertraege/:adrnr/:vertragnr', schreiben, async (req) => {
    const p = z.object({ adrnr, vertragnr: z.string().min(1) }).parse(req.params);
    const b = z.object({ beginn: datum.optional(), ende: datumOpt.optional(), zahler: z.string().nullish() }).parse(req.body);
    return { text: await change(req, (tx) => vertragAendern(tx, p.adrnr, p.vertragnr, {
      beginn: b.beginn, ende: 'ende' in (req.body as object) ? b.ende : undefined, zahler: b.zahler === undefined ? undefined : b.zahler,
    })) };
  });

  // ---------------------------------------------------------------- Dokumente (Paperless)
  app.get('/mitglieder/m/:adrnr/dokumente', lesen, async (req) => {
    const m = await mitgliedLesen(DB, pAdr.parse(req.params).adrnr);
    const v = await vereinLesen();
    if (!plAktiv(v)) return { paperless: false, korrespondent: null, dokumente: [], soll: korrName(m) };
    const r = await dokumenteLesen(v, m);
    const klar = bankSchutz(req).klar;
    return { paperless: true, soll: korrName(m), ...r, dokumente: r.dokumente.map((x) => ({ ...x, gesperrt: !klar && doktypMitBankdaten(x.typ) })) };
  });

  app.get('/mitglieder/doktypen', lesen, async () => {
    const pl = plPruefen(await vereinLesen());
    return (await pl.dokumenttypen()).map((t) => ({ id: t.id, name: t.name })).sort((a, b) => a.name.localeCompare(b.name));
  });

  app.get('/mitglieder/dokument/:id/datei', lesen, async (req, reply) => {
    const { id } = z.object({ id: docId }).parse(req.params);
    const v = await vereinLesen();
    const pl = plPruefen(v);
    await dokFreigeben(req, v, id);
    const d = await pl.download(id);
    return reply.type(d.contentType).header('content-disposition', `inline; filename="${encodeURIComponent(d.filename)}"`).send(d.data);
  });

  app.get('/mitglieder/dokument/:id/notizen', lesen, async (req) => {
    const { id } = z.object({ id: docId }).parse(req.params);
    const v = await vereinLesen();
    const pl = plPruefen(v);
    await dokFreigeben(req, v, id);
    return (await pl.notizen(id)).map((n) => ({
      id: n.id, text: n.note, erstellt: n.created, von: typeof n.user === 'object' && n.user ? n.user.username ?? '' : '',
    }));
  });

  app.post('/mitglieder/dokument/:id/notizen', schreiben, async (req) => {
    const { id } = z.object({ id: docId }).parse(req.params);
    const b = z.object({ text: z.string().min(1, 'Bitte einen Text eingeben.').max(4000) }).parse(req.body);
    const v = await vereinLesen();
    await dokFreigeben(req, v, id);
    await plPruefen(v).notizAnlegen(id, `${b.text.trim()} (${benutzer(req)}, Vereinsportal)`);
    return { text: 'Notiz an das Dokument angehängt.' };
  });

  app.post('/mitglieder/dokumente/links', lesen, async (req) => {
    const b = z.object({ ids: z.array(docId).min(1, 'Bitte mindestens ein Dokument markieren.').max(20) }).parse(req.body);
    const v = await vereinLesen();
    for (const id of b.ids) await dokFreigeben(req, v, id);
    return freigabelinks(v, b.ids);
  });

  app.post('/mitglieder/m/:adrnr/dokumente', { ...schreiben, bodyLimit: 30 * 1024 * 1024 }, async (req) => {
    const m = await mitgliedLesen(DB, pAdr.parse(req.params).adrnr);
    const b = z.object({
      datei: z.string().min(1), inhalt: z.string().min(1, 'Die Datei ist leer.'), titel: txt, doktyp: z.coerce.number().int().nullish(), notiz: txt,
    }).parse(req.body);
    const mime = /^data:([^;,]+)/.exec(b.inhalt)?.[1] ?? 'application/octet-stream';
    const datei = b.datei.split(/[\\/]/).pop()!;
    return { text: await dateiAblegen(await vereinLesen(), m, { datei, mime, inhalt: binaer(b.inhalt), titel: b.titel, doktyp: b.doktyp ?? null, notiz: b.notiz }, benutzer(req)) };
  });

  // ---------------------------------------------------------------- Unterlagen / Kommunikation
  app.get('/mitglieder/m/:adrnr/unterlage/:art', lesen, async (req, reply) => {
    const p = z.object({ adrnr, art }).parse(req.params);
    const d = druckSchuetzen(await druckdatenLesen(DB, p.adrnr), bankSchutz(req));
    const pdf = await unterlagePdf(await vereinLesen(), p.art, d);
    const name = `${ART_TEXT[p.art]}_${leer(d.m.nachname)}_${leer(d.m.vorname)}.pdf`;
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${encodeURIComponent(name)}"`).send(pdf);
  });

  app.post('/mitglieder/m/:adrnr/unterlage/:art/ablegen', schreiben, async (req) => {
    const p = z.object({ adrnr, art }).parse(req.params);
    const v = await vereinLesen();
    const d = await druckdatenLesen(DB, p.adrnr);
    return unterlageAblegen(v, p.art, d.m, await unterlagePdf(v, p.art, d), benutzer(req));
  });

  const kommSchema = z.object({ art: art.or(z.literal('')).default(''), ids: z.array(docId).max(20).default([]) });

  /** Vorschlag für E-Mail und WhatsApp mit Freigabelinks der markierten Dokumente */
  app.post('/mitglieder/m/:adrnr/komm', lesen, async (req) => {
    const { adrnr: a } = pAdr.parse(req.params);
    const b = kommSchema.parse(req.body);
    const v = await vereinLesen();
    const k = await kontaktLesen(DB, a);
    if (!k) throw new BusinessError('Mitglied nicht gefunden.');
    for (const id of b.ids) await dokFreigeben(req, v, id);
    const links = b.ids.length ? await freigabelinks(v, b.ids) : [];
    const { betreff, text } = mailText(v, b.art, k.vorname, links);
    const [p] = await DB`select kanal from tco.kommpref where adrnr = ${a}`;
    return {
      an: k.email, mobil: k.mobil, kanal: leer(p?.kanal) || (k.email ? 'E' : k.mobil ? 'W' : ''), betreff, text, links,
      mailto: k.email ? `mailto:${k.email}?subject=${encodeURIComponent(betreff)}&body=${encodeURIComponent(text)}` : '',
      whatsapp: k.mobil ? whatsappLink(k.mobil, text) : '', n8n: !!v.n8n_mail_url,
    };
  });

  app.post('/mitglieder/m/:adrnr/mail', schreiben, async (req) => {
    const { adrnr: a } = pAdr.parse(req.params);
    const b = z.object({ an: z.string().min(3, 'Keine E-Mail-Adresse.'), betreff: z.string().min(1), text: z.string().min(1), modus: z.enum(['senden', 'entwurf']).default('senden') }).parse(req.body);
    const v = await vereinLesen();
    const r = await mailSenden(v, { modus: b.modus, anwendung: 'MITGLIEDER', objekt: a, an: b.an, betreff: b.betreff, text: b.text, benutzer: benutzer(req), anhaenge: [] });
    if (r.status === 'fehler') throw new BusinessError(r.fehler ?? 'Der Versand ist fehlgeschlagen.');
    return { text: r.status === 'entwurf' ? 'E-Mail als Entwurf abgelegt.' : `E-Mail an ${b.an} gesendet.` };
  });

  // ---------------------------------------------------------------- Neuanlage
  app.get('/mitglieder/neu/zahler/:adrnr', lesen, async (req) => {
    const r = await zahlerVorschlag(DB, pAdr.parse(req.params).adrnr);
    const sb = bankSchutz(req);
    return { ...r, iban: sb.iban(r.iban), bic: sb.bic(r.bic) };
  });

  /** Aufnahmeantrag aus Paperless (Dok-Nr.) oder als PDF (wird zuerst nach Paperless übertragen) lesen */
  app.post('/mitglieder/neu/antrag', { ...schreiben, bodyLimit: 30 * 1024 * 1024 }, async (req) => {
    const b = z.object({ docid: z.coerce.number().int().positive().nullish(), datei: z.string().nullish(), inhalt: z.string().nullish() }).parse(req.body);
    const pl = plPruefen(await vereinLesen());
    let id = b.docid ?? null;
    if (!id) {
      if (!b.inhalt) throw new BusinessError('Bitte eine Dok-Nr. angeben oder ein PDF ablegen.');
      const datei = (b.datei ?? 'Aufnahmeantrag.pdf').split(/[\\/]/).pop()!;
      // Felder laut zentraler Paperless-Zuordnung (Kontext „Aufnahmeantrag“)
      try {
        id = (await kontextAblegen(pl, K.mitgliedAntrag, 'tco', { datei, heute: heute(), benutzer: benutzer(req) }, binaer(b.inhalt), datei, { warteSekunden: 60 })).id;
      } catch (e) {
        throw new BusinessError(`Paperless hat den Antrag nicht übernommen (${(e as Error).message}). Ggf. ist er schon vorhanden – dann über die Dok-Nr. laden.`);
      }
      if (!id) throw new BusinessError('Paperless verarbeitet den Antrag noch – bitte gleich über die Dok-Nr. laden.');
    }
    const d = await pl.dokument(id).catch(() => null);
    if (!d || !leer(d.content)) throw new BusinessError(`Paperless-Dokument ${id} nicht gefunden oder ohne lesbaren Text.`);
    const { antrag, vart, hinweise } = parse(String(d.content), await mapLesen(DB));
    const zahler = await zahlerErmitteln(DB, antrag);
    if (zahler.hinweis) hinweise.push(zahler.hinweis);
    // Gibt es das Mitglied schon? → Anlegen gesperrt
    const norm = normName(`${antrag.vorname} ${antrag.nachname}`);
    const vorh = (await DB`select adrnr, vorname, nachname, geburtsdatum from tco.mitglieder where eintritt is not null`)
      .find((x) => normName(`${x.vorname ?? ''} ${x.nachname ?? ''}`) === norm && !(antrag.geburtsdatum && x.geburtsdatum && x.geburtsdatum !== antrag.geburtsdatum));
    if (vorh) hinweise.unshift(`Mitglied existiert bereits: ${condense(`${vorh.vorname ?? ''} ${vorh.nachname ?? ''}`)} (Adressnr. ${Number(vorh.adrnr)}) – Anlegen gesperrt.`);
    if (!vart.length) hinweise.push('Mitgliedschaft nicht eindeutig erkannt – bitte Vertrag in der Tabelle auswählen.');
    const eintritt = String(d.created_date ?? d.created ?? '').slice(0, 10) || heute();
    const sb = bankSchutz(req);
    return {
      docid: id, titel: d.title ?? '', vart: vart.map((x) => x.art), zahler, existiert: !!vorh, hinweise,
      antrag: { ...antrag, iban: sb.iban(antrag.iban), bic: sb.bic(antrag.bic), kontoinhaber: sb.text(antrag.kontoinhaber) },
      eintritt, sepa_datum: antrag.antragsdatum ?? eintritt,
    };
  });

  app.post('/mitglieder/neu', schreiben, async (req) => {
    const n = neuSchema.parse(req.body);
    await maskierteBankdatenAufloesen(n);
    const r = await change(req, (tx) => mitgliedNeu(tx, n), { action: 'MITGLIED_NEU' });
    const warnungen: string[] = [];
    if (n.antrag_docid) {
      const v = await vereinLesen();
      if (plAktiv(v)) {
        warnungen.push(...await plPruefen(v).metadatenSetzen(n.antrag_docid, {
          correspondent: condense(`${condense(n.nachname)} ${condense(n.vorname)}`), documentType: 'Aufnahmeantrag', storagePath: SPEICHERPFAD,
        }).catch((e) => [`Paperless: ${(e as Error).message}`]));
      }
    }
    return {
      ...r, warnungen,
      text: `Mitglied Nr. ${r.mitglnrn} angelegt${r.mandat ? (r.mandatNeu ? `, SEPA-Mandat ${r.mandat} erstellt` : `, bestehendes SEPA-Mandat ${r.mandat} des Zahlers verwendet`) : ''}.`,
    };
  });
}
