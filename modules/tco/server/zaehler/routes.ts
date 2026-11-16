import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { portalUrl } from '../../../../server/src/kennwort.js';
import { heute } from '../format.js';
import { DB, vereinLesen } from '../verein.js';
import type { StandEingabe, ZaehlerStamm } from '../../web/zaehler/typen.js';
import {
  auswertung, bogenLesen, detail, exportCsv, fotoLaden, importieren, P_ZAEHLER, standAendern, standAnlegen, standLoeschen, standPruefen,
  uebersicht, vergleich, zaehlerAendern, zaehlerAnlegen, zaehlerEins, zaehlerLoeschen, zeitraum, type Ich,
} from './daten.js';
import { MEDIEN_KEYS, STAND_ARTEN_KEYS } from './logik.js';
import { ablesebogenPdf } from './pdf.js';

export { P_ZAEHLER };

/**
 * Zählerstände (Bereich Instandhaltung): Zähler für Strom, Gas, Wasser, Wärme, PV …, Ablesungen mit Plausibilitätsprüfung
 * und Foto, Auswertung je Monat/Jahr, Jahresvergleich, CSV-Export und -Import, QR-Code je Zähler (öffnet die Erfassung),
 * Ablesebogen als PDF. Verträge der Antworten: modules/tco/web/zaehler/typen.ts.
 */
const nr = z.coerce.number().int().positive();
const pId = z.object({ id: nr });
const pSid = z.object({ sid: nr });
const txt = (max: number) => z.string().trim().max(max);
const optTxt = (max: number) => txt(max).nullish().transform((v) => v || null);
/** leere Eingabe = nicht gesetzt */
const optZahl = <T extends z.ZodTypeAny>(s: T) => z.preprocess((v) => (v === '' ? null : v), s.nullish()).transform((v) => (v ?? null) as z.infer<T> | null);
const monat = z.string().regex(/^\d{4}(-\d{2})?$/, 'Zeitraum im Format JJJJ-MM');
const idListe = z.string().max(2000).default('').transform((v, ctx) => {
  const ids = v.split(',').map((x) => x.trim()).filter(Boolean).map(Number);
  if (ids.some((x) => !Number.isInteger(x) || x <= 0)) { ctx.addIssue({ code: 'custom', message: 'ids: Liste von Zähler-IDs, mit Komma getrennt' }); return z.NEVER; }
  return [...new Set(ids)];
});

const stammSchema = z.object({
  bezeichnung: txt(120).min(1, 'Bitte eine Bezeichnung angeben.'),
  medium: z.enum(MEDIEN_KEYS, { errorMap: () => ({ message: 'Bitte das Medium wählen.' }) }),
  einheit: txt(20).default(''),
  standort: optTxt(120),
  zaehlernummer: optTxt(60),
  faktor: z.preprocess((v) => (v === '' || v == null ? 1 : v), z.coerce.number().positive('Der Faktor muss größer als 0 sein.').max(1_000_000)),
  verbrauchseinheit: optTxt(20),
  stellen: optZahl(z.coerce.number().int().min(1, 'Stellen: 1 bis 12').max(12, 'Stellen: 1 bis 12')),
  intervall_tage: optZahl(z.coerce.number().int().min(1, 'Ableseintervall: 1 bis 3660 Tage').max(3660, 'Ableseintervall: 1 bis 3660 Tage')),
  arbeitspreis: optZahl(z.coerce.number().min(0).max(100_000)),
  grundpreis_monat: optZahl(z.coerce.number().min(0).max(1_000_000)),
  jahresziel: optZahl(z.coerce.number().min(0).max(1e12)),
  aktiv: z.boolean().default(true),
  notiz: optTxt(2000),
}) satisfies z.ZodType<ZaehlerStamm, z.ZodTypeDef, unknown>;

const standSchema = z.object({
  datum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT'),
  stand: z.coerce.number({ invalid_type_error: 'Bitte den Stand als Zahl angeben.' }).min(0, 'Der Stand muss eine Zahl ab 0 sein.').max(99_999_999_999),
  art: z.enum(STAND_ARTEN_KEYS).default('ABLESUNG'),
  notiz: optTxt(500),
  // data:-URL; undefined = unverändert, null = Foto entfernen
  foto: z.string().max(4_500_000, 'Das Foto ist zu groß (höchstens 3 MB).').nullish(),
  bestaetigt: z.boolean().default(false),
}) satisfies z.ZodType<StandEingabe, z.ZodTypeDef, unknown>;

const begruendung = z.object({ reason: z.string({ required_error: 'Bitte eine Begründung angeben.' }).trim().min(1, 'Bitte eine Begründung angeben.').max(500) });

const ich = (req: FastifyRequest): Ich => ({ id: req.user?.apiKey ? null : req.user?.id ?? null });

