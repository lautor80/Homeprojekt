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
| `transport.versand.rechnung` – Versand: Absender-Postfach je Dokumentart und BCC | – (Einstellungen: `transport.stammdaten:edit`, Versand: `transport.versand:execute`) | alle E-Mails gehen aus dem Postfach des Benutzers und ohne BCC |
| `transport.eingang` – Posteingang | `transport.eingang:display`, `transport.eingang:edit` | App Posteingang fehlt |
| `transport.eingang.n8n` – E-Mail-Eingang über n8n | `transport.eingang:execute` (API-Schlüssel) | Lieferungen von n8n werden abgewiesen, Mails bleiben im Postfach |
| `transport.eingang.automatik` – Automatisch ablegen | – | jede Mail landet in der Prüfliste |
| `transport.dialoge.schliessen` – Versand- und Druckdialoge sofort schließen | `transport.dialoge:execute` | Dialoge bleiben nach dem Auslösen offen und zeigen Ergebnis/Fehler (siehe „Dialoge schließen sofort“) |

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
| Eingang | `postfaecher` | leer | Eingangspostfächer `[{ adresse, bezeichnung }]`, z. B. `info@…` „Info“ und `buchhaltung@…` „Buchhaltung“ – siehe „Mehrere Eingangspostfächer“ |
| Versand | `T`/`L`/`R`.`vorauswahl` | T, L ja; R nein | im Dialog vorausgewählt |
| Versand | `T`/`L`/`R`.`modus` | `entwurf` | `senden` wirkt nur mit Funktion „Automatisch senden“ und Recht |
| Versand | `T`/`L`/`R`.`absender` | leer | festes Absender-Postfach dieser Dokumentart (leer = Postfach des Benutzers) |
| Versand | `T`/`L`/`R`.`bcc` | leer | feste BCC-Adresse(n); die Oberfläche bietet sie nur für die **Rechnung** an (z. B. DATEV-Upload) |

In der Oberfläche steht alles zum Versand in **einem** Abschnitt *Versand*: je Dokumentart Vorauswahl, Modus, Absender-Postfach
und (nur Rechnung) BCC. Der frühere Abschnitt *Rechnungsversand* ist darin aufgegangen.

API: `GET /api/m/transport/workflow-einstellungen` → `{ eingang, versand, rechnung }`; `PUT { eingang, versand }`. `rechnung`
(= Absender/BCC von R, Spalte `rechnung`) wird beim Sichern mitgeschrieben und nur noch für ältere Stände gelesen: Fehlt
`versand.R.absender`, gelten die Werte aus `rechnung`.

## Eingang

### Ablauf

```
Outlook 365 (Eingangspostfach, Ordner aus der n8n-Konfiguration, Standard: Posteingang)
  └─ n8n „Euroflex Maileingang“: Zeitplan 5 min · Webhook „jetzt abrufen“
       Graph: ungelesene Mails + Anhänge  →  POST /api/m/transport/eingang/mail  (Bearer pk_transport_…)
       Antwort { aktion: { ordner } }      →  Mail in den Ordner verschieben, als gelesen markieren
Portal
  1. Idempotenz Postfach + Message-ID; Signatur-Logos, .ics, .vcf, .p7s herausfiltern
  2. OCR lokal (Einstellung ocr): PDF → pdftotext; gescanntes PDF ohne Text → pdftoppm (3 Seiten, 200 dpi) + Tesseract; Bild → Tesseract
  3. Zuordnung (eingang/logik.ts, reine Funktionen) – je Auftrag Summe der Punkte, höchstens 100
  4. Trefferwert ≥ Schwelle, eindeutig und Funktion „Automatisch ablegen“ an → ablegen, sonst Prüfliste
  5. Ablage am Auftrag (Ablageziel), Mail als PDF zusätzlich
```

### Zuordnung (Punkte)

