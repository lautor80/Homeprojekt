/**
 * Alle Preise an einer Stelle (#232, N4 Variante A) – ohne Datenbank, nur Quelltext:
 * Gepflegt wird in „Produkte und Preise“ (vier Sichten, jede mit ihrem bisherigen Recht); die Fach-Apps zeigen ihre
 * Preise nur noch an und verweisen auf eine Sicht, die es gibt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lies = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8');
const hub = lies('modules/tco/web/produkte/Produkte.tsx');
const modul = lies('modules/tco/web/index.ts');
const katalog = lies('modules/tco/server/index.ts');
const sichten = [...hub.matchAll(/\{ key: '([a-z]+)', text: '[^']+', recht: '([a-z.]+:[a-z]+)' \}/g)].map(([, key, recht]) => ({ key, recht }));

test('Produkte und Preise: vier Sichten, jede mit einem Recht aus dem Katalog; die App sieht, wer eine Sicht sehen darf', () => {
  assert.deepEqual(sichten.map((s) => s.key), ['alle', 'halle', 'getraenke', 'speisen']);
  for (const s of sichten) assert.ok(new RegExp(`'${s.recht.replace('.', '\\.')}'`).test(katalog + lies('modules/tco/server/clubhaus/routes.ts') + lies('modules/tco/server/halle/routes.ts') + lies('modules/tco/server/verzehr/routes.ts') + lies('modules/tco/server/produkte/routes.ts')),
    `Recht ${s.recht} der Sicht „${s.key}“ gibt es im Server nicht`);
  const rechte = sichten.map((s) => s.recht).join('|');
  assert.ok(modul.includes(`{ text: 'Produkte und Preise', icon: 'product', path: '/tco/produkte', permission: '${rechte}' }`), 'Menüeintrag mit den Rechten aller Sichten');
  assert.ok(modul.includes(`{ path: '/tco/produkte', component: Produkte, permission: '${rechte}' }`), 'Route mit den Rechten aller Sichten');
  assert.match(katalog, /area: 'Tennishalle', app: 'Produkte und Preise'/, 'Rollenpflege nennt die App wie das Menü – als Stammdaten im Fachbereich (E5)');
});

test('Fach-Apps: Preise nur noch zur Anzeige, mit Verweis auf eine vorhandene Sicht; Hallenpreise ist eine Sicht', () => {
  const clubhaus = lies('modules/tco/web/clubhaus/Clubhaus.tsx');
  const verzehr = lies('modules/tco/web/verzehr/Verzehrbuch.tsx');
  assert.ok(clubhaus.includes('<Getraenke edit={false} />') && !/<Getraenke edit=\{edit\}/.test(clubhaus), 'Clubhausabrechnung: Getränke ohne Pflege');
  assert.equal([...verzehr.matchAll(/<Preise admin=\{([^}]+)\}/g)].map((m) => m[1]).sort().join(' | '), "can('tco.verzehr:admin') | false", 'Verzehrbuch: Preisliste ohne Pflege, Pflege nur in der Sicht');
  const verweise = [...(clubhaus + verzehr + hub).matchAll(/\/tco\/produkte\?sicht=([a-z]+)/g)].map((m) => m[1]);
  assert.ok(verweise.length >= 2, 'Verweise „Preise pflegen“ gefunden');
  for (const v of verweise) assert.ok(sichten.some((s) => s.key === v), `Verweis auf die Sicht „${v}“, die es nicht gibt`);
  // die App „Hallenpreise“ steht nicht mehr im Menü; ihre alte Adresse führt in die Sicht
  assert.ok(!/text: 'Hallenpreise'/.test(modul), 'kein Menüeintrag und keine Kachel „Hallenpreise“ mehr');
  assert.ok(modul.includes("{ path: '/tco/hallenpreise', component: ZuHallenpreisen, permission: 'tco.halle:display' }"), 'alte Adresse bleibt gültig');
  assert.match(hub, /export function ZuHallenpreisen\(\) \{ return <Navigate to=\{preiseLink\('halle'\)\} replace \/>; \}/);
  assert.match(hub, /\{sicht\.key === 'halle' && <Hallenpreise \/>\}/);
});
