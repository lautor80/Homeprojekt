/**
 * Euroflex Objektseite Auftrag: „Kontakt anlegen“ fragt das Ziel (Kunde, Unternehmer je Fahrt, Rechnungsempfänger)
 * und trägt den neuen Kontakt nach dem Anlegen direkt dort ein. Quelltextprüfung ohne Browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../modules/transport/web/AuftragDetail.tsx', import.meta.url), 'utf8');

test('Menü „Kontakt anlegen“ mit Zielen, nur solange bearbeitbar', () => {
  assert.match(src, /const anlageZiele[^\n]*= mayEdit \? \[/);
  for (const t of ["'als Kunde'", "'als abw. Rechnungsempfänger'", "'ohne Zuordnung'", '`als Unternehmer (Fahrt ${i + 2})`']) assert.ok(src.includes(t), t);
  assert.match(src, /<MenuButton text="Kontakt anlegen"[^\n]*onClick: \(\) => kontaktAnlegen\(z\.ziel\)/);
});

test('neu angelegter Kontakt wird ins Ziel übernommen (Kopf und weitere Fahrt)', () => {
  const i = src.indexOf('onSaved={async (adrnr) => {');
  assert.ok(i > 0);
  const rumpf = src.slice(i, src.indexOf('}} />', i));
  assert.match(rumpf, /typeof ziel === 'number'[\s\S]*unternehmer: adrnr/);
  assert.match(rumpf, /await waehleAdresse\(ziel, String\(adrnr\)\)/);
  assert.match(rumpf, /Auftrag speichern nicht vergessen/);
});
