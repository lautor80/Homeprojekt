import { useEffect, useState } from 'react';
import { Varianten, feld } from '@core/components/Varianten';
import { createPortal } from 'react-dom';
import {
  Bar, BusyIndicator, Button, CheckBox, DatePicker, Dialog, Input, Label, Link, MessageStrip, ObjectStatus, Option, Select, Tab, TabContainer, Text, TextArea,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api, qs } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { AuswahlBox } from '@core/components/AuswahlBox';
import { ResponsiveTable } from '@core/components/ResponsiveTable';
import { Section } from '@core/components/Section';
import { PdfDialog } from '@core/components/PdfDialog';
import { toast } from '@core/toast';
import { einstellungLink } from '@core/einstellungen';
import { useCan } from '@core/session';
import { dat, eur } from '../util';
import {
  aktMonat, isoHeute, klein, monatsname, monatVerschieben, pdfOeffnen, STATUS_STATE, STATUS_TEXT, VZ, ZAHLART_TEXT, type Beleg, type Posten, type Preisliste, type Produkt, type Rubrik, type Zahlart,
} from './typen';
import './verzehr.css';

/**
 * Verzehrbuch: alle Positionen mit Filtern und Kennzahlen, Belege (Gast + Sammelabrechnungen), Monatsabschluss,
 * Preisliste (Speisen/Sonstiges, Gästepreise) und Einstellungen. Getränke selbst werden in der Clubhausabrechnung gepflegt.
 */
interface BuchPosten extends Posten { person: string; gast_gruppe: string | null; status: string; gast: boolean; beleg_rgnr: string | null; abrechnung: string | null; zahlart: Zahlart | null }
interface Kennzahlen {
  umsatz: number; posten: number; abende: number; offenKonten: { betrag: number; personen: number }; gaeste: { betrag: number; belege: number };
  gaesteOffen: { betrag: number; belege: number }; rechnungenOffen: { betrag: number; belege: number };
  produkte: { text: string; anzahl: number; betrag: number }[]; tage: { datum: string; betrag: number; posten: number }[];
}
interface BuchDaten { von: string; bis: string; posten: BuchPosten[]; kennzahlen: Kennzahlen; mitglieder: { adrnr: string; name: string }[] }
interface Cfg { mindestbetrag: number; zahlungsziel_tage: number; storno_stunden: number; erloeskonto: string; forderungskonto: string; info_text: string }
interface AbschlussZeile { adrnr: string; name: string; email: string; posten: number; betrag: number; zahlart: Zahlart; uebertrag: boolean; abgerechnet: string | null }
interface Abschluss { monat: string; titel: string; zeilen: AbschlussZeile[]; belege: Beleg[]; moeglich: boolean }

const monatsgrenzen = (m: string) => ({ von: `${m.slice(0, 4)}-${m.slice(4, 6)}-01`, bis: new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(4, 6)), 0)).toISOString().slice(0, 10) });

export function Verzehrbuch() {
  const can = useCan();
  const admin = can('tco.verzehr:admin');
  const [start] = useState(() => new URLSearchParams(window.location.search));
  const [tab, setTab] = useState(() => start.get('tab') ?? 'buch');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pdf, setPdf] = useState<{ url: string; titel: string } | null>(null);
  const [neu, setNeu] = useState(0);

  async function aktion(fn: () => Promise<unknown>, meldung?: string) {
    setBusy(true); setError(null);
    try { await fn(); if (meldung) toast(meldung, 5000); setNeu((n) => n + 1); return true; } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  }
  const pdfZeigen = (rgnr: string, titel = `Beleg ${rgnr}`) => (klein() ? pdfOeffnen(`${VZ}/belege/${rgnr}/pdf`, setError) : setPdf({ url: `${VZ}/belege/${rgnr}/pdf`, titel }));
  const pdfUrl = (url: string, titel: string) => (klein() ? pdfOeffnen(url, setError) : setPdf({ url, titel }));
  const warnen = (w?: string[]) => { if (w?.length) setError(w.join('\n')); };

  return (
    <AppPage actions={admin ? <Button design="Transparent" icon="action-settings" tooltip="Einstellungen (Administration → Einstellungen → TC Oberthal → Verzehr)" onClick={() => { window.location.assign(einstellungLink('tco', 'verzehr')); }} /> : undefined}
             varianten={{ repid: 'tco.verzehrbuch', ansicht: { tab }, onAnwenden: (a) => { setTab(feld(a, 'tab', tab)); } }} title="Verzehrbuch" subtitle="Clubhaus-Verzehr: Positionen, Belege, Monatsabschluss, Preisliste">
      <div className="portal-vz portal-vz--breit">
        {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.75rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
        <TabContainer tabLayout="Inline" onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key!)}>
          <Tab data-key="buch" text="Positionen" icon="list" selected={tab === 'buch'}>
            <Buch admin={admin} busy={busy} neu={neu} aktion={aktion} onPdf={pdfZeigen} />
          </Tab>
          <Tab data-key="belege" text="Belege" icon="receipt" selected={tab === 'belege'}>
            <Belege admin={admin} busy={busy} neu={neu} aktion={aktion} onPdf={pdfZeigen} warnen={warnen} />
          </Tab>
          <Tab data-key="abschluss" text="Monatsabschluss" icon="sales-order" selected={tab === 'abschluss'}>
            <Monatsabschluss admin={admin} busy={busy} neu={neu} aktion={aktion} onPdf={pdfZeigen} onVorschau={pdfUrl} />
          </Tab>
          <Tab data-key="preise" text="Preisliste" icon="tags" selected={tab === 'preise'}>
            {admin && (
              <MessageStrip design="Information" hideCloseButton style={{ margin: '0.75rem 0 0' }}>
                Preise werden an einer Stelle gepflegt:{' '}
                <Link onClick={() => { window.location.assign('/tco/produkte?sicht=speisen'); }}>Produkte und Preise → Speisen und Gästepreise</Link>.
              </MessageStrip>
            )}
            <Preise admin={false} busy={busy} neu={neu} aktion={aktion} />
          </Tab>
        </TabContainer>
      </div>
      {pdf && <PdfDialog url={pdf.url} title={pdf.titel} filename={`${pdf.titel.replace(/[^\wäöüÄÖÜß-]+/g, '_')}.pdf`} onClose={() => setPdf(null)} />}
    </AppPage>
  );
}

