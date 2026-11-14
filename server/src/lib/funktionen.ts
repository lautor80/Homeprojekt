/**
 * Funktionsschalter (#232, F1): Verzeichnis aller abschaltbaren Funktionen, Berechnung der Wirkung, Laden und Sichern.
 *
 * Das Verzeichnis hat vier Stufen und entsteht von selbst:
 *   Anwendung → Bereich → App      aus dem Rechtekatalog (dieselbe Gliederung wie Menü und Rollenpflege)
 *   → Funktion                     meldet das Modul an (ServerModule.funktionen), im Kern KERN_FUNKTIONEN
 * Eine neue App ist damit ohne weiteres Zutun abschaltbar. „Aus“ gilt für alles darunter.
 *
 * Wirkung (siehe funktionsschalter.ts): Die Rechte des Knotens gelten als nicht vorhanden – und mit ihnen alle
 * Rechte, die eines davon voraussetzen (requires). Angemeldete Routen werden abgewiesen. Daten und Rollen bleiben.
 */
import { sql, type Tx } from '../db.js';
import { funktionsDefs, permissionCatalog } from '../modules.js';
import { appId, bereichId, modulId, schalterSetzen, schalterZustand, type SchalterZustand } from '../funktionsschalter.js';

export interface Knoten {
  id: string;
  art: 'modul' | 'bereich' | 'app' | 'funktion';
  text: string;
  beschreibung?: string;
  hinweis?: string;
  /** Grund, warum sich der Knoten nicht abschalten lässt */
  fest?: string;
  /** Rechte, die beim Abschalten wegfallen (bei Bereich und Anwendung: die der Knoten darunter) */
  rechte: string[];
  /** Routen „METHODE /api/…“, die beim Abschalten abgewiesen werden */
  routen: string[];
  kinder: Knoten[];
}

/** Apps der Administration, ohne die sich das Portal nicht mehr verwalten oder wiederherstellen ließe */
const FESTE_APPS: Record<string, string> = {
  Benutzer: 'Ohne Benutzerverwaltung käme niemand mehr ins Portal.',
  'Rollen und Rollenmatrix': 'Ohne Rollenpflege ließen sich keine Rechte mehr vergeben.',
  Einstellungen: 'Grundeinstellungen und Anbindungen des Portals.',
  Funktionen: 'Diese Pflege selbst – sonst ließe sich nichts wieder einschalten.',
  Sicherung: 'Die Sicherung der Daten läuft immer.',
};
const KERN_FEST = 'Die Administration lässt sich nur App für App abschalten.';

/** „POST /pfad“ eines Moduls → „POST /api/m/<modul>/pfad“ (so heißt die Route im Server) */
export function routenSchluessel(modul: string, route: string): string {
  const [methode, ...rest] = route.trim().split(/\s+/);
  const pfad = rest.join(' ');
  return `${methode.toUpperCase()} ${modul === 'core' ? pfad : `/api/m/${modul}${pfad}`}`;
}

/** Das Verzeichnis: Anwendung → Bereich → App → Funktion */
export function baum(): Knoten[] {
  const defs = funktionsDefs();
  return permissionCatalog().map((g): Knoten => {
    const kern = g.module === 'core';
    const bereiche: Knoten[] = g.areas.map((a): Knoten => ({
      id: bereichId(g.module, a.name), art: 'bereich', text: a.name, fest: kern ? KERN_FEST : undefined, rechte: [], routen: [],
      kinder: a.apps.map((app): Knoten => ({
        id: appId(g.module, app.name), art: 'app', text: app.name, fest: kern ? FESTE_APPS[app.name] : undefined,
        rechte: app.permissions.map((p) => p.id), routen: [],
        kinder: defs.filter((d) => d.modul === g.module && d.def.app === app.name).map(({ def }): Knoten => ({
          id: def.id, art: 'funktion', text: def.text, beschreibung: def.beschreibung, hinweis: def.hinweis,
          rechte: def.permissions ?? [], routen: (def.routen ?? []).map((r) => routenSchluessel(g.module, r)), kinder: [],
        })),
      })),
    }));
    return { id: modulId(g.module), art: 'modul', text: kern ? 'Administration' : g.name, fest: kern ? KERN_FEST : undefined, rechte: [], routen: [], kinder: bereiche };
  });
}

export const alleKnoten = (wurzeln: Knoten[] = baum()): Knoten[] => wurzeln.flatMap((k) => [k, ...alleKnoten(k.kinder)]);

/** alle Rechte des Katalogs mit ihren Voraussetzungen und ihrer App */
function katalogRechte(): { id: string; requires: string[]; app: string }[] {
  return permissionCatalog().flatMap((g) => g.areas.flatMap((a) => a.apps.flatMap((app) => app.permissions.map((p) => ({ id: p.id, requires: p.requires, app: app.name })))));
}

