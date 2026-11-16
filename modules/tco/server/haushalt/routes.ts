import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { funktionAktiv } from '../../../../server/src/funktionsschalter.js';
import { heute } from '../format.js';
import { DB, plAktiv, vereinLesen } from '../verein.js';
import { kontenStamm } from '../abschluss/logik.js';
import { kontoart } from '../finanz/logik.js';
import {
  cfgLesen, cfgSichern, F_UEBERWACHUNG, kopfAendern, monateSetzen, nachtragAnlegen, neuBerechnen, planAnlegen, planLesen, planListe, planLoeschen,
  positionAendern, positionEntfernen, positionHinzufuegen, projektEinrechnen, sollIst, sondereffektSetzen, statusSetzen, ueberschreitungen, vorgaengerSetzen,
  vorhabenLoeschen, vorhabenSichern,
} from './logik.js';
import { haushaltAblegen, haushaltPdf } from './pdf.js';
import { ENTSCHEIDUNG, POSITION_ARTEN, POSITION_TEXT, STATUS, STATUS_TEXT, VERTEILUNGEN } from './projekt.js';
import { P_PROJEKT, projekteLesen, projektLoeschen, projektnummernVorschlag, projektSichern, projektStatus } from './projekte.js';
import { METHODE_TEXT } from './vorschlag.js';

/**
 * App „Haushaltsplan“ (docs/haushaltsplan/konzept.md): Budget je Konto mit Vorschlag aus den Vorjahren, Fassungen mit
 * Status, Soll-Ist, Liquiditätsvorschau, einmalige Vorhaben, PDF für die Mitgliederversammlung. FI wird nur gelesen.
 */
export const P_HH = { display: 'tco.haushalt:display', edit: 'tco.haushalt:edit', admin: 'tco.haushalt:admin' };

const benutzer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';
const jahr = z.coerce.number().int().min(1990).max(2100);
const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');
const pId = z.object({ id: z.coerce.number().int().positive() });
const konto = z.string().trim().min(1, 'Bitte ein Konto angeben').max(20);
/** Betrag als Zahl oder in deutscher Schreibweise („1.234,56“, „5.000“); leer = null */
const betragOpt = z.union([z.number(), z.string(), z.null()]).optional().transform((v, ctx) => {
  if (v === undefined) return undefined;
  if (v === null || (typeof v === 'string' && !v.trim())) return null;
  // „5.000“ ist in deutscher Schreibweise fünftausend: Punkte vor genau drei Ziffern sind Tausenderpunkte
  const t = typeof v === 'string' ? v.trim().replace(/\s|€/g, '') : '';
  const n = typeof v === 'number' ? v : Number(t.includes(',') || /^-?\d{1,3}(\.\d{3})+$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t);
  if (!Number.isFinite(n)) { ctx.addIssue({ code: 'custom', message: 'Bitte einen Betrag angeben' }); return z.NEVER; }
  return n;
});
const betrag = betragOpt.refine((v): v is number => typeof v === 'number', 'Bitte einen Betrag angeben');
const methode = z.enum(['HOCH', 'AVG3', 'MED5', 'TREND', 'FACH', 'MANUELL']);

const cfgSchema = z.object({
  toleranz_gelb: z.coerce.number().min(0).max(100), toleranz_rot: z.coerce.number().min(0).max(100),
  mindestreserve: betragOpt.transform((v) => v ?? null),
  ausreisser_prozent: z.coerce.number().positive('Die Ausreißerschwelle muss größer als 0 sein').max(1000),
  grundlage_ab: z.union([z.number(), z.string(), z.null()]).optional().transform((v) => (v === null || v === undefined || v === '' ? null : Number(v)))
    .refine((v) => v === null || (Number.isInteger(v) && v >= 1990 && v <= 2100), '„Grundlage ab Jahr“: bitte ein Jahr zwischen 1990 und 2100 oder leer'),
  preissteigerung: z.coerce.number().min(-50).max(100),
  genehmigung_mv: z.boolean(),
});

