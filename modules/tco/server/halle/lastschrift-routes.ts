import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { istTarget2Tag, plusTage } from '../../../../server/src/lib/sepa.js';
import type { Feldschutz } from '../../../../server/src/schutz.js';
import { bankdatenErforderlich, bankSchutz } from '../bankdaten.js';
import { DB, vereinLesen } from '../verein.js';
import { heute } from '../format.js';
import { konfigFehlt, konfigLesen, laufStornieren } from '../soll/logik.js';
import { ichLesen } from '../platz/logik.js';
import {
  halleLaeufeLesen, halleLastschriften, halleLaufErzeugen, halleLaufLesen, halleVorschlag, lsKonfigLesen, lsKonfigSpeichern, mandatWiderrufen,
  meineZahlart, personenMitRechnungen, zahlartenLesen, zahlartSetzen,
} from './lastschrift.js';

/** Hallenrechnungen per Lastschrift: Lauf, Mandate und Einstellungen (Verwaltung) sowie die Entscheidung der Hallenbucher (Portal) */
export const P_HALLE_LS = 'tco.halle:lastschrift';
const P_BUCHEN = 'tco.platzbuchung:edit';

const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');
const laufid = z.object({ id: z.string().regex(/^\d{1,10}$/) });
const adrnrP = z.object({ adrnr: z.string().regex(/^\d{1,10}$/) });
const pad = (id: string) => id.padStart(10, '0');
const benutzer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';

const entscheidung = z.object({
  zahlart: z.enum(['LASTSCHRIFT', 'UEBERWEISUNG']),
  mitglied: z.boolean().default(false),
  kontoinhaber: z.string().trim().max(70).nullish(),
  iban: z.string().max(42).nullish(),
  bic: z.string().max(11).nullish(),
  zustimmung: z.boolean().default(false),
});

/** Bankdaten der Zahler ohne Berechtigung maskieren */
function schuetzen<T extends Record<string, any>>(rows: T[], s: Feldschutz): T[] {
  if (s.klar) return rows;
  return rows.map((r) => ({
    ...r,
    ...('iban' in r ? { iban: s.iban(r.iban) } : {}),
    ...('bic' in r ? { bic: s.bic(r.bic) } : {}),
    ...('kontoinhaber' in r && r.kontoinhaber ? { kontoinhaber: s.freitext(r.kontoinhaber) } : {}),
  }));
}

/** Vorschlag Fälligkeit: nächster TARGET2-Tag frühestens in zwei Tagen (Vorlauf der Gläubigerdaten) */
function faelligVorschlag(vorlauf: number): string {
  let d = plusTage(heute(), Math.max(1, vorlauf));
  while (!istTarget2Tag(d)) d = plusTage(d, 1);
  return d;
}

