import { modulAktiv } from './config.js';
import type { AuditObjectDef, ServerModule } from './module.js';
import { corePermissions, gliedern, type PermissionGroup } from './permissions.js';
import type { SensitiveFieldDef } from './schutz.js';
import type { KontextDef } from './lib/paperless-mapping.js';
import { NEXTCLOUD_DEF } from './lib/nextcloud.js';
import type { VerbindungGruppe } from './lib/verbindungen.js';
import { MAIL_DEF } from './lib/mail.js';
import type { FunktionDef } from './funktionsschalter.js';
import { KERN_FUNKTIONEN } from './funktionen-kern.js';

// ---------------------------------------------------------------------------
// Verfügbare Fachmodule. Neues Modul: hier importieren und eintragen.
// Welche davon aktiv sind, steuert PORTAL_MODULES in der .env.
// ---------------------------------------------------------------------------
import beispiel from '../../modules/beispiel/server/index.js';
import transport from '../../modules/transport/server/index.js';
import tco from '../../modules/tco/server/index.js';

const available: ServerModule[] = [beispiel, transport, tco];

export function activeModules(): ServerModule[] {
  return available.filter((m) => modulAktiv(m.id));
}

export const activeModuleIds = () => activeModules().map((m) => m.id);

export function permissionCatalog(): PermissionGroup[] {
  return [
    { module: 'core', name: 'Basis', permissions: corePermissions, areas: gliedern('Basis', corePermissions) },
    ...activeModules().map((m) => ({ module: m.id, name: m.name, permissions: m.permissions, areas: gliedern(m.name, m.permissions) })),
  ];
}

const coreAuditObjects: AuditObjectDef[] = [
  { type: 'USER', text: 'Benutzer', permission: 'core.users:display' },
  { type: 'USER_ROLE', text: 'Rollenzuordnung', permission: 'core.users:display' },
  { type: 'ROLE', text: 'Rolle', permission: 'core.roles:display' },
  { type: 'SETTING', text: 'Einstellung', permission: 'core.settings:edit' },
  { type: 'API_KEY', text: 'API-Schlüssel', permission: 'core.apikeys:display' },
  { type: 'PAPERLESS_MAPPING', text: 'Paperless-Zuordnung', permission: 'core.settings:edit' },
  { type: 'VERBINDUNG', text: 'Anbindung', permission: 'core.settings:edit' },
  { type: 'FUNKTION', text: 'Funktionsschalter', permission: 'core.funktionen:edit' },
  { type: 'BACKUP_EXPORT', text: 'Nextcloud-Export der Sicherung', permission: 'core.backup:create' },
];

export function auditObjects(): AuditObjectDef[] {
  return [...coreAuditObjects, ...activeModules().flatMap((m) => m.auditObjects ?? [])];
}

/** Paperless-Ablagekontexte aller aktiven Module (der Client kommt aus der Paperless-Anbindung des jeweiligen Bereichs, paperlessFuer) */
export function paperlessKontexte(): { modul: string; name: string; kontexte: KontextDef[] }[] {
  return activeModules().filter((m) => m.paperlessKontexte?.length).map((m) => ({ modul: m.id, name: m.name, kontexte: m.paperlessKontexte! }));
}

/** Anbindungen des Kerns und aller aktiven Module (Administration → Schnittstellen) */
export function verbindungsGruppen(): VerbindungGruppe[] {
  return [
    // Paperless meldet jeder Bereich selbst an (#232, S5: eigener Zugang je Bereich) – der Kern hat keinen gemeinsamen mehr
    { modul: 'core', name: 'Basis', verbindungen: [MAIL_DEF, NEXTCLOUD_DEF] },
    ...activeModules().filter((m) => m.verbindungen?.length).map((m) => ({ modul: m.id, name: m.name, verbindungen: m.verbindungen! })),
  ];
}

/** Einzelne abschaltbare Funktionen des Kerns und aller aktiven Module (Administration → Einstellungen → Funktionen) */
export function funktionsDefs(): { modul: string; def: FunktionDef }[] {
  return [
    ...KERN_FUNKTIONEN.map((def) => ({ modul: 'core', def })),
    ...activeModules().flatMap((m) => (m.funktionen ?? []).map((def) => ({ modul: m.id, def }))),
  ];
}

export function verbindungDef(id: string) {
  for (const g of verbindungsGruppen()) {
    const d = g.verbindungen.find((v) => v.id === id);
    if (d) return { gruppe: g, def: d };
  }
  return null;
}

/** Geschützte Spalten aller aktiven Module (für die Maskierung der Änderungsbelege) */
export function sensitiveFields(): SensitiveFieldDef[] {
  return activeModules().flatMap((m) => m.sensitiveFields ?? []);
}
