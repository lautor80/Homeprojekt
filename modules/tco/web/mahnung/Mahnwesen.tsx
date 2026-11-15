import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AnalyticalTable, Bar, Button, CheckBox, DatePicker, Dialog, FlexBox, Input, Label, MessageStrip, ObjectStatus, Option, Select, Tab, TabContainer, Text, TextArea,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { AuswahlBox, type AuswahlEintrag } from '@core/components/AuswahlBox';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { HeaderKpi } from '@core/components/Filters';
import { FieldBox, FormGrid, TextField } from '@core/components/FormFields';
import { Section } from '@core/components/Section';
import { einstellungLink } from '@core/einstellungen';
import { useCan, useFunktion } from '@core/session';
import { toast } from '@core/toast';
import { TCO, dat, eur } from '../util';

/**
 * App „Mahnwesen“ (Finanzen): offene Posten mit Mahnstufe und nächstem Schritt, Vorschau und Vorschlag des nächsten Laufs,
 * Läufe mit Ergebnis je Posten, nicht per E-Mail erreichbare Schuldner, Mahnsperren. Die Einstellungen (Automatik, Zeitplan,
 * Stufen) stehen unter Administration → Einstellungen → TC Oberthal → Mahnwesen.
 */
const M = `${TCO}/mahnung`;

type Schritt = 'NICHT_FAELLIG' | 'WARTET' | 'MAHNEN' | 'VORSCHLAG' | 'UNERREICHBAR' | 'KLAEREN' | 'GESPERRT' | 'KLEINBETRAG';
type State = 'None' | 'Information' | 'Positive' | 'Critical' | 'Negative';
interface Posten {
  art: 'HALLE' | 'VERZEHR'; art_txt: string; nr: string; schuldner: string; name: string; betrag: number; gesamt: number; datum: string; faellig: string;
  stufe: number; stufe_name: string; gemahnt_am: string | null; naechste: number | null; naechste_name: string; schritt: Schritt; schritt_txt: string;
  ab: string | null; hinweis: string; sperre: { id: number; grund: string; bis: string | null; ebene: string } | null;
  versuch: { id: number; an: string; meldung: string; tag: string | null } | null;
  kontakt?: { anschrift: string; telefon: string; email: string } | null;
}
interface MahnMail { schuldner: string; name: string; posten: Posten[]; stufe: number; stufe_name: string; summe: number; gebuehr: number }
interface LaufZeile {
  id: number; art: string; nr: string; schuldner: string; name: string; betrag: number; faellig: string; stufe: number; stufe_name: string; gebuehr: number;
  frist: string | null; status: string; weg: string | null; an: string | null; meldung: string | null; erledigt_am: string | null; erledigt_von: string | null;
}
interface Lauf {
  id: number; art: 'AUTO' | 'MANUELL'; modus: 'VORSCHLAG' | 'SENDEN'; status: string; stichtag: string; gestartet_am: string; gestartet_von: string; beendet_am: string | null;
  freigegeben_am: string | null; freigegeben_von: string | null; zurueckgestellt: number; meldung: string | null;
  posten: number; schuldner: number; gesendet: number; nicht_erreichbar: number; fehler: number; entfallen: number; betrag: number; zeilen?: LaufZeile[];
}
interface Daten {
  posten: Posten[];
  kennzahlen: { offen: number; offen_betrag: number; faellig: number; faellig_betrag: number; gemahnt: number; klaeren: number };
  plan: { mails: MahnMail[]; zurueckgestellt: number; summe: number; frist: string };
  vorschlag: Lauf | null;
  unerreichbar: Posten[];
  automatik: { aktiv: boolean; funktion: boolean; modus: 'VORSCHLAG' | 'SENDEN'; wochentage: string; uhrzeit: string; naechster: string | null; letzter_lauf: string | null };
  stufen: { name: string; tage: number; gebuehr: number }[]; mindestbetrag: number; max_je_lauf: number; mail: boolean; laeuft: boolean;
}
interface Sperre {
  id: number; ebene: 'RECHNUNG' | 'SCHULDNER'; art: string | null; schluessel: string; name: string; grund: string; bis: string | null;
  angelegt_am: string; angelegt_von: string; aufgehoben_am: string | null; aufgehoben_von: string | null;
}
interface Ergebnis { id: number; text: string; status: string }

