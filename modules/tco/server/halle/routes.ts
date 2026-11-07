import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { DB, paperless, plAktiv, vereinLesen } from '../verein.js';
import { heute } from '../format.js';
import { kontaktLesen } from '../kommunikation.js';
import {
  aboEinzeln, aboSerie, adrnrErmitteln, autoBuchen, autoVorschau, irrelevant, kanalSichern, manuellePosition,
  personDetail, personenLesen, positionEntfernen, positionenLesen, positionenNummerieren, rechnungAnlegen,
  rechnungenLesen, statusSetzen, zuordnen, type Selektion,
} from './daten.js';
import { ep3Importieren, ep3UeberN8n } from './ep3.js';
import {
  mailTexte, mailVersand, paperlessNotiz, rechnungDrucken, rechnungPdfErzeugen, whatsappBestaetigen, whatsappText,
  whatsappVorbereiten, type Schreiber,
} from './versand.js';
import {
  fensterZusammenfassen, gueltigBis, preisePruefen, PREISGRUPPEN, type PflegeFenster, type PflegeProdukt,
} from './preis.js';

export const P_HALLE = {
  display: 'tco.halle:display',
  edit: 'tco.halle:edit',
  versand: 'tco.halle:versand',
  preise: 'tco.halle:preise',
};

const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const selSchema = z.object({
  status: z.string().optional().transform((s) => (s ? s.split(',').filter(Boolean) : [])),
  von: z.string().optional(),
  bis: z.string().optional(),
  buchungen: z.string().optional().transform((s) => s !== '0'),
});
const sel = (q: unknown): Selektion => {
  const s = selSchema.parse(q);
  return { status: s.status, druckVon: s.von || null, druckBis: s.bis || null, buchungen: s.buchungen };
};
/** „1,5“ → 1.5; leer → undefined */
const dezimal = (v: unknown) => (typeof v === 'string' ? (v.trim() === '' ? undefined : Number(v.trim().replace(/\./g, (m, i, t) => (t.includes(',') ? '' : m)).replace(',', '.'))) : v);
const w = (req: FastifyRequest): Schreiber => (fn) => change(req, fn);
const benutzer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';

