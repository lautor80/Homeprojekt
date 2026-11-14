import type { PermissionGroup } from './permissions.js';

/**
 * Prüfungen der Rollenpflege (#46, Administration → Benutzer und Rechte → Rollenmatrix): Überlappungen zwischen Rollen,
 * überflüssige Rollenzuordnungen, Funktionstrennung, fehlende Voraussetzungen, unbekannte Rechte.
 * Reine Funktion ohne Datenbank – die Routen liefern Rollen, Katalog und Benutzer.
 */
export type Stufe = 'FEHLER' | 'WARNUNG' | 'HINWEIS';
export type BefundArt = 'GLEICH' | 'ENTHALTEN' | 'UEBERLAPPUNG' | 'BENUTZER_DOPPELT' | 'TRENNUNG' | 'TRENNUNG_BENUTZER'
  | 'VORAUSSETZUNG' | 'UNBEKANNT' | 'LEER' | 'OHNE_BENUTZER' | 'UNVERGEBEN';

export interface Befund {
  art: BefundArt; stufe: Stufe; text: string;
  /** betroffene Rollen (für den Vergleich in der Matrix) und Rechte */
  rollen: string[]; rechte: string[];
  /** betroffene Benutzer (Anzeigenamen) */
  benutzer?: string[];
}

/** Unerwünschte Kombination zweier Rechte in einer Hand (Berechtigungskonzept 4.8) */
export interface RechteKonflikt { a: string; b: string; text: string }
export const coreKonflikte: RechteKonflikt[] = [
  { a: 'core.roles:edit', b: 'core.users:edit', text: 'Rollen bauen und selbst vergeben – entspricht Administratorrechten' },
];

export interface PruefRolle { id: string; name: string; permissions: string[]; system?: boolean; userCount?: number }
export interface PruefBenutzer { name: string; rollen: string[] }

/** Anteil gemeinsamer Rechte, ab dem zwei Rollen als stark überlappend gemeldet werden */
export const UEBERLAPPUNG_AB = 0.6;
const ART_TEXT: Record<BefundArt, string> = {
  GLEICH: 'Rollen deckungsgleich', ENTHALTEN: 'Rolle vollständig enthalten', UEBERLAPPUNG: 'Hohe Überlappung',
  BENUTZER_DOPPELT: 'Benutzer mit überflüssiger Rolle', TRENNUNG: 'Funktionstrennung (in einer Rolle)',
  TRENNUNG_BENUTZER: 'Funktionstrennung (Benutzer über mehrere Rollen)', VORAUSSETZUNG: 'Voraussetzung fehlt',
  UNBEKANNT: 'Unbekanntes Recht', LEER: 'Rolle ohne Rechte', OHNE_BENUTZER: 'Rolle ohne Benutzer', UNVERGEBEN: 'Recht in keiner Rolle',
};
export const befundArtText = (a: BefundArt) => ART_TEXT[a];
const REIHENFOLGE: Stufe[] = ['FEHLER', 'WARNUNG', 'HINWEIS'];

