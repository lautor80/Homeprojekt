# Euroflex – Mail-Workflows Eingang und Ausgang

Zwei Workflows über Outlook 365 und n8n für die Euroflex-Auftragsverwaltung (`modules/transport`):

- **Eingang:** E-Mails aus einem Outlook-365-Postfach werden samt Anhängen ins Portal geholt, lokal per OCR gelesen, dem
  richtigen Auftrag zugeordnet und dort abgelegt – zuerst lokal (Ablageordner des PCs), später in Paperless.
- **Ausgang:** „Versenden…“ neben „Drucken“ erzeugt eine oder mehrere E-Mails mit den ausgewählten Dokumenten als Anhang.
  Standard ist der Entwurf in Outlook; mit dem Schalter „Automatisch senden“ gehen sie direkt raus.

Beide Workflows nutzen die vorhandene Microsoft-365-Anmeldung in n8n (siehe [n8n/EUROFLEX-MAILVERSAND.md](n8n/EUROFLEX-MAILVERSAND.md)).
Für den Eingang braucht die App in Entra zusätzlich **Mail.ReadWrite** für das Eingangspostfach (Lesen und Verschieben) –
siehe [n8n/EUROFLEX-MAILEINGANG.md](n8n/EUROFLEX-MAILEINGANG.md).

## Berechtigungen und Funktionsschalter

| Funktion (Administration → Funktionen) | Recht | Wirkung, wenn aus |
|---|---|---|
| `transport.versand.sammel` – Versenden über Outlook 365 | `transport.versand:execute` | Knopf „Versenden…“ fehlt, Routen `/versand/*` antworten 403 |
| `transport.versand.automatisch` – Automatisch senden | `transport.versandsenden:execute` | jede Mail wird Entwurf, auch wenn die Einstellung „Senden“ sagt |
| `transport.eingang` – Posteingang | `transport.eingang:display`, `transport.eingang:edit` | App Posteingang fehlt |
| `transport.eingang.n8n` – E-Mail-Eingang über n8n | `transport.eingang:execute` (API-Schlüssel) | Lieferungen von n8n werden abgewiesen, Mails bleiben im Postfach |
| `transport.eingang.automatik` – Automatisch ablegen | – | jede Mail landet in der Prüfliste |

Migration `011_mailworkflows.sql` gibt `transport.eingang:display/edit` allen Rollen, die `transport.versand:execute` haben.
`transport.versandsenden:execute` wird bewusst niemandem automatisch gegeben.

## Einstellungen

*Administration → Einstellungen → Euroflex → Mail-Workflows* (Recht `transport.stammdaten:edit`), Tabelle
`transport.workflow_einstellungen`, Typen und Standardwerte in `modules/transport/server/mailworkflows.ts`.

| Bereich | Feld | Standard | Bedeutung |
|---|---|---|---|
| Eingang | `ablageziel` | `lokal` | `lokal` = im Portal bis zur Übernahme in den Ablageordner, `paperless` = Kontext `auftrag.dokument` |
| Eingang | `schwelle` | 80 | ab diesem Trefferwert automatisch ablegen (nur mit Funktion „Automatisch ablegen“) |
| Eingang | `ordnerZugeordnet` / `ordnerPruefen` | `Portal/Zugeordnet` / `Portal/Prüfen` | Outlook-Ordner nach der Verarbeitung |
| Eingang | `mailAlsPdf` | ja | die E-Mail selbst zusätzlich als PDF ablegen |
| Eingang | `ocr` | ja | Texterkennung lokal (pdftotext, Tesseract deu+eng) |
| Eingang | `speicherWarnungMb` | 1024 | Warnung, wenn noch nicht übernommene Dateien mehr belegen |
| Versand | `T`/`L`/`R`.`vorauswahl` | T, L ja; R nein | im Dialog vorausgewählt |
| Versand | `T`/`L`/`R`.`modus` | `entwurf` | `senden` wirkt nur mit Funktion „Automatisch senden“ und Recht |

API: `GET /api/m/transport/workflow-einstellungen` → `{ eingang, versand }`; `PUT` mit demselben Aufbau.

## Eingang

### Ablauf

```
Outlook 365 (Eingangspostfach, Ordner aus der n8n-Konfiguration, Standard: Posteingang)
  └─ n8n „Euroflex Maileingang“: Zeitplan 5 min · Webhook „jetzt abrufen“
       Graph: ungelesene Mails + Anhänge  →  POST /api/m/transport/eingang/mail  (Bearer pk_transport_…)
       Antwort { aktion: { ordner } }      →  Mail in den Ordner verschieben, als gelesen markieren
Portal
  1. Idempotenz Postfach + Message-ID; Signatur-Logos, .ics, .vcf, .p7s herausfiltern
  2. OCR lokal (Einstellung ocr): PDF → pdftotext, bei leerem Text bzw. Bild → Tesseract
  3. Zuordnung (eingang/logik.ts, reine Funktionen) – je Auftrag Summe der Punkte, höchstens 100
  4. Trefferwert ≥ Schwelle, eindeutig und Funktion „Automatisch ablegen“ an → ablegen, sonst Prüfliste
  5. Ablage am Auftrag (Ablageziel), Mail als PDF zusätzlich
```

