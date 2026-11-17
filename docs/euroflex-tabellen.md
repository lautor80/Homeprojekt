# Euroflex – Tabellen anpassen (Spalten, Filter, Sortierung) und in Varianten speichern

Stand: 17.11.2026 · Modul `modules/transport`, Baustein im Kern `web/src/components/TabellenAnsicht.tsx` · Migration `013_tabellen_anpassen.sql`

## Wo

| App | Tabelle | Variante (`repid`) | Feld in der Variante |
|---|---|---|---|
| Aufträge | Liste | `transport.auftraege` | `spalten.liste` |
| Aufträge | Baum (Art → Kunde → Auftrag) | `transport.auftraege` | `spalten.baum` |
| Kontakte | Reiter „Aufträge“ im Kontakt | `transport.kontakte` | `spalten.auftraege` |
| Kontakte | Reiter „Dokumente“ im Kontakt | `transport.kontakte` | `spalten.dokumente` |

Posteingang und Stammdaten haben keine Tabelle im Sinne einer Liste mit Spalten (Karten bzw. Pflegetabellen) und bleiben unverändert.

## Bedienung

- Knopf **„Spalten“** über der Tabelle öffnet *Tabelle anpassen*:
  - **Spalten** ein- und ausblenden (Pflichtspalten wie *Auftrag* oder *Status* lassen sich nicht ausblenden), *Alle einblenden*.
  - **Filter**: vorhandene Filter ändern oder entfernen, neuen Filter wählen (Spalte + „enthält …“) → *Filter setzen*. Filter lassen sich weiterhin auch direkt im Spaltenkopf eingeben.
  - **Sortierung**: zeigt die aktuelle Sortierung (gesetzt über den Spaltenkopf), *Sortierung aufheben*.
  - *Zurücksetzen* stellt alle Spalten ohne Filter und Sortierung wieder her.
- Gesetzte Filter stehen über der Tabelle („Filter: Kunde: brandt · Route: mannheim“) mit *Filter entfernen*.
- Der Knopf zeigt, was angepasst ist, z. B. „Spalten (2 aus, 1 Filter)“.
- **Speichern/Laden**: über die bestehenden Ansichtsvarianten oben rechts (Diskette). Gespeichert werden Spalten, Filter und Sortierung zusammen mit den übrigen Filtern der App; eine Standardvariante wird beim Öffnen geladen. Ältere Varianten ohne Spaltenangaben lassen die Tabelle, wie sie ist.
- Spalten, die es nicht mehr gibt, und Filter auf ausgeblendeten Spalten fallen beim Laden einer Variante still weg.
- Die Spalte *Abrechnung* hat keinen Textfilter – dafür gibt es den Filter *Zahlung* im Kopf.

## Recht & Funktionsschalter

| Funktion | Recht | aus = |
|---|---|---|
| `transport.tabellen` Tabellen anpassen (Spalten, Filter, Sortierung) | `transport.tabellen:edit` | kein Knopf „Spalten“, alle Spalten sichtbar; die Auftragsliste behält ihre bisherigen Filter im Spaltenkopf, die Tabellen im Kontakt sind wie bisher ohne Filter/Sortierung. Varianten behalten ihre Spaltenangaben, wenden sie aber nicht an und speichern keine neuen. |

Migration 013 gibt das Recht jeder Rolle, die Aufträge oder Kontakte sieht.

## Technik

- Stand je Tabelle: `{ aus: string[], filter: { id, value }[], sortierung: { id, desc }[] }` – reine Funktionen in `web/src/components/tabellenAnsicht.ts` (Tests: `server/test/tabellen_ansicht.test.ts`).
- Hook `useTabellenAnsicht({ spalten, stand, onStand, aktiv, pflicht })` liefert die sichtbaren Spalten, die Eigenschaften für die `AnalyticalTable` (Instanz, `onFilter`/`onSort`), `optionen` für `reactTableOptions` (Filter und Sortierung bleiben beim Neuladen stehen), den Knopf und die Filterzeile. Der Stand gehört der Seite und steht dort in `ansicht` der Variante.
- Wiederverwendbar für andere Apps (TC Oberthal): Hook einbauen, Stand in `ansicht` aufnehmen, eigenes Recht + Funktionsschalter anmelden.
