/**
 * Vorstandssitzung: Die Kopfzeile „Tagesordnung und Protokoll“ mit „+ Tagesordnungspunkt“ bleibt beim Rollen stehen.
 * Die Karte (portal-section) schneidet sonst mit overflow: hidden ab – dann wirkt „sticky“ nicht.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lies = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8');

test('Abschnitt „Tagesordnung und Protokoll“ trägt die Klasse für den fixierten Kopf', () => {
  assert.match(lies('modules/tco/web/vorstand/Sitzung.tsx'), /title="Tagesordnung und Protokoll"[^>]*className="portal-vs__agenda"/);
});

test('Kopfzeile sticky, Karte ohne Abschneiden', () => {
  const css = lies('modules/tco/web/vorstand/vorstand.css');
  assert.match(css, /\.portal-vs__agenda\s*\{\s*overflow:\s*visible;/);
  const kopf = /\.portal-vs__agenda > \.portal-section__head\s*\{([^}]*)\}/.exec(css);
  assert.ok(kopf, 'Regel für den Kopf');
  assert.match(kopf![1], /position:\s*sticky/);
  assert.match(kopf![1], /top:\s*0/);
  assert.match(kopf![1], /background:/, 'Hintergrund, damit die Punkte nicht durchscheinen');
});
