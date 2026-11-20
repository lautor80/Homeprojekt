import { z } from 'zod';
import type { JobPlan } from './job-typen.js';

/**
 * Pläne der Jobs (Administration → System → Jobs): Prüfung, Anzeigetext und nächster Start – reine Funktionen ohne
 * Datenbank. Alle Uhrzeiten gelten in Europe/Berlin; der Wechsel zwischen Sommer- und Winterzeit ist berücksichtigt:
 * Eine Uhrzeit, die es am Tag der Umstellung im Frühjahr nicht gibt (02:00–02:59), läuft eine Stunde später;
 * eine doppelte Uhrzeit im Herbst läuft nur einmal.
 */

const ZONE = 'Europe/Berlin';
/** längstes Intervall: eine Woche */
export const INTERVALL_MAX = 7 * 24 * 60;

export const jobPlanSchema = z.discriminatedUnion('art', [
  z.object({ art: z.literal('intervall'), minuten: z.number().int().min(1).max(INTERVALL_MAX) }),
  z.object({
    art: z.literal('taeglich'),
    uhrzeit: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Uhrzeit im Format HH:MM'),
    wochentage: z.array(z.number().int().min(1).max(7)).max(7).default([]),
  }),
]);

/** Plan prüfen und vereinheitlichen (Wochentage sortiert, ohne Doppelte) – wirft ZodError */
export function planPruefen(roh: unknown): JobPlan {
  const p = jobPlanSchema.parse(roh);
  if (p.art === 'intervall') return { art: 'intervall', minuten: p.minuten };
  return { art: 'taeglich', uhrzeit: p.uhrzeit, wochentage: [...new Set(p.wochentage)].sort((a, b) => a - b) };
}

const TAG = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/** Wochentage kurz: zusammenhängende Folgen ab drei Tagen als „Mo–Fr“, sonst einzeln */
function tageText(tage: number[]): string {
  const t = [...new Set(tage)].sort((a, b) => a - b);
  const teile: string[] = [];
  for (let i = 0; i < t.length;) {
    let j = i;
    while (j + 1 < t.length && t[j + 1] === t[j] + 1) j++;
    if (j - i >= 2) teile.push(`${TAG[t[i]]}–${TAG[t[j]]}`);
    else for (let k = i; k <= j; k++) teile.push(TAG[t[k]]);
    i = j + 1;
  }
  return teile.join(', ');
}

/** Anzeigetext, z. B. „alle 60 Minuten“, „alle 2 Stunden“, „täglich 02:30 (Mo–Fr)“ */
export function planText(p: JobPlan): string {
  if (p.art === 'intervall') {
    if (p.minuten === 1) return 'jede Minute';
    if (p.minuten >= 120 && p.minuten % 60 === 0) return `alle ${p.minuten / 60} Stunden`;
    return `alle ${p.minuten} Minuten`;
  }
  const tage = [...new Set(p.wochentage)];
  return tage.length === 0 || tage.length === 7 ? `täglich ${p.uhrzeit}` : `täglich ${p.uhrzeit} (${tageText(tage)})`;
}

const teileFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** Ortszeit in Berlin als Bestandteile */
function ortszeit(t: number): { j: number; m: number; d: number; h: number; mi: number; s: number } {
  const w: Record<string, number> = {};
  for (const x of teileFmt.formatToParts(new Date(t))) if (x.type !== 'literal') w[x.type] = Number(x.value);
  return { j: w.year, m: w.month, d: w.day, h: w.hour, mi: w.minute, s: w.second };
}

/** Abstand Berlin – UTC in Millisekunden zum Zeitpunkt t (+1 h bzw. +2 h) */
function versatz(t: number): number {
  const o = ortszeit(t);
  return Date.UTC(o.j, o.m - 1, o.d, o.h, o.mi, o.s) - Math.floor(t / 1000) * 1000;
}

/**
 * Zeitpunkt der Ortszeit j-m-d h:mi in Berlin. Doppelte Uhrzeit (Herbst): die erste; fehlende Uhrzeit (Frühjahr):
 * eine Stunde später.
 */
function zeitpunkt(j: number, m: number, d: number, h: number, mi: number): number {
  const roh = Date.UTC(j, m - 1, d, h, mi);
  // Berlin liegt eine (Winterzeit) oder zwei Stunden (Sommerzeit) vor UTC – die frühere passende Lösung gilt
  for (const v of [2, 1]) {
    const t = roh - v * 3600_000;
    const o = ortszeit(t);
    if (o.d === d && o.h === h && o.mi === mi) return t;
  }
  return roh - versatz(roh - versatz(roh));
}

/** ISO-Wochentag (1 = Montag … 7 = Sonntag) eines Kalendertags */
const wochentag = (j: number, m: number, d: number) => ((new Date(Date.UTC(j, m - 1, d)).getUTCDay() + 6) % 7) + 1;

/**
 * Nächster planmäßiger Start nach `ab` (echt später):
 *  - Intervall: ab + Minuten, auf die volle Minute abgerundet,
 *  - täglich: der nächste passende Wochentag zur Uhrzeit (Ortszeit Berlin).
 */
export function naechsterLauf(p: JobPlan, ab: Date): Date {
  const t0 = ab.getTime();
  if (p.art === 'intervall') return new Date(Math.floor((t0 + p.minuten * 60_000) / 60_000) * 60_000);
  const [h, mi] = p.uhrzeit.split(':').map(Number);
  const tage = new Set(p.wochentage.length ? p.wochentage : [1, 2, 3, 4, 5, 6, 7]);
  const heute = ortszeit(t0);
  for (let i = 0; i <= 8; i++) {
    // Kalendertag i Tage nach heute (Ortszeit) – über UTC gerechnet, damit Monats- und Jahreswechsel stimmen
    const tag = new Date(Date.UTC(heute.j, heute.m - 1, heute.d + i));
    const [j, m, d] = [tag.getUTCFullYear(), tag.getUTCMonth() + 1, tag.getUTCDate()];
    if (!tage.has(wochentag(j, m, d))) continue;
    const t = zeitpunkt(j, m, d, h, mi);
    if (t > t0) return new Date(t);
  }
  throw new Error(`Kein nächster Lauf für ${planText(p)} gefunden.`);
}
