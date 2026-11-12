import { useEffect, useMemo, useState } from 'react';
import {
  AnalyticalTable, Bar, Button, Dialog, FlexBox, Label, Link, MessageStrip, ObjectStatus, Option, Select,
  Tab, TabContainer, Text,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { toast } from '@core/toast';
import { T, download } from './util';
import { ablegen, dateiLesen } from './ordner';
import { AUTO, autoOffen, emlErzeugen, emlHerunterladen } from './MailEntwurf';

// ---------------------------------------------------------------------------
// PDF-Vorschau für ein oder mehrere Dokumente (wie DOCS_POPUP_DISPLAY)
// ---------------------------------------------------------------------------
/**
 * url: Server-Adresse des PDFs (oder Objekt-URL bei `lokal`);
 * ablage: Aufträge, in deren Ablageordner das PDF gespeichert wird (#121) – die Vorschau zeigt dann die Datei aus dem Ordner
 */
export interface Doc { url: string; filename: string; ablage?: string[]; lokal?: boolean }

export function DocsDialog({ docs, onClose }: { docs: Doc[] | null; onClose: () => void }) {
  const [idx, setIdx] = useState(0);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [pfade, setPfade] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const doc = docs?.[idx];

  useEffect(() => setIdx(0), [docs]);
  useEffect(() => {
    if (!doc) return;
    setBlobUrl(null);
    setPfade([]);
    setError(null);
    if (doc.lokal) { setBlobUrl(doc.url); return; }
    let url: string | null = null;
    let aus = false;
    (async () => {
      const r = await fetch(doc.url, { credentials: 'same-origin' });
      if (!r.ok) throw new Error(JSON.parse((await r.text()) || '{}').message ?? `Fehler ${r.status}`);
      let b: Blob = await r.blob();
      // Ablageordner: speichern und die gespeicherte Datei anzeigen
      const gespeichert: string[] = [];
      for (const nr of doc.ablage ?? []) {
        try {
          const p = await ablegen(nr, doc.filename, b);
          if (p) gespeichert.push(p);
        } catch (e) {
          if (!aus) setError(`Ablageordner: ${(e as Error).message}`);
        }
      }
      if (gespeichert.length) b = (await dateiLesen(doc.ablage![0], doc.filename)) ?? b;
      if (aus) return;
      url = URL.createObjectURL(b);
      setBlobUrl(url);
      setPfade(gespeichert);
    })().catch((e) => { if (!aus) setError(e.message); });
    return () => { aus = true; if (url) URL.revokeObjectURL(url); };
  }, [doc]);

  const herunterladen = () => {
    if (!doc) return;
    if (!doc.lokal) return download(doc.url, doc.filename).catch((e) => setError(e.message));
    const a = document.createElement('a');
    a.href = doc.url;
    a.download = doc.filename;
    a.click();
  };

  return (
    <Dialog open={!!docs} headerText="PDF-Vorschau" onClose={onClose} resizable
            style={{ width: '80vw', height: '88vh' }}
            footer={<Bar endContent={<>
              <Button icon="download" disabled={!doc} onClick={herunterladen}>Herunterladen</Button>
              <Button design="Emphasized" onClick={onClose}>Schließen</Button>
            </>} />}>
      <FlexBox alignItems="Center" style={{ gap: '0.75rem', marginBottom: '0.5rem' }}>
        <Label showColon>Dokument</Label>
        <Select style={{ width: '24rem' }} onChange={(e) => setIdx(Number(e.detail.selectedOption.dataset.idx))}>
          {(docs ?? []).map((d, i) => <Option key={d.url} data-idx={i} selected={i === idx}>{d.filename}</Option>)}
        </Select>
        <Text>{docs?.length ?? 0} Dokument(e)</Text>
      </FlexBox>
      {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
      {pfade.length > 0 && (
        <MessageStrip design="Positive" hideCloseButton style={{ marginBottom: '0.5rem' }}>
          Gespeichert im Ablageordner: {pfade.join(' · ')}
        </MessageStrip>
      )}
      {blobUrl && <iframe title="PDF" src={blobUrl} style={{ width: '100%', height: `calc(100% - ${pfade.length ? 6 : 3}rem)`, border: 'none' }} />}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Versenden: E-Mail-Entwurf mit PDF im Anhang (.eml – mailto: kann keine Anhänge übergeben) + PDF/XML einzeln
// ---------------------------------------------------------------------------
export interface MailRow {
  auftragsnr: string; faktura: string | null; art: string; empfaenger: string; betreff: string; mailto: string; hasEmail: boolean;
  an: string; text: string;
}

export function MailDialog({ art, mails, onClose }: { art: 'T' | 'L' | 'R'; mails: MailRow[] | null; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [hinweis, setHinweis] = useState(false);
  const datei = (m: MailRow) => {
    const id = art === 'R' ? m.faktura! : m.auftragsnr;
    return { id, url: `${T}/pdf/${art}/${encodeURIComponent(id)}`, name: art === 'T' ? `Transportauftrag_${id}.pdf` : art === 'L' ? `Lieferschein_${id}.pdf` : `Rechnung_${id}.pdf` };
  };
  const pdf = (m: MailRow) => { const d = datei(m); download(d.url, d.name).catch((e) => setError(e.message)); };
  /** E-Mail-Entwurf mit dem PDF als Anhang (bei Rechnungen die ZUGFeRD-Rechnung) – öffnet sich im Mailprogramm mit „Senden“ */
  async function entwurf(m: MailRow) {
    setBusy(m.auftragsnr); setError(null);
    try {
      const d = datei(m);
      const res = await fetch(d.url, { credentials: 'same-origin' });
      if (!res.ok) { const t = await res.text(); throw new Error(JSON.parse(t || '{}').message ?? `PDF konnte nicht erzeugt werden (${res.status}).`); }
      const eml = await emlErzeugen({ an: m.an, betreff: m.betreff, text: m.text, anhaenge: [{ name: d.name, daten: await res.blob() }] });
      emlHerunterladen(eml, m.betreff);
      toast(`E-Mail-Entwurf „${m.betreff}“ mit ${d.name} erstellt.`, 5000);
      if (!autoOffen()) setHinweis(true);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }
  const xml = (m: MailRow) => download(`${T}/xrechnung/${encodeURIComponent(m.faktura!)}/datei`, `XRechnung_${m.faktura}.xml`).catch((e) => setError(e.message));

  return (
    <Dialog open={!!mails} headerText="Versenden" onClose={onClose} style={{ width: 'min(64rem, 95vw)' }}
            footer={<Bar endContent={<Button design="Emphasized" onClick={onClose}>Schließen</Button>} />}>
      <MessageStrip hideCloseButton style={{ marginBottom: '0.75rem' }}>
        „E-Mail öffnen“ erstellt einen E-Mail-Entwurf mit Empfänger, Betreff, Standardtext und dem PDF als Anhang; er öffnet sich im
        Mailprogramm (Outlook mit „Senden“). „ohne Anhang“ öffnet das Mailprogramm direkt, ohne PDF. Bei Rechnungen ist das PDF bereits die E-Rechnung (ZUGFeRD 2.3, EN 16931) – die XRechnung-XML ist nur für Behördenportale nötig.
      </MessageStrip>
      {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
      {hinweis && (
        <MessageStrip design="Information" onClose={() => { try { localStorage.setItem(AUTO, '1'); } catch { /* egal */ } setHinweis(false); }} style={{ marginBottom: '0.5rem' }}>
          Der Entwurf liegt als E-Mail-Datei (.eml) in den Downloads – anklicken, dann öffnet er sich im Mailprogramm. Damit das künftig automatisch passiert:
          Downloads öffnen (Strg+J), bei der .eml-Datei auf ⋯ bzw. Rechtsklick → „Dateien dieses Typs immer öffnen“. Danach diesen Hinweis schließen.
        </MessageStrip>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--sapList_BorderColor)' }}>
            <th style={{ padding: '0.5rem' }}>Auftrag</th><th>Empfänger / Betreff</th><th>E-Mail</th><th>Anhang</th>
          </tr>
        </thead>
        <tbody>
          {(mails ?? []).map((m) => (
            <tr key={m.auftragsnr} style={{ borderBottom: '1px solid var(--sapList_BorderColor)' }}>
              <td style={{ padding: '0.5rem' }}><b>{m.auftragsnr}</b><br /><Text>{m.art}</Text></td>
              <td><b>{m.empfaenger}</b><br /><Text>{m.betreff}</Text></td>
              <td>
                <FlexBox direction="Column" style={{ gap: '0.25rem', padding: '0.25rem 0' }}>
                  <Button design="Emphasized" icon="email" disabled={!!busy || !m.hasEmail} onClick={() => entwurf(m)}
                          tooltip="E-Mail-Entwurf mit dem PDF als Anhang">{busy === m.auftragsnr ? 'Erstelle …' : 'E-Mail öffnen'}</Button>
                  <Link href={m.mailto} disabled={!m.hasEmail} style={{ fontSize: 'var(--sapFontSmallSize)' }}>ohne Anhang</Link>
                </FlexBox>
              </td>
              <td>
                <FlexBox direction="Column" style={{ gap: '0.25rem', padding: '0.25rem 0' }}>
                  <Button icon="download" onClick={() => pdf(m)}>PDF herunterladen</Button>
                  {art === 'R' && <Button icon="attachment-text-file" onClick={() => xml(m)}>E-Rechnung (XML)</Button>}
                </FlexBox>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// E-Rechnung (XRechnung 3.0): Hinweise, Vorschau, XML, Download
// ---------------------------------------------------------------------------
export interface XRes { faktura: string; filename: string; xml: string; hinweise: string[]; html: string; xmlHtml: string; anzahlAuftraege: number }
interface Pruefung { profil: string; datei: string; groesse: number; ok: boolean; punkte: { punkt: string; ok: boolean; detail?: string }[]; hinweise: string[] }

/**
 * E-Rechnung: Das Rechnungs-PDF ist eine ZUGFeRD-Rechnung (PDF/A-3 mit eingebetteter factur-x.xml);
 * zusätzlich gibt es die XRechnung (UBL) für Behörden/Portale. Hier: Vorschau, Hinweise, Downloads, Prüfung.
 */
export function XRechnungDialog({ data, onClose }: { data: XRes | null; onClose: () => void }) {
  const [tab, setTab] = useState<'HTML' | 'XML' | 'PRUEF'>('HTML');
  const [error, setError] = useState<string | null>(null);
  const [pruefung, setPruefung] = useState<Pruefung | null>(null);
  useEffect(() => {
    setPruefung(null);
    if (tab === 'PRUEF' && data) api.get<Pruefung>(`${T}/zugferd/${encodeURIComponent(data.faktura)}/pruefung`).then(setPruefung).catch((e) => setError(e.message));
  }, [tab, data?.faktura]); // eslint-disable-line react-hooks/exhaustive-deps
  const herunterladen = (url: string, name: string) => download(url, name).then(() => toast(`${name} heruntergeladen.`)).catch((e) => setError(e.message));
  return (
    <Dialog open={!!data} headerText={`E-Rechnung ${data?.faktura ?? ''}`} onClose={onClose} resizable draggable
            style={{ width: 'min(64rem, 95vw)', height: '80vh' }}
            footer={<Bar endContent={<>
              {data && <Button design="Emphasized" icon="pdf-attachment" onClick={() => herunterladen(`${T}/pdf/R/${encodeURIComponent(data.faktura)}`, `Rechnung_${data.faktura}.pdf`)}>
                PDF (ZUGFeRD) herunterladen
              </Button>}
              {data && <Button icon="download" onClick={() => herunterladen(`${T}/xrechnung/${encodeURIComponent(data.faktura)}/datei`, data.filename)}>XRechnung (XML)</Button>}
              {data && <Button icon="download" onClick={() => herunterladen(`${T}/zugferd/${encodeURIComponent(data.faktura)}/datei`, `${data.faktura}_factur-x.xml`)}>factur-x.xml</Button>}
              <Button onClick={onClose}>Schließen</Button>
            </>} />}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
      <MessageStrip hideCloseButton style={{ marginBottom: '0.5rem' }}>
        Das Rechnungs-PDF ist eine E-Rechnung nach ZUGFeRD 2.3 / Factur-X (EN 16931): PDF/A-3 mit eingebetteter factur-x.xml – ein Dokument für Mensch und Buchhaltungssoftware.
        Für Behördenportale steht zusätzlich die XRechnung (UBL) zum Download bereit.
      </MessageStrip>
      {!!data?.hinweise.length && (
        <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>
          {data.hinweise.map((h) => <div key={h}>{h}</div>)}
        </MessageStrip>
      )}
      <TabContainer onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key as 'HTML')}>
        <Tab text="Vorschau" data-key="HTML" selected={tab === 'HTML'} />
        <Tab text="XML (XRechnung)" data-key="XML" selected={tab === 'XML'} />
        <Tab text="Prüfung ZUGFeRD-PDF" data-key="PRUEF" selected={tab === 'PRUEF'} />
      </TabContainer>
      {data && tab !== 'PRUEF' && <div dangerouslySetInnerHTML={{ __html: tab === 'HTML' ? data.html : data.xmlHtml }} />}
      {tab === 'PRUEF' && (
        <div style={{ padding: '0.75rem 0.25rem' }}>
          {!pruefung && !error && <Text>Rechnung wird erzeugt und geprüft …</Text>}
          {pruefung && (
            <>
              <MessageStrip design={pruefung.ok ? 'Positive' : 'Negative'} hideCloseButton style={{ marginBottom: '0.75rem' }}>
                {pruefung.ok ? 'Alle Strukturprüfungen bestanden' : 'Mindestens eine Prüfung fehlgeschlagen'} · {pruefung.profil} · {Math.round(pruefung.groesse / 1024)} KB
              </MessageStrip>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <tbody>
                  {pruefung.punkte.map((p) => (
                    <tr key={p.punkt} style={{ borderBottom: '1px solid var(--sapList_BorderColor)' }}>
                      <td style={{ padding: '0.35rem 0.5rem', width: '2rem' }}><ObjectStatus state={p.ok ? 'Positive' : 'Negative'} showDefaultIcon /></td>
                      <td style={{ padding: '0.35rem 0.5rem' }}>{p.punkt}{p.detail ? <span className="portal-muted"> – {p.detail}</span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.75rem' }}>
                Strukturprüfung des Portals. Für einen vollständigen Nachweis das PDF gelegentlich extern prüfen (z. B. veraPDF für PDF/A, Mustang oder der KoSIT-Validator für den XML-Teil).
              </Text>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** Kleine Erfolgsmeldung mit mehreren Zeilen (wie message_box success) */
export function InfoDialog({ title, text, onClose }: { title: string; text: string | null; onClose: () => void }) {
  return (
    <Dialog open={!!text} headerText={title} state="Positive" onClose={onClose}
            footer={<Bar endContent={<Button design="Emphasized" onClick={onClose}>OK</Button>} />}>
      <div style={{ whiteSpace: 'pre-line', maxWidth: '40rem' }}>{text}</div>
    </Dialog>
  );
}

