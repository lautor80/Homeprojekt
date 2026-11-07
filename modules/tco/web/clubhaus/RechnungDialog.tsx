import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AnalyticalTable, Bar, Button, CheckBox, DatePicker, Dialog, FlexBox, Input, Label, Link, MessageStrip, Option, Panel, Select, Text,
  TextArea, Title, Toolbar, ToolbarSpacer,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { PdfDialog } from '@core/components/PdfDialog';
import { toast } from '@core/toast';
import { dat, eur } from '../util';
import { CH } from './Clubhaus';

interface Pos { produkt: string; anzahl: number; ekpreis: number; ekpreis_vor: number; pospreis: number; brutto: number }
interface Beleg { doknr: string; titel: string; belegdatum: string | null; betrag: number; zuord_art: string; erdat: string | null }
interface Kandidat { doknr: string; titel: string; created: string | null; betrag: number; tage: number }

const PFAND = 'PFANDRÜCKGABE';
const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const ART: Record<string, string> = { A: 'Auftragsnummer', B: 'Betrag/Datum', I: 'Dokument-ID', M: 'manuell' };

/** wie rechnen() im Server: Pfandrückgabe negativ und ohne MwSt., ohne Anzahl kein Preis */
function rechnen(p: Pos): Pos {
  if (!(p.anzahl > 0)) return { ...p, anzahl: 0, ekpreis: 0, ekpreis_vor: p.ekpreis ? Math.abs(p.ekpreis) : p.ekpreis_vor, pospreis: 0, brutto: 0 };
  let ek = p.ekpreis || p.ekpreis_vor;
  if (p.produkt === PFAND && ek > 0) ek = -ek;
  const pos = p.anzahl * ek;
  return { ...p, ekpreis: ek, ekpreis_vor: p.ekpreis_vor || Math.abs(ek), pospreis: r2(pos), brutto: r2(p.produkt === PFAND ? pos : pos * 1.19) };
}
const heute = () => new Date().toLocaleDateString('sv-SE');

function ZahlFeld({ wert, onSave, width = '6rem', disabled }: { wert: number; onSave: (v: number) => void; width?: string; disabled?: boolean }) {
  const t = (n: number) => (n ? String(n).replace('.', ',') : '');
  const [v, setV] = useState(t(wert));
  useEffect(() => setV(t(wert)), [wert]);
  const save = () => { const n = v.trim() ? Number(v.replace(',', '.')) : 0; if (Number.isFinite(n) && n !== wert) onSave(n); else setV(t(wert)); };
  return <Input value={v} disabled={disabled} style={{ width }} onInput={(e) => setV(e.target.value)} onChange={save} onKeyDown={(e) => e.key === 'Enter' && save()} />;
}

