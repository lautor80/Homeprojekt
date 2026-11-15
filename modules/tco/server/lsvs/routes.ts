import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { DB, plAktiv, vereinLesen, type Db } from '../verein.js';
import { heute } from '../format.js';
import { BESTAETIGUNG, bestandLesen, bestandPruefen, bestandXml, dateiname, stichtagStandard, type Bestand } from './logik.js';
import { lsvsAblegen, lsvsPdf, lsvsTitel, type LaufInfo } from './pdf.js';

/**
 * App „LSVS-Bestandsmeldung“: Übersicht zum Stichtag prüfen und bestätigen, dann einen Lauf erzeugen –
 * Austauschdatei (XML) für das LSVSnet, Ausdruck im TCO-Layout, Ablage in Paperless; Übersicht der Läufe.
 */
export const P_LSVS = { display: 'tco.lsvs:display', execute: 'tco.lsvs:execute', admin: 'tco.lsvs:admin' };

const benutzer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';
const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');
const stichtagQ = (q: unknown) => z.object({ stichtag: datum.optional() }).parse(q).stichtag ?? stichtagStandard(heute());
const pId = z.object({ id: z.coerce.number().int().positive() });

interface LaufZeile extends LaufInfo {
  stichtag: string; bestaetigt: string; kopf: Bestand['kopf']; zeilen: Bestand['zeilen']; summe: Bestand['summe'];
  hinweise: Bestand['hinweise']; paperless_id: number | null; paperless_am: string | null;
}

async function laufLesen(db: Db, id: number): Promise<LaufZeile & { xml: string }> {
  const [l] = await db`select id, stichtag::text as stichtag, erstellt_am::text as erstellt_am, erstellt_von, bestaetigt, kopf, zeilen, summe, hinweise,
                              dateiname, xml, paperless_id, paperless_am::text as paperless_am
                         from tco.lsvs_laeufe where id = ${id}`;
  if (!l) throw new BusinessError('Lauf nicht gefunden.', 404);
  return l as unknown as LaufZeile & { xml: string };
}
const alsBestand = (l: LaufZeile): Bestand => ({ stichtag: l.stichtag, pruefsumme: '', kopf: l.kopf, zeilen: l.zeilen, summe: l.summe, hinweise: l.hinweise, fehlt: [] });

/** Ausdruck ablegen und am Lauf vermerken; ein Fehler von Paperless lässt den Lauf bestehen */
async function ablegen(l: LaufZeile, wer: string) {
  const v = await vereinLesen();
  if (!plAktiv(v)) return { abgelegt: false, text: 'Paperless ist nicht eingerichtet – der Ausdruck wurde nicht abgelegt.', warnungen: [] as string[] };
  try {
    const r = await lsvsAblegen(v, alsBestand(l), l, wer);
    if (!r.id) return { abgelegt: false, text: 'Hochgeladen, die DOKID ist aber noch nicht verfügbar – bitte später erneut ablegen.', warnungen: r.warnungen };
    await DB`update tco.lsvs_laeufe set paperless_id = ${r.id}, paperless_am = now() where id = ${l.id}`;
    return { abgelegt: true, text: `„${r.titel}“ in Paperless abgelegt (DOKID ${String(r.id).padStart(6, '0')}).`, warnungen: r.warnungen };
  } catch (e) {
    return { abgelegt: false, text: `Ablage in Paperless fehlgeschlagen: ${(e as Error).message}`, warnungen: [] as string[] };
  }
}

const EINSTELLUNGEN = z.object({
  lsvs_vereinsnr: z.string().trim().max(20).nullish().transform((x) => x || null),
  lsvs_ansprechpartner: z.string().trim().min(1, 'Bitte einen Ansprechpartner angeben').max(100),
  lsvs_fachverband: z.string().trim().regex(/^\d{1,4}$/, 'Fachverbandscode: 1 bis 4 Ziffern'),
  lsvs_schluessel: z.string().trim().min(1, 'Bitte den Software-Schlüssel angeben').max(60),
});

