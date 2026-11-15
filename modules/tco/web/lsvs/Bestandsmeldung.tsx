import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AnalyticalTable, Bar, Button, CheckBox, DatePicker, FlexBox, Label, Link, MessageStrip, ObjectStatus, Panel, Tab, TabContainer, Text,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { FormGrid, TextField } from '@core/components/FormFields';
import { download, PdfDialog } from '@core/components/PdfDialog';
import { einstellungLink } from '@core/einstellungen';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { TCO } from '../util';

const L = `${TCO}/lsvs`;

interface Summe { m: number; w: number; d: number; gesamt: number }
interface Vorschau {
  stichtag: string; pruefsumme: string; bestaetigung: string; paperless: boolean; laeufe_zum_stichtag: number;
  kopf: { schluessel: string; nummer: string; bezeichnung: string; ansprechpartner: string; fachverband: string };
  zeilen: { jahrgang: number; m: number; w: number; d: number }[];
  summe: Summe;
  hinweise: { adrnr: string; name: string; grund: string }[];
  fehlt: string[];
}
interface Lauf {
  id: number; stichtag: string; erstellt_am: string; erstellt_von: string; dateiname: string; summe: Summe; nicht_gemeldet: number;
  vereinsnr: string; paperless_id: number | null; paperless_am: string | null;
}

const dat = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const zeit = (ts: string) => new Date(ts).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
const dokid = (id: number) => String(id).padStart(6, '0');

const SPALTEN: AnalyticalTableColumnDefinition[] = [
  { Header: 'Jahrgang', accessor: 'jahrgang', width: 110 },
  { Header: 'männlich', accessor: 'm', hAlign: 'End' },
  { Header: 'weiblich', accessor: 'w', hAlign: 'End' },
  { Header: 'divers', accessor: 'd', hAlign: 'End' },
  { Header: 'gesamt', id: 'gesamt', hAlign: 'End', accessor: (z: { m: number; w: number; d: number }) => z.m + z.w + z.d },
];

/**
 * App „LSVS-Bestandsmeldung“: Übersicht zum Stichtag prüfen und ankreuzen, dann den Lauf erzeugen
 * (Austauschdatei für das LSVSnet, Ausdruck in Paperless). Reiter „Läufe“ mit allen erzeugten Dateien.
 */
