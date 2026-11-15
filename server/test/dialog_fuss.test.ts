/**
 * Dialog-Fußzeilen: Die UI5-Bar schneidet auf dem Telefon ab, was nicht in eine Zeile passt – mit drei Knöpfen war
 * „Abbrechen“ nicht mehr erreichbar. Fußzeilen mit mehr als zwei Knöpfen nutzen deshalb DialogFuss (bricht um).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Bestand an anderen Stellen (noch Bar): darf nur sinken */
const GRENZE = 11;
const wurzel = join(import.meta.dirname, '..', '..');
function dateien(ordner: string): string[] {
  return readdirSync(ordner, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === 'node_modules' ? [] : dateien(join(ordner, e.name))) : e.name.endsWith('.tsx') ? [join(ordner, e.name)] : []);
}
/** Fußzeilen `footer={<Bar endContent={<> … </>} />}` mit der Zahl ihrer Knöpfe */
export function barFuesse(quelltext: string): number[] {
  return [...quelltext.matchAll(/footer=\{<Bar endContent=\{<>([\s\S]*?)<\/>\} \/>\}/g)].map((m) => (m[1].match(/<Button\b/g) ?? []).length);
}

test('Erkennung: Zahl der Knöpfe je Bar-Fußzeile', () => {
  assert.deepEqual(barFuesse('footer={<Bar endContent={<>\n<Button a/>\n<Button b/>\n<Button c/>\n</>} />}> x footer={<Bar endContent={<><Button/></>} />}'), [3, 1]);
});

test('Dokumenteneingang: Dialoge mit drei Knöpfen brechen um (DialogFuss)', () => {
  const q = readFileSync(join(wurzel, 'modules/tco/web/eingang/Dokumenteneingang.tsx'), 'utf8');
  assert.ok(barFuesse(q).every((n) => n <= 2), 'Bar-Fußzeile mit mehr als zwei Knöpfen – bitte DialogFuss verwenden');
  const zuordnen = q.slice(q.indexOf('function ZuordnenDialog'), q.indexOf('function AblageDialog'));
  assert.match(zuordnen, /footer=\{<DialogFuss>[\s\S]*Zuordnen und anwenden[\s\S]*Abbrechen[\s\S]*<\/DialogFuss>\}/);
  assert.match(readFileSync(join(wurzel, 'web/src/styles.css'), 'utf8'), /\.portal-dialogfuss \{[^}]*flex-wrap: wrap/);
});

test('Übersicht: weitere Bar-Fußzeilen mit mehr als zwei Knöpfen werden nicht mehr', () => {
  const treffer = [join(wurzel, 'modules'), join(wurzel, 'web/src')].flatMap(dateien)
    .flatMap((d) => barFuesse(readFileSync(d, 'utf8')).filter((n) => n > 2).map(() => d.slice(wurzel.length + 1)));
  assert.ok(treffer.length <= GRENZE, `Neue Bar-Fußzeile mit mehr als zwei Knöpfen (${treffer.length} > ${GRENZE}): ${[...new Set(treffer)].join(', ')}`);
});

