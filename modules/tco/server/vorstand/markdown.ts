/**
 * Import alter Vorstandsprotokolle aus Markdown – reine Logik ohne Datenbank.
 *
 * Erkannt wird (alles optional, die Datei bleibt zusätzlich als Anlage erhalten):
 *  - Kopfdaten im Front-Matter (--- … ---) oder als Zeilen „Schlüssel: Wert“ vor dem ersten Tagesordnungspunkt:
 *    Datum, Ort, Beginn/Ende/Zeit, Anwesend, Entschuldigt, Gäste, Protokoll, Leitung, Titel, Art
 *    (Listen auch als YAML-Liste „- Name“ darunter); das Datum sonst aus Titel oder Dateiname
 *  - Titel = erste Überschrift der Stufe 1 (wenn es mehrere gibt, sind sie die Tagesordnungspunkte)
 *  - Tagesordnungspunkte = Überschriften der obersten Stufe darunter („## TOP 3 Titel“, „## 3. Titel“, „## Titel“)
 *    oder Absätze „**TOP 3: Titel**“; tiefere Überschriften bleiben Text
 *  - Beschluss: Zeile „Beschluss: …“ (auch fett, als Aufzählung, „Beschluss Nr. 12: …“); die Abstimmung steht in
 *    derselben Zeile („(6/0/0)“, „einstimmig“) oder darunter („Abstimmung: 5 Ja, 0 Nein, 1 Enthaltung“)
 *  - Aufgabe: „- [ ] Text @Wer bis 10.12.“ („- [x]“ = erledigt) oder „Aufgabe: …“ / „ToDo: …“; „(Wer, bis …)“ geht auch
 *  - Anlagen: Verweise auf Dateien „[Name](anlagen/datei.pdf)“ bzw. Bilder – im ZIP werden sie am Dateinamen gefunden
 *  - Exporte aus Docmost/Joplin (Schlüssel/Wert-Tabelle, Teilnehmer als Ankreuzliste in <details>, Tagesordnung als
 *    HTML-Tabelle) werden vorher in diese Form gebracht (export.ts)
 */
import { abstimmungLesen, datumLesen, namenLesen, zeitenLesen, type Ergebnis } from './regeln.js';
import { exportAufbereiten } from './export.js';

export interface MdEintrag {
  art: 'BESCHLUSS' | 'AUFGABE' | 'INFO';
  text: string;
  ja?: number | null; nein?: number | null; enthaltung?: number | null; ergebnis?: Ergebnis | null;
  verantwortlich?: string | null; faellig?: string | null; erledigt?: boolean;
}
export interface MdTop { titel: string; text: string; verantwortlich: string | null; eintraege: MdEintrag[]; anlagen: string[] }
export interface MdProtokoll {
  datei: string;
  titel: string | null;
  art: 'VORSTAND' | 'ERWEITERT';
  datum: string | null;
  beginn: string | null; ende: string | null; ort: string | null;
  leitung: string | null; protokoll: string | null;
  anwesend: string[]; entschuldigt: string[]; gaeste: string[];
  bemerkung: string;
  tops: MdTop[];
  /** Anlagen, auf die vor dem ersten Tagesordnungspunkt verwiesen wird */
  anlagen: string[];
  hinweise: string[];
}

