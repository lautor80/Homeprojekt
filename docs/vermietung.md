# Modul `miete` – Vermietung (Entwurf und Stand)

Ziel: Für ein Haus mit zwei Parteien die Mieteinnahmen je Monat in **Kaltmiete** und **Nebenkosten-Abschlag** aufteilen,
mit den **laufenden Kosten** des Hauses vergleichen und einmal im Jahr die **Nebenkosten abrechnen**. Die Parteien teilen sich
den **Heizstrom** und **Teile des Haushaltsstroms**; dafür gibt es Haupt- und Unterzähler. Belege liegen in **Paperless**.

Das Modul folgt der Portalbasis (Vorlage `modules/beispiel`): eigenes Schema `miete`, Rechte „Objekt:Aktivität“ mit Bereich und
App, Schreiben nur über `change()` (Änderungsbelege), Löschen mit Begründung, Fiori-Bausteine (`AppPage`, `Section`, `Filters`,
`ConfirmDialog`, `ChangeHistoryButton`), eigenes Paperless je Bereich (`paperlessDef('miete', 'Vermietung')`), Ablagekontexte in der
zentralen Paperless-Zuordnung, Einträge im Arbeitsvorrat.

## Aktivieren

Das Modul ist privat und erscheint **nicht** von selbst (wie die Vorlage `beispiel` nur aktiv, wenn ausdrücklich genannt):

```
PORTAL_MODULES=miete            # nur die Vermietung
PORTAL_MODULES=tco,miete        # zusätzlich zu einem anderen Bereich
```

danach `./update.sh`. Anschließend in der Rollenpflege (Bereich *Vermietung*) die Rechte vergeben und unter
*Administration → Schnittstellen → Paperless* den Zugang **Paperless-ngx Vermietung** eintragen (eigenes Paperless oder eigener
Zugang – nie dieselbe Adresse wie ein anderer Bereich).

## Apps und Funktionen

| App | Recht | Funktionen |
|---|---|---|
| **Übersicht** | `miete.uebersicht:display` | Je Monat: Kaltmiete Soll/Ist, NK-Abschlag Soll/Ist, umlagefähige Kosten, davon Anteil der Mieter, **NK-Deckung** (Abschläge − Kostenanteil der Mieter), nicht umlagefähige Kosten, Ergebnis. Mietkonto je Mietverhältnis (Soll bis heute, gezahlt, offen). |
| **Mieteinnahmen** | `miete.zahlungen:display` / `:edit` | Eingang erfassen mit Leistungsmonat; Aufteilung wird aus dem Soll vorgeschlagen (Teilzahlung im Verhältnis, Überzahlung zur Miete) und lässt sich ändern. **Monat buchen**: für alle Mietverhältnisse den Eingang in Höhe des Solls erfassen (Dauerauftrag). **In den Folgemonat kopieren** (Kopiersymbol je Zeile): Leistungsmonat und Eingangsdatum +1 Monat, Betrag, Aufteilung und Notiz vorbelegt; ändert sich der Betrag, bleibt die Kaltmiete gleich und die Abweichung geht in den Nebenkosten-Abschlag. |
| **Laufende Kosten** | `miete.kosten:display` / `:edit` | Rechnungen, Bescheide, Abschläge an Versorger mit Kostenart, Leistungszeitraum (tageweise auf Monate/Jahre verteilt), Lieferant. **Betrag aus Jahreswert**: auf den Leistungszeitraum (je Monat 1/12, angebrochene Monate tageweise) oder auf einen Monat (1/12, Leistungszeitraum = Kalendermonat); gespeichert wird der Betrag. **Paperless**: Dokument suchen und verknüpfen, Datei hochladen (Ablage mit Regel *Kostenbeleg*), Beleg öffnen, **Aus Paperless übernehmen** (Dokumente mit dem Schlagwort des Hauses, die noch keiner Position zugeordnet sind). |
| **Zähler** | `miete.zaehler:display` / `:edit` | Hauptzähler (Versorger), Unterzähler je Wohnung und **Gemeinschaftszähler** (ohne Wohnung, z. B. Waschküche, Keller, Heizungsstrom) – auch hintereinander (*Liegt hinter Zähler*), als Baum angezeigt; Ablesungen mit Verbrauch seit Vorablesung, Warnung bei fallendem Stand. |
| **Nebenkostenabrechnung** | `miete.abrechnung:display` / `:edit` | Verteilung aller Kosten eines Kalenderjahres auf die Wohnungen – **Kostenaufteilung drucken** (PDF quer: je Kostenart Gesamtbetrag, Verteilerschlüssel, je Wohnung Betrag, Prozent und Rechenweg; Summen pro Jahr/Monat, nicht umgelegte Kosten getrennt, Ergebnis je Mietverhältnis, Erläuterung der Schlüssel; auch als Vorschau im laufenden Jahr); je Mietverhältnis Kosten, Vorauszahlungen (Ist), Nachzahlung/Guthaben, Ausweis § 35a EStG, Vorschlag neuer Abschlag. **Festschreiben** (nur abgeschlossene Jahre; Stand wird gespeichert), **PDF**, **In Paperless ablegen** (Regel *Nebenkostenabrechnung*), **Versendet** vermerken, **Wieder öffnen** mit Begründung. |
| **Haus und Mieter** | `miete.stammdaten:display` / `:edit` | Reiter *Mietverhältnisse* (Mieter, Wohnung, Zeitraum, Personen; **Miete/Abschlag ab Stichtag** für Mieterhöhung und neuen Abschlag), *Wohnungen* (Fläche, Eigennutzung), *Kostenarten* (umlagefähig, Verteilerschlüssel, § 35a), *Haus* (Anschrift, Vermieter, IBAN für Nachzahlungen, Paperless-Schlagwort). |

