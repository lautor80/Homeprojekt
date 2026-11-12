import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Button, CheckBox, Icon, MessageStrip, Text, TextArea, Title } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { LAENDER } from './laender';
import { T, type Adresse } from './util';

/**
 * Kontakt aus eingefügten Informationen (#158): Bereich im Kontaktdialog, in den Informationen per Drag & Drop abgelegt oder
 * aus der Zwischenablage eingefügt werden – Screenshot/Foto (Texterkennung auf dem Server), kopierter Text, PDF, Visitenkarte
 * .vcf, Text-/E-Mail-Datei. Der Server analysiert (POST /adressen/erkennen) und schlägt Werte je Feld vor; übernommen wird
 * erst nach Auswahl.
 */
type Feld = Exclude<keyof Adresse, 'adrnr'>;
const FELDER: [Feld, string][] = [
  ['kundenname', 'Name'], ['kundenname2', 'Name 2'], ['strasse', 'Straße'], ['hausnummer', 'Hausnummer'], ['plz', 'PLZ'], ['ort', 'Ort'], ['land', 'Land'],
  ['ustid', 'USt-IdNr.'], ['anrede', 'Anrede'], ['vorname', 'Vorname'], ['name', 'Nachname'], ['telefon', 'Telefon'], ['fax', 'Fax'], ['email', 'E-Mail'], ['gln', 'GLN'],
];
interface Erkennung { felder: Partial<Record<Feld, string>>; unklar: string[]; hinweise: string[]; quelle?: 'text' | 'bild' | 'pdf'; gelesen?: string | null }
type Eingabe = { text: string } | { bild: string } | { pdf: string };
const land = (c: string) => LAENDER.find(([k]) => k === c)?.[1] ?? c;
const istBild = (f: File) => f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(f.name);
const istPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

/** HTML aus Zwischenablage/Drag & Drop in Zeilen umwandeln */
function htmlText(html: string): string {
  const d = new DOMParser().parseFromString(html, 'text/html');
  d.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
  d.querySelectorAll('p,div,tr,li,h1,h2,h3,h4,table,address').forEach((el) => el.append('\n'));
  d.querySelectorAll('td,th').forEach((el) => el.append(' | '));
  return d.body.textContent ?? '';
}
/** E-Mail-Datei (.eml): Kopfzeilen weglassen, Quoted-Printable grob auflösen */
function emlText(eml: string): string {
  const [kopf, ...rest] = eml.replace(/\r/g, '').split('\n\n');
  let t = rest.join('\n\n');
  if (/quoted-printable/i.test(kopf + t.slice(0, 2000))) {
    t = t.replace(/=\n/g, '');
    try { t = decodeURIComponent(t.replace(/%/g, '%25').replace(/=([0-9A-F]{2})/g, '%$1')); } catch { t = t.replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))); }
  }
  return /<html|<body|<div|<p[\s>]/i.test(t) ? htmlText(t) : t;
}
const base64 = (blob: Blob) => new Promise<string>((ok, fehler) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = () => fehler(new Error('Die Datei konnte nicht gelesen werden.'));
  r.readAsDataURL(blob);
});
/**
 * Screenshot/Foto für die Texterkennung vorbereiten: auf weißem Grund zeichnen und kleine Schrift vergrößern
 * (Bildschirmfotos etwa dreifach, lange Seite höchstens 4000 Pixel) – erst damit liest die Texterkennung zuverlässig.
 */
