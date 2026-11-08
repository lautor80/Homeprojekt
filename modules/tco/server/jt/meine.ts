import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { DB, paperless, plAktiv, vereinLesen } from '../verein.js';
import { runden } from '../format.js';
import {
  abrechnung, ARTEN, dokuLesen, ferienLesen, grenzen, istBezahlt, monatsname, saetzeLesen, satzAm, tageGenerieren, trainerLesen,
  zeitenLesen, zeitLoeschen, zeitSetzen, type Trainer,
} from './logik.js';
import { nachweisDaten, nachweisPdf } from './nachweis.js';

/**
 * „Meine Trainingszeiten“ – Rückmeldung durch die Trainer selbst (fürs Handy).
 *
 * Sicherheit: Der Trainer wird AUSSCHLIESSLICH aus dem angemeldeten Benutzer ermittelt
 * (tco.mitgliedera.benutzer_id). Keine Route nimmt eine Adressnummer entgegen; fremde Zeiten,
 * Beträge oder Nachweise sind damit weder lesbar noch änderbar. Bezahlte Monate sind gesperrt.
 */
export const P_JTM = { edit: 'tco.jtmeine:edit' };

const monat = z.string().regex(/^\d{4}(0[1-9]|1[0-2])$/, 'Bitte einen Monat wählen.');
const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');
const art = z.enum(ARTEN);

/** Trainer des angemeldeten Benutzers – sonst 403 */
export async function meinTrainer(req: FastifyRequest): Promise<Trainer> {
  const id = req.user?.id;
  if (!id) throw new BusinessError('Bitte mit einem persönlichen Benutzer anmelden.', 403);
  const [a] = await DB`select adrnr from tco.mitgliedera where benutzer_id = ${id} and trainer`;
  if (!a) throw new BusinessError('Ihr Benutzer ist keinem Trainer zugeordnet. Bitte bei der Jugendleitung melden (Zuordnung unter Abrechnung Jugendtraining → Entgelte).', 403);
  const t = (await trainerLesen(DB)).find((x) => x.adrnr === a.adrnr);
  if (!t) throw new BusinessError('Trainer nicht gefunden.', 403);
  return t;
}

/** Änderungen nur in noch nicht bezahlten Monaten */
async function monatOffen(adrnr: string, d: string) {
  const m = d.slice(0, 7).replace('-', '');
  const doku = await dokuLesen(DB, adrnr, m);
  const eigene = (await zeitenLesen(DB, m)).filter((z) => z.adrnr === adrnr);
  const betrag = runden(eigene.reduce((s, z) => s + z.betrag, 0));
  if (istBezahlt(doku, betrag)) {
    throw new BusinessError(`Der ${monatsname(m)} ist bereits abgerechnet und bezahlt – Änderungen bitte über die Jugendleitung.`);
  }
}

