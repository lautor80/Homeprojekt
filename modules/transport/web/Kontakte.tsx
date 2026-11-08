import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AnalyticalTable, Button, FlexBox, Icon, Input, Link, List, ListItemStandard, MessageStrip, ObjectStatus, Option, Select, Tab, TabContainer, Text, Title,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { MasterDetail } from '@core/components/MasterDetail';
import { ObjectHeader } from '@core/components/ObjectHeader';
import { Attribute, Attributes } from '@core/components/Attributes';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { download, PdfDialog } from '@core/components/PdfDialog';
import { AblageFlaeche, useAblageZiel, type AblageZiel } from '@core/ablage';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { KontaktDialog } from './KontaktDialog';
import { LAENDER } from './laender';
import { T, betrag, dat, type Adresse } from './util';

/**
 * Kontakte (Euroflex) im Layout der Mitglieder: Liste links (Rolle, Suche), Kontakt rechts
 * mit Stammdaten, Aufträgen und Dokumenten (Paperless, Korrespondent = Kontakt).
 */
type Filter = 'ALLE' | 'KUNDEN' | 'UNTERNEHMER' | 'RE' | 'OHNE';
interface Zeile { adrnr: number; name: string; ort: string; rollen: string[]; auftraege: number; offen: number; letzter: string | null }
interface Liste { anzahl: Record<Filter, number>; filter: Record<Filter, string>; zeilen: Zeile[] }
interface AuftragZ {
  auftragsnr: string; anlagedatum: string | null; leistungsdatum: string | null; kennzeichen: string | null; rollen: string[];
  kunde: string; unternehmer: string; route: string; ek: number; vk: number; betrag: number; faktura: string | null; fakturadatum: string | null; status: string;
}
interface Detail {
  adresse: Adresse & { adrnr: number }; titel: string; auftraege: AuftragZ[];
  kennzahlen: { auftraege: number; offen: number; umsatzJahr: number; umsatzGesamt: number; ekGesamt: number; letzter: string | null };
}
interface Dok { id: number; titel: string; typ: string; erstellt: string; datei: string }

const FILTER_TEXT: Record<Filter, string> = { ALLE: 'Alle Kontakte', KUNDEN: 'Kunden', UNTERNEHMER: 'Unternehmer', RE: 'Rechnungsempfänger', OHNE: 'Ohne Aufträge' };
const eur = (v: number) => `${betrag(v)} €`;
const lesen = (f: File) => new Promise<string>((ok, err) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => err(r.error); r.readAsDataURL(f); });

