/**
 * Hallenschlüssel (#215) – fachliche Regeln ohne Datenbank (lokal testbar): Texte, Nummer, Altdaten aus der Zwischenablage.
 */

export const ART = { AUSGABE: 'Ausgabe', RUECKGABE: 'Rückgabe' } as const;
export type Art = keyof typeof ART;
export const STATUS = { WARTET: 'Wartet auf Quittung', QUITTIERT: 'Quittiert', STORNIERT: 'Storniert' } as const;
export type Status = keyof typeof STATUS;
export const ZUSTAND = { OK: 'In Ordnung', BESCHAEDIGT: 'Beschädigt', VERLOREN: 'Verloren' } as const;
export type Zustand = keyof typeof ZUSTAND;
export const QUITTUNG = { KUNDE: 'Kunde online', TCO: 'TCO (Empfang bestätigt)', ALTFALL: 'Altfall' } as const;

export const vorgangsNummer = (jahr: number, id: number) => `SV-${jahr}-${String(id).padStart(4, '0')}`;

/** Standardtext der Nutzungsbedingungen (in den Einstellungen der App änderbar) */
export const BEDINGUNGEN_STANDARD = [
  'Schön, dass du einen Hallenschlüssel hast! Damit das für alle entspannt bleibt, ein paar Spielregeln:',
  '• Der Schlüssel ist nur für dich – bitte nicht verleihen oder nachmachen lassen.',
  '• Nach dem Spielen: Licht aus, Tür zu und abschließen. Der Letzte macht die Halle dicht.',
  '• Schlüssel weg? Kein Drama, aber sag bitte sofort dem Hallenwart oder dem Vorstand Bescheid.',
  '• Das Pfand bekommst du zurück, sobald du den Schlüssel wieder abgibst. Bei Verlust behalten wir es ein.',
  '• Wenn du austrittst oder keine Halle mehr buchst, gib den Schlüssel bitte von dir aus zurück.',
].join('\n');

