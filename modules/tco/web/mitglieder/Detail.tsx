import { useEffect, useState, type ReactNode } from 'react';
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
import { dat } from '../util';
import { MG, type Auswahl, type Detail, type Vertrag } from './typen';
import { BankDialog, KommDialog, KopfDialog, VertragDialog, vertragPersonen } from './Dialoge';
import { VertragsBaum } from './VertragsBaum';
import { Dokumente } from './Dokumente';
import { GruppenTab } from './GruppenTab';
import { VorgangDialog, type VorgangTyp } from './VorgangDialog';
import { MenuButton } from '@core/components/MenuButton';
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
  const [vtFuer, setVtFuer] = useState<string | undefined>();
  const [pdf, setPdf] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [docSel, setDocSel] = useState<number[]>([]);
  const [eingang, setEingang] = useState<File[]>([]);
  /** geführter Vorgang (#154) */
  const [vorgang, setVorgang] = useState<VorgangTyp | null>(null);
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
  /** Kategorie Schnuppertraining (#86): noch kein Mitglied */
  const schnuppert = !!d.schnupper && !m.eintritt && !['MITGLIED', 'ABGESAGT'].includes(d.schnupper.status);
  const unterlagen = aw?.unterlagen ?? {};

  const initialen = `${m.vorname?.[0] ?? ''}${m.nachname?.[0] ?? ''}`.toUpperCase() || undefined;
  return (
    <div>
      <ObjectHeader
        title={d.titel}
        initials={initialen}
        subtitle={[m.mitglnrn && `Mitglied Nr. ${m.mitglnrn}`, `Adressnummer ${Number(m.adrnr)}`, [m.strasse, `${m.plz} ${m.ort}`.trim()].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
        status={<>
          <ObjectStatus state={m.aktiv ? 'Positive' : ausgetreten ? 'Negative' : schnuppert ? 'Information' : 'Critical'} inverted>
            {m.aktiv ? 'Aktiv' : ausgetreten ? `Austritt ${dat(m.austritt)}` : m.mitglnrn ? 'Ohne Eintritt'
              : schnuppert ? 'Schnuppertraining' : d.schnupper?.status === 'ABGESAGT' ? 'Schnuppern abgesagt' : 'Zahler'}
          </ObjectStatus>
          {d.trainer && <ObjectStatus state="Information" inverted>Trainer</ObjectStatus>}
          {d.zuid && <ObjectStatus state="Information">EP3-Kunde {d.zuid}</ObjectStatus>}
          {m.eintritt && <span className="portal-muted portal-small">Eintritt {dat(m.eintritt)}</span>}
        </>}
        actions={<>
          {edit && (
            <MenuButton text="Vorgang" icon="process" design="Emphasized" items={[
              { text: 'Beitragswechsel', icon: 'switch-classes', hidden: !d.vertraege.some((v) => v.eigen && v.laeuft), onClick: () => setVorgang('BEITRAGSWECHSEL') },
              { text: 'Jugendtraining abschließen', icon: 'physical-activity', hidden: ausgetreten, onClick: () => setVorgang('JUGENDTRAINING') },
              { text: 'Kündigung erfassen', icon: 'cancel', hidden: !d.vertraege.some((v) => v.eigen && v.laeuft && !v.vertragende) && !(m.eintritt && !ausgetreten), onClick: () => setVorgang('KUENDIGUNG') },
            ]} />
          )}
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
        <Tab data-key="vt" text={`Verträge (${d.vertraegeFamilie.filter((v) => v.laeuft).length})`} selected={tab === 'vt'}>
          <Vertraege d={d} aw={aw} edit={edit} onNeu={(a) => { setVtFuer(a); setDlg('vertrag'); }} onOpen={onOpen} onAktion={aktion} />
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
      {dlg === 'vertrag' && aw && <VertragDialog d={d} aw={aw} adrnr={vtFuer} onClose={(t) => { setDlg(null); if (t) aktion(async () => ({ text: t })); }} />}
      {vorgang && (
        <VorgangDialog adrnr={adrnr} typ={vorgang} onClose={(geaendert) => {
          setVorgang(null);
          if (geaendert) { laden(); onChanged(); }
        }} />
      )}
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
        {d.spieler?.id_nr && <Feld label="ID-Nr. (nuLiga)">{t(d.spieler.id_nr)}</Feld>}
        {d.spieler?.lk != null && <Feld label="Leistungsklasse">{t(`LK ${d.spieler.lk.toFixed(1).replace('.', ',')}${d.spieler.lk_stand ? ` (Stand ${dat(d.spieler.lk_stand)})` : ''}`)}</Feld>}
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
      {d.schnupper && <SchnupperAngaben s={d.schnupper} />}
      <ConfirmDialog open={frage} title={austritt ? 'Austritt sichern' : 'Austritt entfernen'}
                     text={austritt
                       ? `Austritt zum ${dat(austritt)} sichern? Das SEPA-Mandat gilt dann bis zu diesem Tag.`
                       : 'Austritt entfernen? Das SEPA-Mandat wird wieder aktiv und unbefristet.'}
                     confirmText="Sichern" onCancel={() => setFrage(false)}
                     onConfirm={() => { setFrage(false); onAktion(() => api.post(`${MG}/m/${m.adrnr}/austritt`, { austritt: austritt || null })); }} />
    </>
  );
}

// ---------------------------------------------------------------- Schnuppertraining (#86)
const SCHNUPPER_STATUS: Record<string, string> = {
  NEU: 'Neu', KONTAKTIERT: 'Kontaktiert', TERMIN: 'Termin vereinbart', ABSOLVIERT: 'Schnuppern absolviert', MITGLIED: 'Mitglied geworden', ABGESAGT: 'Abgesagt',
};
const SCHNUPPER_STUFE: Record<string, string> = { NEU: 'Neu (noch nie gespielt)', ANFAENGER: 'Anfänger', FORTGESCHRITTEN: 'Fortgeschritten' };
function SchnupperAngaben({ s }: { s: NonNullable<Detail['schnupper']> }) {
  const termine = [[...(s.termine.tage ?? []), ...(s.termine.zeiten ?? [])].join(', '), s.termine.text].filter(Boolean).join(' · ');
  return (
    <>
      <Toolbar design="Transparent"><Title level="H5">Schnuppertraining {s.nummer}</Title><ToolbarSpacer /></Toolbar>
      <Raster>
        <Feld label="Status">{t(SCHNUPPER_STATUS[s.status] ?? s.status)}</Feld>
        <Feld label="Angemeldet am">{t(s.eingang ? new Date(s.eingang).toLocaleDateString('de-DE') : '')}</Feld>
        <Feld label="Alter bei Anmeldung">{t(s.alter != null ? `${s.alter} Jahre` : '')}</Feld>
        <Feld label="Schon Tennis gespielt">{t(s.gespielt ? 'Ja' : 'Nein')}</Feld>
        <Feld label="Spielstärke">{t(SCHNUPPER_STUFE[s.stufe] ?? s.stufe)}</Feld>
        <Feld label="Mögliche Termine">{t(termine)}</Feld>
        <Feld label="Erziehungsberechtigt">{t(s.erziehungsberechtigt)}</Feld>
        <Feld label="1. / 2. Einheit">{t([dat(s.einheit1), dat(s.einheit2)].filter(Boolean).join(' / '))}</Feld>
        <Feld label="Trainer">{t(s.trainer)}</Feld>
        <Feld label="Mitteilung">{t(s.mitteilung)}</Feld>
        <Feld label="Notiz Trainer">{t(s.notiz)}</Feld>
        <Feld label="Mitgliedsantrag">{t(s.antrag)}</Feld>
      </Raster>
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

// ---------------------------------------------------------------- Verträge (Baum mit allen verknüpften Personen)
function Vertraege({ d, aw, edit, onNeu, onOpen, onAktion }: {
  d: Detail; aw: Auswahl | null; edit: boolean; onNeu: (adrnr?: string) => void; onOpen: (a: string) => void;
  onAktion: (fn: () => Promise<{ text?: string } | void>) => void;
}) {
  // Ändern nur für Verträge, die zu diesem Mitglied gehören (eigene und von Personen, die über das Mitglied zahlen) –
  // Verträge anderer verknüpfter Personen pflegt man auf deren Seite (Name anklicken)
  const eigen = new Set(d.vertraege.map((v) => `${v.adrnr}:${v.vertragnr}`));
  const aenderbar = (v: Vertrag) => edit && eigen.has(`${v.adrnr}:${v.vertragnr}`);
  const anlegbar = new Set(vertragPersonen(d).map((p) => p.adrnr));
  const put = (v: Vertrag, body: object) => onAktion(() => api.put(`${MG}/vertraege/${v.adrnr}/${encodeURIComponent(v.vertragnr)}`, body));
  return (
    <>
      <VertragsBaum personen={d.familie} vertraege={d.vertraegeFamilie} ich={d.mitglied.adrnr} onPerson={onOpen}
                    aktionen={edit ? <Button icon="add" design="Emphasized" onClick={() => onNeu()}>Vertrag hinzufügen</Button> : undefined}
                    // Vertragsbeginn (#33): für die Mitgliederpflege immer änderbar – alle Verträge im Baum, auch beendete
                    beginnZelle={edit ? (v) => (
                      <DatePicker style={{ width: '9.5rem' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={v.vertragbegin ?? ''}
                                  onChange={(e) => { if (e.detail.valid && e.detail.value && e.detail.value !== v.vertragbegin) put(v, { beginn: e.detail.value }); }} />
                    ) : undefined}
                    endeZelle={(v) => (aenderbar(v)
                      ? <DatePicker style={{ width: '9.5rem' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={v.vertragende ?? ''} placeholder="unbefristet"
                                    onChange={(e) => { if ((e.detail.value || null) !== (v.vertragende || null)) put(v, { ende: e.detail.value || null }); }} />
                      : null)}
                    zahlerZelle={(v) => (aenderbar(v) && aw && v.laeuft
                      ? (
                        <Select style={{ width: '100%' }} onChange={(e) => put(v, { zahler: (e.detail.selectedOption as HTMLElement).dataset.z || null })}>
                          <Option data-z="" selected={!v.zahler_adrnr}>{v.zahler_adrnr ? 'wie Mitglied' : v.zahler}</Option>
                          {aw.vtZahler.filter((z) => z.adrnr !== v.adrnr).map((z) => <Option key={z.adrnr} data-z={z.adrnr} selected={z.adrnr === v.zahler_adrnr}>{z.text}</Option>)}
                          {v.zahler_adrnr && !aw.vtZahler.some((z) => z.adrnr === v.zahler_adrnr) && <Option data-z={v.zahler_adrnr} selected>{v.zahler} (ohne aktives Mandat)</Option>}
                        </Select>
                      )
                      : null)}
                    personAktion={edit ? (p) => (anlegbar.has(p.adrnr)
                      ? <Button icon="add-document" design="Transparent" tooltip={`Vertrag für ${p.name} hinzufügen`} onClick={() => onNeu(p.adrnr)} />
                      : <Button icon="action" design="Transparent" tooltip={`${p.name} öffnen – Verträge dort pflegen`} onClick={() => onOpen(p.adrnr)} />) : undefined}
                    aktionenBreite={80} />
      {d.familie.length > 1 && (
        <MessageStrip hideCloseButton style={{ marginTop: '0.5rem' }}>
          Der Baum zeigt alle verknüpften Personen mit ihren Verträgen: Zahler oben, darunter wer über ihn zahlt. Ändern lassen sich hier die Verträge
          dieses Mitglieds und der Personen, die über dieses Mitglied zahlen; die übrigen auf der Seite der jeweiligen Person.
        </MessageStrip>
      )}
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
