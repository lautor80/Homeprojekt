import { useEffect, useMemo, useState } from 'react';
import {
  AnalyticalTable, Bar, Button, Dialog, FlexBox, Label, Link, MessageStrip, ObjectStatus, Option, Select,
  Tab, TabContainer, Text,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { toast } from '@core/toast';
import { AblageFlaeche } from '@core/ablage';
import { T, download } from './util';

// ---------------------------------------------------------------------------
// PDF-Vorschau für ein oder mehrere Dokumente (wie DOCS_POPUP_DISPLAY)
// ---------------------------------------------------------------------------
export interface Doc { url: string; filename: string }

export function DocsDialog({ docs, onClose }: { docs: Doc[] | null; onClose: () => void }) {
  const [idx, setIdx] = useState(0);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const doc = docs?.[idx];

  useEffect(() => setIdx(0), [docs]);
  useEffect(() => {
    if (!doc) return;
    let url: string | null = null;
    setBlobUrl(null);
    setError(null);
    fetch(doc.url, { credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) throw new Error(JSON.parse((await r.text()) || '{}').message ?? `Fehler ${r.status}`);
        return r.blob();
      })
      .then((b) => { url = URL.createObjectURL(b); setBlobUrl(url); })
      .catch((e) => setError(e.message));
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [doc]);

  return (
    <Dialog open={!!docs} headerText="PDF-Vorschau" onClose={onClose} resizable
            style={{ width: '80vw', height: '88vh' }}
            footer={<Bar endContent={<>
              <Button icon="download" disabled={!doc} onClick={() => doc && download(doc.url, doc.filename).catch((e) => setError(e.message))}>Herunterladen</Button>
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
      {blobUrl && <iframe title="PDF" src={blobUrl} style={{ width: '100%', height: 'calc(100% - 3rem)', border: 'none' }} />}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Versenden: E-Mail-Entwürfe (mailto) + PDF/XML zum Anhängen
// ---------------------------------------------------------------------------
export interface MailRow {
  auftragsnr: string; faktura: string | null; art: string; empfaenger: string; betreff: string; mailto: string; hasEmail: boolean;
}

export function MailDialog({ art, mails, onClose }: { art: 'T' | 'L' | 'R'; mails: MailRow[] | null; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const pdf = (m: MailRow) => {
    const id = art === 'R' ? m.faktura! : m.auftragsnr;
    const name = art === 'T' ? `Transportauftrag_${id}.pdf` : art === 'L' ? `Lieferschein_${id}.pdf` : `Rechnung_${id}.pdf`;
    download(`${T}/pdf/${art}/${encodeURIComponent(id)}`, name).catch((e) => setError(e.message));
  };
  const xml = (m: MailRow) => download(`${T}/xrechnung/${encodeURIComponent(m.faktura!)}/datei`, `XRechnung_${m.faktura}.xml`).catch((e) => setError(e.message));

  return (
    <Dialog open={!!mails} headerText="Versenden" onClose={onClose} style={{ width: 'min(64rem, 95vw)' }}
            footer={<Bar endContent={<Button design="Emphasized" onClick={onClose}>Schließen</Button>} />}>
      <MessageStrip hideCloseButton style={{ marginBottom: '0.75rem' }}>
        „E-Mail öffnen“ startet dein Mailprogramm mit Empfänger, Betreff und Standardtext. Das PDF lädst du daneben herunter und hängst es an.
        Bei Rechnungen ist das PDF bereits die E-Rechnung (ZUGFeRD 2.3, EN 16931) – die XRechnung-XML ist nur für Behördenportale nötig.
      </MessageStrip>
      {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
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
              <td><Link href={m.mailto} disabled={!m.hasEmail}>E-Mail öffnen</Link></td>
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

// ---------------------------------------------------------------------------
// CSV-Import aus SAP
// ---------------------------------------------------------------------------
interface ImpStatus { key: string; datei: string; tabelle: string; status: string; state: 'None' | 'Positive' | 'Negative' | 'Critical'; anzahl: number | null; neu: number | null; hinweis: string }

function readBase64(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = rej;
    r.readAsDataURL(f);
  });
}

export function ImportDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (text: string) => void }) {
  const [files, setFiles] = useState<{ name: string; data: string }[]>([]);
  const [status, setStatus] = useState<ImpStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFiles([]);
    setStatus(null);
    setError(null);
    api.post<ImpStatus[]>(`${T}/import/pruefen`, { dateien: [] }).then(setStatus).catch((e) => setError(e.message));
  }, [open]);

  async function add(list: FileList | File[] | null) {
    if (!list?.length) return;
    const neu = [...files];
    for (const f of Array.from(list)) {
      const i = neu.findIndex((x) => x.name === f.name);
      const e = { name: f.name, data: await readBase64(f) };
      if (i >= 0) neu[i] = e; else neu.push(e);
    }
    setFiles(neu);
    setError(null);
    try {
      setStatus(await api.post<ImpStatus[]>(`${T}/import/pruefen`, { dateien: neu }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ text: string }>(`${T}/import/ausfuehren`, { dateien: files });
      onDone(r.text);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const columns: AnalyticalTableColumnDefinition[] = useMemo(() => [
    { Header: 'Datei', accessor: 'datei', width: 230, Cell: ({ row }: Cell) => <div><b>{row.original.datei}</b><br /><Text>{row.original.tabelle}</Text></div> },
    { Header: 'Status', accessor: 'status', width: 140, Cell: ({ row }: Cell) => <ObjectStatus state={row.original.state}>{row.original.status}</ObjectStatus> },
    { Header: 'Sätze', accessor: 'anzahl', width: 80, hAlign: 'End' },
    { Header: 'davon neu', accessor: 'neu', width: 90, hAlign: 'End' },
    { Header: 'Hinweis', accessor: 'hinweis' },
  ], []);
  const rows = status ?? [];

  return (
    <Dialog open={open} headerText="CSV-Import" onClose={onClose} style={{ width: 'min(68rem, 95vw)' }}
            footer={<Bar endContent={<>
              <Button design="Emphasized" icon="upload-to-cloud" loading={busy}
                      disabled={!status?.some((s) => s.status === 'eingelesen')} onClick={start}>Importieren</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      <MessageStrip hideCloseButton style={{ marginBottom: '0.75rem' }}>
        Die SAP-Exporte Aufträge, Aufträge_POs und Adressen gemeinsam auswählen (optional Träger, Produkte, Wertelisten) –
        sie werden sofort eingelesen und am Spaltenkopf erkannt. Beim Import werden nur neue Sätze angelegt,
        vorhandene bleiben unverändert (leere Adressen werden ergänzt).
      </MessageStrip>
      {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
      <AblageFlaeche ziel={{ titel: 'SAP-Import', annehmen: (f) => { add(f); } }} accept=".csv,text/csv" groesse="Dialog"
                     titel="CSV-Dateien hier ablegen" text="Hierher ziehen oder klicken zum Auswählen – sie werden sofort eingelesen und am Spaltenkopf erkannt." />
      <FlexBox alignItems="Center" style={{ gap: '1rem', margin: '0.75rem 0' }}>
        <Text>{files.length ? files.map((f) => f.name).join(', ') : 'Noch keine Dateien ausgewählt'}</Text>
      </FlexBox>
      <AnalyticalTable minRows={1} columns={columns} data={rows} visibleRows={Math.max(rows.length, 1)} scaleWidthMode="Smart" />
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