export function Bestandsmeldung() {
  const can = useCan();
  const navigate = useNavigate();
  const darf = { erzeugen: can('tco.lsvs:execute'), admin: can('tco.lsvs:admin') };
  const [tab, setTab] = useState<'neu' | 'laeufe'>('neu');
  const [stichtag, setStichtag] = useState('');
  const [v, setV] = useState<Vorschau | null>(null);
  const [laeufe, setLaeufe] = useState<Lauf[]>([]);
  const [geprueft, setGeprueft] = useState(false);
  const [pdf, setPdf] = useState<{ url: string; titel: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const vorschauLaden = (s = stichtag) => {
    setBusy(true); setGeprueft(false);
    return api.get<Vorschau>(`${L}/vorschau${s ? `?stichtag=${s}` : ''}`)
      .then((r) => { setV(r); if (!s) setStichtag(r.stichtag); })
      .catch((e) => setError(e.message)).finally(() => setBusy(false));
  };
  const laeufeLaden = () => api.get<Lauf[]>(`${L}/laeufe`).then(setLaeufe).catch((e) => setError(e.message));
  useEffect(() => { vorschauLaden(''); laeufeLaden(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const xml = (l: Lauf) => download(`${L}/laeufe/${l.id}/xml`, l.dateiname).catch((e) => setError((e as Error).message));

  async function erzeugen() {
    if (!v) return;
    setBusy(true); setError(null); setInfo(null);
    try {
      const r = await api.post<{ id: number; dateiname: string; text: string; paperless: { abgelegt: boolean; text: string; warnungen: string[] } }>(
        `${L}/laeufe`, { stichtag: v.stichtag, pruefsumme: v.pruefsumme, bestaetigt: geprueft });
      toast(r.text, 6000);
      setInfo([r.paperless.text, ...r.paperless.warnungen].join(' · '));
      await download(`${L}/laeufe/${r.id}/xml`, r.dateiname);
      await Promise.all([laeufeLaden(), vorschauLaden()]);
      setTab('laeufe');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function ablegen(l: Lauf) {
    setError(null);
    try {
      const r = await api.post<{ text: string; warnungen: string[] }>(`${L}/laeufe/${l.id}/paperless`, {});
      toast(r.text, 6000);
      if (r.warnungen.length) setInfo(r.warnungen.join(' · '));
      laeufeLaden();
    } catch (e) { setError((e as Error).message); }
  }

  const laufSpalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Lauf', accessor: 'id', width: 70 },
    { Header: 'Stichtag', accessor: 'stichtag', width: 110, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Erzeugt', accessor: 'erstellt_am', minWidth: 150, Cell: ({ row }: Cell) => `${zeit(row.original.erstellt_am)} · ${row.original.erstellt_von}` },
    { Header: 'Mitglieder', id: 'gesamt', width: 100, hAlign: 'End', accessor: (l: Lauf) => l.summe.gesamt },
    { Header: 'm / w / d', id: 'mwd', width: 110, hAlign: 'End', accessor: (l: Lauf) => `${l.summe.m} / ${l.summe.w} / ${l.summe.d}` },
    { Header: 'nicht gemeldet', accessor: 'nicht_gemeldet', width: 120, hAlign: 'End' },
    {
      Header: 'Paperless', id: 'pl', width: 150,
      Cell: ({ row }: Cell) => {
        const l = row.original as Lauf;
        if (l.paperless_id) return <ObjectStatus state="Positive">DOKID {dokid(l.paperless_id)}</ObjectStatus>;
        return darf.erzeugen ? <Link onClick={() => ablegen(l)}>Jetzt ablegen</Link> : <ObjectStatus state="Critical">nicht abgelegt</ObjectStatus>;
      },
    },
    {
      Header: 'Dateien', id: 'aktion', width: 190,
      Cell: ({ row }: Cell) => {
        const l = row.original as Lauf;
        return (
          <FlexBox style={{ gap: '0.25rem' }}>
            <Button design="Transparent" icon="download" onClick={() => xml(l)} tooltip={l.dateiname}>XML</Button>
            <Button design="Transparent" icon="pdf-attachment" onClick={() => setPdf({ url: `${L}/laeufe/${l.id}/pdf`, titel: `LSVS-Bestandsmeldung ${l.stichtag.slice(0, 4)} (Lauf ${l.id})` })}>Ausdruck</Button>
          </FlexBox>
        );
      },
    },
  ];

  const bereit = !!v && !v.fehlt.length && v.summe.gesamt > 0;

  return (
    <AppPage title="LSVS-Bestandsmeldung" subtitle="Jährliche Mitgliedermeldung an den Landessportverband für das Saarland (Austauschdatei für das LSVSnet)"
             actions={darf.admin ? <Button design="Transparent" icon="action-settings" tooltip="Einstellungen (Administration → Einstellungen → TC Oberthal → LSVS-Bestandsmeldung)" onClick={() => navigate(einstellungLink('tco', 'lsvs'))} /> : undefined}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {info && <MessageStrip design="Information" onClose={() => setInfo(null)} style={{ marginBottom: '0.5rem' }}>{info}</MessageStrip>}
      <TabContainer onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key as typeof tab)}>
        <Tab data-key="neu" text="Neue Meldung" icon="add-document" selected={tab === 'neu'}>
          <FlexBox alignItems="Center" wrap="Wrap" style={{ gap: '0.5rem 1.5rem', marginBottom: '0.75rem' }}>
            <FlexBox alignItems="Center" style={{ gap: '0.5rem' }}>
              <Label>Stichtag</Label>
              <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={stichtag}
                          onChange={(e) => { if (e.detail.value) { setStichtag(e.detail.value); vorschauLaden(e.detail.value); } }} />
            </FlexBox>
            {v && <Text><b>{v.summe.gesamt}</b> Mitglieder · {v.summe.m} männlich · {v.summe.w} weiblich · {v.summe.d} divers</Text>}
            <Button icon="refresh" design="Transparent" tooltip="Übersicht neu laden" onClick={() => vorschauLaden()} />
          </FlexBox>

          {v && v.fehlt.length > 0 && (
            <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>
              Es fehlt: {v.fehlt.join(', ')} –{' '}
              {darf.admin ? <Link onClick={() => navigate(einstellungLink('tco', 'lsvs'))}>in den Einstellungen eintragen</Link> : 'bitte die Administration bitten, es einzutragen'}.
            </MessageStrip>
          )}
          {v && v.laeufe_zum_stichtag > 0 && (
            <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.5rem' }}>
              Zu diesem Stichtag gibt es schon {v.laeufe_zum_stichtag} Lauf{v.laeufe_zum_stichtag === 1 ? '' : 'e'} (Reiter „Läufe“). Ein neuer Lauf ersetzt im LSVSnet nichts – dort zählt die zuletzt hochgeladene Datei.
            </MessageStrip>
          )}

          <Panel headerText="1. Übersicht prüfen" fixed>
            {v && (
              <Text style={{ display: 'block', marginBottom: '0.5rem' }}>
                Vereinsnummer {v.kopf.nummer || '–'} · {v.kopf.bezeichnung} · Ansprechpartner {v.kopf.ansprechpartner || '–'} ·
                Fachverband {v.kopf.fachverband || '–'} (Tennis) · Software {v.kopf.schluessel || '–'}
              </Text>
            )}
            <AnalyticalTable minRows={1} columns={SPALTEN} data={v?.zeilen ?? []} visibleRows={Math.min(Math.max(v?.zeilen.length ?? 1, 1), 15)} loading={busy}
                             noDataText="Keine Mitglieder zum Stichtag" />
            {v && v.hinweise.length > 0 && (
              <MessageStrip design="Critical" hideCloseButton style={{ marginTop: '0.75rem' }}>
                {v.hinweise.length} Mitglied{v.hinweise.length === 1 ? '' : 'er'} werden nicht gemeldet, weil Angaben fehlen – vor dem Erzeugen im Mitgliederstamm ergänzen:
                <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.25rem' }}>
                  {v.hinweise.map((h) => (
                    <li key={h.adrnr}><Link onClick={() => navigate(`/tco/mitglieder?adrnr=${h.adrnr}`)}>{h.name}</Link> – {h.grund}</li>
                  ))}
                </ul>
              </MessageStrip>
            )}
            <FlexBox style={{ marginTop: '0.75rem' }}>
              <Button icon="pdf-attachment" disabled={!v} onClick={() => v && setPdf({ url: `${L}/vorschau/pdf?stichtag=${v.stichtag}`, titel: `Voransicht LSVS-Bestandsmeldung ${v.stichtag.slice(0, 4)}` })}>Voransicht Ausdruck</Button>
            </FlexBox>
          </Panel>

          {darf.erzeugen && (
            <Panel headerText="2. Bestätigen und Datei erzeugen" fixed style={{ marginTop: '0.75rem' }}>
              <CheckBox checked={geprueft} disabled={!bereit} onChange={(e) => setGeprueft(e.target.checked)} wrappingType="Normal"
                        text={v?.bestaetigung ?? 'Ich habe die Übersicht geprüft.'} />
              <Text className="portal-muted portal-small" style={{ display: 'block', margin: '0.25rem 0 0.75rem' }}>
                Erzeugt einen Lauf mit der XML-Datei (Download startet sofort){v?.paperless ? ' und legt den Ausdruck in Paperless ab' : ' – Paperless ist nicht eingerichtet, der Ausdruck wird nicht abgelegt'}.
                Hochladen im LSVSnet unter Bestandserhebung, Schritt 3.
              </Text>
              <Bar endContent={<Button design="Emphasized" icon="upload-to-cloud" loading={busy} disabled={!bereit || !geprueft} onClick={erzeugen}>Lauf erzeugen</Button>} />
            </Panel>
          )}
        </Tab>

        <Tab data-key="laeufe" text={`Läufe (${laeufe.length})`} icon="history" selected={tab === 'laeufe'}>
          <AnalyticalTable minRows={1} columns={laufSpalten} data={laeufe} visibleRows={Math.min(Math.max(laeufe.length, 1), 15)} noDataText="Noch keine Läufe erzeugt" />
        </Tab>
      </TabContainer>

      {pdf && <PdfDialog url={pdf.url} title={pdf.titel} filename={`${pdf.titel.replace(/[^\wäöüÄÖÜß-]+/g, '_')}.pdf`} onClose={() => setPdf(null)} />}
    </AppPage>
  );
}

/** Kapitel „LSVS-Bestandsmeldung“ der App Einstellungen: Kopfangaben der Austauschdatei */
export function LsvsKapitel() {
  interface Cfg { lsvs_vereinsnr: string | null; lsvs_ansprechpartner: string; lsvs_fachverband: string; lsvs_schluessel: string }
  const [c, setC] = useState<Cfg | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.get<Cfg>(`${L}/einstellungen`).then(setC).catch((e) => setError((e as Error).message)); }, []);
  const s = (k: keyof Cfg) => (x: string) => c && setC({ ...c, [k]: x });
  async function sichern() {
    if (!c) return;
    setError(null);
    try { await api.put(`${L}/einstellungen`, c); toast('Einstellungen gesichert'); } catch (e) { setError((e as Error).message); }
  }
  return (
    <div style={{ maxWidth: '48rem' }}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.75rem' }}>
        Kopf der Austauschdatei für das LSVSnet (DOSB-Schnittstelle „SV-LSB“). Die Vereinsnummer ist die Vereinskennziffer, mit der sich der Verein im LSVSnet anmeldet.
      </MessageStrip>
      {c && (
        <FormGrid>
          <TextField label="Vereinsnummer beim LSVS" required value={c.lsvs_vereinsnr ?? ''} onChange={s('lsvs_vereinsnr')} />
          <TextField label="Ansprechpartner für Rückfragen" required value={c.lsvs_ansprechpartner} onChange={s('lsvs_ansprechpartner')} />
          <TextField label="Fachverbandscode Tennis (DOSB-Funktionscodes)" required value={c.lsvs_fachverband} onChange={s('lsvs_fachverband')} placeholder="83" />
          <TextField label="Software-Schlüssel" required value={c.lsvs_schluessel} onChange={s('lsvs_schluessel')} placeholder="linear" />
        </FormGrid>
      )}
      <Bar style={{ marginTop: '1rem' }} endContent={<Button design="Emphasized" icon="save" disabled={!c} onClick={sichern}>Sichern</Button>} />
    </div>
  );
}