export function rollenPruefen(alle: PruefRolle[], katalog: PermissionGroup[], konflikte: RechteKonflikt[], benutzer: PruefBenutzer[]): Befund[] {
  const out: Befund[] = [];
  // ADMIN bzw. Rollen mit „*“ haben alles – sie nehmen an Vergleichen nicht teil
  const rollen = alle.filter((r) => !r.permissions.includes('*'));
  const allmacht = new Set(alle.filter((r) => r.permissions.includes('*')).map((r) => r.id));
  const name = new Map(alle.map((r) => [r.id, `${r.name} (${r.id})`]));
  const menge = new Map(rollen.map((r) => [r.id, new Set(r.permissions)]));
  const requires = new Map<string, string[]>();
  const text = new Map<string, string>();
  for (const g of katalog) for (const a of g.areas) for (const app of a.apps) for (const p of app.permissions) {
    requires.set(p.id, p.requires);
    text.set(p.id, `${app.name}: ${p.text}`);
  }
  const t = (p: string) => text.get(p) ?? p;
  const kurz = (l: string[], n = 5) => (l.length > n ? `${l.slice(0, n).join(', ')} und ${l.length - n} weitere` : l.join(', '));

  // ---- je Rolle
  for (const r of rollen) {
    const m = menge.get(r.id)!;
    const unbekannt = r.permissions.filter((p) => !requires.has(p));
    if (unbekannt.length) {
      out.push({ art: 'UNBEKANNT', stufe: 'FEHLER', rollen: [r.id], rechte: unbekannt,
        text: `${name.get(r.id)} enthält Kennungen, die es im Katalog nicht (mehr) gibt: ${kurz(unbekannt)}. Sie wirken nicht und sollten entfernt werden.` });
    }
    const fehlt = r.permissions.filter((p) => (requires.get(p) ?? []).some((v) => !m.has(v)));
    if (fehlt.length) {
      out.push({ art: 'VORAUSSETZUNG', stufe: 'FEHLER', rollen: [r.id], rechte: fehlt,
        text: `${name.get(r.id)}: ${kurz(fehlt.map((p) => `„${t(p)}“ braucht ${requires.get(p)!.filter((v) => !m.has(v)).map((v) => `„${t(v)}“`).join(', ')}`), 3)}.` });
    }
    for (const k of konflikte) {
      if (m.has(k.a) && m.has(k.b)) {
        out.push({ art: 'TRENNUNG', stufe: 'WARNUNG', rollen: [r.id], rechte: [k.a, k.b],
          text: `${name.get(r.id)} vereint „${t(k.a)}“ und „${t(k.b)}“: ${k.text}.` });
      }
    }
    if (!r.permissions.length) out.push({ art: 'LEER', stufe: 'HINWEIS', rollen: [r.id], rechte: [], text: `${name.get(r.id)} enthält keine Rechte.` });
    else if (r.userCount === 0) out.push({ art: 'OHNE_BENUTZER', stufe: 'HINWEIS', rollen: [r.id], rechte: [], text: `${name.get(r.id)} ist keinem Benutzer zugeordnet.` });
  }

  // ---- Rollenpaare: deckungsgleich, enthalten, stark überlappend
  const enthalten = (a: Set<string>, b: Set<string>) => [...a].every((p) => b.has(p));
  for (let i = 0; i < rollen.length; i++) {
    for (let j = i + 1; j < rollen.length; j++) {
      const [x, y] = [rollen[i], rollen[j]];
      const [a, b] = [menge.get(x.id)!, menge.get(y.id)!];
      if (!a.size || !b.size) continue;
      const gemeinsam = [...a].filter((p) => b.has(p));
      if (a.size === b.size && gemeinsam.length === a.size) {
        out.push({ art: 'GLEICH', stufe: 'FEHLER', rollen: [x.id, y.id], rechte: gemeinsam,
          text: `${name.get(x.id)} und ${name.get(y.id)} enthalten genau dieselben ${a.size} Rechte – eine der beiden Rollen ist überflüssig.` });
      } else if (enthalten(a, b) || enthalten(b, a)) {
        const [klein, gross] = a.size < b.size ? [x, y] : [y, x];
        out.push({ art: 'ENTHALTEN', stufe: 'WARNUNG', rollen: [klein.id, gross.id], rechte: gemeinsam,
          text: `Alle ${gemeinsam.length} Rechte von ${name.get(klein.id)} stecken auch in ${name.get(gross.id)}. Wer beide Rollen hat, braucht ${klein.id} nicht.` });
      } else {
        const anteil = gemeinsam.length / (a.size + b.size - gemeinsam.length);
        if (gemeinsam.length >= 3 && anteil >= UEBERLAPPUNG_AB) {
          out.push({ art: 'UEBERLAPPUNG', stufe: 'HINWEIS', rollen: [x.id, y.id], rechte: gemeinsam,
            text: `${name.get(x.id)} und ${name.get(y.id)} teilen ${gemeinsam.length} Rechte (${Math.round(anteil * 100)} % Überlappung); nur in ${x.id}: ${a.size - gemeinsam.length}, nur in ${y.id}: ${b.size - gemeinsam.length}.` });
        }
      }
    }
  }

  // ---- Benutzer: überflüssige Rolle, Funktionstrennung über mehrere Rollen (Administratoren ausgenommen)
  const doppelt = new Map<string, { rollen: string[]; benutzer: string[] }>();
  const getrennt = new Map<string, { k: RechteKonflikt; rollen: Set<string>; benutzer: string[] }>();
  for (const u of benutzer) {
    if (u.rollen.some((r) => allmacht.has(r))) continue;
    const eigene = u.rollen.filter((r) => menge.has(r));
    for (const x of eigene) for (const y of eigene) {
      if (x === y) continue;
      const [a, b] = [menge.get(x)!, menge.get(y)!];
      // x bringt nichts Zusätzliches zu y (bei Gleichheit nur einmal melden)
      if (a.size && enthalten(a, b) && (a.size < b.size || x < y)) {
        const e = doppelt.get(`${x}|${y}`) ?? { rollen: [x, y], benutzer: [] };
        e.benutzer.push(u.name);
        doppelt.set(`${x}|${y}`, e);
      }
    }
    for (const k of konflikte) {
      const mitA = eigene.filter((r) => menge.get(r)!.has(k.a));
      const mitB = eigene.filter((r) => menge.get(r)!.has(k.b));
      // steckt beides schon in einer Rolle, meldet das die Rollenprüfung
      if (!mitA.length || !mitB.length || eigene.some((r) => menge.get(r)!.has(k.a) && menge.get(r)!.has(k.b))) continue;
      const e = getrennt.get(`${k.a}|${k.b}`) ?? { k, rollen: new Set<string>(), benutzer: [] };
      for (const r of [...mitA, ...mitB]) e.rollen.add(r);
      e.benutzer.push(u.name);
      getrennt.set(`${k.a}|${k.b}`, e);
    }
  }
  for (const e of doppelt.values()) {
    out.push({ art: 'BENUTZER_DOPPELT', stufe: 'WARNUNG', rollen: e.rollen, rechte: [], benutzer: e.benutzer,
      text: `${e.benutzer.length} Benutzer ${e.benutzer.length === 1 ? 'hat' : 'haben'} ${e.rollen[0]} und ${e.rollen[1]}, obwohl ${e.rollen[0]} nichts Zusätzliches bringt: ${kurz(e.benutzer)}.` });
  }
  for (const e of getrennt.values()) {
    out.push({ art: 'TRENNUNG_BENUTZER', stufe: 'WARNUNG', rollen: [...e.rollen].sort(), rechte: [e.k.a, e.k.b], benutzer: e.benutzer,
      text: `${kurz(e.benutzer)} ${e.benutzer.length === 1 ? 'erhält' : 'erhalten'} über mehrere Rollen „${t(e.k.a)}“ und „${t(e.k.b)}“: ${e.k.text}.` });
  }

  // ---- Rechte, die in keiner Rolle stecken (nur über ADMIN erreichbar)
  const vergeben = new Set(rollen.flatMap((r) => r.permissions));
  const frei = [...requires.keys()].filter((p) => !vergeben.has(p));
  if (frei.length) {
    out.push({ art: 'UNVERGEBEN', stufe: 'HINWEIS', rollen: [], rechte: frei,
      text: `${frei.length} Recht${frei.length === 1 ? ' steckt' : 'e stecken'} in keiner Rolle und ${frei.length === 1 ? 'ist' : 'sind'} nur für Administratoren erreichbar.` });
  }
  return out.sort((x, y) => REIHENFOLGE.indexOf(x.stufe) - REIHENFOLGE.indexOf(y.stufe));
}

