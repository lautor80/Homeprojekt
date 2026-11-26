# Euroflex – Auftrag aus Beleg (Belegerfassung)

Stand: 26.11.2026 · Modul `modules/transport` · Migration `023_belegerfassung.sql`

Ein Kunde schickt seinen Frachtauftrag als PDF oder Bild (Bestellung über Frachtkosten, Ladeauftrag …). Das Portal liest den
Beleg und füllt daraus die Erfassungsmaske eines **Frachtauftrags** vor. Angelegt wird der Auftrag erst, wenn der Benutzer
geprüft und **gespeichert** hat – es entsteht nie ein Auftrag von selbst.

## Grundregel für jedes Feld

| Im Beleg | In der Maske |
|---|---|
| **eindeutig** zu lesen | Wert wird eingetragen, unter dem Feld steht „aus Beleg“ |
| **mehrere Möglichkeiten** oder unsicher | Feld bleibt leer und ist als „Rückfrage offen“ markiert; das Band oben zeigt die möglichen Werte mit der Stelle im Beleg zur Auswahl |
| **nicht gefunden** | Feld bleibt leer und steht unter „Nicht im Beleg gefunden – bitte von Hand nachtragen“ |

Es wird nie geraten. Das gilt für alle Felder, auch für den Kunden: Stehen im Beleg zwei Firmen (z. B. Briefkopf und
Grußformel verschieden) oder passen mehrere Kontakte, fragt die Maske nach. Schon eingetragene Werte werden nicht still
überschrieben – weicht der Beleg ab, entsteht eine Rückfrage („Aus Beleg übernehmen“ / „Eingabe behalten“).

## Bedienung

1. **Auftragsliste:** *Neu → Frachtauftrag aus Beleg…* öffnet einen Dialog mit Ablagezone für eine PDF-, PNG- oder JPG-Datei
   (hineinziehen oder auswählen). Das Portal liest den Beleg und öffnet die Neuanlage vorbefüllt.
2. **Leere Neuanlage** eines Frachtauftrags: dieselbe Zone „Auftrag aus Beleg: PDF oder Bild hierher ziehen oder auswählen“
   steht oben in der Maske. Sie ist getrennt vom Ablagefeld „Dateien nach Paperless ablegen“ der Navigation.
3. **Posteingang:** Jeder PDF-/Bild-Anhang einer offenen, nicht vorgemerkten E-Mail hat den Knopf **„Auftrag daraus anlegen“**.
4. Oben in der Maske steht das Band **„Aus Beleg vorbefüllt (Leseprofil)“** mit Dateiname, Zählern (übernommen · Rückfragen
   offen · nicht gefunden), den Rückfragen, den fehlenden Feldern, Hinweisen der Erkennung und **„Beleg ansehen“** (Datei links,
   gelesener Text rechts).
5. **Rückfragen:** „Wählen“ trägt den Wert ein; das Feld von Hand zu füllen erledigt die Rückfrage ebenfalls.
6. **Kunde nicht eindeutig:** Das Band zeigt den Auftraggeber laut Beleg und bietet „Als Kontakt anlegen…“ mit vorbelegtem
   Kontaktdialog an; sonst den Kunden wie gewohnt wählen.
7. **Dublette:** Gibt es die Auftragsnr. des Kunden schon, steht oben eine Warnung mit Link auf den vorhandenen Auftrag.
   Speichern bleibt möglich.
8. **Speichern:** Sind noch Rückfragen offen, fragt ein Dialog einmal nach („Trotzdem speichern“). Nach dem Speichern wird der
   Beleg an den Auftrag gehängt (wie das Ablagefeld *Dokumente*: Paperless und/oder Ablageordner) bzw. die E-Mail dem Auftrag
   zugeordnet (wie „Ablage bestätigen“ im Posteingang). Schlägt das fehl, bleibt der Auftrag gespeichert und ein Hinweis nennt,
   was nachzuholen ist. Wird die Neuanlage verlassen, ohne zu speichern, bleibt die E-Mail unverändert in der Prüfliste.

