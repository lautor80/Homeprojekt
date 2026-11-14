/**
 * Verzeichnis der Ereignisquellen und ihrer Abdeckung im Arbeitsvorrat (#232, V3).
 *
 * Vorgabe: Jedes Ereignis, das jemand erledigen oder wissen muss, erscheint im Arbeitsvorrat. Dieses Verzeichnis hält
 * für jede Quelle fest, wie es darum steht. Die Quellen selbst werden nicht von Hand gepflegt, sondern vom Test
 * server/test/arbeitsvorrat_absicherung.test.ts aus dem Quelltext abgeleitet:
 *
 *   schnittstelle:<id>          jede Anbindung (VerbindungDef)
 *   lauf:<datei>                jeder automatische Lauf (setInterval)
 *   eingang:<modul> <route>     jede ändernde Route ohne Anmeldung (Formulare, Links aus E-Mails, Webhooks)
 *   meldung:<modul> <route>     jede Route mit dem Vorsatz „melden“ (Schaden, n8n mit API-Schlüssel)
 *   selbst:<modul> <route>      jede ändernde Route der Selbstbedienung (/meine/, /meinkonto)
 *
 * Kommt eine Quelle dazu, scheitert der Test, bis sie hier steht – mit
 *   aufgabe  Schlüssel(anfang) des Eintrags im Arbeitsvorrat, der das Ereignis zeigt,
 *   offen    erscheint heute nicht; wird mit V1 (#232) geschlossen. Die Zahl der offenen Punkte darf nur sinken,
 *   ohne     braucht keinen Eintrag – mit Begründung.
 *
 * Reine Daten ohne Importe, damit der Test ohne Datenbank läuft. Mit V2 (Arbeitsvorrat im Kern) wandert das Verzeichnis
 * zu den Modulen, die ihre Quellen dann selbst anmelden.
 */
export type Abdeckung = { aufgabe: string | string[] } | { offen: string } | { ohne: string };

const VERLAUF = 'reiner Verlauf – steht in Statistik bzw. Änderungsbelegen';

