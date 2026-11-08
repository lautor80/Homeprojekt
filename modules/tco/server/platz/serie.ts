import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import { addTage, condense, dat } from '../format.js';
import { minuten, preiseLesen } from '../halle/preis.js';
import {
  belegungLesen, hhmm, isoWochentag, jetzt, plaetzeLesen, preisVon, QUELLE, regelnPruefen, wochentagText, type Platz, type Preis,
} from './logik.js';

/**
 * Serienbuchung (Hallenwart): mehrere Plätze, mehrere Stunden, einmalig oder wiederholt
 * (wöchentlich, zweiwöchentlich, monatlich am gleichen Wochentag, z. B. „jeden 2. Dienstag“).
 * Vorab: Verfügbarkeit je Platz und Termin und Vorschläge für Platzkombinationen.
 * Wiederholte Buchungen werden als Abo (Status 3) angelegt – je Platz eine Serie (BID),
 * einmalige als Einzelbuchung (Status 1). Vereinsinterne Buchungen erhalten keine Rechnung.
 */

export type Rhythmus = 'EINMALIG' | 'WOECHENTLICH' | 'ZWEIWOECHENTLICH' | 'MONATLICH';
export const RHYTHMEN: Record<Rhythmus, string> = {
  EINMALIG: 'einmalig', WOECHENTLICH: 'wöchentlich', ZWEIWOECHENTLICH: 'alle zwei Wochen', MONATLICH: 'monatlich',
};

export interface SerienAnfrage {
  ab: string; bis_datum?: string | null; von: string; bis: string; rhythmus: Rhythmus;
  anzahl: number; art?: 'HALLE' | 'FREI' | null; plaetze?: number[];
}

const MAX_TERMINE = 60;
const nr = (iso: string) => Math.ceil(Number(iso.slice(8, 10)) / 7); // 1. bis 5. Wochentag im Monat
const ORDINAL = ['', '1.', '2.', '3.', '4.', 'letzten'];

/** n-ter Wochentag (1–4, 5 = letzter) eines Monats */
function nterWochentag(jahr: number, monat: number, wt: number, n: number): string | null {
  const erster = new Date(Date.UTC(jahr, monat, 1, 12));
  const versatz = (wt - (((erster.getUTCDay() + 6) % 7) + 1) + 7) % 7;
  if (n === 5) {
    const tage = new Date(Date.UTC(jahr, monat + 1, 0, 12)).getUTCDate();
    let d = 1 + versatz;
    while (d + 7 <= tage) d += 7;
    return new Date(Date.UTC(jahr, monat, d, 12)).toISOString().slice(0, 10);
  }
  const d = 1 + versatz + (n - 1) * 7;
  const iso = new Date(Date.UTC(jahr, monat, d, 12)).toISOString().slice(0, 10);
  return Number(iso.slice(5, 7)) === monat + 1 ? iso : null;
}

/** Termine der Serie */
export function termineBerechnen(ab: string, bis: string | null | undefined, rhythmus: Rhythmus): string[] {
  if (rhythmus === 'EINMALIG') return [ab];
  if (!bis) throw new BusinessError('Bitte angeben, bis wann die Serie läuft.');
  if (bis < ab) throw new BusinessError('Das Ende der Serie liegt vor dem ersten Termin.');
  const out: string[] = [];
  if (rhythmus === 'MONATLICH') {
    const wt = isoWochentag(ab);
    const n = nr(ab) >= 5 ? 5 : nr(ab);
    let j = Number(ab.slice(0, 4));
    let m = Number(ab.slice(5, 7)) - 1;
    while (out.length <= MAX_TERMINE) {
      const d = nterWochentag(j, m, wt, n);
      if (d && d > bis) break;
      if (d && d >= ab) out.push(d);
      m++; if (m > 11) { m = 0; j++; }
      if (j > Number(bis.slice(0, 4)) + 1) break;
    }
  } else {
    const schritt = rhythmus === 'WOECHENTLICH' ? 7 : 14;
    for (let d = ab; d <= bis && out.length <= MAX_TERMINE; d = addTage(d, schritt)) out.push(d);
  }
  if (out.length > MAX_TERMINE) throw new BusinessError(`Höchstens ${MAX_TERMINE} Termine je Serie – bitte den Zeitraum verkürzen.`);
  return out;
}

export function rhythmusText(ab: string, rhythmus: Rhythmus): string {
  if (rhythmus === 'EINMALIG') return `${wochentagText(ab)}, ${dat(ab)}`;
  if (rhythmus === 'MONATLICH') return `jeden ${ORDINAL[nr(ab) >= 5 ? 5 : nr(ab)]} ${wochentagText(ab)} im Monat`;
  return `${rhythmus === 'WOECHENTLICH' ? 'jeden' : 'jeden zweiten'} ${wochentagText(ab)}`;
}

