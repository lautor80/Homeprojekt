import { sql } from '../../../server/src/db.js';
import {
  abrechnen, monateDesJahres, monatsLetzter, r2, sollMonat, verteilen,
  type Abrechnung, type Einheit, type Kosten, type Kostenart, type Verteilung, type Vertrag, type Zaehler,
} from './logik.js';

/** Lesezugriffe der Vermietung – Zahlen als number, Datum als JJJJ-MM-TT */

export async function einheitenLesen(): Promise<(Einheit & { bezeichnung: string; sort: number })[]> {
  return (await sql`select id, kuerzel, bezeichnung, flaeche::float8 as flaeche, personen::float8 as personen, eigennutzung, sort
                      from miete.einheiten order by sort, kuerzel`) as any;
}

export interface VertragZeile extends Vertrag {
  nummer: string; email: string | null; telefon: string | null; anschrift: string | null; notiz: string | null; einheit: string;
}

export async function vertraegeLesen(): Promise<VertragZeile[]> {
  const vs = (await sql`select v.id, v.nummer, v.einheit_id, e.kuerzel as einheit, v.name, v.email, v.telefon, v.anschrift, v.notiz,
                               v.beginn::text as beginn, v.ende::text as ende, v.personen::float8 as personen
                          from miete.vertraege v join miete.einheiten e on e.id = v.einheit_id
                         order by v.beginn desc, v.nummer`) as any as VertragZeile[];
  const ks = await sql`select id, vertrag_id, gueltig_ab::text as gueltig_ab, kaltmiete::float8 as kaltmiete, nk_abschlag::float8 as nk_abschlag
                         from miete.konditionen order by gueltig_ab`;
  for (const v of vs) v.konditionen = ks.filter((k) => k.vertrag_id === v.id) as any;
  return vs;
}

export async function kostenartenLesen(nurAktive = false): Promise<(Kostenart & { sort: number; aktiv: boolean })[]> {
  const rows = await sql`select id, bezeichnung, umlagefaehig, schluessel, zaehler_id, grundanteil::float8 as grundanteil, rest_einheit_id, gemeinsam_schluessel, anteile, p35a, sort, aktiv
                           from miete.kostenarten ${nurAktive ? sql`where aktiv` : sql``} order by sort, bezeichnung`;
  return rows.map((r) => ({ ...r, anteile: Object.fromEntries(Object.entries(r.anteile ?? {}).map(([k, v]) => [Number(k), Number(v)])) })) as any;
}

export async function zaehlerLesen(): Promise<(Zaehler & { nummer: string | null; art: string; masseinheit: string; aktiv: boolean })[]> {
  const zs = (await sql`select id, bezeichnung, nummer, art, masseinheit, einheit_id, haupt_id, aktiv from miete.zaehler order by haupt_id nulls first, bezeichnung`) as any[];
  const as = await sql`select id, zaehler_id, datum::text as datum, stand::float8 as stand, notiz from miete.ablesungen order by datum`;
  for (const z of zs) z.ablesungen = as.filter((a) => a.zaehler_id === z.id);
  return zs;
}

/** Kosten, die einen Zeitraum berühren (Belegdatum oder Leistungszeitraum) */
export async function kostenLesen(von: string, bis: string): Promise<(Kosten & Record<string, unknown>)[]> {
  return (await sql`
    select k.id, k.kostenart_id, a.bezeichnung as kostenart, a.umlagefaehig, k.datum::text as datum, k.von::text as von, k.bis::text as bis,
           k.betrag::float8 as betrag, k.lieferant, k.belegnr, k.einheit_id, k.paperless_id, k.notiz
      from miete.kosten k join miete.kostenarten a on a.id = k.kostenart_id
     where (k.von is null and k.datum between ${von} and ${bis}) or (k.von is not null and k.von <= ${bis} and k.bis >= ${von})
     order by k.datum desc, k.id desc`) as any;
}

/** Verteilung aller Kosten eines Zeitraums auf Einheiten und Mieter */
export async function verteilungFuer(von: string, bis: string): Promise<Verteilung> {
  const [einheiten, vertraege, kostenarten, kosten, zaehler] = await Promise.all([einheitenLesen(), vertraegeLesen(), kostenartenLesen(), kostenLesen(von, bis), zaehlerLesen()]);
  return verteilen({ von, bis, einheiten, vertraege, kostenarten, kosten, zaehler });
}

/** geleistete Nebenkosten-Abschläge je Mietverhältnis (Leistungsmonat im Zeitraum) */
export async function vorauszahlungen(von: string, bis: string): Promise<Map<number, number>> {
  const rows = await sql`select vertrag_id, sum(anteil_nk)::float8 as nk from miete.zahlungen where monat between ${von} and ${bis} group by vertrag_id`;
  return new Map(rows.map((r) => [r.vertrag_id as number, r.nk as number]));
}

