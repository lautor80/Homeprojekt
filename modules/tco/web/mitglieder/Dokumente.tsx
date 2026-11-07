import { useEffect, useMemo, useState } from 'react';
import {
  AnalyticalTable, Button, CheckBox, FileUploader, Label, Link, MessageStrip, Option, Select, Text, TextArea, Title, Toolbar, ToolbarSpacer,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { FormGrid, TextField } from '@core/components/FormFields';
import { download, PdfDialog } from '@core/components/PdfDialog';
import { toast } from '@core/toast';
import { dat, dateiLesen } from '../util';
import { MG, type Dok } from './typen';
import { Auswahlfeld, Dlg } from './Dialoge';

interface Antwort { paperless: boolean; soll: string; korrespondent: { id: number; name: string } | null; dokumente: Dok[] }
interface Notiz { id: number; text: string; erstellt: string; von: string }

/** Paperless-Dokumente des Mitglieds (Korrespondent „Nachname Vorname“) mit Jahresfilter, Auswahl, Notizen und Upload */
export function Dokumente({ adrnr, edit, sel, onSel, onError, onKomm }: {
  adrnr: string; edit: boolean; sel: number[]; onSel: (ids: number[]) => void; onError: (t: string) => void; onKomm: () => void;
}) {
  const [d, setD] = useState<Antwort | null>(null);
  const [jahr, setJahr] = useState('');
  const [ansicht, setAnsicht] = useState<Dok | null>(null);
  const [notizen, setNotizen] = useState<Dok | null>(null);
  const [upload, setUpload] = useState<{ datei: string; inhalt: string; groesse: number } | null>(null);
  const laden = () => api.get<Antwort>(`${MG}/m/${adrnr}/dokumente`).then(setD).catch((e) => onError(e.message));
  useEffect(() => { laden(); }, [adrnr]); // eslint-disable-line react-hooks/exhaustive-deps

  const jahre = useMemo(() => [...new Set((d?.dokumente ?? []).map((x) => x.erstellt.slice(0, 4)).filter(Boolean))].sort().reverse(), [d]);
  const rows = (d?.dokumente ?? []).filter((x) => !jahr || x.erstellt.startsWith(jahr));
  const istPdf = (x: Dok) => x.mime === 'application/pdf' || /\.pdf$/i.test(x.datei) || !x.datei;
  const oeffnen = (x: Dok) => (istPdf(x) ? setAnsicht(x) : download(`${MG}/dokument/${x.id}/datei`, x.datei).catch((e) => onError(e.message)));
  const toggle = (id: number, an: boolean) => onSel(an ? [...new Set([...sel, id])] : sel.filter((x) => x !== id));
  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: '', id: 'sel', width: 50, Cell: ({ row }: Cell) => <CheckBox checked={sel.includes(row.original.id)} onChange={(e) => toggle(row.original.id, e.target.checked)} /> },
    { Header: 'Titel', accessor: 'titel', minWidth: 200, Cell: ({ row, value }: Cell) => <Link onClick={() => oeffnen(row.original)}>{value}</Link> },
    { Header: 'Dokumenttyp', accessor: 'typ', minWidth: 150 },
    { Header: 'Datum', accessor: 'erstellt', width: 105, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Dok-Nr.', accessor: 'id', width: 85, hAlign: 'End' },
    {
      Header: 'Notizen', accessor: 'notizen', width: 100,
      Cell: ({ row, value }: Cell) => <Button design="Transparent" icon="notes" onClick={() => setNotizen(row.original)}>{String(value)}</Button>,
    },
  ];

  if (!d) return <Text>Lade Dokumente aus Paperless …</Text>;
  if (!d.paperless) return <MessageStrip hideCloseButton design="Critical">Paperless ist nicht eingerichtet (Stammdaten → Anbindungen).</MessageStrip>;
  return (
    <>
      <Toolbar design="Transparent">
        <Title level="H5">Dokumente ({rows.length})</Title>
        <Label>Jahr</Label>
        <Select style={{ width: '7rem' }} onChange={(e) => setJahr((e.detail.selectedOption as HTMLElement).dataset.j ?? '')}>
          <Option data-j="" selected={!jahr}>alle</Option>
          {jahre.map((j) => <Option key={j} data-j={j} selected={j === jahr}>{j}</Option>)}
        </Select>
        <ToolbarSpacer />
        <Button icon="refresh" design="Transparent" onClick={laden}>Aktualisieren</Button>
        <Button icon="email" disabled={!sel.length} onClick={onKomm}>{sel.length ? `${sel.length} markierte senden` : 'Markierte senden'}</Button>
        {edit && (
          <FileUploader hideInput onChange={async (e) => {
            const f = e.detail.files?.[0];
            if (f) setUpload({ datei: f.name, inhalt: await dateiLesen(f), groesse: f.size });
          }}><Button icon="upload">Datei ablegen</Button></FileUploader>
        )}
      </Toolbar>
      {!d.korrespondent && <MessageStrip hideCloseButton style={{ marginBottom: '0.5rem' }}>In Paperless gibt es noch keinen Korrespondenten „{d.soll}“ – er wird beim ersten Ablegen angelegt.</MessageStrip>}
      <AnalyticalTable columns={columns} data={rows} visibleRows={Math.max(rows.length, 1)} minRows={1} noDataText="Keine Dokumente in Paperless" />
      {ansicht && <PdfDialog url={`${MG}/dokument/${ansicht.id}/datei`} title={ansicht.titel} filename={ansicht.datei || `${ansicht.titel}.pdf`} onClose={() => setAnsicht(null)} />}
      {notizen && <NotizDialog dok={notizen} edit={edit} onClose={(neu) => { setNotizen(null); if (neu) laden(); }} />}
      {upload && <UploadDialog adrnr={adrnr} f={upload} onClose={(t) => { setUpload(null); if (t) { toast(t, 5000); laden(); } }} />}
    </>
  );
}

