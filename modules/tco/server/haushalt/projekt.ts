/**
 * Haushaltsplan – Projekte: Rechenkern (reine Funktionen ohne Datenbank).
 * Ein Projekt hat eine Zeitspanne (Monate, auch über mehrere Geschäftsjahre) und Positionen: Kosten, Finanzierung
 * (Zuschuss, Spende, Eigenmittel, Darlehen mit Tilgung) und Folgekosten/-einsparungen nach Abschluss. Jede Position
 * wird über die Zeit verteilt; daraus entsteht je Geschäftsjahr die Wirkung auf Einnahmen, Ausgaben und Liquidität.
 *
 * Monate sind als „JJJJ-MM“ angegeben.
 */

export const POSITION_ARTEN = ['KOSTEN', 'ZUSCHUSS', 'SPENDE', 'EIGENMITTEL', 'DARLEHEN', 'TILGUNG', 'FOLGEKOSTEN', 'EINSPARUNG'] as const;
export type PositionArt = (typeof POSITION_ARTEN)[number];
export const POSITION_TEXT: Record<PositionArt, string> = {
  KOSTEN: 'Kosten', ZUSCHUSS: 'Zuschuss', SPENDE: 'Spende', EIGENMITTEL: 'Eigenmittel', DARLEHEN: 'Darlehen (Zufluss)', TILGUNG: 'Tilgung des Darlehens',
  FOLGEKOSTEN: 'Folgekosten (jährlich)', EINSPARUNG: 'Einsparung (jährlich)',
};
/** GLEICH = gleichmäßig über die Laufzeit · MONAT = in einem Monat · HAND = je Monat von Hand · JAEHRLICH = Betrag je Jahr, wiederkehrend */
export const VERTEILUNGEN = ['GLEICH', 'MONAT', 'HAND', 'JAEHRLICH'] as const;
export type Verteilung = (typeof VERTEILUNGEN)[number];

export const STATUS = ['IDEE', 'BEANTRAGT', 'GENEHMIGT', 'ABGELEHNT', 'ZURUECKGESTELLT', 'UMSETZUNG', 'ABGESCHLOSSEN'] as const;
export type ProjektStatus = (typeof STATUS)[number];
export const STATUS_TEXT: Record<ProjektStatus, string> = {
  IDEE: 'Idee / Entwurf', BEANTRAGT: 'beantragt', GENEHMIGT: 'vom Vorstand genehmigt', ABGELEHNT: 'abgelehnt', ZURUECKGESTELLT: 'zurückgestellt',
  UMSETZUNG: 'in Umsetzung', ABGESCHLOSSEN: 'abgeschlossen',
};
/** erlaubte Übergänge; „entscheiden“ (genehmigen, ablehnen, zurückstellen) braucht das Recht zum Genehmigen */
export const UEBERGAENGE: Record<ProjektStatus, ProjektStatus[]> = {
  IDEE: ['BEANTRAGT'],
  BEANTRAGT: ['GENEHMIGT', 'ABGELEHNT', 'ZURUECKGESTELLT', 'IDEE'],
  GENEHMIGT: ['UMSETZUNG', 'ZURUECKGESTELLT'],
  ABGELEHNT: ['IDEE'],
  ZURUECKGESTELLT: ['BEANTRAGT', 'IDEE'],
  UMSETZUNG: ['ABGESCHLOSSEN'],
  ABGESCHLOSSEN: [],
};
export const ENTSCHEIDUNG: ProjektStatus[] = ['GENEHMIGT', 'ABGELEHNT', 'ZURUECKGESTELLT'];
/** Vorgabe „einrechnen“: genehmigte, laufende und abgeschlossene (Folgekosten) ja – Ideen, Anträge, Abgelehntes nein */
export const einrechnenVorgabe = (s: ProjektStatus) => s === 'GENEHMIGT' || s === 'UMSETZUNG' || s === 'ABGESCHLOSSEN';

export interface ProjektPosition {
  art: PositionArt; betrag: number; verteilung: Verteilung; konto?: string | null; bezeichnung?: string | null;
  /** eigener Zeitraum der Position (JJJJ-MM); leer = Laufzeit des Projekts. JAEHRLICH: ab `von`, ohne `bis` unbefristet */
  von?: string | null; bis?: string | null;
  /** HAND: Monat (JJJJ-MM) → Betrag */
  monate?: Record<string, number>;
}
export interface ProjektZeit { beginn: string; ende: string; positionen: ProjektPosition[] }

const cent = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
/** fortlaufende Monatsnummer aus „JJJJ-MM“ */
export const monatNr = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
export const monatText = (n: number) => `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`;

/** Anzahl Monate der Laufzeit (einschließlich Beginn und Ende); mindestens 1 */
export function laufzeit(beginn: string, ende: string): number {
  return Math.max(1, monatNr(ende) - monatNr(beginn) + 1);
}

/**
 * Zwölf Monatswerte einer Position im Geschäftsjahr `jahr`. Die Summe über alle Jahre ergibt den Betrag der Position
 * auf den Cent (der Rest steht im letzten Monat); JAEHRLICH liefert in jedem vollen Jahr den Betrag.
 */
