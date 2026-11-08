import { useMemo, useState } from 'react';
import {
  AnalyticalTable, Button, DatePicker, FileUploader, Input, Label, Link, MessageStrip, MultiComboBox, MultiComboBoxItem, ObjectStatus, Option,
  Select, Text,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { FieldBox, FormGrid, TextField } from '@core/components/FormFields';
import { Section } from '@core/components/Section';
import { useLoad } from '@core/components/useLoad';
import { toast } from '@core/toast';
import { TCO, dat, dateiLesen } from '../util';

export const UP = `${TCO}/upload`;

interface Eintrag { id: number; name: string }
interface Stamm { paperless: boolean; dokumenttypen: Eintrag[]; korrespondenten: Eintrag[]; tags: Eintrag[]; speicherpfade: Eintrag[]; heute: string; dateitypen: string[] }
interface Datei {
  key: string; name: string; mime: string; bytes: number; titel: string; datum: string;
  state: 'None' | 'Information' | 'Positive' | 'Critical' | 'Negative'; status: string; docId: number | null; bereich: string;
}
interface Ergebnis { id: number | null; text: string; state: 'Positive' | 'Critical' | 'Negative'; groesse: string; bereich: string }

const groesse = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} KB` : `${(b / 1048576).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`);
const ohneEndung = (n: string) => n.replace(/\.[^.]+$/, '');

/**
 * Dokumenten-Upload (Port von Z2UI5_CL_TCO_UPLOAD_MULTI): mehrere Belege wählen, gemeinsame Metadaten
 * (Dokumenttyp, Korrespondent, Datum, Tags, Speicherpfad) und je Datei Titel/Datum festlegen,
 * nacheinander nach Paperless übertragen; die Statusliste zeigt das Ergebnis je Datei.
 */
export function Upload() {
  const { data: stamm, error: ladeFehler, loading } = useLoad(() => api.get<Stamm>(`${UP}/stamm`));
  const [dateien, setDateien] = useState<Datei[]>([]);
  const [inhalte] = useState(() => new Map<string, string>());
  const [meta, setMeta] = useState({ doktyp: '', korrespondent: '', korrespondentNeu: '', datum: '', tags: [] as number[], tagsNeu: '', speicherpfad: '', notiz: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const datumStd = meta.datum || stamm?.heute || new Date().toISOString().slice(0, 10);

  async function hinzufuegen(files: FileList | null) {
    if (!files) return;
    const neu: Datei[] = [];
    for (const f of Array.from(files)) {
      const key = `${f.name}|${f.size}|${f.lastModified}`;
      if (dateien.some((d) => d.key === key)) continue;
      const e = (/\.([a-z0-9]+)$/i.exec(f.name)?.[1] ?? '').toLowerCase();
      const ok = (stamm?.dateitypen ?? []).includes(e);
      const zuGross = f.size > 50 * 1024 * 1024;
      if (ok && !zuGross) inhalte.set(key, await dateiLesen(f));
      neu.push({
        key, name: f.name, mime: f.type, bytes: f.size, titel: ohneEndung(f.name), datum: datumStd, docId: null, bereich: '',
        state: ok && !zuGross ? 'None' : 'Negative',
        status: !ok ? `Dateityp „${e || '?'}“ nicht erlaubt` : zuGross ? 'größer als 50 MB' : 'bereit',
      });
    }
    setDateien([...dateien, ...neu]);
  }
  const setDatei = (key: string, p: Partial<Datei>) => setDateien((l) => l.map((d) => (d.key === key ? { ...d, ...p } : d)));
  const entfernen = (key: string) => { inhalte.delete(key); setDateien((l) => l.filter((d) => d.key !== key)); };
  const leeren = () => { inhalte.clear(); setDateien([]); };

  const offen = dateien.filter((d) => d.state === 'None' || d.state === 'Negative' && inhalte.has(d.key));

  async function uebertragen() {
    if (!offen.length) { toast('Keine Dateien vorhanden'); return; }
    setBusy(true); setError(null);
    let ok = 0, bytes = 0;
    for (const d of offen) {
      setDatei(d.key, { state: 'Information', status: 'wird übertragen …' });
      try {
        const r = await api.post<Ergebnis>(`${UP}/datei`, {
          datei: d.name, inhalt: inhalte.get(d.key), meta: {
            titel: d.titel, datum: d.datum || datumStd, doktyp: meta.doktyp ? Number(meta.doktyp) : null,
            korrespondent: meta.korrespondent ? Number(meta.korrespondent) : null, korrespondentNeu: meta.korrespondentNeu,
            tags: meta.tags, tagsNeu: meta.tagsNeu.split(',').map((t) => t.trim()).filter(Boolean),
            speicherpfad: meta.speicherpfad ? Number(meta.speicherpfad) : null, notiz: meta.notiz,
          },
        });
        setDatei(d.key, { state: r.state, status: r.text, docId: r.id, bereich: r.bereich });
        if (r.state !== 'Negative') { ok++; bytes += d.bytes; inhalte.delete(d.key); }
      } catch (e) {
        setDatei(d.key, { state: 'Negative', status: (e as Error).message });
      }
    }
    setBusy(false);
    toast(`${ok} von ${offen.length} Datei(en), ${groesse(bytes)} insgesamt übertragen`, 5000);
  }

  const columns = useMemo<AnalyticalTableColumnDefinition[]>(() => [
    { Header: 'Dateiname', accessor: 'name', minWidth: 200, Cell: ({ row, value }: Cell) => <div style={{ lineHeight: 1.3 }}><Text style={{ fontWeight: 'bold' }}>{value}</Text><br /><Label>{row.original.mime || 'unbekannter Typ'}</Label></div> },
    {
      Header: 'Titel in Paperless', accessor: 'titel', minWidth: 220,
      Cell: ({ row }: Cell) => (row.original.docId || row.original.state === 'Information'
        ? <Text>{row.original.titel}</Text>
        : <Input style={{ width: '100%' }} value={row.original.titel} disabled={busy} onInput={(e) => setDatei(row.original.key, { titel: e.target.value })} />),
    },
    {
      Header: 'Dokumentdatum', accessor: 'datum', width: 160,
      Cell: ({ row }: Cell) => (row.original.docId || row.original.state === 'Information'
        ? <Text>{dat(row.original.datum)}</Text>
        : <DatePicker style={{ width: '100%' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={row.original.datum} disabled={busy}
                      onChange={(e) => setDatei(row.original.key, { datum: e.detail.value })} />),
    },
    { Header: 'Größe', accessor: 'bytes', width: 90, hAlign: 'End', Cell: ({ value }: Cell) => groesse(value) },
    {
      Header: 'Status', accessor: 'status', minWidth: 220,
      Cell: ({ row, value }: Cell) => (
        <ObjectStatus state={row.original.state} icon={row.original.state === 'Positive' ? 'accept' : row.original.state === 'Negative' ? 'error' : undefined}>
          {value}{row.original.bereich && row.original.bereich !== 'FI Belege' ? ` · Hinweis: ${row.original.bereich}` : ''}
        </ObjectStatus>
      ),
    },
    { Header: '', id: 'aktion', width: 60, disableSortBy: true, Cell: ({ row }: Cell) => (row.original.docId ? null : <Button icon="decline" design="Transparent" disabled={busy} onClick={() => entfernen(row.original.key)} />) },
  ], [busy]); // eslint-disable-line react-hooks/exhaustive-deps

  const akzeptiert = (stamm?.dateitypen ?? ['pdf']).map((e) => `.${e}`).join(',');
  const fertig = dateien.filter((d) => d.docId).length;

  return (
    <AppPage title="Dokumenten-Upload" subtitle="Mehrere Belege mit Metadaten nach Paperless übertragen"
             actions={<>
               <FileUploader multiple hideInput accept={akzeptiert} onChange={(e) => hinzufuegen(e.detail.files)}>
                 <Button icon="add-document" disabled={busy || !stamm?.paperless}>Dateien wählen</Button>
               </FileUploader>
               <Button icon="upload-to-cloud" design="Emphasized" loading={busy} disabled={!offen.length || !stamm?.paperless} onClick={uebertragen}>
                 {offen.length ? `${offen.length} Datei(en) übertragen` : 'Übertragen'}
               </Button>
               <Button icon="delete" design="Transparent" disabled={busy || !dateien.length} onClick={leeren}>Liste zurücksetzen</Button>
             </>}>
      {(error || ladeFehler) && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error ?? ladeFehler}</MessageStrip>}
      {stamm && !stamm.paperless && <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>Paperless ist nicht eingerichtet (Stammdaten → Anbindungen).</MessageStrip>}
      <Section title="Metadaten für alle Dateien">
        <FormGrid>
          <Auswahl label="Dokumenttyp" value={meta.doktyp} liste={stamm?.dokumenttypen ?? []} onChange={(v) => setMeta({ ...meta, doktyp: v })} />
          <Auswahl label="Korrespondent" value={meta.korrespondent} liste={stamm?.korrespondenten ?? []} onChange={(v) => setMeta({ ...meta, korrespondent: v, korrespondentNeu: v ? '' : meta.korrespondentNeu })} />
          <TextField label="… oder neuen Korrespondenten anlegen" value={meta.korrespondentNeu} readonly={!!meta.korrespondent} placeholder="Name des Korrespondenten"
                     onChange={(v) => setMeta({ ...meta, korrespondentNeu: v })} />
          <FieldBox label="Dokumentdatum (Vorschlag je Datei)">
            <DatePicker style={{ width: '100%' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={datumStd}
                        onChange={(e) => { setMeta({ ...meta, datum: e.detail.value }); setDateien((l) => l.map((d) => (d.docId ? d : { ...d, datum: e.detail.value || datumStd }))); }} />
          </FieldBox>
          <FieldBox label="Tags">
            <MultiComboBox style={{ width: '100%' }} placeholder="keine" disabled={loading}
                           onSelectionChange={(e) => setMeta({ ...meta, tags: e.detail.items.map((i) => Number((i as HTMLElement).dataset.id)) })}>
              {(stamm?.tags ?? []).map((t) => <MultiComboBoxItem key={t.id} data-id={t.id} text={t.name} selected={meta.tags.includes(t.id)} />)}
            </MultiComboBox>
          </FieldBox>
          <TextField label="Neue Tags (durch Komma getrennt)" value={meta.tagsNeu} onChange={(v) => setMeta({ ...meta, tagsNeu: v })} placeholder="z.B. Beleg 2026, Clubhaus" />
          <Auswahl label="Speicherpfad" value={meta.speicherpfad} liste={stamm?.speicherpfade ?? []} onChange={(v) => setMeta({ ...meta, speicherpfad: v })} leer="– Standard von Paperless –" />
          <TextField label="Notiz (wird an jedes Dokument angehängt)" value={meta.notiz} onChange={(v) => setMeta({ ...meta, notiz: v })} />
        </FormGrid>
      </Section>
      <Section title="Dateien" count={dateien.length} flush
               status={fertig ? <Text className="portal-muted">{fertig} übertragen</Text> : undefined}>
        <AnalyticalTable columns={columns} data={dateien} visibleRows={Math.max(dateien.length, 3)} noDataText="Noch keine Dateien ausgewählt – „Dateien wählen“ (PDF, Bilder, CSV, Office; max. 50 MB je Datei)"
                         withRowHighlight highlightField={(r: Record<string, any>) => r.state} />
      </Section>
      <MessageStrip hideCloseButton>
        Die Dateien werden im Browser gelesen und einzeln an Paperless übergeben; der Titel ist mit dem Dateinamen vorbelegt. Fehlende Korrespondenten und Tags werden in Paperless angelegt.
        Ein Hinweis in der Statusspalte zeigt CSV-Dateien, die eigentlich in eine App gehören (Jugendabrechnung, Mitglieder, Hallen-/Clubhausabrechnung → <Link href="/tco/stammdaten">Übernahme aus SAP</Link>).
      </MessageStrip>
    </AppPage>
  );
}

function Auswahl({ label, value, liste, onChange, leer = '– keine Angabe –' }: { label: string; value: string; liste: Eintrag[]; onChange: (v: string) => void; leer?: string }) {
  return (
    <FieldBox label={label}>
      <Select style={{ width: '100%' }} onChange={(e) => onChange((e.detail.selectedOption as HTMLElement).dataset.k ?? '')}>
        <Option data-k="" selected={!value}>{leer}</Option>
        {liste.map((x) => <Option key={x.id} data-k={String(x.id)} selected={String(x.id) === value}>{x.name}</Option>)}
      </Select>
    </FieldBox>
  );
}
