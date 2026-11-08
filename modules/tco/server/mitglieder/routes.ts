import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { DB, plAktiv, vereinLesen } from '../verein.js';
import { mitgliedDokumentPruefen } from '../dokumentfreigabe.js';
import { condense, heute } from '../format.js';
import { kontaktLesen, mailSenden, whatsappLink } from '../kommunikation.js';
import {
  austrittSichern, bankSichern, betragAm, DATUM_TYP, detailLesen, kanalSetzen, kopfSichern, leer, listeLesen, mitgliedLesen, mitgliedNeu,
  normName, notizAnlegen, notizLoeschen, schluesselSetzen, sepaManuell, STATUS, trainerSetzen, vertragAendern, vertragNeu, vertragsarten,
  vertragsbeginn, vertragsZahler, zahlerAuswahl, zahlerVorschlag, ZAHLUNGSARTEN, ZAHLUNGSWEISEN,
} from './logik.js';
import { ART_TEXT, ARTEN, druckdatenLesen, unterlagePdf } from './pdf.js';
import { dateiAblegen, dokumenteLesen, freigabelinks, korrName, mailText, plPruefen, SPEICHERPFAD, unterlageAblegen } from './dokumente.js';
import { mapLesen, parse, zahlerErmitteln } from './antrag.js';
import { istMaskiert, maskText, type Feldschutz } from '../../../../server/src/schutz.js';
import { bankdatenErforderlich, bankSchutz, doktypMitBankdaten, P_BANK } from '../bankdaten.js';
import type { Verein } from '../verein.js';
import { kontextAblegen } from '../../../../server/src/lib/paperless-mapping.js';
import { K } from '../paperless-kontexte.js';
import { bankAendern, kontaktSichern, kuendigen, kuendigungBestaetigen, meineLesen, mitgliederBenutzerAnlegen, P_SELBST } from './selbst.js';

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

export async function mitgliederRoutes(app: FastifyInstance) {
  const lesen = { preHandler: requireAuth(P_MG.display) };
  const schreiben = { preHandler: requireAuth(P_MG.edit) };
  const selbst = { preHandler: requireAuth(P_SELBST) };
  const benutzerId = (req: FastifyRequest) => {
    if (!req.user?.id) throw new BusinessError('Bitte mit einem persönlichen Benutzer anmelden.', 403);
    return req.user.id;
  };

  // ---------------------------------------------------------------- „Meine Mitgliedschaft“ (nur eigene Daten)
  app.get('/mitglieder/meine', selbst, async (req) => meineLesen(DB, benutzerId(req)));
  app.put('/mitglieder/meine/kontakt', selbst, async (req) => {
    const k = z.object({ strasse: txt, plz: txt, ort: txt, telefon: txt, mobil: txt, email: txt, bildrechte: z.boolean().default(false) }).parse(req.body);
    return { text: await change(req, (tx) => kontaktSichern(tx, benutzerId(req), k), { action: 'SELBSTAUSKUNFT' }) };
  });
  app.put('/mitglieder/meine/bank', selbst, async (req) => {
    const b = z.object({ iban: z.string().min(1, 'Bitte die IBAN angeben.'), bic: txt, bank: txt }).parse(req.body);
    if (istMaskiert(b.iban)) throw new BusinessError('Bitte die vollständige neue IBAN eingeben.');
    return { text: await change(req, (tx) => bankAendern(tx, benutzerId(req), b), { action: 'SELBSTAUSKUNFT', reason: 'Bankverbindung' }) };
  });
  app.post('/mitglieder/meine/kuendigung', selbst, async (req) => {
    const k = z.object({
      art: z.enum(['MITGLIEDSCHAFT', 'VERTRAG']), adrnr: z.string().nullish(), vertragnr: z.string().nullish(), grund: z.string().max(500).nullish(),
      bestaetigung: z.literal(true, { errorMap: () => ({ message: 'Bitte die Kündigung bestätigen.' }) }),
    }).parse(req.body);
    const v = await vereinLesen();
    const r = await change(req, (tx) => kuendigen(tx, benutzerId(req), k, v, benutzer(req)), { action: 'KUENDIGUNG', reason: k.grund ?? null });
    const b = await kuendigungBestaetigen(DB, v, r, k.grund ?? null);
    return { ...b, text: `${r.text}${b.gesendet ? ' Die Kündigungsbestätigung wurde per E-Mail gesendet.' : ''}` };
  });

  // ---------------------------------------------------------------- Administration → Benutzer: Mitglieder als Benutzer anlegen
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

  // ---------------------------------------------------------------- Liste / Stammdaten der Auswahl
  app.get('/mitglieder/liste', lesen, async (req) => {
    const q = z.object({
      status: z.enum(STATUS).default('AKTIV'), datumTyp: z.enum(DATUM_TYP).default('EINGETRETEN'),
      von: datumOpt, bis: datumOpt, suche: z.string().nullish(),
    }).parse(req.query);
    return listeLesen(DB, q);
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
    return { text: await change(req, (tx) => austrittSichern(tx, a, b.austritt), { action: 'AUSTRITT' }) };
  });

  app.post('/mitglieder/m/:adrnr/trainer', schreiben, async (req) => {
    const { adrnr: a } = pAdr.parse(req.params);
    const b = z.object({ trainer: z.boolean() }).parse(req.body);
    await change(req, (tx) => trainerSetzen(tx, a, b.trainer));
    return { text: b.trainer ? 'Als Trainer gekennzeichnet.' : 'Trainer-Kennzeichen entfernt.' };
  });

  app.post('/mitglieder/m/:adrnr/kanal', schreiben, async (req) => {
    const { adrnr: a } = pAdr.parse(req.params);
    const b = z.object({ kanal: z.enum(['E', 'W', '']) }).parse(req.body);
    await change(req, (tx) => kanalSetzen(tx, a, b.kanal, benutzer(req)));
    return { text: b.kanal === 'E' ? 'Versandweg E-Mail gesichert.' : b.kanal === 'W' ? 'Versandweg WhatsApp gesichert.' : 'Versandweg zurückgesetzt.' };
  });

  app.post('/mitglieder/m/:adrnr/schluessel', schreiben, async (req) => {
    const { adrnr: a } = pAdr.parse(req.params);
    const b = z.object({ ausgabe: datumOpt, ausgabebeleg: txt, ruecknahme: datumOpt, ruecknahmebeleg: txt }).parse(req.body);
    await change(req, (tx) => schluesselSetzen(tx, a, b));
    return { text: 'Schlüssel gesichert.' };
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
    const b = z.object({ ende: datumOpt.optional(), zahler: z.string().nullish() }).parse(req.body);
    return { text: await change(req, (tx) => vertragAendern(tx, p.adrnr, p.vertragnr, { ende: 'ende' in (req.body as object) ? b.ende : undefined, zahler: b.zahler === undefined ? undefined : b.zahler })) };
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
