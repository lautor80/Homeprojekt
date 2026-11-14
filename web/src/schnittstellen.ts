import type { SchnittstellenAbschnitt, WebModule } from './platform';

/**
 * App „Schnittstellen“ (Administration → Schnittstellen, #232 S1): ein Reiter je Schnittstelle, darin je Bereich ein Block –
 * erst der Zugang (Anbindungen, vom Server), dann die Abschnitte, die ein Modul für diese Schnittstelle anmeldet
 * (WebModule.schnittstellen): Importe, Regeln, Felder. Eine neue Schnittstelle ist ein neuer Reiter.
 */
export const SCHNITTSTELLEN_PFAD = '/admin/schnittstellen';
/** Reiter „API-Schlüssel“ (Zugriff von außen) */
export const REITER_API = 'api';
/** Schlüssel eines Reiters für die Adresse (?tab=paperless) */
export const reiterSchluessel = (reiter: string): string => reiter.toLowerCase().replace(/[^a-z0-9]+/g, '');
/** Adresse eines Reiters – für Absprünge aus den Fach-Apps */
export const schnittstelleLink = (reiter: string): string => `${SCHNITTSTELLEN_PFAD}?tab=${reiterSchluessel(reiter)}`;

export interface AbschnittGruppe { modul: string; name: string; abschnitte: SchnittstellenAbschnitt[] }

/** Abschnitte der Module, die der Benutzer sehen darf */
export function schnittstellenAbschnitte(modules: WebModule[], can: (p?: string) => boolean): AbschnittGruppe[] {
  return modules.map((m) => ({ modul: m.id, name: m.name, abschnitte: (m.schnittstellen ?? []).filter((a) => can(a.permission)) })).filter((g) => g.abschnitte.length > 0);
}

/** Die App erscheint im Menü, sobald man etwas darin sehen darf: Zugänge und Regeln, API-Schlüssel oder einen Abschnitt eines Moduls */
export function schnittstellenSichtbar(modules: WebModule[], can: (p?: string) => boolean): boolean {
  return can('core.settings:edit') || can('core.apikeys:display') || schnittstellenAbschnitte(modules, can).length > 0;
}
