/**
 * Textbausteine der Zuwendungsbestätigung (Geldzuwendung an eine Körperschaft nach § 5 Abs. 1 Nr. 9 KStG).
 *
 * Die Vorgaben sind dem amtlichen Muster des BMF (Schreiben vom 07.11.2013, Anlagen „Bestätigung über Geldzuwendungen/
 * Mitgliedsbeitrag“ und „Sammelbestätigung“) NACHGEBILDET – aus dem Gedächtnis, ohne Abgleich mit der Quelle. Sie sind
 * deshalb ausdrücklich keine amtliche Fassung: Der Verein gleicht den Wortlaut vor der ersten Ausstellung mit dem
 * amtlichen Muster ab (Einstellungen → Zuwendungsbestätigungen) und ändert ihn dort, wenn er abweicht.
 * Reine Daten ohne weitere Importe.
 */

export interface TextDef {
  schluessel: string;
  /** Abschnitt in den Einstellungen */
  gruppe: 'Kopf' | 'Angaben zur Zuwendung' | 'Steuerbegünstigung' | 'Bestätigungen' | 'Sammelbestätigung' | 'Hinweise';
  name: string;
  standard: string;
  /** Platzhalter, die der Text enthalten muss */
  pflicht?: string[];
  mehrzeilig?: boolean;
}

export const PLATZHALTER: Record<string, string> = {
  Zweck: 'begünstigter Zweck aus den Einstellungen (Vorgabe „Förderung des Sports“)',
  ZweckSatzung: 'Zweck im Satz „Wir fördern nach unserer Satzung …“ (Vorgabe „den Sport“)',
  Finanzamt: 'Finanzamt des Bescheids',
  Steuernummer: 'Steuernummer des Bescheids',
  Bescheiddatum: 'Datum des Bescheids (TT.MM.JJJJ)',
  Veranlagungszeitraum: 'letzter Veranlagungszeitraum laut Freistellungsbescheid',
};

