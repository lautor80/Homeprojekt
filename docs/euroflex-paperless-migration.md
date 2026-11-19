# Euroflex: Dokumente zum Auftrag über das Custom Field „Auftrag“ und Migration lokaler Auftragsordner

## Verknüpfung Auftrag ↔ Paperless

Ein Paperless-Dokument gehört zu einem Euroflex-Auftrag, wenn

* es im Portal verknüpft ist (Tabelle `transport.auftrag_dokumente`, wie bisher), **oder**
* sein Custom Field **„Auftrag“** (Text) die Auftragsnummer nennt. Mehrere Nummern stehen durch Komma getrennt darin
  (z. B. Sammelrechnung `2026_0150, 2026_0153`); gezählt werden nur genaue Treffer.

Das Feld legt das Portal in Paperless an, falls es fehlt. Gesetzt wird es durch die Standardregeln der Ablagekontexte
(Administration → Schnittstellen → Paperless → Ablageregeln, Bereich Euroflex):

| Kontext | Feld „Auftrag“ |
|---|---|
| Dokument zum Auftrag, Transportauftrag, Lieferschein | `{auftragsnr}` |
| Ausgangsrechnung (ZUGFeRD-PDF) | `{auftraege}` – alle Aufträge der Rechnung, damit die Rechnung bei jedem Auftrag erscheint |
| Migration lokaler Auftragsordner | `{auftragsnr}` |

Wer eine Ablageregel mit eigenen Custom Fields gespeichert hat, ersetzt damit die Standardfelder – dort „Auftrag“ bei Bedarf ergänzen.

## Im Auftrag (Abschnitt Dokumente)

* Die Liste zeigt alle Dokumente beider Wege, jedes einmal, neueste zuerst (Dokumentdatum aus Paperless). Nur über das
  Feld zugeordnete tragen den Hinweis „über Feld „Auftrag““; „Zuordnung lösen“ gibt es nur für Portal-Verknüpfungen.
* **Klick auf den Namen** öffnet ein Popup: links die **Vorschau** (archivierte Fassung aus Paperless – PDF auch für Bilder und
  Office-Dateien), rechts die **Kommentare** (Notizen in Paperless) mit Eingabe für einen neuen Kommentar (Recht Aufträge bearbeiten),
  dazu „In Paperless öffnen“ und „Herunterladen“ (Original).
* Der Pfeil-Knopf in der Zeile öffnet das Dokument direkt in der Paperless-Oberfläche (interne Ablage-Adresse).
* Die Sprechblase mit Zahl zeigt die Anzahl der Kommentare.
* Über das Feld zugeordnete Dokumente lassen sich auch als Anhang der E-Mail zum Auftrag verwenden.
* Ist Paperless nicht erreichbar, erscheinen die Portal-Verknüpfungen mit einem Hinweis.

Endpunkte: `GET /api/m/transport/auftraege/:nr/dokumente` (zusammengeführte Liste), `GET …/dokumente/:id/datei[?vorschau=1]`,
`GET`/`POST …/dokumente/:id/notizen`. Paperless-Suche über `custom_field_query=["Auftrag","icontains",nr]`
(ältere Paperless-Fassungen: `custom_fields__icontains`), danach genaue Prüfung im Portal.

## Migration lokaler Auftragsordner

Administration → Schnittstellen → Reiter **Paperless** → **Euroflex: Migration lokaler Auftragsordner**
(Recht `transport.import:execute`, Chrome oder Edge am PC).

1. **Ordner wählen** – z. B. den bisherigen Ablageordner `…/Jahr/Auftragsnummer/…`. Das Programm durchsucht alle Unterordner
   (nur lesend). Systemdateien (`Thumbs.db`, `desktop.ini`, `~$…`, versteckte) werden ausgelassen.
2. **Regel:** Ein Ordner, der nach der Auftragsnummer benannt ist, gibt diese Nummer an **jede Datei darunter** weiter –
   auch in Unterordnern (`2026/2026_0153/Eingang/Fotos/x.jpg` → `2026_0153`). Maßgeblich ist der oberste solche Ordner.
   Als Auftragsordner gilt ein Ordnername, der im Portal ein Auftrag ist, oder der mit `JJJJ_NNNN` beginnt (auch mit Zusatz,
   z. B. „2026_0153 Holz Müller“). Ordner, deren Nummer es im Portal nicht gibt, werden nur mit dem Häkchen
   „auch Ordner, deren Auftrag es im Portal nicht gibt“ übertragen.
3. **Testen:** „Testlauf: 1 Datei“ überträgt die erste offene Datei der (gefilterten) Liste; jede Zeile hat außerdem „Übertragen“.
   Mit dem Filter (z. B. `2026_0153`) und „Gefilterte übertragen“ lässt sich ein einzelner Auftrag testen. Danach den Auftrag
   über den Link in der Spalte Auftrag öffnen und prüfen.
4. **Alle übertragen** – nacheinander, „Anhalten“ stoppt nach der laufenden Datei. Die Seite bleibt dabei geöffnet.

Je Datei (Kontext „Migration lokaler Auftragsordner“, anpassbar in den Ablageregeln):

* Titel `Auftrag {auftragsnr} – Dateiname`, Korrespondent = Kunde des Auftrags, Tag „Migration“,
* **Dokumentdatum = Datum der Datei im lokalen Ordner** – der Browser gibt nur das *Änderungsdatum* der Datei heraus, das
  Erstelldatum ist für Webseiten nicht lesbar. Beim Kopieren unter Windows bleibt das Änderungsdatum erhalten, das Erstelldatum
  nicht – es ist daher meist das verlässlichere Datum.
* Custom Field „Auftrag“ = Auftragsnummer, Notiz „Übernommen aus dem Ablageordner: <Pfad>“,
* bei bekannten Aufträgen zusätzlich Verknüpfung im Portal (Änderungsbeleg `DOKUMENT_MIGRATION`).

**Wiederholen ist gefahrlos:** Kennt Paperless die Datei schon (Dublette), wird kein zweites Dokument angelegt, sondern die
Auftragsnummer im Feld „Auftrag“ des vorhandenen Dokuments ergänzt. Meldet Paperless „verarbeitet noch“ (große Office-Dateien),
die Datei später erneut übertragen – dann wird das Feld nachgetragen.

Dateitypen wie bei „Dokumente zum Auftrag“ (pdf, Bilder, txt, csv, doc/docx, xls/xlsx, eml); andere (z. B. `.msg`, `.zip`)
werden angezeigt, aber nicht übertragen.

Code: `modules/transport/web/PaperlessMigration.tsx`, Regeln `modules/transport/web/migration-logik.ts`,
Server `POST /migration/pruefen`, `POST /migration/datei` in `modules/transport/server/index.ts`,
Feldlogik `modules/transport/server/paperless-auftrag.ts`; Test `server/test/transport_paperless_auftrag.test.ts`.