## Verteilerschlüssel

| Schlüssel | Rechnung |
|---|---|
| Wohnfläche | Anteil = Fläche der Wohnung / Fläche aller Wohnungen |
| Personen | nach Personentagen (Personen × Tage je Nutzungsabschnitt); Leerstand zählt 0 Personen |
| Wohneinheiten | gleiche Teile |
| Fester Anteil | Prozent je Wohnung (z. B. 50/50 – frei vereinbar) |
| **Verbrauch** | Hauptzähler der Kostenart; jede Wohnung trägt den Verbrauch ihrer Unterzähler. **Gemeinsamer Verbrauch** – Gemeinschaftszähler (Waschküche, Keller, Heizungsstrom) und was der Hauptzähler mehr zeigt als alle Unterzähler zusammen (Treppenhaus, Außenlicht) – wird je Kostenart *nach Wohnfläche* (Standard), *nach Personen* (Personentage) oder *zu gleichen Teilen* geteilt (*Gemeinsamen Verbrauch teilen*). Liegt ein Gemeinschaftszähler hinter dem Zähler einer Wohnung (die Waschküche hängt am Stromkreis einer Partei), wird sein Verbrauch dort abgezogen. Zeigen die Zähler hinter einem Zähler mehr als dieser, meldet die Verteilung das. Fehlen Hauptzähler oder Ablesungen, wird der ganze Betrag so geteilt wie der gemeinsame Verbrauch (mit Hinweis). Hat nur eine Wohnung einen Unterzähler (**Differenzmessung**), lässt sich der Rest stattdessen der anderen Wohnung zuordnen (*Hauptzähler minus Unterzähler gehört …*). Optional **Grundkosten** in Prozent vorab nach Wohnfläche (z. B. 30 % bei Heizkosten). |
| Direkt | Beleg ist einer Wohnung zugeordnet |

Typische Einrichtung für das Haus:

- **Heizstrom** (Wärmepumpe/Nachtspeicher): Hauptzähler „Heizstrom“; je Wohnung ein Wärmemengenzähler als Unterzähler → Schlüssel *Verbrauch*, Grundkosten 30 %.
  Nur ein Zwischenzähler (z. B. OG): Rest „gehört EG“ (Differenzmessung).
  Ohne Unterzähler: *Fester Anteil* oder *Wohnfläche*.
- **Haushaltsstrom (gemeinsam)**: voreingestellt *nach Personen* je Wohnung (Personentage, Migration 003) – ohne Zähler der ganze Betrag, mit Hauptzähler „Hausstrom“
  und Zwischenzählern der gemeinsame Rest.
- **Waschküche/Keller oder Heizungsstrom im Zähler einer Partei**: Hausanschluss als Hauptzähler, je Partei ein Unterzähler, hinter dem Unterzähler der Partei
  der Gemeinschaftszähler „Waschküche“ (ohne Wohnung). Beispiel: Mama 2.250 kWh, Nils & Sophia 3.000 kWh inkl. Waschküche 600 kWh, nach Fläche (gleich groß)
  → Mama 2.250 + 300 = 2.550, Nils & Sophia 2.400 + 300 = 2.700 kWh; nach Personen (1 : 2) → 2.450 / 2.800 kWh.
- **Telefon/Internet** (gemeinsamer Anschluss): *Wohneinheiten (gleiche Teile)*, umlagefähig – keine Betriebskosten nach BetrKV, nur bei vertraglicher Vereinbarung umlegen.
- Eigener Haushaltsstrom einer Partei mit eigenem Vertrag beim Versorger gehört nicht in die Abrechnung.

**Zeitanteile:** Nutzungsabschnitte je Wohnung (Mietverhältnis, Eigennutzung, Leerstand) werden lückenlos gebildet; jeder Mieter
trägt seine Tage. Der Anteil der selbst bewohnten Wohnung und des Leerstands bleibt beim Vermieter. Verbrauch im Zeitraum = Stand am
Ende − Stand am Vortag des Beginns; fehlt eine Ablesung genau am Stichtag, wird zwischen zwei Ablesungen linear geschätzt. Ohne
eingrenzende Ablesungen verteilt die Abrechnung nach Wohnfläche und zeigt einen Hinweis.

