/**
 * Knopf „Importieren“ (oben rechts, #232 S4): Die UI5-Toolbar verschiebt bei wenig Platz die hinteren Einträge ins „…“-Menü.
 * In Apps mit Ansichtsvarianten (stehen davor) war der Import auf Laptop, Tablet und Handy dadurch nicht mehr zu sehen –
 * in der Abrechnung Jugendtraining also weder „Aus Nextcloud laden“ noch die CSV-Ablage. Der Seitenrahmen nimmt den Knopf
 * deshalb vom Überlauf aus.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const wurzel = join(import.meta.dirname, '..', '..');
const lesen = (pfad: string) => readFileSync(join(wurzel, pfad), 'utf8');

test('Seitenrahmen: „Importieren“ wandert nie ins Überlaufmenü', () => {
  const q = lesen('web/src/components/AppPage.tsx');
  assert.match(q, /import \{ ImportKnopf \} from '\.\/ImportDialog';/);
  assert.match(q, /<ToolbarItem key=\{i\} overflowPriority=\{isValidElement\(c\) && c\.type === ImportKnopf \? 'NeverOverflow' : 'Default'\}>/);
});

test('Abrechnung Jugendtraining: Import als ImportKnopf in den Aktionen der Seite, Nextcloud im Dialog', () => {
  const q = lesen('modules/tco/web/jt/Jugendtraining.tsx');
  // direkt als Element in `actions` (nicht in einem eigenen Bauteil verpackt) – nur so erkennt ihn der Seitenrahmen
  assert.match(q, /actions=\{importAn \? <ImportKnopf /);
  assert.match(q, /import\/nextcloud[\s\S]{0,80}Aus Nextcloud laden/);
});

test('Alle Apps: ImportKnopf steht unmittelbar in den Aktionen (kein Wrapper, der die Erkennung aushebelt)', () => {
  for (const d of ['modules/tco/web/fi/FiBelege.tsx', 'modules/tco/web/sport/Spielerdaten.tsx', 'modules/tco/web/Hallenabrechnung.tsx', 'modules/tco/web/jt/Jugendtraining.tsx']) {
    assert.match(lesen(d), /<ImportKnopf /, d);
  }
});
