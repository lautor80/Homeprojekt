# Berechtigungskonzept

Stand: 9. November 2026 · zu Issue #46 · Grundlage: Code auf `main` (94abe96)

Dieses Dokument beschreibt, wie Berechtigungen im Portal künftig geschnitten, benannt, vergeben und geprüft
werden. Es ist ein Konzept, noch keine Umsetzung: Abschnitt 5 teilt die Arbeit in vier Stufen, Abschnitt 6
nennt die Entscheidungen, die vorher fallen müssen.

## 1. Kurzfassung

Das Fundament trägt: Der Server prüft jede Route, Module bringen ihre Rechte selbst mit, Bankdaten sind
feldweise geschützt, Rollenänderungen wirken sofort und sind belegt. Was fehlt, ist die Ordnung darüber.

1. **Drei Schutzebenen, klar getrennt:** Funktion (Objekt:Aktivität), Eigentum (nur eigene Daten) und Feld
   (Maskierung). Jede Berechtigung gehört zu genau einer **Klasse**: Selbstbedienung, Fachrecht, Feldrecht
   oder kritisches Recht.
2. **Niemand vergibt mehr, als er selbst hat.** Heute ist `core.users:edit` und `core.roles:edit` jeweils
   gleichbedeutend mit Administrator (Abschnitt 3, Befund 1). Das wird serverseitig geschlossen.
3. **Mitgliederzugänge bekommen ein eigenes Recht** (`tco.zugaenge:edit`). Der Kassenwart braucht dann kein
   Benutzerverwaltungsrecht mehr, und die Zuordnung Benutzer ↔ Mitglied liegt an einer Stelle statt an drei.
4. **Standardrollen für die Vereinsämter** als Vorlagen mit fertiger Matrix (Anhang A) statt 74 einzelner
   Häkchen.
5. **Ein Namensschema** mit neun festen Aktivitäten; 18 Kennungen im Modul `tco` werden umbenannt (Anhang B).
6. **Befristete Zuordnungen** (Kassenprüfer, Thekendienst, Vertretung) und eine jährliche Durchsicht.
7. **Ein generierter Test** prüft für jede Route, dass sie ohne das Recht abweist.

## 2. Grundsätze

| # | Grundsatz | Bedeutung |
|---|---|---|
| G1 | Der Server entscheidet | Die Oberfläche blendet nur aus. Jede Route prüft selbst (gilt schon heute). |
| G2 | Ohne Rolle kein Zugriff | Rechte sind rein additiv, es gibt keine Verbote. Kein Recht heißt: nicht sichtbar, nicht aufrufbar. |
| G3 | Rollen bilden Ämter ab | Rechte hängen an Rollen, nie direkt an Personen. Wechselt das Amt, wechselt die Zuordnung, nicht die Rolle. |
| G4 | So wenig wie nötig | Eine Rolle enthält, was das Amt im Alltag braucht. Seltenes (Import, Rücksicherung) bleibt beim Administrator. |
| G5 | Eigene Daten sind kein Fachrecht | „Meine …“-Apps wirken nur auf den Datensatz, dem der Benutzer zugeordnet ist. Die Zuordnung ist deshalb selbst schützenswert. |
| G6 | Keine Rechteausweitung | Wer Rollen pflegt oder vergibt, kann nur weitergeben, was er selbst besitzt. |
| G7 | Nachvollziehbar | Jede Änderung an Rollen, Zuordnungen und Zugängen erzeugt einen Änderungsbeleg (gilt schon heute). |
| G8 | Geprüft statt geglaubt | Katalog, Navigation, Routen und Rollenvorlagen werden automatisch gegeneinander getestet. |

## 3. Ist-Stand

### 3.1 Was heute gut gelöst ist

- **Prüfung im Backend** über `requireAuth('<recht>')` an den Routen und `can(req, …)` in den Handlern
  (`server/src/auth.ts`). Ohne Anmeldung erreichbar sind nur die dafür gedachten Routen: Anmeldung und
  Kennwort-Links, Ersteinrichtung, Registrierung, Online-Antrag, Einladung, Statusabfrage.
- **Deklarativer Katalog je Modul** (`ServerModule.permissions`), gegliedert wie die Navigation; ein Test gleicht
  Navigation und Katalog ab (`server/test/permissions.test.ts`).
- **Sofortige Wirkung:** Rechte werden bei jeder Anfrage aus der Datenbank gelesen (`loadUser`).
- **Feldschutz für Bankdaten** serverseitig, auch in Änderungsbelegen, PDFs und der Tabellenansicht
  (`server/src/schutz.ts`, `modules/tco/server/bankdaten.ts`).
- **Rollen „nur Admin“** `MITGLIED` und `HALLENNUTZER` (seit 11/2026 keine Systemrollen mehr, Kennzeichen `core.roles.nur_admin`):
  Berechtigungen ändert nur ein Benutzer mit der Rolle `ADMIN`, Administrationsrechte (`core.*`, `*`) sind darin nicht erlaubt,
  löschen geht nicht. Das Portal legt sie nur an, wenn sie fehlen; nach jeder automatischen Anlage prüft `rechtePruefen`, dass
  der Benutzer genau diese eine Rolle und keine Administrationsrechte hat.
- **Schutz des letzten Administrators**, Änderungsbelege für Rollen und Zuordnungen, Rollen für einen Zeitraum
  deaktivierbar, API-Schlüssel auf ein Modul begrenzt.