/** Datum aus TT.MM.JJJJ, TT.MM.JJ oder JJJJ-MM-TT; ungültig → null */
export function datumLesen(s: string | null | undefined): string | null {
  const t = (s ?? '').trim();
  if (!t) return null;
  let j: number, m: number, d: number;
  let x = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (x) { j = +x[1]; m = +x[2]; d = +x[3]; } else {
    x = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(t);
    if (!x) return null;
    d = +x[1]; m = +x[2]; j = +x[3];
    if (j < 100) j += j > 69 ? 1900 : 2000;
  }
  const dt = new Date(Date.UTC(j, m - 1, d));
  if (dt.getUTCFullYear() !== j || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${j}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Betrag aus „25,00 €“, „25.5“, „1.234,56“; leer → null, ungültig → NaN */
export function betragLesen(s: string | null | undefined): number | null {
  let t = (s ?? '').replace(/[€\s]|EUR/gi, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? Math.abs(Math.round(n * 100) / 100) : NaN;
}

/** Paperless-ID aus „123“, „000123“, „DOKID 123“; leer → null, ungültig → NaN */
export function dokLesen(s: string | null | undefined): number | null {
  const t = (s ?? '').trim();
  if (!t) return null;
  const x = /(\d{1,9})\s*$/.exec(t);
  return x ? Number(x[1]) : NaN;
}

export interface AltZeile {
  zeile: number;
  person: string; ausgabe: string | null; ausgegeben_von: string; pfand: number | null;
  rueckgabe: string | null; empfangen_von: string; doc_ausgabe: number | null; doc_rueckgabe: number | null;
  schluessel_nr: string; bemerkung: string;
  fehler: string[];
}

const SPALTEN = ['person', 'ausgabe', 'ausgegeben_von', 'pfand', 'rueckgabe', 'empfangen_von', 'doc_ausgabe', 'doc_rueckgabe', 'schluessel_nr', 'bemerkung'] as const;
type Spalte = typeof SPALTEN[number];
export const SPALTEN_TEXT: Record<Spalte, string> = {
  person: 'Person (Mitgliedsnr. oder Name)', ausgabe: 'Ausgabe am', ausgegeben_von: 'ausgegeben von', pfand: 'Pfand', rueckgabe: 'Rückgabe am',
  empfangen_von: 'empfangen von', doc_ausgabe: 'Paperless-ID Beleg Ausgabe', doc_rueckgabe: 'Paperless-ID Beleg Rückgabe', schluessel_nr: 'Schlüsselnr.', bemerkung: 'Bemerkung',
};
const KOPF: [RegExp, Spalte][] = [
  [/beleg.*(r(ü|ue)ck)|(r(ü|ue)ck).*beleg/i, 'doc_rueckgabe'], [/beleg/i, 'doc_ausgabe'],
  [/ausgegeben|ausgabe.*(von|durch)/i, 'ausgegeben_von'], [/empfangen|r(ü|ue)ck.*(von|durch)/i, 'empfangen_von'],
  [/r(ü|ue)ck(gabe|nahme)/i, 'rueckgabe'], [/ausgabe/i, 'ausgabe'], [/pfand|betrag|kaution/i, 'pfand'],
  [/schl(ü|ue)ssel/i, 'schluessel_nr'], [/bemerk|notiz|hinweis/i, 'bemerkung'], [/person|name|mitglied|kunde/i, 'person'],
];

/**
 * Altdaten aus der Zwischenablage (Excel: Tabulator; sonst Semikolon). Mit Kopfzeile werden die Spalten nach ihrer Überschrift
 * erkannt, ohne Kopfzeile gilt die feste Reihenfolge SPALTEN. Je Zeile mindestens Person und Ausgabe- oder Rückgabedatum.
 */
export function altdatenLesen(text: string): AltZeile[] {
  const zeilen = text.replace(/\r/g, '').split('\n').filter((z) => z.trim());
  if (!zeilen.length) return [];
  const trenner = zeilen[0].includes('\t') ? '\t' : ';';
  const zellen = zeilen.map((z) => z.split(trenner).map((c) => c.trim().replace(/^"(.*)"$/, '$1')));
  let ordnung: (Spalte | null)[] = [...SPALTEN];
  let start = 0;
  // Kopfzeile: keine Zelle ist ein Datum und mindestens zwei Überschriften werden erkannt
  const erkannt = zellen[0].map((c) => KOPF.find(([re]) => re.test(c))?.[1] ?? null);
  if (!zellen[0].some((c) => datumLesen(c)) && erkannt.filter(Boolean).length >= 2) { ordnung = erkannt; start = 1; }
  const out: AltZeile[] = [];
  for (let i = start; i < zellen.length; i++) {
    const w: Partial<Record<Spalte, string>> = {};
    zellen[i].forEach((c, n) => { const sp = ordnung[n]; if (sp && w[sp] === undefined) w[sp] = c; });
    const fehler: string[] = [];
    const datum = (k: 'ausgabe' | 'rueckgabe') => {
      if (!w[k]) return null;
      const d = datumLesen(w[k]);
      if (!d) fehler.push(`${SPALTEN_TEXT[k]}: „${w[k]}“ ist kein Datum (TT.MM.JJJJ)`);
      return d;
    };
    const ausgabe = datum('ausgabe');
    const rueckgabe = datum('rueckgabe');
    const pfand = betragLesen(w.pfand);
    if (Number.isNaN(pfand)) fehler.push(`Pfand: „${w.pfand}“ ist kein Betrag`);
    const dok = (k: 'doc_ausgabe' | 'doc_rueckgabe') => {
      const d = dokLesen(w[k]);
      if (Number.isNaN(d)) fehler.push(`${SPALTEN_TEXT[k]}: „${w[k]}“ ist keine Dokumentnummer`);
      return Number.isNaN(d) ? null : d;
    };
    if (!w.person) fehler.push('Person fehlt');
    if (!ausgabe && !rueckgabe && !fehler.length) fehler.push('Weder Ausgabe- noch Rückgabedatum');
    if (ausgabe && rueckgabe && rueckgabe < ausgabe) fehler.push('Die Rückgabe liegt vor der Ausgabe');
    out.push({
      zeile: i + 1, person: w.person ?? '', ausgabe, ausgegeben_von: w.ausgegeben_von ?? '', pfand: Number.isNaN(pfand) ? null : pfand,
      rueckgabe, empfangen_von: w.empfangen_von ?? '', doc_ausgabe: dok('doc_ausgabe'), doc_rueckgabe: dok('doc_rueckgabe'),
      schluessel_nr: w.schluessel_nr ?? '', bemerkung: w.bemerkung ?? '', fehler,
    });
  }
  return out;
}

/** Ausgabe ohne Quittung seit mehr als `tage` Tagen */
export function quittungUeberfaellig(v: { art: string; status: string; datum: string }, heute: string, tage: number): boolean {
  if (v.art !== 'AUSGABE' || v.status !== 'WARTET') return false;
  return (new Date(`${heute}T00:00:00Z`).getTime() - new Date(`${v.datum}T00:00:00Z`).getTime()) / 86_400_000 > tage;
}

// ---------------------------------------------------------------- Abgleich mit FI-Buchungen

/** Namen und Buchungstexte vergleichbar machen: Großschreibung, Umlaute/ß aufgelöst, nur Buchstaben und Ziffern */
export const normText = (s: string | null | undefined) => (s ?? '').toUpperCase()
  .replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Ü/g, 'UE').replace(/ß|ẞ/g, 'SS').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Z0-9]+/g, ' ').trim();

