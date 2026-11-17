/**
 * Euroflex: Versand- und Druckdialoge schließen sich beim Auslösen sofort (Funktionsschalter transport.dialoge.schliessen).
 * Prüft ohne Browser, dass Schalter und Recht angemeldet sind und jeder betroffene Dialog das Recht abfragt und dann onClose aufruft.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TRANSPORT_FUNKTIONEN } from '../../modules/transport/server/funktionen.js';

const ID = 'transport.dialoge.schliessen';
const RECHT = 'transport.dialoge:execute';
const quelle = (datei: string) => readFileSync(new URL(`../../modules/transport/web/${datei}`, import.meta.url), 'utf8');
const rumpf = (src: string, name: string) => {
  const i = src.indexOf(name);
  assert.ok(i >= 0, name);
  return src.slice(i, src.indexOf('\n  }', i));
};

test('Funktionsschalter ist angemeldet, mit eigenem Recht', () => {
  const f = TRANSPORT_FUNKTIONEN.find((x) => x.id === ID);
  assert.ok(f, ID);
  assert.equal(f!.app, 'Aufträge');
  assert.deepEqual(f!.permissions, [RECHT]);
});

test('Versenden …: Entwürfe/Senden und EML schließen sofort', () => {
  const src = quelle('VersandDialog.tsx');
  assert.match(src, new RegExp(`useCan\\(\\)\\('${RECHT}'\\)`));
  assert.match(rumpf(src, 'async function ausfuehren()'), /if \(direkt\) \{ onClose\(\);/);
  assert.match(rumpf(src, 'async function eml()'), /if \(direkt\) onClose\(\);/);
});

test('E-Mail zum Auftrag: Senden, Entwurf in Outlook, E-Mail-Datei, Teilen, ohne Anhänge schließen sofort', () => {
  const src = quelle('MailEntwurf.tsx');
  assert.match(src, new RegExp(`useCan\\(\\)\\('${RECHT}'\\)`));
  for (const fn of ['async function entwurf()', 'async function senden(', 'async function teilen()']) assert.match(rumpf(src, fn), /if \(direkt\) (\{ )?onClose\(\);/, fn);
  assert.match(src.slice(src.indexOf('const mailto = ')), /if \(direkt\) onClose\(\);/);
});

test('Versenden-Liste und PDF-Vorschau: jede Ausgabe schließt sofort', () => {
  const src = quelle('dialogs.tsx');
  assert.equal(src.split(`useCan()('${RECHT}')`).length - 1, 2, 'DocsDialog und MailDialog');
  assert.match(src, /const pdf = \(m: MailRow\) => \{ zu\(\);/);
  assert.match(src, /const xml = \(m: MailRow\) => \{ zu\(\);/);
  assert.match(rumpf(src, 'async function entwurf(m: MailRow)'), /zu\(\);/);
  assert.match(src, /onClick=\{\(\) => setTimeout\(zu, 0\)\}/);
  assert.match(src, /const alle = docs \?\? \[\];\n    onClose\(\);/);
});
