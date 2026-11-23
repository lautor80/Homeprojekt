/**
 * Startseiten-Kacheln: Auf schmalen Telefonen (z. B. Pixel 9 Pro, ~384–412 CSS-px) überdeckte die Kennzahl
 * („3.001,04 € – Saldo zugunsten Verein“) das Kachel-Symbol, weil die Bezeichnung fest bis 7rem breit sein durfte.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(import.meta.dirname, '..', '..', 'web/src/styles.css'), 'utf8');
const regel = (sel: string, quelle = css) => quelle.match(new RegExp(`${sel.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`))?.[1] ?? '';

test('Kennzahl-Bezeichnung ist nie breiter als der Platz neben dem Symbol', () => {
  const label = regel('.portal-tile__kpi-label');
  assert.match(label, /max-width: 100%/);
  assert.doesNotMatch(label, /max-width: \d+(\.\d+)?rem/);
  assert.match(regel('.portal-tile__kpi'), /min-width: 0/);
});

test('Handy: Kennzahl bricht unter das Symbol um statt es zu überdecken', () => {
  const handy = css.slice(css.indexOf('Handy (bis 600px)'));
  assert.match(regel('.portal-tile__foot', handy), /flex-wrap: wrap/);
  assert.match(regel('.portal-tile__kpi'), /margin-left: auto/);
});
