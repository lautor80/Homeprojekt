import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { DB } from '../verein.js';
import { heute } from '../format.js';
import {
  aktivUmschalten, artNorm, betragAbEinfuegen, detail, initialBefuellen, preiseAufbereiten, preisePruefen, sichern, TURNUS,
  uebersicht, vertraegeLesen, vorschlagNeu, zeitraumEntfernen, type Preis,
} from './logik.js';

/** Beiträge (Beitragsstamm) – Port von Z2UI5_CL_TCO_BEITRAEGE */
export const P_BEITRAEGE = { display: 'tco.beitraege:display', edit: 'tco.beitraege:edit' };

const benutzer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';
const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');
const artParam = z.object({ art: z.string().trim().min(1).max(10) });

/** Betrag wie in der SAP-App eingegeben: „65,00“, „1.250,50“, „65.00 €“ */
export function betragParse(txt: string | number): number {
  if (typeof txt === 'number') return txt;
  let t = txt.replace(/€|EUR/g, '').replace(/\s/g, '');
  if (!t) throw new BusinessError('Bitte einen gültigen Betrag eingeben, z. B. 65,00.');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(t)) throw new BusinessError(`"${txt}" ist kein gültiger Betrag.`);
  return Number(t);
}

const preisSchema = z.object({ gueltig_ab: datum, gueltig_bis: datum, betrag: z.union([z.string(), z.number()]) });
/** Zeiträume aus der Oberfläche (Beträge als Text) in Preise wandeln */
function preiseAusUi(art: string, l: z.infer<typeof preisSchema>[]): Preis[] {
  return l.map((p) => {
    let betrag: number;
    try { betrag = betragParse(p.betrag); } catch { throw new BusinessError(`Zeitraum ab ${p.gueltig_ab.split('-').reverse().join('.')}: "${p.betrag}" ist kein gültiger Betrag.`); }
    return { art: artNorm(art), gueltig_ab: p.gueltig_ab, gueltig_bis: p.gueltig_bis, betrag, aenam: null, aedat: null };
  });
}

export async function beitraegeRoutes(app: FastifyInstance) {
  /** Übersicht: alle Beitragsarten mit Betrag heute, nächster Änderung und laufenden Verträgen */
  app.get('/beitraege', { preHandler: requireAuth(P_BEITRAEGE.display) }, async () => ({ ...(await uebersicht(DB)), turnusse: TURNUS, heute: heute() }));

  /** Vorbelegung für einen neuen Beitrag (Art-Vorschlag, Erlöskonto-Vorschlag, Konten) */
  app.get('/beitraege/neu', { preHandler: requireAuth(P_BEITRAEGE.display) }, async () => vorschlagNeu(DB));

  /** Eine Beitragsart mit Zeiträumen und Verträgen */
  app.get('/beitraege/:art', { preHandler: requireAuth(P_BEITRAEGE.display) }, async (req) => detail(DB, artParam.parse(req.params).art));

  /** Verträge zu einer Beitragsart */
  app.get('/beitraege/:art/vertraege', { preHandler: requireAuth(P_BEITRAEGE.display) }, async (req) => vertraegeLesen(DB, artParam.parse(req.params).art));

  /**
   * Zeiträume im Dialog bearbeiten (ohne Sichern): neuen Betrag ab Datum einfügen bzw. Zeitraum entfernen.
   * Liefert die neue Liste aufbereitet und das Prüfergebnis.
   */
  app.post('/beitraege/zeitraum', { preHandler: requireAuth(P_BEITRAEGE.display) }, async (req) => {
    const b = z.object({
      art: z.string().default(''), preise: z.array(preisSchema),
      aktion: z.enum(['einfuegen', 'entfernen']), ab: z.string(), betrag: z.union([z.string(), z.number()]).optional(),
    }).parse(req.body);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.ab)) throw new BusinessError('Bitte ein gültiges Datum "gültig ab" wählen.');
    const alt = preiseAusUi(b.art, b.preise);
    const neu = b.aktion === 'einfuegen'
      ? betragAbEinfuegen(alt, b.art, b.ab, betragParse(b.betrag ?? ''))
      : zeitraumEntfernen(alt, b.ab);
    return { preise: preiseAufbereiten(neu), fehler: preisePruefen(neu) };
  });

  /** Beitragsart anlegen/ändern mit Zeiträumen */
  app.post('/beitraege', { preHandler: requireAuth(P_BEITRAEGE.edit) }, async (req) => {
    const b = z.object({
      neu: z.boolean().default(false), art: z.string(), bezeichnung: z.string().default(''), turnus: z.string().default(''),
      konto: z.string().default(''), aktiv: z.boolean().default(true), preise: z.array(preisSchema),
      /** noch nicht übernommene Eingabe im Feld „neuer Betrag“ */
      neu_betrag: z.string().optional(),
    }).parse(req.body);
    if (b.neu_betrag?.trim()) throw new BusinessError('Der neue Betrag wurde noch nicht übernommen. Bitte "Übernehmen" drücken oder das Feld leeren.');
    const pr = preiseAusUi(b.art, b.preise);
    return change(req, (tx) => sichern(tx, { art: b.art, bezeichnung: b.bezeichnung, turnus: b.turnus, erloeskonto: b.konto, aktiv: b.aktiv }, pr, b.neu, benutzer(req)),
      { action: b.neu ? 'BEITRAG_NEU' : 'BEITRAG_AENDERN' });
  });

  /** Schalter „Aktiv“ in der Übersicht */
  app.post('/beitraege/:art/aktiv', { preHandler: requireAuth(P_BEITRAEGE.edit) }, async (req) => {
    const { art } = artParam.parse(req.params);
    const b = z.object({ aktiv: z.boolean() }).parse(req.body);
    return { text: await change(req, (tx) => aktivUmschalten(tx, art, b.aktiv, benutzer(req)), { action: b.aktiv ? 'BEITRAG_AKTIV' : 'BEITRAG_INAKTIV' }) };
  });

  /** Erstbefüllung aus den Verträgen (solange der Stamm leer ist); test = nur Protokoll */
  app.post('/beitraege/initial', { preHandler: requireAuth(P_BEITRAEGE.edit) }, async (req) => {
    const b = z.object({ test: z.boolean().default(false) }).parse(req.body ?? {});
    const log = await change(req, (tx) => initialBefuellen(tx, b.test, benutzer(req)), { action: 'BEITRAG_INITIAL' });
    return {
      log,
      text: b.test ? 'Testlauf abgeschlossen – nichts gesichert.' : 'Beitragsstamm aus den Verträgen aufgebaut. Bitte Betrag und Erlöskonto je Beitrag prüfen.',
    };
  });
}
