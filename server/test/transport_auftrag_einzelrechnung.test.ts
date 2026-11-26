/**
 * Auftrag: Knopf „Einzelrechnung“ auf der Objektseite – derselbe Aufruf wie „Einzelrechnungen“ in der Auftragsliste
 * (POST /rechnungen, sammel: false), danach PDF-Vorschau; versendet wird mit „Versenden…“. Ohne Datenbank – nur Quelltext.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const web = readFileSync(path.join(ROOT, 'modules/transport/web/AuftragDetail.tsx'), 'utf8');

test('Auftrag: Einzelrechnung nur für offene Aufträge mit Recht, Aufruf wie in der Liste', () => {
  assert.ok(web.includes('const kannRechnung = !isNew && darfRechnung && !a.faktura && !a.faktura_reserviert && !a.abgeschlossen_am;'), 'Bedingung');
  const fn = web.slice(web.indexOf('async function einzelrechnung()'), web.indexOf('/** Speichern und die zur Korrektur geöffnete Rechnung'));
  assert.ok(fn.includes('`${T}/rechnungen`, { auftraege: [nr], sammel: false }'), 'derselbe Endpunkt wie die Liste');
  assert.ok(fn.includes('if (darfBearbeiten) await api.put(`${T}/auftraege/${nr}`'), 'im Bearbeitungsmodus vorher speichern');
  assert.ok(fn.indexOf('api.put(') < fn.indexOf('/rechnungen'), 'erst speichern, dann Rechnung');
  assert.ok(fn.includes('await ordnerBereit(true)') && fn.includes('await lade()'), 'Ablageordner und Neuladen');
  assert.ok(fn.includes('setDocs(r.fakturen.map((f) => ({ url: `${T}/pdf/R/${encodeURIComponent(f)}`, filename: `Rechnung_${f}.pdf`, ablage: [nr!] })))'), 'Vorschau wie in der Liste');
  assert.ok(/\{kannRechnung && \(\s*<Button icon="lead" loading=\{busy\} onClick=\{einzelrechnung\}/.test(web), 'Knopf');
  assert.ok(readFileSync(path.join(ROOT, 'modules/transport/web/AuftraegeListe.tsx'), 'utf8').includes('`${T}/rechnungen`, { auftraege: sel.map((s) => s.auftragsnr), sammel }'), 'Liste nutzt denselben Endpunkt');
});