export async function meineZeitenRoutes(app: FastifyInstance) {
  const recht = { preHandler: requireAuth(P_JTM.edit) };

  app.get('/jt/meine/monat', recht, async (req) => {
    const t = await meinTrainer(req);
    const q = z.object({ monat }).parse(req.query);
    const { von, bis } = grenzen(q.monat);
    const s = await saetzeLesen(DB);
    const zeiten = (await zeitenLesen(DB, q.monat, s)).filter((x) => x.adrnr === t.adrnr).map(({ zalias: _z, ...x }) => x);
    const ferien = (await ferienLesen(DB, Number(q.monat.slice(0, 4)))).filter((f) => f.datum >= von && f.datum <= bis);
    const [abr] = await abrechnung(DB, q.monat, zeiten.map((x) => ({ ...x, zalias: '' })), [t]);
    const doku = await dokuLesen(DB, t.adrnr, q.monat);
    const betrag = runden(zeiten.reduce((x, z) => x + z.betrag, 0));
    return {
      monat: q.monat, titel: monatsname(q.monat), von, bis, arten: ARTEN, ferien,
      trainer: { name: t.name, satz: satzAm(s, t.adrnr, bis) || t.satz },
      zeiten, stunden: runden(zeiten.reduce((x, z) => x + z.anzahl, 0)), betrag,
      status: abr ? { text: abr.status.replace(/ · DOKID \d+$/, ''), state: abr.state } : { text: 'Keine Stunden', state: 'None' },
      nachweis: doku?.doc_id ? { belegnr: doku.belegnr, erstellt_am: doku.erstellt_am, bezahlt_am: doku.bezahlt_am } : null,
      gesperrt: istBezahlt(doku, betrag),
    };
  });

  /** Archiv: alle Monate mit abgelegtem Zeitnachweis (nur eigene) */
  app.get('/jt/meine/nachweise', recht, async (req) => {
    const t = await meinTrainer(req);
    const rows = await DB`select monat, belegnr, to_char(erstellt_am, 'YYYY-MM-DD') as erstellt_am, to_char(bezahlt_am, 'YYYY-MM-DD') as bezahlt_am,
                                 coalesce(stunden, 0)::float8 as stunden, coalesce(betrag, 0)::float8 as betrag
                            from tco.jt_doku where adrnr = ${t.adrnr} and doc_id is not null order by monat desc limit 36`;
    return rows.map((r) => ({ monat: r.monat, titel: monatsname(r.monat), belegnr: r.belegnr, erstellt_am: r.erstellt_am, bezahlt_am: r.bezahlt_am, stunden: Number(r.stunden), betrag: Number(r.betrag) }));
  });

  app.post('/jt/meine/zeiten', recht, async (req) => {
    const t = await meinTrainer(req);
    const b = z.object({ datum, trainingsart: art, anzahl: z.coerce.number(), altArt: art.nullish() }).parse(req.body);
    await monatOffen(t.adrnr, b.datum);
    await change(req, (tx) => zeitSetzen(tx, { adrnr: t.adrnr, ...b }), { action: 'JT_RUECKMELDUNG' });
    return { ok: true };
  });

  app.post('/jt/meine/zeiten/loeschen', recht, async (req) => {
    const t = await meinTrainer(req);
    const b = z.object({ datum, trainingsart: art }).parse(req.body);
    await monatOffen(t.adrnr, b.datum);
    await change(req, (tx) => zeitLoeschen(tx, t.adrnr, b.datum, b.trainingsart), { action: 'JT_RUECKMELDUNG' });
    return { ok: true };
  });

  app.post('/jt/meine/generieren', recht, async (req) => {
    const t = await meinTrainer(req);
    const b = z.object({ monat, wochentage: z.array(z.number().int().min(1).max(7)), trainingsart: art.default('Jugendtraining') }).parse(req.body);
    await monatOffen(t.adrnr, grenzen(b.monat).von);
    const n = await change(req, (tx) => tageGenerieren(tx, t.adrnr, b.monat, b.wochentage, b.trainingsart), { action: 'JT_RUECKMELDUNG' });
    return { text: n ? `${n} Trainingstag(e) angelegt – bitte noch die Dauer eintragen.` : 'Alle gewählten Tage sind bereits erfasst.' };
  });

  /** Voransicht des Zeitnachweises mit dem aktuellen Stand */
  app.get('/jt/meine/nachweis/pdf', recht, async (req, reply) => {
    const t = await meinTrainer(req);
    const q = z.object({ monat }).parse(req.query);
    const { kopf, zeilen } = await nachweisDaten(DB, t.adrnr, q.monat);
    const pdf = await nachweisPdf(await vereinLesen(), kopf, zeilen);
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${kopf.belegnr}.pdf"`).send(pdf);
  });

  /** abgelegter Zeitnachweis (neueste Fassung aus Paperless) */
  app.get('/jt/meine/nachweis/dokument', recht, async (req, reply) => {
    const t = await meinTrainer(req);
    const q = z.object({ monat }).parse(req.query);
    const d = await dokuLesen(DB, t.adrnr, q.monat);
    if (!d?.doc_id) throw new BusinessError('Zu diesem Monat ist noch kein Zeitnachweis abgelegt.');
    const v = await vereinLesen();
    if (!plAktiv(v)) throw new BusinessError('Paperless ist nicht eingerichtet.');
    const pl = paperless(v);
    const f = await pl.download(await pl.neuesteVersion(d.doc_id));
    return reply.type(f.contentType).header('content-disposition', `inline; filename="${d.belegnr ?? f.filename}.pdf"`).send(f.data);
  });
}
