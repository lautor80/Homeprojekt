/**
 * Menü und Rollenpflege sind gleich gegliedert (#232, N6, A1, B4) – ohne Datenbank, nur Quelltext.
 *
 *  - Jede Gruppe des Menüs ist ein Bereich des Rechtekatalogs, in derselben Reihenfolge. Lose Apps eines Moduls
 *    (ohne Gruppe) stehen im Katalog im Bereich mit ihrem Namen, sonst im Bereich mit dem Namen des Moduls,
 *    sonst in „Allgemein“.
 *  - Jede App des Menüs ist eine App dieses Bereichs im Katalog und umgekehrt, in derselben Reihenfolge.
 *  - Bereiche und Apps stehen im Katalog zusammenhängend.
 *  - Icons: Das Zahnrad steht nur für Einstellungen; innerhalb eines Moduls hat jede App ihr eigenes Icon.
 *
 * Ausnahmen sind unten benannt und begründet – sie sollen mit E1, S1 und N7 verschwinden.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lesen = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

interface Eintrag { text: string; icon?: string; path?: string; permission?: string; children?: Eintrag[] }

/** Klammerausdruck ab Position i (dort steht „[“ oder „{“) bis zur passenden schließenden Klammer – Zeichenketten und Zeilenkommentare zählen nicht */
function klammer(text: string, i: number): string {
  const auf = text[i];
  const zu = auf === '[' ? ']' : '}';
  let tiefe = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === "'" || c === '"' || c === '`') { j++; while (text[j] !== c) { if (text[j] === '\\') j++; j++; } continue; }
    if (c === '/' && text[j + 1] === '/') { while (text[j] !== '\n') j++; continue; }
    if (c === auf) tiefe++;
    else if (c === zu && --tiefe === 0) return text.slice(i, j + 1);
  }
  throw new Error('schließende Klammer nicht gefunden');
}
/** Das Menü ist ein reines Literal (nur Texte) – deshalb lässt es sich ohne die Oberfläche auswerten */
const literal = <T>(quelle: string): T => new Function(`return (${quelle});`)() as T;

function menue(datei: string, anker: string): Eintrag {
  const text = lesen(datei);
  const i = text.indexOf(anker);
  assert.ok(i >= 0, `${datei}: „${anker}“ nicht gefunden`);
  const wert = literal<Eintrag | Eintrag[]>(klammer(text, i + anker.length - 1));
  const wurzel = Array.isArray(wert) ? wert[0] : wert;
  assert.ok(wurzel?.children?.length, `${datei}: Menü nicht erkannt`);
  return wurzel;
}

/** (Bereich, App) je Berechtigung in Deklarationsreihenfolge */
function katalog(datei: string): { bereich: string; app: string }[] {
  return [...lesen(datei).matchAll(/\barea: '([^']+)', app: '([^']+)'/g)].map(([, bereich, app]) => ({ bereich, app }));
}
const ohneDoppelte = (l: string[]) => l.filter((x, i) => l.indexOf(x) === i);
/** steht jeder Wert in einem Stück? */
const zusammenhaengend = (l: string[]) => l.every((x, i) => i === 0 || l[i - 1] === x || l.indexOf(x) === i);

interface Modul {
  name: string;
  menue: Eintrag;
  katalog: { bereich: string; app: string }[];
  /** Bereiche, die es nur in der Rollenpflege gibt (kein Menüpunkt) */
  nurKatalogBereiche?: string[];
  /** Apps, die es nur in der Rollenpflege gibt */
  nurKatalogApps?: string[];
  /** Menüpunkte ohne eigene App im Katalog – mit Begründung */
  ohneKatalogApp?: Record<string, string>;
}

const MODULE: Modul[] = [
  {
    name: 'Administration', menue: menue('web/src/shell/core.tsx', 'admin: {'), katalog: katalog('server/src/permissions.ts'),
    nurKatalogApps: ['Rollen und Rollenmatrix'],
    ohneKatalogApp: {
      Rollen: 'Rollen und Rollenmatrix teilen sich die Rechte core.roles:* (App „Rollen und Rollenmatrix“)',
      Rollenmatrix: 'Rollen und Rollenmatrix teilen sich die Rechte core.roles:* (App „Rollen und Rollenmatrix“)',
    },
  },
  {
    name: 'TC Oberthal', menue: menue('modules/tco/web/index.ts', 'nav: ['), katalog: katalog('modules/tco/server/index.ts'),
    nurKatalogBereiche: ['Datenschutz'],
  },
  {
    name: 'Euroflex', menue: menue('modules/transport/web/index.ts', 'nav: ['), katalog: katalog('modules/transport/server/index.ts'),
    ohneKatalogApp: { Kontakte: 'hat noch kein eigenes Recht (sichtbar mit „Aufträge anzeigen“) – N7' },
  },
];

