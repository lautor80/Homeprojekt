import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Bar, BusyIndicator, Button, CheckBox, Dialog, Input, Label, Link, List, ListItemStandard, MessageStrip, ObjectStatus, Option, Select, Tab,
  TabContainer, Text, TextArea,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { ResponsiveTable } from '@core/components/ResponsiveTable';
import { Section } from '@core/components/Section';
import { useLoad } from '@core/components/useLoad';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { dat } from '../util';
import { lkText, MODUS_TEXT, STATUS_TEXT, T, vollname, type LiveDaten, type Teilnehmer, type Turnier, type TurnierDetail as Detail, type TurnierStatus } from './api';
import { MODUS_UI } from './modi';
import { STATUS_STATE, TurnierStammDialog } from './Turniere';
import { portalAdresse } from '@core/branding';

/**
 * Detailseite eines Turniers (/tco/turniere/:id): Kopf mit Status und Statuswechsel, öffentliche Links, Reiter
 * „Teilnehmende“ (pflegen, Mitglieder übernehmen, persönliche Links, Stärke-Reihenfolge), Reiter des Modus
 * (Tableau / Gruppen / Runden aus MODUS_UI) und „Live“ (dieselbe Ansicht wie öffentlich, mit vollen Namen).
 */
type TnStatus = Teilnehmer['status'];
const TN_STATUS_TEXT: Record<TnStatus, string> = { gemeldet: 'gemeldet', warteliste: 'Warteliste', abgemeldet: 'abgemeldet' };
const TN_STATE: Record<TnStatus, 'Positive' | 'Critical' | 'None'> = { gemeldet: 'Positive', warteliste: 'Critical', abgemeldet: 'None' };
const GESCHLECHT: Record<string, string> = { w: 'weiblich', m: 'männlich', d: 'divers' };
/** nächster Status mit Knopftext */
const WEITER: Record<TurnierStatus, { status: TurnierStatus; text: string; icon: string } | null> = {
  entwurf: { status: 'anmeldung', text: 'Anmeldung öffnen', icon: 'media-play' },
  anmeldung: { status: 'laeuft', text: 'Turnier starten', icon: 'media-play' },
  laeuft: { status: 'beendet', text: 'Turnier beenden', icon: 'stop' },
  beendet: null,
};

function kopieren(text: string) {
  navigator.clipboard?.writeText(text).then(() => toast('Link kopiert.')).catch(() => toast('Kopieren nicht möglich – bitte den Link markieren und kopieren.'));
}

/** Body für PUT /turniere/:id – alle Felder des Server-Schemas, Einstellungen unverändert */
const turnierBody = (t: Turnier, status: TurnierStatus = t.status) => ({
  name: t.name, kennung: t.kennung, modus: t.modus, status, beschreibung: t.beschreibung, meldeschluss: t.meldeschluss,
  max_teilnehmer: t.max_teilnehmer, einstellungen: t.einstellungen,
});
/** Body für PUT /turniere/:id/teilnehmer/:tid aus einem gelesenen Teilnehmer */
const tnBody = (x: Teilnehmer) => ({
  vorname: x.vorname, nachname: x.nachname, geburtsjahr: x.geburtsjahr, geschlecht: x.geschlecht, email: x.email, telefon: x.telefon,
  adrnr: x.adrnr, lk: x.lk, rang: x.rang, setzplatz: x.setzplatz, status: x.status, bemerkung: x.bemerkung,
});

type Reiter = 'teilnehmer' | 'modus' | 'live';

