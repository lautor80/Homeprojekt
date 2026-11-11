/**
 * Vereinsübersicht (#30): registrierte Benutzer des Portals über die Zeit – kumulierte Anzahl je Tag, Woche, Monat, Jahr
 * oder über die gesamte Laufzeit (Raster automatisch). Gezählt werden die vorhandenen Benutzer nach Anlagedatum
 * (`core.users.created_at`), dazu „davon Mitglieder“ (Rolle MITGLIED) und „davon Hallennutzer“ (nur Rolle HALLENNUTZER).
 */
import type { Db } from '../verein.js';

export const BENUTZER_ZEITRAEUME = { TAG: 'Tage', WOCHE: 'Wochen', MONAT: 'Monate', JAHR: 'Jahre', GESAMT: 'Gesamte Laufzeit' } as const;
export type BenutzerZeitraum = keyof typeof BENUTZER_ZEITRAEUME;
type Raster = 'day' | 'week' | 'month' | 'year';

export interface BenutzerPunkt { label: string; bis: string; gesamt: number; mitglieder: number; hallennutzer: number; neu: number }
export interface BenutzerVerlauf { zeitraum: BenutzerZeitraum; raster: Raster; punkte: BenutzerPunkt[]; gesamt: number; seit: string | null }

const iso = (d: Date) => d.toISOString().slice(0, 10);
const tag = (s: string) => new Date(`${s}T00:00:00Z`);
const plus = (d: Date, n: number, r: Raster) => {
  const x = new Date(d);
  if (r === 'day') x.setUTCDate(x.getUTCDate() + n);
  else if (r === 'week') x.setUTCDate(x.getUTCDate() + 7 * n);
  else if (r === 'month') x.setUTCMonth(x.getUTCMonth() + n);
  else x.setUTCFullYear(x.getUTCFullYear() + n);
  return x;
};
/** Beginn des Rasterintervalls (Woche ab Montag) */
const start = (d: Date, r: Raster) => {
  const x = new Date(Date.UTC(d.getUTCFullYear(), r === 'year' ? 0 : d.getUTCMonth(), r === 'month' || r === 'year' ? 1 : d.getUTCDate()));
  if (r === 'week') x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x;
};
/** ISO-Kalenderwoche */
const kw = (d: Date) => {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() + 3 - ((x.getUTCDay() + 6) % 7));
  const j1 = new Date(Date.UTC(x.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((x.getTime() - j1.getTime()) / 86400000 - 3 + ((j1.getUTCDay() + 6) % 7)) / 7);
};
const label = (d: Date, r: Raster) => {
  const dd = String(d.getUTCDate()).padStart(2, '0'), mm = String(d.getUTCMonth() + 1).padStart(2, '0'), yy = String(d.getUTCFullYear()).slice(2);
  return r === 'day' ? `${dd}.${mm}.` : r === 'week' ? `KW ${kw(d)}/${yy}` : r === 'month' ? `${mm}/${yy}` : String(d.getUTCFullYear());
};

export async function benutzerVerlauf(db: Db, zeitraum: BenutzerZeitraum, heute: string): Promise<BenutzerVerlauf> {
  const rows = await db`
    select u.created_at::date::text as tag,
           exists (select 1 from core.user_roles r where r.user_id = u.id and r.role_id = 'MITGLIED') as mitglied,
           exists (select 1 from core.user_roles r where r.user_id = u.id and r.role_id = 'HALLENNUTZER')
             and not exists (select 1 from core.user_roles r where r.user_id = u.id and r.role_id <> 'HALLENNUTZER') as hallennutzer
      from core.users u order by u.created_at`;
  const liste = rows.map((r) => ({ tag: r.tag as string, mitglied: !!r.mitglied, hallennutzer: !!r.hallennutzer }));
  const seit = liste[0]?.tag ?? null;
  const h = tag(heute);
  // Raster und Anzahl Punkte je Zeitraum; „gesamt“ wählt das Raster nach der Laufzeit (höchstens etwa 60 Punkte)
  let raster: Raster;
  let von: Date;
  if (zeitraum === 'TAG') { raster = 'day'; von = plus(h, -29, 'day'); }
  else if (zeitraum === 'WOCHE') { raster = 'week'; von = plus(start(h, 'week'), -25, 'week'); }
  else if (zeitraum === 'MONAT') { raster = 'month'; von = plus(start(h, 'month'), -23, 'month'); }
  else {
    const erst = seit ? tag(seit) : h;
    const tage = (h.getTime() - erst.getTime()) / 86400000;
    raster = zeitraum === 'JAHR' ? 'year' : tage <= 60 ? 'day' : tage <= 420 ? 'week' : tage <= 365 * 5 ? 'month' : 'year';
    von = start(erst, raster);
    // eine Periode davor, damit die Linie bei 0 bzw. dem Ausgangswert beginnt
    if (zeitraum === 'GESAMT' && seit) von = plus(von, -1, raster);
  }
  const punkte: BenutzerPunkt[] = [];
  let i = 0;
  let vorher = 0;
  for (let s = start(von, raster); s <= h; s = plus(s, 1, raster)) {
    const ende = plus(s, 1, raster);
    const bis = iso(new Date(Math.min(ende.getTime() - 86400000, h.getTime())));
    const bisher = liste.filter((x) => x.tag <= bis);
    const gesamt = bisher.length;
    punkte.push({
      label: label(s, raster), bis, gesamt, mitglieder: bisher.filter((x) => x.mitglied).length, hallennutzer: bisher.filter((x) => x.hallennutzer).length,
      neu: i === 0 ? liste.filter((x) => x.tag >= iso(s) && x.tag <= bis).length : gesamt - vorher,
    });
    vorher = gesamt;
    i++;
    if (i > 400) break;
  }
  return { zeitraum, raster, punkte, gesamt: liste.length, seit };
}
