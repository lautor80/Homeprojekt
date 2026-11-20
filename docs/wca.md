# WCA Zeitenkontrolle – fachliche Beschreibung

Modul `wca`: Tempo-Zeitexporte (Teamreport als CSV) ins Portal laden und die Zeitbuchungen eines Teams prüfen –
**Vollständigkeit** je Person und Tag, **Billable-Anteil**, **Kontierung**, **Plausibilität**, **Textqualität** der
Rückmeldungen und das **Regelwerk** für Buchungstexte. Vorbild ist eine bisher lokal im Browser laufende HTML-Prüfung;
das Portal speichert Buchungen, Einstellungen und Personenvorgaben in der Datenbank (Schema `wca`).

Quelltext: Prüflogik ohne Datenbank in `modules/wca/server/logik/` (CSV-Leser, Ableitungen, Feiertage, Textanalyse,
Regeln), Datenvertrag `modules/wca/server/typen.ts`, Routen und Speicherung `modules/wca/server/index.ts`,
Oberfläche `modules/wca/web/`. Tests: `server/test/wca_logik.test.ts` (ohne DB) und `server/test/wca.test.ts` (DB);
Testdaten `server/test/fixtures/wca/teamreport_nov26.csv` (echter Export, Personen und Kunden anonymisiert).

## Begriffe

| Begriff | Bedeutung |
|---|---|
| Rückmeldung / Eintrag | Eine Blattzeile des Exports: Person, Kategorietyp, Account, Team, Bereich, Schlüssel, Text und ein oder mehrere Tage mit Stunden. |
| Personentag | Summe aller Einträge einer Person an einem Datum, aufgeteilt nach Typ. |
| Typ | **A** Abwesenheit, **B** Billable (abrechenbar), **P** PreSales, **I** Intern. |
| Stichtag | Letzter bewerteter Tag. Vorschlag: letzter Arbeitstag vor heute, begrenzt auf den Datenbestand. |
| Zeitraum | Monat (`JJJJ-MM`), ISO-Woche (`JJJJ-Www`) oder `alle` (erster Tag bis Stichtag). Ausgewertet wird immer nur bis zum Stichtag. |
| Fund | Treffer einer Prüfregel an einer Rückmeldung oder einem Personentag, mit Stufe 1 Niedrig, 2 Mittel, 3 Hoch. |

## Importformat

Tempo-Ansicht „Teamreport“ als CSV-Export (Komma oder Semikolon, UTF-8 mit oder ohne BOM, Felder in Anführungszeichen
dürfen Trennzeichen und Zeilenumbrüche enthalten). Mehrere Dateien auf einmal sind möglich; die Oberfläche schickt sie
als Text oder Data-URL.

- **Spalten** (Kopfzeile, Groß-/Kleinschreibung egal, deutsche und englische Bezeichnungen): *Benutzer* (Pflicht),
  *Kategorietyp*, *Projektname*, *Account*, *Team*, *Bereich* (Jira-Projekt), *Zeitnachweis* (Text), *Schlüssel*,
  *Erfasst* (wird ignoriert). Fehlen *Account* oder *Team*, warnt der Import (Kontierungsprüfungen eingeschränkt bzw.
  Personen „Ohne Team“).
- **Tagesspalten**: jede Kopfspalte, die ein Datum ist – `01/Nov./26`, `1-Nov-2026`, `01.11.26`, `01.11.2026`, `2026-11-01`
  (Monatsnamen deutsch oder englisch, zweistellige Jahre = 20xx). Ohne Benutzer- oder Tagesspalte ist die Datei nicht lesbar.
- **Stundenwerte**: `8h`, `0.5h`, `1,5`, `1h 30m`, `90m`; leer = 0.
- **Hierarchie**: Der Teamreport enthält Summenzeilen je Benutzer, Kategorietyp, Projekt, Account, Team und Bereich.
  Eine Zeile ist eine **Rückmeldung**, wenn sie einen Text hat oder einen Vorgangsschlüssel (`ABC-123`) bei vollständig
  gefüllter Hierarchie. Die Benutzer-Summenzeile dient als **Kontrollsumme** (Abweichung über 0,02 h → Warnung).
  Zwischenzeilen mit Schlüssel liefern die **Schlüssel**: Bereich → Jira-Projektschlüssel, Account → Tempo-Account-Schlüssel;
  das Portal merkt sie sich dauerhaft (`wca.schluessel`). Die Zeile „Gesamt“ (ohne Benutzer) entfällt.