export async function halleLastschriftRoutes(app: FastifyInstance) {
  const ls = { preHandler: requireAuth(P_HALLE_LS) };

  // ---------------------------------------------------------------- Portal: Entscheidung der Person
  app.get('/halle/zahlart/ich', { preHandler: requireAuth(P_BUCHEN) }, async (req) => {
    const i = req.user?.id ? await ichLesen(DB, req.user.id) : null;
    if (!i) return { fragen: false, aktiv: false, zahlart: null };
    return meineZahlart(DB, await vereinLesen(), i.adrnr, i.name);
  });

  app.post('/halle/zahlart/ich', { preHandler: requireAuth(P_BUCHEN) }, async (req) => {
    const e = entscheidung.parse(req.body);
    const i = req.user?.id ? await ichLesen(DB, req.user.id) : null;
    if (!i) throw new BusinessError('Ihr Benutzer ist keiner Person zugeordnet – bitte beim Verein melden.', 403);
    const cfg = await lsKonfigLesen(DB);
    if (!cfg.aktiv && e.zahlart === 'LASTSCHRIFT') throw new BusinessError('Die Lastschrift für Hallenrechnungen ist derzeit nicht eingeschaltet.');
    const v = await vereinLesen();
    return change(req, (tx) => zahlartSetzen(tx, v, i.adrnr, e, { name: i.name, benutzerId: i.benutzerId, ip: req.ip }),
      { action: 'HALLE_ZAHLART', reason: e.zahlart === 'LASTSCHRIFT' ? 'SEPA-Mandat im Portal erteilt' : 'Überweisung gewählt' });
  });

  // ---------------------------------------------------------------- Verwaltung
  app.get('/halle/lastschrift/init', ls, async () => {
    const v = await vereinLesen();
    const gl = await konfigLesen(DB, v);
    return { cfg: await lsKonfigLesen(DB), fehlt: konfigFehlt(gl), glaeubigerId: gl.gl_id, laeufe: await halleLaeufeLesen(DB), faellig: faelligVorschlag(gl.vorlauf) };
  });

  app.put('/halle/lastschrift/cfg', ls, async (req) => {
    const c = z.object({
      aktiv: z.boolean(),
      vorankuendigung: z.coerce.number().int().min(1).max(30),
      gebuehr: z.coerce.number().min(0).max(100).nullable(),
      gebuehr_konto: z.string().trim().min(1, 'Bitte ein Konto für die Gebühr angeben').max(10),
    }).parse(req.body);
    if (c.aktiv) {
      const fehlt = konfigFehlt(await konfigLesen(DB, await vereinLesen()));
      if (fehlt.length) throw new BusinessError(`Vor dem Einschalten bitte die Gläubigerdaten ergänzen (Einstellungen → Beitragseinzug): ${fehlt.join(', ')}.`);
    }
    await change(req, (tx) => lsKonfigSpeichern(tx, c, benutzer(req)));
    return { text: c.aktiv ? 'Gespeichert – Hallenbucher werden beim nächsten Aufruf nach der Zahlart gefragt.' : 'Gespeichert.' };
  });

  app.get('/halle/lastschrift/zahlarten', ls, async (req) => {
    const sb = bankSchutz(req);
    return { zahlarten: schuetzen(await zahlartenLesen(DB), sb), personen: await personenMitRechnungen(DB), bankKlar: sb.klar };
  });

  /** Verwaltung: Papiermandat erfassen bzw. Überweisung eintragen */
  app.post('/halle/lastschrift/zahlarten', ls, async (req) => {
    const b = entscheidung.extend({ adrnr: z.string().regex(/^\d{1,10}$/), mandatsdatum: datum.nullish() }).parse(req.body);
    const adrnr = b.adrnr.padStart(10, '0');
    const v = await vereinLesen();
    return change(req, (tx) => zahlartSetzen(tx, v, adrnr, { ...b, zustimmung: true }, { name: benutzer(req), benutzerId: req.user?.id ?? null, verwaltung: true }),
      { action: 'HALLE_ZAHLART', reason: 'durch die Verwaltung erfasst' });
  });

  app.post('/halle/lastschrift/zahlarten/:adrnr/widerruf', ls, async (req) => {
    const adrnr = adrnrP.parse(req.params).adrnr.padStart(10, '0');
    const { grund } = z.object({ grund: z.string().trim().min(1, 'Bitte einen Grund angeben').max(200) }).parse(req.body);
    const text = await change(req, (tx) => mandatWiderrufen(tx, adrnr, grund, benutzer(req)), { action: 'HALLE_MANDAT_WIDERRUF', reason: grund });
    return { text };
  });

  app.post('/halle/lastschrift/vorschlag', ls, async (req) => {
    const { faellig } = z.object({ faellig: datum }).parse(req.body);
    const v = await halleVorschlag(DB, faellig);
    const sb = bankSchutz(req);
    return { pos: schuetzen(v.pos, sb), excl: schuetzen(v.excl, sb), tx: schuetzen(halleLastschriften(v.pos, null), sb), bankKlar: sb.klar };
  });

  app.post('/halle/lastschrift/laeufe', ls, async (req) => {
    const b = z.object({ faellig: datum, ohne: z.array(z.string()).default([]) }).parse(req.body);
    if (!istTarget2Tag(b.faellig)) throw new BusinessError('Die Fälligkeit muss ein Bankarbeitstag (TARGET2) sein.');
    const cfg = await konfigLesen(DB, await vereinLesen());
    const r = await change(req, (tx) => halleLaufErzeugen(tx, cfg, b, benutzer(req)), { action: 'HALLE_LASTSCHRIFT' });
    if (!r.laufid) return { ok: false, meldungen: r.meldungen, text: 'Die Lastschriftdatei wurde nicht erzeugt. Details siehe Prüfmeldungen.' };
    return { ok: true, laufid: r.laufid, meldungen: r.meldungen, text: `Lauf ${Number(r.laufid)} erzeugt (${r.anzahl} Rechnungen, ${r.summe?.toFixed(2).replace('.', ',')} €) – Datei wird heruntergeladen.` };
  });

  app.get('/halle/lastschrift/laeufe/:id', ls, async (req) => {
    const l = await halleLaufLesen(DB, pad(laufid.parse(req.params).id));
    const sb = bankSchutz(req);
    return { ...l, pos: schuetzen(l.pos as unknown as Record<string, any>[], sb), bankKlar: sb.klar };
  });

  // Die SEPA-Datei enthält alle IBANs im Klartext → zusätzlich Bankdaten-Berechtigung
  app.get('/halle/lastschrift/laeufe/:id/datei', ls, async (req, reply) => {
    bankdatenErforderlich(bankSchutz(req), 'Die SEPA-Lastschriftdatei');
    const id = pad(laufid.parse(req.params).id);
    const [k] = await DB`select xml, status from tco.soll_kopf where laufid = ${id} and typ = 'HALLE'`;
    if (!k?.xml) throw new BusinessError('Zu diesem Lauf ist keine Datei gespeichert.');
    if (k.status === 'S') throw new BusinessError('Der Lauf ist storniert.');
    return reply.type('application/xml; charset=utf-8')
      .header('content-disposition', `attachment; filename="TCO_Hallenlastschrift_${Number(id)}.xml"`).send(k.xml);
  });

  app.post('/halle/lastschrift/laeufe/:id/storno', ls, async (req) => {
    const id = pad(laufid.parse(req.params).id);
    const { grund } = z.object({ grund: z.string().trim().min(1, 'Bitte eine Begründung angeben').max(200) }).parse(req.body);
    const [k] = await DB`select typ from tco.soll_kopf where laufid = ${id}`;
    if (k?.typ !== 'HALLE') throw new BusinessError('Lauf nicht gefunden.');
    await change(req, (tx) => laufStornieren(tx, id), { action: 'STORNO', reason: grund });
    return { text: `Lauf ${Number(id)} storniert – die Rechnungen sind wieder für einen Lauf frei.` };
  });
}