type Aktion = (fn: () => Promise<unknown>, meldung?: string) => Promise<boolean>;

// ---------------------------------------------------------------- Positionen
function Buch({ admin, busy, neu, aktion, onPdf }: { admin: boolean; busy: boolean; neu: number; aktion: Aktion; onPdf: (rgnr: string) => void }) {
  const [monat, setMonat] = useState(aktMonat);
  const [f, setF] = useState({ adrnr: '', art: '', status: '', suche: '' });
  const [d, setD] = useState<BuchDaten | null>(null);
  const [storno, setStorno] = useState<BuchPosten | null>(null);
  const [grund, setGrund] = useState('');
  useEffect(() => {
    const g = monatsgrenzen(monat);
    api.get<BuchDaten>(`${VZ}/buch${qs({ von: g.von, bis: g.bis, adrnr: f.adrnr, art: f.art, status: f.status, suche: f.suche })}`).then(setD).catch(() => setD(null));
  }, [monat, f, neu]);
  const k = d?.kennzahlen;
  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Datum', accessor: 'datum', width: 110, Cell: ({ row }: Cell) => `${dat(row.original.datum)} ${row.original.zeit}` },
    { Header: 'Person / Gast', accessor: 'person', minWidth: 160, Cell: ({ row }: Cell) => <span>{row.original.person}{row.original.gast && row.original.gast_gruppe && row.original.gast_name !== row.original.gast_gruppe ? <span className="portal-muted"> · {row.original.gast_gruppe}</span> : null}{row.original.gast ? <ObjectStatus state="Information" style={{ marginLeft: '0.375rem' }}>Gast</ObjectStatus> : null}</span> },
    { Header: 'Position', accessor: 'text', minWidth: 160 },
    { Header: 'Anzahl', accessor: 'anzahl', width: 80, hAlign: 'End', Cell: ({ value }: Cell) => value.toLocaleString('de-DE') },
    { Header: 'Preis', accessor: 'preis', width: 90, hAlign: 'End', Cell: ({ value }: Cell) => eur(value) },
    { Header: 'Betrag', accessor: 'betrag', width: 100, hAlign: 'End', Cell: ({ value }: Cell) => eur(value) },
    { Header: 'Erfasst', accessor: 'erfasst_von', width: 130, Cell: ({ row }: Cell) => (row.original.selbst ? 'selbst' : row.original.erfasst_von) },
    { Header: 'Status', accessor: 'status', width: 150, Cell: ({ row }: Cell) => <ObjectStatus state={STATUS_STATE[row.original.status]}>{STATUS_TEXT[row.original.status]}{row.original.storno_grund ? ` (${row.original.storno_grund})` : ''}</ObjectStatus> },
    { Header: 'Beleg', accessor: 'abrechnung', width: 160, Cell: ({ value }: Cell) => (value ? <Button design="Transparent" icon="pdf-attachment" onClick={() => onPdf(value)}>{value}</Button> : '–') },
    ...(admin ? [{
      Header: '', id: 'akt', width: 60, disableSortBy: true,
      Cell: ({ row }: Cell) => (row.original.status === 'OFFEN' ? <Button icon="delete" design="Transparent" tooltip="Stornieren" disabled={busy} onClick={() => { setStorno(row.original); setGrund(''); }} /> : null),
    } as AnalyticalTableColumnDefinition] : []),
  ];
  return (
    <>
      <div className="portal-vz__filter" style={{ marginTop: '0.75rem' }}>
        <Button icon="navigation-left-arrow" design="Transparent" onClick={() => setMonat(monatVerschieben(monat, -1))} />
        <DatePicker formatPattern="MMMM yyyy" valueFormat="yyyyMM" value={monat} style={{ width: '11rem' }} onChange={(e) => e.detail.value && setMonat(e.detail.value)} />
        <Button icon="navigation-right-arrow" design="Transparent" onClick={() => setMonat(monatVerschieben(monat, 1))} />
<Varianten repid="tco.verzehrbuch.buch" ansicht={{ monat, f }} onAnwenden={(a) => { setMonat(feld(a, 'monat', monat)); setF(feld(a, 'f', f)); }} />
        <AuswahlBox eintraege={(d?.mitglieder ?? []).map((m) => ({ key: m.adrnr, text: m.name }))} wert={f.adrnr} onWaehle={(k2) => setF({ ...f, adrnr: k2 ?? '' })} placeholder="Mitglied" style={{ width: '14rem' }} />
        <Select style={{ width: '11rem' }} onChange={(e) => setF({ ...f, art: (e.detail.selectedOption as HTMLElement).dataset.v ?? '' })}>
          <Option data-v="" selected={f.art === ''}>Mitglieder + Gäste</Option><Option data-v="MITGLIED" selected={f.art === 'MITGLIED'}>Mitglieder</Option><Option data-v="GAST" selected={f.art === 'GAST'}>Gäste</Option>
        </Select>
        <Select style={{ width: '10rem' }} onChange={(e) => setF({ ...f, status: (e.detail.selectedOption as HTMLElement).dataset.v ?? '' })}>
          <Option data-v="" selected={f.status === ''}>Alle Status</Option><Option data-v="OFFEN" selected={f.status === 'OFFEN'}>offen</Option><Option data-v="ABGERECHNET" selected={f.status === 'ABGERECHNET'}>abgerechnet</Option>
          <Option data-v="BEZAHLT" selected={f.status === 'BEZAHLT'}>bezahlt</Option><Option data-v="STORNIERT" selected={f.status === 'STORNIERT'}>storniert</Option>
        </Select>
        <Input placeholder="Suche (Produkt, Name)" value={f.suche} showClearIcon onInput={(e) => setF({ ...f, suche: e.target.value })} style={{ width: '12rem' }} />
      </div>
      {!d ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : (
        <>
          {k && (
            <div className="portal-vz__kpis">
              <div className="portal-vz__kpi"><div className="portal-vz__kpi-label">Umsatz {monatsname(monat)}</div><div className="portal-vz__kpi-wert">{eur(k.umsatz)}</div><div className="portal-vz__kpi-sub">{k.posten} Positionen · {k.abende} Tage</div></div>
              <div className="portal-vz__kpi"><div className="portal-vz__kpi-label">Offen auf Mitgliedskonten</div><div className="portal-vz__kpi-wert">{eur(k.offenKonten.betrag)}</div><div className="portal-vz__kpi-sub">{k.offenKonten.personen} Mitglieder (gesamt, nicht abgerechnet)</div></div>
              <div className="portal-vz__kpi"><div className="portal-vz__kpi-label">Gäste kassiert</div><div className="portal-vz__kpi-wert">{eur(k.gaeste.betrag)}</div><div className="portal-vz__kpi-sub">{k.gaeste.belege} Belege{k.gaesteOffen.belege ? ` · ${k.gaesteOffen.belege} offen (${eur(k.gaesteOffen.betrag)})` : ''}</div></div>
              <div className="portal-vz__kpi"><div className="portal-vz__kpi-label">Sammelabrechnungen offen</div><div className="portal-vz__kpi-wert">{eur(k.rechnungenOffen.betrag)}</div><div className="portal-vz__kpi-sub">{k.rechnungenOffen.belege} Belege gestellt</div></div>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: klein() ? '1fr' : 'minmax(0, 2fr) minmax(16rem, 1fr)', gap: '1rem' }}>
            <Section title="Positionen" count={d.posten.length} flush>
              <ResponsiveTable columns={columns} data={d.posten} titelSpalten={2} visibleRows={Math.min(Math.max(d.posten.length, 1), 25)} noDataText="Keine Positionen im Zeitraum" />
            </Section>
            <div>
              <Section title="Top-Produkte">
                {k?.produkte.length ? k.produkte.map((p) => (
                  <div key={p.text} className="portal-vz__balken"><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.text}</span><i style={{ width: `${Math.max(4, (p.betrag / k.produkte[0].betrag) * 100)}%` }} /><span>{eur(p.betrag)}</span></div>
                )) : <Text className="portal-muted">Keine Daten</Text>}
              </Section>
              <Section title="Umsatz je Tag">
                {k?.tage.length ? k.tage.map((t) => (
                  <div key={t.datum} className="portal-vz__balken"><span>{dat(t.datum)} · {t.posten} Pos.</span><i style={{ width: `${Math.max(4, (t.betrag / Math.max(...k.tage.map((x) => x.betrag))) * 100)}%` }} /><span>{eur(t.betrag)}</span></div>
                )) : <Text className="portal-muted">Keine Daten</Text>}
              </Section>
            </div>
          </div>
        </>
      )}
      {storno && createPortal(
        <Dialog open headerText="Position stornieren" onClose={() => setStorno(null)}
                footer={<Bar endContent={<><Button design="Negative" disabled={busy} onClick={async () => { if (await aktion(() => api.post(`${VZ}/storno`, { id: storno.id, grund }), 'Position storniert.')) setStorno(null); }}>Stornieren</Button><Button onClick={() => setStorno(null)}>Abbrechen</Button></>} />}>
          <div className="portal-vz__form" style={{ maxWidth: '24rem' }}>
            <Text>{storno.anzahl} × {storno.text} · {storno.person} · {dat(storno.datum)} · {eur(storno.betrag)}</Text>
            <div className="portal-vz__feld"><Label>Grund</Label><Input value={grund} onInput={(e) => setGrund(e.target.value)} style={{ width: '100%' }} /></div>
          </div>
        </Dialog>, document.body)}
    </>
  );
}

