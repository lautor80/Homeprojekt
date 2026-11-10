# Dokumenteneingang

Eingegangene E-Mails und ihre Anhänge werden nach einem pflegbaren Regelwerk abgelegt. **Das Portal entscheidet und legt ab,
n8n holt die E-Mails und behandelt sie danach** (verschieben, als gelesen markieren, löschen). Eine neue Ablageregel wird in der
App angelegt; der n8n-Workflow bleibt dafür unverändert.

```
IMAP-Postfach ──> n8n: Mail + Anhänge ──> Portal: Regelwerk ──┬─ eindeutig ──> Paperless (+ Nextcloud) ──> n8n: E-Mail behandeln
                                                              └─ unklar ────> Prüfliste (Mensch entscheidet) ──┘
```

## Entscheidungen

| Frage | Entscheidung |
|---|---|
| Wo wird das Regelwerk ausgewertet? | Im Portal, mit eigener Berechtigung. |
| Wer legt ab? | Das Portal selbst, über die zentrale Anbindung „Paperless-ngx“ (Administration → Anbindungen) und die neue Anbindung „Nextcloud Dokumentenablage“. Abweichung vom ersten Konzept („n8n führt aus“): Der Paperless-Client, die Vorlagen der Paperless-Zuordnung und der WebDAV-Client waren im Portal schon vorhanden. |
| Paperless-Instanz | Gültig ist die Instanz im LAN (nicht die Internet-Adresse). Maßgeblich ist die Anbindung „Paperless-ngx“ im Portal – dort muss sie eingetragen sein; n8n spricht Paperless für den Dokumenteneingang nicht mehr direkt an. |
| KI | Keine. Felder werden per Muster (regulärer Ausdruck) aus Betreff, Mailtext, HTML oder Dokumenttext gelesen; Inhalte verlassen das Portal nicht. Mitgliederinformationen gehen damit nie an einen KI-Dienst. |
| Zuordnung über HTML | Der HTML-Teil der E-Mail ist Bedingungsfeld und Quelle für die Extraktion („Mailtext (HTML)“). |
| Mitgliedsanträge | Laufen über das Portal (Mitglieder → Mitgliedsanträge) und sind kein Fall für den Dokumenteneingang. |
| Mehrere Postfächer | „Postfach“ ist Bedingungsfeld und Teil des Vorgangsschlüssels (Postfach + Message-ID). |
| Prüfliste | Dieselbe Berechtigung wie die Pflege des Regelwerks (`tco.eingang:edit`), Rolle „Dokumenteneingang“. |
| Aufgaben | Regeln können eine Folgeaufgabe melden; der Knoten in n8n ist vorhanden, aber deaktiviert. |

## Ablauf

1. n8n liefert jede neue E-Mail mit Anhängen an `POST /api/m/tco/eingang/mail`.
2. Das Portal legt einen **Vorgang** an (Postfach + Message-ID; dieselbe E-Mail wird nie doppelt verarbeitet), ermittelt den
   Korrespondenten (Stammdaten: Adressen und Domains) und – über die Absenderadresse – das Mitglied.
3. Signatur-Logos (Bilder unter 30 KB), Kalender- und Signaturdateien werden übergangen.
4. Je Anhang gewinnt die erste passende Regel „je Anhang“ (kleinste Priorität zuerst); für die E-Mail selbst die erste passende
   Regel „E-Mail“. Die E-Mail wird nur dann zum Dokument (PDF aus dem Text), wenn eine solche Regel sie ablegen will.
5. **Rückmeldungen** zu E-Mails des Portals (unzustellbar, Abwesenheit, Antwort) werden im E-Mail-Protokoll verbucht. Rückläufer und
   Abwesenheitsnotizen legt der Dokumenteneingang nicht ab (Status „nicht abgelegt“); Anhänge einer Antwort laufen normal durchs Regelwerk.
6. Eindeutige Treffer aktiver Regeln werden sofort abgelegt. In die **Prüfliste** kommen: Anhänge ohne Regel, Treffer von Regeln im
   Testlauf oder mit „immer prüfen“, fehlende Pflichtfelder und fehlgeschlagene Ablagen.
