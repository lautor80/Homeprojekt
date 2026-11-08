import { BusinessError } from '../../../../server/src/errors.js';
import { runden } from '../format.js';
import type { Db } from '../verein.js';

/**
 * Anlagevermögen und AfA – Port von ZCL_TCO_ANLAGEN.
 * Anlagenverzeichnis des Vereins (tco.anlagen) mit linearer Abschreibung.
 * Rechenlogik wie Excel „Werte Anlagevermögen“:
 *   Buchwert 31.12. = AW − AW / ND × (Monate Erstjahr / 12 + Jahre seit Anschaffung)
 *   (nie kleiner 0, letzter Restbetrag im letzten Jahr).
 * Die Monate im Anschaffungsjahr sind je Objekt gepflegt (Vorschlag Monatsregel:
 * Anschaffungsmonat bis Dezember), damit die Altwerte aus der Excel exakt reproduziert werden.
 * Die AfA ist reine Information zum Jahresabschluss – sie verändert das Ergebnis der
 * Einnahmen-Ausgaben-Rechnung nicht (die Anschaffung ist als Ausgabe gebucht).
 */

export interface Anlage {
  anlnr: number; bezeichnung: string; anschdat: string; anschwert: number; nutzdauer: number; monate_ej: number;
  notiz: string | null; erstellt_von: string | null; erstellt_am: string | null; geaendert_am: string | null;
}

export interface AnlageEingabe {
  anlnr: number | null; bezeichnung: string; anschdat: string; anschwert: number; nutzdauer: number; monate_ej: number; notiz: string | null;
}

export type AnlStatus = 'Zugang' | 'abgeschrieben' | 'letzte AfA' | 'aktiv';

export interface Spiegel {
  anlnr: number; bezeichnung: string; anschdat: string; anschwert: number; nutzdauer: number; monate_ej: number;
  afa_satz: number; afa_voll: number; bw_beginn: number; zugang: number; afa_jahr: number; bw_ende: number;
  ende_jahr: number | null; status: AnlStatus;
}

export interface SpiegelSumme { anschwert: number; bw_beginn: number; zugang: number; afa_jahr: number; bw_ende: number }

export const ANL_STATE: Record<AnlStatus, 'Information' | 'Critical' | 'Positive' | 'None'> = {
  Zugang: 'Information', 'letzte AfA': 'Critical', aktiv: 'Positive', abgeschrieben: 'None',
};

const jahrVon = (iso: string) => Number(iso.slice(0, 4));

export async function anlagenLesen(db: Db): Promise<Anlage[]> {
  const r = await db`select anlnr, coalesce(bezeichnung, '') as bezeichnung, to_char(anschdat, 'YYYY-MM-DD') as anschdat,
                            coalesce(anschwert, 0)::float8 as anschwert, coalesce(nutzdauer, 0) as nutzdauer, coalesce(monate_ej, 0) as monate_ej,
                            notiz, erstellt_von, erstellt_am::text as erstellt_am, geaendert_am::text as geaendert_am
                       from tco.anlagen order by anschdat, anlnr`;
  return r as unknown as Anlage[];
}

export async function anlageLesen(db: Db, anlnr: number): Promise<Anlage | null> {
  const l = await anlagenLesen(db);
  return l.find((a) => a.anlnr === anlnr) ?? null;
}

/** Monatsregel: Anschaffungsmonat bis Dezember (ohne Datum 12) */
export function monateErstjahr(datum: string | null | undefined): number {
  if (!datum || !/^\d{4}-\d{2}-\d{2}$/.test(datum)) return 12;
  return 13 - Number(datum.slice(5, 7));
}

export function anlagePruefen(a: AnlageEingabe): string | null {
  if (!a.bezeichnung.trim()) return 'Bitte eine Bezeichnung angeben.';
  if (!a.anschdat || !/^\d{4}-\d{2}-\d{2}$/.test(a.anschdat)) return 'Bitte das Anschaffungsdatum angeben.';
  if (!(a.anschwert > 0)) return 'Der Anschaffungswert muss größer 0 sein.';
  if (!Number.isInteger(a.nutzdauer) || a.nutzdauer < 1 || a.nutzdauer > 99) return 'Die Nutzungsdauer muss zwischen 1 und 99 Jahren liegen.';
  if (!Number.isInteger(a.monate_ej) || a.monate_ej < 0 || a.monate_ej > 12) return 'Die AfA-Monate im Anschaffungsjahr müssen zwischen 0 und 12 liegen.';
  return null;
}