async function bildVorbereiten(f: Blob): Promise<string> {
  let bild: ImageBitmap;
  try { bild = await createImageBitmap(f); } catch { throw new Error('Dieses Bildformat kann der Browser nicht lesen – bitte als PNG oder JPEG einfügen.'); }
  const lang = Math.max(bild.width, bild.height);
  const faktor = Math.max(1, Math.min(3, 4000 / lang, 2400 / Math.min(bild.width, bild.height)));
  const c = document.createElement('canvas');
  c.width = Math.round(bild.width * faktor); c.height = Math.round(bild.height * faktor);
  const x = c.getContext('2d')!;
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  x.drawImage(bild, 0, 0, c.width, c.height);
  bild.close();
  const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/png'));
  if (!blob) throw new Error('Das Bild konnte nicht verarbeitet werden.');
  return base64(blob);
}
async function dateiLesen(f: File): Promise<Eingabe> {
  if (istBild(f)) return { bild: await bildVorbereiten(f) };
  if (f.size > 10_000_000) throw new Error('Die Datei ist zu groß (höchstens 10 MB).');
  if (istPdf(f)) return { pdf: await base64(f) };
  if (f.size > 500_000) throw new Error('Die Datei ist zu groß – bitte nur die Kontaktdaten einfügen.');
  const t = await f.text();
  if (/\u0000/.test(t.slice(0, 2000))) throw new Error('Dieses Dateiformat kann nicht gelesen werden – bitte Text, Screenshot, PDF oder Visitenkarte (.vcf) einfügen.');
  return { text: /\.html?$/i.test(f.name) ? htmlText(t) : /\.eml$/i.test(f.name) ? emlText(t) : t };
}

