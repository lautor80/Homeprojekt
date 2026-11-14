/**
 * Absicherung des Arbeitsvorrats beim Umbau (#232, V3) – drei Prüfungen, alle ohne Datenbank (nur Quelltext):
 *
 *  1. Jeder Pfad, auf den ein Eintrag des Arbeitsvorrats verweist, ist eine vorhandene Seite; ein „?tab=…“ gibt es
 *     als Reiter der Seite. Zieht eine Funktion um, fällt der tote Verweis hier auf.
 *  2. Jede Schnittstelle, jeder automatische Lauf und jeder Eingang von außen steht im Verzeichnis
 *     modules/tco/server/dashboard/ereignisquellen.ts – mit Eintrag im Arbeitsvorrat, als offener Punkt (V1) oder
 *     mit Begründung, warum es keinen Eintrag braucht. Neues ohne Entscheidung lässt den Test scheitern.
 *  3. Das Verzeichnis stimmt: nichts Veraltetes, jeder genannte Eintrag existiert im Arbeitsvorrat und jeder genannte
 *     Hinweis (V1) wird im Quelltext gemeldet; auch dessen Absprung ist eine vorhandene Seite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EREIGNISQUELLEN } from '../../modules/tco/server/dashboard/ereignisquellen.js';

/** offene Punkte im Verzeichnis, Stand 14.11.2026 – nur senken, nie erhöhen */
const OFFEN_HOECHSTENS = 0;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lesen = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

/** alle .ts-Dateien eines Ordners (ohne Tests und Migrationen), Pfade relativ zum Projekt */
function dateien(rel: string): string[] {
  const dir = path.join(ROOT, rel);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((n) => {
    const r = `${rel}/${n}`;
    if (statSync(path.join(ROOT, r)).isDirectory()) return ['migrations', 'test', 'assets'].includes(n) ? [] : dateien(r);
    return /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [r] : [];
  });
}

const MODULE = readdirSync(path.join(ROOT, 'modules')).filter((m) => existsSync(path.join(ROOT, 'modules', m, 'server'))).sort();
/** Serverquellen je Herkunft: „core“ und je Modul seine Id */
const QUELLTEXT: { modul: string; datei: string; text: string }[] = [
  ...dateien('server/src').map((datei) => ({ modul: 'core', datei, text: lesen(datei) })),
  ...MODULE.flatMap((m) => dateien(`modules/${m}/server`).map((datei) => ({ modul: m, datei, text: lesen(datei) }))),
];

// ---------------------------------------------------------------- Quellen des Arbeitsvorrats
const AV = 'modules/tco/server/dashboard/arbeitsvorrat.ts';
/** Arbeitsvorrat des Kerns (seit V2), arbeitsvorrat.ts des Vereinsmoduls und alle Dateien, aus denen es eine Funktion „aufgaben“ einbindet */
const AV_KERN = 'server/src/lib/arbeitsvorrat.ts';
const AV_DATEIEN = [AV_KERN, AV, ...[...lesen(AV).matchAll(/import \{[^}]*\baufgaben\b[^}]*\} from '([^']+)\.js'/g)]
  .map(([, p]) => path.posix.normalize(`${path.posix.dirname(AV)}/${p}.ts`))];