export interface PlatzVerfuegbarkeit {
  id: number; name: string; art: string; abrechnen: boolean;
  /** je Termin: null = frei, sonst Grund */
  termine: (string | null)[];
  frei: number; preis: Preis;
}
export interface Kombination { plaetze: number[]; namen: string[]; frei: number; vollstaendig: boolean; text: string }

/** Verfügbarkeit aller passenden Plätze je Termin und die besten Platzkombinationen */
export async function verfuegbarkeit(db: Db, a: SerienAnfrage) {
  const termine = termineBerechnen(a.ab, a.bis_datum, a.rhythmus);
  const von = minuten(a.von);
  const bis = a.bis === '24:00' ? 1440 : minuten(a.bis);
  if (bis <= von) throw new BusinessError('Das Ende liegt vor dem Beginn.');
  let plaetze = (await plaetzeLesen(db, true)).filter((p) => !a.art || p.art === a.art);
  if (a.plaetze?.length) plaetze = plaetze.filter((p) => a.plaetze!.includes(p.id));
  if (!plaetze.length) throw new BusinessError('Keine passenden aktiven Plätze.');
  if (a.anzahl > plaetze.length) throw new BusinessError(`Es gibt nur ${plaetze.length} passende Plätze.`);

  const bel = await belegungLesen(db, plaetze, termine[0], termine[termine.length - 1]);
  const preise = await preiseLesen(db);
  const status = a.rhythmus === 'EINMALIG' ? '1' as const : '3' as const;
  const liste: PlatzVerfuegbarkeit[] = plaetze.map((p) => {
    const t = termine.map((d) => {
      const r = regelnPruefen({ platz: p, datum: d, von, bis }, true);
      if (r) return r.replace(`${p.name}: `, '');
      const b = bel.find((x) => x.platzId === p.id && x.datum === d && x.von < bis && x.bis > von);
      return b ? `belegt ${hhmm(b.von)}–${hhmm(b.bis)} (${b.fest ? b.fest.bezeichnung : b.reserviert ? 'gerade in Auswahl' : b.status === '3' ? 'Abo' : 'Einzel'}${!b.fest && b.kunde ? `, ${b.kunde}` : ''})` : null;
    });
    return {
      id: p.id, name: p.name, art: p.art, abrechnen: p.abrechnen, termine: t, frei: t.filter((x) => !x).length,
      preis: preisVon(p, termine[0], von, bis, status, preise),
    };
  });

  return {
    termine: termine.map((d) => ({ datum: d, wochentag: wochentagText(d) })),
    rhythmus: rhythmusText(a.ab, a.rhythmus),
    plaetze: liste,
    kombinationen: kombinationen(liste, a.anzahl, termine.length),
  };
}

/**
 * Vorschläge: Kombinationen aus `anzahl` Plätzen, sortiert nach Terminen, an denen alle frei sind,
 * dann nach Summe der freien Termine, dann nach „nah beieinander“ (Reihenfolge der Plätze).
 */
export function kombinationen(alle: PlatzVerfuegbarkeit[], anzahl: number, termine: number, max = 5): Kombination[] {
  // bei sehr vielen Plätzen nur die 14 mit den meisten freien Terminen kombinieren (Reihenfolge bleibt)
  const liste = alle.length > 14
    ? alle.filter((p) => [...alle].sort((a, b) => b.frei - a.frei).slice(0, 14).includes(p))
    : alle;
  const n = Math.max(1, Math.min(anzahl, liste.length));
  const erg: { k: number[]; frei: number; summe: number; spanne: number }[] = [];
  const wahl = (start: number, akt: number[]) => {
    if (akt.length === n) {
      let frei = 0;
      for (let t = 0; t < termine; t++) if (akt.every((i) => !liste[i].termine[t])) frei++;
      erg.push({ k: [...akt], frei, summe: akt.reduce((s, i) => s + liste[i].frei, 0), spanne: akt[akt.length - 1] - akt[0] });
      return;
    }
    for (let i = start; i < liste.length; i++) { akt.push(i); wahl(i + 1, akt); akt.pop(); }
  };
  wahl(0, []);
  erg.sort((a, b) => b.frei - a.frei || b.summe - a.summe || a.spanne - b.spanne);
  const beste = erg.slice(0, max);
  return beste.filter((e, i) => i === 0 || e.frei > 0).map((e) => {
    const ps = e.k.map((i) => liste[i]);
    return {
      plaetze: ps.map((p) => p.id), namen: ps.map((p) => p.name), frei: e.frei, vollstaendig: e.frei === termine,
      text: e.frei === termine ? `an allen ${termine} Termin(en) frei` : `an ${e.frei} von ${termine} Terminen alle frei`,
    };
  });
}