### 3.2 Befunde

**Befund 1 – Verwaltungsrechte sind verdeckte Administratorrechte.**
`server/src/routes/admin.ts` prüft nur, *ob* jemand Benutzer bzw. Rollen pflegen darf, nicht *was* er dabei vergibt:

- Mit `core.users:edit` lässt sich jedem Benutzer jede Rolle zuordnen, auch `ADMIN` und auch sich selbst
  (`setUserRoles`). Außerdem lässt sich das Kennwort jedes Benutzers neu setzen, auch das eines Administrators
  (`POST /api/admin/users/:id/password`).
- Mit `core.roles:edit` lassen sich beliebige Rechte in jede Nicht-Systemrolle schreiben, auch in die eigene.
  Gefiltert wird nur `*`.
- `core.backup:restore` ersetzt alle Daten einschließlich der Rollen; `core.backup:create` und
  `core.tabellen:display` lesen den gesamten Datenbestand; `core.apikeys:edit` stellt Schlüssel mit allen Rechten
  eines Moduls aus.

Das ist für den einen Administrator unkritisch, wird aber zum Problem, sobald eines dieser Rechte in einer
Amtsrolle landet. Genau das erzwingt Befund 2.

**Befund 2 – Mitgliederzugänge hängen am Benutzerverwaltungsrecht.**
Benutzer aus Mitgliedern anlegen, Einladungen mit QR-Code, Zuordnung und Massenzuordnung verlangen
`core.users:edit` (`modules/tco/server/mitglieder/routes.ts`, Routen `/mitglieder/benutzer-*`, `/mitglieder/einladungen`).
Wer im Verein die Zugänge betreut, erhält damit zwangsläufig das Recht aus Befund 1.

**Befund 3 – Die Zuordnung Benutzer ↔ Mitglied liegt an drei Stellen.**
`tco.mitgliedera.benutzer_id` entscheidet, wessen Daten ein Benutzer in „Meine Mitgliedschaft“, „Platz buchen“
und „Mein Verzehr“ sieht und ändert (Kontaktdaten, Bankverbindung, Kündigung, Buchungen auf dessen Rechnung).
Setzen dürfen sie drei verschiedene Rechte, keines schließt die Zuordnung auf sich selbst aus:

| Route | Recht |
|---|---|
| `PUT /mitglieder/benutzer/:id/zuordnung`, `POST /mitglieder/benutzer-mapping` | `core.users:edit` |
| `PUT /platz/admin/benutzer` | `tco.platz:admin` |
| `PUT /jt/trainer/benutzer` | `tco.jt:entgelte` |

Die ersten beiden Wege verhindern nur, dass ein Mitglied zwei Benutzern gehört; Mitglieder ohne Portalzugang
lassen sich also „übernehmen“. Die Trainerpflege überschreibt sogar eine bestehende Zuordnung des Trainers.

**Befund 4 – Kein einheitliches Namensschema.**
Die 74 Kennungen (13 Basis, 51 `tco`, 7 `transport`, 3 `beispiel`) verwenden 17 verschiedene Aktivitäten.
Teils sind es Tätigkeiten (`display`, `edit`, `execute`), teils Teilobjekte (`halle:preise`, `jt:entgelte`,
`soll:glaeubiger`), teils Ämter (`verzehr:theke`) oder Merkmale (`registrierung:mitglied`). `edit` bedeutet bei
`tco.verzehr:edit` „eigenen Verzehr anschreiben“, bei `tco.clubhaus:edit` „die Abrechnung pflegen“ und bei
`tco.dashboard:edit` „Beitragsstufenwechsel ausführen“. Eigene Daten heißen `meinedaten`, `meinkonto` und
`jtmeine`; Plätze `platz` und `platzbuchung`.

**Befund 5 – Sammelrechte.**
`core.settings:edit` deckt Einstellungen, Anbindungen mit Zugangsdaten, Paperless-Zuordnung und das
Mailprotokoll ab (Empfänger, Betreff, bei Fehlern der Inhalt). `tco.dashboard:display` zeigt die Kennzahlen aller
Bereiche einschließlich Finanzen, unabhängig von den Anzeigerechten der Bereiche
(`modules/tco/server/dashboard/routes.ts`). `core.audit:display` durchsucht die Änderungsbelege aller Module,
also auch die von Euroflex, wenn beide Module in einer Installation laufen.

**Befund 6 – Voraussetzungen und Katalog gelten nur in der Oberfläche.**
`requires` wird im `PermissionEditor` aufgelöst, der Server speichert beim Sichern einer Rolle aber jede
Zeichenkette: unbekannte Kennungen, Platzhalter wie `tco.halle:*` und Rechte ohne ihre Voraussetzung. Nach einer
Umbenennung bleiben verwaiste Einträge unbemerkt stehen.

**Befund 7 – Keine Rollen für die Vereinsämter.**
Ausgeliefert werden `ADMIN`, `MITGLIED` und `HALLENNUTZER`. Die Katalogtexte sprechen von Kassenwart, Hallenwart
und Thekendienst, aber welches Amt welche Rechte braucht, steht nirgends. Jede Rolle muss von Hand
zusammengestellt werden.