Sieht der Beleg nicht nach einem Frachtauftrag aus (Rechnung, Lieferschein, beliebiger Text), kommt die Meldung „Der Beleg
sieht nicht nach einem Frachtauftrag aus – nichts übernommen“ und die Maske bleibt, wie sie war.

## Was gelesen wird

| Feld der Maske | Quelle im Beleg |
|---|---|
| Kunde | Auftraggeber/Frachtzahler bzw. Firma des Belegs – abgeglichen mit den Kontakten. Eindeutig nur, wenn der Beleg genau eine Firma nennt und genau ein Kontakt mit vollem Namen und PLZ/Ort passt; ähnliche Kontakte (Teilname, andere Rechtsform, ohne Ort) werden zur Bestätigung vorgeschlagen |
| Auftragsnr. Kunde | Bestell- bzw. Transportnummer |
| Leistungsdatum | Ladedatum des ersten Stops |
| Frachtpreis VK | Frachtrate bzw. Gesamtpreis netto |
| Gewicht (t), Lademeter (m) | „900 kg“, „18,250 TO“, „5,5 LM“. Die Fahrzeuglänge in der LKW-Art ist **kein** Lademeter; eine Tonnenangabe im Freitext („nur mit 7,5 t LKW“) ist kein Gewicht |
| Fahrzeugtyp, Ladegut, Ladeweise, Palettentausch | Text des Belegs, abgeglichen mit den Wertelisten: gleiche Bezeichnung oder gleicher Schlüssel = eindeutig, ein nur ähnlicher Wert wird zur Bestätigung vorgeschlagen. Die Neuanlage belegt diese Felder mit Standardwerten vor – steht im Beleg nichts dazu, bleibt der Standardwert stehen und wird unter „nicht gefunden“ als solcher genannt |
| Stop: Absender, Ladenummer, Zeitvorgabe Laden | Ladestelle/Verladeadresse („wie Auftraggeber“ = Anschrift des Auftraggebers), Ladenr., Ladetermin |
| Stop: Empfänger, Zeitvorgabe Entladen | Lieferadresse/Anlieferung, Liefertermin. „00:00:00“ gilt als „keine Uhrzeit“ |
| Besonderheiten | Ladungssicherung, Info, Kontakt laut Beleg, Lieferbedingung |

Unternehmer, Kennzeichen und Frachtpreis EK stehen nicht im Kundenbeleg und bleiben leer.

**Land ohne Länderkennzeichen:** Steht vor der PLZ kein „D-“/„B-“ …, wird das Land nicht gesetzt, sondern als Rückfrage mit
Vorschlag angeboten.

**Texterkennung mit getrennten Spalten:** Liest die Texterkennung Beschriftungen und Werte als getrennte Blöcke und passen sie in der Anzahl nicht zusammen (z. B. eine Beschriftung verschluckt), wird nichts zugeordnet – die Felder bleiben leer und ein Hinweis nennt den Grund.

**Grenzen:** Bei Bildern und gescannten PDFs kann die Texterkennung einzelne Zeichen falsch lesen (z. B. in einer
Ladenummer) – das Programm kann das nicht bemerken, deshalb den Beleg neben der Maske vergleichen. Zeitfenster
(„07:00–08:30“), mehr als zwei Anlieferadressen, andere Währungen als EUR und mehrseitige Belege werden nicht ausgewertet.

## Leseprofile

*Administration → Einstellungen → Euroflex → Leseprofile (Auftrag aus Beleg)*

| Layout | erkennt |
|---|---|
| `bestellung` Bestellung über Frachtkosten | „Bestellung Nr.“, Ladestelle, Lieferadresse, Ladetermin, Liefertermin, Gesamtpreis |
| `ladeauftrag` Ladeauftrag / Transportauftrag | „Transport <Nr.>“, Auftraggeber/Frachtzahler, Verladeadresse, Anlieferung, Frachtrate, LKW-Art |
| `allgemein` Allgemein (Schlagworte) | Rückfall für andere Belege: nur klar beschriftete Angaben |

