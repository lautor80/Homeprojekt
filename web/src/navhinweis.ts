import { useSyncExternalStore } from 'react';

/**
 * Hinweise an Einträgen der Seitenleiste („3 neu“): Module melden je Pfad eine Anzahl, die Seitenleiste zeigt sie am Eintrag
 * und – solange die Gruppe eingeklappt ist – an der Gruppe darüber.
 */
let stand: Record<string, number> = {};
const hoerer = new Set<() => void>();

export function setNavHinweis(pfad: string, anzahl: number) {
  if ((stand[pfad] ?? 0) === anzahl) return;
  stand = { ...stand, [pfad]: anzahl };
  hoerer.forEach((h) => h());
}

export function useNavHinweise(): Record<string, number> {
  return useSyncExternalStore((h) => { hoerer.add(h); return () => { hoerer.delete(h); }; }, () => stand);
}