### Prüflauf und Übernahme

Der Import läuft in zwei Schritten (`POST /api/m/wca/import`):

1. **Prüflauf** (`uebernehmen: false`) – schreibt nichts. Zeigt je Datei Personen, Rückmeldungen, Stunden, ersten und
   letzten Tag, Warnungen und wie viele Buchungstage (Person × Datum) eine frühere Datei ersetzen würde. Nicht lesbare
   Dateien erscheinen mit Fehlermeldung, die übrigen laufen weiter.
2. **Übernahme** (`uebernehmen: true`) – in einer Transaktion mit Änderungsbeleg (Aktion `WCA_IMPORT`); je Datei
   ein Import-Datensatz.

### Ersetzungslogik

Je **Person und Datum** gilt nur die zuletzt übernommene Datei („neue Datei gewinnt“):

- Für jede Person der Datei (auch Personen ohne Rückmeldungen) und jedes Datum ihrer Tagesspalten werden die bisher
  gespeicherten Stunden dieser Person an diesem Datum gelöscht und durch den Inhalt der neuen Datei ersetzt. Ein Tag,
  den die neue Datei leer zeigt, ist danach leer.
- Rückmeldungen, denen dadurch kein Tag mehr bleibt, entfallen. Der ältere Import selbst bleibt in der Liste stehen
  (mit 0 Rückmeldungen), bis er gelöscht wird.
- Werden mehrere Dateien zugleich übernommen und haben alle ein Änderungsdatum, wird die ältere zuerst eingespielt;
  sonst gilt die Reihenfolge der Auswahl.
- Derselbe Export zweimal importiert verdoppelt also nichts. Ein Import lässt sich mit Begründung löschen; seine noch
  geltenden Rückmeldungen verschwinden dann mit (ältere Dateien leben nicht wieder auf – ggf. erneut importieren).

## Ableitungen je Rückmeldung

- **Account** wird am ersten `|` geteilt: Name des Accounts und Kunde (`Servicemanagement|Helioform Services GmbH` →
  Account „Servicemanagement“, Kunde „Helioform Services GmbH“). Ohne Account oder „Kein Account“ → *ohne Account*.
- **Jira-Projektschlüssel** aus dem Vorgangsschlüssel (`WDEINT001-37` → `WDEINT001`).
- **Typ** (in dieser Reihenfolge): Abwesenheit (Account beginnt mit „ATG Absence“, Projekt `ATGABS` oder Text beginnt mit
  „Absence:“) → **A**; Kategorietyp „Abrechenbar“/„Billable“ → **B**; Projekt mit „PRESAL“ oder Account mit „Presales“ →
  **P**; sonst **I**.
- **Error-Account**: Account steht in der Liste der Error-Accounts (Einstellungen) oder heißt „Error Account“,
  „please review“, „Clean up Account“.
- **Intern**: kein Kunde oder Kunde enthält „internal“/„intern“.
- **Team** gekürzt: Präfix `WCA | ` und Kennung `(#…)` am Ende entfallen (`WCA | Cloud Purchasing (#v2-T-6122480)` → „Cloud Purchasing“).

## Ableitungen je Person

Es gibt keine Stammdaten; alles wird aus den Buchungen abgeleitet und lässt sich je Person überschreiben
(**Personenvorgaben**: Standort, Soll je Tag, Arbeitstage, im Team von/bis, ausblenden).

- **Standort**: aus den Projekt- bzw. Account-Schlüsseln (`WDE…` → DE, `WAT…` → AT, `WLV…` → LV …) oder dem Kunden,
  nach Stunden gewichtet; sonst DE.
- **Im Team von/bis**: erste Buchung; „bis“ = letzte Buchung, wenn danach mehr als 15 Arbeitstage bis zum Stichtag
  nichts mehr kam, sonst offen.
- **Arbeitstage**: aus den letzten bis zu 10 Wochen mit Arbeitszeit; ab 4 Wochen zählt ein Wochentag, wenn in mindestens
  45 % (Mo–Fr) bzw. 60 % (Sa/So) der Wochen gebucht wurde; sonst Mo–Fr.
- **Soll je Tag**: Median der Tagessummen ohne Abwesenheit an Arbeitstagen (ab 5 Werten), auf 0,5 h gerundet,
  zwischen 2 und 8 h; sonst 8 h.
- **Feiertage**: je Standort berechnet (DE mit Bundesland aus den Einstellungen, AT, ES, LV, LT), zusätzlich manuell
  (Einstellungen) und erkannt („vermutlich Feiertag“: Werktag, an dem von mindestens 3 aktiven Personen eines Standorts
  höchstens 20 % gebucht haben).