// ---------------------------------------------------------------- Belege
function Belege({ admin, busy, neu, aktion, onPdf, warnen }: { admin: boolean; busy: boolean; neu: number; aktion: Aktion; onPdf: (rgnr: string) => void; warnen: (w?: string[]) => void }) {
  const [f, setF] = useState<{ art: string; status: string }>({ art: '', status: '' });
  const [liste, setListe] = useState<Beleg[] | null>(null);
  const [bez, setBez] = useState<Beleg | null>(null);
  const [datum, setDatum] = useState(isoHeute());
  const [zahlart, setZahlart] = useState<Zahlart | ''>('');
  const [storno, setStorno] = useState<Beleg | null>(null);
  const [grund, setGrund] = useState('');
  const [nachStorno, setNachStorno] = useState<Beleg | null>(null);
  useEffect(() => { api.get<Beleg[]>(`${VZ}/belege${qs({ art: f.art, status: f.status })}`).then(setListe).catch(() => setListe([])); }, [f, neu]);
  const mail = (b: Beleg) => aktion(async () => { const r = await api.post<{ text: string; warnungen: string[] }>(`${VZ}/belege/${b.rgnr}/mail`, {}); toast(r.text, 5000); warnen(r.warnungen); });
  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Beleg', accessor: 'rgnr', width: 150 },
    { Header: 'Person', accessor: 'person', minWidth: 160, Cell: ({ row }: Cell) => <span>{row.original.person}{row.original.art === 'GAST' && row.original.gast_name && row.original.gast_gruppe ? <span className="portal-muted"> · {row.original.gast_gruppe}</span> : null}</span> },
    { Header: 'Art', accessor: 'art', width: 110, Cell: ({ row }: Cell) => (row.original.art === 'GAST' ? 'Gastbeleg' : `Sammel ${row.original.monat ? `${row.original.monat.slice(4, 6)}/${row.original.monat.slice(0, 4)}` : ''}`) },
    { Header: 'Datum', accessor: 'datum', width: 100, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Betrag', accessor: 'betrag', width: 100, hAlign: 'End', Cell: ({ value }: Cell) => eur(value) },
    { Header: 'Zahlart', accessor: 'zahlart', width: 110, Cell: ({ value }: Cell) => (value ? ZAHLART_TEXT[value as Zahlart] : '–') },
    { Header: 'Status', accessor: 'status', width: 170, Cell: ({ row }: Cell) => <ObjectStatus state={STATUS_STATE[row.original.status]}>{STATUS_TEXT[row.original.status]}{row.original.bezahlt_am ? ` ${dat(row.original.bezahlt_am)}` : row.original.faellig && row.original.status === 'GESTELLT' ? ` · fällig ${dat(row.original.faellig)}` : ''}{row.original.laufid ? ` · Lauf ${Number(row.original.laufid)}` : ''}</ObjectStatus> },
    { Header: 'Versand', accessor: 'versand_am', width: 150, Cell: ({ row }: Cell) => (row.original.versand_am ? `${row.original.versand_art === 'MAIL' ? 'E-Mail' : 'WhatsApp'} ${dat(row.original.versand_am.slice(0, 10))}` : '–') },
    {
      Header: 'Aktionen', id: 'akt', width: 300, disableSortBy: true,
      Cell: ({ row }: Cell) => {
        const b: Beleg = row.original;
        return (
          <span style={{ display: 'inline-flex', gap: '0.25rem' }}>
            <Button icon="pdf-attachment" design="Transparent" tooltip="PDF" onClick={() => onPdf(b.rgnr)} />
            {admin && b.status !== 'STORNIERT' && <Button icon="email" design="Transparent" tooltip="per E-Mail senden" disabled={busy || !(b.email || b.mitglied_email)} onClick={() => mail(b)} />}
            {admin && b.status === 'GESTELLT' && !b.laufid && <Button icon="paid-leave" design="Transparent" tooltip="Als bezahlt kennzeichnen" disabled={busy} onClick={() => { setBez(b); setDatum(isoHeute()); setZahlart(''); }}>Bezahlt</Button>}
            {admin && b.status === 'OFFEN' && <Button icon="paid-leave" design="Transparent" disabled={busy} onClick={() => { setBez(b); setDatum(isoHeute()); setZahlart('BAR'); }}>Kassiert</Button>}
            {admin && b.status !== 'STORNIERT' && !b.laufid && <Button icon="delete" design="Transparent" tooltip="Beleg stornieren" disabled={busy} onClick={() => { setStorno(b); setGrund(''); }} />}
          </span>
        );
      },
    },
  ];
  return (
    <>
      <div className="portal-vz__filter" style={{ marginTop: '0.75rem' }}>
        <Select style={{ width: '12rem' }} onChange={(e) => setF({ ...f, art: (e.detail.selectedOption as HTMLElement).dataset.v ?? '' })}>
          <Option data-v="" selected={f.art === ''}>Alle Belege</Option><Option data-v="GAST" selected={f.art === 'GAST'}>Gastbelege</Option><Option data-v="SAMMEL" selected={f.art === 'SAMMEL'}>Sammelabrechnungen</Option>
        </Select>
        <Select style={{ width: '11rem' }} onChange={(e) => setF({ ...f, status: (e.detail.selectedOption as HTMLElement).dataset.v ?? '' })}>
          <Option data-v="" selected={f.status === ''}>Alle Status</Option><Option data-v="OFFEN" selected={f.status === 'OFFEN'}>offen</Option><Option data-v="GESTELLT" selected={f.status === 'GESTELLT'}>abgerechnet</Option>
          <Option data-v="BEZAHLT" selected={f.status === 'BEZAHLT'}>bezahlt</Option><Option data-v="STORNIERT" selected={f.status === 'STORNIERT'}>storniert</Option>
        </Select>
      </div>
      {!liste ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : (
        <Section title="Belege" count={liste.length} flush>
          <ResponsiveTable columns={columns} data={liste} titelSpalten={2} visibleRows={Math.min(Math.max(liste.length, 1), 25)} noDataText="Keine Belege" />
        </Section>
      )}
      {bez && createPortal(
        <Dialog open headerText={`${bez.rgnr} als bezahlt kennzeichnen`} onClose={() => setBez(null)}
                footer={<Bar endContent={<><Button design="Emphasized" disabled={busy} onClick={async () => {
                  if (bez.status === 'OFFEN') {
                    if (await aktion(async () => { const r = await api.post<{ text: string; warnungen: string[] }>(`${VZ}/theke/kassieren`, { rgnr: bez.rgnr, zahlart: zahlart || 'BAR' }); toast(r.text, 5000); warnen(r.warnungen); })) setBez(null);
                  } else if (await aktion(async () => { const r = await api.post<{ text: string; warnungen: string[] }>(`${VZ}/belege/${bez.rgnr}/bezahlt`, { datum, zahlart: zahlart || null }); toast(r.text, 5000); warnen(r.warnungen); })) setBez(null);
                }}>Bezahlt</Button><Button onClick={() => setBez(null)}>Abbrechen</Button></>} />}>
          <div className="portal-vz__form" style={{ maxWidth: '24rem' }}>
            <Text>{bez.person} · {eur(bez.betrag)}</Text>
            {bez.status !== 'OFFEN' && <div className="portal-vz__feld"><Label>Zahlungseingang am</Label><DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={datum} onChange={(e) => e.detail.value && setDatum(e.detail.value)} style={{ width: '100%' }} /></div>}
            <div className="portal-vz__feld">
              <Label>Zahlart</Label>
              <Select style={{ width: '100%' }} onChange={(e) => setZahlart(((e.detail.selectedOption as HTMLElement).dataset.v ?? '') as Zahlart | '')}>
                {bez.status !== 'OFFEN' && <Option data-v="" selected={zahlart === ''}>wie Beleg ({bez.zahlart ? ZAHLART_TEXT[bez.zahlart] : '–'})</Option>}
                {(Object.keys(ZAHLART_TEXT) as Zahlart[]).filter((z) => bez.status !== 'OFFEN' || ['BAR', 'KARTE', 'PAYPAL'].includes(z)).map((z) => <Option key={z} data-v={z} selected={zahlart === z}>{ZAHLART_TEXT[z]}</Option>)}
              </Select>
            </div>
            <Text className="portal-muted portal-small">Der Beleg wird mit Zahlvermerk neu gedruckt (neue Version in Paperless).</Text>
          </div>
        </Dialog>, document.body)}
      {storno && createPortal(
        <Dialog open headerText={`${storno.rgnr} stornieren`} onClose={() => setStorno(null)}
                footer={<Bar endContent={<><Button design="Negative" disabled={busy} onClick={async () => { if (await aktion(() => api.post(`${VZ}/belege/${storno.rgnr}/storno`, { grund }), 'Beleg storniert.')) { setStorno(null); if (storno.art === 'SAMMEL') setNachStorno(storno); } }}>Stornieren</Button><Button onClick={() => setStorno(null)}>Abbrechen</Button></>} />}>
          <div className="portal-vz__form" style={{ maxWidth: '26rem' }}>
            <Text>{storno.art === 'SAMMEL' ? 'Die Positionen der Sammelabrechnung werden wieder offen. Danach kannst du einzelne Verbräuche stornieren und den Monat neu abrechnen.' : 'Alle Positionen des Gastbelegs werden storniert.'}</Text>
            <div className="portal-vz__feld"><Label>Grund</Label><Input value={grund} onInput={(e) => setGrund(e.target.value)} style={{ width: '100%' }} /></div>
          </div>
        </Dialog>, document.body)}
      {nachStorno && <PositionenKorrektur beleg={nachStorno} busy={busy} aktion={aktion} onClose={() => setNachStorno(null)} />}
    </>
  );
}

