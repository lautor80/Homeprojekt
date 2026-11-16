/**
 * Mein Bereich (#232, N2 und B2) – ohne Datenbank, nur Quelltext:
 *  - „Meine Daten“ ist eine App für Mitglieder und Hallennutzer; die frühere App „Meine Mitgliedschaft“ ist ihr Inhalt für Mitglieder.
 *  - „Platz buchen“ schaltet seine drei Teile mit Reitern; der Umschalter bleibt für Sichten derselben Daten.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lies = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8');

test('Meine Daten: eine App, Inhalt je nachdem ob Mitglied oder Hallennutzer; alte Adresse bleibt gültig', () => {
  const modul = lies('modules/tco/web/index.ts');
  // seit der App „Projekte“ gehört die Zeiterfassung (Training, Projekt) als Reiter „Meine Zeiten“ dazu – auch Trainer erreichen die App
  const rechte = 'tco.meinedaten:edit|tco.meinkonto:edit|tco.jtmeine:edit|tco.projektzeiten:edit';
  assert.ok(modul.includes(`{ text: 'Meine Daten', icon: 'customer', path: '/tco/meine-daten', permission: '${rechte}' }`), 'ein Menüeintrag mit den Rechten für Daten und Zeiten');
  assert.ok(!/text: 'Meine Mitgliedschaft'/.test(modul), 'kein zweiter Menüeintrag, keine zweite Kachel');
  assert.ok(modul.includes(`{ path: '/tco/meine-daten', component: MeineDatenApp, permission: '${rechte}' }`));
  assert.ok(modul.includes("{ path: '/tco/meine-mitgliedschaft', component: MeineDatenApp, permission: 'tco.meinedaten:edit' }"), 'alte Adresse');
  // Inhalt des Reiters „Meine Daten“: Mitglied → Mitgliedschaft, Hallennutzer → Kontaktdaten
  assert.ok(lies('modules/tco/web/platz/MeineDaten.tsx').includes("const stamm = can('tco.meinedaten:edit') ? <MeineMitgliedschaft /> : can('tco.meinkonto:edit') ? <MeineDaten /> : null;"));
  const katalog = lies('modules/tco/server/index.ts');
  assert.equal([...katalog.matchAll(/area: 'Mein Bereich', app: 'Meine Daten', id: /g)].length, 4, 'Rollenpflege: Daten (Mitglied, Hallennutzer) und Zeiten (Training, Projekt) unter der einen App');
  assert.ok(!/app: 'Meine Mitgliedschaft'/.test(katalog));
});

test('Platz buchen: Reiter für die Teile der App', () => {
  const pb = lies('modules/tco/web/platz/PlatzBuchen.tsx');
  assert.deepEqual([...pb.matchAll(/<Tab data-k="([a-z]+)" icon="[a-z-]+" text="([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`), ['kalender:Kalender', 'meine:Meine Buchungen', 'abo:Abo-Bewerbung']);
  assert.ok(!/portal-pb__umschalter" onSelectionChange/.test(pb), 'kein Umschalter mehr für die Teile der App');
});