| Merkmal | Punkte |
|---|---|
| Antwort auf eine eigene Mail: `in_reply_to`/`references` ↔ `core.mail_protokoll.message_id` mit `anwendung` Euroflex, `objekt` = Auftragsnr. (bei `nr-1` Fahrtzusatz abschneiden) | 100 |
| Auftrags- oder Rechnungsnummer `JJJJ_NNNN` (auch `JJJJ-NNNN`, `JJJJ/NNNN`, `JJJJNNNN` nur mit Wortgrenze; im OCR-Text auch `JJJJ NNNN`, weil die Texterkennung den Unterstrich oft als Leerzeichen liest) in Betreff, Mailtext, Dateiname oder OCR-Text – es zählt, wenn es den Auftrag (`auftragsnr`) bzw. die Rechnung (`faktura`) gibt | 90 |
| Ordernummer, Ladenummer (Auftrag oder Stops) oder Rechnungsnummer (`faktura`) in anderem Format – mindestens 4 Zeichen **mit mindestens einer Ziffer** (Platzhalter wie „FOLGT“ oder „Muster“ zählen nicht), mit Wortgrenze | 70 |
| Absender = E-Mail von Kunde, Unternehmer oder Rechnungsempfänger eines **offenen** Auftrags (nicht abgeschlossen, ohne Rechnung bzw. letzte 90 Tage) | 50, wenn genau ein Auftrag; sonst 30 je Kandidat |

**Nummernsuche zuerst:** Die Auftrags-/Rechnungsnummer wird vor allem anderen gesucht. Gibt es einen solchen Treffer (oder ist die
Mail eine Antwort auf eine eigene Mail), bleiben nur diese Aufträge Kandidaten – Referenz- und Absendertreffer anderer Aufträge
fallen weg (für denselben Auftrag zählen sie weiter als Zusatz). Die Begründung nennt **alle Fundstellen**, z. B.
„Rechnungsnummer 2026_0815 (Auftrag 2026_0790) im Betreff und im Dokument „Scan.pdf“ (Texterkennung)“.

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
- Übernahme im Browser: automatisch beim Öffnen des Auftrags, wenn der Ablageordner verbunden und der Zugriff schon erteilt ist
  (sonst Link „Zugriff erlauben und übernehmen“, weil der Browser nur nach einem Klick fragen darf). Nötig sind
  `transport.eingang:edit` und `transport.auftraege:edit`. Gleiche Dateinamen werden nicht überschrieben („Name (2).pdf“).
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

### Absender je Dokumentart und BCC (Rechnung)

Mit der Funktion `transport.versand.rechnung` und eingetragenen Adressen (*Einstellungen → Euroflex → Mail-Workflows → Versand*,
`versand.T/L/R.absender`, `versand.R.bcc`) gilt:

- Jede E-Mail geht aus dem **Absender-Postfach ihrer Dokumentart** hinaus (z. B. Transportauftrag aus `dispo@…`, Rechnung aus
  `buchhaltung@…`); leer = Postfach des Benutzers. Arten mit verschiedenem Absender oder BCC gehen bei „Versenden…“ **nie in einer
  E-Mail zusammen** (`mailsPlanen`, Option `gruppe`). Haben alle gewählten Arten einen festen Absender, braucht der Benutzer kein
  eigenes Postfach.
- Einzeldialog „E-Mail mit Anhängen…“: Absender/BCC der gewählten Vorlage (T, L, R); *Freier Text* aus dem Postfach des Benutzers.
- Jedes Absender-Postfach muss für die n8n-App freigegeben sein ([n8n/EUROFLEX-MAILVERSAND.md](n8n/EUROFLEX-MAILVERSAND.md), 1.2).
- `GET /mail/info` und `GET /versand/einstellungen` liefern `absender: { T, L, R: { absender, bcc[] } }` (und `rechnung` = R).

Für jede E-Mail mit einer Rechnung gilt zusätzlich:

- **Absender** ist das feste Postfach (z. B. `buchhaltung@…`) statt des Postfachs des Benutzers – der Entwurf liegt dann in dessen
  Ordner *Entwürfe*. Das Postfach muss für die n8n-App freigegeben sein ([n8n/EUROFLEX-MAILVERSAND.md](n8n/EUROFLEX-MAILVERSAND.md), 1.2).
- **BCC** an die feste(n) Adresse(n) (z. B. die DATEV-Upload-Adresse). Nur an der E-Mail an den Empfänger, nicht an der Kopie an die
  feste zweite Adresse; im E-Mail-Protokoll steht die BCC-Adresse bei den Empfängern.