- **Account-Pflicht ab** (für K2): aus den Einstellungen oder automatisch – der früheste Monat, ab dem durchgehend
  weniger als 10 % der Stunden ohne Account gebucht sind.

## Kennzahlen

Je Person und Zeitraum (bis Stichtag):

| Kennzahl | Berechnung |
|---|---|
| Soll | Summe Soll je Tag über alle Arbeitstage (ohne Feiertage, nur im Team von/bis). |
| Ist | alle gebuchten Stunden, Abwesenheit eingeschlossen. |
| Offen / Fehltage | je Arbeitstag `Soll − Ist`, wenn größer als die Toleranz (Standard 0,25 h); Mehrstunden gleichen nichts aus. |
| Vollständig | Offen ≤ Toleranz. |
| B / P / I / A | Stunden je Typ. |
| Billable-Quote | `B / (B + P + I)` – Anteil an der Arbeitszeit ohne Abwesenheit. |
| Kontierung / Texte / Regelwerk | je `[Anzahl Fundgruppen, davon Niedrig, Mittel, Hoch]`; Kontierung umfasst K und P. |
| Texte unauffällig | Anteil der Rückmeldungen (ohne Abwesenheit) ohne T-Fund. |

**Tagesstatus**: vollständig, teilweise, fehlt, abwesend (Abwesenheit deckt das Soll), Feiertag, frei, frei gebucht,
außerhalb (vor/nach Team-Zugehörigkeit), Zukunft (nach dem Stichtag).

**Fundgruppen**: Alle Funde einer Rückmeldung bzw. eines Personentags bilden eine Zeile; deren Stufe ist das Maximum.
Stunden eines Funds sind die Stunden der Rückmeldung im Zeitraum (K2, R1, R2 erst ab dem jeweiligen Stichdatum).

**Rückfrage**: je Person ein fertiger Text zum Kopieren mit fehlenden Tagen (höchstens 25), Kontierungs- und
Textfunden ab Stufe Mittel (je höchstens 20) mit Meldung und Tipp – oder „Alles in Ordnung – danke!“.

## Prüfregeln

Stufen: 1 Niedrig, 2 Mittel, 3 Hoch. „B“ = abrechenbare Rückmeldung (Typ B). Die T-Regeln gelten nicht für Abwesenheiten.
Jede Regel lässt sich in den Einstellungen abschalten; die Wortlisten der F-Regeln sind änderbar.
Katalog im Quelltext: `REGELN` in `modules/wca/server/logik/standard.ts`.

