import { useEffect, useState } from 'react';
import {
  Bar, Button, CheckBox, FlexBox, Input, MessageStrip, Panel, Tab, TabContainer, Text, TextArea,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { FieldBox, FormGrid, TextField } from '@core/components/FormFields';
import { toast } from '@core/toast';
import { SperrHinweis, useSperre } from '@core/sperre';
import { T, type Werte } from './util';
import { AblageFlaeche } from '@core/ablage';

interface Firma {
  name: string; strasse: string; plz: string; ort: string; land: string; ustid: string; steuernr: string; kontakt: string;
  telefon: string; fax: string; email: string; bank: string; iban: string; bic: string;
  zahlungsziel_tage: number; ust_satz: number; rechnung_startnr: number; logo: string | null;
  paperless?: boolean;
}
interface Produkt { prod_key: string; text: string; preis: number; gueltig_bis: string | null; sort: number }
interface MailText { art: 'T' | 'L' | 'R'; sprache: 'D' | 'E'; text: string }

const WERTE_TITEL: Record<keyof Werte, string> = {
  FAHRZEUGTYP: 'Fahrzeugtypen', LADEGUT: 'Ladegut', LADEWEISE: 'Ladeweisen', PALETTENTAUSCH: 'Palettentausch',
};
const ART_TITEL = { T: 'Transportauftrag', L: 'Lieferschein', R: 'Rechnung' };

function FirmaTab() {
  const [f, setF] = useState<Firma | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sperre = useSperre('FIRMA', '1', true, { bezeichnung: 'Firmendaten Transport' });
  useEffect(() => { api.get<Firma>(`${T}/firma`).then(setF).catch((e) => setError(e.message)); }, []);
  if (!f) return error ? <MessageStrip design="Negative">{error}</MessageStrip> : null;
  const s = (k: keyof Firma) => (v: string) => setF({ ...f, [k]: v });

  async function logo(files: FileList | File[] | null) {
    const file = files?.[0];
    if (!file) return;
    if (file.size > 400_000) return setError('Logo ist zu groß (max. 400 KB).');
    const r = new FileReader();
    r.onload = () => setF({ ...f!, logo: String(r.result) });
    r.readAsDataURL(file);
  }
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.put(`${T}/firma`, f);
      toast('Firmendaten gesichert');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <SperrHinweis s={sperre} />
      {error && <MessageStrip design="Negative" style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}
      <Panel headerText="Rechnungssteller" fixed>
        <FormGrid>
          <TextField label="Name" required value={f.name} onChange={s('name')} />
          <TextField label="Ansprechpartner" value={f.kontakt} onChange={s('kontakt')} />
          <TextField label="Straße" value={f.strasse} onChange={s('strasse')} />
          <FieldBox label="PLZ / Ort">
            <FlexBox style={{ gap: '0.5rem' }}>
              <Input style={{ width: '4rem' }} value={f.land} onInput={(e) => s('land')(e.target.value.toUpperCase())} />
              <Input style={{ width: '6rem' }} value={f.plz} onInput={(e) => s('plz')(e.target.value)} />
              <Input style={{ flex: 1 }} value={f.ort} onInput={(e) => s('ort')(e.target.value)} />
            </FlexBox>
          </FieldBox>
          <TextField label="Telefon" value={f.telefon} onChange={s('telefon')} />
          <TextField label="Fax" value={f.fax} onChange={s('fax')} />
          <TextField label="E-Mail (Pflicht für E-Rechnung)" type="Email" value={f.email} onChange={s('email')} />
          <TextField label="USt-IdNr." value={f.ustid} onChange={s('ustid')} />
          <TextField label="Steuernummer (nur für nicht steuerbare Leistungen)" value={f.steuernr} onChange={s('steuernr')} />
        </FormGrid>
      </Panel>
      <Panel headerText="Bank und Rechnung" fixed style={{ marginTop: '1rem' }}>
        <FormGrid>
          <TextField label="Bank" value={f.bank} onChange={s('bank')} />
          <TextField label="IBAN" value={f.iban} onChange={s('iban')} />
          <TextField label="BIC" value={f.bic} onChange={s('bic')} />
          <TextField label="Zahlungsziel (Tage)" type="Number" value={String(f.zahlungsziel_tage)} onChange={(v) => setF({ ...f, zahlungsziel_tage: Number(v) })} />
          <TextField label="USt-Satz (%)" type="Number" value={String(f.ust_satz)} onChange={(v) => setF({ ...f, ust_satz: Number(v) })} />
          <TextField label="Erste Rechnungsnummer je Jahr" type="Number" value={String(f.rechnung_startnr)} onChange={(v) => setF({ ...f, rechnung_startnr: Number(v) })} />
          <FieldBox label="Logo für Ausdrucke (PNG/JPEG, Seitenverhältnis ca. 6:1)" wide>
            <FlexBox alignItems="Center" style={{ gap: '1rem' }}>
              {f.logo && <img src={f.logo} alt="Logo" style={{ maxHeight: 48, maxWidth: 300 }} />}
              <div style={{ flex: 1, maxWidth: '28rem' }}>
                <AblageFlaeche ziel={{ titel: 'Logo für Ausdrucke', annehmen: (fs) => { logo(fs); } }} accept="image/png,image/jpeg" multiple={false}
                               groesse="Dot" titel="Logo hier ablegen" text="PNG oder JPEG hierher ziehen oder klicken zum Auswählen" />
              </div>
              {f.logo && <Button design="Transparent" icon="delete" onClick={() => setF({ ...f, logo: null })}>Entfernen</Button>}
            </FlexBox>
          </FieldBox>
        </FormGrid>
      </Panel>
      <MessageStrip design="Information" hideCloseButton style={{ marginTop: '1rem' }}>
        Paperless-ngx {f.paperless ? 'ist eingerichtet' : 'ist nicht eingerichtet'} – Adresse und API-Token werden zentral unter Administration → Anbindungen gepflegt.
      </MessageStrip>
      <Bar style={{ marginTop: '1rem' }} endContent={<>
        <ChangeHistoryButton objectType="FIRMA" objectKey="1" />
        <Button design="Emphasized" loading={busy} disabled={!sperre.eigen} onClick={save}>Sichern</Button>
      </>} />
    </>
  );
}

