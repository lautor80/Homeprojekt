/**
 * Vereinsübersicht, Bereich Halle: Einzelbuchungen der Halle als Balkendiagramm – Anzahl je Tag, summiert auf Woche (KW),
 * Monat oder Jahr. Tag, Woche und Monat zeigen das gewählte Jahr, „Jahr“ alle Jahre mit Daten.
 * Einzelbuchung wie im Diagramm „Hallenbuchungen je Monat“ (charts.ts → halleStundenLesen): Status 1 und 5 sowie Abos,
 * die über bookings_ch zur Einzelabrechnung gekennzeichnet sind; storniert/entfallen zählt nicht. Termine nach heute
 * sind gebucht, aber noch nicht gespielt (zukünftig).
 */
import type { Db } from '../verein.js';
import { runden } from '../format.js';

export const EINZEL_RASTER = { TAG: 'Tag', WOCHE: 'Woche', MONAT: 'Monat', JAHR: 'Jahr' } as const;
export type EinzelRaster = keyof typeof EINZEL_RASTER;

export interface EinzelTag { datum: string; anzahl: number; stunden: number }
export interface EinzelPunkt { key: string; label: string; titel: string; anzahl: number; stunden: number; zukunft: boolean }

const MONATE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const MONATE_LANG = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const WOCHENTAGE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const tag = (s: string) => new Date(`${s}T00:00:00Z`);
const de = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}`;

/** ISO-Kalenderwoche */
export function kalenderwoche(datum: string): number {
  const x = tag(datum);
  x.setUTCDate(x.getUTCDate() + 3 - ((x.getUTCDay() + 6) % 7));
  const j1 = new Date(Date.UTC(x.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((x.getTime() - j1.getTime()) / 86400000 - 3 + ((j1.getUTCDay() + 6) % 7)) / 7);
}
/** Montag der Woche */
function montag(datum: string): string {
  const x = tag(datum);
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return iso(x);
}

/**
 * Tageswerte auf das Raster summieren – lückenlos (Tage/Wochen/Monate ohne Buchung mit 0).
 * TAG/WOCHE/MONAT: nur das Jahr `jahr`; Wochen laufen Montag–Sonntag und zählen am Jahresrand nur die Tage des Jahres.
 * JAHR: alle Jahre von `jahre` (aufsteigend). `zukunft`: der Abschnitt beginnt nach `heute`.
 */
export function einzelRaster(tage: EinzelTag[], raster: EinzelRaster, jahr: number, jahre: number[], heute: string): EinzelPunkt[] {
  const m = new Map<string, EinzelPunkt>();
  const neu = (key: string, label: string, titel: string, ab: string) => { m.set(key, { key, label, titel, anzahl: 0, stunden: 0, zukunft: ab > heute }); };
  const schluessel = (d: string): string => (raster === 'TAG' ? d : raster === 'WOCHE' ? (montag(d) < `${jahr}-01-01` ? `${jahr}-01-01` : montag(d)) : raster === 'MONAT' ? d.slice(0, 7) : d.slice(0, 4));
  if (raster === 'JAHR') {
    for (const j of [...jahre].sort((a, b) => a - b)) neu(String(j), String(j), String(j), `${j}-01-01`);
  } else if (raster === 'MONAT') {
    for (let i = 0; i < 12; i++) neu(`${jahr}-${String(i + 1).padStart(2, '0')}`, MONATE[i], `${MONATE_LANG[i]} ${jahr}`, `${jahr}-${String(i + 1).padStart(2, '0')}-01`);
  } else {
    for (let x = tag(`${jahr}-01-01`); x.getUTCFullYear() === jahr; x.setUTCDate(x.getUTCDate() + 1)) {
      const d = iso(x);
      if (raster === 'TAG') neu(d, `${d.slice(8, 10)}.${d.slice(5, 7)}.`, `${WOCHENTAGE[x.getUTCDay()]} ${de(d)}`, d);
      else {
        const k = schluessel(d);
        if (!m.has(k)) {
          const so = tag(montag(d)); so.setUTCDate(so.getUTCDate() + 6);
          const bis = iso(so) > `${jahr}-12-31` ? `${jahr}-12-31` : iso(so);
          neu(k, `KW ${kalenderwoche(d)}`, `KW ${kalenderwoche(d)} (${de(k)} – ${de(bis)})`, k);
        }
      }
    }
  }
  for (const t of tage) {
    if (raster !== 'JAHR' && Number(t.datum.slice(0, 4)) !== jahr) continue;
    const p = m.get(schluessel(t.datum));
    if (!p) continue;
    p.anzahl += t.anzahl; p.stunden = runden(p.stunden + t.stunden);
  }
  return [...m.values()];
}

/** Einzelbuchungen je Tag (Anzahl und Stunden) */
export async function einzelTageLesen(db: Db, von: string, bis: string): Promise<EinzelTag[]> {
  const rows = await db`select b.datum::text as datum, count(*)::int as anzahl, sum(case when s.sek > 0 then s.sek else 0 end)::float8 / 3600 as stunden
                          from tco.bookings b
                          left join tco.bookings_ch c on c.bid = b.bid
                          cross join lateral (select case when b.time_start is null or b.time_ende is null then 0
                                                          when extract(epoch from (b.time_ende - b.time_start)) < 0
                                                          then extract(epoch from (b.time_ende - b.time_start)) + 86400
                                                          else extract(epoch from (b.time_ende - b.time_start)) end as sek) s
                         where b.datum between ${von} and ${bis}
                           and (b.status in ('1', '5') or (b.status = '3' and coalesce(c.status_abw, '') = '1'))
                         group by 1 order by 1`;
  return rows.map((r) => ({ datum: r.datum as string, anzahl: Number(r.anzahl), stunden: runden(Number(r.stunden ?? 0)) }));
}

export interface EinzelDiagramm {
  raster: EinzelRaster; jahr: number; jahre: number[]; punkte: EinzelPunkt[];
  summe: { anzahl: number; stunden: number; zukunft: number }; max: { titel: string; anzahl: number } | null;
}

/** Diagrammdaten: Jahre mit Einzelbuchungen (absteigend, das laufende Jahr immer), Punkte im Raster, Summen */
export async function einzelDiagramm(db: Db, raster: EinzelRaster, jahrWunsch: number | null, heute: string): Promise<EinzelDiagramm> {
  const hj = Number(heute.slice(0, 4));
  const rows = await db`select distinct extract(year from b.datum)::int as jahr from tco.bookings b left join tco.bookings_ch c on c.bid = b.bid
                         where b.datum >= '2000-01-01' and (b.status in ('1', '5') or (b.status = '3' and coalesce(c.status_abw, '') = '1'))`;
  const jahre = [...new Set([hj, ...rows.map((r) => Number(r.jahr))])].sort((a, b) => b - a);
  const jahr = jahrWunsch && jahre.includes(jahrWunsch) ? jahrWunsch : hj;
  const tage = raster === 'JAHR' ? await einzelTageLesen(db, `${jahre[jahre.length - 1]}-01-01`, `${jahre[0]}-12-31`) : await einzelTageLesen(db, `${jahr}-01-01`, `${jahr}-12-31`);
  const punkte = einzelRaster(tage, raster, jahr, jahre, heute);
  const top = punkte.reduce<EinzelPunkt | null>((a, p) => (p.anzahl > (a?.anzahl ?? 0) ? p : a), null);
  return {
    raster, jahr, jahre, punkte,
    summe: {
      anzahl: punkte.reduce((s, p) => s + p.anzahl, 0), stunden: runden(punkte.reduce((s, p) => s + p.stunden, 0)),
      zukunft: tage.filter((t) => t.datum > heute && (raster === 'JAHR' || Number(t.datum.slice(0, 4)) === jahr)).reduce((s, t) => s + t.anzahl, 0),
    },
    max: top ? { titel: top.titel, anzahl: top.anzahl } : null,
  };
}
