import { BusinessError } from '../../../../server/src/errors.js';
import { runden } from '../format.js';
import type { Db } from '../verein.js';
import { anfangsbestand, kontoGruppe, kontostand } from '../fi/daten.js';

/**
 * Kontenstamm – Port von Z2UI5_CL_TCO_KONTEN.
 * Stammdaten der FI-Konten (tco.fikonten) mit Übersicht, welche Konten in den
 * letzten Jahren bebucht wurden, und Pflege der Kontenverwendung je Geschäftsjahr
 * (tco.fikontojahr). Kein Eintrag = Konto aktiv. Nicht verwendete Konten werden in
 * den Kontenlisten der FI-Belege für das jeweilige Jahr ausgeblendet.
 *
 * Ergänzung gegenüber SAP: Pflege der Jahresanfangs-/Endbestände der Geldkonten
 * (tco.fibankab) – Grundlage der Saldenrechnung in fi/daten.ts.
 */

/** Jahresfenster wie in der ABAP-App: 4 Vorjahre, aktuelles Jahr, Folgejahr */
export const JAHRE = 6;
export const jahrVonStandard = () => new Date().getFullYear() - JAHRE + 2;

export const PROFITCENTER: { key: string; text: string }[] = [
  { key: '', text: '– kein Profit-Center –' },
  { key: 'Jugendarbeit', text: 'Jugendarbeit' },
  { key: 'Vereinsbetrieb', text: 'Vereinsbetrieb' },
  { key: 'Clubhaus', text: 'Clubhaus' },
  { key: 'Halle', text: 'Halle' },
  { key: 'Turniere', text: 'Turniere' },
];

export interface JahrInfo {
  jahr: number;
  /** Verwendung im Jahr (kein Eintrag in fikontojahr = aktiv) */
  aktiv: boolean;
  /** Anzahl Buchungen im Jahr */
  anz: number;
  /** Saldo Soll − Haben im Jahr */
  saldo: number;
}

export interface KontoZeile {
  konto: string;
  name: string;
  kennzahl: string;
  profitcenter: string;
  gruppe: string;
  /** letzte Buchung (JJJJ-MM-TT) oder null = nie bebucht */
  letzte: string | null;
  /** im Jahresfenster bebucht */
  bebucht: boolean;
  /** im aktuellen Kalenderjahr verwendet */
  aktAktiv: boolean;
  jahre: JahrInfo[];
}

export interface Uebersicht { von: number; bis: number; aktJahr: number; profitcenter: typeof PROFITCENTER; zeilen: KontoZeile[] }

const nr = (k: string) => (/^\d+$/.test(k) ? Number(k) : 999999);

/** Konten numerisch sortiert, je Jahr des Fensters Anzahl Buchungen, Saldo und Verwendungskennzeichen (DATEN_LESEN) */
export async function uebersichtLesen(db: Db, von: number): Promise<Uebersicht> {
  const bis = von + JAHRE - 1;
  const aktJahr = new Date().getFullYear();
  const konten = await db`select konto, coalesce(name, '') as name, coalesce(kennzahl, '') as kennzahl, coalesce(profitcenter, '') as profitcenter from tco.fikonten`;
  const bu = await db`
    select konto, jahr, count(*)::int as anz, coalesce(sum(coalesce(soll, 0) - coalesce(haben, 0)), 0)::float8 as saldo
      from tco.fibuchungen where jahr between ${von} and ${bis} group by konto, jahr`;
  const last = await db`select konto, max(datum)::text as letzt from tco.fibuchungen group by konto`;
  const kj = await db`select konto, jahr, aktiv from tco.fikontojahr where jahr between ${von} and ${bis}`;
  const akt = await db`select konto, aktiv from tco.fikontojahr where jahr = ${aktJahr}`;

  const buMap = new Map<string, { anz: number; saldo: number }>(bu.map((b) => [`${b.konto}|${b.jahr}`, { anz: Number(b.anz), saldo: Number(b.saldo) }]));
  const kjMap = new Map<string, boolean>(kj.map((x) => [`${x.konto}|${x.jahr}`, Boolean(x.aktiv)]));
  const lastMap = new Map<string, string | null>(last.map((l) => [String(l.konto), (l.letzt as string | null) ?? null]));
  const aktMap = new Map<string, boolean>(akt.map((a) => [String(a.konto), Boolean(a.aktiv)]));

  const zeilen: KontoZeile[] = konten
    .map((k) => {
      const konto = String(k.konto).trim();
      const jahre: JahrInfo[] = [];
      let bebucht = false;
      for (let j = von; j <= bis; j++) {
        const b = buMap.get(`${konto}|${j}`);
        if (b && b.anz > 0) bebucht = true;
        jahre.push({ jahr: j, aktiv: kjMap.get(`${konto}|${j}`) ?? true, anz: b?.anz ?? 0, saldo: runden(b?.saldo ?? 0) });
      }
      return {
        konto, name: k.name, kennzahl: k.kennzahl, profitcenter: k.profitcenter,
        gruppe: kontoGruppe(konto, k.kennzahl || null),
        letzte: lastMap.get(konto) ?? null, bebucht, aktAktiv: aktMap.get(konto) ?? true, jahre,
      };
    })
    .sort((a, b) => nr(a.konto) - nr(b.konto) || a.konto.localeCompare(b.konto));

  return { von, bis, aktJahr, profitcenter: PROFITCENTER, zeilen };
}