/** Wirkung der abgeschalteten Ids: alles darunter ist mit aus, Rechte mit abgeschalteter Voraussetzung ebenfalls */
export function berechnen(aus: ReadonlySet<string>, wurzeln: Knoten[] = baum()): SchalterZustand {
  const ids = new Set<string>();
  const rechte = new Set<string>();
  const routen = new Map<string, string>();
  const gehen = (k: Knoten, obenAus: boolean): void => {
    const istAus = !k.fest && (obenAus || aus.has(k.id));
    if (istAus) {
      ids.add(k.id);
      for (const r of k.rechte) rechte.add(r);
      for (const r of k.routen) routen.set(r, k.text);
    }
    for (const c of k.kinder) gehen(c, istAus);
  };
  for (const k of wurzeln) gehen(k, false);
  if (rechte.size) {
    const alle = katalogRechte();
    for (let neu = true; neu;) {
      neu = false;
      for (const p of alle) {
        if (!rechte.has(p.id) && p.requires.some((r) => rechte.has(r))) { rechte.add(p.id); neu = true; }
      }
    }
  }
  return { ids, rechte, routen };
}

/** Apps außerhalb des Knotens, die beim Abschalten ganz oder teilweise mit ausfallen (weil ihre Rechte eines seiner Rechte voraussetzen) */
export function folgen(k: Knoten, wurzeln: Knoten[] = baum()): string[] {
  if (k.fest) return [];
  const eigene = new Set(alleKnoten([k]).flatMap((x) => x.rechte));
  const danach = berechnen(new Set([k.id]), wurzeln).rechte;
  const apps = new Map<string, { aus: number; alle: number }>();
  for (const p of katalogRechte()) {
    if (eigene.has(p.id)) continue;
    const z = apps.get(p.app) ?? { aus: 0, alle: 0 };
    z.alle++;
    if (danach.has(p.id)) z.aus++;
    apps.set(p.app, z);
  }
  return [...apps].filter(([, z]) => z.aus > 0).map(([app, z]) => (z.aus === z.alle ? app : `${app} (teilweise)`));
}

// ---------------------------------------------------------------- Laden und Sichern

/** Ids, die der Administrator abgeschaltet hat (nur die betätigten Schalter, ohne das, was darunter liegt) */
export async function ausLesen(): Promise<Set<string>> {
  const rows = await sql`select id from core.funktionen where not aktiv`;
  return new Set(rows.map((r) => r.id as string));
}

let geladen = 0;
let laeuft: Promise<void> | null = null;

/** Zustand aus der Datenbank neu berechnen */
export async function schalterLaden(): Promise<void> {
  schalterSetzen(berechnen(await ausLesen()));
  geladen = Date.now();
}

/**
 * Zustand aktuell halten: nach einer Änderung lädt die Pflege sofort neu; alles andere (Rücksicherung, direkter Eingriff
 * in die Tabelle) wird spätestens nach `maxAlterMs` bemerkt. Schlägt das Laden fehl, bleibt der letzte Zustand gültig.
 */
export async function schalterAktuell(maxAlterMs = 30_000): Promise<void> {
  if (Date.now() - geladen <= maxAlterMs) return;
  laeuft ??= schalterLaden().finally(() => { laeuft = null; });
  try { await laeuft; } catch (e) {
    geladen = Date.now() - maxAlterMs + 5_000; // in 5 Sekunden erneut versuchen
    throw e;
  }
}

/** für Tests und nach einer Rücksicherung: beim nächsten Aufruf neu laden */
export const schalterVergessen = (): void => { geladen = 0; };

export async function schalterSpeichern(tx: Tx, id: string, aktiv: boolean, benutzer: string): Promise<void> {
  await tx`insert into core.funktionen (id, aktiv, geaendert_am, geaendert_von) values (${id}, ${aktiv}, now(), ${benutzer})
           on conflict (id) do update set aktiv = excluded.aktiv, geaendert_am = now(), geaendert_von = excluded.geaendert_von`;
}

// ---------------------------------------------------------------- Antwort für die Pflege

export interface KnotenStand extends Omit<Knoten, 'rechte' | 'routen' | 'kinder'> {
  /** eigener Schalter */
  aktiv: boolean;
  /** tatsächlich an – also auch nichts darüber abgeschaltet */
  wirksam: boolean;
  /** Apps außerhalb, die beim Abschalten mit ausfallen */
  folgen: string[];
  /** selbst an, aber Rechte fehlen, weil sie etwas Abgeschaltetes voraussetzen */
  betroffen?: 'ganz' | 'teilweise';
  kinder: KnotenStand[];
}

export async function stand(): Promise<{ baum: KnotenStand[]; verwaist: string[] }> {
  const wurzeln = baum();
  const aus = await ausLesen();
  const { ids: wirkung, rechte: ohne } = schalterZustand();
  const bekannt = new Set(alleKnoten(wurzeln).map((k) => k.id));
  const betroffen = (k: Knoten): KnotenStand['betroffen'] => {
    if (wirkung.has(k.id) || !k.rechte.length) return undefined;
    const fehlen = k.rechte.filter((r) => ohne.has(r)).length;
    return fehlen === 0 ? undefined : fehlen === k.rechte.length ? 'ganz' : 'teilweise';
  };
  const zeigen = (k: Knoten): KnotenStand => ({
    id: k.id, art: k.art, text: k.text, beschreibung: k.beschreibung, hinweis: k.hinweis, fest: k.fest,
    aktiv: !aus.has(k.id) || !!k.fest, wirksam: !wirkung.has(k.id), folgen: folgen(k, wurzeln), betroffen: betroffen(k), kinder: k.kinder.map(zeigen),
  });
  return { baum: wurzeln.map(zeigen), verwaist: [...aus].filter((id) => !bekannt.has(id)).sort() };
}