export async function haushaltRoutes(app: FastifyInstance) {
  const lesen = { preHandler: requireAuth(P_HH.display) };
  const planen = { preHandler: requireAuth(P_HH.edit) };
  const admin = { preHandler: requireAuth(P_HH.admin) };

  /** Pläne, wählbare Jahre, Einstellungen, planbare Konten */
  app.get('/haushalt/init', lesen, async () => {
    const stamm = await kontenStamm(DB);
    const konten = [...stamm.values()].filter((k) => !k.verrechnung).map((k) => ({ konto: k.konto, name: k.name, art: kontoart(String(k.konto).trim(), k.kennzahl) }))
      .filter((k) => k.art === 'E' || k.art === 'A').sort((a, b) => Number(a.konto) - Number(b.konto));
    const h = Number(heute().slice(0, 4));
    return {
      plaene: await planListe(DB), jahr: h, jahre: [h + 1, h, h - 1], cfg: await cfgLesen(DB), konten, methoden: METHODE_TEXT,
      paperless: plAktiv(await vereinLesen()), ueberwachung: funktionAktiv(F_UEBERWACHUNG),
    };
  });

  app.get('/haushalt/plan/:id', lesen, async (req) => planLesen(DB, pId.parse(req.params).id));

  /** Plan für ein Geschäftsjahr anlegen – alle bebuchten Konten mit dem Vorschlag der treffsichersten Methode */
  app.post('/haushalt/plan', planen, async (req) => {
    const b = z.object({ jahr }).parse(req.body);
    const id = await change(req, (tx) => planAnlegen(tx, b.jahr, benutzer(req)), { action: 'HH_ANLEGEN' });
    return { id, text: `Haushaltsplan ${b.jahr} angelegt.` };
  });

  /** Vorschlag neu berechnen: je Konto die treffsicherste Methode, die bisherige oder eine Methode für alle */
  app.post('/haushalt/plan/:id/berechnen', planen, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ methode: z.enum(['BESTE', 'BEHALTEN', 'HOCH', 'AVG3', 'MED5', 'TREND']).default('BEHALTEN'), auchManuelle: z.boolean().default(false) }).parse(req.body ?? {});
    const n = await change(req, (tx) => neuBerechnen(tx, id, b), { action: 'HH_BERECHNEN' });
    return { text: `Vorschlag für ${n} Konten neu berechnet.` };
  });

  /** Angaben am Plan: Preissteigerung, Mindestreserve, Tilgung, Anfangsbestand, Notiz */
  app.put('/haushalt/plan/:id', planen, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({
      preissteigerung: z.coerce.number().min(-50).max(100).optional(), mindestreserve: betragOpt, tilgung: betragOpt, anfangsbestand: betragOpt,
      notiz: z.string().max(2000).nullish(),
    }).parse(req.body);
    await change(req, (tx) => kopfAendern(tx, id, b));
    return { ok: true };
  });

  /** Position ändern: Methode, Planwert, Zuschlag, Notiz */
  app.put('/haushalt/plan/:id/position', planen, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ konto, methode: methode.optional(), planwert: betragOpt, zuschlag: betragOpt, notiz: z.string().max(500).nullish() }).parse(req.body);
    await change(req, (tx) => positionAendern(tx, id, b.konto, { methode: b.methode, planwert: b.planwert, zuschlag: b.zuschlag, notiz: b.notiz }));
    return { ok: true };
  });

  app.post('/haushalt/plan/:id/position', planen, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ konto }).parse(req.body);
    await change(req, (tx) => positionHinzufuegen(tx, id, b.konto));
    return { text: `Konto ${b.konto} in den Haushaltsplan aufgenommen.` };
  });

  app.post('/haushalt/plan/:id/position/entfernen', planen, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ konto }).parse(req.body);
    await change(req, (tx) => positionEntfernen(tx, id, b.konto));
    return { text: `Konto ${b.konto} aus dem Haushaltsplan entfernt.` };
  });

  /** Monatsverlauf eines Kontos von Hand festlegen (betraege: null = wieder berechnen) */
  app.put('/haushalt/plan/:id/monate', planen, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ konto, betraege: z.array(z.coerce.number()).length(12, 'Bitte zwölf Monatsbeträge angeben').nullable() }).parse(req.body);
    await change(req, (tx) => monateSetzen(tx, id, b.konto, b.betraege));
    return { ok: true };
  });

  // ---------------------------------------------------------------- einmalige Vorhaben
  app.post('/haushalt/plan/:id/vorhaben', planen, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({
      id: z.coerce.number().int().positive().nullish(), bezeichnung: z.string().trim().min(1, 'Bitte eine Bezeichnung angeben').max(120),
      art: z.enum(['E', 'A']), monat: z.coerce.number().int().min(1).max(12), betrag: betrag.refine((v) => v >= 0, 'Der Betrag darf nicht negativ sein'),
      konto: z.string().trim().max(20).nullish(), projekt: z.string().trim().max(40).nullish(), eingeplant: z.boolean().default(true),
    }).parse(req.body);
    const vid = await change(req, (tx) => vorhabenSichern(tx, id, b));
    return { id: vid, text: `Vorhaben „${b.bezeichnung}“ gesichert.` };
  });

  app.post('/haushalt/plan/:id/vorhaben/loeschen', planen, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ id: z.coerce.number().int().positive() }).parse(req.body);
    await change(req, (tx) => vorhabenLoeschen(tx, id, b.id), { action: 'LOESCHEN' });
    return { text: 'Vorhaben gelöscht.' };
  });

  // ---------------------------------------------------------------- Projekte: Planung, Genehmigung, Simulation im Plan
  const monat = z.string().regex(/^\d{4}-\d{2}$/, 'Monat im Format JJJJ-MM');
  const projektSchema = z.object({
    id: z.coerce.number().int().positive().nullish(), projektnr: z.string().trim().max(20).nullish(),
    bezeichnung: z.string().trim().min(1, 'Bitte eine Bezeichnung angeben').max(120), beschreibung: z.string().max(4000).nullish(),
    verantwortlich: z.string().trim().max(100).nullish(), beginn: monat, ende: monat, bereich: z.enum(['A', 'B', 'C', 'D']).nullish(),
    positionen: z.array(z.object({
      art: z.enum(POSITION_ARTEN), bezeichnung: z.string().trim().max(120).nullish(), betrag: betragOpt.transform((v) => v ?? 0),
      konto: z.string().trim().max(20).nullish(), verteilung: z.enum(VERTEILUNGEN), von: monat.nullish().or(z.literal('').transform(() => null)),
      bis: monat.nullish().or(z.literal('').transform(() => null)), monate: z.record(z.coerce.number()).optional(),
    })).max(60),
  });

  /** Alle Projekte mit Budget, Ist aus FI und Verlauf der Genehmigung */
  app.get('/haushalt/projekte', lesen, async (req) => ({
    projekte: await projekteLesen(DB, await cfgLesen(DB)), darfGenehmigen: can(req, P_PROJEKT.approve),
    arten: POSITION_TEXT, status: STATUS_TEXT, projektnummern: await projektnummernVorschlag(DB),
  }));

  app.post('/haushalt/projekte', planen, async (req) => {
    const b = projektSchema.parse(req.body);
    const id = await change(req, (tx) => projektSichern(tx, b, benutzer(req), can(req, P_PROJEKT.approve)));
    return { id, text: `Projekt „${b.bezeichnung}“ gesichert.` };
  });

  /** Status: beantragen, umsetzen, abschließen (planen) – genehmigen, ablehnen, zurückstellen nur mit dem Recht „Projekte genehmigen“ */
  app.post('/haushalt/projekte/:id/status', lesen, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ status: z.enum(STATUS), grund: z.string().trim().max(1000).nullish() }).parse(req.body);
    // entscheiden darf, wer genehmigen darf (auch ohne Planungsrecht) – alles andere braucht das Planungsrecht
    if (!ENTSCHEIDUNG.includes(b.status) && !can(req, P_HH.edit)) throw new BusinessError('Dafür fehlt das Recht „Haushaltsplan planen“.', 403);
    const p = await change(req, (tx) => projektStatus(tx, id, b.status, b.grund ?? null, benutzer(req), can(req, P_PROJEKT.approve)), { action: `HH_PROJEKT_${b.status}`, reason: b.grund ?? undefined });
    return { text: `Projekt „${p.bezeichnung}“: ${p.status_text}.` };
  });

  app.post('/haushalt/projekte/:id/loeschen', planen, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ grund: z.string().trim().min(1, 'Bitte eine Begründung angeben') }).parse(req.body);
    const name = await change(req, (tx) => projektLoeschen(tx, id), { action: 'LOESCHEN', reason: b.grund });
    return { text: `Projekt „${name}“ gelöscht.` };
  });

  /** Simulation: Projekt in dieser Fassung ein- oder ausrechnen (einrechnen: null = Vorgabe nach dem Status) */
  app.put('/haushalt/plan/:id/projekt', planen, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ projekt_id: z.coerce.number().int().positive(), einrechnen: z.boolean().nullable() }).parse(req.body);
    await change(req, (tx) => projektEinrechnen(tx, id, b.projekt_id, b.einrechnen));
    return { ok: true };
  });

  // ---------------------------------------------------------------- Grundlage: Sondereffekte und Vorgängerkonten (gelten für alle Pläne)
  app.post('/haushalt/sondereffekt', planen, async (req) => {
    const b = z.object({ konto, jahr, grund: z.string().trim().max(200).nullish() }).parse(req.body);
    await change(req, (tx) => sondereffektSetzen(tx, b.konto, b.jahr, b.grund ?? null, benutzer(req)));
    return { text: b.grund ? `${b.jahr} zählt für Konto ${b.konto} nicht mehr in die Grundlage.` : `${b.jahr} zählt für Konto ${b.konto} wieder in die Grundlage.` };
  });

  app.post('/haushalt/vorgaenger', planen, async (req) => {
    const b = z.object({ konto, vorgaenger: z.string().trim().max(20).nullish(), ab_jahr: jahr.nullish() }).parse(req.body);
    await change(req, (tx) => vorgaengerSetzen(tx, b.konto, b.vorgaenger ?? null, b.ab_jahr ?? null));
    return { text: b.vorgaenger ? `Vorgängerkonto ${b.vorgaenger} für Konto ${b.konto} zugeordnet.` : `Vorgängerkonto für Konto ${b.konto} entfernt.` };
  });

  // ---------------------------------------------------------------- Statusfolge, Nachtrag
  app.post('/haushalt/plan/:id/beschliessen', admin, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ datum: datum.default(heute()) }).parse(req.body ?? {});
    const p = await change(req, (tx) => statusSetzen(tx, id, 'BESCHLOSSEN', b.datum, benutzer(req)), { action: 'HH_BESCHLUSS' });
    return { text: `Haushaltsplan ${p.jahr} (Fassung ${p.fassung}) ist vom Vorstand beschlossen und damit unveränderlich.` };
  });

  app.post('/haushalt/plan/:id/genehmigen', admin, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ datum: datum.default(heute()) }).parse(req.body ?? {});
    const p = await change(req, (tx) => statusSetzen(tx, id, 'GENEHMIGT', b.datum, benutzer(req)), { action: 'HH_GENEHMIGUNG' });
    return { text: `Haushaltsplan ${p.jahr} (Fassung ${p.fassung}) ist von der Mitgliederversammlung genehmigt.` };
  });

  app.post('/haushalt/plan/:id/nachtrag', admin, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ begruendung: z.string().trim().min(1, 'Bitte den Nachtrag begründen').max(1000) }).parse(req.body);
    const neu = await change(req, (tx) => nachtragAnlegen(tx, id, b.begruendung, benutzer(req)), { action: 'HH_NACHTRAG', reason: b.begruendung });
    return { id: neu, text: 'Nachtrag als neue Fassung im Entwurf angelegt.' };
  });

  app.post('/haushalt/plan/:id/loeschen', admin, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ grund: z.string().trim().min(1, 'Bitte eine Begründung angeben') }).parse(req.body);
    const p = await change(req, (tx) => planLoeschen(tx, id), { action: 'LOESCHEN', reason: b.grund });
    return { text: `Entwurf des Haushaltsplans ${p.jahr} (Fassung ${p.fassung}) gelöscht.` };
  });

  // ---------------------------------------------------------------- Soll-Ist und Überwachung
  app.get('/haushalt/sollist', lesen, async (req) => {
    const q = z.object({ jahr: jahr.default(Number(heute().slice(0, 4))) }).parse(req.query);
    return sollIst(DB, q.jahr);
  });

  /** Kennzahl der Startseite: überschrittene Budgets des laufenden Jahres (nur gegen eine beschlossene Fassung) */
  app.get('/haushalt/kennzahl', lesen, async () => {
    const u = await ueberschreitungen(DB);
    return { jahr: u.jahr, aktiv: funktionAktiv(F_UEBERWACHUNG), plan: !!u.plan, ueberschritten: u.zeilen.length, beobachten: u.beobachten };
  });

  // ---------------------------------------------------------------- PDF und Paperless
  app.get('/haushalt/plan/:id/pdf', lesen, async (req, reply) => {
    const { pdf, titel } = await haushaltPdf(DB, await vereinLesen(), pId.parse(req.params).id);
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${titel.replace(/[^\wäöüÄÖÜß .()-]/g, '_')}.pdf"`).send(pdf);
  });

  app.post('/haushalt/plan/:id/paperless', planen, async (req) => {
    const { id } = pId.parse(req.params);
    const v = await vereinLesen();
    const { pdf, titel, sicht } = await haushaltPdf(DB, v, id);
    const r = await haushaltAblegen(v, sicht, titel, pdf, benutzer(req));
    await DB`update tco.hh_plan set paperless_id = ${r.id} where id = ${id}`;
    return r;
  });

  // ---------------------------------------------------------------- Einstellungen (Administration → Einstellungen → TC Oberthal)
  app.get('/haushalt/einstellungen', admin, async () => cfgLesen(DB));
  app.put('/haushalt/einstellungen', admin, async (req) => {
    const c = cfgSchema.parse(req.body);
    await change(req, (tx) => cfgSichern(tx, c));
    return { ok: true };
  });
}
