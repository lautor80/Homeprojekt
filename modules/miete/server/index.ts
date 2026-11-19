import path from 'node:path';
import { z } from 'zod';
import type { ServerModule } from '../../../server/src/module.js';
import { APP_ROOT } from '../../../server/src/config.js';
import { sql } from '../../../server/src/db.js';
import { can, change, requireAuth } from '../../../server/src/auth.js';
import { BusinessError } from '../../../server/src/errors.js';
import { htmlToPdf } from '../../../server/src/pdf.js';
import { getPublicSettings } from '../../../server/src/routes/settings.js';
import { kontextAblegen } from '../../../server/src/lib/paperless-mapping.js';
import { paperlessFuer } from '../../../server/src/lib/verbindungen.js';
import type { Aufgabe } from '../../../server/src/lib/arbeitsvorrat.js';
import { hinweisAufgaben } from '../../../server/src/lib/hinweise.js';
import { abrechnungJahr, einheitenLesen, kostenLesen, kostenartenLesen, uebersicht, vertraegeLesen, zaehlerLesen } from './daten.js';
import { abrechnungsFrist, aufteilen, monatsErster, r2, sollMonat, standAm, zaehlerKreis } from './logik.js';
import { K, MIETE_KONTEXTE, MIETE_PAPERLESS, dokumentKurz, paperless } from './paperless.js';
import { abrechnungHtml, type AbrechnungDruck } from './pdf.js';

/**
 * Vermietung: Mieteinnahmen je Monat in Kaltmiete und Nebenkosten-Abschlag aufteilen, mit den laufenden Kosten
 * vergleichen und die Nebenkosten jährlich abrechnen – für ein Haus mit mehreren Parteien, die sich Heizstrom und
 * Teile des Haushaltsstroms teilen (Haupt- und Unterzähler). Belege liegen in Paperless (eigener Zugang „Vermietung“).
 */
export const P = {
  uebersicht: 'miete.uebersicht:display',
  zahlungenDisplay: 'miete.zahlungen:display',
  zahlungenEdit: 'miete.zahlungen:edit',
  kostenDisplay: 'miete.kosten:display',
  kostenEdit: 'miete.kosten:edit',
  zaehlerDisplay: 'miete.zaehler:display',
  zaehlerEdit: 'miete.zaehler:edit',
  abrechnungDisplay: 'miete.abrechnung:display',
  abrechnungEdit: 'miete.abrechnung:edit',
  stammDisplay: 'miete.stammdaten:display',
  stammEdit: 'miete.stammdaten:edit',
};

const A = 'Vermietung';
const opt = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);
const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum JJJJ-MM-TT');
const datumOpt = datum.nullish().or(z.literal('')).transform((v) => v || null);
const betrag = z.coerce.number().finite().transform((v) => r2(v));
const idParam = z.object({ id: z.coerce.number().int().positive() });
const jahrQuery = z.object({ jahr: z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()) });
const grund = z.object({ reason: z.string().trim().min(1, 'Begründung ist Pflicht') });
const benutzer = (req: { user: { displayName: string; username: string } | null }) => req.user?.displayName || req.user?.username || 'Portal';

async function nichtVerwendet(frage: Promise<{ n: number }[]>, text: string) {
  const [{ n }] = await frage;
  if (n > 0) throw new BusinessError(text);
}

