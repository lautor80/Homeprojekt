export interface PermissionDef {
  /** "<objekt>:<aktivität>", z. B. "core.users:edit" */
  id: string;
  /** Anzeigetext in der Rollenpflege */
  text: string;
}

export interface PermissionGroup {
  module: string;
  name: string;
  permissions: PermissionDef[];
}

export const corePermissions: PermissionDef[] = [
  { id: 'core.users:display', text: 'Benutzer anzeigen' },
  { id: 'core.users:edit', text: 'Benutzer anlegen und ändern' },
  { id: 'core.roles:display', text: 'Rollen anzeigen' },
  { id: 'core.roles:edit', text: 'Rollen anlegen und ändern' },
  { id: 'core.audit:display', text: 'Änderungsbelege anzeigen (alle Objekte)' },
  { id: 'core.settings:edit', text: 'Systemeinstellungen ändern' },
  { id: 'core.apikeys:display', text: 'API-Schlüssel anzeigen' },
  { id: 'core.apikeys:edit', text: 'API-Schlüssel anlegen, ändern und sperren' },
];

/** Prüft, ob eine Menge von Berechtigungen eine bestimmte Berechtigung enthält. */
export function hasPermission(granted: Set<string>, required: string): boolean {
  if (granted.has('*') || granted.has(required)) return true;
  // "modul.objekt:*" erlaubt alle Aktivitäten eines Objekts
  const [object] = required.split(':');
  return granted.has(`${object}:*`);
}
