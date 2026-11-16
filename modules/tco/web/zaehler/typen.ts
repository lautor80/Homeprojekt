/**
 * Zählerstände (TC Oberthal → Instandhaltung → Zählerstände): Typen der Schnittstelle /api/m/tco/zaehler…
 * Der Server (modules/tco/server/zaehler) liefert genau diese Formen; Datumswerte als 'YYYY-MM-DD', Perioden als 'YYYY-MM' bzw. 'YYYY'.
 */

export type Medium = 'STROM' | 'GAS' | 'WASSER' | 'WAERME' | 'PV' | 'OEL' | 'SONSTIGES';
/** ABLESUNG = abgelesen, SCHAETZUNG = geschätzt, AUSBAU = Endstand des alten Zählers, EINBAU = Anfangsstand des neuen Zählers (Zählerwechsel) */
export type StandArt = 'ABLESUNG' | 'SCHAETZUNG' | 'AUSBAU' | 'EINBAU';

export const MEDIEN: { key: Medium; text: string; einheit: string }[] = [
  { key: 'STROM', text: 'Strom', einheit: 'kWh' },
  { key: 'GAS', text: 'Gas', einheit: 'm³' },
  { key: 'WASSER', text: 'Wasser', einheit: 'm³' },
  { key: 'WAERME', text: 'Wärme', einheit: 'kWh' },
  { key: 'PV', text: 'PV-Erzeugung', einheit: 'kWh' },
  { key: 'OEL', text: 'Heizöl', einheit: 'l' },
  { key: 'SONSTIGES', text: 'Sonstiges', einheit: '' },
];
export const STAND_ARTEN: { key: StandArt; text: string }[] = [
  { key: 'ABLESUNG', text: 'Ablesung' },
  { key: 'SCHAETZUNG', text: 'Schätzung' },
  { key: 'AUSBAU', text: 'Zählerwechsel: Ausbau (Endstand alt)' },
  { key: 'EINBAU', text: 'Zählerwechsel: Einbau (Anfangsstand neu)' },
];

/** Stammdaten eines Zählers (Body von POST/PUT /zaehler ohne id/nummer) */
export interface ZaehlerStamm {
  bezeichnung: string;
  medium: Medium;
  einheit: string;
  standort: string | null;
  /** Herstell-/Zählernummer auf dem Gerät */
  zaehlernummer: string | null;
  /** Umrechnungsfaktor Ablesewert → Verbrauch (Wandlerfaktor; Gas m³→kWh = Brennwert × Zustandszahl). Standard 1 */
  faktor: number;
  /** Einheit des Verbrauchs nach dem Faktor (z. B. kWh bei Gas); null = wie einheit */
  verbrauchseinheit: string | null;
  /** Vorkommastellen des Zählwerks – für den Überlauf (999999 → 000000); null = kein Überlauf */
  stellen: number | null;
  /** Ableseintervall in Tagen (Erinnerung im Arbeitsvorrat); null = keine Erinnerung */
  intervall_tage: number | null;
  /** € je Verbrauchseinheit (brutto) */
  arbeitspreis: number | null;
  /** € je Monat (brutto) */
  grundpreis_monat: number | null;
  /** Zielwert Verbrauch je Kalenderjahr; Hochrechnung darüber → Hinweis im Arbeitsvorrat */
  jahresziel: number | null;
  aktiv: boolean;
  notiz: string | null;
}

export interface Zaehler extends ZaehlerStamm {
  id: number;
  /** fortlaufend, z. B. Z0001 */
  nummer: string;
}

export interface Zaehlerstand {
  id: number;
  zaehler_id: number;
  datum: string;
  stand: number;
  art: StandArt;
  notiz: string | null;
  hatFoto: boolean;
  erfasstVon: string | null;
  /** Verbrauch seit der vorigen Ablesung (× Faktor), null bei der ersten bzw. bei EINBAU */
  verbrauch: number | null;
  /** Ø Verbrauch je Tag seit der vorigen Ablesung */
  tagesverbrauch: number | null;
}

