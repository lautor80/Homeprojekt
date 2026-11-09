import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AnalyticalTable, Button, CheckBox, DatePicker, FlexBox, Input, Label, Link, MessageStrip, ObjectStatus, Option, Select, Tab, TabContainer, Text,
  TextArea, Title, Toolbar, ToolbarSpacer,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { PdfDialog } from '@core/components/PdfDialog';
import { toast } from '@core/toast';
import { useCan } from '@core/session';
import { Attribute, Attributes } from '@core/components/Attributes';
import { ObjectHeader } from '@core/components/ObjectHeader';
import { dat, eur } from '../util';
import { MG, type Auswahl, type Detail } from './typen';
import { BankDialog, KommDialog, KopfDialog, VertragDialog } from './Dialoge';
import { Dokumente } from './Dokumente';
import { GruppenTab } from './GruppenTab';
import { useAblageZiel } from '@core/ablage';
import { SperrHinweis, useSperre } from '@core/sperre';

const t = (s: string | null | undefined) => (s ? <Text>{s}</Text> : null);
const ibanFormat = (s: string) => s.replace(/\s/g, '').replace(/(.{4})/g, '$1 ').trim();

/** Beschriftetes Feld (Label über Wert) – Kernbaustein Attribute */
export function Feld({ label, children }: { label: string; children: ReactNode }) {
  return <Attribute label={label}>{children}</Attribute>;
}
export const Raster = ({ children }: { children: ReactNode }) => (
  <div style={{ padding: '0.5rem 0' }}><Attributes>{children}</Attributes></div>
);

