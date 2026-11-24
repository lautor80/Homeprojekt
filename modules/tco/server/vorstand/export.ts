/**
 * Import alter Vorstandsprotokolle: Exporte aus Docmost bzw. Joplin vor dem eigentlichen Lesen (markdown.ts) in die dort
 * erkannte Form bringen – reine Logik ohne Datenbank.
 *
 *  - erste Überschrift, die nur ein Datum oder der Dateiname ist („# 2026-08-13“) → kein Tagesordnungspunkt, sondern
 *    „Datum: …“ (der Titel ergibt sich dann aus Art und Datum)
 *  - zweispaltige Tabelle „| Datum | August 13, 2026 |“ → Zeilen „Datum: …“ (leere Werte entfallen)
 *  - aufklappbarer Block „<details><summary>Teilnehmer</summary> - [x] Name … </details>“ → „Teilnehmer:“ mit der
 *    Liste darunter; angekreuzt = anwesend, nicht angekreuzt = entschuldigt
 *  - Überschriften „Informationen“, „Kopfdaten“, „Teilnehmer“ … über solchen Kopfdaten entfallen
 *  - HTML-Tabelle der Tagesordnung (Spalten Nr · Thema · Besprochen · Verantwortlich) → je Zeile ein Tagesordnungspunkt
 *    „**TOP n: Thema**“ mit „Verantwortlich: …“ und dem Text; Absätze mit „Beschluss“/„beschlossen“ werden Beschlüsse,
 *    Bilder werden Anlagen; leere Zeilen und Zwischenüberschriften ohne Inhalt entfallen. Die Überschrift über der
 *    Tabelle („Agenda“, „Tagesordnung“) entfällt dann.
 */
import { datumLesen } from './regeln.js';

const KOPF = /^(informationen|kopfdaten|rahmendaten|allgemeine angaben|eckdaten|teilnehmer(?:innen)?|teilnehmende|anwesenheit)$/i;
const AGENDA = /^(agenda|tagesordnung|tagesordnungspunkte|themen|protokoll)$/i;

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', euro: '€', ndash: '–', mdash: '—', hellip: '…', bdquo: '„', ldquo: '“', rdquo: '”' };
export const entitaeten = (s: string) => s
  .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&([a-z]+);/gi, (a, n: string) => ENT[n.toLowerCase()] ?? a);

/** HTML einer Zelle → Zeilen im Format der Protokolltexte (Absätze, „- “-Aufzählung, **fett**, *kursiv*, Bilder als Verweis) */
export function htmlZuText(html: string): string[] {
  const out: string[] = [];
  let zeile = '';
  let tiefe = 0;
  let inListe = false;
  const weg = () => {
    const t = zeile.replace(/[ \t]+/g, ' ').trim();
    zeile = '';
    if (!t || /^-\s*(?:–\s*)?$/.test(t)) return;
    // Absätze außerhalb von Listen durch Leerzeilen trennen
    if (!t.startsWith('- ') && out.length && out[out.length - 1] !== '') out.push('');
    if (t.startsWith('- ') && out.length && out[out.length - 1] !== '' && !out[out.length - 1].startsWith('- ')) out.push('');
    out.push(t);
  };
  const re = /<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[4] != null) { zeile += entitaeten(m[4]).replace(/\s+/g, ' '); continue; }
    const zu = m[1] === '/', tag = m[2].toLowerCase(), attr = m[3];
    if (tag === 'ul' || tag === 'ol') { weg(); tiefe = Math.max(0, tiefe + (zu ? -1 : 1)); inListe = tiefe > 0; continue; }
    if (tag === 'li') { weg(); if (!zu) zeile = `- ${tiefe > 1 ? '– ' : ''}`; continue; }
    if (tag === 'p' || tag === 'div' || /^h[1-6]$/.test(tag)) {
      // Absatz in einem Listenpunkt gehört zum Punkt
      if (inListe && /^-\s(?:–\s)?$/.test(zeile)) continue;
      weg();
      continue;
    }
    if (tag === 'br') { weg(); continue; }
    if (tag === 'strong' || tag === 'b') { zeile += '**'; continue; }
    if (tag === 'em' || tag === 'i') { zeile += '*'; continue; }
    if (tag === 's' || tag === 'del' || tag === 'strike') { zeile += '~~'; continue; }
    if (tag === 'img') {
      const src = /\ssrc\s*=\s*"([^"]+)"|\ssrc\s*=\s*'([^']+)'/i.exec(attr);
      if (src) { weg(); zeile = `![](${src[1] ?? src[2]})`; weg(); }
    }
  }
  weg();
  // leere Hervorhebungen und Leerzeichen innerhalb von ** ** bereinigen
  return out.map((z) => z.replace(/\*\*\s*\*\*/g, '').replace(/\*\*(\S[^*]*?)\s+\*\*/g, '**$1** ').trimEnd())
    .filter((z, i, a) => z !== '' || (i > 0 && i < a.length - 1 && a[i - 1] !== ''));
}

