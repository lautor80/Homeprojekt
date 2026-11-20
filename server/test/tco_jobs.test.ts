/**
 * Jobs des Vereinsmoduls (modules/tco/server/jobs.ts) – ohne Datenbank: eindeutige Ids mit Präfix „tco.“, Texte, gültiger
 * Plan, Ausführungsrecht vorhanden; kein setInterval mehr in den Modulen (jede Funktion läuft als Job); abgeschaltete
 * Apps laufen nach Plan nicht (der Lauf wird verworfen) und von Hand nur mit Protokollzeile.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TCO_JOBS } from '../../modules/tco/server/jobs.js';
import { appId, modulId, schalterSetzen, schalterZustand } from '../src/funktionsschalter.js';
import type { JobKontext, JobStufe } from '../src/job-typen.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dateien = (dir: string): string[] => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => {
  const p = path.join(dir, d.name);
  if (d.isDirectory()) return d.name === 'node_modules' ? [] : dateien(p);
  return /\.ts$/.test(d.name) ? [p] : [];
});
const QUELLTEXT = ['server/src', 'modules/tco/server'].flatMap(dateien).map((datei) => ({ datei, text: fs.readFileSync(path.join(ROOT, datei), 'utf8') }));

test('tco-Jobs: eindeutige Ids mit Präfix „tco.“, Texte, Bereich, gültiger Plan', () => {
  assert.ok(TCO_JOBS.length >= 6, 'die bisherigen Hintergrundläufe fehlen');
  const ids = TCO_JOBS.map((j) => j.id);
  assert.equal(new Set(ids).size, ids.length, `doppelte Ids: ${ids.join(', ')}`);
  for (const j of TCO_JOBS) {
    assert.match(j.id, /^tco\.[a-z0-9_]+(\.[a-z0-9_]+)+$/, `${j.id}: Id „tco.<bereich>.<name>“`);
    assert.ok(j.text.trim().length >= 5, `${j.id}: Anzeigename fehlt`);
    assert.ok(j.beschreibung.trim().length >= 40, `${j.id}: Beschreibung fehlt oder ist zu knapp`);
    assert.match(j.bereich, /^[^→]+ → [^→]+$/, `${j.id}: Bereich als „Menübereich → App“`);
    const p = j.standardPlan;
    if (p.art === 'intervall') {
      assert.ok(Number.isInteger(p.minuten) && p.minuten >= 1 && p.minuten <= 7 * 1440, `${j.id}: Intervall ${p.minuten} Minuten`);
    } else {
      assert.equal(p.art, 'taeglich', `${j.id}: unbekannte Planart`);
      assert.match(p.uhrzeit, /^([01]\d|2[0-3]):[0-5]\d$/, `${j.id}: Uhrzeit ${p.uhrzeit}`);
      assert.ok(p.wochentage.every((t) => Number.isInteger(t) && t >= 1 && t <= 7), `${j.id}: Wochentage ${p.wochentage}`);
      assert.equal(new Set(p.wochentage).size, p.wochentage.length, `${j.id}: Wochentag doppelt`);
    }
    assert.equal(typeof j.ausfuehren, 'function');
  }
});

test('tco-Jobs: Ausführungsrecht ist ein vorhandenes Recht, die bisherigen Läufe sind eingeplant', () => {
  for (const j of TCO_JOBS) {
    assert.ok(j.recht, `${j.id}: Ausführungsrecht der Fach-App fehlt`);
    assert.match(j.recht!, /^[a-z]+\.[a-z0-9_]+:[a-z]+$/, `${j.id}: Recht ${j.recht}`);
    assert.ok(QUELLTEXT.some((q) => !q.datei.endsWith('jobs.ts') && q.text.includes(`'${j.recht}'`)), `${j.id}: Recht ${j.recht} gibt es sonst nirgends`);
  }
  // bisher per setInterval/setTimeout: nach der Installation eingeplant wie zuvor
  const bisher = { 'tco.platz.abolauf': 60, 'tco.instandhaltung.lauf': 60, 'tco.mitglieder.austritt': 360, 'tco.benutzer.rollenabgleich': 360, 'tco.mahnung.automatik': 1 };
  for (const [id, minuten] of Object.entries(bisher)) {
    const j = TCO_JOBS.find((x) => x.id === id);
    assert.ok(j, `${id} fehlt`);
    assert.deepEqual(j!.standardPlan, { art: 'intervall', minuten }, id);
    assert.notEqual(j!.standardEingeplant, false, `${id}: lief bisher von selbst`);
  }
  assert.equal(TCO_JOBS.find((x) => x.id === 'tco.mahnung.automatik')!.recht, 'tco.mahnung:execute');
  // neu angemeldete Knopf-Funktionen ändern den Betrieb nicht: nicht eingeplant
  for (const id of ['tco.jt.ferien', 'tco.halle.ep3import', 'tco.eingang.mailabruf']) {
    assert.equal(TCO_JOBS.find((x) => x.id === id)?.standardEingeplant, false, `${id}: nur von Hand bzw. bewusst einplanen`);
  }
});

test('Hintergrundläufe nur als Job: kein setInterval in den Modulen tco, transport und miete', () => {
  const module = ['modules/tco/server', 'modules/transport/server', 'modules/miete/server'].filter((d) => fs.existsSync(path.join(ROOT, d))).flatMap(dateien);
  assert.ok(module.length > 50, 'Quelltext der Module nicht gefunden');
  const treffer = module.filter((d) => /\bsetInterval\(/.test(fs.readFileSync(path.join(ROOT, d), 'utf8')));
  assert.deepEqual(treffer, [], 'regelmäßige Läufe gehören als JobDef in modules/<modul>/server/jobs.ts');
});

// ---------------------------------------------------------------- Funktionsschalter (ohne Datenbank: der Lauf endet vor dem Laden der Fachfunktion)
const vorher = schalterZustand();
after(() => schalterSetzen(vorher));

function kontext(manuell: boolean) {
  const zeilen: { text: string; stufe: JobStufe }[] = [];
  let leer = false;
  const ctx: JobKontext = {
    laufId: 1, manuell, von: { id: null, name: manuell ? 'Admin' : 'system (Jobplanung)' }, signal: new AbortController().signal,
    log: (text, stufe = 'info') => { zeilen.push({ text, stufe }); }, leer: () => { leer = true; },
  };
  return { ctx, zeilen, istLeer: () => leer };
}

test('Funktionsschalter: abgeschaltete App läuft nach Plan nicht (Lauf verworfen), von Hand nur Protokollzeile', async () => {
  const aus = (ids: string[]) => schalterSetzen({ ids: new Set(ids), rechte: new Set(), routen: new Map() });
  const faelle: [string, string[]][] = [
    ['tco.platz.abolauf', [appId('tco', 'Platz buchen')]],
    ['tco.instandhaltung.lauf', [appId('tco', 'Schadensmeldungen')]],
    ['tco.benutzer.rollenabgleich', ['tco.benutzer.rollenabgleich']],
    ['tco.benutzer.rollenabgleich', [modulId('tco')]],
    ['tco.rundschreiben.wiederaufnahme', ['tco.rundschreiben.versand']],
    ['tco.jt.ferien', [appId('tco', 'Abrechnung Jugendtraining')]],
    ['tco.halle.ep3import', ['tco.halle.ep3import']],
    ['tco.eingang.mailabruf', [appId('tco', 'Dokumenteneingang')]],
  ];
  for (const [id, ids] of faelle) {
    aus(ids);
    const j = TCO_JOBS.find((x) => x.id === id)!;
    const plan = kontext(false);
    const r1 = await j.ausfuehren(plan.ctx);
    assert.ok(plan.istLeer(), `${id}: Planlauf bei abgeschalteter App nicht verworfen`);
    assert.match(String(r1), /abgeschaltet.*nichts ausgeführt/, id);
    const hand = kontext(true);
    const r2 = await j.ausfuehren(hand.ctx);
    assert.match(String(r2), /abgeschaltet.*nichts ausgeführt/, `${id}: von Hand`);
    assert.deepEqual(hand.zeilen.map((z) => z.stufe), ['warnung'], `${id}: eine Protokollzeile von Hand`);
  }
  aus([]);
});
