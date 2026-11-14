/**
 * App „Einstellungen“ mit Kapiteln je Anwendung (#232, E1) – ohne Datenbank, nur Quelltext:
 *
 *  - Jeder Absprung aus einer Fach-App (einstellungLink('<modul>', '<kapitel>')) führt auf ein angemeldetes Kapitel.
 *    Zieht ein Kapitel um oder wird es umbenannt, fällt der tote Absprung hier auf.
 *  - Jedes Kapitel verlangt ein Recht, das es im Rechtekatalog gibt.
 *  - Kapitel sind je Anwendung eindeutig; die App selbst hat kein eigenes Recht an der Route (sie zeigt, was man sehen darf).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lesen = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
function dateien(rel: string, endung: RegExp): string[] {
  const dir = path.join(ROOT, rel);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const r = `${rel}/${n}`;
    if (statSync(path.join(ROOT, r)).isDirectory()) return ['node_modules', 'dist', 'migrations'].includes(n) ? [] : dateien(r, endung);
    return endung.test(n) ? [r] : [];
  });
}
const MODULE = readdirSync(path.join(ROOT, 'modules')).filter((m) => existsSync(path.join(ROOT, 'modules', m, 'web/index.ts'))).sort();

/** angemeldete Kapitel: { id: '…', text: '…', …, permission: '…', component: … } in der Liste „einstellungen“ bzw. PORTAL_KAPITEL */
function kapitel(text: string, anker: RegExp): { id: string; text: string; permission: string }[] {
  const start = text.search(anker);
  if (start < 0) return [];
  const ende = text.indexOf('],', start);
  return [...text.slice(start, ende).matchAll(/\{ id: '([^']+)', text: '([^']+)'[^}]*permission: '([^']+)'/g)].map(([, id, t, permission]) => ({ id, text: t, permission }));
}
const KAPITEL: Record<string, { id: string; text: string; permission: string }[]> = {
  core: kapitel(lesen('web/src/einstellungen.ts'), /PORTAL_KAPITEL: EinstellungsKapitel\[\] = \[/),
  ...Object.fromEntries(MODULE.map((m) => [m, kapitel(lesen(`modules/${m}/web/index.ts`), /\beinstellungen: \[/)])),
};
const RECHTE = new Set([...dateien('server/src', /\.ts$/), ...MODULE.flatMap((m) => dateien(`modules/${m}/server`, /\.ts$/))]
  .flatMap((d) => [...lesen(d).matchAll(/'((?:core|[a-z]+)\.[a-z0-9]+:[a-z]+)'/g)].map(([, r]) => r)));

test('Einstellungen: Kapitel je Anwendung angemeldet, eindeutig und mit vorhandenem Recht', () => {
  assert.deepEqual(KAPITEL.core.map((k) => k.id), ['allgemein', 'erscheinungsbild'], 'Kapitel „Portal“');
  assert.ok(KAPITEL.tco?.some((k) => k.id === 'verein'), 'TC Oberthal meldet „Verein und Bank“ an');
  assert.ok(KAPITEL.transport?.some((k) => k.id === 'firma'), 'Euroflex meldet „Firma und Bank“ an');
  for (const [modul, liste] of Object.entries(KAPITEL)) {
    assert.equal(new Set(liste.map((k) => k.id)).size, liste.length, `${modul}: Kapitel-Ids doppelt`);
    assert.equal(new Set(liste.map((k) => k.text)).size, liste.length, `${modul}: Kapitelnamen doppelt`);
    for (const k of liste) {
      for (const r of k.permission.split('|')) assert.ok(RECHTE.has(r), `${modul}.${k.id}: Recht ${r} gibt es im Server nicht`);
    }
  }
});

test('Einstellungen: jeder Absprung aus einer Fach-App führt auf ein angemeldetes Kapitel', () => {
  const quellen = [...dateien('web/src', /\.tsx?$/), ...MODULE.flatMap((m) => dateien(`modules/${m}/web`, /\.tsx?$/))];
  let geprueft = 0;
  for (const d of quellen) {
    for (const [, modul, id] of lesen(d).matchAll(/\beinstellungLink\('([a-z]+)', '([a-z-]+)'\)/g)) {
      assert.ok(KAPITEL[modul]?.some((k) => k.id === id), `${d}: einstellungLink('${modul}', '${id}') – dieses Kapitel gibt es nicht (mehr)`);
      geprueft++;
    }
    // Absprünge immer über einstellungLink mit festen Namen – sonst lässt sich das Ziel nicht prüfen
    assert.ok(!/einstellungLink\((?!'[a-z]+', '[a-z-]+'\))/.test(lesen(d).replace(/export const einstellungLink[^\n]*/, '')), `${d}: einstellungLink bitte mit festen Namen aufrufen`);
  }
  assert.ok(geprueft >= 3, `nur ${geprueft} Absprünge gefunden – Erkennung prüfen`);
});

test('Einstellungen: die App zeigt die Kapitel, die man sehen darf – Route ohne eigenes Recht, Menü über die Kapitel', () => {
  const core = lesen('web/src/shell/core.tsx');
  assert.match(core, /\{ path: '\/admin\/einstellungen', component: EinstellungenPage \}/, 'Route ohne permission');
  assert.match(lesen('web/src/shell/nav.ts'), /e\.path === EINSTELLUNGEN_PFAD \? kapitelGruppen\(modules, can\)\.length > 0 : can\(e\.permission\)/, 'Menüeintrag hängt an den Kapiteln');
});
