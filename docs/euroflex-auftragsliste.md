# Euroflex – Auftragsliste: Lade-/Entladezeiten und Abrechnungsstatus

Stand: 17.11.2026 · Modul `modules/transport` · Migration `012_abrechnungsstatus.sql`

## Was sich in der Liste ändert

| Bereich | Anzeige |
|---|---|
| Spalte **Route · Laden / Entladen** | Zeile 1: Orte wie bisher (Ladestelle → Entladestelle 1 → Entladestelle 2). Zeile 2: **Laden** = Datum und Zeit des ersten Stops, **Entladen** = Datum und Zeit der letzten Entladestelle, z. B. `↑ Mi 18.11. 07:00–08:30 · ↓ Mi 18.11. 12:30`. Die Zeit ist das freie Zeitfeld des Stops (Uhrzeit oder Zeitfenster). Die eigene Spalte „Ladedatum“ entfällt dann. |
| Spalte **Abrechnung** | Drei Symbole in einer Zelle: **angelegt · abgerechnet · bezahlt**, darunter ein kurzer Hinweis („fällig 01.12.“, „bezahlt 16.11.“, „5 Tage überfällig“, „ohne Rechnung“). Der Tooltip nennt Datum bzw. Rechnungsnummer. |
| Filter **Zahlung** | Alle · Nur angelegt · Abgerechnet, nicht bezahlt · Zahlung überfällig · Bezahlt. Wird in Varianten gespeichert. |
| Menü **Zahlung** | *Als bezahlt markieren …* (Datum wählen, Vorgabe heute) und *Zahlung zurücknehmen* für die ausgewählten fakturierten Aufträge. |

### Symbole

| Zustand | Aussehen |
|---|---|
| erledigt (angelegt, abgerechnet) | blau gefüllt |
| bezahlt | grün gefüllt |
| noch offen | grau gestrichelt umrandet |
| Zahlung überfällig | orange gefüllt |

## Regeln

- **Fällig** = Rechnungsdatum + Zahlungsziel aus *Einstellungen → Euroflex → Firma und Bank*.
- **Überfällig** erst **mehr als 3 Tage nach Fälligkeit** (`KULANZ_TAGE` in `modules/transport/server/abrechnung.ts`). Bis einschließlich dem 3. Tag gilt die Rechnung als „abgerechnet“.
- **Ohne Rechnung abgeschlossen** (früher „mit 0 Euro ausgebucht“) braucht keine Zahlung und wird **direkt als bezahlt** angezeigt. Es gibt dafür kein eigenes Symbol, nur den Hinweis „ohne Rechnung“.
- Der Zahlungseingang gilt für die **Rechnung**: Bei einer Sammelrechnung bekommen alle ihre Aufträge dasselbe Datum, auch nicht ausgewählte.
- Das Zahlungsdatum darf nicht in der Zukunft und nicht vor dem Rechnungsdatum liegen.
- *Rechnung entfernen* löscht auch den Zahlungseingang.
- Beim SAP-Neuaufbau (Datenimport „Ersetzen“) wird der im Portal erfasste Zahlungseingang zurückgeschrieben, wenn der Auftrag dieselbe Rechnungsnummer behält.

## Technik

- Spalte `transport.auftraege.bezahlt_am` (Datum, leer = nicht bezahlt), Änderungsbeleg `ZAHLUNG_ERFASST` / `ZAHLUNG_ZURUECKGENOMMEN`.
- `GET /api/m/transport/auftraege` liefert je Auftrag zusätzlich `laden`, `entladen` (`{ datum, zeit }`) und `abrechnung` (`{ status, faellig, tageUeberfaellig, bezahltAm, ohneRechnung }`) – jeweils nur mit dem passenden Recht.
- `POST /api/m/transport/zahlungen` `{ auftraege: string[], bezahltAm: 'JJJJ-MM-TT' | null }`.
- Logik: `modules/transport/server/abrechnung.ts` (Status, Termine), Anzeige: `modules/transport/web/termin.ts`. Tests: `server/test/transport_abrechnung.test.ts` (ohne Datenbank) und `server/test/transport.test.ts` (Integration).

## Rechte & Funktionsschalter

Abschaltbar unter *Administration → Einstellungen → Funktionen → Euroflex → Aufträge*; die Rechte vergibt die Rollenpflege (*Euroflex → Aufträge*).

| Funktion | Recht | aus = |
|---|---|---|
| `transport.liste.ladezeiten` Lade- und Entladezeiten in der Auftragsliste | `transport.ladezeiten:display` | Spalte Route nur mit Orten, Spalte „Ladedatum“ wie bisher |
| `transport.liste.abrechnung` Abrechnungsstatus in der Auftragsliste | `transport.abrechnung:display` | keine Spalte „Abrechnung“, kein Filter „Zahlung“; schaltet auch die Zahlungserfassung ab |
| `transport.zahlungen` Zahlungseingang erfassen | `transport.zahlungen:edit` (setzt `transport.abrechnung:display` voraus) | kein Menü „Zahlung“, `POST /zahlungen` antwortet mit 403 |

Migration 012 gibt die beiden Anzeigerechte jeder Rolle, die Aufträge sieht, und `transport.zahlungen:edit` jeder Rolle, die Rechnungen erstellen darf – niemand verliert etwas.