export interface Kennzahlen {
  letzteAblesung: { datum: string; stand: number } | null;
  /** letzte Ablesung + Intervall; null ohne Intervall oder ohne Ablesung */
  faelligAm: string | null;
  ueberfaellig: boolean;
  /** Ø Verbrauch je Tag der letzten 365 Tage (bzw. seit der ersten Ablesung) */
  tagesdurchschnitt: number | null;
  verbrauchJahr: number | null;      // laufendes Kalenderjahr bis zur letzten Ablesung (anteilig)
  verbrauchVorjahr: number | null;   // ganzes Vorjahr (anteilig interpoliert)
  /** Hochrechnung des laufenden Kalenderjahres */
  prognoseJahr: number | null;
  /** Kosten der Hochrechnung (Arbeitspreis × Prognose + 12 × Grundpreis) */
  kostenPrognoseJahr: number | null;
  /** Veränderung Prognose ggü. Vorjahr in % (null ohne Vorjahr) */
  veraenderungProzent: number | null;
  /** Prognose > Jahresziel */
  zielUeberschritten: boolean;
}

/** Zeile der Übersicht (GET /zaehler) */
export interface ZaehlerZeile extends Zaehler {
  kennzahlen: Kennzahlen;
  /** Monatsverbrauch der letzten 12 vollen Monate für eine Sparkline (ältester zuerst) */
  verlauf12: number[];
}

/** GET /zaehler/:id */
export interface ZaehlerDetail {
  zaehler: Zaehler;
  /** neueste zuerst */
  staende: Zaehlerstand[];
  kennzahlen: Kennzahlen;
}

/** POST /zaehler/:id/staende/pruefen und Antwort-Teil von POST /zaehler/:id/staende */
export interface Pruefung {
  /** verhindert das Speichern (z. B. Stand kleiner als der vorige, Datum in der Zukunft) */
  fehler: string | null;
  /** Speichern erst mit bestaetigt: true (z. B. Verbrauch dreimal so hoch wie üblich) */
  warnung: string | null;
  verbrauch: number | null;
  tagesverbrauch: number | null;
  vorher: { datum: string; stand: number } | null;
}

/** Body von POST /zaehler/:id/staende und PUT /zaehler/staende/:sid */
export interface StandEingabe {
  datum: string;
  stand: number;
  art: StandArt;
  notiz: string | null;
  /** JPEG/PNG als data:-URL (Oberfläche verkleinert vorher auf max. 1600 px); undefined = unverändert, null = Foto entfernen */
  foto?: string | null;
  bestaetigt?: boolean;
}

export type Raster = 'monat' | 'jahr';

/** GET /zaehler/auswertung?ids=1,2&von=YYYY-MM&bis=YYYY-MM&raster=monat|jahr */
export interface Auswertung {
  perioden: string[];
  reihen: {
    zaehlerId: number;
    bezeichnung: string;
    medium: Medium;
    einheit: string;
    /** je Periode (gleiche Reihenfolge wie perioden); null = keine Daten für diese Periode */
    verbrauch: (number | null)[];
    kosten: (number | null)[];
    summe: number;
    kostenSumme: number | null;
  }[];
}

/** GET /zaehler/:id/jahresvergleich – Monatsverbrauch je Kalenderjahr (bis zu 5 Jahre, neuestes zuletzt) */
export interface Jahresvergleich {
  jahre: { jahr: number; monate: (number | null)[]; summe: number }[];
}

/** POST /zaehler/import  Body { csv: string; uebernehmen: boolean } */
export interface ImportErgebnis {
  zeilen: { zeile: number; zaehler: string; datum: string; stand: number; art: StandArt; fehler: string | null; warnung: string | null }[];
  uebernommen: number;
}
