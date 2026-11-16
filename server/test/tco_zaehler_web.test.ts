/**
 * Zählerstände – Oberfläche: Menüpunkt unter Instandhaltung, Routen (Übersicht, Erfassen per QR-Code, Objektseite),
 * Startseitenkachel mit Kennzahl, Diagrammfarben aus dem Theme und Foto-Verkleinerung im Browser. Ohne Datenbank – nur Quelltext.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lesen = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const W = 'modules/tco/web/zaehler';

test('Zählerstände: Menüpunkt in der Gruppe Instandhaltung nach den Schadensmeldungen, Icon nur einmal im Menü', () => {
  const web = lesen('modules/tco/web/index.ts');
  const punkt = "{ text: 'Zählerstände', icon: 'measuring-point', path: '/tco/zaehler', permission: 'tco.zaehler:display' }";
  assert.ok(web.includes(punkt), 'Menüpunkt');
  const gruppe = web.indexOf("text: 'Instandhaltung', icon: 'technical-object'");
  assert.ok(gruppe > 0 && web.indexOf("text: 'Schadensmeldungen', icon: 'wrench'", gruppe) < web.indexOf(punkt, gruppe), 'nach Schadensmeldungen in der Gruppe');
  assert.ok(web.indexOf(punkt) < web.indexOf("text: 'Finanzen', icon: 'loan'", gruppe), 'noch in der Gruppe Instandhaltung');
  // genau zweimal: Menüpunkt und Kachel
  assert.equal(web.match(/icon: 'measuring-point'/g)?.length, 2);
});

test('Zählerstände: Routen mit Rechten; Erfassen vor der Objektseite und nach der Anmeldung erhalten', () => {
  const web = lesen('modules/tco/web/index.ts');
  const r1 = "{ path: '/tco/zaehler', component: Zaehlerstaende, permission: 'tco.zaehler:display' }";
  const r2 = "{ path: '/tco/zaehler/erfassen', component: ZaehlerErfassen, permission: 'tco.zaehler:edit' }";
  const r3 = "{ path: '/tco/zaehler/:id', component: ZaehlerDetail, permission: 'tco.zaehler:display' }";
  for (const r of [r1, r2, r3]) assert.ok(web.includes(r), r);
  assert.ok(web.indexOf(r2) < web.indexOf(r3), 'feste Route vor :id');
  assert.match(web, /nachAnmeldung: \[[^\]]*'\/tco\/zaehler\/erfassen'/, 'QR-Link bleibt nach der Anmeldung erhalten');
  assert.ok(lesen(`${W}/format.ts`).includes('/tco/zaehler/erfassen${id ? `?zaehler=${id}`'), 'QR-Link mit vorbelegtem Zähler');
});

test('Zählerstände: Kachel neben Schadensmeldungen mit Kennzahl überfällige Ablesungen', () => {
  const web = lesen('modules/tco/web/index.ts');
  const kachel = "{ text: 'Zählerstände', subtitle: 'Strom, Gas, Wasser erfassen und auswerten', icon: 'measuring-point', path: '/tco/zaehler', permission: 'tco.zaehler:display', kpi: kpiZaehler }";
  assert.ok(web.includes(kachel), 'Kachel');
  const schaden = web.indexOf("{ text: 'Schadensmeldungen', subtitle:");
  assert.ok(schaden > 0 && web.indexOf(kachel) > schaden && web.indexOf(kachel) - schaden < 400, 'direkt nach der Kachel Schadensmeldungen');
  const kpi = web.slice(web.indexOf('const kpiZaehler'), web.indexOf('const kpiHalle'));
  assert.match(kpi, /ueberfaellig/);
  assert.match(kpi, /state: n > 0 \? 'Negative' : 'Positive'/);
});

test('Zählerstände: Diagramme als SVG mit den geordneten Theme-Farben, Tooltip und viewBox', () => {
  const d = lesen(`${W}/Diagramme.tsx`);
  assert.match(d, /var\(--sapChart_OrderedColor_\$\{i\}/, 'Farben aus --sapChart_OrderedColor_1…11');
  assert.ok(!/fill="#|stroke="#/.test(d), 'keine festen Farben an den Marken');
  assert.match(d, /viewBox=\{`0 0 \$\{W\} \$\{H\}`\}/, 'responsiv über viewBox');
  assert.ok((d.match(/<title>/g)?.length ?? 0) >= 4, 'Tooltips');
  for (const f of ['SaeulenDiagramm', 'KategorieLinien', 'StandVerlauf', 'Sparkline']) assert.match(d, new RegExp(`export function ${f}\\b`), f);
  assert.match(d, /Zählerwechsel/, 'Zählerwechsel markiert');
  assert.match(d, /geschätzt/, 'Schätzungen gekennzeichnet');
});

test('Zählerstände: Foto mit Kamera, im Browser auf höchstens 1600 px als JPEG verkleinert', () => {
  const s = lesen(`${W}/StandErfassen.tsx`);
  assert.ok(s.includes('type="file" accept="image/*" capture="environment"'), 'Kamera');
  assert.match(s, /import \{ fotoVerkleinern \} from '\.\.\/instandhaltung\/foto'/, 'gemeinsamer Helfer');
  const f = lesen('modules/tco/web/instandhaltung/foto.ts');
  assert.match(f, /const MAX = 1600;/);
  assert.match(f, /toDataURL\('image\/jpeg'/);
  assert.match(f, /createElement\('canvas'\)/);
  // Warnung ohne Bestätigung → 409 → erneut mit bestaetigt: true
  assert.match(s, /e\.status === 409/);
  assert.match(s, /bestaetigt: true/);
  assert.match(s, /staende\/pruefen/);
});

test('Zählerstände: Reiter mit Stammdaten zuletzt (nur Admin), Import über Funktionsschalter, Kernbausteine', () => {
  const s = lesen(`${W}/Zaehlerstaende.tsx`);
  const reiter = [...s.matchAll(/<Tab data-key="(\w+)" text="([^"]+)"/g)].map((m) => m[2]);
  assert.deepEqual(reiter, ['Übersicht', 'Auswertung', 'Ablesungen', 'Stammdaten']);
  assert.match(s, /\{admin && \(\s*<Tab data-key="stammdaten"/);
  assert.match(s, /funktion\('tco\.zaehler\.import'\)/);
  for (const b of ['AppPage', 'Filters', 'HeaderKpi', 'ImportDialog', 'ImportKnopf', 'PdfDialog', 'ConfirmDialog', 'askReason']) assert.ok(s.includes(b), b);
  const detail = lesen(`${W}/ZaehlerDetail.tsx`);
  for (const b of ['ObjectHeader', 'Attributes', 'ChangeHistoryButton objectType="ZAEHLER"', 'askReason']) assert.ok(detail.includes(b), b);
  assert.ok(lesen(`${W}/QrCode.tsx`).includes('QR-Code am Zähler anbringen'));
});
