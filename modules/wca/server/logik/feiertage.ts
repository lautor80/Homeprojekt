/**
 * WCA Zeitenkontrolle – gesetzliche Feiertage je Standort (DE inkl. Bundesländer, AT, ES landesweit, LV, LT)
 * und manuell gepflegte Feiertage. Andere Standorte (MY, SG, US …) haben keine berechneten Feiertage.
 */
import { isoAus, plusTage, wochentag } from './datum.js';

export interface FeiertagRoh {
  tag: string;
  name: string;
}

/** Ostersonntag (Gauß/Meeus, gregorianisch) */
export function ostersonntag(jahr: number): string {
  const a = jahr % 19;
  const b = Math.floor(jahr / 100);
  const c = jahr % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const monat = Math.floor((h + l - 7 * m + 114) / 31);
  const tag = ((h + l - 7 * m + 114) % 31) + 1;
  return isoAus(jahr, monat, tag);
}

/** Buß- und Bettag: Mittwoch vor dem 23.11. */
function bussUndBettag(jahr: number): string {
  let t = isoAus(jahr, 11, 22);
  while (wochentag(t) !== 2) t = plusTage(t, -1);
  return t;
}

/** Samstag/Sonntag → folgender Montag */
function aufMontag(tag: string): string {
  const w = wochentag(tag);
  return w === 5 ? plusTage(tag, 2) : w === 6 ? plusTage(tag, 1) : tag;
}

/**
 * Berechnete Feiertage eines Standorts in einem Jahr.
 * Standort 'DE' nutzt das Bundesland aus den Einstellungen; 'DE-BY' o. Ä. setzt das Bundesland direkt.
 */
export function feiertageBerechnet(standort: string, jahr: number, bundesland: string): FeiertagRoh[] {
  const s = standort.toUpperCase();
  const e = ostersonntag(jahr);
  const t = (m: number, tg: number) => isoAus(jahr, m, tg);
  const r: FeiertagRoh[] = [];
  const add = (tag: string, name: string) => r.push({ tag, name });

  if (s === 'DE' || s.startsWith('DE-')) {
    const bl = (s.startsWith('DE-') ? s.slice(3) : bundesland || '').toUpperCase();
    const in_ = (...l: string[]) => l.includes(bl);
    add(t(1, 1), 'Neujahr');
    if (in_('BW', 'BY', 'ST')) add(t(1, 6), 'Heilige Drei Könige');
    if (in_('BE', 'MV')) add(t(3, 8), 'Internationaler Frauentag');
    add(plusTage(e, -2), 'Karfreitag');
    add(plusTage(e, 1), 'Ostermontag');
    add(t(5, 1), 'Tag der Arbeit');
    add(plusTage(e, 39), 'Christi Himmelfahrt');
    add(plusTage(e, 50), 'Pfingstmontag');
    if (in_('BW', 'BY', 'HE', 'NW', 'RP', 'SL')) add(plusTage(e, 60), 'Fronleichnam');
    if (in_('SL')) add(t(8, 15), 'Mariä Himmelfahrt');
    if (in_('TH')) add(t(9, 20), 'Weltkindertag');
    add(t(10, 3), 'Tag der Deutschen Einheit');
    if (in_('BB', 'MV', 'SN', 'ST', 'TH', 'HB', 'HH', 'NI', 'SH')) add(t(10, 31), 'Reformationstag');
    if (in_('BW', 'BY', 'NW', 'RP', 'SL')) add(t(11, 1), 'Allerheiligen');
    if (in_('SN')) add(bussUndBettag(jahr), 'Buß- und Bettag');
    add(t(12, 25), '1. Weihnachtstag');
    add(t(12, 26), '2. Weihnachtstag');
  } else if (s === 'AT') {
    add(t(1, 1), 'Neujahr');
    add(t(1, 6), 'Heilige Drei Könige');
    add(plusTage(e, 1), 'Ostermontag');
    add(t(5, 1), 'Staatsfeiertag');
    add(plusTage(e, 39), 'Christi Himmelfahrt');
    add(plusTage(e, 50), 'Pfingstmontag');
    add(plusTage(e, 60), 'Fronleichnam');
    add(t(8, 15), 'Mariä Himmelfahrt');
    add(t(10, 26), 'Nationalfeiertag');
    add(t(11, 1), 'Allerheiligen');
    add(t(12, 8), 'Mariä Empfängnis');
    add(t(12, 25), 'Christtag');
    add(t(12, 26), 'Stefanitag');
  } else if (s === 'ES') {
    add(t(1, 1), 'Año Nuevo');
    add(t(1, 6), 'Epifanía del Señor');
    add(plusTage(e, -2), 'Viernes Santo');
    add(t(5, 1), 'Fiesta del Trabajo');
    add(t(8, 15), 'Asunción de la Virgen');
    add(t(10, 12), 'Fiesta Nacional de España');
    add(t(11, 1), 'Todos los Santos');
    add(t(12, 6), 'Día de la Constitución');
    add(t(12, 8), 'Inmaculada Concepción');
    add(t(12, 25), 'Navidad');
  } else if (s === 'LV') {
    add(t(1, 1), 'Jaunais gads');
    add(plusTage(e, -2), 'Lielā Piektdiena');
    add(plusTage(e, 1), 'Otrās Lieldienas');
    add(t(5, 1), 'Darba svētki');
    add(aufMontag(t(5, 4)), 'Neatkarības atjaunošanas diena');
    add(t(6, 23), 'Līgo');
    add(t(6, 24), 'Jāņi');
    add(aufMontag(t(11, 18)), 'Proklamēšanas diena');
    add(t(12, 24), 'Ziemassvētku vakars');
    add(t(12, 25), 'Ziemassvētki');
    add(t(12, 26), 'Otrie Ziemassvētki');
    add(t(12, 31), 'Vecgada vakars');
  } else if (s === 'LT') {
    add(t(1, 1), 'Naujieji metai');
    add(t(2, 16), 'Valstybės atkūrimo diena');
    add(t(3, 11), 'Nepriklausomybės atkūrimo diena');
    add(plusTage(e, 1), 'Antroji Velykų diena');
    add(t(5, 1), 'Tarptautinė darbo diena');
    add(t(6, 24), 'Joninės');
    add(t(7, 6), 'Valstybės diena');
    add(t(8, 15), 'Žolinė');
    add(t(11, 1), 'Visų šventųjų diena');
    add(t(11, 2), 'Vėlinės');
    add(t(12, 24), 'Kūčios');
    add(t(12, 25), 'Kalėdos');
    add(t(12, 26), 'Antroji Kalėdų diena');
  }
  return r;
}

/** Manuelle Feiertage: Zeilen „Standort JJJJ-MM-TT Name“, * = alle Standorte */
export function feiertageManuell(text: string): { standort: string; tag: string; name: string }[] {
  const r: { standort: string; tag: string; name: string }[] = [];
  for (const z of (text || '').split(/\r?\n/)) {
    const m = /^(\S+)\s+(\d{4}-\d{2}-\d{2})\s*(.*)$/.exec(z.trim());
    if (m) r.push({ standort: m[1].toUpperCase(), tag: m[2], name: m[3].trim() || 'Feiertag (manuell)' });
  }
  return r;
}
