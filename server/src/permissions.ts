export interface PermissionDef {
  /** "<objekt>:<aktivität>", z. B. "core.users:edit" */
  id: string;
  /** Anzeigetext in der Rollenpflege (vollständiger Satz, auch ohne App-Kontext verständlich) */
  text: string;
  /** Menübereich wie in der Navigation, z. B. "Abrechnungen". Ohne Angabe: Bereich = Modulname. */
  area?: string;
  /** App bzw. Menüeintrag, z. B. "Hallenabrechnung". Ohne Angabe: „Allgemein“. */
  app?: string;
  /**
   * Weitere Berechtigungen, ohne die diese nicht nutzbar ist (z. B. Hallenpreise pflegen →
   * Hallenabrechnung anzeigen). Die Anzeigeberechtigung desselben Objekts ("x:display")
   * gilt automatisch als Voraussetzung jeder anderen Aktivität dieses Objekts.
   */
  requires?: string[];
}

/** Eine App mit ihren Berechtigungen (Zeile in der Rollenpflege) */
export interface PermissionApp {
  name: string;
  permissions: (PermissionDef & { requires: string[] })[];
}

/** Ein Menübereich mit seinen Apps */
export interface PermissionArea {
  name: string;
  apps: PermissionApp[];
}

export interface PermissionGroup {
  module: string;
  name: string;
  /** flach, in Deklarationsreihenfolge (für API-Schlüssel u. ä.) */
  permissions: PermissionDef[];
  /** gegliedert nach Menübereich → App, Reihenfolge wie deklariert */
  areas: PermissionArea[];
}

export const corePermissions: PermissionDef[] = [
  { id: 'core.users:display', text: 'Benutzer anzeigen', area: 'Administration', app: 'Benutzer' },
  { id: 'core.users:edit', text: 'Benutzer anlegen und ändern', area: 'Administration', app: 'Benutzer' },
  { id: 'core.roles:display', text: 'Rollen anzeigen', area: 'Administration', app: 'Rollen' },
  { id: 'core.roles:edit', text: 'Rollen anlegen und ändern', area: 'Administration', app: 'Rollen' },
  { id: 'core.apikeys:display', text: 'API-Schlüssel anzeigen', area: 'Administration', app: 'API-Schlüssel' },
  { id: 'core.apikeys:edit', text: 'API-Schlüssel anlegen, ändern und sperren', area: 'Administration', app: 'API-Schlüssel' },
  { id: 'core.audit:display', text: 'Änderungsbelege anzeigen (alle Objekte)', area: 'Administration', app: 'Änderungsbelege' },
  { id: 'core.settings:edit', text: 'Systemeinstellungen ändern', area: 'Administration', app: 'Einstellungen' },
];

/**
 * Gliedert die Berechtigungen eines Moduls nach Menübereich und App und ergänzt die
 * Voraussetzungen (explizite `requires` + Anzeigeberechtigung desselben Objekts).
 */
export function gliedern(moduleName: string, perms: PermissionDef[]): PermissionArea[] {
  const ids = new Set(perms.map((p) => p.id));
  const areas: PermissionArea[] = [];
  for (const p of perms) {
    const areaName = p.area ?? moduleName;
    const appName = p.app ?? 'Allgemein';
    let area = areas.find((a) => a.name === areaName);
    if (!area) areas.push(area = { name: areaName, apps: [] });
    let app = area.apps.find((a) => a.name === appName);
    if (!app) area.apps.push(app = { name: appName, permissions: [] });
    const [objekt, aktivitaet] = p.id.split(':');
    const anzeigen = `${objekt}:display`;
    const requires = new Set(p.requires ?? []);
    if (aktivitaet !== 'display' && ids.has(anzeigen)) requires.add(anzeigen);
    requires.delete(p.id);
    app.permissions.push({ ...p, requires: [...requires] });
  }
  return areas;
}

/** Prüft, ob eine Menge von Berechtigungen eine bestimmte Berechtigung enthält. */
export function hasPermission(granted: Set<string>, required: string): boolean {
  if (granted.has('*') || granted.has(required)) return true;
  // "modul.objekt:*" erlaubt alle Aktivitäten eines Objekts
  const [object] = required.split(':');
  return granted.has(`${object}:*`);
}