export const TEXTE: TextDef[] = [
  { schluessel: 'aussteller_label', gruppe: 'Kopf', name: 'Bezeichnung über dem Aussteller', standard: 'Aussteller (Bezeichnung und Anschrift der steuerbegünstigten Einrichtung)' },
  { schluessel: 'titel_einzel', gruppe: 'Kopf', name: 'Titel der Einzelbestätigung', standard: 'Bestätigung über Geldzuwendungen/Mitgliedsbeitrag' },
  { schluessel: 'titel_sammel', gruppe: 'Kopf', name: 'Titel der Sammelbestätigung', standard: 'Sammelbestätigung über Geldzuwendungen/Mitgliedsbeiträge' },
  {
    schluessel: 'untertitel', gruppe: 'Kopf', name: 'Zeile unter dem Titel', mehrzeilig: true,
    standard: 'im Sinne des § 10b des Einkommensteuergesetzes an eine der in § 5 Abs. 1 Nr. 9 des Körperschaftsteuergesetzes bezeichneten Körperschaften, Personenvereinigungen oder Vermögensmassen',
  },
  { schluessel: 'zuwendender_label', gruppe: 'Angaben zur Zuwendung', name: 'Bezeichnung über dem Zuwendenden', standard: 'Name und Anschrift des Zuwendenden:' },
  { schluessel: 'betrag_label', gruppe: 'Angaben zur Zuwendung', name: 'Betrag in Ziffern (Einzelbestätigung)', standard: 'Betrag der Zuwendung - in Ziffern -' },
  { schluessel: 'betrag_label_sammel', gruppe: 'Angaben zur Zuwendung', name: 'Betrag in Ziffern (Sammelbestätigung)', standard: 'Gesamtbetrag der Zuwendung - in Ziffern -' },
  { schluessel: 'worte_label', gruppe: 'Angaben zur Zuwendung', name: 'Betrag in Buchstaben', standard: '- in Buchstaben -' },
  { schluessel: 'tag_label', gruppe: 'Angaben zur Zuwendung', name: 'Tag der Zuwendung', standard: 'Tag der Zuwendung:' },
  { schluessel: 'zeitraum_label', gruppe: 'Angaben zur Zuwendung', name: 'Zeitraum (Sammelbestätigung)', standard: 'Zeitraum der Sammelbestätigung:' },
  { schluessel: 'verzicht', gruppe: 'Angaben zur Zuwendung', name: 'Verzicht auf Erstattung von Aufwendungen (Ja/Nein)', standard: 'Es handelt sich um den Verzicht auf Erstattung von Aufwendungen' },
  {
    schluessel: 'freistellung', gruppe: 'Steuerbegünstigung', name: 'Freistellungsbescheid bzw. Anlage zum Körperschaftsteuerbescheid', mehrzeilig: true,
    pflicht: ['Zweck', 'Finanzamt', 'Steuernummer', 'Bescheiddatum', 'Veranlagungszeitraum'],
    standard: 'Wir sind wegen {Zweck} nach dem Freistellungsbescheid bzw. nach der Anlage zum Körperschaftsteuerbescheid des Finanzamtes {Finanzamt}, StNr. {Steuernummer}, '
      + 'vom {Bescheiddatum} für den letzten Veranlagungszeitraum {Veranlagungszeitraum} nach § 5 Abs. 1 Nr. 9 des Körperschaftsteuergesetzes von der Körperschaftsteuer '
      + 'und nach § 3 Nr. 6 des Gewerbesteuergesetzes von der Gewerbesteuer befreit.',
  },
  {
    schluessel: 'feststellung', gruppe: 'Steuerbegünstigung', name: 'Feststellung nach § 60a AO', mehrzeilig: true,
    pflicht: ['Finanzamt', 'Steuernummer', 'Bescheiddatum', 'ZweckSatzung'],
    standard: 'Die Einhaltung der satzungsmäßigen Voraussetzungen nach den §§ 51, 59, 60 und 61 AO wurde vom Finanzamt {Finanzamt}, StNr. {Steuernummer}, '
      + 'mit Bescheid vom {Bescheiddatum} nach § 60a AO gesondert festgestellt. Wir fördern nach unserer Satzung {ZweckSatzung}.',
  },
  {
    schluessel: 'verwendung', gruppe: 'Bestätigungen', name: 'Bestätigung der Verwendung', mehrzeilig: true, pflicht: ['Zweck'],
    standard: 'Es wird bestätigt, dass die Zuwendung nur zur {Zweck} verwendet wird.',
  },
  {
    schluessel: 'nur_fuer', gruppe: 'Bestätigungen', name: 'Überschrift zum Vermerk „kein Mitgliedsbeitrag“', mehrzeilig: true,
    standard: 'Nur für steuerbegünstigte Einrichtungen, bei denen die Mitgliedsbeiträge steuerlich nicht abziehbar sind:',
  },
  {
    schluessel: 'kein_beitrag', gruppe: 'Bestätigungen', name: 'Vermerk „kein Mitgliedsbeitrag“ (Sportverein, § 10b Abs. 1 Satz 8 Nr. 1 EStG)', mehrzeilig: true,
    standard: 'Es wird bestätigt, dass es sich nicht um einen Mitgliedsbeitrag handelt, dessen Abzug nach § 10b Abs. 1 des Einkommensteuergesetzes ausgeschlossen ist.',
  },
  { schluessel: 'unterschrift_label', gruppe: 'Bestätigungen', name: 'Zeile unter der Unterschrift', standard: '(Ort, Datum und Unterschrift des Zuwendungsempfängers)' },
  {
    schluessel: 'sammel_keine_weiteren', gruppe: 'Sammelbestätigung', name: 'Keine weiteren Bestätigungen', mehrzeilig: true,
    standard: 'Es wird bestätigt, dass über die in der Gesamtsumme enthaltenen Zuwendungen keine weiteren Bestätigungen, weder formelle Zuwendungsbestätigungen '
      + 'noch Beitragsquittungen oder Ähnliches ausgestellt wurden und werden.',
  },
  {
    schluessel: 'sammel_verzicht', gruppe: 'Sammelbestätigung', name: 'Verweis auf die Anlage (Verzicht)', mehrzeilig: true,
    standard: 'Ob es sich um den Verzicht auf Erstattung von Aufwendungen handelt, ist der Anlage zur Sammelbestätigung zu entnehmen.',
  },
  { schluessel: 'anlage_titel', gruppe: 'Sammelbestätigung', name: 'Titel der Anlage', standard: 'Anlage zur Sammelbestätigung' },
  { schluessel: 'anlage_datum', gruppe: 'Sammelbestätigung', name: 'Anlage: Spalte Datum', standard: 'Datum der Zuwendung' },
  { schluessel: 'anlage_art', gruppe: 'Sammelbestätigung', name: 'Anlage: Spalte Art', standard: 'Art der Zuwendung (Geldspende/Mitgliedsbeitrag)' },
  { schluessel: 'anlage_verzicht', gruppe: 'Sammelbestätigung', name: 'Anlage: Spalte Verzicht', standard: 'Verzicht auf die Erstattung von Aufwendungen (ja/nein)' },
  { schluessel: 'anlage_betrag', gruppe: 'Sammelbestätigung', name: 'Anlage: Spalte Betrag', standard: 'Betrag' },
  { schluessel: 'anlage_summe', gruppe: 'Sammelbestätigung', name: 'Anlage: Summenzeile', standard: 'Gesamtsumme' },
  { schluessel: 'hinweis_titel', gruppe: 'Hinweise', name: 'Überschrift der Hinweise', standard: 'Hinweis:' },
  {
    schluessel: 'hinweis_haftung', gruppe: 'Hinweise', name: 'Haftungshinweis', mehrzeilig: true,
    standard: 'Wer vorsätzlich oder grob fahrlässig eine unrichtige Zuwendungsbestätigung erstellt oder veranlasst, dass Zuwendungen nicht zu den in der '
      + 'Zuwendungsbestätigung angegebenen steuerbegünstigten Zwecken verwendet werden, haftet für die entgangene Steuer (§ 10b Abs. 4 EStG, § 9 Abs. 3 KStG, § 9 Nr. 5 GewStG).',
  },
  {
    schluessel: 'hinweis_gueltigkeit', gruppe: 'Hinweise', name: 'Hinweis zur Gültigkeit (5 bzw. 3 Jahre)', mehrzeilig: true,
    standard: 'Diese Bestätigung wird nicht als Nachweis für die steuerliche Berücksichtigung der Zuwendung anerkannt, wenn das Datum des Freistellungsbescheides länger als 5 Jahre '
      + 'bzw. das Datum der Feststellung der Einhaltung der satzungsmäßigen Voraussetzungen nach § 60a Abs. 1 AO länger als 3 Jahre seit Ausstellung des Bescheides zurückliegt (§ 63 Abs. 5 AO).',
  },
];