**Befund 8 – Funktionstrennung ist nicht festgelegt.**
Technisch trennbar ist vieles (z. B. `tco.fi:buchen` und `tco.fi:storno`), aber es gibt keine Aussage, welche
Kombinationen in einer Hand unerwünscht sind, und keinen Hinweis, wenn sie entstehen. Beispiel: Ein Trainer mit
`tco.jtmeine:edit` und `tco.jt:edit` könnte seine Zeiten melden und den eigenen Nachweis als bezahlt kennzeichnen;
`POST /jt/nachweis/bezahlt` prüft nur das Recht.

**Befund 9 – Befristung nur für ganze Rollen.**
Der Deaktivierungszeitraum gilt für alle Inhaber einer Rolle. Eine einzelne Zuordnung („Kassenprüfer bis zur
Mitgliederversammlung“) lässt sich nicht befristen und muss von Hand entzogen werden.

**Befund 10 – Kaum Abweisungstests.**
Die Durchsicht vom 8. November (`docs/review-2026-11-08.md`, Punkt 15) nennt es bereits: wenige 403-Prüfungen,
keine generierte Berechtigungsmatrix. Der Katalogtest prüft die Navigation, nicht die Routen.

## 4. Zielbild

### 4.1 Modell

```
Benutzer ──(Zuordnung, optional befristet)──> Rolle ──> Berechtigung  <modul>.<objekt>:<aktivität>
   │
   └──(Identität)──> Mitglied / EP3-Kunde / Trainer        bestimmt „eigene“ Daten
```

Geprüft wird auf drei Ebenen, immer in dieser Reihenfolge:

| Ebene | Frage | Mittel |
|---|---|---|
| Funktion | Darf der Benutzer diese Aktion überhaupt? | `requireAuth('<recht>')` an der Route |
| Eigentum | Auf welchen Datensatz wirkt sie? | bei Selbstbedienung: Datensatz aus der Identität, nie aus der Anfrage |
| Feld | Welche Werte sieht er im Klartext? | `feldschutz(req, '<recht>')`, Maskierung im Server |

Es bleibt bei Rollen aus additiven Rechten. Bewusst **nicht** eingeführt werden Verbotsrechte, Rechte direkt am
Benutzer, Rollenhierarchien und Platzhalter in Amtsrollen (`*` bleibt allein bei `ADMIN`, `objekt:*` entfällt).
Für einen Verein dieser Größe wäre das mehr Mechanik, als sich prüfen lässt.

### 4.2 Klassen

Jede Berechtigung erhält im Katalog ein Pflichtfeld `klasse`. Die Rollenpflege zeigt die Klasse an; die Regeln
je Klasse setzt der Server durch.

| Klasse | Bedeutung | Regeln |
|---|---|---|
| **S** Selbstbedienung | wirkt nur auf die eigenen Daten | Objektname beginnt mit `selbst.`; nicht für API-Schlüssel; einzige Klasse, die in den festen Systemrollen `MITGLIED`/`HALLENNUTZER` vorkommt |
| **F** Fachrecht | Anzeigen oder Bearbeiten eines Fachgebiets | Normalfall; Bestandteil der Amtsrollen |
| **D** Feldrecht | Klartext oder Änderung geschützter Felder | ergänzt ein Fachrecht, ersetzt es nie; Vergabe nur mit Begründung im Änderungsbeleg |
| **K** Kritisch | hebelt das Rechtemodell aus oder erreicht den gesamten Datenbestand | nur durch `ADMIN` vergebbar; in der Rollenpflege markiert; Inhaber erscheinen in der Jahresdurchsicht |

Kritisch sind: `core.users:edit`, `core.roles:edit`, `core.apikeys:edit`, `core.verbindungen:edit` (neu),
`core.backup:create`, `core.backup:restore`, `core.tabellen:display`, `core.audit:display` und
`tco.zugaenge:edit` (neu).

### 4.3 Namensschema

`<modul>.<objekt>:<aktivität>` – Modul und Objekt klein, ohne Umlaute; das Objekt ist die App oder das Fachobjekt,
nie ein Amt. Zulässig sind genau diese Aktivitäten:

| Aktivität | Bedeutung | Beispiel |
|---|---|---|
| `display` | anzeigen, drucken, exportieren | `tco.mitglieder:display` |
| `edit` | anlegen und ändern | `tco.fi:edit` |
| `delete` | löschen, wo es getrennt vergeben werden soll | `beispiel.kontakte:delete` |
| `create` | Beleg erzeugen, der danach unveränderlich ist | `transport.rechnungen:create`, `core.backup:create` |
| `execute` | Lauf oder Massenverarbeitung starten | `tco.soll:execute`, `tco.import:execute` |
| `approve` | prüfen, freigeben, ablehnen | `tco.antraege:approve` |
| `cancel` | stornieren | `tco.fi:cancel` |
| `send` | versenden an Dritte | `tco.halle:send` |
| `admin` | Fremdes verwalten und App-Einstellungen | `tco.platz:admin`, `core.sperren:admin` |

Einzige Ausnahme bleibt `core.backup:restore`. Zusätzlich gilt:

- **Ein Teilobjekt ist ein eigenes Objekt:** `tco.hallenpreise:edit` statt `tco.halle:preise`.
- **`edit` ohne `display` schließt das Anzeigen ein** (z. B. `tco.stammdaten:edit`). Gibt es ein `display`, ist es
  Voraussetzung jeder anderen Aktivität des Objekts; das leitet `gliedern` schon heute ab.
