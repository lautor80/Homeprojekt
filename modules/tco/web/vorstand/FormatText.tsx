import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '@ui5/webcomponents-react';
import { textLesen, type Stueck } from '../../server/vorstand/format';

/**
 * Formatierte Protokolltexte der Vorstandssitzungen: Anzeige (FormatText) und Eingabe mit Werkzeugleiste (FormatEditor).
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

type Aktion = 'fett' | 'kursiv' | 'durch' | 'liste' | 'nummer' | 'link';
const UMSCHLIESSEN: Record<'fett' | 'kursiv' | 'durch', [string, string]> = { fett: ['**', '**'], kursiv: ['*', '*'], durch: ['~~', '~~'] };

/**
 * Textfeld mit Werkzeugleiste: Fett (Strg+B), Kursiv (Strg+I), Durchgestrichen, Aufzählung, nummerierte Liste,
 * Verknüpfung (Strg+K) und Vorschau. Die Knöpfe setzen die Formatzeichen um die Markierung bzw. an den Zeilenanfang.
 */
export function FormatEditor({ value, onChange, rows = 8, placeholder, label }: {
  value: string; onChange: (v: string) => void; rows?: number; placeholder?: string; label: string;
}) {
  const feld = useRef<HTMLTextAreaElement>(null);
  const [vorschau, setVorschau] = useState(false);

  function anwenden(a: Aktion) {
    const ta = feld.current;
    if (!ta) return;
    const { selectionStart: von, selectionEnd: bis } = ta;
    const vor = value.slice(0, von), mark = value.slice(von, bis), nach = value.slice(bis);
    let neu = value, selVon = von, selBis = bis;
    if (a === 'fett' || a === 'kursiv' || a === 'durch') {
      const [l, r] = UMSCHLIESSEN[a];
      // bereits umschlossen → entfernen
      if (vor.endsWith(l) && nach.startsWith(r) && !(a === 'kursiv' && vor.endsWith('**') && !vor.endsWith('***'))) {
        neu = vor.slice(0, -l.length) + mark + nach.slice(r.length); selVon = von - l.length; selBis = bis - l.length;
      } else {
        const t = mark || (a === 'fett' ? 'fetter Text' : a === 'kursiv' ? 'kursiver Text' : 'Text');
        neu = vor + l + t + r + nach; selVon = von + l.length; selBis = selVon + t.length;
      }
    } else if (a === 'liste' || a === 'nummer') {
      // ganze Zeilen der Markierung
      const start = value.lastIndexOf('\n', von - 1) + 1;
      const endeRoh = value.indexOf('\n', bis);
      const ende = endeRoh < 0 ? value.length : endeRoh;
      const zeilen = value.slice(start, ende).split('\n');
      const istListe = zeilen.every((z) => (a === 'liste' ? /^\s*[-*•]\s/.test(z) : /^\s*\d+[.)]\s/.test(z)));
      const neuZ = zeilen.map((z, i) => {
        const ohne = z.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '');
        return istListe ? ohne : `${a === 'liste' ? '-' : `${i + 1}.`} ${ohne}`;
      }).join('\n');
      neu = value.slice(0, start) + neuZ + value.slice(ende); selVon = start; selBis = start + neuZ.length;
    } else {
      const istAdresse = /^(https?:\/\/|www\.)\S+$/i.test(mark.trim());
      const bez = istAdresse ? 'Bezeichnung' : mark || 'Bezeichnung';
      const url = istAdresse ? mark.trim() : 'https://';
      neu = `${vor}[${bez}](${url})${nach}`;
      // Bezeichnung markieren, wenn die Adresse schon da ist, sonst die Adresse
      if (istAdresse || !mark) { selVon = von + 1; selBis = selVon + bez.length; } else { selVon = von + bez.length + 3; selBis = selVon + url.length; }
    }
    onChange(neu);
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(selVon, selBis); });
  }
  function taste(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    const a: Aktion | null = k === 'b' ? 'fett' : k === 'i' ? 'kursiv' : k === 'k' ? 'link' : null;
    if (a) { e.preventDefault(); anwenden(a); }
  }
  const knopf = (a: Aktion, icon: string, tip: string) => (
    <Button design="Transparent" icon={icon} tooltip={tip} accessibleName={tip} disabled={vorschau} onClick={() => anwenden(a)} />
  );

  return (
    <div className="portal-vs__editor">
      <div className="portal-vs__werkzeuge" role="toolbar" aria-label={`${label}: Formatierung`}>
        {knopf('fett', 'bold-text', 'Fett (Strg+B)')}
        {knopf('kursiv', 'italic-text', 'Kursiv (Strg+I)')}
        {knopf('durch', 'strikethrough', 'Durchgestrichen')}
        <span className="portal-vs__trenner" />
        {knopf('liste', 'list', 'Aufzählung')}
        {knopf('nummer', 'numbered-text', 'Nummerierte Liste')}
        {knopf('link', 'chain-link', 'Verknüpfung (Strg+K)')}
        <span style={{ flex: 1 }} />
        <Button design={vorschau ? 'Emphasized' : 'Transparent'} icon="show" onClick={() => setVorschau(!vorschau)}>{vorschau ? 'Bearbeiten' : 'Vorschau'}</Button>
      </div>
      {vorschau
        ? <div className="portal-vs__vorschau">{value.trim() ? <FormatText text={value} /> : <span className="portal-muted">Noch kein Text.</span>}</div>
        : <textarea ref={feld} className="portal-vs__eingabe" rows={rows} value={value} placeholder={placeholder} aria-label={label}
                    onChange={(e) => onChange(e.target.value)} onKeyDown={taste} />}
      <div className="portal-muted portal-vs__hilfe">**fett** · *kursiv* · ~~durchgestrichen~~ · „- “ Aufzählung · „1. “ Liste · [Bezeichnung](https://…) – Adressen werden von selbst zu Verknüpfungen</div>
    </div>
  );
}