export function TurnierDetail() {
  const { id } = useParams();
  const tid = Number(id);
  const navigate = useNavigate();
  const darfPflegen = useCan()('tco.turnier:edit');
  const { data: d, error, reload } = useLoad(() => api.get<Detail>(`${T}/${tid}`), [tid]);
  const [tab, setTab] = useState<Reiter>('teilnehmer');
  const [bearbeiten, setBearbeiten] = useState(false);
  const [loeschen, setLoeschen] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!d) {
    return (
      <AppPage title="Turnier" actions={<Button icon="nav-back" design="Transparent" onClick={() => navigate('/tco/turniere')}>Zur Übersicht</Button>}>
        {error ? <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip> : <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />}
      </AppPage>
    );
  }
  const t = d.turnier;
  const ui = MODUS_UI[t.modus];
  const weiter = WEITER[t.status];
  const gemeldet = d.teilnehmer.filter((x) => x.status === 'gemeldet').length;
  const warteliste = d.teilnehmer.filter((x) => x.status === 'warteliste').length;

  async function statusSetzen(status: TurnierStatus) {
    setBusy(true); setFehler(null);
    try {
      await api.put(`${T}/${t.id}`, turnierBody(t, status));
      toast(`Status: ${STATUS_TEXT[status]}`);
      reload();
    } catch (e) { setFehler((e as Error).message); } finally { setBusy(false); }
  }
  async function turnierLoeschen() {
    setLoeschen(false);
    try {
      await api.del(`${T}/${t.id}`);
      toast('Turnier gelöscht.');
      navigate('/tco/turniere');
    } catch (e) { setFehler((e as Error).message); }
  }

  return (
    <AppPage title={t.name} subtitle={`${MODUS_TEXT[t.modus]} · ${gemeldet} gemeldet${t.max_teilnehmer ? ` von ${t.max_teilnehmer}` : ''}${warteliste ? ` · ${warteliste} auf der Warteliste` : ''}${t.meldeschluss ? ` · Meldeschluss ${dat(t.meldeschluss)}` : ''}`}
             actions={<>
               <Button icon="nav-back" design="Transparent" onClick={() => navigate('/tco/turniere')}>Zur Übersicht</Button>
               <ObjectStatus state={STATUS_STATE[t.status]} inverted>{STATUS_TEXT[t.status]}</ObjectStatus>
               {darfPflegen && weiter && <Button design="Emphasized" icon={weiter.icon} loading={busy} onClick={() => statusSetzen(weiter.status)}>{weiter.text}</Button>}
               {darfPflegen && t.status === 'beendet' && <Button icon="undo" loading={busy} onClick={() => statusSetzen('laeuft')}>Wieder öffnen</Button>}
               {darfPflegen && <Button icon="edit" onClick={() => setBearbeiten(true)}>Bearbeiten</Button>}
               {darfPflegen && <Button icon="delete" design="Transparent" onClick={() => setLoeschen(true)}>Löschen</Button>}
               <ChangeHistoryButton objectType="TURNIER" objectKey={String(t.id)} />
             </>}>
      {fehler && <MessageStrip design="Negative" onClose={() => setFehler(null)} style={{ marginBottom: '0.5rem' }}>{fehler}</MessageStrip>}
      {t.beschreibung && <Text style={{ display: 'block', whiteSpace: 'pre-line', marginBottom: '0.75rem' }}>{t.beschreibung}</Text>}
      <Links detail={d} />

      <TabContainer tabLayout="Inline" contentBackgroundDesign="Transparent" onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key as Reiter)}>
        <Tab data-key="teilnehmer" text="Teilnehmende" icon="group" additionalText={String(gemeldet)} selected={tab === 'teilnehmer'}>
          {tab === 'teilnehmer' && <TeilnehmerReiter detail={d} darfPflegen={darfPflegen} reload={reload} />}
        </Tab>
        <Tab data-key="modus" text={ui.reiter} icon="org-chart" selected={tab === 'modus'}>
          {tab === 'modus' && <ui.Verwaltung detail={d} darfPflegen={darfPflegen} reload={reload} />}
        </Tab>
        <Tab data-key="live" text="Live" icon="full-screen" selected={tab === 'live'}>
          {tab === 'live' && <LiveReiter turnier={t} />}
        </Tab>
      </TabContainer>

      {bearbeiten && <TurnierStammDialog turnier={t} onClose={() => setBearbeiten(false)} onGespeichert={() => { setBearbeiten(false); toast('Turnier gespeichert.'); reload(); }} />}
      <ConfirmDialog open={loeschen} danger title="Turnier löschen" confirmText="Löschen" onCancel={() => setLoeschen(false)} onConfirm={turnierLoeschen}
                     text={`„${t.name}“ mit allen Teilnehmenden, Runden und Spielen löschen?\n\nGibt es schon Ergebnisse, lässt sich das Turnier nicht löschen – dann bitte auf „beendet“ setzen.`} />
    </AppPage>
  );
}

