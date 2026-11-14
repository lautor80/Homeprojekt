import { useEffect, useMemo, useState } from 'react';
import {
  AnalyticalTable, Button, CheckBox, Icon, Input, Label, Link, MessageStrip, Option, Select, Text, TextArea, Title, Toolbar, ToolbarSpacer,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { FormGrid, TextField } from '@core/components/FormFields';
import { download, PdfDialog } from '@core/components/PdfDialog';
import { toast } from '@core/toast';
import { AblageFlaeche } from '@core/ablage';
import { dat, dateiLesen } from '../util';
import { MG, type Dok } from './typen';
import { Auswahlfeld, Dlg } from './Dialoge';

interface Antwort { paperless: boolean; soll: string; korrespondent: { id: number; name: string } | null; dokumente: Dok[] }
interface Notiz { id: number; text: string; erstellt: string; von: string }

/** Paperless-Dokumente des Mitglieds (Korrespondent „Nachname Vorname“) mit Jahresfilter, Auswahl, Notizen und Upload */
export function Dokumente({ adrnr, edit, sel, onSel, onError, onKomm, eingang = [], onEingang, onErledigt }: {
  adrnr: string; edit: boolean; sel: number[]; onSel: (ids: number[]) => void; onError: (t: string) => void; onKomm: () => void;
  /** abgelegte Dateien (Drag & Drop, Strg+V), werden nacheinander mit Dokumenttyp abgefragt */
  eingang?: File[]; onEingang?: (f: File[]) => void; onErledigt?: () => void;
}) {
  const [d, setD] = useState<Antwort | null>(null);
  // Standard: nur das laufende Jahr (sonst werden es schnell zu viele Einträge)
  const aktJahr = String(new Date().getFullYear());
  const [jahr, setJahr] = useState(aktJahr);
  const [typ, setTyp] = useState('');
  const [suche, setSuche] = useState('');
  const [ansicht, setAnsicht] = useState<Dok | null>(null);
  const [notizen, setNotizen] = useState<Dok | null>(null);
  const [upload, setUpload] = useState<{ datei: string; inhalt: string; groesse: number } | null>(null);
  const laden = () => api.get<Antwort>(`${MG}/m/${adrnr}/dokumente`).then(setD).catch((e) => onError(e.message));
  useEffect(() => { laden(); }, [adrnr]); // eslint-disable-line react-hooks/exhaustive-deps
  // nächste abgelegte Datei in den Ablage-Dialog übernehmen
  const naechste = eingang[0];
  useEffect(() => {
    if (!naechste || upload) return;
    dateiLesen(naechste).then((inhalt) => setUpload({ datei: naechste.name, inhalt, groesse: naechste.size }));
  }, [naechste, upload]); // eslint-disable-line react-hooks/exhaustive-deps

  const alle = d?.dokumente ?? [];
  const jahre = useMemo(() => [...new Set([aktJahr, ...alle.map((x) => x.erstellt.slice(0, 4)).filter(Boolean)])].sort().reverse(), [d]); // eslint-disable-line react-hooks/exhaustive-deps
  const typen = useMemo(() => [...new Set(alle.map((x) => x.typ).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de')), [d]); // eslint-disable-line react-hooks/exhaustive-deps
  // Freitext: alle Wörter müssen in Titel, Dokumenttyp, Dok-Nr. oder Datum vorkommen
  const woerter = suche.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const passt = (x: Dok) => {
    const t = `${x.titel} ${x.typ ?? ''} ${x.id} ${dat(x.erstellt)} ${x.datei ?? ''}`.toLowerCase();
    return woerter.every((w) => t.includes(w));
  };
  const rows = alle.filter((x) => (!jahr || x.erstellt.startsWith(jahr)) && (!typ || x.typ === typ) && passt(x));
  const gefiltert = rows.length !== alle.length;
  const istPdf = (x: Dok) => x.mime === 'application/pdf' || /\.pdf$/i.test(x.datei) || !x.datei;
  const oeffnen = (x: Dok) => (istPdf(x) ? setAnsicht(x) : download(`${MG}/dokument/${x.id}/datei`, x.datei).catch((e) => onError(e.message)));
  const gesperrt = 'Enthält Bankdaten – Öffnen und Versenden nur mit der Berechtigung „Bankdaten von Personen“';
  const toggle = (id: number, an: boolean) => onSel(an ? [...new Set([...sel, id])] : sel.filter((x) => x !== id));
  const columns: AnalyticalTableColumnDefinition[] = [
    {
      Header: '', id: 'sel', width: 50,
      Cell: ({ row }: Cell) => <CheckBox disabled={row.original.gesperrt} checked={sel.includes(row.original.id)} onChange={(e) => toggle(row.original.id, e.target.checked)} />,
    },
    {
      Header: 'Titel', accessor: 'titel', minWidth: 200,
      Cell: ({ row, value }: Cell) => (row.original.gesperrt
        ? <span title={gesperrt} className="portal-row"><Icon name="locked" style={{ width: '0.875rem', height: '0.875rem', color: 'var(--sapContent_LabelColor)' }} />{value}</span>
        : <Link onClick={() => oeffnen(row.original)}>{value}</Link>),
    },
    { Header: 'Dokumenttyp', accessor: 'typ', minWidth: 150 },
    { Header: 'Datum', accessor: 'erstellt', width: 105, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Dok-Nr.', accessor: 'id', width: 85, hAlign: 'End' },
    {
      Header: 'Notizen', accessor: 'notizen', width: 100,
      Cell: ({ row, value }: Cell) => <Button design="Transparent" icon="notes" disabled={row.original.gesperrt} onClick={() => setNotizen(row.original)}>{String(value)}</Button>,
    },
  ];

  if (!d) return <Text>Lade Dokumente aus Paperless …</Text>;
  if (!d.paperless) return <MessageStrip hideCloseButton design="Critical">Paperless ist nicht eingerichtet (Administration → Schnittstellen → Anbindungen).</MessageStrip>;
  return (
    <>
      <Toolbar design="Transparent">
        <Title level="H5">Dokumente ({gefiltert ? `${rows.length} von ${alle.length}` : alle.length})</Title>
        <Label>Jahr</Label>
        <Select style={{ width: '7rem' }} onChange={(e) => setJahr((e.detail.selectedOption as HTMLElement).dataset.j ?? '')}>
          <Option data-j="" selected={!jahr}>alle</Option>
          {jahre.map((j) => <Option key={j} data-j={j} selected={j === jahr}>{j}</Option>)}
        </Select>
        <Label>Dokumentart</Label>
        <Select style={{ width: '12rem' }} onChange={(e) => setTyp((e.detail.selectedOption as HTMLElement).dataset.t ?? '')}>
          <Option data-t="" selected={!typ}>alle</Option>
          {typen.map((t) => <Option key={t} data-t={t} selected={t === typ}>{t}</Option>)}
        </Select>
        <Input value={suche} placeholder="Titel, Dok-Nr., Datum …" showClearIcon style={{ width: '14rem' }} data-kein-autofill
               icon={<Icon name="search" />} onInput={(e) => setSuche(e.target.value)} />
        <ToolbarSpacer />
        <Button icon="refresh" design="Transparent" onClick={laden}>Aktualisieren</Button>
        <Button icon="email" disabled={!sel.length} onClick={onKomm}>{sel.length ? `${sel.length} markierte senden` : 'Markierte senden'}</Button>
      </Toolbar>
      {!d.korrespondent && <MessageStrip hideCloseButton style={{ marginBottom: '0.5rem' }}>In Paperless gibt es noch keinen Korrespondenten „{d.soll}“ – er wird beim ersten Ablegen angelegt.</MessageStrip>}
      {edit && onEingang && (
        <div style={{ marginBottom: '0.5rem' }}>
          <AblageFlaeche ziel={{ titel: 'Dokumente des Mitglieds', annehmen: (f) => onEingang(f) }} groesse={alle.length ? 'Dot' : 'Spot'}
                         titel="Dokumente hier ablegen"
                         text="Hierher ziehen, klicken zum Auswählen oder Screenshot mit Strg+V – danach je Datei Titel und Dokumenttyp wählen, abgelegt wird in Paperless beim Mitglied." />
        </div>
      )}
      {edit && onEingang
        ? <AblageFlaeche ziel={{ titel: 'Dokumente des Mitglieds', annehmen: (f) => onEingang(f) }}>
            <AnalyticalTable columns={columns} data={rows} visibleRows={Math.max(rows.length, 1)} minRows={1} noDataText={alle.length ? 'Keine Dokumente zum Filter – Jahr „alle“ wählen oder Suche leeren' : 'Keine Dokumente in Paperless – Datei hierher ziehen oder Screenshot mit Strg+V einfügen'} />
          </AblageFlaeche>
        : <AnalyticalTable columns={columns} data={rows} visibleRows={Math.max(rows.length, 1)} minRows={1} noDataText={alle.length ? 'Keine Dokumente zum Filter – Jahr „alle“ wählen oder Suche leeren' : 'Keine Dokumente in Paperless'} />}
      {ansicht && <PdfDialog url={`${MG}/dokument/${ansicht.id}/datei`} title={ansicht.titel} filename={ansicht.datei || `${ansicht.titel}.pdf`} onClose={() => setAnsicht(null)} />}
      {notizen && <NotizDialog dok={notizen} edit={edit} onClose={(neu) => { setNotizen(null); if (neu) laden(); }} />}
      {upload && <UploadDialog adrnr={adrnr} f={upload} rest={Math.max(0, eingang.length - 1)}
                               onClose={(t) => { setUpload(null); if (eingang.length) onErledigt?.(); if (t) { toast(t, 5000); laden(); } }} />}
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

function UploadDialog({ adrnr, f, rest = 0, onClose }: { adrnr: string; f: { datei: string; inhalt: string; groesse: number }; rest?: number; onClose: (t: string | null) => void }) {
  const [typen, setTypen] = useState<{ id: number; name: string }[]>([]);
  const [v, setV] = useState({ titel: f.datei.replace(/\.[^.]+$/, ''), doktyp: '', notiz: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.get<{ id: number; name: string }[]>(`${MG}/doktypen`).then(setTypen).catch((e) => setError(e.message)); }, []);
  return (
    <Dlg titel={`Dokument in Paperless ablegen${rest ? ` (noch ${rest} weitere)` : ''}`} onClose={() => onClose(null)}
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
