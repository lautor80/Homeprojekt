/**
 * PowerPoint-Dateien (.pptx) füllen und zusammenstellen – ohne Zusatzpaket, direkt auf dem Office-XML (#146).
 *
 *   Platzhalter    {{name}} in Texten von Folien, Layouts, Mastern (Fußzeile) und Notizen; über mehrere Textläufe
 *                  hinweg (PowerPoint teilt Text beim Tippen auf). Unbekannte Platzhalter bleiben stehen.
 *   Diagramme      Objekt (Name oder Alternativtext) mit {{DIAGRAMM}} bzw. {{DIAGRAMM:SCHLUESSEL}}: Kategorien,
 *                  Reihennamen und Werte werden ersetzt, überzählige Reihen entfernt bzw. zusätzliche angehängt.
 *   Tabellen       Objekt mit {{TABELLE}} bzw. {{TABELLE:SCHLUESSEL}}: Kopfzeile und Zeilen aus den Daten, Format der
 *                  ersten (Kopf) und zweiten Zeile (Daten) der Vorlage.
 *   Folien         klonen (inkl. Diagrammen), entfernen, Reihenfolge – für den Sammelkorb.
 */
import { entpacken, packen } from '../../../../server/src/lib/zip.js';

export type Teile = Map<string, Buffer>;
export interface Diagramm { kategorien: string[]; serien: { name: string; werte: number[] }[] }
export interface Tabelle { kopf: string[]; zeilen: string[][] }

const REL_CHART = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart';
const REL_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const REL_NOTES = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide';
const CT_SLIDE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const CT_CHART = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';

export const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function lesen(buf: Buffer): Teile {
  let e: { name: string; inhalt: Buffer }[];
  try { e = entpacken(buf); } catch { throw new Error('Die Datei ist keine PowerPoint-Datei (.pptx).'); }
  const t: Teile = new Map(e.map((x) => [x.name, x.inhalt]));
  if (!t.has('ppt/presentation.xml') || !t.has('[Content_Types].xml')) throw new Error('Die Datei ist keine PowerPoint-Datei (.pptx).');
  return t;
}

export function schreiben(t: Teile): Buffer {
  const namen = [...t.keys()].sort((a, b) => (a === '[Content_Types].xml' ? -1 : b === '[Content_Types].xml' ? 1 : 0));
  return packen(namen.map((name) => ({ name, inhalt: t.get(name)! })));
}

const txt = (t: Teile, p: string) => t.get(p)?.toString('utf8') ?? '';
const setze = (t: Teile, p: string, s: string) => t.set(p, Buffer.from(s, 'utf8'));
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Teile, in denen Platzhalter ersetzt werden */
const textTeile = (t: Teile) => [...t.keys()].filter((n) => /^ppt\/(slides|slideLayouts|slideMasters|notesSlides)\/[^/]+\.xml$/.test(n));
export const folienPfade = (t: Teile) => reihenfolge(t);

// ---------------------------------------------------------------- Beziehungen

const relsPfad = (p: string) => p.replace(/([^/]+)$/, '_rels/$1.rels');
function ziel(von: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const teile = von.split('/').slice(0, -1);
  for (const s of target.split('/')) { if (s === '..') teile.pop(); else if (s !== '.') teile.push(s); }
  return teile.join('/');
}
interface Rel { id: string; typ: string; ziel: string; target: string }
function rels(t: Teile, p: string): Rel[] {
  const x = txt(t, relsPfad(p));
  return [...x.matchAll(/<Relationship\b([^>]*?)\/?>/g)].map((m) => {
    const a = (n: string) => new RegExp(`\\b${n}="([^"]*)"`).exec(m[1])?.[1] ?? '';
    return { id: a('Id'), typ: a('Type'), target: a('Target'), ziel: a('TargetMode') === 'External' ? '' : ziel(p, a('Target')) };
  });
}

/** Folien in der Reihenfolge der Präsentation */
function reihenfolge(t: Teile): string[] {
  const pr = rels(t, 'ppt/presentation.xml');
  return [...txt(t, 'ppt/presentation.xml').matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)].map((m) => pr.find((r) => r.id === m[1])!.ziel).filter(Boolean);
}

