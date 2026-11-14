/**
 * Ziel nach der Registrierung (web/src/anmeldeziel.ts): Wer über einen Einladungslink kommt und sich erst registriert,
 * landet bei der ersten Anmeldung einmal auf der eingeladenen Seite – aber nur auf Adressen im Portal, die ein Modul
 * nach der Anmeldung ausdrücklich erhält. Dazu: Der Kalender gibt seinen Pfad frei und öffnet die Veranstaltung aus dem Link.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lies = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8');

test('Ziel nach der Registrierung: nur freigegebene Pfade im Portal, nur begrenzte Zeit', async () => {
  const { zielPruefen, ZIEL_TAGE } = await import('../../web/src/anmeldeziel.js');
  const erlaubt = ['/tco/schaden', '/tco/kalender'];
  const jetzt = Date.UTC(2027, 4, 1);
  const z = (pfad: unknown, zeit: unknown = jetzt - 3_600_000) => JSON.stringify({ pfad, zeit });

  assert.equal(zielPruefen(z('/tco/kalender?veranstaltung=12'), erlaubt, jetzt), '/tco/kalender?veranstaltung=12');
  assert.equal(zielPruefen(z('/tco/kalender/?veranstaltung=12'), erlaubt, jetzt), '/tco/kalender/?veranstaltung=12', 'Schrägstrich am Ende zählt nicht');
  assert.equal(zielPruefen(z('/tco/schaden?anlage=3'), erlaubt, jetzt), '/tco/schaden?anlage=3');

  assert.equal(zielPruefen(z('/tco/mitglieder'), erlaubt, jetzt), null, 'nicht freigegebener Pfad');
  assert.equal(zielPruefen(z('/tco/kalenderx'), erlaubt, jetzt), null);
  for (const fremd of ['https://example.org/tco/kalender', '//example.org/tco/kalender', '/\\example.org', 'tco/kalender', '/tco/kalender?x=https://example.org', 'javascript:alert(1)']) {
    assert.equal(zielPruefen(z(fremd), erlaubt, jetzt), null, `fremde Adresse: ${fremd}`);
  }
  assert.equal(zielPruefen(z('/tco/kalender', jetzt - (ZIEL_TAGE + 1) * 86_400_000), erlaubt, jetzt), null, 'zu alt');
  assert.equal(zielPruefen(z('/tco/kalender', jetzt + 86_400_000), erlaubt, jetzt), null, 'aus der Zukunft');
  assert.equal(zielPruefen(z(12), erlaubt, jetzt), null);
  assert.equal(zielPruefen(z('/tco/kalender', 'gestern'), erlaubt, jetzt), null);
  assert.equal(zielPruefen('kein json', erlaubt, jetzt), null);
  assert.equal(zielPruefen('null', erlaubt, jetzt), null);
  assert.equal(zielPruefen(null, erlaubt, jetzt), null);
});

test('Einladungslink: Server, Kalender-Seite und Modul meinen dieselbe Adresse', () => {
  const server = lies('modules/tco/server/kalender/einladung.ts');
  const dialog = lies('modules/tco/web/kalender/Einladung.tsx');
  const seite = lies('modules/tco/web/kalender/Kalender.tsx');
  const modul = lies('modules/tco/web/index.ts');
  const param = /VERANSTALTUNG_PARAM = '([a-z]+)'/.exec(dialog)?.[1];
  assert.equal(param, 'veranstaltung');
  assert.ok(server.includes(`/tco/kalender?${param}=\${id}`), 'Link des Servers');
  assert.ok(dialog.includes('/tco/kalender?${VERANSTALTUNG_PARAM}=${id}'), 'Link im Dialog, wenn die Portal-Adresse fehlt');
  assert.ok(seite.includes('params.get(VERANSTALTUNG_PARAM)'), 'die Kalender-Seite öffnet die Veranstaltung aus der Adresse');
  assert.match(modul, /path: '\/tco\/kalender', component: Kalender/, 'Route des Kalenders');
  assert.match(modul, /nachAnmeldung: \[[^\]]*'\/tco\/kalender'/, 'der Pfad bleibt nach der Anmeldung erhalten');
});
