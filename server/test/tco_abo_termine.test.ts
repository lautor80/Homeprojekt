/**
 * Platzverwaltung → Abos → „Termine“: einzelne Termine einer Abo-Serie stornieren (modules/tco/web/platz/aboTermine.ts) –
 * reine Funktionen und Quelltext, ohne Datenbank. Der Ablauf mit Datenbank steht in tco_platz.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { kommentarNoetig, stornierbar, stornoBereit, terminStatus, termineTitel, termineZeigen, type AboTermin } from '../../modules/tco/web/platz/aboTermine.js';

const lesen = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const t = (datum: string, x: Partial<AboTermin> = {}): AboTermin => ({
  datum, wochentag: 'Freitag', von: '11:00', bis: '12:00', storniert: false, storno_grund: null, vergangen: false, abgerechnet: false, rechnung: null, ...x,
});
const SERIE = [t('2026-11-20', { vergangen: true, abgerechnet: true, rechnung: 'H-2026-0815' }), t('2026-11-27'), t('2026-12-04'), t('2026-12-11', { storniert: true, storno_grund: 'Urlaub' })];

test('Anzeige: kommende Termine, vergangene auf Wunsch – der vorgewählte bleibt sichtbar', () => {
  assert.deepEqual(termineZeigen(SERIE, false).map((x) => x.datum), ['2026-11-27', '2026-12-04', '2026-12-11']);
  assert.equal(termineZeigen(SERIE, true).length, 4);
  assert.deepEqual(termineZeigen(SERIE, false, '2026-11-20').map((x) => x.datum)[0], '2026-11-20');
});

test('Stornieren: jeder nicht stornierte Termin, abgerechnete nur mit Kommentar', () => {
  assert.equal(stornierbar(SERIE[2]), true);
  assert.equal(stornierbar(SERIE[3]), false, 'schon storniert');
  assert.equal(stornoBereit(SERIE[2], ''), true, 'offener Termin ohne Kommentar');
  assert.equal(kommentarNoetig(SERIE[0]), true);
  assert.equal(stornoBereit(SERIE[0], '   '), false, 'leerer Kommentar zählt nicht');
  assert.equal(stornoBereit(SERIE[0], 'Halle gesperrt'), true);
  assert.equal(stornoBereit(SERIE[3], 'egal'), false);
});

test('Status und Überschrift', () => {
  assert.deepEqual(terminStatus(SERIE[0]), { text: 'abgerechnet (Rechnung H-2026-0815)', art: 'Positive' });
  assert.deepEqual(terminStatus(SERIE[1]), { text: 'offen', art: 'None' });
  assert.deepEqual(terminStatus(SERIE[3]), { text: 'storniert – Urlaub', art: 'Negative' });
  assert.deepEqual(terminStatus(t('2026-11-13', { vergangen: true })), { text: 'gespielt, offen', art: 'Critical' });
  assert.equal(termineTitel(SERIE), '2 kommende Termine, 1 storniert');
  assert.equal(termineTitel([SERIE[1]]), '1 kommender Termin');
});

test('Eigenes Recht und Funktionsschalter; erreichbar aus Abo-Liste und Termin-Dialog', () => {
  const routen = lesen('modules/tco/server/platz/routes.ts');
  assert.match(routen, /abotermine: 'tco\.platz:abotermine'/);
  assert.match(routen, /app\.get\('\/platz\/admin\/abos\/:bid\/termine', aboTermine,/);
  assert.match(routen, /app\.post\('\/platz\/admin\/abos\/:bid\/termine\/storno', aboTermine,/);
  assert.match(lesen('modules/tco/server/index.ts'), /app: 'Platzverwaltung', id: P_PLATZ\.abotermine, requires: \[P_PLATZ\.admin\]/);
  assert.match(lesen('modules/tco/server/funktionen.ts'), /id: 'tco\.platz\.abotermine', app: 'Platzverwaltung'[^]*?permissions: \['tco\.platz:abotermine'\]/);
  assert.match(lesen('modules/tco/server/migrations/117_platz_abotermine.sql'), /'tco\.platz:abotermine' from core\.role_permissions where permission = 'tco\.platz:admin'/);
  const web = lesen('modules/tco/web/platz/Platzverwaltung.tsx');
  assert.equal(web.split("('tco.platz:abotermine')").length - 1, 2, 'Abo-Liste und Belegung fragen das Recht ab');
  assert.match(web, /\{darfTermine && <Button[^>]*onClick=\{\(\) => setTermineVon\(row\.original\.bid\)\}>Termine<\/Button>\}/);
  assert.match(web, /\{onAboTermine && <Button[^>]*onClick=\{onAboTermine\}>Andere Termine des Abos…<\/Button>\}/);
  // der Knopf am Abo-Termin sagt, dass nur dieser Termin gemeint ist
  assert.match(web, /b\.art === 'Abo' \? 'Diesen Termin stornieren' : 'Stornieren'/);
});
