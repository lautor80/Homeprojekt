import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { DB, paperless, plAktiv, vereinLesen, type Verein } from '../verein.js';
import {
  absatzLesen, belegtextUebernehmen, chCfg, forderungBerechnen, forderungenLesen, getraenkeLesen, getraenkSpeichern, kandidatenIds,
  rechnen, rechnungenLesen, rechnungLesen, rechnungLoeschen, rechnungSpeichern, treffer, NAH_TAGE, type PlDoc,
} from './logik.js';
import { chTitel, clubhausAblegen, clubhausPdf } from './pdf.js';

export const P_CH = { display: 'tco.clubhaus:display', edit: 'tco.clubhaus:edit' };

const benutzer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';
const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');
const jahr = z.coerce.number().int().min(2000).max(2100);
const monat = z.coerce.number().int().min(1).max(12);
const posSchema = z.array(z.object({ produkt: z.string(), anzahl: z.coerce.number(), ekpreis: z.coerce.number(), ekpreis_vor: z.coerce.number().optional() }));

/** Monate „JJJJ-MM“ → Forderungsliste ab dem frühesten Monat je Jahr neu berechnen */
async function nachrechnen(tx: Parameters<typeof forderungBerechnen>[0], v: Verein, monate: string[]) {
  const je = new Map<number, number>();
  for (const m of monate) {
    const j = Number(m.slice(0, 4)), mo = Number(m.slice(5, 7));
    je.set(j, Math.min(je.get(j) ?? 12, mo));
  }
  for (const [j, mo] of [...je].sort((a, b) => a[0] - b[0])) await forderungBerechnen(tx, v, j, mo);
}

/** Paperless-Kandidaten (Belege des Wareneingangskontos) mit Betrag und Auftragsnummer */
async function plDocs(v: Verein, ids: { doknr: string; internenr: string | null }[]): Promise<PlDoc[]> {
  if (!ids.length) return [];
  const pl = paperless(v);
  const fB = await pl.feld(v.fi_feld_betrag);
  const fJ = await pl.feld(v.ch_feld_json);
  const out: PlDoc[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const docs = await pl.dokumenteSuchen({ id__in: chunk.map((x) => x.doknr).join(','), page_size: '100' });
    for (const d of docs) {
      const cf = (id?: number) => (d.custom_fields ?? []).find((x: { field: number }) => x.field === id)?.value ?? null;
      const b = String(cf(fB?.id) ?? '').replace(/^[A-Z]{3}/, '');
      const json = cf(fJ?.id) as string | null;
      const anr = json ? /"auftragsnummer"\s*:\s*"([^"]*)"/.exec(json)?.[1]?.trim() ?? '' : '';
      out.push({
        doknr: String(d.id), internenr: chunk.find((x) => x.doknr === String(d.id))?.internenr ?? null, titel: d.title ?? `Dokument ${d.id}`,
        created: String(d.created ?? '').slice(0, 10) || null, betrag: Number(b) || 0, auftragsnr: anr, json: json ? String(json) : null,
      });
    }
  }
  return out;
}

async function vergeben(): Promise<Map<string, string>> {
  return new Map((await DB`select doknr, rgnr from tco.werg_beleg`).map((x) => [x.doknr, x.rgnr]));
}

async function belegSichern(tx: Parameters<typeof forderungBerechnen>[0], rgnr: string, d: PlDoc, art: string) {
  await tx`insert into tco.werg_beleg (rgnr, doknr, internenr, zuord_art, titel, belegdatum, betrag, erdat)
           values (${rgnr}, ${d.doknr}, ${d.internenr}, ${art}, ${d.titel}, ${d.created}, ${d.betrag}, current_date)
           on conflict (rgnr, doknr) do update set internenr = excluded.internenr, zuord_art = excluded.zuord_art, titel = excluded.titel,
             belegdatum = excluded.belegdatum, betrag = excluded.betrag, erdat = excluded.erdat`;
}

