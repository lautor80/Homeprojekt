#!/usr/bin/env node
/**
 * System- und Prozesslandschaft TC Oberthal (Issue #118) – erzeugt docs/landschaft/*.md aus dem Code.
 *
 *   node scripts/landschaft.mjs            Dokumentation neu schreiben
 *   node scripts/landschaft.mjs --pruefen  nichts schreiben; Fehler bei kaputten Verweisen, Hinweis wenn veraltet
 *   node scripts/landschaft.mjs --check    nichts schreiben; Fehler bei kaputten Verweisen ODER veralteter Doku
 *
 * Quellen (alles automatisch, außer prozesse.json):
 *   Level 1  docker-compose.yml (Container), modules/tco/web/index.ts (Bereiche, Apps, öffentliche Seiten, Kacheltexte),
 *            docs/n8n/*.json (Workflows, Auslöser, Ziele), modules/tco/server/verbindung.ts + server/src/lib (Anbindungen)
 *   Level 2  docs/landschaft/prozesse.json (ebene 2) – Verweise auf Routen, Rechte, Apps und Workflows werden geprüft
 *   Level 3  docs/landschaft/prozesse.json (ebene 3)
 *   Level 4  Migrationen (create table) und die Quelltexte hinter den Routen eines Prozesses
 *
 * Ohne Abhängigkeiten (nur Node ≥ 22), damit es in CI und lokal ohne npm ci läuft.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/landschaft');
const MOD = 'modules/tco';
const PREFIX = '/api/m/tco';
const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const PRUEFEN = args.has('--pruefen') || CHECK;

const lesen = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const gibt = (p) => fs.existsSync(path.join(ROOT, p));
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');
function dateien(dir, re) {
  const out = [];
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const p = path.join(abs, e.name);
    if (e.isDirectory()) out.push(...dateien(rel(p), re));
    else if (re.test(e.name)) out.push(rel(p));
  }
  return out.sort();
}
const md = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const mm = (s) => String(s ?? '').replace(/"/g, "'").replace(/[<>]/g, '');
const warnungen = [];
const fehler = [];

// ------------------------------------------------------------------ Container (docker-compose.yml)
function container() {
  const text = lesen('docker-compose.yml');
  const liste = [];
  let akt = null;
  let inServices = false;
  for (const zeile of text.split('\n')) {
    if (/^services:/.test(zeile)) { inServices = true; continue; }
    if (/^\S/.test(zeile)) inServices = false;
    if (!inServices) continue;
    const s = zeile.match(/^ {2}([a-z0-9-]+):\s*$/);
    if (s) { akt = { name: s[1], image: '', profil: '' }; liste.push(akt); continue; }
    if (!akt) continue;
    const i = zeile.match(/^ {4}image:\s*(\S+)/);
    if (i) akt.image = i[1];
    const p = zeile.match(/^ {4}profiles:\s*\[([^\]]*)\]/);
    if (p) akt.profil = p[1].replace(/["' ]/g, '');
  }
  return liste;
}

// ------------------------------------------------------------------ Bereiche und Apps (Web-Navigation)
function apps() {
  const text = lesen(`${MOD}/web/index.ts`);
  const navTeil = text.slice(text.indexOf('nav: ['), text.indexOf('routes: ['));
  const kacheln = {};
  for (const m of text.matchAll(/\{ text: '([^']+)', subtitle: '([^']+)'[^}]*?path: '([^']+)'/g)) kacheln[m[3]] = m[2];
  const liste = [];
  let bereich = 'Allgemein';
  for (const zeile of navTeil.split('\n')) {
    const app = zeile.match(/text: '([^']+)'.*path: '([^']+)'(?:, permission: '([^']+)')?/);
    if (app) {
      const tief = zeile.search(/\S/) >= 12;
      liste.push({ bereich: tief ? bereich : 'Allgemein', app: app[1], pfad: app[2], recht: app[3] ?? '', text: kacheln[app[2]] ?? '' });
      continue;
    }
    const gruppe = zeile.match(/^\s+text: '([^']+)', icon:/);
    if (gruppe) bereich = gruppe[1];
  }
  const oeffentlich = [...text.matchAll(/\{ pfad: '([^']+)', component: (\w+)/g)].map((m) => ({ pfad: m[1], komponente: m[2] }));
  return { liste, oeffentlich };
}

// ------------------------------------------------------------------ Server-Routen
function routen() {
  const liste = [];
  const quellen = [
    ...dateien(`${MOD}/server`, /\.ts$/).map((f) => ({ f, modul: true })),
    ...dateien('server/src/routes', /\.ts$/).map((f) => ({ f, modul: false })),
  ];
  for (const { f, modul } of quellen) {
    for (const m of lesen(f).matchAll(/app\.(get|post|put|delete|patch)\(\s*['`]([^'`]+)['`]/g)) {
      const p = m[2];
      liste.push({ methode: m[1].toUpperCase(), pfad: p, voll: modul && !p.startsWith('/api/') ? PREFIX + p : p, datei: f, modul });
    }
  }
  return liste;
}

// ------------------------------------------------------------------ Berechtigungen
function rechte() {
  const set = new Set();
  for (const f of [...dateien(`${MOD}/server`, /\.ts$/), ...dateien('server/src', /\.ts$/)]) {
    for (const m of lesen(f).matchAll(/'((?:tco|core)\.[a-z_]+:[a-z_]+)'/g)) set.add(m[1]);
  }
  return set;
}

// ------------------------------------------------------------------ n8n-Workflows
function zielVon(url) {
  if (/app:8080|\/api\/m\/tco|\/api\//.test(url) && !/PAPERLESS/.test(url)) return 'portal';
  if (/PAPERLESS|paperless/.test(url)) return 'paperless';
  if (/openai\.com/.test(url)) return 'openai';
  return 'extern';
}
function workflows() {
  const liste = [];
  for (const f of dateien('docs/n8n', /\.json$/)) {
    const w = JSON.parse(lesen(f));
    const wf = { name: w.name, datei: f, ausloeser: [], ziele: [] };
    for (const n of w.nodes ?? []) {
      const typ = n.type.replace('n8n-nodes-base.', '');
      const p = n.parameters ?? {};
      if (typ === 'webhook') wf.ausloeser.push(`Webhook /webhook/${p.path}`);
      if (typ === 'scheduleTrigger') {
        const i = p.rule?.interval?.[0];
        wf.ausloeser.push(i ? `Zeitplan alle ${i.minutesInterval ?? i.hoursInterval ?? ''} ${i.field === 'hours' ? 'Std.' : 'Min.'}` : 'Zeitplan');
      }
      if (typ === 'manualTrigger') wf.ausloeser.push('manuell (Editor)');
      if (typ === 'httpRequest') {
        const url = String(p.url ?? '');
        const ziel = zielVon(url);
        const pfad = ziel === 'portal' ? (url.match(/\/api\/[^\s'"{}]*/)?.[0] ?? url) : ziel === 'paperless' ? (url.match(/\/api\/[a-z_]+/)?.[0] ?? '') : '';
        wf.ziele.push({ ziel, art: 'HTTP', knoten: n.name, detail: pfad || url.replace(/^=/, '').slice(0, 60) });
      }
      if (typ === 'mySql') wf.ziele.push({ ziel: 'ep3', art: 'MySQL (lesend)', knoten: n.name, detail: '' });
      if (typ.includes('imap')) wf.ziele.push({ ziel: 'mailserver', art: 'IMAP', knoten: n.name, detail: '' });
      if (typ === 'emailSend') wf.ziele.push({ ziel: 'mailserver', art: 'SMTP', knoten: n.name, detail: '' });
    }
    liste.push(wf);
  }
  return liste;
}

