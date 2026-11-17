/**
 * Tabellenansicht (Spalten ein-/ausblenden, Spaltenfilter, Sortierung) – reine Funktionen ohne React.
 * Der Stand ist ein einfaches JSON-Objekt und wird so in Ansichtsvarianten gespeichert (Varianten.tsx).
 * Komponente und Hook: TabellenAnsicht.tsx. Tests: server/test/tabellen_ansicht.test.ts.
 */

export interface TabellenFilter { id: string; value: string }
export interface TabellenSortierung { id: string; desc: boolean }
export interface TabellenStand {
  /** ausgeblendete Spalten (Ids) */
  aus: string[];
  /** Spaltenfilter (Text je Spalte, wie im Kopf der Tabelle eingegeben) */
  filter: TabellenFilter[];
  /** Sortierung, erste Spalte zuerst */
  sortierung: TabellenSortierung[];
}

export const LEERER_STAND: TabellenStand = { aus: [], filter: [], sortierung: [] };

/** die Teile einer Spaltendefinition, die hier gebraucht werden */
export interface SpalteInfo { id?: string; accessor?: unknown; Header?: unknown }

/** Id einer Spalte wie in react-table: id, sonst der Accessor-Text, sonst die Überschrift */
export function spaltenId(c: SpalteInfo): string {
  if (c.id) return c.id;
  if (typeof c.accessor === 'string') return c.accessor;
  return typeof c.Header === 'string' ? c.Header : '';
}

/** Überschrift für die Spaltenauswahl */
export function spaltenText(c: SpalteInfo): string {
  return typeof c.Header === 'string' && c.Header ? c.Header : spaltenId(c);
}

/** Spalten ohne die ausgeblendeten – Pflichtspalten bleiben immer stehen */
export function sichtbareSpalten<C extends SpalteInfo>(spalten: C[], stand: TabellenStand, pflicht: string[] = []): C[] {
  const aus = new Set(stand.aus.filter((id) => !pflicht.includes(id)));
  return spalten.filter((c) => !aus.has(spaltenId(c)));
}

/**
 * Stand aus einer gespeicherten Variante prüfen (ids = bekannte Spalten; ohne ids nur die Form): nur bekannte Spalten, nur Text-Filter, keine Filter oder Sortierung auf
 * ausgeblendeten Spalten, Pflichtspalten nie aus. Unbrauchbares fällt still weg (alte Varianten nach Spaltenänderungen).
 */
export function standLesen(wert: unknown, ids?: string[] | null, pflicht: string[] = []): TabellenStand {
  const o = (wert && typeof wert === 'object' ? wert : {}) as Record<string, unknown>;
  const bekannt = { has: (id: string) => !ids || ids.includes(id) };
  const liste = (v: unknown) => (Array.isArray(v) ? v : []);
  const aus = [...new Set(liste(o.aus).filter((x): x is string => typeof x === 'string' && bekannt.has(x) && !pflicht.includes(x)))];
  const sichtbar = (id: string) => bekannt.has(id) && !aus.includes(id);
  const filter: TabellenFilter[] = [];
  for (const f of liste(o.filter)) {
    const x = f as Record<string, unknown>;
    if (typeof x?.id === 'string' && sichtbar(x.id) && typeof x.value === 'string' && x.value.trim() && !filter.some((y) => y.id === x.id)) {
      filter.push({ id: x.id, value: x.value });
    }
  }
  const sortierung: TabellenSortierung[] = [];
  for (const s of liste(o.sortierung)) {
    const x = s as Record<string, unknown>;
    if (typeof x?.id === 'string' && sichtbar(x.id) && !sortierung.some((y) => y.id === x.id)) sortierung.push({ id: x.id, desc: x.desc === true });
  }
  return { aus, filter, sortierung };
}

/** Spalte ein- oder ausblenden; ausgeblendet verliert sie ihren Filter und ihre Sortierung */
export function spalteSetzen(stand: TabellenStand, id: string, sichtbar: boolean): TabellenStand {
  if (sichtbar) return { ...stand, aus: stand.aus.filter((x) => x !== id) };
  return {
    aus: stand.aus.includes(id) ? stand.aus : [...stand.aus, id],
    filter: stand.filter.filter((f) => f.id !== id),
    sortierung: stand.sortierung.filter((s) => s.id !== id),
  };
}

/** Zustand der Tabelle (react-table state.filters / state.sortBy) in den Stand übernehmen */
export function ausTabelle(stand: TabellenStand, filters: unknown, sortBy: unknown): TabellenStand {
  const f = (Array.isArray(filters) ? filters : [])
    .map((x) => x as { id?: unknown; value?: unknown })
    .filter((x) => typeof x.id === 'string' && typeof x.value === 'string' && x.value.trim())
    .map((x) => ({ id: x.id as string, value: x.value as string }));
  const s = (Array.isArray(sortBy) ? sortBy : [])
    .map((x) => x as { id?: unknown; desc?: unknown })
    .filter((x) => typeof x.id === 'string')
    .map((x) => ({ id: x.id as string, desc: x.desc === true }));
  return { ...stand, filter: f, sortierung: s };
}

/**
 * Haben sich Filter oder Sortierung der Tabelle seit dem letzten Zeichnen geändert? (react-table ersetzt die Listen bei jeder
 * Änderung, daher genügt der Vergleich der Referenzen.) Ohne vorherigen Stand: nein – das erste Zeichnen ist keine Änderung.
 * Hintergrund: onSort/onFilter kommen, bevor die Tabelle ihren Zustand aktualisiert – die Sortierung fehlte so in Varianten.
 */
export function tabellenAenderung(neu: { filters?: unknown; sortBy?: unknown } | null | undefined, alt: { filters?: unknown; sortBy?: unknown } | null | undefined): boolean {
  if (!neu || !alt) return false;
  return neu.sortBy !== alt.sortBy || neu.filters !== alt.filters;
}

/** gleicher Inhalt? (verhindert Schleifen zwischen Tabelle und Stand) */
export function gleich(a: TabellenStand, b: TabellenStand): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** kurze Beschreibung der gesetzten Filter: „Kunde: brandt · Route: mannheim“ */
export function filterText(stand: TabellenStand, spalten: SpalteInfo[]): string {
  return stand.filter.map((f) => {
    const c = spalten.find((x) => spaltenId(x) === f.id);
    return `${c ? spaltenText(c) : f.id}: ${f.value}`;
  }).join(' · ');
}
