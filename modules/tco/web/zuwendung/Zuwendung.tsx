import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, CheckBox, Dialog, FlexBox, Input, Label, Link, MessageStrip, ObjectStatus, Option, Select, Tab, TabContainer, Text,
} from '@ui5/webcomponents-react';
import { ResponsiveTable } from '@core/components/ResponsiveTable';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { AuswahlBox } from '@core/components/AuswahlBox';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { DialogFuss } from '@core/components/DialogFuss';
import { Filter, Filters, HeaderKpi } from '@core/components/Filters';
import { FormGrid, TextField } from '@core/components/FormFields';
import { PdfDialog } from '@core/components/PdfDialog';
import { Empty, Section } from '@core/components/Section';
import { einstellungLink } from '@core/einstellungen';
import { useCan, useFunktion } from '@core/session';
import { toast } from '@core/toast';
import { TCO, dat, eur } from '../util';
import '../instandhaltung/instandhaltung.css';

const Z = `${TCO}/zuwendung`;

export interface Quelle {
  key: string; internenr: string; konto: string; posnr: number; datum: string; betrag: number; text: string; belnr: string; herkunft: 'SOLL' | 'FI'; artname: string;
  spender: string | null; spender_von: 'SOLL' | 'HAND' | null; verzicht: boolean; zbnr: string | null; sperre: string | null; ausschluss: string | null; grund: string | null;
  vorschlag: { adrnr: string; name: string } | null;
}
interface Spender {
  key: string; typ: 'M' | 'X'; adrnr: string | null; spender_id: number | null; name: string; anschrift: string[]; email: string; email_unzustellbar: boolean; fehlt: string[];
  offen: Quelle[]; bestaetigt: Quelle[]; gesperrt: Quelle[]; summe_offen: number;
}
interface Rueck { key: string; internenr: string; datum: string; betrag: number; text: string; kandidaten: string[] }
interface Vorschlag {
  jahr: number; sperren: string[]; bescheid: { ok: boolean; text: string }; spender: Spender[]; ohne_spender: Quelle[]; ausgeschlossen: Quelle[]; rueckbuchungen: Rueck[];
  summe_offen: number; anzahl_offen: number; mail_erlaubt: boolean; paperless: boolean;
}
interface Bestaetigung {
  zbnr: string; jahr: number; art: 'EINZEL' | 'SAMMEL'; status: 'A' | 'S'; status_txt: string; spender_name: string; betrag: number; tag: string | null;
  zeitraum_von: string | null; zeitraum_bis: string | null; ausgestellt_am: string; ausgestellt_von: string; paperless_id: number | null;
  versand_status: string; versand_txt: string; versand_an: string | null; versand_hinweis: string | null; storno_grund: string | null; storno_von: string | null;
  anzahl: number; hinweis: string | null;
}
interface Personen { mitglieder: { key: string; name: string; ort: string }[]; spender: { key: string; name: string; ort: string }[] }
interface Ablage { abgelegt: boolean; text: string; warnungen: string[] }
interface LaufZeile { zbnr: string; name: string; betrag: number; art: string; paperless?: string; versand?: string; drucken?: boolean }

const beleg = (q: { internenr: string }) => String(Number(q.internenr) || q.internenr);
const artText = (a: string) => (a === 'SAMMEL' ? 'Sammelbestätigung' : 'Einzelbestätigung');
const VERSAND_STATE: Record<string, 'None' | 'Positive' | 'Critical' | 'Information'> = { '': 'None', GESENDET: 'Positive', GEDRUCKT: 'Positive', NICHT_VERSENDET: 'Critical' };
const fehlerText = (e: unknown) => (e as Error).message;

/**
 * App „Zuwendungsbestätigungen“ (Finanzen): Jahr wählen, Vorschlagsliste der Spender mit ihren noch nicht bestätigten Spenden,
 * Vorschau, Einzel- bzw. Sammelbestätigung ausstellen, Jahreslauf, Liste der ausgestellten Bestätigungen mit Versand,
 * Druck und Storno. Bestätigt werden nur Geldspenden – nie Mitgliedsbeiträge oder Entgelte.
 */