// ---------------------------------------------------------------- Platzhalter

/** Text je Absatz (über alle Textläufe) – für das Auffinden der Platzhalter */
function absatzTexte(xml: string): string[] {
  return [...xml.matchAll(/<a:p>[\s\S]*?<\/a:p>|<a:p [\s\S]*?<\/a:p>/g)].map((m) => unesc([...m[0].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((x) => x[1]).join('')));
}
const objektNamen = (xml: string) => [...xml.matchAll(/<p:cNvPr\b([^>]*)>/g)].flatMap((m) =>
  [/\bname="([^"]*)"/.exec(m[1])?.[1] ?? '', /\bdescr="([^"]*)"/.exec(m[1])?.[1] ?? ''].map(unesc));

/** alle Platzhalter der Datei (Texte und Objektmarker), sortiert, ohne Doppelte */
export function platzhalter(t: Teile): string[] {
  const s = new Set<string>();
  for (const p of textTeile(t)) {
    const x = txt(t, p);
    for (const a of [...absatzTexte(x), ...objektNamen(x)]) for (const m of a.matchAll(TOKEN)) s.add(m[1].trim());
  }
  return [...s].sort((a, b) => a.localeCompare(b, 'de'));
}

/** Platzhalter im Text eines Absatzes ersetzen; mehrzeilige Werte werden zu mehreren Absätzen */
function absatzErsetzen(p0: string, werte: (k: string) => string | undefined): string {
  if (!p0.includes('{{') && !/\{<\/a:t>/.test(p0)) return p0;
  // zuerst je Textlauf (Formatierung je Lauf bleibt, z. B. Wert groß, Einheit klein) – mehrzeilige Werte erst unten
  const p = p0.replace(/<a:t>([^<]*)<\/a:t>/g, (m, x: string) => {
    const t = unesc(x);
    if (!t.includes('{{')) return m;
    const neu = t.replace(TOKEN, (alles, k: string) => { const v = werte(k.trim()); return v === undefined || /\n/.test(v) ? alles : v; });
    return neu === t ? m : `<a:t>${esc(neu)}</a:t>`;
  });
  const ts = [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)];
  if (!ts.length) return p;
  const voll = unesc(ts.map((m) => m[1]).join(''));
  if (!voll.includes('{{')) return p;
  let geaendert = false;
  const neu = voll.replace(TOKEN, (alles, k: string) => { const v = werte(k.trim()); if (v === undefined) return alles; geaendert = true; return v; });
  if (!geaendert) return p;
  const zeilen = neu.split(/\r?\n/);
  return zeilen.map((z) => {
    let erster = true;
    return p.replace(/<a:t>[^<]*<\/a:t>/g, () => { const r = erster ? `<a:t>${esc(z)}</a:t>` : '<a:t></a:t>'; erster = false; return r; });
  }).join('');
}

export function texteErsetzen(xml: string, werte: (k: string) => string | undefined): string {
  return xml.replace(/<a:p>[\s\S]*?<\/a:p>|<a:p [\s\S]*?<\/a:p>/g, (p) => absatzErsetzen(p, werte));
}

// ---------------------------------------------------------------- Diagramme und Tabellen

/** graphicFrame-Blöcke einer Folie mit Marker {{DIAGRAMM…}} / {{TABELLE…}} */
function rahmen(xml: string) {
  return [...xml.matchAll(/<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/g)].map((m) => {
    const marker = objektNamen(m[0]).join(' ');
    const d = /\{\{\s*DIAGRAMM(?::\s*([^}\s]+))?\s*\}\}/.exec(marker);
    const tb = /\{\{\s*TABELLE(?::\s*([^}\s]+))?\s*\}\}/.exec(marker);
    return { xml: m[0], start: m.index!, diagramm: d ? d[1] ?? '' : null, tabelle: tb ? tb[1] ?? '' : null, rid: /<c:chart\b[^>]*\br:id="([^"]+)"/.exec(m[0])?.[1] ?? null };
  });
}

