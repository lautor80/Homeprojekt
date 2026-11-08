import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AnalyticalTable, Button, CheckBox, Input, Link, MessageStrip, ObjectStatus, SegmentedButton, SegmentedButtonItem, Text,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { Attribute, Attributes } from '@core/components/Attributes';
import { Filter, Filters, HeaderKpi } from '@core/components/Filters';
import { ObjectHeader } from '@core/components/ObjectHeader';
import { Section } from '@core/components/Section';
import { useLoad } from '@core/components/useLoad';
import { TCO, dat, eur } from '../util';
import { Dlg } from '../mitglieder/Dialoge';

export const TN = `${TCO}/teilnehmer`;

interface Teilnehmer {
  adrnr: string; nachname: string; vorname: string; name: string; email: string; geburtsdatum: string | null; alter: number | null;
  einheiten: number; trainingsbeitrag: number; mitglied: boolean; mitglied_text: string; mitglied_state: 'Positive' | 'Critical';
}
interface Liste { teilnehmer: Teilnehmer[]; einheiten: number; mitglieder: number; nichtmitglieder: number }
type FilterArt = 'ALL' | 'MEMBER' | 'NONMEMBER';

/**
 * Teilnehmer Jugendtraining (Port von Z2UI5_CL_TCO_JUGENDTRAINING): Trefferliste aller Personen mit
 * laufendem Jugendtraining-Vertrag, Suche über Name/E-Mail, Filter Alle/Mitglieder/Nichtmitglieder,
 * Sortierung über die Spaltenköpfe, Mehrfachauswahl mit „E-Mail an Auswahl“ (BCC) und Detail je Person.
 */
