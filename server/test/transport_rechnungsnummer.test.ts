/**
 * Euroflex-Rechnung: Rechnungsnummer ausgeschrieben („Rechnungsnummer“ statt „Rechnungs-Nr.“), damit DATEV sie erkennt –
 * oben rechts im Infoblock und zusätzlich gut lesbar rechts neben dem Titel. Reine Layoutprüfung ohne Datenbank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pdf, type TextOpts } from '../src/lib/pdfdoc.js';
import { C, RECHNUNGSNUMMER, infoBlock, titel } from '../../modules/transport/server/pdf/layout.js';

interface Aufruf { x: number; y: number; text: string; o: TextOpts }

/** Pdf, das alle Textausgaben samt linker Kante mitschreibt */
function protokollPdf() {
  const p = new Pdf();
  p.newPage();
  const texte: (Aufruf & { links: number; rechts: number })[] = [];
  const orig = p.text.bind(p);
  p.text = (x: number, y: number, text: string | null | undefined, o: TextOpts = {}) => {
    if (text) {
      const w = p.textWidth(text, o);
      const links = o.align === 'R' ? x - w : o.align === 'C' ? x - w / 2 : x;
      texte.push({ x, y, text, o, links, rechts: links + w });
    }
    orig(x, y, text, o);
  };
  return { p, texte };
}

test('Beschriftung ist ausgeschrieben', () => {
  assert.equal(RECHNUNGSNUMMER, 'Rechnungsnummer');
});

test('Infoblock oben rechts: „Rechnungsnummer“ mit Nummer', () => {
  const { p, texte } = protokollPdf();
  infoBlock(p, [[RECHNUNGSNUMMER, '2026_9917'], ['Rechnungsdatum', '16.11.2026']]);
  const label = texte.find((t) => t.text === 'Rechnungsnummer');
  const wert = texte.find((t) => t.text === '2026_9917');
  assert.ok(label && wert);
  assert.equal(label.y, wert.y);
  assert.ok(label.rechts < wert.links, 'Beschriftung und Nummer überlappen nicht');
  assert.ok(!texte.some((t) => t.text.includes('Rechnungs-Nr.')));
});

test('Titel: Rechnungsnummer groß rechts neben dem Titel, ohne Überlappung – auch bei Sammelrechnung', () => {
  for (const [titelText, badge] of [['Rechnung', '1 TRANSPORTAUFTRAG'], ['Sammelrechnung', '12 TRANSPORTAUFTRÄGE']]) {
    const { p, texte } = protokollPdf();
    titel(p, titelText, badge, 'Transportrechnung · Freight Invoice', '2026_9917');
    const nr = texte.find((t) => t.text === '2026_9917');
    const label = texte.find((t) => t.text === 'Rechnungsnummer');
    const badgeText = texte.find((t) => t.text === badge);
    assert.ok(nr && label && badgeText);
    assert.equal(nr.o.bold, true);
    assert.ok((nr.o.size ?? 0) >= 14, 'Nummer gut lesbar');
    assert.ok(Math.abs(nr.rechts - C.right) < 0.01, 'rechtsbündig am Rand');
    assert.ok(label.rechts < nr.links);
    assert.ok(badgeText.rechts + 5 < label.links, `${titelText}: Badge und Rechnungsnummer überlappen nicht`);
  }
});

test('Titel ohne Nummer (Lieferschein, Transportauftrag) bleibt unverändert', () => {
  const { p, texte } = protokollPdf();
  titel(p, 'Lieferschein', null, 'Delivery Note');
  assert.deepEqual(texte.map((t) => t.text), ['Lieferschein', 'Delivery Note']);
});