### Zuordnung (Punkte)

| Merkmal | Punkte |
|---|---|
| Antwort auf eine eigene Mail: `in_reply_to`/`references` ↔ `core.mail_protokoll.message_id` mit `anwendung` Euroflex, `objekt` = Auftragsnr. (bei `nr-1` Fahrtzusatz abschneiden) | 100 |
| Auftragsnummer `JJJJ_NNNN` (auch `JJJJ-NNNN`, `JJJJ/NNNN`, `JJJJNNNN` nur mit Wortgrenze) in Betreff, Text, Dateiname oder OCR-Text, die es als Auftrag gibt | 90 |
| Ordernummer, Ladenummer (Auftrag oder Stops) oder Rechnungsnummer (`faktura`) – mindestens 4 Zeichen, mit Wortgrenze | 70 |
| Absender = E-Mail von Kunde, Unternehmer oder Rechnungsempfänger eines **offenen** Auftrags (nicht abgeschlossen, ohne Rechnung bzw. letzte 90 Tage) | 50, wenn genau ein Auftrag; sonst 30 je Kandidat |

Die Punkte eines Auftrags werden addiert und auf 100 gedeckelt. Die Begründungen (`[{grund, punkte}]`) stehen am Vorgang
und werden in der Prüfliste angezeigt. Liegen zwei Aufträge gleichauf, ist die Zuordnung nicht eindeutig → Prüfliste.

### Schnittstelle für n8n (API-Schlüssel, Recht `transport.eingang:execute`)

`POST /api/m/transport/eingang/mail` (bodyLimit 80 MB, höchstens 40 Anhänge)

```json
{
  "postfach": "auftraege@firma.de",
  "graph_id": "AAMk…",
  "message_id": "<abc@mail.example>",
  "in_reply_to": "<…>", "references": "<…> <…>",
  "von": "Einkauf <einkauf@kunde.de>", "an": "auftraege@firma.de", "betreff": "AW: Lieferschein 2026_0153",
  "datum": "2026-11-17T06:12:00Z",
  "text": "…", "html": "<p>…</p>",
  "anhaenge": [{ "name": "Scan.pdf", "mime": "application/pdf", "inhalt": "<base64>" }]
}
```

Antwort: `{ "vorgang": 12, "status": "abgelegt" | "pruefen" | "ignoriert" | "doppelt", "auftragsnr": "2026_0153" | null,
"aktion": { "ordner": "Portal/Zugeordnet" } }`. Bei `doppelt` (schon verarbeitet) ebenfalls mit `aktion`, damit n8n die Mail
wegräumt.

### Prüfliste und Ablage (Oberfläche)

| Methode | Pfad | Recht | Inhalt |
|---|---|---|---|
| GET | `/eingang/vorgaenge?status=pruefen\|fehler\|abgelegt\|ignoriert` | display | Liste: id, von, von_name, betreff, datum, status, auftragsnr, punkte, anzahl_dokumente |
| GET | `/eingang/vorgaenge/:id` | display | Vorgang mit text, begruendung, kandidaten (mit Kunde/Datum), dokumente (id, art, datei, mime, groesse, status, ziel, ocr_auszug) |
| GET | `/eingang/dokumente/:id/datei` | edit | Dateiinhalt (solange vorhanden), CSP-Sandbox |
| POST | `/eingang/vorgaenge/:id/ablegen` | edit + auftraege:display | `{ auftragsnr, dokumente: number[] }` – legt am Auftrag ab (Ablageziel) |
| POST | `/eingang/vorgaenge/:id/ignorieren` | edit | Vorgang und Dokumente ignorieren, Inhalte löschen |
| POST | `/eingang/vorgaenge/:id/neu-bewerten` | edit | Zuordnung neu berechnen |
| POST | `/eingang/abruf` | edit | offene Vorgänge neu bewerten, n8n-Webhook „jetzt abrufen“ anstoßen (falls eingerichtet) |
| GET | `/eingang/speicher` | display | `{ bytes, dateien, warnungMb, warnung: boolean }` – Belegung durch noch nicht übernommene Inhalte |
| GET | `/auftraege/:nr/eingang` | auftraege:display | Eingangsdokumente am Auftrag: id, datei, mime, groesse, status, ziel, von, betreff, datum |
| POST | `/eingang/dokumente/:id/uebernommen` | auftraege:edit | Browser hat die Datei in den Ablageordner (Unterordner `Eingang/`) geschrieben → Inhalt löschen, Status `uebernommen` |

### Lokale Ablage und Speicher

- Ablageziel `lokal`: Dokumente erhalten Status `wartet`, Inhalt bleibt in `transport.eing_dokumente.inhalt`.
  Öffnet jemand den Auftrag mit verbundenem Ablageordner, schreibt der Browser die wartenden Dateien nach `Eingang/` und meldet
  jede mit `POST /eingang/dokumente/:id/uebernommen` → Inhalt wird gelöscht.