/** Legt an (anlnr leer) oder ändert; liefert die Anlagennummer */
export async function anlageSpeichern(tx: Db, a: AnlageEingabe, benutzer: string): Promise<number> {
  const fehler = anlagePruefen(a);
  if (fehler) throw new BusinessError(fehler);
  const wert = runden(a.anschwert);
  if (!a.anlnr) {
    const [m] = await tx`select coalesce(max(anlnr), 0) + 1 as n from tco.anlagen`;
    const anlnr = Number(m.n);
    await tx`insert into tco.anlagen (anlnr, bezeichnung, anschdat, anschwert, nutzdauer, monate_ej, notiz, erstellt_von, erstellt_am, geaendert_am)
             values (${anlnr}, ${a.bezeichnung.trim()}, ${a.anschdat}, ${wert}, ${a.nutzdauer}, ${a.monate_ej}, ${a.notiz?.trim() || null}, ${benutzer}, now(), now())`;
    return anlnr;
  }
  const [alt] = await tx`select 1 from tco.anlagen where anlnr = ${a.anlnr}`;
  if (!alt) throw new BusinessError(`Anlageobjekt ${a.anlnr} nicht gefunden.`);
  await tx`update tco.anlagen set bezeichnung = ${a.bezeichnung.trim()}, anschdat = ${a.anschdat}, anschwert = ${wert}, nutzdauer = ${a.nutzdauer},
              monate_ej = ${a.monate_ej}, notiz = ${a.notiz?.trim() || null}, geaendert_am = now() where anlnr = ${a.anlnr}`;
  return a.anlnr;
}

export async function anlageLoeschen(tx: Db, anlnr: number): Promise<Anlage> {
  const a = await anlageLesen(tx, anlnr);
  if (!a) throw new BusinessError(`Anlageobjekt ${anlnr} nicht gefunden.`);
  await tx`delete from tco.anlagen where anlnr = ${anlnr}`;
  return a;
}

/** Buchwert zum 31.12. des Jahres (0 vor dem Anschaffungsjahr) */
export function buchwert(a: Pick<Anlage, 'anschdat' | 'anschwert' | 'nutzdauer' | 'monate_ej'>, jahr: number): number {
  if (!a.anschdat) return 0;
  const j0 = jahrVon(a.anschdat);
  if (jahr < j0) return 0;
  if (a.nutzdauer <= 0) return runden(a.anschwert);
  let afa = (a.anschwert / a.nutzdauer) * (a.monate_ej / 12 + (jahr - j0));
  if (afa > a.anschwert) afa = a.anschwert;
  return runden(a.anschwert - afa);
}

/** Anlagenspiegel eines Jahres (alle bis dahin angeschafften, noch nicht voll abgeschriebenen Objekte) */
export function spiegelBerechnen(anlagen: Anlage[], jahr: number): { spiegel: Spiegel[]; summe: SpiegelSumme } {
  const spiegel: Spiegel[] = [];
  const summe: SpiegelSumme = { anschwert: 0, bw_beginn: 0, zugang: 0, afa_jahr: 0, bw_ende: 0 };
  for (const a of anlagen) {
    if (!a.anschdat) continue;
    const j0 = jahrVon(a.anschdat);
    if (j0 > jahr) continue;
    let afa_satz = 0, afa_voll = 0, ende_jahr: number | null = null;
    if (a.nutzdauer > 0) {
      afa_voll = runden(a.anschwert / a.nutzdauer);
      afa_satz = runden(100 / a.nutzdauer);
      // letztes Jahr mit AfA: j0 + aufgerundet(ND − Monate Erstjahr / 12)
      ende_jahr = j0 + Math.ceil(a.nutzdauer - a.monate_ej / 12 - 1e-9);
    }
    const zugang = j0 === jahr ? runden(a.anschwert) : 0;
    const bw_beginn = j0 === jahr ? 0 : buchwert(a, jahr - 1);
    const bw_ende = buchwert(a, jahr);
    const afa_jahr = runden(bw_beginn + zugang - bw_ende);
    // vor dem gewählten Jahr bereits voll abgeschrieben → nicht mehr ausweisen
    if (zugang === 0 && bw_beginn === 0) continue;
    const status: AnlStatus = zugang > 0 ? 'Zugang' : bw_ende === 0 && afa_jahr === 0 ? 'abgeschrieben' : bw_ende === 0 ? 'letzte AfA' : 'aktiv';
    spiegel.push({
      anlnr: a.anlnr, bezeichnung: a.bezeichnung, anschdat: a.anschdat, anschwert: runden(a.anschwert), nutzdauer: a.nutzdauer, monate_ej: a.monate_ej,
      afa_satz, afa_voll, bw_beginn, zugang, afa_jahr, bw_ende, ende_jahr, status,
    });
    summe.anschwert = runden(summe.anschwert + a.anschwert);
    summe.bw_beginn = runden(summe.bw_beginn + bw_beginn);
    summe.zugang = runden(summe.zugang + zugang);
    summe.afa_jahr = runden(summe.afa_jahr + afa_jahr);
    summe.bw_ende = runden(summe.bw_ende + bw_ende);
  }
  return { spiegel, summe };
}