export interface AbrechnungVorschau extends Abrechnung { nummer: string; name: string; einheit: string; sollNk: number }

/** Nebenkostenabrechnung eines Jahres für alle Mietverhältnisse, die das Jahr berühren (berechnet, nicht gespeichert) */
export async function abrechnungJahr(jahr: number): Promise<{ verteilung: Verteilung; abrechnungen: AbrechnungVorschau[] }> {
  const von = `${jahr}-01-01`, bis = `${jahr}-12-31`;
  const [verteilung, vertraege, vz] = await Promise.all([verteilungFuer(von, bis), vertraegeLesen(), vorauszahlungen(von, bis)]);
  const abrechnungen = vertraege
    .filter((v) => v.beginn <= bis && (!v.ende || v.ende >= von))
    .map((v) => ({
      ...abrechnen(verteilung, v, vz.get(v.id) ?? 0), nummer: v.nummer, name: v.name, einheit: v.einheit,
      sollNk: r2(monateDesJahres(jahr).reduce((s, m) => s + sollMonat(v, m).nk, 0)),
    }));
  return { verteilung, abrechnungen };
}

/** Monatsübersicht: Soll/Ist je Monat, Kosten (zeitanteilig) und der auf die Mieter entfallende Teil */
export async function uebersicht(jahr: number) {
  const von = `${jahr}-01-01`, bis = `${jahr}-12-31`;
  const [vertraege, einheiten, kostenarten, kosten, zaehler] = await Promise.all([vertraegeLesen(), einheitenLesen(), kostenartenLesen(), kostenLesen(von, bis), zaehlerLesen()]);
  const ist = await sql`select vertrag_id, monat::text as monat, sum(anteil_miete)::float8 as miete, sum(anteil_nk)::float8 as nk, sum(betrag)::float8 as betrag
                          from miete.zahlungen where monat between ${von} and ${bis} group by vertrag_id, monat`;
  const heute = new Date().toISOString().slice(0, 10);
  const monate = monateDesJahres(jahr).map((m) => {
    const mBis = monatsLetzter(m);
    const v = verteilen({ von: m, bis: mBis, einheiten, vertraege, kostenarten, kosten, zaehler });
    const soll = vertraege.map((x) => sollMonat(x, m));
    const im = ist.filter((x) => x.monat === m);
    const kostenGesamt = r2(v.positionen.reduce((s, p) => s + p.gesamt, 0));
    const umlagefaehig = r2(v.positionen.filter((p) => p.umlagefaehig).reduce((s, p) => s + p.gesamt, 0));
    const mieteranteil = r2(v.positionen.filter((p) => p.umlagefaehig).flatMap((p) => p.anteile).filter((a) => a.art === 'miete').reduce((s, a) => s + a.betrag, 0));
    const istMiete = r2(im.reduce((s, x) => s + x.miete, 0));
    const istNk = r2(im.reduce((s, x) => s + x.nk, 0));
    return {
      monat: m,
      vergangen: m <= heute,
      sollMiete: r2(soll.reduce((s, x) => s + x.miete, 0)),
      sollNk: r2(soll.reduce((s, x) => s + x.nk, 0)),
      istMiete, istNk,
      kosten: kostenGesamt,
      umlagefaehig,
      nichtUmlagefaehig: r2(kostenGesamt - umlagefaehig),
      mieteranteil,
      /** Abschläge der Mieter abzüglich ihres Kostenanteils: positiv = voraussichtlich Guthaben des Mieters */
      nkSaldo: r2(istNk - mieteranteil),
      /** Einnahmen abzüglich aller Kosten des Hauses */
      ergebnis: r2(istMiete + istNk - kostenGesamt),
    };
  });
  // offene Beträge je Mietverhältnis bis heute (bzw. Jahresende)
  const stichtag = bis < heute ? bis : heute;
  const offen = vertraege
    .filter((v) => v.beginn <= bis && (!v.ende || v.ende >= von))
    .map((v) => {
      const ms = monateDesJahres(jahr).filter((m) => m <= stichtag);
      const soll = ms.reduce((s, m) => { const x = sollMonat(v, m); return s + x.miete + x.nk; }, 0);
      const bezahlt = ist.filter((x) => x.vertrag_id === v.id && x.monat <= stichtag).reduce((s, x) => s + x.betrag, 0);
      return { vertrag_id: v.id, nummer: v.nummer, name: v.name, einheit: v.einheit, soll: r2(soll), ist: r2(bezahlt), offen: r2(soll - bezahlt) };
    });
  return { jahr, monate, offen };
}
