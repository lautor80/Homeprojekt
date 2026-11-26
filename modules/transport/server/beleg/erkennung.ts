/**
 * Auftrag aus Beleg: reine Texterkennung. Aus dem gelesenen Text eines Belegs (pdftotext -layout oder Texterkennung eines Bildes)
 * werden die Felder eines Frachtauftrags vorgeschlagen. Ohne Datenbank; der Abgleich mit Kontakten und Wertelisten folgt serverseitig.
 * Doku: docs/euroflex-belegerfassung.md.
 *
 * Grundregel für JEDES Feld (siehe typen.ts): eindeutig im Beleg → übernehmen; mehrere mögliche oder ein unsicherer Wert → „unklar“
 * mit Kandidaten (die Maske fragt nach); nichts gefunden → „fehlt“. Es wird nie geraten.
 */
import type { BelegErkennung, BelegLayout } from './typen.js';
import { genugMerkmale, leereErkennung, zeilenAus } from './erkennung-helfer.js';
import { allgemeinLesen } from './layout-allgemein.js';
import { bestellungLesen } from './layout-bestellung.js';
import { ladeauftragLesen } from './layout-ladeauftrag.js';

const anzahl = (text: string, merkmale: RegExp[]) => merkmale.filter((m) => m.test(text)).length;

/** Layout nach Merkmalen im Text bestimmen (unabhängig davon, welche Layouts aktiv sind); null = kein eigenes Layout erkannt */
export function layoutErkennen(text: string): Exclude<BelegLayout, 'allgemein'> | null {
  const bestellung = /Bestellung\s*Nr/i.test(text)
    ? anzahl(text, [/Ladestell/i, /Ladetermin/i, /Lieferadresse/i, /Frachtkosten/i, /Gesamtpreis/i, /Liefertermin/i]) : 0;
  const ladeauftrag = anzahl(text, [/Transport\s?-?\s?Auftrag\s+f[üu]r/i, /Auftraggeber\s*\/\s*Frachtzahler/i, /Verladeadresse/i, /Verladedatum/i, /Anlieferdatum/i,
    /Adresse(\(n\)|n)?\s+Anlieferung/i, /Frachtrate/i, /Ladeauftrag/i, /Gesamtgewicht\s+der\s+Tour/i]);
  if (ladeauftrag >= 4 && ladeauftrag > bestellung) return 'ladeauftrag';
  if (bestellung >= 3) return 'bestellung';
  return null;
}

/** Belege, die sicher kein Frachtauftrag sind (nur für das Layout „allgemein“ geprüft – dort fehlen eindeutige Merkmale) */
const ANDERER_BELEG = /(?<![\p{L}-])(Rechnungs?\s?-?\s?(Nr|Nummer|Datum)|Lieferschein\s?-?\s?(Nr|Nummer|Datum)|Gutschrift\s?-?\s?(Nr|Nummer)|Mahnung|Zahlungserinnerung|Kontoauszug|Angebots?\s?-?\s?(Nr|Nummer))/iu;
const TITEL_ANDERER = /^\s*(Rechnung|Lieferschein|Gutschrift|Angebot|Mahnung|Auftragsbestätigung)\s*$/im;

/**
 * Beleg lesen. `aktiv` = in den Einstellungen eingeschaltete Layouts; ist das passende Layout nicht aktiv, liest – sofern aktiv –
 * das Layout „allgemein“. istFrachtauftrag = false: der Text sieht nicht nach einem Frachtauftrag aus, alle Felder bleiben leer.
 */
export function belegErkennen(text: string, aktiv: BelegLayout[] = ['bestellung', 'ladeauftrag', 'allgemein']): BelegErkennung {
  const zeilen = zeilenAus(text ?? '');
  const ganz = zeilen.join('\n');
  const erkannt = layoutErkennen(ganz);
  const layout: BelegLayout | null = erkannt && aktiv.includes(erkannt) ? erkannt : aktiv.includes('allgemein') ? 'allgemein' : null;
  if (!layout) {
    const leer = leereErkennung(erkannt ?? 'allgemein');
    leer.hinweise.push(erkannt ? 'Das Leseprofil für diese Belegart ist in den Einstellungen nicht aktiv.' : 'Für diesen Beleg ist kein Leseprofil aktiv.');
    return leer;
  }
  if (!ganz.trim()) { const leer = leereErkennung(layout); leer.hinweise.push('Der Beleg enthält keinen lesbaren Text.'); return leer; }
  const e = layout === 'bestellung' ? bestellungLesen(zeilen) : layout === 'ladeauftrag' ? ladeauftragLesen(zeilen) : allgemeinLesen(zeilen);
  const anderer = layout === 'allgemein' && !erkannt && (ANDERER_BELEG.test(ganz) || TITEL_ANDERER.test(ganz));
  if (anderer || !genugMerkmale(e)) {
    const leer = leereErkennung(layout);
    leer.hinweise.push(anderer ? 'Der Beleg sieht nach einer Rechnung, einem Lieferschein oder Angebot aus, nicht nach einem Frachtauftrag.'
      : 'Im Beleg wurden zu wenige Merkmale eines Frachtauftrags gefunden (Lade-/Lieferanschrift und Preis oder Termin).');
    return leer;
  }
  if (layout === 'allgemein' && erkannt) e.hinweise.push('Das Leseprofil für diese Belegart ist nicht aktiv – gelesen wurde nur über allgemeine Schlagworte.');
  return e;
}
