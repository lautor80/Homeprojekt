/**
 * Auftrag aus Beleg (Belegerfassung): gemeinsame Typen von Erkennung, Abgleich, Routen und Oberfläche.
 * Doku: docs/euroflex-belegerfassung.md. Reine Typen ohne Importe.
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

/** Ergebnis der reinen Texterkennung (ohne Datenbank) */
export interface BelegErkennung {
  layout: BelegLayout;
  /** false = der Text sieht nicht nach einem Frachtauftrag aus (dann sind die Felder leer) */
  istFrachtauftrag: boolean;
  /** Auftraggeber laut Beleg; mehrere verschiedene Firmen im Beleg = „unklar“ */
  kunde: Feld<BelegAnschrift>;
  ordernummer: Feld;
  /** = Ladedatum des ersten Stops (JJJJ-MM-TT) */
  leistungsdatum: Feld;
  frachtpreis_vk: Feld<number>;
  /** in Tonnen */
  gewicht: Feld<number>;
  /** in Metern */
  lademeter: Feld<number>;
  /** Text aus dem Beleg, z. B. „LKW mit Plane 13,6“ – der Abgleich mit der Werteliste folgt serverseitig */
  fahrzeugtyp: Feld;
  ladegut: Feld;
  ladeweise: Feld;
  palettentausch: Feld;
  besonderheiten: Feld;
  /** ein oder zwei Stops */
  stops: BelegStop[];
  /** allgemeine Hinweise zum Beleg */
  hinweise: string[];
}

/** Kontakt des Portals als Wert des Feldes „Kunde“ */
export interface Dublette { auftragsnr: string; anlagedatum: string | null; kunde: string | null }

/**
 * Antwort der Routen POST /auftraege/beleg/erkennen und POST /eingang/dokumente/:id/beleg: die Erkennung, abgeglichen
 * mit Kontakten und Wertelisten. kunde.wert = adrnr; fahrzeugtyp/ladegut/ladeweise/palettentausch.wert = Schlüssel der Werteliste.
 */
export interface BelegVorschlag extends Omit<BelegErkennung, 'kunde'> {
  kunde: Feld<number>;
  /** Auftraggeber, wie er im Beleg steht – zum Nachtragen von Hand bzw. für „Kontakt anlegen“ */
  kundeImBeleg: BelegAnschrift[];
  /** vorhandene Aufträge mit derselben Auftragsnr. des Kunden */
  dubletten: Dublette[];
  /** Bezeichnung des Leseprofils aus den Einstellungen */
  profil: string;
  /** gelesener Text des Belegs (zur Kontrolle) */
  text: string;
}

/** Leseprofil in den Einstellungen (Tabelle transport.beleg_profile) */
export interface BelegProfil {
  layout: BelegLayout;
  bezeichnung: string;
  aktiv: boolean;
  /** bevorzugter Kunde (adrnr): wird gewählt, wenn er unter mehreren Treffern des Kundenabgleichs ist */
  kunde: number | null;
  kunde_name: string | null;
}
