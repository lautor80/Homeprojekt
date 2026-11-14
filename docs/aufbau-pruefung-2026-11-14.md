# Prüfung: Aufbau der Apps, Einstellungen und Schnittstellen (#232) – Stand 14.11.2026

Geprüft wurden das Menü und die Kacheln (`web/src/shell/core.tsx`, `modules/*/web/index.ts`), der
Berechtigungskatalog (`modules/*/server/index.ts`) und alle 54 Apps (13 Administration, 38 TC Oberthal,
3 Euroflex) mit ihren Reitern, Dialogen und Feldern – **im Quelltext, nicht im Browser**.

**Am Programm wurde nichts geändert.** Jede Empfehlung hat ein Kürzel (E1, S1 …). Zum Entscheiden reicht ein
Kommentar im Issue, z. B. „E1 ja, S1 ja, N1 nein, N4 Variante B“. Die Liste zum Abhaken steht in
[Abschnitt 6](#6-entscheidungsliste).

**Überarbeitet am 14.11.2026** nach den Kommentaren im Issue: Paperless hat je Bereich einen eigenen Zugang (neu
**S5**, S1 angepasst), alle Ereignisse landen im Arbeitsvorrat (neu **V1–V3**), jede Funktion lässt sich vom
Administrator abschalten (neu **F1**), und vor dem Umbau gibt es einen Sicherungspunkt mit beschriebenem
Rückweg: [sicherungspunkt-2026-11-14.md](sicherungspunkt-2026-11-14.md).

## 1 Kurzfassung

1. **Einstellungen liegen an 12 Stellen in 4 Bauarten** – eigene App, Reiter, Zahnrad-Dialog, Feldgruppe in
   einer Fach-App. Sie stehen im Baum Euroflex, im Baum TC Oberthal und in der Administration. → **E1**
2. **Drei Logos an drei Stellen** (Oberfläche, Kopfband Verein, Ausdrucke Euroflex). → **E2**
3. **Dieselben Daten werden doppelt gepflegt:** IBAN des Vereins (Stammdaten und Gläubigerdaten), Nextcloud-Zugang
   (Sicherung und Anbindungen), Zuordnung Benutzer ↔ Mitglied (Benutzer und Platzverwaltung), Produktpreise
   (vier Pflegeorte auf demselben Produktstamm). → **E3, S2, N3, N4**
4. **Schnittstellen sind nach Technik verteilt, nicht nach Schnittstelle:** Wer „alles zu Paperless“ sucht, braucht
   heute sechs Stellen (Anbindungen, Paperless-Zuordnung, Stammdaten, Clubhaus, Instandhaltung,
   Dokumenteneingang). → **S1**
5. **Eigene Funktionen der Mitglieder stehen zwischen den Verwaltungs-Apps**, verteilt auf fünf Gruppen mit je
   ein bis zwei Apps. → **N1**
6. **Paperless ist heute genau eine Verbindung für alle Bereiche.** Euroflex und TC Oberthal legen damit
   zwangsläufig im selben Paperless ab. → **S5**
7. **Der Arbeitsvorrat gehört zum Modul TC Oberthal und kennt nicht alle Ereignisse:** Es fehlen unter anderem der
   Dokumenteneingang, unzustellbare E-Mails, Kündigungen und Beitragswechsel der Mitglieder, Fehler der
   Schnittstellen und alles aus Euroflex. → **V1–V3**
8. **Einzelne Funktionen lassen sich nicht abschalten.** Es gibt nur ganze Module (`PORTAL_MODULES` in der `.env`,
   mit Neustart) und Rechte je Rolle. EP3-Import, Bankimport oder „Geldkonto tauschen“ sind da, sobald jemand das
   Recht hat. → **F1**

### Vorgaben für den Umbau

Diese vier Punkte sind entschieden (Kommentare vom 14.11.2026) und gelten für jede Empfehlung unten:

| Vorgabe | Bedeutung |
|---|---|
| **Paperless je Bereich** | Jeder Bereich (TC Oberthal, Euroflex, künftige) hat seinen eigenen Paperless-Zugang. Zwei Bereiche zeigen nie auf dieselbe Adresse. |
| **Alles in den Arbeitsvorrat** | Jedes Ereignis, das jemand erledigen oder wissen muss, erscheint im Arbeitsvorrat – auch nach jedem Umzug einer Funktion. |
| **Funktionen abschaltbar** | Jede Funktion (EP3-Import, Bankimport, Umbuchung …) lässt sich vom Administrator abschalten und ist dann nirgends mehr zu sehen. |
| **Sicherungspunkt** | Vor dem Start ein fester Stand von Programm und Daten; jeder Umbauschritt einzeln zurücknehmbar. |

Was heute schon gut ist und als Vorbild dient: Zugänge zu Fremdsystemen sind bereits zentral
(`core.verbindungen`, Module melden ihre Verbindungen selbst an); Menü und Startseite kommen aus derselben
Quelle; der Hallenschlüssel am Mitglied ist nur noch Anzeige, gepflegt wird an einer Stelle (#231). Genau diese
drei Muster schlage ich für den Rest vor.

## 2 Ist-Stand

Stand vor dem Umbau (14.11.2026). Was inzwischen umgesetzt ist, steht in [Abschnitt 7](#7-umsetzungsstand).

```
Start
Euroflex
  Aufträge
  Kontakte
  Stammdaten            ← Einstellungen
TC Oberthal
  Vereinsübersicht
  Präsentationen
  Vereinskalender
  Einstellungen         ← Einstellungen
    Stammdaten · Kontenstamm · Produkte
  Mitglieder       (7 Apps)
  Sport            (1)
  Jugend           (4)
  Tennishalle      (7)
  Clubhaus         (4)
  Instandhaltung   (2)
  Finanzen         (6)
  Dokumente        (1)
Administration
  Benutzerverwaltung
    Benutzer · Rollen · Rollenmatrix
  API-Schlüssel
  Änderungsbelege
  E-Mail-Protokoll
  Einstellungen         ← Einstellungen
  Anbindungen
  Paperless-Zuordnung
  Sperren
  Sicherung
  Statistik
  Tabellenansicht
```

## 3 Empfehlungen

### E – Einstellungen

#### E1 Eine App „Einstellungen“ in der Administration, mit Kapiteln je Anwendung

**Befund.** Einstellungen stehen heute hier:

| Wo | Was | Bauart |
|---|---|---|
| Administration → Einstellungen | Name, Logo, Akzentfarbe, Anschrift, Portal-Adresse | eigene App |
| Administration → Anbindungen | Ersatzabsender je Anwendung | Feldgruppe |
| Administration → Sicherung | Nextcloud-Export: Zugang, Uhrzeit, Aufbewahrung | Feldgruppe |
| TC Oberthal → Einstellungen → Stammdaten | Verein und Bank, Logo, Hallenabrechnung, FI-Belege | eigene App |
| Finanzen → Sollstellungen | Gläubigerdaten | Feldgruppe |
| Clubhaus → Clubhausabrechnung | Wirtin, Konten, Reinigung, Provision | Reiter |
| Clubhaus → Verzehrbuch | Mindestbetrag, Fristen, Konten, Hinweistext | Reiter |
| Tennishalle → Hallenschlüssel | Spielregeln, Fristen, Kassenkonto | Zahnrad-Dialog |
| Instandhaltung → Stammdaten | E-Mail Vorstand, Löschfrist Fotos, Paperless-Auswahl | Reiter, unterster Abschnitt |
| Euroflex → Stammdaten → Firmendaten | Firma, Bank, Logo, Auftragsbedingungen | Reiter |
| Euroflex → Stammdaten → E-Mail-Texte | Texte | Reiter |
| Stammdaten beider Module | Übernahme aus SAP | Reiter |

**Empfehlung.** Eine App *Administration → Einstellungen*. Links die Kapitel, rechts der Inhalt. Jede Anwendung
ist ein Kapitel mit Unterkapiteln; ein weiteres Modul bringt sein Kapitel selbst mit – so wie Module heute schon
ihre Anbindungen anmelden (`ServerModule.verbindungen`), künftig `WebModule.einstellungen`.

```
Administration → Einstellungen
┌──────────────────┬──────────────────────┐
│ Portal           │ TC Oberthal ›        │
│   Allgemein      │ Verein und Bank      │
│   Erscheinungsb. │                      │
│ TC Oberthal      │ Name     [.........] │
│ ▸ Verein u. Bank │ Straße   [.........] │
│   Tennishalle    │ IBAN     [.........] │
│   Clubhaus       │ BIC      [.........] │
│   Finanzen       │                      │
│   Instandhaltung │                      │
│ Euroflex         │                      │
│   Firma u. Bank  │                      │
│   Aufträge       │                      │
│   E-Mail-Texte   │           [Sichern]  │
└──────────────────┴──────────────────────┘
```

Inhalt der Kapitel (alles vorhandene Felder, nur neu einsortiert):

- **Portal:** Allgemein (Name, Portal-Adresse) · Erscheinungsbild (E2)
- **TC Oberthal:** Verein und Bank (mit Gläubigerdaten, E3) · Tennishalle (Hallenabrechnung, Hallenschlüssel) ·
  Clubhaus (Clubhausabrechnung, Verzehr) · Finanzen (FI-Belege, Kontenfindung E4) · Instandhaltung
- **Euroflex:** Firma und Bank · Aufträge (Auftragsbedingungen, Rechnungsnummer, USt) · E-Mail-Texte

Die Rechte bleiben, wie sie sind: Ein Kapitel sieht nur, wer das heutige Recht hat (`tco.stammdaten:edit`,
`tco.verzehr:admin`, `tco.schluessel:admin`, `transport.stammdaten:edit` …). Der Kassenwart ohne
Administratorrolle sieht dann in der Administration genau diese eine App mit seinen Kapiteln.

In den Fach-Apps bleibt ein Zahnrad, das direkt in das passende Kapitel springt. So findet man die Einstellung
von beiden Seiten, gepflegt wird sie an einer.

*Aufwand:* groß, aber in Stufen: (1) Rahmen mit Kapiteln und Portal/Euroflex, (2) TC Oberthal Verein und Bank,
(3) je Fachbereich ein Schritt. Nach jeder Stufe ist das Portal benutzbar.

#### E2 Kapitel „Erscheinungsbild“: alle Logos an einer Stelle

**Befund.** Logo der Oberfläche in *Administration → Einstellungen*, Logo des Kopfbands in *TC Oberthal →
Stammdaten*, Logo der Ausdrucke in *Euroflex → Stammdaten*. Drei Formate, drei Größenregeln, drei Stellen.

```
Einstellungen › Portal › Erscheinungsbild
  Akzentfarbe          [■ #0a6ed1]
  Logos
  ┌─────────────┬──────────────┬─────────┐
  │ Verwendung  │ Anwendung    │ Logo    │
  ├─────────────┼──────────────┼─────────┤
  │ Oberfläche  │ Portal       │ [Bild]  │
  │ Kopfband    │ TC Oberthal  │ [Bild]  │
  │ Ausdrucke   │ Euroflex     │ [Bild]  │
  └─────────────┴──────────────┴─────────┘
  je Zeile: ablegen · entfernen · Vorschau
```

Ein neues Modul meldet seine Logo-Verwendung an und erscheint als weitere Zeile. *Aufwand:* klein bis mittel
(die drei Speicherorte können bleiben, nur die Pflege zieht um). Setzt den Rahmen aus E1 voraus – oder als
Zwischenlösung ein Abschnitt „Logos“ in der heutigen App.

#### E3 Doppelt gepflegte Angaben zusammenführen

| Angabe | Stelle 1 | Stelle 2 | Vorschlag |
|---|---|---|---|
| IBAN und BIC des Vereins | Stammdaten → Verein | Sollstellungen → Gläubigerdaten | ein Kapitel „Verein und Bank“; die Sollstellung liest von dort und zeigt nur an |
| Name der Organisation | Administration → Einstellungen | Stammdaten → Verein (Name) | bleibt getrennt (Portalname ≠ Rechnungssteller), aber nebeneinander in E1 |
| Anschrift | Administration → Einstellungen „Anschrift (für Ausdrucke)“ | Stammdaten → Verein, Euroflex → Firmendaten | Feld der Administration **entfernen** – es wird von keinem Ausdruck gelesen |

Bei der IBAN ist zu klären, ob Rechnungskonto und Lastschriftkonto bewusst verschieden sein dürfen. Wenn ja:
zwei Felder im selben Kapitel, klar benannt. *Aufwand:* klein (Anschrift) bis mittel (IBAN, mit Migration).

#### E4 Kontenfindung als ein Unterkapitel

**Befund.** Welches FI-Konto ein Vorgang bebucht, steht an fünf Stellen: Stammdaten (Konten mit/ohne
Bankdatei), Clubhaus-Einstellungen (Einzahlungen, Wareneingang), Verzehr-Einstellungen (Erlös, Forderung),
Hallenschlüssel-Einstellungen (Kassenkonto), Sollstellungen (Bankkonto FI) – dazu das Erlöskonto je Produkt.

```
Einstellungen › TC Oberthal › Finanzen
Kontenfindung
  Vorgang                        Konto
  Bankimport (mit Datei)         ....
  Kasse / ohne Bankdatei         ....
  Lastschrift (Bankkonto)        ....
  Clubhaus Einzahlungen          ....
  Clubhaus Wareneingang          ....
  Verzehr Erlös / Forderung      .... / ....
  Hallenschlüssel Kasse          ....
  Erlöskonto je Produkt          → Produkte
```

Eine Tabelle, jede Zeile mit Auswahl aus dem Kontenstamm. Der Kassenwart sieht auf einen Blick, wohin gebucht
wird. *Aufwand:* mittel. Ergibt sich fast von selbst, wenn E1 für den Bereich Finanzen umgesetzt wird.

#### E5 Feste Regel: Was ist „Einstellung“, was „Stammdaten“?

**Befund.** „Stammdaten“ heißt heute fünferlei: App TC Oberthal, App Euroflex, Reiter in der Instandhaltung,
Reiter am Mitglied, Reiter am Kontakt. „Einstellungen“ heißt eine Menügruppe, eine App, zwei Reiter und ein
Dialog. Fachliche Listen liegen mal unter *Einstellungen* (Kontenstamm, Produkte), mal im Fachbereich
(Mitgliedsbeiträge, Hallenpreise, Trainer und Entgelte, Orte und Kategorien, Plätze).

**Empfehlung.**

| Begriff | Bedeutung | Ort |
|---|---|---|
| **Einstellungen** | steuert das Verhalten, ändert sich selten, pflegt Administrator oder Kassenwart | Administration → Einstellungen (E1) |
| **Stammdaten** | fachliche Listen, die im Betrieb wachsen: Produkte und Preise, Konten, Beiträge, Plätze, Trainer, Orte | im Fachbereich, immer als **letzter Reiter „Stammdaten“** oder letzte App der Gruppe |

```
TC Oberthal
  Finanzen
    … · Kontenstamm
  Mitglieder
    … · Mitgliedsbeiträge
  Tennishalle
    … · Produkte und Preise
  Jugend › Abrechnung Jugendtraining
    Zeiten │ Woche │ Abrechnung │ Stammdaten
    (Stammdaten = Trainer, Entgelte)
Euroflex
  Aufträge
  Kontakte
  Produkte und Wertelisten
```

Die Menügruppe *TC Oberthal → Einstellungen* und die App *Euroflex → Stammdaten* entfallen damit; in keinem
Fachbaum steht mehr „Einstellungen“. *Aufwand:* mittel (Menü, Rechtekatalog, Texte; keine Datenänderung).

### S – Schnittstellen

#### S1 Bereich „Schnittstellen“: ein Reiter je Schnittstelle, darin nach Bereich und Funktion

**Befund.** Heute ist nach Technik sortiert (Zugänge hier, Regeln dort, Protokoll woanders):

| Schnittstelle | Zugang | Regeln und Felder | Auslösen | Protokoll |
|---|---|---|---|---|
| Paperless | Anbindungen – **eine** Verbindung für alle Bereiche | Paperless-Zuordnung · Stammdaten (FI-Felder) · Clubhaus · Instandhaltung · Dokumenteneingang | je App, Upload, Ablagefeld | – |
| E-Mail-Versand | Anbindungen | Ersatzabsender (Anbindungen) · Texte (Euroflex-Stammdaten) | je App | E-Mail-Protokoll **und** Anbindungen |
| E-Mail-Eingang | API-Schlüssel · Anbindungen („jetzt abrufen“) | Dokumenteneingang → Regeln | Dokumenteneingang | Dokumenteneingang |
| EP3 | Anbindungen | – | Hallenabrechnung (Knopf) | Dialog |
| Trainerstunden | Anbindungen | – | Abrechnung Jugendtraining → Import | – |
| Schulferien | Anbindungen | – | Abrechnung Jugendtraining | – |
| Nextcloud | Anbindungen **und** Sicherung | Dokumenteneingang → Regeln | Sicherung | Sicherung |
| SAP-Übernahme | Datei | – | Stammdaten TC Oberthal · Stammdaten Euroflex | – |
| nuLiga, Bank | Datei | Stammdaten (Konten mit Bankdatei) | Spielerdaten · FI-Belege | – |
| Zugriff von außen | API-Schlüssel | – | – | – |

**Empfehlung.** Eine App *Administration → Schnittstellen* mit einem Reiter je Schnittstelle. In jedem Reiter
steht **je Bereich ein Block**, immer in derselben Reihenfolge: **Zugang – Funktionen – Stand**. Der Zugang gehört
zum Bereich, nicht zum Portal (S5); nur was wirklich für alle gilt, steht in einem Block „Portal“.

```
Administration → Schnittstellen
[Paperless][E-Mail][EP3][Trainerstunden]
[Ferien][Nextcloud][SAP][API-Schlüssel]

Reiter „Paperless“
  ═ TC Oberthal ════════════════════════
  Zugang          Adresse · Token · [Prüfen]
                  Adresse für Freigabelinks
  Ablageregeln    FI-Beleg, Mitglied, Halle …
  Finanzen        Belegtypen, Pfad, Felder
  Clubhaus        Feld „JSON“
  Instandhaltung  Dokumenttypen, Pfade
  Dokumente       Regeln → Dokumenteneingang
  Stand           erreichbar · letzte Ablage
  ═ Euroflex ═══════════════════════════
  Zugang          eigene Adresse · Token
                  Adresse für Freigabelinks
  Ablageregeln    Auftrag, Kontakt, Rechnung
  Stand           erreichbar · letzte Ablage

Reiter „E-Mail“
  Versand         Webhook · [Testmail]
  Absender        Ersatzabsender je Anwendung
  Eingang         Abruf · API-Schlüssel dazu
  ─ Euroflex ───────────────────────────
  Texte           (heute in den Stammdaten)
  Stand           letzte 5 → E-Mail-Protokoll
                  Fehler → Arbeitsvorrat (V1)
```

*Anbindungen*, *Paperless-Zuordnung* und *API-Schlüssel* gehen in dieser App auf. Module melden Reiter-Abschnitte
an, wie heute ihre Verbindungen; eine neue Schnittstelle ist ein neuer Reiter.

Abgrenzung zu E1: Was festlegt, **wie mit einem Fremdsystem gesprochen und was dort abgelegt wird**, gehört zur
Schnittstelle. Alles andere ist Einstellung.

Die Zeile „Stand“ zeigt dasselbe, was bei einem Fehler im Arbeitsvorrat steht (V1) – eine Quelle, zwei
Anzeigen.

*Aufwand:* groß, in Stufen: (1) Reiter statt langer Seite für die heutigen Anbindungen, (2) Paperless je Bereich
(S5), (3) Paperless-Zuordnung und API-Schlüssel hinein, (4) verstreute Paperless-Felder aus den Fach-Apps.

#### S2 Nextcloud: ein Zugang statt zwei

**Befund.** *Sicherung* fragt Adresse, Benutzer und App-Passwort der Nextcloud selbst ab; unter *Anbindungen*
gibt es zusätzlich „Nextcloud Dokumentenablage“ mit denselben drei Angaben. Ein geändertes App-Passwort muss an
zwei Stellen nachgezogen werden.

```
Schnittstellen › Nextcloud
  Zugang        Adresse · Benutzer · Passwort
  ─ Portal ──────────────────────────
  Sicherung     Ordner · Uhrzeit · Dauer
  ─ TC Oberthal ─────────────────────
  Dokumente     Ordner der Arbeitsablage
```

*Aufwand:* klein bis mittel (Migration übernimmt den vorhandenen Zugang). Auch ohne S1 sinnvoll.

#### S3 E-Mail-Protokoll nur einmal

**Befund.** Das Protokoll gibt es als App *E-Mail-Protokoll* und noch einmal unten in *Anbindungen* beim
E-Mail-Versand – zwei Listen, jede mit eigenen Filtern. **Empfehlung:** In den Anbindungen nur „letzte 5“
und ein Link zur App. *Aufwand:* klein.

#### S4 Importe: gleiche Stelle, gleicher Knopf

**Befund.** Sieben Importe in drei Bauarten: Knopf mit Dialog (EP3, Bankimport, Altdaten Hallenschlüssel),
Reiter in der Fach-App (Jugendtraining „Import“, Spielerdaten „Abgleich mit nuLiga“), Reiter in den Stammdaten
(SAP, je einmal für TC Oberthal und Euroflex).

**Empfehlung.** Laufende Importe bleiben in der Fach-App, dort wo man das Ergebnis braucht – aber immer als
Knopf **„Importieren“ oben rechts** mit demselben Ablauf (Quelle wählen → Prüfen → Übernehmen → Protokoll).
Einmalige Übernahmen (SAP, Altdaten) ziehen nach *Schnittstellen → SAP* mit Abschnitten TC Oberthal und Euroflex.

```
Abrechnung Jugendtraining      [Importieren ▾]
  Zeiten │ Woche │ Abrechnung │ Stammdaten

  Importieren
   1 Quelle     ○ n8n   ○ Datei
   2 Prüfen     12 neu · 2 geändert · 0 Fehler
   3 Übernehmen           [Übernehmen]
```

*Aufwand:* mittel (gemeinsamer Import-Dialog im Kern, dann App für App).

#### S5 Paperless: eigener Zugang je Bereich

**Befund.** Im Kern gibt es genau eine Verbindung `paperless` – im Quelltext ausdrücklich „eine Verbindung für
Kern und alle Module“. TC Oberthal (`modules/tco/server/verein.ts`) und Euroflex
(`modules/transport/server/data.ts`) lesen beide diesen einen Zugang. Auch zwei Funktionen des Kerns hängen daran:
die Auswahllisten der Paperless-Zuordnung und das Umschreiben der Freigabelinks beim E-Mail-Versand.

**Vorgabe.** Je Bereich ein eigener Zugang; zwei Bereiche zeigen nie auf dieselbe Adresse.

```
Heute                    Vorgabe
Paperless (eine)         Paperless TC Oberthal
  ↑        ↑               ↑
 TCO   Euroflex           TCO
                         Paperless Euroflex
                           ↑
                          Euroflex
```

Was sich dadurch ändert:

| Teil | Heute | Künftig |
|---|---|---|
| Zugang | `paperless` im Kern | je Bereich: `tco.paperless`, `transport.paperless`; ein neues Modul bringt seinen mit |
| Adresse für Freigabelinks | eine | je Bereich |
| Paperless-Zuordnung | Auswahllisten aus dem einen Paperless | je Ablagekontext aus dem Paperless seines Bereichs (die Kontexte gehören schon heute zu einem Modul) |
| E-Mail-Versand | schreibt Freigabelinks mit der einen Adresse um | nimmt die Adresse des Bereichs, aus dem die E-Mail kommt |
| Ablagefeld, Dokumenten-Upload, Dokumenteneingang | TC Oberthal | TC Oberthal (unverändert, nur anderer Zugang) |
| Prüfung beim Sichern | – | dieselbe Adresse in zwei Bereichen wird abgelehnt |
| Sicherung | `backup.sh` sichert das Paperless im Stack | ein zweites Paperless braucht seine eigene Sicherung |

Dokumenttypen, Korrespondenten, Speicherpfade und Custom Fields sind je Paperless verschieden. Deshalb stehen
im Reiter „Paperless“ (S1) alle Regeln und Felder unter dem Bereich, zu dem sie gehören – nie darüber.

**Umzug der heutigen Werte.** Der vorhandene Zugang wird beim Update auf einen Bereich übertragen; der andere
ist danach „nicht eingerichtet“, bis seine Adresse eingetragen ist. Der alte Eintrag bleibt stehen, bis der
Schritt abgenommen ist. **Offen:** Welcher Bereich behält das heutige Paperless – TC Oberthal (Annahme) oder
Euroflex? Und liegen dort heute schon Dokumente des anderen Bereichs, die umziehen müssen?

Dasselbe Muster (Zugang je Bereich) trägt der Rahmen aus S1 auch für E-Mail und Nextcloud, falls das später
gewünscht ist; vorgegeben ist es nur für Paperless.

*Aufwand:* mittel (Kern: Verbindung je Modul, zwei Kernfunktionen mit Bereich; Migration; Tests). Lässt sich vor
S1 umsetzen – dann als zwei Einträge in den heutigen Anbindungen.

### V – Arbeitsvorrat

#### V1 Jedes Ereignis landet im Arbeitsvorrat

**Befund.** Der Arbeitsvorrat wird bei jedem Aufruf aus dem aktuellen Stand berechnet
(`modules/tco/server/dashboard/arbeitsvorrat.ts`). Was dort keine eigene Abfrage hat, erscheint nicht.

| Ereignis | Im Arbeitsvorrat? | Heute sichtbar |
|---|---|---|
| Schadensmeldung, Hallenschlüssel ohne Quittung | ja | – |
| Registrierung, Mitgliedsantrag, Vertragswechsel | ja | – |
| Schnuppertraining, Zeitnachweis Trainer | ja | – |
| Hallenbuchungen heute, Halle aufsperren, Hallenabo | ja | – |
| Verzehr: Gastbelege, überfällig, Monatsabschluss | ja | – |
| Upload „Überweisung an Einreicher“ | ja | – |
| Nextcloud-Export der Sicherung fehlgeschlagen | ja | – |
| Dokumenteneingang: zu prüfen, Fehler | **nein** | Kachelzahl, Prüfliste |
| E-Mail nicht gesendet, unzustellbar, Antwort | **nein** (nur beim Hallenabo) | E-Mail-Protokoll |
| Kündigung, Beitragswechsel, Jugendtraining durch das Mitglied | **nein** | Notiz am Mitglied, E-Mail-Kopie |
| EP3-Import, Trainerstunden, Schulferien: Abruf scheitert | **nein** | Meldung in der App, solange sie offen ist |
| Paperless eines Bereichs nicht erreichbar | **nein** | Fehlermeldung beim Ablegen |
| Alles aus Euroflex | **nein** | – |

Die Zeilen mit „nein“ sind am Quelltext geprüft. Bei der Umsetzung kommt jede App noch einmal an die Reihe
(z. B. Preisfehler in der Hallenabrechnung, Bankimport, ablaufende API-Schlüssel).

**Empfehlung.** Eine Regel und zwei Arten von Einträgen:

| Art | Bedeutung | Verschwindet, wenn |
|---|---|---|
| **Aufgabe** | jemand muss etwas tun (prüfen, freigeben, zahlen) | der Vorgang erledigt ist |
| **Hinweis** | jemand muss etwas wissen (Kündigung ausgeführt, Import gescheitert) | abgehakt („gesehen“) oder die Ursache behoben ist |

```
Arbeitsvorrat
 Kassenwart (5)
  ● Mitgliedsantrag …
  ● 3 Dokumente im Eingang zu prüfen     neu
  ○ Kündigung zum 31.12. ausgeführt  ☐   neu
 Administration (2)
  ▲ EP3-Abruf gescheitert                neu
  ▲ 2 E-Mails unzustellbar               neu
 Euroflex (1)
  ▲ Paperless Euroflex nicht erreichbar  neu

 ● Aufgabe   ○ Hinweis   ▲ Fehler
```

Nicht in den Arbeitsvorrat gehört, was nur Verlauf ist: jede einzelne gesendete E-Mail, jede Anmeldung, jede
Feldänderung. Dafür gibt es E-Mail-Protokoll, Statistik und Änderungsbelege. **Offen:** Reicht diese Grenze,
oder soll wirklich jedes Ereignis als Hinweis erscheinen?

*Aufwand:* mittel (je Lücke eine Quelle; Fehler der Schnittstellen müssen dafür festgehalten werden, statt nur
in der App zu erscheinen).

#### V2 Arbeitsvorrat in den Kern, für alle Bereiche

**Befund.** Der Arbeitsvorrat ist Teil der *Vereinsübersicht* und verlangt deren Recht
(`tco.dashboard:display`). Wer nur Euroflex bedient oder dieses Recht nicht hat, hat keinen. Ereignisse der
Administration (Sicherung) stehen in einer Liste des Vereinsmoduls.

**Empfehlung.** Der Arbeitsvorrat wird eine Funktion des Kerns auf der Startseite. Jedes Modul meldet seine
Quellen an (`ServerModule.arbeitsvorrat`), so wie heute Anbindungen und künftig Einstellungen. Jeder sieht die
Einträge, deren App er bedienen darf – ein eigenes Recht braucht es nicht.

```
Start
┌ Arbeitsvorrat ───────────────────────┐
│ Portal │ TC Oberthal │ Euroflex      │
│ ▲ …      ● …           ● …           │
└──────────────────────────────────────┘
  Kacheln …

Kern        Administration, Schnittstellen
TC Oberthal Quellen wie heute + Lücken (V1)
Euroflex    neu
```

Die Vereinsübersicht zeigt weiter ihren Ausschnitt (TC Oberthal). Der rote Zähler am Menüeintrag wandert zu
*Start*. *Aufwand:* mittel.

**Umgesetzt (14.11.2026).** Die Startseite zeigt über den Kacheln den Arbeitsvorrat, je Anwendung einen Block
(*Portal*, *TC Oberthal*; bei nur einer Anwendung ohne Zusatz im Titel). Abruf `GET /api/arbeitsvorrat`
(nur Anmeldung nötig), Sammelstelle `server/src/lib/arbeitsvorrat.ts`, Baustein der Oberfläche
`web/src/components/Arbeitsvorrat.tsx`. Der Eintrag „Sicherung in die Nextcloud“ kommt jetzt vom Kern (Gruppe
*Portal*) und steht nicht mehr in der Vereinsübersicht. Kann eine Anwendung ihre Einträge nicht liefern,
bleiben die anderen sichtbar und ein roter Eintrag nennt die Störung. Euroflex meldet noch keine Quellen an –
das gehört zu V1.

#### V3 Absichern, dass beim Umbau nichts verloren geht

**Befund.** Jeder Eintrag verweist fest auf eine App, teils auf einen Reiter (`/tco/platzverwaltung`,
`/tco/verzehrbuch?tab=belege`, `/admin/sicherung`). Zieht eine Funktion um (E1, S1, N3), zeigt der Eintrag ins
Leere, ohne dass es jemand merkt.

**Empfehlung.** Drei Prüfungen, die bei jedem Umbauschritt automatisch laufen:

| Prüfung | Schützt vor |
|---|---|
| Jeder Pfad eines Eintrags ist eine vorhandene Seite | toten Verweisen nach einem Umzug |
| Jede Schnittstelle und jeder automatische Lauf hat eine Quelle im Arbeitsvorrat | stillen Fehlern |
| Jeder Eingang von außen (Formular, Registrierung, E-Mail, Selbstvorgang) hat eine Quelle | vergessenen Vorgängen |

```
Umbauschritt ─► CI
   ├─ Pfade der Einträge vorhanden?
   ├─ Schnittstelle ohne Quelle?
   └─ Eingang ohne Quelle?
 rot ─► kein Merge
```

*Aufwand:* klein bis mittel. **Gehört an den Anfang**, vor E1, S1 und N3.

**Umgesetzt (14.11.2026):** `server/test/arbeitsvorrat_absicherung.test.ts` läuft in der CI bei jedem Schritt.

- *Pfade:* Jeder Verweis eines Eintrags muss eine vorhandene Seite sein, ein `?tab=…` ein vorhandener Reiter.
- *Quellen:* Der Test leitet aus dem Quelltext ab, was Ereignisse auslösen kann – jede Anbindung, jeden
  automatischen Lauf, jede Route ohne Anmeldung, jede Meldung (Schaden, n8n) und jede ändernde Route der
  Selbstbedienung. Jede davon muss in `modules/tco/server/dashboard/ereignisquellen.ts` entschieden sein: mit
  Eintrag im Arbeitsvorrat, als offener Punkt oder mit Begründung, warum es keinen braucht.
- *Sperrklinke:* Stand heute 44 Quellen, davon 13 mit Eintrag, 13 begründet ohne, **18 offen** (das ist die
  Arbeitsliste für V1). Die Zahl der offenen Punkte darf nur sinken; eine neue Quelle ohne Entscheidung lässt die
  CI scheitern.

### F – Funktionen ein- und ausschalten

#### F1 Funktionsschalter in der Administration

**Befund.** Heute gibt es zwei Hebel, keiner passt:

| Hebel | Wirkt auf | Grenze |
|---|---|---|
| `PORTAL_MODULES` in der `.env` | ganzes Modul (TC Oberthal, Euroflex) | nur auf dem Server, mit Neustart, nichts Feineres |
| Rechte je Rolle | wer eine App oder Aktion nutzen darf | beantwortet „wer“, nicht „gibt es das hier“; der Administrator sieht immer alles; ein Recht bündelt oft mehrere Funktionen |

Beispiele für die Bündelung: `tco.halle:edit` erlaubt Buchungen zuordnen, Rechnungen bearbeiten **und** EP3
importieren; `tco.fi:buchen` erlaubt Bankimport **und** manuelle Buchungen (darunter die Umbuchung zwischen
Geldkonten). Den EP3-Import allein kann man heute nur ausblenden, indem man beides entzieht.

**Vorgabe.** Jede Funktion ist abschaltbar; abgeschaltet heißt: nicht mehr angezeigt. Gepflegt vom Administrator.

**Empfehlung.** Ein Verzeichnis aller Funktionen. Jedes Modul meldet seine Funktionen an
(`ServerModule.funktionen`), in vier Stufen: Anwendung → Bereich → App → Funktion. Der Administrator schaltet
auf jeder Stufe; „aus“ gilt für alles darunter.

```
Administration › Einstellungen › Funktionen
  TC Oberthal                      [an ]
    Tennishalle                    [an ]
      Hallenabrechnung             [an ]
        EP3-Import                 [aus]
        Sammelversand              [an ]
    Finanzen                       [an ]
      FI-Belege                    [an ]
        Bankimport                 [aus]
        Umbuchung                  [aus]
        Geldkonto tauschen         [aus]
  Euroflex                         [an ]
    Datenimport                    [aus]
```

**„Aus“ heißt überall aus** – nicht nur der Knopf:

| Stelle | Wirkung |
|---|---|
| Menü, Kacheln, Reiter, Knöpfe | nicht mehr sichtbar, auch nicht für Administratoren |
| Server | die Endpunkte der Funktion antworten wie „nicht vorhanden“ – Ausblenden allein wäre kein Schutz |
| Automatische Läufe und Eingänge von außen | laufen nicht bzw. werden abgewiesen |
| Einstellungen (E1), Schnittstellen (S1) | Kapitel bzw. Reiter-Abschnitt der Funktion verschwindet |
| Arbeitsvorrat (V1) | keine Einträge der Funktion |
| Rollenpflege | Rechte der Funktion grau mit Hinweis „abgeschaltet“; die Zuordnung bleibt erhalten |
| Daten | bleiben unverändert; „an“ stellt alles wieder her |

Verhältnis zu den Rechten: Der Schalter entscheidet, **ob es die Funktion in dieser Installation gibt**; das
Recht, **wer sie nutzt**. Sichtbar ist sie nur, wenn beides zutrifft. Die Rechte müssen dafür nicht neu
geschnitten werden.

Abhängigkeiten zeigt die Pflege vor dem Abschalten an („Bankimport aus – dort wird heute die Gutschrift der
Sollstellungen verbucht“). Jede Schaltung schreibt einen Änderungsbeleg. Die Pflege hat ein eigenes
Recht (`core.funktionen:edit`); sie selbst und die Benutzerverwaltung sind nicht abschaltbar.

Erste Liste der Funktionen unterhalb der Apps – aus Rechten, Knöpfen und Reitern im Quelltext, bei der
Umsetzung je App zu vervollständigen:

| Bereich | Funktionen |
|---|---|
| Tennishalle | EP3-Import · EP3-Abgleich · Sammelrechnung · Sammelversand · Versand per WhatsApp · Abo-Bewerbung · Online-Quittung Hallenschlüssel · Altdaten Hallenschlüssel |
| Finanzen | Bankimport · manuelle Buchung und Umbuchung · Geldkonto tauschen · Storno · Periodenabschluss · Lastschriftlauf |
| Mitglieder | Online-Mitgliedsantrag · Registrierung · Einladung per QR-Code · Beitragswechsel, Jugendtraining, Kündigung durch das Mitglied · nuLiga-Abgleich |
| Jugend | Import Trainerstunden · Anmeldeformular Schnuppertraining |
| Clubhaus | Theke · Mein Verzehr · Monatsabschluss |
| Instandhaltung | Meldung per QR-Code · Platz sperren |
| Dokumente | Dokumenteneingang · Ablage in die Nextcloud · Ablagefeld |
| Euroflex | Rechnung erstellen · Rechnung entfernen · Versand · Datenimport |
| Portal | Registrierung auf der Anmeldeseite · Benutzer wechseln · Werte ändern in der Tabellenansicht |

Damit „alle Funktionen“ auch künftig gilt: eine Prüfung in der CI, dass jede App und jeder Import im
Verzeichnis steht (wie V3). `PORTAL_MODULES` bleibt als Schalter der Installation bestehen.

**Offen:** Reicht die Liste oben als Feinheit, oder soll jeder einzelne Knopf schaltbar sein? Sollen
abgeschaltete Funktionen in der Rollenpflege grau stehen (Annahme) oder ganz verschwinden?

*Aufwand:* mittel bis groß, in Stufen: (1) Verzeichnis, Pflege und Schalter für Apps, (2) Funktionen innerhalb
der Apps, Bereich für Bereich. **Früh umsetzen** – die Rahmen für Einstellungen (E1), Schnittstellen (S1) und
Arbeitsvorrat (V2) fragen den Schalter dann von Anfang an ab.

**Umgesetzt (14.11.2026) – Rahmen, alle Apps und die ersten Funktionen.** Pflege unter *Administration →
Einstellungen → Funktionen* (Recht `core.funktionen:edit`).

| Stufe | Abschaltbar | Woher |
|---|---|---|
| Anwendung | TC Oberthal, Euroflex | von selbst (Rechtekatalog) |
| Bereich | alle Bereiche der beiden Anwendungen | von selbst |
| App | alle Apps; in der Administration alle außer Benutzer, Rollen, Einstellungen, Funktionen, Sicherung | von selbst – eine neue App ist ohne Zutun abschaltbar |
| Funktion | siehe unten | vom Modul angemeldet (`ServerModule.funktionen`) |

Einzelne Funktionen der ersten Lieferung:

| App | Funktion | Wirkt über |
|---|---|---|
| Hallenabrechnung | EP3-Import (mit Abgleich) · Automatisch zuordnen · Rechnung ohne Buchung · Sammelversand · Versand per WhatsApp | Routen |
| Hallenabrechnung | Rechnungen drucken und versenden (alle Wege) | Recht |
| Hallenschlüssel | Altdaten einfügen | Routen |
| Platzverwaltung | EP3-Abgleich | Routen |
| Sollstellungen | Lastschriftlauf | Recht |
| Spielerdaten (nuLiga) | Abgleich mit nuLiga | Recht |
| Dokumenteneingang | E-Mail-Eingang über n8n | Recht (API-Schlüssel) |
| Vereinsübersicht | Beitragsstufenwechsel Jugend → Erwachsene | Recht |
| Aufträge (Euroflex) | Rechnungen erstellen · Rechnungen entfernen · Versand | je ein Recht |
| FI-Belege | Bankimport | Route und Prüfung beim Buchen |
| FI-Belege | Manuelle Buchung und Umbuchung | Prüfung beim Buchen |
| FI-Belege | Geldkonto tauschen · Storno · Perioden abschließen | je ein Recht |
| Abrechnung Jugendtraining | Import Trainerstunden | Routen |
| Stammdaten (TC Oberthal) | Übernahme aus SAP | Recht |
| Stammdaten (Euroflex) | Datenimport aus SAP | Recht |
| Tabellenansicht | Werte ändern · Datensätze löschen | je ein Recht |
| Mitgliedsanträge | Online-Mitgliedsantrag (`/beitritt`) | Routen, Seite zeigt Hinweis |
| Schnuppertraining | Anmeldeformular (`/schnuppertraining`) | Routen, Seite zeigt Hinweis |
| Registrierungen | Registrierung auf der Anmeldeseite (mit Bestätigungslink) | Routen, Knopf verschwindet |
| Mitglieder | Einladung annehmen (`/einladung`) | Routen – **kein eigener Schalter**, nur mit der App |
| Hallenschlüssel | Online-Quittung (`/schluessel-quittung`) | Routen – **kein eigener Schalter**, nur mit der App |

Öffentliche Formulare (seit 14.11.2026): Sie hängen an keinem Recht und liefen deshalb weiter, auch wenn ihre App
aus war. Jetzt sind sie als Funktionen angemeldet: Der Server nimmt nichts mehr an, die Seite zeigt statt des
Formulars „Dieses Angebot steht zurzeit nicht zur Verfügung“, auf der Anmeldeseite verschwindet „Registrieren“.
Einladung und Schlüssel-Quittung haben keinen eigenen Schalter, damit bereits verschickte Links gültig bleiben,
solange es die App gibt. In der App *Mitgliedsanträge* steht ein Hinweis, wenn das Formular aus ist; neue
Vertragsangebote lassen sich dann nicht erstellen (sie könnten nicht bestätigt werden).

So wirkt „Aus“:

- **Rechte:** Die Rechte des Knotens hat niemand mehr, auch der Administrator nicht (zentrale Prüfung im Server und
  in der Oberfläche). Rechte, die eines davon voraussetzen, fallen mit weg – die Pflege nennt diese Apps vor dem
  Abschalten und markiert sie danach als „nicht nutzbar“.
- **Anzeige:** Menü, Startseite und Seiten (auch über die Adresszeile) verschwinden; Knöpfe und Reiter einzelner
  Funktionen ebenfalls. Offene Sitzungen gleichen sich innerhalb einer Minute an.
- **Server:** Routen abgeschalteter Funktionen antworten mit 403 „abgeschaltet“.
- **Läufe:** Abo-Lauf und Lauf der Instandhaltung ruhen, wenn ihre App aus ist. Die Sperre ausgetretener Mitglieder
  ruht nur, wenn das ganze Vereinsmodul aus ist (Schutzfunktion).
- **Arbeitsvorrat:** Einträge hängen an Rechten und entfallen damit.
- **Rollenpflege:** abgeschaltete Rechte stehen grau mit Hinweis; die Zuordnung bleibt.
- **Änderungsbeleg** je Schaltung (Objekt „Funktionsschalter“).

Tests: `server/test/funktionen.test.ts` (Wirkung, mit Datenbank) und `server/test/funktionen_verzeichnis.test.ts`
(jede angemeldete Funktion hat eine App, ihre Rechte und Routen gibt es, sie wirkt im Server und wird in der
Oberfläche abgefragt).

**Noch offen bei F1:**

- Funktionen, die mehrere Apps berühren und deshalb einen eigenen Schritt brauchen: Abo-Bewerbung (Platz buchen,
  Platzverwaltung, Lauf, Arbeitsvorrat), Kündigung und Beitragswechsel durch das Mitglied, Monatsabschluss Verzehr,
  Platz sperren aus einer Schadensmeldung, Ablagefeld, Benutzer wechseln;
- Kapitel der Einstellungen (E1), Reiter der Schnittstellen (S1) und der Arbeitsvorrat im Kern (V2) fragen den
  Schalter ab, sobald es sie gibt;
- Apps, die Daten einer abgeschalteten App nur anzeigen, ohne deren Recht ausdrücklich vorauszusetzen, zeigen
  diese Daten dann nicht mehr (Meldung „abgeschaltet“). Die Pflege weist darauf hin, kann sie aber nicht einzeln
  nennen.

### A – Administration

#### A1 Administration in fünf Gruppen

**Befund.** Zehn Einträge stehen lose untereinander, nur die Benutzerverwaltung ist gruppiert; die Reihenfolge
folgt keiner erkennbaren Logik.

```
Administration
  Benutzer und Rechte
    Benutzer · Rollen · Rollenmatrix
  Einstellungen            (E1)
  Schnittstellen           (S1)
  Protokolle
    Änderungsbelege · E-Mail-Protokoll
    Statistik
  System
    Sicherung · Sperren · Tabellenansicht
```

Aus 13 Einträgen werden 11 in 5 Gruppen. *Aufwand:* klein (nur Menü und Rechtekatalog). Sofort machbar, auch
bevor E1 und S1 fertig sind.

### N – Navigation der Fachbereiche

#### N1 Gruppe „Mein Bereich“

**Befund.** Was ein Mitglied, Hallennutzer oder Trainer für sich selbst tut, steht verteilt zwischen den Apps der
Verwaltung. Leere Gruppen blendet das Menü zwar aus, übrig bleiben aber mehrere Gruppen mit je einer App.

```
Heute
TC Oberthal
  Vereinskalender
  Mitglieder     › Meine Mitgliedschaft
  Jugend         › Meine Trainingszeiten
  Tennishalle    › Platz buchen, Meine Daten
  Clubhaus       › Mein Verzehr
  Instandhaltung › Schaden melden

Vorschlag
TC Oberthal
  Mein Bereich
    Meine Mitgliedschaft
    Platz buchen
    Mein Verzehr
    Meine Trainingszeiten
    Schaden melden
  Vereinskalender
  Mitglieder …   (nur noch Verwaltung)
```

Für Vorstand und Kassenwart enthalten die Fachgruppen danach nur noch Verwaltung. *Aufwand:* klein (Menü und
Rechtekatalog; Pfade und Rechte bleiben).

#### N2 „Meine Daten“ und „Meine Mitgliedschaft“ zusammenlegen

**Befund.** *Tennishalle → Meine Daten* pflegt Anschrift, E-Mail und Telefon – auch für Mitglieder (die App
zeigt dann die Mitgliedsnummer). *Mitglieder → Meine Mitgliedschaft* pflegt dieselben Kontaktdaten und mehr.
Zwei Apps, gleiches Icon, überschneidender Inhalt.

```
Mein Bereich › Meine Daten
  Kontakt        (alle)
  Bank           (nur Mitglieder)
  Verträge       (nur Mitglieder)
  Was möchtest du ändern?  (nur Mitglieder)
```

Eine App; Abschnitte erscheinen je nachdem, ob der Benutzer Mitglied oder externer Hallennutzer ist.
*Aufwand:* mittel.

#### N3 Zugänge und Zuordnungen an einer Stelle

**Befund.** Wer einen Zugang freigibt oder zuordnet, findet das an vier Stellen:

| Aufgabe | Heute |
|---|---|
| Registrierung Mitglied freigeben | Mitglieder → Registrierungen |
| Registrierung Hallennutzer freigeben | Tennishalle → Platzverwaltung → Zugänge |
| Benutzer ↔ Mitglied zuordnen | Administration → Benutzer **und** Platzverwaltung → Benutzer |
| EP3-Kunden mit Benutzern abgleichen | Platzverwaltung → Zugänge → EP3-Abgleich |

```
Mitglieder › Zugänge
  Registrierungen │ Zuordnung │ EP3-Abgleich
  [Mitglieder (3)] [Hallennutzer (1)]
```

Eine App *Zugänge* mit drei Reitern; in *Registrierungen* ein Umschalter Mitglieder/Hallennutzer, sichtbar je
nach Recht. Die Platzverwaltung behält Plätze, Belegung, Training und Abos. In *Administration → Benutzer* bleibt
die Zuordnung im Benutzer-Dialog (ein Benutzer), die Massenpflege liegt in *Zugänge*. *Aufwand:* mittel.

#### N4 Preise: ein Pflegeort

**Befund.** Alle Preise liegen im selben Produktstamm, gepflegt wird an vier Stellen:

```
Einstellungen › Produkte
    alle Produkte
Tennishalle › Hallenpreise
    Halle (000–099)
Clubhausabrechnung › Getränke und Preise
    Getränke (ab 100)
Verzehrbuch › Preisliste
    Speisen, Sonstiges, Gästepreise
```

**Variante A (empfohlen):** Pflege nur in *Produkte und Preise* (Filter Halle, Getränke, Speisen, Sonstiges; der
Wochenplan der Hallenpreise wird dort eine Sicht). Die Fach-Apps zeigen die Preise nur an und haben einen Link
„Preise pflegen“ – dasselbe Muster wie beim Hallenschlüssel am Mitglied.

**Variante B:** Pflege bleibt in den Fach-Apps, *Produkte* wird reine Übersicht ohne Ändern.

```
Variante A
Produkte und Preise
 [Alle][Halle][Getränke][Speisen][Sonstiges]
 Sicht: (Tabelle) (Wochenplan – nur Halle)

Clubhausabrechnung › Getränke
 Getränk   Preis   gültig ab   (nur Anzeige)
                       [Preise pflegen →]
```

*Aufwand:* mittel (A) bzw. klein (B).

#### N5 Dokumente gehören zu Dokumente

**Befund.** *Dokumenten-Upload* steht unter Finanzen, legt aber beliebige Belege in Paperless ab; die Gruppe
*Dokumente* hat nur eine App.

```
Dokumente
  Dokumenteneingang
  Dokumenten-Upload
```

*Aufwand:* klein.

#### N6 Menü und Rollenpflege gleich gliedern

**Befund.** Das Menü soll laut Quelltext „wie die Rollenpflege“ gegliedert sein, weicht aber ab: Der
*Vereinskalender* steht im Menü auf oberster Ebene, in der Rollenpflege unter *Mitglieder*; *Präsentationen* im
Menü oben, in der Rollenpflege unter *Vereinsübersicht*; im Bereich *Einstellungen* stehen die Rechte des
Kontenstamms getrennt (Anzeigen vor, Ändern nach den Produkten). **Empfehlung:** eine Gliederung für beides, und
ein Test, der Menü und Katalog vergleicht. *Aufwand:* klein. Am besten zusammen mit N1 und A1.

#### N7 Euroflex wie TC Oberthal aufbauen

**Befund.** *Kontakte* hat kein eigenes Recht (sichtbar mit „Aufträge anzeigen“) und fehlt als App im
Rechtekatalog; *Stammdaten* mischt Einstellungen (Firma, Bank, Logo, Texte), fachliche Listen (Produkte,
Wertelisten) und eine Schnittstelle (Datenimport).

```
Euroflex
  Aufträge
  Kontakte                  (eigenes Recht)
  Produkte und Wertelisten  (Stammdaten, E5)
Administration
  Einstellungen › Euroflex
    Firma, Bank, Texte
  Schnittstellen › SAP
    Datenimport
```

*Aufwand:* klein bis mittel; ergibt sich aus E1, E5 und S4.

### B – Bedienmuster

#### B1 Varianten: eine Bauart

**Befund.** 31 Apps nutzen die Varianten des Kerns (Kopfzeile der App). Drei Apps haben eine eigene Bauart mit
eigenem Dialog und eigenen Endpunkten: Mitglieder-Analyse, Instandhaltung, Hallenschlüssel. Listen-Apps ohne
Varianten: Sollstellungen, Sperren, API-Schlüssel, Rollen.

```
┌ App-Titel ──── Variante [Standard ▾] ┐
  in jeder Listen-App an derselben Stelle
```

**Empfehlung:** die drei auf die Varianten des Kerns umstellen (gespeicherte Varianten per Migration
übernehmen). *Aufwand:* mittel.

#### B2 Reiter für Teile der App, Umschalter nur für Sichten

**Befund.** *Platz buchen* schaltet seine drei Hauptteile (Kalender, Meine Buchungen, Abo-Bewerbung) mit einem
Umschalter, die *Platzverwaltung* daneben ihre sechs Teile mit Reitern.

| Element | Verwendung |
|---|---|
| Reiter | verschiedene Inhalte der App |
| Umschalter | dieselben Daten anders gezeigt oder gefiltert (Liste/Monat, Alle/Offen) |

*Aufwand:* klein (betrifft vor allem *Platz buchen*).

#### B3 Zahnrad statt Reiter „Einstellungen“

Falls E1 nicht oder nur teilweise kommt: In jeder Fach-App mit eigenen Einstellungen ein **Zahnrad oben rechts**
(wie heute beim Hallenschlüssel), kein Reiter „Einstellungen“ zwischen den Arbeitsreitern. Mit E1 springt das
Zahnrad in das Kapitel. *Aufwand:* klein.

#### B4 Icons eindeutig

| Icon | heute für |
|---|---|
| Zahnrad | Gruppe Einstellungen, App Einstellungen, **Platzverwaltung**, zwei Reiter |
| Person | Meine Mitgliedschaft, Meine Daten |
| Beleg | Hallenabrechnung, Verzehrbuch |
| Schlüssel | API-Schlüssel, Hallenschlüssel |
| Datenbank | Stammdaten (zweimal), Sicherung |

**Empfehlung:** Zahnrad nur für Einstellungen, sonst je App ein eigenes Icon. *Aufwand:* klein.

### K – Kleinigkeiten (Texte, die nicht mehr stimmen)

| Kürzel | Stelle | Heute | Richtig |
|---|---|---|---|
| K1 | Kachel *Stammdaten* (TC Oberthal) | „Verein, Anbindungen, SAP-Übernahme“ | Anbindungen sind zentral |
| K2 | Recht `tco.stammdaten:edit` | „Vereinsdaten und Anbindungen pflegen“ | ohne Anbindungen |
| K3 | Fehlermeldung Euroflex | „Paperless ist nicht eingerichtet (Stammdaten → Firmendaten: URL und API-Token)“ | Administration → Anbindungen |
| K4 | Untertitel *Stammdaten TC Oberthal* | „Vereinsdaten für Ausdrucke, Anbindungen und Übernahme aus SAP“ | ohne Anbindungen |
| K5 | Gruppe und App *Instandhaltung* | gleicher Name, gleiches Icon | App „Schadensmeldungen“ |

*Aufwand:* zusammen klein, unabhängig von allem anderen.

## 4 Durchsicht je App

„passt“ heißt: Platz im Menü und innerer Aufbau sind stimmig. **F1 gilt für jede App** und steht deshalb nicht
in jeder Zeile.

### Administration

| App | Befund | Kürzel |
|---|---|---|
| Benutzer | Einladen, Zugangslinks und Zuordnung in einer App – stimmig; Massenzuordnung doppelt mit Platzverwaltung | N3 |
| Rollen | passt; ohne Varianten | B1 |
| Rollenmatrix | passt | – |
| API-Schlüssel | ist eine Schnittstelle (Zugriff von außen), steht getrennt von den Anbindungen | S1 |
| Änderungsbelege | passt; mit E-Mail-Protokoll und Statistik als „Protokolle“ gruppieren | A1 |
| E-Mail-Protokoll | passt; zweite Fassung in Anbindungen; Fehler und Unzustellbares nicht im Arbeitsvorrat | S3, V1 |
| Einstellungen | nur Portal; Anschrift wird nirgends verwendet; Logo nur eines von dreien | E1, E2, E3 |
| Anbindungen | eine lange Seite, alle Systeme untereinander; enthält Ersatzabsender und Mailprotokoll; Paperless nur einmal für alle Bereiche | S1, S3, S5 |
| Paperless-Zuordnung | gehört zur Schnittstelle Paperless; Auswahllisten aus dem einen Paperless | S1, S5 |
| Sperren | passt | A1 |
| Sicherung | enthält eigenen Nextcloud-Zugang | S2 |
| Statistik | passt | A1 |
| Tabellenansicht | passt | A1 |

### TC Oberthal

| App | Befund | Kürzel |
|---|---|---|
| Vereinsübersicht | der Arbeitsvorrat ist die richtige zentrale Stelle, gehört aber nur zu TC Oberthal und hat Lücken | V1, V2, V3 |
| Präsentationen | passt; Gliederung weicht von der Rollenpflege ab | N6 |
| Vereinskalender | Reiter „Gruppen / Mannschaften“ zeigt die App Mitgliedergruppen eingebettet – bewusst (#16), in Ordnung; Gliederung weicht von der Rollenpflege ab | N6 |
| Stammdaten | mischt Verein, Logo, Hallenabrechnung, FI-Belege, Paperless-Felder und SAP-Übernahme | E1, E2, E4, S1, S4 |
| Kontenstamm | fachliche Liste, gehört zu Finanzen | E5 |
| Produkte | einer von vier Pflegeorten für Preise | N4, E5 |
| Meine Mitgliedschaft | überschneidet sich mit „Meine Daten“; Kündigung und Beitragswechsel erscheinen nicht im Arbeitsvorrat | N1, N2, V1 |
| Mitglieder | passt; Hallenschlüssel nur Anzeige – gutes Muster | – |
| Mitgliedergruppen | passt | – |
| Mitgliedsanträge | passt | – |
| Registrierungen | nur Mitglieder; Hallennutzer liegen in der Platzverwaltung | N3 |
| Mitgliedsbeiträge | fachliche Liste, richtig im Fachbereich | E5 |
| Mitglieder-Analyse | eigene Varianten-Bauart | B1 |
| Spielerdaten (nuLiga) | Import als Reiter | S4 |
| Teilnehmer Jugendtraining | passt | – |
| Schnuppertraining | passt | – |
| Abrechnung Jugendtraining | Reiter Trainer und Entgelte sind Stammdaten; Import als Reiter; Fehler beim Abruf (Stunden, Ferien) nur in der App | E5, S4, V1 |
| Meine Trainingszeiten | eigene Funktion zwischen Verwaltungs-Apps | N1 |
| Hallenpreise | zweiter Pflegeort für Hallenprodukte | N4 |
| Hallenabrechnung | EP3-Import als Knopf – gutes Muster; Einstellungen dazu liegen in den Stammdaten; gescheiterter Abruf nicht im Arbeitsvorrat; EP3-Import nicht einzeln abschaltbar | E1, S4, V1, F1 |
| Hallenschlüssel | Einstellungen im Zahnrad-Dialog; eigene Varianten; Altdaten-Import | E1, B1, S4 |
| Platz buchen | Hauptteile per Umschalter statt Reiter | N1, B2 |
| Meine Daten | überschneidet sich mit „Meine Mitgliedschaft“ | N2 |
| Serienbuchung | passt | – |
| Platzverwaltung | sechs Reiter, davon zwei (Benutzer, Zugänge) nicht zum Thema Platz; Zahnrad-Icon | N3, B4 |
| Clubhausabrechnung | Reiter „Einstellungen“ und „Getränke und Preise“ | E1, E4, N4 |
| Mein Verzehr | eigene Funktion | N1 |
| Theke | passt | – |
| Verzehrbuch | Reiter „Einstellungen“ und „Preisliste“ | E1, E4, N4 |
| Schaden melden | eigene Funktion | N1 |
| Instandhaltung | Reiter „Stammdaten“ enthält auch Einstellungen und Paperless-Auswahl; eigene Varianten; Name wie die Gruppe | E1, S1, B1, K5 |
| Sollstellungen | Gläubigerdaten mit zweiter IBAN des Vereins | E3, E4 |
| FI-Belege | Bankimport als Dialog; Einstellungen dazu in den Stammdaten; Bankimport, Umbuchung und „Geldkonto tauschen“ nicht einzeln abschaltbar | E4, S4, F1 |
| Beitragsforecast | passt | – |
| Einnahmen und Ausgaben | passt | – |
| Jahresabschluss | passt | – |
| Dokumenten-Upload | steht unter Finanzen | N5 |
| Dokumenteneingang | passt; Regeln sind Teil der Schnittstellen E-Mail-Eingang und Paperless (Verweis genügt); Prüfliste und Fehler nicht im Arbeitsvorrat | S1, V1 |

### Euroflex

| App | Befund | Kürzel |
|---|---|---|
| Aufträge | passt; kein Arbeitsvorrat; teilt sich Paperless mit TC Oberthal | V2, S5 |
| Kontakte | kein eigenes Recht, fehlt im Rechtekatalog | N7 |
| Stammdaten | mischt Einstellungen, fachliche Listen und Datenimport | E1, E2, E5, S4, N7 |

## 5 Abhängigkeiten und Reihenfolge

```
Sicherungspunkt ─ vor allem anderen
V3 Prüfungen ──── vor E1, S1, N3
F1 Verzeichnis ── vor E1, S1, V2
K1–K5 ─┐
A1 ────┼─ sofort, unabhängig
N5 N6 ─┘
S2 S3 ──── unabhängig, klein
S5 ─────── vor oder mit S1
V2 Kern ──┬─ V1 Lücken schließen
          └─ Stand-Zeile in S1

E1 Rahmen ──┬─ E2 Logos
            ├─ E3 Verein und Bank
            ├─ E4 Kontenfindung
            └─ B3 Zahnrad springt ins Kapitel
E5 ─────────── N4 Preise · N7 Euroflex
S1 Rahmen ──┬─ S2 Nextcloud (falls noch offen)
            └─ S4 SAP-Übernahme
N1 ─────────── N2 Meine Daten
N3 ─────────── unabhängig
B1 B2 B4 ───── unabhängig
```

Vorschlag für die Reihenfolge:

0. **Sicherungspunkt:** Daten auf dem Server sichern ([Anleitung](sicherungspunkt-2026-11-14.md)).
1. **Absichern:** V3 – die Prüfungen, die jeden weiteren Schritt bewachen.
2. **Aufräumen ohne Umbau:** K1–K5, A1, N5, N6, S3, B4 – ein kleiner Schritt, sofort sichtbar.
3. **Funktionsschalter:** F1 Stufe 1 (Verzeichnis, Pflege, Apps), danach die Funktionen in den Apps.
4. **Arbeitsvorrat:** V2 in den Kern, danach V1 Lücke für Lücke.
5. **Paperless je Bereich:** S5.
6. **Menü für Mitglieder:** N1, danach N2.
7. **Einstellungen:** E1 Rahmen mit Portal und Euroflex, E2, dann TC Oberthal Kapitel für Kapitel (E3, E4).
8. **Schnittstellen:** S1 Rahmen, S2, danach die verstreuten Paperless-Felder, S4.
9. **Fachliche Bereinigung:** E5, N4, N3, N7, B1, B2.

Bei jedem Umzug gilt: Pfade der Apps und Namen der Rechte bleiben, damit Rollen, Lesezeichen, Varianten und
Änderungsbelege weiter passen. Verschoben wird nur, wo etwas angezeigt und gepflegt wird. Jeder Schritt ist ein
eigener PR und damit einzeln zurücknehmbar; zieht eine Funktion um, zieht ihr Eintrag im Arbeitsvorrat mit (V3).

## 6 Entscheidungsliste

| Kürzel | Empfehlung | Aufwand | Entscheidung |
|---|---|---|---|
| E1 | Eine App „Einstellungen“ mit Kapiteln je Anwendung | groß, in Stufen | ☐ |
| E2 | Kapitel „Erscheinungsbild“ mit allen Logos | klein–mittel | ☐ |
| E3 | Doppelte Angaben zusammenführen (IBAN, Anschrift) | klein–mittel | ☐ |
| E4 | Kontenfindung als ein Unterkapitel | mittel | ☐ |
| E5 | Regel Einstellungen/Stammdaten, Gruppe „Einstellungen“ im Fachbaum entfällt | mittel | ☐ |
| S1 | App „Schnittstellen“ mit einem Reiter je Schnittstelle | groß, in Stufen | ☐ |
| S2 | Nextcloud: ein Zugang | klein–mittel | ☐ |
| S3 | E-Mail-Protokoll nur einmal | klein | ☑ umgesetzt |
| S4 | Importe einheitlich, SAP-Übernahme zu den Schnittstellen | mittel | ☐ |
| S5 | Paperless: eigener Zugang je Bereich | mittel | ☑ vorgegeben |
| V1 | Jedes Ereignis in den Arbeitsvorrat, Lücken schließen | mittel | ☑ vorgegeben |
| V2 | Arbeitsvorrat in den Kern, für alle Bereiche | mittel | ☑ umgesetzt |
| V3 | Prüfungen, die den Arbeitsvorrat beim Umbau absichern | klein–mittel | ☑ umgesetzt |
| F1 | Funktionsschalter: jede Funktion vom Administrator abschaltbar | mittel–groß, in Stufen | ☑ Rahmen, Apps und erste Funktionen umgesetzt |
| A1 | Administration in fünf Gruppen | klein | ☑ umgesetzt |
| N1 | Gruppe „Mein Bereich“ | klein | ☐ |
| N2 | „Meine Daten“ und „Meine Mitgliedschaft“ zusammenlegen | mittel | ☐ |
| N3 | App „Zugänge“ (Registrierungen, Zuordnung, EP3-Abgleich) | mittel | ☐ |
| N4 | Preise an einem Ort – Variante A oder B | mittel / klein | ☐ A ☐ B |
| N5 | Dokumenten-Upload zu „Dokumente“ | klein | ☑ umgesetzt |
| N6 | Menü und Rollenpflege gleich gliedern, mit Test | klein | ☑ umgesetzt |
| N7 | Euroflex wie TC Oberthal aufbauen | klein–mittel | ☐ |
| B1 | Varianten: eine Bauart | mittel | ☐ |
| B2 | Reiter für Teile, Umschalter für Sichten | klein | ☐ |
| B3 | Zahnrad statt Reiter „Einstellungen“ | klein | ☐ |
| B4 | Icons eindeutig | klein | ☑ umgesetzt |
| K1–K5 | Texte berichtigen | klein | ☑ umgesetzt |

### Offene Fragen

| Zu | Frage |
|---|---|
| S5 | Welcher Bereich behält das heutige Paperless – TC Oberthal oder Euroflex? Liegen dort Dokumente des anderen Bereichs? |
| S5 | Dieselbe Adresse in zwei Bereichen: ablehnen (Annahme) oder nur warnen? |
| V1 | Aufgaben und Hinweise wie beschrieben – oder wirklich jedes Ereignis, auch reiner Verlauf? |
| F1 | Feinheit: reicht die Liste der Funktionen in F1, oder jeder einzelne Knopf? |
| F1 | Abgeschaltetes in der Rollenpflege: grau mit Hinweis (Annahme) oder ganz weg? |
| E3 | Dürfen Rechnungskonto und Lastschriftkonto des Vereins verschieden sein? |
| N4 | Variante A oder B? |

Aufwand: *klein* = ein Schritt ohne Datenänderung · *mittel* = mehrere Dateien, ggf. eine Migration ·
*groß* = neuer Rahmen im Kern, Umsetzung in mehreren Schritten.

## 7 Umsetzungsstand

| Schritt | Inhalt | Stand |
|---|---|---|
| V3 | Prüfungen für den Arbeitsvorrat (`server/test/arbeitsvorrat_absicherung.test.ts`) | umgesetzt 14.11.2026 |
| K1–K5 | Kachel, Recht und Untertitel der Stammdaten ohne „Anbindungen“; Hinweis „Paperless nicht eingerichtet“ in Euroflex nennt die Anbindungen; App „Instandhaltung“ heißt „Schadensmeldungen“ (Pfad und Rechte unverändert) | umgesetzt 14.11.2026 |
| A1 | Administration in fünf Gruppen | umgesetzt 14.11.2026 – Zwischenstand, siehe unten |
| N5 | Dokumenten-Upload steht unter „Dokumente“ | umgesetzt 14.11.2026 |
| N6 | Rollenpflege in der Reihenfolge des Menüs; lose Apps im Bereich „Allgemein“; Test `server/test/menue_rollenpflege.test.ts` | umgesetzt 14.11.2026 |
| S3 | Anbindungen zeigen Testmail und die letzten 5 Versuche; „Protokoll leeren“ steht in der App E-Mail-Protokoll | umgesetzt 14.11.2026 |
| B4 | Zahnrad nur für Einstellungen, je App ein eigenes Icon (Test) | umgesetzt 14.11.2026 |
| V2 | Arbeitsvorrat auf der Startseite für alle Anwendungen (`GET /api/arbeitsvorrat`, `ServerModule.arbeitsvorrat`); roter Zähler am Menüeintrag *Start*; die Vereinsübersicht zeigt weiter den Ausschnitt TC Oberthal | umgesetzt 14.11.2026 – Quellen für Euroflex folgen mit V1 |
| F1 | Funktionsschalter: Pflege *Administration → Einstellungen → Funktionen*; Anwendungen, Bereiche und alle Apps abschaltbar, dazu 30 einzelne Funktionen einschließlich der öffentlichen Formulare | umgesetzt 14.11.2026 – offen sind Funktionen, die mehrere Apps berühren (siehe F1) |

Menü der Administration nach A1 – bis E1 und S1 fertig sind, ist *Einstellungen* die bisherige App und
*Schnittstellen* eine Gruppe mit den drei bisherigen Apps:

```
Administration
  Benutzer und Rechte
    Benutzer · Rollen · Rollenmatrix
  Einstellungen
    Einstellungen · Funktionen   (seit F1)
  Schnittstellen
    Anbindungen · Paperless-Zuordnung
    API-Schlüssel
  Protokolle
    Änderungsbelege · E-Mail-Protokoll
    Statistik
  System
    Sicherung · Sperren · Tabellenansicht
```

Alle Hinweistexte, Meldungen und die Dokumentation nennen die neuen Wege (z. B. „Administration →
Schnittstellen → Anbindungen“). Pfade der Seiten und Namen der Rechte sind unverändert; Rollen, Lesezeichen und
Varianten passen weiter.

Neue Icons: Platzverwaltung (Karte), Meine Daten (Visitenkarte), Verzehrbuch (Buch), Schadensmeldungen
(Schraubenschlüssel), API-Schlüssel (Schlüssel mit Zahnrad), Sicherung (Schild).

**Nicht im Browser geprüft:** Aussehen des Menüs und der neuen Icons, die Anzeige der letzten Versuche in den
Anbindungen und der Knopf „Protokoll leeren“ im E-Mail-Protokoll. Geprüft sind Typen, Tests und Build in der CI.

