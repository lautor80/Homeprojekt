import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Bar, BusyIndicator, Button, CheckBox, DatePicker, Dialog, Input, Label, Link, MessageStrip, ObjectStatus, Option, RadioButton, Select, Tab, TabContainer, Text,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api, qs } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { FieldBox, FormGrid } from '@core/components/FormFields';
import { ImportDialog, ImportKnopf, type ImportSchritt } from '@core/components/ImportDialog';
import { ResponsiveTable } from '@core/components/ResponsiveTable';
import { Section } from '@core/components/Section';
import { toast } from '@core/toast';
import { dat, dateiLesen } from '../util';
import {
  abstimmung, STAND_STATE, STAND_TEXT, STATUS_STATE, tagIso, uhrzeit, VS,
  type AufgabeZeile, type BeschlussZeile, type SitzungZeile, type Uebersicht,
} from './typen';
import './vorstand.css';

/**
 * Vorstandssitzungen: Übersicht der Sitzungen (Protokolle), Beschlussregister und Aufgaben aus allen Sitzungen.
 * Neue Sitzung mit Veranstaltung im Vereinskalender, Vorstandsgruppe einstellen, alte Protokolle aus Markdown importieren.
 * Die Sitzung selbst (Teilnehmer, Tagesordnung, Beschlüsse, Anlagen, Freigabe) steht in Sitzung.tsx (/tco/vorstand/:id).
 */
type Reiter = 'sitzungen' | 'beschluesse' | 'aufgaben';