- „Versenden…“: Die Rechnung ist immer eine **eigene E-Mail** (nie zusammen mit Lieferschein oder Transportauftrag), zusätzliche
  Dateien aus Ablageordner/Paperless werden nicht angehängt – die DATEV-Upload-Adresse übernimmt jeden Anhang als Beleg.
- Einzeldialog „E-Mail mit Anhängen…“: gilt bei der Vorlage *Rechnung*; der Dialog zeigt Absender und BCC an.
- E-Mail-Dateien (.eml) erhalten `From:` und `Bcc:`. Outlook übernimmt den Absender nur, wenn das Postfach im Outlook des Benutzers
  eingebunden ist.
- Die Adressen stehen **nur in der Datenbank**, nie im (öffentlichen) Repository: Die DATEV-Upload-Adresse ist ein Zugang zum
  Belegeingang.
- Hinweis XRechnung: Wird im Dialog „XRechnung zusätzlich“ gewählt, geht die XML-Datei ebenfalls an die BCC-Adresse. Die
  ZUGFeRD-PDF enthält die Rechnungsdaten bereits – für DATEV genügt sie.

### Modus

Je Mail gilt der Modus der (ersten) Dokumentart aus den Einstellungen. `senden` nur, wenn Funktion
`transport.versand.automatisch` an **und** Recht `transport.versandsenden:execute` vorhanden – sonst `entwurf`. Der Server prüft das,
die Oberfläche zeigt es nur an.

### Schnittstelle (Oberfläche → Portal)

| Methode | Pfad | Recht | Inhalt |
|---|---|---|---|
| GET | `/versand/einstellungen` | versand:execute | `{ vorauswahl, modus, senden_erlaubt, eingerichtet, postfach, kopie_an, max_mb }` – Vorauswahl für den Dialog (ohne Recht auf die Einstellungsseite) |
| POST | `/versand/vorschau` | versand:execute | `{ auftraege: string[], arten: ('T'\|'L'\|'R')[], xrechnung?: boolean }` → `{ mails: [{ schluessel, auftragsnr, fahrt?, rolle: 'unternehmer'\|'kunde'\|'rechnungsempfaenger', empfaenger_name, an, cc, betreff, text, arten, anhaenge: [{ name, groesse }], modus, hinweis?, fehler? }], senden_erlaubt: boolean }` |
| POST | `/versand/ausfuehren` | versand:execute | `{ auftraege, arten, xrechnung?, mails: [{ schluessel, an, cc, betreff, text }], zusatz?: [{ name, mime, inhalt_base64 }], paperless?: number[], nur_entwurf?: boolean }` → `{ ergebnisse: [{ schluessel, status: 'entwurf'\|'gesendet'\|'fehler', text }] }` |
| POST | `/versand/eml` | versand:execute | wie ausführen, liefert `{ dateien: [{ schluessel, name, inhalt_base64 }] }` (EML mit `X-Unsent: 1`) |

Regeln im Detail:
- Der Server rechnet die Vorschau bei „ausführen“ aus `auftraege`/`arten` neu; aus `mails` übernimmt er nur An, CC, Betreff und Text.
- „Gleicher Empfänger“ = gleiche E-Mail-Adresse (ohne Groß-/Kleinschreibung), ohne Adresse gleiche Adressnummer. Zwei Fahrten mit demselben Unternehmer ergeben eine Mail mit beiden Transportaufträgen.
- Eine Rechnungsnummer (auch Sammelrechnung) geht nur einmal hinaus – mit dem ersten ausgewählten Auftrag.
- `nur_entwurf: true` legt alle Mails als Entwurf ab, auch wenn „Senden“ erlaubt wäre.
- Status je Mail richtet sich nach der Mail an den Empfänger; scheitert nur die Kopie an die feste zweite Adresse, nennt der Text den Fehler – erneutes Senden schickt dem Kunden nichts doppelt.
- Zusätzliche Dateien (Ablageordner, Paperless) hängen an jeder Mail; Paperless nur bei genau einem Auftrag.
- In der Auftragsliste ersetzt bei eingeschalteter Funktion ein Menü „E-Rechnung / Paperless“ das alte Menü „Versenden“; ist die Funktion aus, bleibt das alte EML-Menü.

