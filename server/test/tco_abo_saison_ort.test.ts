/**
 * Abo-Saison verwalten (Kassenwart, #11) steht in der Platzverwaltung im eigenen Reiter „Abo-Saison“ neben „Abos“ – nicht mehr in
 * „Platz buchen → Abo-Bewerbung“. Dort sehen Admins nur noch einen Link; Verweise zeigen auf ?tab=abosaison.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const wurzel = join(import.meta.dirname, '..', '..');
const lies = (d: string) => readFileSync(join(wurzel, d), 'utf8');

test('Abo-Bewerbung enthält keine Kassenwart-Verwaltung mehr, nur den Link zur Platzverwaltung', () => {
  const q = lies('modules/tco/web/platz/AboBewerbung.tsx');
  assert.doesNotMatch(q, /function AboVerwaltung|AboSaisonVerwaltung|Abo-Saison verwalten \(Kassenwart\)/);
  assert.doesNotMatch(q, /\/admin\/abosaison|\/admin\/abowunsch/, 'Verwaltungs-Endpunkte gehören nicht mehr in die Abo-Bewerbung');
  assert.match(q, /navigate\('\/tco\/platzverwaltung\?tab=abosaison'\)/);
  assert.match(q, /Abo-Saison verwalten: Platzverwaltung → Abo-Saison/);
});

test('Platzverwaltung rendert die Abo-Saison-Verwaltung im eigenen Reiter neben Abos', () => {
  const q = lies('modules/tco/web/platz/Platzverwaltung.tsx');
  assert.match(q, /import \{ AboSaisonVerwaltung \} from '\.\/AboSaisonVerwaltung';/);
  // Reiter „Abo-Saison“ direkt nach dem Reiter „Abos“, die Verwaltung nur dort
  assert.match(q, /<Tab data-key="abos" text="Abos"[^\n]*>\n[^\n]*<Abos [^\n]*\n\s*<\/Tab>\n\s*<Tab data-key="abosaison" text="Abo-Saison"[^\n]*>\n\s*\{tab === 'abosaison' && <AboSaisonVerwaltung \/>\}/);
  assert.doesNotMatch(q, /\{tab === 'abos' && [^\n]*<AboSaisonVerwaltung/);
  // Termin-Details einer Abo-Reservierung führen in den Reiter Abo-Saison, nicht mehr nach Platz buchen
  assert.match(q, /Zur Abo-Saison/);
  assert.doesNotMatch(q, /platz-buchen\?ansicht=abo/);
  assert.match(q, /navigate\('\/tco\/platzverwaltung\?tab=abosaison'\)/);
  // die Seite übernimmt den Reiter aus der Adresse (?tab=…)
  assert.match(q, /get\('tab'\)/);
});

test('Eigene Komponente lädt die Verwaltungsdaten selbst', () => {
  const q = lies('modules/tco/web/platz/AboSaisonVerwaltung.tsx');
  assert.match(q, /export function AboSaisonVerwaltung\(\)/);
  assert.match(q, /api\.get<Verwaltung>\(`\$\{PB\}\/admin\/abosaison`\)/);
  assert.match(q, /Abo-Saison verwalten \(Kassenwart\)/);
});

test('Arbeitsvorrat (Kassenwart) verweist auf Platzverwaltung → Abo-Saison', () => {
  const q = lies('modules/tco/server/dashboard/arbeitsvorrat.ts');
  assert.match(q, /const pfad = '\/tco\/platzverwaltung\?tab=abosaison';/);
  assert.doesNotMatch(q, /platz-buchen\?ansicht=abo/);
});