const zahl = (v: number) => (Number.isFinite(v) ? String(Math.round(v * 100) / 100) : '0');
function cache(werte: string[], num: boolean, formatCode = 'General'): string {
  const pts = werte.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join('');
  return num ? `<c:numCache><c:formatCode>${esc(formatCode)}</c:formatCode><c:ptCount val="${werte.length}"/>${pts}</c:numCache>`
    : `<c:strCache><c:ptCount val="${werte.length}"/>${pts}</c:strCache>`;
}

/** Diagramm-XML mit neuen Daten: Reihe i der Vorlage bekommt Reihe i der Daten (Format bleibt), Rest entfernt bzw. angehängt */
export function diagrammFuellen(xml: string, d: Diagramm): string {
  const serien = [...xml.matchAll(/<c:ser>[\s\S]*?<\/c:ser>/g)];
  if (!serien.length) return xml;
  const f = (s: string, tag: string) => /<c:f>([^<]*)<\/c:f>/.exec(/<c:${tag}>[\s\S]*?<\/c:${tag}>/.exec(s)?.[0] ?? '')?.[1];
  const neu = d.serien.map((r, i) => {
    let s = serien[Math.min(i, serien.length - 1)][0];
    s = s.replace(/<c:idx val="\d+"\/>/, `<c:idx val="${i}"/>`).replace(/<c:order val="\d+"\/>/, `<c:order val="${i}"/>`);
    const fTx = f(s, 'tx'), fCat = f(s, 'cat'), fVal = f(s, 'val');
    const format = /<c:formatCode>([^<]*)<\/c:formatCode>/.exec(/<c:val>[\s\S]*?<\/c:val>/.exec(s)?.[0] ?? '')?.[1] ?? 'General';
    s = s.replace(/<c:tx>[\s\S]*?<\/c:tx>/, `<c:tx><c:strRef>${fTx ? `<c:f>${fTx}</c:f>` : ''}${cache([r.name], false)}</c:strRef></c:tx>`);
    s = s.replace(/<c:cat>[\s\S]*?<\/c:cat>/, `<c:cat><c:strRef>${fCat ? `<c:f>${fCat}</c:f>` : ''}${cache(d.kategorien, false)}</c:strRef></c:cat>`);
    s = s.replace(/<c:val>[\s\S]*?<\/c:val>/, `<c:val><c:numRef>${fVal ? `<c:f>${fVal}</c:f>` : ''}${cache(r.werte.map(zahl), true, format)}</c:numRef></c:val>`);
    // zusätzliche Reihe ohne eigene Vorlage: Farbe aus dem Design (Akzent i+1)
    if (i >= serien.length) s = s.replace(/<c:spPr>[\s\S]*?<\/c:spPr>/, `<c:spPr><a:solidFill><a:schemeClr val="accent${(i % 6) + 1}"/></a:solidFill><a:ln w="28575"><a:solidFill><a:schemeClr val="accent${(i % 6) + 1}"/></a:solidFill></a:ln></c:spPr>`);
    return s;
  }).join('');
  const erste = serien[0].index!;
  const letzte = serien[serien.length - 1];
  const ende = letzte.index! + letzte[0].length;
  // nur die Reihen eines Diagrammtyps (der erste Block) ersetzen; dazwischenliegende Elemente bleiben
  let out = xml.slice(0, erste) + neu + xml.slice(ende);
  // eingebettete Tabelle hätte die alten Werte – ohne Verknüpfung zeigt PowerPoint die neuen Werte
  out = out.replace(/<c:externalData\b[^>]*\/>|<c:externalData\b[^>]*>[\s\S]*?<\/c:externalData>/, '');
  return out;
}

