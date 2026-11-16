/**
 * Haushaltsplan – Rechenkern (docs/haushaltsplan/konzept.md, Abschnitt 3). Reine Funktionen ohne Datenbank:
 * Jahresverlauf, Hochrechnung des laufenden Jahres, Methoden des Vorschlags, rückwirkende Prüfung (Treffsicherheit),
 * Ausreißer, Preissteigerung, Monatsverteilung, Bewertung der Abweichung und Liquiditätsvorschau.
 *
 * Alle Beträge sind positive Werte aus Sicht der Kontoart (Einnahme bzw. Ausgabe), wie im Jahresabschluss.
 */

export type Methode = 'HOCH' | 'AVG3' | 'MED5' | 'TREND' | 'FACH' | 'MANUELL';
/** Methoden, die aus der Vergangenheit rechnen (in dieser Reihenfolge bei gleicher Treffsicherheit bevorzugt) */
export const RECHEN_METHODEN = ['HOCH', 'AVG3', 'MED5', 'TREND'] as const;
export type RechenMethode = (typeof RECHEN_METHODEN)[number];

export const METHODE_TEXT: Record<Methode, string> = {
  HOCH: 'Hochrechnung laufendes Jahr', AVG3: 'Durchschnitt 3 Jahre', MED5: 'Median 5 Jahre', TREND: 'Trend',
  FACH: 'Fachdaten (Verträge)', MANUELL: 'Manuell',
};

/** Unter so vielen abgeschlossenen Jahren gibt es weder Trend noch Trefferquote */
export const MIN_HISTORIE = 3;
/** Über so viele Prüfjahre wird die Treffsicherheit höchstens gemittelt */
export const PRUEFJAHRE = 3;
/** Liegt der übliche Anteil der gebuchten Monate darunter, wird nicht geteilt, sondern der übliche Rest addiert */
export const MIN_ANTEIL = 0.15;

const cent = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const summe = (a: number[]) => a.reduce((s, x) => s + x, 0);

export function mittel(a: number[]): number | null {
  return a.length ? summe(a) / a.length : null;
}

