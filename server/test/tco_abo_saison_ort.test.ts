/**
 * Abo-Saison verwalten (Kassenwart, #11) steht in der Platzverwaltung im Reiter „Abos“ – nicht mehr in
 * „Platz buchen → Abo-Bewerbung“. Dort sehen Admins nur noch einen Link; Verweise zeigen auf ?tab=abos.
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
  assert.match(q, /navigate\('\/tco\/platzverwaltung\?tab=abos'\)/);
  assert.match(q, /Abo-Saison verwalten: Platzverwaltung → Abos/);
});

test('Platzverwaltung rendert die Abo-Saison-Verwaltung im Reiter Abos', () => {
  const q = lies('modules/tco/web/platz/Platzverwaltung.tsx');
  assert.match(q, /import \{ AboSaisonVerwaltung \} from '\.\/AboSaisonVerwaltung';/);
  assert.match(q, /\{tab === 'abos' && [^\n]*<AboSaisonVerwaltung \/>/);
  // Termin-Details einer Abo-Reservierung führen in den Reiter Abos, nicht mehr nach Platz buchen
  assert.match(q, /Zur Abo-Saison/);
  assert.doesNotMatch(q, /platz-buchen\?ansicht=abo/);
  assert.match(q, /navigate\('\/tco\/platzverwaltung\?tab=abos'\)/);
  // die Seite übernimmt den Reiter aus der Adresse (?tab=…)
  assert.match(q, /get\('tab'\)/);
});

test('Eigene Komponente lädt die Verwaltungsdaten selbst', () => {
  const q = lies('modules/tco/web/platz/AboSaisonVerwaltung.tsx');
  assert.match(q, /export function AboSaisonVerwaltung\(\)/);
  assert.match(q, /api\.get<Verwaltung>\(`\$\{PB\}\/admin\/abosaison`\)/);
  assert.match(q, /Abo-Saison verwalten \(Kassenwart\)/);
});

test('Arbeitsvorrat (Kassenwart) verweist auf Platzverwaltung → Abos', () => {
  const q = lies('modules/tco/server/dashboard/arbeitsvorrat.ts');
  assert.match(q, /const pfad = '\/tco\/platzverwaltung\?tab=abos';/);
  assert.doesNotMatch(q, /platz-buchen\?ansicht=abo/);
});
