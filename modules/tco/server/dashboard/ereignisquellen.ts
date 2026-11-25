/**
 * Verzeichnis der Ereignisquellen und ihrer Abdeckung im Arbeitsvorrat (#232, V3).
 *
 * Vorgabe: Jedes Ereignis, das jemand erledigen oder wissen muss, erscheint im Arbeitsvorrat. Dieses Verzeichnis hält
 * für jede Quelle fest, wie es darum steht. Die Quellen selbst werden nicht von Hand gepflegt, sondern vom Test
 * server/test/arbeitsvorrat_absicherung.test.ts aus dem Quelltext abgeleitet:
 *
 *   schnittstelle:<id>          jede Anbindung (VerbindungDef)
 *   lauf:<datei>                jeder automatische Lauf (setInterval)
 *   job:<id>                    jeder Job (Administration → System → Jobs; server/src/jobs-kern.ts, modules/<modul>/server/jobs.ts)
 *   eingang:<modul> <route>     jede ändernde Route ohne Anmeldung (Formulare, Links aus E-Mails, Webhooks)
 *   meldung:<modul> <route>     jede Route mit dem Vorsatz „melden“ (Schaden, n8n mit API-Schlüssel)
 *   selbst:<modul> <route>      jede ändernde Route der Selbstbedienung (/meine/, /meinkonto)
 *
 * Kommt eine Quelle dazu, scheitert der Test, bis sie hier steht – mit
 *   aufgabe  Schlüssel(anfang) des Eintrags im Arbeitsvorrat, der das Ereignis zeigt (aus dem aktuellen Stand berechnet),
 *   hinweis  Quelle des Hinweises, den die Stelle beim Ereignis meldet (hinweisMelden, server/src/lib/hinweise.ts) –
 *            er steht im Arbeitsvorrat, bis jemand „gesehen“ bestätigt,
 *   ueberwacht  Schnittstelle, deren Aufruf überwacht ist (tcoSchnittstelle(<Konstante der Anbindung>, …)): Scheitert er,
 *            steht die Störung im Arbeitsvorrat, bis der nächste Aufruf klappt,
 *   offen    erscheint nicht – seit V1 (#232) gibt es keinen offenen Punkt mehr, und der Test lässt keinen neuen zu,
 *   ohne     braucht keinen Eintrag – mit Begründung.
 *
 * Reine Daten ohne Importe, damit der Test ohne Datenbank läuft. Mit V2 (Arbeitsvorrat im Kern) wandert das Verzeichnis
 * zu den Modulen, die ihre Quellen dann selbst anmelden.
 */
export type Abdeckung = { aufgabe: string | string[] } | { hinweis: string | string[] } | { ueberwacht: string } | { offen: string } | { ohne: string };

const VERLAUF = 'reiner Verlauf – steht in Statistik bzw. Änderungsbelegen';