export function Zuwendung() {
  const can = useCan();
  const an = useFunktion();
  const navigate = useNavigate();
  const darf = { ausfuehren: can('tco.zuwendung:execute'), admin: can('tco.zuwendung:admin') };
  const lauf = darf.ausfuehren && an('tco.zuwendung.jahreslauf');
  const mail = darf.ausfuehren && an('tco.zuwendung.mail');
  const dieses = new Date().getFullYear();
  const [jahr, setJahr] = useState(new Date().getMonth() < 6 ? dieses - 1 : dieses);
  const [tab, setTab] = useState<'vorschlag' | 'liste'>('vorschlag');
  const [v, setV] = useState<Vorschlag | null>(null);
  const [liste, setListe] = useState<Bestaetigung[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pdf, setPdf] = useState<{ url: string; titel: string; gedruckt?: string[] } | null>(null);
  const [offen, setOffen] = useState<Spender | null>(null);
  const [zuordnen, setZuordnen] = useState<Quelle | null>(null);
  const [klaeren, setKlaeren] = useState<Rueck | null>(null);
  const [storno, setStorno] = useState<Bestaetigung | null>(null);
  const [lauffrage, setLauffrage] = useState(false);
  const [laufMail, setLaufMail] = useState(false);
  const [ergebnis, setErgebnis] = useState<{ zeilen: LaufZeile[]; uebersprungen: { name: string; grund: string }[]; laeuft: boolean } | null>(null);

  const laden = useCallback(async (j = jahr) => {
    setBusy(true);
    try {
      const [vs, l] = await Promise.all([api.get<Vorschlag>(`${Z}/vorschlag?jahr=${j}`), api.get<Bestaetigung[]>(`${Z}/bestaetigungen?jahr=${j}`)]);
      setV(vs); setListe(l);
    } catch (e) { setError(fehlerText(e)); } finally { setBusy(false); }
  }, [jahr]);
  useEffect(() => { laden(jahr); }, [jahr]); // eslint-disable-line react-hooks/exhaustive-deps

  const gesperrt = !!v && v.sperren.length > 0;
  const alleQuellen = useMemo(() => new Map([...(v?.spender ?? []).flatMap((s) => [...s.offen, ...s.gesperrt, ...s.bestaetigt]), ...(v?.ohne_spender ?? [])].map((q) => [q.key, q])), [v]);
  const bereit = (v?.spender ?? []).filter((s) => s.offen.length && !s.fehlt.length && !s.gesperrt.some((q) => !q.ausschluss));

  async function ausstellen(s: Spender, art: 'EINZEL' | 'SAMMEL', quellen: string[] | null) {
    setError(null); setInfo(null);
    try {
      const r = await api.post<{ zbnr: string; text: string; paperless: Ablage }>(`${Z}/bestaetigungen`, { art, jahr, spender: s.key, quellen });
      toast(r.text, 6000);
      setInfo([r.paperless.text, ...r.paperless.warnungen].join(' · '));
      setOffen(null);
      await laden();
      setPdf({ url: `${Z}/bestaetigungen/${r.zbnr}/pdf`, titel: `${artText(art)} ${r.zbnr}`, gedruckt: [r.zbnr] });
    } catch (e) { setError(fehlerText(e)); setOffen(null); }
  }

  async function senden(b: { zbnr: string }) {
    setError(null);
    try {
      const r = await api.post<{ versendet: boolean; text: string }>(`${Z}/bestaetigungen/${b.zbnr}/senden`, {});
      if (r.versendet) toast(r.text, 5000); else setError(r.text);
      laden();
    } catch (e) { setError(fehlerText(e)); }
  }
  async function gedruckt(nummern: string[]) {
    try { await api.post(`${Z}/bestaetigungen/gedruckt`, { nummern }); toast('Als gedruckt vermerkt'); laden(); } catch (e) { setError(fehlerText(e)); }
  }
  async function ablegen(b: Bestaetigung) {
    setError(null);
    try { const r = await api.post<Ablage>(`${Z}/bestaetigungen/${b.zbnr}/paperless`, {}); toast(r.text, 6000); laden(); } catch (e) { setError(fehlerText(e)); }
  }
  async function wiederAufnehmen(q: Quelle) {
    try { await api.put(`${Z}/quelle`, { key: q.key, ausschluss: null }); laden(); } catch (e) { setError(fehlerText(e)); }
  }

  /** Jahreslauf: ausstellen, dann je Bestätigung in Paperless ablegen und – wenn gewählt – per E-Mail senden */
  async function jahreslauf(mitMail: boolean) {
    setLauffrage(false); setError(null); setInfo(null);
    try {
      const r = await api.post<{ ausgestellt: LaufZeile[]; uebersprungen: { name: string; grund: string }[]; text: string }>(`${Z}/jahreslauf`, { jahr });
      toast(r.text, 6000);
      const zeilen: LaufZeile[] = r.ausgestellt.map((z) => ({ ...z }));
      setErgebnis({ zeilen, uebersprungen: r.uebersprungen, laeuft: zeilen.length > 0 });
      for (const z of zeilen) {
        if (v?.paperless) z.paperless = await api.post<Ablage>(`${Z}/bestaetigungen/${z.zbnr}/paperless`, {}).then((a) => 'abgelegt', (e) => fehlerText(e));
        if (mitMail) {
          const s = await api.post<{ versendet: boolean; text: string }>(`${Z}/bestaetigungen/${z.zbnr}/senden`, {}).catch((e) => ({ versendet: false, text: fehlerText(e) }));
          z.versand = s.versendet ? 'gesendet' : 'nicht versendet – bitte drucken'; z.drucken = !s.versendet;
        } else z.drucken = true;
        setErgebnis({ zeilen: [...zeilen], uebersprungen: r.uebersprungen, laeuft: true });
      }
      setErgebnis({ zeilen: [...zeilen], uebersprungen: r.uebersprungen, laeuft: false });
      laden();
    } catch (e) { setError(fehlerText(e)); }
  }

  const spalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Spender', accessor: 'name', minWidth: 180, Cell: ({ row }: Cell) => { const s = row.original as Spender; return <Link onClick={() => setOffen(s)}>{s.name}</Link>; } },
    { Header: 'Anschrift', id: 'anschrift', minWidth: 200, accessor: (r: Record<string, unknown>) => (r as unknown as Spender).anschrift.join(', ') },
    { Header: 'Art', id: 'typ', width: 110, accessor: (r: Record<string, unknown>) => ((r as unknown as Spender).typ === 'M' ? 'Mitglied/Zahler' : 'ohne Mitgliedschaft') },
    { Header: 'offen', id: 'n', width: 70, hAlign: 'End', accessor: (r: Record<string, unknown>) => (r as unknown as Spender).offen.length },
    { Header: 'Summe offen', accessor: 'summe_offen', width: 120, hAlign: 'End', Cell: ({ value }: Cell) => eur(value) },
    { Header: 'bestätigt', id: 'b', width: 90, hAlign: 'End', accessor: (r: Record<string, unknown>) => (r as unknown as Spender).bestaetigt.length },
    {
      Header: 'Stand', id: 'stand', minWidth: 200,
      Cell: ({ row }: Cell) => {
        const s = row.original as Spender;
        if (s.fehlt.length) return <ObjectStatus state="Negative">Anschrift unvollständig: {s.fehlt.join(', ')}</ObjectStatus>;
        if (s.gesperrt.some((q) => !q.ausschluss)) return <ObjectStatus state="Critical">{s.gesperrt.length} Spende(n) ungeklärt</ObjectStatus>;
        if (!s.offen.length) return <ObjectStatus state="Positive">alles bestätigt</ObjectStatus>;
        return <ObjectStatus state="Information">bereit</ObjectStatus>;
      },
    },
    { Header: '', id: 'aktion', width: 130, Cell: ({ row }: Cell) => <Button design="Transparent" icon="detail-view" onClick={() => setOffen(row.original as Spender)}>Spenden</Button> },
  ];

  const quellSpalten = (aktion: (q: Quelle) => ReactNode): AnalyticalTableColumnDefinition[] => [
    { Header: 'Datum', accessor: 'datum', width: 100, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Beleg', id: 'beleg', width: 90, accessor: (r: Record<string, unknown>) => beleg(r as unknown as Quelle) },
    { Header: 'Konto', accessor: 'konto', width: 70 },
    { Header: 'Buchungstext', accessor: 'text', minWidth: 220 },
    { Header: 'Betrag', accessor: 'betrag', width: 110, hAlign: 'End', Cell: ({ value }: Cell) => eur(value) },
    { Header: 'Hinweis', id: 'hinweis', minWidth: 220, Cell: ({ row }: Cell) => { const q = row.original as Quelle; return q.sperre ? <ObjectStatus state="Critical">{q.sperre}</ObjectStatus> : q.vorschlag ? <Text>Vorschlag: {q.vorschlag.name}</Text> : null; } },
    { Header: '', id: 'aktion', width: 150, Cell: ({ row }: Cell) => aktion(row.original as Quelle) },
  ];

  const listSpalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Nummer', accessor: 'zbnr', width: 130, Cell: ({ row }: Cell) => { const b = row.original as Bestaetigung; return <Link onClick={() => setPdf({ url: `${Z}/bestaetigungen/${b.zbnr}/pdf`, titel: `${artText(b.art)} ${b.zbnr}`, gedruckt: b.status === 'A' ? [b.zbnr] : undefined })}>{b.zbnr}</Link>; } },
    { Header: 'Art', id: 'art', width: 150, accessor: (r: Record<string, unknown>) => { const b = r as unknown as Bestaetigung; return b.art === 'SAMMEL' ? `Sammel (${b.anzahl})` : 'Einzel'; } },
    { Header: 'Spender', accessor: 'spender_name', minWidth: 170 },
    { Header: 'Betrag', accessor: 'betrag', width: 110, hAlign: 'End', Cell: ({ value }: Cell) => eur(value) },
    { Header: 'Zuwendung', id: 'tag', width: 170, accessor: (r: Record<string, unknown>) => { const b = r as unknown as Bestaetigung; return b.tag ? dat(b.tag) : `${dat(b.zeitraum_von)} – ${dat(b.zeitraum_bis)}`; } },
    { Header: 'Ausgestellt', id: 'am', width: 170, accessor: (r: Record<string, unknown>) => { const b = r as unknown as Bestaetigung; return `${dat(b.ausgestellt_am)} · ${b.ausgestellt_von}`; } },
    {
      Header: 'Status', id: 'status', minWidth: 200,
      Cell: ({ row }: Cell) => {
        const b = row.original as Bestaetigung;
        if (b.status === 'S') return <ObjectStatus state="Negative">Storniert: {b.storno_grund}</ObjectStatus>;
        if (b.hinweis) return <ObjectStatus state="Negative">{b.hinweis}</ObjectStatus>;
        return <ObjectStatus state={VERSAND_STATE[b.versand_status] ?? 'None'}>{b.versand_txt}{b.versand_status === 'GESENDET' && b.versand_an ? ` (${b.versand_an})` : ''}{b.versand_status === 'NICHT_VERSENDET' && b.versand_hinweis ? `: ${b.versand_hinweis}` : ''}</ObjectStatus>;
      },
    },
    {
      Header: 'Paperless', id: 'pl', width: 140,
      Cell: ({ row }: Cell) => {
        const b = row.original as Bestaetigung;
        if (b.paperless_id) return <ObjectStatus state="Positive">DOKID {String(b.paperless_id).padStart(6, '0')}</ObjectStatus>;
        return darf.ausfuehren ? <Link onClick={() => ablegen(b)}>Jetzt ablegen</Link> : <ObjectStatus state="Critical">nicht abgelegt</ObjectStatus>;
      },
    },
    {
      Header: 'Aktionen', id: 'aktion', width: 250,
      Cell: ({ row }: Cell) => {
        const b = row.original as Bestaetigung;
        if (b.status !== 'A' || !darf.ausfuehren) return null;
        return (
          <FlexBox style={{ gap: '0.25rem' }}>
            {mail && v?.mail_erlaubt && <Button design="Transparent" icon="email" tooltip="Per E-Mail an den Spender senden" onClick={() => senden(b)}>Senden</Button>}
            <Button design="Transparent" icon="print" tooltip="Als gedruckt vermerken" onClick={() => gedruckt([b.zbnr])}>Gedruckt</Button>
            <Button design="Transparent" icon="cancel" tooltip="Stornieren (mit Grund) – danach neu ausstellen" onClick={() => setStorno(b)}>Storno</Button>
          </FlexBox>
        );
      },
    },
  ];
  const druckbar = liste.filter((b) => b.status === 'A' && (b.versand_status === '' || b.versand_status === 'NICHT_VERSENDET')).map((b) => b.zbnr);
  const zuDrucken = (ergebnis?.zeilen ?? []).filter((z) => z.drucken).map((z) => z.zbnr);

  return (
    <AppPage title="Zuwendungsbestätigungen" subtitle="Spendenbescheinigungen für Geldspenden nach § 10b EStG – Einzel- und Sammelbestätigung, Doppel in Paperless"
             actions={<>
               {lauf && <Button design="Emphasized" icon="process" disabled={gesperrt || !bereit.length} onClick={() => { setLaufMail(false); setLauffrage(true); }}>Jahreslauf {jahr}</Button>}
               {darf.admin && <Button design="Transparent" icon="action-settings" tooltip="Einstellungen (Administration → Einstellungen → TC Oberthal → Zuwendungsbestätigungen)" onClick={() => navigate(einstellungLink('tco', 'zuwendung'))} />}
             </>}
             header={(
               <Filters>
                 <Filter label="Jahr der Zuwendung" width="9rem">
                   <Select style={{ width: '100%' }} onChange={(e) => setJahr(Number((e.detail.selectedOption as HTMLElement).dataset.j))}>
                     {Array.from({ length: 7 }, (_x, i) => dieses - i).map((j) => <Option key={j} data-j={j} selected={j === jahr}>{j}</Option>)}
                   </Select>
                 </Filter>
                 <HeaderKpi label="Offene Spenden" value={v ? `${v.anzahl_offen} · ${eur(v.summe_offen)}` : '–'} />
                 <HeaderKpi label="Ohne Spender" value={v?.ohne_spender.length ?? '–'} state={v?.ohne_spender.length ? 'Critical' : 'None'} />
                 <HeaderKpi label="Ausgestellt" value={liste.filter((b) => b.status === 'A').length} />
               </Filters>
             )}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {info && <MessageStrip design="Information" onClose={() => setInfo(null)} style={{ marginBottom: '0.5rem' }}>{info}</MessageStrip>}
      {v && v.sperren.map((s) => (
        <MessageStrip key={s} design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>
          Ausstellung gesperrt: {s}{' '}
          {darf.admin ? <Link onClick={() => navigate(einstellungLink('tco', 'zuwendung'))}>Zu den Einstellungen</Link> : 'Bitte die Administration verständigen.'}
        </MessageStrip>
      ))}

      <TabContainer onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key as typeof tab)}>
        <Tab data-key="vorschlag" text="Vorschlag" icon="money-bills" selected={tab === 'vorschlag'}>
          <Text className="portal-muted portal-small" style={{ display: 'block', marginBottom: '0.75rem' }}>
            Gezählt wird nur, was als Spende tatsächlich eingegangen ist: Buchungen auf den Spendenkonten und verbuchte Lastschriften der Spenden-Beitragsarten.
            Mitgliedsbeiträge, Trainings-, Hallen- und Verzehrentgelte werden nie bestätigt. {v?.bescheid.ok ? v.bescheid.text : ''}
          </Text>

          {v && v.rueckbuchungen.length > 0 && (
            <Section title="Rückbuchungen auf Spendenkonten – bitte klären" count={v.rueckbuchungen.length} status={<ObjectStatus state="Critical">sperren die passende Spende</ObjectStatus>}>
              {v.rueckbuchungen.map((r) => (
                <FlexBox key={r.key} alignItems="Center" wrap="Wrap" style={{ gap: '0.5rem 1rem', marginBottom: '0.25rem' }}>
                  <Text>{dat(r.datum)} · Beleg {beleg(r)} · {r.text} · <b>{eur(r.betrag)}</b>{r.kandidaten.length ? ` · betrifft vermutlich ${r.kandidaten.length} Spende(n)` : ''}</Text>
                  {darf.ausfuehren && <Button design="Transparent" icon="accept" onClick={() => setKlaeren(r)}>Klären</Button>}
                </FlexBox>
              ))}
            </Section>
          )}

          <Section title="Spender" count={v?.spender.length ?? 0} flush>
            <ResponsiveTable minRows={1} columns={spalten} data={v?.spender ?? []} loading={busy} visibleRows={Math.min(Math.max(v?.spender.length ?? 1, 1), 15)} filterable sortable
                             noDataText={`Für ${jahr} gibt es keine Spenden mit Spender.`} />
          </Section>

          {v && v.ohne_spender.length > 0 && (
            <Section title="Buchungen ohne erkannten Spender" count={v.ohne_spender.length} flush>
              <ResponsiveTable minRows={1} data={v.ohne_spender} visibleRows={Math.min(v.ohne_spender.length, 10)}
                               columns={quellSpalten((q) => (darf.ausfuehren ? <Button design="Transparent" icon="person-placeholder" onClick={() => setZuordnen(q)}>Zuordnen</Button> : null))} />
            </Section>
          )}
          {v && v.ausgeschlossen.length > 0 && (
            <Section title="Ausgeschlossen (werden nicht bestätigt)" count={v.ausgeschlossen.length} flush>
              <ResponsiveTable minRows={1} data={v.ausgeschlossen} visibleRows={Math.min(v.ausgeschlossen.length, 8)}
                               columns={quellSpalten((q) => (darf.ausfuehren ? <Button design="Transparent" icon="undo" onClick={() => wiederAufnehmen(q)}>Wieder aufnehmen</Button> : null))} />
            </Section>
          )}
        </Tab>

        <Tab data-key="liste" text={`Ausgestellt (${liste.length})`} icon="history" selected={tab === 'liste'}>
          <FlexBox alignItems="Center" wrap="Wrap" style={{ gap: '0.5rem', marginBottom: '0.5rem' }}>
            <Button icon="print" disabled={!druckbar.length} onClick={() => setPdf({ url: `${Z}/bestaetigungen/druck?nummern=${druckbar.join(',')}`, titel: `Zuwendungsbestätigungen ${jahr} – noch nicht versendet (${druckbar.length})`, gedruckt: druckbar })}>
              Noch nicht Versendete drucken ({druckbar.length})
            </Button>
            <Text className="portal-muted portal-small">Bestätigungen sind unveränderlich – Korrektur nur über Storno (mit Grund) und Neuausstellung. Das PDF bleibt auch nach dem Storno abrufbar.</Text>
          </FlexBox>
          <ResponsiveTable minRows={1} columns={listSpalten} data={liste} loading={busy} visibleRows={Math.min(Math.max(liste.length, 1), 18)} filterable sortable noDataText={`Für ${jahr} wurde noch keine Bestätigung ausgestellt.`} />
        </Tab>
      </TabContainer>

      {offen && <SpenderDialog s={offen} jahr={jahr} gesperrt={gesperrt} darf={darf.ausfuehren} onClose={() => setOffen(null)} onGeaendert={() => { setOffen(null); laden(); }}
                               onVorschau={(art, quellen) => setPdf({ url: `${Z}/vorschau/pdf?art=${art}&jahr=${jahr}&spender=${encodeURIComponent(offen.key)}${quellen ? `&quellen=${encodeURIComponent(quellen.join(','))}` : ''}`, titel: `Vorschau ${artText(art)} – ${offen.name}` })}
                               onAusstellen={(art, quellen) => ausstellen(offen, art, quellen)} onZuordnen={(q) => { setOffen(null); setZuordnen(q); }} />}
      {zuordnen && <ZuordnenDialog q={zuordnen} onClose={() => setZuordnen(null)} onFertig={() => { setZuordnen(null); laden(); }} />}
      {klaeren && <KlaerenDialog r={klaeren} quellen={alleQuellen} onClose={() => setKlaeren(null)} onFertig={() => { setKlaeren(null); laden(); }} />}

      <ConfirmDialog open={!!storno} danger askReason title={`${storno?.zbnr ?? ''} stornieren`} confirmText="Stornieren"
                     text={`Die Bestätigung für ${storno?.spender_name ?? ''} über ${eur(storno?.betrag)} wird storniert. Sie bleibt mit ihrem PDF gespeichert; ihre Spenden stehen danach wieder in der Vorschlagsliste und können neu bestätigt werden.\n\nWurde die Bestätigung bereits übergeben, muss der Spender das Original zurückgeben bzw. über die Stornierung informiert werden.`}
                     onCancel={() => setStorno(null)}
                     onConfirm={async (grund) => {
                       const b = storno; setStorno(null);
                       if (!b) return;
                       try { const r = await api.post<{ text: string }>(`${Z}/bestaetigungen/${b.zbnr}/storno`, { grund }); toast(r.text, 6000); laden(); } catch (e) { setError(fehlerText(e)); }
                     }} />

      <Dialog open={lauffrage} headerText={`Jahreslauf ${jahr}`} onClose={() => setLauffrage(false)}
              footer={<DialogFuss>
                <Button design="Emphasized" onClick={() => jahreslauf(laufMail)}>Ausstellen</Button>
                <Button onClick={() => setLauffrage(false)}>Abbrechen</Button>
              </DialogFuss>}>
        <FlexBox direction="Column" style={{ gap: '0.75rem', maxWidth: '34rem' }}>
          <Text>Für {bereit.length} Spender mit offenen Spenden wird je eine Sammelbestätigung ausgestellt (bei nur einer Spende eine Einzelbestätigung) und in Paperless abgelegt. Spender mit ungeklärten Spenden oder unvollständiger Anschrift werden übersprungen und genannt.</Text>
          {mail && v?.mail_erlaubt
            ? <CheckBox checked={laufMail} onChange={(e) => setLaufMail(e.target.checked)} wrappingType="Normal" text="Anschließend per E-Mail senden – wo das nicht gelingt (keine oder unzustellbare Adresse), steht „bitte drucken“." />
            : <Text className="portal-muted portal-small">Der Versand per E-Mail ist nicht zugelassen bzw. abgeschaltet – die Bestätigungen werden anschließend gedruckt.</Text>}
        </FlexBox>
      </Dialog>

      <Dialog open={!!ergebnis} headerText={`Jahreslauf ${jahr} – Ergebnis`} onClose={() => !ergebnis?.laeuft && setErgebnis(null)}
              footer={<DialogFuss>
                <Button design="Emphasized" icon="print" disabled={ergebnis?.laeuft || !zuDrucken.length}
                        onClick={() => { setPdf({ url: `${Z}/bestaetigungen/druck?nummern=${zuDrucken.join(',')}`, titel: `Zuwendungsbestätigungen ${jahr} – Druck (${zuDrucken.length})`, gedruckt: zuDrucken }); setErgebnis(null); }}>
                  Drucken ({zuDrucken.length})
                </Button>
                <Button disabled={ergebnis?.laeuft} onClick={() => setErgebnis(null)}>Schließen</Button>
              </DialogFuss>}>
        <div style={{ minWidth: 'min(40rem, 85vw)' }}>
          {ergebnis?.laeuft && <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.5rem' }}>Ablage und Versand laufen – bitte warten …</MessageStrip>}
          {ergebnis && !ergebnis.zeilen.length && <Empty>Es wurde keine Bestätigung ausgestellt.</Empty>}
          {ergebnis?.zeilen.map((z) => (
            <FlexBox key={z.zbnr} wrap="Wrap" style={{ gap: '0.25rem 1rem', marginBottom: '0.25rem' }}>
              <Text><b>{z.zbnr}</b> · {z.name} · {eur(z.betrag)} · {artText(z.art)}</Text>
              {z.paperless && <ObjectStatus state={z.paperless === 'abgelegt' ? 'Positive' : 'Critical'}>Paperless: {z.paperless}</ObjectStatus>}
              {z.versand && <ObjectStatus state={z.versand === 'gesendet' ? 'Positive' : 'Critical'}>{z.versand}</ObjectStatus>}
            </FlexBox>
          ))}
          {!!ergebnis?.uebersprungen.length && (
            <MessageStrip design="Critical" hideCloseButton style={{ marginTop: '0.5rem' }}>
              Übersprungen:
              <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.25rem' }}>{ergebnis.uebersprungen.map((u) => <li key={u.name}>{u.name} – {u.grund}</li>)}</ul>
            </MessageStrip>
          )}
        </div>
      </Dialog>

      {pdf && <PdfDialog url={pdf.url} title={pdf.titel} filename={`${pdf.titel.replace(/[^\wäöüÄÖÜß-]+/g, '_')}.pdf`} onClose={() => setPdf(null)}
                         actions={pdf.gedruckt && darf.ausfuehren ? <Button icon="print" onClick={() => { gedruckt(pdf.gedruckt!); setPdf(null); }}>Als gedruckt vermerken</Button> : undefined} />}
    </AppPage>
  );
}

