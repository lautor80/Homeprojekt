import type { KontextDef } from './lib/paperless-mapping.js';
import type { VerbindungDef } from './lib/verbindungen.js';
import type { MailFolge, Wiederholung } from './lib/mail.js';
import type { MailPerson } from './lib/mailuebersicht.js';
import type { FastifyInstance } from 'fastify';
import type { PermissionDef } from './permissions.js';
import type { SensitiveFieldDef } from './schutz.js';
import type { Tx } from './db.js';

export interface AuditObjectDef {
  type: string;
  text: string;
  permission: string;
  /** Sperre dieses Objekts sperrt auch diese Objekttypen mit gleichem Schlüssel (z. B. Mitglied → Schlüssel) */
  sperrtAuch?: string[];
}

/**
 * Schnittstelle eines Fachmoduls (serverseitig).
 *
 * Ein Modul bringt mit:
 *  - eigene Berechtigungen (erscheinen automatisch in der Rollenpflege),
 *  - eigene SQL-Migrationen (eigenes DB-Schema, z. B. "transport"),
 *  - eigene API-Routen unter /api/m/<id>/...
 *
 * Die Oberfläche des Moduls liegt in modules/<id>/web und wird in
 * web/src/modules.ts registriert.
 */
export interface ServerModule {
  id: string;
  name: string;
  permissions: PermissionDef[];
  /**
   * Objekttypen mit Änderungsbelegen und die Berechtigung, mit der ein Benutzer
   * die Historie eines einzelnen Objekts sehen darf (Button "Änderungshistorie").
   */
  auditObjects?: AuditObjectDef[];
  /**
   * Geschützte Spalten: In Änderungsbelegen werden alte/neue Werte ohne die angegebene
   * Berechtigung maskiert (z. B. IBAN). Siehe server/src/schutz.ts.
   */
  sensitiveFields?: SensitiveFieldDef[];
  /** Absoluter Pfad zum Ordner mit *.sql-Migrationen (alphabetisch ausgeführt). */
  migrationsDir?: string;
  /** Registriert die Routen. Prefix /api/m/<id> wird automatisch gesetzt. */
  routes?: (app: FastifyInstance) => Promise<void> | void;
  /** Ablagekontexte für Paperless mit Platzhaltern und Standardregel (zentrale Zuordnung, Administration) */
  paperlessKontexte?: KontextDef[];
  /**
   * Selbstregistrierung (Anmeldeseite → „Registrieren“): öffentlicher Pfad unter /api/m/<id>/… mit GET (Info) und POST
   * (Registrierung). Der Server stellt sicher, dass so angelegte Benutzer nur die vorgesehene Rolle erhalten.
   */
  registrierung?: { pfad: string; titel: string; text: string };
  /**
   * Sperren ohne die Berechtigung des Objekttyps erlauben, wenn es das EIGENE Objekt des Benutzers ist
   * (z. B. Mitglied in „Meine Mitgliedschaft“). true = erlaubt.
   */
  sperreErlaubt?: (req: import('fastify').FastifyRequest, objekt: string, schluessel: string) => Promise<boolean>;
  /**
   * Vor dem Löschen eines Benutzers (Administration → Benutzer): Grund, warum er nicht gelöscht werden darf
   * (z. B. „3 Platzbuchungen vorhanden“), sonst null. Läuft in der Lösch-Transaktion.
   */
  benutzerLoeschenSperre?: (tx: Tx, benutzerId: string) => Promise<string | null>;
  /** nach einer Rücksicherung (z. B. Systemrollen und feste Berechtigungen wiederherstellen) */
  nachRuecksicherung?: () => Promise<void>;
  /** Sperrbare Objekte ohne Änderungsbeleg (z. B. PLATZZEIT: ausgewählte, noch nicht gesicherte Platzbuchung) */
  sperrObjekte?: AuditObjectDef[];
  /**
   * Mailprotokoll → „Erneut senden“ für Mails mit Zugangslinks (werden nie gespeichert): das Modul erzeugt für seine
   * Wiederholungsarten einen neuen Link und sendet (cc: Kopie an diese Adresse); null = Art nicht zuständig. Siehe server/src/lib/mail.ts.
   */
  mailWiederholen?: (tx: Tx, w: Wiederholung, wer: string, cc?: string) => Promise<string | null>;
  /** nach erfolgreicher Wiederholung nachziehen, was der erste Versand getan hätte (z. B. Rechnung „versendet“); null = nicht zuständig */
  mailFolge?: (tx: Tx, f: MailFolge) => Promise<string[] | null>;
  /**
   * E-Mail-Protokoll (Administration → E-Mail-Protokoll): wem gehören diese Empfängeradressen (klein geschrieben)?
   * Das Modul meldet seine Personen (z. B. Mitglied, Hallenkunde, Registrierung); Benutzer ergänzt der Kern.
   */
  mailPersonen?: (db: Tx, emails: string[]) => Promise<MailPerson[]>;
  /**
   * Angeschlossene Systeme des Moduls (Administration → Anbindungen): Adresse und Zugangsdaten werden zentral
   * gepflegt und mit verbindungLesen(id) gelesen. Ids mit Präfix „<modul>.“ (z. B. tco.ep3). Paperless meldet der Kern.
   */
  verbindungen?: VerbindungDef[];
}