export function RechnungDialog({ rgnr, jahr, edit, paperless, onClose }: { rgnr: string | null; jahr: number; edit: boolean; paperless: boolean; onClose: (geaendert: boolean) => void }) {
  const [nr, setNr] = useState(rgnr ?? '');
  const [datum, setDatum] = useState(jahr === new Date().getFullYear() ? heute() : `${jahr}-01-01`);
  const [pos, setPos] = useState<Pos[]>([]);
  const [belege, setBelege] = useState<Beleg[]>([]);
  const [alle, setAlle] = useState(!rgnr);
  const [text, setText] = useState('');
  const [imp, setImp] = useState<{ info: string; warn: string } | null>(null);
  const [kand, setKand] = useState<Kandidat[] | null>(null);
  const [kandSel, setKandSel] = useState('');
  const [plId, setPlId] = useState('');
  const [vorschau, setVorschau] = useState<string | null>(null);
  const [weg, setWeg] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [geaendert, setGeaendert] = useState(false);
  const [plUrl, setPlUrl] = useState<string | null>(null);

  const laden = async (n = rgnr) => {
    const r = await api.get<{ rgnr: string; datum: string | null; pos: Pos[]; belege: Beleg[]; plUrl: string | null }>(`${CH}/rechnung${n ? `?rgnr=${encodeURIComponent(n)}` : ''}`);
    setPos(r.pos); setBelege(r.belege); setPlUrl(r.plUrl);
    if (r.datum) setDatum(r.datum);
  };
  useEffect(() => { laden().catch((e) => setError(e.message)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const kandidatenLaden = () => api.get<{ kandidaten: Kandidat[]; offline: boolean }>(`${CH}/belege/kandidaten?jahr=${datum.slice(0, 4)}&datum=${datum}`)
    .then((r) => { setKand(r.kandidaten); if (r.offline) setError('Paperless ist nicht erreichbar – Belege können nicht ermittelt werden.'); }).catch((e) => setError(e.message));
  useEffect(() => { if (paperless && rgnr) kandidatenLaden(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const brutto = r2(pos.reduce((s, p) => s + p.brutto, 0));
  const belegSumme = r2(belege.reduce((s, b) => s + b.betrag, 0));
  const setzen = (produkt: string, k: 'anzahl' | 'ekpreis', v: number) => setPos(pos.map((p) => (p.produkt === produkt ? rechnen({ ...p, [k]: v }) : p)));
  const sichtbar = alle ? pos : pos.filter((p) => p.anzahl > 0);

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true); setError(null);
    try { return await fn(); } catch (e) { setError((e as Error).message); return undefined; } finally { setBusy(false); }
  }
  async function uebernehmen() {
    const r = await run(() => api.post<{ pos: Pos[]; kopf: { rgnr: string; datum: string }; info: string; warn: string }>(`${CH}/belegtext`, { text, pos, rgnr: nr, datum }));
    if (!r) return;
    setPos(r.pos); setImp({ info: r.info, warn: r.warn }); setAlle(true);
    if (r.kopf.rgnr) setNr(r.kopf.rgnr);
    if (r.kopf.datum) setDatum(r.kopf.datum);
  }
  async function speichern() {
    const r = await run(() => api.post<{ text: string }>(`${CH}/rechnung`, { rgnrAlt: rgnr, rgnr: nr, datum, pos: pos.filter((p) => p.anzahl > 0) }));
    if (r) { toast(r.text, 5000); onClose(true); }
  }
  async function zuordnen(art: 'AUTO' | 'M' | 'I', doknr?: string) {
    if (!rgnr) { setError('Bitte die Rechnung zuerst speichern.'); return; }
    const r = await run(() => api.post<{ text: string; json: string | null }>(`${CH}/belege/zuordnen`, { rgnr, art, doknr, datum, brutto, jahr: Number(datum.slice(0, 4)) }));
    if (!r) return;
    toast(r.text); setGeaendert(true); setPlId(''); setKandSel('');
    if (r.json && !text.trim()) { setText(r.json); toast('JSON aus dem Beleg ins Importfeld übernommen – mit „Positionen übernehmen“ einlesen.', 6000); }
    await laden(); await kandidatenLaden();
  }

  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Produkt', accessor: 'produkt', minWidth: 220 },
    { Header: 'Anzahl', accessor: 'anzahl', width: 100, hAlign: 'End', Cell: ({ row }: Cell) => <ZahlFeld wert={row.original.anzahl} width="5rem" disabled={!edit} onSave={(v) => setzen(row.original.produkt, 'anzahl', Math.round(v))} /> },
    { Header: 'EK-Preis (netto)', accessor: 'ekpreis', width: 140, hAlign: 'End',
      Cell: ({ row }: Cell) => <ZahlFeld wert={row.original.anzahl ? row.original.ekpreis : 0} disabled={!edit} onSave={(v) => setzen(row.original.produkt, 'ekpreis', v)} /> },
    { Header: 'Vorschlag', accessor: 'ekpreis_vor', width: 100, hAlign: 'End', Cell: ({ value }: Cell) => (value ? <Label>{eur(value)}</Label> : '') },
    { Header: 'Positionspreis', accessor: 'pospreis', width: 130, hAlign: 'End', Cell: ({ row }: Cell) => (row.original.anzahl ? eur(row.original.pospreis) : '') },
    { Header: 'Brutto', accessor: 'brutto', width: 120, hAlign: 'End', Cell: ({ row }: Cell) => (row.original.anzahl ? <b>{eur(row.original.brutto)}</b> : '') },
  ];
  const belegCols: AnalyticalTableColumnDefinition[] = [
    { Header: 'Dokument', accessor: 'doknr', width: 100, Cell: ({ value }: Cell) => <Link onClick={() => setVorschau(value)}>{value}</Link> },
    { Header: 'Titel', accessor: 'titel', minWidth: 180 },
    { Header: 'Belegdatum', accessor: 'belegdatum', width: 110, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Betrag', accessor: 'betrag', width: 110, hAlign: 'End', Cell: ({ value }: Cell) => eur(value) },
    { Header: 'Zuordnung', accessor: 'zuord_art', width: 190, Cell: ({ row }: Cell) => `${ART[row.original.zuord_art] ?? 'manuell'}, ${dat(row.original.erdat)}` },
    { Header: '', id: 'akt', width: 200, disableSortBy: true, Cell: ({ row }: Cell) => (
      <FlexBox alignItems="Center" style={{ gap: '0.25rem' }}>
        {plUrl && <Link href={`${plUrl}/documents/${row.original.doknr}/details`} target="_blank">Paperless</Link>}
        {edit && <Button design="Transparent" icon="decline" onClick={async () => {
          const r = await run(() => api.post<{ text: string }>(`${CH}/belege/loesen`, { rgnr, doknr: row.original.doknr }));
          if (r) { toast(r.text); setGeaendert(true); await laden(); await kandidatenLaden(); }
        }}>Lösen</Button>}
      </FlexBox>
    ) },
  ];

  return createPortal(
    <Dialog open headerText={rgnr ? `Getränkerechnung ${rgnr}` : 'Neue Getränkerechnung'} onClose={() => onClose(geaendert)} resizable
            style={{ width: 'min(70rem, 96vw)' }}
            footer={<Bar endContent={<>
              {edit && rgnr && <Button design="Negative" icon="delete" onClick={() => setWeg(true)}>Löschen</Button>}
              {edit && <Button design="Emphasized" icon="save" loading={busy} onClick={speichern}>Speichern</Button>}
              <Button onClick={() => onClose(geaendert)}>{edit ? 'Abbrechen' : 'Schließen'}</Button>
            </>} />}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {edit && (
        <Panel headerText="Belegdaten importieren (JSON aus Paperless oder OCR-Text)" collapsed={!!rgnr} style={{ marginBottom: '0.5rem' }}>
          <TextArea value={text} rows={5} style={{ width: '100%' }} placeholder='JSON aus dem Paperless-Feld "JSON" oder den OCR-Text der Rechnung hier einfügen …'
                    onInput={(e) => setText(e.target.value)} />
          <FlexBox alignItems="Center" style={{ gap: '0.5rem', marginTop: '0.25rem' }}>
            <Button icon="paste" disabled={!text.trim()} onClick={uebernehmen}>Positionen übernehmen</Button>
          </FlexBox>
          {imp?.info && <MessageStrip hideCloseButton style={{ marginTop: '0.25rem' }}>{imp.info}</MessageStrip>}
          {imp?.warn && <MessageStrip design="Critical" hideCloseButton style={{ marginTop: '0.25rem' }}>{imp.warn}</MessageStrip>}
        </Panel>
      )}
      <FlexBox wrap="Wrap" alignItems="End" style={{ gap: '1.5rem', marginBottom: '0.5rem' }}>
        <FlexBox direction="Column"><Label required>Rechnungsnummer</Label>
          <Input value={nr} readonly={!edit} style={{ width: '14rem' }} onInput={(e) => setNr(e.target.value)} />
        </FlexBox>
        <FlexBox direction="Column"><Label required>Rechnungsdatum</Label>
          <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={datum} readonly={!edit} style={{ width: '10rem' }} onChange={(e) => setDatum(e.detail.value)} />
        </FlexBox>
        <CheckBox text="Alle Produkte anzeigen" checked={alle} onChange={(e) => setAlle(e.target.checked)} />
      </FlexBox>
      <Toolbar design="Transparent">
        <Title level="H5">Positionen</Title>
        <ToolbarSpacer />
        <Text style={{ fontWeight: 'bold' }}>Summe Brutto: {eur(brutto)}</Text>
      </Toolbar>
      <AnalyticalTable columns={columns} data={sichtbar} visibleRows={Math.max(sichtbar.length, 2)} noDataText="Keine Positionen – „Alle Produkte anzeigen“ wählen" />

      {paperless && (
        <Panel headerText={`Paperless-Belege${belege.length ? ` (${belege.length})` : ''}`} style={{ marginTop: '0.75rem' }}>
          {!rgnr && <MessageStrip hideCloseButton>Belege können zugeordnet werden, sobald die Rechnung gespeichert ist.</MessageStrip>}
          {rgnr && belege.length > 0 && (
            <MessageStrip design={Math.abs(belegSumme - brutto) <= 0.05 ? 'Positive' : 'Critical'} hideCloseButton style={{ marginBottom: '0.5rem' }}>
              {belege.length} Beleg(e) zugeordnet – Summe {eur(belegSumme)}, Rechnung {eur(brutto)}
              {Math.abs(belegSumme - brutto) > 0.05 ? ` – Abweichung ${eur(r2(belegSumme - brutto))}` : ''}
            </MessageStrip>
          )}
          {rgnr && belege.length > 0 && <AnalyticalTable columns={belegCols} data={belege} visibleRows={belege.length} />}
          {rgnr && edit && (
            <FlexBox wrap="Wrap" alignItems="Center" style={{ gap: '0.5rem', marginTop: '0.5rem' }}>
              <Button icon="search" onClick={() => zuordnen('AUTO')}>Beleg ermitteln</Button>
              <Select style={{ width: '28rem' }} onChange={(e) => setKandSel((e.detail.selectedOption as HTMLElement).dataset.k ?? '')}>
                <Option data-k="" selected={!kandSel}>{kand === null ? 'Belege werden geladen …' : kand.length ? 'Beleg aus der FI-Zuordnung wählen …' : 'Keine freien Belege in der Nähe des Rechnungsdatums'}</Option>
                {(kand ?? []).map((k) => <Option key={k.doknr} data-k={k.doknr} selected={k.doknr === kandSel}>{`${k.doknr} – ${k.titel} – ${dat(k.created)} – ${eur(k.betrag)}`}</Option>)}
              </Select>
              <Button icon="chain-link" disabled={!kandSel} onClick={() => zuordnen('M', kandSel)}>Hinzufügen</Button>
              <Input value={plId} placeholder="Paperless-Dokument-ID" style={{ width: '11rem' }} onInput={(e) => setPlId(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && plId && zuordnen('I', plId)} />
              <Button icon="add" disabled={!plId.trim()} onClick={() => zuordnen('I', plId)}>Per ID zuordnen</Button>
            </FlexBox>
          )}
        </Panel>
      )}
      <PdfDialog url={vorschau ? `${CH}/belege/${vorschau}/pdf` : null} title={`Paperless-Dokument ${vorschau}`} filename={`Beleg_${vorschau}.pdf`} onClose={() => setVorschau(null)} />
      <ConfirmDialog open={weg} danger title={`Rechnung ${rgnr} löschen`} text={`Getränkerechnung ${rgnr} mit allen Positionen und Belegzuordnungen löschen? Die Forderungsliste wird nachgerechnet.`}
                     confirmText="Löschen" onCancel={() => setWeg(false)}
                     onConfirm={async () => { setWeg(false); const r = await run(() => api.post<{ text: string }>(`${CH}/rechnung/loeschen`, { rgnr })); if (r) { toast(r.text); onClose(true); } }} />
    </Dialog>,
    document.body,
  );
}