const SCHRITT_STATE: Record<Schritt, State> = {
  NICHT_FAELLIG: 'None', WARTET: 'Information', MAHNEN: 'Critical', VORSCHLAG: 'Information', UNERREICHBAR: 'Negative', KLAEREN: 'Negative', GESPERRT: 'None', KLEINBETRAG: 'None',
};
const LAUF_STATUS: Record<string, [string, State]> = {
  LAEUFT: ['läuft', 'Information'], VORSCHLAG: ['Vorschlag – wartet auf Freigabe', 'Critical'], FERTIG: ['abgeschlossen', 'Positive'], FEHLER: ['Fehler', 'Negative'], VERWORFEN: ['verworfen', 'None'],
};
const POSTEN_STATUS: Record<string, [string, State]> = {
  VORSCHLAG: ['vorgeschlagen', 'Information'], GESENDET: ['gesendet', 'Positive'], NICHT_ERREICHBAR: ['nicht erreichbar', 'Negative'], FEHLER: ['Fehler', 'Negative'],
  ENTFALLEN: ['entfallen', 'None'], VERWORFEN: ['verworfen', 'None'],
};
const WEG: Record<string, string> = { MAIL: 'E-Mail', BRIEF: 'Brief', TELEFON: 'Anruf', PERSOENLICH: 'persönlich' };
const TAGE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const zeit = (ts: string | null) => (ts ? new Date(ts).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const zeilenHoehe = (n: number) => Math.min(Math.max(n, 1), 15);
const rechts = { hAlign: 'End' as const };

export function Mahnwesen() {
  const can = useCan();
  const navigate = useNavigate();
  const darf = { ausfuehren: can('tco.mahnung:execute'), admin: can('tco.mahnung:admin') };
  /** Funktionsschalter: Der automatische Lauf lässt sich abschalten – der Lauf von Hand bleibt */
  const automatikAn = useFunktion()('tco.mahnung.automatik');
  const [start] = useState(() => new URLSearchParams(window.location.search));
  const [tab, setTab] = useState(() => start.get('tab') ?? 'posten');
  const [d, setD] = useState<Daten | null>(null);
  const [laeufe, setLaeufe] = useState<Lauf[]>([]);
  const [sperren, setSperren] = useState<Sperre[]>([]);
  const [filter, setFilter] = useState<'faellig' | 'alle' | 'gemahnt'>('faellig');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [frage, setFrage] = useState<null | { titel: string; text: string; ok: string; tun: () => Promise<unknown> }>(null);
  const [historie, setHistorie] = useState<Posten | null>(null);
  const [lauf, setLauf] = useState<number | null>(null);
  const [sperre, setSperre] = useState<null | { posten?: Posten }>(null);
  const [zustellung, setZustellung] = useState<Posten | null>(null);

  const laden = () => Promise.all([
    api.get<Daten>(M).then(setD),
    api.get<Lauf[]>(`${M}/laeufe`).then(setLaeufe),
    api.get<Sperre[]>(`${M}/sperren?alle=1`).then(setSperren),
  ]).catch((e) => setError((e as Error).message));
  useEffect(() => { laden(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function tun(f: () => Promise<unknown>) {
    setBusy(true); setError(null); setInfo(null);
    try {
      const r = await f() as { text?: string } | undefined;
      if (r?.text) { toast(r.text, 6000); setInfo(r.text); }
      await laden();
    } catch (e) { setError((e as Error).message); await laden(); } finally { setBusy(false); }
  }
  const starten = (modus: 'VORSCHLAG' | 'SENDEN') => setFrage(modus === 'SENDEN' ? {
    titel: 'Mahnlauf jetzt senden', ok: 'Jetzt senden',
    text: `Es ${d?.plan.mails.length === 1 ? 'geht 1 E-Mail' : `gehen ${d?.plan.mails.length ?? 0} E-Mails`} an die Schuldner hinaus (${eur(d?.plan.summe)}). Jeder Posten wird unmittelbar vor dem Senden erneut gegen den Zahlungsstand geprüft.`,
    tun: () => api.post<Ergebnis>(`${M}/lauf`, { modus }),
  } : {
    titel: 'Vorschlag erzeugen', ok: 'Vorschlag erzeugen',
    text: 'Der Lauf hält die fälligen Posten als Vorschlag fest – es wird nichts gesendet. Erst mit der Freigabe gehen die E-Mails hinaus. Ein offener Vorschlag wird ersetzt.',
    tun: () => api.post<Ergebnis>(`${M}/lauf`, { modus }),
  });

  const posten = useMemo(() => (d?.posten ?? []).filter((p) => (filter === 'alle' ? true : filter === 'gemahnt' ? p.stufe > 0 : p.schritt !== 'NICHT_FAELLIG')), [d, filter]);

  const postenSpalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Art', accessor: 'art_txt', width: 150 },
    { Header: 'Nummer', accessor: 'nr', width: 130 },
    { Header: 'Schuldner', accessor: 'name', minWidth: 150 },
    { Header: 'Fällig', accessor: 'faellig', width: 100, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Offen', accessor: 'betrag', width: 110, ...rechts, Cell: ({ row }: Cell) => { const p = row.original as Posten; return <span title={p.betrag < p.gesamt ? `Rest von ${eur(p.gesamt)}` : undefined}>{eur(p.betrag)}</span>; } },
    {
      Header: 'Mahnstufe', accessor: 'stufe', width: 170,
      Cell: ({ row }: Cell) => { const p = row.original as Posten; return p.stufe ? <ObjectStatus state="Negative">{p.stufe_name} · {dat(p.gemahnt_am)}</ObjectStatus> : <span className="portal-muted">–</span>; },
    },
    {
      Header: 'Nächster Schritt', accessor: 'schritt_txt', minWidth: 260,
      Cell: ({ row }: Cell) => {
        const p = row.original as Posten;
        return <span title={p.hinweis}><ObjectStatus state={SCHRITT_STATE[p.schritt]}>{p.schritt_txt}</ObjectStatus>{p.hinweis ? <span className="portal-muted portal-small"> · {p.hinweis}</span> : null}</span>;
      },
    },
    {
      Header: '', id: 'aktion', width: 200, disableSortBy: true,
      Cell: ({ row }: Cell) => {
        const p = row.original as Posten;
        return (
          <FlexBox style={{ gap: '0.25rem' }}>
            <Button design="Transparent" icon="history" tooltip="Mahnhistorie" onClick={() => setHistorie(p)} />
            {darf.ausfuehren && (p.sperre
              ? <Button design="Transparent" icon="unlocked" onClick={() => tun(() => api.post(`${M}/sperren/${p.sperre!.id}/aufheben`, {}))}>Sperre aufheben</Button>
              : <Button design="Transparent" icon="locked" onClick={() => setSperre({ posten: p })}>Mahnsperre</Button>)}
          </FlexBox>
        );
      },
    },
  ];

  const planSpalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Schuldner', accessor: 'name', minWidth: 160 },
    { Header: 'Stufe (Text der E-Mail)', accessor: 'stufe_name', width: 200 },
    { Header: 'Posten', id: 'posten', minWidth: 260, accessor: (r: Record<string, unknown>) => (r as unknown as MahnMail).posten.map((p) => `${p.nr} (${p.naechste_name})`).join(', ') },
    { Header: 'Offen', accessor: 'summe', width: 110, ...rechts, Cell: ({ value }: Cell) => eur(value) },
    { Header: 'Gebühr', accessor: 'gebuehr', width: 90, ...rechts, Cell: ({ value }: Cell) => (value ? eur(value) : '–') },
  ];

  const zeilenSpalten = (mitAktion: boolean): AnalyticalTableColumnDefinition[] => [
    { Header: 'Schuldner', accessor: 'name', minWidth: 150 },
    { Header: 'Posten', accessor: 'nr', width: 130 },
    { Header: 'Stufe', accessor: 'stufe_name', width: 160 },
    { Header: 'Offen', accessor: 'betrag', width: 100, ...rechts, Cell: ({ value }: Cell) => eur(value) },
    { Header: 'Gebühr', accessor: 'gebuehr', width: 80, ...rechts, Cell: ({ value }: Cell) => (value ? eur(value) : '–') },
    { Header: 'Neue Frist', accessor: 'frist', width: 100, Cell: ({ value }: Cell) => dat(value) },
    {
      Header: 'Ergebnis', accessor: 'status', minWidth: 240,
      Cell: ({ row }: Cell) => {
        const z = row.original as LaufZeile;
        const [text, state] = POSTEN_STATUS[z.status] ?? [z.status, 'None'];
        const zusatz = [z.status === 'GESENDET' && z.weg ? `${WEG[z.weg] ?? z.weg}${z.an ? ` an ${z.an}` : ''}` : z.an, z.meldung].filter(Boolean).join(' – ');
        return <span title={zusatz}><ObjectStatus state={state}>{text}</ObjectStatus>{zusatz ? <span className="portal-muted portal-small"> · {zusatz}</span> : null}</span>;
      },
    },
    ...(mitAktion ? [{
      Header: '', id: 'aktion', width: 190, disableSortBy: true,
      Cell: ({ row }: Cell) => ((row.original as LaufZeile).status === 'VORSCHLAG'
        ? <Button design="Transparent" icon="decline" onClick={() => tun(() => api.post(`${M}/posten/${(row.original as LaufZeile).id}/verwerfen`, {}))}>Nicht mahnen</Button> : null),
    }] : []),
  ];

  const laufSpalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Lauf', accessor: 'id', width: 70 },
    { Header: 'Gestartet', accessor: 'gestartet_am', minWidth: 210, Cell: ({ row }: Cell) => { const l = row.original as Lauf; return `${zeit(l.gestartet_am)} · ${l.art === 'AUTO' ? 'automatisch' : l.gestartet_von}`; } },
    { Header: 'Modus', accessor: 'modus', width: 150, Cell: ({ row }: Cell) => { const l = row.original as Lauf; return l.modus === 'SENDEN' ? 'senden' : l.freigegeben_am ? `Vorschlag, freigegeben von ${l.freigegeben_von}` : 'nur Vorschlag'; } },
    { Header: 'Status', accessor: 'status', minWidth: 200, Cell: ({ row }: Cell) => { const l = row.original as Lauf; const [t, s] = LAUF_STATUS[l.status] ?? [l.status, 'None']; return <span title={l.meldung ?? ''}><ObjectStatus state={s}>{t}</ObjectStatus>{l.meldung ? <span className="portal-muted portal-small"> · {l.meldung}</span> : null}</span>; } },
    { Header: 'Schuldner', accessor: 'schuldner', width: 95, ...rechts },
    { Header: 'gesendet', accessor: 'gesendet', width: 90, ...rechts },
    { Header: 'nicht erreichbar', accessor: 'nicht_erreichbar', width: 130, ...rechts },
    { Header: 'Fehler', accessor: 'fehler', width: 80, ...rechts },
    { Header: 'Betrag', accessor: 'betrag', width: 110, ...rechts, Cell: ({ value }: Cell) => eur(value) },
    { Header: '', id: 'aktion', width: 110, disableSortBy: true, Cell: ({ row }: Cell) => <Button design="Transparent" icon="detail-view" onClick={() => setLauf((row.original as Lauf).id)}>Posten</Button> },
  ];

  const unSpalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Schuldner', accessor: 'name', minWidth: 150 },
    { Header: 'Posten', accessor: 'nr', width: 130 },
    { Header: 'Stufe', accessor: 'naechste_name', width: 160 },
    { Header: 'Offen', accessor: 'betrag', width: 100, ...rechts, Cell: ({ value }: Cell) => eur(value) },
    { Header: 'Grund', id: 'grund', minWidth: 220, accessor: (r: Record<string, unknown>) => { const p = r as unknown as Posten; return [p.versuch?.an, p.versuch?.meldung].filter(Boolean).join(' – '); } },
    { Header: 'Anschrift / Telefon', id: 'kontakt', minWidth: 240, accessor: (r: Record<string, unknown>) => { const k = (r as unknown as Posten).kontakt; return k ? [k.anschrift, k.telefon].filter(Boolean).join(' · ') || '–' : 'nicht im Stamm gefunden'; } },
    ...(darf.ausfuehren ? [{
      Header: '', id: 'aktion', width: 330, disableSortBy: true,
      Cell: ({ row }: Cell) => {
        const p = row.original as Posten;
        return (
          <FlexBox style={{ gap: '0.25rem' }}>
            <Button design="Transparent" icon="letter" onClick={() => setZustellung(p)}>Zustellung vermerken</Button>
            <Button design="Transparent" icon="refresh" disabled={!p.versuch} onClick={() => p.versuch && tun(() => api.post(`${M}/posten/${p.versuch!.id}/erneut`, {}))}>Erneut versuchen</Button>
          </FlexBox>
        );
      },
    }] : []),
  ];

  const sperrSpalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Gilt für', id: 'ziel', minWidth: 220, accessor: (r: Record<string, unknown>) => { const s = r as unknown as Sperre; return s.ebene === 'RECHNUNG' ? `${s.art === 'HALLE' ? 'Hallenrechnung' : 'Verzehrabrechnung'} ${s.schluessel}${s.name ? ` (${s.name})` : ''}` : `alle Posten von ${s.name || s.schluessel}`; } },
    { Header: 'Grund', accessor: 'grund', minWidth: 220 },
    { Header: 'Bis', accessor: 'bis', width: 120, Cell: ({ value }: Cell) => (value ? dat(value) : 'auf Widerruf') },
    { Header: 'Gesetzt', accessor: 'angelegt_am', width: 220, Cell: ({ row }: Cell) => { const s = row.original as Sperre; return `${dat(s.angelegt_am)} · ${s.angelegt_von}`; } },
    {
      Header: 'Stand', id: 'stand', width: 230,
      Cell: ({ row }: Cell) => {
        const s = row.original as Sperre;
        if (s.aufgehoben_am) return <ObjectStatus state="None">aufgehoben {dat(s.aufgehoben_am)} · {s.aufgehoben_von}</ObjectStatus>;
        if (s.bis && s.bis < new Date().toLocaleDateString('sv-SE')) return <ObjectStatus state="None">abgelaufen</ObjectStatus>;
        return darf.ausfuehren ? <Button design="Transparent" icon="unlocked" onClick={() => tun(() => api.post(`${M}/sperren/${s.id}/aufheben`, {}))}>Aufheben</Button> : <ObjectStatus state="Critical">aktiv</ObjectStatus>;
      },
    },
  ];

  const a = d?.automatik;
  const automatikText = !a ? '' : !automatikAn || !a.funktion ? 'Der automatische Mahnlauf ist als Funktion abgeschaltet (Administration → Einstellungen → Funktionen).'
    : !a.aktiv ? 'Die Automatik ist aus: Ohne Start von Hand wird nichts gemahnt und keine E-Mail gesendet.'
      : `Automatik an: ${a.wochentage.split(',').map((t) => TAGE[Number(t) - 1]).join(', ')} um ${a.uhrzeit} Uhr – ${a.modus === 'SENDEN' ? 'sendet automatisch' : 'erzeugt nur einen Vorschlag zur Freigabe'}${a.naechster ? `, nächster Lauf am ${dat(a.naechster)}` : ''}.`;

  return (
    <AppPage title="Mahnwesen" subtitle="Zahlungserinnerungen und Mahnungen für offene Hallenrechnungen und Verzehrabrechnungen"
             actions={darf.admin ? <Button design="Transparent" icon="action-settings" tooltip="Einstellungen (Administration → Einstellungen → TC Oberthal → Mahnwesen)" onClick={() => navigate(einstellungLink('tco', 'mahnwesen'))} /> : undefined}
             header={d ? (
               <FlexBox wrap="Wrap" style={{ gap: '0.5rem 2rem' }}>
                 <HeaderKpi label={`${d.kennzahlen.offen} offene Posten`} value={eur(d.kennzahlen.offen_betrag)} />
                 <HeaderKpi label={`${d.kennzahlen.faellig} davon fällig`} value={eur(d.kennzahlen.faellig_betrag)} state={d.kennzahlen.faellig ? 'Critical' : 'Positive'} />
                 <HeaderKpi label="bereits gemahnt" value={d.kennzahlen.gemahnt} />
                 <HeaderKpi label="manuell zu klären" value={d.kennzahlen.klaeren} state={d.kennzahlen.klaeren ? 'Negative' : 'None'} />
               </FlexBox>
             ) : undefined}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {info && <MessageStrip design="Positive" onClose={() => setInfo(null)} style={{ marginBottom: '0.5rem' }}>{info}</MessageStrip>}
      {d && !d.mail && <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>Der E-Mail-Versand ist nicht eingerichtet (Administration → Schnittstellen) – Mahnungen können nicht gesendet werden.</MessageStrip>}
      <TabContainer onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key ?? 'posten')}>
        <Tab data-key="posten" text={`Offene Posten (${d?.posten.length ?? 0})`} icon="money-bills" selected={tab === 'posten'}>
          <FlexBox alignItems="Center" wrap="Wrap" style={{ gap: '0.5rem 1rem', marginBottom: '0.5rem' }}>
            <Label showColon>Anzeigen</Label>
            <Select style={{ minWidth: '16rem' }} accessibleName="Posten filtern" onChange={(e) => setFilter(((e.detail.selectedOption as HTMLElement).dataset.f ?? 'faellig') as typeof filter)}>
              <Option data-f="faellig" selected={filter === 'faellig'}>fällige Posten</Option>
              <Option data-f="gemahnt" selected={filter === 'gemahnt'}>bereits gemahnte Posten</Option>
              <Option data-f="alle" selected={filter === 'alle'}>alle offenen Posten</Option>
            </Select>
            <Button icon="refresh" design="Transparent" tooltip="Neu laden" onClick={() => laden()} />
          </FlexBox>
          <AnalyticalTable minRows={1} columns={postenSpalten} data={posten} visibleRows={zeilenHoehe(posten.length)} sortable loading={!d}
                           noDataText={filter === 'faellig' ? 'Keine fälligen Posten – alles im Zahlungsziel oder bezahlt' : 'Keine offenen Posten'} />
        </Tab>

        <Tab data-key="vorschlag" text={`Nächster Lauf${d?.vorschlag ? ' · Vorschlag offen' : ''}`} icon="payment-approval" selected={tab === 'vorschlag'}>
          <MessageStrip design={a?.aktiv && a.funktion && automatikAn ? 'Information' : 'Critical'} hideCloseButton style={{ marginBottom: '0.75rem' }}>{automatikText}</MessageStrip>
          {d?.vorschlag && (
            <Section title={`Vorschlag aus Lauf ${d.vorschlag.id} vom ${zeit(d.vorschlag.gestartet_am)}`} count={d.vorschlag.zeilen?.length ?? 0} flush
                     status={<ObjectStatus state="Critical" inverted>wartet auf Freigabe</ObjectStatus>}
                     actions={darf.ausfuehren ? <>
                       <Button design="Emphasized" icon="email" loading={busy} disabled={!d.mail || d.laeuft}
                               onClick={() => setFrage({
                                 titel: 'Vorschlag freigeben und senden', ok: 'Freigeben und senden',
                                 text: `Die vorgeschlagenen Mahnungen an ${d.vorschlag!.schuldner} Schuldner (${eur(d.vorschlag!.betrag)}) gehen jetzt per E-Mail hinaus. Inzwischen bezahlte oder gesperrte Posten entfallen.`,
                                 tun: () => api.post<Ergebnis>(`${M}/laeufe/${d.vorschlag!.id}/freigeben`, {}),
                               })}>Freigeben und senden</Button>
                       <Button design="Transparent" icon="decline" disabled={busy} onClick={() => tun(() => api.post(`${M}/laeufe/${d.vorschlag!.id}/verwerfen`, {}))}>Verwerfen</Button>
                     </> : undefined}>
              <AnalyticalTable minRows={1} columns={zeilenSpalten(darf.ausfuehren)} data={d.vorschlag.zeilen ?? []} visibleRows={zeilenHoehe(d.vorschlag.zeilen?.length ?? 0)} />
            </Section>
          )}
          <Section title="Vorschau: Das würde der nächste Lauf tun" count={d?.plan.mails.length ?? 0} flush
                   actions={darf.ausfuehren ? <>
                     <Button icon="simulate" disabled={busy || !d?.plan.mails.length || d.laeuft} onClick={() => starten('VORSCHLAG')}>Vorschlag erzeugen</Button>
                     <Button icon="email" design="Emphasized" disabled={busy || !d?.plan.mails.length || !d.mail || d.laeuft} onClick={() => starten('SENDEN')}>Jetzt senden</Button>
                   </> : undefined}>
            <AnalyticalTable minRows={1} columns={planSpalten} data={d?.plan.mails ?? []} visibleRows={zeilenHoehe(d?.plan.mails.length ?? 0)} loading={!d}
                             noDataText="Nichts zu mahnen – der nächste Lauf würde keine E-Mail senden" />
          </Section>
          {d && (
            <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>
              Je Schuldner eine E-Mail mit allen fälligen Posten; die höchste Stufe bestimmt den Text. Neue Zahlungsfrist: {dat(d.plan.frist)}.
              {d.plan.zurueckgestellt ? ` ${d.plan.zurueckgestellt} weitere Schuldner warten wegen der Obergrenze von ${d.max_je_lauf} E-Mails je Lauf auf den nächsten Lauf.` : ''}
              {d.mindestbetrag ? ` Unter ${eur(d.mindestbetrag)} je Schuldner wird nicht gemahnt.` : ''}
              {d.vorschlag ? ' Ein neuer Lauf ersetzt den offenen Vorschlag.' : ''}
            </Text>
          )}
        </Tab>

        <Tab data-key="laeufe" text={`Läufe (${laeufe.length})`} icon="history" selected={tab === 'laeufe'}>
          <AnalyticalTable minRows={1} columns={laufSpalten} data={laeufe} visibleRows={zeilenHoehe(laeufe.length)} noDataText="Noch kein Mahnlauf" />
        </Tab>

        <Tab data-key="unerreichbar" text={`Nicht erreichbar (${d?.unerreichbar.length ?? 0})`} icon="email" selected={tab === 'unerreichbar'}>
          <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.5rem' }}>
            Schuldner ohne E-Mail-Adresse oder mit abgelehntem Versand: Die Stufe gilt als nicht zugestellt. Bitte per Brief oder Anruf erinnern und die Zustellung vermerken –
            erst dann zählt die Stufe. Ändert sich die E-Mail-Adresse im Stamm, versucht es der nächste Lauf von selbst erneut.
          </MessageStrip>
          <AnalyticalTable minRows={1} columns={unSpalten} data={d?.unerreichbar ?? []} visibleRows={zeilenHoehe(d?.unerreichbar.length ?? 0)} loading={!d} noDataText="Alle Schuldner waren per E-Mail erreichbar" />
        </Tab>

        <Tab data-key="sperren" text={`Mahnsperren (${sperren.filter((s) => !s.aufgehoben_am).length})`} icon="locked" selected={tab === 'sperren'}>
          <FlexBox style={{ marginBottom: '0.5rem' }}>
            {darf.ausfuehren && <Button icon="add" onClick={() => setSperre({})}>Mahnsperre setzen</Button>}
          </FlexBox>
          <AnalyticalTable minRows={1} columns={sperrSpalten} data={sperren} visibleRows={zeilenHoehe(sperren.length)} noDataText="Keine Mahnsperren" />
        </Tab>
      </TabContainer>

      {frage && (
        <ConfirmDialog open title={frage.titel} text={frage.text} confirmText={frage.ok} onCancel={() => setFrage(null)}
                       onConfirm={() => { const f = frage.tun; setFrage(null); tun(f); }} />
      )}
      {historie && <HistorieDialog posten={historie} onClose={() => setHistorie(null)} />}
      {lauf !== null && <LaufDialog id={lauf} spalten={zeilenSpalten(false)} onClose={() => setLauf(null)} />}
      {sperre && <SperreDialog posten={sperre.posten} onClose={(ok) => { setSperre(null); if (ok) laden(); }} />}
      {zustellung && <ZustellungDialog posten={zustellung} onClose={(ok) => { setZustellung(null); if (ok) laden(); }} />}
    </AppPage>
  );
}