export interface KontoEingabe {
  konto: string;
  name: string;
  kennzahl: string;
  profitcenter: string;
  neu: boolean;
  /** Verwendung je Jahr – nur die Jahre des Fensters, die gesetzt werden sollen */
  jahre: { jahr: number; aktiv: boolean }[];
}

/**
 * Neue Konten anlegen, Bezeichnung/Kennzahl/Profit-Center ändern und geänderte
 * Jahreskennzeichen in fikontojahr schreiben (SPEICHERN). Es werden nur tatsächliche
 * Abweichungen zum Datenbankstand geschrieben; ein Fehler bricht alles ab (Transaktion).
 */
export async function speichern(tx: Db, benutzer: string, zeilen: KontoEingabe[]): Promise<{ aenderungen: number; neu: number }> {
  let aenderungen = 0;
  let neu = 0;
  for (const z of zeilen) {
    const konto = z.konto.trim();
    const kennzahl = z.kennzahl.trim().toUpperCase();
    const name = z.name.trim();
    const pc = z.profitcenter.trim();
    if (!PROFITCENTER.some((p) => p.key === pc)) throw new BusinessError(`Konto ${konto}: unbekanntes Profit-Center „${pc}“.`);

    if (z.neu) {
      if (!/^\d{1,4}$/.test(konto)) throw new BusinessError(`Neues Konto "${konto}": bitte eine Kontonummer mit bis zu 4 Ziffern eingeben.`);
      const [ex] = await tx`select konto from tco.fikonten where konto = ${konto}`;
      if (ex) throw new BusinessError(`Konto ${konto} ist bereits vorhanden.`);
      await tx`insert into tco.fikonten (konto, name, kennzahl, profitcenter) values (${konto}, ${name}, ${kennzahl}, ${pc})`;
      neu++;
    } else {
      const [alt] = await tx`select coalesce(name, '') as name, coalesce(kennzahl, '') as kennzahl, coalesce(profitcenter, '') as profitcenter from tco.fikonten where konto = ${konto}`;
      if (!alt) throw new BusinessError(`Konto ${konto} ist nicht vorhanden.`);
      if (alt.name !== name || alt.kennzahl !== kennzahl || alt.profitcenter !== pc) {
        await tx`update tco.fikonten set name = ${name}, kennzahl = ${kennzahl}, profitcenter = ${pc} where konto = ${konto}`;
        aenderungen++;
      }
    }

    for (const j of z.jahre) {
      const [kj] = await tx`select aktiv from tco.fikontojahr where konto = ${konto} and jahr = ${j.jahr}`;
      const alt: boolean = kj ? kj.aktiv : true;
      if (alt === j.aktiv) continue;
      await tx`insert into tco.fikontojahr (konto, jahr, aktiv, geaendert_am, geaendert_von) values (${konto}, ${j.jahr}, ${j.aktiv}, now(), ${benutzer})
               on conflict (konto, jahr) do update set aktiv = excluded.aktiv, geaendert_am = excluded.geaendert_am, geaendert_von = excluded.geaendert_von`;
      aenderungen++;
    }
  }
  return { aenderungen, neu };
}

/**
 * Vorschlag für ein Jahr (VORSCHLAG): verwenden, wenn das Konto im Jahr oder im Vorjahr
 * bebucht wurde; Bank-/Kassen-/Kreditkonten bleiben aktiv. Nur Anzeige – wirksam erst mit Speichern.
 */