export async function zaehlerRoutes(app: FastifyInstance) {
  const lesen = { preHandler: requireAuth(P_ZAEHLER.display) };
  const erfassen = { preHandler: requireAuth(P_ZAEHLER.edit) };
  const admin = { preHandler: requireAuth(P_ZAEHLER.admin) };
  const FOTO_LIMIT = 6 * 1024 * 1024;

  // ---------------------------------------------------------------- Übersicht und Zähler
  app.get('/zaehler', lesen, async (req) => {
    const q = z.object({ alle: z.enum(['0', '1', 'true', 'false']).optional() }).parse(req.query);
    return { zeilen: await uebersicht(DB, q.alle === '1' || q.alle === 'true', heute()) };
  });

  /** Auswertung je Monat bzw. Jahr (ids leer = alle aktiven Zähler) */
  app.get('/zaehler/auswertung', lesen, async (req) => {
    const q = z.object({ ids: idListe, von: monat.optional(), bis: monat.optional(), raster: z.enum(['monat', 'jahr']).default('monat') }).parse(req.query);
    const t = zeitraum(q.raster, q.von, q.bis, heute());
    return auswertung(DB, q.ids, q.raster, t.von, t.bis);
  });

  /** CSV-Download der Stände (ids leer = alle Zähler) */
  app.get('/zaehler/export.csv', lesen, async (req, reply) => {
    const q = z.object({ ids: idListe, von: monat.optional(), bis: monat.optional() }).parse(req.query);
    const von = q.von ? (q.von.length === 4 ? `${q.von}-01` : q.von) : null;
    const bis = q.bis ? (q.bis.length === 4 ? `${q.bis}-12` : q.bis) : null;
    const csv = await exportCsv(DB, q.ids, von, bis);
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="zaehlerstaende_${heute()}.csv"`).send(csv);
  });

  /** Ablesebogen aller aktiven Zähler zum Ausdrucken */
  app.get('/zaehler/ablesebogen.pdf', lesen, async (_req, reply) => {
    const stichtag = heute();
    const pdf = await ablesebogenPdf(await vereinLesen(), await bogenLesen(DB, stichtag), stichtag);
    return reply.type('application/pdf').header('content-disposition', `inline; filename="Ablesebogen_${stichtag}.pdf"`).send(pdf);
  });

  /** CSV-Import: prüfen (uebernehmen false) oder fehlerfreie Zeilen übernehmen – abschaltbar (tco.zaehler.import) */
  app.post('/zaehler/import', { ...erfassen, bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    const b = z.object({ csv: z.string().max(3_000_000), uebernehmen: z.boolean().default(false) }).parse(req.body);
    if (!b.uebernehmen) return importieren(DB, b.csv, false, ich(req), heute());
    return change(req, (tx) => importieren(tx, b.csv, true, ich(req), heute()), { action: 'ZAEHLER_IMPORT' });
  });

  app.get('/zaehler/:id', lesen, async (req) => detail(DB, pId.parse(req.params).id, heute()));

  app.get('/zaehler/:id/jahresvergleich', lesen, async (req) => vergleich(DB, pId.parse(req.params).id));

  /** QR-Code (SVG) zum Aufkleben am Zähler: öffnet die Erfassung mit vorbelegtem Zähler */
  app.get('/zaehler/:id/qr', lesen, async (req, reply) => {
    const { id } = pId.parse(req.params);
    await zaehlerEins(DB, id);
    const url = await portalUrl();
    if (!url) throw new BusinessError('Die Portal-Adresse ist nicht eingerichtet (Administration → Einstellungen) – ohne sie funktionieren die QR-Codes nicht.');
    const svg = await QRCode.toString(`${url}/tco/zaehler/erfassen?zaehler=${id}`, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
    return reply.type('image/svg+xml').header('cache-control', 'private, max-age=3600').send(svg);
  });

  app.post('/zaehler', admin, async (req) => {
    const b = stammSchema.parse(req.body);
    const r = await change(req, (tx) => zaehlerAnlegen(tx, b), { action: 'ZAEHLER_ANLEGEN' });
    return { ...r, text: `Zähler ${r.nummer} „${b.bezeichnung}“ angelegt.` };
  });

  app.put('/zaehler/:id', admin, async (req) => {
    const { id } = pId.parse(req.params);
    const b = stammSchema.parse(req.body);
    await change(req, (tx) => zaehlerAendern(tx, id, b), { action: 'ZAEHLER_AENDERN' });
    return { text: 'Gesichert.' };
  });

  app.delete('/zaehler/:id', admin, async (req) => {
    const { id } = pId.parse(req.params);
    const { reason } = begruendung.parse(req.body ?? {});
    const name = await change(req, (tx) => zaehlerLoeschen(tx, id), { action: 'ZAEHLER_LOESCHEN', reason });
    return { text: `Zähler ${name} gelöscht.` };
  });

  // ---------------------------------------------------------------- Stände
  app.post('/zaehler/:id/staende/pruefen', erfassen, async (req) => {
    const { id } = pId.parse(req.params);
    const b = standSchema.omit({ foto: true }).parse(req.body);
    return standPruefen(DB, id, b, heute());
  });

  app.post('/zaehler/:id/staende', { ...erfassen, bodyLimit: FOTO_LIMIT }, async (req) => {
    const { id } = pId.parse(req.params);
    const b = standSchema.parse(req.body);
    return change(req, (tx) => standAnlegen(tx, id, b, ich(req), heute()), { action: 'ZAEHLER_STAND' });
  });

  app.put('/zaehler/staende/:sid', { ...erfassen, bodyLimit: FOTO_LIMIT }, async (req) => {
    const { sid } = pSid.parse(req.params);
    const b = standSchema.parse(req.body);
    return change(req, (tx) => standAendern(tx, sid, b, heute()), { action: 'ZAEHLER_STAND' });
  });

  app.delete('/zaehler/staende/:sid', erfassen, async (req) => {
    const { sid } = pSid.parse(req.params);
    const { reason } = begruendung.parse(req.body ?? {});
    return { text: await change(req, (tx) => standLoeschen(tx, sid), { action: 'ZAEHLER_STAND_LOESCHEN', reason }) };
  });

  app.get('/zaehler/staende/:sid/foto', lesen, async (req, reply) => {
    const f = await fotoLaden(DB, pSid.parse(req.params).sid);
    return reply.type(f.typ).header('cache-control', 'private, max-age=86400').send(f.daten);
  });
}