| ID | Name | Erkennung | Stufe | Tipp |
|---|---|---|---|---|
| K1 | Error-Account gebucht | Der Account steht in der Liste der Error-Accounts oder heißt „Error Account“, „please review“ oder „Clean up Account“. | 3 | Auf den richtigen Account umbuchen; bei Unklarheit Projektleitung fragen. |
| K2 | Kein Account | Die Buchung hat keinen Account (ab dem Datum der Account-Pflicht, Abwesenheiten ausgenommen). | 2 | Ticket einem Account zuordnen lassen oder auf das passende interne Konto umbuchen. |
| K3 | Ticket auf mehreren Accounts | Dasselbe Ticket läuft sonst überwiegend auf einem anderen Account mit anderem Kunden oder anderer Abrechenbarkeit. | 3 anderer Kunde, sonst 2 | Prüfen, ob der seltenere Account stimmt; sonst umbuchen. |
| K4 | Ticket bei untypischem Kunden | Tickets dieses Jira-Projekts laufen zu mindestens 85 % (ab 16 h) auf einen Kunden, diese Buchung auf einen anderen oder ein internes Konto. | 3 anderer Kunde, 1 internes Konto | Kunde und Account prüfen; interne Kontierung eines Kundentickets ist möglicherweise verlorener Umsatz. |
| K5 | Text nennt anderen Kunden | Der Text nennt einen Kunden aus dem Datenbestand (mit Aliassen), die Buchung liegt aber auf einem anderen Kunden oder internen Konto. | 2 internes Konto, sonst 3 | Account prüfen; bei Kundenarbeit auf internem Konto möglicherweise abrechenbar. |
| K6 | Abwesenheit / Privates auf Arbeitskonto | Der Text nennt Urlaub, Krankheit, Arzt, Pause o. Ä., gebucht ist aber auf ein Arbeitskonto („nach dem Urlaub“ u. Ä. ausgenommen). | 3 bei B, sonst 2 | Abwesenheit als Abwesenheit erfassen; Pausen nicht buchen. |
| K7 | Reisezeit auf Kundenkonto | Ein abrechenbarer Eintrag nennt Reise, Anfahrt oder Flug, der Account ist kein Reisezeit-Konto. | 1 | Reisezeit-Regel des Vertrags prüfen und ggf. auf das Reisezeit-Konto buchen. |
| K8 | Kundenarbeit auf internem Projekt | Eine Buchung auf einem internen Projekt (Schlüsselmuster, Standard `W??INT*`) nennt ein Kundenticket oder einen Kundennamen. | 3 Kundenticket, 2 Kundenname | Prüfen, ob die Zeit auf das Kundenprojekt gehört (abrechenbar oder dessen Non-billable-Account). Echte interne Themen (Angebot, Staffing, Eskalation) so benennen. |
| P1 | Tag mit sehr vielen Stunden | Die Tagessumme liegt über der Grenze für lange Tage (Standard 10 h). | 1; 2 ab Grenze + 2 h | Prüfen, ob Stunden doppelt oder am falschen Tag gebucht sind. |
| P2 | Lange Einzelbuchung | Eine einzelne Buchung an einem Tag liegt über der Grenze (Standard 8 h). | 1 | Lange Blöcke aufteilen und je Tätigkeit beschreiben. |
| P3 | Buchung an freiem Tag | Arbeitszeit an einem Feiertag, Wochenende oder sonst freien Tag der Person. | 1 | Nur zur Info: Datum prüfen, Mehrarbeit ggf. freigeben. |
| T1 | Leer oder Platzhalter | Kein Text oder nur ein Platzhalter wie „x“, „tbd“, „siehe oben“, „dito“. | 2, B 3 | Jede Buchung braucht eine eigene Beschreibung. |
| T2 | Nur Kürzel oder Ticketnummer | Der Text besteht nur aus IDs, Ticketnummern oder Kürzeln. | 2, B 3 | Hinter die ID schreiben, was getan wurde. |
| T3 | Nur Allgemeinbegriffe | Der Text enthält nur Allgemeinbegriffe wie Meeting, Abstimmung, Support, Analyse, ohne konkreten Gegenstand. | 1, +1 bei B, +1 ab 4 h an einem Tag | Gegenstand und Ergebnis ergänzen. |
| T3b | ID, aber Tätigkeit allgemein | Neben einer ID oder einem Kürzel stehen nur Allgemeinbegriffe. | 1 | Nach der ID die konkrete Tätigkeit nennen. |
| T9 | Nur Personenname | Der Text nennt nur Vornamen von Kolleginnen und Kollegen, aber kein Thema. | 1, B 2 | Thema der Absprache nennen. |
| T4 | Kalender- oder Mailtext kopiert | Der Text enthält typische Teile von Einladungen oder Mails (Hallo zusammen, Von:, Teams-Besprechung …). | 2, B 3 | Nur den Termin-Titel plus Ergebnis; Einladungstexte gehören nicht auf die Rechnung. |
| T5 | Kurzer Text für lange Buchung | Sehr wenige Wörter für viele Stunden an einem Tag (Standard: höchstens 3 Wörter ab 4 h, höchstens 2 Wörter ab 2 h). | 2, B 3 (ab 4 h); 1 (ab 2 h) | Bei langen Blöcken die Teilschritte nennen, ab 4 h mindestens zwei konkrete Punkte. |
| T6 | Gleicher Text an vielen Tagen | Derselbe Text steht an vielen Tagen mit vielen Stunden (Standard ab 5 Tagen und 8 h), Regeltermine ausgenommen. | 1, B 2 | Pro Tag beschreiben, was neu war. |
| T8 | Text wiederholt nur den Account | Der Text entspricht im Wesentlichen dem Namen des Accounts. | 1 | Der Account sagt schon, wofür; der Text soll sagen, was genau. |
| F_pauschal | Sammelbegriff ohne Inhalt | Wortliste („diverses“, „sonstiges“, „misc“ …). | 2, B 3 | Die einzelnen Themen konkret aufzählen statt eines Sammelbegriffs. |
| F_versuch | Versuch ohne Ergebnis | Wortliste („versucht“, „probiert“, „trial and error“ …). | 1, B 2 | Vorgehen und Ergebnis beschreiben: was wurde geprüft, was kam heraus. |
| F_nacharbeit | Nacharbeit / eigener Fehler | Wortliste („nochmal“, „vergessen“, „rework“ …), nur abrechenbare Einträge. | B 2 | Nacharbeit wegen eigener Fehler nicht dem Kunden berechnen; sonst den Anlass sachlich beschreiben. |
| F_warten | Warten / Bereitschaft | Wortliste („warten“, „standby“, „idle“ …). | 1, B 3 | Wartezeit nur buchen, wenn vertraglich vereinbart; sonst die erledigte Arbeit beschreiben. |
| F_lernen | Lernen / Einarbeitung auf Kundenkonto | Wortliste („Einarbeitung“, „self study“, „tutorial“ …), nur abrechenbare Einträge. | B 2 | Einarbeitung und Weiterbildung auf das interne Trainingskonto buchen, außer sie ist mit dem Kunden vereinbart. |
| F_intern | Interne Tätigkeit auf Kundenkonto | Wortliste („Zeiterfassung“, „interne Abstimmung“, „Townhall“ …), nur abrechenbare Einträge. | B 1 | Interne Tätigkeiten auf das passende interne Konto buchen. |
| F_ton | Umgangssprache / Wertung | Wortliste („nervig“, „sinnlos“, „wie immer“, „???“ …). | 1, B 2 | Sachlich formulieren – der Text kann beim Kunden auf der Rechnung stehen. |
| R1 | Regelwerk: zu wenige Wörter | Nach der führenden ID stehen weniger Wörter als verlangt (Standard 5); Regeltermine ausgenommen; ab „Regelwerk gilt ab“. | 1, B 2 | Kurz, klar, spezifisch: mindestens fünf Wörter. |
| R2 | Regelwerk: ID am Anfang fehlt | Ein abrechenbarer Text beginnt nicht mit „<ID>: “; Regeltermine ausgenommen; ab „Regelwerk gilt ab“. | 2 | Format „<ID>: Beschreibung mit mehr als fünf Wörtern“. |