function ProdukteTab() {
  const [list, setList] = useState<Produkt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sperre = useSperre('PRODUKT', '*', true, { bezeichnung: 'Produkte Transport' });
  useEffect(() => { api.get<Produkt[]>(`${T}/produkte`).then(setList).catch((e) => setError(e.message)); }, []);
  if (!list) return error ? <MessageStrip design="Negative">{error}</MessageStrip> : null;
  const set = (i: number, k: keyof Produkt, v: string | number | null) => setList(list.map((p, j) => (j === i ? { ...p, [k]: v } : p)));
  async function save() {
    setError(null);
    try {
      await api.put(`${T}/produkte`, list!.map((p, i) => ({ ...p, sort: i + 1 })));
      toast('Produkte gesichert');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <SperrHinweis s={sperre} />
      {error && <MessageStrip design="Negative" style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}
      <Text>Produkte erscheinen als Vorschlag in der Trägerbestellung neuer Holzträgeraufträge (nur gültige).</Text>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '0.75rem' }}>
        <thead><tr style={{ textAlign: 'left', borderBottom: '1px solid var(--sapList_BorderColor)' }}>
          <th style={{ padding: '0.5rem', width: '8rem' }}>Schlüssel</th><th>Bezeichnung</th><th style={{ width: '9rem' }}>Preis (EUR)</th><th style={{ width: '10rem' }}>Gültig bis</th><th style={{ width: '3rem' }} />
        </tr></thead>
        <tbody>
          {list.map((p, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--sapList_BorderColor)' }}>
              <td style={{ padding: '0.25rem 0.5rem' }}><Input style={{ width: '7rem' }} value={p.prod_key} onInput={(e) => set(i, 'prod_key', e.target.value)} /></td>
              <td><Input style={{ width: '100%' }} value={p.text} onInput={(e) => set(i, 'text', e.target.value)} /></td>
              <td><Input style={{ width: '8rem' }} value={String(p.preis).replace('.', ',')} onChange={(e) => set(i, 'preis', Number(e.target.value.replace(',', '.')) || 0)} /></td>
              <td><Input style={{ width: '9rem' }} placeholder="JJJJ-MM-TT" value={p.gueltig_bis ?? ''} onInput={(e) => set(i, 'gueltig_bis', e.target.value || null)} /></td>
              <td><Button icon="delete" design="Transparent" onClick={() => setList(list.filter((_, j) => j !== i))} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <Bar style={{ marginTop: '1rem' }}
           startContent={<Button icon="add" onClick={() => setList([...list, { prod_key: '', text: '', preis: 0, gueltig_bis: null, sort: list.length + 1 }])}>Produkt hinzufügen</Button>}
           endContent={<Button design="Emphasized" disabled={!sperre.eigen} onClick={save}>Sichern</Button>} />
    </>
  );
}

function WerteTab() {
  const [werte, setWerte] = useState<Werte | null>(null);
  const [neu, setNeu] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const sperre = useSperre('WERT', '*', true, { bezeichnung: 'Wertelisten Transport' });
  const lade = () => api.get<Werte>(`${T}/werte`).then(setWerte).catch((e) => setError(e.message));
  useEffect(() => { lade(); }, []);
  if (!werte) return error ? <MessageStrip design="Negative">{error}</MessageStrip> : null;
  async function aendern(typ: string, key: string, text: string, aktiv: boolean) {
    try {
      await api.put(`${T}/werte/${typ}/${key}`, { text, aktiv });
      toast('Gesichert');
      lade();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function anlegen(typ: string) {
    try {
      await api.post(`${T}/werte`, { typ, text: neu[typ] ?? '' });
      setNeu({ ...neu, [typ]: '' });
      lade();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <SperrHinweis s={sperre} />
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '1rem' }}>
        {(Object.keys(WERTE_TITEL) as (keyof Werte)[]).map((typ) => (
          <Panel key={typ} headerText={WERTE_TITEL[typ]} fixed>
            {werte[typ].map((w) => (
              <WertZeile key={w.key} gesperrt={!sperre.eigen} schluessel={w.key} text={w.text} aktiv={w.aktiv ?? true} onSave={(t, a) => aendern(typ, w.key, t, a)} />
            ))}
            <FlexBox style={{ gap: '0.5rem', marginTop: '0.5rem' }}>
              <Input style={{ flex: 1 }} placeholder="Neuer Wert" value={neu[typ] ?? ''} onInput={(e) => setNeu({ ...neu, [typ]: e.target.value })} />
              <Button icon="add" disabled={!sperre.eigen || !(neu[typ] ?? '').trim()} onClick={() => anlegen(typ)}>Anlegen</Button>
            </FlexBox>
          </Panel>
        ))}
      </div>
    </>
  );
}

function WertZeile({ schluessel, text, aktiv, gesperrt, onSave }: { gesperrt: boolean; schluessel: string; text: string; aktiv: boolean; onSave: (t: string, a: boolean) => void }) {
  const [t, setT] = useState(text);
  const [a, setA] = useState(aktiv);
  const geaendert = t !== text || a !== aktiv;
  return (
    <FlexBox alignItems="Center" style={{ gap: '0.5rem', marginBottom: '0.25rem' }}>
      <Text style={{ width: '2.5rem', color: 'var(--sapContent_LabelColor)' }}>{schluessel}</Text>
      <Input style={{ flex: 1 }} value={t} onInput={(e) => setT(e.target.value)} />
      <CheckBox text="aktiv" checked={a} onChange={(e) => setA(e.target.checked)} />
      <Button icon="save" design="Transparent" disabled={gesperrt || !geaendert} onClick={() => onSave(t, a)} />
    </FlexBox>
  );
}

function MailtexteTab() {
  const [list, setList] = useState<MailText[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sperre = useSperre('MAILTEXT', '*', true, { bezeichnung: 'E-Mail-Texte Transport' });
  useEffect(() => { api.get<MailText[]>(`${T}/mailtexte`).then(setList).catch((e) => setError(e.message)); }, []);
  if (!list) return error ? <MessageStrip design="Negative">{error}</MessageStrip> : null;
  async function save() {
    try {
      await api.put(`${T}/mailtexte`, list);
      toast('E-Mail-Texte gesichert');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <SperrHinweis s={sperre} />
      {error && <MessageStrip design="Negative" style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}
      <MessageStrip hideCloseButton style={{ marginBottom: '1rem' }}>
        Platzhalter: {'{ANREDE}'} (z. B. „Sehr geehrter Herr Müller“), {'{AUFTRAG}'}, {'{RECHNUNG}'}.
        Deutsch wird verwendet, wenn der Empfänger in Deutschland sitzt, sonst Englisch.
      </MessageStrip>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: '1rem' }}>
        {list.map((m, i) => (
          <Panel key={`${m.art}${m.sprache}`} headerText={`${ART_TITEL[m.art]} – ${m.sprache === 'D' ? 'Deutsch' : 'Englisch'}`} fixed>
            <TextArea rows={7} style={{ width: '100%' }} value={m.text}
                      onInput={(e) => setList(list.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
          </Panel>
        ))}
      </div>
      <Bar style={{ marginTop: '1rem' }} endContent={<Button design="Emphasized" disabled={!sperre.eigen} onClick={save}>Sichern</Button>} />
    </>
  );
}

export function Stammdaten() {
  const [tab, setTab] = useState('FIRMA');
  return (
    <AppPage title="Stammdaten Transport" subtitle="Firmendaten, Produkte, Wertelisten und E-Mail-Texte">
      <TabContainer onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key!)} style={{ marginBottom: '1rem' }}>
        <Tab data-key="FIRMA" text="Firmendaten" selected={tab === 'FIRMA'} />
        <Tab data-key="PROD" text="Produkte" selected={tab === 'PROD'} />
        <Tab data-key="WERTE" text="Wertelisten" selected={tab === 'WERTE'} />
        <Tab data-key="MAIL" text="E-Mail-Texte" selected={tab === 'MAIL'} />
      </TabContainer>
      {tab === 'FIRMA' && <FirmaTab />}
      {tab === 'PROD' && <ProdukteTab />}
      {tab === 'WERTE' && <WerteTab />}
      {tab === 'MAIL' && <MailtexteTab />}
    </AppPage>
  );
}

