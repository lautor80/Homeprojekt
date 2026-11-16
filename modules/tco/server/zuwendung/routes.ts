import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { kontextAblegen } from '../../../../server/src/lib/paperless-mapping.js';
import { DB, paperless, plAktiv, vereinLesen, type Db } from '../verein.js';
import { dat, heute } from '../format.js';
import { mailSenden } from '../kommunikation.js';
import { mailtextFuellen } from '../mailtexte.js';
import { K } from '../paperless-kontexte.js';
import {
  ausstellen, bestaetigungenLesen, cfgAuswahl, cfgLesen, cfgSichern, dokumentBauen, jahreslauf, kopfLesen, merkmalSichern, P_ZUW, pdfLesen, rueckbuchungKlaeren,
  spenderSichern, sperren, stornieren, vorschlag, bescheidPruefen, cfgFehlt, type KopfZeile,
} from './logik.js';
import { zuwendungPdf, zuwendungTitel } from './pdf.js';
import { texteMischen } from './texte.js';

/**
 * App „Zuwendungsbestätigungen“ (Finanzen): Vorschlagsliste der Spenden je Jahr und Spender, Vorschau, Ausstellen von
 * Einzel- und Sammelbestätigungen (auch als Jahreslauf), Ablage des Doppels in Paperless, Versand per E-Mail oder Druck,
 * Storno. Einstellungen im Kapitel Administration → Einstellungen → TC Oberthal → Zuwendungsbestätigungen.
 */

const benutzer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';
const jahrQ = z.coerce.number().int().min(2000).max(2100);
const nrP = z.object({ nr: z.string().regex(/^ZB-\d{4}-\d{4,}$/, 'Ungültige Nummer') });
const keyZ = z.string().regex(/^[^|]+\|[^|]+\|\d+$/, 'Ungültige Buchungsangabe');
const spenderZ = z.string().regex(/^[MX]:.+$/, 'Ungültiger Spender');
const AUFTRAG = z.object({ art: z.enum(['EINZEL', 'SAMMEL']), jahr: jahrQ, spender: spenderZ, quellen: z.array(keyZ).max(500).nullish() });
const dateiname = (titel: string) => `${titel.replace(/[^\wäöüÄÖÜß .()-]/g, '_')}.pdf`;
const artText = (art: string) => (art === 'SAMMEL' ? 'Sammelbestätigung' : 'Einzelbestätigung');

/** Doppel in Paperless ablegen und an der Bestätigung vermerken; ein Fehler von Paperless lässt die Bestätigung bestehen */
async function ablegen(req: FastifyRequest, k: KopfZeile): Promise<{ abgelegt: boolean; text: string; warnungen: string[] }> {
  const wer = benutzer(req);
  if (k.paperless_id) return { abgelegt: true, text: `Bereits in Paperless abgelegt (DOKID ${String(k.paperless_id).padStart(6, '0')}).`, warnungen: [] };
  const v = await vereinLesen();
  if (!plAktiv(v)) return { abgelegt: false, text: 'Paperless ist nicht eingerichtet – das Doppel wurde nicht abgelegt (es bleibt im Portal gespeichert).', warnungen: [] };
  try {
    const pdf = await pdfLesen(DB, k.zbnr);
    const [nach] = k.adrnr ? await DB`select coalesce(nachname, '') as nachname, coalesce(vorname, '') as vorname from tco.mitglieder where adrnr = any(${[k.adrnr, String(Number(k.adrnr) || '')]}) limit 1` : [];
    const werte = {
      nummer: k.zbnr, spender: nach ? `${nach.nachname} ${nach.vorname}`.trim() : k.spender_name, name: k.spender_name, art: artText(k.art), jahr: k.jahr,
      betrag: k.betrag, datum: k.ausgestellt_am, verein: v.name, heute: heute(), benutzer: wer,
    };
    const r = await kontextAblegen(paperless(v), K.zuwendung, 'tco', werte, pdf, dateiname(zuwendungTitel({ nummer: k.zbnr, art: k.art, jahr: k.jahr })), { benutzer: wer });
    if (!r.id) return { abgelegt: false, text: 'Hochgeladen, die DOKID ist aber noch nicht verfügbar – bitte später erneut ablegen.', warnungen: r.warnungen };
    await change(req, (tx) => tx`update tco.zuw_kopf set paperless_id = ${r.id}, paperless_am = now() where zbnr = ${k.zbnr}`, { action: 'ZUWENDUNG_ABLAGE' });
    return { abgelegt: true, text: `${k.zbnr} in Paperless abgelegt (DOKID ${String(r.id).padStart(6, '0')}).`, warnungen: r.warnungen };
  } catch (e) {
    return { abgelegt: false, text: `Ablage in Paperless fehlgeschlagen: ${(e as Error).message}`, warnungen: [] };
  }
}