/** Mahnhistorie eines Postens: jede Stufe und jeder Versuch */
function HistorieDialog({ posten, onClose }: { posten: Posten; onClose: () => void }) {
  interface Zeile { id: number; lauf_id: number; stufe_name: string; status: string; weg: string | null; an: string | null; meldung: string | null; betrag: number; gebuehr: number; frist: string | null; am: string; erledigt_von: string | null; lauf_art: string }
  const [z, setZ] = useState<Zeile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.get<Zeile[]>(`${M}/historie?art=${posten.art}&nr=${encodeURIComponent(posten.nr)}`).then(setZ).catch((e) => setError((e as Error).message)); }, [posten]);
  const spalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Wann', accessor: 'am', width: 170, Cell: ({ value }: Cell) => zeit(value) },
    { Header: 'Stufe', accessor: 'stufe_name', width: 160 },
    { Header: 'Ergebnis', accessor: 'status', minWidth: 260, Cell: ({ row }: Cell) => { const x = row.original as Zeile; const [t, s] = POSTEN_STATUS[x.status] ?? [x.status, 'None']; return <span><ObjectStatus state={s}>{t}</ObjectStatus><span className="portal-muted portal-small"> {[x.weg ? WEG[x.weg] : null, x.an, x.meldung].filter(Boolean).join(' – ')}</span></span>; } },
    { Header: 'Offen', accessor: 'betrag', width: 100, ...rechts, Cell: ({ value }: Cell) => eur(value) },
    { Header: 'Frist', accessor: 'frist', width: 100, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Lauf', accessor: 'lauf_id', width: 150, Cell: ({ row }: Cell) => { const x = row.original as Zeile; return `${x.lauf_id} · ${x.lauf_art === 'AUTO' ? 'automatisch' : x.erledigt_von ?? 'von Hand'}`; } },
  ];
  return (
    <Dialog open headerText={`Mahnhistorie ${posten.art_txt} ${posten.nr} · ${posten.name}`} style={{ width: 'min(64rem, 98vw)' }} onClose={onClose}
            footer={<Bar endContent={<Button onClick={onClose}>Schließen</Button>} />}>
      {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
      <Text style={{ display: 'block', marginBottom: '0.5rem' }}>Rechnungsdatum {dat(posten.datum)} · fällig {dat(posten.faellig)} · offen {eur(posten.betrag)}{posten.betrag < posten.gesamt ? ` von ${eur(posten.gesamt)}` : ''}</Text>
      <AnalyticalTable minRows={1} columns={spalten} data={z ?? []} visibleRows={zeilenHoehe(z?.length ?? 0)} loading={!z} noDataText="Noch nicht gemahnt" />
    </Dialog>
  );
}