/** Spenden eines Spenders: Auswahl, Verzicht, Vorschau, Einzel- bzw. Sammelbestätigung */
function SpenderDialog({ s, jahr, gesperrt, darf, onClose, onGeaendert, onVorschau, onAusstellen, onZuordnen }: {
  s: Spender; jahr: number; gesperrt: boolean; darf: boolean; onClose: () => void; onGeaendert: () => void;
  onVorschau: (art: 'EINZEL' | 'SAMMEL', quellen: string[] | null) => void; onAusstellen: (art: 'EINZEL' | 'SAMMEL', quellen: string[] | null) => void; onZuordnen: (q: Quelle) => void;
}) {
  const [wahl, setWahl] = useState<Set<string>>(new Set(s.offen.map((q) => q.key)));
  const [error, setError] = useState<string | null>(null);
  const gewaehlt = s.offen.filter((q) => wahl.has(q.key));
  const summe = gewaehlt.reduce((x, q) => x + q.betrag, 0);
  const art: 'EINZEL' | 'SAMMEL' = gewaehlt.length > 1 ? 'SAMMEL' : 'EINZEL';
  const haengt = s.gesperrt.some((q) => !q.ausschluss);
  const moeglich = gewaehlt.length > 0 && !s.fehlt.length && !(art === 'SAMMEL' && haengt);
  const keys = gewaehlt.map((q) => q.key);
  async function verzicht(q: Quelle, an: boolean) {
    try { await api.put(`${Z}/quelle`, { key: q.key, verzicht: an }); q.verzicht = an; setWahl(new Set(wahl)); } catch (e) { setError(fehlerText(e)); }
  }
  const zeile = (q: Quelle, modus: 'offen' | 'gesperrt' | 'bestaetigt') => (
    <tr key={q.key}>
      <td>{modus === 'offen' && <CheckBox checked={wahl.has(q.key)} onChange={(e) => { const n = new Set(wahl); if (e.target.checked) n.add(q.key); else n.delete(q.key); setWahl(n); }} />}</td>
      <td>{dat(q.datum)}</td>
      <td>{q.herkunft === 'SOLL' ? `Lastschrift (${q.artname})` : 'Buchung'} · Beleg {beleg(q)}<br /><span className="portal-muted portal-small">{q.text}</span></td>
      <td style={{ textAlign: 'right' }}>{eur(q.betrag)}</td>
      <td>{modus === 'offen' && darf ? <CheckBox checked={q.verzicht} text="Verzicht" onChange={(e) => verzicht(q, e.target.checked)} /> : q.verzicht ? 'Verzicht: ja' : ''}</td>
      <td>
        {modus === 'bestaetigt' && <ObjectStatus state={q.sperre ? 'Negative' : 'Positive'}>{q.zbnr}{q.sperre ? ` – ${q.sperre}` : ''}</ObjectStatus>}
        {modus === 'gesperrt' && <ObjectStatus state="Critical">{q.sperre}</ObjectStatus>}
        {modus === 'offen' && darf && <Button design="Transparent" icon="edit" tooltip="Anderen Spender zuordnen oder ausschließen" onClick={() => onZuordnen(q)} />}
      </td>
    </tr>
  );
  return (
    <Dialog open headerText={`${s.name} – Spenden ${jahr}`} onClose={onClose} resizable style={{ width: 'min(60rem, 95vw)' }}
            footer={<DialogFuss>
              <Button icon="pdf-attachment" disabled={!moeglich} onClick={() => onVorschau(art, keys)}>Vorschau</Button>
              {darf && <Button design="Emphasized" icon="accept" disabled={!moeglich || gesperrt} onClick={() => onAusstellen(art, keys)}>{art === 'SAMMEL' ? `Sammelbestätigung ausstellen (${gewaehlt.length})` : 'Einzelbestätigung ausstellen'}</Button>}
              <Button onClick={onGeaendert}>Schließen</Button>
            </DialogFuss>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <Text style={{ display: 'block', marginBottom: '0.5rem' }}>{[s.name, ...s.anschrift].join(' · ')}{s.email ? ` · ${s.email}${s.email_unzustellbar ? ' (als unzustellbar vermerkt – bitte drucken)' : ''}` : ' · keine E-Mail-Adresse – bitte drucken'}</Text>
      {s.fehlt.length > 0 && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>Name und Anschrift des Zuwendenden sind unvollständig ({s.fehlt.join(', ')}) – bitte {s.typ === 'M' ? 'im Mitgliederstamm' : 'beim Spender'} ergänzen.</MessageStrip>}
      {haengt && <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>Eine Spende ist ungeklärt – bis dahin ist keine Sammelbestätigung möglich (Einzelbestätigungen der übrigen Spenden schon).</MessageStrip>}
      <div className="portal-ih__rahmen portal-tabrahmen" style={{ maxHeight: '50vh' }}><table className="portal-ih__tabelle" style={{ width: '100%' }}>
        <thead><tr><th /><th>Datum</th><th>Herkunft</th><th style={{ textAlign: 'right' }}>Betrag</th><th>Aufwandsverzicht</th><th /></tr></thead>
        <tbody>
          {s.offen.map((q) => zeile(q, 'offen'))}
          {s.gesperrt.map((q) => zeile(q, 'gesperrt'))}
          {s.bestaetigt.map((q) => zeile(q, 'bestaetigt'))}
        </tbody>
      </table></div>
      <Text style={{ display: 'block', marginTop: '0.75rem' }}>
        Gewählt: <b>{gewaehlt.length}</b> Spende{gewaehlt.length === 1 ? '' : 'n'} · <b>{eur(summe)}</b> → {art === 'SAMMEL' ? 'Sammelbestätigung mit Anlage' : 'Einzelbestätigung'}
      </Text>
    </Dialog>
  );
}

/** Buchung einem Spender zuordnen (Mitglied oder Spender ohne Mitgliedschaft, auch neu erfassen) oder ausschließen */
function ZuordnenDialog({ q, onClose, onFertig }: { q: Quelle; onClose: () => void; onFertig: () => void }) {
  const [p, setP] = useState<Personen | null>(null);
  const [modus, setModus] = useState<'M' | 'X' | 'NEU' | 'AUS'>('M');
  const [wahl, setWahl] = useState<string | null>(q.spender ?? (q.vorschlag ? `M:${q.vorschlag.adrnr}` : null));
  const [neu, setNeu] = useState({ name: '', zusatz: '', strasse: '', plz: '', ort: '', email: '' });
  const [verzicht, setVerzicht] = useState(q.verzicht);
  const [ausschluss, setAusschluss] = useState<'KEINE_SPENDE' | 'RUECKLAST'>('KEINE_SPENDE');
  const [grund, setGrund] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.get<Personen>(`${Z}/personen`).then(setP).catch((e) => setError(fehlerText(e))); }, []);
  async function sichern() {
    setError(null);
    try {
      if (modus === 'AUS') await api.put(`${Z}/quelle`, { key: q.key, ausschluss, grund });
      else {
        let spender = wahl;
        if (modus === 'NEU') spender = (await api.post<{ key: string }>(`${Z}/spender`, neu)).key;
        if (!spender) { setError('Bitte einen Spender wählen.'); return; }
        await api.put(`${Z}/quelle`, { key: q.key, spender, verzicht });
      }
      onFertig();
    } catch (e) { setError(fehlerText(e)); }
  }
  const n = (k: keyof typeof neu) => (x: string) => setNeu({ ...neu, [k]: x });
  return (
    <Dialog open headerText="Spende zuordnen" onClose={onClose} style={{ width: 'min(44rem, 95vw)' }}
            footer={<DialogFuss>
              <Button design="Emphasized" onClick={sichern}>{modus === 'AUS' ? 'Ausschließen' : 'Zuordnen'}</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </DialogFuss>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <Text style={{ display: 'block', marginBottom: '0.75rem' }}>{dat(q.datum)} · Beleg {beleg(q)} · Konto {q.konto} · <b>{eur(q.betrag)}</b><br />{q.text}</Text>
      <Select style={{ width: '100%', marginBottom: '0.75rem' }} onChange={(e) => { setModus((e.detail.selectedOption as HTMLElement).dataset.m as typeof modus); setWahl(null); }}>
        <Option data-m="M" selected={modus === 'M'}>Mitglied bzw. Zahler</Option>
        <Option data-m="X" selected={modus === 'X'}>Spender ohne Mitgliedschaft (bereits erfasst)</Option>
        <Option data-m="NEU" selected={modus === 'NEU'}>Spender ohne Mitgliedschaft neu erfassen</Option>
        <Option data-m="AUS" selected={modus === 'AUS'}>Nicht bestätigen (keine Spende / Rücklastschrift)</Option>
      </Select>
      {modus === 'M' && <AuswahlBox eintraege={(p?.mitglieder ?? []).map((m) => ({ key: m.key, text: m.name, zusatz: m.ort }))} wert={wahl} onWaehle={setWahl} placeholder="Mitglied suchen …" style={{ width: '100%' }} max={50} />}
      {modus === 'X' && <AuswahlBox eintraege={(p?.spender ?? []).map((m) => ({ key: m.key, text: m.name, zusatz: m.ort }))} wert={wahl} onWaehle={setWahl} placeholder="Spender suchen …" style={{ width: '100%' }} max={50} />}
      {modus === 'NEU' && (
        <FormGrid>
          <TextField label="Name (Person oder Firma)" required value={neu.name} onChange={n('name')} />
          <TextField label="Zusatz (z. B. z. Hd.)" value={neu.zusatz} onChange={n('zusatz')} />
          <TextField label="Straße und Hausnummer" required value={neu.strasse} onChange={n('strasse')} />
          <TextField label="PLZ" required value={neu.plz} onChange={n('plz')} />
          <TextField label="Ort" required value={neu.ort} onChange={n('ort')} />
          <TextField label="E-Mail (für den Versand)" type="Email" value={neu.email} onChange={n('email')} />
        </FormGrid>
      )}
      {modus === 'AUS' ? (
        <FlexBox direction="Column" style={{ gap: '0.5rem' }}>
          <Select onChange={(e) => setAusschluss((e.detail.selectedOption as HTMLElement).dataset.a as typeof ausschluss)}>
            <Option data-a="KEINE_SPENDE" selected={ausschluss === 'KEINE_SPENDE'}>Keine Spende (z. B. Beitrag, Entgelt, Umbuchung)</Option>
            <Option data-a="RUECKLAST" selected={ausschluss === 'RUECKLAST'}>Rücklastschrift – nicht zugeflossen</Option>
          </Select>
          <Label required>Grund</Label>
          <Input value={grund} onInput={(e) => setGrund(e.target.value)} style={{ width: '100%' }} />
        </FlexBox>
      ) : (
        <CheckBox style={{ marginTop: '0.75rem' }} checked={verzicht} onChange={(e) => setVerzicht(e.target.checked)} wrappingType="Normal"
                  text="Es handelt sich um den Verzicht auf Erstattung von Aufwendungen (Feld „Ja“ auf der Bestätigung)" />
      )}
    </Dialog>
  );
}

