import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { hasPermission } from '../../../../server/src/permissions.js';
import { DB, plAktiv, vereinLesen } from '../verein.js';
import { addTage, heute, runden } from '../format.js';
import { eigeneAdrnr } from '../mitglieder/selbst.js';
import {
  abschlussErzeugen, abschlussPosten, abschlussVorschau, belegBezahlt, belegeLesen, belegLesen, belegPosten, belegStornieren, cfgLesen, cfgSpeichern, gastBuchen,
  gastKassieren, kennzahlen, mitgliedBuchen, mitgliederAuswahl, monatsgrenzen, monatsname, monatVon, offenePosten, postenStornieren,
  preislisteLesen, produktBeenden, produktSpeichern, RUBRIKEN, verzehrbuch, ZAHLART_TEXT, ZAHLARTEN, type Erfasser,
} from './logik.js';
import { belegAblegen, belegErzeugen, belegMailen, belegWhatsapp, empfaenger, vorschauPdf } from './beleg.js';

/**
 * Berechtigungsobjekte Clubhaus-Verzehr:
 *  - tco.verzehr:edit     „Mein Verzehr“ – nur das eigene Mitgliedskonto (Adressnummer aus dem Benutzer)
 *  - tco.verzehr:theke    Thekendienst – Gastbelege, Verzehr für Mitglieder erfassen, kassieren, Belege versenden
 *  - tco.verzehr:display  Verzehrbuch anzeigen (alle Positionen, Belege, Auswertung)
 *  - tco.verzehr:admin    Preisliste, Stornos, Monatsabschluss, Belege bezahlen/stornieren, Einstellungen
 */
export const P_VZ = { edit: 'tco.verzehr:edit', theke: 'tco.verzehr:theke', display: 'tco.verzehr:display', admin: 'tco.verzehr:admin' };

const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');
const monat = z.string().regex(/^\d{4}(0[1-9]|1[0-2])$/, 'Bitte einen Monat wählen.');
const wuensche = z.array(z.object({ prod_key: z.string().regex(/^\d{3}$/), anzahl: z.coerce.number().positive().max(99) })).min(1, 'Bitte mindestens eine Position angeben.');
const rgnr = z.string().regex(/^VZ[GM]-[\d-]+$/, 'Ungültige Belegnummer.');
const zahlart = z.enum(ZAHLARTEN);

const wer = (req: FastifyRequest): Erfasser => ({ name: req.user?.displayName || req.user?.username || 'unbekannt', benutzerId: req.user?.id ?? null });

/** mindestens eine der Berechtigungen */
function eine(...perms: string[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) return reply.code(401).send({ message: 'Nicht angemeldet' });
    if (!perms.some((p) => hasPermission(req.user!.permissions, p))) return reply.code(403).send({ message: 'Keine Berechtigung' });
  };
}

async function pdfSenden(reply: FastifyReply, nr: string) {
  const { pdf, beleg } = await belegErzeugen(DB, await vereinLesen(), nr);
  return reply.type('application/pdf').header('content-disposition', `inline; filename="${beleg.rgnr}.pdf"`).send(pdf);
}