- **Voraussetzungen über Objektgrenzen** stehen ausdrücklich in `requires` und werden beim Sichern einer Rolle
  vom Server geprüft, nicht nur von der Oberfläche.
- **Der Katalogtext** nennt, was man mit dem Recht tun kann, und bei Klasse K auch die Folge („enthält alle
  Daten“), wie es `core.backup:create` schon vormacht.

Die 18 Umbenennungen stehen in Anhang B. `transport` und `beispiel` passen bereits bis auf
`transport.versand:execute` (künftig `transport.auftraege:send`).

### 4.4 Neue und geteilte Rechte

| Recht | Kl. | Inhalt | ersetzt |
|---|:-:|---|---|
| `tco.zugaenge:edit` | K | Portalzugänge für Mitglieder und Hallennutzer: Benutzer aus Mitglied/EP3-Kunde anlegen, einladen, Benutzer ↔ Mitglied/EP3-Kunde/Trainer zuordnen. Legt ausschließlich Benutzer mit `MITGLIED` oder `HALLENNUTZER` an. | `core.users:edit` in den `tco`-Routen; die Zuordnung in `tco.platz:admin` und `tco.jt:entgelte` |
| `tco.audit:display` | F | Änderungsbelege aller Objekte des Moduls `tco` durchsuchen (Feldschutz bleibt) | `core.audit:display` für den Kassenprüfer |
| `core.verbindungen:edit` | K | Anbindungen: Adressen und Zugangsdaten der angeschlossenen Systeme | Teil von `core.settings:edit` |
| `core.mail:edit` | F | Mailprotokoll ansehen und bereinigen, erneut senden, Testmail | Teil von `core.settings:edit` |

`core.settings:edit` behält Einstellungen und Paperless-Zuordnung. `tco.dashboard:display` bleibt ein Recht,
liefert aber je Bereich nur dann Kennzahlen, wenn der Benutzer das Anzeigerecht des Bereichs hat (Finanzen →
`tco.finanz:display`, Mitglieder → `tco.mitglieder:display` usw.).

### 4.5 Rollen

Drei Arten:

| Art | Rollen | Eigenschaften |
|---|---|---|
| Systemrolle, fest | `ADMIN` | Rechte im Code festgelegt |
| Rolle „nur Admin“ | `MITGLIED`, `HALLENNUTZER` | vom Portal automatisch vergeben; Berechtigungen pflegt nur ein Administrator, keine `core.*`-Rechte, nicht löschbar |
| Amtsrolle aus Vorlage | siehe unten | vom Modul als **Rollenvorlage** mitgeliefert, per Knopf angelegt, danach frei änderbar; die Rollenpflege zeigt Abweichungen von der Vorlage |
| Eigene Rolle | nach Bedarf | wie heute |

Vorgeschlagene Rollen für den Verein (Kürzel wie in Anhang A):

| Rolle | Kürzel | Zweck |
|---|:-:|---|
| `MITGLIED` | MI | eigene Mitgliedschaft, Platz buchen, eigener Verzehr, Kalender |
| `HALLENNUTZER` | HN | externe Nutzer: Platz buchen, eigene Kontaktdaten |
| `TRAINER` | TR | eigene Trainingszeiten zurückmelden, Teilnehmerliste sehen |
| `THEKE` | TH | Thekendienst; typischerweise befristet je Dienstplan |
| `VORSTAND` | VO | lesender Überblick über alle Bereiche, Kalender pflegen; keine Bankdaten |
| `MITGLIEDERWART` | MW | Mitglieder, Anträge, Registrierungen, Portalzugänge |
| `KASSENWART` | KW | Finanzen vollständig, Beiträge, Bankdaten, Lastschrift |
| `JUGENDWART` | JW | Jugendtraining erfassen und abrechnen, Teilnehmer |
| `SPORTWART` | SW | Kalender, Mannschaften, Serienbuchungen |
| `HALLENWART` | HW | Hallenabrechnung, Preise, Platzverwaltung |
| `CLUBHAUSWART` | CW | Clubhausabrechnung, Verzehrbuch, Theke |
| `KASSENPRUEFER` | KP | alles Finanzielle lesend samt Änderungsbelegen; befristet |

Regeln dazu:

- **Die Ämter (VO bis KP) enthalten keine Selbstbedienungsrechte.** Ein Amtsträger ist zusätzlich `MITGLIED`,
  ein Trainer ebenso. So bleibt sichtbar, was jemand als Mitglied darf und was kraft Amtes.
- **`ADMIN` ist kein Amt.** Höchstens zwei namentlich bekannte Personen; SAP-Import, Rücksicherung, Rollenpflege,
  API-Schlüssel und Anbindungen bleiben dort.
- **Mehrere Ämter = mehrere Rollen.** Es werden keine Mischrollen wie „Kassenwart und Hallenwart“ gebaut.
- **Euroflex** erhält eigene Vorlagen ohne Vereinsrechte: `EF_DISPOSITION` (Aufträge, Kontakte, Versand),
  `EF_FAKTURA` (zusätzlich Rechnungen erstellen) und `EF_STAMMDATEN` (Stammdaten, Import). Keine Vereinsrolle
  enthält `transport.*` und umgekehrt.

### 4.6 Schutz vor Rechteausweitung