/** Bereich im Katalog, in dem ein Menüpunkt der zweiten Stufe steht */
function bereiche(m: Modul): { bereich: string; apps: Eintrag[] }[] {
  const vorhanden = new Set(m.katalog.map((k) => k.bereich));
  const out: { bereich: string; apps: Eintrag[] }[] = [];
  for (const e of m.menue.children ?? []) {
    const bereich = e.children ? e.text : vorhanden.has(e.text) ? e.text : vorhanden.has(m.menue.text) ? m.menue.text : 'Allgemein';
    const ziel = out.find((b) => b.bereich === bereich) ?? out[out.push({ bereich, apps: [] }) - 1];
    ziel.apps.push(...(e.children ?? [e]));
  }
  return out;
}

for (const m of MODULE) {
  test(`${m.name}: Menü und Rollenpflege haben dieselben Bereiche in derselben Reihenfolge`, () => {
    assert.ok(m.katalog.length > 0, 'Rechtekatalog nicht erkannt');
    assert.ok(zusammenhaengend(m.katalog.map((k) => k.bereich)), 'Im Katalog steht ein Bereich nicht zusammenhängend');
    const imMenue = bereiche(m).map((b) => b.bereich);
    const imKatalog = ohneDoppelte(m.katalog.map((k) => k.bereich)).filter((b) => !m.nurKatalogBereiche?.includes(b));
    assert.deepEqual(imKatalog, imMenue, 'Bereiche der Rollenpflege (links) und Gruppen des Menüs (rechts) weichen ab');
  });

  test(`${m.name}: jede App steht im Menü und in der Rollenpflege im selben Bereich, in derselben Reihenfolge`, () => {
    for (const b of bereiche(m)) {
      const kat = m.katalog.filter((k) => k.bereich === b.bereich).map((k) => k.app);
      assert.ok(zusammenhaengend(kat), `${b.bereich}: Im Katalog steht eine App nicht zusammenhängend (${ohneDoppelte(kat).join(', ')})`);
      const imKatalog = ohneDoppelte(kat).filter((a) => !m.nurKatalogApps?.includes(a));
      const imMenue = b.apps.map((a) => a.text).filter((a) => !(m.ohneKatalogApp && a in m.ohneKatalogApp));
      assert.deepEqual(imKatalog, imMenue, `${b.bereich}: Apps der Rollenpflege (links) und des Menüs (rechts) weichen ab`);
    }
    // Ausnahmen müssen noch zutreffen – sonst entfernen
    const alleApps = bereiche(m).flatMap((b) => b.apps.map((a) => a.text));
    for (const a of Object.keys(m.ohneKatalogApp ?? {})) assert.ok(alleApps.includes(a), `Ausnahme „${a}“ gibt es im Menü nicht mehr – aus dem Test entfernen`);
    for (const a of m.nurKatalogApps ?? []) assert.ok(m.katalog.some((k) => k.app === a), `Ausnahme „${a}“ gibt es im Katalog nicht mehr – aus dem Test entfernen`);
  });

  test(`${m.name}: Zahnrad nur für Einstellungen, jede App mit eigenem Icon`, () => {
    const alle = (e: Eintrag): Eintrag[] => [e, ...(e.children ?? []).flatMap(alle)];
    for (const e of alle(m.menue)) {
      if (e.icon === 'action-settings') assert.equal(e.text, 'Einstellungen', `„${e.text}“ trägt das Zahnrad – es steht nur für Einstellungen`);
    }
    const apps = alle(m.menue).filter((e) => e.path);
    for (const a of apps) {
      assert.ok(a.icon, `„${a.text}“ hat kein Icon`);
      const gleich = apps.filter((x) => x.icon === a.icon).map((x) => x.text);
      assert.deepEqual(gleich, [a.text], `Icon „${a.icon}“ mehrfach vergeben`);
    }
  });
}