/** Zelle mit neuem Text (Format des ersten Textlaufs bzw. des Absatzendes bleibt) */
function zelle(tc: string, text: string): string {
  const p = /<a:p>[\s\S]*?<\/a:p>|<a:p [\s\S]*?<\/a:p>/.exec(tc)?.[0] ?? '<a:p></a:p>';
  const ppr = /<a:pPr\b[^>]*\/>|<a:pPr\b[^>]*>[\s\S]*?<\/a:pPr>/.exec(p)?.[0] ?? '';
  const rpr = /<a:rPr\b[^>]*\/>|<a:rPr\b[^>]*>[\s\S]*?<\/a:rPr>/.exec(p)?.[0]
    ?? (/<a:endParaRPr\b([^>]*?)(\/>|>([\s\S]*?)<\/a:endParaRPr>)/.exec(p)?.[0].replace(/endParaRPr/g, 'rPr') ?? '');
  const neuP = `<a:p>${ppr}<a:r>${rpr}<a:t>${esc(text)}</a:t></a:r></a:p>`;
  return tc.replace(/(<a:txBody>[\s\S]*?)(<a:p>[\s\S]*<\/a:p>|<a:p [\s\S]*<\/a:p>)([\s\S]*?<\/a:txBody>)/, (_m, a, _b, c) => `${a}${neuP}${c}`);
}
function zeile(tr: string, werte: string[]): string {
  const tcs = [...tr.matchAll(/<a:tc\b[^>]*>[\s\S]*?<\/a:tc>/g)].map((m) => m[0]);
  const kopf = /^<a:tr\b[^>]*>/.exec(tr)![0];
  return `${kopf}${werte.map((w, i) => zelle(tcs[Math.min(i, tcs.length - 1)], w)).join('')}</a:tr>`;
}
/** Tabelle (a:tbl) aus Daten: Spaltenbreite gleichmäßig über die bisherige Gesamtbreite */
export function tabelleFuellen(rahmenXml: string, d: Tabelle, maxZeilen = 14): string {
  const spalten = Math.max(1, d.kopf.length);
  const breiten = [...rahmenXml.matchAll(/<a:gridCol w="(\d+)"/g)].map((m) => Number(m[1]));
  const gesamt = breiten.reduce((s, w) => s + w, 0) || 9144000;
  const trs = [...rahmenXml.matchAll(/<a:tr\b[^>]*>[\s\S]*?<\/a:tr>/g)].map((m) => m[0]);
  if (!trs.length) return rahmenXml;
  const kopfTr = trs[0], datenTr = trs[1] ?? trs[0];
  const zeilen = d.zeilen.length > maxZeilen ? [...d.zeilen.slice(0, maxZeilen - 1), [`… und ${d.zeilen.length - maxZeilen + 1} weitere`]] : d.zeilen;
  const grid = `<a:tblGrid>${Array.from({ length: spalten }, () => `<a:gridCol w="${Math.floor(gesamt / spalten)}"/>`).join('')}</a:tblGrid>`;
  const rows = [zeile(kopfTr, d.kopf), ...zeilen.map((z) => zeile(datenTr, Array.from({ length: spalten }, (_x, i) => z[i] ?? '')))].join('');
  return rahmenXml.replace(/<a:tblGrid>[\s\S]*?<\/a:tblGrid>/, grid).replace(/(<a:tblGrid>[\s\S]*?<\/a:tblGrid>)[\s\S]*(<\/a:tbl>)/, `$1${rows}$2`);
}

export interface Fuellung {
  werte: (k: string) => string | undefined;
  diagramm?: (schluessel: string) => Diagramm | undefined;
  tabelle?: (schluessel: string) => Tabelle | undefined;
}

/** Diagramme und Tabellen einer Folie füllen (Schlüssel leer = Marker ohne Schlüssel) */
function folieObjekte(t: Teile, folie: string, f: Fuellung): void {
  let xml = txt(t, folie);
  const r = rels(t, folie);
  for (const g of rahmen(xml).reverse()) {
    if (g.diagramm !== null && g.rid && f.diagramm) {
      const d = f.diagramm(g.diagramm);
      const ch = r.find((x) => x.id === g.rid && x.typ === REL_CHART)?.ziel;
      if (d && ch && t.has(ch)) setze(t, ch, diagrammFuellen(txt(t, ch), d));
    }
    if (g.tabelle !== null && f.tabelle) {
      const d = f.tabelle(g.tabelle);
      if (d) xml = xml.slice(0, g.start) + tabelleFuellen(g.xml, d) + xml.slice(g.start + g.xml.length);
    }
  }
  setze(t, folie, xml);
}

