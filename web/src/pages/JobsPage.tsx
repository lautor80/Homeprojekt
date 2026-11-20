import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Button, DatePicker, Dialog, Icon, Input, Label, Link, MessageStrip, ObjectStatus, Option, SegmentedButton, SegmentedButtonItem, Select,
  StepInput, Tab, TabContainer, Text, TimePicker, ToggleButton,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api, qs } from '../api';
import { AppPage } from '../components/AppPage';
import { Attribute, Attributes } from '../components/Attributes';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DialogFuss } from '../components/DialogFuss';
import { Filter, Filters } from '../components/Filters';
import { IconAktionen, iconSpalte } from '../components/IconAktionen';
import { ResponsiveTable } from '../components/ResponsiveTable';
import { Section } from '../components/Section';
import { useLoad } from '../components/useLoad';
import { useCan } from '../session';
import { toast } from '../toast';

/**
 * Jobs (Administration → System → Jobs): alle Hintergrundläufe des Portals und der Anwendungen – ein- und ausplanen, Plan ändern,
 * „Jetzt ausführen“ und das Protokoll jedes Laufs einsehen. Typen wie server/src/job-typen.ts, REST /api/admin/jobs.
 * Adresse: ?tab=jobs|laeufe, ?job=<id> (Reiter Läufe, gefiltert – so verlinkt der Arbeitsvorrat), ?lauf=<id> (Protokoll).
 */
type JobPlan = { art: 'intervall'; minuten: number } | { art: 'taeglich'; uhrzeit: string; wochentage: number[] };
type LaufStatus = 'LAEUFT' | 'OK' | 'WARNUNG' | 'FEHLER' | 'ABGEBROCHEN' | 'LEER';
type Stufe = 'info' | 'warnung' | 'fehler';

interface LaufSicht {
  id: number; jobId: string; jobText: string; ausloeser: 'PLAN' | 'MANUELL'; gestartetVon: string | null; gestartetAm: string;
  beendetAm: string | null; dauerSekunden: number | null; status: LaufStatus; ergebnis: string | null; warnungen: number; fehler: number;
}
interface JobSicht {
  id: string; text: string; beschreibung: string; bereich: string; modul: string; eingeplant: boolean; plan: JobPlan;
  standardPlan: JobPlan; standardEingeplant: boolean; planText: string; naechsterLauf: string | null; laeuft: number | null;
  letzterLauf: LaufSicht | null; darfAusfuehren: boolean; geaendertAm: string | null; geaendertVon: string | null;
}
interface Protokoll { lauf: LaufSicht; protokoll: { nr: number; zeit: string; stufe: Stufe; text: string }[] }

type State = 'Positive' | 'Negative' | 'Critical' | 'Information' | 'None';
const STATUS: Record<LaufStatus, { text: string; state: State; icon: string }> = {
  LAEUFT: { text: 'läuft', state: 'Information', icon: 'synchronize' },
  OK: { text: 'OK', state: 'Positive', icon: 'sys-enter-2' },
  WARNUNG: { text: 'Warnung', state: 'Critical', icon: 'alert' },
  FEHLER: { text: 'Fehler', state: 'Negative', icon: 'error' },
  ABGEBROCHEN: { text: 'abgebrochen', state: 'Critical', icon: 'cancel' },
  LEER: { text: 'nichts zu tun', state: 'None', icon: 'less' },
};
const STUFE: Record<Stufe, { text: string; icon: string; farbe: string }> = {
  info: { text: 'Info', icon: 'message-information', farbe: 'var(--sapInformativeElementColor)' },
  warnung: { text: 'Warnung', icon: 'message-warning', farbe: 'var(--sapCriticalElementColor)' },
  fehler: { text: 'Fehler', icon: 'message-error', farbe: 'var(--sapNegativeElementColor)' },
};
const TAGE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const REITER = [{ key: 'jobs', text: 'Jobs' }, { key: 'laeufe', text: 'Läufe' }];

const uhr = (iso: string | null) => (iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '–');
const uhrSek = (iso: string) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const tag = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const vorTagen = (n: number) => tag(new Date(Date.now() - n * 86400_000));