export function Teilnehmer() {
  const { data, error: ladeFehler, loading, reload } = useLoad(() => api.get<Liste>(TN));
  const [filter, setFilter] = useState<FilterArt>('ALL');
  const [suche, setSuche] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const [detail, setDetail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => {
    const s = suche.trim().toUpperCase();
    return (data?.teilnehmer ?? []).filter((t) => (filter === 'MEMBER' ? t.mitglied : filter === 'NONMEMBER' ? !t.mitglied : true))
      .filter((t) => !s || t.name.toUpperCase().includes(s) || t.email.toUpperCase().includes(s));
  }, [data, filter, suche]);
  const einheiten = rows.reduce((x, t) => x + t.einheiten, 0);
  const markiert = (data?.teilnehmer ?? []).filter((t) => sel.includes(t.adrnr));
  const mitEmail = markiert.filter((t) => t.email);
  const alleSichtbar = rows.length > 0 && rows.every((t) => sel.includes(t.adrnr));

  const toggle = (a: string, an: boolean) => setSel(an ? [...new Set([...sel, a])] : sel.filter((x) => x !== a));
  const columns: AnalyticalTableColumnDefinition[] = [
    {
      Header: '', id: 'sel', width: 50, disableSortBy: true,
      Cell: ({ row }: Cell) => <CheckBox checked={sel.includes(row.original.adrnr)} onChange={(e) => toggle(row.original.adrnr, e.target.checked)} />,
    },
    {
      Header: 'Name', accessor: 'name', minWidth: 200,
      Cell: ({ row, value }: Cell) => (
        <div style={{ lineHeight: 1.3 }}>
          <Link onClick={() => setDetail(row.original.adrnr)}>{value}</Link>
          {row.original.geburtsdatum && <><br /><Text className="portal-muted">{dat(row.original.geburtsdatum)}</Text></>}
        </div>
      ),
    },
    { Header: 'E-Mail', accessor: 'email', minWidth: 200, Cell: ({ value }: Cell) => (value ? <Link href={`mailto:${value}`}>{value}</Link> : '') },
    { Header: 'Alter', accessor: 'alter', width: 80, hAlign: 'End', Cell: ({ value }: Cell) => (value === null ? '' : String(value)) },
    { Header: 'Einheiten', accessor: 'einheiten', width: 100, hAlign: 'End', Cell: ({ value }: Cell) => <Text style={{ fontWeight: 'bold' }}>{value}</Text> },
    { Header: 'Trainingsbeitrag', accessor: 'trainingsbeitrag', width: 140, hAlign: 'End', Cell: ({ value }: Cell) => eur(value) },
    { Header: 'Mitglied', accessor: 'mitglied_text', width: 100, Cell: ({ row, value }: Cell) => <ObjectStatus state={row.original.mitglied_state}>{value}</ObjectStatus> },
  ];

  async function mail() {
    setError(null);
    try {
      const r = await api.post<{ url: string | null; ohneEmail: string[] }>(`${TN}/mailto`, { adrnrs: sel });
      if (!r.url) { setError('Keine der markierten Personen hat eine E-Mail-Adresse.'); return; }
      if (r.ohneEmail.length) setError(`Ohne E-Mail-Adresse und daher nicht im Verteiler: ${r.ohneEmail.join(', ')}`);
      window.location.href = r.url;
    } catch (e) { setError((e as Error).message); }
  }

  const header = (
    <Filters>
      <Filter label="Teilnehmer">
        <SegmentedButton onSelectionChange={(e) => setFilter((e.detail.selectedItems[0] as HTMLElement).dataset.f as FilterArt)}>
          <SegmentedButtonItem data-f="ALL" selected={filter === 'ALL'}>Alle{data ? ` (${data.teilnehmer.length})` : ''}</SegmentedButtonItem>
          <SegmentedButtonItem data-f="MEMBER" selected={filter === 'MEMBER'}>Mitglieder{data ? ` (${data.mitglieder})` : ''}</SegmentedButtonItem>
          <SegmentedButtonItem data-f="NONMEMBER" selected={filter === 'NONMEMBER'}>Nichtmitglieder{data ? ` (${data.nichtmitglieder})` : ''}</SegmentedButtonItem>
        </SegmentedButton>
      </Filter>
      <Filter label="Suche" width="16rem">
        <Input style={{ width: '100%' }} placeholder="Name oder E-Mail…" value={suche} showClearIcon onInput={(e) => setSuche(e.target.value)} />
      </Filter>
      <HeaderKpi label="Einheiten in der Auswahl" value={einheiten.toLocaleString('de-DE')} />
    </Filters>
  );

  return (
    <AppPage title={`Teilnehmer Jugendtraining (${rows.length})`} subtitle={`${einheiten} Einheiten – Personen mit laufendem Jugendtraining-Vertrag`} header={header}
             actions={<>
               <Button icon="email" disabled={!mitEmail.length} onClick={mail}>{markiert.length ? `E-Mail an Auswahl (${markiert.length})` : 'E-Mail an Auswahl'}</Button>
               <Button icon="refresh" design="Transparent" onClick={() => { setSel([]); reload(); }}>Neu laden</Button>
             </>}>
      {(error || ladeFehler) && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error ?? ladeFehler}</MessageStrip>}
      <Section title="Trefferliste" count={rows.length} flush
               status={sel.length ? <Text className="portal-muted">{sel.length} markiert{mitEmail.length < markiert.length ? `, ${markiert.length - mitEmail.length} ohne E-Mail` : ''}</Text> : undefined}
               actions={sel.length ? <Button design="Transparent" onClick={() => setSel([])}>Auswahl aufheben</Button> : undefined}>
        <AnalyticalTable columns={columns} data={rows} loading={loading} sortable visibleRows={Math.min(Math.max(rows.length, 3), 25)}
                         noDataText="Keine Teilnehmer gefunden" />
      </Section>
      <MessageStrip hideCloseButton>
        Jeder laufende Vertrag der Art 90 (Jugendtraining) zählt als gebuchte Einheit; ein laufender Vertrag einer Art unter 90 macht die Person zum Vereinsmitglied.
        Stammdaten werden unter „Mitglieder“ gepflegt.
      </MessageStrip>
      {detail && <DetailDialog adrnr={detail} onClose={() => setDetail(null)} />}
    </AppPage>
  );
}