interface Zelle { html: string; kopf: boolean; spalten: number }
function tabelleLesen(html: string): Zelle[][] {
  const zeilen: Zelle[][] = [];
  for (const tr of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const z: Zelle[] = [];
    for (const td of tr[1].matchAll(/<t([hd])\b([^>]*)>([\s\S]*?)<\/t[hd]>/gi)) {
      const cs = /colspan\s*=\s*"?(\d+)/i.exec(td[2]);
      z.push({ html: td[3], kopf: td[1].toLowerCase() === 'h', spalten: cs ? Math.max(1, Number(cs[1])) : 1 });
    }
    if (z.length) zeilen.push(z);
  }
  return zeilen;
}
const zellText = (html: string) => htmlZuText(html).filter(Boolean).join(' ').replace(/\*\*/g, '').trim();

/**
 * Tagesordnung aus einer HTML-Tabelle; null, wenn keine Spalte „Thema“ erkennbar ist.
 * Zeilen werden zu „**TOP n: Thema**“, „Verantwortlich: …“ und dem Text (Beschlüsse als „Beschluss: …“).
 */
export function agendaAusHtml(html: string, hinweise: string[]): string[] | null {
  const tab = tabelleLesen(html);
  const kopfIdx = tab.findIndex((z) => z.some((c) => c.kopf));
  const kopf = kopfIdx >= 0 ? tab[kopfIdx] : tab[0];
  if (!kopf) return null;
  const namen: string[] = [];
  for (const c of kopf) { const n = zellText(c.html).toLowerCase(); for (let i = 0; i < c.spalten; i++) namen.push(i ? '' : n); }
  const finde = (re: RegExp) => namen.findIndex((n) => re.test(n));
  const thema = finde(/thema|titel|punkt|tagesordnung|gegenstand/);
  if (thema < 0) return null;
  const nr = finde(/^(nr\.?|top|#|nummer|lfd\.?)$/);
  const inhalt = finde(/besprochen|protokoll|inhalt|beschreibung|ergebnis|notiz|bemerkung|diskussion/);
  const wer = finde(/verantwortlich|zuständig|wer\b/);
  const out: string[] = [];
  let n = 0;
  let abschnitt: string | null = null;
  for (const z of tab.slice((kopfIdx >= 0 ? kopfIdx : 0) + 1)) {
    const spalte: string[] = [];
    for (const c of z) { spalte.push(c.html); for (let i = 1; i < c.spalten; i++) spalte.push(''); }
    const titel = zellText(spalte[thema] ?? '');
    const text = inhalt >= 0 ? htmlZuText(spalte[inhalt] ?? '') : [];
    const verantwortlich = wer >= 0 ? zellText(spalte[wer] ?? '') : '';
    // Zwischenüberschrift: eine Zelle über mehrere Spalten (oder nur die Nummernspalte leer) ohne Text
    const ueber = z.find((c) => c.spalten > 1 && zellText(c.html));
    if (ueber && !text.some(Boolean)) { abschnitt = zellText(ueber.html); continue; }
    if (!titel && !text.some(Boolean)) continue;
    if (abschnitt) { hinweise.push(`Zwischenüberschrift „${abschnitt}“ der Tagesordnung nicht übernommen`); abschnitt = null; }
    n++;
    const nummer = nr >= 0 && /^\d+[a-z]?$/i.test(zellText(spalte[nr] ?? '')) ? zellText(spalte[nr] ?? '') : String(n);
    out.push('', `**TOP ${nummer}: ${titel || 'ohne Titel'}**`);
    if (verantwortlich) out.push(`Verantwortlich: ${verantwortlich}`);
    for (const t of text) {
      if (t && !t.startsWith('- ') && !t.startsWith('![') && /\bbeschluss\b|\bbeschlossen\b/i.test(t)) {
        out.push(`Beschluss: ${t.replace(/\*\*/g, '')}${/einstimmig/i.test(t) && !/\(\s*einstimmig\s*\)\s*\.?$/i.test(t) ? ' (einstimmig)' : ''}`);
      } else out.push(t);
    }
  }
  return out;
}

/** zweispaltige Markdown-Tabelle → „Schlüssel: Wert“ (leere Werte entfallen); null = keine solche Tabelle */
function schluesselTabelle(zeilen: string[]): string[] | null {
  const zellen = zeilen.map((z) => z.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  if (!zellen.every((c) => c.length === 2)) return null;
  const out: string[] = [];
  for (const [k, v] of zellen) {
    if (/^:?-{3,}:?$/.test(k) || !k.replace(/\*\*|__/g, '').trim()) continue;
    if (v.replace(/\*\*|__/g, '').trim()) out.push(`${k.replace(/\*\*|__/g, '').trim()}: ${v}`);
  }
  return out;
}

/** Export (Docmost/Joplin) aufbereiten; ohne solche Bestandteile bleibt der Text unverändert */
export function exportAufbereiten(zeilen: string[], datei: string): { zeilen: string[]; hinweise: string[] } {
  const hinweise: string[] = [];
  const stamm = datei.replace(/\.[^.]+$/, '').trim().toLowerCase();
  const out: string[] = [];
  let erste = true;
  for (let i = 0; i < zeilen.length; i++) {
    const z = zeilen[i];
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(z);
    if (h) {
      const t = h[2].replace(/\*\*|__/g, '').trim();
      // erste Überschrift nur Datum bzw. Dateiname
      if (erste && (t.toLowerCase() === stamm || (/^[\d.\-/\s]+$/.test(t) && datumLesen(t)))) { erste = false; out.push(`Datum: ${t}`); continue; }
      erste = false;
      // Abschnitt bis zur nächsten Überschrift
      let ende = i + 1;
      while (ende < zeilen.length && !/^#{1,6}\s/.test(zeilen[ende])) ende++;
      const abschnitt = zeilen.slice(i + 1, ende);
      if (KOPF.test(t) && abschnitt.some((x) => /^\s*\|.*\|\s*$/.test(x) || /<details\b|<summary\b/i.test(x))) continue;
      const html = abschnitt.join('\n');
      if (AGENDA.test(t) && /<table\b/i.test(html)) {
        const vor = html.slice(0, html.search(/<(?:div[^>]*joplin-table|table)\b/i)).trim();
        const tabEnde = html.toLowerCase().lastIndexOf('</table>');
        const nach = tabEnde >= 0 ? html.slice(tabEnde + 8).replace(/^\s*<\/div>/i, '').trim() : '';
        const agenda = agendaAusHtml(html, hinweise);
        if (agenda) {
          if (vor) out.push(vor);
          out.push(...agenda);
          if (nach) out.push('', nach);
          i = ende - 1;
          continue;
        }
      }
      out.push(z);
      continue;
    }
    // zweispaltige Tabelle
    if (/^\s*\|.*\|\s*$/.test(z)) {
      let ende = i;
      while (ende < zeilen.length && /^\s*\|.*\|\s*$/.test(zeilen[ende])) ende++;
      const kv = schluesselTabelle(zeilen.slice(i, ende));
      if (kv) { out.push(...kv); i = ende - 1; continue; }
      out.push(...zeilen.slice(i, ende));
      i = ende - 1;
      continue;
    }
    // aufklappbarer Block
    if (/^\s*<\/?details\b[^>]*>\s*$/i.test(z)) continue;
    const sum = /^\s*<summary>(.*?)<\/summary>\s*$/i.exec(z);
    if (sum) {
      out.push(`${entitaeten(sum[1]).replace(/<[^>]+>/g, '').trim()}:`);
      while (i + 1 < zeilen.length && !zeilen[i + 1].trim()) i++;
      continue;
    }
    out.push(z);
  }
  return { zeilen: out, hinweise };
}
