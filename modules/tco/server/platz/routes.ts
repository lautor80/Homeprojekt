import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { DB } from '../verein.js';
import { addTage } from '../format.js';
import {
  aboAnlegen, aboBeenden, abosLesen, aboVorschau, belegungLesen, benutzerListe, benutzerZuordnen, einzelAendern, einzelAnlegen,
  einzelStornieren, hhmm, ichLesen, jetzt, meineLesen, platzLesen, platzLoeschen, plaetzeLesen, platzSpeichern, preisVon, regelnPruefen,
  tagLesen, verwaltungStornieren, ARTEN, type Ich,
} from './logik.js';
import { minuten, preiseLesen } from '../halle/preis.js';

/**
 * Platzbuchung (Freiplätze und Halle).
 *
 * „Platz buchen“ (tco.platzbuchung:edit): Das Mitglied wird AUSSCHLIESSLICH aus dem angemeldeten Benutzer
 * ermittelt (tco.mitgliedera.benutzer_id). Eigene Buchungen mit Preis anzeigen, anlegen, ändern, stornieren;
 * fremde Buchungen erscheinen nur als „belegt“ (ohne Name, Nummer, Text). Abos sind nur lesbar.
 *
 * „Platzverwaltung“ (tco.platz:admin): Plätze und Buchungsregeln, Belegung mit Namen, Abos, Benutzerzuordnung.
 */
export const P_PLATZ = { buchen: 'tco.platzbuchung:edit', admin: 'tco.platz:admin' };

const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');
const uhr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Uhrzeit im Format HH:MM');
const buchung = z.object({ platz_id: z.coerce.number().int().positive(), datum, von: uhr, bis: uhr, text: z.string().max(200).nullish() });
const platz = z.object({
  name: z.string().trim().min(1, 'Bitte eine Bezeichnung angeben.').max(60),
  art: z.enum(['HALLE', 'FREI']),
  aliase: z.string().max(300).default(''),
  sort: z.coerce.number().int().default(0),
  gueltig_von: datum,
  gueltig_bis: datum.default('9999-12-31'),
  wochentage: z.string().regex(/^[1-7]{1,7}$/, 'Bitte mindestens einen Wochentag wählen.'),
  zeit_von: uhr, zeit_bis: uhr,
  raster: z.coerce.number().refine((x) => [15, 30, 60].includes(x), 'Zeitraster 15, 30 oder 60 Minuten'),
  dauer_min: z.coerce.number().int().min(15).max(1440),
  dauer_max: z.coerce.number().int().min(15).max(1440),
  vorlauf_min: z.coerce.number().int().min(0).max(24 * 14),
  vorlauf_max: z.coerce.number().int().min(0).max(400),
  storno_frist: z.coerce.number().int().min(0).max(24 * 14),
  max_offen: z.coerce.number().int().min(0).max(100),
  abrechnen: z.boolean(),
  aktiv: z.boolean(),
  hinweis: z.string().max(500).nullish().transform((x) => x ?? null),
});
const abo = z.object({
  platz_id: z.coerce.number().int().positive(), adrnr: z.string().min(1, 'Bitte ein Mitglied wählen.'),
  ab: datum, bis_datum: datum, von: uhr, bis: uhr, text: z.string().max(200).nullish(),
});

/** Mitglied des angemeldeten Benutzers – sonst 403 */
async function ich(req: FastifyRequest): Promise<Ich> {
  const id = req.user?.id;
  if (!id) throw new BusinessError('Bitte mit einem persönlichen Benutzer anmelden.', 403);
  const i = await ichLesen(DB, id);
  if (!i) throw new BusinessError('Ihr Benutzer ist keinem Mitglied zugeordnet. Bitte beim Vorstand melden (Zuordnung unter Tennishalle → Platzverwaltung → Benutzer).', 403);
  return i;
}

