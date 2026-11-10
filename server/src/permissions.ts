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
  { id: 'core.mail:display', text: 'E-Mail-Protokoll anzeigen: alle E-Mails des Portals mit Empfänger, Betreff, Status und Fehler (ohne Inhalt), gesammelt je Person oder Vorgang', area: 'Administration', app: 'E-Mail-Protokoll' },
  { id: 'core.mail:edit', text: 'E-Mails aus dem E-Mail-Protokoll erneut senden – auch bereits gesendete, mit Kopie (CC) an den Absender; Zugangslinks werden dabei neu erzeugt', area: 'Administration', app: 'E-Mail-Protokoll' },
  { id: 'core.settings:edit', text: 'Systemeinstellungen ändern', area: 'Administration', app: 'Einstellungen' },
  { id: 'core.statistik:display', text: 'Nutzungsstatistik anzeigen (Anmeldungen je Benutzer und Monat, Aufrufe je App)', area: 'Administration', app: 'Statistik' },
  { id: 'core.sperren:admin', text: 'Sperreinträge aller Benutzer anzeigen und aufheben', area: 'Administration', app: 'Sperren' },
  { id: 'core.tabellen:display', text: 'Tabellenansicht: Struktur und Inhalt aller Datenbanktabellen lesen, selektieren und gruppieren (nur lesend; Kennwort-Hashes, Tokens und Zugangsschlüssel nie, Bankdaten nur mit der Bankdaten-Berechtigung im Klartext)', area: 'Administration', app: 'Tabellenansicht' },
  { id: 'core.tabellen:delete', text: 'Tabellenansicht: markierte Datensätze löschen und aus dem Papierkorb wiederherstellen (Papierkorb 7 Tage; Sätze mit abhängigen Einträgen und Änderungsbelege nicht)', area: 'Administration', app: 'Tabellenansicht', requires: ['core.tabellen:display'] },
  { id: 'core.backup:create', text: 'Sicherungen erstellen, herunterladen und löschen (enthalten alle Daten, auch Kennwort-Hashes und Bankdaten)', area: 'Administration', app: 'Sicherung' },
  { id: 'core.backup:restore', text: 'Sicherungen hochladen und zurücksichern (ersetzt Daten!)', area: 'Administration', app: 'Sicherung', requires: ['core.backup:create'] },
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
