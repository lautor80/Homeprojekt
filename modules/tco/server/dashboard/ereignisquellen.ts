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
  'schnittstelle:mail': { hinweis: 'MAIL_FEHLER' },
  'schnittstelle:tco.ep3': { ueberwacht: 'V_EP3' },
  'schnittstelle:tco.stunden': { ueberwacht: 'V_STUNDEN' },
  'schnittstelle:tco.ferien': { ueberwacht: 'V_FERIEN' },
  'schnittstelle:tco.mailabruf': { ueberwacht: 'V_MAILABRUF' },
  'schnittstelle:tco.nextcloud': { ueberwacht: 'V_NEXTCLOUD' },
  'schnittstelle:transport.mail': { ohne: 'Euroflex sendet nur aus dem Dialog am Auftrag (#235): das Ergebnis sieht der Absender sofort und wiederholt dort; kein Hintergrundlauf, jede E-Mail steht im E-Mail-Protokoll' },

  // ---------------------------------------------------------------- automatische Läufe
  'lauf:server/src/backup-export.ts': { aufgabe: 'BACKUP_EXPORT' },
  'lauf:modules/tco/server/platz/routes.ts': { aufgabe: ['ABO_FREIGABE', 'ABO_MAIL', 'ABO_BEWERBUNG'] },
  'lauf:modules/tco/server/instandhaltung/routes.ts': { aufgabe: 'SCHADEN' },
  'lauf:modules/tco/server/mitglieder/routes.ts': { hinweis: 'MG_SPERRE' },

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

  // ---------------------------------------------------------------- Meldungen
  'meldung:tco POST /schaden': { aufgabe: 'SCHADEN' },
  'meldung:tco POST /eingang/mail': { aufgabe: ['EINGANG_PRUEFEN', 'EINGANG_FEHLER'] },
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
  'selbst:tco POST /mitglieder/meine/vorgang': { hinweis: 'MG_VORGANG' },
  'selbst:tco POST /mitglieder/meine/kuendigung': { aufgabe: 'KUENDIGUNG' },
  'selbst:tco PUT /mitglieder/meine/kontakt': { hinweis: 'MG_KONTAKT' },
  'selbst:tco PUT /mitglieder/meine/bank': { hinweis: 'MG_BANK' },
  'selbst:tco POST /mitglieder/meine/gruppen': { hinweis: 'MG_GRUPPE' },
  'selbst:tco PUT /meinkonto': { hinweis: ['HN_KONTAKT', 'MG_KONTAKT'] },
};