Der Server erzeugt die PDFs selbst (wie `GET /pdf/:art/:id`) und ruft je Mail `euroflexMailSenden` aus `mailversand.ts` auf –
damit gelten Postfach je Benutzer, feste Kopieadresse und E-Mail-Protokoll wie beim Einzelversand. Die Message-IDs im
Protokoll lassen Antworten im Eingang sicher dem Auftrag zuordnen.

## Dialoge schließen sofort

Stand 17.11.2026. Jeder Knopf, der versendet, einen E-Mail-Entwurf erzeugt oder Dokumente herunterlädt, schließt seinen Dialog **sofort**; die Arbeit läuft im Hintergrund weiter, Ergebnis und Fehler erscheinen als Meldung unten im Bild.

| Dialog | Knöpfe |
|---|---|
| *Versenden …* (Sammelversand) | *n Entwürfe erzeugen* / *n E-Mails senden* / *Fehlgeschlagene erneut …*, *Als EML herunterladen* |
| *E-Mail zum Auftrag* | *Senden*, *Entwurf in Outlook*, *E-Mail-Datei* / *Entwurf öffnen*, *Teilen…*, *Ohne Anhänge* |
| *Versenden* (Liste, ohne Outlook 365) | *E-Mail öffnen*, *ohne Anhang*, *PDF herunterladen*, *E-Rechnung (XML)* |
| *PDF-Vorschau* (nach „Drucken“) | *Herunterladen* – lädt bei mehreren Dokumenten **alle** (*Alle herunterladen (n)*) |

- Schlägt etwas fehl, nennt die Meldung Auftrag und Grund (z. B. „2026_1343: Postfach nicht erreichbar“); zum Wiederholen den Dialog erneut öffnen.
- Das Ablegen im Ablageordner beim Öffnen der PDF-Vorschau läuft wie bisher, auch wenn die Vorschau sofort wieder geschlossen wird.
- Ohne den Hinweisdialog zur .eml-Datei: der Hinweis („Dateien dieses Typs immer öffnen“) steht in der Meldung.
- Funktionsschalter `transport.dialoge.schliessen` mit Recht `transport.dialoge:execute` (Migration 014 gibt es jeder Rolle, die Aufträge sieht). Aus bzw. ohne Recht bleiben die Dialoge offen und zeigen Ergebnis und Fehler wie bisher.

## Mehrere Eingangspostfächer

Stand 17.11.2026. Der Eingang kann mehrere Outlook-Postfächer abrufen, z. B. `info@euro-flex.de` und `buchhaltung@euro-flex.de`:

- **n8n** (Knoten *Konfiguration*): `POSTFAECHER = ['info@…', 'buchhaltung@…']` – jedes Postfach wird bei jedem Lauf gelesen;
  verschoben und als gelesen markiert wird im Postfach, aus dem die Mail kam (Zielordner je Postfach). Ein gestörtes Postfach hält
  die anderen nicht auf; der Fehler steht im *Ergebnis* des Laufs. Ältere Konfigurationen mit `POSTFACH` gelten weiter.
- **Portal**: Jede Lieferung trägt `postfach`; der Vorgang behält es (Schlüssel Postfach + Message-ID – dieselbe Mail in zwei
  Postfächern sind zwei Vorgänge). Unter *Einstellungen → Mail-Workflows → Eingang → Eingangspostfächer* bekommt jedes Postfach eine
  Bezeichnung („Info“, „Buchhaltung“).
- **App Posteingang**: Mit mehr als einem Postfach erscheint die Auswahl *Alle Postfächer / Info / Buchhaltung*, und jede E-Mail zeigt,
  in welchem Postfach sie ankam. `GET /eingang/vorgaenge?postfach=…` filtert; die Antwort enthält `postfaecher: [{ adresse, bezeichnung }]`
  (eingetragene, dann bisher gesehene ohne Eintrag).
- Zuordnung und Ablage arbeiten für alle Postfächer gleich.

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
