/** Euroflex-Kontakte → Paperless-Korrespondenten: Abgleich, Übertragen, Sofortprüfung beim Anlegen/Ändern */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { abgleichPlanen, korrespondentName, korrespondentenUebertragen, korrespondentSichern, type KorrespondentQuelle } from '../../modules/transport/server/korrespondenten.js';

/** Paperless-Attrappe: Liste der Korrespondenten, Anlegen merkt sich die Namen */
function attrappe(start: string[], kaputt: string[] = []) {
  const liste = start.map((name, i) => ({ id: 9100 + i, name }));
  const angelegt: string[] = [];
  const pl: KorrespondentQuelle = {
    korrespondenten: async () => liste,
    korrespondent: async (name, anlegen = true) => {
      const hit = liste.find((k) => k.name.trim().toLowerCase() === name.trim().toLowerCase());
      if (hit || !anlegen) return hit?.id ?? null;
      if (kaputt.includes(name)) throw new Error('HTTP 400');
      const neu = { id: 9200 + liste.length, name };
      liste.push(neu); angelegt.push(name);
      return neu.id;
    },
  };
  return { pl, angelegt };
}

test('Korrespondentenname: Name und Namenszusatz, Leerzeichen zusammengefasst', () => {
  assert.equal(korrespondentName({ kundenname: 'Spedition  Kranich', kundenname2: 'GmbH & Co. KG ' }), 'Spedition Kranich GmbH & Co. KG');
  assert.equal(korrespondentName({ kundenname: '', kundenname2: null }), '');
});

test('abgleichPlanen: vorhandene ohne Groß-/Kleinschreibung, gleiche fehlende Namen nur einmal', () => {
  const plan = abgleichPlanen([
    { adrnr: 88001, kundenname: 'Holzhandel Amsel' },
    { adrnr: 88002, kundenname: 'spedition kranich' },
    { adrnr: 88003, kundenname: 'Zeder Logistik' },
    { adrnr: 88004, kundenname: 'Zeder Logistik' },
    { adrnr: 88005, kundenname: '', kundenname2: '' },
  ], [{ id: 1, name: 'Spedition Kranich ' }]);
  assert.deepEqual(plan.vorhanden, [{ adrnr: 88002, name: 'spedition kranich', id: 1 }]);
  assert.deepEqual(plan.fehlend, [{ name: 'Holzhandel Amsel', adrnr: [88001] }, { name: 'Zeder Logistik', adrnr: [88003, 88004] }]);
});

test('korrespondentenUebertragen: legt nur Fehlendes an, Fehler einzelner Namen brechen nicht ab', async () => {
  const { pl, angelegt } = attrappe(['Spedition Kranich'], ['Kaputt AG']);
  const r = await korrespondentenUebertragen(pl, [
    { adrnr: 88011, kundenname: 'Spedition Kranich' },
    { adrnr: 88012, kundenname: 'Holzhandel Amsel' },
    { adrnr: 88013, kundenname: 'Kaputt AG' },
  ]);
  assert.deepEqual(angelegt, ['Holzhandel Amsel']);
  assert.equal(r.vorhanden, 1);
  assert.deepEqual(r.angelegt, ['Holzhandel Amsel']);
  assert.equal(r.fehler.length, 1);
  assert.match(r.text, /1 Korrespondent\(en\) in Paperless angelegt/);
  assert.match(r.text, /Kaputt AG \(HTTP 400\)/);

  const nochmal = await korrespondentenUebertragen(pl, [{ adrnr: 88012, kundenname: 'Holzhandel Amsel' }]);
  assert.deepEqual(nochmal.angelegt, [], 'zweiter Lauf legt nichts doppelt an');
});

test('korrespondentSichern: neuer Kontakt wird sofort angelegt, vorhandener nur geprüft', async () => {
  const { pl, angelegt } = attrappe(['Holzhandel Amsel']);
  const a = await korrespondentSichern(pl, { adrnr: 88021, kundenname: 'Fichte', kundenname2: 'Transporte' });
  assert.equal(a.status, 'angelegt');
  assert.deepEqual(angelegt, ['Fichte Transporte']);
  const b = await korrespondentSichern(pl, { adrnr: 88022, kundenname: 'holzhandel amsel' });
  assert.equal(b.status, 'vorhanden');
  assert.equal(angelegt.length, 1);
  assert.equal((await korrespondentSichern(pl, { adrnr: 88023, kundenname: ' ' })).status, 'ohne-name');
  const c = await korrespondentSichern(attrappe([], ['Kaputt AG']).pl, { adrnr: 88024, kundenname: 'Kaputt AG' });
  assert.equal(c.status, 'fehler', 'Fehler kommt als Hinweis zurück statt das Speichern abzubrechen');
});

test('Anlegen/Ändern eines Kontakts prüft den Korrespondenten sofort; Knöpfe in der Oberfläche', () => {
  const index = readFileSync(new URL('../../modules/transport/server/index.ts', import.meta.url), 'utf8');
  assert.equal(index.match(/paperless: await kontaktNachPaperless\(/g)?.length, 2, 'POST und PUT /adressen');
  const ui = readFileSync(new URL('../../modules/transport/web/Kontakte.tsx', import.meta.url), 'utf8');
  assert.match(ui, /kontakte\/paperless-abgleich/);
  assert.match(ui, /kontakte\/\$\{adrnr\}\/paperless/);
});