type Feld = 'datum' | 'ort' | 'beginn' | 'ende' | 'zeit' | 'anwesend' | 'entschuldigt' | 'gaeste' | 'protokoll' | 'leitung' | 'titel' | 'art';
const FELDER: Record<string, Feld> = {
  datum: 'datum', termin: 'datum', sitzungsdatum: 'datum', tag: 'datum',
  ort: 'ort', sitzungsort: 'ort', raum: 'ort',
  beginn: 'beginn', start: 'beginn', anfang: 'beginn', ende: 'ende', schluss: 'ende', zeit: 'zeit', uhrzeit: 'zeit',
  anwesend: 'anwesend', anwesende: 'anwesend', teilnehmer: 'anwesend', teilnehmende: 'anwesend',
  entschuldigt: 'entschuldigt', abwesend: 'entschuldigt', fehlend: 'entschuldigt', 'es fehlten': 'entschuldigt', 'nicht anwesend': 'entschuldigt',
  gaeste: 'gaeste', 'gäste': 'gaeste', gast: 'gaeste',
  protokoll: 'protokoll', verantwortlich: 'protokoll', protokollfuehrer: 'protokoll', 'protokollführer': 'protokoll', 'protokollführung': 'protokoll', schriftfuehrer: 'protokoll', 'schriftführer': 'protokoll',
  leitung: 'leitung', sitzungsleitung: 'leitung', vorsitz: 'leitung', versammlungsleitung: 'leitung',
  titel: 'titel', title: 'titel', art: 'art', sitzung: 'art',
};
const LISTEN: Feld[] = ['anwesend', 'entschuldigt', 'gaeste'];

/** Hervorhebungen und Aufzählungszeichen am Zeilenanfang entfernen */
const schlicht = (z: string) => z.replace(/^\s*(?:[-*+]\s+(?!\[)|>\s*)/, '').replace(/\*\*|__/g, '').trim();
const basis = (p: string) => decodeURIComponent(p.split(/[?#]/)[0]).split(/[\\/]/).pop() ?? p;

/** Verweise auf Dateien: Bezeichnung im Text, Dateiname in die Liste */
function verweise(z: string, anlagen: string[]): string {
  return z.replace(/!?\[([^\]]*)\]\(<?([^)>\s]+)>?(?:\s+"[^"]*")?\)/g, (alles, text: string, ziel: string) => {
    if (/^(https?:|mailto:|#)/i.test(ziel)) return alles;
    const name = basis(ziel);
    if (name && !anlagen.includes(name)) anlagen.push(name);
    // Bild ohne Beschreibung: nur Anlage, kein Text
    return text || (alles.startsWith('!') ? '' : name);
  });
}

function topTitel(s: string): string {
  return s.replace(/\*\*|__/g, '').replace(/^TOP\s*\d+[a-z]?\s*[:.)–—-]?\s*/i, '').replace(/^\d+(?:\.\d+)*[.)]?\s+/, '').replace(/\s*#+\s*$/, '').trim();
}

/** Aufgabe aus einer Zeile: Text, @Wer bzw. „(Wer, bis …)“, „bis 10.12.“ */
export function aufgabeLesen(roh: string, bezug: string | null): MdEintrag {
  let t = roh.trim(), verantwortlich: string | null = null, faellig: string | null = null;
  // „(Wer, bis …)“
  const kl = /\(\s*([^(),]+?)\s*,\s*((?:bis|fällig|faellig)\b[^()]*)\)/i.exec(t);
  if (kl) { verantwortlich = kl[1].trim(); t = `${t.slice(0, kl.index)} ${kl[2]} ${t.slice(kl.index + kl[0].length)}`.trim(); }
  const bis = /\(?\s*\b(?:bis|fällig|faellig|termin)\b(?:\s+(?:zum|spätestens))?\s*:?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}\.\s?\d{1,2}\.(?:\s?\d{2,4})?)\s*\)?/i.exec(t);
  if (bis) { faellig = datumLesen(bis[1], bezug); t = (t.slice(0, bis.index) + ' ' + t.slice(bis.index + bis[0].length)).trim(); }
  const at = verantwortlich ? null : /@([\p{L}][\p{L}.'’-]*(?:\s(?=[\p{Lu}])[\p{L}][\p{L}'’-]*)?)/u.exec(t);
  if (at) { verantwortlich = at[1].replace(/[.,;:]+$/, ''); t = (t.slice(0, at.index) + t.slice(at.index + at[0].length)).trim(); }
  if (!verantwortlich) {
    const wer = /(?:→|->|\bverantwortlich\s*:)\s*([^,;()]+)$/i.exec(t) ?? /\(([^()]+)\)\s*$/.exec(t);
    if (wer && wer[1].trim().split(/\s+/).length <= 3) { verantwortlich = wer[1].trim().replace(/[.,;:]+$/, ''); t = t.slice(0, wer.index).trim(); }
  }
  t = t.replace(/\(\s*[,;]?\s*\)/g, '').replace(/\s{2,}/g, ' ').replace(/[\s,;:–-]+$/, '').trim();
  return { art: 'AUFGABE', text: t || roh.trim(), verantwortlich, faellig };
}