function LaufDialog({ id, spalten, onClose }: { id: number; spalten: AnalyticalTableColumnDefinition[]; onClose: () => void }) {
  const [l, setL] = useState<Lauf | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.get<Lauf>(`${M}/laeufe/${id}`).then(setL).catch((e) => setError((e as Error).message)); }, [id]);
  return (
    <Dialog open headerText={`Mahnlauf ${id}${l ? ` vom ${zeit(l.gestartet_am)}` : ''}`} style={{ width: 'min(72rem, 98vw)' }} onClose={onClose}
            footer={<Bar endContent={<Button onClick={onClose}>Schließen</Button>} />}>
      {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
      {l && (
        <Text style={{ display: 'block', marginBottom: '0.5rem' }}>
          {l.art === 'AUTO' ? 'Automatischer Lauf' : `Von Hand gestartet von ${l.gestartet_von}`} · Stichtag {dat(l.stichtag)} · {(LAUF_STATUS[l.status] ?? [l.status])[0]}
          {l.freigegeben_am ? ` · freigegeben ${zeit(l.freigegeben_am)} von ${l.freigegeben_von}` : ''}{l.zurueckgestellt ? ` · ${l.zurueckgestellt} Schuldner zurückgestellt (Obergrenze)` : ''}{l.meldung ? ` · ${l.meldung}` : ''}
        </Text>
      )}
      <AnalyticalTable minRows={1} columns={spalten} data={l?.zeilen ?? []} visibleRows={zeilenHoehe(l?.zeilen?.length ?? 0)} loading={!l} noDataText="Der Lauf hatte nichts zu mahnen" />
    </Dialog>
  );
}