7. Sind alle Dokumente eines Vorgangs erledigt, meldet das Portal n8n die Behandlung der E-Mail. E-Mails ohne Regel und ohne
   Anhang bleiben unangetastet im Postfach (Status „ohne Regel“, ohne gespeicherten Inhalt).
8. **Posteingang abrufen** (Knopf in Prüfliste und Protokoll): wendet das Regelwerk erneut auf alle offenen Vorgänge an und startet
   den n8n-Workflow sofort über einen Webhook. n8n liefert dann alle E-Mails des Posteingangs erneut – auch gelesene und ältere.
   Bekannte E-Mails bleiben unverändert; nur E-Mails „ohne Regel“ werden neu bewertet (z. B. nachdem aus der Prüfliste eine Regel
   erstellt wurde). Passt weiterhin keine Regel, bleibt der Vorgang wie er ist.

**Dubletten:** Dieselbe Datei (SHA-256) wird nicht zweimal nach Paperless gebracht; der Vorgang verweist auf das vorhandene Dokument.
**Inhalte:** Mailtext und Dateien liegen nur im Portal, solange ein Vorgang offen ist. Nach dem Abschluss bleiben Metadaten,
Zuordnung und Paperless-Nummer.

## App „Dokumenteneingang“ (TC Oberthal → Dokumente)

| Reiter | Inhalt |
|---|---|
| Prüfliste | Offene Vorgänge: Mailtext und Dokument ansehen, mit einer Regel oder von Hand ablegen, ignorieren, „Regel erstellen“ (Absender und Dateiendung vorbelegt), „Neu bewerten“ nach einer Regeländerung, Vorgang verwerfen (wird mit „Posteingang abrufen“ neu eingelesen), „Posteingang abrufen“. |
| Protokoll | Alle Vorgänge mit Regel, Ablageort und Behandlung der E-Mail – ohne Inhalte. |
| Regeln | Regelwerk nach Priorität, Treffer der letzten 30 Tage, anlegen/ändern/kopieren/löschen, Probe gegen eine Beispiel-E-Mail. |
| Korrespondenten | Partner mit ihren Adressen und Domains; Regeln prüfen „Korrespondent ist …“. |

### Regel

| Teil | Inhalt |
|---|---|
| Status | `aktiv`, `testlauf` (nichts ablegen, Vorschlag in die Prüfliste) oder `aus` |
| Gilt | je Anhang oder für die E-Mail selbst |
| Bedingungen | UND/ODER; Felder: Absender-Adresse, -Domain, -Name, Empfänger, Postfach, Betreff, Mailtext, Mailtext (HTML), Korrespondent, Absender ist Mitglied, Anzahl Anhänge, Dateiname, Dateityp, Dokumenttext; Operatoren: ist, enthält, beginnt mit, endet mit, Muster, in Liste – jeweils auch verneint |
| Felder lesen | Name, Quelle, Muster (erste Klammergruppe = Wert), optional Pflicht → Platzhalter `{feld.<name>}` |
| Paperless | Bei neuen Regeln aus; bei Bedarf einschalten. Titel, Korrespondent, Dokumenttyp, Speicherpfad, Tags, Dokumentdatum, Notiz – Vorlagen wie in der Paperless-Zuordnung (`{datei|ohneEndung}`, `{datum|datum}` …); fehlende Korrespondenten und Tags werden angelegt |
| Custom Fields | Feld aus Paperless wählen, Wert oder Vorlage angeben (z. B. `{feld.betrag}`). Das Portal wandelt je Feldtyp um: Betrag `EUR12.50`, Datum `JJJJ-MM-TT` (auch `31.12.2026`), Zahl, Ja/Nein, Auswahl per Option. Ungültige Werte werden als Warnung gemeldet. |
| Anhänge zusammenfassen | Nur je Anhang: alle Anhänge einer E-Mail, für die die Regel greift (PDFs und Bilder), werden vor der Ablage zu einem PDF zusammengefügt – Reihenfolge wie in der E-Mail oder nach Dateiname, Dateiname als Vorlage (`{anzahl}` = Zahl der Teile). Dublettenprüfung über die Teile. Schlägt das Zusammenfügen fehl (z. B. verschlüsseltes PDF), gehen die Teile einzeln in die Prüfliste. Läuft über Gotenberg. |
| Nextcloud | Bei neuen Regeln aus; bei Bedarf einschalten. Ordner und Dateiname als Vorlagen, z. B. `Belege/{jahr}` und `{datum}_{kurz}_{datei}` |
| E-Mail danach | im Posteingang lassen, in einen Ordner verschieben oder in den Papierkorb; optional als gelesen markieren. Zielordner aus der Liste der Ordner des Vereinspostfachs (Anzeige wie in der Nextcloud, gespeichert wird der IMAP-Pfad für n8n, z. B. „Belege › SumUp“ = `INBOX.Belege.SumUp`) oder frei eingegeben; die Liste steht in `modules/tco/web/eingang/typen.ts` (`MAIL_ORDNER`). |
| Automatik | bei Treffer sofort ablegen oder immer in die Prüfliste |

