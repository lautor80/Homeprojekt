import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerModule } from '../../../server/src/module.js';
import { APP_ROOT } from '../../../server/src/config.js';
import { sql, type Tx } from '../../../server/src/db.js';
import { change, requireAuth } from '../../../server/src/auth.js';
import { BusinessError } from '../../../server/src/errors.js';
import {
  NR_AUFTRAG, NR_RECHNUNG, WERTE_TYPEN, adresseLesen, auftragLesen, firmaLesen, isoDate, leererStop, naechsteAdrnr,
  naechsteNummer, num, nummerVorschau, rechnungsbetrag, traegerVorschlag, werteLesen, type Adresse, type Stop,
} from './data.js';
import { condense, heute } from './format.js';
import { rechnungPdf } from './pdf/rechnung.js';
import { lieferscheinPdf, transportauftragPdf } from './pdf/dokumente.js';
import { xrechnungErzeugen } from './xrechnung.js';
import { FX_DATEI, pdfPruefen, zugferdXml } from './zugferd.js';
import { paperlessSenden } from './paperless.js';
import { dokumentAblegen, paperlessFirma } from './dokumente.js';
import { kontaktRoutes } from './kontakte.js';
import { kontaktErkennen } from './kontakterkennung.js';
import { bildText, pdfText } from '../../../server/src/lib/texterkennung.js';
import { TRANSPORT_KONTEXTE } from './paperless-kontexte.js';
import { ausfuehren, dekodieren, parsen, pruefen, type Geparst, type OhneZiel } from './importer.js';

export const P = {
  display: 'transport.auftraege:display',
  edit: 'transport.auftraege:edit',
  rechnung: 'transport.rechnungen:create',
  versand: 'transport.versand:execute',
  kontakte: 'transport.kontakte:edit',
  stammdaten: 'transport.stammdaten:edit',
  import: 'transport.import:execute',
};

// ---------------------------------------------------------------------------
// Eingabeprüfung
// ---------------------------------------------------------------------------
const txt = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);
const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().or(z.literal('')).transform((v) => v || null);
const betragS = z.coerce.number().finite().default(0);

const stopSchema = z.object({
  firma: txt(60), strasse: txt(60), land: txt(3), plzort: txt(60), ladenummer: txt(60), datum, zeit: txt(30),
  firma_e: txt(60), strasse_e: txt(60), land_e: txt(3), plzort_e: txt(60), datum_e: datum, zeit_e: txt(30),
});

const auftragSchema = z.object({
  anlagedatum: datum,
  leistungsdatum: datum,
  kunde: z.coerce.number().int().positive().nullish(),
  unternehmer: z.coerce.number().int().positive().nullish(),
  rechnungsempfaenger: z.coerce.number().int().positive().nullish(),
  ordernummer: txt(40),
  frachtpreis_ek: betragS,
  frachtpreis_vk: betragS,
  steuerrelevant: z.boolean(),
  steuerbefreiung: z.enum(['RC', 'DRITTLAND']).nullish(),
  dok_fehlen: z.boolean(),
  kennzeichen: txt(20),
  fahrzeugtyp: txt(10),
  ladegut: txt(10),
  gewicht: txt(10),
  lademeter: z.union([z.number(), z.string()]).nullish().transform((v) => {
    const s = String(v ?? '').trim().replace(',', '.');
    return s ? Number(s) : null;
  }).refine((v) => v === null || (Number.isFinite(v) && v >= 0 && v < 10000), 'Lademeter bitte als Zahl angeben.'),
  ladeweise: txt(10),
  palettentausch: txt(10),
  ladenummer: txt(30),
  besonderheiten: z.string().max(20000).nullish().transform((v) => (v ?? '').replace(/\s+$/, '') || null),
  stops: z.array(stopSchema).max(2).default([]),
  traeger: z.array(z.object({
    produkt: txt(20), prod_txt: txt(40), menge: z.coerce.number().int().min(0).default(0), preis: betragS,
  })).default([]),
});
type AuftragInput = z.infer<typeof auftragSchema>;

