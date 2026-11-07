import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { DB, plAktiv, vereinLesen } from '../verein.js';
import { heute } from '../format.js';
import {
  istBeitragsmonat, konfigFehlt, konfigLesen, konfigSpeichern, laeufeLesen, lastschriften, laufErzeugen, laufLesen,
  laufStornieren, vorschlag, vorschlagFaelligkeit,
} from './logik.js';
import { sollAblegen, sollPdf, sollTitel } from './pdf.js';

export const P_SOLL = {
  display: 'tco.soll:display',
  edit: 'tco.soll:edit',
  glaeubiger: 'tco.soll:glaeubiger',
};

const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');
const sollper = z.string().regex(/^\d{4}(0[1-9]|1[0-2])$/, 'Bitte einen Sollmonat wählen.');
const laufid = z.object({ id: z.string().regex(/^\d{1,10}$/) });
const benutzer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';
const pad = (id: string) => id.padStart(10, '0');

/** Sollmonat-Vorbelegung: bis zum 15. der laufende Monat, danach der Folgemonat */
function sollperVorschlag(): string {
  const d = new Date();
  if (d.getDate() > 15) d.setMonth(d.getMonth() + 1, 1);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export async function sollRoutes(app: FastifyInstance) {
  app.get('/soll/init', { preHandler: requireAuth(P_SOLL.display) }, async () => {
    const cfg = await konfigLesen(DB, await vereinLesen());
    const sp = sollperVorschlag();
    return {
      cfg, fehlt: konfigFehlt(cfg), laeufe: await laeufeLesen(DB),
      vorschlag: { sollper: sp, faellig: vorschlagFaelligkeit(heute(), cfg.vorlauf, sp), mitMb: istBeitragsmonat(sp), mitJt: true },
    };
  });

  app.put('/soll/cfg', { preHandler: requireAuth(P_SOLL.glaeubiger) }, async (req) => {
    const c = z.object({
      gl_name: z.string().trim().max(70), iban: z.string().max(40), bic: z.string().max(11).default(''),
      gl_id: z.string().max(35), bankkonto: z.string().max(10), vorlauf: z.coerce.number().int().min(0).max(30).default(2),
    }).parse(req.body);
    await change(req, (tx) => konfigSpeichern(tx, c, benutzer(req)));
    return { text: 'Gläubigerdaten gespeichert.' };
  });

  app.get('/soll/faelligkeit', { preHandler: requireAuth(P_SOLL.display) }, async (req) => {
    const q = z.object({ sollper }).parse(req.query);
    const cfg = await konfigLesen(DB, await vereinLesen());
    return { faellig: vorschlagFaelligkeit(heute(), cfg.vorlauf, q.sollper), mitMb: istBeitragsmonat(q.sollper) };
  });

  app.post('/soll/vorschlag', { preHandler: requireAuth(P_SOLL.display) }, async (req) => {
    const b = z.object({ sollper, mitMb: z.boolean(), mitJt: z.boolean(), faellig: datum.nullish() }).parse(req.body);
    const v = await vorschlag(DB, b.sollper, b.mitMb, b.mitJt, b.faellig ?? null);
    return { ...v, tx: lastschriften(v.pos, null) };
  });

  app.post('/soll/laeufe', { preHandler: requireAuth(P_SOLL.edit) }, async (req) => {
    const b = z.object({ sollper, mitMb: z.boolean(), mitJt: z.boolean(), faellig: datum, ohne: z.array(z.string()).default([]) }).parse(req.body);
    const cfg = await konfigLesen(DB, await vereinLesen());
    const r = await change(req, (tx) => laufErzeugen(tx, cfg, b, benutzer(req)), { action: 'SOLLSTELLUNG' });
    if (!r.laufid) return { ok: false, meldungen: r.meldungen, text: 'Die Lastschriftdatei wurde nicht erzeugt. Details siehe „Prüfmeldungen“.' };
    return { ok: true, laufid: r.laufid, meldungen: r.meldungen, text: `Lauf ${Number(r.laufid)} erzeugt – Datei wird heruntergeladen.` };
  });

  app.get('/soll/laeufe/:id', { preHandler: requireAuth(P_SOLL.display) }, async (req) => laufLesen(DB, pad(laufid.parse(req.params).id)));

  app.get('/soll/laeufe/:id/datei', { preHandler: requireAuth(P_SOLL.edit) }, async (req, reply) => {
    const id = pad(laufid.parse(req.params).id);
    const [k] = await DB`select sollper, xml, status from tco.soll_kopf where laufid = ${id}`;
    if (!k?.xml) throw new BusinessError('Zu diesem Lauf ist keine Datei gespeichert.');
    if (k.status === 'S') throw new BusinessError('Der Lauf ist storniert.');
    return reply.type('application/xml; charset=utf-8')
      .header('content-disposition', `attachment; filename="TCO_Sollstellung_${Number(id)}_${k.sollper}.xml"`).send(k.xml);
  });

  app.post('/soll/laeufe/:id/storno', { preHandler: requireAuth(P_SOLL.edit) }, async (req) => {
    const id = pad(laufid.parse(req.params).id);
    const { grund } = z.object({ grund: z.string().trim().min(1, 'Bitte eine Begründung angeben') }).parse(req.body);
    await change(req, (tx) => laufStornieren(tx, id), { action: 'STORNO', reason: grund });
    return { text: `Lauf ${Number(id)} storniert.` };
  });

  const pdfDaten = async (id: string) => {
    const l = await laufLesen(DB, id);
    return { l, pdf: await sollPdf(await vereinLesen(), l.kopf as never, l.pos as never) };
  };

  app.get('/soll/laeufe/:id/pdf', { preHandler: requireAuth(P_SOLL.display) }, async (req, reply) => {
    const { l, pdf } = await pdfDaten(pad(laufid.parse(req.params).id));
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${sollTitel(l.kopf as never)}.pdf"`).send(pdf);
  });

  app.post('/soll/laeufe/:id/paperless', { preHandler: requireAuth(P_SOLL.edit) }, async (req) => {
    const id = pad(laufid.parse(req.params).id);
    const v = await vereinLesen();
    if (!plAktiv(v)) throw new BusinessError('Paperless ist nicht eingerichtet (TC Oberthal → Stammdaten).');
    const { l, pdf } = await pdfDaten(id);
    const r = await sollAblegen(v, l.kopf as never, pdf, benutzer(req));
    if (r.id && r.id !== l.kopf.pl_doc_id) await change(req, (tx) => tx`update tco.soll_kopf set pl_doc_id = ${r.id} where laufid = ${id}`);
    return r;
  });
}