/** Text einer Beschlusszeile ohne eingebettete Abstimmung in Klammern */
function beschlussLesen(roh: string): MdEintrag {
  let text = roh.trim();
  let a = null as ReturnType<typeof abstimmungLesen>;
  const kl = /\(([^()]*)\)\s*\.?$/.exec(text);
  if (kl) { a = abstimmungLesen(kl[1]); if (a) text = text.slice(0, kl.index).trim(); }
  if (!a) {
    const nach = /[.;,–-]\s*((?:abstimmung|ergebnis)?\s*:?\s*(?:einstimmig|\d+\s*[/:]\s*\d+\s*[/:]\s*\d+|\d+\s*ja\b.*)[^.]*)\.?$/i.exec(text);
    if (nach) { a = abstimmungLesen(nach[1]); if (a) text = text.slice(0, nach.index + 1).trim(); }
  }
  return { art: 'BESCHLUSS', text, ja: a?.ja ?? null, nein: a?.nein ?? null, enthaltung: a?.enthaltung ?? null, ergebnis: a?.ergebnis ?? null };
}

export function markdownLesen(inhalt: string, datei: string): MdProtokoll {
  const p: MdProtokoll = {
    datei, titel: null, art: 'VORSTAND', datum: null, beginn: null, ende: null, ort: null, leitung: null, protokoll: null,
    anwesend: [], entschuldigt: [], gaeste: [], bemerkung: '', tops: [], anlagen: [], hinweise: [],
  };
  let zeilen = inhalt.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const roh: Partial<Record<Feld, string[]>> = {};
  const setzen = (f: Feld, wert: string) => { (roh[f] ??= []).push(wert); };

  // ---- Front-Matter
  if (zeilen[0]?.trim() === '---') {
    const ende = zeilen.findIndex((z, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(z));
    if (ende > 0) {
      let liste: Feld | null = null;
      for (const z of zeilen.slice(1, ende)) {
        const punkt = /^\s+-\s+(.*)$/.exec(z) ?? (liste ? /^-\s+(.*)$/.exec(z) : null);
        if (punkt && liste) { setzen(liste, punkt[1].replace(/^["']|["']$/g, '')); continue; }
        const m = /^([\p{L} ]+?)\s*:\s*(.*)$/u.exec(z);
        liste = null;
        if (!m) continue;
        const f = FELDER[m[1].trim().toLowerCase()];
        if (!f) continue;
        const wert = m[2].trim().replace(/^\[(.*)\]$/, '$1').replace(/^["']|["']$/g, '');
        if (wert) setzen(f, wert); else liste = f;
      }
      zeilen = zeilen.slice(ende + 1);
    }
  }

  // ---- Exporte aus Docmost/Joplin aufbereiten
  const aufb = exportAufbereiten(zeilen, datei);
  zeilen = aufb.zeilen;
  p.hinweise.push(...aufb.hinweise);

  // ---- Überschriften: Titel (erste H1, wenn es nur eine gibt) und Stufe der Tagesordnungspunkte
  const ueber = zeilen.map((z) => /^(#{1,6})\s+(.*)$/.exec(z)).map((m) => (m ? { stufe: m[1].length, text: m[2].trim() } : null));
  const h1 = ueber.filter((u) => u?.stufe === 1).length;
  let titelZeile = -1;
  if (h1 === 1) titelZeile = ueber.findIndex((u) => u?.stufe === 1);
  const stufen = ueber.filter((u, i) => u && i !== titelZeile).map((u) => u!.stufe);
  const topStufe = stufen.length ? Math.min(...stufen) : 0;
  if (titelZeile >= 0) p.titel = ueber[titelZeile]!.text.replace(/\*\*|__/g, '').trim();

  // ---- Durchlauf
  let top: MdTop | null = null;
  const vorTop: string[] = [];
  let letzterBeschluss: MdEintrag | null = null;
  let offenerBeschluss: MdEintrag | null = null;   // „Beschluss:“ ohne Text – der Text folgt in den nächsten Zeilen
  let liste: Feld | null = null;
  /** Aufgaben: Fälligkeit ohne Jahr erst mit dem Sitzungsdatum auflösen (steht ggf. erst am Ende fest) */
  const aufgabenRoh: { e: MdEintrag; roh: string }[] = [];
  const text = (z: string) => { if (top) top.text += (top.text ? '\n' : '') + z; else vorTop.push(z); };

  for (let i = 0; i < zeilen.length; i++) {
    if (i === titelZeile) continue;
    const zeile = zeilen[i];
    const u = ueber[i];
    const fettTop = /^\s*(?:\*\*|__)\s*(TOP\s*\d+[a-z]?\b.*?)(?:\*\*|__)\s*$/i.exec(zeile) ?? /^\s*(TOP\s*\d+[a-z]?\s*[:.)–—-]\s*\S.*)$/i.exec(zeile);
    if ((u && u.stufe === topStufe) || fettTop) {
      const t = topTitel(u ? u.text : fettTop![1]);
      top = { titel: t || `TOP ${p.tops.length + 1}`, text: '', verantwortlich: null, eintraege: [], anlagen: [] };
      p.tops.push(top);
      letzterBeschluss = offenerBeschluss = null; liste = null;
      continue;
    }
    if (u) { text(`**${u.text.replace(/\*\*|__/g, '')}**`); continue; }

    const anlagen = top ? top.anlagen : p.anlagen;
    const z = verweise(zeile, anlagen);
    const s = schlicht(z);

    if (!s) { offenerBeschluss = null; liste = null; if (top?.text) text(''); continue; }

    // Kopfdaten (nur vor dem ersten Tagesordnungspunkt)
    if (!top) {
      const punkt = /^\s*[-*+]\s+(.*)$/.exec(z);
      if (punkt && liste) {
        // Ankreuzliste der Teilnehmer: angekreuzt = anwesend, sonst entschuldigt
        const kreuz = liste === 'anwesend' ? /^\[([ xX])\]\s+(.*)$/.exec(punkt[1]) : null;
        if (kreuz) setzen(kreuz[1] === ' ' ? 'entschuldigt' : 'anwesend', kreuz[2].replace(/\*\*|__/g, '').trim());
        else setzen(liste, punkt[1].replace(/\*\*|__/g, '').trim());
        continue;
      }
      const m = /^([\p{L} ]{2,30}?)\s*:\s*(.*)$/u.exec(s);
      const f = m ? FELDER[m[1].trim().toLowerCase()] : undefined;
      if (m && f) {
        liste = null;
        if (m[2].trim()) setzen(f, m[2].trim()); else if (LISTEN.includes(f)) liste = f;
        continue;
      }
      liste = null;
    }

    // Beschluss
    const b = /^Beschluss(?:\s*(?:Nr\.?|Nummer)?\s*[A-Z]{0,3}\s*\d[\w/.-]*)?\s*:\s*(.*)$/i.exec(s);
    if (b && top) {
      const e = beschlussLesen(b[1]);
      top.eintraege.push(e);
      letzterBeschluss = e;
      offenerBeschluss = b[1].trim() ? null : e;
      continue;
    }
    const ab = /^(?:Abstimmung|Abstimmungsergebnis|Ergebnis|Abgestimmt)\s*:\s*(.*)$/i.exec(s);
    if (ab && letzterBeschluss) {
      const a = abstimmungLesen(ab[1]);
      if (a) { Object.assign(letzterBeschluss, a); offenerBeschluss = null; continue; }
    }
    if (offenerBeschluss) {
      offenerBeschluss.text += (offenerBeschluss.text ? ' ' : '') + s;
      const a = abstimmungLesen(s);
      if (a && /\d\s*[/:]\s*\d|einstimmig/i.test(s)) Object.assign(offenerBeschluss, beschlussLesen(offenerBeschluss.text), { art: 'BESCHLUSS' });
      continue;
    }

    // Aufgabe
    const cb = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(z);
    const auf = cb ? null : /^(?:Aufgabe|To-?Do|Todo|Erledigung|Maßnahme)\s*:\s*(.*)$/i.exec(s);
    if ((cb || auf) && top) {
      const r = (cb ? cb[2] : auf![1]).replace(/\*\*|__/g, '');
      const e = aufgabeLesen(r, null);
      if (cb) e.erledigt = cb[1].toLowerCase() === 'x';
      top.eintraege.push(e);
      aufgabenRoh.push({ e, roh: r });
      continue;
    }
    // Info
    const info = /^(?:Info|Information|Hinweis)\s*:\s*(.*)$/i.exec(s);
    if (info && top && info[1].trim()) { top.eintraege.push({ art: 'INFO', text: info[1].trim() }); continue; }
    // Verantwortlich/Bericht am Tagesordnungspunkt
    const ber = /^(?:Bericht|Berichterstatter|Verantwortlich|Referent)\s*:\s*(.+)$/i.exec(s);
    if (ber && top && !top.verantwortlich && !top.text) { top.verantwortlich = ber[1].trim(); continue; }

    text(z.trimEnd());
  }
  for (const t of p.tops) t.text = t.text.replace(/\n{3,}/g, '\n\n').trim();

  // ---- Kopfdaten zusammenführen
  const erst = (f: Feld) => (roh[f] ?? []).map((x) => x.trim()).find(Boolean) ?? null;
  p.titel = erst('titel') ?? p.titel;
  if (/erweitert/i.test(erst('art') ?? '') || /erweitert/i.test(p.titel ?? '')) p.art = 'ERWEITERT';
  p.datum = datumLesen(erst('datum') ?? '') ?? datumLesen(p.titel ?? '') ?? datumLesen(datei.replace(/_/g, ' '));
  if (!p.datum) p.hinweise.push('Datum nicht erkannt');
  const zeit = zeitenLesen([erst('zeit'), erst('datum')].filter(Boolean).join(' '));
  p.beginn = zeitenLesen(erst('beginn') ?? '').beginn ?? zeit.beginn;
  p.ende = zeitenLesen(erst('ende') ?? '').beginn ?? zeit.ende;
  p.ort = erst('ort');
  p.leitung = erst('leitung');
  p.protokoll = erst('protokoll');
  for (const f of LISTEN) p[f as 'anwesend'] = (roh[f] ?? []).flatMap(namenLesen);
  p.bemerkung = vorTop.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!p.tops.length) {
    p.hinweise.push('Keine Tagesordnungspunkte erkannt – der Text wird als ein Punkt übernommen');
    p.tops.push({ titel: 'Protokoll', text: p.bemerkung, verantwortlich: null, eintraege: [], anlagen: [...p.anlagen] });
    p.bemerkung = '';
    p.anlagen = [];
  }
  // Aufgaben ohne Jahr: erst jetzt ist das Sitzungsdatum sicher bekannt
  for (const { e, roh: r } of aufgabenRoh) {
    const neu = aufgabeLesen(r, p.datum);
    e.faellig = neu.faellig; e.text = neu.text; e.verantwortlich = neu.verantwortlich;
  }
  return p;
}

/** Zusammenfassung je Datei für die Prüfliste */
export function mdZaehlen(p: MdProtokoll) {
  const e = p.tops.flatMap((t) => t.eintraege);
  return {
    tops: p.tops.length,
    beschluesse: e.filter((x) => x.art === 'BESCHLUSS').length,
    aufgaben: e.filter((x) => x.art === 'AUFGABE').length,
    anlagen: [...new Set([...p.anlagen, ...p.tops.flatMap((t) => t.anlagen)])],
  };
}