export function Kontakte() {
  const can = useCan();
  const edit = can('transport.kontakte:edit');
  const [filter, setFilter] = useState<Filter>('ALLE');
  const [suche, setSuche] = useState('');
  const [liste, setListe] = useState<Liste | null>(null);
  const [adrnr, setAdrnr] = useState<number | null>(() => Number(new URLSearchParams(window.location.search).get('adrnr')) || null);
  const [neu, setNeu] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const laden = () => api.get<Liste>(`${T}/kontakte/liste?${new URLSearchParams({ filter, suche: suche.trim() })}`).then(setListe).catch((e) => setError(e.message));
  useEffect(() => { const t = setTimeout(laden, suche ? 250 : 0); return () => clearTimeout(t); }, [filter, suche]); // eslint-disable-line react-hooks/exhaustive-deps

  const waehlen = (a: number | null) => {
    setAdrnr(a);
    const u = new URL(window.location.href);
    if (a) u.searchParams.set('adrnr', String(a)); else u.searchParams.delete('adrnr');
    window.history.replaceState(null, '', u);
  };

  return (
    <AppPage title="Kontakte" subtitle={liste ? `${liste.anzahl.ALLE} Kontakte · ${liste.anzahl.KUNDEN} Kunden · ${liste.anzahl.UNTERNEHMER} Unternehmer` : ''}
             actions={edit ? <Button icon="add-contact" design="Emphasized" onClick={() => setNeu(true)}>Neuer Kontakt</Button> : undefined}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <MasterDetail
        masterWidth="22rem"
        emptyTitle="Kein Kontakt ausgewählt" emptyText="Links einen Kontakt wählen oder über „Neuer Kontakt“ anlegen."
        onBack={() => waehlen(null)}
        masterHead={
          <>
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              <Select style={{ width: '100%' }} onChange={(e) => setFilter((e.detail.selectedOption as HTMLElement).dataset.f as Filter)}>
                {(Object.keys(FILTER_TEXT) as Filter[]).map((f) => (
                  <Option key={f} data-f={f} selected={f === filter}>{`${FILTER_TEXT[f]}${liste ? ` (${liste.anzahl[f]})` : ''}`}</Option>
                ))}
              </Select>
              <Input style={{ width: '100%' }} placeholder="Name, Ort, PLZ, E-Mail, Telefon" value={suche} showClearIcon onInput={(e) => setSuche(e.target.value)} />
            </div>
            <FlexBox justifyContent="SpaceBetween" alignItems="Center" style={{ marginTop: '0.5rem', minHeight: '2rem' }}>
              <Title level="H5">{FILTER_TEXT[filter]} <span className="portal-muted">({liste?.zeilen.length ?? 0})</span></Title>
              {(suche || filter !== 'ALLE') && <Button design="Transparent" icon="reset" onClick={() => { setSuche(''); setFilter('ALLE'); }}>Zurücksetzen</Button>}
            </FlexBox>
          </>
        }
        master={
          <List onItemClick={(e) => waehlen(Number((e.detail.item as HTMLElement).dataset.a))} noDataText="Keine Kontakte zu dieser Auswahl">
            {liste?.zeilen.map((z) => (
              <ListItemStandard key={z.adrnr} data-a={z.adrnr} type="Active" selected={z.adrnr === adrnr}
                                icon={z.rollen.includes('Unternehmer') && !z.rollen.includes('Kunde') ? 'shipping-status' : z.auftraege ? 'customer' : 'contacts'}
                                description={[z.ort, z.rollen.join(', ')].filter(Boolean).join(' · ')}
                                additionalText={z.offen ? `${z.offen} offen` : z.auftraege ? `${z.auftraege} Aufträge` : ''}
                                additionalTextState={z.offen ? 'Critical' : 'None'}>{z.name}</ListItemStandard>
            ))}
          </List>
        }
        detail={adrnr ? <KontaktDetail key={adrnr} adrnr={adrnr} edit={edit} onChanged={laden} onGeloescht={() => { waehlen(null); laden(); }} /> : null}
      />
      <KontaktDialog modus={neu ? 'NEU' : null} auswahl={[]} onClose={() => setNeu(false)}
                     onSaved={(a) => { setNeu(false); laden(); waehlen(a); }} />
    </AppPage>
  );
}

