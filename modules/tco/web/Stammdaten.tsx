import { useEffect, useState } from 'react';
import {
  AnalyticalTable, Bar, Button, DatePicker, FlexBox, Label, MessageStrip, ObjectStatus, Panel, SegmentedButton,
  SegmentedButtonItem, Tab, TabContainer, Text,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { FieldBox, FormGrid, TextField } from '@core/components/FormFields';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { SperrHinweis, useSperre } from '@core/sperre';
import { AblageFlaeche } from '@core/ablage';
import { TCO, dateiLesen } from './util';

type Verein = Record<string, string | number | null>;

export function TcoStammdaten() {
  const can = useCan();
  return (
    <AppPage title="Stammdaten TC Oberthal" subtitle="Vereinsdaten für Ausdrucke, Einstellungen der Hallenabrechnung und der FI-Belege, Übernahme aus SAP">
      <TabContainer contentBackgroundDesign="Transparent">
        <Tab text="Verein und Anbindungen" selected><VereinTab /></Tab>
        {can('tco.import:execute') ? <Tab text="Übernahme aus SAP"><ImportTab /></Tab> : null}
      </TabContainer>
    </AppPage>
  );
}

function VereinTab() {
  const can = useCan();
  const sperre = useSperre('TCO_VEREIN', '1', can('tco.stammdaten:edit'), { bezeichnung: 'Vereinsdaten' });
  const ro = !can('tco.stammdaten:edit') || !sperre.eigen;
  const [v, setV] = useState<Verein | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.get<Verein>(`${TCO}/verein`).then(setV).catch((e) => setError(e.message)); }, []);
  if (!v) return error ? <MessageStrip design="Negative">{error}</MessageStrip> : null;
  const s = (k: string) => (x: string) => setV({ ...v, [k]: x });
  const t = (k: string) => (v[k] ?? '') as string;

  async function save() {
    setBusy(true); setError(null);
    try {
      await api.put(`${TCO}/verein`, v);
      toast('Vereinsdaten gesichert');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <SperrHinweis s={sperre} />
      <Panel headerText="Verein (Rechnungssteller)" fixed>
        <FormGrid>
          <TextField label="Name (auch Empfänger im GiroCode)" required value={t('name')} onChange={s('name')} readonly={ro} />
          <TextField label="Straße" value={t('strasse')} onChange={s('strasse')} readonly={ro} />
          <TextField label="PLZ / Ort" value={t('plz_ort')} onChange={s('plz_ort')} readonly={ro} />
          <TextField label="Ansprechpartner (Rechnung, Mailtexte)" value={t('ansprechpartner')} onChange={s('ansprechpartner')} readonly={ro} />
          <TextField label="Steuernummer" value={t('steuernr')} onChange={s('steuernr')} readonly={ro} />
          <TextField label="E-Mail" value={t('email')} onChange={s('email')} readonly={ro} />
          <TextField label="Bank" value={t('bank')} onChange={s('bank')} readonly={ro} />
          <TextField label="IBAN" value={t('iban')} onChange={s('iban')} readonly={ro} />
          <TextField label="BIC" value={t('bic')} onChange={s('bic')} readonly={ro} />
          <TextField label="Zahlungsziel Hallenrechnung (Tage)" type="Number" value={String(v.zahlungsziel_tage ?? 8)} onChange={s('zahlungsziel_tage')} readonly={ro} />
          <TextField label="Ansprechpartner in Mitglieder-Mails (eine Zeile je Person: Name – Aufgabe – Telefon)" multiline wide
                     value={t('mg_ansprechpartner')} onChange={s('mg_ansprechpartner')} readonly={ro} />
          <FieldBox label="Logo für das Kopfband (weiß auf Orange)">
            <FlexBox alignItems="Center" style={{ gap: '0.75rem', background: '#E2701F', padding: '0.5rem', borderRadius: '0.5rem', width: 'fit-content' }}>
              <img alt="Logo" src={(v.logo as string) || '/api/m/tco/logo'} style={{ height: '3rem' }} />
            </FlexBox>
            {!ro && (
              <FlexBox alignItems="Center" style={{ gap: '0.5rem' }}>
                <div style={{ flex: 1, maxWidth: '24rem' }}>
                  <AblageFlaeche ziel={{ titel: 'Vereinslogo', annehmen: async (fs) => { setV({ ...v, logo: await dateiLesen(fs[0]) }); } }} accept="image/png,image/jpeg"
                                 multiple={false} groesse="Dot" titel="Eigenes Logo hier ablegen" text="PNG oder JPEG hierher ziehen oder klicken zum Auswählen" />
                </div>
                {v.logo && <Button design="Transparent" icon="reset" onClick={() => setV({ ...v, logo: null })}>Vereinslogo</Button>}
              </FlexBox>
            )}
          </FieldBox>
        </FormGrid>
      </Panel>

      <Panel headerText="Anbindungen" fixed style={{ marginTop: '1rem' }}>
        <Text style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--sapContent_LabelColor)' }}>
          Zugänge werden zentral unter Administration → Schnittstellen → Anbindungen gepflegt (Adresse, Anmeldung, Verbindungstest, Mailprotokoll).
        </Text>
        <FlexBox wrap="Wrap" style={{ gap: '0.5rem 1.5rem' }}>
          {([['Paperless-ngx', v.paperless_url], ['E-Mail-Versand (n8n)', v.n8n_mail_url], ['Rückmeldungen Jugendtraining', v.n8n_stunden_url],
            ['Schulferien', v.n8n_ferien_url], ['EP3-Export', v.n8n_ep3_url]] as [string, unknown][]).map(([name, url]) => (
            <ObjectStatus key={name} state={url ? 'Positive' : 'None'} showDefaultIcon>{name}: {url ? 'eingerichtet' : 'nicht eingerichtet'}</ObjectStatus>
          ))}
        </FlexBox>
      </Panel>

      <Panel headerText="Hallenabrechnung" fixed style={{ marginTop: '1rem' }}>
        <FormGrid>
          <FieldBox label="Buchungen abrechnen ab (Datum nach)">
            <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={t('halle_stichtag')} readonly={ro} onChange={(e) => setV({ ...v, halle_stichtag: e.detail.value })} />
          </FieldBox>
          <TextField label="EP3-Namen ohne Abrechnung (durch Komma getrennt)" value={t('halle_ausschluss')} onChange={s('halle_ausschluss')} readonly={ro} />
          <TextField label="Plätze mit Abo-Abrechnung auch im Sommer 01.05.–30.09. (EP3-Platzname oder -Nummer, durch Komma)" value={t('halle_plaetze')} onChange={s('halle_plaetze')} readonly={ro} placeholder="Halle" />
        </FormGrid>
      </Panel>

      <Panel headerText="FI Belege" fixed style={{ marginTop: '1rem' }}>
        <FormGrid>
          <TextField label="Konten mit Bankdatei (CSV-Umsatzexport)" value={t('fi_bankkonten')} onChange={s('fi_bankkonten')} readonly={ro} placeholder="1200,654" />
          <TextField label="Kasse und Konten ohne Bankdatei (manuelle Buchung)" value={t('fi_manuell_konten')} onChange={s('fi_manuell_konten')} readonly={ro} placeholder="1000,1210,1220" />
          <TextField label="Paperless-Dokumenttypen offener Belege" value={t('fi_beleg_typen')} onChange={s('fi_beleg_typen')} readonly={ro} />
          <TextField label="Paperless-Speicherpfad offener Belege" value={t('fi_beleg_pfad')} onChange={s('fi_beleg_pfad')} readonly={ro} />
          <TextField label="Custom Field interne Belegnummer (Name oder ID)" value={t('fi_feld_beleg')} onChange={s('fi_feld_beleg')} readonly={ro} />
          <TextField label="Custom Field „SAP“ zugeordnet (Name oder ID)" value={t('fi_feld_sap')} onChange={s('fi_feld_sap')} readonly={ro} />
          <TextField label="Custom Field Betrag (Name oder ID)" value={t('fi_feld_betrag')} onChange={s('fi_feld_betrag')} readonly={ro} />
        </FormGrid>
      </Panel>

      <Bar style={{ marginTop: '1rem' }} endContent={<>
        <ChangeHistoryButton objectType="TCO_VEREIN" objectKey="1" />
        {!ro && <Button design="Emphasized" loading={busy} onClick={save}>Sichern</Button>}
      </>} />
    </>
  );
}