/** Mahnsperre je Rechnung oder je Mitglied/Kunde – mit Grund und optionalem Ablaufdatum */
function SperreDialog({ posten, onClose }: { posten?: Posten; onClose: (ok: boolean) => void }) {
  const [ebene, setEbene] = useState<'RECHNUNG' | 'SCHULDNER'>(posten ? 'RECHNUNG' : 'SCHULDNER');
  const [art, setArt] = useState<'HALLE' | 'VERZEHR'>(posten?.art ?? 'HALLE');
  const [nr, setNr] = useState(posten?.nr ?? '');
  const [person, setPerson] = useState<{ key: string; text: string } | null>(posten && !posten.schuldner.startsWith('K:') ? { key: posten.schuldner, text: posten.name } : null);
  const [treffer, setTreffer] = useState<AuswahlEintrag[]>([]);
  const [grund, setGrund] = useState('');
  const [bis, setBis] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const suchen = (q: string) => {
    if (q.trim().length < 2) return;
    api.get<{ schluessel: string; name: string; art: string }[]>(`${M}/schuldner?q=${encodeURIComponent(q.trim())}`)
      .then((l) => setTreffer(l.map((x) => ({ key: x.schluessel, text: x.name, zusatz: x.art })))).catch(() => undefined);
  };
  async function sichern() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string }>(`${M}/sperren`, ebene === 'RECHNUNG'
        ? { ebene, art, schluessel: nr.trim(), name: posten?.nr === nr ? posten.name : '', grund, bis: bis || null }
        : { ebene, schluessel: person?.key ?? '', name: person?.text ?? '', grund, bis: bis || null });
      toast(r.text);
      onClose(true);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const bereit = grund.trim().length >= 3 && (ebene === 'RECHNUNG' ? !!nr.trim() : !!person);
  return (
    <Dialog open headerText="Mahnsperre setzen" style={{ width: 'min(36rem, 96vw)' }} onClose={() => onClose(false)}
            footer={<Bar endContent={<><Button design="Emphasized" icon="locked" loading={busy} disabled={!bereit} onClick={sichern}>Sperre setzen</Button><Button onClick={() => onClose(false)}>Abbrechen</Button></>} />}>
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <FormGrid columns={1}>
        <FieldBox label="Sperre gilt für">
          <Select onChange={(e) => setEbene(((e.detail.selectedOption as HTMLElement).dataset.e ?? 'RECHNUNG') as typeof ebene)}>
            <Option data-e="RECHNUNG" selected={ebene === 'RECHNUNG'}>eine Rechnung bzw. Abrechnung</Option>
            <Option data-e="SCHULDNER" selected={ebene === 'SCHULDNER'}>alle Posten eines Mitglieds bzw. Kunden</Option>
          </Select>
        </FieldBox>
        {ebene === 'RECHNUNG' ? (
          <>
            <FieldBox label="Art">
              <Select onChange={(e) => setArt(((e.detail.selectedOption as HTMLElement).dataset.a ?? 'HALLE') as typeof art)}>
                <Option data-a="HALLE" selected={art === 'HALLE'}>Hallenrechnung</Option>
                <Option data-a="VERZEHR" selected={art === 'VERZEHR'}>Verzehrabrechnung</Option>
              </Select>
            </FieldBox>
            <TextField label="Rechnungs- bzw. Belegnummer" required value={nr} onChange={setNr} />
          </>
        ) : (
          <FieldBox label="Mitglied bzw. Kunde" required>
            {person
              ? <FlexBox alignItems="Center" style={{ gap: '0.5rem' }}><Text>{person.text}</Text><Button design="Transparent" icon="decline" tooltip="Andere Person wählen" onClick={() => setPerson(null)} /></FlexBox>
              : <AuswahlBox eintraege={treffer} wert="" filter="None" onSuche={suchen} placeholder="Name tippen (mindestens 2 Zeichen)" style={{ width: '100%' }}
                            onWaehle={(k) => { const t = treffer.find((x) => x.key === k); if (t) setPerson({ key: t.key, text: t.text }); }} />}
          </FieldBox>
        )}
        <FieldBox label="Grund" required>
          <TextArea rows={2} value={grund} placeholder="z. B. Ratenzahlung vereinbart, Rechnung strittig" onInput={(e) => setGrund(e.target.value)} />
        </FieldBox>
        <FieldBox label="Gilt bis (leer = auf Widerruf)">
          <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={bis} onChange={(e) => setBis(e.detail.value)} />
        </FieldBox>
      </FormGrid>
    </Dialog>
  );
}