/** Schlüssel der Einträge, z. B. MITGLIEDSANTRAG, SCHLUESSEL:Q, VZ_ABSCHLUSS */
const AV_SCHLUESSEL = new Set(AV_DATEIEN.flatMap((d) => [...lesen(d).matchAll(/\bkey: ['`]([A-Z][A-Z0-9_]*(?::[A-Z]+)?)/g)].map(([, k]) => k)));

/** Hinweise (V1): Dateien, die Ereignisse melden (hinweisMelden, tcoHinweis, stoerungMelden …) */
const MELDER = QUELLTEXT.filter((q) => /\b(?:\w*Hinweis|hinweisMelden|stoerungMelden)\(/.test(q.text) && q.datei !== 'server/src/lib/hinweise.ts');
/** gemeldete Quellen – { quelle: 'MG_BANK', … } */
const HINWEIS_QUELLEN = new Set(MELDER.flatMap((q) => [...q.text.matchAll(/\bquelle: '([A-Z][A-Z0-9_]*)'/g)].map(([, k]) => k)));
/** Absprünge der Meldungen: pfad im Aufruf der Meldefunktion */
const HINWEIS_PFADE = MELDER.flatMap((q) => [...q.text.matchAll(/\b(?:\w*Hinweis|hinweisMelden|stoerungMelden)\([^;]*?\bpfad: ['`](\/[a-z0-9/-]*)/gs)].map(([, pfad]) => ({ pfad, datei: q.datei })));

// ---------------------------------------------------------------- Seiten der Oberfläche
interface Seite { pfad: string; datei: string | null }
function seiten(): Seite[] {
  const out: Seite[] = [];
  for (const index of ['web/src/shell/core.tsx', ...MODULE.map((m) => `modules/${m}/web/index.ts`)]) {
    const text = lesen(index);
    const importe = new Map([...text.matchAll(/import \{([^}]+)\} from '(\.[^']+)'/g)]
      .flatMap(([, namen, von]) => namen.split(',').map((n) => [n.trim().split(/\s+as\s+/).pop()!, von] as [string, string])));
    for (const [, pfad, komponente] of text.matchAll(/\{ path: '([^']+)', component: (\w+)/g)) {
      const von = importe.get(komponente);
      out.push({ pfad, datei: von ? path.posix.normalize(`${path.posix.dirname(index)}/${von}.tsx`) : null });
    }
  }
  return out;
}

test('Arbeitsvorrat: jeder Verweis führt auf eine vorhandene Seite und einen vorhandenen Reiter', () => {
  const alle = seiten();
  assert.ok(alle.length > 40, 'Seiten der Oberfläche nicht erkannt');
  assert.ok(AV_DATEIEN.length >= 3, 'Quellen des Arbeitsvorrats nicht erkannt');
  let geprueft = 0;
  for (const datei of AV_DATEIEN) {
    for (const [, pfad, tab] of lesen(datei).matchAll(/['`](\/(?:tco|admin|transport|beispiel)\/[a-z0-9/-]*)(?:\?tab=([a-z]+))?/g)) {
      const seite = alle.find((s) => s.pfad === pfad);
      assert.ok(seite, `${datei}: Eintrag verweist auf ${pfad} – diese Seite gibt es nicht (mehr). Beim Umzug einer Funktion den Verweis mitziehen.`);
      if (tab) {
        assert.ok(seite.datei && existsSync(path.join(ROOT, seite.datei)), `${datei}: Datei der Seite ${pfad} nicht gefunden`);
        const quelle = lesen(seite.datei!);
        assert.ok(quelle.includes(`data-key="${tab}"`), `${datei}: ${pfad}?tab=${tab} – den Reiter „${tab}“ gibt es in ${seite.datei} nicht (mehr)`);
        assert.ok(quelle.includes("get('tab')"), `${datei}: ${seite.datei} wertet „?tab=“ nicht aus`);
      }
      geprueft++;
    }
  }
  assert.ok(geprueft >= 15, `nur ${geprueft} Verweise gefunden – Erkennung prüfen`);
  // Hinweise (V1): auch ihr Absprung muss eine vorhandene Seite sein
  assert.ok(HINWEIS_QUELLEN.size >= 9, `nur ${HINWEIS_QUELLEN.size} gemeldete Hinweise gefunden – Erkennung prüfen`);
  assert.ok(HINWEIS_PFADE.length >= 5, `nur ${HINWEIS_PFADE.length} Absprünge von Hinweisen gefunden – Erkennung prüfen`);
  for (const h of HINWEIS_PFADE) {
    assert.ok(alle.some((s) => s.pfad === h.pfad), `${h.datei}: ein Hinweis verweist auf ${h.pfad} – diese Seite gibt es nicht (mehr)`);
  }
});

// ---------------------------------------------------------------- Ereignisquellen aus dem Quelltext
/** alles, was Ereignisse auslösen kann – abgeleitet aus dem Quelltext, nicht von Hand gepflegt */
function ereignisquellen(): Map<string, string> {
  const out = new Map<string, string>();
  for (const { modul, datei, text } of QUELLTEXT) {
    // Schnittstellen: Verbindungsdefinitionen (Administration → Schnittstellen)
    if (text.includes('VerbindungDef')) {
      for (const [, roh] of text.matchAll(/\bid: ([A-Z][A-Z0-9_]*|'[^']+'), text: '/g)) {
        const id = roh.startsWith("'") ? roh.slice(1, -1) : new RegExp(`const ${roh} = '([^']+)'`).exec(text)?.[1];
        assert.ok(id, `${datei}: Id der Verbindung ${roh} nicht auflösbar`);
        out.set(`schnittstelle:${id}`, datei);
      }
    }
    // Paperless je Bereich (#232, S5): paperlessDef('<modul>', …) – TC Oberthal behält die Id „paperless“
    for (const [, m] of text.matchAll(/\bpaperlessDef\('([a-z]+)'/g)) out.set(`schnittstelle:${m === 'tco' ? 'paperless' : `${m}.paperless`}`, datei);
    // automatische Läufe
    const laeufe = text.match(/\bsetInterval\(/g)?.length ?? 0;
    for (let i = 0; i < laeufe; i++) out.set(`lauf:${datei}${i ? `#${i + 1}` : ''}`, datei);
    // Routen, die etwas ändern
    for (const [, methode, pfad, rest] of text.matchAll(/\bapp\.(post|put|delete|patch)\('([^']+)',\s*([^\n]*)/g)) {
      const route = `${modul} ${methode.toUpperCase()} ${pfad}`;
      const ohneAnmeldung = /^async\b/.test(rest) || /^\{(?![^}]*(?:preHandler|\.\.\.))[^}]*\},\s*async\b/.test(rest);
      if (ohneAnmeldung) out.set(`eingang:${route}`, datei);                         // öffentlich: Formulare, Links, Webhooks
      else if (/^(?:\{\s*\.\.\.)?melden\b/.test(rest)) out.set(`meldung:${route}`, datei); // Meldungen (Schaden, n8n mit API-Schlüssel)
      else if (/\/meine\/|\/meinkonto\b/.test(pfad)) out.set(`selbst:${route}`, datei);     // Selbstbedienung der Mitglieder und Hallennutzer
    }
  }
  return out;
}

test('Ereignisquellen: jede Schnittstelle, jeder Lauf und jeder Eingang ist im Verzeichnis entschieden', () => {
  const quellen = ereignisquellen();
  // Anker: Die Erkennung darf nicht still leerlaufen
  for (const k of ['schnittstelle:paperless', 'schnittstelle:mail', 'schnittstelle:tco.ep3', 'lauf:server/src/backup-export.ts', 'eingang:tco POST /antrag', 'meldung:tco POST /eingang/mail', 'selbst:tco POST /mitglieder/meine/kuendigung']) {
    assert.ok(quellen.has(k), `Erkennung defekt: ${k} nicht gefunden`);
  }
  const fehlt = [...quellen].filter(([k]) => !(k in EREIGNISQUELLEN)).map(([k, datei]) => `  ${k}   (${datei})`);
  assert.deepEqual(fehlt, [], `Neue Ereignisquelle ohne Entscheidung. In modules/tco/server/dashboard/ereignisquellen.ts eintragen – mit Eintrag im Arbeitsvorrat (aufgabe), als offenen Punkt (offen) oder mit Begründung (ohne):\n${fehlt.join('\n')}\n`);
  const veraltet = Object.keys(EREIGNISQUELLEN).filter((k) => !quellen.has(k));
  assert.deepEqual(veraltet, [], `Im Verzeichnis steht, was es im Quelltext nicht mehr gibt – Eintrag entfernen oder umbenennen:\n  ${veraltet.join('\n  ')}\n`);
});

test('Ereignisquellen: genannte Einträge gibt es im Arbeitsvorrat, offene Punkte sind begründet', () => {
  assert.ok(AV_SCHLUESSEL.size >= 15, 'Schlüssel des Arbeitsvorrats nicht erkannt');
  let offen = 0;
  for (const [quelle, a] of Object.entries(EREIGNISQUELLEN)) {
    const arten = ['aufgabe', 'hinweis', 'ueberwacht', 'offen', 'ohne'].filter((x) => x in a);
    assert.equal(arten.length, 1, `${quelle}: genau eine Angabe aus aufgabe / hinweis / ueberwacht / offen / ohne`);
    if ('aufgabe' in a) {
      for (const aufgabe of [a.aufgabe].flat()) {
        assert.ok([...AV_SCHLUESSEL].some((k) => k === aufgabe || k.startsWith(`${aufgabe}:`)),
          `${quelle}: Eintrag „${aufgabe}“ gibt es im Arbeitsvorrat nicht (mehr) – vorhanden: ${[...AV_SCHLUESSEL].sort().join(', ')}`);
      }
    } else if ('ueberwacht' in a) {
      // der Aufruf der Schnittstelle läuft über die Überwachung: …Schnittstelle(V_EP3, …)
      assert.match(quelle, /^schnittstelle:/, `${quelle}: „ueberwacht“ gibt es nur für Schnittstellen`);
      const aufruf = new RegExp(`\\b\\w*Schnittstelle\\(\\s*${a.ueberwacht}\\s*,`);
      const wo = QUELLTEXT.filter((q) => aufruf.test(q.text)).map((q) => q.datei);
      assert.ok(wo.length > 0, `${quelle}: kein überwachter Aufruf gefunden (…Schnittstelle(${a.ueberwacht}, …))`);
      // und die Konstante gehört zu dieser Anbindung
      const id = quelle.slice('schnittstelle:'.length);
      assert.ok(QUELLTEXT.some((q) => q.text.includes(`const ${a.ueberwacht} = '${id}'`)), `${quelle}: ${a.ueberwacht} ist nicht die Id dieser Anbindung`);
    } else if ('hinweis' in a) {
      for (const h of [a.hinweis].flat()) {
        assert.ok(HINWEIS_QUELLEN.has(h), `${quelle}: Hinweis „${h}“ wird nirgends gemeldet (hinweisMelden mit quelle: '${h}') – gemeldet werden: ${[...HINWEIS_QUELLEN].sort().join(', ')}`);
      }
    } else {
      const text = 'offen' in a ? a.offen : a.ohne;
      assert.ok(text.trim().length >= 10, `${quelle}: Begründung fehlt`);
      if ('offen' in a) offen++;
    }
  }
  // Sperrklinke: Die Zahl der offenen Punkte darf nur sinken. Wird eine Lücke geschlossen (V1), die Zahl hier senken.
  assert.ok(offen >= OFFEN_HOECHSTENS, `nur noch ${offen} offene Punkte – bitte OFFEN_HOECHSTENS in diesem Test auf ${offen} senken, damit die Lücke nicht wieder aufgeht`);
  assert.ok(offen <= OFFEN_HOECHSTENS, `${offen} offene Punkte, erlaubt sind ${OFFEN_HOECHSTENS} – eine neue Ereignisquelle braucht einen Eintrag im Arbeitsvorrat, keinen weiteren offenen Punkt`);
});