export function positionMonate(p: ProjektPosition, z: { beginn: string; ende: string }, jahr: number): number[] {
  const out = Array.from({ length: 12 }, () => 0);
  const j0 = jahr * 12;
  if (p.verteilung === 'HAND') {
    for (const [m, b] of Object.entries(p.monate ?? {})) { const i = monatNr(m) - j0; if (i >= 0 && i < 12) out[i] = cent(out[i] + b); }
    return out;
  }
  const von = monatNr(p.von || (p.verteilung === 'JAEHRLICH' ? monatText(monatNr(z.ende) + 1) : z.beginn));
  if (p.verteilung === 'MONAT') {
    const i = von - j0;
    if (i >= 0 && i < 12) out[i] = cent(p.betrag);
    return out;
  }
  if (p.verteilung === 'JAEHRLICH') {
    const bis = p.bis ? monatNr(p.bis) : Number.POSITIVE_INFINITY;
    const je = cent(p.betrag / 12);
    for (let i = 0; i < 12; i++) if (j0 + i >= von && j0 + i <= bis) out[i] = je;
    // volles Jahr: Summe genau der Jahresbetrag
    if (j0 >= von && j0 + 11 <= bis) out[11] = cent(p.betrag - je * 11);
    return out;
  }
  // GLEICH: gleichmäßig über die Laufzeit, Rest im letzten Monat
  const bis = Math.max(von, monatNr(p.bis || z.ende));
  const n = bis - von + 1, je = cent(p.betrag / n);
  for (let i = 0; i < 12; i++) {
    const m = j0 + i;
    if (m >= von && m < bis) out[i] = je;
    else if (m === bis) out[i] = cent(p.betrag - je * (n - 1));
  }
  return out;
}

export interface Wirkung {
  /** Einnahmen und Ausgaben der Einnahmen-Ausgaben-Rechnung (Einsparungen mindern die Ausgaben) */
  einnahmen: number[]; ausgaben: number[];
  /** nur Liquidität: Zufluss aus Darlehen und dessen Tilgung */
  darlehen: number[]; tilgung: number[];
  /** je Konto (für die Anzeige): Monatswerte, Ausgaben positiv */
  konten: { konto: string; art: 'E' | 'A'; monate: number[] }[];
  sum: { einnahmen: number; ausgaben: number; ergebnis: number; darlehen: number; tilgung: number; liquiditaet: number };
}

const WIRKT: Record<PositionArt, 'E' | 'A' | 'A-' | 'D' | 'T' | ''> = {
  KOSTEN: 'A', FOLGEKOSTEN: 'A', EINSPARUNG: 'A-', ZUSCHUSS: 'E', SPENDE: 'E', EIGENMITTEL: '', DARLEHEN: 'D', TILGUNG: 'T',
};

/** Wirkung eines Projekts auf ein Geschäftsjahr */
export function wirkung(z: ProjektZeit, jahr: number): Wirkung {
  const n = () => Array.from({ length: 12 }, () => 0);
  const w: Wirkung = { einnahmen: n(), ausgaben: n(), darlehen: n(), tilgung: n(), konten: [], sum: { einnahmen: 0, ausgaben: 0, ergebnis: 0, darlehen: 0, tilgung: 0, liquiditaet: 0 } };
  for (const p of z.positionen) {
    const art = WIRKT[p.art];
    if (!art) continue;
    const m = positionMonate(p, z, jahr);
    const ziel = art === 'E' ? w.einnahmen : art === 'D' ? w.darlehen : art === 'T' ? w.tilgung : w.ausgaben;
    const vz = art === 'A-' ? -1 : 1;
    m.forEach((x, i) => { ziel[i] = cent(ziel[i] + vz * x); });
    if (p.konto && (art === 'E' || art === 'A' || art === 'A-') && m.some((x) => x !== 0)) {
      const ka = art === 'E' ? 'E' : 'A';
      let k = w.konten.find((x) => x.konto === p.konto && x.art === ka);
      if (!k) { k = { konto: p.konto, art: ka, monate: n() }; w.konten.push(k); }
      m.forEach((x, i) => { k!.monate[i] = cent(k!.monate[i] + vz * x); });
    }
  }
  const s = (a: number[]) => cent(a.reduce((x, y) => x + y, 0));
  w.sum = { einnahmen: s(w.einnahmen), ausgaben: s(w.ausgaben), ergebnis: cent(s(w.einnahmen) - s(w.ausgaben)), darlehen: s(w.darlehen), tilgung: s(w.tilgung),
    liquiditaet: cent(s(w.einnahmen) - s(w.ausgaben) + s(w.darlehen) - s(w.tilgung)) };
  return w;
}

/** Wirkt das Projekt im Jahr überhaupt? */
export const wirktIm = (w: Wirkung) => [...w.einnahmen, ...w.ausgaben, ...w.darlehen, ...w.tilgung].some((x) => x !== 0);

export interface Budget { kosten: number; finanzierung: number; zuschuss: number; spende: number; eigenmittel: number; darlehen: number; luecke: number; folge_jahr: number }

/** Gesamtbudget über die ganze Laufzeit: Kosten gegen Finanzierung; Lücke = noch nicht finanzierter Teil */
export function budget(positionen: ProjektPosition[]): Budget {
  const s = (a: PositionArt) => cent(positionen.filter((p) => p.art === a).reduce((x, p) => x + (p.verteilung === 'HAND' ? Object.values(p.monate ?? {}).reduce((y, b) => y + b, 0) : p.betrag), 0));
  const kosten = s('KOSTEN'), zuschuss = s('ZUSCHUSS'), spende = s('SPENDE'), eigenmittel = s('EIGENMITTEL'), darlehen = s('DARLEHEN');
  const finanzierung = cent(zuschuss + spende + eigenmittel + darlehen);
  return { kosten, finanzierung, zuschuss, spende, eigenmittel, darlehen, luecke: cent(kosten - finanzierung), folge_jahr: cent(s('FOLGEKOSTEN') - s('EINSPARUNG')) };
}
