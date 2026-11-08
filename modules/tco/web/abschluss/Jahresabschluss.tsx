import { useEffect, useMemo, useState } from 'react';
import {
  AnalyticalTable, Bar, BusyIndicator, Button, CheckBox, Dialog, FlexBox, Icon, MessageStrip, ObjectStatus, Option, SegmentedButton,
  SegmentedButtonItem, Select, Text,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { Attribute, Attributes } from '@core/components/Attributes';
import { Filter, Filters, HeaderKpi } from '@core/components/Filters';
import { PdfDialog } from '@core/components/PdfDialog';
import { Empty, Section } from '@core/components/Section';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { dat, eur } from '../util';
import { AnlageDialog } from './AnlageDialog';
import { AB, ANL_STATE, anlnrText, saldoState, type Abschluss, type Spiegel, type State } from './typen';

/**
 * Jahresabschluss – Port von Z2UI5_CL_TCO_JAHRESABSCHLUSS: Einnahmen-Ausgaben-Rechnung je
 * Tätigkeitsbereich (Baum oder Tabelle), Überschussrechnung mit zwei Vorjahren, Bankbestände,
 * Anlagevermögen mit AfA; PDF (EAR, Steuererklärung, Anlagevermögen) mit Voransicht und Ablage in Paperless.
 */

interface Zeile {
  id: string; text: string; icon?: string; ebene: 0 | 1 | 2; konto?: string; name?: string; art?: string;
  ein?: number | null; aus?: number | null; saldo?: number | null; werte?: (number | null)[]; state?: State; farbig?: boolean; subRows?: Zeile[];
}
type Teile = { ear: boolean; steuer: boolean; anlagen: boolean };

const betragZelle = (v: number | null | undefined, fett?: boolean, state?: State) => {
  if (v === null || v === undefined) return '';
  const t = fett ? <b>{eur(v)}</b> : eur(v);
  return state && state !== 'None' ? <ObjectStatus state={state}>{t}</ObjectStatus> : <Text>{t}</Text>;
};
const textZelle = ({ row }: Cell) => {
  const z = row.original as Zeile;
  return (
    <FlexBox alignItems="Center" style={{ gap: '0.35rem', minWidth: 0 }}>
      {z.icon && <Icon name={z.icon} />}
      <Text style={{ fontWeight: z.ebene < 2 ? 'bold' : undefined }}>{z.text}</Text>
    </FlexBox>
  );
};
const zeilenBaum = (rows: Zeile[]): number => rows.reduce((n, r) => n + 1 + (r.subRows ? zeilenBaum(r.subRows) : 0), 0);

export function Jahresabschluss() {
  const can = useCan();
  const edit = can('tco.abschluss:edit');
  const [jahr, setJahr] = useState(new Date().getFullYear());
  const [d, setD] = useState<Abschluss | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [baum, setBaum] = useState(true);
  const [anlage, setAnlage] = useState<number | null | undefined>(undefined); // undefined = zu, null = neu
  const [auswahl, setAuswahl] = useState<Teile | null>(null);
  const [pdf, setPdf] = useState<Teile | null>(null);

  const laden = (j = jahr) => api.get<Abschluss>(`${AB}/init?jahr=${j}`).then(setD).catch((e) => setError(e.message));
  useEffect(() => { setD(null); laden(jahr); }, [jahr]); // eslint-disable-line react-hooks/exhaustive-deps

  async function aktion(fn: () => Promise<{ text: string } | void>) {
    setError(null); setBusy(true);
    try { const r = await fn(); if (r?.text) toast(r.text, 5000); await laden(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  // ---------------------------------------------------------------- Tätigkeitsbereiche: Baum (Bereich → Konto) oder flache Tabelle
  const earBaum = useMemo<Zeile[]>(() => (d?.ear.bereiche ?? []).map((b) => ({
    id: b.bereich, text: b.text, icon: 'course-book', ebene: 1, ein: b.ein, aus: b.aus, saldo: b.ergebnis, state: saldoState(b.ergebnis),
    subRows: [
      ...b.einnahmen.map((k): Zeile => ({ id: `${b.bereich}-1-${k.konto}`, text: `${k.konto} ${k.name}`, icon: 'money-bills', ebene: 2, ein: k.wert, aus: null, saldo: k.wert, state: 'Positive' })),
      ...b.ausgaben.map((k): Zeile => ({ id: `${b.bereich}-2-${k.konto}`, text: `${k.konto} ${k.name}`, icon: 'receipt', ebene: 2, ein: null, aus: k.wert, saldo: -k.wert, state: 'Negative' })),
    ],
  })), [d]);
  const earTabelle = useMemo<Zeile[]>(() => (d?.ear.bereiche ?? []).flatMap((b) => [
    { id: `${b.bereich}-E`, text: b.text, art: 'Einnahmen', ebene: 1 as const, state: 'Information' as State },
    ...b.einnahmen.map((k): Zeile => ({ id: `${b.bereich}-E-${k.konto}`, text: b.text, art: 'Einnahmen', konto: k.konto, name: k.name, ebene: 2, saldo: k.wert })),
    { id: `${b.bereich}-ES`, text: b.text, art: 'Einnahmen', name: 'Summe Einnahmen', ebene: 1 as const, saldo: b.ein, state: 'Information' as State },
    { id: `${b.bereich}-A`, text: b.text, art: 'Ausgaben', ebene: 1 as const, state: 'Information' as State },
    ...b.ausgaben.map((k): Zeile => ({ id: `${b.bereich}-A-${k.konto}`, text: b.text, art: 'Ausgaben', konto: k.konto, name: k.name, ebene: 2, saldo: k.wert })),
    { id: `${b.bereich}-AS`, text: b.text, art: 'Ausgaben', name: 'Summe Ausgaben', ebene: 1 as const, saldo: b.aus, state: 'Information' as State },
    { id: `${b.bereich}-R`, text: b.text, art: 'Ergebnis', name: `Ergebnis ${b.text.slice(2)}`, ebene: 1 as const, saldo: b.ergebnis, state: saldoState(b.ergebnis), farbig: true },
  ]), [d]);

  const earBaumSpalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Bereich / Konto', accessor: 'text', minWidth: 280, Cell: textZelle },
    { Header: 'Einnahmen', accessor: 'ein', width: 130, hAlign: 'End', Cell: ({ row, value }: Cell) => betragZelle(value, row.original.ebene === 1) },
    { Header: 'Ausgaben', accessor: 'aus', width: 130, hAlign: 'End', Cell: ({ row, value }: Cell) => betragZelle(value, row.original.ebene === 1) },
    { Header: 'Saldo', accessor: 'saldo', width: 150, hAlign: 'End', Cell: ({ row, value }: Cell) => betragZelle(value, row.original.ebene === 1, row.original.state) },
  ];
  const earTabelleSpalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Bereich', accessor: 'text', minWidth: 200 },
    { Header: 'Art', accessor: 'art', width: 110 },
    { Header: 'Konto', accessor: 'konto', width: 80 },
    { Header: 'Bezeichnung', accessor: 'name', minWidth: 200, Cell: ({ row, value }: Cell) => (row.original.ebene === 1 ? <b>{value ?? ''}</b> : <Text>{value ?? ''}</Text>) },
    { Header: 'Betrag', accessor: 'saldo', width: 150, hAlign: 'End', Cell: ({ row, value }: Cell) => betragZelle(value, row.original.ebene === 1, row.original.farbig ? row.original.state : undefined) },
  ];

  // ---------------------------------------------------------------- Überschussrechnung: Baum (Art → Konto) oder Tabelle (Bereich × Art)
  const u = d?.ueberschuss;
  const uebBaum = useMemo<Zeile[]>(() => (u ? [
    ...u.arten.map((a): Zeile => ({
      id: `U${a.art}`, text: a.text, icon: a.art === '1' ? 'money-bills' : 'receipt', ebene: 1, werte: a.summe,
      subRows: a.konten.map((k): Zeile => ({ id: `U${a.art}-${k.konto}`, text: `${k.konto} ${k.name}`, icon: a.art === '1' ? 'money-bills' : 'receipt', ebene: 2, werte: k.werte })),
    })),
    { id: 'US', text: 'Überschuss / Fehlbetrag', icon: 'sum', ebene: 1, werte: u.ergebnis, farbig: true },
  ] : []), [u]);
  const uebTabelle = useMemo<Zeile[]>(() => (u ? [
    ...u.bereiche.flatMap((b): Zeile[] => [
      { id: `${b.bereich}-E`, text: `${b.text} – Einnahmen`, ebene: 2, werte: b.ein },
      { id: `${b.bereich}-A`, text: `${b.text} – Ausgaben`, ebene: 2, werte: b.aus },
      { id: `${b.bereich}-U`, text: `Überschuss ${b.text}`, ebene: 1, werte: b.ergebnis, farbig: true, state: 'Information' },
    ]),
    { id: 'GE', text: 'Einnahmen gesamt', ebene: 1, werte: u.ein, state: 'Information' },
    { id: 'GA', text: 'Ausgaben gesamt', ebene: 1, werte: u.aus, state: 'Information' },
    { id: 'GU', text: 'Überschuss / Fehlbetrag gesamt', ebene: 0, werte: u.ergebnis, farbig: true, state: saldoState(u.ergebnis[0]) },
  ] : []), [u]);
  const uebSpalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Position / Konto', accessor: 'text', minWidth: 280, Cell: textZelle },
    ...(u?.jahre ?? []).map((j, i) => ({
      Header: String(j), id: `w${i}`, accessor: (z: Record<string, any>) => (z as Zeile).werte?.[i] ?? null, width: 150, hAlign: 'End' as const,
      Cell: ({ row, value }: Cell) => betragZelle(value, row.original.ebene < 2, row.original.farbig ? saldoState(value) : undefined),
    })),
  ];

  // ---------------------------------------------------------------- Bankkonten und Anlagen
  const bankSpalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Konto', accessor: 'konto', width: 90 },
    { Header: 'Bezeichnung', accessor: 'name', minWidth: 200 },
    { Header: `Anfangsbestand 01.01.${jahr}`, accessor: 'anfang', width: 170, hAlign: 'End', Cell: ({ value }: Cell) => betragZelle(value) },
    { Header: `Endbestand 31.12.${jahr}`, accessor: 'ende', width: 170, hAlign: 'End', Cell: ({ value }: Cell) => betragZelle(value) },
    { Header: 'Veränderung', accessor: 'delta', width: 150, hAlign: 'End', Cell: ({ value }: Cell) => betragZelle(value, true, saldoState(value)) },
    { Header: 'Herkunft Anfangsbestand', accessor: 'quelle', minWidth: 180, responsiveMinWidth: 1300, Cell: ({ value }: Cell) => <Text className="portal-muted">{value}</Text> },
  ];
  const anlSpalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Nr.', accessor: 'anlnr', width: 70, Cell: ({ value }: Cell) => anlnrText(value) },
    { Header: 'Bezeichnung', accessor: 'bezeichnung', minWidth: 180 },
    { Header: 'Anschaffung', accessor: 'anschdat', width: 110, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Anschaffungswert', accessor: 'anschwert', width: 140, hAlign: 'End', Cell: ({ value }: Cell) => betragZelle(value) },
    { Header: 'ND Jahre', accessor: 'nutzdauer', width: 90, hAlign: 'End' },
    { Header: 'AfA-Satz', accessor: 'afa_satz', width: 90, hAlign: 'End', Cell: ({ value }: Cell) => `${value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %` },
    { Header: 'Buchwert 01.01.', accessor: 'bw_beginn', width: 130, hAlign: 'End', Cell: ({ value }: Cell) => betragZelle(value) },
    { Header: 'Zugang', accessor: 'zugang', width: 120, hAlign: 'End', Cell: ({ value }: Cell) => (value ? betragZelle(value) : '') },
    { Header: `AfA ${jahr}`, accessor: 'afa_jahr', width: 120, hAlign: 'End', Cell: ({ value }: Cell) => betragZelle(value) },
    { Header: 'Buchwert 31.12.', accessor: 'bw_ende', width: 130, hAlign: 'End', Cell: ({ value }: Cell) => betragZelle(value, true) },
    { Header: 'Status', accessor: 'status', width: 120, Cell: ({ value }: Cell) => <ObjectStatus state={ANL_STATE[value as Spiegel['status']]}>{value}</ObjectStatus> },
  ];

  const header = (
    <Filters>
      <Filter label="Geschäftsjahr" width="8rem">
        <Select style={{ width: '100%' }} onChange={(e) => setJahr(Number((e.detail.selectedOption as HTMLElement).dataset.j))}>
          {(d?.jahre ?? [jahr]).map((j) => <Option key={j} data-j={j} selected={j === jahr}>{j}</Option>)}
        </Select>
      </Filter>
      <Filter label="Darstellung">
        <SegmentedButton onSelectionChange={(e) => setBaum((e.detail.selectedItems[0] as HTMLElement).dataset.k === 'baum')}>
          <SegmentedButtonItem data-k="baum" icon="tree" selected={baum}>Baumansicht</SegmentedButtonItem>
          <SegmentedButtonItem data-k="tab" icon="table-view" selected={!baum}>Tabellenansicht</SegmentedButtonItem>
        </SegmentedButton>
      </Filter>
      {d && <HeaderKpi label={`Ergebnis ${jahr}`} value={eur(d.ear.ergebnis)} state={d.ear.ergebnis < 0 ? 'Negative' : 'Positive'} />}
    </Filters>
  );

  const pdfUrl = pdf ? `${AB}/pdf?jahr=${jahr}&ear=${pdf.ear ? 1 : 0}&steuer=${pdf.steuer ? 1 : 0}&anlagen=${pdf.anlagen ? 1 : 0}` : null;
  const pdfTitel = (t: Teile) => {
    const teile = [t.ear && 'EAR', t.steuer && 'Steuererklärung', t.anlagen && !t.steuer && 'Anlagevermögen'].filter(Boolean) as string[];
    return teile.length === 1 ? (t.ear ? `Einnahmen-Ausgaben-Rechnung ${jahr}` : t.steuer ? `Steuererklärung ${jahr}` : `Anlagevermögen ${jahr}`) : `Jahresabschluss ${jahr} (${teile.join(', ')})`;
  };

  return (
    <AppPage title={`Jahresabschluss ${jahr}`} subtitle="Jahresabschluss: Tätigkeitsbereiche, Überschussrechnung mit Vorjahren, Bankbestände und Anlagevermögen" header={header}
             actions={<>
               <Button icon="pdf-attachment" design="Emphasized" disabled={!d} onClick={() => setAuswahl({ ear: true, steuer: false, anlagen: false })}>PDF erzeugen</Button>
               <Button icon="refresh" design="Transparent" tooltip="Neu berechnen" onClick={() => { setD(null); laden(); }} />
             </>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      {!d && !error && <BusyIndicator active delay={200} style={{ width: '100%', display: 'block', padding: '2rem 0' }} />}
      {d && (
        <BusyIndicator active={busy} delay={300} style={{ width: '100%', display: 'block' }}>
          {d.hinweise.map((h) => <MessageStrip key={h} design={d.ear.leer ? 'Critical' : 'Information'} hideCloseButton style={{ marginBottom: '0.5rem' }}>{h}</MessageStrip>)}

          <Section title="Jahresergebnis">
            <Attributes>
              <Attribute label="Einnahmen gesamt" strong>{eur(d.ear.ein)}</Attribute>
              <Attribute label="Ausgaben gesamt" strong>{eur(d.ear.aus)}</Attribute>
              <Attribute label="Ergebnis" strong><ObjectStatus state={saldoState(d.ear.ergebnis)}><b>{eur(d.ear.ergebnis)}</b></ObjectStatus></Attribute>
              <Attribute label="Zeitraum">01.01.{jahr} – 31.12.{jahr}</Attribute>
            </Attributes>
          </Section>

          <Section title={`Tätigkeitsbereiche und Konten ${jahr}`} flush>
            {baum ? (
              <AnalyticalTable columns={earBaumSpalten} data={earBaum} isTreeTable visibleRows={Math.max(zeilenBaum(earBaum), 2)} noDataText={`Für ${jahr} liegen keine Buchungen vor.`}
                               reactTableOptions={{ autoResetExpanded: false, getRowId: (r: Zeile) => r.id, initialState: { expanded: { A: true, B: true, C: true, D: true } } }} />
            ) : (
              <AnalyticalTable columns={earTabelleSpalten} data={earTabelle} visibleRows={Math.max(earTabelle.length, 2)} noDataText={`Für ${jahr} liegen keine Buchungen vor.`}
                               withRowHighlight highlightField={(r: Record<string, any>) => (r.state ?? 'None')} />
            )}
          </Section>

          {u && (
            <Section title={`Überschussrechnung – ${jahr} mit Vorjahresvergleich`} flush>
              {baum ? (
                <AnalyticalTable columns={uebSpalten} data={uebBaum} isTreeTable visibleRows={Math.max(zeilenBaum(uebBaum), 3)}
                                 reactTableOptions={{ autoResetExpanded: false, getRowId: (r: Zeile) => r.id, initialState: { expanded: { U1: true, U2: true } } }} />
              ) : (
                <AnalyticalTable columns={uebSpalten} data={uebTabelle} visibleRows={uebTabelle.length}
                                 withRowHighlight highlightField={(r: Record<string, any>) => (r.state ?? 'None')} />
              )}
            </Section>
          )}

          <Section title="Bankkonten – Anfangs- und Endbestand" count={d.bank.length} flush>
            {d.bank.length
              ? <AnalyticalTable columns={bankSpalten} data={d.bank} visibleRows={d.bank.length} />
              : <Empty>Keine Geld- oder Darlehenskonten (Kennzahl BA/BK) mit Bestand in {jahr}.</Empty>}
          </Section>

          <Section title={`Anlagevermögen und Abschreibungen ${jahr}`} count={d.anlagen.spiegel.length} flush
                   actions={<>
                     {edit && d.anlagen.leer && <Button icon="excel-attachment" onClick={() => aktion(() => api.post(`${AB}/anlagen/initialbestand`))}>Bestand aus Excel übernehmen</Button>}
                     {edit && <Button icon="add" onClick={() => setAnlage(null)}>Neues Objekt</Button>}
                     <Button icon="print" onClick={() => setPdf({ ear: false, steuer: false, anlagen: true })}>Formular drucken</Button>
                   </>}>
            <div style={{ padding: '0.75rem 1rem' }}>
              <Attributes narrow>
                <Attribute label={`Buchwert 01.01.${jahr}`} strong>{eur(d.anlagen.summe.bw_beginn)}</Attribute>
                <Attribute label="Zugänge" strong>{eur(d.anlagen.summe.zugang)}</Attribute>
                <Attribute label={`Abschreibung ${jahr}`} strong><ObjectStatus state="Negative"><b>{eur(d.anlagen.summe.afa_jahr)}</b></ObjectStatus></Attribute>
                <Attribute label={`Buchwert 31.12.${jahr}`} strong>{eur(d.anlagen.summe.bw_ende)}</Attribute>
              </Attributes>
            </div>
            {d.anlagen.spiegel.length ? (
              <AnalyticalTable columns={anlSpalten} data={d.anlagen.spiegel} visibleRows={d.anlagen.spiegel.length}
                               onRowClick={(e) => setAnlage(e.detail.row.original.anlnr)}
                               withRowHighlight highlightField={(r: Record<string, any>) => ANL_STATE[r.status as Spiegel['status']]} />
            ) : <Empty>Bis {jahr} sind keine Anlageobjekte erfasst.</Empty>}
            <MessageStrip hideCloseButton style={{ margin: '0.5rem 1rem 1rem' }}>
              Lineare Abschreibung, im Anschaffungsjahr anteilig nach den je Objekt hinterlegten Monaten. Die Abschreibung ist eine Information zum Jahresabschluss
              und verändert das Ergebnis der Einnahmen-Ausgaben-Rechnung nicht. Zeile anklicken, um ein Objekt zu bearbeiten.
            </MessageStrip>
          </Section>
        </BusyIndicator>
      )}

      {anlage !== undefined && <AnlageDialog anlnr={anlage} edit={edit} onClose={(g) => { setAnlage(undefined); if (g) laden(); }} />}

      {auswahl && (
        <Dialog open headerText={`PDF erzeugen – ${jahr}`} onClose={() => setAuswahl(null)}
                footer={<Bar endContent={<>
                  <Button design="Emphasized" icon="pdf-attachment" disabled={!auswahl.ear && !auswahl.steuer && !auswahl.anlagen}
                          onClick={() => { setPdf(auswahl); setAuswahl(null); }}>Voransicht</Button>
                  <Button onClick={() => setAuswahl(null)}>Abbrechen</Button>
                </>} />}>
          <FlexBox direction="Column" style={{ gap: '0.25rem', minWidth: 'min(420px, 80vw)' }}>
            <Text>Bitte die Teile wählen – alle gewählten Teile kommen in ein Dokument:</Text>
            <CheckBox text="EAR – Einnahmen-Ausgaben-Rechnung, Überschussrechnung, Vermögensübersicht" checked={auswahl.ear} onChange={(e) => setAuswahl({ ...auswahl, ear: e.target.checked })} />
            <CheckBox text={`Steuererklärung – Bereiche, Konten und Bankkonten ${jahr - 2} bis ${jahr} (enthält das Anlagevermögen)`} checked={auswahl.steuer} onChange={(e) => setAuswahl({ ...auswahl, steuer: e.target.checked })} />
            <CheckBox text="Anlagevermögen – Anlagenspiegel und Wertentwicklung" checked={auswahl.anlagen} onChange={(e) => setAuswahl({ ...auswahl, anlagen: e.target.checked })} />
            {!auswahl.ear && !auswahl.steuer && !auswahl.anlagen && <Text className="portal-muted portal-small">Bitte mindestens einen Teil auswählen: EAR, Steuererklärung oder Anlagevermögen.</Text>}
          </FlexBox>
        </Dialog>
      )}

      <PdfDialog url={pdfUrl} title={pdf ? `Voransicht ${pdfTitel(pdf)}` : ''} filename={pdf ? `${pdfTitel(pdf).replace(/[^\wäöüÄÖÜß-]+/g, '_')}.pdf` : 'Jahresabschluss.pdf'}
                 onClose={() => setPdf(null)}
                 actions={edit && d?.paperless && pdf ? (
                   <Button design="Emphasized" icon="upload-to-cloud" disabled={busy} onClick={() => {
                     const t = pdf;
                     aktion(async () => {
                       const r = await api.post<{ text: string; warnungen: string[] }>(`${AB}/paperless`, { jahr, ...t });
                       if (r.warnungen.length) setError(r.warnungen.join('\n'));
                       setPdf(null);
                       return r;
                     });
                   }}>In Paperless ablegen</Button>
                 ) : undefined} />
    </AppPage>
  );
}
