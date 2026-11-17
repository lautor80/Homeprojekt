# Euroflex – Vorschläge beim Erfassen der Stops

Stand: 17.11.2026 · Modul `modules/transport` · Migration `015_stop_vorschlaege.sql`

## Bedienung

Auf der Objektseite des Auftrags (Bereiche *Erster Stop*, *Zweiter Stop* …) schlagen diese Felder beim Tippen Werte aus früheren Aufträgen vor – für Absender und Empfänger gleich, aus allen Lade- und Entladestellen:

| Feld | Vorschläge | Beim Übernehmen |
|---|---|---|
| **Firma** | bekannte Firmen mit Anschrift rechts („Edmund Meiser Straße 1 · DE 66839 Schmelz“); dieselbe Firma mit verschiedenen Anschriften steht einzeln da. Auch über Straße oder Ort auffindbar. | Straße, Land und PLZ/Ort werden mit eingetragen |
| **Straße** | bekannte Straßen; passt PLZ/Ort schon, deren Straßen zuerst | Land und PLZ/Ort |
| **PLZ Ort** | bekannte Orte, über PLZ oder Namen | Land |
| **Zeitvorgabe** (Laden/Entladen) | die häufigsten Angaben („bis 14:00 Uhr“, „07:00-08:30“) | – |

- Vorschläge ab 2 Zeichen (Zeitvorgabe sofort), Treffer am Anfang vor Treffern im Wort, sonst die zuletzt verwendeten zuerst.
- Mit Maus oder Pfeiltasten + Enter gewählt: die zugehörigen Felder werden **überschrieben**. Eine Firma ganz abgetippt und das Feld verlassen: nur **leere** Felder werden ergänzt.
- „laut LFS“ (Platzhalter beim Frachtauftrag) wird nie vorgeschlagen.
- Die Liste wird beim Öffnen des Auftrags einmal geladen (höchstens 3000 Anschriften, jüngste zuerst).

## Recht & Funktionsschalter

| Funktion | Recht | aus = |
|---|---|---|
| `transport.stops.vorschlaege` Vorschläge beim Erfassen der Stops | `transport.vorschlaege:display` | einfache Eingabefelder; `GET /stops/vorschlaege` antwortet 403 |

Migration 015 gibt das Recht jeder Rolle, die Aufträge bearbeiten darf.

## Technik

- `GET /api/m/transport/stops/vorschlaege` → `{ orte: { firma, strasse, land, plzort, anzahl }[], zeiten: string[] }` (`modules/transport/server/index.ts`).
- Filter und Rangfolge: `modules/transport/web/vorschlaege.ts`, Eingabefeld: `modules/transport/web/StopFeld.tsx`.
- Tests: `server/test/transport_stop_vorschlaege.test.ts` (ohne DB), `server/test/transport.test.ts` (Route).
