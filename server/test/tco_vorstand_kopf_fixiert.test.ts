/**
 * Vorstandssitzung: Die Kopfzeile „Tagesordnung und Protokoll“ (mit „Aus dem Parkplatz“ und „+ Tagesordnungspunkt“) steht
 * unter dem Seitentitel fest, nur die Tagesordnungspunkte rollen in einem eigenen Rahmen.
 * Hintergrund: Die Karte (portal-section) schneidet mit overflow: hidden ab – ein „sticky“ Kopf darin wirkt nicht; und der
 * Seitentitel der DynamicPage liegt über dem Rollbereich, daher die gemessene Höhe (--vs-titel, --vs-oben).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lies = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8');

test('Abschnitt „Tagesordnung und Protokoll“ trägt die Klasse; Höhe des Seitentitels wird gemessen', () => {
  const tsx = lies('modules/tco/web/vorstand/Sitzung.tsx');
  assert.match(tsx, /title="Tagesordnung und Protokoll"[^>]*className="portal-vs__agenda"/);
  assert.match(tsx, /ui5-dynamic-page-title/);
  assert.match(tsx, /setProperty\('--vs-titel'/);
  assert.match(tsx, /setProperty\('--vs-oben'/);
});

test('ganzer Abschnitt sticky unter dem Seitentitel, die Punkte rollen im eigenen Rahmen', () => {
  const css = lies('modules/tco/web/vorstand/vorstand.css');
  const ab = /\.portal-section\.portal-vs__agenda\s*\{([^}]*)\}/.exec(css);
  assert.ok(ab, 'Regel für den Abschnitt');
  assert.match(ab![1], /position:\s*sticky/);
  assert.match(ab![1], /top:\s*var\(--vs-titel/);
  const body = /\.portal-section\.portal-vs__agenda > \.portal-section__body\s*\{([^}]*)\}/.exec(css);
  assert.ok(body, 'Regel für den Rahmen der Punkte');
  assert.match(body![1], /overflow-y:\s*auto/);
  assert.match(body![1], /max-height:\s*calc\(100vh - var\(--vs-oben/);
  assert.match(css, /\.portal-vs__rechts \{ align-self: stretch; \}/, 'rechte Spalte so hoch wie die linke, sonst kann der Abschnitt nicht stehen bleiben');
});
