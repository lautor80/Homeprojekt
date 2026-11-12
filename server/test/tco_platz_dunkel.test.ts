/**
 * Platz buchen (#11): Zeitachse im Dunkelmodus lesbar – je Preiszone eine dunkle Fläche, auf der die helle Uhrzeit
 * mindestens Kontrast 4,5:1 (WCAG AA) hat; der helle Modus (hallenpreise.css) bleibt unverändert.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const platz = readFileSync(new URL('../../modules/tco/web/platz/platz.css', import.meta.url), 'utf8');
const preise = readFileSync(new URL('../../modules/tco/web/hallenpreise.css', import.meta.url), 'utf8');

const kanal = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = (hex: string) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * kanal(n >> 16) + 0.7152 * kanal((n >> 8) & 255) + 0.0722 * kanal(n & 255); };
const kontrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('Dunkelmodus: jede Preiszone der Zeitachse hat eine dunkle Fläche mit lesbarer Uhrzeit', () => {
  const schrift = /portal-pb__zeiten--preise \.portal-pb__stunde \{ color: (#[0-9a-f]{6})/.exec(platz)?.[1];
  assert.ok(schrift, 'Uhrzeitfarbe im Dunkelmodus');
  for (let f = 0; f <= 4; f++) {
    const m = new RegExp(`\\[data-portal-theme='dunkel'\\][^{]*\\.portal-hpw__f${f} \\{ --hf-bg: (#[0-9a-f]{6})`).exec(platz);
    assert.ok(m, `Zone f${f} im Dunkelmodus`);
    assert.ok(kontrast(schrift!, m![1]) >= 4.5, `Kontrast f${f}: ${kontrast(schrift!, m![1]).toFixed(1)}`);
  }
});

test('Heller Modus unverändert: Pastellflächen der Hallenpreise ohne Theme-Bedingung', () => {
  assert.match(preise, /^\.portal-hpw__f0 \{ --hf-bg: #dff1e3;/m);
  assert.ok(!/data-portal-theme/.test(preise));
  assert.match(platz, /^\.portal-pb__zeiten--preise \.portal-pb__stunde \{ color: var\(--sapTextColor/m);
});
