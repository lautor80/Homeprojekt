import { modulAktiv } from './config.js';
import type { AuditObjectDef, ServerModule } from './module.js';
import { corePermissions, gliedern, type PermissionGroup } from './permissions.js';
import type { SensitiveFieldDef } from './schutz.js';
import type { KontextDef } from './lib/paperless-mapping.js';
import type { Paperless } from './lib/paperless.js';

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
];

export function auditObjects(): AuditObjectDef[] {
  return [...coreAuditObjects, ...activeModules().flatMap((m) => m.auditObjects ?? [])];
}

/** Paperless-Ablagekontexte aller aktiven Module */
export function paperlessKontexte(): { modul: string; name: string; kontexte: KontextDef[]; client?: () => Promise<Paperless | null> }[] {
  return activeModules().filter((m) => m.paperlessKontexte?.length).map((m) => ({ modul: m.id, name: m.name, kontexte: m.paperlessKontexte!, client: m.paperlessClient }));
}

/** Geschützte Spalten aller aktiven Module (für die Maskierung der Änderungsbelege) */
export function sensitiveFields(): SensitiveFieldDef[] {
  return activeModules().flatMap((m) => m.sensitiveFields ?? []);
}