Diese Regeln setzt der Server in `server/src/routes/admin.ts` durch, unabhängig von der Oberfläche:

1. **Rollen zuordnen:** Eine Rolle darf nur vergeben oder entziehen, wer alle ihre Rechte selbst besitzt.
   Die Rolle `ADMIN` vergibt damit nur, wer selbst `ADMIN` ist.
2. **Rollen ändern:** In eine Rolle darf nur aufgenommen werden, was der Bearbeiter selbst besitzt und was im
   Katalog der aktiven Module steht. Rechte der Klasse K nimmt nur `ADMIN` auf.
3. **Fremde Konten:** Kennwort setzen, Kennwort-Link senden, E-Mail-Adresse ändern, sperren und löschen sind nur
   bei Benutzern erlaubt, deren Rechte der Bearbeiter vollständig abdeckt.
4. **Eigenes Konto:** Die eigenen Rollen ändert niemand selbst. Der Schutz des letzten aktiven Administrators
   bleibt.
5. **API-Schlüssel:** nur Rechte der Klasse F und D des gewählten Moduls, nur was der Aussteller selbst besitzt,
   Ablaufdatum Pflicht (höchstens 12 Monate).

### 4.7 Identität und eigene Daten

- **Eine Stelle für die Zuordnung:** Nur `tco.zugaenge:edit` (und `ADMIN`) setzt `mitgliedera.benutzer_id` und
  `kunden.benutzer_id`. Platzverwaltung und Trainerpflege zeigen die Zuordnung nur noch an.
- **Nie sich selbst:** Der Bearbeiter kann den eigenen Benutzer nicht zuordnen oder umhängen.
- **Mit Beleg und Begründung:** Jede Zuordnung an ein Mitglied, das bisher keinen Zugang hatte, verlangt eine
  Begründung. Das Mitglied erhält eine Mail an die im Mitgliederstamm hinterlegte Adresse.
- **Selbstbedienungsrouten** lesen den Datensatz immer aus der Identität des angemeldeten Benutzers
  (`eigeneAdrnr`, `ichLesen`), nie aus einem Parameter der Anfrage. Das ist heute so und wird Testgegenstand.
- **Automatisch angelegte Benutzer** (Registrierung, Antragsübernahme, Einladung, EP3) erhalten weiterhin genau
  eine feste Systemrolle; `rechtePruefen` bleibt die Schranke.

### 4.8 Funktionstrennung

Unerwünschte Kombinationen werden im Katalog als Konfliktpaare deklariert. Die Benutzerpflege prüft sie über
alle Rollen eines Benutzers hinweg.

| Kombination bei einer Person | Risiko | Behandlung |
|---|---|---|
| `tco.selbst.trainingszeiten:edit` mit `tco.jt:edit` oder `tco.trainerentgelte:edit` | eigene Abrechnung freigeben, als bezahlt kennzeichnen, eigenes Entgelt setzen | **gesperrt**; zusätzlich weist der Server die Bearbeitung des eigenen Nachweises ab |
| `KASSENPRUEFER` mit einem schreibenden Finanzrecht | Prüfer prüft eigene Buchungen | **gesperrt** |
| `tco.bankdaten:edit` mit `tco.soll:execute` | Bankverbindung ändern und Lastschrift einziehen | Hinweis und Begründung; Ausgleich: geänderte Bankverbindungen als Liste im Lastschriftlauf, Durchsicht durch den Kassenprüfer |
| `tco.theke:edit` mit `tco.verzehr:admin` | kassieren und stornieren/abschließen | Hinweis |
| `core.roles:edit` mit `core.users:edit` | Rollen bauen und vergeben | nur bei `ADMIN` zulässig, durch 4.6 begrenzt |

In einem Verein lässt sich nicht jede Trennung besetzen. Deshalb sind nur zwei Paare gesperrt; die übrigen
werden sichtbar gemacht und über Belege ausgeglichen.