/** Rückbuchung klären: betrifft eine Spende (→ Rücklastschrift, wird nicht bestätigt) oder keine Spende (mit Grund) */
function KlaerenDialog({ r, quellen, onClose, onFertig }: { r: Rueck; quellen: Map<string, Quelle>; onClose: () => void; onFertig: () => void }) {
  const [betrifft, setBetrifft] = useState<string>(r.kandidaten[0] ?? '');
  const [grund, setGrund] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function sichern() {
    try { await api.post(`${Z}/rueckbuchung`, { key: r.key, betrifft: betrifft || null, grund }); onFertig(); } catch (e) { setError(fehlerText(e)); }
  }
  return (
    <Dialog open headerText="Rückbuchung klären" onClose={onClose} style={{ width: 'min(40rem, 95vw)' }}
            footer={<DialogFuss>
              <Button design="Emphasized" disabled={!betrifft && !grund.trim()} onClick={sichern}>Klären</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </DialogFuss>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <Text style={{ display: 'block', marginBottom: '0.75rem' }}>{dat(r.datum)} · Beleg {beleg(r)} · <b>{eur(r.betrag)}</b><br />{r.text}</Text>
      <Label>Die Rückbuchung betrifft</Label>
      <Select style={{ width: '100%', marginBottom: '0.75rem' }} onChange={(e) => setBetrifft((e.detail.selectedOption as HTMLElement).dataset.k ?? '')}>
        {r.kandidaten.map((k) => { const q = quellen.get(k); return <Option key={k} data-k={k} selected={betrifft === k}>{q ? `Spende vom ${dat(q.datum)} über ${eur(q.betrag)} (Beleg ${beleg(q)}) – wird als Rücklastschrift ausgeschlossen` : k}</Option>; })}
        <Option data-k="" selected={!betrifft}>keine bestätigungsfähige Spende (Grund angeben)</Option>
      </Select>
      <Label required={!betrifft}>Grund / Bemerkung</Label>
      <Input value={grund} onInput={(e) => setGrund(e.target.value)} style={{ width: '100%' }} />
    </Dialog>
  );
}