/** aktuelle E-Mail-Adresse des Spenders (Mitgliederstamm bzw. Spender ohne Mitgliedschaft) */
async function empfaenger(db: Db, k: KopfZeile): Promise<string> {
  if (k.spender_id != null) {
    const [s] = await db`select email from tco.zuw_spender where spender_id = ${k.spender_id}`;
    return String(s?.email ?? '').trim();
  }
  const [m] = k.adrnr ? await db`select email from tco.mitglieder where adrnr = any(${[k.adrnr, String(Number(k.adrnr) || '')]}) limit 1` : [];
  return String(m?.email ?? '').trim();
}

/**
 * Bestätigung per E-Mail senden. Als versendet gilt ausschließlich das Ergebnis „gesendet“ des zentralen Versands –
 * jede andere Antwort (abgelehnte bzw. als unzustellbar vermerkte Adresse, Entwurf, Fehler) und jede Ausnahme heißt
 * „nicht versendet – bitte drucken“ und wird an der Bestätigung vermerkt.
 */
async function senden(req: FastifyRequest, k: KopfZeile): Promise<{ versendet: boolean; an: string; text: string }> {
  const wer = benutzer(req);
  const nicht = async (an: string, grund: string) => {
    const hinweis = `${grund} – bitte drucken`.slice(0, 500);
    await change(req, (tx) => tx`update tco.zuw_kopf set versand_status = 'NICHT_VERSENDET', versand_am = now(), versand_an = ${an || null}, versand_hinweis = ${hinweis} where zbnr = ${k.zbnr}`, { action: 'ZUWENDUNG_VERSAND' });
    return { versendet: false, an, text: `${k.zbnr} (${k.spender_name}): nicht versendet – bitte drucken. ${grund}` };
  };
  const an = await empfaenger(DB, k);
  if (!an) return nicht('', 'Keine E-Mail-Adresse hinterlegt');
  const v = await vereinLesen();
  let status: string;
  let grund = '';
  try {
    const t = await mailtextFuellen(DB, v, 'zuwendung.bestaetigung', {
      Name: k.spender_name, Nummer: k.zbnr, Jahr: String(k.jahr), Art: artText(k.art), Betrag: `${k.betrag.toFixed(2).replace('.', ',')} €`, Datum: dat(k.ausgestellt_am),
    });
    const r = await mailSenden(v, {
      modus: 'senden', anwendung: 'Zuwendungsbestätigung', objekt: k.zbnr, an, betreff: t.betreff, text: t.text, benutzer: wer,
      anhaenge: [{ dateiname: dateiname(zuwendungTitel({ nummer: k.zbnr, art: k.art, jahr: k.jahr })), inhalt: await pdfLesen(DB, k.zbnr), mime: 'application/pdf', objekt: k.zbnr }],
      folge: { art: 'ZUWENDUNG', zbnr: k.zbnr, an },
    });
    status = String(r.status);
    grund = r.fehler || r.hinweis || '';
  } catch (e) {
    status = 'fehler';
    grund = (e as Error).message;
  }
  if (status !== 'gesendet') return nicht(an, grund || `Der Versand meldet „${status}“`);
  await change(req, (tx) => tx`update tco.zuw_kopf set versand_status = 'GESENDET', versand_am = now(), versand_an = ${an}, versand_hinweis = null where zbnr = ${k.zbnr}`, { action: 'ZUWENDUNG_VERSAND' });
  return { versendet: true, an, text: `${k.zbnr} an ${an} gesendet.` };
}