export async function vorschlag(db: Db, jahr: number): Promise<{ jahr: number; aktiv: Record<string, boolean>; abgewaehlt: number; text: string }> {
  const used = new Set((await db`select distinct konto from tco.fibuchungen where jahr in (${jahr}, ${jahr - 1})`).map((r) => String(r.konto).trim()));
  const konten = await db`select konto, coalesce(kennzahl, '') as kennzahl from tco.fikonten`;
  const aktiv: Record<string, boolean> = {};
  let aus = 0;
  for (const k of konten) {
    const konto = String(k.konto).trim();
    const an = k.kennzahl === 'BA' || k.kennzahl === 'BK' || used.has(konto);
    aktiv[konto] = an;
    if (!an) aus++;
  }
  return {
    jahr, aktiv, abgewaehlt: aus,
    text: `Vorschlag ${jahr}: ${aus} Konten ohne Buchungen in ${jahr - 1}/${jahr} abgewählt. Bank-, Kassen- und Kreditkonten bleiben aktiv. Zum Übernehmen bitte speichern.`,
  };
}

// ---------------------------------------------------------------------------
// Jahresanfangsbestände der Geldkonten (tco.fibankab)
// ---------------------------------------------------------------------------

export interface Bestand {
  konto: string;
  name: string;
  kennzahl: string;
  /** gepflegter Anfangsbestand (null = nicht gepflegt) */
  anfangsbestand: number | null;
  /** gepflegter Endbestand (null = nicht gepflegt) */
  endbestand: number | null;
  /** von der Saldenrechnung verwendeter Anfangsbestand mit Herkunft */
  rechnerisch: number;
  quelle: string;
  /** Kontostand 31.12. laut Buchungen (Anfangsbestand + Bewegungen) */
  kontostand: number;
  /** Abweichung gepflegter Endbestand − rechnerischer Kontostand (null, wenn kein Endbestand) */
  differenz: number | null;
}

/** Anfangs-/Endbestände aller Bank-, Kassen- und Kreditkonten (Kennzahl BA/BK) im Jahr */
export async function bestaendeLesen(db: Db, jahr: number): Promise<Bestand[]> {
  const konten = await db`select konto, coalesce(name, '') as name, coalesce(kennzahl, '') as kennzahl from tco.fikonten where kennzahl in ('BA', 'BK')`;
  const ab = await db`select konto, anfangsbestand::float8 as a, endbestand::float8 as e from tco.fibankab where jahr = ${jahr}`;
  const abMap = new Map<string, { a: number | null; e: number | null }>(ab.map((x) => [String(x.konto).trim(), { a: x.a ?? null, e: x.e ?? null }]));
  const out: Bestand[] = [];
  for (const k of konten) {
    const konto = String(k.konto).trim();
    const g = abMap.get(konto);
    const r = await anfangsbestand(db, konto, jahr);
    const stand = await kontostand(db, konto, `${jahr}-12-31`);
    const e = g?.e ?? null;
    out.push({
      konto, name: k.name, kennzahl: k.kennzahl, anfangsbestand: g?.a ?? null, endbestand: e,
      rechnerisch: r.betrag, quelle: r.quelle, kontostand: stand, differenz: e === null ? null : runden(e - stand),
    });
  }
  return out.sort((a, b) => nr(a.konto) - nr(b.konto) || a.konto.localeCompare(b.konto));
}

/** Anfangs-/Endbestand eines Geldkontos im Jahr pflegen (null löscht den jeweiligen Wert) */
export async function bestandSpeichern(tx: Db, d: { jahr: number; konto: string; anfangsbestand: number | null; endbestand: number | null }): Promise<string> {
  const [k] = await tx`select kennzahl from tco.fikonten where konto = ${d.konto}`;
  if (!k) throw new BusinessError(`Konto ${d.konto} ist nicht vorhanden.`);
  if (k.kennzahl !== 'BA' && k.kennzahl !== 'BK') throw new BusinessError(`Konto ${d.konto} ist kein Bank-, Kassen- oder Kreditkonto (Kennzahl BA/BK).`);
  if (d.anfangsbestand === null && d.endbestand === null) {
    await tx`delete from tco.fibankab where jahr = ${d.jahr} and konto = ${d.konto}`;
    return `Bestände ${d.jahr} für Konto ${d.konto} entfernt.`;
  }
  await tx`insert into tco.fibankab (jahr, konto, anfangsbestand, endbestand) values (${d.jahr}, ${d.konto}, ${d.anfangsbestand}, ${d.endbestand})
           on conflict (jahr, konto) do update set anfangsbestand = excluded.anfangsbestand, endbestand = excluded.endbestand`;
  return `Bestände ${d.jahr} für Konto ${d.konto} gespeichert.`;
}