const adresseSchema = z.object({
  kundenname: z.string().trim().min(1, 'Bitte einen Namen angeben.').max(60),
  kundenname2: txt(60), anrede: txt(20), name: txt(40), vorname: txt(40), strasse: txt(60), hausnummer: txt(10),
  land: txt(3).transform((v) => v?.toUpperCase() ?? null), plz: txt(10), ort: txt(40), telefon: txt(30), fax: txt(30),
  email: txt(128), gln: txt(20), markt: txt(10), ustid: txt(20),
  force: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Speichern eines Auftrags (wie DETAIL_SAVE + ZCL_EU_AUFTRAG=>AUFTRAG_SPEICHERN)
// ---------------------------------------------------------------------------
async function auftragSchreiben(tx: Tx, nr: string, d: AuftragInput, typ: 'F' | 'H', neu: boolean) {
  const firma = await firmaLesen(tx);
  let stops = d.stops.map((s, i) => ({ ...leererStop(i + 1), ...s, pos: i + 1 })) as Stop[];

  if (typ === 'F') {
    // Empfangsort ist nur Pflicht, wenn beim jeweiligen Stop ein Empfänger (Firma) eingetragen ist
    const fehlt = stops.findIndex((s) => s.firma_e && !s.plzort_e);
    if (fehlt >= 0) {
      throw new BusinessError(`Beim ${fehlt === 0 ? 'ersten' : 'zweiten'} Stop ist ein Empfänger eingetragen - bitte auch Land / PLZ Ort angeben.`);
    }
  }
  if (typ === 'H') {
    if (!d.traeger.some((t) => t.menge > 0)) throw new BusinessError('Bitte bei den Holzträgern mindestens eine Menge erfassen.');
    stops = []; // Holzträgeraufträge haben keine Stops
  }
  const traeger = d.traeger.map((t, i) => ({ pos: i + 1, produkt: t.produkt, prod_txt: t.prod_txt, menge: t.menge, preis: t.preis }));
  const rgbetrag = rechnungsbetrag(d, traeger, firma.ust_satz);

  const werte = {
    anlagedatum: d.anlagedatum ?? heute(),
    leistungsdatum: d.leistungsdatum,
    kunde: d.kunde ?? null,
    unternehmer: d.unternehmer ?? null,
    rechnungsempfaenger: d.rechnungsempfaenger ?? null,
    ordernummer: d.ordernummer,
    frachtpreis_ek: d.frachtpreis_ek,
    frachtpreis_vk: d.frachtpreis_vk,
    steuerrelevant: d.steuerrelevant,
    steuerbefreiung: d.steuerrelevant ? null : d.steuerbefreiung ?? null,
    dok_fehlen: d.dok_fehlen,
    kennzeichen: d.kennzeichen,
    fahrzeugtyp: d.fahrzeugtyp,
    ladegut: d.ladegut,
    gewicht: d.gewicht,
    lademeter: d.lademeter,
    ladeweise: d.ladeweise,
    palettentausch: d.palettentausch,
    ladenummer: d.ladenummer,
    besonderheiten: d.besonderheiten,
    rgbetrag,
  };
  for (const f of ['kunde', 'unternehmer', 'rechnungsempfaenger'] as const) {
    if (werte[f] && !(await adresseLesen(werte[f], tx))) throw new BusinessError(`Adresse ${werte[f]} existiert nicht.`);
  }

  if (neu) {
    await tx`insert into transport.auftraege ${tx({ auftragsnr: nr, ...werte })}`;
  } else {
    const r = await tx`update transport.auftraege set ${tx(werte)} where auftragsnr = ${nr}`;
    if (!r.count) throw new BusinessError(`Auftrag ${nr} nicht gefunden.`, 404);
  }

  // Stops: nur Stops mit Daten speichern (zweiter Stop nur, wenn belegt)
  const behalten = stops.filter((s, i) => i === 0 ? (s.firma || s.firma_e || s.plzort || s.plzort_e || s.strasse || s.strasse_e) : (s.firma || s.firma_e));
  await tx`delete from transport.stops where auftragsnr = ${nr} and pos <> all(${behalten.map((s) => s.pos)}::smallint[])`;
  for (const s of behalten) {
    const { pos, ...rest } = s;
    await tx`insert into transport.stops ${tx({ auftragsnr: nr, pos, ...rest })}
             on conflict (auftragsnr, pos) do update set ${tx(rest)}`;
  }
  // Träger
  await tx`delete from transport.traeger where auftragsnr = ${nr} and pos > ${traeger.length}`;
  for (const t of traeger) {
    const { pos, ...rest } = t;
    await tx`insert into transport.traeger ${tx({ auftragsnr: nr, pos, ...rest })}
             on conflict (auftragsnr, pos) do update set ${tx(rest)}`;
  }
}

// ---------------------------------------------------------------------------
// Dublettenprüfung Kontakte: gleicher Name (ohne Groß-/Kleinschreibung) am gleichen Ort
// ---------------------------------------------------------------------------
async function dublette(name: string, ort: string | null, ohne: number | null) {
  const rows = await sql`select adrnr, kundenname, land, plz, ort from transport.adressen
                         where upper(kundenname) = upper(${name}) order by adrnr`;
  const o = condense(ort).toUpperCase();
  return rows.find((r) => r.adrnr !== ohne && (!o || condense(r.ort).toUpperCase() === o)) ?? null;
}

// ---------------------------------------------------------------------------
// Routen
// ---------------------------------------------------------------------------
async function routes(app: FastifyInstance) {
  // ---- Stammdaten für die Oberfläche ----
  app.get('/init', { preHandler: requireAuth(P.display) }, async () => {
    const jahre = await sql`select extract(year from anlagedatum)::int::text as jahr, count(*)::int as n
                              from transport.auftraege group by 1 order by 1 desc`;
    const firma = await firmaLesen();
    return {
      jahre: jahre.map((j) => ({ key: j.jahr, text: `${j.jahr} (${j.n})` })),
      werte: await werteLesen(),
      firmaUnvollstaendig: !firma.name || !firma.iban,
    };
  });

  // ---- Auftragsliste ----
  app.get('/auftraege', { preHandler: requireAuth(P.display) }, async (req) => {
    const q = z.object({ jahr: z.string().optional(), fakt: z.string().optional() }).parse(req.query);
    const jahr = q.jahr && q.jahr !== 'ALL' ? q.jahr : null;
    const tage = q.fakt && q.fakt !== 'ALL' ? Number(q.fakt) : null;
    const rows = await sql`
      select a.auftragsnr, a.kennzeichen, a.anlagedatum, a.frachtpreis_ek, a.frachtpreis_vk, a.rgbetrag,
             a.faktura, a.fakturadatum, a.dok_fehlen,
             k.kundenname as kunde_txt, u.kundenname as unternehmer_txt,
             s1.plzort as s1_plzort, s1.plzort_e as s1_plzort_e, s2.plzort_e as s2_plzort_e, s1.datum as ladedatum,
             (s1.auftragsnr is not null and (coalesce(s1.firma,'') <> '' or coalesce(s1.firma_e,'') <> '' or coalesce(s1.plzort,'') <> ''
                or coalesce(s1.plzort_e,'') <> '' or coalesce(s1.strasse,'') <> '' or coalesce(s1.strasse_e,'') <> ''))
               or (s2.auftragsnr is not null and (coalesce(s2.firma,'') <> '' or coalesce(s2.firma_e,'') <> '')) as hat_stops,
             exists (select 1 from transport.traeger t where t.auftragsnr = a.auftragsnr and t.menge > 0) as hat_menge
        from transport.auftraege a
        left join transport.adressen k on k.adrnr = a.kunde
        left join transport.adressen u on u.adrnr = a.unternehmer
        left join transport.stops s1 on s1.auftragsnr = a.auftragsnr and s1.pos = 1
        left join transport.stops s2 on s2.auftragsnr = a.auftragsnr and s2.pos = 2
       where true
         ${jahr ? sql`and a.anlagedatum between ${`${jahr}-01-01`} and ${`${jahr}-12-31`}` : sql``}
         ${tage !== null ? sql`and a.fakturadatum >= current_date - ${tage}::int` : sql``}
       order by a.auftragsnr desc`;
    return rows.map((r) => {
      let route = r.s1_plzort ?? '';
      if (r.s1_plzort_e) route = `${route} → ${r.s1_plzort_e}`;
      if (r.s2_plzort_e) route = `${route} → ${r.s2_plzort_e}`;
      return {
        auftragsnr: r.auftragsnr,
        kennzeichen: r.kennzeichen,
        art: !r.hat_stops && r.hat_menge ? 'Holzträger' : 'Fracht',
        anlagedatum: isoDate(r.anlagedatum),
        kunde: r.kunde_txt ?? '',
        unternehmer: r.unternehmer_txt ?? '',
        route: route.trim(),
        ladedatum: isoDate(r.ladedatum),
        ek: num(r.frachtpreis_ek),
        vk: num(r.frachtpreis_vk),
        betrag: num(r.rgbetrag),
        faktura: r.faktura,
        fakturadatum: isoDate(r.fakturadatum),
        status: r.faktura ? 'Fakturiert' : 'Offen',
        dokFehlen: r.dok_fehlen,
      };
    });
  });

  // ---- Einzelner Auftrag ----
  app.get('/auftraege/:nr', { preHandler: requireAuth(P.display) }, async (req) => {
    const { nr } = z.object({ nr: z.string() }).parse(req.params);
    const a = await auftragLesen(nr);
    // Holzträger: Produktliste ergänzen, falls noch keine Träger erfasst sind
    if (a.typ === 'H' && !a.traeger.length) a.traeger = await traegerVorschlag();
    return a;
  });

  /** Vorlage für einen neuen Auftrag (F = Fracht, H = Holzträger) – Nummer nur als Vorschau */
  app.get('/neu/:typ', { preHandler: requireAuth(P.edit) }, async (req) => {
    const { typ } = z.object({ typ: z.enum(['F', 'H']) }).parse(req.params);
    const jahr = new Date().getFullYear();
    return {
      nummerVorschau: await nummerVorschau(NR_AUFTRAG, jahr),
      typ,
      anlagedatum: heute(),
      palettentausch: '099',
      steuerrelevant: true,
      steuerbefreiung: null,
      dok_fehlen: false,
      kennzeichen: 'Bitte angeben',
      ladeweise: '001',
      fahrzeugtyp: '001',
      ladegut: '002',
      frachtpreis_ek: 0,
      frachtpreis_vk: 0,
      stops: [leererStop(1), leererStop(2)],
      traeger: typ === 'H' ? await traegerVorschlag() : [],
    };
  });

  app.post('/auftraege', { preHandler: requireAuth(P.edit) }, async (req) => {
    const body = auftragSchema.extend({ typ: z.enum(['F', 'H']) }).parse(req.body);
    const nr = await change(req, async (tx) => {
      const jahr = Number((body.anlagedatum ?? heute()).slice(0, 4));
      const n = await naechsteNummer(tx, NR_AUFTRAG, jahr);
      await auftragSchreiben(tx, n, body, body.typ, true);
      return n;
    });
    return { auftragsnr: nr };
  });

  app.put('/auftraege/:nr', { preHandler: requireAuth(P.edit) }, async (req) => {
    const { nr } = z.object({ nr: z.string() }).parse(req.params);
    const body = auftragSchema.extend({ typ: z.enum(['F', 'H']) }).parse(req.body);
    await change(req, async (tx) => {
      const [alt] = await tx`select faktura from transport.auftraege where auftragsnr = ${nr} for update`;
      if (!alt) throw new BusinessError(`Auftrag ${nr} nicht gefunden.`, 404);
      // Fakturierte Aufträge (#121): nur noch „Dokumente fehlen“ und Besonderheiten änderbar,
      // Dokumente werden über /auftraege/:nr/dokumente zugeordnet – alle übrigen Felder bleiben, wie sie sind.
      if (alt.faktura) {
        await tx`update transport.auftraege set dok_fehlen = ${body.dok_fehlen}, besonderheiten = ${body.besonderheiten} where auftragsnr = ${nr}`;
        // Grund ohne MwSt (#121) bleibt korrigierbar: ändert nur den Hinweistext der Rechnung, nicht die Beträge (0 % bleibt 0 %)
        if (body.steuerbefreiung) {
          await tx`update transport.auftraege set steuerbefreiung = ${body.steuerbefreiung} where auftragsnr = ${nr} and not steuerrelevant`;
        }
        return;
      }
      await auftragSchreiben(tx, nr, body, body.typ, false);
    });
    return { auftragsnr: nr };
  });

  // ---- Rechnungen (Einzel/Sammel) ----
  app.post('/rechnungen', { preHandler: requireAuth(P.rechnung) }, async (req) => {
    const { auftraege, sammel } = z.object({ auftraege: z.array(z.string()).min(1), sammel: z.boolean() }).parse(req.body);
    const firma = await firmaLesen();
    return change(req, async (tx) => {
      const rows = await tx`select auftragsnr, faktura from transport.auftraege
                            where auftragsnr = any(${auftraege}) order by auftragsnr for update`;
      const offen = rows.filter((r) => !r.faktura).map((r) => r.auftragsnr as string);
      const ignoriert = rows.length - offen.length;
      if (!offen.length) throw new BusinessError('Keine offenen Aufträge ausgewählt.');
      if (sammel && offen.length < 2) throw new BusinessError('Für eine Sammelrechnung bitte mindestens zwei offene Aufträge auswählen.');
      const jahr = new Date().getFullYear();
      const fakturen: string[] = [];
      let faktura = '';
      for (const nr of offen) {
        if (!sammel || !faktura) {
          faktura = await naechsteNummer(tx, NR_RECHNUNG, jahr, firma.rechnung_startnr);
          fakturen.push(faktura);
        }
        await tx`update transport.auftraege set faktura = ${faktura}, fakturadatum = current_date where auftragsnr = ${nr}`;
      }
      return { fakturen, ignoriert };
    }, { action: sammel ? 'SAMMELRECHNUNG' : 'RECHNUNG' });
  });

  // ---- Dokumente (PDF) ----
  app.get('/pdf/:art/:id', { preHandler: requireAuth(P.display) }, async (req, reply) => {
    const { art, id } = z.object({ art: z.enum(['T', 'L', 'R']), id: z.string() }).parse(req.params);
    let pdf: Buffer;
    let name: string;
    if (art === 'R') {
      const r = await rechnungPdf(id);
      if (!r) throw new BusinessError(`Rechnung ${id} nicht gefunden.`, 404);
      pdf = r.pdf;
      name = r.filename;
    } else if (art === 'L') {
      pdf = await lieferscheinPdf(id);
      name = `Lieferschein_${id}.pdf`;
    } else {
      pdf = await transportauftragPdf(id);
      name = `Transportauftrag_${id}.pdf`;
    }
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${name}"`).send(pdf);
  });

  // ---- E-Rechnung ----
  app.get('/xrechnung/:faktura', { preHandler: requireAuth(P.display) }, async (req) => {
    const { faktura } = z.object({ faktura: z.string() }).parse(req.params);
    const res = await xrechnungErzeugen(faktura);
    const [{ n }] = await sql`select count(*)::int as n from transport.auftraege where faktura = ${faktura}`;
    return { ...res, anzahlAuftraege: n };
  });

  /** ZUGFeRD/Factur-X: eingebettetes CII-XML einzeln herunterladen */
  app.get('/zugferd/:faktura/datei', { preHandler: requireAuth(P.display) }, async (req, reply) => {
    const { faktura } = z.object({ faktura: z.string() }).parse(req.params);
    const r = await zugferdXml(faktura);
    if (!r) throw new BusinessError(`Rechnung ${faktura} nicht gefunden.`, 404);
    return reply.type('application/xml; charset=utf-8').header('content-disposition', `attachment; filename="${faktura}_${FX_DATEI}"`).send(r.xml);
  });

  /** Selbstprüfung der E-Rechnung: PDF/A-3-Struktur, Einbettung, Pflichtangaben */
  app.get('/zugferd/:faktura/pruefung', { preHandler: requireAuth(P.display) }, async (req) => {
    const { faktura } = z.object({ faktura: z.string() }).parse(req.params);
    const r = await rechnungPdf(faktura);
    if (!r) throw new BusinessError(`Rechnung ${faktura} nicht gefunden.`, 404);
    const pr = pdfPruefen(r.pdf, r.xml);
    return { faktura, profil: 'ZUGFeRD 2.3 / Factur-X 1.0 – EN 16931', datei: FX_DATEI, groesse: r.pdf.length, ...pr, hinweise: r.hinweise };
  });

  app.get('/xrechnung/:faktura/datei', { preHandler: requireAuth(P.display) }, async (req, reply) => {
    const { faktura } = z.object({ faktura: z.string() }).parse(req.params);
    const res = await xrechnungErzeugen(faktura);
    if (!res.xml) throw new BusinessError(res.hinweise.join(' '));
    return reply.type('application/xml; charset=utf-8').header('content-disposition', `attachment; filename="${res.filename}"`).send(res.xml);
  });

  // ---- Versenden: E-Mail-Entwürfe (mailto) ----
  app.post('/mails', { preHandler: requireAuth(P.versand) }, async (req) => {
    const { art, auftraege } = z.object({ art: z.enum(['T', 'L', 'R']), auftraege: z.array(z.string()).min(1) }).parse(req.body);
    const texte = await sql`select art, sprache, text from transport.mailtexte`;
    const res = [];
    for (const nr of auftraege) {
      const a = await auftragLesen(nr);
      if (art === 'R' && !a.faktura) continue;
      // Empfänger: Transportauftrag → Unternehmer, Lieferschein/Rechnung → Kunde
      const adr: Adresse | null = art === 'T' ? a.unternehmerAdr : a.kundeAdr;
      const sprache = (adr?.land ?? 'DE') === 'DE' ? 'D' : 'E';
      const anrede = sprache === 'E' ? 'Dear Sir or Madam'
        : adr?.anrede === 'Herr' ? `Sehr geehrter Herr ${condense(`${adr.vorname ?? ''} ${adr.name ?? ''}`)}`
        : adr?.anrede === 'Frau' ? `Sehr geehrte Frau ${condense(`${adr.vorname ?? ''} ${adr.name ?? ''}`)}`
        : 'Sehr geehrte Damen und Herren';
      const vorlage = texte.find((t) => t.art === art && t.sprache === sprache)?.text ?? '';
      const body = vorlage.replace(/\{ANREDE\}/g, anrede).replace(/\{AUFTRAG\}/g, nr).replace(/\{RECHNUNG\}/g, a.faktura ?? '');
      const betreff = art === 'T' ? `Transportauftrag ${nr}` : art === 'L' ? `Lieferschein ${nr}` : `Rechnung ${a.faktura}`;
      const email = adr?.email ?? '';
      res.push({
        auftragsnr: nr,
        faktura: a.faktura,
        art: art === 'T' ? 'Transportauftrag' : art === 'L' ? 'Lieferschein' : `Rechnung ${a.faktura}`,
        empfaenger: condense(`${adr?.kundenname ?? '(kein Empfänger)'} ${email ? `<${email}>` : ''}`),
        betreff,
        // für den E-Mail-Entwurf mit Anhängen im Auftrag (#121): Empfänger und Text einzeln
        an: email, text: body,
        mailto: `mailto:${email}?subject=${encodeURIComponent(betreff)}&body=${encodeURIComponent(body.replace(/\n/g, '\r\n'))}`,
        hasEmail: !!email,
      });
    }
    return res;
  });

  // ---- Dokumente zum Auftrag (Paperless) ----
  const benutzerName = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';
  app.get('/auftraege/:nr/dokumente', { preHandler: requireAuth(P.display) }, async (req) => {
    const { nr } = z.object({ nr: z.string() }).parse(req.params);
    const rows = await sql`select doc_id, titel, datei, erstellt_am, erstellt_von from transport.auftrag_dokumente
                            where auftragsnr = ${nr} order by erstellt_am desc`;
    const f = await firmaLesen();
    return { paperless: !!(f.paperless_url && f.paperless_token), dokumente: rows };
  });

  app.post('/auftraege/:nr/dokumente', { preHandler: requireAuth(P.edit), bodyLimit: 50 * 1024 * 1024 }, async (req) => {
    const { nr } = z.object({ nr: z.string() }).parse(req.params);
    const b = z.object({ datei: z.string().min(1).max(200), inhalt: z.string().min(1, 'Die Datei ist leer.') }).parse(req.body);
    const a = await auftragLesen(nr);
    const k = a.kundeAdr;
    const kunde = k ? [k.kundenname, k.kundenname2].filter(Boolean).join(' ').trim() || null : null;
    const u = a.unternehmerAdr;
    const d = await dokumentAblegen(await firmaLesen(), {
      auftragsnr: nr, kunde, unternehmer: u ? [u.kundenname, u.kundenname2].filter(Boolean).join(' ').trim() : null, kennzeichen: a.kennzeichen, ordernummer: a.ordernummer,
      datum: new Date().toISOString().slice(0, 10), benutzer: benutzerName(req),
    }, b.datei, b.inhalt);
    await change(req, (tx) => tx`insert into transport.auftrag_dokumente (auftragsnr, doc_id, titel, datei, erstellt_von)
                                values (${nr}, ${d.id}, ${d.titel}, ${d.datei}, ${benutzerName(req)}) on conflict do nothing`, { action: 'DOKUMENT_ABLEGEN' });
    return { id: d.id, text: `„${d.datei}“ in Paperless abgelegt (Dokument ${d.id}) und Auftrag ${nr} zugeordnet${d.warnungen.length ? ` – ${d.warnungen.join('; ')}` : ''}` };
  });

  /** nur die Verknüpfung lösen – das Dokument bleibt in Paperless */
  app.delete('/auftraege/:nr/dokumente/:id', { preHandler: requireAuth(P.edit) }, async (req) => {
    const p = z.object({ nr: z.string(), id: z.coerce.number().int().positive() }).parse(req.params);
    const r = await change(req, (tx) => tx`delete from transport.auftrag_dokumente where auftragsnr = ${p.nr} and doc_id = ${p.id}`, { action: 'DOKUMENT_LOESEN' });
    if (!r.count) throw new BusinessError('Dokument ist dem Auftrag nicht zugeordnet.');
    return { text: `Dokument ${p.id} vom Auftrag ${p.nr} gelöst (bleibt in Paperless)` };
  });

  /** Datei nur für Dokumente, die einem Auftrag zugeordnet sind */
  app.get('/auftraege/:nr/dokumente/:id/datei', { preHandler: requireAuth(P.display) }, async (req, reply) => {
    const p = z.object({ nr: z.string(), id: z.coerce.number().int().positive() }).parse(req.params);
    const [da] = await sql`select 1 from transport.auftrag_dokumente where auftragsnr = ${p.nr} and doc_id = ${p.id}`;
    if (!da) throw new BusinessError('Dokument nicht gefunden.', 404);
    const d = await paperlessFirma(await firmaLesen()).download(p.id);
    return reply.type(d.contentType).header('content-disposition', `inline; filename="${encodeURIComponent(d.filename)}"`).send(d.data);
  });

  // ---- Paperless ----
  app.post('/paperless', { preHandler: requireAuth(P.versand) }, async (req) => {
    const { fakturen } = z.object({ fakturen: z.array(z.string()).min(1) }).parse(req.body);
    const firma = await firmaLesen();
    const msgs: { faktura: string; ok: boolean; message: string }[] = [];
    for (const f of [...new Set(fakturen)]) {
      const r = await rechnungPdf(f);
      if (!r) {
        msgs.push({ faktura: f, ok: false, message: 'PDF konnte nicht erzeugt werden.' });
        continue;
      }
      const e = await paperlessSenden(firma, r, benutzerName(req));
      msgs.push({ faktura: f, ...e });
    }
    return msgs;
  });

  // ---- Kontakte ----
  await kontaktRoutes(app, P);
  app.get('/adressen', { preHandler: requireAuth(P.display) }, async () => {
    const rows = await sql`select adrnr, kundenname, kundenname2, land, ort from transport.adressen
                           where coalesce(kundenname, '') <> '' or coalesce(kundenname2, '') <> ''
                           order by lower(kundenname), lower(coalesce(kundenname2, '')), ort`;
    return rows.map((a) => ({
      key: String(a.adrnr),
      text: condense(`${a.kundenname ?? ''} ${a.kundenname2 ?? ''}`),
      zusatz: a.land && a.ort ? `${a.land}, ${a.ort}` : condense(`${a.land ?? ''} ${a.ort ?? ''}`),
    }));
  });

  app.get('/adressen/:nr', { preHandler: requireAuth(P.display) }, async (req) => {
    const { nr } = z.object({ nr: z.coerce.number().int() }).parse(req.params);
    const a = await adresseLesen(nr);
    if (!a) throw new BusinessError('Kontakt nicht gefunden.', 404);
    return a;
  });

  /**
   * #158: eingefügte/abgelegte Informationen analysieren und Feldvorschläge liefern – speichert nichts.
   * text: kopierter Text · bild: Screenshot/Foto (PNG oder JPEG, Base64) → Texterkennung · pdf: PDF mit Textebene (Base64)
   */
  app.post('/adressen/erkennen', { preHandler: requireAuth(P.kontakte), bodyLimit: 16 * 1024 * 1024 }, async (req) => {
    const b = z.object({ text: z.string().max(100_000).nullish(), bild: z.string().max(15_000_000).nullish(), pdf: z.string().max(15_000_000).nullish() })
      .refine((x) => [x.text, x.bild, x.pdf].filter((v) => v && v.trim()).length === 1, 'Bitte Text, ein Bild oder ein PDF einfügen.').parse(req.body);
    const base64 = (s: string) => Buffer.from(s.replace(/^data:[^,]*,/, ''), 'base64');
    const quelle = b.bild ? 'bild' : b.pdf ? 'pdf' : 'text';
    const text = b.bild ? await bildText(base64(b.bild)) : b.pdf ? await pdfText(base64(b.pdf)) : b.text!;
    if (!text.trim()) {
      throw new BusinessError(quelle === 'bild' ? 'Im Bild wurde kein Text erkannt – bitte einen schärferen oder größeren Ausschnitt einfügen.'
        : quelle === 'pdf' ? 'Das PDF enthält keinen lesbaren Text (vermutlich ein Scan) – bitte einen Screenshot der Seite einfügen.' : 'Bitte Text einfügen.');
    }
    // gelesener Text zur Kontrolle (nur bei Bild/PDF)
    return { ...kontaktErkennen(text), quelle, gelesen: quelle === 'text' ? null : text.replace(/[ \t]{3,}/g, '   ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 3000) };
  });

  app.post('/adressen', { preHandler: requireAuth(P.kontakte) }, async (req, reply) => {
    const { force, ...d } = adresseSchema.parse(req.body);
    const dub = await dublette(d.kundenname, d.ort, null);
    if (dub && !force) {
      return reply.code(409).send({
        code: 'DUBLETTE',
        message: `Diesen Kontakt gibt es schon: ${dub.kundenname}, ${condense(`${dub.land ?? ''} ${dub.plz ?? ''} ${dub.ort ?? ''}`)}. ` +
          'Zum Verwenden "Abbrechen" und im Dropdown auswählen - oder erneut "Anlegen" klicken.',
      });
    }
    const adrnr = await change(req, async (tx) => {
      const n = await naechsteAdrnr(tx);
      await tx`insert into transport.adressen ${tx({ adrnr: n, ...d })}`;
      return n;
    });
    return { adrnr };
  });

  app.put('/adressen/:nr', { preHandler: requireAuth(P.kontakte) }, async (req, reply) => {
    const { nr } = z.object({ nr: z.coerce.number().int() }).parse(req.params);
    const { force, ...d } = adresseSchema.parse(req.body);
    const dub = await dublette(d.kundenname, d.ort, nr);
    if (dub && !force) {
      return reply.code(409).send({
        code: 'DUBLETTE',
        message: `Diesen Kontakt gibt es schon: ${dub.kundenname}, ${condense(`${dub.land ?? ''} ${dub.plz ?? ''} ${dub.ort ?? ''}`)}. ` +
          'Zum Speichern trotzdem erneut "Speichern" klicken.',
      });
    }
    await change(req, async (tx) => {
      const r = await tx`update transport.adressen set ${tx(d)} where adrnr = ${nr}`;
      if (!r.count) throw new BusinessError('Kontakt nicht gefunden.', 404);
    });
    return { adrnr: nr };
  });

  // ---- Wertelisten ----
  app.get('/werte', { preHandler: requireAuth(P.display) }, async () => werteLesen());

  /** Neuer Listenwert (wie HANDLE_DOMAIN_VALUES): Schlüssel = höchster + 1, dreistellig */
  app.post('/werte', { preHandler: requireAuth(P.edit) }, async (req) => {
    const { typ, text } = z.object({ typ: z.enum(WERTE_TYPEN as [string, ...string[]]), text: z.string().trim().min(1, 'Bitte einen Text eingeben.').max(60) }).parse(req.body);
    const key = await change(req, async (tx) => {
      await tx`select pg_advisory_xact_lock(4722)`;
      const rows = await tx`select schluessel, sort from transport.werte where typ = ${typ}`;
      const max = rows.reduce((m, r) => Math.max(m, /^\d+$/.test(r.schluessel) ? Number(r.schluessel) : 0), 0);
      const sort = rows.reduce((m, r) => Math.max(m, Number(r.sort)), 0) + 1;
      const k = String(max + 1).padStart(3, '0');
      await tx`insert into transport.werte (typ, schluessel, text, sort) values (${typ}, ${k}, ${text}, ${sort})`;
      return k;
    });
    return { key };
  });

  /**
   * Mehrere Listenwerte auf einmal (Copy & Paste in den Stammdaten, #121).
   * Schlüssel optional (sonst höchster + 1, dreistellig); vorhandene Texte oder Schlüssel werden übersprungen.
   */
  app.post('/werte/masse', { preHandler: requireAuth(P.stammdaten) }, async (req) => {
    const b = z.object({
      typ: z.enum(WERTE_TYPEN as [string, ...string[]]),
      zeilen: z.array(z.object({
        key: z.string().trim().max(10).optional(),
        text: z.string().trim().min(1).max(60, 'Ein Wert ist länger als 60 Zeichen.'),
      })).min(1, 'Keine Werte erkannt.').max(500),
    }).parse(req.body);
    return change(req, async (tx) => {
      await tx`select pg_advisory_xact_lock(4722)`;
      const rows = await tx`select schluessel, text, sort from transport.werte where typ = ${b.typ}`;
      const keys = new Set(rows.map((r) => r.schluessel as string));
      const texte = new Set(rows.map((r) => String(r.text).toLowerCase()));
      let max = rows.reduce((m, r) => Math.max(m, /^\d+$/.test(r.schluessel) ? Number(r.schluessel) : 0), 0);
      let sort = rows.reduce((m, r) => Math.max(m, Number(r.sort)), 0);
      let neu = 0;
      let uebersprungen = 0;
      for (const z of b.zeilen) {
        if (texte.has(z.text.toLowerCase()) || (z.key && keys.has(z.key))) { uebersprungen++; continue; }
        let k = z.key || '';
        while (!k || keys.has(k)) k = String(++max).padStart(3, '0');
        if (/^\d+$/.test(k)) max = Math.max(max, Number(k));
        await tx`insert into transport.werte (typ, schluessel, text, sort) values (${b.typ}, ${k}, ${z.text}, ${++sort})`;
        keys.add(k);
        texte.add(z.text.toLowerCase());
        neu++;
      }
      return { neu, uebersprungen };
    });
  });

  app.put('/werte/:typ/:key', { preHandler: requireAuth(P.stammdaten) }, async (req) => {
    const { typ, key } = z.object({ typ: z.string(), key: z.string() }).parse(req.params);
    const b = z.object({ text: z.string().trim().min(1).max(60), aktiv: z.boolean() }).parse(req.body);
    await change(req, (tx) => tx`update transport.werte set text = ${b.text}, aktiv = ${b.aktiv} where typ = ${typ} and schluessel = ${key}`);
    return { ok: true };
  });

  // ---- Firmendaten ----
  app.get('/firma', { preHandler: requireAuth(P.stammdaten) }, async () => {
    const f = await firmaLesen();
    // Paperless wird zentral gepflegt (Administration → Anbindungen); hier nur der Stand
    return { ...f, paperless_token: f.paperless_token ? '********' : '', paperless: !!(f.paperless_url && f.paperless_token) };
  });

  app.put('/firma', { preHandler: requireAuth(P.stammdaten) }, async (req) => {
    const s = (max: number) => z.string().trim().max(max).default('');
    const b = z.object({
      name: s(100), strasse: s(100), plz: s(10), ort: s(60), land: s(3), ustid: s(20), steuernr: s(30), kontakt: s(100),
      telefon: s(40), fax: s(40), email: z.string().trim().email('Keine gültige E-Mail').or(z.literal('')).default(''),
      bank: s(100), iban: s(40), bic: s(15),
      zahlungsziel_tage: z.coerce.number().int().min(0).max(365), ust_satz: z.coerce.number().min(0).max(100),
      rechnung_startnr: z.coerce.number().int().min(1).max(9999),
      logo: z.string().max(600_000).regex(/^data:image\/(png|jpeg);base64,/, 'Logo muss PNG oder JPEG sein').nullish(),
    }).parse(req.body);
    await change(req, async (tx) => {
      await tx`update transport.firma set ${tx({ ...b, logo: b.logo ?? null })} where id = 1`;
    });
    return { ok: true };
  });

  // ---- Produkte ----
  app.get('/produkte', { preHandler: requireAuth(P.display) }, async () => {
    const rows = await sql`select prod_key, text, preis, gueltig_bis, sort from transport.produkte order by sort, prod_key`;
    return rows.map((p) => ({ ...p, preis: num(p.preis), gueltig_bis: isoDate(p.gueltig_bis) }));
  });

  app.put('/produkte', { preHandler: requireAuth(P.stammdaten) }, async (req) => {
    const list = z.array(z.object({
      prod_key: z.string().trim().min(1).max(20), text: z.string().trim().min(1).max(40),
      preis: z.coerce.number().min(0), gueltig_bis: datum, sort: z.coerce.number().int().default(0),
    })).parse(req.body);
    const keys = list.map((p) => p.prod_key);
    if (new Set(keys).size !== keys.length) throw new BusinessError('Produktschlüssel doppelt.');
    await change(req, async (tx) => {
      await tx`delete from transport.produkte where prod_key <> all(${keys})`;
      for (const p of list) {
        const { prod_key, ...rest } = p;
        await tx`insert into transport.produkte ${tx(p)} on conflict (prod_key) do update set ${tx(rest)}`;
      }
    });
    return { ok: true };
  });

  // ---- E-Mail-Texte ----
  app.get('/mailtexte', { preHandler: requireAuth(P.stammdaten) }, async () =>
    sql`select art, sprache, text from transport.mailtexte order by art, sprache`);

  app.put('/mailtexte', { preHandler: requireAuth(P.stammdaten) }, async (req) => {
    const list = z.array(z.object({ art: z.enum(['T', 'L', 'R']), sprache: z.enum(['D', 'E']), text: z.string().max(10000) })).parse(req.body);
    await change(req, async (tx) => {
      for (const t of list) {
        await tx`insert into transport.mailtexte ${tx(t)} on conflict (art, sprache) do update set text = excluded.text`;
      }
    });
    return { ok: true };
  });

  // ---- CSV-Import ----
  // modus „neu“: nur neue Sätze anlegen; „ersetzen“: Tabellen leeren und komplett neu aufbauen (#121)
  const importBody = z.object({
    dateien: z.array(z.object({ name: z.string(), data: z.string() })).max(20),
    modus: z.enum(['neu', 'ersetzen']).default('neu'),
    reason: z.string().optional(),
  });
  const lesen = (body: unknown) => {
    const { dateien, modus, reason } = importBody.parse(body);
    const ok: Geparst[] = [];
    const ohneZiel: OhneZiel[] = [];
    const fehler: string[] = [];
    for (const d of dateien) {
      const r = parsen(d.name, dekodieren(Buffer.from(d.data.replace(/^data:[^,]*,/, ''), 'base64')));
      if ('fehler' in r) fehler.push(r.fehler);
      else if ('ohneZiel' in r) ohneZiel.push(r);
      else {
        // gleiche Tabelle mehrfach: letzte Datei gilt
        const i = ok.findIndex((x) => x.art === r.art);
        if (i >= 0) ok.splice(i, 1);
        ok.push(r);
      }
    }
    return { ok, ohneZiel, fehler, modus, reason };
  };

  app.post('/import/pruefen', { preHandler: requireAuth(P.import), bodyLimit: 30 * 1024 * 1024 }, async (req) => {
    const { ok, ohneZiel, fehler, modus } = lesen(req.body);
    return sql.begin((tx) => pruefen(tx as unknown as Tx, ok, fehler, ohneZiel, modus));
  });

  app.post('/import/ausfuehren', { preHandler: requireAuth(P.import), bodyLimit: 30 * 1024 * 1024 }, async (req) => {
    const { ok, fehler, modus, reason } = lesen(req.body);
    if (!ok.length) throw new BusinessError(fehler[0] ?? 'Bitte zuerst die CSV-Dateien einlesen.');
    if (modus === 'ersetzen' && !reason?.trim()) throw new BusinessError('Für den Neuaufbau ist eine Begründung nötig.');
    return change(req, (tx) => ausfuehren(tx, ok, modus), { action: modus === 'ersetzen' ? 'IMPORT_NEUAUFBAU' : 'IMPORT', reason: reason?.trim() || undefined });
  });
}

const mod: ServerModule = {
  id: 'transport',
  name: 'Transport',
  migrationsDir: path.join(APP_ROOT, 'modules', 'transport', 'server', 'migrations'),
  paperlessKontexte: TRANSPORT_KONTEXTE,
  permissions: [
    { area: 'Euroflex', app: 'Aufträge', id: P.display, text: 'Aufträge anzeigen und drucken' },
    { area: 'Euroflex', app: 'Aufträge', id: P.edit, text: 'Aufträge anlegen und ändern' },
    { area: 'Euroflex', app: 'Aufträge', id: P.rechnung, text: 'Rechnungen erstellen', requires: [P.display] },
    { area: 'Euroflex', app: 'Aufträge', id: P.versand, text: 'Versenden (E-Mail, Paperless)', requires: [P.display] },
    { area: 'Euroflex', app: 'Aufträge', id: P.kontakte, text: 'Kontakte anlegen und ändern', requires: [P.display] },
    { area: 'Euroflex', app: 'Stammdaten', id: P.stammdaten, text: 'Stammdaten pflegen (Firmendaten, Produkte, Wertelisten, Texte)' },
    { area: 'Euroflex', app: 'Stammdaten', id: P.import, text: 'CSV-Import aus SAP', requires: [P.stammdaten] },
  ],
  auditObjects: [
    { type: 'AUFTRAG', text: 'Auftrag', permission: P.display },
    { type: 'ADRESSE', text: 'Kontakt', permission: P.display },
    { type: 'PRODUKT', text: 'Produkt', permission: P.display },
    { type: 'WERT', text: 'Listenwert', permission: P.display },
    { type: 'MAILTEXT', text: 'E-Mail-Text', permission: P.stammdaten },
    { type: 'FIRMA', text: 'Firmendaten', permission: P.stammdaten },
  ],
  routes,
};

export default mod;