export const EREIGNISQUELLEN: Record<string, Abdeckung> = {
  // ---------------------------------------------------------------- Schnittstellen
  // Paperless je Bereich (#232, S5): Störungen meldet der Client je Zugang (Rechnername), gleich welcher Bereich
  'schnittstelle:paperless': { hinweis: 'PAPERLESS' },
  'schnittstelle:transport.paperless': { hinweis: 'PAPERLESS' },
  'schnittstelle:miete.paperless': { hinweis: 'PAPERLESS' },
  'schnittstelle:mail': { hinweis: 'MAIL_FEHLER' },
  'schnittstelle:tco.ep3': { ueberwacht: 'V_EP3' },
  'schnittstelle:tco.stunden': { ueberwacht: 'V_STUNDEN' },
  'schnittstelle:tco.ferien': { ueberwacht: 'V_FERIEN' },
  'schnittstelle:tco.mailabruf': { ueberwacht: 'V_MAILABRUF' },
  // ein Zugang für Sicherung und Dokumentenablage (#232, S2): Ablage überwacht, die Sicherung hat ihren eigenen Eintrag (BACKUP_EXPORT)
  'schnittstelle:nextcloud': { ueberwacht: 'V_NEXTCLOUD' },
  'schnittstelle:transport.mail': { ohne: 'Euroflex sendet nur aus dem Dialog am Auftrag (#235): das Ergebnis sieht der Absender sofort und wiederholt dort; kein Hintergrundlauf, jede E-Mail steht im E-Mail-Protokoll' },
  'schnittstelle:transport.maileingang': { ohne: 'nur der Knopf „Posteingang abrufen“ im Euroflex-Posteingang: das Ergebnis sieht der Benutzer sofort; den regelmäßigen Abruf macht n8n selbst' },

  // ---------------------------------------------------------------- automatische Läufe
  // Planer der Jobs: ein fehlgeschlagener Lauf nach Plan meldet eine Störung (Quelle JOB), bis der nächste Lauf gelingt
  'lauf:server/src/jobs.ts': { hinweis: 'JOB' },

  // ---------------------------------------------------------------- Jobs (Administration → System → Jobs)
  'job:core.backup.nextcloud': { aufgabe: 'BACKUP_EXPORT' },
  'job:core.jobs.aufraeumen': { ohne: 'technisches Aufräumen alter Laufprotokolle – scheitert es, meldet der Planer die Störung (Quelle JOB)' },
  // TC Oberthal (modules/tco/server/jobs.ts) – bisher setInterval in den Routen
  'job:tco.platz.abolauf': { aufgabe: ['ABO_FREIGABE', 'ABO_MAIL', 'ABO_BEWERBUNG'] },
  'job:tco.instandhaltung.lauf': { aufgabe: 'SCHADEN' },
  'job:tco.mitglieder.austritt': { hinweis: 'MG_SPERRE' },
  'job:tco.benutzer.rollenabgleich': { ohne: 'Rollen nach Mitgliedschaft angleichen – Änderungen stehen je Benutzer im Laufprotokoll und in den Änderungsbelegen; Rollen vergibt sonst der Administrator' },
  'job:tco.mahnung.automatik': { aufgabe: ['MAHN_VORSCHLAG', 'MAHN_KLAEREN', 'MAHN_UNERREICHBAR', 'MAHN_LAUF'] },
  'job:tco.rundschreiben.wiederaufnahme': { ohne: 'setzt nur einen bereits ausgelösten Versand fort – Stand und Fehler je Empfänger stehen in der App „Rundschreiben“, ein angehaltener Versand mit Grund' },
  // TC Oberthal: Stapelfunktionen, bisher nur per Knopf (Vorgabe nicht eingeplant)
  'job:tco.jt.ferien': { ohne: 'Abruf überwacht (V_FERIEN, Schnittstelle „Schulferien“): Störungen stehen im Arbeitsvorrat; fehlende Ferien zeigt die Abrechnung Jugendtraining' },
  'job:tco.halle.ep3import': { ohne: 'Abruf überwacht (V_EP3): Störungen stehen im Arbeitsvorrat; das Ergebnis je Datei steht im Laufprotokoll, offene Buchungen in der Hallenabrechnung' },
  'job:tco.eingang.mailabruf': { ohne: 'Anstoß überwacht (V_MAILABRUF): Störungen stehen im Arbeitsvorrat; was n8n danach liefert, meldet der Dokumenteneingang selbst (Prüfliste)' },

  // ---------------------------------------------------------------- Eingänge ohne Anmeldung: Kern
  'eingang:core POST /api/auth/login': { ohne: VERLAUF },
  'eingang:core POST /api/auth/logout': { ohne: VERLAUF },
  'eingang:core POST /api/auth/passwort-vergessen': { ohne: VERLAUF },
  'eingang:core POST /api/auth/kennwort-setzen': { ohne: VERLAUF },
  'eingang:core POST /api/setup': { ohne: 'einmalige Einrichtung des Portals durch den ersten Administrator' },
  'eingang:core POST /api/mail/eingang': { hinweis: 'MAIL_RUECKLAUF' },

  // ---------------------------------------------------------------- Eingänge ohne Anmeldung: TC Oberthal
  'eingang:tco POST /antrag': { aufgabe: 'MITGLIEDSANTRAG' },
  'eingang:tco POST /antrag/angebot': { aufgabe: 'MITGLIEDSANTRAG' },
  'eingang:tco POST /schnupper': { aufgabe: 'SCHNUPPER' },
  'eingang:tco POST /schluessel/quittung': { aufgabe: 'SCHLUESSEL' },
  'eingang:tco POST /platz/registrierung': { aufgabe: ['REG_MITGLIED', 'REGISTRIERUNG'] },
  'eingang:tco POST /platz/registrierung/pruefen': { ohne: 'nur Suche im Bestand, es wird nichts angelegt' },
  'eingang:tco POST /platz/registrierung/schnell': { ohne: 'verschickt nur den Einladungslink – das Ereignis ist die Annahme (POST /einladung)' },
  'eingang:tco POST /platz/registrierung/bestaetigen': { hinweis: 'HN_NEU' },
  'eingang:tco POST /einladung': { hinweis: 'MG_ZUGANG' },
  // Turniere (Sport → Turniere): Anmeldung und Abmeldung melden sich bei der Turnierleitung; Ergebnisse stehen im Turnier selbst
  'eingang:tco POST /turnier/oeffentlich/:kennung/anmeldung': { hinweis: 'TURNIER_ANMELDUNG' },
  'eingang:tco POST /turnier/zugang/:schluessel/abmelden': { hinweis: 'TURNIER_ABMELDUNG' },
  'eingang:tco POST /turnier/zugang/:schluessel/ergebnis': { ohne: 'Ergebnis aus dem Spiel – steht sofort in Tableau, Gruppen und Live-Ansicht der Turnierleitung, Änderungsbeleg mit Absender' },
  'eingang:tco POST /turnier/spass/platz/:kennung/ergebnis': { ohne: 'Ergebnis aus dem Spiel – steht sofort in Tableau, Gruppen und Live-Ansicht der Turnierleitung, Änderungsbeleg mit Absender' },
  'eingang:tco POST /turnier/liga/zugang/:schluessel/bemueht': { ohne: 'Vermerk am Spiel, steht in der Gruppe der Turnierleitung und wirkt erst beim Monatsabschluss' },
  'eingang:tco POST /turnier/spass/zugang/:schluessel/pause': { ohne: 'Pausenwunsch für die nächste Runde, steht bei der Auslosung in der Verwaltung' },

  // ---------------------------------------------------------------- Meldungen
  'meldung:tco POST /schaden': { aufgabe: 'SCHADEN' },
  // Projektstunden (Mein Bereich → Meine Zeiten): der Planer bestätigt sie im Projekt
  'meldung:tco POST /projekte/meine-zeiten': { aufgabe: 'HHPROJEKTZEIT' },
  'meldung:tco POST /projekte/meine-zeiten/:id/loeschen': { ohne: 'das Mitglied zieht die eigene, noch nicht bestätigte Meldung zurück – der Eintrag im Arbeitsvorrat entfällt damit' },
  'meldung:tco POST /eingang/mail': { aufgabe: ['EINGANG_PRUEFEN', 'EINGANG_FEHLER'] },
  'meldung:tco POST /eingang/abgleich': { ohne: 'technischer Abgleich mit n8n, welche E-Mails schon geliefert sind' },
  'meldung:tco POST /eingang/vorgaenge/:id/mail-erledigt': { ohne: 'Quittung von n8n, dass die E-Mail im Postfach behandelt ist' },
  'meldung:transport POST /eingang/mail': { hinweis: ['EINGANG_PRUEFEN', 'EINGANG_SPEICHER'] },

  // ---------------------------------------------------------------- Selbstbedienung
  'selbst:tco POST /jt/meine/freigeben': { aufgabe: 'JT' },
  'selbst:tco POST /jt/meine/oeffnung': { aufgabe: 'JT' },
  'selbst:tco POST /jt/meine/zeiten': { ohne: 'Erfassung der eigenen Zeiten – das Ereignis ist die Freigabe des Monats' },
  'selbst:tco POST /jt/meine/zeiten/loeschen': { ohne: 'Erfassung der eigenen Zeiten – das Ereignis ist die Freigabe des Monats' },
  'selbst:tco POST /jt/meine/generieren': { ohne: 'Erfassung der eigenen Zeiten – das Ereignis ist die Freigabe des Monats' },
  'selbst:tco POST /mannschaftsmeldung/meine/:id': { ohne: 'Angabe zur Mannschaftsmeldung (fest/Ersatz/nicht) – der Sportwart sieht alle Angaben gesammelt in der Anmeldematrix, die Abfrage hat eine Frist' },
  'selbst:tco POST /verzehr/meine/buchen': { aufgabe: 'VZ_ABSCHLUSS' },
  'selbst:tco POST /verzehr/meine/storno': { aufgabe: 'VZ_ABSCHLUSS' },
  'selbst:tco POST /mitglieder/meine/vorgang/pruefen': { ohne: 'nur Prüfung, es wird nichts geändert' },
  'selbst:tco POST /mitglieder/meine/vorgang': { aufgabe: 'MG_AENDERUNG' },
  'selbst:tco POST /mitglieder/meine/kuendigung': { aufgabe: 'KUENDIGUNG' },
  'selbst:tco PUT /mitglieder/meine/kontakt': { hinweis: 'MG_KONTAKT' },
  'selbst:tco PUT /mitglieder/meine/bank': { hinweis: 'MG_BANK' },
  'selbst:tco POST /mitglieder/meine/gruppen': { hinweis: 'MG_GRUPPE' },
  'selbst:tco PUT /meinkonto': { hinweis: ['HN_KONTAKT', 'MG_KONTAKT'] },
};