export type Texte = Record<string, string>;

/** Texte des Vereins über die Vorgaben legen (leere Angabe = Vorgabe) */
export function texteMischen(eigen: Record<string, unknown> | null | undefined): Texte {
  const out: Texte = {};
  for (const t of TEXTE) {
    const e = eigen?.[t.schluessel];
    out[t.schluessel] = typeof e === 'string' && e.trim() ? e.trim() : t.standard;
  }
  return out;
}

/** Eingabe der Einstellungen prüfen: nur bekannte Schlüssel, Pflicht-Platzhalter vorhanden; gespeichert wird nur, was von der Vorgabe abweicht */
export function textePruefen(eingabe: Record<string, string>): { texte: Texte; fehler: string[] } {
  const fehler: string[] = [];
  const texte: Texte = {};
  for (const t of TEXTE) {
    const e = (eingabe[t.schluessel] ?? '').replace(/\r\n/g, '\n').trim();
    if (!e || e === t.standard) continue;
    for (const p of t.pflicht ?? []) if (!e.includes(`{${p}}`)) fehler.push(`„${t.name}“: Platzhalter {${p}} fehlt.`);
    const fremd = [...e.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]).filter((p) => !(p in PLATZHALTER));
    if (fremd.length) fehler.push(`„${t.name}“: unbekannter Platzhalter {${fremd[0]}}.`);
    texte[t.schluessel] = e;
  }
  return { texte, fehler };
}

export const fuellen = (text: string, werte: Record<string, string>) => text.replace(/\{([A-Za-z]+)\}/g, (m, k: string) => (k in werte ? werte[k] : m));
