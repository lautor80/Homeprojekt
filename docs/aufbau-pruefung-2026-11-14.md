# Prüfung: Aufbau der Apps, Einstellungen und Schnittstellen (#232) – Stand 14.11.2026

Geprüft wurden das Menü und die Kacheln (`web/src/shell/core.tsx`, `modules/*/web/index.ts`), der
Berechtigungskatalog (`modules/*/server/index.ts`) und alle 54 Apps (13 Administration, 38 TC Oberthal,
3 Euroflex) mit ihren Reitern, Dialogen und Feldern – **im Quelltext, nicht im Browser**.

**Am Programm wurde nichts geändert.** Jede Empfehlung hat ein Kürzel (E1, S1 …). Zum Entscheiden reicht ein
Kommentar im Issue, z. B. „E1 ja, S1 ja, N1 nein, N4 Variante B“. Die Liste zum Abhaken steht in
[Abschnitt 6](#6-entscheidungsliste).

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

Was heute schon gut ist und als Vorbild dient: Zugänge zu Fremdsystemen sind bereits zentral
(`core.verbindungen`, Module melden ihre Verbindungen selbst an); Menü und Startseite kommen aus derselben
Quelle; der Hallenschlüssel am Mitglied ist nur noch Anzeige, gepflegt wird an einer Stelle (#231). Genau diese
drei Muster schlage ich für den Rest vor.

## 2 Ist-Stand

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
| Paperless | Anbindungen | Paperless-Zuordnung · Stammdaten (FI-Felder) · Clubhaus · Instandhaltung · Dokumenteneingang | je App, Upload, Ablagefeld | – |
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
dieselbe Reihenfolge: **Zugang – dann je Bereich die Funktionen – Stand**.

```
Administration → Schnittstellen
[Paperless][E-Mail][EP3][Trainerstunden]
[Ferien][Nextcloud][SAP][API-Schlüssel]

Reiter „Paperless“
  Zugang          Adresse · Token · [Prüfen]
  ─ Portal ─────────────────────────────
  Ablageregeln    (heute Paperless-Zuordnung)
  ─ TC Oberthal ────────────────────────
  Finanzen        Belegtypen, Pfad, Felder
  Clubhaus        Feld „JSON“
  Instandhaltung  Dokumenttypen, Pfade
  Dokumente       Regeln → Dokumenteneingang
  ─ Euroflex ───────────────────────────
  Aufträge        Auftrag, Kontakt, Rechnung

Reiter „E-Mail“
  Versand         Webhook · [Testmail]
  Absender        Ersatzabsender je Anwendung
  Eingang         Abruf · API-Schlüssel dazu
  ─ Euroflex ───────────────────────────
  Texte           (heute in den Stammdaten)
  Stand           letzte 5 → E-Mail-Protokoll
```

*Anbindungen*, *Paperless-Zuordnung* und *API-Schlüssel* gehen in dieser App auf. Module melden Reiter-Abschnitte
an, wie heute ihre Verbindungen; eine neue Schnittstelle ist ein neuer Reiter.

Abgrenzung zu E1: Was festlegt, **wie mit einem Fremdsystem gesprochen und was dort abgelegt wird**, gehört zur
Schnittstelle. Alles andere ist Einstellung.

*Aufwand:* groß, in Stufen: (1) Reiter statt langer Seite für die heutigen Anbindungen, (2) Paperless-Zuordnung
und API-Schlüssel hinein, (3) verstreute Paperless-Felder aus den Fach-Apps.

#### S2 Nextcloud: ein Zugang statt zwei

**Befund.** *Sicherung* fragt Adresse, Benutzer und App-Passwort der Nextcloud selbst ab; unter *Anbindungen*
gibt es zusätzlich „Nextcloud Dokumentenablage“ mit denselben drei Angaben. Ein geändertes App-Passwort muss an
zwei Stellen nachgezogen werden.

```
Schnittstellen › Nextcloud
  Zugang        Adresse · Benutzer · Passwort
  ─ Portal ──────────────────────────
  Sicherung     Ordner · Uhrzeit · Aufbewahrung
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

„passt“ heißt: Platz im Menü und innerer Aufbau sind stimmig.

### Administration

| App | Befund | Kürzel |
|---|---|---|
| Benutzer | Einladen, Zugangslinks und Zuordnung in einer App – stimmig; Massenzuordnung doppelt mit Platzverwaltung | N3 |
| Rollen | passt; ohne Varianten | B1 |
| Rollenmatrix | passt | – |
| API-Schlüssel | ist eine Schnittstelle (Zugriff von außen), steht getrennt von den Anbindungen | S1 |
| Änderungsbelege | passt; mit E-Mail-Protokoll und Statistik als „Protokolle“ gruppieren | A1 |
| E-Mail-Protokoll | passt; zweite Fassung in Anbindungen | S3 |
| Einstellungen | nur Portal; Anschrift wird nirgends verwendet; Logo nur eines von dreien | E1, E2, E3 |
| Anbindungen | eine lange Seite, alle Systeme untereinander; enthält Ersatzabsender und Mailprotokoll | S1, S3 |
| Paperless-Zuordnung | gehört zur Schnittstelle Paperless | S1 |
| Sperren | passt | A1 |
| Sicherung | enthält eigenen Nextcloud-Zugang | S2 |
| Statistik | passt | A1 |
| Tabellenansicht | passt | A1 |

### TC Oberthal

| App | Befund | Kürzel |
|---|---|---|
| Vereinsübersicht | passt; der Arbeitsvorrat ist die richtige zentrale Stelle für offene Aufgaben | – |
| Präsentationen | passt; Gliederung weicht von der Rollenpflege ab | N6 |
| Vereinskalender | Reiter „Gruppen / Mannschaften“ zeigt die App Mitgliedergruppen eingebettet – bewusst (#16), in Ordnung; Gliederung weicht von der Rollenpflege ab | N6 |
| Stammdaten | mischt Verein, Logo, Hallenabrechnung, FI-Belege, Paperless-Felder und SAP-Übernahme | E1, E2, E4, S1, S4 |
| Kontenstamm | fachliche Liste, gehört zu Finanzen | E5 |
| Produkte | einer von vier Pflegeorten für Preise | N4, E5 |
| Meine Mitgliedschaft | überschneidet sich mit „Meine Daten“ | N1, N2 |
| Mitglieder | passt; Hallenschlüssel nur Anzeige – gutes Muster | – |
| Mitgliedergruppen | passt | – |
| Mitgliedsanträge | passt | – |
| Registrierungen | nur Mitglieder; Hallennutzer liegen in der Platzverwaltung | N3 |
| Mitgliedsbeiträge | fachliche Liste, richtig im Fachbereich | E5 |
| Mitglieder-Analyse | eigene Varianten-Bauart | B1 |
| Spielerdaten (nuLiga) | Import als Reiter | S4 |
| Teilnehmer Jugendtraining | passt | – |
| Schnuppertraining | passt | – |
| Abrechnung Jugendtraining | Reiter Trainer und Entgelte sind Stammdaten; Import als Reiter | E5, S4 |
| Meine Trainingszeiten | eigene Funktion zwischen Verwaltungs-Apps | N1 |
| Hallenpreise | zweiter Pflegeort für Hallenprodukte | N4 |
| Hallenabrechnung | EP3-Import als Knopf – gutes Muster; Einstellungen dazu liegen in den Stammdaten | E1, S4 |
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
| FI-Belege | Bankimport als Dialog; Einstellungen dazu in den Stammdaten | E4, S4 |
| Beitragsforecast | passt | – |
| Einnahmen und Ausgaben | passt | – |
| Jahresabschluss | passt | – |
| Dokumenten-Upload | steht unter Finanzen | N5 |
| Dokumenteneingang | passt; Regeln sind Teil der Schnittstellen E-Mail-Eingang und Paperless (Verweis genügt) | S1 |

### Euroflex

| App | Befund | Kürzel |
|---|---|---|
| Aufträge | passt | – |
| Kontakte | kein eigenes Recht, fehlt im Rechtekatalog | N7 |
| Stammdaten | mischt Einstellungen, fachliche Listen und Datenimport | E1, E2, E5, S4, N7 |

## 5 Abhängigkeiten und Reihenfolge

```
K1–K5 ─┐
A1 ────┼─ sofort, unabhängig
N5 N6 ─┘
S2 S3 ──── unabhängig, klein

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

1. **Aufräumen ohne Umbau:** K1–K5, A1, N5, N6, S3, B4 – ein kleiner Schritt, sofort sichtbar.
2. **Menü für Mitglieder:** N1, danach N2.
3. **Einstellungen:** E1 Rahmen mit Portal und Euroflex, E2, dann TC Oberthal Kapitel für Kapitel (E3, E4).
4. **Schnittstellen:** S1 Rahmen, S2, danach die verstreuten Paperless-Felder, S4.
5. **Fachliche Bereinigung:** E5, N4, N3, N7, B1, B2.

Bei jedem Umzug gilt: Pfade der Apps und Namen der Rechte bleiben, damit Rollen, Lesezeichen, Varianten und
Änderungsbelege weiter passen. Verschoben wird nur, wo etwas angezeigt und gepflegt wird.

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
| S3 | E-Mail-Protokoll nur einmal | klein | ☐ |
| S4 | Importe einheitlich, SAP-Übernahme zu den Schnittstellen | mittel | ☐ |
| A1 | Administration in fünf Gruppen | klein | ☐ |
| N1 | Gruppe „Mein Bereich“ | klein | ☐ |
| N2 | „Meine Daten“ und „Meine Mitgliedschaft“ zusammenlegen | mittel | ☐ |
| N3 | App „Zugänge“ (Registrierungen, Zuordnung, EP3-Abgleich) | mittel | ☐ |
| N4 | Preise an einem Ort – Variante A oder B | mittel / klein | ☐ A ☐ B |
| N5 | Dokumenten-Upload zu „Dokumente“ | klein | ☐ |
| N6 | Menü und Rollenpflege gleich gliedern, mit Test | klein | ☐ |
| N7 | Euroflex wie TC Oberthal aufbauen | klein–mittel | ☐ |
| B1 | Varianten: eine Bauart | mittel | ☐ |
| B2 | Reiter für Teile, Umschalter für Sichten | klein | ☐ |
| B3 | Zahnrad statt Reiter „Einstellungen“ | klein | ☐ |
| B4 | Icons eindeutig | klein | ☐ |
| K1–K5 | Texte berichtigen | klein | ☐ |

Aufwand: *klein* = ein Schritt ohne Datenänderung · *mittel* = mehrere Dateien, ggf. eine Migration ·
*groß* = neuer Rahmen im Kern, Umsetzung in mehreren Schritten.
