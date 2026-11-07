import { config } from './config.js';
import type { AuditObjectDef, ServerModule } from './module.js';
import { corePermissions, type PermissionGroup } from './permissions.js';

// ---------------------------------------------------------------------------
// Verfügbare Fachmodule. Neues Modul: hier importieren und eintragen.
// Welche davon aktiv sind, steuert PORTAL_MODULES in der .env.
// ---------------------------------------------------------------------------
import beispiel from '../../modules/beispiel/server/index.js';
import transport from '../../modules/transport/server/index.js';
import tco from '../../modules/tco/server/index.js';

const available: ServerModule[] = [beispiel, transport, tco];

export function activeModules(): ServerModule[] {
  return available.filter((m) => config.modules.includes(m.id));
}

export const activeModuleIds = () => activeModules().map((m) => m.id);

export function permissionCatalog(): PermissionGroup[] {
  return [
    { module: 'core', name: 'Basis', permissions: corePermissions },
    ...activeModules().map((m) => ({ module: m.id, name: m.name, permissions: m.permissions })),
  ];
}

const coreAuditObjects: AuditObjectDef[] = [
  { type: 'USER', text: 'Benutzer', permission: 'core.users:display' },
  { type: 'USER_ROLE', text: 'Rollenzuordnung', permission: 'core.users:display' },
  { type: 'ROLE', text: 'Rolle', permission: 'core.roles:display' },
  { type: 'SETTING', text: 'Einstellung', permission: 'core.settings:edit' },
  { type: 'API_KEY', text: 'API-Schlüssel', permission: 'core.apikeys:display' },
];

export function auditObjects(): AuditObjectDef[] {
  return [...coreAuditObjects, ...activeModules().flatMap((m) => m.auditObjects ?? [])];
}