Reihenfolge der Textregeln: T1, T2, T3b/T3 und T9 schließen einander aus (die erste treffende gilt); T5 und T8 prüfen
nur Texte, die keine dieser Regeln (außer T3b) getroffen hat. Wortlisten: kommagetrennt, `*` am Ende = Wortanfang,
Präfix `re:` = regulärer Ausdruck, sonst ganzes Wort (Groß-/Kleinschreibung egal).

## Einstellungen

Global für alle Personen (Tabelle `wca.einstellungen`, Änderungsbeleg `WCA_EINST`); fehlende Werte ergänzt der
Server mit dem Standard.

| Einstellung | Standard | Wirkung |
|---|---|---|
| Toleranz je Tag | 0,25 h | Offen/Fehltag erst darüber. |
| Bundesland | BW | Landesfeiertage für Standort DE. |
| Error-Accounts | drei Standardnamen | K1 (zeilenweise). |
| Account-Pflicht ab | automatisch | K2. |
| Regelwerk an / gilt ab / min. Wörter / ID-Pflicht abrechenbar | an / 2026-11-01 / 5 / ja | R1, R2. |
| Gleicher Text: Tage / Stunden | 5 / 8 h | T6. |
| Tag mit vielen Stunden | 10 h | P1. |
| Lange Einzelbuchung | 8 h | P2. |
| Kurzer Text: Stunden / Wörter | 4 h / 3 | T5. |
| Kunden-Aliasse | einige Kürzel | K5, K8 (zeilenweise „Kürzel = Kundenname“). |
| Weitere Allgemeinbegriffe | – | T3 (kommagetrennt). |
| Regeltermine | Daily, Jour fixe, Standup … | von T6, R1, R2 ausgenommen. |
| Zusätzliche Feiertage | – | zeilenweise „Standort JJJJ-MM-TT Name“, `*` = alle Standorte. |
| Schlüsselmuster interne Projekte | `W??INT*` | K8 (`?` = Buchstabe/Ziffer, `*` = beliebig). |
| Regeln abgeschaltet | keine | je Regel-ID. |
| Wortlisten der F-Regeln | siehe Tabelle | Name, Art, nur abrechenbar, Stufe intern/abrechenbar, Wörter, Tipp. |

**Personenvorgaben** (Tabelle `wca.person`, Änderungsbeleg `WCA_PERSON`): Standort, Soll je Tag, Arbeitstage
(0 = Mo … 6 = So), im Team von/bis, ausblenden. Leere Felder = abgeleiteter Wert.