export const EREIGNISQUELLEN: Record<string, Abdeckung> = {
  // ---------------------------------------------------------------- Schnittstellen
  'schnittstelle:paperless': { offen: 'Paperless nicht erreichbar oder Ablage gescheitert: heute nur Fehlermeldung beim Ablegen' },
  'schnittstelle:mail': { offen: 'nicht gesendete E-Mails stehen nur im E-Mail-Protokoll (Ausnahme: Hallenabo, ABO_MAIL)' },
  'schnittstelle:tco.ep3': { offen: 'gescheiterter EP3-Abruf: heute nur Meldung in der Hallenabrechnung' },
  'schnittstelle:tco.stunden': { offen: 'gescheiterter Abruf der Trainerstunden: kein Eintrag im Arbeitsvorrat' },
  'schnittstelle:tco.ferien': { offen: 'gescheiterter Abruf der Schulferien: heute nur Hinweis in der Abrechnung Jugendtraining' },
  'schnittstelle:tco.mailabruf': { offen: 'gescheiterter Abruf des Maileingangs: kein Eintrag im Arbeitsvorrat' },
  'schnittstelle:tco.nextcloud': { offen: 'gescheiterte Ablage in die Nextcloud: kein Eintrag im Arbeitsvorrat' },
  'schnittstelle:transport.mail': { ohne: 'Euroflex sendet nur aus dem Dialog am Auftrag (#235): das Ergebnis sieht der Absender sofort und wiederholt dort; kein Hintergrundlauf, jede E-Mail steht im E-Mail-Protokoll' },

  // ---------------------------------------------------------------- automatische Läufe
  'lauf:server/src/backup-export.ts': { aufgabe: 'BACKUP_EXPORT' },
  'lauf:modules/tco/server/platz/routes.ts': { aufgabe: ['ABO_FREIGABE', 'ABO_MAIL', 'ABO_BEWERBUNG'] },
  'lauf:modules/tco/server/instandhaltung/routes.ts': { aufgabe: 'SCHADEN' },
  'lauf:modules/tco/server/mitglieder/routes.ts': { offen: 'Benutzer ausgetretener Mitglieder werden gesperrt, ohne dass es jemand erfährt (nur Server-Protokoll)' },

  // ---------------------------------------------------------------- Eingänge ohne Anmeldung: Kern
  'eingang:core POST /api/auth/login': { ohne: VERLAUF },
  'eingang:core POST /api/auth/logout': { ohne: VERLAUF },
  'eingang:core POST /api/auth/passwort-vergessen': { ohne: VERLAUF },
  'eingang:core POST /api/auth/kennwort-setzen': { ohne: VERLAUF },
  'eingang:core POST /api/setup': { ohne: 'einmalige Einrichtung des Portals durch den ersten Administrator' },
  'eingang:core POST /api/mail/eingang': { offen: 'Unzustellbar-Meldungen, Abwesenheitsnotizen und Antworten stehen nur im E-Mail-Protokoll' },

  // ---------------------------------------------------------------- Eingänge ohne Anmeldung: TC Oberthal
  'eingang:tco POST /antrag': { aufgabe: 'MITGLIEDSANTRAG' },
  'eingang:tco POST /antrag/angebot': { aufgabe: 'MITGLIEDSANTRAG' },
  'eingang:tco POST /schnupper': { aufgabe: 'SCHNUPPER' },
  'eingang:tco POST /schluessel/quittung': { aufgabe: 'SCHLUESSEL' },
  'eingang:tco POST /platz/registrierung': { aufgabe: ['REG_MITGLIED', 'REGISTRIERUNG'] },
  'eingang:tco POST /platz/registrierung/pruefen': { ohne: 'nur Suche im Bestand, es wird nichts angelegt' },
  'eingang:tco POST /platz/registrierung/schnell': { ohne: 'verschickt nur den Einladungslink – das Ereignis ist die Annahme (POST /einladung)' },
  'eingang:tco POST /platz/registrierung/bestaetigen': { offen: 'externer Hallennutzer schaltet sich per E-Mail-Bestätigung selbst frei – kein Eintrag im Arbeitsvorrat' },
  'eingang:tco POST /einladung': { offen: 'Mitglied nimmt die Einladung an und legt seinen Benutzer an – kein Eintrag im Arbeitsvorrat' },

  // ---------------------------------------------------------------- Meldungen
  'meldung:tco POST /schaden': { aufgabe: 'SCHADEN' },
  'meldung:tco POST /eingang/mail': { offen: 'Dokumenteneingang: zu prüfende und fehlerhafte Vorgänge stehen nur in der Prüfliste und als Kachelzahl' },
  'meldung:tco POST /eingang/abgleich': { ohne: 'technischer Abgleich mit n8n, welche E-Mails schon geliefert sind' },
  'meldung:tco POST /eingang/vorgaenge/:id/mail-erledigt': { ohne: 'Quittung von n8n, dass die E-Mail im Postfach behandelt ist' },

  // ---------------------------------------------------------------- Selbstbedienung
  'selbst:tco POST /jt/meine/freigeben': { aufgabe: 'JT' },
  'selbst:tco POST /jt/meine/oeffnung': { aufgabe: 'JT' },
  'selbst:tco POST /jt/meine/zeiten': { ohne: 'Erfassung der eigenen Zeiten – das Ereignis ist die Freigabe des Monats' },
  'selbst:tco POST /jt/meine/zeiten/loeschen': { ohne: 'Erfassung der eigenen Zeiten – das Ereignis ist die Freigabe des Monats' },
  'selbst:tco POST /jt/meine/generieren': { ohne: 'Erfassung der eigenen Zeiten – das Ereignis ist die Freigabe des Monats' },
  'selbst:tco POST /verzehr/meine/buchen': { aufgabe: 'VZ_ABSCHLUSS' },
  'selbst:tco POST /verzehr/meine/storno': { aufgabe: 'VZ_ABSCHLUSS' },
  'selbst:tco POST /mitglieder/meine/vorgang/pruefen': { ohne: 'nur Prüfung, es wird nichts geändert' },
  'selbst:tco POST /mitglieder/meine/vorgang': { offen: 'Beitragswechsel und Jugendtraining durch das Mitglied: nur Notiz am Mitglied und E-Mail-Kopie' },
  'selbst:tco POST /mitglieder/meine/kuendigung': { offen: 'Kündigung durch das Mitglied: nur Notiz am Mitglied und E-Mail-Kopie' },
  'selbst:tco PUT /mitglieder/meine/kontakt': { offen: 'Mitglied ändert Anschrift, E-Mail oder Telefon – kein Eintrag im Arbeitsvorrat' },
  'selbst:tco PUT /mitglieder/meine/bank': { offen: 'Mitglied ändert seine Bankverbindung – kein Eintrag im Arbeitsvorrat' },
  'selbst:tco POST /mitglieder/meine/gruppen': { offen: 'Mitglied trägt sich in eine Gruppe ein oder aus – kein Eintrag im Arbeitsvorrat' },
  'selbst:tco PUT /meinkonto': { offen: 'Hallennutzer ändert seine Kontaktdaten – kein Eintrag im Arbeitsvorrat' },
};
