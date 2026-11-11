# App „Präsentationen“ – PowerPoint aus dem Portal (#146)

Präsentationen im TCO-Branding mit **aktuellen Zahlen aus dem Portal**, z. B. für Vorstandssitzungen oder die
Mitgliederversammlung. Umgesetzt sind die Optionen **B** (eigene Vorlagen hochladen und füllen) und **C** (Sammelkorb
„Zur Präsentation“ in der Vereinsübersicht). Menü: **TCO → Präsentationen** (`/tco/praesentationen`).

Berechtigungen: `tco.praesentation:display` (Präsentationen erzeugen, eigener Sammelkorb; erhalten alle Rollen mit
`tco.dashboard:display`), `tco.praesentation:edit` (Vorlagen hochladen und löschen). Die erzeugten Dateien sind normale
PowerPoint-Dateien; Diagramme bleiben **native, bearbeitbare PowerPoint-Diagramme** mit den Portaldaten.

## Option C – Sammelkorb

In der **Vereinsübersicht** hat jeder Bereich (Mitglieder, Clubhaus, Finanzen, Jugend, Halle, Portal) den Knopf
**Zur Präsentation**: Kennzahl, Diagramm oder Tabelle wählen → *Hinzufügen* (oder *Hinzufügen und öffnen*). Der Korb gehört
dem angemeldeten Benutzer (`tco.praesentation_korb`, max. 100 Einträge). In der App, Reiter **Sammelkorb**:

- Reihenfolge ändern (hoch/runter), Einträge entfernen, eigene **Textfolien** und **Kapiteltrenner** ergänzen,
  je Eintrag optional Folientitel und Kommentar.
- Geschäftsjahr, Titel und Untertitel wählen → **PowerPoint erzeugen**.

Aufbau der erzeugten Datei (Standardvorlage `modules/tco/server/assets/praesentation_standard.pptx`):
Titelfolie → Inhalte in Korb-Reihenfolge → Abschlussfolie. Aufeinanderfolgende Kennzahlen werden zu Kachelfolien mit bis zu
vier Kacheln zusammengefasst (eine Kennzahl mit eigenem Folientitel beginnt eine neue Folie). Diagramme (Linie/Säulen),
Tabellen (bis 14 Zeilen) und Texte erhalten je eine Folie; ohne Kommentar wird das Diagramm auf volle Breite gezogen.

## Option B – eigene Vorlagen

Reiter **Vorlagen**: Die Vorlage wird in PowerPoint gestaltet und mit Platzhaltern versehen, dann hochgeladen
(`.pptx`, bis 40 MB). Das Portal erkennt alle Platzhalter und zeigt je Vorlage, welche es selbst füllt (grün) und welche
als **eigene Texte** vor dem Erzeugen einzutragen sind. Die mitgelieferte **Beispielvorlage** zeigt alle Möglichkeiten und
kann heruntergeladen und als Ausgangspunkt genutzt werden.

### Platzhalter

| Platzhalter | Inhalt |
|---|---|
| `{{praesentation.titel}}`, `{{praesentation.untertitel}}` | Eingaben beim Erzeugen |
| `{{jahr}}`, `{{stand.datum}}`, `{{verein.name}}` | Geschäftsjahr, Tagesdatum, Vereinsname |
| `{{SCHLUESSEL}}` | Wert einer Kennzahl der Vereinsübersicht, z. B. `{{MTG_GESAMT}}`, `{{FIN_SALDO}}`, `{{HAL_BELEGUNG}}`, `{{JUG_MITGL}}`, `{{CLUB_UMSATZ}}`, `{{HAL_ABR}}` |
| `{{SCHLUESSEL.einheit}}`, `.titel`, `.text` | Einheit (z. B. `€`, `%`), Kachelüberschrift, Untertitel der Kennzahl |
| `{{liq.geld}}`, `{{liq.forderung}}`, `{{liq.rechnungen}}`, `{{liq.kredit}}`, `{{liq.summe}}`, `{{liq.monat}}` | Liquidität (Geldkonten, Forderungen Clubhaus, offene Rechnungen, Kredite, Summe, Stichmonat) |
| `{{beliebig.name}}` | alles andere ist ein **eigener Text**, der beim Erzeugen abgefragt wird (z. B. `{{kommentar.finanzen}}`) |

Platzhalter dürfen in Textfeldern, Tabellen, Notizen und Layouts stehen und auch über mehrere Formatierungen laufen;
die Formatierung des ersten Zeichens bleibt erhalten. Mehrzeilige Texte werden zu mehreren Absätzen.
Platzhalter ohne Wert bleiben stehen – so fällt auf, was fehlt.

