import { useMemo, useState } from 'react';
import {
  AnalyticalTable, Button, DatePicker, Icon, Input, Label, Link, MessageStrip, ObjectStatus, Text,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { FieldBox } from '@core/components/FormFields';
import { useSession } from '@core/session';
import { AblageFlaeche, useAblageZiel } from '@core/ablage';
import { LEER, MetaFelder, metaFuerUpload, vorgabeLesen, vorgabeSpeichern, type Stamm, type Vorgabe } from './MetaFelder';
import './ablage.css';
import { Section } from '@core/components/Section';
import { useLoad } from '@core/components/useLoad';
import { toast } from '@core/toast';
import { TCO, dat, dateiLesen } from '../util';

export const UP = `${TCO}/upload`;

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
 * Dateien über das Ablagefeld der Seite (ziehen oder klicken), das Ablagefeld der Navigation oder Strg+V (Screenshot).
 * Metadaten wie im Ablagefeld der Navigation (gemeinsame Voreinstellung; neuer Korrespondent per Eingabe).
 */
export function Upload() {
  const { me } = useSession();
  const { data: stamm, error: ladeFehler, reload: stammNeu } = useLoad(() => api.get<Stamm>(`${UP}/stamm`));
  const [dateien, setDateien] = useState<Datei[]>([]);
  const [inhalte] = useState(() => new Map<string, string>());
  // Start mit der Voreinstellung des Ablagefelds
  const [meta, setMeta] = useState<Vorgabe & { datum: string }>(() => ({ ...(vorgabeLesen(me.user.id) ?? LEER), datum: '' }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const datumStd = meta.datum || stamm?.heute || new Date().toISOString().slice(0, 10);

  async function hinzufuegen(files: FileList | File[] | null) {
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
            titel: d.titel, datum: d.datum || datumStd, ...metaFuerUpload(meta),
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
    // neu angelegte Korrespondenten/Tags in die Auswahl übernehmen
    if (meta.korrespondentNeu.trim() || meta.tagsNeu.trim()) { await stammNeu(); setMeta((m) => ({ ...m, korrespondentNeu: m.korrespondentNeu, tagsNeu: '' })); }
  }

  // Ablagefeld der Navigation und Strg+V legen auf dieser Seite in die Liste (nicht sofort nach Paperless)
  useAblageZiel(stamm?.paperless ? { titel: 'Dokumenten-Upload (Liste)', annehmen: async (f: File[]) => { await hinzufuegen(f); return `${f.length} Datei(en) zur Liste hinzugefügt – Metadaten prüfen und „Übertragen“.`; } } : null);


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
        <ObjectStatus state={row.original.state} icon={row.original.state === 'Positive' ? <Icon name="accept" /> : row.original.state === 'Negative' ? <Icon name="error" /> : undefined}>
          {value}{row.original.bereich && row.original.bereich !== 'FI Belege' ? ` · Hinweis: ${row.original.bereich}` : ''}
        </ObjectStatus>
      ),
    },
    { Header: '', id: 'aktion', width: 60, disableSortBy: true, Cell: ({ row }: Cell) => (row.original.docId ? null : <Button icon="decline" design="Transparent" disabled={busy} onClick={() => entfernen(row.original.key)} />) },
  ], [busy]); // eslint-disable-line react-hooks/exhaustive-deps

  const akzeptiert = (stamm?.dateitypen ?? ['pdf']).map((e) => `.${e}`).join(',');
  const fertig = dateien.filter((d) => d.docId).length;

  return (
    <AppPage title="Dokumenten-Upload" subtitle="Mehrere Belege mit Metadaten nach Paperless übertragen – auch per Drag & Drop"
             actions={<>
               <Button icon="upload-to-cloud" design="Emphasized" loading={busy} disabled={!offen.length || !stamm?.paperless} onClick={uebertragen}>
                 {offen.length ? `${offen.length} Datei(en) übertragen` : 'Übertragen'}
               </Button>
               <Button icon="delete" design="Transparent" disabled={busy || !dateien.length} onClick={leeren}>Liste zurücksetzen</Button>
             </>}>
      {(error || ladeFehler) && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error ?? ladeFehler}</MessageStrip>}
      {stamm && !stamm.paperless && <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>Paperless ist nicht eingerichtet (Administration → Anbindungen).</MessageStrip>}
      <Section title="Metadaten für alle Dateien"
               actions={<>
                 <Button design="Transparent" icon="download" tooltip="Voreinstellung des Ablagefelds übernehmen"
                         onClick={() => { const v = vorgabeLesen(me.user.id); if (v) { setMeta({ ...v, datum: meta.datum }); toast('Voreinstellung übernommen'); } else toast('Noch keine Voreinstellung gespeichert'); }}>Voreinstellung laden</Button>
                 <Button design="Transparent" icon="save" tooltip="Diese Angaben als Voreinstellung für das Ablagefeld speichern" disabled={!meta.doktyp}
                         onClick={() => { const { datum: _d, ...v } = meta; vorgabeSpeichern(me.user.id, v); toast('Als Voreinstellung für das Ablagefeld gespeichert'); }}>Als Voreinstellung speichern</Button>
               </>}>
        {stamm && (
          <div className="portal-up__grid">
            <MetaFelder stamm={stamm} v={meta} onChange={(v) => setMeta({ ...v, datum: meta.datum })} />
            <FieldBox label="Dokumentdatum (Vorschlag je Datei)">
              <DatePicker style={{ width: '100%' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={datumStd}
                          onChange={(e) => { setMeta({ ...meta, datum: e.detail.value }); setDateien((l) => l.map((d) => (d.docId ? d : { ...d, datum: e.detail.value || datumStd }))); }} />
            </FieldBox>
          </div>
        )}
      </Section>
      {stamm?.paperless && (
        <AblageFlaeche ziel={{ titel: 'Dokumenten-Upload (Liste)', annehmen: (f) => { if (!busy) hinzufuegen(f); } }} accept={akzeptiert}
                       groesse={dateien.length ? 'Dot' : 'Spot'} titel="Dateien hier ablegen"
                       text="Hierher ziehen, klicken zum Auswählen oder Screenshot mit Strg+V – die Dateien landen in der Liste und werden erst mit „Übertragen“ an Paperless gegeben." />
      )}
      <Section title="Dateien" count={dateien.length} flush
               status={fertig ? <Text className="portal-muted">{fertig} übertragen</Text> : undefined}>
        <AnalyticalTable minRows={1} columns={columns} data={dateien} visibleRows={Math.max(dateien.length, 1)} noDataText="Noch keine Dateien – ins Ablagefeld oben ziehen oder dort klicken (PDF, Bilder, CSV, Office; max. 50 MB je Datei)"
                         withRowHighlight highlightField={(r: Record<string, any>) => r.state} />
      </Section>
      <MessageStrip hideCloseButton>
        Die Dateien werden im Browser gelesen und einzeln an Paperless übergeben; der Titel ist mit dem Dateinamen vorbelegt. Fehlende Korrespondenten und Tags werden in Paperless angelegt.
        Ein Hinweis in der Statusspalte zeigt CSV-Dateien, die eigentlich in eine App gehören (Jugendabrechnung, Mitglieder, Hallen-/Clubhausabrechnung → <Link href="/tco/stammdaten">Übernahme aus SAP</Link>).
      </MessageStrip>
    </AppPage>
  );
}