function KontaktDetail({ adrnr, edit, onChanged, onGeloescht }: { adrnr: number; edit: boolean; onChanged: () => void; onGeloescht: () => void }) {
  const navigate = useNavigate();
  const [d, setD] = useState<Detail | null>(null);
  const [tab, setTab] = useState('stamm');
  const [bearbeiten, setBearbeiten] = useState(false);
  const [loeschen, setLoeschen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const laden = () => api.get<Detail>(`${T}/kontakte/${adrnr}`).then(setD).catch((e) => setError(e.message));
  useEffect(() => { laden(); }, [adrnr]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!d) return error ? <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip> : <Text>Lade …</Text>;
  const a = d.adresse;
  const k = d.kennzahlen;
  const rollen = [...new Set(d.auftraege.flatMap((x) => x.rollen))];
  const land = LAENDER.find(([c]) => c === a.land)?.[1] ?? a.land ?? '';
  const initialen = d.titel.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const t = (s: string | null | undefined) => (s ? <Text>{s}</Text> : <Text className="portal-muted">–</Text>);

  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Auftrag', accessor: 'auftragsnr', width: 110, Cell: ({ value }: Cell) => <Link onClick={() => navigate(`/transport/auftraege/${value}`)}>{value}</Link> },
    { Header: 'Angelegt', accessor: 'anlagedatum', width: 100, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Rolle', accessor: 'rollen', width: 150, Cell: ({ value }: Cell) => (value as string[]).join(', ') },
    { Header: 'Route', accessor: 'route', minWidth: 180 },
    { Header: 'Kunde / Unternehmer', id: 'partner', minWidth: 170, Cell: ({ row }: Cell) => (row.original.rollen.includes('Kunde') ? row.original.unternehmer : row.original.kunde) || '–' },
    { Header: 'Betrag', accessor: 'betrag', width: 110, hAlign: 'End', Cell: ({ row }: Cell) => eur(row.original.rollen.includes('Unternehmer') && !row.original.rollen.includes('Kunde') ? row.original.ek : row.original.betrag) },
    {
      Header: 'Status', accessor: 'status', width: 160,
      Cell: ({ row }: Cell) => (row.original.faktura
        ? <ObjectStatus state="Positive">{row.original.faktura} · {dat(row.original.fakturadatum)}</ObjectStatus>
        : <ObjectStatus state="Critical">offen</ObjectStatus>),
    },
  ];

  return (
    <div>
      <ObjectHeader
        title={d.titel}
        initials={initialen || undefined}
        subtitle={[`Kontakt Nr. ${a.adrnr}`, [[a.strasse, a.hausnummer].filter(Boolean).join(' '), [a.plz, a.ort].filter(Boolean).join(' '), land].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
        status={<>
          {rollen.length ? rollen.map((r) => <ObjectStatus key={r} state={r === 'Unternehmer' ? 'Information' : 'Positive'} inverted>{r}</ObjectStatus>)
            : <ObjectStatus state="None" inverted>ohne Aufträge</ObjectStatus>}
          {k.offen > 0 && <ObjectStatus state="Critical">{k.offen} offene Aufträge</ObjectStatus>}
          {k.letzter && <span className="portal-muted portal-small">letzter Auftrag {dat(k.letzter)}</span>}
        </>}
        actions={<>
          {edit && <Button icon="edit" onClick={() => setBearbeiten(true)}>Bearbeiten</Button>}
          {edit && <Button icon="delete" design="Transparent" disabled={k.auftraege > 0} tooltip={k.auftraege ? 'In Aufträgen verwendet – nicht löschbar' : 'Kontakt löschen'} onClick={() => setLoeschen(true)} />}
          <ChangeHistoryButton objectType="ADRESSE" objectKey={String(adrnr)} />
        </>}
      >
        <Attributes>
          <Attribute label="Aufträge">{k.auftraege}</Attribute>
          <Attribute label={`Umsatz ${new Date().getFullYear()}`}>{eur(k.umsatzJahr)}</Attribute>
          <Attribute label="Umsatz gesamt">{eur(k.umsatzGesamt)}</Attribute>
          {k.ekGesamt > 0 && <Attribute label="Frachtkosten (als Unternehmer)">{eur(k.ekGesamt)}</Attribute>}
        </Attributes>
        {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginTop: '0.75rem' }}>{error}</MessageStrip>}
      </ObjectHeader>

      <div className="portal-section">
        <TabContainer tabLayout="Inline" contentBackgroundDesign="Transparent" onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key!)}>
          <Tab data-key="stamm" text="Stammdaten" selected={tab === 'stamm'}>
            <div style={{ padding: '0.5rem 0' }}>
              <Attributes>
                <Attribute label="Firma / Name">{t(a.kundenname)}</Attribute>
                <Attribute label="Namenszusatz">{t(a.kundenname2)}</Attribute>
                <Attribute label="Ansprechpartner">{t([a.anrede, a.vorname, a.name].filter(Boolean).join(' '))}</Attribute>
                <Attribute label="Straße">{t([a.strasse, a.hausnummer].filter(Boolean).join(' '))}</Attribute>
                <Attribute label="PLZ / Ort">{t([a.plz, a.ort].filter(Boolean).join(' '))}</Attribute>
                <Attribute label="Land">{t(land)}</Attribute>
                <Attribute label="Telefon">{a.telefon ? <Link href={`tel:${a.telefon.replace(/[^\d+]/g, '')}`}>{a.telefon}</Link> : t(null)}</Attribute>
                <Attribute label="Fax">{t(a.fax)}</Attribute>
                <Attribute label="E-Mail">{a.email ? <Link href={`mailto:${a.email}`}>{a.email}</Link> : t(null)}</Attribute>
                <Attribute label="USt-IdNr.">{t(a.ustid)}</Attribute>
                <Attribute label="GLN">{t(a.gln)}</Attribute>
                <Attribute label="Markt">{t(a.markt)}</Attribute>
              </Attributes>
            </div>
          </Tab>
          <Tab data-key="auf" text={`Aufträge (${d.auftraege.length})`} selected={tab === 'auf'}>
            <AnalyticalTable columns={columns} data={d.auftraege} visibleRows={Math.min(Math.max(d.auftraege.length, 1), 15)} minRows={1}
                             noDataText="Keine Aufträge mit diesem Kontakt" onRowClick={(e) => navigate(`/transport/auftraege/${e.detail.row.original.auftragsnr}`)} />
          </Tab>
          <Tab data-key="dok" text="Dokumente" selected={tab === 'dok'}>
            {tab === 'dok' && <KontaktDokumente adrnr={adrnr} titel={d.titel} edit={edit} />}
          </Tab>
        </TabContainer>
      </div>

      <KontaktDialog modus={bearbeiten ? 'EDIT' : null} auswahl={[{ key: String(adrnr), text: d.titel, zusatz: '' }]}
                     onClose={() => setBearbeiten(false)} onSaved={() => { setBearbeiten(false); laden(); onChanged(); }} />
      <ConfirmDialog open={loeschen} danger title="Kontakt löschen" confirmText="Löschen" text={`„${d.titel}“ endgültig löschen?`}
                     onCancel={() => setLoeschen(false)}
                     onConfirm={async () => {
                       setLoeschen(false);
                       try { const r = await api.del<{ text: string }>(`${T}/kontakte/${adrnr}`); toast(r.text); onGeloescht(); } catch (e) { setError((e as Error).message); }
                     }} />
    </div>
  );
}

