# PowerPoint-Export – Vorlage und Vorschläge (#146)

Ziel: eine Präsentation im TCO-Branding, in die ausgewählte Statistiken und Inhalte aus dem Portal **dynamisch**
übernommen werden, z. B. für Vorstandssitzungen oder die Mitgliederversammlung.

## Die Vorlage

`TCO_Praesentationsvorlage.pptx` (16:9, Schrift Arial, Farben wie die PDF-Belege des Vereins: Orange `E2701F`,
Dunkelorange `B9561A`, Anthrazit `1F1F1F`, Grau `6B6B6B`, Hintergrund `F6F4F2`; Logo aus `modules/tco/server/assets`).
Die Farben stecken im Design der Datei; in PowerPoint lässt sich alles über *Entwurf → Varianten* zentral ändern.

| Folie | Layout | Inhalt (dynamisch) |
|---|---|---|
| 1 | TCO Titel (orange, Logo weiß) | `{{praesentation.titel}}`, `{{praesentation.untertitel}}`, `{{stand.datum}}` |
| 2 | TCO Inhalt | **Der Verein auf einen Blick** – vier Kennzahl-Kacheln (`{{MTG_GESAMT}}`, `{{FIN_SALDO}}`, `{{HAL_BELEGUNG}}`, `{{JUG_MITGL}}`, je mit `.text` als Untertitel) und `{{kommentar.ueberblick}}` |
| 3 | TCO Inhalt | **Mitgliederentwicklung** – natives Liniendiagramm (Monatswerte), Eintritte/Austritte, Kommentar |
| 4 | TCO Kapitel (dunkel) | Kapiteltrenner „Finanzen {{jahr}}“ |
| 5 | TCO Inhalt | **Einnahmen und Ausgaben je Monat** – natives Säulendiagramm, Liquidität inkl. offener Rechnungen (#28) |
| 6 | TCO Inhalt | **Halle** – Tabelle „Offene Hallenstunden“ (je Datensatz eine Zeile, Syntax `{{HAL_ABR[].bereich}}`) und Kommentar |
| 7 | TCO Titel | Abschluss „Vielen Dank“ |

Fußzeile mit Vereinsname, Präsentationstitel, Stand und Seitenzahl sowie das Logo liegen in den Layouts, nicht auf den Folien.
Die Diagramme sind **native PowerPoint-Diagramme** mit Beispieldaten – sie bleiben in PowerPoint bearbeitbar.

**Platzhalter:** Text in `{{ }}` ersetzt das Portal beim Export. Kennzahlen heißen wie in der Vereinsübersicht
(`MTG_GESAMT`, `MTG_EINTRITT`, `MTG_AUSTRITT`, `FIN_SALDO`, `FIN_GEWINN`, `CLUB_UMSATZ`, `JUG_MITGL`, `JUG_TRAINING`,
`HAL_BELEGUNG`, `HAL_ABR` …): `{{SCHLUESSEL}}` = Wert, `{{SCHLUESSEL.text}}` = Untertitel. Dazu `{{jahr}}`, `{{liq.*}}`
(Liquidität), `{{verein.*}}` und freie Kommentare `{{kommentar.*}}`, die man vor dem Export im Portal eintippt.
Platzhalter ohne Wert bleiben stehen – so fällt auf, was fehlt.

Neu erzeugen (nach Farb-/Layoutänderungen): `node docs/praesentation/vorlage-erzeugen.cjs` mit `pptxgenjs` und dem
Hilfsskript `apply_theme.js` (Pfad über `APPLY_THEME`).

## Vorschläge für den Export im Portal

**A – Folien zum Ankreuzen (empfohlen für den Start).** Neuer Knopf *Präsentation* in der Vereinsübersicht: Dialog mit
Geschäftsjahr, Titel und je Folie einem Häkchen (Überblick, Mitglieder, Finanzen, Clubhaus, Jugend, Halle, Portal-Benutzer)
sowie optionalem Kommentar je Folie. Der Server füllt die Vorlage (Platzhalter ersetzen, Diagrammdaten austauschen) und
liefert die .pptx zum Download, auf Wunsch zusätzlich als Ablage in Paperless. Aufwand: mittel.

**B – Eigene Vorlagen hochladen.** Wie A, aber der Verein pflegt mehrere Vorlagen (z. B. Mitgliederversammlung,
Vorstandssitzung, Sponsoren) unter *Stammdaten*. Das Portal erkennt die Platzhalter einer hochgeladenen Datei und zeigt,
welche es füllen kann. Aufwand: höher; volle gestalterische Freiheit in PowerPoint.

**C – „In die Präsentation“ an jeder Kachel/jedem Diagramm.** Sammelkorb: An Kennzahlen und Diagrammen der
Vereinsübersicht (und später an Berichten wie Einnahmen & Ausgaben) gibt es „zur Präsentation hinzufügen“; der Korb wird
in der gewählten Reihenfolge zu Folien im Layout *TCO Inhalt*. Aufwand: mittel; sehr flexibel, weniger fest gestaltet.

**Weitere Ideen:** Vergleich mit dem Vorjahr als zweite Datenreihe, Jahresabschluss (EAR) als Tabellenfolie, Fotos vom
Vereinsleben aus Paperless/Nextcloud als Bildfolie, automatischer Versand der fertigen Präsentation an den Vorstand.

**Offene Fragen:** Welcher Vorschlag (A, B, C)? Welche Statistiken gehören zwingend hinein? Soll die Präsentation in
Paperless abgelegt werden? Gibt es Vorgaben zur Hausschrift oder ein aktuelles Logo in höherer Auflösung?