const EINSTELLUNGEN = z.object({
  bescheid_art: z.enum(['', 'FREISTELLUNG', 'FESTSTELLUNG']),
  finanzamt: z.string().max(100), steuernummer: z.string().max(40),
  bescheid_datum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT').nullish().or(z.literal('')).transform((x) => x || null),
  veranlagungszeitraum: z.string().max(40), zweck: z.string().max(200), zweck_satzung: z.string().max(200),
  unterzeichner: z.string().max(100), funktion: z.string().max(100), ort: z.string().max(80),
  unterschrift: z.string().max(450_000).nullish().transform((x) => x || null),
  spendenkonten: z.array(z.string().max(20)).max(50), spendenarten: z.array(z.string().max(20)).max(50),
  mail_erlaubt: z.boolean(), texte: z.record(z.string().max(2000)), muster_geprueft: z.boolean(),
});

export async function zuwendungRoutes(app: FastifyInstance) {
  const lesen = { preHandler: requireAuth(P_ZUW.display) };
  const ausfuehren = { preHandler: requireAuth(P_ZUW.execute) };
  const admin = { preHandler: requireAuth(P_ZUW.admin) };

  /** Vorschlagsliste: Spender mit offenen, gesperrten und bestätigten Spenden des Jahres, Buchungen ohne Spender, Rückbuchungen */
  app.get('/zuwendung/vorschlag', lesen, async (req) => {
    const { jahr } = z.object({ jahr: jahrQ }).parse(req.query);
    const v = await vereinLesen();
    return { ...(await vorschlag(DB, v, jahr)), paperless: plAktiv(v) };
  });

  /** Auswahl für die Zuordnung von Hand: Mitglieder und Spender ohne Mitgliedschaft */
  app.get('/zuwendung/personen', lesen, async () => {
    const mg = await DB`select adrnr, trim(coalesce(nachname, '') || ', ' || coalesce(vorname, '')) as name, coalesce(ort, '') as ort from tco.mitglieder
                         where coalesce(nachname, '') <> '' order by lower(nachname), lower(vorname)`;
    const ex = await DB`select spender_id, name, zusatz, strasse, plz, ort, email from tco.zuw_spender order by lower(name)`;
    return {
      mitglieder: mg.map((m) => ({ key: `M:${/^\d+$/.test(m.adrnr) ? String(m.adrnr).padStart(10, '0') : m.adrnr}`, name: m.name as string, ort: m.ort as string })),
      spender: ex.map((s) => ({ key: `X:${s.spender_id}`, ...s })),
    };
  });

  const SPENDER = z.object({
    name: z.string().trim().min(2, 'Bitte den Namen angeben').max(120), zusatz: z.string().trim().max(120).nullish(),
    strasse: z.string().trim().min(2, 'Bitte die Straße angeben').max(120), plz: z.string().trim().min(4, 'Bitte die PLZ angeben').max(10),
    ort: z.string().trim().min(2, 'Bitte den Ort angeben').max(80), email: z.string().trim().email('Ungültige E-Mail-Adresse').max(200).nullish().or(z.literal('')),
  });
  app.post('/zuwendung/spender', ausfuehren, async (req) => {
    const d = SPENDER.parse(req.body);
    const id = await change(req, (tx) => spenderSichern(tx, null, d, benutzer(req)));
    return { spender_id: id, key: `X:${id}` };
  });
  app.put('/zuwendung/spender/:id', ausfuehren, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const d = SPENDER.parse(req.body);
    await change(req, (tx) => spenderSichern(tx, id, d, benutzer(req)));
    return { ok: true };
  });

  /** Spender, Verzicht bzw. Ausschluss einer Spende von Hand festlegen */
  app.put('/zuwendung/quelle', ausfuehren, async (req) => {
    const d = z.object({
      key: keyZ, spender: spenderZ.nullable().optional(), verzicht: z.boolean().optional(),
      ausschluss: z.enum(['RUECKLAST', 'KEINE_SPENDE']).nullable().optional(), grund: z.string().max(300).nullish(),
    }).parse(req.body);
    await change(req, (tx) => merkmalSichern(tx, d, benutzer(req)), { action: 'ZUW_QUELLE' });
    return { ok: true };
  });

  /** Rückbuchung auf einem Spendenkonto klären (betrifft eine Spende → Rücklastschrift, oder keine Spende mit Grund) */
  app.post('/zuwendung/rueckbuchung', ausfuehren, async (req) => {
    const d = z.object({ key: keyZ, betrifft: keyZ.nullish(), grund: z.string().max(300).nullish() }).parse(req.body);
    await change(req, (tx) => rueckbuchungKlaeren(tx, d, benutzer(req)), { action: 'ZUW_QUELLE' });
    return { ok: true };
  });

  /** PDF-Vorschau einer Bestätigung aus dem aktuellen Stand (ohne Nummer, als Vorschau gekennzeichnet) */
  app.get('/zuwendung/vorschau/pdf', lesen, async (req, reply) => {
    const q = z.object({ art: z.enum(['EINZEL', 'SAMMEL']), jahr: jahrQ, spender: spenderZ, quellen: z.string().optional() }).parse(req.query);
    const v = await vereinLesen();
    const { dok } = await dokumentBauen(DB, v, { art: q.art, jahr: q.jahr, spender: q.spender, quellen: q.quellen ? q.quellen.split(',').map((k) => keyZ.parse(k)) : null });
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${dateiname(zuwendungTitel(dok))}"`).send(await zuwendungPdf(v, [dok]));
  });

  app.get('/zuwendung/bestaetigungen', lesen, async (req) => {
    const { jahr } = z.object({ jahr: jahrQ.optional() }).parse(req.query);
    return bestaetigungenLesen(DB, jahr ?? null);
  });

  /** Ausstellen: Einzel- oder Sammelbestätigung, danach Ablage des Doppels in Paperless */
  app.post('/zuwendung/bestaetigungen', ausfuehren, async (req) => {
    const d = AUFTRAG.parse(req.body);
    const wer = benutzer(req);
    const v = await vereinLesen();
    const r = await change(req, (tx) => ausstellen(tx, v, d, wer), { action: 'ZUWENDUNG' });
    const pl = await ablegen(req, await kopfLesen(DB, r.zbnr));
    return { ...r, paperless: pl, text: `${artText(r.art)} ${r.zbnr} für ${r.name} ausgestellt.` };
  });

  /**
   * Jahreslauf: alle offenen Bestätigungen eines Jahres in einem Schritt ausstellen (je Spender eine Sammelbestätigung,
   * bei nur einer Spende eine Einzelbestätigung). Ablage und Versand stößt die Oberfläche je Bestätigung an.
   */
  app.post('/zuwendung/jahreslauf', ausfuehren, async (req) => {
    const { jahr } = z.object({ jahr: jahrQ }).parse(req.body);
    const v = await vereinLesen();
    const r = await change(req, (tx) => jahreslauf(tx, v, jahr, benutzer(req)), { action: 'ZUWENDUNG_LAUF' });
    return { ...r, text: `${r.ausgestellt.length} Bestätigung${r.ausgestellt.length === 1 ? '' : 'en'} ausgestellt${r.uebersprungen.length ? `, ${r.uebersprungen.length} Spender übersprungen` : ''}.` };
  });

  /** Sammeldruck: mehrere ausgestellte Bestätigungen als eine Datei (aus den gespeicherten Druckdaten) */
  app.get('/zuwendung/bestaetigungen/druck', lesen, async (req, reply) => {
    const { nummern } = z.object({ nummern: z.string().min(1) }).parse(req.query);
    const nrn = [...new Set(nummern.split(',').map((n) => nrP.shape.nr.parse(n.trim())))].slice(0, 300);
    const zeilen = await DB`select zbnr, status, daten from tco.zuw_kopf where zbnr = any(${nrn}) order by jahr, lfdnr`;
    const gueltig = zeilen.filter((k) => k.status === 'A');
    if (!gueltig.length) throw new BusinessError('Keine gültige Bestätigung gewählt.', 404);
    const pdf = await zuwendungPdf(await vereinLesen(), gueltig.map((k) => k.daten));
    return reply.type('application/pdf').header('content-disposition', `inline; filename="Zuwendungsbestaetigungen_${heute()}.pdf"`).send(pdf);
  });

  /** als gedruckt vermerken (per E-Mail versendete bleiben „versendet“) */
  app.post('/zuwendung/bestaetigungen/gedruckt', ausfuehren, async (req) => {
    const { nummern } = z.object({ nummern: z.array(nrP.shape.nr).min(1).max(300) }).parse(req.body);
    const r = await change(req, (tx) => tx`
      update tco.zuw_kopf set versand_status = 'GEDRUCKT', versand_am = now(), versand_hinweis = null
       where zbnr = any(${nummern}) and status = 'A' and versand_status <> 'GESENDET'`, { action: 'ZUWENDUNG_DRUCK' });
    return { anzahl: r.count };
  });

  /** das gespeicherte, unveränderte PDF (auch stornierter Bestätigungen) */
  app.get('/zuwendung/bestaetigungen/:nr/pdf', lesen, async (req, reply) => {
    const { nr } = nrP.parse(req.params);
    const k = await kopfLesen(DB, nr);
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${dateiname(zuwendungTitel({ nummer: k.zbnr, art: k.art, jahr: k.jahr }))}"`).send(await pdfLesen(DB, nr));
  });

  app.post('/zuwendung/bestaetigungen/:nr/paperless', ausfuehren, async (req) => {
    const r = await ablegen(req, await kopfLesen(DB, nrP.parse(req.params).nr));
    if (!r.abgelegt) throw new BusinessError(r.text);
    return r;
  });

  /** per E-Mail senden – das Ergebnis nennt „nicht versendet – bitte drucken“, statt einen Fehler zu werfen */
  app.post('/zuwendung/bestaetigungen/:nr/senden', ausfuehren, async (req) => {
    const k = await kopfLesen(DB, nrP.parse(req.params).nr);
    if (k.status !== 'A') throw new BusinessError(`${k.zbnr} ist storniert und wird nicht versendet.`, 409);
    if (!(await cfgLesen(DB)).mail_erlaubt) throw new BusinessError('Der Versand per E-Mail ist in den Einstellungen nicht zugelassen – bitte drucken und unterschrieben übergeben.', 409);
    return senden(req, k);
  });

  app.post('/zuwendung/bestaetigungen/:nr/storno', ausfuehren, async (req) => {
    const { nr } = nrP.parse(req.params);
    const { grund } = z.object({ grund: z.string().trim().min(3, 'Bitte einen Stornogrund angeben').max(300) }).parse(req.body);
    const wer = benutzer(req);
    await change(req, (tx) => stornieren(tx, nr, grund, wer), { action: 'ZUWENDUNG_STORNO', reason: grund });
    // Vermerk am Doppel in Paperless – es bleibt aufbewahrt
    const k = await kopfLesen(DB, nr);
    let hinweis = '';
    if (k.paperless_id) {
      try {
        const v = await vereinLesen();
        if (plAktiv(v)) await paperless(v).notizAnlegen(k.paperless_id, `STORNIERT am ${dat(heute())} durch ${wer}: ${grund}`);
      } catch (e) { hinweis = ` Der Vermerk am Doppel in Paperless (DOKID ${String(k.paperless_id).padStart(6, '0')}) ist fehlgeschlagen: ${(e as Error).message}`; }
    }
    return { ok: true, text: `${nr} storniert – die Spenden stehen wieder in der Vorschlagsliste.${hinweis}` };
  });

  // ---------------------------------------------------------------- Einstellungen
  app.get('/zuwendung/einstellungen', admin, async () => {
    const c = await cfgLesen(DB);
    const v = await vereinLesen();
    return {
      ...c, texte: texteMischen(c.texte), ...(await cfgAuswahl(DB)), fehlt: cfgFehlt(c, v), stand: bescheidPruefen(c, heute()), sperren: sperren(c, v, heute()),
      aussteller: { name: v.name, strasse: v.strasse, plz_ort: v.plz_ort },
    };
  });
  app.put('/zuwendung/einstellungen', admin, async (req) => {
    const d = EINSTELLUNGEN.parse(req.body);
    return change(req, (tx) => cfgSichern(tx, d, benutzer(req)));
  });
}