**Heizkostenverordnung:** In einem Zweifamilienhaus, in dem der Vermieter eine Wohnung selbst bewohnt, gilt sie nicht zwingend
(§ 2 HeizkostenV) – Schlüssel frei vereinbar. Bei anderen Häusern: 50–70 % nach Verbrauch (Grundkosten 30–50 %).

## Arbeitsvorrat (Startseite, Block „Vermietung“)

- **Miete offen** je Mietverhältnis (Soll seit Jahresbeginn − Eingänge; der laufende Monat zählt ab dem 6.).
- **Nebenkostenabrechnung <Vorjahr> erstellen** – solange ein Mietverhältnis des Vorjahres nicht festgeschrieben ist; ab Oktober rot (Frist § 556 Abs. 3 BGB: 12 Monate nach Ende des Abrechnungszeitraums).
- **Zählerstand zum Jahreswechsel** – im Januar/Februar je Zähler ohne Ablesung um den 31.12.
- Störungen des Paperless-Zugangs meldet der Kern (Administration).

## Paperless

- Zugang **Paperless-ngx Vermietung** (`miete.paperless`), Prüfung auf eindeutige Adresse wie bei allen Bereichen.
- Ablagekontexte (Administration → Schnittstellen → Paperless → Vermietung): *Kostenbeleg* (`kosten.beleg`: Titel „{kostenart} {zeitraum} – {lieferant}“, Korrespondent = Lieferant, Tags „Nebenkosten, {objekt}“) und *Nebenkostenabrechnung an den Mieter* (`abrechnung`).
- Verknüpfung wird im Portal gespeichert (`miete.kosten.paperless_id`, `miete.abrechnungen.paperless_id`); Belege öffnet das Portal über `GET /api/m/miete/paperless/:id/datei` (Ablage intern, nichts verlässt das Haus).

## Technik

| Datei | Inhalt |
|---|---|
| `modules/miete/server/migrations/001_miete.sql` | Schema `miete`: objekt, einheiten, vertraege, konditionen, zahlungen, zaehler, ablesungen, kostenarten (mit Vorbelegung nach BetrKV), kosten, abrechnungen; Änderungsbelege |
| `modules/miete/server/logik.ts` | Reine Rechenlogik: Aufteilung, Soll je Monat, Zeitanteile, Zählerstände, Verteilung, Abrechnung – Test `server/test/miete_logik.test.ts` |
| `modules/miete/server/daten.ts` | Lesen, Monatsübersicht, Abrechnung eines Jahres |
| `modules/miete/server/index.ts` | Modul, Rechte, Routen (`/api/m/miete/...`), Arbeitsvorrat |
| `modules/miete/server/paperless.ts`, `pdf.ts` | Anbindung, Ablagekontexte, PDF der Abrechnung (Gotenberg) |
| `modules/miete/web/*` | Apps der Oberfläche |
| `server/test/miete.test.ts` | Durchlauf mit Datenbank: zwei Parteien, Heizstrom mit Unterzähler, Einnahmen, Übersicht, Abrechnung, Rechte |
| `server/test/miete_gemeinschaftszaehler.test.ts` | Gemeinschaftszähler hinter einem Unterzähler, Teilung nach Fläche/Personen/gleichen Teilen, Kreisprüfung |
| `modules/miete/server/migrations/002_gemeinschaftszaehler.sql` | Kostenart: `gemeinsam_schluessel` (flaeche, personen, einheiten) |
| `modules/miete/server/migrations/003_hausstrom_personen.sql` | Haushaltsstrom (gemeinsam) auf *nach Personen* |
| `modules/miete/server/migrations/004_kostenart_telefon.sql` | Kostenart *Telefon/Internet* (zu gleichen Teilen, umlagefähig) |

## Nächste Ausbaustufen (nicht umgesetzt)

1. **Bankimport** (CSV/CAMT) mit Zuordnung der Mieteingänge über Verwendungszweck/IBAN – Baustein wie *Bankimport* im Verein.
2. **Versand der Abrechnung** per E-Mail (n8n) mit Freigabelink aus Paperless; Mieterportal (Selbstbedienung) mit Zugang zur eigenen Abrechnung.
3. **Wiederkehrende Kosten** (Abschläge an Versorger automatisch je Monat anlegen) und Abgleich mit der Jahresendabrechnung des Versorgers.
4. **Anlage V / Steuer**: Einnahmen-/Werbungskostenübersicht je Jahr (Kaltmiete, umgelegte Nebenkosten, Abschreibung, Zinsen).
5. **Mehrere Häuser** (heute ein Objekt je Installation) und abweichende Abrechnungszeiträume (nicht Kalenderjahr).
6. Abgeschaltete Funktionen über den Funktionsschalter (z. B. „Monat buchen“).
