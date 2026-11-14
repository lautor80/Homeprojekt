import type { NavEntry } from '../platform';
import type { WebModule } from '../platform';
import { appId } from '../session';
import { coreNav } from './core';

/**
 * Navigation (Seitenleiste und Startseite aus derselben Quelle): Start, Fachmodule, Administration –
 * gefiltert nach Berechtigung und Funktionsschaltern, leere Gruppen entfallen.
 *
 * Funktionsschalter (#232, F1): Eine abgeschaltete App verliert ihre Rechte und fällt damit von selbst heraus. Teilt sie
 * sich ihr Recht mit einer anderen App (z. B. Hallenpreise), greift der Name: App im Menü = App im Verzeichnis.
 */
export function navAufbauen(modules: WebModule[], can: (p?: string) => boolean, an: (id: string) => boolean = () => true): NavEntry[] {
  const filter = (entries: NavEntry[], modul: string): NavEntry[] =>
    entries
      .filter((e) => can(e.permission) && (!e.path || an(appId(modul, e.text))))
      .map((e) => (e.children ? { ...e, children: filter(e.children, modul) } : e))
      .filter((e) => !e.children || e.children.length > 0);
  return [...filter([coreNav.home], 'core'), ...modules.flatMap((m) => filter(m.nav, m.id)), ...filter([coreNav.admin], 'core')];
}

/** Pfade abgeschalteter Apps – ihre Seiten (auch Unterseiten) werden nicht mehr angezeigt */
export function abgeschaltetePfade(modules: WebModule[], an: (id: string) => boolean): string[] {
  const blaetter = (entries: NavEntry[], modul: string): string[] =>
    entries.flatMap((e) => [...(e.path && !an(appId(modul, e.text)) ? [e.path] : []), ...blaetter(e.children ?? [], modul)]);
  return [...modules.flatMap((m) => blaetter(m.nav, m.id)), ...blaetter([coreNav.admin], 'core')];
}

export const pfadAbgeschaltet = (pfad: string, aus: string[]): boolean => aus.some((p) => pfad === p || pfad.startsWith(`${p}/`));