export interface SerienBuchung extends SerienAnfrage {
  plaetze: number[];
  adrnr?: string | null;
  intern?: string | null;
  text?: string | null;
  ueberspringen: boolean;
}

/** Buchungen anlegen: je Platz eine BID (Abo-Serie bzw. Einzelbuchung) */
export async function serieBuchen(tx: Db, e: SerienBuchung): Promise<{ bids: string[]; text: string }> {
  if (!e.plaetze.length) throw new BusinessError('Bitte mindestens einen Platz wählen.');
  if (!e.adrnr && !e.intern?.trim()) throw new BusinessError('Bitte ein Mitglied wählen oder eine vereinsinterne Bezeichnung angeben.');
  await tx`select pg_advisory_xact_lock(hashtext('tco.platz.serie'))`;
  for (const id of e.plaetze) for (const d of termineBerechnen(e.ab, e.bis_datum, e.rhythmus)) {
    await tx`select pg_advisory_xact_lock(hashtext(${`tco.platz|${id}|${d}`}))`;
  }
  const v = await verfuegbarkeit(tx, { ...e, anzahl: e.plaetze.length, art: null });
  const gewaehlt = v.plaetze;
  const fehlend = e.plaetze.filter((id) => !gewaehlt.some((p) => p.id === id));
  if (fehlend.length) throw new BusinessError('Ein gewählter Platz ist nicht (mehr) aktiv.');
  const belegt = gewaehlt.flatMap((p) => p.termine.map((k, i) => (k ? `${p.name} ${dat(v.termine[i].datum)}: ${k}` : null)).filter(Boolean)) as string[];
  if (belegt.length && !e.ueberspringen) {
    throw new BusinessError(`${belegt.length} Termin(e) nicht frei: ${belegt.slice(0, 4).join('; ')}${belegt.length > 4 ? ' …' : ''}`);
  }

  let kunde: string;
  let benutzerId: string | null = null;
  if (e.adrnr) {
    const [m] = await tx`select m.vorname, m.nachname, a.benutzer_id::text from tco.mitglieder m left join tco.mitgliedera a on a.adrnr = m.adrnr where m.adrnr = ${e.adrnr}`;
    if (!m) throw new BusinessError('Mitglied nicht gefunden.');
    kunde = condense(`${m.vorname ?? ''} ${m.nachname ?? ''}`).toUpperCase();
    benutzerId = m.benutzer_id ?? null;
  } else {
    kunde = condense(e.intern!).toUpperCase();
  }
  const status = e.rhythmus === 'EINMALIG' ? '1' : '3';
  const von = minuten(e.von);
  const bis = e.bis === '24:00' ? 1440 : minuten(e.bis);
  const plaetze = await plaetzeLesen(tx);
  const heute = jetzt().datum;
  const bids: string[] = [];
  let anzahl = 0;
  for (const pv of gewaehlt) {
    const p = plaetze.find((x) => x.id === pv.id) as Platz;
    const freieTermine = v.termine.filter((_, i) => !pv.termine[i]);
    if (!freieTermine.length) continue;
    const [{ n }] = await tx`select core.next_number('TCO_PLATZ', 0)::bigint as n`;
    const bid = `9${String(n).padStart(9, '0')}`;
    // vereinsintern oder kostenfreier Platz: ohne Rechnung
    const assigned = e.intern || !p.abrechnen ? 'X' : '';
    for (const t of freieTermine) {
      await tx`insert into tco.bookings (bid, datum, time_start, time_ende, kunde, status, description, preis, erstellt, assigned, text, platz, benutzer_id, quelle)
               values (${bid}, ${t.datum}, ${hhmm(von)}, ${hhmm(bis)}, ${kunde}, ${status}, ${`${dat(t.datum)} von ${hhmm(von)} bis ${hhmm(bis)} Uhr`},
                       ${e.intern ? 0 : pv.preis.betrag}, ${heute}, ${assigned}, ${e.text?.trim() || null}, ${p.name}, ${benutzerId}, ${QUELLE})`;
      anzahl++;
    }
    bids.push(bid);
  }
  if (!anzahl) throw new BusinessError('Kein freier Termin – nichts gebucht.');
  return {
    bids,
    text: `${anzahl} Buchung(en) für ${condense(e.adrnr ? kunde : e.intern!)} angelegt: ${gewaehlt.map((p) => p.name).join(', ')}, `
      + `${v.rhythmus} ${hhmm(von)}–${hhmm(bis)} Uhr${status === '3' ? ` (${bids.length} Abo-Serie(n))` : ''}`
      + (belegt.length ? `, ${belegt.length} belegte Termin(e) ausgelassen` : '') + '.',
  };
}