/** öffentliche Links mit Kopieren-Knopf; Hinweis, wenn die Portal-Adresse fehlt oder das Turnier noch Entwurf ist */
function Links({ detail }: { detail: Detail }) {
  const t = detail.turnier;
  const basis = (detail.url ?? portalAdresse()).replace(/\/+$/, '');
  const k = encodeURIComponent(t.kennung);
  const links = [
    { text: 'Anmeldung', url: `${basis}/turnier?t=${k}` },
    { text: 'Live', url: `${basis}/turnier-live?t=${k}` },
    { text: 'Beamer', url: `${basis}/turnier-live?t=${k}&beamer=1` },
  ];
  return (
    <Section title="Öffentliche Links">
      {!detail.url && (
        <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>
          Die Portal-Adresse ist in den Einstellungen nicht eingetragen – die Links unten verwenden die Adresse dieses Browsers, in E-Mails fehlt sie.
        </MessageStrip>
      )}
      {t.status === 'entwurf' && (
        <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.5rem' }}>
          Im Entwurf sind die öffentlichen Seiten noch nicht erreichbar – mit „Anmeldung öffnen“ werden sie freigeschaltet.
        </MessageStrip>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', gap: '0.25rem 0.75rem', alignItems: 'center' }}>
        {links.map((l) => (
          <div key={l.text} style={{ display: 'contents' }}>
            <Label showColon>{l.text}</Label>
            <Link href={l.url} target="_blank" wrappingType="Normal" style={{ wordBreak: 'break-all' }}>{l.url}</Link>
            <Button design="Transparent" icon="copy" tooltip={`${l.text}-Link kopieren`} onClick={() => kopieren(l.url)} />
          </div>
        ))}
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------ Teilnehmende

/** Stärke-Reihenfolge wie auf dem Server: manueller Rang, dann LK, dann Meldung */
function nachStaerke(l: Teilnehmer[]): Teilnehmer[] {
  const g = Number.MAX_SAFE_INTEGER;
  return [...l].sort((x, y) => (x.rang ?? g) - (y.rang ?? g) || (x.lk ?? 99) - (y.lk ?? 99)
    || String(x.angemeldet_am).localeCompare(String(y.angemeldet_am)) || x.id - y.id);
}

type Vorlage = Partial<Teilnehmer>;

function TeilnehmerReiter({ detail, darfPflegen, reload }: { detail: Detail; darfPflegen: boolean; reload: () => void }) {
  const t = detail.turnier;
  const [dialog, setDialog] = useState<{ tn?: Teilnehmer; vorlage?: Vorlage } | null>(null);
  const [suche, setSuche] = useState(false);
  const [link, setLink] = useState<Teilnehmer | null>(null);
  const [loeschen, setLoeschen] = useState<Teilnehmer | null>(null);
  const [rangliste, setRangliste] = useState(false);
  const [abgemeldeteZeigen, setAbgemeldeteZeigen] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  const reihenfolge: Record<TnStatus, number> = { gemeldet: 0, warteliste: 1, abgemeldet: 2 };
  const liste = detail.teilnehmer
    .filter((x) => abgemeldeteZeigen || x.status !== 'abgemeldet')
    .sort((a, b) => reihenfolge[a.status] - reihenfolge[b.status] || String(a.angemeldet_am).localeCompare(String(b.angemeldet_am)) || a.id - b.id);
  const abgemeldet = detail.teilnehmer.filter((x) => x.status === 'abgemeldet').length;

  async function statusSetzen(x: Teilnehmer, status: TnStatus) {
    setFehler(null);
    try {
      await api.put(`${T}/${t.id}/teilnehmer/${x.id}`, { ...tnBody(x), status });
      const wl = detail.teilnehmer.filter((y) => y.status === 'warteliste' && y.id !== x.id);
      toast(status === 'abgemeldet' && x.status === 'gemeldet' && wl.length
        ? `${vollname(x)} abgemeldet. Auf der Warteliste steht als Nächstes ${vollname(wl[0])} – über „Nachrücken“ übernehmen.`
        : `${vollname(x)}: ${TN_STATUS_TEXT[status]}`, 6000);
      reload();
    } catch (e) { setFehler((e as Error).message); }
  }
  async function entfernen(x: Teilnehmer) {
    setLoeschen(null); setFehler(null);
    try { await api.del(`${T}/${t.id}/teilnehmer/${x.id}`); toast(`${vollname(x)} gelöscht.`); reload(); } catch (e) { setFehler((e as Error).message); }
  }

  const nr = new Map(liste.filter((x) => x.status === 'gemeldet').map((x, i) => [x.id, i + 1]));
  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Name', id: 'name', minWidth: 180, accessor: (r: Record<string, any>) => `${r.nachname}, ${r.vorname}`,
      Cell: ({ row }: Cell) => {
        const x = row.original as Teilnehmer;
        return <span title={x.bemerkung ?? undefined}>{nr.get(x.id) ? <span className="portal-muted">{nr.get(x.id)}. </span> : null}{x.nachname}, {x.vorname}{x.bemerkung ? <span className="portal-muted portal-small"> · {x.bemerkung}</span> : null}</span>;
      } },
    { Header: 'Jahrgang', accessor: 'geburtsjahr', width: 90, Cell: ({ row }: Cell) => `${row.original.geburtsjahr ?? '–'}${row.original.geschlecht ? ` ${row.original.geschlecht}` : ''}` },
    { Header: 'LK', accessor: 'lk', width: 90, Cell: ({ value }: Cell) => lkText(value) },
    { Header: 'Rang', accessor: 'rang', width: 70, hAlign: 'End', Cell: ({ value }: Cell) => value ?? '–' },
    { Header: 'Setzplatz', accessor: 'setzplatz', width: 90, hAlign: 'End', Cell: ({ value }: Cell) => value ?? '–' },
    { Header: 'Status', accessor: 'status', width: 120, Cell: ({ value }: Cell) => <ObjectStatus state={TN_STATE[value as TnStatus]}>{TN_STATUS_TEXT[value as TnStatus]}</ObjectStatus> },
    { Header: 'Mitglied', accessor: 'adrnr', width: 90, Cell: ({ value }: Cell) => (value ? 'Mitglied' : 'Gast') },
    { Header: 'E-Mail', accessor: 'email', minWidth: 160, Cell: ({ row }: Cell) => (row.original.email ? <Link href={`mailto:${row.original.email}`}>{row.original.email}</Link> : (row.original.telefon ?? '–')) },
    ...(darfPflegen ? [{
      Header: 'Aktionen', id: 'akt', width: 230, disableSortBy: true,
      Cell: ({ row }: Cell) => {
        const x = row.original as Teilnehmer;
        return (
          <span className="portal-row" style={{ gap: 0, flexWrap: 'nowrap' }}>
            <Button design="Transparent" icon="edit" tooltip="Bearbeiten" onClick={() => setDialog({ tn: x })} />
            <Button design="Transparent" icon="paper-plane" tooltip="Persönlichen Link senden" disabled={x.status === 'abgemeldet'} onClick={() => setLink(x)} />
            {x.status === 'warteliste' && <Button design="Transparent" icon="accept" tooltip="Nachrücken (gemeldet)" onClick={() => statusSetzen(x, 'gemeldet')} />}
            {x.status === 'gemeldet' && <Button design="Transparent" icon="history" tooltip="Auf die Warteliste" onClick={() => statusSetzen(x, 'warteliste')} />}
            {x.status !== 'abgemeldet'
              ? <Button design="Transparent" icon="decline" tooltip="Abmelden" onClick={() => statusSetzen(x, 'abgemeldet')} />
              : <Button design="Transparent" icon="undo" tooltip="Wieder anmelden" onClick={() => statusSetzen(x, 'gemeldet')} />}
            <Button design="Transparent" icon="delete" tooltip="Löschen" onClick={() => setLoeschen(x)} />
          </span>
        );
      },
    }] : []),
  ];

  if (rangliste) return <RanglisteEditor detail={detail} onClose={(gespeichert) => { setRangliste(false); if (gespeichert) reload(); }} />;

  return (
    <Section title="Teilnehmende" count={liste.length} flush
             actions={<>
               {!!abgemeldet && <CheckBox text={`Abgemeldete zeigen (${abgemeldet})`} checked={abgemeldeteZeigen} onChange={(e) => setAbgemeldeteZeigen(e.target.checked)} />}
               {darfPflegen && <>
                 <Button icon="add" onClick={() => setDialog({})}>Hinzufügen</Button>
                 <Button icon="search" onClick={() => setSuche(true)}>Aus Mitgliedern</Button>
                 <Button icon="sort" disabled={!detail.teilnehmer.some((x) => x.status !== 'abgemeldet')} onClick={() => setRangliste(true)}>Stärke-Reihenfolge</Button>
               </>}
             </>}>
      {fehler && <MessageStrip design="Negative" onClose={() => setFehler(null)} style={{ margin: '0.5rem' }}>{fehler}</MessageStrip>}
      <ResponsiveTable columns={columns} data={liste} titelSpalten={1} visibleRows={Math.min(Math.max(liste.length, 1), 30)}
                       noDataText={t.status === 'entwurf' ? 'Noch niemand gemeldet – Anmeldung öffnen oder Teilnehmende hinzufügen.' : 'Noch niemand gemeldet.'} />

      {dialog && <TeilnehmerDialog turnierId={t.id} tn={dialog.tn} vorlage={dialog.vorlage} onClose={() => setDialog(null)}
                                   onGespeichert={(text) => { setDialog(null); toast(text); reload(); }} />}
      {suche && <MitgliedSuche vorhanden={new Set(detail.teilnehmer.filter((x) => x.adrnr && x.status !== 'abgemeldet').map((x) => x.adrnr!))}
                               onClose={() => setSuche(false)} onWahl={(v) => { setSuche(false); setDialog({ vorlage: v }); }} />}
      {link && <LinkDialog turnierId={t.id} tn={link} onClose={() => setLink(null)} />}
      <ConfirmDialog open={!!loeschen} danger title="Teilnehmende/n löschen" confirmText="Löschen" onCancel={() => setLoeschen(null)}
                     onConfirm={() => loeschen && entfernen(loeschen)}
                     text={loeschen ? `${vollname(loeschen)} endgültig aus dem Turnier löschen? Wer schon ausgelost ist, lässt sich nur abmelden.` : ''} />
    </Section>
  );
}

const zahlOderNull = (v: string) => (v.trim() ? Number(v.trim().replace(',', '.')) : null);

function TeilnehmerDialog({ turnierId, tn, vorlage, onClose, onGespeichert }: {
  turnierId: number; tn?: Teilnehmer; vorlage?: Vorlage; onClose: () => void; onGespeichert: (text: string) => void;
}) {
  const v = tn ?? vorlage ?? {};
  const s = (x: unknown) => (x == null ? '' : String(x));
  const [f, setF] = useState({
    vorname: s(v.vorname), nachname: s(v.nachname), geburtsjahr: s(v.geburtsjahr), geschlecht: s(v.geschlecht), email: s(v.email), telefon: s(v.telefon),
    lk: v.lk != null ? String(v.lk).replace('.', ',') : '', rang: s(v.rang), setzplatz: s(v.setzplatz), status: (v.status ?? 'gemeldet') as TnStatus,
    bemerkung: s(v.bemerkung), adrnr: v.adrnr ?? null,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ok = !!f.vorname.trim() && !!f.nachname.trim();

  async function sichern() {
    setBusy(true); setError(null);
    const body = {
      vorname: f.vorname.trim(), nachname: f.nachname.trim(), geburtsjahr: zahlOderNull(f.geburtsjahr), geschlecht: f.geschlecht || null,
      email: f.email.trim() || null, telefon: f.telefon.trim() || null, adrnr: f.adrnr, lk: f.lk.trim() || null,
      rang: zahlOderNull(f.rang), setzplatz: zahlOderNull(f.setzplatz), status: f.status, bemerkung: f.bemerkung.trim() || null,
    };
    try {
      if (tn) await api.put(`${T}/${turnierId}/teilnehmer/${tn.id}`, body);
      else await api.post(`${T}/${turnierId}/teilnehmer`, body);
      onGespeichert(`${body.vorname} ${body.nachname} ${tn ? 'gespeichert' : 'hinzugefügt'}.`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const feld = (k: keyof typeof f, label: string, props: Record<string, unknown> = {}) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: 1, minWidth: '9rem' }}>
      <Label showColon required={k === 'vorname' || k === 'nachname'}>{label}</Label>
      <Input value={String(f[k] ?? '')} onInput={(e) => setF({ ...f, [k]: e.target.value })} style={{ width: '100%' }} {...props} />
    </div>
  );
  return (
    <Dialog open headerText={tn ? `${vollname(tn)} bearbeiten` : 'Teilnehmende/n hinzufügen'} style={{ width: 'min(36rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={<>
              <Button design="Emphasized" icon="save" disabled={!ok} loading={busy} onClick={sichern}>Sichern</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      <div className="portal-bk__form">
        {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
        {f.adrnr
          ? <MessageStrip design="Information" hideCloseButton>Mitglied (Adressnr. {f.adrnr}). <Link onClick={() => setF({ ...f, adrnr: null })}>Als Gast führen</Link></MessageStrip>
          : <Text className="portal-muted portal-small">Gast (nicht mit dem Mitgliederstamm verknüpft).</Text>}
        <div className="portal-row" style={{ alignItems: 'flex-start' }}>{feld('vorname', 'Vorname', { maxlength: 60 })}{feld('nachname', 'Nachname', { maxlength: 60 })}</div>
        <div className="portal-row" style={{ alignItems: 'flex-start' }}>
          {feld('geburtsjahr', 'Geburtsjahr', { type: 'Number' })}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: 1, minWidth: '9rem' }}>
            <Label showColon>Geschlecht</Label>
            <Select style={{ width: '100%' }} onChange={(e) => setF({ ...f, geschlecht: (e.detail.selectedOption as HTMLElement).dataset.g ?? '' })}>
              <Option data-g="" selected={!f.geschlecht}>–</Option>
              {Object.entries(GESCHLECHT).map(([k, x]) => <Option key={k} data-g={k} selected={f.geschlecht === k}>{x}</Option>)}
            </Select>
          </div>
          {feld('lk', 'LK', { placeholder: 'z. B. 18,5' })}
        </div>
        <div className="portal-row" style={{ alignItems: 'flex-start' }}>{feld('email', 'E-Mail', { type: 'Email', maxlength: 120 })}{feld('telefon', 'Mobil', { type: 'Tel', maxlength: 40 })}</div>
        <div className="portal-row" style={{ alignItems: 'flex-start' }}>
          {feld('rang', 'Rang (manuelle Stärke)', { type: 'Number' })}
          {feld('setzplatz', 'Setzplatz (KO)', { type: 'Number' })}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: 1, minWidth: '9rem' }}>
            <Label showColon>Status</Label>
            <Select style={{ width: '100%' }} onChange={(e) => setF({ ...f, status: (e.detail.selectedOption as HTMLElement).dataset.s as TnStatus })}>
              {(Object.keys(TN_STATUS_TEXT) as TnStatus[]).map((x) => <Option key={x} data-s={x} selected={f.status === x}>{TN_STATUS_TEXT[x]}</Option>)}
            </Select>
          </div>
        </div>
        <Label showColon>Bemerkung</Label>
        <TextArea rows={2} value={f.bemerkung} maxlength={500} onInput={(e) => setF({ ...f, bemerkung: e.target.value })} />
      </div>
    </Dialog>
  );
}

interface MitgliedTreffer { adrnr: string; vorname: string; nachname: string; geburtsjahr: number | null; email: string | null; telefon: string | null; geschlecht: 'w' | 'm' | null; lk: number | null }

function MitgliedSuche({ vorhanden, onClose, onWahl }: { vorhanden: Set<string>; onClose: () => void; onWahl: (v: Vorlage) => void }) {
  const [q, setQ] = useState('');
  const [treffer, setTreffer] = useState<MitgliedTreffer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (q.trim().length < 2) { setTreffer(null); return; }
    let aktuell = true;
    const h = setTimeout(() => {
      api.get<MitgliedTreffer[]>(`${T}/mitglieder?q=${encodeURIComponent(q.trim())}`)
        .then((r) => { if (aktuell) { setTreffer(r); setError(null); } })
        .catch((e) => { if (aktuell) setError(e.message); });
    }, 250);
    return () => { aktuell = false; clearTimeout(h); };
  }, [q]);
  return (
    <Dialog open headerText="Mitglied hinzufügen" style={{ width: 'min(32rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={<Button onClick={onClose}>Abbrechen</Button>} />}>
      <div className="portal-bk__form">
        {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
        <Input value={q} placeholder="Name eingeben (mind. 2 Zeichen)" style={{ width: '100%' }} onInput={(e) => setQ(e.target.value)} />
        {treffer && (treffer.length ? (
          <List onItemClick={(e) => {
            const m = treffer.find((x) => x.adrnr === (e.detail.item as HTMLElement).dataset.adrnr);
            if (m && !vorhanden.has(m.adrnr)) onWahl({ ...m, adrnr: m.adrnr, status: 'gemeldet' });
          }}>
            {treffer.map((m) => (
              <ListItemStandard key={m.adrnr} data-adrnr={m.adrnr} type={vorhanden.has(m.adrnr) ? 'Inactive' : 'Active'}
                                description={[m.geburtsjahr, m.email].filter(Boolean).join(' · ') || undefined}
                                additionalText={vorhanden.has(m.adrnr) ? 'bereits dabei' : lkText(m.lk)}
                                additionalTextState={vorhanden.has(m.adrnr) ? 'Positive' : 'None'}>
                {m.nachname}, {m.vorname}
              </ListItemStandard>
            ))}
          </List>
        ) : <Text className="portal-muted">Kein aktives Mitglied gefunden.</Text>)}
      </div>
    </Dialog>
  );
}

function LinkDialog({ turnierId, tn, onClose }: { turnierId: number; tn: Teilnehmer; onClose: () => void }) {
  const [senden, setSenden] = useState(!!tn.email);
  const [erg, setErg] = useState<{ link: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function erzeugen() {
    setBusy(true); setError(null);
    try { setErg(await api.post<{ link: string; text: string }>(`${T}/${turnierId}/teilnehmer/${tn.id}/link`, { senden })); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open headerText={`Persönlicher Link – ${vollname(tn)}`} style={{ width: 'min(32rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={erg ? <>
              <Button icon="copy" onClick={() => kopieren(erg.link)}>Kopieren</Button>
              <Button design="Emphasized" onClick={onClose}>Schließen</Button>
            </> : <>
              <Button design="Emphasized" icon="paper-plane" loading={busy} onClick={erzeugen}>{senden ? 'Link erzeugen und senden' : 'Link erzeugen'}</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      <div className="portal-bk__form">
        {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
        {erg ? <>
          <MessageStrip design="Positive" hideCloseButton>{erg.text}</MessageStrip>
          <Text style={{ wordBreak: 'break-all' }}><b>{erg.link}</b></Text>
          <Text className="portal-muted portal-small">Über den Link sieht die Person ihre Spiele, trägt Ergebnisse ein oder meldet sich ab.</Text>
        </> : <>
          <Text>Es wird ein neuer persönlicher Link erzeugt; ein früher verschickter Link gilt danach nicht mehr.</Text>
          <CheckBox text={tn.email ? `per E-Mail an ${tn.email} senden` : 'keine E-Mail-Adresse hinterlegt'} disabled={!tn.email} checked={senden}
                    onChange={(e) => setSenden(e.target.checked)} style={{ marginLeft: '-0.5rem' }} />
        </>}
      </div>
    </Dialog>
  );
}

/** manuelle Stärke-Reihenfolge (Rang 1 = stärkste/r) per Auf/Ab-Knöpfen → PUT /turniere/:id/rangliste */
function RanglisteEditor({ detail, onClose }: { detail: Detail; onClose: (gespeichert: boolean) => void }) {
  const start = useMemo(() => nachStaerke(detail.teilnehmer.filter((x) => x.status !== 'abgemeldet')), [detail]);
  const [liste, setListe] = useState(start);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const schieben = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= liste.length) return;
    const n = [...liste];
    [n[i], n[j]] = [n[j], n[i]];
    setListe(n);
  };
  async function sichern() {
    setBusy(true); setError(null);
    try {
      await api.put(`${T}/${detail.turnier.id}/rangliste`, { ids: liste.map((x) => x.id) });
      toast('Stärke-Reihenfolge gespeichert.');
      onClose(true);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const nachLk = () => setListe([...liste].sort((x, y) => (x.lk ?? 99) - (y.lk ?? 99) || String(x.angemeldet_am).localeCompare(String(y.angemeldet_am)) || x.id - y.id));
  return (
    <Section title="Stärke-Reihenfolge" count={liste.length}
             actions={<>
               <Button icon="sort" onClick={nachLk}>Nach LK vorsortieren</Button>
               <Button design="Emphasized" icon="save" loading={busy} onClick={sichern}>Speichern</Button>
               <Button onClick={() => onClose(false)}>Abbrechen</Button>
             </>}>
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <Text className="portal-muted portal-small" style={{ display: 'block', marginBottom: '0.5rem' }}>
        Oben steht die stärkste Person. Gespeichert wird der Rang 1, 2, 3 … – er gilt bei Setzung „manuell“ vor der LK.
      </Text>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {liste.map((x, i) => (
          <li key={x.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.15rem 0', borderBottom: '1px solid var(--sapList_BorderColor)' }}>
            <span style={{ width: '2rem', textAlign: 'right' }} className="portal-muted">{i + 1}.</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              {vollname(x)} <span className="portal-muted portal-small">{lkText(x.lk)}{x.status === 'warteliste' ? ' · Warteliste' : ''}</span>
            </span>
            <Button design="Transparent" icon="navigation-up-arrow" tooltip="nach oben" disabled={i === 0} onClick={() => schieben(i, -1)} />
            <Button design="Transparent" icon="navigation-down-arrow" tooltip="nach unten" disabled={i === liste.length - 1} onClick={() => schieben(i, 1)} />
          </li>
        ))}
      </ol>
    </Section>
  );
}

// ------------------------------------------------------------------ Live

function LiveReiter({ turnier }: { turnier: Turnier }) {
  const { data, error, reload, loading } = useLoad(() => api.get<LiveDaten>(`${T}/${turnier.id}/live`), [turnier.id]);
  const Live = MODUS_UI[turnier.modus].Live;
  // alle 30 s neu laden, solange der Reiter offen ist
  useEffect(() => { const h = setInterval(reload, 30_000); return () => clearInterval(h); }, [reload]);
  return (
    <Section title="Live-Ansicht" status={data ? <Text className="portal-muted portal-small">Stand {new Date(data.stand).toLocaleTimeString('de-DE')}</Text> : undefined}
             actions={<>
               <Button icon="refresh" loading={loading} onClick={reload}>Aktualisieren</Button>
               {turnier.status !== 'entwurf' && <Button icon="action" onClick={() => window.open(`/turnier-live?t=${encodeURIComponent(turnier.kennung)}`, '_blank')}>Öffentlich öffnen</Button>}
             </>}>
      {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
      {data ? <Live live={data} /> : !error && <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />}
    </Section>
  );
}