export async function platzRoutes(app: FastifyInstance) {
  const buchen = { preHandler: requireAuth(P_PLATZ.buchen) };
  const admin = { preHandler: requireAuth(P_PLATZ.admin) };

  // ------------------------------------------------------------------ Platz buchen (eigene Buchungen)
  app.get('/platz/tag', buchen, async (req) => {
    const i = await ich(req);
    const q = z.object({ datum }).parse(req.query);
    const j = jetzt();
    return { datum: q.datum, heute: j.datum, jetzt: hhmm(j.min), ich: { name: i.name }, plaetze: await tagLesen(DB, q.datum, i) };
  });

  app.get('/platz/meine', buchen, async (req) => {
    const i = await ich(req);
    const q = z.object({ zeitraum: z.enum(['kommend', 'vergangen']).default('kommend') }).parse(req.query);
    return { ich: { name: i.name }, ...(await meineLesen(DB, i, q.zeitraum)) };
  });

  /** Preis und Regeln vorab prüfen (Buchungsdialog) */
  app.post('/platz/pruefen', buchen, async (req) => {
    await ich(req);
    const e = buchung.extend({ bid: z.string().nullish() }).parse(req.body);
    const p = await platzLesen(DB, e.platz_id);
    if (!p.aktiv) throw new BusinessError('Platz nicht gefunden.', 404);
    const von = minuten(e.von);
    const bis = e.bis === '24:00' ? 1440 : minuten(e.bis);
    let fehler = regelnPruefen({ platz: p, datum: e.datum, von, bis }, false);
    if (!fehler) {
      const b = (await belegungLesen(DB, [p], e.datum, e.datum)).find((x) => x.bid !== e.bid && x.von < bis && x.bis > von);
      if (b) fehler = `Von ${hhmm(b.von)} bis ${hhmm(b.bis)} Uhr bereits belegt.`;
    }
    return { fehler, preis: preisVon(p, e.datum, von, bis, '1', await preiseLesen(DB)) };
  });

  app.post('/platz/buchungen', buchen, async (req) => {
    const i = await ich(req);
    const e = buchung.parse(req.body);
    return change(req, (tx) => einzelAnlegen(tx, i, e), { action: 'PLATZ_BUCHEN', reason: `${e.datum} ${e.von}–${e.bis}` });
  });

  app.put('/platz/buchungen/:bid', buchen, async (req) => {
    const i = await ich(req);
    const { bid } = z.object({ bid: z.string().min(1) }).parse(req.params);
    const e = buchung.parse(req.body);
    return { text: await change(req, (tx) => einzelAendern(tx, i, bid, e), { action: 'PLATZ_AENDERN', reason: bid }) };
  });

  app.delete('/platz/buchungen/:bid', buchen, async (req) => {
    const i = await ich(req);
    const { bid } = z.object({ bid: z.string().min(1) }).parse(req.params);
    return { text: await change(req, (tx) => einzelStornieren(tx, i, bid), { action: 'PLATZ_STORNO', reason: bid }) };
  });

  // ------------------------------------------------------------------ Platzverwaltung
  app.get('/platz/admin/plaetze', admin, async () => ({ plaetze: await plaetzeLesen(DB), arten: ARTEN }));

  app.post('/platz/admin/plaetze', admin, async (req) => {
    const p = platz.parse(req.body);
    const id = await change(req, (tx) => platzSpeichern(tx, null, p), { action: 'PLATZ_ANLEGEN', reason: p.name });
    return { id, text: `Platz „${p.name}“ angelegt.` };
  });

  app.put('/platz/admin/plaetze/:id', admin, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const p = platz.parse(req.body);
    await change(req, (tx) => platzSpeichern(tx, id, p), { action: 'PLATZ_AENDERN', reason: p.name });
    return { id, text: `Platz „${p.name}“ gespeichert.` };
  });

  app.delete('/platz/admin/plaetze/:id', admin, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    await change(req, (tx) => platzLoeschen(tx, id), { action: 'PLATZ_LOESCHEN' });
    return { text: 'Platz gelöscht.' };
  });

  app.get('/platz/admin/tag', admin, async (req) => {
    const q = z.object({ datum }).parse(req.query);
    return { datum: q.datum, plaetze: await tagLesen(DB, q.datum, 'admin') };
  });

  app.post('/platz/admin/storno', admin, async (req) => {
    const e = z.object({ bid: z.string().min(1), datum }).parse(req.body);
    return { text: await change(req, (tx) => verwaltungStornieren(tx, e.bid, e.datum), { action: 'PLATZ_STORNO', reason: e.bid }) };
  });

  app.get('/platz/admin/abos', admin, async () => abosLesen(DB));

  app.post('/platz/admin/abos/vorschau', admin, async (req) => aboVorschau(DB, abo.parse(req.body)));

  app.post('/platz/admin/abos', admin, async (req) => {
    const e = abo.extend({ ueberspringen: z.boolean().default(false) }).parse(req.body);
    return change(req, (tx) => aboAnlegen(tx, e, e.ueberspringen), { action: 'PLATZ_ABO', reason: `${e.adrnr} ${e.ab}–${e.bis_datum}` });
  });

  app.post('/platz/admin/abos/:bid/beenden', admin, async (req) => {
    const { bid } = z.object({ bid: z.string().min(1) }).parse(req.params);
    const { ab } = z.object({ ab: datum.default(() => addTage(jetzt().datum, 1)) }).parse(req.body ?? {});
    return { text: await change(req, (tx) => aboBeenden(tx, bid, ab), { action: 'PLATZ_ABO_ENDE', reason: bid }) };
  });

  app.get('/platz/admin/benutzer', admin, async () => benutzerListe(DB));

  app.put('/platz/admin/benutzer', admin, async (req) => {
    const e = z.object({ benutzer_id: z.string().uuid(), adrnr: z.string().min(1).nullable() }).parse(req.body);
    await change(req, (tx) => benutzerZuordnen(tx, e.benutzer_id, e.adrnr), { action: 'PLATZ_BENUTZER' });
    return { text: e.adrnr ? 'Zuordnung gespeichert.' : 'Zuordnung entfernt.' };
  });
}