- Ablageziel `paperless`: Ablage über Kontext `auftrag.dokument`, Verknüpfung in `transport.auftrag_dokumente`, Inhalt sofort gelöscht.
- Nicht übernommene Inhalte werden **nie** automatisch gelöscht. Die Belegung zeigt die Einstellungsseite; ab
  `speicherWarnungMb` erscheint eine Warnung (auch im Arbeitsvorrat).
- Dubletten (gleicher sha256 am selben Auftrag) werden nicht erneut abgelegt (Status `dublette`).
- Größenordnung: typische Mail 0,2–2 MB; bei ~20 Mails/Tag ohne Übernahme ~20 MB/Tag. Mit Übernahme liegen nur offene Dateien im Portal.

## Ausgang (Sammelversand)

### Bedienung

*Euroflex → Aufträge* (Liste, eine oder mehrere Zeilen markiert) bzw. Auftragsdetail → **„Versenden…“** neben „Drucken“:

1. Dokumentarten wählen: Transportauftrag (je Fahrt, an den Unternehmer der Fahrt), Lieferschein (an den Kunden), Rechnung mit
   ZUGFeRD (an den Rechnungsempfänger, sonst Kunde; nur bei Aufträgen mit Rechnung), optional XRechnung-XML.
   Vorauswahl aus den Einstellungen.
2. Weitere Auftragsdateien (nur bei einem Auftrag): Paperless-Dokumente des Auftrags und Dateien aus dem Ablageordner.
3. Vorschau: **eine E-Mail je Auftrag und Empfänger**. Mehrere Dokumentarten an denselben Empfänger desselben Auftrags werden zu
   einer E-Mail zusammengefasst (Betreff und Text der ersten Art, Anhänge aller Arten). Empfänger, CC, Betreff, Text je Mail änderbar;
   Zeilen ohne Empfänger-Adresse sind markiert und werden übersprungen.
4. „N Entwürfe erzeugen“ bzw. „N E-Mails senden“. Ergebnis je Mail: Entwurf / gesendet / Fehler; Fehlgeschlagene lassen sich erneut senden.

Ohne eingerichtete Anbindung (oder als Rückfallweg) lädt „Als EML herunterladen“ je Mail eine EML-Datei herunter.

### Modus

Je Mail gilt der Modus der (ersten) Dokumentart aus den Einstellungen. `senden` nur, wenn Funktion
`transport.versand.automatisch` an **und** Recht `transport.versandsenden:execute` vorhanden – sonst `entwurf`. Der Server prüft das,
die Oberfläche zeigt es nur an.

### Schnittstelle (Oberfläche → Portal)

| Methode | Pfad | Recht | Inhalt |
|---|---|---|---|
| POST | `/versand/vorschau` | versand:execute | `{ auftraege: string[], arten: ('T'\|'L'\|'R')[], xrechnung?: boolean }` → `{ mails: [{ schluessel, auftragsnr, fahrt?, rolle: 'unternehmer'\|'kunde'\|'rechnungsempfaenger', an, cc, betreff, text, arten, anhaenge: [{ name, groesse }], modus, fehler? }], senden_erlaubt: boolean }` |
| POST | `/versand/ausfuehren` | versand:execute | `{ mails: [{ schluessel, an, cc, betreff, text }], zusatz?: [{ name, mime, inhalt_base64 }], paperless?: number[] }` → `{ ergebnisse: [{ schluessel, status: 'entwurf'\|'gesendet'\|'fehler', text }] }` |
| POST | `/versand/eml` | versand:execute | wie ausführen, liefert `{ dateien: [{ name, inhalt_base64 }] }` (EML mit `X-Unsent: 1`) |

Der Server erzeugt die PDFs selbst (wie `GET /pdf/:art/:id`) und ruft je Mail `euroflexMailSenden` aus `mailversand.ts` auf –
damit gelten Postfach je Benutzer, feste Kopieadresse und E-Mail-Protokoll wie beim Einzelversand. Die Message-IDs im
Protokoll lassen Antworten im Eingang sicher dem Auftrag zuordnen.

## Dateien

| Datei | Inhalt |
|---|---|
| `modules/transport/server/migrations/011_mailworkflows.sql` | Tabellen, Rechte für bestehende Rollen |
| `modules/transport/server/mailworkflows.ts` | Rechte-, Schalter-Konstanten, Einstellungen |
| `modules/transport/server/eingang/` | `logik.ts` (Zuordnung, rein), `verarbeitung.ts`, `routes.ts` |
| `modules/transport/server/sammelversand.ts` | Vorschau, Ausführen, EML |
| `modules/transport/web/eingang/Posteingang.tsx` | App Posteingang |
| `modules/transport/web/MailWorkflowsTab.tsx` | Einstellungen |
| `modules/transport/web/VersandDialog.tsx` | Dialog „Versenden…“ |
| `docs/n8n/euroflex-maileingang.json`, `docs/n8n/EUROFLEX-MAILEINGANG.md` | n8n-Workflow Eingang |
| `server/test/transport_eingang.test.ts`, `server/test/transport_sammelversand.test.ts`, `server/test/n8n_euroflex_maileingang.test.ts` | Tests |
