import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { DB, vereinLesen } from '../verein.js';
import { auswaehlen, teilnehmerPdf, teilnehmerTitel } from './pdf.js';
import { mailtoLink, teilnehmerDetail, teilnehmerLesen } from './logik.js';
import { SAISONS, saisonAm, saisonText, vorjahresSaison, zeitenLesen, zeitenSetzen, zeitenText, zeitenUebernehmen, type SaisonRef } from './zeiten.js';

/**
 * Stammdaten werden unter „Mitglieder“ geändert. Gepflegt werden hier nur die Trainingszeiten je Saison
 * (Sommer/Winter eines Jahres, Wochentag Mo–So mit Uhrzeit) – Recht tco.teilnehmer:edit.
 */
export const P_TN = { display: 'tco.teilnehmer:display', edit: 'tco.teilnehmer:edit' };

const saisonSchema = z.object({
  jahr: z.coerce.number().int().min(2000).max(2100),
  saison: z.enum(SAISONS),
});
/** Saison aus der Anfrage; fehlt sie, die Saison zum heutigen Tag */
const saisonAus = (q: unknown): SaisonRef => {
  const r = saisonSchema.partial().parse(q ?? {});
  const akt = saisonAm();
  return r.jahr && r.saison ? { jahr: r.jahr, saison: r.saison } : akt;
};
const zeitSchema = z.object({
  wochentag: z.coerce.number().int().min(1, 'Bitte einen Wochentag wählen.').max(7),
  von: z.string().max(8), bis: z.string().max(8), bemerkung: z.string().max(200).default(''),
});

export async function teilnehmerRoutes(app: FastifyInstance) {
  const lesen = { preHandler: requireAuth(P_TN.display) };
  const pflegen = { preHandler: requireAuth(P_TN.edit) };

  /** Trefferliste aller Teilnehmer mit ihren Trainingszeiten der gewählten Saison (Filter, Suche und Sortierung laufen in der Oberfläche) */
  app.get('/teilnehmer', lesen, async (req) => {
    const s = saisonAus(req.query);
    const t = await teilnehmerLesen(DB);
    const zeiten = await zeitenLesen(DB, s);
    const liste = t.map((x) => {
      const z = zeiten.get(x.adrnr) ?? [];
      return { ...x, zeiten: z, zeiten_text: zeitenText(z) };
    });
    return {
      teilnehmer: liste, einheiten: t.reduce((n, x) => n + x.einheiten, 0),
      mitglieder: t.filter((x) => x.mitglied).length, nichtmitglieder: t.filter((x) => !x.mitglied).length,
      saison: { ...s, text: saisonText(s) }, aktuell: saisonAm(), vorjahr: { ...vorjahresSaison(s), text: saisonText(vorjahresSaison(s)) },
      mit_zeiten: liste.filter((x) => x.zeiten.length).length,
    };
  });

  /** Trainingszeiten einer Person für eine Saison */
  app.get('/teilnehmer/:adrnr/zeiten', lesen, async (req) => {
    const { adrnr } = z.object({ adrnr: z.string().min(1).max(20) }).parse(req.params);
    const s = saisonAus(req.query);
    return { ...s, text: saisonText(s), zeiten: (await zeitenLesen(DB, s, adrnr)).get(adrnr) ?? [] };
  });

  /** Trainingszeiten einer Person für eine Saison speichern (ersetzt die bisherigen Zeiten dieser Saison) */
  app.put('/teilnehmer/:adrnr/zeiten', pflegen, async (req) => {
    const { adrnr } = z.object({ adrnr: z.string().min(1).max(20) }).parse(req.params);
    const b = saisonSchema.extend({ zeiten: z.array(zeitSchema).max(21) }).parse(req.body);
    const s: SaisonRef = { jahr: b.jahr, saison: b.saison };
    const zeiten = await change(req, (tx) => zeitenSetzen(tx, adrnr, s, b.zeiten), { action: 'TN_ZEITEN', reason: saisonText(s) });
    return { ...s, text: saisonText(s), zeiten, zeiten_text: zeitenText(zeiten) };
  });

  /** Zeiten aller laufenden Teilnehmer aus einer Saison übernehmen (nur Personen ohne Zeiten in der Zielsaison) */
  app.post('/teilnehmer/zeiten/uebernehmen', pflegen, async (req) => {
    const b = z.object({ von: saisonSchema, nach: saisonSchema }).parse(req.body);
    const adrnrs = (await teilnehmerLesen(DB)).map((x) => x.adrnr);
    const r = await change(req, (tx) => zeitenUebernehmen(tx, b.von, b.nach, adrnrs),
      { action: 'TN_ZEITEN', reason: `${saisonText(b.von)} → ${saisonText(b.nach)}` });
    const text = r.personen
      ? `${r.zeiten} Trainingszeit(en) für ${r.personen} Teilnehmer aus ${saisonText(b.von)} übernommen.`
      : `Nichts übernommen – in ${saisonText(b.von)} gibt es keine Zeiten für Teilnehmer ohne Zeiten in ${saisonText(b.nach)}.`;
    return { ...r, text: r.uebersprungen ? `${text} ${r.uebersprungen} Teilnehmer hatten schon Zeiten und blieben unverändert.` : text };
  });

  /** Teilnehmerliste als PDF im Vereinslayout – gleiche Auswahl wie in der App (Filter, Suche, Markierung) */
  app.get('/teilnehmer/pdf', lesen, async (req, reply) => {
    const q = z.object({
      filter: z.enum(['ALL', 'MEMBER', 'NONMEMBER']).default('ALL'),
      suche: z.string().max(100).default(''),
      adrnrs: z.string().max(20000).default(''),
    }).parse(req.query);
    const auswahl = { filter: q.filter, suche: q.suche, adrnrs: q.adrnrs.split(',').map((x) => x.trim()).filter(Boolean) };
    const rows = auswaehlen(await teilnehmerLesen(DB), auswahl);
    const pdf = await teilnehmerPdf(await vereinLesen(), rows, auswahl);
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${teilnehmerTitel()}.pdf"`).send(pdf);
  });

  app.get('/teilnehmer/:adrnr', lesen, async (req) => {
    const { adrnr } = z.object({ adrnr: z.string().min(1).max(20) }).parse(req.params);
    return teilnehmerDetail(DB, adrnr);
  });

  /** mailto-Link für die markierten Teilnehmer (BCC) */
  app.post('/teilnehmer/mailto', lesen, async (req) => {
    const b = z.object({ adrnrs: z.array(z.string().min(1)).min(1, 'Bitte mindestens einen Teilnehmer markieren.') }).parse(req.body);
    const t = (await teilnehmerLesen(DB)).filter((x) => b.adrnrs.includes(x.adrnr));
    const url = mailtoLink(t.map((x) => x.email));
    return { url, anzahl: t.length, ohneEmail: t.filter((x) => !x.email).map((x) => x.name) };
  });
}