/** Nach dem Storno einer Sammelabrechnung: die wieder offenen Verbräuche des Mitglieds einzeln stornieren, dann neu abrechnen */
function PositionenKorrektur({ beleg, busy, aktion, onClose }: { beleg: Beleg; busy: boolean; aktion: Aktion; onClose: () => void }) {
  const [posten, setPosten] = useState<BuchPosten[] | null>(null);
  const [grund, setGrund] = useState('');
  const monat = beleg.monat ?? aktMonat();
  const laden = () => {
    const g = monatsgrenzen(monat);
    api.get<BuchDaten>(`${VZ}/buch${qs({ von: '2000-01-01', bis: g.bis, adrnr: beleg.adrnr ?? '', status: 'OFFEN' })}`).then((d) => setPosten(d.posten)).catch(() => setPosten([]));
  };
  useEffect(() => { laden(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const offen = (posten ?? []).filter((p) => p.status === 'OFFEN');
  const summe = offen.reduce((s, p) => s + p.betrag, 0);
  return createPortal(
    <Dialog open stretch={klein()} headerText={`${beleg.person ?? ''} – Verbräuche bis ${monatsname(monat)}`} onClose={onClose}
            footer={<Bar startContent={<Text className="portal-muted">{offen.length} offen · {eur(summe)}</Text>}
                         endContent={<>
                           <Button design="Emphasized" icon="sales-order" disabled={busy || !offen.length}
                                   onClick={async () => { if (await aktion(async () => { const r = await api.post<{ text: string; prot: { rgnr: string; text: string }[] }>(`${VZ}/abschluss`, { monat, adrnrs: [beleg.adrnr], versenden: true }); toast(r.prot.map((p) => `${p.rgnr}: ${p.text}`).join('\n') || r.text, 6000); })) onClose(); }}>
                             Monat neu abrechnen
                           </Button>
                           <Button onClick={onClose}>Schließen</Button>
                         </>} />}>
      <div className="portal-vz__form" style={{ minWidth: 'min(40rem, 90vw)' }}>
        <MessageStrip design="Information" hideCloseButton>Sammelabrechnung {beleg.rgnr} ist storniert. Streiche hier einzelne Verbräuche und erzeuge die Abrechnung danach neu – oder lass die Positionen offen, dann laufen sie in den nächsten Monatsabschluss.</MessageStrip>
        <div className="portal-vz__feld"><Label>Stornogrund (für die nächsten Stornos)</Label><Input value={grund} onInput={(e) => setGrund(e.target.value)} style={{ width: '100%' }} placeholder="z. B. Fehlbuchung laut Rückmeldung des Mitglieds" /></div>
        {!posten ? <BusyIndicator active style={{ display: 'block', padding: '1rem 0' }} /> : (
          <div className="portal-vz__liste" style={{ border: '1px solid var(--sapList_BorderColor)', borderRadius: '0.5rem' }}>
            {posten.map((p) => (
              <div key={p.id} className="portal-vz__eintrag" style={p.status !== 'OFFEN' ? { opacity: 0.55 } : undefined}>
                <div style={{ minWidth: 0 }}>
                  <div className="portal-vz__eintrag-titel">{p.anzahl} × {p.text}</div>
                  <div className="portal-vz__eintrag-info"><span>{dat(p.datum)} {p.zeit}</span><span>{p.selbst ? 'selbst erfasst' : `erfasst von ${p.erfasst_von}`}</span>{p.status !== 'OFFEN' && <ObjectStatus state={STATUS_STATE[p.status]}>{STATUS_TEXT[p.status]}{p.storno_grund ? ` (${p.storno_grund})` : ''}</ObjectStatus>}</div>
                </div>
                <div className="portal-vz__eintrag-rechts">
                  <span>{eur(p.betrag)}</span>
                  {p.status === 'OFFEN' && <Button icon="delete" design="Transparent" tooltip="Verbrauch stornieren" disabled={busy}
                                                   onClick={() => aktion(() => api.post(`${VZ}/storno`, { id: p.id, grund }), 'Position storniert.').then((ok) => { if (ok) laden(); })} />}
                </div>
              </div>
            ))}
            {!posten.length && <Text className="portal-muted" style={{ padding: '0.75rem 1rem' }}>Keine offenen Positionen.</Text>}
          </div>
        )}
      </div>
    </Dialog>,
    document.body,
  );
}

// ---------------------------------------------------------------- Monatsabschluss
function Monatsabschluss({ admin, busy, neu, aktion, onPdf, onVorschau }: { admin: boolean; busy: boolean; neu: number; aktion: Aktion; onPdf: (rgnr: string) => void; onVorschau: (url: string, titel: string) => void }) {
  const [monat, setMonat] = useState(() => monatVerschieben(aktMonat(), -1));
  const [d, setD] = useState<Abschluss | null>(null);
  const [ohne, setOhne] = useState<Set<string>>(new Set());
  const [versenden, setVersenden] = useState(true);
  const [prot, setProt] = useState<{ rgnr: string; text: string }[] | null>(null);
  useEffect(() => { setD(null); api.get<Abschluss>(`${VZ}/abschluss?monat=${monat}`).then(setD).catch(() => setD(null)); }, [monat, neu]);
  const offen = (d?.zeilen ?? []).filter((z) => !z.abgerechnet && !z.uebertrag);
  const gewaehlt = offen.filter((z) => !ohne.has(z.adrnr));
  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: '', id: 'sel', width: 50, disableSortBy: true, Cell: ({ row }: Cell) => (row.original.abgerechnet || row.original.uebertrag ? null : <CheckBox checked={!ohne.has(row.original.adrnr)} onChange={() => { const s = new Set(ohne); if (s.has(row.original.adrnr)) s.delete(row.original.adrnr); else s.add(row.original.adrnr); setOhne(s); }} />) },
    { Header: 'Mitglied', accessor: 'name', minWidth: 180 },
    { Header: 'Positionen', accessor: 'posten', width: 100, hAlign: 'End' },
    { Header: 'Betrag', accessor: 'betrag', width: 110, hAlign: 'End', Cell: ({ value }: Cell) => eur(value) },
    { Header: 'Zahlweise', accessor: 'zahlart', width: 120, Cell: ({ value }: Cell) => ZAHLART_TEXT[value as Zahlart] },
    { Header: 'E-Mail', accessor: 'email', width: 200, Cell: ({ value }: Cell) => value || <ObjectStatus state="Critical">keine – Ausdruck</ObjectStatus> },
    { Header: 'Status', id: 'st', width: 220, Cell: ({ row }: Cell) => (row.original.abgerechnet ? <ObjectStatus state="Positive">abgerechnet {row.original.abgerechnet}</ObjectStatus> : row.original.uebertrag ? <ObjectStatus state="None">unter Mindestbetrag → Folgemonat</ObjectStatus> : <ObjectStatus state="Critical">offen</ObjectStatus>) },
    {
      Header: 'Vorschau', id: 'pdf', width: 100, disableSortBy: true,
      Cell: ({ row }: Cell) => (row.original.abgerechnet
        ? <Button icon="pdf-attachment" design="Transparent" tooltip="Abrechnung" onClick={() => onPdf(row.original.abgerechnet)} />
        : row.original.uebertrag ? null
          : <Button icon="show" design="Transparent" tooltip="Vorschau der Sammelabrechnung" onClick={() => onVorschau(`${VZ}/abschluss/pdf?monat=${monat}&adrnr=${row.original.adrnr}`, `Vorschau ${row.original.name} – ${monatsname(monat)}`)} />),
    },
  ];
  return (
    <>
      <div className="portal-vz__filter" style={{ marginTop: '0.75rem' }}>
        <Button icon="navigation-left-arrow" design="Transparent" onClick={() => setMonat(monatVerschieben(monat, -1))} />
        <DatePicker formatPattern="MMMM yyyy" valueFormat="yyyyMM" value={monat} style={{ width: '11rem' }} onChange={(e) => e.detail.value && setMonat(e.detail.value)} />
        <Button icon="navigation-right-arrow" design="Transparent" onClick={() => setMonat(monatVerschieben(monat, 1))} />
        <span style={{ flex: 1 }} />
        <Button icon="show" disabled={!offen.length} onClick={() => onVorschau(`${VZ}/abschluss/pdf?monat=${monat}`, `Vorschau Sammelabrechnungen ${monatsname(monat)}`)}>Vorschau-PDF (alle)</Button>
        {admin && (
          <>
            <CheckBox text="Abrechnungen per E-Mail versenden" checked={versenden} onChange={(e) => setVersenden(e.target.checked)} />
            <Button design="Emphasized" icon="sales-order" disabled={busy || !d?.moeglich || !gewaehlt.length}
                    onClick={async () => {
                      let r: { text: string; prot: { rgnr: string; text: string }[] } | null = null;
                      if (await aktion(async () => { r = await api.post(`${VZ}/abschluss`, { monat, adrnrs: gewaehlt.map((z) => z.adrnr), versenden }); })) { const x = r as unknown as { text: string; prot: { rgnr: string; text: string }[] }; toast(x.text, 6000); setProt(x.prot); }
                    }}>
              Sammelabrechnungen erzeugen ({gewaehlt.length} · {eur(gewaehlt.reduce((s, z) => s + z.betrag, 0))})
            </Button>
          </>
        )}
      </div>
      {d && !d.moeglich && <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.75rem' }}>Der {d.titel} kann erst nach Monatsende abgerechnet werden – hier die Vorschau.</MessageStrip>}
      {prot && <MessageStrip design="Positive" onClose={() => setProt(null)} style={{ marginBottom: '0.75rem', whiteSpace: 'pre-line' }}>{prot.map((p) => `${p.rgnr}: ${p.text}`).join('\n') || 'Keine Belege erzeugt.'}</MessageStrip>}
      {!d ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : (
        <>
          <Section title={`Offener Verzehr bis ${d.titel}`} count={d.zeilen.length} flush>
            <ResponsiveTable columns={columns} data={d.zeilen} titelSpalten={2} visibleRows={Math.min(Math.max(d.zeilen.length, 1), 25)} noDataText="Keine offenen Positionen" />
          </Section>
          <Section title={`Sammelabrechnungen ${d.titel}`} count={d.belege.length} flush>
            <div className="portal-vz__liste">
              {d.belege.map((b) => (
                <div key={b.rgnr} className="portal-vz__eintrag">
                  <div style={{ minWidth: 0 }}>
                    <div className="portal-vz__eintrag-titel">{b.person} <span style={{ fontWeight: 400 }}>· {b.rgnr}</span></div>
                    <div className="portal-vz__eintrag-info">
                      <ObjectStatus state={STATUS_STATE[b.status]}>{STATUS_TEXT[b.status]}{b.bezahlt_am ? ` ${dat(b.bezahlt_am)}` : ''}</ObjectStatus>
                      <span>{b.zahlart ? ZAHLART_TEXT[b.zahlart] : ''}</span>
                      {b.versand_am && <span>{b.versand_art === 'MAIL' ? 'E-Mail' : 'WhatsApp'} {dat(b.versand_am.slice(0, 10))}</span>}
                      {b.laufid && <span>Lastschriftlauf {Number(b.laufid)}</span>}
                    </div>
                  </div>
                  <div className="portal-vz__eintrag-rechts"><span>{eur(b.betrag)}</span><Button icon="pdf-attachment" design="Transparent" onClick={() => onPdf(b.rgnr)} /></div>
                </div>
              ))}
              {!d.belege.length && <Text className="portal-muted" style={{ padding: '0.75rem 1rem' }}>Noch keine Sammelabrechnungen für diesen Monat.</Text>}
            </div>
          </Section>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Preisliste
/** Pflege der Preisliste als Sicht der App „Produkte und Preise“ (#232, N4) – im Verzehrbuch steht sie nur noch zur Anzeige */
export function VerzehrPreisePflege() {
  const can = useCan();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [neu, setNeu] = useState(0);
  const aktion: Aktion = async (fn, meldung) => {
    setBusy(true); setError(null);
    try { await fn(); if (meldung) toast(meldung, 5000); setNeu((n) => n + 1); return true; } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  };
  return (
    <>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-wrap' }}>{error}</MessageStrip>}
      <Preise admin={can('tco.verzehr:admin')} busy={busy} neu={neu} aktion={aktion} />
    </>
  );
}

function Preise({ admin, busy, neu, aktion }: { admin: boolean; busy: boolean; neu: number; aktion: Aktion }) {
  const [liste, setListe] = useState<Preisliste | null>(null);
  const [f, setF] = useState<{ prod_key: string | null; rubrik: Rubrik; text: string; preis: string; preis_gast: string; ab: string } | null>(null);
  useEffect(() => { api.get<Preisliste>(`${VZ}/preisliste`).then(setListe).catch(() => setListe(null)); }, [neu]);
  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Rubrik', accessor: 'rubrik', width: 110, Cell: ({ value }: Cell) => liste?.rubriken[value as Rubrik] ?? value },
    { Header: 'Produkt', accessor: 'text', minWidth: 180 },
    { Header: 'Preis Mitglied', accessor: 'preis', width: 130, hAlign: 'End', Cell: ({ value }: Cell) => eur(value) },
    { Header: 'Preis Gast', accessor: 'preis_gast', width: 130, hAlign: 'End', Cell: ({ row }: Cell) => (row.original.preis_gast != null ? eur(row.original.preis_gast) : <span className="portal-muted">wie Mitglied</span>) },
    { Header: 'Gültig ab', accessor: 'valid_from', width: 110, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Schlüssel', accessor: 'prod_key', width: 90 },
    ...(admin ? [{
      Header: '', id: 'akt', width: 110, disableSortBy: true,
      Cell: ({ row }: Cell) => {
        const p: Produkt = row.original;
        return (
          <span style={{ display: 'inline-flex', gap: '0.25rem' }}>
            <Button icon="edit" design="Transparent" tooltip="Preis ändern" disabled={busy} onClick={() => setF({ prod_key: p.prod_key, rubrik: p.rubrik, text: p.text, preis: String(p.preis).replace('.', ','), preis_gast: p.preis_gast != null ? String(p.preis_gast).replace('.', ',') : '', ab: isoHeute() })} />
            {p.rubrik !== 'G' && <Button icon="delete" design="Transparent" tooltip="Produkt beenden (ab heute)" disabled={busy} onClick={() => aktion(() => api.post(`${VZ}/produkte/beenden`, { prod_key: p.prod_key, ab: isoHeute() }), 'Produkt beendet.')} />}
          </span>
        );
      },
    } as AnalyticalTableColumnDefinition] : []),
  ];
  const n = (s: string) => Number(s.replace(',', '.'));
  return (
    <>
      <MessageStrip design="Information" hideCloseButton style={{ margin: '0.75rem 0' }}>
        Getränke und ihre Mitgliederpreise stehen in der Sicht „Getränke“ von „Produkte und Preise“. Hier: Speisen und Sonstiges sowie Gästepreise für alle Produkte.
      </MessageStrip>
      {!liste ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : (
        <Section title="Preisliste (aktuell gültig)" count={liste.produkte.length} flush actions={admin && <Button icon="add" design="Emphasized" onClick={() => setF({ prod_key: null, rubrik: 'S', text: '', preis: '', preis_gast: '', ab: isoHeute() })}>Speise / Sonstiges anlegen</Button>}>
          <ResponsiveTable columns={columns} data={liste.produkte} visibleRows={Math.min(Math.max(liste.produkte.length, 1), 30)} noDataText="Keine Produkte" />
        </Section>
      )}
      {f && createPortal(
        <Dialog open headerText={f.prod_key ? `${f.text} – Preis ändern` : 'Produkt anlegen'} onClose={() => setF(null)}
                footer={<Bar endContent={<><Button design="Emphasized" disabled={busy || !f.text.trim() || !(n(f.preis) > 0)} onClick={async () => {
                  if (await aktion(() => api.put(`${VZ}/produkte`, { prod_key: f.prod_key, rubrik: f.rubrik, text: f.text, preis: n(f.preis), preis_gast: f.preis_gast.trim() ? n(f.preis_gast) : null, ab: f.ab }), 'Preis gespeichert.')) setF(null);
                }}>Speichern</Button><Button onClick={() => setF(null)}>Abbrechen</Button></>} />}>
          <div className="portal-vz__form">
            {!f.prod_key && (
              <div className="portal-vz__feld"><Label>Rubrik</Label>
                <Select style={{ width: '100%' }} onChange={(e) => setF({ ...f, rubrik: (e.detail.selectedOption as HTMLElement).dataset.v as Rubrik })}>
                  <Option data-v="S" selected={f.rubrik === 'S'}>Speisen</Option><Option data-v="X" selected={f.rubrik === 'X'}>Sonstiges</Option>
                </Select>
              </div>
            )}
            <div className="portal-vz__feld"><Label required>Bezeichnung</Label><Input value={f.text} disabled={f.rubrik === 'G'} onInput={(e) => setF({ ...f, text: e.target.value })} style={{ width: '100%' }} /></div>
            <div className="portal-vz__aktionen">
              <div className="portal-vz__feld"><Label required>Preis Mitglied €</Label><Input value={f.preis} disabled={f.rubrik === 'G'} onInput={(e) => setF({ ...f, preis: e.target.value })} style={{ width: '100%' }} /></div>
              <div className="portal-vz__feld"><Label>Preis Gast € (leer = wie Mitglied)</Label><Input value={f.preis_gast} onInput={(e) => setF({ ...f, preis_gast: e.target.value })} style={{ width: '100%' }} /></div>
            </div>
            <div className="portal-vz__feld"><Label>Gültig ab</Label><DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.ab} minDate={isoHeute()} onChange={(e) => e.detail.value && setF({ ...f, ab: e.detail.value })} style={{ width: '100%' }} /></div>
            {f.rubrik === 'G' && <Text className="portal-muted portal-small">Bei Getränken kann hier nur der Gästepreis gesetzt werden; Bezeichnung und Mitgliederpreis in der Clubhausabrechnung.</Text>}
          </div>
        </Dialog>, document.body)}
    </>
  );
}

// ---------------------------------------------------------------- Einstellungen
/** Kapitel „Verzehr“ der App Einstellungen (#232, E1) – bisher Reiter „Einstellungen“ im Verzehrbuch */
export function VerzehrKapitel() {
  const can = useCan();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aktion: Aktion = async (fn, meldung) => {
    setBusy(true); setError(null);
    try { await fn(); toast(meldung ?? 'Gespeichert.'); return true; } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  };
  return (
    <>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <Einstellungen admin={can('tco.verzehr:admin')} busy={busy} aktion={aktion} />
    </>
  );
}

function Einstellungen({ admin, busy, aktion }: { admin: boolean; busy: boolean; aktion: Aktion }) {
  const [c, setC] = useState<Cfg | null>(null);
  useEffect(() => { api.get<Cfg>(`${VZ}/cfg`).then(setC).catch(() => setC(null)); }, []);
  if (!c) return <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />;
  const num = (v: string) => Number(v.replace(',', '.')) || 0;
  return (
    <Section title="Einstellungen Verzehr" actions={admin && <Button design="Emphasized" icon="save" disabled={busy} onClick={() => aktion(() => api.put(`${VZ}/cfg`, c), 'Einstellungen gespeichert.')}>Speichern</Button>}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))', gap: '1rem', maxWidth: '60rem' }}>
        <div className="portal-vz__feld"><Label>Mindestbetrag Sammelabrechnung €</Label><Input value={String(c.mindestbetrag).replace('.', ',')} readonly={!admin} onInput={(e) => setC({ ...c, mindestbetrag: num(e.target.value) })} /><Text className="portal-muted portal-small">Darunter wird der Verzehr in den Folgemonat übertragen.</Text></div>
        <div className="portal-vz__feld"><Label>Zahlungsziel (Tage)</Label><Input type="Number" value={String(c.zahlungsziel_tage)} readonly={!admin} onInput={(e) => setC({ ...c, zahlungsziel_tage: Number(e.target.value) || 0 })} /></div>
        <div className="portal-vz__feld"><Label>Storno-Frist für Mitglieder (Stunden)</Label><Input type="Number" value={String(c.storno_stunden)} readonly={!admin} onInput={(e) => setC({ ...c, storno_stunden: Number(e.target.value) || 0 })} /></div>
        <div className="portal-vz__feld"><Label>Erlöskonto (Lastschrift / FI)</Label><Input value={c.erloeskonto} readonly={!admin} onInput={(e) => setC({ ...c, erloeskonto: e.target.value })} placeholder="z. B. 8400" /></div>
        <div className="portal-vz__feld"><Label>Forderungskonto</Label><Input value={c.forderungskonto} readonly={!admin} onInput={(e) => setC({ ...c, forderungskonto: e.target.value })} placeholder="z. B. 1400" /></div>
        <div className="portal-vz__feld" style={{ gridColumn: '1 / -1' }}><Label>Hinweis in „Mein Verzehr“</Label><TextArea value={c.info_text} readonly={!admin} rows={2} onInput={(e) => setC({ ...c, info_text: e.target.value })} placeholder="z. B. Bitte Verzehr noch am selben Abend eintragen." /></div>
      </div>
    </Section>
  );
}