// ------------------------------------------------------------------ Anbindungen (Administration → Anbindungen)
function anbindungen() {
  const liste = [];
  const quellen = [`${MOD}/server/verbindung.ts`, 'server/src/lib/verbindungen.ts', 'server/src/lib/mail.ts', 'server/src/lib/webdav.ts', 'modules/transport/server/mailversand.ts'];
  for (const f of quellen.filter(gibt)) {
    const t = lesen(f);
    const konst = Object.fromEntries([...t.matchAll(/(?:export )?const (\w+) = '([^']+)'/g)].map((m) => [m[1], m[2]]));
    const treffer = [...t.matchAll(/id: (\w+|'[^']+'), text: '([^']+)'/g)];
    treffer.forEach((m, i) => {
      const id = m[1].startsWith("'") ? m[1].slice(1, -1) : konst[m[1]] ?? m[1];
      const block = t.slice(m.index, treffer[i + 1]?.index ?? m.index + 3000);
      const b = block.match(/beschreibung: '([^']+)'/);
      liste.push({ id, text: m[2], beschreibung: b?.[1] ?? '', datei: f, block });
    });
  }
  return liste;
}

// ------------------------------------------------------------------ Tabellen (Level 4)
function tabellen() {
  const set = new Set();
  for (const f of [...dateien('server/migrations', /\.sql$/), ...dateien(`${MOD}/server/migrations`, /\.sql$/)]) {
    for (const m of lesen(f).matchAll(/create table (?:if not exists )?([a-z_]+\.[a-z_]+)/gi)) set.add(m[1].toLowerCase());
  }
  return set;
}
const tabCache = new Map();
function tabellenIn(datei, alle, tiefe = 1) {
  const key = `${datei}#${tiefe}`;
  if (tabCache.has(key)) return tabCache.get(key);
  const out = new Set();
  if (!gibt(datei)) return out;
  const t = lesen(datei);
  for (const m of t.matchAll(/\b((?:tco|core)\.[a-z_]+)\b/g)) if (alle.has(m[1])) out.add(m[1]);
  if (tiefe > 0) {
    // eine Ebene relativer Importe aus demselben Ordner (logik.ts, pdf.ts …), nicht über Modulgrenzen
    for (const m of t.matchAll(/from '(\.\/[^']+)\.js'/g)) {
      const ziel = rel(path.resolve(path.dirname(path.join(ROOT, datei)), `${m[1]}.ts`));
      for (const x of tabellenIn(ziel, alle, tiefe - 1)) out.add(x);
    }
  }
  tabCache.set(key, out);
  return out;
}

// ------------------------------------------------------------------ Prozesse prüfen
function routeFinden(alle, angabe) {
  const [methode, pfad] = angabe.split(/\s+/);
  return alle.find((r) => r.methode === methode && (r.pfad === pfad || r.voll === pfad));
}
function prozessePruefen(prozesse, ctx) {
  for (const p of prozesse) {
    for (const [i, s] of p.schritte.entries()) {
      const wo = `${p.id} Schritt ${i + 1} („${s.text}“)`;
      s.status = [];
      if (s.route) {
        const r = routeFinden(ctx.routen, s.route);
        if (!r) fehler.push(`${wo}: Route ${s.route} gibt es im Code nicht (mehr)`);
        else { s.routeInfo = r; s.status.push('Route'); }
      }
      if (s.recht && !ctx.rechte.has(s.recht)) fehler.push(`${wo}: Berechtigung ${s.recht} unbekannt`);
      if (s.app && !ctx.apps.liste.some((a) => a.pfad === s.app) && !ctx.apps.oeffentlich.some((a) => a.pfad === s.app)) {
        fehler.push(`${wo}: App/Seite ${s.app} nicht in der Navigation`);
      }
      if (s.workflow && !ctx.workflows.some((w) => w.name === s.workflow)) fehler.push(`${wo}: n8n-Workflow „${s.workflow}“ fehlt in docs/n8n`);
      if (!ctx.akteure[s.akteur]) fehler.push(`${wo}: Akteur ${s.akteur} nicht in „akteure“`);
      if (!ctx.systeme[s.system]) fehler.push(`${wo}: System ${s.system} nicht in „systeme“`);
    }
  }
}

// ------------------------------------------------------------------ Ausgabe
const KOPF = (titel) => `<!-- Automatisch erzeugt von scripts/landschaft.mjs – nicht von Hand ändern. Quelle der Prozesse: docs/landschaft/prozesse.json -->\n# ${titel}\n\n`;
const KLASSEN = [
  'classDef portal fill:#ffffff,stroke:#1f5fa8,stroke-width:2px,color:#1f5fa8',
  'classDef n8n fill:#ffffff,stroke:#2e7d32,stroke-width:2px,color:#2e7d32',
  'classDef extern fill:#ffffff,stroke:#2a9d8f,stroke-width:2px,color:#1d6f66',
  'classDef person fill:#ffffff,stroke:#7f7f7f,stroke-width:2px,stroke-dasharray:4 3,color:#404040',
];
const klasseVon = (system) => (system === 'portal' ? 'portal' : system === 'n8n' ? 'n8n' : system === 'person' ? 'person' : 'extern');

function level1(ctx) {
  const { liste, oeffentlich } = ctx.apps;
  const bereiche = [...new Set(liste.map((a) => a.bereich))];
  const id = (s) => s.replace(/[^A-Za-z0-9]/g, '');
  const L = ['```mermaid', 'flowchart LR'];
  L.push('  subgraph CLIENT["Endnutzer · Client-Zugang"]', '    BROWSER["Browser"]', '    PHONE["Smartphone"]', `    OEFF["Öffentliche Seiten<br/>${oeffentlich.map((o) => o.pfad).join(' · ')}"]`, '  end');
  L.push('  subgraph STACK["Heimserver · Docker-Stack (Portainer)"]');
  L.push('    subgraph PORTAL["3 · Vereinsportal – Modul tco"]');
  for (const b of bereiche) {
    const apps = liste.filter((a) => a.bereich === b).map((a) => a.app);
    L.push(`      B_${id(b)}["<b>${mm(b)}</b><br/>${apps.map(mm).join('<br/>')}"]`);
  }
  L.push('    end');
  L.push('    AUTH["1 · Anmeldung & Rollen<br/>core.users · Sessions"]');
  L.push('    ANB["2 · Anbindungen<br/>' + ctx.anbindungen.map((a) => mm(a.text)).join('<br/>') + '"]');
  const lauf = ctx.container.map((c) => c.name).filter((n) => !['app'].includes(n));
  L.push(`    RT["5 · Laufzeit<br/>${lauf.join(' · ')}"]`);
  L.push('    N8N["n8n<br/>' + ctx.workflows.map((w) => mm(w.name)).join('<br/>') + '"]');
  L.push('    PL[("Paperless-ngx")]');
  L.push('  end');
  L.push('  subgraph EXT["4 · Vereinssysteme"]', '    EP3[("EP3-bs")]', '    MAIL["Mailserver IMAP/SMTP"]', '    NC["Nextcloud WebDAV"]', '    BANK["Bank (Dateien)"]', '    SAP["SAP (Altsystem)"]', '  end');
  L.push('  subgraph CLOUD["Externe Cloud-Dienste"]', '    OAI["OpenAI API"]', '    LIGA["liga.nu"]', '  end');
  L.push('  BROWSER --> PORTAL', '  PHONE --> PORTAL', '  OEFF --> PORTAL', '  CLIENT -. Anmeldung .-> AUTH', '  AUTH -- trust --- PORTAL');
  L.push('  PORTAL <--> ANB', '  ANB -- Webhooks --> N8N', '  PORTAL -- REST --> PL');
  const kanten = new Set();
  for (const w of ctx.workflows) for (const z of w.ziele) {
    const ziel = { portal: 'PORTAL', paperless: 'PL', openai: 'OAI', ep3: 'EP3', mailserver: 'MAIL' }[z.ziel];
    if (ziel) kanten.add(`  N8N -- "${z.art}" --> ${ziel}`);
  }
  L.push(...kanten, '  PORTAL -- WebDAV --> NC', '  BANK -. CSV / pain.008 .- PORTAL', '  SAP -. ZIP/CSV .-> PORTAL', '  LIGA -. Spielplan .-> PORTAL');
  L.push(...KLASSEN.map((k) => '  ' + k), '  class PORTAL,AUTH,ANB,RT portal', '  class N8N n8n', '  class EP3,MAIL,NC,BANK,SAP,OAI,LIGA,PL extern', '```');

  let s = KOPF('Level 1 – Systemlandschaft');
  s += 'Aufbau wie die SAP-BTP-Referenzarchitektur: ① Anmeldung, ② Anbindungen, ③ Portal mit Fachbereichen, ④ Vereinssysteme hinter der Firewall, ⑤ Laufzeit.\n\n';
  s += L.join('\n') + '\n\n';
  s += '## Bereiche und Apps\n\n| Bereich | App | Pfad | Berechtigung | Zweck |\n|---|---|---|---|---|\n';
  for (const a of liste) s += `| ${md(a.bereich)} | ${md(a.app)} | \`${a.pfad}\` | \`${md(a.recht)}\` | ${md(a.text)} |\n`;
  s += '\n**Öffentliche Seiten (ohne Anmeldung):** ' + oeffentlich.map((o) => `\`${o.pfad}\``).join(', ') + '\n\n';
  s += '## Schnittstellen (n8n-Workflows)\n\n| Workflow | Auslöser | Ziel | Art | Knoten | Detail |\n|---|---|---|---|---|---|\n';
  for (const w of ctx.workflows) {
    const gruppen = new Map();
    for (const z of w.ziele) {
      const k = `${z.ziel}|${z.art}`;
      if (!gruppen.has(k)) gruppen.set(k, { ...z, knoten: [], details: new Set() });
      gruppen.get(k).knoten.push(z.knoten);
      if (z.detail) gruppen.get(k).details.add(z.detail);
    }
    for (const g of gruppen.values()) {
      s += `| ${md(w.name)} | ${md(w.ausloeser.join(', '))} | ${md(ctx.systeme[g.ziel] ?? g.ziel)} | ${g.art} | ${md(g.knoten.join(', '))} | ${md([...g.details].join(', '))} |\n`;
    }
  }
  s += '\n## Anbindungen im Portal (Administration → Anbindungen)\n\n| Kennung | Bezeichnung | n8n-Workflow | Beschreibung | Quelle |\n|---|---|---|---|---|\n';
  for (const a of ctx.anbindungen) s += `| \`${a.id}\` | ${md(a.text)} | ${md(a.workflow ?? '')} | ${md(a.beschreibung)} | \`${a.datei}\` |\n`;
  const ohneWf = ctx.anbindungen.filter((a) => /\(n8n\)/.test(a.text) && !a.workflow);
  if (ohneWf.length) s += `\n> Hinweis: Zu ${ohneWf.map((a) => `„${a.text}“`).join(', ')} liegt kein Workflow-Export in \`docs/n8n\` – die Workflows existieren nur in der n8n-Instanz.\n`;
  s += '\n## Container (docker-compose.yml)\n\n| Dienst | Image | Profil |\n|---|---|---|\n';
  for (const c of ctx.container) s += `| ${c.name} | \`${c.image}\` | ${c.profil || 'immer'} |\n`;
  s += '\n## API-Routen je Ordner\n\n| Ordner | Routen |\n|---|---|\n';
  const jeOrdner = {};
  for (const r of ctx.routen) { const o = r.modul ? r.datei.replace(`${MOD}/server/`, '').split('/')[0].replace(/\.ts$/, '') : `core:${path.basename(r.datei, '.ts')}`; jeOrdner[o] = (jeOrdner[o] ?? 0) + 1; }
  for (const [o, n] of Object.entries(jeOrdner).sort()) s += `| ${o} | ${n} |\n`;
  return s;
}

function prozessDiagramm(p, ctx) {
  const L = ['```mermaid', 'flowchart LR'];
  p.schritte.forEach((st, i) => {
    const ak = ctx.akteure[st.akteur] ?? st.akteur;
    L.push(`  S${i}["${mm(st.text)}<br/><small>${mm(ak)} · ${mm(ctx.systeme[st.system] ?? st.system)}</small>"]:::${klasseVon(st.system)}`);
    if (i) L.push(`  S${i - 1} --> S${i}`);
  });
  L.push(...KLASSEN.map((k) => '  ' + k), '```');
  return L.join('\n');
}
function prozessTabelle(p, ctx) {
  let s = '| # | Schritt | Akteur | System | Route | Recht | App | Workflow |\n|---|---|---|---|---|---|---|---|\n';
  p.schritte.forEach((st, i) => {
    const route = st.routeInfo ? `\`${st.routeInfo.methode} ${st.routeInfo.voll}\`` : st.route ? `⚠️ \`${st.route}\`` : '';
    s += `| ${i + 1} | ${md(st.text)} | ${md(ctx.akteure[st.akteur] ?? st.akteur)} | ${md(ctx.systeme[st.system] ?? st.system)} | ${route} | ${st.recht ? `\`${st.recht}\`` : ''} | ${st.app ? `\`${st.app}\`` : ''} | ${md(st.workflow ?? '')} |\n`;
  });
  return s;
}
function prozessSeite(ebene, titel, einleitung, ctx) {
  const liste = ctx.prozesse.filter((p) => p.ebene === ebene);
  let s = KOPF(titel) + einleitung + '\n\n';
  s += '| ID | Prozess | Bereich | Auslöser | Ergebnis | Schritte |\n|---|---|---|---|---|---|\n';
  for (const p of liste) s += `| ${p.id} | [${md(p.name)}](#${p.id.toLowerCase()}) | ${md(p.bereich)} | ${md(p.ausloeser)} | ${md(p.ergebnis)} | ${p.schritte.length} |\n`;
  for (const p of liste) {
    s += `\n<a id="${p.id.toLowerCase()}"></a>\n## ${p.id} · ${p.name}${p.teil_von ? ` (Teil von ${p.teil_von})` : ''}\n\n`;
    s += `**Auslöser:** ${p.ausloeser} · **Ergebnis:** ${p.ergebnis}\n\n`;
    s += prozessDiagramm(p, ctx) + '\n\n' + prozessTabelle(p, ctx);
  }
  if (ebene === 2) {
    s += '\n## Prozess × App\n\n| App | ' + liste.map((p) => p.id).join(' | ') + ' |\n|---|' + liste.map(() => '---').join('|') + '|\n';
    const appsGenutzt = [...new Set(liste.flatMap((p) => p.schritte.map((x) => x.app).filter(Boolean)))].sort();
    for (const a of appsGenutzt) {
      const name = ctx.apps.liste.find((x) => x.pfad === a)?.app ?? a;
      s += `| ${md(name)} | ` + liste.map((p) => (p.schritte.some((x) => x.app === a) ? '●' : '')).join(' | ') + ' |\n';
    }
  }
  return s;
}

function level4(ctx) {
  let s = KOPF('Level 4 – Datenbankabhängigkeiten');
  s += 'Abgeleitet aus den Quelltexten hinter den Routen jedes Prozessschritts (Routendatei plus direkt importierte Dateien im selben Ordner). ' +
    'Das ist eine Näherung: eine Tabelle steht hier, wenn der Code sie in diesen Dateien nennt.\n\n';
  const prozesse = ctx.prozesse;
  const jeProzess = new Map();
  for (const p of prozesse) {
    const set = new Set();
    for (const st of p.schritte) if (st.routeInfo) for (const t of tabellenIn(st.routeInfo.datei, ctx.tabellen)) set.add(t);
    jeProzess.set(p.id, set);
  }
  const genutzt = [...new Set([...jeProzess.values()].flatMap((x) => [...x]))].sort();
  s += '| Tabelle | ' + prozesse.map((p) => p.id).join(' | ') + ' |\n|---|' + prozesse.map(() => '---').join('|') + '|\n';
  for (const t of genutzt) s += `| \`${t}\` | ` + prozesse.map((p) => (jeProzess.get(p.id).has(t) ? '●' : '')).join(' | ') + ' |\n';
  s += '\n' + prozesse.map((p) => `**${p.id}** ${p.name}`).join(' · ') + '\n';
  const ungenutzt = [...ctx.tabellen].filter((t) => !genutzt.includes(t)).sort();
  s += `\n## Weitere Tabellen (${ungenutzt.length}, von keinem beschriebenen Prozess berührt)\n\n` + ungenutzt.map((t) => `\`${t}\``).join(', ') + '\n';
  return s;
}

function index(ctx) {
  let s = KOPF('System- und Prozesslandschaft TC Oberthal');
  s += 'Mehrstufige Landschaft zu Issue #118. Die Seiten werden aus dem Code erzeugt; nur `prozesse.json` wird von Hand gepflegt.\n\n';
  s += '| Ebene | Inhalt | Seite |\n|---|---|---|\n';
  s += `| 1 | Systeme, Apps (${ctx.apps.liste.length}), Schnittstellen (${ctx.workflows.length} n8n-Workflows, ${ctx.anbindungen.length} Anbindungen), Container (${ctx.container.length}) | [level-1-systeme.md](level-1-systeme.md) |\n`;
  s += `| 2 | Kernprozesse (${ctx.prozesse.filter((p) => p.ebene === 2).length}) mit Schritten, Akteuren, Routen, Rechten | [level-2-prozesse.md](level-2-prozesse.md) |\n`;
  s += `| 3 | Detailprozesse (${ctx.prozesse.filter((p) => p.ebene === 3).length}) | [level-3-details.md](level-3-details.md) |\n`;
  s += `| 4 | Datenbankabhängigkeiten (${ctx.tabellen.size} Tabellen) | [level-4-daten.md](level-4-daten.md) |\n\n`;
  s += '## Aktualisieren\n\n```bash\nnpm run doku:landschaft   # neu erzeugen\nnpm run doku:pruefen      # nur prüfen (CI)\n```\n\n';
  s += 'Der Workflow `.github/workflows/landschaft.yml` prüft jeden Pull Request (kaputte Verweise in `prozesse.json` lassen ihn fehlschlagen) ' +
    'und erzeugt die Seiten nach jedem Push auf `main` neu.\n\n';
  s += '**Neuen Prozess aufnehmen:** Eintrag in `prozesse.json` (ebene 2 oder 3) mit Schritten; je Schritt `akteur`, `system` und – soweit vorhanden – ' +
    '`route` (z. B. `POST /antrag`), `recht`, `app`, `workflow`. Danach `npm run doku:landschaft`.\n\n';
  s += '**Farben** wie im Board: blau = Portal, grün = n8n, petrol = externes System, grau gestrichelt = manuell.\n';
  return s;
}

// ------------------------------------------------------------------ Hauptablauf
const def = JSON.parse(lesen('docs/landschaft/prozesse.json'));
const ctx = {
  container: container(),
  apps: apps(),
  routen: routen(),
  rechte: rechte(),
  workflows: workflows(),
  anbindungen: anbindungen(),
  tabellen: tabellen(),
  akteure: def.akteure,
  systeme: def.systeme,
  prozesse: def.prozesse,
};
for (const a of ctx.anbindungen.filter((x) => /n8n/.test(x.text))) {
  const wf = ctx.workflows.find((w) => w.ausloeser.some((x) => x.startsWith('Webhook') && a.block.includes(x.replace('Webhook /webhook/', ''))))
    ?? ctx.workflows.find((w) => {
      const woerter = (x) => new Set(x.toLowerCase().split(/[^a-z0-9äöü]+/).filter((t) => t.length >= 3 && !['tco', 'n8n', 'portal'].includes(t)));
      const wa = woerter(a.text.replace('E-Mail-Versand', 'Mailversand'));
      return [...woerter(w.name)].some((t) => wa.has(t));
    });
  if (wf) a.workflow = wf.name;
}
prozessePruefen(ctx.prozesse, ctx);

const seiten = {
  'README.md': index(ctx),
  'level-1-systeme.md': level1(ctx),
  'level-2-prozesse.md': prozessSeite(2, 'Level 2 – Prozesslandschaft', 'Kernprozesse von Ende zu Ende. Jeder Verweis ist gegen den Code geprüft (⚠️ = nicht gefunden).', ctx),
  'level-3-details.md': prozessSeite(3, 'Level 3 – Prozessschritte im Detail', 'Wie die Schritte der Prozesse aus Issue #118 ineinandergreifen.', ctx),
  'level-4-daten.md': level4(ctx),
};

let veraltet = [];
for (const [name, inhalt] of Object.entries(seiten)) {
  const ziel = path.join(OUT, name);
  const alt = fs.existsSync(ziel) ? fs.readFileSync(ziel, 'utf8') : null;
  if (alt !== inhalt) veraltet.push(name);
  if (!PRUEFEN) fs.writeFileSync(ziel, inhalt);
}

for (const w of warnungen) console.warn(`Hinweis: ${w}`);
for (const f of fehler) console.error(`::error file=docs/landschaft/prozesse.json::${f}`);
if (PRUEFEN && veraltet.length) {
  const text = `Landschafts-Doku veraltet: ${veraltet.join(', ')} – bitte \`npm run doku:landschaft\` ausführen`;
  console.log(CHECK ? `::error::${text}` : `::warning::${text}`);
}
console.log(`${ctx.apps.liste.length} Apps, ${ctx.routen.length} Routen, ${ctx.workflows.length} Workflows, ${ctx.anbindungen.length} Anbindungen, ` +
  `${ctx.tabellen.size} Tabellen, ${ctx.prozesse.length} Prozesse · ${fehler.length} Fehler · ${PRUEFEN ? (veraltet.length ? 'veraltet' : 'aktuell') : `geschrieben: ${veraltet.length ? veraltet.join(', ') : 'keine Änderung'}`}`);
if (fehler.length || (CHECK && veraltet.length)) process.exit(1);
