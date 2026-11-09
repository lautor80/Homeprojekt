import { useEffect, useMemo, useState } from 'react';
import {
  Bar, Button, BusyIndicator, CheckBox, DatePicker, Dialog, Input, Label, MessageStrip, ObjectStatus, Option, Select, Text,
} from '@ui5/webcomponents-react';
import { useNavigate } from 'react-router-dom';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { Section } from '@core/components/Section';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { TCO, dat, eur } from '../util';

/**
 * Produkte pflegen (Einstellungen → Produkte): alle Produkte mit Preisen je Zeitraum, Gästepreis und Erlöskonto.
 * Hallenprodukte (000–099) haben Zeitfenster – deren Zeiträume werden weiter in den Hallenpreisen gepflegt.
 */
const P = `${TCO}/produkte`;
type Bereich = 'HALLE' | 'GETRAENK' | 'SPEISE' | 'SONSTIGES' | 'ANDERE';
interface Zeile {
  prod_key: string; bereich: Bereich; valid_from: string; valid_to: string; text: string; preis: number | null; preis_gast: number | null;
  typ: string | null; menge: string | null; erloeskonto: string | null; aktuell: boolean; zukunft: boolean;
}
interface Daten { produkte: Zeile[]; konten: { konto: string; name: string }[]; bereiche: { key: Bereich; text: string; von: number; bis: number }[] }
interface Form { text: string; preis: string; preis_gast: string; erloeskonto: string; menge: string; ab: string }
type Modus = { art: 'aendern' | 'preis' | 'beenden'; z: Zeile } | { art: 'neu'; bereich: Bereich };

const zelle = { padding: '0.3rem 0.5rem', verticalAlign: 'middle' } as const;
const kopf = { ...zelle, textAlign: 'left', whiteSpace: 'nowrap', borderBottom: '1px solid var(--sapList_BorderColor)' } as const;
const heute = () => new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10);
const zahl = (s: string) => (s.trim() === '' ? null : Number(s.replace(/\./g, '').replace(',', '.')));
const zahlText = (v: number | null) => (v == null ? '' : String(v).replace('.', ','));

