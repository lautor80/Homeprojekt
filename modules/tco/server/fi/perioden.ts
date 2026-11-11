/**
 * FI-Perioden abschließen (#3): je Monat; abgeschlossen ist immer ein lückenloser Zeitraum bis zu einem Monat.
 * Die Sperre selbst setzt der Trigger tco.fi_periode_pruefen (Migration 054) durch; hier Anzeige, Abschluss und
 * Wiederöffnen sowie eine Vorabprüfung mit verständlicher Meldung.
 */
import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import { heute } from '../format.js';

const NAMEN = ['', 'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const nr = (j: number, m: number) => j * 12 + (m - 1);
const text = (j: number, m: number) => `${String(m).padStart(2, '0')}/${j}`;

/** letzter abgeschlossener Monat als „JJJJ-MM“ (null = nichts abgeschlossen) */
export async function abgeschlossenBis(db: Db): Promise<string | null> {
  const [r] = await db`select jahr, monat from tco.fiperioden order by jahr desc, monat desc limit 1`;
  return r ? `${r.jahr}-${String(r.monat).padStart(2, '0')}` : null;
}

/** Vorabprüfung beim Buchen/Stornieren: Daten (JJJJ-MM-TT) in abgeschlossenen Perioden → verständliche Meldung */
export async function periodenPruefen(db: Db, daten: string[], was: 'buchen' | 'stornieren') {
  const paare = [...new Set(daten.map((d) => d.slice(0, 7)))];
  if (!paare.length) return;
  const zu = await db`select jahr, monat from tco.fiperioden
                       where (jahr::text || '-' || lpad(monat::text, 2, '0')) = any(${paare}) order by jahr, monat`;
  if (!zu.length) return;
  const liste = zu.map((r) => text(Number(r.jahr), Number(r.monat))).join(', ');
  throw new BusinessError(was === 'stornieren'
    ? `Die Buchung liegt in der abgeschlossenen Periode ${liste} und kann nicht mehr storniert werden.`
    : `Periode ${liste} ist abgeschlossen – bitte ein Buchungsdatum in einer offenen Periode wählen.`);
}

export interface PeriodeMonat {
  monat: number; name: string; geschlossen: boolean; geschlossen_am: string | null; geschlossen_von: string | null;
  buchungen: number; vergangen: boolean;
}

export async function periodenLesen(db: Db, jahr: number) {
  const zu = await db`select monat, geschlossen_am, geschlossen_von from tco.fiperioden where jahr = ${jahr}`;
  const anz = await db`select monat, count(distinct internenr)::int as n from tco.fibuchungen where jahr = ${jahr} group by monat`;
  const h = heute();
  const jetzt = nr(Number(h.slice(0, 4)), Number(h.slice(5, 7)));
  const monate: PeriodeMonat[] = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    const z = zu.find((r) => Number(r.monat) === m);
    return {
      monat: m, name: NAMEN[m], geschlossen: !!z, geschlossen_am: z ? new Date(z.geschlossen_am).toISOString() : null,
      geschlossen_von: z?.geschlossen_von ?? null, buchungen: anz.find((r) => Number(r.monat) === m)?.n ?? 0, vergangen: nr(jahr, m) < jetzt,
    };
  });
  return { jahr, monate, abgeschlossenBis: await abgeschlossenBis(db) };
}

/** alle offenen Monate bis einschließlich jahr/monat abschließen (ab der ersten Buchung bzw. dem Jahresanfang) */
export async function abschliessen(tx: Db, jahr: number, monat: number): Promise<string> {
  const h = heute();
  if (nr(jahr, monat) >= nr(Number(h.slice(0, 4)), Number(h.slice(5, 7)))) {
    throw new BusinessError('Nur vergangene Perioden können abgeschlossen werden (der laufende Monat bleibt offen).');
  }
  const [erst] = await tx`select min(jahr * 12 + monat - 1)::int as n from tco.fibuchungen where jahr is not null and monat is not null`;
  const bis = await abgeschlossenBis(tx);
  // ab der ersten Buchung (ohne Buchungen ab Januar des Jahres), höchstens bis zum gewählten Monat
  let start = Math.min(erst?.n ?? nr(jahr, 1), nr(jahr, monat));
  if (bis) start = Math.max(start, nr(Number(bis.slice(0, 4)), Number(bis.slice(5, 7))) + 1);
  const neu: { jahr: number; monat: number }[] = [];
  for (let n = start; n <= nr(jahr, monat); n++) neu.push({ jahr: Math.floor(n / 12), monat: (n % 12) + 1 });
  if (!neu.length) throw new BusinessError(`Die Periode ${text(jahr, monat)} ist bereits abgeschlossen.`);
  await tx`insert into tco.fiperioden ${tx(neu as never, 'jahr', 'monat')} on conflict do nothing`;
  const von = neu[0];
  return neu.length === 1 ? `Periode ${text(jahr, monat)} abgeschlossen.`
    : `Perioden ${text(von.jahr, von.monat)} bis ${text(jahr, monat)} abgeschlossen (${neu.length} Monate).`;
}

/** Periode und alle späteren wieder öffnen (der abgeschlossene Zeitraum bleibt lückenlos) */
export async function oeffnen(tx: Db, jahr: number, monat: number): Promise<string> {
  const r = await tx`delete from tco.fiperioden where jahr * 12 + monat - 1 >= ${nr(jahr, monat)} returning jahr, monat`;
  if (!r.length) throw new BusinessError(`Die Periode ${text(jahr, monat)} ist nicht abgeschlossen.`);
  return r.length === 1 ? `Periode ${text(jahr, monat)} wieder geöffnet.` : `Periode ${text(jahr, monat)} und ${r.length - 1} spätere wieder geöffnet.`;
}