export function KontaktEinfuegen({ aktiv, k, onUebernehmen }: { aktiv: boolean; k: Adresse; onUebernehmen: (f: Partial<Adresse>) => void }) {
  const [e, setE] = useState<Erkennung | null>(null);
  const [wahl, setWahl] = useState<Set<Feld>>(new Set());
  /** laufender Schritt als Text (Bild lesen dauert einige Sekunden) */
  const [busy, setBusy] = useState<string | null>(null);
  const dateiRef = useRef<HTMLInputElement>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [ueber, setUeber] = useState(false);
  const [eingabe, setEingabe] = useState(false);
  const [text, setText] = useState('');
  const kRef = useRef(k);
  kRef.current = k;

  useEffect(() => { if (!aktiv) { setE(null); setFehler(null); setEingabe(false); setText(''); setUeber(false); } }, [aktiv]);

  async function analysieren(ein: Eingabe | string) {
    setFehler(null);
    const body = typeof ein === 'string' ? { text: ein.slice(0, 100_000) } : ein;
    if ('text' in body && !body.text.trim()) { setFehler('Die Zwischenablage bzw. Datei enthält keinen Text.'); return; }
    setBusy('bild' in body ? 'Bild wird gelesen …' : 'pdf' in body ? 'PDF wird gelesen …' : 'Text wird analysiert …');
    try {
      const r = await api.post<Erkennung>(`${T}/adressen/erkennen`, body);
      setE(r);
      // vorausgewählt: alles, was im Dialog noch leer ist (bestehende abweichende Werte bleiben, bis sie angehakt werden)
      setWahl(new Set(FELDER.map(([f]) => f).filter((f) => r.felder[f] && !(kRef.current[f] ?? '').trim())));
      setEingabe(false); setText('');
    } catch (x) { setFehler((x as Error).message); } finally { setBusy(null); }
  }
  const versuchen = (p: Promise<Eingabe>) => { setFehler(null); setBusy('Datei wird gelesen …'); p.then(analysieren).catch((x) => { setBusy(null); setFehler((x as Error).message); }); };

  // Strg+V überall im Dialog: mehrzeiliger Text wird analysiert; einzelne Werte in einem Eingabefeld bleiben normales Einfügen
  useEffect(() => {
    if (!aktiv) return undefined;
    const paste = (ev: ClipboardEvent) => {
      const cd = ev.clipboardData;
      if (!cd) return;
      const pfad = ev.composedPath().filter((x): x is HTMLElement => x instanceof HTMLElement);
      if (pfad.some((x) => x.dataset.kontaktText !== undefined)) return;
      const datei = cd.files[0];
      const t = cd.getData('text/plain') || (cd.getData('text/html') ? htmlText(cd.getData('text/html')) : '');
      const imFeld = pfad.some((x) => /^(INPUT|TEXTAREA|UI5-INPUT|UI5-TEXTAREA|UI5-COMBOBOX)$/.test(x.tagName));
      if (t.trim()) {
        if (imFeld && t.trim().split('\n').length < 2) return;
        ev.preventDefault(); ev.stopPropagation();
        analysieren(t);
      } else if (datei) {
        // Screenshot oder Datei aus der Zwischenablage: hier lesen, nicht als Dokument am Auftrag ablegen
        ev.preventDefault(); ev.stopPropagation();
        versuchen(dateiLesen(datei));
      }
    };
    document.addEventListener('paste', paste, true);
    return () => document.removeEventListener('paste', paste, true);
  }, [aktiv]); // eslint-disable-line react-hooks/exhaustive-deps

  function drop(ev: DragEvent) {
    ev.preventDefault(); ev.stopPropagation();
    setUeber(false);
    const dt = ev.dataTransfer;
    const t = dt.getData('text/plain') || (dt.getData('text/html') ? htmlText(dt.getData('text/html')) : '');
    if (dt.files.length) versuchen(dateiLesen(dt.files[0]));
    else analysieren(t);
  }
  /** Knopf „Aus Zwischenablage“: Text, sonst ein Bild (Screenshot) aus der Zwischenablage holen */
  async function zwischenablage() {
    setFehler(null);
    try {
      const t = await navigator.clipboard.readText().catch(() => '');
      if (t.trim()) { await analysieren(t); return; }
      const eintraege = await navigator.clipboard.read();
      for (const e2 of eintraege) {
        const typ = e2.types.find((x) => x.startsWith('image/'));
        if (typ) { versuchen(e2.getType(typ).then(async (b) => ({ bild: await bildVorbereiten(b) }))); return; }
      }
      setFehler('Die Zwischenablage enthält weder Text noch ein Bild.');
    } catch { setFehler('Der Browser erlaubt den Zugriff auf die Zwischenablage nicht – bitte in den Dialog klicken und mit Strg+V einfügen.'); }
  }

  const vorschlaege = e ? FELDER.filter(([f]) => e.felder[f] && e.felder[f] !== (k[f] ?? '')) : [];
  const gleich = e ? FELDER.filter(([f]) => e.felder[f] && e.felder[f] === (k[f] ?? '')).length : 0;
  return (
    <div style={{ marginBottom: '0.5rem' }}>
      <div className={`portal-ablagebox${ueber ? ' portal-ablagebox--ueber' : ''}`} style={{ cursor: 'default', flexWrap: 'wrap' }}
           onDragOver={(ev) => { ev.preventDefault(); ev.stopPropagation(); setUeber(true); }} onDragLeave={() => setUeber(false)} onDrop={drop}>
        <Icon name="paste" />
        <div style={{ flex: '1 1 16rem', minWidth: 0 }}>
          <b style={{ color: 'var(--sapTextColor)' }}>Kontaktdaten einfügen</b>
          <div>Screenshot, Text, PDF oder Visitenkarte (.vcf) hierher ziehen oder mit Strg+V einfügen – z. B. Unternehmensprofil, E-Mail-Signatur, Impressum. Die Felder werden vorgeschlagen.</div>
        </div>
        <Button icon="paste" loading={!!busy} onClick={zwischenablage}>Aus Zwischenablage</Button>
        <Button design="Transparent" icon="attachment" disabled={!!busy} onClick={() => dateiRef.current?.click()}>Datei oder Foto</Button>
        <Button design="Transparent" icon="edit" disabled={!!busy} onClick={() => { setEingabe(!eingabe); setFehler(null); }}>Text eingeben</Button>
        <input ref={dateiRef} type="file" hidden accept="image/*,application/pdf,.vcf,.txt,.eml,.html,.htm,.csv"
               onChange={(ev) => { const f = ev.target.files?.[0]; ev.target.value = ''; if (f) versuchen(dateiLesen(f)); }} />
      </div>
      {busy && <MessageStrip design="Information" hideCloseButton style={{ marginTop: '0.5rem' }}>{busy}</MessageStrip>}
      {eingabe && (
        <div style={{ marginTop: '0.5rem' }}>
          <TextArea data-kontakt-text="" rows={6} value={text} placeholder="Kontaktdaten hier einfügen oder eintippen …" onInput={(ev) => setText(ev.target.value)} />
          <Button design="Emphasized" icon="search" disabled={!!busy || !text.trim()} style={{ marginTop: '0.25rem' }} onClick={() => analysieren(text)}>Analysieren</Button>
        </div>
      )}
      {fehler && <MessageStrip design="Negative" onClose={() => setFehler(null)} style={{ marginTop: '0.5rem' }}>{fehler}</MessageStrip>}
      {e && (
        <div style={{ marginTop: '0.5rem', padding: '0.75rem 1rem', border: '1px solid var(--sapList_BorderColor)', borderRadius: 'var(--portal-radius, 0.75rem)' }}>
          <Title level="H6" style={{ marginBottom: '0.25rem' }}>{e.quelle === 'bild' ? 'Vorschlag aus dem eingefügten Bild' : e.quelle === 'pdf' ? 'Vorschlag aus dem PDF' : 'Vorschlag aus dem eingefügten Text'}</Title>
          {e.hinweise.map((h) => <MessageStrip key={h} design="Critical" hideCloseButton style={{ margin: '0.25rem 0' }}>{h}</MessageStrip>)}
          {vorschlaege.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(17rem, 1fr))', gap: '0 1rem' }}>
              {vorschlaege.map(([f, label]) => {
                const alt = (k[f] ?? '').trim();
                const wert = f === 'land' ? `${land(e.felder[f]!)} (${e.felder[f]})` : e.felder[f]!;
                return (
                  <CheckBox key={f} wrappingType="Normal" checked={wahl.has(f)}
                            text={`${label}: ${wert}${alt ? ` (bisher: ${alt})` : ''}`}
                            onChange={(ev) => { const n = new Set(wahl); if (ev.target.checked) n.add(f); else n.delete(f); setWahl(n); }} />
                );
              })}
            </div>
          )}
          {!vorschlaege.length && !e.hinweise.length && <Text>Alle erkannten Angaben stehen bereits im Dialog.</Text>}
          {gleich > 0 && vorschlaege.length > 0 && <Text className="portal-muted portal-small" style={{ display: 'block' }}>{gleich} weitere Angabe(n) stimmen bereits überein.</Text>}
          {e.unklar.length > 0 && (
            <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.25rem' }}>Nicht zugeordnet: {e.unklar.join(' · ')}</Text>
          )}
          {e.gelesen && (
            <details style={{ marginTop: '0.25rem' }}>
              <summary className="portal-muted portal-small" style={{ cursor: 'pointer' }}>Gelesener Text (zur Kontrolle – Texterkennung kann einzelne Zeichen verwechseln)</summary>
              <pre style={{ margin: '0.25rem 0 0', padding: '0.5rem', maxHeight: '10rem', overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 'var(--sapFontSmallSize)', background: 'var(--sapField_ReadOnly_Background, #f5f6f7)', borderRadius: '0.5rem' }}>{e.gelesen}</pre>
            </details>
          )}
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
            {vorschlaege.length > 0 && (
              <Button design="Emphasized" icon="accept" disabled={!wahl.size} onClick={() => {
                onUebernehmen(Object.fromEntries(vorschlaege.filter(([f]) => wahl.has(f)).map(([f]) => [f, e.felder[f]])) as Partial<Adresse>);
                setE(null);
              }}>{wahl.size} Feld{wahl.size === 1 ? '' : 'er'} übernehmen</Button>
            )}
            <Button design="Transparent" onClick={() => setE(null)}>Verwerfen</Button>
          </div>
        </div>
      )}
    </div>
  );
}
