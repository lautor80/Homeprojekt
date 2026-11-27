/**
 * Dialog-Fußzeilen: Die UI5-Bar schneidet auf dem Telefon ab, was nicht in eine Zeile passt – mit drei Knöpfen war
 * „Abbrechen“ nicht mehr erreichbar. Fußzeilen mit mehr als zwei Knöpfen nutzen deshalb DialogFuss (bricht um).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Bestand an anderen Stellen (noch Bar): darf nur sinken */
const GRENZE = 0;
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


/**
 * Mobil-Prüfung (27.11.2026): Die UI5-Bar ist als Knopfleiste portalweit durch die umbrechende `FussLeiste` ersetzt
 * (Dialogfuß, Leiste im Inhalt, Seitenfuß der AppPage). Eine neue Bar als Knopfleiste lässt diesen Test scheitern.
 */
test('Keine UI5-Bar mehr als Knopfleiste – überall FussLeiste (bricht um)', () => {
  const treffer = [join(wurzel, 'modules'), join(wurzel, 'web/src')].flatMap(dateien).flatMap((d) =>
    readFileSync(d, 'utf8').split('\n').map((z, i) => ({ z, ort: `${d.slice(wurzel.length + 1)}:${i + 1}` }))
      // erlaubt: Bar als Kopfzeile eines Dialogs (header={<Bar …)
      .filter(({ z }) => /<Bar(?=[\s/>]|$)/.test(z) && !z.includes('header={<Bar')).map(({ ort }) => ort));
  assert.deepEqual(treffer, [], 'UI5-Bar als Knopfleiste – bitte FussLeiste aus @core/components/DialogFuss verwenden');
  const css = readFileSync(join(wurzel, 'web/src/styles.css'), 'utf8');
  assert.match(css, /\.portal-dialogfuss__start, \.portal-dialogfuss__mitte, \.portal-dialogfuss__ende \{[^}]*flex-wrap: wrap/);
  const leiste = readFileSync(join(wurzel, 'web/src/components/DialogFuss.tsx'), 'utf8');
  assert.match(leiste, /export function FussLeiste/);
  assert.match(leiste, /slot=\{slot\}/, 'der Dialog setzt den Slot – ohne ihn stünde die Fußzeile im Inhalt');
});

test('Kartenansicht der Tabellen (Telefon): Spalten ohne Überschrift bleiben als Aktionszeile, Zeilenklick wirkt', () => {
  const q = readFileSync(join(wurzel, 'web/src/components/ResponsiveTable.tsx'), 'utf8');
  assert.match(q, /const aktionen = mitText\.slice\(ende\)\.filter\(\(x\) => !x\.text && typeof x\.c\.Cell === 'function'\)/);
  assert.match(q, /Weitere \{Math\.min\(SEITE/, 'lange Listen: Karten in Seiten');
  assert.match(q, /portal-rt__aktionen/);
  assert.match(q, /onRowClick/);
  assert.match(readFileSync(join(wurzel, 'web/src/styles.css'), 'utf8'), /\.portal-rt__aktionen \{[^}]*flex-wrap: wrap/);
});

test('Telefon: Tabellen ohne eigenen Höhenrahmen (kein Rollbereich im Rollbereich)', () => {
  const css = readFileSync(join(wurzel, 'web/src/styles.css'), 'utf8');
  assert.match(css, /@media \(max-width: 700px\) \{ :root, ui5-dialog \{ --portal-tabhoehe: none; \} \}/);
});

test('Tabellen mit Zeilenaktionen nutzen die Kartenansicht (Aktionen auf dem Telefon ohne seitliches Rollen)', () => {
  // Stichproben aus der Mobil-Prüfung: Aktionsspalte stand ganz rechts in 600–1500 px breiten Tabellen
  for (const [datei, anzahl] of [['modules/tco/web/mahnung/Mahnwesen.tsx', 8], ['modules/tco/web/zuwendung/Zuwendung.tsx', 4], ['modules/tco/web/mitglieder/MeineMitgliedschaft.tsx', 1],
    ['modules/tco/web/platz/FesteBelegungen.tsx', 1], ['web/src/pages/BackupPage.tsx', 1], ['web/src/pages/SperrenPage.tsx', 1]] as const) {
    const q = readFileSync(join(wurzel, datei), 'utf8');
    assert.equal((q.match(/<ResponsiveTable\b/g) ?? []).length, anzahl, datei);
    assert.ok(!/<AnalyticalTable\b/.test(q), `${datei}: noch eine reine AnalyticalTable`);
  }
});

test('Telefon: nebeneinander stehende Bereiche stehen untereinander, feste Breiten begrenzt (Mobil-Prüfung, Paket 3)', () => {
  const css = readFileSync(join(wurzel, 'web/src/styles.css'), 'utf8');
  assert.match(css, /\.portal-teilung \{ display: flex !important; flex-direction: column !important;/);
  assert.match(css, /\.portal-m-einspaltig \{ grid-template-columns: minmax\(0, 1fr\) !important; \}/);
  assert.match(css, /td:last-child:has\(> \.portal-iconakt\) \{ position: sticky; right: 0;/);
  assert.match(css, /> table > tbody > tr > td:last-child:has\(ui5-button\),/, 'Knöpfe der letzten Spalte bleiben rechts stehen');
  for (const datei of ['modules/transport/web/DokumentPopup.tsx', 'modules/transport/web/beleg/BelegAnsicht.tsx', 'modules/transport/web/VersandDialog.tsx', 'modules/tco/web/fi/FiDialoge.tsx']) {
    assert.match(readFileSync(join(wurzel, datei), 'utf8'), /className="portal-teilung"/, datei);
  }
  // Raster mit Mindestbreite passen sich der Bildschirmbreite an
  assert.match(readFileSync(join(wurzel, 'modules/transport/web/AuftragDetail.tsx'), 'utf8'), /minmax\(min\(\$\{n === 3 \? 300 : 380\}px, 100%\), 1fr\)/);
  assert.match(readFileSync(join(wurzel, 'modules/tco/web/platz/platz.css'), 'utf8'), /\.portal-abo__raster \{[^}]*repeat\(7, minmax\(4\.5rem, 1fr\)\)/);
});

test('HTML-Tabellen stehen in einem Rollrahmen (sonst schneidet die Karte sie auf dem Telefon ab)', () => {
  for (const datei of ['modules/tco/web/eingang/RegelDialog.tsx', 'modules/tco/web/turnier/ErgebnisDialog.tsx', 'modules/transport/web/dialogs.tsx',
    'web/src/pages/PaperlessMappingPage.tsx', 'web/src/pages/RollenMatrix.tsx', 'web/src/pages/TabellenPage.tsx']) {
    const q = readFileSync(join(wurzel, datei), 'utf8');
    assert.match(q, /<div className="portal-tabrahmen"><table/, datei);
  }
});