Je Layout: **Bezeichnung** (frei, z. B. der Name des Kunden), **Aktiv** und **bevorzugter Kunde**. Der bevorzugte Kunde wird
gewählt, wenn der Beleg mehrere passende Kontakte ergibt und er darunter ist – sonst fragt die Maske weiter nach. Mindestens
ein Leseprofil bleibt aktiv. Die Layouts selbst stehen im Programm; neue Belegarten brauchen ein neues Layout.

Die Erkennung arbeitet regelbasiert im Portal (pdftotext/tesseract auf dem Server), es geht kein Beleg an einen fremden Dienst.

## Rechte & Funktionsschalter

| Funktion | Recht | aus = |
|---|---|---|
| `transport.beleg.erfassung` Auftrag aus Beleg (Drag & Drop) | `transport.belegerfassung:create` | kein Menüpunkt, keine Ablagezone; `POST /auftraege/beleg/erkennen` antwortet 403 |
| `transport.beleg.eingang` Auftrag aus Posteingang anlegen | `transport.belegeingang:create` (zusätzlich Posteingang und Aufträge bearbeiten) | Knopf fehlt; `POST /eingang/dokumente/:id/beleg` antwortet 403 |
| `transport.beleg.profile` Leseprofile pflegen | `transport.leseprofile:edit` | Kapitel fehlt; alle Layouts gelten als aktiv, ohne bevorzugten Kunden |

Migration 023 vergibt *Auftrag aus Beleg* an alle Rollen mit „Aufträge bearbeiten“, *Auftrag aus Posteingang* an Rollen mit
„Aufträge bearbeiten“ und „Posteingang bearbeiten“, *Leseprofile pflegen* an Rollen mit „Stammdaten pflegen“.

## Technik

- Vertrag: `modules/transport/server/beleg/typen.ts` (`Feld` mit `status` eindeutig/unklar/fehlt, `BelegErkennung`, `BelegVorschlag`, `BelegProfil`); Kopie für die Oberfläche in `modules/transport/web/beleg/typen.ts`.
- Erkennung (rein, ohne Datenbank): `server/beleg/erkennung.ts`, `erkennung-helfer.ts`, `layout-bestellung.ts`, `layout-ladeauftrag.ts`, `layout-allgemein.ts`.
- Abgleich mit Kontakten, Wertelisten und vorhandenen Aufträgen: `server/beleg/abgleich.ts`.
- Routen (`server/beleg/routes.ts`, Präfix `/api/m/transport`); keine legt Aufträge an oder Dateien ab:
  - `POST /auftraege/beleg/erkennen` `{ name, inhalt }` → `BelegVorschlag`
  - `POST /eingang/dokumente/:id/beleg` → `BelegVorschlag` (nutzt den schon gelesenen Text des Posteingangs)
  - `GET /beleg/profile`, `PUT /beleg/profile/:layout` `{ bezeichnung, aktiv, kunde }` (mit Änderungsbeleg, Objekt `LESEPROFIL`)
- Oberfläche: `web/beleg/` (`uebernahme.ts` reine Logik, `BelegPanel.tsx`, `BelegAblage.tsx`, `BelegAnsicht.tsx`, `BelegNeuDialog.tsx`, `LeseprofileTab.tsx`), eingebunden in `AuftragDetail.tsx`, `AuftraegeListe.tsx`, `eingang/Posteingang.tsx`.
- Tests: `server/test/transport_belegerkennung.test.ts`, `transport_belegabgleich.test.ts`, `transport_beleguebernahme.test.ts` (ohne DB), `transport_belegrouten.test.ts` (Routen, Rechte, Schalter). Die Testbelege sind anonymisierte Nachbauten.

## Später

Vollautomatisches Anlegen aus dem Posteingang (ohne Prüfen) ist bewusst nicht enthalten und käme als eigener Funktionsschalter.

## Bekannte Lücken

- Oberfläche nicht im Browser geprüft.
- Der Routen-Test prüft Rechte, Schalter und Leseprofile, aber keinen vollständig gelesenen Beleg über die Route (Kontakt- und Dublettenabgleich aus der Datenbank).
- Erkennung an OCR-Text der Musterbelege geprüft, nicht an echten PDFs mit Textebene.