export function MitgliedDetail({ adrnr, edit: darf, onChanged, onOpen }: { adrnr: string; edit: boolean; onChanged: () => void; onOpen: (a: string) => void }) {
  const can = useCan();
  const [d, setD] = useState<Detail | null>(null);
  const [aw, setAw] = useState<Auswahl | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState('stamm');
  const [dlg, setDlg] = useState<'kopf' | 'bank' | 'vertrag' | 'komm' | null>(null);
  const [art, setArt] = useState('2');
  const [pdf, setPdf] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [docSel, setDocSel] = useState<number[]>([]);
  const [eingang, setEingang] = useState<File[]>([]);
  // Sperre gegen gleichzeitige Bearbeitung: nur mit eigener Sperre bearbeitbar
  const sperre = useSperre('MITGLIED', adrnr, darf, { bezeichnung: d ? `Mitglied ${d.titel}` : undefined });
  const edit = darf && sperre.eigen;

  // Ablage (Drag & Drop ins Ablagefeld, Strg+V): Dokumente des Mitglieds – Dokumenttyp wird je Datei abgefragt
  useAblageZiel(edit && d ? {
    titel: `${d.titel} – Dokumente`,
    annehmen: (files) => { setTab('dok'); setEingang((alt) => [...alt, ...files]); },
  } : null);

  const laden = () => api.get<Detail>(`${MG}/m/${adrnr}`).then(setD).catch((e) => setError(e.message));
  useEffect(() => {
    laden();
    api.get<Auswahl>(`${MG}/auswahl?ohne=${adrnr}`).then(setAw).catch((e) => setError(e.message));
  }, [adrnr]); // eslint-disable-line react-hooks/exhaustive-deps

  async function aktion(fn: () => Promise<{ text?: string; warnungen?: string[] } | void>, liste = true) {
    setError(null);
    setBusy(true);
    try {
      const r = await fn();
      if (r?.text) toast(r.text, 5000);
      if (r?.warnungen?.length) setError(r.warnungen.join('\n'));
      await laden();
      if (liste) onChanged();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  if (!d) return error ? <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip> : <Text>Lade …</Text>;
  const m = d.mitglied;
  const ausgetreten = !!m.austritt;
  const unterlagen = aw?.unterlagen ?? {};

  const initialen = `${m.vorname?.[0] ?? ''}${m.nachname?.[0] ?? ''}`.toUpperCase() || undefined;
  return (
    <div>
      <ObjectHeader
        title={d.titel}
        initials={initialen}
        subtitle={[m.mitglnrn && `Mitglied Nr. ${m.mitglnrn}`, `Adressnummer ${Number(m.adrnr)}`, [m.strasse, `${m.plz} ${m.ort}`.trim()].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
        status={<>
          <ObjectStatus state={m.aktiv ? 'Positive' : ausgetreten ? 'Negative' : 'Critical'} inverted>
            {m.aktiv ? 'Aktiv' : ausgetreten ? `Austritt ${dat(m.austritt)}` : m.mitglnrn ? 'Ohne Eintritt' : 'Zahler'}
          </ObjectStatus>
          {d.trainer && <ObjectStatus state="Information" inverted>Trainer</ObjectStatus>}
          {d.zuid && <ObjectStatus state="Information">EP3-Kunde {d.zuid}</ObjectStatus>}
          {m.eintritt && <span className="portal-muted portal-small">Eintritt {dat(m.eintritt)}</span>}
        </>}
        actions={<>
          <Button icon="email" design="Transparent" onClick={() => setDlg('komm')}>Kommunikation</Button>
          <ChangeHistoryButton objectType="MITGLIED" objectKey={adrnr} />
        </>}
      >
        <div className="portal-row">
          <Label>Unterlage</Label>
          <Select style={{ width: '15rem' }} onChange={(e) => setArt((e.detail.selectedOption as HTMLElement).dataset.k!)}>
            {Object.entries(unterlagen).map(([k, t]) => <Option key={k} data-k={k} selected={k === art}>{t}</Option>)}
          </Select>
          <Button icon="show" onClick={() => setPdf(`${MG}/m/${adrnr}/unterlage/${art}`)}>Voransicht</Button>
          {edit && aw?.paperless && (
            <Button icon="upload-to-cloud" disabled={busy} onClick={() => aktion(async () => {
              const r = await api.post<{ id: number; text: string; warnungen: string[] }>(`${MG}/m/${adrnr}/unterlage/${art}/ablegen`);
              setDocSel([r.id]);
              return r;
            }, false)}>Ablegen</Button>
          )}
        </div>
        {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginTop: '0.75rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
        <SperrHinweis s={sperre} style={{ marginTop: '0.75rem', marginBottom: 0 }} />
      </ObjectHeader>

      <div className="portal-section">
      <TabContainer tabLayout="Inline" contentBackgroundDesign="Transparent" onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key!)}>
        <Tab data-key="stamm" text="Stammdaten" selected={tab === 'stamm'}>
          <Stammdaten d={d} edit={edit} onEdit={() => setDlg('kopf')} onAktion={aktion} />
        </Tab>
        <Tab data-key="bank" text="Bank & SEPA" selected={tab === 'bank'}>
          <Toolbar design="Transparent">
            <Title level="H5">Bankverbindung</Title>
            <ToolbarSpacer />
            {edit && can('tco.bankdaten:edit') && <Button icon="edit" onClick={() => setDlg('bank')}>Bearbeiten</Button>}
          </Toolbar>
          {!d.bankKlar && (
            <MessageStrip hideCloseButton design="Information" style={{ marginBottom: '0.5rem' }}>
              IBAN, BIC und abweichender Kontoinhaber werden maskiert angezeigt. Für den Klartext ist die Berechtigung
              „Bankdaten von Personen“ (Rollenpflege → Datenschutz) nötig.
            </MessageStrip>
          )}
          <Raster>
            <Feld label="Zahlungsart">{t(d.bank.zahlungsart_txt)}</Feld>
            <Feld label="Zahlungsweise">{t(d.bank.zahlungsweise_txt)}</Feld>
            <Feld label="Kontoinhaber">{t(d.bank.kontoinhaber)}</Feld>
            <Feld label="IBAN">{t(ibanFormat(d.bank.iban))}</Feld>
            <Feld label="BIC">{t(d.bank.bic)}</Feld>
            <Feld label="Kreditinstitut">{t(d.bank.bank)}</Feld>
            <Feld label="Mandatsreferenz">{t(d.bank.mandatsref)}</Feld>
            <Feld label="Abweichender Zahler">
              {d.bank.zahler ? <Link onClick={() => onOpen(d.bank.zahler!.adrnr)}>{d.bank.zahler.name}{d.bank.zahler.austritt ? ` (Austritt ${dat(d.bank.zahler.austritt)})` : ''}</Link> : null}
            </Feld>
          </Raster>
          <SepaTabelle d={d} edit={edit} onAktion={aktion} />
        </Tab>
        <Tab data-key="vt" text={`Verträge (${d.vertraege.filter((v) => v.laeuft).length})`} selected={tab === 'vt'}>
          <Vertraege d={d} aw={aw} edit={edit} onNeu={() => setDlg('vertrag')} onAktion={aktion} />
        </Tab>
        <Tab data-key="fam" text={`Familie & Schlüssel (${d.familie.length - 1})`} selected={tab === 'fam'}>
          <Familie d={d} onOpen={onOpen} />
          <Schluessel d={d} edit={edit} onAktion={aktion} />
        </Tab>
        <Tab data-key="grp" text={`Gruppen (${d.gruppen.length})`} selected={tab === 'grp'}>
          {tab === 'grp' && <GruppenTab d={d} edit={edit} onAktion={aktion} />}
        </Tab>
        <Tab data-key="dok" text="Dokumente" selected={tab === 'dok'}>
          {tab === 'dok' && <Dokumente adrnr={adrnr} edit={edit} sel={docSel} onSel={setDocSel} onError={setError} onKomm={() => setDlg('komm')}
                                       eingang={eingang} onEingang={(f) => setEingang((alt) => [...alt, ...f])} onErledigt={() => setEingang((alt) => alt.slice(1))} />}
        </Tab>
        <Tab data-key="not" text={`Notizen (${d.notizen.length})`} selected={tab === 'not'}>
          <Notizen d={d} edit={edit} onAktion={aktion} />
        </Tab>
      </TabContainer>
      </div>

      {pdf && <PdfDialog url={pdf} title={`Voransicht: ${unterlagen[art]} – ${d.titel}`} filename={`${unterlagen[art]}_${m.nachname}_${m.vorname}.pdf`} onClose={() => setPdf(null)} />}
      {dlg === 'kopf' && <KopfDialog d={d} onClose={(ok) => { setDlg(null); if (ok) aktion(async () => ({ text: 'Stammdaten gesichert.' })); }} />}
      {dlg === 'bank' && aw && <BankDialog d={d} aw={aw} onClose={(ok) => { setDlg(null); if (ok) aktion(async () => ({ text: 'Bankverbindung gesichert.' })); }} />}
      {dlg === 'vertrag' && aw && <VertragDialog d={d} aw={aw} onClose={(t) => { setDlg(null); if (t) aktion(async () => ({ text: t })); }} />}
      {dlg === 'komm' && <KommDialog d={d} art={art} unterlagen={unterlagen} docs={docSel} edit={edit} onClose={(t) => { setDlg(null); if (t) aktion(async () => ({ text: t }), false); }} />}
    </div>
  );
}

// ---------------------------------------------------------------- Stammdaten
function Stammdaten({ d, edit, onEdit, onAktion }: { d: Detail; edit: boolean; onEdit: () => void; onAktion: (fn: () => Promise<{ text?: string } | void>) => void }) {
  const m = d.mitglied;
  const [austritt, setAustritt] = useState(m.austritt ?? '');
  useEffect(() => setAustritt(m.austritt ?? ''), [m.austritt]);
  const [frage, setFrage] = useState(false);
  return (
    <>
      <Toolbar design="Transparent">
        <Title level="H5">Kontakt</Title>
        <ToolbarSpacer />
        {edit && <Button icon="edit" onClick={onEdit}>Bearbeiten</Button>}
      </Toolbar>
      <Raster>
        <Feld label="Anrede">{t(m.anrede)}</Feld>
        <Feld label="Vorname">{t(m.vorname)}</Feld>
        <Feld label="Nachname">{t(m.nachname)}</Feld>
        <Feld label="Straße">{t(m.strasse)}</Feld>
        <Feld label="PLZ / Ort">{t(`${m.plz} ${m.ort}`.trim())}</Feld>
        <Feld label="Geburtsdatum">{t(dat(m.geburtsdatum))}</Feld>
        <Feld label="Telefon">{m.telefon ? <Link href={`tel:${m.telefon}`}>{m.telefon}</Link> : null}</Feld>
        <Feld label="Mobil">{m.mobil ? <Link href={`tel:${m.mobil}`}>{m.mobil}</Link> : null}</Feld>
        <Feld label="E-Mail">{m.email ? <Link href={`mailto:${m.email}`}>{m.email}</Link> : null}</Feld>
        <Feld label="Geschlecht">{t(m.geschlecht_txt)}</Feld>
        <Feld label="Datenverarbeitung">{t(m.datenschutz ? 'Ja' : 'Nein')}</Feld>
        <Feld label="Verwendung Bild/Name">{t(m.bildrechte ? 'Ja' : 'Nein')}</Feld>
      </Raster>
      <Toolbar design="Transparent"><Title level="H5">Mitgliedschaft</Title><ToolbarSpacer /></Toolbar>
      <Raster>
        <Feld label="Mitgliedsnummer">{t(m.mitglnrn)}</Feld>
        <Feld label="Eintritt">{t(dat(m.eintritt))}</Feld>
        <Feld label="Austritt">
          {edit ? (
            <FlexBox style={{ gap: '0.25rem' }}>
              <DatePicker style={{ width: '9.5rem' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={austritt} onChange={(e) => setAustritt(e.detail.value)} />
              <Button icon="save" design="Transparent" disabled={(austritt || null) === (m.austritt || null)} onClick={() => setFrage(true)}>Sichern</Button>
            </FlexBox>
          ) : <Text>{dat(m.austritt)}</Text>}
        </Feld>
        <Feld label="Trainer">
          <CheckBox checked={d.trainer} disabled={!edit} text="Trainer im Jugendtraining"
                    onChange={(e) => onAktion(() => api.post(`${MG}/m/${m.adrnr}/trainer`, { trainer: e.target.checked }))} />
        </Feld>
        <Feld label="Bevorzugter Versandweg">
          <Select style={{ width: '11rem' }} disabled={!edit} onChange={(e) => onAktion(() => api.post(`${MG}/m/${m.adrnr}/kanal`, { kanal: (e.detail.selectedOption as HTMLElement).dataset.k }))}>
            {[['', 'automatisch'], ['E', 'E-Mail'], ['W', 'WhatsApp']].map(([k, t]) => <Option key={k} data-k={k} selected={d.kanal === k}>{t}</Option>)}
          </Select>
        </Feld>
        <Feld label="EP3-Kundennummer">{t(d.zuid)}</Feld>
      </Raster>
      <ConfirmDialog open={frage} title={austritt ? 'Austritt sichern' : 'Austritt entfernen'}
                     text={austritt
                       ? `Austritt zum ${dat(austritt)} sichern? Das SEPA-Mandat gilt dann bis zu diesem Tag.`
                       : 'Austritt entfernen? Das SEPA-Mandat wird wieder aktiv und unbefristet.'}
                     confirmText="Sichern" onCancel={() => setFrage(false)}
                     onConfirm={() => { setFrage(false); onAktion(() => api.post(`${MG}/m/${m.adrnr}/austritt`, { austritt: austritt || null })); }} />
    </>
  );
}

// ---------------------------------------------------------------- SEPA
function SepaTabelle({ d, edit, onAktion }: { d: Detail; edit: boolean; onAktion: (fn: () => Promise<{ text?: string } | void>) => void }) {
  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Kontoinhaber', accessor: 'inhaber', minWidth: 140, Cell: ({ row, value }: Cell) => <Text>{value}{row.original.eigen ? '' : ' (Zahler)'}</Text> },
    { Header: 'Mandatsnummer', accessor: 'mandatsnr', minWidth: 120 },
    { Header: 'Art', accessor: 'typ', width: 120, responsiveMinWidth: 900 },
    { Header: 'Angelegt am', accessor: 'angelegtam', width: 110, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Gültig bis', accessor: 'gueltigbis', width: 110, Cell: ({ value }: Cell) => (value ? dat(value) : 'unbefristet') },
    {
      Header: 'Status', id: 'st', width: 150,
      Cell: ({ row }: Cell) => <ObjectStatus state={row.original.aktiv ? 'Positive' : 'Negative'}>
        {row.original.aktiv ? (row.original.manuell_aktiv ? 'Aktiv (manuell)' : 'Aktiv') : 'Inaktiv'}</ObjectStatus>,
    },
    ...(edit ? [{
      Header: '', id: 'akt', width: 190,
      Cell: ({ row }: Cell) => {
        const s = row.original;
        if (s.manuell_aktiv) return <Button design="Transparent" icon="undo" onClick={() => onAktion(() => api.post(`${MG}/sepa/${s.adrnr}/manuell`, { aktiv: false }))}>Manuell aufheben</Button>;
        if (!s.aktiv) return <Button design="Transparent" icon="activate" onClick={() => onAktion(() => api.post(`${MG}/sepa/${s.adrnr}/manuell`, { aktiv: true }))}>Manuell aktivieren</Button>;
        return '';
      },
    }] : []),
  ];
  return (
    <>
      <Toolbar design="Transparent"><Title level="H5">SEPA-Lastschriftmandate ({d.sepa.length})</Title><ToolbarSpacer /></Toolbar>
      <AnalyticalTable columns={columns} data={d.sepa} visibleRows={Math.max(d.sepa.length, 1)} minRows={1} noDataText="Kein SEPA-Mandat hinterlegt" />
      {d.sepa.some((s) => !s.aktiv && s.austritt) && (
        <MessageStrip hideCloseButton style={{ marginTop: '0.5rem' }}>
          Mandate ausgetretener Zahler enden mit dem Austritt. Zahlen Familienmitglieder weiter über dieses Konto, kann das Mandat manuell aktiviert werden.
        </MessageStrip>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Verträge
function Vertraege({ d, aw, edit, onNeu, onAktion }: {
  d: Detail; aw: Auswahl | null; edit: boolean; onNeu: () => void; onAktion: (fn: () => Promise<{ text?: string } | void>) => void;
}) {
  const [alle, setAlle] = useState(false);
  const rows = useMemo(() => d.vertraege.filter((v) => alle || v.laeuft), [d.vertraege, alle]);
  const mehrere = new Set(d.vertraege.map((v) => v.adrnr)).size > 1;
  const summe = rows.filter((v) => v.laeuft).reduce((s, v) => s + v.betrag, 0);
  const put = (v: Detail['vertraege'][number], body: object) => onAktion(() => api.put(`${MG}/vertraege/${v.adrnr}/${encodeURIComponent(v.vertragnr)}`, body));
  const columns: AnalyticalTableColumnDefinition[] = [
    ...(mehrere ? [{ Header: 'Für', accessor: 'person', minWidth: 120 }] : []),
    { Header: 'Nr.', accessor: 'vertragnr', width: 55 },
    { Header: 'Vertragsart', accessor: 'artname', minWidth: 130, Cell: ({ row, value }: Cell) => <Text>{`${row.original.art} – ${value}`}</Text> },
    { Header: 'Turnus', accessor: 'sollstellung', width: 115, responsiveMinWidth: 1100 },
    { Header: 'Beginn', accessor: 'vertragbegin', width: 100, Cell: ({ value }: Cell) => dat(value) },
    {
      Header: 'Ende', accessor: 'vertragende', width: edit ? 165 : 100,
      Cell: ({ row, value }: Cell) => (edit
        ? <DatePicker style={{ width: '9.5rem' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={value ?? ''} placeholder="unbefristet"
                      onChange={(e) => { if ((e.detail.value || null) !== (value || null)) put(row.original, { ende: e.detail.value || null }); }} />
        : <Text>{value ? dat(value) : 'unbefristet'}</Text>),
    },
    { Header: 'Betrag', accessor: 'betrag', width: 95, hAlign: 'End', Cell: ({ value }: Cell) => eur(value) },
    {
      Header: 'Zahler', accessor: 'zahler', minWidth: 150,
      Cell: ({ row }: Cell) => (edit && aw && row.original.laeuft
        ? (
          <Select style={{ width: '100%' }} onChange={(e) => put(row.original, { zahler: (e.detail.selectedOption as HTMLElement).dataset.z || null })}>
            <Option data-z="" selected={!row.original.zahler_adrnr}>{row.original.zahler_adrnr ? 'wie Mitglied' : row.original.zahler}</Option>
            {aw.vtZahler.filter((z) => z.adrnr !== row.original.adrnr).map((z) => <Option key={z.adrnr} data-z={z.adrnr} selected={z.adrnr === row.original.zahler_adrnr}>{z.text}</Option>)}
            {row.original.zahler_adrnr && !aw.vtZahler.some((z) => z.adrnr === row.original.zahler_adrnr) && <Option data-z={row.original.zahler_adrnr} selected>{row.original.zahler} (ohne aktives Mandat)</Option>}
          </Select>
        )
        : <Text>{row.original.zahler}</Text>),
    },
  ];
  return (
    <>
      <Toolbar design="Transparent">
        <Title level="H5">{alle ? 'Alle Verträge' : 'Laufende Verträge'} ({rows.length}) · {eur(summe)}</Title>
        <ToolbarSpacer />
        <CheckBox text="Auch beendete" checked={alle} onChange={(e) => setAlle(e.target.checked)} />
        {edit && <Button icon="add" design="Emphasized" onClick={onNeu}>Vertrag hinzufügen</Button>}
      </Toolbar>
      <AnalyticalTable columns={columns} data={rows} visibleRows={Math.max(rows.length, 1)} minRows={1} noDataText="Keine Verträge"
                       withRowHighlight highlightField={(r: Record<string, any>) => (r.laeuft ? 'Positive' : 'None')} />
      {mehrere && <MessageStrip hideCloseButton style={{ marginTop: '0.5rem' }}>Enthalten sind auch die Verträge der Familienmitglieder, die über dieses Mitglied zahlen.</MessageStrip>}
    </>
  );
}

// ---------------------------------------------------------------- Familie / Schlüssel / Notizen
function Familie({ d, onOpen }: { d: Detail; onOpen: (a: string) => void }) {
  const rows = d.familie.filter((p) => p.adrnr !== d.mitglied.adrnr);
  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Name', accessor: 'name', minWidth: 150, Cell: ({ row, value }: Cell) => <Link onClick={() => onOpen(row.original.adrnr)}>{value}</Link> },
    { Header: 'Mitgliedsnr.', accessor: 'mitglnrn', width: 110 },
    { Header: 'Geburtsdatum', accessor: 'geburtsdatum', width: 120, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Eintritt', accessor: 'eintritt', width: 105, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Austritt', accessor: 'austritt', width: 105, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Verknüpfung', accessor: 'rolle', minWidth: 160 },
  ];
  return (
    <>
      <Toolbar design="Transparent"><Title level="H5">Verknüpfte Personen ({rows.length})</Title><ToolbarSpacer /></Toolbar>
      <AnalyticalTable columns={columns} data={rows} visibleRows={Math.max(rows.length, 1)} minRows={1} noDataText="Keine verknüpften Personen" />
    </>
  );
}

function Schluessel({ d, edit, onAktion }: { d: Detail; edit: boolean; onAktion: (fn: () => Promise<{ text?: string } | void>) => void }) {
  const s = d.schluessel[0];
  const [v, setV] = useState({ ausgabe: s?.ausgabe ?? '', ausgabebeleg: s?.ausgabebeleg ?? '', ruecknahme: s?.ruecknahme ?? '', ruecknahmebeleg: s?.ruecknahmebeleg ?? '' });
  const geaendert = (v.ausgabe || null) !== (s?.ausgabe ?? null) || (v.ruecknahme || null) !== (s?.ruecknahme ?? null)
    || v.ausgabebeleg !== (s?.ausgabebeleg ?? '') || v.ruecknahmebeleg !== (s?.ruecknahmebeleg ?? '');
  return (
    <>
      <Toolbar design="Transparent">
        <Title level="H5">Hallenschlüssel</Title>
        {s && <ObjectStatus state={s.ausgabe && !s.ruecknahme ? 'Critical' : 'None'}>{s.ausgabe && !s.ruecknahme ? 'ausgegeben' : s.ruecknahme ? 'zurückgegeben' : ''}</ObjectStatus>}
        <ToolbarSpacer />
        {edit && <Button icon="save" disabled={!geaendert} onClick={() => onAktion(() => api.post(`${MG}/m/${d.mitglied.adrnr}/schluessel`, v))}>Sichern</Button>}
      </Toolbar>
      <Raster>
        <Feld label="Ausgabe am"><DatePicker style={{ width: '100%' }} readonly={!edit} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={v.ausgabe} onChange={(e) => setV({ ...v, ausgabe: e.detail.value })} /></Feld>
        <Feld label="Beleg Ausgabe"><InputText readonly={!edit} value={v.ausgabebeleg} onChange={(x) => setV({ ...v, ausgabebeleg: x })} /></Feld>
        <Feld label="Rückgabe am"><DatePicker style={{ width: '100%' }} readonly={!edit} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={v.ruecknahme} onChange={(e) => setV({ ...v, ruecknahme: e.detail.value })} /></Feld>
        <Feld label="Beleg Rückgabe"><InputText readonly={!edit} value={v.ruecknahmebeleg} onChange={(x) => setV({ ...v, ruecknahmebeleg: x })} /></Feld>
      </Raster>
    </>
  );
}

function InputText({ value, onChange, readonly }: { value: string; onChange: (v: string) => void; readonly?: boolean }) {
  return <Input readonly={readonly} value={value} onInput={(e) => onChange(e.target.value)} style={{ width: '100%' }} />;
}

function Notizen({ d, edit, onAktion }: { d: Detail; edit: boolean; onAktion: (fn: () => Promise<{ text?: string } | void>, liste?: boolean) => void }) {
  const [text, setText] = useState('');
  const [weg, setWeg] = useState<string | null>(null);
  return (
    <>
      {edit && (
        <FlexBox alignItems="End" style={{ gap: '0.5rem', margin: '0.5rem 0' }}>
          <TextArea rows={3} style={{ flex: 1 }} placeholder="Neue Notiz zum Mitglied" value={text} onInput={(e) => setText(e.target.value)} />
          <Button icon="add" design="Emphasized" disabled={!text.trim()}
                  onClick={() => { onAktion(() => api.post(`${MG}/m/${d.mitglied.adrnr}/notizen`, { text }), false); setText(''); }}>Notiz anlegen</Button>
        </FlexBox>
      )}
      {!d.notizen.length && <MessageStrip hideCloseButton>Keine Notizen vorhanden.</MessageStrip>}
      {d.notizen.map((n) => (
        <div key={n.notiz_id} style={{ borderBottom: '1px solid var(--sapList_BorderColor)', padding: '0.5rem 0' }}>
          <FlexBox alignItems="Center" style={{ gap: '0.5rem' }}>
            <Label>{new Date(n.erstellt_am).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })} · {n.erstellt_von}</Label>
            <div style={{ flex: 1 }} />
            {edit && <Button design="Transparent" icon="delete" onClick={() => setWeg(n.notiz_id)}>Löschen</Button>}
          </FlexBox>
          <Text style={{ whiteSpace: 'pre-wrap' }}>{n.notiz}</Text>
        </div>
      ))}
      <ConfirmDialog open={!!weg} title="Notiz löschen" text="Die Notiz wird gelöscht." confirmText="Löschen" danger onCancel={() => setWeg(null)}
                     onConfirm={() => { const id = weg; setWeg(null); onAktion(() => api.post(`${MG}/m/${d.mitglied.adrnr}/notizen/loeschen`, { id }), false); }} />
    </>
  );
}
