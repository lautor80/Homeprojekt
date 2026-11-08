import type { KontextDef } from './lib/paperless-mapping.js';
import type { Paperless } from './lib/paperless.js';
import type { FastifyInstance } from 'fastify';
import type { PermissionDef } from './permissions.js';
import type { SensitiveFieldDef } from './schutz.js';

export interface AuditObjectDef {
  type: string;
  text: string;
  permission: string;
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
  /** Paperless-Client des Moduls (für Auswahllisten in der Zuordnungspflege); null = nicht eingerichtet */
  paperlessClient?: () => Promise<Paperless | null>;
}