Platzhalter: `{datei}`, `{betreff}`, `{von}`, `{von_name}`, `{domain}`, `{postfach}`, `{datum}`, `{jahr}`, `{monat}`, `{heute}`,
`{korrespondent}`, `{kurz}`, `{mitglied}` (Nachname Vorname), `{vorname}`, `{nachname}`, `{adrnr}`, `{feld.<name>}`.

## Berechtigungen

| Berechtigung | Zweck |
|---|---|
| `tco.eingang:display` | Regelwerk, Korrespondenten und Protokoll ansehen (ohne Inhalte) |
| `tco.eingang:edit` | Regelwerk pflegen und Prüfliste bearbeiten (Mailtext und Dateien offener Vorgänge ansehen) |
| `tco.eingang:melden` | nur für den API-Schlüssel von n8n |

Die Migration legt die Rolle **Dokumenteneingang** mit `display` und `edit` an. Regeln und Korrespondenten schreiben Änderungsbelege.

## Einrichten

1. **Administration → Anbindungen:** „Paperless-ngx“ prüfen; bei Bedarf „Nextcloud Dokumentenablage“ (Adresse, Benutzer, App-Passwort) eintragen.
   Für „Posteingang abrufen“ die Anbindung „Maileingang jetzt abrufen (n8n)“ mit der Production-URL des Webhooks und der Header-Anmeldung eintragen.
2. **Administration → API-Schlüssel:** Schlüssel für das Modul „TC Oberthal“ mit `tco.eingang:melden` anlegen.
3. **n8n:** Workflow „TCO Maileingang“ ([`docs/n8n/tco-maileingang.json`](n8n/tco-maileingang.json)) – ein Workflow für Dokumenteneingang und Rückmeldungen, siehe [n8n/DOKUMENTENEINGANG.md](n8n/DOKUMENTENEINGANG.md).
   Nach der Ablage ergänzt „TCO Paperless Qualifizierung“ Datum, Betrag und Positionen per Bildanalyse – sofort über einen Paperless-Workflow, siehe [n8n/QUALIFIZIERUNG.md](n8n/QUALIFIZIERUNG.md).
4. **Rolle „Dokumenteneingang“** den zuständigen Benutzern zuordnen.
5. Korrespondenten und Regeln anlegen – zunächst im **Testlauf**; aktiv schalten, wenn die Vorschläge in der Prüfliste stimmen.

## Noch nicht enthalten

- Dokumenttext: PDFs liest das Portal nicht selbst aus. Regeln auf „Dokumenttext“ greifen nur, wenn n8n den Text je Anhang mitliefert (Feld `text`).
- Testlauf des gesamten Regelwerks gegen vergangene E-Mails (die Probe prüft eine Regel gegen eine Beispiel-E-Mail).
- KI-Vorschlag für Unbekanntes.
- Übernahme der bisherigen Switch-Regeln aus dem n8n-Workflow „TCO Maileingang“ (werden als Regeln neu angelegt).