export function Vorstand() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Reiter) || 'sitzungen';
  const [jahr, setJahr] = useState<number | null>(null);
  const [suche, setSuche] = useState('');
  const [d, setD] = useState<Uebersicht | null>(null);
  const [beschluesse, setBeschluesse] = useState<BeschlussZeile[] | null>(null);
  const [aufgaben, setAufgaben] = useState<AufgabeZeile[] | null>(null);
  const [nurOffen, setNurOffen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [neu, setNeu] = useState(false);
  const [einst, setEinst] = useState(false);
  const [imp, setImp] = useState(false);

  // Absprung aus dem Arbeitsvorrat: /tco/vorstand?sitzung=<id>
  useEffect(() => {
    const s = params.get('sitzung');
    if (s) navigate(`/tco/vorstand/${s}`, { replace: true });
  }, [params, navigate]);

  const laden = useCallback(() => {
    setError(null);
    return api.get<Uebersicht>(`${VS}${qs({ jahr: jahr ?? undefined, suche: suche.trim() || undefined })}`).then(setD).catch((e) => setError(e.message));
  }, [jahr, suche]);
  useEffect(() => { const t = setTimeout(laden, 250); return () => clearTimeout(t); }, [laden]);
  useEffect(() => {
    if (tab === 'beschluesse') api.get<{ beschluesse: BeschlussZeile[] }>(`${VS}/beschluesse${qs({ jahr: jahr ?? undefined, suche: suche.trim() || undefined })}`).then((r) => setBeschluesse(r.beschluesse)).catch((e) => setError(e.message));
  }, [tab, jahr, suche]);
  const aufgabenLaden = useCallback(() => api.get<{ aufgaben: AufgabeZeile[] }>(`${VS}/aufgaben${qs({ offen: nurOffen ? 1 : 0 })}`).then((r) => setAufgaben(r.aufgaben)).catch((e) => setError(e.message)), [nurOffen]);
  useEffect(() => { if (tab === 'aufgaben') aufgabenLaden(); }, [tab, aufgabenLaden]);

  const setTab = (t: string) => { const p = new URLSearchParams(params); p.set('tab', t); setParams(p, { replace: true }); };

  const naechste = useMemo(() => {
    const h = tagIso(new Date().toISOString());
    return [...(d?.sitzungen ?? [])].filter((s) => s.datum >= h && s.status !== 'FREIGEGEBEN').sort((a, b) => a.datum.localeCompare(b.datum))[0] ?? null;
  }, [d]);

  const spalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Nr.', accessor: 'nr', width: 110, Cell: ({ row }: Cell) => <Link onClick={() => navigate(`/tco/vorstand/${row.original.id}`)}>{row.original.nr}</Link> },
    { Header: 'Datum', accessor: 'datum', width: 110, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Sitzung', accessor: 'titel', minWidth: 220, Cell: ({ row }: Cell) => (
      <span className="portal-vs__zelle2">
        <span>{row.original.titel}{row.original.importiert && <ObjectStatus state="Information" inverted style={{ marginLeft: '0.4rem' }}>Import</ObjectStatus>}</span>
        <span className="portal-muted">{[row.original.event ? `Kalender: ${row.original.event.titel}` : '', row.original.ort, row.original.beginn && `${row.original.beginn} Uhr`].filter(Boolean).join(' · ') || '–'}</span>
      </span>) },
    { Header: 'Teilnahme', accessor: 'anwesend', width: 100, Cell: ({ row }: Cell) => (row.original.vorstand ? `${row.original.anwesend} / ${row.original.vorstand}` : '–') },
    { Header: 'TOPs', accessor: 'tops', width: 70 },
    { Header: 'Beschlüsse', accessor: 'beschluesse', width: 100 },
    { Header: 'Offene Aufgaben', accessor: 'aufgaben_offen', width: 130, Cell: ({ value }: Cell) => (value ? <ObjectStatus state="Critical">{value}</ObjectStatus> : '–') },
    { Header: 'Anlagen', accessor: 'anlagen', width: 85 },
    { Header: 'Status', accessor: 'status_text', width: 170, Cell: ({ row }: Cell) => <ObjectStatus state={STATUS_STATE[row.original.status]} inverted>{row.original.status_text}</ObjectStatus> },
  ];
  const bSpalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Nr.', accessor: 'nr', width: 115 },
    { Header: 'Beschluss', accessor: 'text', minWidth: 320, Cell: ({ row }: Cell) => <span className="portal-vs__umbruch">{row.original.text}</span> },
    { Header: 'Abstimmung', accessor: 'ja', width: 170, Cell: ({ row }: Cell) => (
      <span>{abstimmung(row.original) || '–'}{row.original.ergebnis && <ObjectStatus state={row.original.ergebnis === 'ANGENOMMEN' ? 'Positive' : 'Negative'} style={{ marginLeft: '0.4rem' }}>{row.original.ergebnis === 'ANGENOMMEN' ? 'angenommen' : 'abgelehnt'}</ObjectStatus>}</span>) },
    { Header: 'Sitzung', accessor: 'sitzung_nr', width: 200, Cell: ({ row }: Cell) => (
      <span className="portal-vs__zelle2"><Link onClick={() => navigate(`/tco/vorstand/${row.original.sitzung_id}`)}>{row.original.sitzung_nr} · {dat(row.original.datum)}</Link><span className="portal-muted">{row.original.top}</span></span>) },
  ];
  const aSpalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Aufgabe', accessor: 'text', minWidth: 280, Cell: ({ row }: Cell) => <span className="portal-vs__umbruch">{row.original.text}</span> },
    { Header: 'Wer', accessor: 'verantwortlich', width: 150 },
    { Header: 'Fällig', accessor: 'faellig', width: 110, Cell: ({ value }: Cell) => (value ? dat(value) : '–') },
    { Header: 'Stand', accessor: 'stand', width: 130, Cell: ({ row }: Cell) => <ObjectStatus state={STAND_STATE[row.original.stand]} inverted>{STAND_TEXT[row.original.stand]}</ObjectStatus> },
    { Header: 'Aus', accessor: 'sitzung_nr', width: 210, Cell: ({ row }: Cell) => (
      <span className="portal-vs__zelle2"><Link onClick={() => navigate(`/tco/vorstand/${row.original.sitzung_id}`)}>{row.original.sitzung_nr} · {dat(row.original.datum)}</Link><span className="portal-muted">{row.original.top}</span></span>) },
    ...(d?.pflege ? [{ Header: '', id: 'haken', width: 120, Cell: ({ row }: Cell) => (
      <Button design="Transparent" icon={row.original.erledigt_am ? 'undo' : 'accept'} onClick={async () => {
        try {
          await api.post(`${VS}/aufgaben/${row.original.id}/erledigt`, { erledigt: !row.original.erledigt_am });
          toast(row.original.erledigt_am ? 'Wieder offen.' : 'Erledigt.');
          aufgabenLaden();
        } catch (e) { setError((e as Error).message); }
      }}>{row.original.erledigt_am ? 'Öffnen' : 'Erledigt'}</Button>) } as AnalyticalTableColumnDefinition] : []),
  ];

  const filter = (
    <div className="portal-vs__filter">
      <Input placeholder="Suche in Titel, Tagesordnung, Text und Beschlüssen …" value={suche} onInput={(e) => setSuche(e.target.value)} style={{ flex: '1 1 18rem', minWidth: '12rem' }} />
      <Label>Jahr</Label>
      <Select onChange={(e) => setJahr(Number((e.detail.selectedOption as HTMLElement).dataset.j) || null)} style={{ width: '9rem' }}>
        <Option data-j="" selected={jahr === null}>alle</Option>
        {(d?.jahre ?? []).map((j) => <Option key={j} data-j={j} selected={jahr === j}>{j}</Option>)}
      </Select>
    </div>
  );

  return (
    <AppPage title="Vorstandssitzungen" subtitle={d ? `Vorstand: ${d.cfg.gruppe ?? 'keine Gruppe gefunden'} · ${d.vorstand.length} Mitglieder` : undefined}
             actions={<>
               {d?.pflege && <Button icon="group" onClick={() => setEinst(true)}>Vorstandsgruppe</Button>}
               {d?.pflege && <ImportKnopf tooltip="Alte Protokolle als Markdown-Dateien (.md) oder ZIP mit Anlagen übernehmen" onClick={() => setImp(true)} />}
               {d?.pflege && <Button design="Emphasized" icon="add" onClick={() => setNeu(true)}>Neue Sitzung</Button>}
             </>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {d && !d.cfg.gruppe_id && (
        <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>
          Es gibt keine Mitgliedergruppe „Vorstand“. Bitte unter Mitgliedergruppen anlegen oder über „Vorstandsgruppe“ eine andere Gruppe wählen – sonst stehen in neuen Sitzungen keine Teilnehmer.
        </MessageStrip>
      )}
      {!d ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : (
        <>
          <div className="portal-vs__kacheln">
            <div className="portal-vs__kachel">
              <span className="portal-vs__klabel">Nächste Sitzung</span>
              {naechste ? (<><Link onClick={() => navigate(`/tco/vorstand/${naechste.id}`)} className="portal-vs__kwert">{dat(naechste.datum)}</Link>
                <span className="portal-muted">{[naechste.beginn && `${naechste.beginn} Uhr`, naechste.ort].filter(Boolean).join(' · ') || naechste.titel}</span></>)
                : <span className="portal-vs__kwert">–</span>}
            </div>
            <div className="portal-vs__kachel"><span className="portal-vs__klabel">Protokolle im Entwurf</span><span className="portal-vs__kwert">{d.sitzungen.filter((s) => s.status === 'ENTWURF').length}</span></div>
            <div className="portal-vs__kachel"><span className="portal-vs__klabel">Offene Aufgaben</span><span className="portal-vs__kwert">{d.sitzungen.reduce((n, s) => n + s.aufgaben_offen, 0)}</span></div>
            <div className="portal-vs__kachel"><span className="portal-vs__klabel">Beschlüsse{jahr ? ` ${jahr}` : ''}</span><span className="portal-vs__kwert">{d.sitzungen.reduce((n, s) => n + s.beschluesse, 0)}</span></div>
          </div>
          <TabContainer onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key ?? 'sitzungen')}>
            <Tab data-key="sitzungen" text={`Sitzungen (${d.sitzungen.length})`} icon="meeting-room" selected={tab === 'sitzungen'}>
              <Section flush plain>
                {filter}
                <ResponsiveTable columns={spalten} data={d.sitzungen} titelSpalten={2} noDataText="Noch keine Sitzungen – „Neue Sitzung“ oder alte Protokolle importieren." visibleRows={Math.min(Math.max(d.sitzungen.length, 3), 20)} />
              </Section>
            </Tab>
            <Tab data-key="beschluesse" text="Beschlüsse" icon="decision" selected={tab === 'beschluesse'}>
              <Section flush plain>
                {filter}
                {!beschluesse ? <BusyIndicator active /> : <ResponsiveTable columns={bSpalten} data={beschluesse} noDataText="Keine Beschlüsse gefunden." visibleRows={Math.min(Math.max(beschluesse.length, 3), 25)} />}
              </Section>
            </Tab>
            <Tab data-key="aufgaben" text="Aufgaben" icon="task" selected={tab === 'aufgaben'}>
              <Section flush plain>
                <div className="portal-vs__filter"><CheckBox text="nur offene" checked={nurOffen} onChange={(e) => setNurOffen(e.target.checked)} /></div>
                {!aufgaben ? <BusyIndicator active /> : <ResponsiveTable columns={aSpalten} data={aufgaben} noDataText="Keine Aufgaben." visibleRows={Math.min(Math.max(aufgaben.length, 3), 25)} />}
              </Section>
            </Tab>
          </TabContainer>
        </>
      )}
      {neu && d && <NeueSitzung d={d} onClose={() => setNeu(false)} onFertig={(id) => navigate(`/tco/vorstand/${id}`)} />}
      {einst && d && <GruppeDialog d={d} onClose={() => setEinst(false)} onFertig={() => { setEinst(false); laden(); }} />}
      <MarkdownImport open={imp} onClose={() => { setImp(false); laden(); }} />
    </AppPage>
  );
}