/** ganze Datei füllen: Objekte aller Folien, dann Platzhalter in allen Texten */
export function fuellen(t: Teile, f: Fuellung, nurFolie?: string): void {
  for (const folie of nurFolie ? [nurFolie] : reihenfolge(t)) folieObjekte(t, folie, f);
  for (const p of nurFolie ? [nurFolie] : textTeile(t)) setze(t, p, texteErsetzen(txt(t, p), f.werte));
}

/** Formen (p:sp) einer Folie entfernen, deren Name mit einem der Präfixe beginnt (z. B. leere Kacheln) */
export function formenEntfernen(t: Teile, folie: string, praefixe: string[]): void {
  if (!praefixe.length) return;
  setze(t, folie, txt(t, folie).replace(/<p:sp>[\s\S]*?<\/p:sp>/g, (sp) => {
    const name = unesc(/<p:cNvPr\b[^>]*\bname="([^"]*)"/.exec(sp)?.[1] ?? '');
    return praefixe.some((p) => name === p || name.startsWith(`${p} `)) ? '' : sp;
  }));
}

/** Breite (EMU) der Diagramm-/Tabellenrahmen einer Folie setzen, z. B. ohne Kommentarspalte auf volle Breite */
export function rahmenBreite(t: Teile, folie: string, cx: number): void {
  setze(t, folie, txt(t, folie).replace(/<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/g, (g) =>
    /\{\{\s*DIAGRAMM/.test(objektNamen(g).join(' ')) ? g.replace(/(<p:xfrm>\s*<a:off\b[^>]*\/>\s*<a:ext\b[^>]*\bcx=")\d+(")/, `$1${Math.round(cx)}$2`) : g));
}

// ---------------------------------------------------------------- Folien klonen / entfernen / ordnen

function naechste(t: Teile, prefix: string, ext: string): { pfad: string; nr: number } {
  let nr = 1;
  while (t.has(`${prefix}${nr}${ext}`)) nr++;
  return { pfad: `${prefix}${nr}${ext}`, nr };
}
function contentType(t: Teile, pfad: string, typ: string): void {
  const ct = txt(t, '[Content_Types].xml');
  if (ct.includes(`PartName="/${pfad}"`)) return;
  setze(t, '[Content_Types].xml', ct.replace('</Types>', `<Override PartName="/${pfad}" ContentType="${typ}"/></Types>`));
}
function contentTypeWeg(t: Teile, pfad: string): void {
  setze(t, '[Content_Types].xml', txt(t, '[Content_Types].xml').replace(new RegExp(`<Override PartName="/${pfad.replace(/[.[\]]/g, '\\$&')}"[^>]*/>`), ''));
}
function neueRelId(xml: string): string {
  let n = 1;
  while (xml.includes(`Id="rId${n}"`)) n++;
  return `rId${n}`;
}

/** Folie kopieren (mit eigenen Diagramm-Teilen, ohne Notizen) und hinten anfügen; liefert den Pfad der neuen Folie */
export function folieKlonen(t: Teile, quelle: string): string {
  const { pfad, nr } = naechste(t, 'ppt/slides/slide', '.xml');
  setze(t, pfad, txt(t, quelle));
  let relXml = txt(t, relsPfad(quelle));
  for (const r of rels(t, quelle)) {
    if (r.typ === REL_NOTES) {
      relXml = relXml.replace(new RegExp(`<Relationship\\b[^>]*\\bId="${r.id}"[^>]*/>`), '');
    } else if (r.typ === REL_CHART && t.has(r.ziel)) {
      const c = naechste(t, 'ppt/charts/chart', '.xml');
      setze(t, c.pfad, txt(t, r.ziel));
      if (t.has(relsPfad(r.ziel))) setze(t, relsPfad(c.pfad), txt(t, relsPfad(r.ziel)).replace(/<Relationship\b[^>]*\/package"[^>]*\/>/g, ''));
      contentType(t, c.pfad, CT_CHART);
      relXml = relXml.replace(new RegExp(`(<Relationship\\b[^>]*\\bId="${r.id}"[^>]*\\bTarget=")[^"]*(")`), `$1/${c.pfad}$2`)
        .replace(new RegExp(`(<Relationship\\b[^>]*\\bTarget=")[^"]*("[^>]*\\bId="${r.id}")`), `$1/${c.pfad}$2`);
    }
  }
  setze(t, relsPfad(pfad), relXml);
  contentType(t, pfad, CT_SLIDE);
  // in die Präsentation aufnehmen
  const prRels = txt(t, 'ppt/_rels/presentation.xml.rels');
  const rid = neueRelId(prRels);
  setze(t, 'ppt/_rels/presentation.xml.rels', prRels.replace('</Relationships>', `<Relationship Id="${rid}" Type="${REL_SLIDE}" Target="slides/slide${nr}.xml"/></Relationships>`));
  const pr = txt(t, 'ppt/presentation.xml');
  const ids = [...pr.matchAll(/<p:sldId\b[^>]*\bid="(\d+)"/g)].map((m) => Number(m[1]));
  const id = Math.max(255, ...ids) + 1;
  setze(t, 'ppt/presentation.xml', pr.replace('</p:sldIdLst>', `<p:sldId id="${id}" r:id="${rid}"/></p:sldIdLst>`));
  return pfad;
}

/** Folie mit Notizen und eigenen Diagrammen entfernen */
export function folieEntfernen(t: Teile, folie: string): void {
  const prRels = rels(t, 'ppt/presentation.xml');
  const r = prRels.find((x) => x.ziel === folie);
  if (r) {
    setze(t, 'ppt/presentation.xml', txt(t, 'ppt/presentation.xml').replace(new RegExp(`<p:sldId\\b[^>]*\\br:id="${r.id}"[^>]*/>`), ''));
    setze(t, 'ppt/_rels/presentation.xml.rels', txt(t, 'ppt/_rels/presentation.xml.rels').replace(new RegExp(`<Relationship\\b[^>]*\\bId="${r.id}"[^>]*/>`), ''));
  }
  const andere = [...t.keys()].filter((k) => /^ppt\/slides\/_rels\/.*\.rels$/.test(k) && k !== relsPfad(folie)).map((k) => txt(t, k)).join('');
  for (const x of rels(t, folie)) {
    const name = x.ziel.split('/').pop()!;
    if (x.typ === REL_NOTES || (x.typ === REL_CHART && !andere.includes(`/${name}"`) && !andere.includes(`charts/${name}"`))) {
      // eingebettete Tabellen des Diagramms mit entfernen, wenn kein anderes Diagramm sie nutzt
      if (x.typ === REL_CHART) {
        const sonst = [...t.keys()].filter((k) => /^ppt\/charts\/_rels\/.*\.rels$/.test(k) && k !== relsPfad(x.ziel)).map((k) => txt(t, k)).join('');
        for (const e of rels(t, x.ziel)) if (e.ziel && e.ziel.startsWith('ppt/embeddings/') && !sonst.includes(e.ziel.split('/').pop()!)) t.delete(e.ziel);
      }
      t.delete(x.ziel); t.delete(relsPfad(x.ziel)); contentTypeWeg(t, x.ziel);
    }
  }
  t.delete(folie); t.delete(relsPfad(folie)); contentTypeWeg(t, folie);
}

/** Folien neu ordnen (Pfade in gewünschter Reihenfolge; nicht genannte bleiben am Ende) */
export function ordnen(t: Teile, folien: string[]): void {
  const pr = txt(t, 'ppt/presentation.xml');
  const prRels = rels(t, 'ppt/presentation.xml');
  const eintraege = [...pr.matchAll(/<p:sldId\b[^>]*\/>/g)].map((m) => ({ xml: m[0], ziel: prRels.find((r) => r.id === /r:id="([^"]+)"/.exec(m[0])![1])?.ziel ?? '' }));
  const sortiert = [...folien.map((f) => eintraege.find((e) => e.ziel === f)!).filter(Boolean), ...eintraege.filter((e) => !folien.includes(e.ziel))];
  setze(t, 'ppt/presentation.xml', pr.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, `<p:sldIdLst>${sortiert.map((e) => e.xml).join('')}</p:sldIdLst>`));
}