function NotizDialog({ dok, edit, onClose }: { dok: Dok; edit: boolean; onClose: (neu: boolean) => void }) {
  const [n, setN] = useState<Notiz[] | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [neu, setNeu] = useState(false);
  const laden = () => api.get<Notiz[]>(`${MG}/dokument/${dok.id}/notizen`).then(setN).catch((e) => setError(e.message));
  useEffect(() => { laden(); }, [dok.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dlg titel={`Notizen – ${dok.titel}`} onClose={() => onClose(neu)}
         fuss={edit ? <Button design="Emphasized" disabled={!text.trim()} onClick={async () => {
           try { await api.post(`${MG}/dokument/${dok.id}/notizen`, { text }); setText(''); setNeu(true); laden(); } catch (e) { setError((e as Error).message); }
         }}>Notiz anhängen</Button> : null}>
      {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
      {n && !n.length && <Text>Keine Notizen.</Text>}
      {n?.map((x) => (
        <div key={x.id} style={{ borderBottom: '1px solid var(--sapList_BorderColor)', padding: '0.4rem 0' }}>
          <Label>{new Date(x.erstellt).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}{x.von ? ` · ${x.von}` : ''}</Label>
          <Text style={{ display: 'block', whiteSpace: 'pre-wrap' }}>{x.text}</Text>
        </div>
      ))}
      {edit && <TextArea rows={3} style={{ width: '100%', marginTop: '0.5rem' }} placeholder="Neue Notiz" value={text} onInput={(e) => setText(e.target.value)} />}
    </Dlg>
  );
}

function UploadDialog({ adrnr, f, onClose }: { adrnr: string; f: { datei: string; inhalt: string; groesse: number }; onClose: (t: string | null) => void }) {
  const [typen, setTypen] = useState<{ id: number; name: string }[]>([]);
  const [v, setV] = useState({ titel: f.datei.replace(/\.[^.]+$/, ''), doktyp: '', notiz: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.get<{ id: number; name: string }[]>(`${MG}/doktypen`).then(setTypen).catch((e) => setError(e.message)); }, []);
  return (
    <Dlg titel="Dokument in Paperless ablegen" onClose={() => onClose(null)}
         fuss={<Button design="Emphasized" disabled={busy || !v.doktyp} onClick={async () => {
           setBusy(true);
           try {
             const r = await api.post<{ text: string }>(`${MG}/m/${adrnr}/dokumente`, { datei: f.datei, inhalt: f.inhalt, titel: v.titel, doktyp: Number(v.doktyp), notiz: v.notiz });
             onClose(r.text);
           } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
         }}>Übertragen</Button>}>
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <FormGrid>
        <TextField label="Datei" readonly value={`${f.datei} (${Math.max(1, Math.round(f.groesse / 1024))} KB)`} wide />
        <TextField label="Titel" value={v.titel} onChange={(x) => setV({ ...v, titel: x })} wide />
        <Auswahlfeld label="Dokumenttyp" required wide value={v.doktyp} optionen={[['', '– bitte wählen –'], ...typen.map((t) => [String(t.id), t.name] as [string, string])]}
                     onChange={(x) => setV({ ...v, doktyp: x })} />
        <TextField label="Notiz (optional)" multiline wide value={v.notiz} onChange={(x) => setV({ ...v, notiz: x })} />
      </FormGrid>
      <MessageStrip hideCloseButton style={{ marginTop: '0.5rem' }}>Dokumentdatum ist heute, Speicherpfad „Mitglieder“, Korrespondent ist das Mitglied.</MessageStrip>
    </Dlg>
  );
}
