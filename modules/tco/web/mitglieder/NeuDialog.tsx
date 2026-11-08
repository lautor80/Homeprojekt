import { useEffect, useState } from 'react';
import {
  AnalyticalTable, Button, CheckBox, DatePicker, FileUploader, FlexBox, Input, Label, MessageStrip, SegmentedButton, SegmentedButtonItem, Text, Title,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { FieldBox, FormGrid, TextField } from '@core/components/FormFields';
import { PdfDialog } from '@core/components/PdfDialog';
import { dateiLesen } from '../util';
import { MG, type Auswahl } from './typen';
import { Auswahlfeld, Datum, Dlg } from './Dialoge';

const heute = () => new Date().toLocaleDateString('sv-SE');

/** wie vertragsbeginn() im Server: Mitgliedschaft zum Halbjahr, Jugendtraining (90) zum Monatsersten */
function beginn(eintritt: string, art: string): string {
  if (!eintritt) return '';
  const j = Number(eintritt.slice(0, 4)), m = Number(eintritt.slice(5, 7));
  if (art === '90') return eintritt.slice(8) === '01' ? eintritt : m === 12 ? `${j + 1}-01-01` : `${j}-${String(m + 1).padStart(2, '0')}-01`;
  if (['01-01', '07-01'].includes(eintritt.slice(5))) return eintritt;
  return m <= 6 ? `${j}-07-01` : `${j + 1}-01-01`;
}

interface Vt { sel: boolean; art: string; name: string; betrag: string; turnus: string; beginn: string }
interface AntragAntwort {
  docid: number; titel: string; existiert: boolean; hinweise: string[]; eintritt: string; sepa_datum: string; vart: string[];
  antrag: { nachname: string; vorname: string; geburtsdatum: string | null; strasse: string; plz: string; ort: string; telefon: string; mobil: string;
    email: string; iban: string; bic: string; bank: string; datenschutz: boolean; bildrechte: boolean; sepa: boolean };
  zahler: { modus: 'SELBST' | 'BESTEHEND' | 'NEU'; adrnr: string; vorname: string; nachname: string; kandidaten: string[] };
}

const LEER = {
  anrede: 'Herr', vorname: '', nachname: '', strasse: '', plz: '', ort: '', telefon: '', mobil: '', email: '', geburtsdatum: '',
  eintritt: heute(), datenschutz: true, bildrechte: true, zahlungsart: 'L', zahlungsweise: 'monatlich', iban: '', bic: '', bank: '',
  sepa: true, sepa_datum: heute(), zahler_modus: 'SELBST' as 'SELBST' | 'BESTEHEND' | 'NEU', zahler_adrnr: '',
  z_anrede: 'Herr', z_vorname: '', z_nachname: '', z_strasse: '', z_plz: '', z_ort: '', z_email: '',
};

export function NeuDialog({ onClose }: { onClose: (adrnr: string | null, text?: string) => void }) {
  const [aw, setAw] = useState<Auswahl | null>(null);
  const [v, setV] = useState(LEER);
  const [vt, setVt] = useState<Vt[]>([]);
  const [docid, setDocid] = useState('');
  const [antrag, setAntrag] = useState<{ docid: number; info: string; existiert: boolean; kandidaten: string[] } | null>(null);
  const [hinweis, setHinweis] = useState('');
  const [sepaPdf, setSepaPdf] = useState(true);
  const [fertig, setFertig] = useState<{ adrnr: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.get<Auswahl>(`${MG}/auswahl`).then((a) => { setAw(a); setVt(vtAufbauen(a, LEER.eintritt, [])); }).catch((e) => setError(e.message)); }, []);
  const vtAufbauen = (a: Auswahl, ein: string, sel: string[]) => a.arten.map((x) => ({
    sel: sel.includes(x.art), art: x.art, name: x.name, betrag: String(x.betrag).replace('.', ','), turnus: x.turnus, beginn: beginn(ein, x.art),
  }));
  const f = (k: keyof typeof LEER) => (x: string) => setV((o) => ({ ...o, [k]: x }));
  const eintritt = (x: string) => { setV((o) => ({ ...o, eintritt: x })); setVt((l) => l.map((r) => ({ ...r, beginn: beginn(x, r.art) }))); };

  async function zahlerWaehlen(a: string) {
    setV((o) => ({ ...o, zahler_adrnr: a }));
    setHinweis('');
    if (!a) return;
    const r = await api.get<{ iban: string; bic: string; bank: string; hinweis: string }>(`${MG}/neu/zahler/${a}`);
    if (r.iban) setV((o) => ({ ...o, iban: r.iban, bic: r.bic, bank: r.bank }));
    setHinweis(r.hinweis);
  }

  async function antragLaden(body: object) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<AntragAntwort>(`${MG}/neu/antrag`, body);
      const a = r.antrag;
      setV((o) => ({
        ...o, vorname: a.vorname, nachname: a.nachname, geburtsdatum: a.geburtsdatum ?? '', strasse: a.strasse, plz: a.plz, ort: a.ort, telefon: a.telefon,
        mobil: a.mobil, email: a.email, iban: a.iban, bic: a.bic, bank: a.bank, datenschutz: a.datenschutz, bildrechte: a.bildrechte, sepa: a.sepa,
        eintritt: r.eintritt, sepa_datum: r.sepa_datum, zahler_modus: r.zahler.modus, zahler_adrnr: r.zahler.adrnr,
        z_vorname: r.zahler.modus === 'NEU' ? r.zahler.vorname : '', z_nachname: r.zahler.modus === 'NEU' ? r.zahler.nachname : '',
      }));
      if (aw) setVt(vtAufbauen(aw, r.eintritt, r.vart));
      setDocid(String(r.docid));
      setAntrag({ docid: r.docid, existiert: r.existiert, kandidaten: r.zahler.kandidaten, info: [`Antrag ${r.docid} (${r.titel}) geladen.`, ...r.hinweise].join(' ') });
      if (r.zahler.adrnr) zahlerWaehlen(r.zahler.adrnr).catch(() => undefined);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function sichern() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ adrnr: string; text: string; mandat: string; warnungen: string[] }>(`${MG}/neu`, {
        ...v, geburtsdatum: v.geburtsdatum || null, sepa_datum: v.sepa_datum || null, zahler_adrnr: v.zahler_adrnr || null,
        antrag_docid: antrag?.docid ?? null,
        vertraege: vt.filter((x) => x.sel).map((x) => ({ art: x.art, beginn: x.beginn || null, betrag: Number(x.betrag.replace(',', '.')), turnus: x.turnus })),
      });
      const text = [r.text, ...r.warnungen].join(' ');
      if (sepaPdf && r.mandat) setFertig({ adrnr: r.adrnr, text });
      else onClose(r.adrnr, text);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const setRow = (i: number, p: Partial<Vt>) => setVt((l) => l.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: '', id: 'sel', width: 50, Cell: ({ row }: Cell) => <CheckBox checked={row.original.sel} onChange={(e) => setRow(row.index, { sel: e.target.checked })} /> },
    { Header: 'Vertragsart', accessor: 'name', minWidth: 160, Cell: ({ row, value }: Cell) => `${row.original.art} – ${value}` },
    { Header: 'Turnus', accessor: 'turnus', width: 120 },
    { Header: 'Beginn', accessor: 'beginn', width: 175, Cell: ({ row }: Cell) => <DatePicker style={{ width: '100%' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={row.original.beginn} onChange={(e) => setRow(row.index, { beginn: e.detail.value })} /> },
    { Header: 'Betrag', accessor: 'betrag', width: 110, Cell: ({ row }: Cell) => <Input style={{ width: '100%' }} value={row.original.betrag} onInput={(e) => setRow(row.index, { betrag: e.target.value })} /> },
  ];
  const ls = v.zahlungsart === 'L';
  const zahlerOpt: [string, string][] = aw ? [
    ['', '– bitte wählen –'],
    ...aw.zahler.filter((z) => antrag?.kandidaten.includes(z.adrnr)).map((z) => [z.adrnr, `★ ${z.text}`] as [string, string]),
    ...aw.zahler.filter((z) => !antrag?.kandidaten.includes(z.adrnr)).map((z) => [z.adrnr, z.text] as [string, string]),
  ] : [];
  const sperre = !!antrag?.existiert;

  if (fertig) {
    return <PdfDialog url={`${MG}/m/${fertig.adrnr}/unterlage/5`} title="SEPA-Lastschriftmandat zur Unterschrift" filename="SEPA-Lastschriftmandat.pdf"
                      onClose={() => onClose(fertig.adrnr, fertig.text)} />;
  }
  return (
    <Dlg titel="Neues Mitglied" breite="min(1000px, 96vw)" onClose={() => onClose(null)}
         fuss={<Button design="Emphasized" disabled={busy || sperre || !vt.some((x) => x.sel) || !v.vorname.trim() || !v.nachname.trim()} onClick={sichern}>Anlegen</Button>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.75rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      {aw?.paperless && (
        <FlexBox alignItems="End" wrap="Wrap" style={{ gap: '0.5rem', marginBottom: '0.75rem' }}>
          <FieldBox label="Aufnahmeantrag aus Paperless (Dok-Nr.)">
            <Input style={{ width: '10rem' }} value={docid} onInput={(e) => setDocid(e.target.value.replace(/\D/g, ''))}
                   onKeyDown={(e) => e.key === 'Enter' && docid && antragLaden({ docid: Number(docid) })} />
          </FieldBox>
          <Button disabled={!docid || busy} onClick={() => antragLaden({ docid: Number(docid) })}>Antrag laden</Button>
          <FileUploader hideInput accept="application/pdf" onChange={async (e) => {
            const file = e.detail.files?.[0];
            if (file) antragLaden({ datei: file.name, inhalt: await dateiLesen(file) });
          }}><Button icon="upload" disabled={busy}>Antrag-PDF hochladen</Button></FileUploader>
        </FlexBox>
      )}
      {antrag && <MessageStrip design={sperre ? 'Negative' : 'Information'} hideCloseButton style={{ marginBottom: '0.75rem' }}>{antrag.info}</MessageStrip>}

      <Title level="H5">Person</Title>
      <FormGrid>
        <Auswahlfeld label="Anrede" required value={v.anrede} optionen={[['Herr', 'Herr'], ['Frau', 'Frau']]} onChange={f('anrede')} />
        <TextField label="Vorname" required value={v.vorname} onChange={f('vorname')} />
        <TextField label="Nachname" required value={v.nachname} onChange={f('nachname')} />
        <Datum label="Geburtsdatum" value={v.geburtsdatum} onChange={f('geburtsdatum')} />
        <TextField label="Straße" value={v.strasse} onChange={f('strasse')} wide />
        <TextField label="PLZ" value={v.plz} onChange={f('plz')} />
        <TextField label="Ort" value={v.ort} onChange={f('ort')} />
        <TextField label="Telefon" type="Tel" value={v.telefon} onChange={f('telefon')} />
        <TextField label="Mobil" type="Tel" value={v.mobil} onChange={f('mobil')} />
        <TextField label="E-Mail" type="Email" value={v.email} onChange={f('email')} />
        <Datum label="Eintritt" required value={v.eintritt} onChange={eintritt} />
        <FieldBox label="Einwilligungen" wide>
          <FlexBox style={{ gap: '1rem' }}>
            <CheckBox text="Datenverarbeitung" checked={v.datenschutz} onChange={(e) => setV({ ...v, datenschutz: e.target.checked })} />
            <CheckBox text="Verwendung Bild/Name" checked={v.bildrechte} onChange={(e) => setV({ ...v, bildrechte: e.target.checked })} />
          </FlexBox>
        </FieldBox>
      </FormGrid>

      <Title level="H5" style={{ marginTop: '1rem' }}>Zahlung</Title>
      <FormGrid>
        <Auswahlfeld label="Zahlungsart" required value={v.zahlungsart} optionen={Object.entries(aw?.zahlungsarten ?? { L: 'Lastschrift' })} onChange={f('zahlungsart')} />
        <Auswahlfeld label="Zahlungsweise" value={v.zahlungsweise} optionen={Object.entries(aw?.zahlungsweisen ?? {})} onChange={f('zahlungsweise')} />
        {ls && (
          <FieldBox label="Kontoinhaber" wide>
            <SegmentedButton onSelectionChange={(e) => { const m = (e.detail.selectedItems[0] as HTMLElement).dataset.m as typeof v.zahler_modus; setV({ ...v, zahler_modus: m }); setHinweis(''); }}>
              <SegmentedButtonItem data-m="SELBST" selected={v.zahler_modus === 'SELBST'}>Mitglied selbst</SegmentedButtonItem>
              <SegmentedButtonItem data-m="BESTEHEND" selected={v.zahler_modus === 'BESTEHEND'}>Bestehender Zahler</SegmentedButtonItem>
              <SegmentedButtonItem data-m="NEU" selected={v.zahler_modus === 'NEU'}>Neuer Zahler</SegmentedButtonItem>
            </SegmentedButton>
          </FieldBox>
        )}
        {ls && v.zahler_modus === 'BESTEHEND' && <Auswahlfeld label="Zahler" required wide value={v.zahler_adrnr} optionen={zahlerOpt} onChange={(x) => zahlerWaehlen(x).catch((e) => setError(e.message))} />}
        {ls && v.zahler_modus === 'NEU' && (<>
          <Auswahlfeld label="Anrede Zahler" value={v.z_anrede} optionen={[['Herr', 'Herr'], ['Frau', 'Frau']]} onChange={f('z_anrede')} />
          <TextField label="E-Mail Zahler" value={v.z_email} onChange={f('z_email')} />
          <TextField label="Vorname Zahler" required value={v.z_vorname} onChange={f('z_vorname')} />
          <TextField label="Nachname Zahler" required value={v.z_nachname} onChange={f('z_nachname')} />
          <TextField label="Straße Zahler (leer = wie Mitglied)" value={v.z_strasse} onChange={f('z_strasse')} wide />
          <TextField label="PLZ Zahler" value={v.z_plz} onChange={f('z_plz')} />
          <TextField label="Ort Zahler" value={v.z_ort} onChange={f('z_ort')} />
        </>)}
        {ls && (v.iban.includes('•')
          ? (
            <FieldBox label="IBAN (übernommen, maskiert)">
              <FlexBox alignItems="Center" style={{ gap: '0.5rem' }}>
                <Text title="Die vollständige IBAN wird beim Anlegen serverseitig aus dem Zahler bzw. Aufnahmeantrag übernommen.">{v.iban}</Text>
                <Button design="Transparent" icon="edit" onClick={() => setV((o) => ({ ...o, iban: '', bic: '' }))}>Andere IBAN eingeben</Button>
              </FlexBox>
            </FieldBox>
          )
          : <TextField label="IBAN" required value={v.iban} onChange={f('iban')} />)}
        {ls && <TextField label="BIC" value={v.bic} onChange={f('bic')} readonly={v.bic.includes('•')} />}
        {ls && <TextField label="Kreditinstitut" value={v.bank} onChange={f('bank')} />}
        {ls && <Datum label="Datum SEPA-Mandat" value={v.sepa_datum} onChange={f('sepa_datum')} />}
        {ls && (
          <FieldBox label="SEPA" wide>
            <FlexBox style={{ gap: '1rem' }}>
              <CheckBox text="SEPA-Mandat anlegen" checked={v.sepa} onChange={(e) => setV({ ...v, sepa: e.target.checked })} />
              <CheckBox text="Mandat danach zur Unterschrift anzeigen" checked={sepaPdf} disabled={!v.sepa} onChange={(e) => setSepaPdf(e.target.checked)} />
            </FlexBox>
          </FieldBox>
        )}
      </FormGrid>
      {hinweis && <MessageStrip hideCloseButton style={{ marginTop: '0.5rem' }}>{hinweis}</MessageStrip>}

      <FlexBox alignItems="Center" style={{ gap: '0.5rem', marginTop: '1rem' }}>
        <Title level="H5">Verträge</Title>
        <Label>({vt.filter((x) => x.sel).length} ausgewählt)</Label>
      </FlexBox>
      <AnalyticalTable columns={columns} data={vt} visibleRows={Math.max(vt.length, 1)} minRows={1} rowHeight={44} noDataText="Keine Vertragsarten vorhanden" />
    </Dlg>
  );
}
