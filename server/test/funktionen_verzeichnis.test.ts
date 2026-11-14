/**
 * Funktionsschalter (#232, F1): Die angemeldeten Funktionen stimmen mit dem Quelltext überein – ohne Datenbank.
 *
 *  - Jede Funktion gehört zu einer App des Rechtekatalogs ihres Moduls; App-Namen sind je Modul eindeutig
 *    (sie sind die Id der App im Verzeichnis und im Menü).
 *  - Ihre Rechte und Routen gibt es im Quelltext des Moduls – eine umbenannte Route fällt hier auf.
 *  - Jede Funktion wirkt auch wirklich: über ein Recht, eine Route oder eine Abfrage funktionAktiv() im Server.
 *  - Abgeschaltetes wird nicht angezeigt: Funktionen ohne eigenes Recht fragt die Oberfläche mit useFunktion() ab;
 *    öffentliche Seiten (ohne Sitzung) zeigen den Hinweis „nicht verfügbar“, wenn der Server „abgeschaltet“ meldet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FunktionDef } from '../src/funktionsschalter.js';
import { KERN_FUNKTIONEN } from '../src/funktionen-kern.js';
import { TCO_FUNKTIONEN } from '../../modules/tco/server/funktionen.js';
import { TRANSPORT_FUNKTIONEN } from '../../modules/transport/server/funktionen.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lesen = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
/** alle Quelltexte eines Ordners (ohne Tests und Migrationen) in einem Stück */
function quelltext(rel: string, endung: RegExp): string {
  const dir = path.join(ROOT, rel);
  if (!existsSync(dir)) return '';
  return readdirSync(dir).sort().map((n) => {
    const r = `${rel}/${n}`;
    if (statSync(path.join(ROOT, r)).isDirectory()) return ['migrations', 'test', 'assets', 'node_modules'].includes(n) ? '' : quelltext(r, endung);
    return endung.test(n) && !/\.test\.ts$/.test(n) ? lesen(r) : '';
  }).join('\n');
}

interface Modul { id: string; funktionen: FunktionDef[]; katalog: string; server: string; web: string; webIndex?: string }
const MODULE: Modul[] = [
  { id: 'core', funktionen: KERN_FUNKTIONEN, katalog: lesen('server/src/permissions.ts'), server: quelltext('server/src', /\.ts$/), web: quelltext('web/src', /\.tsx?$/) },
  { id: 'tco', funktionen: TCO_FUNKTIONEN, katalog: lesen('modules/tco/server/index.ts'), server: quelltext('modules/tco/server', /\.ts$/), web: quelltext('modules/tco/web', /\.tsx?$/), webIndex: 'modules/tco/web/index.ts' },
  { id: 'transport', funktionen: TRANSPORT_FUNKTIONEN, katalog: lesen('modules/transport/server/index.ts'), server: quelltext('modules/transport/server', /\.ts$/), web: quelltext('modules/transport/web', /\.tsx?$/) },
];
const regexSicher = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Datei der öffentlichen Seite zu einem Pfad – aus WebModule.oeffentlich und den Importen des Moduls */
function oeffentlicheSeite(m: Modul, pfad: string): string | null {
  if (!m.webIndex) return null;
  const index = lesen(m.webIndex);
  const komponente = new RegExp(`\\{ pfad: '${regexSicher(pfad)}', component: (\\w+)`).exec(index)?.[1];
  const von = komponente && new RegExp(`import \\{[^}]*\\b${komponente}\\b[^}]*\\} from '(\\.[^']+)'`).exec(index)?.[1];
  return von ? path.posix.normalize(`${path.posix.dirname(m.webIndex)}/${von}.tsx`) : null;
}

