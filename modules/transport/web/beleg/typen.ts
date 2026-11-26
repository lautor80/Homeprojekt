/**
 * Auftrag aus Beleg (Belegerfassung): Typen der Oberfläche – Kopie des Vertrags aus modules/transport/server/beleg/typen.ts
 * (die Oberfläche importiert nichts aus dem Server-Ordner). Doku: docs/euroflex-belegerfassung.md.
 *
 * Grundregel für JEDES Feld: Nur ein eindeutig gelesener Wert wird übernommen. Gibt es mehrere mögliche Werte,
 * ist das Feld „unklar“ und die Maske fragt nach; wurde nichts gefunden, bleibt es leer („fehlt“) und wird von
 * Hand nachgetragen. Es wird nie geraten.
 */
export type FeldStatus = 'eindeutig' | 'unklar' | 'fehlt';

export interface Kandidat<T = string> {
  wert: T;
  /** Anzeigetext in der Auswahl, z. B. „4,5 m“ oder „Muster GmbH, 12345 Musterstadt“ */
  text: string;
  /** Stelle im Beleg (kurzer Textausschnitt), aus der der Wert stammt */
  herkunft: string | null;
}

export interface Feld<T = string> {
  status: FeldStatus;
  /** nur bei status „eindeutig“ gesetzt, sonst null */
  wert: T | null;
  /** bei „unklar“ die möglichen Werte (mindestens zwei, oder ein unsicherer); sonst leer */
  kandidaten: Kandidat<T>[];
  /** bei „eindeutig“: Stelle im Beleg */
  herkunft: string | null;
  /** Erklärung für den Benutzer, z. B. warum nachgefragt wird */
  hinweis: string | null;
}

/** Anschrift, wie sie im Beleg steht (noch kein Kontakt des Portals) */
export interface BelegAnschrift { name: string; strasse: string | null; land: string | null; plz: string | null; ort: string | null }

/** Ein Stop wie in transport.stops; Datum als JJJJ-MM-TT, Zeit als freier Text (leer = keine Zeitvorgabe) */
export interface BelegStop {
  firma: Feld; strasse: Feld; land: Feld; plzort: Feld; ladenummer: Feld; datum: Feld; zeit: Feld;
  firma_e: Feld; strasse_e: Feld; land_e: Feld; plzort_e: Feld; datum_e: Feld; zeit_e: Feld;
}

/** Layouts, die die Erkennung kennt. „allgemein“ liest über Schlagworte und ist der Rückfall. */
export type BelegLayout = 'bestellung' | 'ladeauftrag' | 'allgemein';

/** vorhandener Auftrag mit derselben Auftragsnr. des Kunden */
export interface Dublette { auftragsnr: string; anlagedatum: string | null; kunde: string | null }

/**
 * Antwort der Routen POST /auftraege/beleg/erkennen und POST /eingang/dokumente/:id/beleg: die Erkennung, abgeglichen
 * mit Kontakten und Wertelisten. kunde.wert = adrnr; fahrzeugtyp/ladegut/ladeweise/palettentausch.wert = Schlüssel der Werteliste.
 */
export interface BelegVorschlag {
  layout: BelegLayout;
  /** false = der Text sieht nicht nach einem Frachtauftrag aus (dann sind die Felder leer) */
  istFrachtauftrag: boolean;
  kunde: Feld<number>;
  ordernummer: Feld;
  /** = Ladedatum des ersten Stops (JJJJ-MM-TT) */
  leistungsdatum: Feld;
  frachtpreis_vk: Feld<number>;
  /** in Tonnen */
  gewicht: Feld<number>;
  /** in Metern */
  lademeter: Feld<number>;
  fahrzeugtyp: Feld;
  ladegut: Feld;
  ladeweise: Feld;
  palettentausch: Feld;
  besonderheiten: Feld;
  /** ein oder zwei Stops */
  stops: BelegStop[];
  /** allgemeine Hinweise zum Beleg */
  hinweise: string[];
  /** Auftraggeber, wie er im Beleg steht – zum Nachtragen von Hand bzw. für „Kontakt anlegen“ */
  kundeImBeleg: BelegAnschrift[];
  /** vorhandene Aufträge mit derselben Auftragsnr. des Kunden */
  dubletten: Dublette[];
  /** Bezeichnung des Leseprofils aus den Einstellungen */
  profil: string;
  /** gelesener Text des Belegs (zur Kontrolle) */
  text: string;
}

/** Leseprofil in den Einstellungen (GET /beleg/profile) */
export interface BelegProfil {
  layout: BelegLayout;
  bezeichnung: string;
  aktiv: boolean;
  /** bevorzugter Kunde (adrnr): wird gewählt, wenn er unter mehreren Treffern des Kundenabgleichs ist */
  kunde: number | null;
  kunde_name: string | null;
}