export function Produkte() {
  const can = useCan();
  const edit = can('tco.produkte:edit');
  const navigate = useNavigate();
  const [d, setD] = useState<Daten | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bereich, setBereich] = useState<string>('');
  const [suche, setSuche] = useState('');
  const [nurAktuell, setNurAktuell] = useState(true);
  const [modus, setModus] = useState<Modus | null>(null);
  const [f, setF] = useState<Form>({ text: '', preis: '', preis_gast: '', erloeskonto: '', menge: '', ab: heute() });
  const [busy, setBusy] = useState(false);

  const laden = () => api.get<Daten>(P).then(setD).catch((e) => setError(e.message));
  useEffect(() => { laden(); }, []);

  const bereichText = (b: Bereich) => d?.bereiche.find((x) => x.key === b)?.text ?? b;
  const kontoText = (k: string | null) => (k ? `${k} ${d?.konten.find((x) => x.konto === k)?.name ?? ''}`.trim() : 'Standard');
  const liste = useMemo(() => (d?.produkte ?? []).filter((z) =>
    (!bereich || z.bereich === bereich)
    && (!nurAktuell || z.aktuell || z.zukunft)
    && (!suche || `${z.prod_key} ${z.text}`.toLowerCase().includes(suche.toLowerCase()))), [d, bereich, suche, nurAktuell]);

  function oeffnen(m: Modus) {
    const z = m.art === 'neu' ? null : m.z;
    setF({
      text: z?.text ?? '', preis: zahlText(z?.preis ?? null), preis_gast: zahlText(z?.preis_gast ?? null),
      erloeskonto: z?.erloeskonto ?? '', menge: z?.menge ?? '', ab: heute(),
    });
    setModus(m);
  }

  async function speichern() {
    if (!modus) return;
    setBusy(true); setError(null);
    const body = { text: f.text, preis: zahl(f.preis), preis_gast: zahl(f.preis_gast), erloeskonto: f.erloeskonto || null, menge: f.menge || null };
    try {
      let r: { text: string };
      if (modus.art === 'neu') r = await api.post(P, { ...body, bereich: modus.bereich, ab: f.ab });
      else if (modus.art === 'aendern') r = await api.put(`${P}/${modus.z.prod_key}/${modus.z.valid_from}`, body);
      else if (modus.art === 'preis') r = await api.post(`${P}/${modus.z.prod_key}/preis`, { ...body, ab: f.ab });
      else r = await api.post(`${P}/${modus.z.prod_key}/beenden`, { ab: f.ab });
      toast(r.text, 5000);
      setModus(null);
      await laden();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const status = (z: Zeile) => (z.aktuell ? <ObjectStatus state="Positive">gültig</ObjectStatus>
    : z.zukunft ? <ObjectStatus state="Information">ab {dat(z.valid_from)}</ObjectStatus> : <ObjectStatus state="None">abgelaufen</ObjectStatus>);
  const titel = !modus ? '' : modus.art === 'neu' ? `Neues Produkt – ${bereichText(modus.bereich)}`
    : modus.art === 'aendern' ? `Produkt ${modus.z.prod_key} ändern (Zeitraum ab ${dat(modus.z.valid_from)})`
      : modus.art === 'preis' ? `Neuer Preis für ${modus.z.prod_key} ${modus.z.text}` : `Produkt ${modus.z.prod_key} ${modus.z.text} beenden`;
  const halle = !!modus && modus.art !== 'neu' && modus.z.bereich === 'HALLE';

  return (
    <AppPage title="Produkte" subtitle="Produkte, Preise je Zeitraum und Erlöskonten"
             actions={<>
               {can('tco.halle:preise') && <Button icon="lead" design="Transparent" onClick={() => navigate('/tco/hallenpreise')}>Hallenpreise (Zeitfenster)</Button>}
               {edit && (
                 <Select key={modus ? 'offen' : 'zu'} style={{ width: '14rem' }} onChange={(e) => {
                   const b = (e.detail.selectedOption as HTMLElement).dataset.b as Bereich | undefined;
                   if (b) oeffnen({ art: 'neu', bereich: b });
                 }}>
                   <Option data-b="" selected>+ Produkt anlegen …</Option>
                   {(d?.bereiche ?? []).filter((b) => b.key !== 'HALLE').map((b) => <Option key={b.key} data-b={b.key}>{b.text}</Option>)}
                 </Select>
               )}
             </>}>
      {error && !modus && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {!d ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : (
        <Section title="Produkte" count={liste.length} flush status={
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <Select style={{ width: '12rem' }} onChange={(e) => setBereich((e.detail.selectedOption as HTMLElement).dataset.b ?? '')}>
              <Option data-b="" selected={!bereich}>alle Bereiche</Option>
              {d.bereiche.map((b) => <Option key={b.key} data-b={b.key} selected={bereich === b.key}>{b.text}</Option>)}
            </Select>
            <Input placeholder="Suchen" value={suche} onInput={(e) => setSuche(e.target.value)} style={{ width: '12rem' }} />
            <CheckBox text="nur gültige und künftige" checked={nurAktuell} onChange={(e) => setNurAktuell(e.target.checked)} />
          </div>
        }>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr>{['Schlüssel', 'Bereich', 'Bezeichnung', 'Gültig ab', 'Gültig bis', 'Preis', 'Gästepreis', 'Erlöskonto', 'Status', ''].map((h) =>
                <th key={h} style={kopf}><Label>{h}</Label></th>)}</tr></thead>
              <tbody>
                {liste.map((z) => (
                  <tr key={`${z.prod_key}|${z.valid_from}`} style={{ borderTop: '1px solid var(--sapList_BorderColor)' }}>
                    <td style={zelle}><Text>{z.prod_key}</Text></td>
                    <td style={zelle}><Text>{bereichText(z.bereich)}</Text></td>
                    <td style={zelle}><Text>{z.text}</Text></td>
                    <td style={zelle}><Text>{dat(z.valid_from)}</Text></td>
                    <td style={zelle}><Text>{z.valid_to === '9999-12-31' ? 'unbegrenzt' : dat(z.valid_to)}</Text></td>
                    <td style={{ ...zelle, textAlign: 'right' }}><Text>{z.preis == null ? '–' : eur(z.preis)}</Text></td>
                    <td style={{ ...zelle, textAlign: 'right' }}><Text>{z.preis_gast == null ? '–' : eur(z.preis_gast)}</Text></td>
                    <td style={zelle}><Text>{kontoText(z.erloeskonto)}</Text></td>
                    <td style={zelle}>{status(z)}</td>
                    <td style={{ ...zelle, whiteSpace: 'nowrap' }}>
                      {edit && <Button design="Transparent" icon="edit" tooltip="Zeitraum ändern" onClick={() => oeffnen({ art: 'aendern', z })} />}
                      {edit && z.bereich !== 'HALLE' && (z.aktuell || z.zukunft) && <>
                        <Button design="Transparent" icon="lead" tooltip="Neuer Preis ab Stichtag" onClick={() => oeffnen({ art: 'preis', z })} />
                        <Button design="Transparent" icon="decline" tooltip="Produkt beenden" onClick={() => oeffnen({ art: 'beenden', z })} />
                      </>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
      {modus && (
        <Dialog open headerText={titel} style={{ width: 'min(34rem, 96vw)' }} onClose={() => setModus(null)}
                footer={<Bar endContent={<>
                  <Button design="Emphasized" disabled={busy} onClick={speichern}>{modus.art === 'beenden' ? 'Beenden' : 'Speichern'}</Button>
                  <Button design="Transparent" onClick={() => setModus(null)}>Abbrechen</Button>
                </>} />}>
          {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
          <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.5rem 1rem', alignItems: 'center' }}>
            {modus.art !== 'aendern' && <>
              <Label required>{modus.art === 'beenden' ? 'Nicht mehr gültig ab' : 'Gültig ab'}</Label>
              <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.ab} onChange={(e) => setF({ ...f, ab: e.detail.value })} />
            </>}
            {modus.art !== 'beenden' && <>
              <Label required>Bezeichnung</Label>
              <Input value={f.text} maxlength={60} onInput={(e) => setF({ ...f, text: e.target.value })} />
              <Label>Preis (EUR)</Label>
              <Input value={f.preis} onInput={(e) => setF({ ...f, preis: e.target.value })} style={{ width: '8rem' }} />
              {(modus.art === 'neu' ? modus.bereich : modus.z.bereich) !== 'HALLE' && <>
                <Label>Gästepreis (EUR)</Label>
                <Input value={f.preis_gast} placeholder="wie Mitglieder" onInput={(e) => setF({ ...f, preis_gast: e.target.value })} style={{ width: '8rem' }} />
              </>}
              {(modus.art === 'neu' ? modus.bereich : modus.z.bereich) === 'GETRAENK' && <>
                <Label>Menge (Liter)</Label>
                <Input value={f.menge} onInput={(e) => setF({ ...f, menge: e.target.value })} style={{ width: '8rem' }} />
              </>}
              <Label>Erlöskonto</Label>
              <Select onChange={(e) => setF({ ...f, erloeskonto: (e.detail.selectedOption as HTMLElement).dataset.k ?? '' })}>
                <Option data-k="" selected={!f.erloeskonto}>Standard{halle || (modus.art === 'neu' && modus.bereich === 'HALLE') ? ' (8003 Hallenmiete)' : ''}</Option>
                {(d?.konten ?? []).map((k) => <Option key={k.konto} data-k={k.konto} selected={f.erloeskonto === k.konto}>{k.konto} {k.name}</Option>)}
              </Select>
            </>}
          </div>
          <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.75rem' }}>
            {modus.art === 'aendern' ? 'Ändert diesen Zeitraum ohne neue Gültigkeit. Das Erlöskonto gilt für alle Zeiträume des Produkts.'
              : modus.art === 'preis' ? 'Der laufende Zeitraum endet am Vortag, ab dem Stichtag gilt der neue Preis.'
                : modus.art === 'beenden' ? 'Das Produkt gilt bis zum Vortag; spätere Zeiträume entfallen.'
                  : 'Der Schlüssel wird im Bereich automatisch vergeben.'}
            {halle ? ' Zeitfenster und neue Zeiträume von Hallenprodukten: Hallenpreise.' : ''}
          </Text>
        </Dialog>
      )}
    </AppPage>
  );
}
