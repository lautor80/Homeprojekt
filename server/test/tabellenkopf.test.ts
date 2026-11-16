import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Fixierter Tabellenkopf (portalweit): Jede HTML-Tabelle mit Spaltenkopf (<thead>) steht in einem Rollrahmen,
 * in dem die Kopfzeile stehen bleibt – siehe web/src/styles.css, Abschnitt „Fixierter Tabellenkopf“.
 * Der Test liest nur die Quelltexte der Oberfläche; er braucht keine Datenbank.
 */
const WURZEL = path.resolve(import.meta.dirname, '..', '..');
/** Rahmen, die selbst rollen und den Kopf fixieren (zentral bzw. mit eigenen Regeln im Modul-CSS) */
const RAHMEN = ['portal-tabrahmen', 'hh-roll', 'portal-ih__rahmen', 'portal-rm__rahmen', 'portal-sb__matrix-scroll'];

function tsxDateien(ordner: string): string[] {
  if (!fs.existsSync(ordner)) return [];
  return fs.readdirSync(ordner, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(ordner, e.name);
    return e.isDirectory() ? tsxDateien(p) : e.name.endsWith('.tsx') ? [p] : [];
  });
}

test('jede HTML-Tabelle mit Kopfzeile steht in einem Rollrahmen', () => {
  const dateien = [
    ...tsxDateien(path.join(WURZEL, 'web', 'src')),
    ...fs.readdirSync(path.join(WURZEL, 'modules')).flatMap((m) => tsxDateien(path.join(WURZEL, 'modules', m, 'web'))),
  ];
  assert.ok(dateien.length > 50, 'Quelltexte der Oberfläche nicht gefunden');
  const fehler: string[] = [];
  for (const datei of dateien) {
    const zeilen = fs.readFileSync(datei, 'utf8').split('\n');
    zeilen.forEach((z, i) => {
      if (!/<table[\s>]/.test(z)) return;
      const hatKopf = zeilen.slice(i, i + 12).join('\n').includes('<thead');
      const imRahmen = RAHMEN.some((k) => zeilen.slice(Math.max(0, i - 3), i + 1).join('\n').includes(k));
      if (hatKopf && !imRahmen) fehler.push(`${path.relative(WURZEL, datei)}:${i + 1}`);
    });
  }
  assert.deepEqual(fehler, [], 'Tabelle mit <thead> ohne Rollrahmen (<div className="portal-tabrahmen"> direkt um die Tabelle setzen)');
});

test('die zentrale Regel begrenzt auch die AnalyticalTable', () => {
  const css = fs.readFileSync(path.join(WURZEL, 'web', 'src', 'styles.css'), 'utf8');
  assert.match(css, /\[data-component-name="AnalyticalTableBody"\]\s*\{\s*max-height:\s*var\(--portal-tabhoehe\)/);
  assert.match(css, /\.portal-tabrahmen > table > thead\s*\{\s*position:\s*sticky/);
});