// ---------------------------------------------------------------------------
// Verprobung (#46): Was dürfte ein Benutzer mit dem (ggf. noch nicht gesicherten) Stand der Rollen – und optional mit
// probeweise zugeordneten Rollen – im Vergleich zu heute?
// ---------------------------------------------------------------------------
export interface VerprobRolle { id: string; name: string; permissions: string[]; inaktiv?: boolean }
export interface VerprobBenutzer { id: string; name: string; username: string; aktiv: boolean; rollen: string[] }
export interface Verprobung {
  id: string; name: string; username: string; aktiv: boolean;
  rollenJetzt: string[]; rollenProbe: string[];
  /** alle Rechte (Rolle mit „*“) */
  allesJetzt: boolean; allesProbe: boolean;
  anzahlJetzt: number; anzahlProbe: number;
  /** Rechte in der Probe mit den Rollen, aus denen sie stammen */
  rechte: { id: string; text: string; app: string; rollen: string[] }[];
  dazu: string[]; weg: string[];
  /** erreichbare Apps („Bereich › App“) in der Probe */
  apps: string[];
  befunde: { stufe: Stufe; text: string }[];
}

export function verproben(
  jetzt: VerprobRolle[], probe: VerprobRolle[], katalog: PermissionGroup[], konflikte: RechteKonflikt[],
  benutzer: VerprobBenutzer[], zuordnung: { rollen: string[]; modus: 'ZUSAETZLICH' | 'ERSETZEN' } | null,
): Verprobung[] {
  const info = new Map<string, { text: string; app: string }>();
  for (const g of katalog) for (const a of g.areas) for (const app of a.apps) for (const p of app.permissions) info.set(p.id, { text: p.text, app: `${a.name} › ${app.name}` });
  const alle = [...info.keys()];
  const rj = new Map(jetzt.map((r) => [r.id, r]));
  const rp = new Map(probe.map((r) => [r.id, r]));
  // wirksame Rechte: deaktivierte Rollen gewähren nichts, „*“ gewährt alles
  const wirksam = (rollen: string[], stand: Map<string, VerprobRolle>) => {
    const quelle = new Map<string, string[]>();
    let alles = false;
    for (const id of rollen) {
      const r = stand.get(id);
      if (!r || r.inaktiv) continue;
      if (r.permissions.includes('*')) alles = true;
      for (const p of r.permissions.includes('*') ? alle : r.permissions) quelle.set(p, [...(quelle.get(p) ?? []), id]);
    }
    return { quelle, alles };
  };
  return benutzer.map((u) => {
    const rollenProbe = !zuordnung ? u.rollen
      : [...new Set([...(zuordnung.modus === 'ERSETZEN' ? [] : u.rollen), ...zuordnung.rollen])].filter((r) => rp.has(r)).sort();
    const a = wirksam(u.rollen, rj);
    const b = wirksam(rollenProbe, rp);
    const t = (p: string) => info.get(p)?.text ?? p;
    const befunde: Verprobung['befunde'] = [];
    const aktiv = rollenProbe.map((r) => rp.get(r)!).filter((r) => r && !r.inaktiv && !r.permissions.includes('*'));
    if (!b.alles) {
      for (const k of konflikte) {
        if (b.quelle.has(k.a) && b.quelle.has(k.b)) {
          befunde.push({ stufe: 'WARNUNG', text: `Funktionstrennung: „${t(k.a)}“ (${b.quelle.get(k.a)!.join(', ')}) und „${t(k.b)}“ (${b.quelle.get(k.b)!.join(', ')}) – ${k.text}.` });
        }
      }
      for (const x of aktiv) for (const y of aktiv) {
        if (x.id === y.id || !x.permissions.length) continue;
        const in_y = new Set(y.permissions);
        if (x.permissions.every((p) => in_y.has(p)) && (x.permissions.length < y.permissions.length || x.id < y.id)) {
          befunde.push({ stufe: 'WARNUNG', text: `Rolle ${x.id} ist überflüssig: alle ihre Rechte stecken auch in ${y.id}.` });
        }
      }
    } else if (rollenProbe.length > 1) {
      befunde.push({ stufe: 'HINWEIS', text: 'Hat über eine Rolle alle Rechte – die übrigen Rollen ändern nichts.' });
    }
    for (const r of rollenProbe) if (rp.get(r)?.inaktiv) befunde.push({ stufe: 'HINWEIS', text: `Rolle ${r} ist derzeit deaktiviert und gewährt nichts.` });
    const unbekannt = [...b.quelle.keys()].filter((p) => !info.has(p));
    if (unbekannt.length) befunde.push({ stufe: 'FEHLER', text: `Wirkungslose Kennungen (nicht im Katalog): ${unbekannt.join(', ')}.` });
    if (!u.aktiv) befunde.push({ stufe: 'HINWEIS', text: 'Benutzer ist gesperrt – die Rechte wirken erst nach dem Entsperren.' });
    if (!b.quelle.size) befunde.push({ stufe: 'HINWEIS', text: 'Hätte keine Rechte.' });
    const rechte = [...b.quelle.entries()].filter(([p]) => info.has(p))
      .map(([id, rollen]) => ({ id, text: info.get(id)!.text, app: info.get(id)!.app, rollen }))
      .sort((x, y) => alle.indexOf(x.id) - alle.indexOf(y.id));
    return {
      id: u.id, name: u.name, username: u.username, aktiv: u.aktiv, rollenJetzt: u.rollen, rollenProbe,
      allesJetzt: a.alles, allesProbe: b.alles, anzahlJetzt: a.quelle.size, anzahlProbe: b.quelle.size,
      rechte,
      dazu: [...b.quelle.keys()].filter((p) => !a.quelle.has(p)).sort((x, y) => alle.indexOf(x) - alle.indexOf(y)),
      weg: [...a.quelle.keys()].filter((p) => !b.quelle.has(p)).sort((x, y) => alle.indexOf(x) - alle.indexOf(y)),
      apps: [...new Set(rechte.map((r) => r.app))],
      befunde,
    };
  });
}
