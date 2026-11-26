/**
 * ObjectStatus (UI5 React) erwartet als icon ein Element (<Icon name="…" />) – ein Text wie icon="locked" wird als Wort
 * „locked“ angezeigt und überlagert den Status (Mitgliedergruppen, Mahnwesen). Ohne Datenbank – nur Quelltext.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function dateien(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (n === 'node_modules' || n === 'dist') return [];
    return statSync(p).isDirectory() ? dateien(p) : p.endsWith('.tsx') ? [p] : [];
  });
}

test('ObjectStatus: icon nie als Text, immer als <Icon name="…" />', () => {
  const fehler: string[] = [];
  for (const d of [...dateien(path.join(ROOT, 'modules')), ...dateien(path.join(ROOT, 'web/src'))]) {
    const text = readFileSync(d, 'utf8');
    for (const m of text.matchAll(/<ObjectStatus\b[^>]*?\sicon=(\{[^}]*\}|"[^"]*")/g)) {
      const wert = m[1];
      // Text direkt oder als Ausdruck mit Textliteral ohne Element (z. B. {x ? 'locked' : undefined})
      if (wert.startsWith('"') || (!wert.includes('<') && /['"`][a-z][\w-]*['"`]/.test(wert))) {
        fehler.push(`${path.relative(ROOT, d)}: icon=${wert}`);
      }
    }
  }
  assert.deepEqual(fehler, []);
});

test('Mitgliedergruppen und Mahnwesen: Schloss als Icon', () => {
  assert.ok(readFileSync(path.join(ROOT, 'modules/tco/web/gruppen/Gruppen.tsx'), 'utf8').includes('<ObjectStatus state="Indication05" icon={<Icon name="locked" />}'));
  assert.ok(readFileSync(path.join(ROOT, 'modules/tco/web/mahnung/Mahnwesen.tsx'), 'utf8').includes('icon={p.buchungssperre ? <Icon name="locked" /> : undefined}'));
});
