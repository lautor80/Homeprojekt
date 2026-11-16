# Projekte – Konzept

Stand: Vorschlag, noch nicht freigegeben. Bedienbares Mockup: [mockup.html](mockup.html).
Der Code-Entwurf der Projekte-App liegt in PR #299 (Entwurf, nicht gemergt) und wird an die Entscheidungen angepasst.

## 1. Ziel

Eine App **Finanzen → Projekte** zu den Projekten des Haushaltsplans (`tco.hh_projekt`). Die Kostenplanung bleibt, wie
sie ist. Dazu kommen Terminplanung mit Gantt-Diagramm, Ressourcenplanung (Arbeitseinsatz der Mitglieder mit externem
Verrechnungssatz, Material mit Preis), der Projektantrag als PDF mit Ablage in Paperless – und die **Rückmeldung der
geleisteten Stunden** durch die Mitglieder selbst.

## 2. Aufbau der App

| Reiter | Inhalt |
|---|---|
| Übersicht | Status, Termine, Kosten, Finanzierung, Arbeitseinsatz (geplant/geleistet), Material; Gantt-Diagramm |
| Kosten und Finanzierung | Kostenplanung des Haushaltsplans (derselbe Dialog), Vergleich mit Material und Eigenleistung |
| Termine | Vorgänge mit Dauer, Vorgängern, Puffer, kritischem Weg; Gantt-Diagramm |
| Ressourcen | Arbeitseinsatz (wer, Stunden, externer Satz) und Material (Menge, Preis, Lieferant, beschafft) |
| Zeiten | Soll-Ist der Stunden je Person, Rückmeldungen bestätigen, für Helfer ohne Zugang erfassen |
| Antrag | PDF im Vereinslayout, Voransicht, Ablage in Paperless |

## 3. Rechenregeln

- Ein Vorgang beginnt, sobald alle Vorgänger fertig sind (plus Abstand), ohne Vorgänger mit dem Projekt; Dauer 0 = Meilenstein.
- Puffer = Tage, um die sich ein Vorgang verschieben darf, ohne das Projektende zu verschieben; ohne Puffer = kritischer Weg.
- Wert der Eigenleistung = Personen × Stunden × externer Verrechnungssatz (was die Arbeit kostete, wenn eine Firma sie ausführte).
- Geleistete Eigenleistung = bestätigte Stunden × Satz der Planzeile der Person, sonst Vorgabe des Projekts.

## 4. Zeiterfassung: „Meine Zeiten“ für Training und Projekte

### Heute
„Meine Trainingszeiten“ (Mein Bereich, Recht `tco.jtmeine:edit`): Der Trainer wird allein aus dem angemeldeten Benutzer
ermittelt, meldet Datum, Trainingsart und Dauer, gibt den Monat frei; daraus entstehen Zeitnachweis und Auszahlung.

### Vorschlag
- **Ein Ort:** Die Zeiterfassung wird der Reiter **Meine Zeiten** in der App **Meine Daten**. Der Menüpunkt
  „Meine Trainingszeiten“ entfällt; die alte Adresse leitet weiter.
- **Zwei Arten von Zeit**, klar getrennt:
  - **Training** – unverändert: Trainingsart, Dauer, Entgelt, Monatsfreigabe, Zeitnachweis, Auszahlung.
  - **Projekt** – neu: Datum, Projekt, optional Vorgang, Stunden, Tätigkeit. Unbezahlt; zählt als Eigenleistung des
    Projekts. Projektstunden erscheinen nie im Zeitnachweis des Trainers und lösen keine Zahlung aus.
- **Zuordnung zum Projekt** ist Pflicht; der Vorgang ist wählbar, wenn das Projekt Vorgänge hat.

### Wer darf was (Berechtigung und Person)

| Rückmeldung | Recht | Person |
|---|---|---|
| Training | `tco.jtmeine:edit` (wie bisher) | Benutzer ist einem Mitglied mit Kennzeichen „Trainer“ zugeordnet |
| Projekt, eigene Stunden | `tco.projektzeiten:edit` (neu, in der Rolle „Mitglied“ vorbelegt) | Benutzer ist einem Mitglied zugeordnet **und** dieses Mitglied ist im Projekt eingeplant – oder das Projekt ist „offen für alle Mitglieder“ |
| Projekt, für andere erfassen und bestätigen | `tco.projekte:edit` | Projektverantwortliche und Planer – auch für Helfer ohne Portalzugang |

- Wählbar sind nur Projekte im Status **genehmigt** oder **in Umsetzung**.
- Keine Schnittstelle nimmt bei „eigene Stunden“ eine Adressnummer entgegen – die Person kommt immer aus der Anmeldung
  (wie heute bei den Trainingszeiten). Fremde Stunden sind weder lesbar noch änderbar.
- Ein Trainer, der auch in einem Projekt mitarbeitet, sieht beide Arten im selben Reiter.
- Wer weder Trainer noch in einem Projekt eingeplant ist, sieht den Reiter mit einem Hinweis statt einer Eingabe.

### Bestätigung
Gemeldete Projektstunden haben den Status **gemeldet**; der Projektverantwortliche **bestätigt** sie (oder weist sie mit
Begründung zurück). Erst bestätigte Stunden zählen im Soll-Ist. Bestätigte Stunden ändert nur noch der Planer.

### Daten
Neue Tabelle `tco.hh_projekt_zeit` (Projekt, optional Vorgang, Mitglied oder Name, Datum, Stunden, Tätigkeit, Status,
erfasst von, bestätigt von/am, Begründung) mit Änderungsbelegen. Die Tabellen des Jugendtrainings bleiben unberührt.

## 5. Offene Entscheidungen

Stehen mit Empfehlung im Mockup (Reiter „Vorschlag“): Kalender- oder Arbeitstage; Material und Kostenplanung;
Eigenleistung im Antrag; Herkunft des Verrechnungssatzes; Selbstanmeldung zu Arbeitseinsätzen; Änderungen nach der
Genehmigung; Bestätigung der Projektstunden; wer auf ein Projekt melden darf; Ort der Zeiterfassung.

## 6. Nicht im ersten Schritt

Pflicht-Arbeitsstunden je Mitglied und Jahr mit Abrechnung, Auslastung über mehrere Projekte, Feiertage im Terminplan,
Bestellungen und Rechnungen zum Material (läuft weiter über FI).
