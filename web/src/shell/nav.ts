import type { NavEntry } from '../platform';
import type { WebModule } from '../platform';
import { coreNav } from './core';

/**
 * Navigation (Seitenleiste und Startseite aus derselben Quelle): Start, Fachmodule, Administration –
 * gefiltert nach Berechtigung, leere Gruppen entfallen.
 */
export function navAufbauen(modules: WebModule[], can: (p?: string) => boolean): NavEntry[] {
  const filter = (entries: NavEntry[]): NavEntry[] =>
    entries
      .filter((e) => can(e.permission))
      .map((e) => (e.children ? { ...e, children: filter(e.children) } : e))
      .filter((e) => !e.children || e.children.length > 0);
  return filter([coreNav.home, ...modules.flatMap((m) => m.nav), coreNav.admin]);
}
