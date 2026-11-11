/**
 * Offene Rechnungen zum Stichtag (#28) – Forderungen aus dem Portal, die noch nicht bezahlt sind und deshalb (noch) nicht auf
 * den Geldkonten stehen:
 *   Halle      gestellte Hallenrechnungen (gedruckt, versendet, teilbezahlt; bezahlt erst nach dem Stichtag), Betrag abzüglich
 *              Teilzahlungen; „In Bearbeitung“ (noch nicht gestellt) und „Forderung ausgefallen“ zählen nicht
 *   Verzehr    gestellte Verzehrabrechnungen und offene Gastbelege, ohne die per Lastschrift in einem Beitragslauf eingezogenen
 *              (die stecken im Lauf)
 *   Beiträge   Sollstellungsläufe (Lastschrift), die noch nicht in FI verbucht sind bzw. erst nach dem Stichtag
 * Die Clubhaus-Forderung (Pächter, `tco.forderungen`) bleibt eigene Position der Liquidität.
 * Es wird nur gelesen.
 */
import type { Db } from './verein.js';
import { runden } from './format.js';

export interface OffeneRechnungen { halle: number; verzehr: number; beitraege: number; summe: number; anzahl: number }
interface Posten { quelle: 'halle' | 'verzehr' | 'beitraege'; ab: string | null; bis: string | null; betrag: number; offenJetzt: boolean }

/** alle Posten mit Ausstellungs- und Zahldatum einmal lesen – je Stichtag wird dann nur gefiltert */
async function postenLesen(db: Db): Promise<Posten[]> {
  const halle = await db`
    select coalesce(k.gedruckt, k.versendet, k.angelegt_am)::text as ab, k.bezahlt::text as bis, k.status,
           (k.betrag - coalesce((select sum(z.betrag) from tco.rgtz z where z.rgnr_txt = k.rgnr_txt), 0))::float8 as rest,
           k.betrag::float8 as betrag
      from tco.rgkopf k where k.status in ('2', '3', '4', '5')`;
  const vz = await db`
    select datum::text as ab, bezahlt_am::text as bis, status, betrag::float8 as betrag
      from tco.vz_belege
     where laufid is null and (status = 'GESTELLT' or (status = 'OFFEN' and art = 'GAST') or (status = 'BEZAHLT' and bezahlt_am is not null))`;
  const soll = await db`
    select coalesce(erdat, faellig)::text as ab, fi_datum::text as bis, status, coalesce(summe, 0)::float8 as betrag
      from tco.soll_kopf where status in ('E', 'Z', 'V')`;
  return [
    // bezahlte Rechnung: bis zum Zahltag offen (voller Betrag); offene/teilbezahlte: Rest
    ...halle.map((r) => ({ quelle: 'halle' as const, ab: r.ab, bis: r.status === '4' ? r.bis : null, betrag: r.status === '4' ? r.betrag : Math.max(0, r.rest), offenJetzt: r.status !== '4' })),
    ...vz.map((r) => ({ quelle: 'verzehr' as const, ab: r.ab, bis: r.status === 'BEZAHLT' ? r.bis : null, betrag: r.betrag, offenJetzt: r.status !== 'BEZAHLT' })),
    ...soll.map((r) => ({ quelle: 'beitraege' as const, ab: r.ab, bis: r.status === 'V' ? r.bis : null, betrag: r.betrag, offenJetzt: r.status !== 'V' })),
  ].filter((p) => p.betrag > 0 && (p.offenJetzt || !!p.bis));
}

function summieren(posten: Posten[], stichtag: string): OffeneRechnungen {
  const o: OffeneRechnungen = { halle: 0, verzehr: 0, beitraege: 0, summe: 0, anzahl: 0 };
  for (const p of posten) {
    if (p.ab && p.ab > stichtag) continue;                 // erst nach dem Stichtag gestellt
    if (p.bis && p.bis <= stichtag) continue;              // bis zum Stichtag bezahlt
    o[p.quelle] += p.betrag;
    o.anzahl++;
  }
  o.halle = runden(o.halle); o.verzehr = runden(o.verzehr); o.beitraege = runden(o.beitraege);
  o.summe = runden(o.halle + o.verzehr + o.beitraege);
  return o;
}

/** offene Rechnungen zu einem Stichtag (JJJJ-MM-TT) */
export async function offeneRechnungen(db: Db, stichtag: string): Promise<OffeneRechnungen> {
  return summieren(await postenLesen(db), stichtag);
}

/** offene Rechnungen je Stichtag (z. B. Monatsenden) – eine Abfrage für alle */
export async function offeneRechnungenJe(db: Db, stichtage: string[]): Promise<Map<string, OffeneRechnungen>> {
  const posten = await postenLesen(db);
  return new Map(stichtage.map((s) => [s, summieren(posten, s)]));
}

/** Monatsende als Stichtag, für den laufenden Monat heute */
export function monatsende(jahr: number, monat: number, heute: string): string {
  const e = new Date(Date.UTC(jahr, monat, 0)).toISOString().slice(0, 10);
  return e > heute && heute.slice(0, 7) === e.slice(0, 7) ? heute : e;
}
