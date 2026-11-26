/**
 * Vertragsbaum („Meine Daten“, Mitglied-Detail): Die Leiste mit Ansichtsauswahl, Suche und „Auch beendete“ lag ohne
 * Innenabstand direkt an der abgerundeten Kante der Karte – die Auswahl wurde links angeschnitten.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const wurzel = join(import.meta.dirname, '..', '..');

test('Vertragsbaum: Leiste hat eigenen Innenabstand zur Kartenkante', () => {
  const tsx = readFileSync(join(wurzel, 'modules/tco/web/mitglieder/VertragsBaum.tsx'), 'utf8');
  const css = readFileSync(join(wurzel, 'modules/tco/web/gruppen/gruppen.css'), 'utf8');
  assert.match(tsx, /className="portal-row portal-vb__leiste"[^>]*>\s*<Varianten/, 'Ansichtsauswahl steht in der Leiste mit Abstand');
  const regel = css.match(/\.portal-vb__leiste\s*\{([^}]*)\}/);
  assert.ok(regel, 'CSS-Regel .portal-vb__leiste fehlt');
  assert.match(regel[1], /padding:\s*0\.5rem 0\.5rem 0\.5rem 0\.75rem/);
});