export async function verzehrRoutes(app: FastifyInstance) {
  const alle = { preHandler: eine(P_VZ.edit, P_VZ.theke, P_VZ.display, P_VZ.admin) };
  const theke = { preHandler: eine(P_VZ.theke, P_VZ.admin) };
  const display = { preHandler: eine(P_VZ.display, P_VZ.admin) };
  const admin = { preHandler: requireAuth(P_VZ.admin) };
  const mein = { preHandler: requireAuth(P_VZ.edit) };

  /** Preisliste (Mitglied sieht Mitgliederpreise, Theke zusätzlich Gästepreise) */
  app.get('/verzehr/preisliste', alle, async (req) => {
    const q = z.object({ stichtag: datum.optional() }).parse(req.query);
    const liste = await preislisteLesen(DB, q.stichtag ?? heute());
    const gast = can(req, P_VZ.theke) || can(req, P_VZ.admin);
    return {
      rubriken: RUBRIKEN, zahlarten: ZAHLART_TEXT,
      produkte: liste.map((p) => (gast ? p : { ...p, preis_gast: null })),
      paperless: plAktiv(await vereinLesen()),
    };
  });

  // ---------------------------------------------------------------- Mein Verzehr (nur eigenes Konto)
  app.get('/verzehr/meine', mein, async (req) => {
    const adrnr = await eigeneAdrnr(DB, req.user!.id);
    const cfg = await cfgLesen(DB);
    const offen = await offenePosten(DB, adrnr);
    const belege = await belegeLesen(DB, { art: 'SAMMEL' });
    const eigene = belege.filter((b) => b.adrnr === adrnr).map(({ email: _e, mobil: _m, mitglied_email: _me, ...b }) => b);
    const grenze = Date.now() - cfg.storno_stunden * 36e5;
    return {
      adrnr, heute: heute(), monat: monatVon(heute()), titel: monatsname(monatVon(heute())),
      offen: offen.map((p) => ({ ...p, stornierbar: new Date(p.erfasst_am.replace(' ', 'T')).getTime() >= grenze })),
      betrag: runden(offen.reduce((s, p) => s + p.betrag, 0)),
      belege: eigene, mindestbetrag: cfg.mindestbetrag, storno_stunden: cfg.storno_stunden, info_text: cfg.info_text,
      paperless: plAktiv(await vereinLesen()),
    };
  });

  app.post('/verzehr/meine/buchen', mein, async (req) => {
    const adrnr = await eigeneAdrnr(DB, req.user!.id);
    const b = z.object({ datum: datum.default(heute()), positionen: wuensche }).parse(req.body);
    // Nachträge höchstens für den Vormonat (solange er nicht abgerechnet ist)
    const vormonat = new Date(Date.UTC(Number(heute().slice(0, 4)), Number(heute().slice(5, 7)) - 2, 1)).toISOString().slice(0, 10);
    if (b.datum < vormonat) throw new BusinessError('Verzehr kann nur für den laufenden oder den Vormonat angeschrieben werden – für ältere Abende bitte beim Clubhauswart melden.');
    const r = await change(req, (tx) => mitgliedBuchen(tx, adrnr, b.datum, b.positionen, wer(req), true), { action: 'VZ_BUCHUNG', reason: 'Mein Verzehr' });
    return { ...r, text: `${r.anzahl} Position(en) über ${r.betrag.toLocaleString('de-DE', { minimumFractionDigits: 2 })} € auf dein Konto angeschrieben.` };
  });

  app.post('/verzehr/meine/storno', mein, async (req) => {
    const adrnr = await eigeneAdrnr(DB, req.user!.id);
    const b = z.object({ id: z.coerce.number().int(), grund: z.string().max(200).default('') }).parse(req.body);
    const cfg = await cfgLesen(DB);
    await change(req, (tx) => postenStornieren(tx, b.id, wer(req), b.grund, { adrnr, fristStunden: cfg.storno_stunden }), { action: 'VZ_STORNO', reason: 'Mein Verzehr' });
    return { text: 'Position storniert.' };
  });

  app.get('/verzehr/meine/beleg/:rgnr/pdf', mein, async (req, reply) => {
    const adrnr = await eigeneAdrnr(DB, req.user!.id);
    const { rgnr: nr } = z.object({ rgnr }).parse(req.params);
    const b = await belegLesen(DB, nr);
    if (!b || b.adrnr !== adrnr) throw new BusinessError('Beleg nicht gefunden.', 404);
    return pdfSenden(reply, nr);
  });

  app.get('/verzehr/meine/beleg/:rgnr/posten', mein, async (req) => {
    const adrnr = await eigeneAdrnr(DB, req.user!.id);
    const { rgnr: nr } = z.object({ rgnr }).parse(req.params);
    const b = await belegLesen(DB, nr);
    if (!b || b.adrnr !== adrnr) throw new BusinessError('Beleg nicht gefunden.', 404);
    return belegPosten(DB, nr);
  });

  // ---------------------------------------------------------------- Theke
  app.get('/verzehr/theke', theke, async () => ({
    offen: await belegeLesen(DB, { art: 'GAST', status: 'OFFEN' }),
    heute: (await belegeLesen(DB, { von: heute(), bis: heute() })).filter((b) => b.art === 'GAST'),
    mitglieder: await mitgliederAuswahl(DB),
    paperless: plAktiv(await vereinLesen()), mail: !!(await vereinLesen()).n8n_mail_url,
  }));

  /** heutige Positionen (Mitglieder und Gäste) für den Thekendienst – Mitglieder nur mit Namen */
  app.get('/verzehr/theke/heute', theke, async () => verzehrbuch(DB, { von: heute(), bis: heute() }));

  app.post('/verzehr/theke/gast', theke, async (req) => {
    const b = z.object({
      rgnr: rgnr.nullish(), gast_name: z.string().max(80).default(''), gast_gruppe: z.string().max(80).nullish(),
      email: z.string().max(120).nullish(), mobil: z.string().max(40).nullish(), positionen: wuensche,
    }).parse(req.body);
    const nr = await change(req, (tx) => gastBuchen(tx, { rgnr: b.rgnr, gast_name: b.gast_name, gast_gruppe: b.gast_gruppe, email: b.email, mobil: b.mobil, wuensche: b.positionen }, wer(req)), { action: 'VZ_BUCHUNG', reason: 'Theke Gast' });
    return { rgnr: nr, beleg: await belegLesen(DB, nr), posten: await belegPosten(DB, nr) };
  });

  app.post('/verzehr/theke/mitglied', theke, async (req) => {
    const b = z.object({ adrnr: z.string().min(1), datum: datum.default(heute()), positionen: wuensche }).parse(req.body);
    const r = await change(req, (tx) => mitgliedBuchen(tx, b.adrnr, b.datum, b.positionen, wer(req), false), { action: 'VZ_BUCHUNG', reason: 'Theke Mitglied' });
    return { ...r, text: `${r.anzahl} Position(en) über ${r.betrag.toLocaleString('de-DE', { minimumFractionDigits: 2 })} € angeschrieben.` };
  });

  app.post('/verzehr/theke/kassieren', theke, async (req) => {
    const b = z.object({ rgnr, zahlart }).parse(req.body);
    const betrag = await change(req, (tx) => gastKassieren(tx, b.rgnr, b.zahlart, wer(req)), { action: 'VZ_KASSIERT' });
    const v = await vereinLesen();
    let warnungen: string[] = [];
    if (plAktiv(v)) {
      try { warnungen = (await belegAblegen(DB, v, b.rgnr, wer(req).name, (fn) => change(req, fn, { action: 'VZ_BELEG' }), { neuVersion: true })).warnungen; }
      catch (e) { warnungen.push(`Ablage in Paperless: ${(e as Error).message}`); }
    }
    return { text: `${betrag.toLocaleString('de-DE', { minimumFractionDigits: 2 })} € ${ZAHLART_TEXT[b.zahlart].toLowerCase()} kassiert (${b.rgnr}).`, warnungen, beleg: await belegLesen(DB, b.rgnr) };
  });

  app.post('/verzehr/theke/storno', theke, async (req) => {
    const b = z.object({ id: z.coerce.number().int(), grund: z.string().max(200).default('') }).parse(req.body);
    const istAdmin = can(req, P_VZ.admin);
    await change(req, (tx) => postenStornieren(tx, b.id, wer(req), b.grund, istAdmin ? {} : { nurHeute: true }), { action: 'VZ_STORNO', reason: 'Theke' });
    return { text: 'Position storniert.' };
  });

  // ---------------------------------------------------------------- Belege (Theke: Gastbelege, Admin: alle)
  const belegZugriff = async (req: FastifyRequest, nr: string) => {
    const b = await belegLesen(DB, nr);
    if (!b) throw new BusinessError('Beleg nicht gefunden.', 404);
    if (b.art === 'SAMMEL' && !can(req, P_VZ.admin) && !can(req, P_VZ.display)) throw new BusinessError('Keine Berechtigung', 403);
    return b;
  };
  const schreiber = (req: FastifyRequest, action: string) => (fn: (tx: typeof DB) => Promise<void>) => change(req, fn, { action });

  app.get('/verzehr/belege/:rgnr/pdf', { preHandler: eine(P_VZ.theke, P_VZ.display, P_VZ.admin) }, async (req, reply) => {
    const { rgnr: nr } = z.object({ rgnr }).parse(req.params);
    await belegZugriff(req, nr);
    return pdfSenden(reply, nr);
  });
  app.get('/verzehr/belege/:rgnr', { preHandler: eine(P_VZ.theke, P_VZ.display, P_VZ.admin) }, async (req) => {
    const { rgnr: nr } = z.object({ rgnr }).parse(req.params);
    return { beleg: await belegZugriff(req, nr), posten: await belegPosten(DB, nr) };
  });
  app.post('/verzehr/belege/:rgnr/drucken', theke, async (req) => {
    const { rgnr: nr } = z.object({ rgnr }).parse(req.params);
    await belegZugriff(req, nr);
    const r = await belegAblegen(DB, await vereinLesen(), nr, wer(req).name, schreiber(req, 'VZ_BELEG'), { neuVersion: true });
    return { text: r.docId ? `Beleg ${nr} in Paperless abgelegt (Dokument ${r.docId}).` : `Beleg ${nr} gedruckt (Paperless nicht eingerichtet).`, docId: r.docId, warnungen: r.warnungen };
  });
  app.post('/verzehr/belege/:rgnr/mail', theke, async (req) => {
    const { rgnr: nr } = z.object({ rgnr }).parse(req.params);
    const b = z.object({ an: z.string().email('Bitte eine gültige E-Mail-Adresse angeben.').nullish() }).parse(req.body ?? {});
    await belegZugriff(req, nr);
    return belegMailen(DB, await vereinLesen(), nr, b.an ?? null, wer(req).name, schreiber(req, 'VZ_VERSAND'));
  });
  app.post('/verzehr/belege/:rgnr/whatsapp', theke, async (req) => {
    const { rgnr: nr } = z.object({ rgnr }).parse(req.params);
    const b = z.object({ mobil: z.string().max(40).nullish() }).parse(req.body ?? {});
    await belegZugriff(req, nr);
    return belegWhatsapp(DB, await vereinLesen(), nr, b.mobil ?? null, wer(req).name, schreiber(req, 'VZ_VERSAND'));
  });

  // ---------------------------------------------------------------- Verzehrbuch
  app.get('/verzehr/buch', display, async (req) => {
    const q = z.object({
      von: datum.optional(), bis: datum.optional(), adrnr: z.string().optional(), rgnr: z.string().optional(),
      art: z.enum(['MITGLIED', 'GAST']).optional(), status: z.enum(['OFFEN', 'ABGERECHNET', 'BEZAHLT', 'STORNIERT']).optional(), suche: z.string().max(80).optional(),
    }).parse(req.query);
    const m = monatsgrenzen(monatVon(heute()));
    const von = q.von ?? m.von, bis = q.bis ?? m.bis;
    return { von, bis, posten: await verzehrbuch(DB, { von, bis, adrnr: q.adrnr || undefined, rgnr: q.rgnr || undefined, art: q.art, status: q.status, suche: q.suche || undefined }), kennzahlen: await kennzahlen(DB, von, bis), mitglieder: await mitgliederAuswahl(DB) };
  });

  app.get('/verzehr/belege', display, async (req) => {
    const q = z.object({ von: datum.optional(), bis: datum.optional(), art: z.enum(['GAST', 'SAMMEL']).optional(), status: z.string().optional(), monat: monat.optional() }).parse(req.query);
    return belegeLesen(DB, q);
  });

  // ---------------------------------------------------------------- Verwaltung
  app.get('/verzehr/cfg', display, async () => cfgLesen(DB));
  app.put('/verzehr/cfg', admin, async (req) => {
    const b = z.object({
      mindestbetrag: z.coerce.number().min(0).max(1000), zahlungsziel_tage: z.coerce.number().int().min(0).max(90), storno_stunden: z.coerce.number().int().min(0).max(720),
      erloeskonto: z.string().max(10).default(''), forderungskonto: z.string().max(10).default(''), info_text: z.string().max(500).default(''),
    }).parse(req.body);
    await change(req, (tx) => cfgSpeichern(tx, b), { action: 'VZ_CFG' });
    return { text: 'Einstellungen gespeichert.' };
  });

  app.put('/verzehr/produkte', admin, async (req) => {
    const b = z.object({
      prod_key: z.string().regex(/^\d{3}$/).nullish(), rubrik: z.enum(['G', 'S', 'X']), text: z.string().max(60), preis: z.coerce.number(),
      preis_gast: z.coerce.number().nullish(), ab: datum.default(heute()),
    }).parse(req.body);
    const key = await change(req, (tx) => produktSpeichern(tx, { ...b, preis_gast: b.preis_gast ?? null }), { action: 'VZ_PREIS' });
    return { prod_key: key, text: 'Preis gespeichert.' };
  });
  app.post('/verzehr/produkte/beenden', admin, async (req) => {
    const b = z.object({ prod_key: z.string().regex(/^\d{3}$/), ab: datum.default(heute()) }).parse(req.body);
    await change(req, (tx) => produktBeenden(tx, b.prod_key, b.ab), { action: 'VZ_PREIS' });
    return { text: 'Produkt beendet.' };
  });

  app.post('/verzehr/storno', admin, async (req) => {
    const b = z.object({ id: z.coerce.number().int(), grund: z.string().max(200).default('') }).parse(req.body);
    await change(req, (tx) => postenStornieren(tx, b.id, wer(req), b.grund, {}), { action: 'VZ_STORNO', reason: 'Verzehrbuch' });
    return { text: 'Position storniert.' };
  });

  app.get('/verzehr/abschluss', display, async (req) => {
    const q = z.object({ monat }).parse(req.query);
    return { monat: q.monat, titel: monatsname(q.monat), zeilen: await abschlussVorschau(DB, q.monat), belege: await belegeLesen(DB, { art: 'SAMMEL', monat: q.monat }), moeglich: q.monat < monatVon(heute()) };
  });

  /** Vorschau-PDF im Vereinslayout: ein Mitglied oder alle offenen des Monats, ohne Belege anzulegen */
  app.get('/verzehr/abschluss/pdf', display, async (req, reply) => {
    const q = z.object({ monat, adrnr: z.string().optional() }).parse(req.query);
    const cfg = await cfgLesen(DB);
    const v = await vereinLesen();
    const zeilen = (await abschlussVorschau(DB, q.monat)).filter((z) => !z.abgerechnet && !z.uebertrag && (!q.adrnr || z.adrnr === q.adrnr));
    if (!zeilen.length) throw new BusinessError('Für diese Auswahl gibt es keine offenen Positionen über dem Mindestbetrag.');
    const teile = [];
    for (const z of zeilen) {
      const b = {
        rgnr: `VZM-${q.monat.slice(0, 4)}-${q.monat.slice(4, 6)}-????`, art: 'SAMMEL' as const, adrnr: z.adrnr, gast_name: null, gast_gruppe: null, email: z.email, mobil: null,
        datum: heute(), monat: q.monat, status: 'GESTELLT' as const, betrag: z.betrag, zahlart: z.zahlart, faellig: addTage(heute(), cfg.zahlungsziel_tage),
        bezahlt_am: null, doc_id: null, versand_am: null, versand_art: null, laufid: null, erstellt_von: null, bemerkung: null,
      };
      teile.push({ beleg: b, empfaenger: await empfaenger(DB, b), pos: await abschlussPosten(DB, z.adrnr, q.monat) });
    }
    const pdf = await vorschauPdf(v, teile);
    return reply.type('application/pdf').header('content-disposition', `inline; filename="Vorschau_Verzehr_${q.monat}.pdf"`).send(pdf);
  });

  /** Sammelabrechnungen erzeugen, in Paperless ablegen und (soweit E-Mail vorhanden) versenden */
  app.post('/verzehr/abschluss', admin, async (req) => {
    const b = z.object({ monat, adrnrs: z.array(z.string()).nullish(), versenden: z.boolean().default(true) }).parse(req.body);
    const belege = await change(req, (tx) => abschlussErzeugen(tx, b.monat, b.adrnrs ?? null, wer(req)), { action: 'VZ_ABSCHLUSS', reason: `Sammelabrechnung ${monatsname(b.monat)}` });
    const v = await vereinLesen();
    const prot: { rgnr: string; text: string }[] = [];
    for (const nr of belege) {
      try {
        if (b.versenden && v.n8n_mail_url) {
          const r = await belegMailen(DB, v, nr, null, wer(req).name, schreiber(req, 'VZ_VERSAND'));
          prot.push({ rgnr: nr, text: r.text });
        } else {
          const r = await belegAblegen(DB, v, nr, wer(req).name, schreiber(req, 'VZ_BELEG'));
          prot.push({ rgnr: nr, text: r.docId ? `abgelegt (Dokument ${r.docId})` : 'erzeugt' });
        }
      } catch (e) { prot.push({ rgnr: nr, text: `Hinweis: ${(e as Error).message}` }); }
    }
    return { belege, prot, text: belege.length ? `${belege.length} Sammelabrechnung(en) für ${monatsname(b.monat)} erzeugt.` : 'Keine offenen Positionen über dem Mindestbetrag – nichts abgerechnet.' };
  });

  app.post('/verzehr/belege/:rgnr/bezahlt', admin, async (req) => {
    const { rgnr: nr } = z.object({ rgnr }).parse(req.params);
    const b = z.object({ datum: datum.default(heute()), zahlart: zahlart.nullish() }).parse(req.body ?? {});
    await change(req, (tx) => belegBezahlt(tx, nr, b.datum, b.zahlart), { action: 'VZ_BEZAHLT' });
    const v = await vereinLesen();
    let warnungen: string[] = [];
    if (plAktiv(v)) {
      try { warnungen = (await belegAblegen(DB, v, nr, wer(req).name, schreiber(req, 'VZ_BELEG'), { neuVersion: true })).warnungen; }
      catch (e) { warnungen.push(`Neue Version in Paperless: ${(e as Error).message}`); }
    }
    return { text: `Beleg ${nr} als bezahlt gekennzeichnet.`, warnungen };
  });

  app.post('/verzehr/belege/:rgnr/storno', admin, async (req) => {
    const { rgnr: nr } = z.object({ rgnr }).parse(req.params);
    const b = z.object({ grund: z.string().max(200).default('') }).parse(req.body ?? {});
    await change(req, (tx) => belegStornieren(tx, nr, wer(req), b.grund), { action: 'VZ_STORNO', reason: 'Beleg' });
    return { text: `Beleg ${nr} storniert.` };
  });
}