for (const m of MODULE) {
  /** (Bereich, App) aus dem Rechtekatalog */
  const apps = [...m.katalog.matchAll(/\barea: '([^']+)', app: '([^']+)'/g)].map(([, bereich, app]) => ({ bereich, app }));

  test(`${m.id}: App-Namen sind je Modul eindeutig (Id der App im Verzeichnis und im Menü)`, () => {
    assert.ok(apps.length > 0, 'Rechtekatalog nicht erkannt');
    const bereichJeApp = new Map<string, Set<string>>();
    for (const a of apps) bereichJeApp.set(a.app, (bereichJeApp.get(a.app) ?? new Set()).add(a.bereich));
    const doppelt = [...bereichJeApp].filter(([, b]) => b.size > 1).map(([app, b]) => `${app} (${[...b].join(', ')})`);
    assert.deepEqual(doppelt, [], 'Dieselbe App steht in mehreren Bereichen');
  });

  test(`${m.id}: jede angemeldete Funktion gehört zu einer App, ihre Rechte und Routen gibt es`, () => {
    const ids = m.funktionen.map((f) => f.id);
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], 'Id doppelt');
    for (const f of m.funktionen) {
      assert.ok(f.id.startsWith(`${m.id}.`), `${f.id}: Id beginnt mit „${m.id}.“`);
      assert.ok(!/^[mba]:/.test(f.id), `${f.id}: Präfixe m:, b:, a: gehören Anwendung, Bereich und App`);
      assert.ok(apps.some((a) => a.app === f.app), `${f.id}: App „${f.app}“ gibt es im Rechtekatalog nicht (mehr)`);
      assert.ok(f.text.trim() && f.beschreibung.trim().length >= 10, `${f.id}: Name und Beschreibung`);
      for (const p of f.permissions ?? []) {
        assert.ok(m.server.includes(`'${p}'`), `${f.id}: Recht ${p} gibt es im Quelltext nicht (mehr)`);
      }
      for (const r of f.routen ?? []) {
        const [methode, pfad] = r.split(' ');
        assert.ok(/^(GET|POST|PUT|DELETE|PATCH)$/.test(methode) && pfad?.startsWith('/'), `${f.id}: Route „${r}“ – erwartet „METHODE /pfad“`);
        assert.ok(new RegExp(`\\bapp\\.${methode.toLowerCase()}\\('${regexSicher(pfad)}'`).test(m.server), `${f.id}: Route ${r} gibt es im Quelltext nicht (mehr)`);
      }
    }
  });

  test(`${m.id}: jede Funktion wirkt im Server und wird in der Oberfläche nicht mehr angezeigt`, () => {
    for (const f of m.funktionen) {
      const perRecht = !!f.permissions?.length;
      const perRoute = !!f.routen?.length;
      // Konstante mit dieser Id (z. B. F_MANUELL = 'tco.fi.manuell') oder die Id selbst – neben einer Abfrage funktionAktiv()
      const konstante = new RegExp(`const (\\w+) = '${regexSicher(f.id)}'`).exec(m.server)?.[1];
      const imHandler = m.server.includes('funktionAktiv(') && [f.id, konstante].some((n) => n && new RegExp(`\\b${regexSicher(n)}\\b[^\\n]*\\n?[^\\n]*funktionAktiv\\(|funktionAktiv\\([^)]*${regexSicher(n)}`).test(m.server));
      assert.ok(perRecht || perRoute || imHandler, `${f.id}: wirkt nirgends – braucht ein Recht, eine Route oder eine Abfrage funktionAktiv() im Handler`);
      if (f.seite) {
        // öffentliche Seite: braucht eine Route (ohne Anmeldung gibt es kein Recht) und zeigt bei „abgeschaltet“ den Hinweis
        assert.ok(perRoute, `${f.id}: eine öffentliche Seite braucht Routen, die abgewiesen werden`);
        const datei = oeffentlicheSeite(m, f.seite);
        assert.ok(datei, `${f.id}: Seite ${f.seite} ist in ${m.webIndex} nicht als öffentliche Seite angemeldet`);
        const quelle = lesen(datei);
        assert.ok(quelle.includes('istAbgeschaltet(') && quelle.includes('<NichtVerfuegbar'), `${f.id}: ${datei} zeigt keinen Hinweis, wenn die Funktion abgeschaltet ist`);
      } else if (!perRecht) {
        // Ein eigenes Recht blendet überall aus, wo es geprüft wird. Alles andere muss die Oberfläche selbst abfragen.
        assert.ok(m.web.includes(`'${f.id}'`), `${f.id}: Die Oberfläche fragt die Funktion nicht ab (useFunktion) – sie würde weiter angezeigt`);
      }
      if (f.nurMitApp) assert.ok(!perRecht, `${f.id}: „nur mit der App“ ist für Seiten hinter verschickten Links gedacht, nicht für Rechte`);
    }
  });
}