const mod: ServerModule = {
  id: 'miete',
  name: 'Vermietung',
  migrationsDir: path.join(APP_ROOT, 'modules', 'miete', 'server', 'migrations'),
  paperlessKontexte: MIETE_KONTEXTE,
  verbindungen: [MIETE_PAPERLESS],
  permissions: [
    { area: 'Vermietung', app: 'Übersicht', id: P.uebersicht, text: 'Monatsübersicht anzeigen: Mieteinnahmen (Kaltmiete und Abschläge) gegen laufende Kosten, offene Mieten' },
    { area: 'Vermietung', app: 'Mieteinnahmen', id: P.zahlungenDisplay, text: 'Mieteingänge anzeigen' },
    { area: 'Vermietung', app: 'Mieteinnahmen', id: P.zahlungenEdit, text: 'Mieteingänge erfassen, aufteilen (Kaltmiete/Nebenkosten) und löschen', requires: [P.zahlungenDisplay] },
    { area: 'Vermietung', app: 'Laufende Kosten', id: P.kostenDisplay, text: 'Laufende Kosten und Belege (Paperless) anzeigen' },
    { area: 'Vermietung', app: 'Laufende Kosten', id: P.kostenEdit, text: 'Kosten erfassen und ändern, Belege mit Paperless verknüpfen und hochladen', requires: [P.kostenDisplay] },
    { area: 'Vermietung', app: 'Zähler', id: P.zaehlerDisplay, text: 'Zähler und Ablesungen anzeigen' },
    { area: 'Vermietung', app: 'Zähler', id: P.zaehlerEdit, text: 'Zähler anlegen und Zählerstände erfassen', requires: [P.zaehlerDisplay] },
    { area: 'Vermietung', app: 'Nebenkostenabrechnung', id: P.abrechnungDisplay, text: 'Nebenkostenabrechnung berechnen und ansehen (Verteilung auf die Parteien)' },
    { area: 'Vermietung', app: 'Nebenkostenabrechnung', id: P.abrechnungEdit, text: 'Abrechnung festschreiben, wieder öffnen, als PDF erzeugen und in Paperless ablegen', requires: [P.abrechnungDisplay] },
    { area: 'Vermietung', app: 'Haus und Mieter', id: P.stammDisplay, text: 'Haus, Wohnungen, Mietverhältnisse und Kostenarten anzeigen' },
    { area: 'Vermietung', app: 'Haus und Mieter', id: P.stammEdit, text: 'Haus, Wohnungen, Mietverhältnisse (Miete und Abschlag) und Kostenarten (Verteilerschlüssel) pflegen', requires: [P.stammDisplay] },
  ],
  auditObjects: [
    { type: 'MIETOBJEKT', text: 'Haus (Vermietung)', permission: P.stammDisplay },
    { type: 'MIETEINHEIT', text: 'Wohnung', permission: P.stammDisplay },
    { type: 'MIETVERTRAG', text: 'Mietverhältnis', permission: P.stammDisplay },
    { type: 'MIETZAHLUNG', text: 'Mieteingang', permission: P.zahlungenDisplay },
    { type: 'KOSTENART', text: 'Kostenart (Vermietung)', permission: P.stammDisplay },
    { type: 'MIETKOSTEN', text: 'Laufende Kosten (Vermietung)', permission: P.kostenDisplay },
    { type: 'ZAEHLER', text: 'Zähler', permission: P.zaehlerDisplay },
    { type: 'NKABRECHNUNG', text: 'Nebenkostenabrechnung', permission: P.abrechnungDisplay },
  ],

  // Arbeitsvorrat: offene Mieten, fällige Abrechnung, fehlende Ablesung zum Jahreswechsel
  arbeitsvorrat: async (req) => {
    const out: Aufgabe[] = await hinweisAufgaben(req, 'miete');
    const heute = new Date().toISOString().slice(0, 10);
    const jahr = +heute.slice(0, 4);
    if (can(req, P.zahlungenDisplay)) {
      // Monat gilt nach dem 5. Werktag als fällig – vereinfacht: ab dem 6. des Monats
      const [{ offen }, vertraege] = await Promise.all([uebersicht(jahr), vertraegeLesen()]);
      for (const o of offen) {
        const s = sollMonat(vertraege.find((v) => v.id === o.vertrag_id)!, monatsErster(heute));
        // der laufende Monat zählt erst ab dem 6. als fällig
        const faellig = heute.slice(8) >= '06' ? o.offen : o.offen - s.miete - s.nk;
        if (faellig > 0.005) {
          out.push({ key: `MIETE_OFFEN:${o.vertrag_id}`, bereich: A, icon: 'lead', state: 'Critical', titel: `Miete offen: ${o.name} (${o.einheit})`,
            text: `Seit Jahresbeginn sind ${r2(faellig).toLocaleString('de-DE', { minimumFractionDigits: 2 })} € offen.`, datum: heute, pfad: '/miete/einnahmen', betrag: r2(faellig) });
        }
      }
    }
    if (can(req, P.abrechnungDisplay)) {
      const vorjahr = jahr - 1;
      const [{ n }] = await sql`select count(*)::int as n from miete.vertraege v
                                  where v.beginn <= ${`${vorjahr}-12-31`} and (v.ende is null or v.ende >= ${`${vorjahr}-01-01`})
                                    and not exists (select 1 from miete.einheiten e where e.id = v.einheit_id and e.eigennutzung)
                                    and not exists (select 1 from miete.abrechnungen a where a.jahr = ${vorjahr} and a.vertrag_id = v.id)`;
      if (n > 0) {
        const frist = abrechnungsFrist(`${vorjahr}-12-31`);
        const knapp = heute >= `${jahr}-10-01`;
        out.push({ key: `MIETE_ABRECHNUNG:${vorjahr}`, bereich: A, icon: 'receipt', state: knapp ? 'Negative' : 'Information',
          titel: `Nebenkostenabrechnung ${vorjahr} erstellen`, text: `${n} Mietverhältnis(se) noch nicht abgerechnet – Frist bis ${frist.slice(8)}.${frist.slice(5, 7)}.${frist.slice(0, 4)} (§ 556 Abs. 3 BGB).`,
          datum: `${jahr}-01-01`, pfad: '/miete/abrechnung' });
      }
    }
    if (can(req, P.zaehlerDisplay) && heute <= `${jahr}-02-28`) {
      // Zum Jahreswechsel braucht die Abrechnung eine Ablesung je Zähler (bis zwei Wochen um den 31.12.)
      for (const z of (await zaehlerLesen()).filter((x) => x.aktiv)) {
        const nah = z.ablesungen.some((a) => a.datum >= `${jahr - 1}-12-17` && a.datum <= `${jahr}-01-14`);
        if (!nah && standAm(z.ablesungen, `${jahr - 1}-12-31`) === null) {
          out.push({ key: `MIETE_ABLESUNG:${z.id}`, bereich: A, icon: 'measure', state: 'Information', titel: `Zählerstand zum Jahreswechsel: ${z.bezeichnung}`,
            text: 'Für die Abrechnung fehlt eine Ablesung um den 31.12.', datum: `${jahr}-01-01`, pfad: '/miete/zaehler' });
        }
      }
    }
    return out;
  },

  routes(app) {
    // ------------------------------------------------------------------ Haus und Mieter
    app.get('/objekt', { preHandler: requireAuth(P.stammDisplay) }, async () => {
      const [o] = await sql`select bezeichnung, strasse, plz, ort, vermieter, vermieter_anschrift, iban, paperless_tag from miete.objekt where id = 1`;
      return o;
    });
    app.put('/objekt', { preHandler: requireAuth(P.stammEdit) }, async (req) => {
      const b = z.object({
        bezeichnung: z.string().trim().min(1).max(200), strasse: opt(200), plz: opt(10), ort: opt(100), vermieter: opt(200),
        vermieter_anschrift: opt(500), iban: opt(40), paperless_tag: z.string().trim().max(100).default(''),
      }).parse(req.body);
      await change(req, (tx) => tx`update miete.objekt set ${tx(b)} where id = 1`);
      return { ok: true };
    });

    const einheitBody = z.object({
      kuerzel: z.string().trim().min(1).max(20), bezeichnung: z.string().trim().min(1).max(200),
      flaeche: z.coerce.number().min(0), personen: z.coerce.number().min(0), eigennutzung: z.boolean().default(false), sort: z.coerce.number().int().default(0),
    });
    app.get('/einheiten', { preHandler: requireAuth() }, async (req) => {
      if (![P.stammDisplay, P.zahlungenDisplay, P.kostenDisplay, P.zaehlerDisplay, P.abrechnungDisplay].some((p) => can(req, p))) throw new BusinessError('Keine Berechtigung.', 403);
      return einheitenLesen();
    });
    app.post('/einheiten', { preHandler: requireAuth(P.stammEdit) }, async (req) => {
      const b = einheitBody.parse(req.body);
      return change(req, async (tx) => (await tx`insert into miete.einheiten ${tx(b)} returning id`)[0]);
    });
    app.put('/einheiten/:id', { preHandler: requireAuth(P.stammEdit) }, async (req) => {
      const { id } = idParam.parse(req.params);
      const b = einheitBody.parse(req.body);
      await change(req, (tx) => tx`update miete.einheiten set ${tx(b)} where id = ${id}`);
      return { ok: true };
    });
    app.delete('/einheiten/:id', { preHandler: requireAuth(P.stammEdit) }, async (req) => {
      const { id } = idParam.parse(req.params);
      const { reason } = grund.parse(req.body ?? {});
      await nichtVerwendet(sql`select (select count(*) from miete.vertraege where einheit_id = ${id}) + (select count(*) from miete.zaehler where einheit_id = ${id})
                                      + (select count(*) from miete.kosten where einheit_id = ${id}) as n` as any,
      'Die Wohnung hat Mietverhältnisse, Zähler oder Kosten – sie kann nicht gelöscht werden.');
      await change(req, (tx) => tx`delete from miete.einheiten where id = ${id}`, { action: 'LOESCHEN', reason });
      return { ok: true };
    });

    const vertragBody = z.object({
      einheit_id: z.coerce.number().int().positive(), name: z.string().trim().min(1).max(200), email: opt(200), telefon: opt(50), anschrift: opt(500),
      beginn: datum, ende: datumOpt, personen: z.coerce.number().min(0), notiz: opt(5000),
    }).refine((v) => !v.ende || v.ende >= v.beginn, { message: 'Das Ende liegt vor dem Beginn.', path: ['ende'] });
    const konditionBody = z.object({ gueltig_ab: datum, kaltmiete: betrag.pipe(z.number().min(0)), nk_abschlag: betrag.pipe(z.number().min(0)) });

    app.get('/vertraege', { preHandler: requireAuth() }, async (req) => {
      if (![P.stammDisplay, P.zahlungenDisplay, P.abrechnungDisplay].some((p) => can(req, p))) throw new BusinessError('Keine Berechtigung.', 403);
      return vertraegeLesen();
    });
    app.post('/vertraege', { preHandler: requireAuth(P.stammEdit) }, async (req) => {
      const { kondition, ...rest } = z.object({ kondition: konditionBody.omit({ gueltig_ab: true }) }).passthrough().parse(req.body);
      const b = vertragBody.parse(rest);
      return change(req, async (tx) => {
        const [{ n }] = await tx`select core.next_number('MIETVERTRAG') as n`;
        const nummer = 'MV' + String(n).padStart(4, '0');
        const [v] = await tx`insert into miete.vertraege ${tx({ ...b, nummer })} returning id, nummer`;
        await tx`insert into miete.konditionen (vertrag_id, gueltig_ab, kaltmiete, nk_abschlag) values (${v.id}, ${b.beginn}, ${kondition.kaltmiete}, ${kondition.nk_abschlag})`;
        return v;
      });
    });
    app.put('/vertraege/:id', { preHandler: requireAuth(P.stammEdit) }, async (req) => {
      const { id } = idParam.parse(req.params);
      const b = vertragBody.parse(req.body);
      await change(req, async (tx) => {
        const r = await tx`update miete.vertraege set ${tx(b)} where id = ${id}`;
        if (r.count === 0) throw new BusinessError('Mietverhältnis nicht gefunden.', 404);
      });
      return { ok: true };
    });
    app.delete('/vertraege/:id', { preHandler: requireAuth(P.stammEdit) }, async (req) => {
      const { id } = idParam.parse(req.params);
      const { reason } = grund.parse(req.body ?? {});
      await nichtVerwendet(sql`select (select count(*) from miete.zahlungen where vertrag_id = ${id}) + (select count(*) from miete.abrechnungen where vertrag_id = ${id}) as n` as any,
        'Zum Mietverhältnis gibt es Mieteingänge oder Abrechnungen – stattdessen ein Ende eintragen.');
      await change(req, (tx) => tx`delete from miete.vertraege where id = ${id}`, { action: 'LOESCHEN', reason });
      return { ok: true };
    });
    app.post('/vertraege/:id/konditionen', { preHandler: requireAuth(P.stammEdit) }, async (req) => {
      const { id } = idParam.parse(req.params);
      const b = konditionBody.parse(req.body);
      await change(req, (tx) => tx`insert into miete.konditionen (vertrag_id, gueltig_ab, kaltmiete, nk_abschlag) values (${id}, ${b.gueltig_ab}, ${b.kaltmiete}, ${b.nk_abschlag})
                                   on conflict (vertrag_id, gueltig_ab) do update set kaltmiete = excluded.kaltmiete, nk_abschlag = excluded.nk_abschlag`);
      return { ok: true };
    });
    app.delete('/konditionen/:id', { preHandler: requireAuth(P.stammEdit) }, async (req) => {
      const { id } = idParam.parse(req.params);
      await change(req, async (tx) => {
        const [k] = await tx`select vertrag_id from miete.konditionen where id = ${id}`;
        if (!k) throw new BusinessError('Kondition nicht gefunden.', 404);
        const [{ n }] = await tx`select count(*)::int as n from miete.konditionen where vertrag_id = ${k.vertrag_id}`;
        if (n <= 1) throw new BusinessError('Die letzte Kondition eines Mietverhältnisses bleibt stehen – ändern statt löschen.');
        await tx`delete from miete.konditionen where id = ${id}`;
      });
      return { ok: true };
    });

    const kostenartBody = z.object({
      bezeichnung: z.string().trim().min(1).max(200), umlagefaehig: z.boolean(),
      schluessel: z.enum(['flaeche', 'personen', 'einheiten', 'anteil', 'verbrauch', 'direkt']),
      zaehler_id: z.coerce.number().int().positive().nullish().transform((v) => v ?? null), grundanteil: z.coerce.number().min(0).max(100).default(0),
      rest_einheit_id: z.coerce.number().int().positive().nullish().transform((v) => v ?? null),
      gemeinsam_schluessel: z.enum(['flaeche', 'personen', 'einheiten']).default('flaeche'),
      anteile: z.record(z.coerce.number().min(0).max(100)).default({}), p35a: z.boolean().default(false), sort: z.coerce.number().int().default(0), aktiv: z.boolean().default(true),
    }).refine((k) => k.schluessel !== 'verbrauch' || k.zaehler_id, { message: 'Für „Verbrauch“ den Hauptzähler wählen.', path: ['zaehler_id'] });
    app.get('/kostenarten', { preHandler: requireAuth() }, async (req) => {
      if (![P.stammDisplay, P.kostenDisplay, P.abrechnungDisplay].some((p) => can(req, p))) throw new BusinessError('Keine Berechtigung.', 403);
      return kostenartenLesen();
    });
    app.post('/kostenarten', { preHandler: requireAuth(P.stammEdit) }, async (req) => {
      const b = kostenartBody.parse(req.body);
      return change(req, async (tx) => (await tx`insert into miete.kostenarten ${tx({ ...b, anteile: tx.json(b.anteile) } as any)} returning id`)[0]);
    });
    app.put('/kostenarten/:id', { preHandler: requireAuth(P.stammEdit) }, async (req) => {
      const { id } = idParam.parse(req.params);
      const b = kostenartBody.parse(req.body);
      await change(req, (tx) => tx`update miete.kostenarten set ${tx({ ...b, anteile: tx.json(b.anteile) } as any)} where id = ${id}`);
      return { ok: true };
    });

    // ------------------------------------------------------------------ Mieteinnahmen
    app.get('/zahlungen', { preHandler: requireAuth(P.zahlungenDisplay) }, async (req) => {
      const { jahr } = jahrQuery.parse(req.query);
      return sql`select z.id, z.vertrag_id, v.nummer, v.name, e.kuerzel as einheit, z.datum::text as datum, z.monat::text as monat,
                        z.betrag::float8 as betrag, z.anteil_miete::float8 as anteil_miete, z.anteil_nk::float8 as anteil_nk, z.notiz
                   from miete.zahlungen z join miete.vertraege v on v.id = z.vertrag_id join miete.einheiten e on e.id = v.einheit_id
                  where extract(year from z.monat) = ${jahr} order by z.monat desc, z.datum desc, z.id desc`;
    });
    /** Soll und bereits Gezahltes je Mietverhältnis für einen Monat – Vorbelegung der Erfassung */
    app.get('/soll', { preHandler: requireAuth(P.zahlungenDisplay) }, async (req) => {
      const { monat } = z.object({ monat: datum.transform(monatsErster) }).parse(req.query);
      const ist = await sql`select vertrag_id, sum(betrag)::float8 as betrag from miete.zahlungen where monat = ${monat} group by vertrag_id`;
      return (await vertraegeLesen()).map((v) => ({ vertrag_id: v.id, nummer: v.nummer, name: v.name, einheit: v.einheit, ...sollMonat(v, monat), bezahlt: ist.find((x) => x.vertrag_id === v.id)?.betrag ?? 0 }))
        .filter((x) => x.miete + x.nk > 0);
    });
    const zahlungBody = z.object({
      vertrag_id: z.coerce.number().int().positive(), datum, monat: datum.transform(monatsErster), betrag,
      anteil_miete: betrag.nullish(), anteil_nk: betrag.nullish(), notiz: opt(500),
    });
    /** Anteile: angegeben (Summe muss stimmen) oder nach Soll des Monats vorgeschlagen */
    async function anteile(b: z.infer<typeof zahlungBody>) {
      if (b.anteil_miete != null && b.anteil_nk != null) {
        if (Math.abs(b.anteil_miete + b.anteil_nk - b.betrag) > 0.001) throw new BusinessError('Kaltmiete und Nebenkosten ergeben zusammen nicht den Betrag.');
        return { anteil_miete: b.anteil_miete, anteil_nk: b.anteil_nk };
      }
      const v = (await vertraegeLesen()).find((x) => x.id === b.vertrag_id);
      if (!v) throw new BusinessError('Mietverhältnis nicht gefunden.', 404);
      const s = sollMonat(v, b.monat);
      const t = aufteilen(b.betrag, s.miete, s.nk);
      return { anteil_miete: t.miete, anteil_nk: t.nk };
    }
    app.post('/zahlungen', { preHandler: requireAuth(P.zahlungenEdit) }, async (req) => {
      const b = zahlungBody.parse(req.body);
      const a = await anteile(b);
      return change(req, async (tx) => (await tx`insert into miete.zahlungen (vertrag_id, datum, monat, betrag, anteil_miete, anteil_nk, notiz)
                                                 values (${b.vertrag_id}, ${b.datum}, ${b.monat}, ${b.betrag}, ${a.anteil_miete}, ${a.anteil_nk}, ${b.notiz}) returning id`)[0]);
    });
    /** Monatslauf: für alle gewählten Mietverhältnisse den Eingang in Höhe des Solls erfassen (bereits erfasste bleiben unberührt) */
    app.post('/zahlungen/monat', { preHandler: requireAuth(P.zahlungenEdit) }, async (req) => {
      const b = z.object({ monat: datum.transform(monatsErster), datum, vertrag_ids: z.array(z.coerce.number().int().positive()).min(1) }).parse(req.body);
      const vs = (await vertraegeLesen()).filter((v) => b.vertrag_ids.includes(v.id));
      return change(req, async (tx) => {
        let n = 0;
        for (const v of vs) {
          const [{ da }] = await tx`select count(*)::int as da from miete.zahlungen where vertrag_id = ${v.id} and monat = ${b.monat}`;
          const s = sollMonat(v, b.monat);
          if (da || s.miete + s.nk <= 0) continue;
          await tx`insert into miete.zahlungen (vertrag_id, datum, monat, betrag, anteil_miete, anteil_nk)
                   values (${v.id}, ${b.datum}, ${b.monat}, ${r2(s.miete + s.nk)}, ${s.miete}, ${s.nk})`;
          n++;
        }
        return { erfasst: n };
      });
    });
    app.put('/zahlungen/:id', { preHandler: requireAuth(P.zahlungenEdit) }, async (req) => {
      const { id } = idParam.parse(req.params);
      const b = zahlungBody.parse(req.body);
      const a = await anteile(b);
      await change(req, async (tx) => {
        const r = await tx`update miete.zahlungen set vertrag_id = ${b.vertrag_id}, datum = ${b.datum}, monat = ${b.monat}, betrag = ${b.betrag},
                             anteil_miete = ${a.anteil_miete}, anteil_nk = ${a.anteil_nk}, notiz = ${b.notiz} where id = ${id}`;
        if (r.count === 0) throw new BusinessError('Mieteingang nicht gefunden.', 404);
      });
      return { ok: true };
    });
    app.delete('/zahlungen/:id', { preHandler: requireAuth(P.zahlungenEdit) }, async (req) => {
      const { id } = idParam.parse(req.params);
      const { reason } = grund.parse(req.body ?? {});
      await change(req, (tx) => tx`delete from miete.zahlungen where id = ${id}`, { action: 'LOESCHEN', reason });
      return { ok: true };
    });

    // ------------------------------------------------------------------ Laufende Kosten
    const kostenBody = z.object({
      kostenart_id: z.coerce.number().int().positive(), datum, von: datumOpt, bis: datumOpt, betrag,
      lieferant: opt(200), belegnr: opt(100), einheit_id: z.coerce.number().int().positive().nullish().transform((v) => v ?? null),
      paperless_id: z.coerce.number().int().positive().nullish().transform((v) => v ?? null), notiz: opt(2000),
    }).refine((k) => !k.von === !k.bis, { message: 'Leistungszeitraum: Beginn und Ende angeben (oder beide leer lassen).', path: ['bis'] })
      .refine((k) => !k.von || !k.bis || k.bis >= k.von, { message: 'Das Ende des Leistungszeitraums liegt vor dem Beginn.', path: ['bis'] });
    app.get('/kosten', { preHandler: requireAuth(P.kostenDisplay) }, async (req) => {
      const { jahr } = jahrQuery.parse(req.query);
      return kostenLesen(`${jahr}-01-01`, `${jahr}-12-31`);
    });
    app.post('/kosten', { preHandler: requireAuth(P.kostenEdit) }, async (req) => {
      const b = kostenBody.parse(req.body);
      return change(req, async (tx) => (await tx`insert into miete.kosten ${tx(b)} returning id`)[0]);
    });
    app.put('/kosten/:id', { preHandler: requireAuth(P.kostenEdit) }, async (req) => {
      const { id } = idParam.parse(req.params);
      const b = kostenBody.parse(req.body);
      await change(req, async (tx) => {
        const r = await tx`update miete.kosten set ${tx(b)} where id = ${id}`;
        if (r.count === 0) throw new BusinessError('Kostenposition nicht gefunden.', 404);
      });
      return { ok: true };
    });
    app.delete('/kosten/:id', { preHandler: requireAuth(P.kostenEdit) }, async (req) => {
      const { id } = idParam.parse(req.params);
      const { reason } = grund.parse(req.body ?? {});
      await change(req, (tx) => tx`delete from miete.kosten where id = ${id}`, { action: 'LOESCHEN', reason });
      return { ok: true };
    });
    /** Beleg (Datei als data-URL) nach Paperless hochladen und mit der Kostenposition verknüpfen */
    app.post('/kosten/:id/beleg', { preHandler: requireAuth(P.kostenEdit) }, async (req) => {
      const { id } = idParam.parse(req.params);
      const b = z.object({ datei: z.string().trim().min(1).max(200), inhalt: z.string().regex(/^data:[^;]+;base64,/, 'Datei fehlt') }).parse(req.body);
      const [k] = await sql`select k.datum::text as datum, k.von::text as von, k.bis::text as bis, k.betrag::float8 as betrag, k.lieferant, a.bezeichnung as kostenart
                              from miete.kosten k join miete.kostenarten a on a.id = k.kostenart_id where k.id = ${id}`;
      if (!k) throw new BusinessError('Kostenposition nicht gefunden.', 404);
      const [o] = await sql`select bezeichnung from miete.objekt where id = 1`;
      const mime = b.inhalt.slice(5, b.inhalt.indexOf(';'));
      const daten = Buffer.from(b.inhalt.slice(b.inhalt.indexOf(',') + 1), 'base64');
      const d = (x: string) => `${x.slice(8, 10)}.${x.slice(5, 7)}.${x.slice(0, 4)}`;
      const e = await kontextAblegen(await paperless(), K.beleg, 'miete', {
        kostenart: k.kostenart, lieferant: k.lieferant ?? '', datum: k.datum, betrag: k.betrag, zeitraum: k.von ? `${d(k.von)}–${d(k.bis)}` : '',
        objekt: o?.bezeichnung ?? '', datei: b.datei, heute: new Date().toISOString().slice(0, 10), benutzer: benutzer(req),
      }, daten, b.datei, { mime, benutzer: benutzer(req) });
      if (e.id) await change(req, (tx) => tx`update miete.kosten set paperless_id = ${e.id} where id = ${id}`);
      return { id: e.id, warnungen: e.warnungen, text: e.id ? `In Paperless abgelegt (Dokument ${e.id}).` : 'An Paperless übergeben – die Verarbeitung läuft noch; bitte später verknüpfen.' };
    });

    // ------------------------------------------------------------------ Paperless
    const plRecht = (req: Parameters<typeof can>[0]) => {
      if (![P.kostenDisplay, P.abrechnungDisplay].some((p) => can(req, p))) throw new BusinessError('Keine Berechtigung.', 403);
    };
    app.get('/paperless/status', { preHandler: requireAuth() }, async (req) => {
      plRecht(req);
      const [o] = await sql`select paperless_tag from miete.objekt where id = 1`;
      return { eingerichtet: !!(await paperlessFuer('miete')), tag: o?.paperless_tag ?? '' };
    });
    app.get('/paperless/suche', { preHandler: requireAuth(P.kostenDisplay) }, async (req) => {
      const { q } = z.object({ q: z.string().trim().default('') }).parse(req.query);
      const pl = await paperless();
      const docs = await pl.dokumenteErsteSeite({ ordering: '-created', ...(q ? (/^\d+$/.test(q) ? { id: q } : { title_content__icontains: q }) : {}) }, 30);
      return Promise.all(docs.map((d) => dokumentKurz(pl, d)));
    });
    /** Belege in Paperless mit dem Schlagwort des Hauses, die noch keiner Kostenposition zugeordnet sind */
    app.get('/paperless/eingang', { preHandler: requireAuth(P.kostenDisplay) }, async () => {
      const [o] = await sql`select paperless_tag from miete.objekt where id = 1`;
      if (!o?.paperless_tag) return { tag: '', dokumente: [] };
      const pl = await paperless();
      const tag = await pl.tag(o.paperless_tag, false);
      if (!tag) return { tag: o.paperless_tag, dokumente: [], hinweis: `Das Schlagwort „${o.paperless_tag}“ gibt es in Paperless nicht.` };
      const docs = await pl.dokumenteErsteSeite({ tags__id__all: String(tag), ordering: '-created' }, 100);
      const verknuepft = new Set((await sql`select paperless_id from miete.kosten where paperless_id = any(${docs.map((d) => Number(d.id))}::int[])`).map((r) => r.paperless_id as number));
      const frei = docs.filter((d) => !verknuepft.has(Number(d.id)));
      return { tag: o.paperless_tag, dokumente: await Promise.all(frei.map((d) => dokumentKurz(pl, d))) };
    });
    app.get('/paperless/:id/datei', { preHandler: requireAuth() }, async (req, reply) => {
      plRecht(req);
      const { id } = idParam.parse(req.params);
      // nur Dokumente, die in der Vermietung verknüpft sind (oder gesucht werden dürfen)
      const [{ n }] = await sql`select (select count(*) from miete.kosten where paperless_id = ${id}) + (select count(*) from miete.abrechnungen where paperless_id = ${id}) as n`;
      if (!Number(n) && !can(req, P.kostenDisplay)) throw new BusinessError('Dokument ist nicht verknüpft.', 404);
      const d = await (await paperless()).download(id);
      return reply.type(d.contentType).header('content-disposition', `inline; filename="${encodeURIComponent(d.filename)}"`).send(d.data);
    });

    // ------------------------------------------------------------------ Zähler
    const zaehlerBody = z.object({
      bezeichnung: z.string().trim().min(1).max(200), nummer: opt(100), art: z.enum(['strom', 'waerme', 'wasser', 'gas', 'sonstig']), masseinheit: z.string().trim().min(1).max(20).default('kWh'),
      einheit_id: z.coerce.number().int().positive().nullish().transform((v) => v ?? null), haupt_id: z.coerce.number().int().positive().nullish().transform((v) => v ?? null),
      aktiv: z.boolean().default(true),
    });
    app.get('/zaehler', { preHandler: requireAuth() }, async (req) => {
      if (![P.zaehlerDisplay, P.stammDisplay].some((p) => can(req, p))) throw new BusinessError('Keine Berechtigung.', 403);
      return zaehlerLesen();
    });
    app.post('/zaehler', { preHandler: requireAuth(P.zaehlerEdit) }, async (req) => {
      const b = zaehlerBody.parse(req.body);
      return change(req, async (tx) => (await tx`insert into miete.zaehler ${tx(b)} returning id`)[0]);
    });
    app.put('/zaehler/:id', { preHandler: requireAuth(P.zaehlerEdit) }, async (req) => {
      const { id } = idParam.parse(req.params);
      const b = zaehlerBody.parse(req.body);
      if (b.haupt_id === id) throw new BusinessError('Ein Zähler kann nicht sein eigener Hauptzähler sein.');
      const baum = await sql`select id, haupt_id from miete.zaehler`;
      if (zaehlerKreis(baum as any, id, b.haupt_id)) throw new BusinessError('Ein Zähler kann nicht hinter einem seiner eigenen Unterzähler liegen.');
      await change(req, (tx) => tx`update miete.zaehler set ${tx(b)} where id = ${id}`);
      return { ok: true };
    });
    app.post('/zaehler/:id/ablesungen', { preHandler: requireAuth(P.zaehlerEdit) }, async (req) => {
      const { id } = idParam.parse(req.params);
      const b = z.object({ datum, stand: z.coerce.number().finite(), notiz: opt(500) }).parse(req.body);
      await change(req, (tx) => tx`insert into miete.ablesungen (zaehler_id, datum, stand, notiz) values (${id}, ${b.datum}, ${b.stand}, ${b.notiz})
                                   on conflict (zaehler_id, datum) do update set stand = excluded.stand, notiz = excluded.notiz`);
      return { ok: true };
    });
    app.delete('/ablesungen/:id', { preHandler: requireAuth(P.zaehlerEdit) }, async (req) => {
      const { id } = idParam.parse(req.params);
      await change(req, (tx) => tx`delete from miete.ablesungen where id = ${id}`, { action: 'LOESCHEN' });
      return { ok: true };
    });

    // ------------------------------------------------------------------ Übersicht
    app.get('/uebersicht', { preHandler: requireAuth(P.uebersicht) }, async (req) => {
      const { jahr } = jahrQuery.parse(req.query);
      return uebersicht(jahr);
    });

    // ------------------------------------------------------------------ Nebenkostenabrechnung
    app.get('/abrechnung', { preHandler: requireAuth(P.abrechnungDisplay) }, async (req) => {
      const { jahr } = jahrQuery.parse(req.query);
      const [{ verteilung, abrechnungen }, einheiten, fest] = await Promise.all([
        abrechnungJahr(jahr), einheitenLesen(),
        sql`select id, vertrag_id, kosten::float8 as kosten, vorauszahlungen::float8 as vorauszahlungen, ergebnis::float8 as ergebnis,
                   erstellt_von, to_char(erstellt_am at time zone 'Europe/Berlin', 'YYYY-MM-DD') as erstellt_am, versendet_am::text as versendet_am, paperless_id
              from miete.abrechnungen where jahr = ${jahr}`,
      ]);
      const eigen = new Set(einheiten.filter((e) => e.eigennutzung).map((e) => e.id));
      return {
        jahr, einheiten, verteilung, frist: abrechnungsFrist(`${jahr}-12-31`),
        abrechnungen: abrechnungen.map((a) => ({ ...a, festgeschrieben: fest.find((f) => f.vertrag_id === a.vertrag_id) ?? null })),
        vermieter: r2(verteilung.positionen.filter((p) => p.umlagefaehig).flatMap((p) => p.anteile).filter((a) => a.art !== 'miete' || eigen.has(a.einheit_id)).reduce((s, a) => s + a.betrag, 0)),
      };
    });
    app.post('/abrechnung/festschreiben', { preHandler: requireAuth(P.abrechnungEdit) }, async (req) => {
      const b = z.object({ jahr: z.coerce.number().int(), vertrag_id: z.coerce.number().int().positive() }).parse(req.body);
      const { verteilung, abrechnungen } = await abrechnungJahr(b.jahr);
      const a = abrechnungen.find((x) => x.vertrag_id === b.vertrag_id);
      if (!a) throw new BusinessError('Das Mietverhältnis liegt nicht im Abrechnungsjahr.');
      if (`${b.jahr}-12-31` >= new Date().toISOString().slice(0, 10)) throw new BusinessError(`Das Jahr ${b.jahr} ist noch nicht abgeschlossen.`);
      return change(req, async (tx) => {
        const [r] = await tx`insert into miete.abrechnungen (jahr, vertrag_id, von, bis, kosten, vorauszahlungen, ergebnis, daten, erstellt_von)
                             values (${b.jahr}, ${b.vertrag_id}, ${a.von}, ${a.bis}, ${a.kosten}, ${a.vorauszahlungen}, ${a.ergebnis},
                                     ${tx.json({ abrechnung: a, hinweise: verteilung.hinweise } as any)}, ${benutzer(req)})
                             on conflict (jahr, vertrag_id) do nothing returning id`;
        if (!r) throw new BusinessError('Die Abrechnung ist bereits festgeschrieben – zum Neuberechnen erst wieder öffnen.');
        return r;
      });
    });
    app.delete('/abrechnungen/:id', { preHandler: requireAuth(P.abrechnungEdit) }, async (req) => {
      const { id } = idParam.parse(req.params);
      const { reason } = grund.parse(req.body ?? {});
      await change(req, (tx) => tx`delete from miete.abrechnungen where id = ${id}`, { action: 'LOESCHEN', reason });
      return { ok: true };
    });
    app.post('/abrechnungen/:id/versendet', { preHandler: requireAuth(P.abrechnungEdit) }, async (req) => {
      const { id } = idParam.parse(req.params);
      const b = z.object({ datum: datumOpt }).parse(req.body);
      await change(req, (tx) => tx`update miete.abrechnungen set versendet_am = ${b.datum} where id = ${id}`);
      return { ok: true };
    });

    async function druck(id: number): Promise<{ html: string; d: AbrechnungDruck; datei: string }> {
      const [r] = await sql`select a.jahr, a.daten, a.vertrag_id, to_char(a.erstellt_am at time zone 'Europe/Berlin', 'DD.MM.YYYY') as erstellt,
                                   v.name, v.anschrift, e.kuerzel as einheit
                              from miete.abrechnungen a join miete.vertraege v on v.id = a.vertrag_id join miete.einheiten e on e.id = v.einheit_id where a.id = ${id}`;
      if (!r) throw new BusinessError('Abrechnung nicht gefunden.', 404);
      const [o] = await sql`select bezeichnung, strasse, plz, ort, vermieter, vermieter_anschrift, iban from miete.objekt where id = 1`;
      const x = r.daten.abrechnung;
      const d: AbrechnungDruck = { ...x, jahr: r.jahr, objekt: o as any, mieter: { name: r.name, anschrift: r.anschrift, einheit: r.einheit }, erstellt: `${o?.ort ?? ''}${o?.ort ? ', ' : ''}${r.erstellt}` };
      const s = await getPublicSettings();
      return { d, html: abrechnungHtml(d, (s['org.color'] as string) ?? undefined), datei: `Nebenkostenabrechnung_${r.jahr}_${r.einheit}.pdf` };
    }
    app.get('/abrechnungen/:id/pdf', { preHandler: requireAuth(P.abrechnungDisplay) }, async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const { html, datei } = await druck(id);
      return reply.type('application/pdf').header('content-disposition', `inline; filename="${datei}"`).send(await htmlToPdf(html));
    });
    app.post('/abrechnungen/:id/paperless', { preHandler: requireAuth(P.abrechnungEdit) }, async (req) => {
      const { id } = idParam.parse(req.params);
      const { html, d, datei } = await druck(id);
      const pdf = await htmlToPdf(html);
      const e = await kontextAblegen(await paperless(), K.abrechnung, 'miete', {
        jahr: String(d.jahr), mieter: d.mieter.name, einheit: d.mieter.einheit, ergebnis: d.ergebnis, objekt: d.objekt.bezeichnung,
        heute: new Date().toISOString().slice(0, 10), benutzer: benutzer(req),
      }, pdf, datei, { mime: 'application/pdf', benutzer: benutzer(req) });
      if (e.id) await change(req, (tx) => tx`update miete.abrechnungen set paperless_id = ${e.id} where id = ${id}`);
      return { id: e.id, warnungen: e.warnungen, text: e.id ? `In Paperless abgelegt (Dokument ${e.id}).` : 'An Paperless übergeben – die Verarbeitung läuft noch.' };
    });
  },
};

export default mod;