// ---------------------------------------------------------------- Neue Sitzung

function NeueSitzung({ d, onClose, onFertig }: { d: Uebersicht; onClose: () => void; onFertig: (id: number) => void }) {
  const frei = d.events.filter((e) => !e.sitzung_id);
  const [f, setF] = useState({
    titel: 'Vorstandssitzung', art: 'VORSTAND' as 'VORSTAND' | 'ERWEITERT', datum: '', beginn: '19:30', ende: '', ort: 'Clubhaus',
    kal: 'NEU' as 'NEU' | 'VORHANDEN' | 'OHNE', event_id: frei.find((e) => e.kategorie === 'SITZUNG')?.id ?? frei[0]?.id ?? null, vorlage: true,
  });
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const ev = frei.find((e) => e.id === f.event_id);
  const ok = f.titel.trim() && (f.kal === 'VORHANDEN' ? !!ev : /^\d{4}-\d{2}-\d{2}$/.test(f.datum));

  async function anlegen() {
    setBusy(true); setFehler(null);
    try {
      const r = await api.post<{ id: number; text: string }>(`${VS}/sitzungen`, {
        titel: f.titel, art: f.art, datum: f.kal === 'VORHANDEN' && ev ? tagIso(ev.beginn) : f.datum, beginn: f.beginn, ende: f.ende, ort: f.ort,
        event_id: f.kal === 'VORHANDEN' ? f.event_id : null, event_anlegen: f.kal === 'NEU', vorlage: f.vorlage,
      });
      toast(r.text);
      onFertig(r.id);
    } catch (e) { setFehler((e as Error).message); setBusy(false); }
  }

  return (
    <Dialog open headerText="Neue Sitzung" onClose={onClose} style={{ width: 'min(44rem, 96vw)' }}
            footer={<Bar endContent={<><Button design="Emphasized" disabled={!ok || busy} onClick={anlegen}>Anlegen</Button><Button onClick={onClose}>Abbrechen</Button></>} />}>
      {fehler && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{fehler}</MessageStrip>}
      <FormGrid>
        <FieldBox label="Titel" required><Input value={f.titel} onInput={(e) => setF({ ...f, titel: e.target.value })} /></FieldBox>
        <FieldBox label="Art">
          <Select onChange={(e) => setF({ ...f, art: (e.detail.selectedOption as HTMLElement).dataset.a as typeof f.art })}>
            <Option data-a="VORSTAND" selected={f.art === 'VORSTAND'}>Vorstandssitzung</Option>
            <Option data-a="ERWEITERT" selected={f.art === 'ERWEITERT'}>Erweiterte Vorstandssitzung</Option>
          </Select>
        </FieldBox>
        <FieldBox label="Veranstaltung im Vereinskalender" wide>
          <div className="portal-vs__radios">
            <RadioButton name="vs-kal" text="neu anlegen (Einladung, Zu- und Absagen über den Kalender)" checked={f.kal === 'NEU'} onChange={() => setF({ ...f, kal: 'NEU' })} />
            <RadioButton name="vs-kal" text="vorhandene Veranstaltung verknüpfen" disabled={!frei.length} checked={f.kal === 'VORHANDEN'} onChange={() => setF({ ...f, kal: 'VORHANDEN' })} />
            <RadioButton name="vs-kal" text="ohne Veranstaltung" checked={f.kal === 'OHNE'} onChange={() => setF({ ...f, kal: 'OHNE' })} />
          </div>
        </FieldBox>
        {f.kal === 'VORHANDEN' ? (
          <FieldBox label="Veranstaltung" wide>
            <Select onChange={(e) => setF({ ...f, event_id: Number((e.detail.selectedOption as HTMLElement).dataset.e) })}>
              {frei.map((e) => <Option key={e.id} data-e={e.id} selected={f.event_id === e.id}>{dat(tagIso(e.beginn))} {uhrzeit(e.beginn)} · {e.titel}{e.ort ? ` · ${e.ort}` : ''}{e.abgesagt ? ' (abgesagt)' : ''}</Option>)}
            </Select>
            <Text className="portal-muted">Datum, Uhrzeit und Ort kommen aus der Veranstaltung; ändert sich der Termin im Kalender, zieht die Sitzung mit.</Text>
          </FieldBox>
        ) : (<>
          <FieldBox label="Datum" required><DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.datum} onChange={(e) => setF({ ...f, datum: e.detail.value })} /></FieldBox>
          <FieldBox label="Ort"><Input value={f.ort} onInput={(e) => setF({ ...f, ort: e.target.value })} /></FieldBox>
          <FieldBox label="Beginn (HH:MM)"><Input value={f.beginn} maxlength={5} placeholder="19:30" onInput={(e) => setF({ ...f, beginn: e.target.value })} /></FieldBox>
          <FieldBox label="Ende (HH:MM)"><Input value={f.ende} maxlength={5} placeholder="21:30" onInput={(e) => setF({ ...f, ende: e.target.value })} /></FieldBox>
        </>)}
        <FieldBox label="Tagesordnung" wide>
          <CheckBox checked={f.vorlage} onChange={(e) => setF({ ...f, vorlage: e.target.checked })}
                    text="vorschlagen: Begrüßung, Genehmigung des letzten Protokolls, vertagte Punkte der letzten Sitzung, Verschiedenes" wrappingType="Normal" />
        </FieldBox>
      </FormGrid>
      <Text className="portal-muted" style={{ display: 'block', marginTop: '0.75rem' }}>
        Teilnehmer: {d.vorstand.length ? d.vorstand.map((m) => m.name).join('; ') : 'keine – Vorstandsgruppe prüfen'}
      </Text>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Vorstandsgruppe

function GruppeDialog({ d, onClose, onFertig }: { d: Uebersicht; onClose: () => void; onFertig: () => void }) {
  const [g, setG] = useState<number | null>(d.cfg.automatisch ? null : d.cfg.gruppe_id);
  const [fehler, setFehler] = useState<string | null>(null);
  const pfad = (id: number): string => {
    const x = d.gruppen.find((y) => y.id === id);
    return !x ? '' : x.parent_id ? `${pfad(x.parent_id)} › ${x.name}` : x.name;
  };
  const liste = d.gruppen.map((x) => ({ id: x.id, text: pfad(x.id) })).sort((a, b) => a.text.localeCompare(b.text, 'de'));
  return (
    <Dialog open headerText="Vorstandsgruppe" onClose={onClose} style={{ width: 'min(36rem, 96vw)' }}
            footer={<Bar endContent={<><Button design="Emphasized" onClick={async () => {
              try { await api.put(`${VS}/einstellungen`, { gruppe_id: g }); toast('Gesichert.'); onFertig(); } catch (e) { setFehler((e as Error).message); }
            }}>Sichern</Button><Button onClick={onClose}>Abbrechen</Button></>} />}>
      {fehler && <MessageStrip design="Negative" hideCloseButton>{fehler}</MessageStrip>}
      <Text style={{ display: 'block', marginBottom: '0.75rem' }}>
        Teilnehmer neuer Sitzungen sind die Mitglieder dieser Mitgliedergruppe samt ihrer Untergruppen. Die Rolle (z. B. Kassenwart) ist die Rolle in der Gruppe oder der Name der Untergruppe.
      </Text>
      <Select onChange={(e) => setG(Number((e.detail.selectedOption as HTMLElement).dataset.g) || null)} style={{ width: '100%' }}>
        <Option data-g="" selected={g === null}>automatisch: Gruppe „Vorstand“</Option>
        {liste.map((x) => <Option key={x.id} data-g={x.id} selected={g === x.id}>{x.text}</Option>)}
      </Select>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Import alter Protokolle

interface ImportZeile {
  datei: string; datum: string | null; titel: string; tops: number; beschluesse: number; aufgaben: number; anlagen_gefunden: number; anlagen_fehlen: string[];
  teilnehmer: number; zugeordnet: number; unklar: string[]; veranstaltung: { id: number; titel: string } | null;
  status: 'BEREIT' | 'PRUEFEN' | 'DUPLIKAT' | 'FEHLER'; hinweise: string[]; sitzung_id?: number;
}
const IMP_STATE = { BEREIT: 'Positive', PRUEFEN: 'Critical', DUPLIKAT: 'Negative', FEHLER: 'Negative' } as const;
const IMP_TEXT = { BEREIT: 'bereit', PRUEFEN: 'prüfen', DUPLIKAT: 'Duplikat – übersprungen', FEHLER: 'Datum fehlt – übersprungen' } as const;

function MarkdownImport({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const datei = useRef<HTMLInputElement>(null);
  const [dateien, setDateien] = useState<{ name: string; data: string }[]>([]);
  const [zeilen, setZeilen] = useState<ImportZeile[] | null>(null);
  const [fertig, setFertig] = useState<ImportZeile[] | null>(null);
  const [opt, setOpt] = useState({ veranstaltung: true, freigeben: true });
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  useEffect(() => { if (open) { setDateien([]); setZeilen(null); setFertig(null); setFehler(null); } }, [open]);
  const schritt: ImportSchritt = fertig ? 4 : zeilen ? 3 : dateien.length ? 2 : 1;

  async function waehlen(l: FileList | null) {
    if (!l?.length) return;
    setBusy(true); setFehler(null); setFertig(null);
    try {
      const neu = await Promise.all([...l].map(async (f) => ({ name: f.name, data: await dateiLesen(f) })));
      const alle = [...dateien.filter((x) => !neu.some((n) => n.name === x.name)), ...neu];
      setDateien(alle);
      const r = await api.post<{ zeilen: ImportZeile[] }>(`${VS}/import`, { dateien: alle });
      setZeilen(r.zeilen);
    } catch (e) { setFehler((e as Error).message); setZeilen(null); }
    setBusy(false);
  }
  async function uebernehmen() {
    setBusy(true); setFehler(null);
    try {
      const r = await api.post<{ zeilen: ImportZeile[]; text: string }>(`${VS}/import`, { dateien, uebernehmen: true, ...opt });
      setFertig(r.zeilen); toast(r.text);
    } catch (e) { setFehler((e as Error).message); }
    setBusy(false);
  }
  const anzahl = zeilen?.filter((z) => z.status === 'BEREIT' || z.status === 'PRUEFEN').length ?? 0;
  const liste = fertig ?? zeilen;

  return (
    <ImportDialog open={open} was="alte Vorstandsprotokolle (Markdown)" schritt={schritt} breit onClose={onClose}>
      <Text style={{ display: 'block', marginBottom: '0.5rem' }}>
        Markdown-Dateien (.md) einzeln oder mehrere, auch als ZIP mit Anlagen-Ordner. Erkannt werden Kopfdaten (Datum, Ort, Zeit, Anwesend, Entschuldigt, Gäste,
        Protokoll, Leitung – am Dateianfang als „Schlüssel: Wert“ oder Front-Matter), Tagesordnungspunkte (Überschriften „## TOP 1 …“ bzw. „**TOP 1: …**“),
        Beschlüsse („Beschluss: …“ mit „Abstimmung: 5/0/1“ oder „einstimmig“), Aufgaben („- [ ] Text @Wer bis 10.12.“) und Verweise auf Dateien als Anlagen.
        Der Originaltext bleibt immer als Anlage erhalten.
      </Text>
      {fehler && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{fehler}</MessageStrip>}
      <div className="portal-vs__filter">
        <input ref={datei} type="file" multiple hidden accept=".md,.markdown,.txt,.zip,.pdf,.png,.jpg,.jpeg,.docx,.xlsx" onChange={(e) => { waehlen(e.target.files); e.target.value = ''; }} />
        <Button icon="add-document" disabled={busy || !!fertig} onClick={() => datei.current?.click()}>{dateien.length ? 'Weitere Dateien …' : 'Dateien wählen …'}</Button>
        {dateien.length > 0 && <Text className="portal-muted">{dateien.length} Datei{dateien.length === 1 ? '' : 'en'} gewählt</Text>}
        {busy && <BusyIndicator active size="S" />}
      </div>
      {liste && (
        <div className="portal-vs__imp portal-tabrahmen">
          <table>
            <thead><tr><th>Datei</th><th>Datum</th><th>Titel</th><th>TOPs</th><th>Beschl.</th><th>Aufg.</th><th>Anlagen</th><th>Teilnehmer</th><th>Veranstaltung</th><th>Stand</th></tr></thead>
            <tbody>
              {liste.map((z) => (
                <tr key={z.datei}>
                  <td className="portal-vs__mono">{z.datei}</td>
                  <td>{z.datum ? dat(z.datum) : '–'}</td>
                  <td>{z.sitzung_id ? <Link onClick={() => navigate(`/tco/vorstand/${z.sitzung_id}`)}>{z.titel}</Link> : z.titel}</td>
                  <td>{z.tops}</td><td>{z.beschluesse}</td><td>{z.aufgaben}</td>
                  <td>{z.anlagen_gefunden}{z.anlagen_fehlen.length ? <span title={z.anlagen_fehlen.join(', ')}> / {z.anlagen_gefunden + z.anlagen_fehlen.length}</span> : ''}</td>
                  <td title={z.unklar.length ? `nicht zugeordnet: ${z.unklar.join('; ')}` : undefined}>{z.zugeordnet} / {z.teilnehmer}</td>
                  <td>{z.veranstaltung ? z.veranstaltung.titel : <span className="portal-muted">{opt.veranstaltung ? 'neu anlegen' : '–'}</span>}</td>
                  <td>
                    <ObjectStatus state={fertig ? (z.sitzung_id ? 'Positive' : 'None') : IMP_STATE[z.status]} inverted>{fertig ? (z.sitzung_id ? 'übernommen' : 'übersprungen') : IMP_TEXT[z.status]}</ObjectStatus>
                    {z.hinweise.length > 0 && <div className="portal-muted portal-vs__hinweis">{z.hinweise.join(' · ')}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {zeilen && !fertig && (
        <div className="portal-vs__filter" style={{ marginTop: '0.75rem' }}>
          <CheckBox text="fehlende Veranstaltungen im Vereinskalender anlegen" checked={opt.veranstaltung} onChange={(e) => setOpt({ ...opt, veranstaltung: e.target.checked })} />
          <CheckBox text="als freigegeben übernehmen" checked={opt.freigeben} onChange={(e) => setOpt({ ...opt, freigeben: e.target.checked })} />
          <span style={{ flex: 1 }} />
          <Button design="Emphasized" disabled={busy || !anzahl} onClick={uebernehmen}>{anzahl} Protokoll{anzahl === 1 ? '' : 'e'} übernehmen</Button>
        </div>
      )}
    </ImportDialog>
  );
}
