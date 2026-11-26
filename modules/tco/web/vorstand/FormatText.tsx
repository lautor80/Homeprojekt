import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button, Input } from '@ui5/webcomponents-react';
import {
  EDITOR_FARBE, EDITOR_MARKIERT, EDITOR_OHNE_FARBE, FARBE_TEXT, FARBEN, farbeAusHex, hexWert, knotenZuText, linkPruefen, textLesen, textZuKnoten,
  type DomKnoten, type Farbe, type Knoten, type Stueck,
} from '../../server/vorstand/format';

/**
 * Formatierte Protokolltexte der Vorstandssitzungen: Anzeige (FormatText) und Editor (FormatEditor), in dem Fett, Kursiv,
 * Farben, Markierung, Aufzählungen und Verknüpfungen direkt beim Schreiben sichtbar sind (Enter in einer Aufzählung setzt sie fort).
 * Gespeichert wird Text mit wenigen Markdown-Zeichen (server/vorstand/format.ts) – **fett**, *kursiv*, ~~durchgestrichen~~,
 * Aufzählungen, nummerierte Listen und Verknüpfungen [Bezeichnung](https://…) bzw. freie Adressen. Die Anzeige baut
 * daraus React-Elemente (kein HTML aus dem Text); Verknüpfungen öffnen in einem neuen Tab.
 */
function Stuecke({ z }: { z: Stueck[] }) {
  return (
    <>
      {z.map((s, i) => {
        let el: ReactNode = s.text;
        if (s.durch) el = <s>{el}</s>;
        if (s.kursiv) el = <em>{el}</em>;
        if (s.fett) el = <strong>{el}</strong>;
        if (s.farbe) el = <span className={`portal-vs__f-${s.farbe}`}>{el}</span>;
        if (s.markiert) el = <mark className="portal-vs__mark">{el}</mark>;
        if (s.href) el = <a href={s.href} target="_blank" rel="noopener noreferrer">{el}</a>;
        return <span key={i}>{el}</span>;
      })}
    </>
  );
}

/** formatierten Text anzeigen; kompakt = ohne Absatzabstände (Tabellenzellen, Einträge) */
export function FormatText({ text, kompakt, className }: { text: string | null | undefined; kompakt?: boolean; className?: string }) {
  const bloecke = textLesen(text);
  if (!bloecke.length) return null;
  return (
    <div className={`portal-vs__fmt${kompakt ? ' portal-vs__fmt--kompakt' : ''}${className ? ` ${className}` : ''}`}>
      {bloecke.map((b, i) => (b.art === 'absatz'
        ? <p key={i}>{b.zeilen.map((z, k) => <span key={k}>{k > 0 && <br />}<Stuecke z={z} /></span>)}</p>
        : b.nummeriert
          ? <ol key={i} start={b.start}>{b.punkte.map((z, k) => <li key={k}><Stuecke z={z} /></li>)}</ol>
          : <ul key={i}>{b.punkte.map((z, k) => <li key={k}><Stuecke z={z} /></li>)}</ul>))}
    </div>
  );
}

/** Editor-Baum → DOM (nur erzeugte Elemente, Text als Textknoten – kein HTML aus dem Protokoll) */
function dom(k: Knoten): Node {
  if (typeof k === 'string') return document.createTextNode(k);
  const el = document.createElement(k.tag);
  if (k.tag === 'a' && k.href) { el.setAttribute('href', k.href); el.setAttribute('title', k.href); }
  if (k.tag === 'font' && k.farbe) el.setAttribute('color', EDITOR_FARBE[k.farbe]);
  if (k.tag === 'span' && k.markiert) el.style.backgroundColor = EDITOR_MARKIERT;
  if (k.start) el.setAttribute('start', String(k.start));
  for (const x of k.kinder) el.appendChild(dom(x));
  return el;
}
const imEditor = (el: HTMLElement | null) => {
  const sel = window.getSelection();
  return !!(el && sel && sel.rangeCount && el.contains(sel.getRangeAt(0).commonAncestorContainer));
};
/** nächstes umschließendes Element mit diesem Tag innerhalb des Editors */
function umschliessend(el: HTMLElement, tag: string): HTMLElement | null {
  let n: Node | null = window.getSelection()?.anchorNode ?? null;
  while (n && n !== el) { if (n.nodeType === 1 && (n as HTMLElement).tagName === tag) return n as HTMLElement; n = n.parentNode; }
  return null;
}
const befehl = (cmd: string, wert?: string) => {
  // Markieren (hiliteColor) geht nur mit Inline-Stil; alles andere mit Tags (<b>, <font color> …)
  document.execCommand('styleWithCSS', false, cmd === 'hiliteColor' ? 'true' : 'false');
  document.execCommand(cmd, false, wert);
  document.execCommand('styleWithCSS', false, 'false');
};

type Zustand = { fett: boolean; kursiv: boolean; durch: boolean; liste: boolean; nummer: boolean; link: boolean; farbe: Farbe | null; markiert: boolean };
const AUS: Zustand = { fett: false, kursiv: false, durch: false, liste: false, nummer: false, link: false, farbe: null, markiert: false };