**Umgesetzt (11/2026, #46):** Die Rollenpflege zeigt diese Paare mit den heutigen Kennungen als Warnung – je Rolle und je
Benutzer über mehrere Rollen (Administration → Rollen → Prüfung). Module deklarieren sie in `rechteKonflikte`
(`server/src/module.ts`), der Kern in `server/src/rollenpruefung.ts`. Gesperrt wird noch nichts.

### 4.9 Lebenszyklus

| Anlass | Ablauf |
|---|---|
| Neues Mitglied | Einladung oder Registrierung → `MITGLIED` automatisch (wie heute) |
| Amt übernommen | `ADMIN` ordnet die Amtsrolle zu; Zuordnung optional mit „gültig bis“ (z. B. Ende der Amtszeit) |
| Kassenprüfung, Thekendienst, Vertretung | Zuordnung **befristet**: neue Spalten `gueltig_ab`/`gueltig_bis` in `core.user_roles`, ausgewertet in `loadUser` neben der bestehenden Rollen-Deaktivierung |
| Amt abgegeben | Zuordnung entziehen; bei K-Rechten am selben Tag |
| Austritt | Benutzer wird nach dem Austrittsdatum automatisch gesperrt (wie heute); zusätzlich entfallen alle Amtsrollen |
| Jährlich nach der Mitgliederversammlung | **Durchsicht:** Bericht „Benutzer je Rolle“ mit letzter Anmeldung, K-Rechten, befristeten und abgelaufenen Zuordnungen, Abweichungen von den Vorlagen; als PDF ablegbar |

Benutzer mit K-Rechten ohne Anmeldung seit zwölf Monaten erscheinen im Arbeitsvorrat des Administrators.
Zwei-Faktor-Anmeldung für diese Benutzer ist sinnvoll, gehört aber zur Anmeldung und nicht in dieses Konzept.

### 4.10 Prüfbarkeit

Vier Tests, alle ohne Fachdaten:

1. **Routenmatrix:** Über den `onRoute`-Hook alle registrierten Routen einsammeln. Jede Route unter `/api/` muss
   entweder auf einer ausdrücklichen Liste öffentlicher Routen stehen oder ohne Anmeldung 401 und mit einem
   Benutzer ohne Rollen 403 liefern.
2. **Katalog ↔ Code:** Jede in `requireAuth`/`can` verwendete Kennung steht im Katalog, jede Katalogkennung wird
   von mindestens einer Route verwendet, jede Aktivität stammt aus 4.3, jede Berechtigung hat eine Klasse.
3. **Rollenvorlagen:** Jede Vorlage enthält nur Katalogrechte, erfüllt alle Voraussetzungen und enthält kein
   gesperrtes Konfliktpaar. Anhang A wird aus den Vorlagen erzeugt, nicht von Hand gepflegt.
4. **Ausweitung:** Ein Benutzer mit `core.users:edit` kann weder `ADMIN` vergeben noch das Kennwort eines
   Administrators setzen; ein Benutzer mit `tco.zugaenge:edit` kann sich nicht selbst zuordnen.

## 5. Umsetzung in Stufen

Jede Stufe ist für sich auslieferbar. Stufe 1 ändert keine Kennung und keine Rolle.

| Stufe | Inhalt | Wesentliche Stellen | Risiko |
|---|---|---|---|
| **1 Absichern** | Regeln 4.6 Nr. 1–4; Rollen nur mit Katalogrechten und erfüllten Voraussetzungen speichern; keine Selbstzuordnung; Tests 1 und 4 | `server/src/routes/admin.ts`, `modules/tco/server/platz/logik.ts` (`benutzerZuordnen`), `jt/logik.ts`, `server/test/` | gering; betrifft nur Benutzer, die heute mehr vergeben könnten, als sie haben |
| **2 Ordnen** | `klasse` im Katalog; neue Rechte aus 4.4 samt Übergangsmigration (Rollen mit dem alten Recht erhalten das neue, Muster wie `016_bankdaten_berechtigung.sql`); Zuordnung nur noch über `tco.zugaenge:edit`; Dashboard je Bereich; API-Schlüssel-Regeln; Rollenvorlagen mit „Standardrollen anlegen“ | `server/src/permissions.ts`, `module.ts`, `modules/tco/server/index.ts`, `mitglieder/routes.ts`, `platz/routes.ts`, `jt/routes.ts`, `dashboard/routes.ts`, `web/src/pages/RolesPage.tsx` | mittel; nach dem Update Rollen einmal durchsehen |
| **3 Umbenennen** | Anhang B in einer Migration für `core.role_permissions` und `core.api_keys.permissions`; vorher Platzhalter `objekt:*` in Einzelrechte auflösen; Konstanten, Navigation, `auditObjects`, `sperrObjekte`, Arbeitsvorrat, Tests; Test 2 | alle `P_*`-Konstanten, `modules/tco/web/index.ts`, `platz/registrierung.ts` (Systemrollen) | mittel; rein mechanisch, aber breit. Vorab klären, wie sich die Rücksicherung einer älteren Sicherung verhält; nötigenfalls läuft die Umsetzung auch in `nachRuecksicherung` |
| **4 Lebenszyklus** | `gueltig_ab`/`gueltig_bis` je Zuordnung; Konfliktpaare mit Hinweis bzw. Sperre; Bericht zur Jahresdurchsicht; Test 3 | `server/migrations/`, `server/src/auth.ts` (`loadUser`), `web/src/pages/UsersPage.tsx` | gering |

Empfohlene Reihenfolge: 1 sofort, 2 und 3 gemeinsam in einem Update (eine Durchsicht der Rollen statt zwei),
4 danach.

## 6. Offene Entscheidungen

1. **Ämter:** Passen die Rollen aus 4.5 zu den tatsächlichen Ämtern? Gibt es einen eigenen Mitgliederwart, oder
   liegt das beim Kassenwart (dann entfällt `MITGLIEDERWART`)?
2. **Hallenabrechnung:** Rechnet der Hallenwart ab (Vorschlag) oder der Kassenwart? Davon hängen `tco.halle:edit`
   und `tco.halle:send` ab.
3. **Trainerentgelte:** Der Vorschlag legt sie zum Kassenwart; der Jugendwart erfasst und rechnet ab, setzt aber
   keine Sätze. Gewünscht?
4. **Bankdaten und Lastschrift in einer Hand** (4.8): mit Hinweis und Ausgleich leben, oder die Änderung von
   Bankverbindungen an eine zweite Person binden?
5. **Kassenprüfer:** Bankdaten maskiert (Vorschlag) oder im Klartext?
6. **Umbenennung (Stufe 3):** durchführen, oder das Schema nur für neue Rechte anwenden und die 18 alten
   Kennungen stehen lassen?
7. **Euroflex:** Wer arbeitet dort, und reichen die drei Vorlagen?

## Anhang A – Rollenmatrix (Vorschlag)

Kürzel wie in 4.5. `ADMIN` besitzt alles und steht nicht in der Tabelle. Rechte ohne Markierung bleiben beim
Administrator. Kl. = Klasse nach 4.2.

| Berechtigung (Zielname) | Kl. | MI | HN | TR | TH | VO | MW | KW | JW | SW | HW | CW | KP |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| **Selbstbedienung** | | | | | | | | | | | | | |
| `tco.selbst.mitgliedschaft:edit` – Meine Mitgliedschaft | S | ● |  |  |  |  |  |  |  |  |  |  |  |
| `tco.selbst.platzbuchung:edit` – Platz buchen (eigene Buchungen) | S | ● | ● |  |  |  |  |  |  |  |  |  |  |
| `tco.selbst.verzehr:edit` – Mein Verzehr | S | ● |  |  |  |  |  |  |  |  |  |  |  |
| `tco.selbst.kalender:edit` – Vereinskalender, eigene An-/Abmeldung | S | ● |  |  |  |  |  |  |  |  |  |  |  |
| `tco.selbst.kundendaten:edit` – Meine Daten (Hallennutzer) | S |  | ● |  |  |  |  |  |  |  |  |  |  |
| `tco.selbst.trainingszeiten:edit` – Meine Trainingszeiten | S |  |  | ● |  |  |  |  |  |  |  |  |  |
| **Vereinsübersicht** | | | | | | | | | | | | | |
| `tco.dashboard:display` – Vereinsübersicht (Kennzahlen je Bereich nur mit dessen Anzeigerecht) | F |  |  |  |  | ● | ● | ● | ● | ● | ● | ● | ● |
| `tco.beitragswechsel:execute` – Beitragsstufenwechsel Jugend → Erwachsene | F |  |  |  |  |  | ● | ● |  |  |  |  |  |
| **Einstellungen** | | | | | | | | | | | | | |
| `tco.stammdaten:edit` – Vereinsdaten pflegen | F |  |  |  |  |  |  | ● |  |  |  |  |  |
| `tco.import:execute` – Übernahme der SAP-Tabellen | F |  |  |  |  |  |  |  |  |  |  |  |  |
| `tco.konten:display` – Kontenstamm anzeigen | F |  |  |  |  |  |  | ● |  |  |  |  | ● |
| `tco.konten:edit` – Kontenstamm pflegen | F |  |  |  |  |  |  | ● |  |  |  |  |  |
| `tco.produkte:display` – Produkte anzeigen | F |  |  |  |  |  |  | ● |  |  | ● | ● | ● |
| `tco.produkte:edit` – Produkte und Preise pflegen | F |  |  |  |  |  |  | ● |  |  |  |  |  |
| **Mitglieder** | | | | | | | | | | | | | |
| `tco.mitglieder:display` – Mitglieder anzeigen | F |  |  |  |  | ● | ● | ● | ● | ● |  |  | ● |
| `tco.mitglieder:edit` – Mitglieder pflegen | F |  |  |  |  |  | ● | ● |  |  |  |  |  |
| `tco.antraege:display` – Mitgliedsanträge ansehen | F |  |  |  |  | ● | ● | ● |  |  |  |  |  |
| `tco.antraege:approve` – Mitgliedsanträge prüfen, ablehnen, übernehmen | F |  |  |  |  |  | ● | ● |  |  |  |  |  |
| `tco.registrierungen:approve` – Registrierungen von Mitgliedern freigeben/ablehnen | F |  |  |  |  |  | ● | ● |  |  |  |  |  |
| `tco.zugaenge:edit` – Portalzugänge: Benutzer für Mitglieder/Kunden anlegen, einladen, zuordnen | K |  |  |  |  |  | ● | ● |  |  |  |  |  |
| `tco.kalender:edit` – Veranstaltungen und Gruppen pflegen | F |  |  |  |  | ● | ● |  | ● | ● |  |  |  |
| `tco.beitraege:display` – Mitgliedsbeiträge anzeigen | F |  |  |  |  | ● | ● | ● |  |  |  |  | ● |
| `tco.beitraege:edit` – Mitgliedsbeiträge pflegen | F |  |  |  |  |  |  | ● |  |  |  |  |  |
| `tco.analyse:display` – Mitglieder-Analyse | F |  |  |  |  | ● | ● | ● |  |  |  |  |  |
| **Jugend** | | | | | | | | | | | | | |
| `tco.teilnehmer:display` – Teilnehmer Jugendtraining | F |  |  | ● |  |  |  |  | ● |  |  |  |  |
| `tco.jt:display` – Abrechnung Jugendtraining anzeigen | F |  |  |  |  |  |  | ● | ● |  |  |  | ● |
| `tco.jt:edit` – Zeiten erfassen, Nachweise, bezahlt kennzeichnen | F |  |  |  |  |  |  | ● | ● |  |  |  |  |
| `tco.trainerentgelte:edit` – Trainer und Trainerentgelte pflegen | F |  |  |  |  |  |  | ● |  |  |  |  |  |
| **Tennishalle** | | | | | | | | | | | | | |
| `tco.halle:display` – Hallenabrechnung anzeigen | F |  |  |  |  | ● |  | ● |  |  | ● |  | ● |
| `tco.halle:edit` – Buchungen zuordnen, Rechnungen bearbeiten, EP3-Import | F |  |  |  |  |  |  |  |  |  | ● |  |  |
| `tco.halle:send` – Hallenrechnungen drucken und versenden | F |  |  |  |  |  |  |  |  |  | ● |  |  |
| `tco.hallenpreise:edit` – Hallenpreise pflegen | F |  |  |  |  |  |  |  |  |  | ● |  |  |
| `tco.serienbuchung:edit` – Serienbuchung und Abos | F |  |  |  |  |  |  |  |  | ● | ● |  |  |
| `tco.platz:admin` – Platzverwaltung: Plätze, Regeln, Belegung mit Namen, Freigabe externer Registrierungen | F |  |  |  |  |  |  |  |  |  | ● |  |  |
| **Clubhaus** | | | | | | | | | | | | | |
| `tco.clubhaus:display` – Clubhausabrechnung anzeigen | F |  |  |  |  | ● |  | ● |  |  |  | ● | ● |
| `tco.clubhaus:edit` – Clubhausabrechnung pflegen | F |  |  |  |  |  |  |  |  |  |  | ● |  |
| `tco.theke:edit` – Thekendienst | F |  |  |  | ● |  |  |  |  |  |  | ● |  |
| `tco.verzehr:display` – Verzehrbuch anzeigen | F |  |  |  |  |  |  | ● |  |  |  | ● | ● |
| `tco.verzehr:admin` – Verzehr verwalten, Monatsabschluss | F |  |  |  |  |  |  |  |  |  |  | ● |  |
| **Finanzen** | | | | | | | | | | | | | |
| `tco.soll:display` – Sollstellungen anzeigen | F |  |  |  |  |  |  | ● |  |  |  |  | ● |
| `tco.soll:execute` – Lastschriftlauf erzeugen, herunterladen, stornieren | F |  |  |  |  |  |  | ● |  |  |  |  |  |
| `tco.glaeubigerdaten:edit` – Gläubigerdaten pflegen | F |  |  |  |  |  |  | ● |  |  |  |  |  |
| `tco.fi:display` – FI-Belege anzeigen | F |  |  |  |  |  |  | ● |  |  |  |  | ● |
| `tco.fi:edit` – Bankimport, Buchungen, Belege zuordnen | F |  |  |  |  |  |  | ● |  |  |  |  |  |
| `tco.fi:cancel` – FI-Belege stornieren | F |  |  |  |  |  |  | ● |  |  |  |  |  |
| `tco.forecast:display` – Beitragsforecast | F |  |  |  |  | ● |  | ● |  |  |  |  | ● |
| `tco.finanz:display` – Einnahmen und Ausgaben | F |  |  |  |  | ● |  | ● |  |  |  |  | ● |
| `tco.abschluss:display` – Jahresabschluss anzeigen | F |  |  |  |  | ● |  | ● |  |  |  |  | ● |
| `tco.abschluss:edit` – Anlagevermögen pflegen, Abschluss ablegen | F |  |  |  |  |  |  | ● |  |  |  |  |  |
| `tco.upload:execute` – Belege nach Paperless übertragen | F |  |  |  |  |  |  | ● |  |  |  |  |  |
| `tco.audit:display` – Änderungsbelege aller Vereinsobjekte durchsuchen | F |  |  |  |  |  |  |  |  |  |  |  | ● |
| **Datenschutz** | | | | | | | | | | | | | |
| `tco.bankdaten:display` – Bankdaten im Klartext | D |  |  |  |  |  |  | ● |  |  |  |  |  |
| `tco.bankdaten:edit` – Bankverbindung ändern | D |  |  |  |  |  |  | ● |  |  |  |  |  |

Basisrechte (`core.*`) erhält keine Amtsrolle.

## Anhang B – Umbenennungen im Modul `tco`

| Heute | Zielname |
|---|---|
| `tco.meinedaten:edit` | `tco.selbst.mitgliedschaft:edit` |
| `tco.platzbuchung:edit` | `tco.selbst.platzbuchung:edit` |
| `tco.verzehr:edit` | `tco.selbst.verzehr:edit` |
| `tco.kalender:anmelden` | `tco.selbst.kalender:edit` |
| `tco.meinkonto:edit` | `tco.selbst.kundendaten:edit` |
| `tco.jtmeine:edit` | `tco.selbst.trainingszeiten:edit` |
| `tco.dashboard:edit` | `tco.beitragswechsel:execute` |
| `tco.antraege:edit` | `tco.antraege:approve` |
| `tco.registrierung:mitglied` | `tco.registrierungen:approve` |
| `tco.jt:entgelte` | `tco.trainerentgelte:edit` |
| `tco.halle:versand` | `tco.halle:send` |
| `tco.halle:preise` | `tco.hallenpreise:edit` |
| `tco.platz:serie` | `tco.serienbuchung:edit` |
| `tco.verzehr:theke` | `tco.theke:edit` |
| `tco.soll:edit` | `tco.soll:execute` |
| `tco.soll:glaeubiger` | `tco.glaeubigerdaten:edit` |
| `tco.fi:buchen` | `tco.fi:edit` |
| `tco.fi:storno` | `tco.fi:cancel` |

Dazu im Modul `transport`: `transport.versand:execute` → `transport.auftraege:send`. Alle übrigen Kennungen
bleiben unverändert.