/** nicht per E-Mail erreicht: Brief oder Anruf vermerken – damit gilt die Stufe als zugestellt */
function ZustellungDialog({ posten, onClose }: { posten: Posten; onClose: (ok: boolean) => void }) {
  const [weg, setWeg] = useState('BRIEF');
  const [bemerkung, setBemerkung] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function sichern() {
    if (!posten.versuch) return;
    setBusy(true); setError(null);
    try { toast((await api.post<{ text: string }>(`${M}/posten/${posten.versuch.id}/zugestellt`, { weg, bemerkung })).text); onClose(true); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open headerText={`Zustellung vermerken: ${posten.naechste_name} · ${posten.name}`} style={{ width: 'min(34rem, 96vw)' }} onClose={() => onClose(false)}
            footer={<Bar endContent={<><Button design="Emphasized" icon="accept" loading={busy} onClick={sichern}>Als zugestellt vermerken</Button><Button onClick={() => onClose(false)}>Abbrechen</Button></>} />}>
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <Text style={{ display: 'block', marginBottom: '0.75rem' }}>{posten.art_txt} {posten.nr} über {eur(posten.betrag)}. Mit dem Vermerk gilt die Stufe als zugestellt; die Frist für die nächste Stufe beginnt heute.</Text>
      <FormGrid columns={1}>
        <FieldBox label="Zugestellt per">
          <Select onChange={(e) => setWeg((e.detail.selectedOption as HTMLElement).dataset.w ?? 'BRIEF')}>
            <Option data-w="BRIEF" selected={weg === 'BRIEF'}>Brief</Option>
            <Option data-w="TELEFON" selected={weg === 'TELEFON'}>Anruf</Option>
            <Option data-w="PERSOENLICH" selected={weg === 'PERSOENLICH'}>persönlich</Option>
          </Select>
        </FieldBox>
        <TextField label="Bemerkung" value={bemerkung} onChange={setBemerkung} placeholder="z. B. Brief am 12.11. eingeworfen" />
      </FormGrid>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Kapitel „Mahnwesen“ der App Einstellungen
// ---------------------------------------------------------------------------

interface Cfg {
  aktiv: boolean; modus: 'VORSCHLAG' | 'SENDEN'; wochentage: number[]; uhrzeit: string; zahlungsziel_tage: number | null | ''; frist_tage: number | string;
  stufen: { name: string; tage: number | string; gebuehr: number | string }[]; mindestbetrag: number | string; max_je_lauf: number | string; arten: string[];
  halle_gedruckt: boolean; anhang: boolean; absender: string; absender_name: string; antwort_an: string; kopie_an: string;
  verein_zahlungsziel: number; verein_email: string; max_stufen: number; funktion: boolean; naechster: string | null; mail: boolean; letzter_lauf: string | null;
}

export function MahnKapitel() {
  const [c, setC] = useState<Cfg | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const laden = () => api.get<Cfg>(`${M}/einstellungen`).then(setC).catch((e) => setError((e as Error).message));
  useEffect(() => { laden(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const s = <K extends keyof Cfg>(k: K) => (x: Cfg[K]) => c && setC({ ...c, [k]: x });
  const stufe = (i: number, k: 'name' | 'tage' | 'gebuehr', x: string) => c && setC({ ...c, stufen: c.stufen.map((y, j) => (j === i ? { ...y, [k]: x } : y)) });
  const zahl = (x: number | string) => String(x).replace(',', '.');
  async function sichern() {
    if (!c) return;
    setBusy(true); setError(null);
    try {
      const r = await api.put<{ text: string }>(`${M}/einstellungen`, {
        aktiv: c.aktiv, modus: c.modus, wochentage: c.wochentage, uhrzeit: c.uhrzeit, zahlungsziel_tage: c.zahlungsziel_tage === null ? '' : c.zahlungsziel_tage,
        frist_tage: c.frist_tage, stufen: c.stufen.map((x) => ({ name: x.name, tage: x.tage, gebuehr: zahl(x.gebuehr) })), mindestbetrag: zahl(c.mindestbetrag),
        max_je_lauf: c.max_je_lauf, arten: c.arten, halle_gedruckt: c.halle_gedruckt, anhang: c.anhang,
        absender: c.absender, absender_name: c.absender_name, antwort_an: c.antwort_an, kopie_an: c.kopie_an,
      });
      toast(r.text, 6000);
      await laden();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const tag = (n: number, an: boolean) => c && setC({ ...c, wochentage: an ? [...new Set([...c.wochentage, n])].sort() : c.wochentage.filter((x) => x !== n) });
  const artSetzen = (a: string, an: boolean) => c && setC({ ...c, arten: an ? [...new Set([...c.arten, a])] : c.arten.filter((x) => x !== a) });
  return (
    <div style={{ maxWidth: '56rem' }}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {c && (
        <>
          <MessageStrip design={c.aktiv && c.funktion ? (c.modus === 'SENDEN' ? 'Critical' : 'Information') : 'Information'} hideCloseButton style={{ marginBottom: '0.75rem' }}>
            {!c.funktion ? 'Der automatische Mahnlauf ist als Funktion abgeschaltet (Einstellungen → Funktionen) – der Zeitplan ruht.'
              : !c.aktiv ? 'Die Automatik ist aus: Es geht keine Mahnung von selbst hinaus. Erst mit dem Haken „Automatik eingeschaltet“ und „Sichern“ läuft der Mahnlauf im Hintergrund.'
                : c.modus === 'SENDEN' ? `Die Automatik sendet Zahlungserinnerungen und Mahnungen ohne weitere Freigabe.${c.naechster ? ` Nächster Lauf: ${dat(c.naechster)}, ${c.uhrzeit} Uhr.` : ''}`
                  : `Die Automatik erzeugt nur einen Vorschlag; der Kassenwart gibt ihn in der App „Mahnwesen“ frei.${c.naechster ? ` Nächster Lauf: ${dat(c.naechster)}, ${c.uhrzeit} Uhr.` : ''}`}
          </MessageStrip>
          {!c.mail && <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.75rem' }}>Der E-Mail-Versand ist nicht eingerichtet (Administration → Schnittstellen).</MessageStrip>}

          <Section title="Automatischer Lauf im Hintergrund">
            <FormGrid>
              <FieldBox label="Automatik">
                <CheckBox checked={c.aktiv} text="Automatik eingeschaltet" onChange={(e) => s('aktiv')(e.target.checked)} />
              </FieldBox>
              <FieldBox label="Modus">
                <Select onChange={(e) => s('modus')(((e.detail.selectedOption as HTMLElement).dataset.m ?? 'VORSCHLAG') as Cfg['modus'])}>
                  <Option data-m="VORSCHLAG" selected={c.modus === 'VORSCHLAG'}>nur Vorschlag – Kassenwart gibt frei</Option>
                  <Option data-m="SENDEN" selected={c.modus === 'SENDEN'}>automatisch senden</Option>
                </Select>
              </FieldBox>
              <FieldBox label="Wochentage">
                <FlexBox wrap="Wrap">{TAGE.map((t, i) => <CheckBox key={t} text={t} checked={c.wochentage.includes(i + 1)} onChange={(e) => tag(i + 1, e.target.checked)} />)}</FlexBox>
              </FieldBox>
              <TextField label="Uhrzeit (HH:MM)" value={c.uhrzeit} onChange={s('uhrzeit')} placeholder="08:00" />
              <TextField label="Höchstens E-Mails je Lauf" type="Number" value={String(c.max_je_lauf)} onChange={s('max_je_lauf')} />
            </FormGrid>
          </Section>

          <Section title="Fälligkeit und Posten">
            <FormGrid>
              <TextField label={`Zahlungsziel in Tagen (leer = wie auf der Rechnung: ${c.verein_zahlungsziel} Tage)`} type="Number" value={c.zahlungsziel_tage === null ? '' : String(c.zahlungsziel_tage)}
                         onChange={(x) => s('zahlungsziel_tage')(x === '' ? '' : Number(x))} />
              <TextField label="Neue Zahlungsfrist in der E-Mail (Tage)" type="Number" value={String(c.frist_tage)} onChange={s('frist_tage')} />
              <TextField label="Mindestbetrag je Schuldner (€) – darunter wird nicht gemahnt" value={String(c.mindestbetrag)} onChange={s('mindestbetrag')} />
              <FieldBox label="Gemahnt werden">
                <FlexBox direction="Column">
                  <CheckBox text="Hallenrechnungen (versendet, teilbezahlt)" checked={c.arten.includes('HALLE')} onChange={(e) => artSetzen('HALLE', e.target.checked)} />
                  <CheckBox text="auch nur gedruckte, nicht als versendet gekennzeichnete Hallenrechnungen" checked={c.halle_gedruckt} disabled={!c.arten.includes('HALLE')} onChange={(e) => s('halle_gedruckt')(e.target.checked)} />
                  <CheckBox text="Verzehrabrechnungen zur Überweisung" checked={c.arten.includes('VERZEHR')} onChange={(e) => artSetzen('VERZEHR', e.target.checked)} />
                </FlexBox>
              </FieldBox>
            </FormGrid>
            <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>
              Fälligkeit = eigenes Fälligkeitsdatum des Belegs (Verzehrabrechnung), sonst Versand- bzw. Rechnungsdatum + Zahlungsziel. Rechnungen „In Bearbeitung“, bezahlte und
              ausgefallene Forderungen sowie Verzehrabrechnungen mit Lastschrift werden nie gemahnt; Beiträge laufen per Lastschrift und gehören nicht zum Mahnwesen.
            </Text>
          </Section>

          <Section title="Stufen" count={c.stufen.length}
                   actions={<Button icon="add" design="Transparent" disabled={c.stufen.length >= c.max_stufen} onClick={() => s('stufen')([...c.stufen, { name: `${c.stufen.length}. Mahnung`, tage: 14, gebuehr: 0 }])}>Stufe hinzufügen</Button>}>
            {c.stufen.map((x, i) => (
              <FlexBox key={i} alignItems="End" wrap="Wrap" style={{ gap: '0.5rem 1rem', marginBottom: '0.5rem' }}>
                <div style={{ flex: '2 1 12rem' }}><Label showColon>Stufe {i + 1}</Label><Input style={{ width: '100%' }} value={x.name} onInput={(e) => stufe(i, 'name', e.target.value)} /></div>
                <div style={{ flex: '1 1 9rem' }}><Label showColon>{i === 0 ? 'Tage nach Fälligkeit' : 'Tage nach vorheriger Stufe'}</Label><Input style={{ width: '100%' }} type="Number" value={String(x.tage)} onInput={(e) => stufe(i, 'tage', e.target.value)} /></div>
                <div style={{ flex: '1 1 7rem' }}><Label showColon>Mahngebühr (€)</Label><Input style={{ width: '100%' }} value={String(x.gebuehr)} onInput={(e) => stufe(i, 'gebuehr', e.target.value)} /></div>
                <Button icon="delete" design="Transparent" tooltip="Stufe entfernen" disabled={c.stufen.length <= 1 || i < c.stufen.length - 1} onClick={() => s('stufen')(c.stufen.slice(0, -1))} />
              </FlexBox>
            ))}
            <Text className="portal-muted portal-small" style={{ display: 'block' }}>
              Nach der letzten Stufe geht keine weitere E-Mail hinaus: Ist deren Frist verstrichen, steht der Posten als „Forderung manuell klären“ im Arbeitsvorrat des Kassenwarts.
              Die Texte je Stufe stehen im Kapitel „E-Mail-Texte“ (Bereich Mahnwesen). Die Mahngebühr der höchsten Stufe wird je E-Mail einmal ausgewiesen.
            </Text>
          </Section>

          <Section title="E-Mail">
            <FormGrid>
              <TextField label="Absender-Adresse (leer = Absender der Anbindung „E-Mail-Versand“)" type="Email" value={c.absender} onChange={s('absender')} placeholder={c.verein_email} />
              <TextField label="Absender-Name" value={c.absender_name} onChange={s('absender_name')} placeholder="Kassenwart" />
              <TextField label="Antwortadresse" type="Email" value={c.antwort_an} onChange={s('antwort_an')} placeholder={c.verein_email} />
              <TextField label="Kopie jeder Mahnung an (Blindkopie, z. B. Kassenwart)" type="Email" value={c.kopie_an} onChange={s('kopie_an')} />
              <FieldBox label="Anhang">
                <CheckBox text="Rechnung bzw. Abrechnung als PDF mit GiroCode beilegen" checked={c.anhang} onChange={(e) => s('anhang')(e.target.checked)} />
              </FieldBox>
            </FormGrid>
          </Section>
        </>
      )}
      <Bar style={{ marginTop: '1rem' }} endContent={<Button design="Emphasized" icon="save" loading={busy} disabled={!c} onClick={sichern}>Sichern</Button>} />
    </div>
  );
}
