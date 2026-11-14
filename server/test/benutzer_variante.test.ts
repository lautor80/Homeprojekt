/**
 * Benutzerverwaltung: Die Sortierung der Tabelle gehört zur gespeicherten Variante (z. B. „Letzte Anmeldung“ absteigend)
 * und wird beim Öffnen wieder angewendet – ohne Datenbank, nur Quelltext.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const seite = readFileSync(fileURLToPath(new URL('../../web/src/pages/UsersPage.tsx', import.meta.url)), 'utf8');

test('Variante der Benutzerverwaltung speichert und übernimmt die Sortierung', () => {
  assert.match(seite, /ansicht: \{ filter, suche, art, sortierung \}/, 'Sortierung wird mit der Variante gespeichert');
  assert.match(seite, /setSortierung\(feld\(a, 'sortierung', /, 'gewählte Variante setzt die Sortierung');
  assert.match(seite, /onSort=\{/, 'Sortieren in der Tabelle wird gemerkt');
  assert.match(seite, /tabelle\.current\?\.setSortBy\?\.\(sortierung \? \[sortierung\] : \[\]\)/, 'Sortierung wird auf die Tabelle angewendet');
  assert.match(seite, /initialState: \{ sortBy: sortierung \? \[sortierung\] : \[\] \}/);
});