export async function halleRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- Lesen
  app.get('/halle/personen', { preHandler: requireAuth(P_HALLE.display) }, async (req) => {
    return personenLesen(DB, await vereinLesen(), sel(req.query));
  });

  app.get('/halle/person', { preHandler: requireAuth(P_HALLE.display) }, async (req) => {
    const { kunde } = z.object({ kunde: z.string().min(1) }).parse(req.query);
    return personDetail(DB, await vereinLesen(), kunde, sel(req.query));
  });

  app.get('/halle/rechnungen/:rgnr', { preHandler: requireAuth(P_HALLE.display) }, async (req) => {
    const { rgnr } = z.object({ rgnr: z.string() }).parse(req.params);
    const [k] = await rechnungenLesen(DB, null, undefined, rgnr);
    if (!k) throw new BusinessError(`Rechnung ${rgnr} nicht gefunden`);
    return { kopf: k, positionen: await positionenLesen(DB, rgnr) };
  });

  /** Freigabelink und Notizen der jüngsten Fassung (READ_PAPERLESS_DETAILS) */
  app.get('/halle/rechnungen/:rgnr/paperless', { preHandler: requireAuth(P_HALLE.display) }, async (req) => {
    const { rgnr } = z.object({ rgnr: z.string() }).parse(req.params);
    const v = await vereinLesen();
    const [k] = await DB`select doknr from tco.rgkopf where rgnr_txt = ${rgnr}`;
    if (!k?.doknr || !plAktiv(v)) return { doknr: k?.doknr ?? null, link: null, notizen: [], versionen: [], ansicht: null };
    const pl = paperless(v);
    const id = Number(k.doknr);
    try {
      const versionen = await pl.versionen(id);
      const neueste = versionen[versionen.length - 1]?.id ?? id;
      return {
        doknr: k.doknr,
        link: await pl.freigabelink(neueste, 30),
        notizen: await pl.notizen(id),
        versionen,
        ansicht: await pl.ansichtUrl(id),
      };
    } catch (e) {
      return { doknr: k.doknr, link: null, notizen: [], versionen: [], ansicht: null, fehler: `Paperless-Dokument ${id} nicht lesbar – ${(e as Error).message}` };
    }
  });

  /** PDF einer Paperless-Fassung durchreichen */
  app.get('/halle/paperless/:id/pdf', { preHandler: requireAuth(P_HALLE.display) }, async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const d = await paperless(await vereinLesen()).download(id);
    return reply.type(d.contentType).header('content-disposition', `inline; filename="${d.filename}"`).send(d.data);
  });

  app.get('/halle/rechnungen/:rgnr/zahlungen', { preHandler: requireAuth(P_HALLE.display) }, async (req) => {
    const { rgnr } = z.object({ rgnr: z.string() }).parse(req.params);
    return DB`select z.fibeleg, z.betrag::float8 as betrag,
                     (select min(f.datum)::text from tco.fibuchungen f where f.internenr = z.fibeleg) as datum,
                     (select f.text from tco.fibuchungen f where f.internenr = z.fibeleg order by f.posnr limit 1) as text
                from tco.rgtz z where z.rgnr_txt = ${rgnr} order by 3`;
  });

  app.get('/halle/rechnungen/:rgnr/pdf', { preHandler: requireAuth(P_HALLE.display) }, async (req, reply) => {
    const { rgnr } = z.object({ rgnr: z.string() }).parse(req.params);
    const { pdf } = await rechnungPdfErzeugen(DB, await vereinLesen(), rgnr);
    return reply.type('application/pdf').header('content-disposition', `inline; filename="Rechnung_${rgnr}.pdf"`).send(pdf);
  });

  app.get('/halle/rechnungen/:rgnr/mailtext', { preHandler: requireAuth(P_HALLE.display) }, async (req) => {
    const { rgnr } = z.object({ rgnr: z.string() }).parse(req.params);
    const q = z.object({ rgnrs: z.string().optional() }).parse(req.query);
    const v = await vereinLesen();
    const [k] = await DB`select kunde, adrnr, doknr from tco.rgkopf where rgnr_txt = ${rgnr}`;
    if (!k) throw new BusinessError(`Rechnung ${rgnr} nicht gefunden`);
    const kontakt = await kontaktLesen(DB, k.adrnr ?? await adrnrErmitteln(DB, k.kunde));
    let link: string | null = null;
    if (k.doknr && plAktiv(v)) {
      try {
        const pl = paperless(v);
        link = await pl.freigabelink(await pl.neuesteVersion(Number(k.doknr)), 30);
      } catch { link = null; }
    }
    const rgnrs = q.rgnrs ? q.rgnrs.split(',') : [rgnr];
    return {
      an: kontakt?.email ?? '',
      mobil: kontakt?.mobil ?? '',
      link,
      ...mailTexte(v, kontakt?.vorname ?? '', rgnrs, rgnrs.length === 1 ? link : null),
      whatsapp: whatsappText(v, kontakt?.vorname ?? ''),
    };
  });

  // ---------------------------------------------------------------- Import
  app.post('/halle/import/datei', { preHandler: requireAuth(P_HALLE.edit), bodyLimit: 20 * 1024 * 1024 }, async (req) => {
    const { name, data } = z.object({ name: z.string(), data: z.string() }).parse(req.body);
    const buf = Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64');
    const r = await change(req, (tx) => ep3Importieren(tx, buf), { action: 'EP3_IMPORT', reason: name });
    return { ...r, datei: name };
  });

  app.post('/halle/import/n8n', { preHandler: requireAuth(P_HALLE.edit) }, async (req) => {
    const v = await vereinLesen();
    const j = await ep3UeberN8n(v, benutzer(req));
    const out: { datei: string; ok: boolean; text: string }[] = [];
    for (const [datei, inhalt] of [['Kunden', j.kunden_csv], ['Texte', j.texte_csv], ['Buchungen', j.bookings_csv]] as const) {
      if (!inhalt) continue;
      try {
        const r = await change(req, (tx) => ep3Importieren(tx, inhalt), { action: 'EP3_IMPORT', reason: `n8n ${datei}` });
        out.push({ datei, ok: r.ok, text: r.text });
      } catch (e) {
        out.push({ datei, ok: false, text: (e as Error).message });
      }
    }
    return out;
  });

  // ---------------------------------------------------------------- Rechnungen und Zuordnung
  app.post('/halle/rechnungen', { preHandler: requireAuth(P_HALLE.edit) }, async (req) => {
    const { kunde } = z.object({ kunde: z.string().min(1) }).parse(req.body);
    const rgnr = await change(req, (tx) => rechnungAnlegen(tx, kunde));
    return { rgnr_txt: rgnr };
  });

  app.post('/halle/zuordnen', { preHandler: requireAuth(P_HALLE.edit) }, async (req) => {
    const b = z.object({
      rgnr: z.string(), kunde: z.string().min(1),
      buchungen: z.array(z.object({ bid: z.string(), datum })).min(1),
    }).parse(req.body);
    const v = await vereinLesen();
    return change(req, async (tx) => {
      let rgnr = b.rgnr;
      if (rgnr === 'NEU') rgnr = await rechnungAnlegen(tx, b.kunde);
      const e = await zuordnen(tx, v, rgnr, b.buchungen);
      const teile: string[] = [];
      if (e.anzahl) teile.push(`${e.anzahl} Buchung(en) Rechnung ${rgnr} zugeordnet${e.preisfehler ? `, davon ${e.preisfehler} mit Preisfehler (0 €)` : ''}`);
      if (e.zukunft) teile.push(`${e.zukunft} zukünftige Buchung(en) nicht zugeordnet – erst nach dem Termin möglich`);
      if (!teile.length) teile.push('Keine Buchung zugeordnet');
      return { rgnr_txt: rgnr, ...e, text: teile.join('. ') };
    });
  });

  app.post('/halle/rechnungen/:rgnr/positionen', { preHandler: requireAuth(P_HALLE.edit) }, async (req) => {
    const { rgnr } = z.object({ rgnr: z.string() }).parse(req.params);
    const d = z.object({
      prod_key: z.string().min(1, 'Bitte ein Produkt auswählen'),
      beschreibung: z.string().max(40).nullish(),
      menge: z.preprocess(dezimal, z.number({ invalid_type_error: 'Bitte eine Menge als Zahl erfassen' })),
      preis: z.preprocess(dezimal, z.number({ invalid_type_error: 'Bitte einen Preis als Zahl erfassen' }).nullish()),
    }).parse(req.body);
    const v = await vereinLesen();
    const r = await change(req, (tx) => manuellePosition(tx, rgnr, d));
    const [k] = await DB`select doknr, versendet from tco.rgkopf where rgnr_txt = ${rgnr}`;
    if (k?.versendet) await paperlessNotiz(v, k.doknr, `Position ${r.rgpos} hinzugefügt am ${heute()} durch ${benutzer(req)}: ${d.prod_key} ${d.beschreibung ?? ''} × ${d.menge}`);
    return { ...r, text: [`Position ${r.rgpos} hinzugefügt (${r.betrag.toFixed(2).replace('.', ',')} EUR)`, ...r.hinweise].join('. ') };
  });

  app.delete('/halle/rechnungen/:rgnr/positionen/:pos', { preHandler: requireAuth(P_HALLE.edit) }, async (req) => {
    const p = z.object({ rgnr: z.string(), pos: z.coerce.number().int() }).parse(req.params);
    const { begruendung } = z.object({ begruendung: z.string().optional() }).parse(req.body ?? {});
    const v = await vereinLesen();
    const r = await change(req, (tx) => positionEntfernen(tx, p.rgnr, p.pos, begruendung), { reason: begruendung || undefined });
    if (r.kopf.versendet) {
      await paperlessNotiz(v, r.kopf.doknr, `Position ${p.pos} entfernt am ${heute()} durch ${benutzer(req)}. Begründung: ${begruendung}`);
    }
    return { text: `Position ${p.pos} entfernt` };
  });

  app.post('/halle/rechnungen/:rgnr/nummerieren', { preHandler: requireAuth(P_HALLE.edit) }, async (req) => {
    const { rgnr } = z.object({ rgnr: z.string() }).parse(req.params);
    const n = await change(req, (tx) => positionenNummerieren(tx, rgnr));
    return { text: `${n} Positionen neu nummeriert` };
  });

  app.post('/halle/rechnungen/:rgnr/status', { preHandler: requireAuth(P_HALLE.edit) }, async (req) => {
    const { rgnr } = z.object({ rgnr: z.string() }).parse(req.params);
    const { aktion, begruendung } = z.object({
      aktion: z.enum(['versendet', 'bezahlt', 'entsperren']), begruendung: z.string().optional(),
    }).parse(req.body);
    if (aktion === 'entsperren' && !begruendung?.trim()) throw new BusinessError('Bitte eine Begründung angeben');
    const v = await vereinLesen();
    const k = await change(req, (tx) => statusSetzen(tx, rgnr, aktion), { action: aktion.toUpperCase(), reason: begruendung });
    if (aktion === 'entsperren') await paperlessNotiz(v, k.doknr, `Rechnung wieder eröffnet am ${heute()} durch ${benutzer(req)}. Begründung: ${begruendung}`);
    return {
      text: aktion === 'versendet' ? `Rechnung ${rgnr} als versendet markiert`
        : aktion === 'bezahlt' ? 'Rechnung als gezahlt markiert und abgeschlossen'
          : `Rechnung ${rgnr} wieder eröffnet`,
    };
  });

  app.post('/halle/buchungen/aktion', { preHandler: requireAuth(P_HALLE.edit) }, async (req) => {
    const b = z.object({ bid: z.string(), datum, aktion: z.enum(['einzel', 'serie', 'irrelevant', 'relevant']) }).parse(req.body);
    await change(req, async (tx) => {
      if (b.aktion === 'einzel') await aboEinzeln(tx, b.bid);
      else if (b.aktion === 'serie') await aboSerie(tx, b.bid);
      else await irrelevant(tx, b.bid, b.datum, b.aktion === 'relevant');
    }, { action: `BUCHUNG_${b.aktion.toUpperCase()}` });
    const text = { einzel: `Buchung ${b.bid} auf Einzelabrechnung umgestellt`, serie: `Buchung ${b.bid} wieder als Abo-Serie abgerechnet`, irrelevant: `Buchung ${b.bid} als irrelevant markiert`, relevant: `Buchung ${b.bid} wieder offen` }[b.aktion];
    return { text };
  });

  app.get('/halle/irrelevant', { preHandler: requireAuth(P_HALLE.display) }, async (req) => {
    const { kunde } = z.object({ kunde: z.string() }).parse(req.query);
    return DB`select bid, min(datum)::text as datum, count(*)::int as termine, min(time_start)::text as time_start, min(time_ende)::text as time_ende,
                     max(status) as status
                from tco.bookings where kunde = ${kunde} and assigned = 'X' group by bid order by 2 desc limit 50`;
  });

  app.post('/halle/kanal', { preHandler: requireAuth(P_HALLE.edit) }, async (req) => {
    const { adrnr, kanal } = z.object({ adrnr: z.string(), kanal: z.enum(['E', 'W']) }).parse(req.body);
    const k = await kontaktLesen(DB, adrnr);
    await change(req, (tx) => kanalSichern(tx, k, kanal, benutzer(req)));
    return { text: `Bevorzugter Versand: ${kanal === 'E' ? 'E-Mail' : 'WhatsApp'}` };
  });

  app.get('/halle/auto', { preHandler: requireAuth(P_HALLE.edit) }, async () => autoVorschau(DB, await vereinLesen()));

  app.post('/halle/auto', { preHandler: requireAuth(P_HALLE.edit) }, async (req) => {
    const b = z.object({
      kunden: z.array(z.object({
        kunde: z.string(), ziel: z.string(),
        buchungen: z.array(z.object({ bid: z.string(), datum, ziel: z.string().optional() })),
      })),
    }).parse(req.body);
    const liste = b.kunden.filter((k) => k.buchungen.length);
    if (!liste.length) throw new BusinessError('Keine Buchung ausgewählt');
    const v = await vereinLesen();
    return change(req, (tx) => autoBuchen(tx, v, liste), { action: 'AUTO_ZUORDNUNG' });
  });

  // ---------------------------------------------------------------- Druck und Versand
  app.post('/halle/rechnungen/:rgnr/drucken', { preHandler: requireAuth(P_HALLE.versand) }, async (req) => {
    const { rgnr } = z.object({ rgnr: z.string() }).parse(req.params);
    const r = await rechnungDrucken(DB, await vereinLesen(), rgnr, w(req));
    return { docId: r.docId, link: r.link, text: r.message, warnungen: r.warnungen };
  });

  app.post('/halle/mail', { preHandler: requireAuth(P_HALLE.versand) }, async (req) => {
    const d = z.object({
      rgnrs: z.array(z.string()).min(1, 'Bitte mindestens eine Rechnung auswählen'),
      an: z.string().min(3, 'Bitte eine E-Mail-Adresse angeben'), cc: z.string().optional(),
      betreff: z.string().min(1), text: z.string().min(1), neudruck: z.boolean(), entwurf: z.boolean(),
    }).parse(req.body);
    return mailVersand(DB, await vereinLesen(), w(req), { ...d, benutzer: benutzer(req) });
  });

  app.post('/halle/whatsapp', { preHandler: requireAuth(P_HALLE.versand) }, async (req) => {
    const d = z.object({ rgnrs: z.array(z.string()), nummer: z.string(), text: z.string(), neudruck: z.boolean() }).parse(req.body);
    return whatsappVorbereiten(DB, await vereinLesen(), w(req), d);
  });

  app.post('/halle/whatsapp/bestaetigen', { preHandler: requireAuth(P_HALLE.versand) }, async (req) => {
    const d = z.object({
      nummer: z.string(), links: z.array(z.object({ rgnr: z.string(), link: z.string(), docId: z.number() })).min(1),
    }).parse(req.body);
    return whatsappBestaetigen(DB, await vereinLesen(), w(req), { ...d, benutzer: benutzer(req) });
  });

  // ---------------------------------------------------------------- Hallenpreise
  app.get('/halle/preise', { preHandler: requireAuth(P_HALLE.display) }, async () => {
    const produkte = await DB`select prod_key, valid_from::text, valid_to::text, text, preis::float8 as preis, typ
                                from tco.produkte where prod_key < '100' order by prod_key, valid_from`;
    const fenster = await DB`select prod_key, valid_from::text, tag, to_char(zeit_von, 'HH24:MI') as zeit_von, to_char(zeit_bis, 'HH24:MI') as zeit_bis
                               from tco.prmatrix where prod_key < '100' order by prod_key, valid_from, tag, zeit_von`;
    return { produkte, fenster, gruppen: PREISGRUPPEN };
  });

  const pflegeSchema = z.object({
    produkte: z.array(z.object({
      prod_key: z.string(), valid_from: z.string(), text: z.string(), preis: z.coerce.number(), typ: z.string().nullish(),
    })),
    fenster: z.array(z.object({ prod_key: z.string(), valid_from: z.string(), tag: z.string(), zeit_von: z.string(), zeit_bis: z.string() })),
  });

  app.post('/halle/preise/pruefen', { preHandler: requireAuth(P_HALLE.preise) }, async (req) => {
    const d = pflegeSchema.parse(req.body);
    return preisePruefen(d.produkte as PflegeProdukt[], d.fenster as PflegeFenster[]);
  });

  app.put('/halle/preise', { preHandler: requireAuth(P_HALLE.preise) }, async (req) => {
    const d = pflegeSchema.parse(req.body);
    const befunde = preisePruefen(d.produkte as PflegeProdukt[], d.fenster as PflegeFenster[]);
    const fehler = befunde.filter((b) => b.art === 'Fehler');
    if (fehler.length) throw new BusinessError(`Nicht gespeichert: ${fehler.length} Fehler – bitte zuerst „Prüfen“ ausführen.`);
    const bis = gueltigBis(d.produkte);
    const fenster = fensterZusammenfassen(d.fenster as PflegeFenster[]);
    await change(req, async (tx) => {
      const alt = new Map((await tx`select distinct on (prod_key) prod_key, typ from tco.produkte where prod_key < '100' order by prod_key, valid_from desc`)
        .map((r) => [r.prod_key as string, r.typ as string | null]));
      await tx`delete from tco.prmatrix where prod_key < '100'`;
      await tx`delete from tco.produkte where prod_key < '100'`;
      for (const p of d.produkte) {
        await tx`insert into tco.produkte (prod_key, valid_from, valid_to, text, preis, typ)
                 values (${p.prod_key}, ${p.valid_from}, ${bis.get(`${p.prod_key}|${p.valid_from}`)!}, ${p.text}, ${p.preis},
                         ${p.typ ?? alt.get(p.prod_key) ?? null})`;
      }
      for (const f of fenster) {
        await tx`insert into tco.prmatrix (prod_key, valid_from, valid_to, tag, zeit_von, zeit_bis)
                 values (${f.prod_key}, ${f.valid_from}, ${bis.get(`${f.prod_key}|${f.valid_from}`)!}, ${f.tag}, ${f.zeit_von}, ${f.zeit_bis})`;
      }
    }, { action: 'HALLENPREISE' });
    return { text: `Hallenpreise gespeichert: ${fenster.length} Zeitblöcke, ${d.produkte.length} Produktpreise`, befunde };
  });
}
