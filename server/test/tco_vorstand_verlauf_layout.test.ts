/**
 * Vorstandssitzungen, Darstellung: Kennzeichen (ObjectStatus) bekommen ihr Symbol als <Icon> – ein Name als Text
 * (icon="history") wird von UI5 nicht als Symbol gezeigt, sondern überlagert die Beschriftung.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lies = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8');

test('ObjectStatus in den Vorstandssitzungen ohne Symbolnamen als Text', () => {
  for (const f of ['Sitzung.tsx', 'Themen.tsx', 'Verlauf.tsx', 'Vorstand.tsx']) {
    const q = lies(`modules/tco/web/vorstand/${f}`);
    assert.doesNotMatch(q, /<ObjectStatus[^>]*\sicon="/, f);
  }
  assert.match(lies('modules/tco/web/vorstand/Sitzung.tsx'), /icon=\{<Icon name="history" \/>\}[^>]*>fortgesetzt</);
});

test('Verlauf: Stand als eigenes Kennzeichen, Titel nur wenn abweichend', () => {
  const q = lies('modules/tco/web/vorstand/Verlauf.tsx');
  assert.match(q, /portal-vs__vstand--\$\{v\.status\.toLowerCase\(\)\}/);
  assert.match(q, /andererTitel && /);
  assert.doesNotMatch(q, /Protokoll: \{v\.sitzung_status_text\}/, 'kein doppeltes „Protokoll: Protokoll im Entwurf“');
});