export async function clubhausRoutes(app: FastifyInstance) {
  app.get('/clubhaus/init', { preHandler: requireAuth(P_CH.display) }, async (req) => {
    const q = z.object({ jahr }).parse(req.query);
    const v = await vereinLesen();
    const [r] = await DB`select min(extract(year from datum))::int as von, max(extract(year from datum))::int as bis from tco.werg`;
    const h = new Date().getFullYear();
    const jahre: number[] = [];
    for (let j = Math.max(h, r?.bis ?? h); j >= Math.min(r?.von ?? h, h); j--) jahre.push(j);
    return {
      jahr: q.jahr, jahre, cfg: chCfg(v), paperless: plAktiv(v),
      rechnungen: await rechnungenLesen(DB, q.jahr), forderungen: await forderungenLesen(DB, q.jahr),
    };
  });

  app.put('/clubhaus/cfg', { preHandler: requireAuth(P_CH.edit) }, async (req) => {
    const c = z.object({
      konto_einnahmen: z.string().trim().min(1).max(10), konto_ware: z.string().trim().min(1).max(10),
      reinigung: z.coerce.number().min(0).max(999), provision: z.coerce.number().min(0).max(100),
      wirt: z.string().trim().min(1).max(60), feld_json: z.string().trim().min(1).max(40),
    }).parse(req.body);
    await change(req, (tx) => tx`update tco.verein set ch_konto_einnahmen = ${c.konto_einnahmen}, ch_konto_ware = ${c.konto_ware},
      ch_reinigung = ${c.reinigung}, ch_provision = ${c.provision}, ch_wirt = ${c.wirt}, ch_feld_json = ${c.feld_json}, updated_at = now() where id = 1`);
    return { text: 'Einstellungen gespeichert – Forderungsliste bitte neu berechnen.' };
  });

  // ---------------------------------------------------------------- Rechnungen
  app.get('/clubhaus/rechnung', { preHandler: requireAuth(P_CH.display) }, async (req) => {
    const q = z.object({ rgnr: z.string().optional() }).parse(req.query);
    const r = await rechnungLesen(DB, q.rgnr || null);
    const belege = q.rgnr
      ? (await DB`select doknr, titel, to_char(belegdatum, 'YYYY-MM-DD') as belegdatum, betrag::float8 as betrag, zuord_art, to_char(erdat, 'YYYY-MM-DD') as erdat
                     from tco.werg_beleg where rgnr = ${q.rgnr} order by belegdatum, doknr`)
      : [];
    return { ...r, belege, plUrl: plAktiv(await vereinLesen()) ? await paperless(await vereinLesen()).baseUrl().catch(() => null) : null };
  });

  app.post('/clubhaus/rechnen', { preHandler: requireAuth(P_CH.display) }, async (req) => {
    const b = z.object({ pos: posSchema }).parse(req.body);
    return { pos: b.pos.map((p) => rechnen(p)) };
  });

  app.post('/clubhaus/rechnung', { preHandler: requireAuth(P_CH.edit) }, async (req) => {
    const b = z.object({ rgnrAlt: z.string().nullish(), rgnr: z.string().trim().min(1, 'Bitte eine Rechnungsnummer eingeben.').max(30), datum, pos: posSchema }).parse(req.body);
    const v = await vereinLesen();
    const r = await change(req, async (tx) => {
      const s = await rechnungSpeichern(tx, { rgnrAlt: b.rgnrAlt ?? null, rgnr: b.rgnr, datum: b.datum, pos: b.pos });
      await nachrechnen(tx, v, s.monate);
      return s;
    }, { action: 'GETRAENKERECHNUNG' });
    return { text: `Rechnung ${b.rgnr} gespeichert (${r.anzahl} Positionen), Forderungsliste nachgerechnet.` };
  });

  app.post('/clubhaus/rechnung/loeschen', { preHandler: requireAuth(P_CH.edit) }, async (req) => {
    const b = z.object({ rgnr: z.string().min(1) }).parse(req.body);
    const v = await vereinLesen();
    await change(req, async (tx) => nachrechnen(tx, v, await rechnungLoeschen(tx, b.rgnr)));
    return { text: `Rechnung ${b.rgnr} gelöscht, Forderungsliste nachgerechnet.` };
  });

  app.post('/clubhaus/belegtext', { preHandler: requireAuth(P_CH.edit) }, async (req) => {
    const b = z.object({ text: z.string().min(1, 'Kein Text vorhanden.'), pos: posSchema, rgnr: z.string().default(''), datum: z.string().default('') }).parse(req.body);
    const pos = (await rechnungLesen(DB, null)).pos;
    for (const p of b.pos) { const i = pos.findIndex((x) => x.produkt === p.produkt); const z0 = rechnen(p); if (i >= 0) pos[i] = z0; else pos.push(z0); }
    return belegtextUebernehmen(b.text, pos, { rgnr: b.rgnr, datum: b.datum });
  });

  // ---------------------------------------------------------------- Paperless-Belege
  app.get('/clubhaus/belege/kandidaten', { preHandler: requireAuth(P_CH.display) }, async (req) => {
    const q = z.object({ jahr, rgnr: z.string().default(''), datum: z.string().default('') }).parse(req.query);
    const v = await vereinLesen();
    if (!plAktiv(v)) return { kandidaten: [], offline: true };
    let docs: PlDoc[];
    try { docs = await plDocs(v, await kandidatenIds(DB, v, q.jahr)); } catch { return { kandidaten: [], offline: true }; }
    const verg = await vergeben();
    const k = docs
      .filter((d) => !verg.has(d.doknr))
      .map((d) => ({ ...d, tage: d.created && q.datum ? Math.round(Math.abs(Date.parse(d.created) - Date.parse(q.datum)) / 86_400_000) : 0 }))
      .filter((d) => d.tage <= NAH_TAGE)
      .sort((a, b) => a.tage - b.tage);
    return { kandidaten: k, offline: false };
  });

  app.post('/clubhaus/belege/zuordnen', { preHandler: requireAuth(P_CH.edit) }, async (req) => {
    const b = z.object({ rgnr: z.string().min(1, 'Bitte die Rechnung zuerst speichern.'), art: z.enum(['AUTO', 'M', 'I']), doknr: z.string().optional(), datum: z.string().default(''), brutto: z.coerce.number().default(0), jahr }).parse(req.body);
    const v = await vereinLesen();
    if (!plAktiv(v)) throw new BusinessError('Paperless ist nicht eingerichtet.');
    const [rg] = await DB`select 1 from tco.werg where rgnr = ${b.rgnr}`;
    if (!rg) throw new BusinessError('Bitte die Rechnung zuerst speichern.');
    const verg = await vergeben();
    let doc: PlDoc | undefined;
    let art = b.art as string;
    if (b.art === 'AUTO') {
      const t = treffer(await plDocs(v, await kandidatenIds(DB, v, b.jahr)), verg, { rgnr: b.rgnr, datum: b.datum, brutto: b.brutto });
      if (!t) throw new BusinessError('Kein passender Beleg gefunden (Auftragsnummer bzw. Betrag/Datum). Bitte aus der Liste manuell hinzufügen.');
      if (verg.get(t.doc.doknr) === b.rgnr) throw new BusinessError(`Der passende Beleg ${t.doc.doknr} ist bereits zugeordnet.`);
      doc = t.doc; art = t.art;
    } else {
      const id = String(Number(b.doknr ?? ''));
      if (!/^\d{1,6}$/.test(id) || id === '0') throw new BusinessError('Bitte eine gültige Paperless-Dokument-ID (Zahl, max. 6 Stellen) eingeben.');
      if (verg.has(id)) throw new BusinessError(verg.get(id) === b.rgnr ? `Dokument ${id} ist dieser Rechnung bereits zugeordnet.` : `Dokument ${id} ist bereits Rechnung ${verg.get(id)} zugeordnet.`);
      const map = (await kandidatenIds(DB, v, b.jahr)).find((x) => x.doknr === id);
      doc = (await plDocs(v, [{ doknr: id, internenr: map?.internenr ?? null }]))[0];
      if (!doc) throw new BusinessError(`Dokument ${id} wurde in Paperless nicht gefunden.`);
    }
    await change(req, (tx) => belegSichern(tx, b.rgnr, doc!, art));
    return { text: `Beleg ${doc.doknr} zugeordnet.`, json: doc.json };
  });

  app.post('/clubhaus/belege/loesen', { preHandler: requireAuth(P_CH.edit) }, async (req) => {
    const b = z.object({ rgnr: z.string(), doknr: z.string() }).parse(req.body);
    await change(req, (tx) => tx`delete from tco.werg_beleg where rgnr = ${b.rgnr} and doknr = ${b.doknr}`);
    return { text: `Zuordnung Beleg ${b.doknr} aufgehoben.` };
  });

  app.post('/clubhaus/belege/alle', { preHandler: requireAuth(P_CH.edit) }, async (req) => {
    const b = z.object({ jahr }).parse(req.body);
    const v = await vereinLesen();
    if (!plAktiv(v)) throw new BusinessError('Paperless ist nicht eingerichtet.');
    const docs = await plDocs(v, await kandidatenIds(DB, v, b.jahr));
    if (!docs.length) throw new BusinessError(`Keine Paperless-Belege über die FI-Zuordnung (Konto ${v.ch_konto_ware}) gefunden.`);
    const rgs = await rechnungenLesen(DB, b.jahr);
    const verg = await vergeben();
    let neu = 0;
    await change(req, async (tx) => {
      for (const lauf of [1, 2]) {
        for (const rg of rgs) {
          if ([...verg.values()].includes(rg.rgnr)) continue;
          const t = treffer(docs, verg, rg);
          if (!t || (lauf === 1 && t.art !== 'A')) continue;
          await belegSichern(tx, rg.rgnr, t.doc, t.art);
          verg.set(t.doc.doknr, rg.rgnr);
          neu++;
        }
      }
    });
    const offen = rgs.filter((r) => ![...verg.values()].includes(r.rgnr)).length;
    return { text: `${neu} Rechnung(en) neu zugeordnet, ${offen} ohne passenden Beleg.` };
  });

  app.get('/clubhaus/belege/:doknr/pdf', { preHandler: requireAuth(P_CH.display) }, async (req, reply) => {
    const { doknr } = z.object({ doknr: z.coerce.number().int().positive() }).parse(req.params);
    const pl = paperless(await vereinLesen());
    const d = await pl.download(await pl.neuesteVersion(doknr));
    return reply.type(d.contentType).header('content-disposition', `inline; filename="${d.filename}"`).send(d.data);
  });

  // ---------------------------------------------------------------- Forderungsliste
  app.post('/clubhaus/berechnen', { preHandler: requireAuth(P_CH.edit) }, async (req) => {
    const b = z.object({ jahr, monat }).parse(req.body);
    const v = await vereinLesen();
    await change(req, (tx) => forderungBerechnen(tx, v, b.jahr, b.monat), { action: 'CLUBHAUS_BERECHNEN' });
    return { text: `Forderungsliste ab ${String(b.monat).padStart(2, '0')}/${b.jahr} neu berechnet.` };
  });

  app.get('/clubhaus/pdf', { preHandler: requireAuth(P_CH.display) }, async (req, reply) => {
    const q = z.object({ jahr, monat }).parse(req.query);
    const { pdf } = await clubhausPdf(DB, await vereinLesen(), q.jahr, q.monat);
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${chTitel(q.jahr, q.monat)}.pdf"`).send(pdf);
  });

  app.post('/clubhaus/paperless', { preHandler: requireAuth(P_CH.edit) }, async (req) => {
    const b = z.object({ jahr, monat }).parse(req.body);
    const v = await vereinLesen();
    const { pdf, op } = await clubhausPdf(DB, v, b.jahr, b.monat);
    return clubhausAblegen(DB, v, b.jahr, b.monat, pdf, op, benutzer(req), (fn) => change(req, fn));
  });

  // ---------------------------------------------------------------- Absatz und Getränke
  app.get('/clubhaus/absatz', { preHandler: requireAuth(P_CH.display) }, async () => absatzLesen(DB, chCfg(await vereinLesen()).provision));

  app.get('/clubhaus/getraenke', { preHandler: requireAuth(P_CH.display) }, async () => getraenkeLesen(DB));

  app.post('/clubhaus/getraenke', { preHandler: requireAuth(P_CH.edit) }, async (req) => {
    const b = z.object({ prod_key: z.string().nullish(), text: z.string(), menge: z.coerce.number(), preis: z.coerce.number(), ab: datum }).parse(req.body);
    return { text: await change(req, (tx) => getraenkSpeichern(tx, { ...b, prod_key: b.prod_key ?? null })) };
  });

}