function KontaktDokumente({ adrnr, titel, edit }: { adrnr: number; titel: string; edit: boolean }) {
  const [d, setD] = useState<{ paperless: boolean; korrespondent: number | null; soll?: string; dokumente: Dok[] } | null>(null);
  const [pdf, setPdf] = useState<Dok | null>(null);
  const [error, setError] = useState<string | null>(null);
  const laden = () => api.get<typeof d>(`${T}/kontakte/${adrnr}/dokumente`).then(setD).catch((e) => setError(e.message));
  useEffect(() => { laden(); }, [adrnr]); // eslint-disable-line react-hooks/exhaustive-deps

  const ziel: AblageZiel = {
    titel: `${titel} – Dokumente`,
    annehmen: async (files) => {
      const texte: string[] = [];
      try { for (const f of files) texte.push((await api.post<{ text: string }>(`${T}/kontakte/${adrnr}/dokumente`, { datei: f.name, inhalt: await lesen(f) })).text); } finally { laden(); }
      return files.length === 1 ? texte[0] : `${files.length} Datei(en) beim Kontakt ${titel} abgelegt`;
    },
  };
  useAblageZiel(edit && d?.paperless ? ziel : null);

  const columns: AnalyticalTableColumnDefinition[] = [
    {
      Header: 'Titel', accessor: 'titel', minWidth: 220,
      Cell: ({ row }: Cell) => (
        <span className="portal-row" style={{ flexWrap: 'nowrap' }}>
          <Icon name={/\.pdf$/i.test(row.original.datei) ? 'pdf-attachment' : 'document'} style={{ color: 'var(--sapContent_IconColor)' }} />
          <Link onClick={() => (/\.pdf$/i.test(row.original.datei) ? setPdf(row.original)
            : download(`${T}/kontakte/${adrnr}/dokumente/${row.original.id}/datei`, row.original.datei || `Dokument_${row.original.id}`).catch((e) => setError((e as Error).message)))}>
            {row.original.titel}
          </Link>
        </span>
      ),
    },
    { Header: 'Dokumenttyp', accessor: 'typ', width: 170 },
    { Header: 'Datum', accessor: 'erstellt', width: 105, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Dok-Nr.', accessor: 'id', width: 85, hAlign: 'End' },
  ];

  if (!d) return <Text>Lade Dokumente aus Paperless …</Text>;
  if (!d.paperless) return <MessageStrip hideCloseButton design="Information">Paperless ist nicht eingerichtet (Stammdaten → Firmendaten: URL und API-Token).</MessageStrip>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', paddingTop: '0.5rem' }}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
      {!d.korrespondent && <MessageStrip hideCloseButton>In Paperless gibt es noch keinen Korrespondenten „{d.soll}“ – er wird beim ersten Ablegen angelegt.</MessageStrip>}
      <AnalyticalTable columns={columns} data={d.dokumente} visibleRows={Math.min(Math.max(d.dokumente.length, 1), 12)} minRows={1} noDataText="Keine Dokumente in Paperless" />
      {edit && <AblageFlaeche ziel={ziel} text="Dokumente zum Kontakt hierher ziehen (z. B. Vertrag, Preisabsprache, Versicherungsnachweis), klicken zum Auswählen oder Screenshot mit Strg+V einfügen" />}
      {pdf && <PdfDialog url={`${T}/kontakte/${adrnr}/dokumente/${pdf.id}/datei`} title={pdf.titel} filename={pdf.datei || `${pdf.titel}.pdf`} onClose={() => setPdf(null)} />}
    </div>
  );
}