export function median(a: number[]): number | null {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Lineare Fortschreibung um ein Jahr (kleinste Quadrate über gleichmäßig aufeinanderfolgende Werte).
 * Unter MIN_HISTORIE Werten gibt es keinen Trend; ein Trend unter 0 wird bei 0 gekappt (Beträge sind nie negativ).
 */
export function trend(werte: number[]): number | null {
  const n = werte.length;
  if (n < MIN_HISTORIE) return null;
  const mx = (n - 1) / 2, my = summe(werte) / n;
  let zs = 0, ns = 0;
  werte.forEach((y, x) => { zs += (x - mx) * (y - my); ns += (x - mx) ** 2; });
  if (ns === 0) return null;
  return Math.max(0, my + (zs / ns) * (n - mx));
}

/**
 * Üblicher Jahresverlauf eines Kontos: Anteil jedes Monats am Jahr, gemittelt über die Jahre (jedes Jahr zählt gleich,
 * unabhängig von seiner Höhe). Jahre ohne Wert zählen nicht; negative Monatsanteile (Stornos über den Monatswechsel)
 * werden auf 0 gesetzt. Ohne verwertbares Jahr: null – der Aufrufer rechnet dann gleichmäßig.
 */
export function jahresverlauf(jahre: number[][]): number[] | null {
  const anteile: number[][] = [];
  for (const m of jahre) {
    if (m.length !== 12) continue;
    const s = summe(m);
    if (!(s > 0)) continue;
    anteile.push(m.map((x) => x / s));
  }
  if (!anteile.length) return null;
  const p = Array.from({ length: 12 }, (_, i) => Math.max(0, summe(anteile.map((a) => a[i])) / anteile.length));
  const s = summe(p);
  return s > 0 ? p.map((x) => x / s) : null;
}

export const GLEICHMAESSIG: number[] = Array.from({ length: 12 }, () => 1 / 12);

export interface Hochrechnung {
  wert: number;
  /** IST = Jahr vollständig · VERLAUF = Ist ÷ üblicher Anteil · REST = Ist + üblicher Rest · LINEAR = ohne Jahresverlauf, gleichmäßig */
  art: 'IST' | 'VERLAUF' | 'REST' | 'LINEAR';
  /** üblicher Anteil der gebuchten Monate am Jahr (0…1) */
  anteil: number;
}

/**
 * Ist bis einschließlich Monat `monate` (1…12) auf das ganze Jahr hochrechnen.
 * - mit Jahresverlauf: Ist ÷ Anteil dieser Monate am Jahr
 * - ist der Anteil sehr klein (das Konto fällt üblicherweise später im Jahr an), wäre die Division unbrauchbar:
 *   dann Ist + üblicher Rest (Durchschnitt der Vorjahre × fehlender Anteil)
 * - ohne Jahresverlauf (keine Vorjahre): gleichmäßig × 12 ÷ Monate
 * Ohne gebuchten Monat gibt es keine Hochrechnung (null).
 */
export function hochrechnen(ist: number, monate: number, profil: number[] | null, basisJahr: number | null): Hochrechnung | null {
  if (monate >= 12) return { wert: cent(ist), art: 'IST', anteil: 1 };
  if (monate <= 0) return null;
  if (!profil) return { wert: cent((ist * 12) / monate), art: 'LINEAR', anteil: monate / 12 };
  const anteil = summe(profil.slice(0, monate));
  if (anteil >= MIN_ANTEIL) return { wert: cent(ist / anteil), art: 'VERLAUF', anteil };
  if (basisJahr !== null) return { wert: cent(ist + basisJahr * (1 - anteil)), art: 'REST', anteil };
  return anteil > 0 ? { wert: cent(ist / anteil), art: 'VERLAUF', anteil } : null;
}

/** Jahr eines Kontos mit seinen zwölf Monatswerten */
export interface JahrMonate { jahr: number; monate: number[] }

export interface VorschlagEingabe {
  /** Jahre, die zählen (aufsteigend, lückenlos nicht nötig): ohne Sondereffekte, ohne Jahre vor dem ersten Gebrauch */
  jahre: JahrMonate[];
  /** Jahr, für das geplant wird */
  planjahr: number;
  /** Bis zu diesem Monat ist das Basisjahr (Planjahr − 1) gebucht: 12 = abgeschlossen, 0 = noch nichts */
  standMonat: number;
}

export interface MethodenWerte {
  /** Wert je Methode; null = die Methode liefert für dieses Konto nichts */
  werte: Record<RechenMethode, number | null>;
  /** Hochrechnung des Basisjahres (null: nichts gebucht bzw. das Basisjahr zählt nicht) */
  hoch: Hochrechnung | null;
  /** abgeschlossene Jahre vor dem Basisjahr, die in die Rechnung eingehen */
  anzahlJahre: number;
  /** Jahresverlauf aus den abgeschlossenen Jahren (null = keiner, es wird gleichmäßig gerechnet) */
  profil: number[] | null;
}

const jahreswert = (j: JahrMonate) => summe(j.monate);

/**
 * Werte aller Methoden für ein Konto. Grundlage sind die abgeschlossenen Jahre vor dem Basisjahr und – wenn das
 * Basisjahr schon Buchungen hat – dessen Hochrechnung als jüngster Wert der Reihe (im Herbst ist das Jahr nicht zu Ende).
 */
export function methodenWerte(e: VorschlagEingabe): MethodenWerte {
  const basis = e.planjahr - 1;
  const voll = e.jahre.filter((j) => j.jahr < basis).sort((a, b) => a.jahr - b.jahr);
  const lauf = e.jahre.find((j) => j.jahr === basis);
  const profil = jahresverlauf(voll.map((j) => j.monate));
  const reihe = voll.map(jahreswert);
  let hoch: Hochrechnung | null = null;
  if (lauf && e.standMonat > 0) {
    const m = Math.min(12, e.standMonat);
    hoch = hochrechnen(summe(lauf.monate.slice(0, m)), m, profil, mittel(reihe.slice(-3)));
  }
  if (hoch) reihe.push(hoch.wert);
  // ein abgeschlossenes Basisjahr ist ein volles Jahr Historie, ein hochgerechnetes nicht
  const anzahlJahre = voll.length + (hoch?.art === 'IST' ? 1 : 0);
  return {
    werte: {
      HOCH: hoch ? hoch.wert : null,
      AVG3: mittel(reihe.slice(-3)),
      MED5: median(reihe.slice(-5)),
      TREND: anzahlJahre >= MIN_HISTORIE ? trend(reihe.slice(-5)) : null,
    },
    hoch, anzahlJahre, profil,
  };
}

/** Treffer in Prozent: 100 − Abweichung vom Ist; Ist 0 → 100 bei Vorhersage 0, sonst 0 (keine Division durch 0) */
export function treffer(vorhersage: number, ist: number): number {
  if (Math.abs(ist) < 0.005) return Math.abs(vorhersage) < 0.005 ? 100 : 0;
  return Math.max(0, 100 - (Math.abs(vorhersage - ist) / Math.abs(ist)) * 100);
}

export interface Pruefung {
  /** mittlere Trefferquote je Methode (0…100); null = nicht prüfbar */
  treffer: Record<RechenMethode, number | null>;
  /** geprüfte Jahre (jüngstes zuerst) */
  jahre: number[];
  beste: RechenMethode | null;
}

/**
 * Rückwirkende Prüfung: Jede Methode wird so auf die Vergangenheit angewendet, wie sie heute angewendet wird –
 * mit den Daten bis zum selben Monat des jeweiligen Vorjahres. Geprüft wird gegen bis zu PRUEFJAHRE abgeschlossene
 * Jahre und gemittelt. Unter MIN_HISTORIE abgeschlossenen Jahren gibt es keine Trefferquote.
 */
export function rueckpruefung(e: VorschlagEingabe): Pruefung {
  const basis = e.planjahr - 1;
  const voll = e.jahre.filter((j) => j.jahr < basis || (j.jahr === basis && e.standMonat >= 12)).sort((a, b) => a.jahr - b.jahr);
  const leer: Pruefung = { treffer: { HOCH: null, AVG3: null, MED5: null, TREND: null }, jahre: [], beste: null };
  if (voll.length < MIN_HISTORIE) return leer;
  // Im Rückblick steht dasselbe Stück des Vorjahres zur Verfügung wie heute; ist das Basisjahr abgeschlossen, das ganze
  const stand = e.standMonat >= 12 || e.standMonat <= 0 ? 12 : e.standMonat;
  const summen: Record<RechenMethode, number[]> = { HOCH: [], AVG3: [], MED5: [], TREND: [] };
  const jahre: number[] = [];
  // Verglichen wird über dieselben Jahre: Methoden, die im jüngsten Prüfjahr einen Wert liefern, müssen ihn auch in
  // jedem weiteren Prüfjahr liefern – sonst endet die Prüfung dort (ältere Jahre haben zu wenig Vorlauf).
  let dabei: RechenMethode[] | null = null;
  for (let i = voll.length - 1; i >= 1 && jahre.length < PRUEFJAHRE; i--) {
    const ziel = voll[i];
    // nur prüfen, wenn das Jahr davor zählt (sonst fehlt der Methode genau der Wert, auf den sie sich stützt)
    if (voll[i - 1].jahr !== ziel.jahr - 1) continue;
    const m = methodenWerte({ jahre: voll.slice(0, i), planjahr: ziel.jahr, standMonat: stand });
    const mit = RECHEN_METHODEN.filter((k) => m.werte[k] !== null);
    if (dabei === null) dabei = mit;
    if (!dabei.length || dabei.some((k) => !mit.includes(k))) break;
    const ist = jahreswert(ziel);
    for (const k of dabei) summen[k].push(treffer(m.werte[k]!, ist));
    jahre.push(ziel.jahr);
  }
  const t = { ...leer.treffer };
  let beste: RechenMethode | null = null;
  for (const k of jahre.length ? dabei ?? [] : []) {
    t[k] = Math.round((mittel(summen[k]) ?? 0) * 10) / 10;
    if (beste === null || t[k]! > t[beste]!) beste = k;
  }
  return { treffer: t, jahre, beste };
}

/**
 * Vorbelegte Methode: Fachdaten, wenn es sie für das Konto gibt; sonst die treffsicherste Methode, die für das
 * Planjahr einen Wert liefert; ohne Prüfung die Hochrechnung, sonst der Durchschnitt; ohne jede Grundlage Manuell.
 */
export function besteMethode(m: MethodenWerte, p: Pruefung, fach: number | null): Methode {
  if (fach !== null) return 'FACH';
  const kandidaten = RECHEN_METHODEN.filter((k) => m.werte[k] !== null);
  if (!kandidaten.length) return 'MANUELL';
  const mitTreffer = kandidaten.filter((k) => p.treffer[k] !== null);
  if (mitTreffer.length) return mitTreffer.reduce((a, b) => (p.treffer[b]! > p.treffer[a]! ? b : a));
  return kandidaten[0];
}

export interface Ausreisser { jahr: number; wert: number; median: number; abweichung: number }

/**
 * Jahre, deren Wert um mehr als `schwelle` Prozent vom Median der Reihe abweicht – Vorschlag für Sondereffekte.
 * Ab drei Jahren; bei Median 0 gibt es keinen Maßstab und damit keinen Vorschlag.
 */
export function ausreisser(jahre: { jahr: number; wert: number }[], schwelle: number): Ausreisser[] {
  if (jahre.length < MIN_HISTORIE || !(schwelle > 0)) return [];
  const med = median(jahre.map((j) => j.wert))!;
  if (Math.abs(med) < 0.005) return [];
  return jahre
    .map((j) => ({ jahr: j.jahr, wert: j.wert, median: cent(med), abweichung: Math.round(((j.wert - med) / Math.abs(med)) * 1000) / 10 }))
    .filter((j) => Math.abs(j.abweichung) > schwelle);
}

/** Vorschläge werden auf volle 10 € gerundet (wie im Mockup) – ein Plan ist keine Abrechnung */
export const rundenPlan = (v: number) => Math.round(v / 10) * 10;

/**
 * Planwert aus dem Vorschlag: Preissteigerung nur auf Ausgaben und nur auf Werte aus der Vergangenheit –
 * Fachdaten und manuelle Werte gelten schon für das Planjahr.
 */
export function planwertAus(vorschlag: number | null, methode: Methode, art: 'E' | 'A', zuschlag: number): number {
  if (vorschlag === null || !Number.isFinite(vorschlag)) return 0;
  const mit = art === 'A' && methode !== 'FACH' && methode !== 'MANUELL' ? vorschlag * (1 + (zuschlag || 0) / 100) : vorschlag;
  return rundenPlan(Math.max(0, mit));
}

/** Jahreswert nach dem Jahresverlauf auf zwölf Monate verteilen; die Summe stimmt auf den Cent (Rest im stärksten Monat) */
export function monatsverteilung(planwert: number, profil: number[] | null): number[] {
  const p = profil && profil.length === 12 && summe(profil) > 0 ? profil : GLEICHMAESSIG;
  const s = summe(p);
  const out = p.map((x) => cent((planwert * x) / s));
  const rest = cent(planwert - summe(out));
  if (rest !== 0) {
    const i = p.indexOf(Math.max(...p));
    out[i] = cent(out[i] + rest);
  }
  return out;
}

/** Laufende Summe (aufgelaufene Werte je Monat) */
export function aufgelaufen(werte: number[]): number[] {
  let s = 0;
  return werte.map((w) => (s = cent(s + w)));
}

export type Stufe = 'IM_PLAN' | 'BEOBACHTEN' | 'UEBERSCHRITTEN';
export interface Bewertung {
  abweichung: number;
  /** Abweichung in Prozent des Plans; null ohne Planwert */
  prozent: number | null;
  stufe: Stufe;
  state: 'Positive' | 'Critical' | 'Negative';
  text: string;
}

/**
 * Abweichung eines Wertes (Ist oder Hochrechnung) vom Plan. Schlecht ist bei Ausgaben „mehr“, bei Einnahmen „weniger“.
 * Ohne Planwert gibt es keinen Prozentwert: eine ungeplante Ausgabe gilt als überschritten, eine ungeplante Einnahme
 * als im Plan.
 */
export function bewerten(art: 'E' | 'A', plan: number, wert: number, gelb: number, rot: number): Bewertung {
  const abweichung = cent(wert - plan);
  const gut: Bewertung = { abweichung, prozent: null, stufe: 'IM_PLAN', state: 'Positive', text: 'im Plan' };
  const schlecht = (stufe: Stufe, prozent: number | null): Bewertung => (stufe === 'UEBERSCHRITTEN'
    ? { abweichung, prozent, stufe, state: 'Negative', text: art === 'A' ? 'Budget überschritten' : 'deutlich unter Plan' }
    : { abweichung, prozent, stufe, state: 'Critical', text: 'beobachten' });
  if (Math.abs(plan) < 0.005) {
    if (art === 'A' && abweichung > 0.005) return { ...schlecht('UEBERSCHRITTEN', null), text: 'nicht geplant' };
    return gut;
  }
  const prozent = Math.round((abweichung / Math.abs(plan)) * 1000) / 10;
  const s = art === 'A' ? prozent : -prozent;
  if (s > rot) return schlecht('UEBERSCHRITTEN', prozent);
  if (s > gelb) return schlecht('BEOBACHTEN', prozent);
  return { ...gut, prozent };
}

export interface LiqMonat {
  monat: number; einnahmen: number; ausgaben: number; tilgung: number; bestand: number;
  /** null = keine Mindestreserve hinterlegt, also keine Bewertung */
  ausreichend: boolean | null;
}
export interface Liquiditaet { anfang: number; monate: LiqMonat[]; tiefster: number; tiefsterMonat: number; mindestreserve: number | null }

/** Geldbestand je Monatsende: Anfangsbestand + Einnahmen − Ausgaben − Tilgung, verglichen mit der Mindestreserve */
export function liquiditaet(anfang: number, einnahmen: number[], ausgaben: number[], tilgung: number[], mindestreserve: number | null): Liquiditaet {
  let bestand = anfang;
  const monate: LiqMonat[] = [];
  for (let i = 0; i < 12; i++) {
    const e = einnahmen[i] ?? 0, a = ausgaben[i] ?? 0, t = tilgung[i] ?? 0;
    bestand = cent(bestand + e - a - t);
    monate.push({ monat: i + 1, einnahmen: cent(e), ausgaben: cent(a), tilgung: cent(t), bestand, ausreichend: mindestreserve === null ? null : bestand >= mindestreserve });
  }
  const tiefster = Math.min(...monate.map((m) => m.bestand));
  return { anfang: cent(anfang), monate, tiefster, tiefsterMonat: monate.find((m) => m.bestand === tiefster)!.monat, mindestreserve };
}
