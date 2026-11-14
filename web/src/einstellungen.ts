import type { EinstellungsKapitel, LogoVerwendung, WebModule } from './platform';
import { PortalAllgemein, PortalErscheinungsbild } from './pages/einstellungen/Portal';

/**
 * App „Einstellungen“ (Administration → Einstellungen, #232 E1): eine App, links die Kapitel je Anwendung, rechts der Inhalt.
 * Der Kern bringt das Kapitel „Portal“ mit, jedes Modul meldet seine Kapitel an (WebModule.einstellungen) – so wie
 * Module ihre Anbindungen anmelden. Ein Kapitel sieht, wer das Recht dafür hat; die App erscheint im Menü, sobald man
 * mindestens ein Kapitel sehen darf (z. B. der Kassenwart ohne Administratorrolle).
 */
export const EINSTELLUNGEN_PFAD = '/admin/einstellungen';

export const PORTAL_KAPITEL: EinstellungsKapitel[] = [
  { id: 'allgemein', text: 'Allgemein', icon: 'home', permission: 'core.settings:edit', component: PortalAllgemein },
  // auch für alle sichtbar, die das Logo ihrer Anwendung pflegen dürfen (E2: alle Logos an einer Stelle)
  { id: 'erscheinungsbild', text: 'Erscheinungsbild', icon: 'palette', permission: 'core.settings:edit', component: PortalErscheinungsbild,
    auch: (modules, can) => logoVerwendungen(modules, can).length > 0 },
];

/** Logos der Anwendungen, die der Benutzer pflegen darf – in der Reihenfolge der Module */
export function logoVerwendungen(modules: WebModule[], can: (p?: string) => boolean): { modul: string; name: string; logo: LogoVerwendung }[] {
  return modules.flatMap((m) => (m.logos ?? []).filter((l) => can(l.permission)).map((logo) => ({ modul: m.id, name: m.name, logo })));
}

export interface KapitelGruppe { modul: string; name: string; kapitel: EinstellungsKapitel[] }

/** Kapitel, die der Benutzer sehen darf – Anwendungen ohne sichtbares Kapitel entfallen */
export function kapitelGruppen(modules: WebModule[], can: (p?: string) => boolean): KapitelGruppe[] {
  return [
    { modul: 'core', name: 'Portal', kapitel: PORTAL_KAPITEL },
    ...modules.filter((m) => m.einstellungen?.length).map((m) => ({ modul: m.id, name: m.name, kapitel: m.einstellungen! })),
  ].map((g) => ({ ...g, kapitel: g.kapitel.filter((k) => can(k.permission) || !!k.auch?.(modules, can)) })).filter((g) => g.kapitel.length > 0);
}

/** Adresse eines Kapitels – für das Zahnrad in den Fach-Apps: gepflegt wird an einer Stelle, gefunden von beiden Seiten */
export const einstellungLink = (modul: string, kapitel: string): string => `${EINSTELLUNGEN_PFAD}?kapitel=${modul}.${kapitel}`;