/**
 * Wertentwicklung wie Excel: Spalten = Objekte des Spiegels, Zeilen = Buchwert zum 31.12. je Jahr
 * vom ältesten Anschaffungsjahr bis zum gewählten Jahr, mit Summe je Jahr.
 */
export function wertentwicklung(anlagen: Anlage[], spiegel: Spiegel[], jahr: number): { objekte: Anlage[]; jahre: { jahr: number; werte: (number | null)[]; summe: number }[] } {
  const objekte = spiegel.map((s) => anlagen.find((a) => a.anlnr === s.anlnr)).filter((a): a is Anlage => !!a);
  if (!objekte.length) return { objekte, jahre: [] };
  const min = Math.min(jahr, ...objekte.map((a) => jahrVon(a.anschdat)));
  const jahre: { jahr: number; werte: (number | null)[]; summe: number }[] = [];
  for (let j = min; j <= jahr; j++) {
    const werte = objekte.map((a) => (jahrVon(a.anschdat) > j ? null : buchwert(a, j)));
    jahre.push({ jahr: j, werte, summe: runden(werte.reduce<number>((s, w) => s + (w ?? 0), 0)) });
  }
  return { objekte, jahre };
}

/**
 * Übernimmt den Bestand der Excel „Werte Anlagevermögen“ (Werte 1:1 aus ZCL_TCO_ANLAGEN,
 * Monate Erstjahr so, wie die Excel das Anschaffungsjahr abgeschrieben hat) – nur wenn tco.anlagen leer ist.
 */
export async function initialbestandAnlegen(tx: Db, benutzer: string): Promise<number> {
  const [c] = await tx`select count(*)::int as n from tco.anlagen`;
  if (c.n > 0) throw new BusinessError('Das Anlagenverzeichnis ist nicht leer – der Excel-Bestand wird nur in ein leeres Verzeichnis übernommen.');
  const bestand: [number, string, string, number, number, number][] = [
    [1, 'Hallensanierung', '2013-10-30', 47897.55, 20, 0],
    [2, 'Einsandgerät Sandy 2', '2016-03-01', 976.18, 5, 9],
    [3, 'Räumfix', '2016-03-15', 733.11, 5, 9],
    [4, 'Eingangstreppe', '2016-07-20', 5841.16, 20, 6],
    [5, 'Gasheizung', '2019-04-24', 7872.89, 10, 6],
    [6, 'Hallenbelag', '2022-09-01', 32962.10, 20, 4],
    [7, 'Hallenlicht', '2025-07-01', 5312.23, 10, 5],
  ];
  for (const [anlnr, bez, dat, aw, nd, mon] of bestand) {
    await tx`insert into tco.anlagen (anlnr, bezeichnung, anschdat, anschwert, nutzdauer, monate_ej, notiz, erstellt_von, erstellt_am, geaendert_am)
             values (${anlnr}, ${bez}, ${dat}, ${aw}, ${nd}, ${mon}, ${'Übernahme aus Excel "Werte Anlagevermögen"'}, ${benutzer}, now(), now())`;
  }
  return bestand.length;
}