export async function lsvsRoutes(app: FastifyInstance) {
  const lesen = { preHandler: requireAuth(P_LSVS.display) };
  const ausfuehren = { preHandler: requireAuth(P_LSVS.execute) };
  const admin = { preHandler: requireAuth(P_LSVS.admin) };

  /** Übersicht zum Stichtag (Zahlen, Kopf, nicht gemeldete Mitglieder) mit Prüfsumme und Bestätigungstext */
  app.get('/lsvs/vorschau', lesen, async (req) => {
    const b = await bestandLesen(DB, stichtagQ(req.query));
    const [n] = await DB`select count(*)::int as n from tco.lsvs_laeufe where stichtag = ${b.stichtag}`;
    return { ...b, bestaetigung: BESTAETIGUNG, paperless: plAktiv(await vereinLesen()), laeufe_zum_stichtag: n.n };
  });

  /** Ausdruck der Übersicht als Voransicht (noch ohne Lauf) */
  app.get('/lsvs/vorschau/pdf', lesen, async (req, reply) => {
    const { pdf, titel } = await lsvsPdf(await vereinLesen(), await bestandLesen(DB, stichtagQ(req.query)));
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${titel.replace(/[^\wäöüÄÖÜß .()-]/g, '_')}.pdf"`).send(pdf);
  });

  app.get('/lsvs/laeufe', lesen, async () => DB`
    select id, stichtag::text as stichtag, erstellt_am::text as erstellt_am, erstellt_von, dateiname, summe, jsonb_array_length(hinweise) as nicht_gemeldet,
           kopf->>'nummer' as vereinsnr, paperless_id, paperless_am::text as paperless_am
      from tco.lsvs_laeufe order by id desc`);

  /** Lauf erzeugen – nur nach bestätigter Übersicht, die sich seither nicht geändert hat */
  app.post('/lsvs/laeufe', ausfuehren, async (req) => {
    const d = z.object({
      stichtag: datum, pruefsumme: z.string().min(1),
      bestaetigt: z.literal(true, { errorMap: () => ({ message: 'Bitte zuerst die Übersicht prüfen und bestätigen.' }) }),
    }).parse(req.body);
    const b = await bestandLesen(DB, d.stichtag);
    if (b.pruefsumme !== d.pruefsumme) throw new BusinessError('Die Zahlen haben sich seit der angezeigten Übersicht geändert – bitte die Übersicht neu laden und erneut bestätigen.', 409);
    bestandPruefen(b);
    const wer = benutzer(req);
    const id = await change(req, async (tx) => {
      const [{ id: neu }] = await tx`select nextval(pg_get_serial_sequence('tco.lsvs_laeufe', 'id'))::int as id`;
      await tx`insert into tco.lsvs_laeufe (id, stichtag, erstellt_von, bestaetigt, kopf, zeilen, summe, hinweise, dateiname, xml)
               values (${neu}, ${b.stichtag}, ${wer}, ${BESTAETIGUNG}, ${tx.json(b.kopf as never)}, ${tx.json(b.zeilen as never)}, ${tx.json(b.summe as never)},
                       ${tx.json(b.hinweise as never)}, ${dateiname(b.stichtag, neu)}, ${bestandXml(b)})`;
      return neu as number;
    }, { action: 'LSVS_LAUF' });
    const l = await laufLesen(DB, id);
    const pl = await ablegen(l, wer);
    return { id, dateiname: l.dateiname, summe: b.summe, paperless: pl, text: `Lauf ${id} erzeugt: ${b.summe.gesamt} Mitglieder zum ${b.stichtag.split('-').reverse().join('.')}.` };
  });

  app.get('/lsvs/laeufe/:id/xml', lesen, async (req, reply) => {
    const l = await laufLesen(DB, pId.parse(req.params).id);
    return reply.type('application/xml; charset=utf-8').header('content-disposition', `attachment; filename="${l.dateiname}"`).send(l.xml);
  });

  app.get('/lsvs/laeufe/:id/pdf', lesen, async (req, reply) => {
    const l = await laufLesen(DB, pId.parse(req.params).id);
    const { pdf } = await lsvsPdf(await vereinLesen(), alsBestand(l), l);
    const titel = lsvsTitel(l.stichtag, l.id);
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${titel.replace(/[^\wäöüÄÖÜß .()-]/g, '_')}.pdf"`).send(pdf);
  });

  /** Ausdruck eines Laufs (erneut) in Paperless ablegen */
  app.post('/lsvs/laeufe/:id/paperless', ausfuehren, async (req) => {
    const l = await laufLesen(DB, pId.parse(req.params).id);
    const r = await ablegen(l, benutzer(req));
    if (!r.abgelegt) throw new BusinessError(r.text);
    return r;
  });

  // ---------------------------------------------------------------- Einstellungen (Kopf der Austauschdatei)
  app.get('/lsvs/einstellungen', admin, async () => {
    const [v] = await DB`select lsvs_vereinsnr, lsvs_ansprechpartner, lsvs_fachverband, lsvs_schluessel from tco.verein where id = 1`;
    return v;
  });
  app.put('/lsvs/einstellungen', admin, async (req) => {
    const d = EINSTELLUNGEN.parse(req.body);
    await change(req, (tx) => tx`
      update tco.verein set lsvs_vereinsnr = ${d.lsvs_vereinsnr}, lsvs_ansprechpartner = ${d.lsvs_ansprechpartner},
             lsvs_fachverband = ${d.lsvs_fachverband}, lsvs_schluessel = ${d.lsvs_schluessel}, updated_at = now()
       where id = 1`);
    return { ok: true };
  });
}