/**
 * Editor mit Werkzeugleiste: Fett (Strg+B), Kursiv (Strg+I), Durchgestrichen, Aufzählung, nummerierte Liste und
 * Verknüpfung (Strg+K) wirken sofort im Text. Enter in einer Aufzählung beginnt den nächsten Punkt, Enter in einem leeren
 * Punkt beendet die Liste. Eingefügt wird nur Text (keine fremde Formatierung). Gespeichert wird das schlichte Format.
 */
export function FormatEditor({ value, onChange, rows = 8, placeholder, label }: {
  value: string; onChange: (v: string) => void; rows?: number; placeholder?: string; label: string;
}) {
  const feld = useRef<HTMLDivElement>(null);
  const zuletzt = useRef<string | null>(null);
  const bereich = useRef<Range | null>(null);
  /** letzte Markierung im Editor – Knöpfe und das Link-Feld nehmen den Fokus, danach wird sie wiederhergestellt */
  const markierung = useRef<Range | null>(null);
  const [aktiv, setAktiv] = useState<Zustand>(AUS);
  const [link, setLink] = useState<{ url: string; fehler: string | null } | null>(null);

  // Inhalt nur neu aufbauen, wenn der Wert von außen kommt (sonst springt die Schreibmarke)
  useLayoutEffect(() => {
    const el = feld.current;
    if (!el || value === zuletzt.current) return;
    el.replaceChildren(...textZuKnoten(value).map(dom));
    zuletzt.current = value;
  }, [value]);

  const melden = () => {
    const el = feld.current;
    if (!el) return;
    const t = knotenZuText(el.childNodes as unknown as ArrayLike<DomKnoten>);
    zuletzt.current = t;
    onChange(t);
  };
  const zustand = () => {
    const el = feld.current;
    if (!imEditor(el)) return;
    markierung.current = window.getSelection()!.getRangeAt(0).cloneRange();
    setAktiv({
      fett: document.queryCommandState('bold'), kursiv: document.queryCommandState('italic'), durch: document.queryCommandState('strikeThrough'),
      liste: document.queryCommandState('insertUnorderedList'), nummer: document.queryCommandState('insertOrderedList'), link: !!umschliessend(el!, 'A'),
      farbe: farbeAusHex(document.queryCommandValue('foreColor')) ?? null,
      markiert: hexWert(document.queryCommandValue('hiliteColor') || document.queryCommandValue('backColor')) === EDITOR_MARKIERT,
    });
  };
  useEffect(() => {
    document.execCommand('defaultParagraphSeparator', false, 'div');
    document.addEventListener('selectionchange', zustand);
    return () => document.removeEventListener('selectionchange', zustand);
  }, []);

  /** Fokus zurück in den Editor, mit der zuletzt dort gesetzten Markierung */
  const zurueck = () => {
    const el = feld.current;
    if (!el) return;
    const war = imEditor(el);
    el.focus();
    const sel = window.getSelection();
    if (!war && markierung.current && sel) { sel.removeAllRanges(); sel.addRange(markierung.current); }
  };
  const ausfuehren = (cmd: string, wert?: string) => { zurueck(); befehl(cmd, wert); melden(); zustand(); };

  function linkOeffnen() {
    const el = feld.current;
    if (!el) return;
    zurueck();
    const sel = window.getSelection();
    bereich.current = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const a = umschliessend(el, 'A');
    const markiert = sel?.toString().trim() ?? '';
    setLink({ url: a?.getAttribute('href') ?? (/^(https?:\/\/|www\.)\S+$/i.test(markiert) ? markiert : ''), fehler: null });
  }
  function linkSetzen() {
    const el = feld.current;
    if (!el || !link) return;
    const url = /^mailto:\S+@\S+$/i.test(link.url.trim()) ? link.url.trim() : linkPruefen(link.url);
    if (!url) { setLink({ ...link, fehler: 'Bitte eine vollständige Adresse angeben, z. B. https://www.tc-oberthal.de' }); return; }
    el.focus();
    const sel = window.getSelection();
    if (bereich.current && sel) { sel.removeAllRanges(); sel.addRange(bereich.current); }
    const a = umschliessend(el, 'A');
    if (a) { a.setAttribute('href', url); a.setAttribute('title', url); }
    else if (sel && sel.rangeCount && !sel.isCollapsed) befehl('createLink', url);
    else if (sel && sel.rangeCount) {
      // ohne Markierung: Adresse als Verknüpfung einfügen
      const r = sel.getRangeAt(0);
      const neu = document.createElement('a');
      neu.setAttribute('href', url); neu.setAttribute('title', url); neu.textContent = url.replace(/^mailto:/i, '');
      r.insertNode(neu); r.setStartAfter(neu); r.collapse(true); sel.removeAllRanges(); sel.addRange(r);
    }
    setLink(null); melden(); zustand();
  }
  function linkEntfernen() {
    const el = feld.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (bereich.current && sel) { sel.removeAllRanges(); sel.addRange(bereich.current); }
    const a = umschliessend(el, 'A');
    if (a) { const r = document.createRange(); r.selectNodeContents(a); sel?.removeAllRanges(); sel?.addRange(r); }
    befehl('unlink');
    setLink(null); melden(); zustand();
  }
  function taste(e: KeyboardEvent<HTMLDivElement>) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'k') { e.preventDefault(); linkOeffnen(); }
    else if (k === 'u') e.preventDefault();             // Unterstreichen gibt es nicht
    else if (k === 'b' || k === 'i') { e.preventDefault(); ausfuehren(k === 'b' ? 'bold' : 'italic'); }
  }
  const knopf = (an: boolean, icon: string, tip: string, tun: () => void) => (
    <Button design={an ? 'Emphasized' : 'Transparent'} icon={icon} tooltip={tip} accessibleName={tip} aria-pressed={an}
            onMouseDown={(e) => e.preventDefault()} onClick={tun} />
  );
  const leer = !value.trim();

  return (
    <div className="portal-vs__editor">
      <div className="portal-vs__werkzeuge" role="toolbar" aria-label={`${label}: Formatierung`}>
        {knopf(aktiv.fett, 'bold-text', 'Fett (Strg+B)', () => ausfuehren('bold'))}
        {knopf(aktiv.kursiv, 'italic-text', 'Kursiv (Strg+I)', () => ausfuehren('italic'))}
        {knopf(aktiv.durch, 'strikethrough', 'Durchgestrichen', () => ausfuehren('strikeThrough'))}
        <span className="portal-vs__trenner" />
        {FARBEN.map((f) => (
          <button key={f} type="button" className={`portal-vs__farbknopf portal-vs__farbknopf--${f}${aktiv.farbe === f ? ' portal-vs__farbknopf--an' : ''}`}
                  title={`Textfarbe ${FARBE_TEXT[f]}`} aria-label={`Textfarbe ${FARBE_TEXT[f]}`} aria-pressed={aktiv.farbe === f}
                  onMouseDown={(e) => e.preventDefault()} onClick={() => ausfuehren('foreColor', aktiv.farbe === f ? EDITOR_OHNE_FARBE : EDITOR_FARBE[f])}>A</button>
        ))}
        <button type="button" className="portal-vs__farbknopf portal-vs__farbknopf--ohne" title="Farbe entfernen" aria-label="Farbe entfernen"
                onMouseDown={(e) => e.preventDefault()} onClick={() => ausfuehren('foreColor', EDITOR_OHNE_FARBE)}>A</button>
        {knopf(aktiv.markiert, 'color-fill', 'Markieren (gelb hinterlegt)', () => ausfuehren('hiliteColor', aktiv.markiert ? 'transparent' : EDITOR_MARKIERT))}
        <span className="portal-vs__trenner" />
        {knopf(aktiv.liste, 'list', 'Aufzählung', () => ausfuehren('insertUnorderedList'))}
        {knopf(aktiv.nummer, 'numbered-text', 'Nummerierte Liste', () => ausfuehren('insertOrderedList'))}
        {knopf(aktiv.link, 'chain-link', 'Verknüpfung (Strg+K)', linkOeffnen)}
      </div>
      {link && (
        <div className="portal-vs__linkfeld">
          <Input value={link.url} placeholder="https://…" accessibleName="Adresse der Verknüpfung" style={{ flex: 1 }}
                 valueState={link.fehler ? 'Negative' : 'None'} valueStateMessage={link.fehler ? <div>{link.fehler}</div> : undefined}
                 onInput={(e) => setLink({ url: e.target.value, fehler: null })}
                 onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); linkSetzen(); } if (e.key === 'Escape') setLink(null); }} />
          <Button design="Emphasized" onClick={linkSetzen}>Übernehmen</Button>
          {aktiv.link && <Button design="Transparent" onClick={linkEntfernen}>Entfernen</Button>}
          <Button design="Transparent" onClick={() => setLink(null)}>Abbrechen</Button>
        </div>
      )}
      <div className="portal-vs__schreibflaeche">
        {leer && placeholder && <div className="portal-vs__platzhalter" aria-hidden="true">{placeholder}</div>}
        <div ref={feld} className="portal-vs__fmt portal-vs__eingabe" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true"
             aria-label={label} style={{ minHeight: `${rows * 1.5}em` }}
             onInput={melden} onKeyDown={taste} onKeyUp={zustand} onMouseUp={zustand} onBlur={melden}
             onPaste={(e) => { e.preventDefault(); befehl('insertText', e.clipboardData.getData('text/plain')); melden(); }}
             onDrop={(e) => e.preventDefault()} />
      </div>
      <div className="portal-muted portal-vs__hilfe">Strg+B fett · Strg+I kursiv · Strg+K Verknüpfung · farbiges A = Textfarbe (nochmals = entfernen) · Farbeimer = gelb markieren · Enter in einer Aufzählung setzt sie fort, Enter im leeren Punkt beendet sie</div>
    </div>
  );
}