/** Sekunden → „12 s“, „3 min 05 s“, „1 h 02 min“ */
function dauer(sek: number | null): string {
  if (sek == null) return '–';
  const s = Math.max(0, Math.round(sek));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} min`;
}
/** Dauer eines Laufs; läuft er noch, seit dem Start */
const laufDauer = (l: LaufSicht) => dauer(l.dauerSekunden ?? (l.status === 'LAEUFT' ? (Date.now() - new Date(l.gestartetAm).getTime()) / 1000 : null));
const ausloeserText = (l: LaufSicht) => (l.ausloeser === 'PLAN' ? 'nach Plan' : `von Hand${l.gestartetVon ? ` (${l.gestartetVon})` : ''}`);

/** Plan als Text – für den Standardplan im Dialog (den aktuellen liefert der Server als planText) */
function planText(p: JobPlan): string {
  if (p.art === 'intervall') return p.minuten % 60 === 0 && p.minuten >= 120 ? `alle ${p.minuten / 60} Stunden` : `alle ${p.minuten} Minuten`;
  return `täglich ${p.uhrzeit}${p.wochentage.length && p.wochentage.length < 7 ? ` (${tageText(p.wochentage)})` : ''}`;
}
/** [1,2,3,4,5] → „Mo–Fr“, [1,3,5] → „Mo, Mi, Fr“ */
function tageText(t: number[]): string {
  const s = [...new Set(t)].sort((a, b) => a - b);
  const teile: string[] = [];
  for (let i = 0; i < s.length;) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    teile.push(j - i >= 2 ? `${TAGE[s[i] - 1]}–${TAGE[s[j] - 1]}` : s.slice(i, j + 1).map((x) => TAGE[x - 1]).join(', '));
    i = j + 1;
  }
  return teile.join(', ');
}

function StatusAnzeige({ status }: { status: LaufStatus }) {
  const s = STATUS[status] ?? { text: status, state: 'None' as State, icon: '' };
  return <ObjectStatus state={s.state} icon={s.icon ? <Icon name={s.icon} /> : undefined} showDefaultIcon={!s.icon}>{s.text}</ObjectStatus>;
}

interface LaufFilter { job: string; status: string; von: string; bis: string }

export function JobsPage() {
  const can = useCan();
  const darfPlanen = can('core.jobs:edit');
  const darfAusfuehren = can('core.jobs:execute');
  const [params, setParams] = useSearchParams();
  const urlJob = params.get('job') ?? '';
  const urlLauf = params.get('lauf');
  const tab = params.get('tab') ?? (urlJob ? 'laeufe' : 'jobs');
  /** Adresse anpassen, ohne einen Eintrag im Verlauf zu erzeugen (wie SchnittstellenPage) */
  const setzeParams = (aenderung: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(aenderung)) { if (v) p.set(k, v); else p.delete(k); }
    setParams(p, { replace: true });
  };

  const [meldung, setMeldung] = useState<{ ok: boolean; text: string } | null>(null);
  const [suche, setSuche] = useState('');
  const [planJob, setPlanJob] = useState<JobSicht | null>(null);
  const [startFrage, setStartFrage] = useState<JobSicht | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const jobs = useLoad(() => api.get<JobSicht[]>('/api/admin/jobs'));
  // nächster Lauf, „läuft gerade“ und letzter Lauf ändern sich laufend
  useEffect(() => { const t = setInterval(() => { if (!document.hidden) jobs.reload(); }, 15_000); return () => clearInterval(t); }, [jobs.reload]);

  const leer: LaufFilter = { job: urlJob, status: '', von: vorTagen(30), bis: '' };
  const [f, setF] = useState<LaufFilter>(leer);
  const [query, setQuery] = useState<LaufFilter>(leer);
  // Sprung von außen (Arbeitsvorrat, „Läufe“ an einem Job): Filter auf den Job aus der Adresse
  useEffect(() => { setF((x) => ({ ...x, job: urlJob })); setQuery((x) => ({ ...x, job: urlJob })); }, [urlJob]);
  const laeufe = useLoad(() => (tab === 'laeufe' ? api.get<LaufSicht[]>('/api/admin/jobs/laeufe' + qs({ ...query, limit: 200 })) : Promise.resolve(null)), [query, tab]);
  const suchen = (x = f) => { setF(x); setQuery({ ...x }); setzeParams({ job: x.job || null }); };

  const fehler = (e: unknown) => setMeldung({ ok: false, text: (e as Error).message });
  const neuLaden = () => { jobs.reload(); if (tab === 'laeufe') laeufe.reload(); };

  async function einplanen(j: JobSicht, eingeplant: boolean) {
    setBusy(j.id); setMeldung(null);
    try {
      await api.put<JobSicht>(`/api/admin/jobs/${encodeURIComponent(j.id)}/plan`, { eingeplant, plan: j.plan });
      toast(`„${j.text}“ ist ${eingeplant ? 'eingeplant' : 'ausgeplant'}.`);
    } catch (e) { fehler(e); } finally { setBusy(null); jobs.reload(); }
  }
  async function ausfuehren(j: JobSicht) {
    setStartFrage(null); setBusy(j.id); setMeldung(null);
    try {
      const r = await api.post<{ laufId: number }>(`/api/admin/jobs/${encodeURIComponent(j.id)}/ausfuehren`);
      toast(`„${j.text}“ wurde gestartet.`);
      setzeParams({ lauf: String(r.laufId) });
    } catch (e) { fehler(e); } finally { setBusy(null); jobs.reload(); }
  }
  const zuLaeufen = (j: JobSicht) => { const x = { ...f, job: j.id }; setF(x); setQuery(x); setzeParams({ tab: 'laeufe', job: j.id }); };
  const oeffneLauf = (id: number) => setzeParams({ lauf: String(id) });

  // ---------- Reiter Jobs ----------
  const s = suche.trim().toLowerCase();
  const bereiche = useMemo(() => {
    const liste = (jobs.data ?? [])
      .filter((j) => !s || [j.text, j.beschreibung, j.bereich, j.id].some((t) => t.toLowerCase().includes(s)))
      .sort((a, b) => a.bereich.localeCompare(b.bereich, 'de') || a.text.localeCompare(b.text, 'de'));
    const m = new Map<string, JobSicht[]>();
    for (const j of liste) m.set(j.bereich, [...(m.get(j.bereich) ?? []), j]);
    return [...m];
  }, [jobs.data, s]);

  const jobSpalten: AnalyticalTableColumnDefinition[] = [
    {
      Header: 'Job', accessor: 'text', minWidth: 280,
      Cell: ({ row }: Cell) => {
        const j = row.original as JobSicht;
        return (
          <div style={{ minWidth: 0, lineHeight: 1.3 }} title={j.beschreibung}>
            <Text style={{ fontWeight: 'bold' }}>{j.text}</Text>
            <Text className="portal-muted portal-small" style={{ display: 'block' }} maxLines={2}>{j.beschreibung}</Text>
          </div>
        );
      },
    },
    { Header: 'Bereich', accessor: 'bereich', width: 160 },
    {
      Header: 'Plan', accessor: 'planText', width: 190,
      Cell: ({ row }: Cell) => {
        const j = row.original as JobSicht;
        return <Text title={j.geaendertAm ? `geändert am ${uhr(j.geaendertAm)}${j.geaendertVon ? ` von ${j.geaendertVon}` : ''}` : 'Standardplan'}>{j.planText}{j.geaendertAm ? ' *' : ''}</Text>;
      },
    },
    {
      Header: 'Eingeplant', accessor: 'eingeplant', width: 120,
      Cell: ({ row }: Cell) => ((row.original as JobSicht).eingeplant
        ? <ObjectStatus state="Positive">eingeplant</ObjectStatus> : <ObjectStatus state="None">ausgeplant</ObjectStatus>),
    },
    { Header: 'Nächster Lauf', accessor: 'naechsterLauf', width: 140, Cell: ({ row }: Cell) => { const j = row.original as JobSicht; return j.eingeplant ? uhr(j.naechsterLauf) : '–'; } },
    {
      Header: 'Letzter Lauf', id: 'letzter', width: 220,
      Cell: ({ row }: Cell) => {
        const l = (row.original as JobSicht).letzterLauf;
        if (!l) return <Text className="portal-muted">noch nie</Text>;
        return (
          <div className="portal-row" style={{ gap: '0.5rem', flexWrap: 'nowrap' }}>
            <StatusAnzeige status={l.status} />
            <Link onClick={(e) => { e.stopPropagation(); oeffneLauf(l.id); }}>{uhr(l.gestartetAm)}</Link>
          </div>
        );
      },
    },
    {
      Header: 'Läuft gerade', accessor: 'laeuft', width: 120,
      Cell: ({ row }: Cell) => { const id = (row.original as JobSicht).laeuft; return id ? <Link onClick={(e) => { e.stopPropagation(); oeffneLauf(id); }}><StatusAnzeige status="LAEUFT" /></Link> : '–'; },
    },
    {
      Header: 'Aktionen', id: 'aktion', width: iconSpalte(4), disableSortBy: true, disableFilters: true, disableGroupBy: true,
      Cell: ({ row }: Cell) => {
        const j = row.original as JobSicht;
        return (
          <IconAktionen items={[
            { icon: j.eingeplant ? 'pause' : 'appointment', text: j.eingeplant ? 'Ausplanen' : 'Einplanen', hidden: !darfPlanen, disabled: busy !== null, onClick: () => einplanen(j, !j.eingeplant) },
            { icon: 'edit', text: 'Plan ändern', hidden: !darfPlanen, disabled: busy !== null, onClick: () => setPlanJob(j) },
            { icon: 'media-play', text: j.laeuft ? 'Jetzt ausführen (läuft gerade)' : 'Jetzt ausführen', hidden: !j.darfAusfuehren, disabled: busy !== null || !!j.laeuft, onClick: () => setStartFrage(j) },
            { icon: 'history', text: 'Läufe', onClick: () => zuLaeufen(j) },
          ]} />
        );
      },
    },
  ];

  // ---------- Reiter Läufe ----------
  const laufSpalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Start', accessor: 'gestartetAm', width: 140, Cell: ({ row }: Cell) => { const l = row.original as LaufSicht; return <Link onClick={(e) => { e.stopPropagation(); oeffneLauf(l.id); }}>{uhr(l.gestartetAm)}</Link>; } },
    { Header: 'Job', accessor: 'jobText', minWidth: 220 },
    { Header: 'Auslöser', id: 'ausloeser', width: 170, accessor: (l: Record<string, any>) => ausloeserText(l as LaufSicht) },
    { Header: 'Dauer', id: 'dauer', width: 100, hAlign: 'End', accessor: (l: Record<string, any>) => laufDauer(l as LaufSicht) },
    { Header: 'Status', accessor: 'status', width: 140, Cell: ({ row }: Cell) => <StatusAnzeige status={(row.original as LaufSicht).status} /> },
    { Header: 'Ergebnis', accessor: 'ergebnis', minWidth: 240 },
    {
      Header: 'Warnungen / Fehler', id: 'zaehler', width: 150,
      Cell: ({ row }: Cell) => {
        const l = row.original as LaufSicht;
        if (!l.warnungen && !l.fehler) return '–';
        return (
          <div className="portal-row" style={{ gap: '0.5rem', flexWrap: 'nowrap' }}>
            {l.warnungen > 0 && <ObjectStatus state="Critical" showDefaultIcon>{l.warnungen}</ObjectStatus>}
            {l.fehler > 0 && <ObjectStatus state="Negative" showDefaultIcon>{l.fehler}</ObjectStatus>}
          </div>
        );
      },
    },
  ];
  const auswahl = (e: { detail: { selectedOption: unknown } }) => (e.detail.selectedOption as HTMLElement).dataset.wert ?? '';
  const laufListe = laeufe.data ?? [];

  const fehlerZahl = (jobs.data ?? []).filter((j) => j.letzterLauf?.status === 'FEHLER').length;
  return (
    <AppPage title="Jobs"
             subtitle={`Hintergrundläufe ein- und ausplanen, von Hand starten und protokollieren · ${jobs.data?.length ?? 0} Jobs${fehlerZahl ? `, ${fehlerZahl} zuletzt mit Fehler` : ''}`}
             actions={<Button icon="refresh" onClick={neuLaden}>Aktualisieren</Button>}>
      {jobs.error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{jobs.error}</MessageStrip>}
      {meldung && <MessageStrip design={meldung.ok ? 'Positive' : 'Negative'} onClose={() => setMeldung(null)} style={{ marginBottom: '0.5rem' }}>{meldung.text}</MessageStrip>}
      <TabContainer tabLayout="Inline" onTabSelect={(e) => setzeParams({ tab: (e.detail.tab as HTMLElement).dataset.key! })} style={{ marginBottom: '1rem' }}>
        {REITER.map((r) => <Tab key={r.key} data-key={r.key} text={r.text} selected={tab === r.key} />)}
      </TabContainer>

      {tab !== 'laeufe' && (
        <>
          <Filters>
            <Filter label="Suche (Job, Beschreibung, Bereich)" width="20rem">
              <Input value={suche} placeholder="z. B. Mahnung" showClearIcon style={{ width: '100%' }} onInput={(e) => setSuche(e.target.value)} />
            </Filter>
          </Filters>
          {bereiche.map(([bereich, liste]) => (
            <Section key={bereich} title={bereich} count={liste.length} flush>
              <ResponsiveTable columns={jobSpalten} data={liste} rowHeight={56} visibleRows={liste.length} noDataText="Keine Jobs" />
            </Section>
          ))}
          {!jobs.loading && !bereiche.length && <MessageStrip design="Information" hideCloseButton>{s ? 'Kein Job passt zur Suche.' : 'Es sind keine Jobs angemeldet.'}</MessageStrip>}
        </>
      )}

      {tab === 'laeufe' && (
        <>
          <Filters>
            <Filter label="Job" width="18rem">
              <Select style={{ width: '100%' }} onChange={(e) => setF({ ...f, job: auswahl(e) })}>
                <Option data-wert="" selected={!f.job}>(alle)</Option>
                {[...(jobs.data ?? [])].sort((a, b) => a.text.localeCompare(b.text, 'de')).map((j) => <Option key={j.id} data-wert={j.id} selected={f.job === j.id}>{j.text}</Option>)}
                {f.job && !(jobs.data ?? []).some((j) => j.id === f.job) && <Option data-wert={f.job} selected>{f.job}</Option>}
              </Select>
            </Filter>
            <Filter label="Status" width="11rem">
              <Select style={{ width: '100%' }} onChange={(e) => setF({ ...f, status: auswahl(e) })}>
                <Option data-wert="" selected={!f.status}>(alle)</Option>
                {(Object.keys(STATUS) as LaufStatus[]).filter((k) => k !== 'LEER').map((k) => <Option key={k} data-wert={k} selected={f.status === k}>{STATUS[k].text}</Option>)}
              </Select>
            </Filter>
            <Filter label="Von"><DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.von} onChange={(e) => setF({ ...f, von: e.detail.value })} /></Filter>
            <Filter label="Bis"><DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.bis} onChange={(e) => setF({ ...f, bis: e.detail.value })} /></Filter>
            <div className="portal-row" style={{ alignSelf: 'flex-end' }}>
              <Button design="Emphasized" icon="search" onClick={() => suchen()}>Suchen</Button>
              <Button design="Transparent" icon="clear-filter" onClick={() => suchen({ job: '', status: '', von: vorTagen(30), bis: '' })}>Zurücksetzen</Button>
            </div>
          </Filters>
          {laeufe.error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{laeufe.error}</MessageStrip>}
          <Section title="Läufe" count={laufListe.length} flush>
            <ResponsiveTable columns={laufSpalten} data={laufListe} loading={laeufe.loading} sortable filterable
                             visibleRows={Math.min(Math.max(laufListe.length, 1), 20)}
                             noDataText="Keine Läufe im gewählten Filter (Läufe werden 90 Tage aufbewahrt)"
                             onRowClick={(e) => { const l = e.detail.row.original as LaufSicht | undefined; if (l) oeffneLauf(l.id); }} />
          </Section>
        </>
      )}

      <ConfirmDialog open={!!startFrage} title="Jetzt ausführen" confirmText="Ausführen"
                     text={startFrage ? `„${startFrage.text}“ wird jetzt von Hand gestartet.\n\n${startFrage.beschreibung}` : ''}
                     onConfirm={() => startFrage && ausfuehren(startFrage)} onCancel={() => setStartFrage(null)} />
      {planJob && <PlanDialog job={planJob} onClose={(geaendert) => { setPlanJob(null); if (geaendert) jobs.reload(); }} />}
      {urlLauf && (
        <ProtokollDialog key={urlLauf} laufId={Number(urlLauf)} darfAbbrechen={darfAusfuehren}
                         onClose={() => setzeParams({ lauf: null })}
                         onFertig={neuLaden} />
      )}
    </AppPage>
  );
}

/** Plan ändern: Intervall in Minuten oder täglich zu einer Uhrzeit, wahlweise nur an bestimmten Wochentagen */
function PlanDialog({ job, onClose }: { job: JobSicht; onClose: (geaendert: boolean) => void }) {
  const [plan, setPlan] = useState<JobPlan>(job.plan);
  const [minuten, setMinuten] = useState(job.plan.art === 'intervall' ? job.plan.minuten : 60);
  const [uhrzeit, setUhrzeit] = useState(job.plan.art === 'taeglich' ? job.plan.uhrzeit : '02:00');
  const [tage, setTage] = useState<number[]>(job.plan.art === 'taeglich' ? job.plan.wochentage : []);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [standardFrage, setStandardFrage] = useState(false);

  const neu: JobPlan = plan.art === 'intervall' ? { art: 'intervall', minuten } : { art: 'taeglich', uhrzeit, wochentage: [...tage].sort((a, b) => a - b) };
  const gueltig = neu.art === 'intervall' ? Number.isInteger(minuten) && minuten >= 1 : /^([01]\d|2[0-3]):[0-5]\d$/.test(uhrzeit);

  async function sichern() {
    setBusy(true); setFehler(null);
    try {
      await api.put<JobSicht>(`/api/admin/jobs/${encodeURIComponent(job.id)}/plan`, { eingeplant: job.eingeplant, plan: neu });
      toast(`Plan von „${job.text}“: ${planText(neu)}`);
      onClose(true);
    } catch (e) { setFehler((e as Error).message); setBusy(false); }
  }
  async function standard() {
    setStandardFrage(false); setBusy(true); setFehler(null);
    try {
      await api.post<JobSicht>(`/api/admin/jobs/${encodeURIComponent(job.id)}/standard`);
      toast(`„${job.text}“ steht wieder auf dem Standardplan.`);
      onClose(true);
    } catch (e) { setFehler((e as Error).message); setBusy(false); }
  }
  const tagUmschalten = (t: number) => setTage((x) => (x.includes(t) ? x.filter((y) => y !== t) : [...x, t]));

  return (
    <Dialog open headerText={`Plan ändern – ${job.text}`} style={{ width: 'min(34rem, 96vw)' }} onClose={() => onClose(false)}
            footer={<DialogFuss>
              <Button design="Emphasized" disabled={!gueltig || busy} onClick={sichern}>Sichern</Button>
              <Button design="Transparent" icon="reset" disabled={busy} onClick={() => setStandardFrage(true)}>Auf Standard zurücksetzen</Button>
              <Button onClick={() => onClose(false)}>Abbrechen</Button>
            </DialogFuss>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {fehler && <MessageStrip design="Negative" onClose={() => setFehler(null)}>{fehler}</MessageStrip>}
        <div>
          <Label showColon>Art</Label>
          <SegmentedButton style={{ display: 'flex' }} onSelectionChange={(e) => {
            const art = (e.detail.selectedItems[0] as HTMLElement).dataset.art;
            setPlan(art === 'intervall' ? { art: 'intervall', minuten } : { art: 'taeglich', uhrzeit, wochentage: tage });
          }}>
            <SegmentedButtonItem data-art="intervall" icon="process" selected={plan.art === 'intervall'}>Intervall</SegmentedButtonItem>
            <SegmentedButtonItem data-art="taeglich" icon="appointment-2" selected={plan.art === 'taeglich'}>Täglich</SegmentedButtonItem>
          </SegmentedButton>
        </div>
        {plan.art === 'intervall' ? (
          <div>
            <Label showColon required>Alle … Minuten</Label>
            <StepInput value={minuten} min={1} max={10080} style={{ width: '10rem', display: 'block' }}
                       onChange={(e) => setMinuten(Math.round(Number(e.target.value)))} />
          </div>
        ) : (
          <>
            <div>
              <Label showColon required>Uhrzeit</Label>
              <TimePicker formatPattern="HH:mm" value={uhrzeit} style={{ width: '8rem', display: 'block' }} onChange={(e) => setUhrzeit(e.detail.value)} />
            </div>
            <div>
              <Label showColon>Wochentage</Label>
              <div className="portal-row" style={{ gap: '0.25rem', flexWrap: 'wrap' }}>
                {TAGE.map((t, i) => <ToggleButton key={t} pressed={tage.includes(i + 1)} onClick={() => tagUmschalten(i + 1)}>{t}</ToggleButton>)}
              </div>
              <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.25rem' }}>Keiner gewählt = jeden Tag. Zeiten gelten in deutscher Zeit (Europe/Berlin).</Text>
            </div>
          </>
        )}
        <Attributes narrow>
          <Attribute label="Neuer Plan" strong>{gueltig ? planText(neu) : 'ungültig'}</Attribute>
          <Attribute label="Standardplan">{planText(job.standardPlan)}{job.standardEingeplant ? '' : ' (standardmäßig ausgeplant)'}</Attribute>
          <Attribute label="Eingeplant">{job.eingeplant ? 'ja' : 'nein – Einplanen in der Liste'}</Attribute>
          {job.geaendertAm && <Attribute label="Zuletzt geändert">{uhr(job.geaendertAm)}{job.geaendertVon ? ` von ${job.geaendertVon}` : ''}</Attribute>}
        </Attributes>
      </div>
      <ConfirmDialog open={standardFrage} title="Auf Standard zurücksetzen" confirmText="Zurücksetzen"
                     text={`Plan und Einplanung von „${job.text}“ werden auf den Standard gesetzt: ${planText(job.standardPlan)}, ${job.standardEingeplant ? 'eingeplant' : 'ausgeplant'}.`}
                     onConfirm={standard} onCancel={() => setStandardFrage(false)} />
    </Dialog>
  );
}

/** Protokoll eines Laufs; solange er läuft, alle 2 Sekunden nachladen */
function ProtokollDialog({ laufId, darfAbbrechen, onClose, onFertig }: { laufId: number; darfAbbrechen: boolean; onClose: () => void; onFertig: () => void }) {
  const p = useLoad(() => api.get<Protokoll>(`/api/admin/jobs/laeufe/${laufId}`), [laufId]);
  const [abbruchFrage, setAbbruchFrage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const lauf = p.data?.lauf;
  const laeuft = lauf?.status === 'LAEUFT';
  const [warLaufend, setWarLaufend] = useState(false);

  useEffect(() => {
    if (!laeuft) return;
    setWarLaufend(true);
    const t = setTimeout(async () => {
      try { p.setData(await api.get<Protokoll>(`/api/admin/jobs/laeufe/${laufId}`)); } catch (e) { setFehler((e as Error).message); }
    }, 2000);
    return () => clearTimeout(t);
  }, [p.data, laeuft, laufId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Lauf ist fertig geworden: Liste (letzter Lauf, läuft gerade) nachziehen
  useEffect(() => { if (warLaufend && lauf && !laeuft) onFertig(); }, [warLaufend, laeuft]); // eslint-disable-line react-hooks/exhaustive-deps

  async function abbrechen() {
    setAbbruchFrage(false); setBusy(true); setFehler(null);
    try {
      const r = await api.post<{ text: string }>(`/api/admin/jobs/laeufe/${laufId}/abbrechen`);
      toast(r.text);
      p.reload();
    } catch (e) { setFehler((e as Error).message); } finally { setBusy(false); }
  }

  const zeilen = p.data?.protokoll ?? [];
  return (
    <Dialog open headerText={lauf ? `Protokoll – ${lauf.jobText}` : `Protokoll – Lauf ${laufId}`} style={{ width: 'min(60rem, 96vw)' }} onClose={onClose}
            footer={<DialogFuss>
              {laeuft && darfAbbrechen && <Button design="Negative" icon="stop" disabled={busy} onClick={() => setAbbruchFrage(true)}>Lauf abbrechen</Button>}
              <Button design="Transparent" icon="refresh" onClick={p.reload}>Aktualisieren</Button>
              <Button design="Emphasized" onClick={onClose}>Schließen</Button>
            </DialogFuss>}>
      {p.error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{p.error}</MessageStrip>}
      {fehler && <MessageStrip design="Negative" onClose={() => setFehler(null)} style={{ marginBottom: '0.5rem' }}>{fehler}</MessageStrip>}
      {lauf && (
        <Attributes>
          <Attribute label="Job" strong>{lauf.jobText}</Attribute>
          <Attribute label="Status"><StatusAnzeige status={lauf.status} />{laeuft ? <Text className="portal-muted portal-small"> wird alle 2 Sekunden aktualisiert</Text> : null}</Attribute>
          <Attribute label="Start">{uhr(lauf.gestartetAm)}</Attribute>
          <Attribute label="Ende">{lauf.beendetAm ? uhr(lauf.beendetAm) : '–'}</Attribute>
          <Attribute label="Dauer">{laufDauer(lauf)}</Attribute>
          <Attribute label="Auslöser">{ausloeserText(lauf)}</Attribute>
          <Attribute label="Warnungen / Fehler">{lauf.warnungen} / {lauf.fehler}</Attribute>
          <Attribute label="Lauf-Nr.">{lauf.id}</Attribute>
          {lauf.ergebnis && <Attribute label="Ergebnis" wide><Text style={{ whiteSpace: 'pre-wrap' }}>{lauf.ergebnis}</Text></Attribute>}
        </Attributes>
      )}
      <div style={{ marginTop: '0.75rem' }}>
        {!p.loading && !zeilen.length ? <Text className="portal-muted">Keine Protokollzeilen.</Text> : (
          <div className="portal-tabrahmen">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '0.35rem 0.5rem', width: '6rem' }}>Zeit</th>
                  <th style={{ textAlign: 'left', padding: '0.35rem 0.5rem', width: '7rem' }}>Stufe</th>
                  <th style={{ textAlign: 'left', padding: '0.35rem 0.5rem' }}>Text</th>
                </tr>
              </thead>
              <tbody>
                {zeilen.map((z) => {
                  const st = STUFE[z.stufe] ?? STUFE.info;
                  return (
                    <tr key={z.nr} style={{ borderTop: '1px solid var(--sapList_BorderColor)', verticalAlign: 'top' }}>
                      <td style={{ padding: '0.3rem 0.5rem', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{uhrSek(z.zeit)}</td>
                      <td style={{ padding: '0.3rem 0.5rem', whiteSpace: 'nowrap', color: z.stufe === 'info' ? undefined : st.farbe }}>
                        <Icon name={st.icon} style={{ color: st.farbe, width: '1rem', height: '1rem', verticalAlign: 'middle', marginRight: '0.25rem' }} />{st.text}
                      </td>
                      <td style={{ padding: '0.3rem 0.5rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontWeight: z.stufe === 'fehler' ? 'bold' : undefined }}>{z.text}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <ConfirmDialog open={abbruchFrage} danger title="Lauf abbrechen" confirmText="Lauf abbrechen"
                     text="Der Lauf wird angewiesen, an der nächsten sicheren Stelle anzuhalten. Bereits Erledigtes bleibt bestehen."
                     onConfirm={abbrechen} onCancel={() => setAbbruchFrage(false)} />
    </Dialog>
  );
}
