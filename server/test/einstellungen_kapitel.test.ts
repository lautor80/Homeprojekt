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
  assert.match(lesen('web/src/shell/nav.ts'), /e\.path === EINSTELLUNGEN_PFAD \? kapitelGruppen\(modules, can\)\.length > 0 : /, 'Menüeintrag hängt an den Kapiteln');
});

test('Schnittstellen: Abschnitte der Module angemeldet, Absprünge treffen einen vorhandenen Reiter, Route ohne eigenes Recht', () => {
  const abschnitte = Object.fromEntries(MODULE.map((m) => {
    const text = lesen(`modules/${m}/web/index.ts`);
    const start = text.search(/\bschnittstellen: \[/);
    const liste = start < 0 ? [] : [...text.slice(start, text.indexOf('],', start)).matchAll(/\{ reiter: '([^']+)', id: '([^']+)', text: '([^']+)', permission: '([^']+)'/g)]
      .map(([, reiter, id, t, permission]) => ({ reiter, id, text: t, permission }));
    return [m, liste];
  }));
  assert.ok(abschnitte.tco?.some((a) => a.reiter === 'SAP'), 'TC Oberthal: Übernahme aus SAP im Reiter „SAP“');
  assert.ok(abschnitte.transport?.some((a) => a.reiter === 'SAP'), 'Euroflex: Datenimport im Reiter „SAP“');
  for (const [modul, liste] of Object.entries(abschnitte)) {
    assert.equal(new Set(liste.map((a) => a.id)).size, liste.length, `${modul}: Abschnitts-Ids doppelt`);
    for (const a of liste) for (const r of a.permission.split('|')) assert.ok(RECHTE.has(r), `${modul}.${a.id}: Recht ${r} gibt es im Server nicht`);
  }
  // Reiter: von Anbindungen (Server: reiter: '…') oder von Abschnitten
  const server = [...dateien('server/src', /\.ts$/), ...MODULE.flatMap((m) => dateien(`modules/${m}/server`, /\.ts$/))];
  const reiter = new Set([...server.flatMap((d) => [...lesen(d).matchAll(/\breiter: '([^']+)'/g)].map(([, r]) => r)), ...Object.values(abschnitte).flat().map((a) => a.reiter)]);
  for (const r of ['Paperless', 'E-Mail', 'EP3', 'Nextcloud', 'SAP']) assert.ok(reiter.has(r), `Reiter „${r}“ nicht gefunden – Erkennung prüfen`);
  let geprueft = 0;
  for (const d of [...dateien('web/src', /\.tsx?$/), ...MODULE.flatMap((m) => dateien(`modules/${m}/web`, /\.tsx?$/))]) {
    for (const [, r] of lesen(d).matchAll(/\bschnittstelleLink\('([^']+)'\)/g)) {
      assert.ok(reiter.has(r), `${d}: schnittstelleLink('${r}') – diesen Reiter gibt es nicht (mehr)`);
      geprueft++;
    }
  }
  assert.ok(geprueft >= 2, `nur ${geprueft} Absprünge gefunden – Erkennung prüfen`);
  assert.match(lesen('web/src/shell/core.tsx'), /\{ path: '\/admin\/schnittstellen', component: SchnittstellenPage \}/, 'Route ohne permission');
  assert.match(lesen('web/src/shell/nav.ts'), /e\.path === SCHNITTSTELLEN_PFAD \? schnittstellenSichtbar\(modules, can\)/, 'Menüeintrag hängt an Reitern und Abschnitten');
});

test('Logos: alle an einer Stelle – Module melden ihr Logo an, das Kapitel „Erscheinungsbild“ zeigt sie (#232, E2)', () => {
  const logos = Object.fromEntries(MODULE.map((m) => {
    const text = lesen(`modules/${m}/web/index.ts`);
    return [m, [...text.matchAll(/\blogos: \[\{ id: '([^']+)', text: '([^']+)', permission: '([^']+)'/g)].map(([, id, t, permission]) => ({ id, text: t, permission }))];
  }));
  assert.deepEqual(logos.tco?.map((l) => l.id), ['kopfband'], 'TC Oberthal meldet das Logo des Kopfbands an');
  assert.deepEqual(logos.transport?.map((l) => l.id), ['ausdrucke'], 'Euroflex meldet das Logo der Ausdrucke an');
  for (const [modul, liste] of Object.entries(logos)) {
    for (const l of liste) assert.ok(RECHTE.has(l.permission), `${modul}.${l.id}: Recht ${l.permission} gibt es im Server nicht`);
  }
  // das Kapitel zeigt die angemeldeten Logos und ist auch ohne Administratorrecht sichtbar, wenn man eines pflegen darf
  const portal = lesen('web/src/pages/einstellungen/Portal.tsx');
  assert.match(portal, /logoVerwendungen\(enabledModules\(me\.modules\), can\)/);
  assert.match(lesen('web/src/einstellungen.ts'), /id: 'erscheinungsbild'[^}]*auch: \(modules, can\) => logoVerwendungen\(modules, can\)\.length > 0/s);
  assert.match(lesen('web/src/einstellungen.ts'), /can\(k\.permission\) \|\| !!k\.auch\?\.\(modules, can\)/);
  // in den Fach-Formularen steht kein zweites Feld zum Ablegen mehr, nur der Verweis
  for (const d of ['modules/tco/web/Stammdaten.tsx', 'modules/transport/web/Stammdaten.tsx']) {
    const t = lesen(d);
    assert.equal([...t.matchAll(/<AblageFlaeche ziel=\{\{ titel: '(?:Vereinslogo|Logo für Ausdrucke)'/g)].length, 1, `${d}: genau ein Feld zum Ablegen des Logos`);
    assert.match(t, /einstellungLink\('core', 'erscheinungsbild'\)/, `${d}: Verweis auf das Kapitel Erscheinungsbild`);
  }
});