interface Detail {
  adrnr: string; name: string; anrede: string; vorname: string; nachname: string; strasse: string; plz: string; ort: string; email: string; telefon: string; mobil: string;
  geburtsdatum: string | null; alter: number | null; eintritt: string | null; austritt: string | null; mitglnr: string; mitglied: boolean;
  einheiten: number; trainingsbeitrag: number; zahler: { adrnr: string; name: string; email: string; mobil: string } | null;
  vertraege: { vertragnr: string; art: string; artname: string; sollstellung: string; vertragbegin: string | null; vertragende: string | null; betrag: number; jugend: boolean; laeuft: boolean }[];
}

function DetailDialog({ adrnr, onClose }: { adrnr: string; onClose: () => void }) {
  const navigate = useNavigate();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.get<Detail>(`${TN}/${encodeURIComponent(adrnr)}`).then(setD).catch((e) => setError(e.message)); }, [adrnr]);
  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Art', accessor: 'art', width: 60 },
    { Header: 'Bezeichnung', accessor: 'artname', minWidth: 160, Cell: ({ row, value }: Cell) => <Text style={{ fontWeight: row.original.jugend ? 'bold' : undefined }}>{value}</Text> },
    { Header: 'Turnus', accessor: 'sollstellung', width: 110 },
    { Header: 'Beginn', accessor: 'vertragbegin', width: 105, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Ende', accessor: 'vertragende', width: 105, Cell: ({ value }: Cell) => (value ? dat(value) : 'laufend') },
    { Header: 'Betrag', accessor: 'betrag', width: 100, hAlign: 'End', Cell: ({ value }: Cell) => eur(value) },
  ];
  return (
    <Dlg titel={d ? d.name : 'Teilnehmer'} onClose={onClose} breite="min(900px, 95vw)"
         fuss={<Button icon="group" onClick={() => navigate(`/tco/mitglieder?adrnr=${encodeURIComponent(adrnr)}`)}>Zum Mitglied</Button>}>
      {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
      {d && (
        <>
          <ObjectHeader title={`${d.vorname} ${d.nachname}`.trim()} icon="family-care"
                        subtitle={d.mitglnr ? `Mitgliedsnummer ${d.mitglnr}` : 'ohne Mitgliedsnummer'}
                        status={<>
                          <ObjectStatus state={d.mitglied ? 'Positive' : 'Critical'} inverted>{d.mitglied ? 'Vereinsmitglied' : 'Nichtmitglied'}</ObjectStatus>
                          <ObjectStatus state="Information">{d.einheiten} Einheit(en) · {eur(d.trainingsbeitrag)}</ObjectStatus>
                        </>}>
            <Attributes>
              <Attribute label="Geburtsdatum">{d.geburtsdatum ? `${dat(d.geburtsdatum)} (${d.alter} Jahre)` : ''}</Attribute>
              <Attribute label="Anschrift">{[d.strasse, `${d.plz} ${d.ort}`.trim()].filter(Boolean).join(', ')}</Attribute>
              <Attribute label="E-Mail">{d.email ? <Link href={`mailto:${d.email}`}>{d.email}</Link> : ''}</Attribute>
              <Attribute label="Telefon / Mobil">{[d.telefon, d.mobil].filter(Boolean).join(' / ')}</Attribute>
              <Attribute label="Eintritt">{dat(d.eintritt)}</Attribute>
              <Attribute label="Zahler">{d.zahler ? <Link onClick={() => navigate(`/tco/mitglieder?adrnr=${encodeURIComponent(d.zahler!.adrnr)}`)}>{d.zahler.name}</Link> : ''}</Attribute>
            </Attributes>
          </ObjectHeader>
          <Section title="Verträge" count={d.vertraege.length} flush>
            <AnalyticalTable columns={columns} data={d.vertraege} visibleRows={Math.max(d.vertraege.length, 1)} noDataText="Keine Verträge"
                             withRowHighlight highlightField={(r: Record<string, any>) => (r.laeuft ? (r.jugend ? 'Information' : 'None') : 'Critical')} />
          </Section>
        </>
      )}
    </Dlg>
  );
}