**Diagramme und Tabellen:** Ein beliebiges natives PowerPoint-Diagramm bzw. eine Tabelle bekommt als *Name* oder
*Alternativtext* (Auswahlbereich bzw. Rechtsklick → Alternativtext) den Marker `{{DIAGRAMM:KEY}}` bzw. `{{TABELLE:KEY}}`.
Das Portal tauscht Kategorien und Reihen bzw. die Zeilen aus; Gestaltung, Farben und Achsen bleiben wie in der Vorlage.

| Diagramm-KEY | Inhalt |
|---|---|
| `MTG_MONATE` | Mitgliederentwicklung je Monat |
| `MTG_EIN_AUS` | Eintritte/Austritte je Monat |
| `MTG_JAHRE` | Mitglieder der letzten Jahre |
| `FIN_MONATE` | Einnahmen und Ausgaben je Monat |
| `FIN_BESTAND` | Kontostand je Monatsende |
| `CLUBHAUS` | Clubheimerträge je Monat |
| `HAL_JAHRE` | Hallenbuchungen der letzten fünf Jahre (Stunden) |
| `BENUTZER` | registrierte Portal-Benutzer (24 Monate) |

| Tabellen-KEY | Inhalt |
|---|---|
| `HAL_ABR` | offene Hallenstunden |
| `CLUB_OP` | offene Posten Clubhaus |
| `CLUB_UMSATZ` | Clubhausumsatz je Monat |
| `MTG_JUBILAEUM` | Beitragsstufenwechsel (Jugendliche → Erwachsene) |

Die Liste der verfügbaren Kennzahlen/Diagramme/Tabellen liefert `GET /api/m/tco/praesentation/katalog?jahr=`.

## Schnittstellen (`/api/m/tco/praesentation/…`)

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `katalog` | Kennzahlen, Diagramme, Tabellen zur Auswahl |
| GET/PUT/POST | `korb` | Sammelkorb lesen / ersetzen / einen Eintrag anhängen (doppelte werden nicht erneut angehängt) |
| POST | `korb/erzeugen` | PowerPoint aus dem Korb (`{jahr, titel, untertitel}`) |
| GET/POST/DELETE | `vorlagen[/:id]` | Vorlagen auflisten (inkl. Platzhalter mit Status) / hochladen / löschen |
| GET | `vorlagen/:id/datei` | Originaldatei (`beispiel` = Beispielvorlage) |
| POST | `vorlagen/:id/erzeugen` | PowerPoint aus Vorlage (`{jahr, titel, untertitel, texte}`) |

Dateien gehen als Base64 im JSON (`{name, datei}`). Die PPTX-Verarbeitung (`modules/tco/server/praesentation/pptx.ts`)
kommt ohne zusätzliche Bibliotheken aus: ZIP lesen/schreiben (`server/src/lib/zip.ts`), Platzhalter ersetzen, Diagramm-Caches
und Tabellen füllen, Folien klonen/entfernen.

## Vorlagen neu erzeugen

Standard- und Beispielvorlage werden mit `pptxgenjs` erzeugt (16:9, Arial, TCO-Farben Orange `E2701F`, Dunkelorange
`B9561A`, Anthrazit `1F1F1F`, Grau `6B6B6B`, Hintergrund `F6F4F2`, Logo aus `modules/tco/server/assets`):

```bash
APPLY_THEME=<pfad>/apply_theme.js ASSETS=modules/tco/server/assets \
  node docs/praesentation/standard-erzeugen.cjs modules/tco/server/assets/praesentation_standard.pptx
APPLY_THEME=<pfad>/apply_theme.js ASSETS=modules/tco/server/assets \
  node docs/praesentation/beispiel-erzeugen.cjs modules/tco/server/assets/praesentation_beispiel.pptx
```

Die Standardvorlage enthält je Folienart eine Musterfolie (Titel, Kennzahlen, Linie, Säulen, Tabelle, Text, Kapitel,
Ende), die beim Erzeugen geklont wird; die Formnamen (`Kachel n …`, `Kommentar`, `{{DIAGRAMM}}`, `{{TABELLE}}`) dürfen
bei Änderungen nicht umbenannt werden.

## Weitere Ideen

Vergleich mit dem Vorjahr als zweite Datenreihe, Jahresabschluss (EAR) als Tabellenfolie, Ablage der fertigen
Präsentation in Paperless, Versand an den Vorstand, „Zur Präsentation“ auch an Berichten wie Einnahmen & Ausgaben.
