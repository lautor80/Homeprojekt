import type { DruckPosition } from '../halle/daten.js';

/**
 * Meine Rechnungen (Platz buchen): Positionen einer Rechnung als Baum zur Übersicht – Gruppen (Abo, Einzelbuchungen,
 * weitere Positionen) mit Anzahl und Summe, darunter die einzelnen Positionen. Nur, was auch auf der Rechnung steht:
 * keine Kontierung, keine Belegverweise.
 */
export interface BaumPosition { text: string; menge: string; betrag: number; storno: boolean }
export interface BaumGruppe { titel: string; summe: number; positionen: BaumPosition[] }

const GRUPPEN: [string, (p: DruckPosition) => boolean][] = [
  ['Abo', (p) => p.art === 'Abo'],
  ['Einzelbuchungen', (p) => p.art === 'Einzel'],
  ['Weitere Positionen', () => true],
];
const zahl = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: 2 });
const eur = (n: number) => `${n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const cent = (n: number) => Math.round(n * 100) / 100;

export function rechnungsBaum(positionen: DruckPosition[]): BaumGruppe[] {
  const rest = [...positionen];
  const baum: BaumGruppe[] = [];
  for (const [titel, passt] of GRUPPEN) {
    const eigene = rest.filter(passt);
    if (!eigene.length) continue;
    for (const p of eigene) rest.splice(rest.indexOf(p), 1);
    baum.push({
      titel, summe: cent(eigene.reduce((s, p) => s + p.betrag, 0)),
      positionen: eigene.map((p) => {
        const miete = p.art === 'Abo' || p.art === 'Einzel';
        // die Gruppe nennt die Art schon – in der Zeile stehen Wochentag, Datum und Uhrzeit
        const teile = p.beschreibung.split('\t').map((t) => t.trim()).filter(Boolean);
        const text = (miete && teile.length > 1 ? teile.slice(1) : teile).join(' · ');
        return {
          text, storno: p.storno, betrag: p.betrag,
          menge: p.storno ? 'storniert'
            // über mehrere Preisklassen: je Preisklasse Stunden × Stundenpreis statt Durchschnitt
            : p.teile?.length ? p.teile.map((t) => `${zahl(t.stunden)} Std. × ${eur(t.stundenpreis)}`).join(' + ')
            : p.anzahl === 1 && !miete ? '' : `${zahl(p.anzahl)} ${miete ? 'Std.' : '×'} ${miete ? '×' : ''} ${eur(p.ep)}`.replace(/\s+/g, ' '),
        };
      }),
    });
  }
  return baum;
}
