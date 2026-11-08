import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AnalyticalTable, Bar, Button, DatePicker, Dialog, FlexBox, Input, Label, MessageStrip, ObjectStatus, Option, Panel, Select, Switch, Text, Title,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { FieldBox, FormGrid, TextField } from '@core/components/FormFields';
import { Attribute, Attributes } from '@core/components/Attributes';
import { betrag as betragFmt, dat, eur } from '../util';
import { BT, type Detail, type Preis } from './typen';
import { SperrHinweis, useSperre } from '@core/sperre';

/** Betrag für das Eingabefeld: Zahl → deutsche Schreibweise, Text bleibt wie eingegeben */
const txt = (v: number | string) => (typeof v === 'number' ? betragFmt(v) : v);

/**
 * Beitrag bearbeiten / neu anlegen (POPUP_DISPLAY der SAP-App): Stammdaten, Beträge je Zeitraum
 * (lückenlos, letzter offen), neuer Betrag ab Datum, Verträge zur Beitragsart.
 */
export function BeitragDialog({ art, edit: darf, onClose }: { art: string | null; edit: boolean; onClose: (text?: string, warnung?: string | null) => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [preise, setPreise] = useState<Preis[]>([]);
  const [neuAb, setNeuAb] = useState('');
  const [neuBetrag, setNeuBetrag] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // bestehende Beitragsart während der Bearbeitung sperren (Neuanlage ohne Sperre)
  const sperre = useSperre('BEITRAG', art, darf, { bezeichnung: `Beitragsart ${art ?? ''}` });
  const edit = darf && sperre.eigen;

  useEffect(() => {
    api.get<Detail>(art === null ? `${BT}/neu` : `${BT}/${encodeURIComponent(art)}`)
      .then((x) => { setD(x); setPreise(x.preise); setNeuAb(x.neu_ab); })
      .catch((e) => setError(e.message));
  }, [art]);

  const set = (k: keyof Detail) => (v: string | boolean) => setD((x) => (x ? { ...x, [k]: v } : x));

  /** Zeiträume serverseitig bearbeiten (Logik aus ZCL_TCO_BEITRAG), Beträge aus den Eingabefeldern gehen mit */
  async function zeitraum(aktion: 'einfuegen' | 'entfernen', ab: string) {
    if (!d) return;
    setError(null);
    setBusy(true);
    try {
      const r = await api.post<{ preise: Preis[]; fehler: string }>(`${BT}/zeitraum`, {
        art: d.art, preise: preise.map((p) => ({ gueltig_ab: p.gueltig_ab, gueltig_bis: p.gueltig_bis, betrag: p.betrag })),
        aktion, ab, betrag: aktion === 'einfuegen' ? neuBetrag : undefined,
      });
      setPreise(r.preise);
      if (aktion === 'einfuegen') setNeuBetrag('');
      if (r.fehler) setError(r.fehler);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function sichern() {
    if (!d) return;
    setError(null);
    setBusy(true);
    try {
      const r = await api.post<{ text: string; warnung: string | null }>(BT, {
        neu: d.neu, art: d.art, bezeichnung: d.bezeichnung, turnus: d.turnus, konto: d.konto, aktiv: d.aktiv,
        preise: preise.map((p) => ({ gueltig_ab: p.gueltig_ab, gueltig_bis: p.gueltig_bis, betrag: p.betrag })),
        neu_betrag: neuBetrag,
      });
      onClose(r.text, r.warnung);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  const prCols: AnalyticalTableColumnDefinition[] = [
    { Header: 'gültig ab', accessor: 'ab_txt', width: 110 },
    { Header: 'gültig bis', accessor: 'bis_txt', width: 110 },
    {
      Header: 'Betrag (€)', accessor: 'betrag', width: 140, hAlign: 'End',
      Cell: ({ row }: Cell) => (edit
        ? <Input value={txt(row.original.betrag)} style={{ width: '110px', textAlign: 'end' }}
                 onInput={(e) => setPreise((l) => l.map((p) => (p.gueltig_ab === row.original.gueltig_ab ? { ...p, betrag: e.target.value } : p)))} />
        : <Text>{typeof row.original.betrag === 'number' ? eur(row.original.betrag) : row.original.betrag}</Text>),
    },
    { Header: '', accessor: 'info', minWidth: 120, Cell: ({ row }: Cell) => <ObjectStatus state={row.original.state}>{row.original.info}</ObjectStatus> },
    {
      Header: '', id: 'del', width: 60, disableSortBy: true,
      Cell: ({ row }: Cell) => (edit && row.original.loeschbar
        ? <Button icon="delete" design="Transparent" tooltip="Zeitraum entfernen" disabled={busy} onClick={() => zeitraum('entfernen', row.original.gueltig_ab)} />
        : null),
    },
  ];
  const vtCols: AnalyticalTableColumnDefinition[] = [
    { Header: 'Mitglied', accessor: 'name', minWidth: 180, Cell: ({ row }: Cell) => <div style={{ lineHeight: 1.3 }}><Text>{row.original.name}</Text><br /><Label>Nr. {row.original.mitglnr || '–'} · Vertrag {row.original.vertragnr}</Label></div> },
    { Header: 'Beginn', accessor: 'vertragbegin', width: 100, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Ende', accessor: 'vertragende', width: 100, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Turnus', accessor: 'sollstellung', width: 110 },
    { Header: 'Betrag heute', accessor: 'betrag_heute', width: 120, hAlign: 'End', Cell: ({ row }: Cell) => <Text>{eur(row.original.betrag_heute)}{row.original.betrag_indiv ? ' · individuell' : ''}</Text> },
    { Header: 'Status', accessor: 'laeuft', width: 110, Cell: ({ value }: Cell) => <ObjectStatus state={value ? 'Positive' : 'None'}>{value ? 'laufend' : 'beendet'}</ObjectStatus> },
  ];

  const titel = !d ? 'Beitrag' : d.neu ? 'Neuer Beitrag' : `Beitrag ${d.art} – ${d.bezeichnung}`;
  return createPortal(
    <Dialog open headerText={titel} onClose={() => onClose()} resizable style={{ width: 'min(860px, 95vw)' }}
            footer={<Bar startContent={d && !d.neu ? <ChangeHistoryButton objectType="BEITRAG" objectKey={d.art} /> : undefined}
                         endContent={<>
                           {edit && <Button design="Emphasized" disabled={!d || busy} onClick={sichern}>Sichern</Button>}
                           <Button onClick={() => onClose()}>{edit ? 'Abbrechen' : 'Schließen'}</Button>
                         </>} />}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.75rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      <SperrHinweis s={sperre} />
      {!d ? <Text>Lade …</Text> : (
        <>
          <FormGrid>
            {d.neu
              ? <TextField label="Art (Nummer)" required value={d.art} onChange={set('art')} />
              : <FieldBox label="Art (Nummer)"><Text>{d.art}</Text></FieldBox>}
            <TextField label="Bezeichnung" required value={d.bezeichnung} onChange={set('bezeichnung')} readonly={!edit} />
            <FieldBox label="Turnus" required>
              <Select style={{ width: '100%' }} disabled={!edit} onChange={(e) => set('turnus')((e.detail.selectedOption as HTMLElement).dataset.k ?? '')}>
                {d.turnusse.map((t) => <Option key={t.key} data-k={t.key} selected={t.key === d.turnus}>{t.text}</Option>)}
              </Select>
            </FieldBox>
            <FieldBox label="Erlöskonto" required>
              <Select style={{ width: '100%' }} disabled={!edit} onChange={(e) => set('konto')((e.detail.selectedOption as HTMLElement).dataset.k ?? '')}>
                {d.konten.map((k) => <Option key={k.key} data-k={k.key} selected={k.key === d.konto}>{k.text}</Option>)}
              </Select>
            </FieldBox>
            <FieldBox label="Aktiv">
              <FlexBox alignItems="Center" style={{ gap: '0.5rem' }}>
                <Switch checked={d.aktiv} disabled={!edit} onChange={(e) => set('aktiv')(e.target.checked)} />
                <Label>{d.aktiv ? 'Ja' : 'Nein'}</Label>
              </FlexBox>
            </FieldBox>
            {!d.neu && <FieldBox label="Verträge"><Text>{d.vertraege_txt}</Text></FieldBox>}
          </FormGrid>

          <Title level="H5" style={{ margin: '1rem 0 0.25rem' }}>Beträge je Zeitraum</Title>
          {preise.length > 0 && (
            <AnalyticalTable minRows={1} columns={prCols} data={preise} visibleRows={Math.min(preise.length, 8)} rowHeight={44}
                             withRowHighlight highlightField={(r: Record<string, any>) => r.state} />
          )}
          {edit && (
            <FlexBox alignItems="End" wrap="Wrap" style={{ gap: '0.5rem', marginTop: '0.75rem' }}>
              <FieldBox label={preise.length ? 'Neuer Betrag gültig ab' : 'Erster Betrag gültig ab'}>
                <DatePicker style={{ width: '10rem' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={neuAb} onChange={(e) => setNeuAb(e.detail.value)} />
              </FieldBox>
              <FieldBox label="Betrag">
                <Input style={{ width: '10rem', textAlign: 'end' }} placeholder="Betrag, z. B. 65,00" value={neuBetrag} onInput={(e) => setNeuBetrag(e.target.value)} />
              </FieldBox>
              <Button icon="add" disabled={busy || !neuBetrag.trim()} onClick={() => zeitraum('einfuegen', neuAb)}>Übernehmen</Button>
            </FlexBox>
          )}
          <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>
            Der neue Betrag gilt ab dem gewählten Datum. Der bisherige Zeitraum endet automatisch am Vortag.
            Beim Löschen eines Zeitraums verlängert sich der vorherige, so bleiben die Zeiträume lückenlos.
          </Text>

          {!d.neu && (
            <Panel collapsed headerText={`Verträge zur Beitragsart (${d.vertraege.filter((v) => v.laeuft).length} laufend, ${d.vertraege.length} gesamt)`} style={{ marginTop: '1rem' }}>
              <AnalyticalTable minRows={1} columns={vtCols} data={d.vertraege} visibleRows={Math.min(Math.max(d.vertraege.length, 1), 8)} rowHeight={44}
                               noDataText="Keine Verträge zu dieser Beitragsart" sortable
                               withRowHighlight highlightField={(r: Record<string, any>) => (r.laeuft ? 'Positive' : 'None')} />
              <Attributes narrow>
                <Attribute label="Angelegt">{d.ernam ? `${d.ernam} · ${dat(d.erdat)}` : ''}</Attribute>
                <Attribute label="Geändert">{d.aenam ? `${d.aenam} · ${dat(d.aedat)}` : ''}</Attribute>
              </Attributes>
            </Panel>
          )}
        </>
      )}
    </Dialog>,
    document.body,
  );
}