/** kommt die Person (Vor- und Nachname als ganze Wörter) im Text vor? 2 = Vor- und Nachname, 1 = nur Nachname, 0 = nein */
export function nameImText(person: string, text: string): 0 | 1 | 2 {
  const t = ` ${normText(text)} `;
  const teile = normText(person).split(' ').filter(Boolean);
  if (!teile.length) return 0;
  const nach = teile[teile.length - 1];
  if (nach.length < 3 || !t.includes(` ${nach} `)) return 0;
  return teile.length > 1 && t.includes(` ${teile[0]} `) ? 2 : 1;
}

export interface AbgleichBuchung { datum: string; betrag: number; richtung: Art; text: string; rgnr: string | null }
export interface AbgleichVorgang { id: number; art: string; person: string; datum: string; pfand: number | null; rgnr: string | null }
export interface AbgleichTreffer { id: number; punkte: number; grund: string }

const tageDiff = (a: string, b: string) => Math.abs(new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86_400_000;

/**
 * Vorgänge, die zu einer Buchung passen, bester zuerst. Gleiche Richtung ist Pflicht; gewertet werden die Hallenrechnung
 * (sicher), der Name im Buchungstext, der Betrag (= Pfand) und der zeitliche Abstand. Ab 60 Punkten gilt ein Vorgang als Treffer.
 */
export function abgleichTreffer(b: AbgleichBuchung, vorgaenge: AbgleichVorgang[], tage = 60): AbgleichTreffer[] {
  const out: AbgleichTreffer[] = [];
  for (const v of vorgaenge) {
    if (v.art !== b.richtung) continue;
    let punkte = 0;
    const grund: string[] = [];
    if (b.rgnr && v.rgnr && b.rgnr === v.rgnr) { punkte += 100; grund.push(`Rechnung ${v.rgnr}`); }
    const n = nameImText(v.person, b.text);
    if (n) { punkte += n === 2 ? 60 : 45; grund.push(n === 2 ? 'Name im Buchungstext' : 'Nachname im Buchungstext'); }
    if (v.pfand != null) {
      if (Math.abs(v.pfand - Math.abs(b.betrag)) < 0.005) { punkte += 15; grund.push('Betrag = Pfand'); } else punkte -= 30;
    }
    const d = tageDiff(b.datum, v.datum);
    if (d <= 3) { punkte += 20; grund.push('Datum passt'); } else if (d <= tage) { punkte += 10; grund.push(`${Math.round(d)} Tage Abstand`); } else punkte -= 25;
    if (punkte >= 60) out.push({ id: v.id, punkte, grund: grund.join(', ') });
  }
  return out.sort((x, y) => y.punkte - x.punkte || x.id - y.id);
}

/** eindeutig: genau ein Treffer oder der beste liegt klar vor dem zweiten */
export const abgleichEindeutig = (t: AbgleichTreffer[]) => t.length === 1 || (t.length > 1 && t[0].punkte - t[1].punkte >= 20);
