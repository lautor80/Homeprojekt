/**
 * App Posteingang (Euroflex): Reiter „Posteingang“ (vormerken, gesammelt übergeben) vor der „Prüfliste“; in Outlook wird nicht mehr
 * verschoben. Ohne Datenbank – nur Quelltext. Ablauf mit Datenbank: transport_eingang.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lesen = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

test('Posteingang: neuer Reiter zuerst, Vormerken statt Ablegen, gesammelte Übergabe', () => {
  const web = lesen('modules/transport/web/eingang/Posteingang.tsx');
  const eingang = web.indexOf('<Tab data-key="eingang" text="Posteingang"');
  const pruef = web.indexOf('<Tab data-key="pruefliste" text="Prüfliste"');
  assert.ok(eingang > 0 && pruef > eingang, 'Reiter „Posteingang“ steht vor der Prüfliste');
  assert.ok(web.includes("useState<Reiter>('eingang')"), 'und ist vorausgewählt');
  assert.ok(web.includes('api.post(`${EING}/vorgaenge/${v.id}/vormerken`, { auftragsnr: nr, dokumente: [...auswahl] })'), 'Vormerken mit Auftrag und Dateien');
  assert.ok(web.includes('api.del(`${EING}/vorgaenge/${v.id}/vormerken`)'), 'Vormerkung aufheben');
  assert.ok(web.includes('{darfAblegen && sammel && (') && web.includes('{darfAblegen && !sammel && ('), 'Posteingang merkt vor, Prüfliste bestätigt einzeln');
  assert.ok(web.includes('api.post<{ text?: string; fehler?: number }>(`${EING}/uebergabe`, {})'), 'gesammelte Übergabe');
  assert.ok(web.includes("ablageziel === 'paperless' ? 'An Paperless übergeben'"), 'Beschriftung nach Ablageziel');
  assert.ok(web.includes('Vorgemerkt · {z.auftragsnr'), 'Kennzeichnung in der Liste');
});

test('Outlook: Portal lässt nicht mehr verschieben, nur als gelesen markieren', () => {
  const v = lesen('modules/transport/server/eingang/verarbeitung.ts');
  assert.ok(v.includes('export const MAIL_AKTION = { ordner: null, gelesen: true } as const;'));
  assert.ok(!v.includes('ordnerZugeordnet') && !v.includes('ordnerPruefen'), 'Ordner aus den Einstellungen werden nicht mehr verwendet');
  assert.ok(v.includes("and vorgemerkt_am is null order by id limit 500"), 'Abruf bewertet vorgemerkte nicht neu');
  assert.ok(lesen('modules/transport/server/migrations/022_eingang_vormerken.sql').includes('vorgemerkt_dokumente jsonb'));
});