interface Ergebnis { datei: string; tabelle: string | null; saetze: number; neu: number; fehler: string[]; ignoriert: string[]; geschrieben?: number }

function ImportTab() {
  const [files, setFiles] = useState<{ name: string; data: string }[]>([]);
  const [modus, setModus] = useState<'neu' | 'aktualisieren'>('neu');
  const [rows, setRows] = useState<Ergebnis[]>([]);
  const [bestand, setBestand] = useState<{ tabelle: string; saetze: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fertig, setFertig] = useState(false);

  const ladeBestand = () => api.get<typeof bestand>(`${TCO}/import/tabellen`).then(setBestand).catch(() => undefined);
  useEffect(() => { ladeBestand(); }, []);

  async function add(list: FileList | File[] | null) {
    if (!list?.length) return;
    const neu = [...files];
    for (const f of Array.from(list)) {
      const data = await dateiLesen(f);
      const i = neu.findIndex((x) => x.name === f.name);
      if (i >= 0) neu[i] = { name: f.name, data }; else neu.push({ name: f.name, data });
    }
    setFiles(neu);
    setFertig(false);
    setBusy(true); setError(null);
    try { setRows(await api.post(`${TCO}/import/pruefen`, { dateien: neu, modus })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function ausfuehren() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<Ergebnis[]>(`${TCO}/import/ausfuehren`, { dateien: files, modus });
      setRows(r);
      setFertig(true);
      toast(`${r.reduce((s, x) => s + (x.geschrieben ?? 0), 0)} Sätze übernommen`, 5000);
      ladeBestand();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Datei', accessor: 'datei', minWidth: 180 },
    { Header: 'Tabelle', accessor: 'tabelle', width: 140, Cell: ({ value }: Cell) => (value ? `tco.${value}` : '–') },
    { Header: 'Sätze', accessor: 'saetze', width: 90, hAlign: 'End' },
    { Header: 'davon neu', accessor: 'neu', width: 100, hAlign: 'End' },
    { Header: 'übernommen', accessor: 'geschrieben', width: 110, hAlign: 'End' },
    {
      Header: 'Hinweise', id: 'hinweis', minWidth: 260,
      Cell: ({ row }: Cell) => {
        const r = row.original as Ergebnis;
        if (r.fehler.length) return <ObjectStatus state="Negative">{r.fehler.join(' · ')}</ObjectStatus>;
        return <Text>{r.ignoriert.length ? `nicht übernommene Spalten: ${r.ignoriert.join(', ').toUpperCase()}` : 'ok'}</Text>;
      },
    },
  ];

  return (
    <>
      <MessageStrip hideCloseButton style={{ marginBottom: '0.75rem' }}>
        Die ZIP-Datei aus dem SAP-Report ZTCO_PORTAL_EXPORT (alle Tabellen) oder einzelne CSV-Dateien aus ZTCO_ARCHIVE hier auswählen.
        Die Tabelle ergibt sich aus dem Dateinamen (z. B. ZTCO_RGKOPF.CSV, BANKAB.CSV); erst wird geprüft, dann mit „Übernehmen“ geschrieben. „Nur neue Sätze“ lässt vorhandene Daten unverändert; „Vorhandene aktualisieren“ überschreibt sie mit dem SAP-Stand.
      </MessageStrip>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <AblageFlaeche ziel={{ titel: 'Übernahme aus SAP', annehmen: (f) => { add(f); } }} accept=".csv,.zip,text/csv,application/zip"
                     groesse={files.length ? 'Dot' : 'Spot'} titel="ZIP- oder CSV-Dateien hier ablegen"
                     text="Hierher ziehen oder klicken zum Auswählen – die Dateien werden zuerst geprüft und erst mit „Übernehmen“ geschrieben." />
      <FlexBox alignItems="Center" style={{ gap: '1rem', margin: '0.75rem 0' }}>
        <SegmentedButton onSelectionChange={(e) => setModus((e.detail.selectedItems[0] as HTMLElement).dataset.m as typeof modus)}>
          <SegmentedButtonItem data-m="neu" selected={modus === 'neu'}>Nur neue Sätze</SegmentedButtonItem>
          <SegmentedButtonItem data-m="aktualisieren" selected={modus === 'aktualisieren'}>Vorhandene aktualisieren</SegmentedButtonItem>
        </SegmentedButton>
        <Button design="Emphasized" icon="upload" loading={busy} disabled={!files.length || fertig || rows.every((r) => !r.tabelle)} onClick={ausfuehren}>Übernehmen</Button>
        {files.length > 0 && <Button design="Transparent" onClick={() => { setFiles([]); setRows([]); setFertig(false); }}>Auswahl leeren</Button>}
      </FlexBox>
      <AnalyticalTable minRows={1} columns={columns} data={rows} visibleRows={Math.max(rows.length, 1)} noDataText="Noch keine Dateien ausgewählt" loading={busy} />
      <Panel headerText="Aktueller Bestand" fixed style={{ marginTop: '1rem' }}>
        <FlexBox wrap="Wrap" style={{ gap: '0.25rem 1.5rem' }}>
          {bestand.map((b) => (
            <FlexBox key={b.tabelle} style={{ width: '13rem' }} justifyContent="SpaceBetween">
              <Label>{b.tabelle}</Label><Text>{b.saetze.toLocaleString('de-DE')}</Text>
            </FlexBox>
          ))}
        </FlexBox>
      </Panel>
    </>
  );
}
