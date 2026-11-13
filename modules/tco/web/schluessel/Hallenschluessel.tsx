import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Bar, BusyIndicator, Button, CheckBox, DatePicker, Dialog, Icon, Input, Label, Link, MessageStrip, ObjectStatus, Option, SegmentedButton, SegmentedButtonItem,
  Select, Text, TextArea, Title,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { PdfDialog } from '@core/components/PdfDialog';
import { toast } from '@core/toast';
import { TCO, dat, dateiLesen, eur } from '../util';
import '../instandhaltung/instandhaltung.css';

/**
 * Hallenschlüssel (#215): Ausgabe und Rückgabe dokumentieren – wer hat vom TCO ausgegeben bzw. empfangen, Online-Quittung des Kunden,
 * Empfangsbestätigung des TCO, Beleg in Paperless, Pfand als Rechnungsposition bzw. Gutschrift in der Hallenabrechnung.
 * Altfälle per Copy & Paste (Buchung direkt auf das Kassenkonto). Liste filter- und sortierbar, Varianten je Benutzer.
 */
const S = `${TCO}/schluessel`;
type Texte = Record<string, string>;
interface Zeile {
  id: number; nummer: string; art: string; art_txt: string; adrnr: string; person: string; datum: string; schluessel_nr: string | null; pfand: number | null;
  zustand_txt: string | null; tco_name: string; status: string; status_txt: string; quittiert_am: string | null; quittiert_von: string | null; quittung_txt: string | null;
  nachweis: string | null; rgnr: string | null; internenr: string | null; doc_id: number | null; quelle: string; bemerkung: string | null;
  ausgegeben: boolean; ueberfaellig: boolean; ausgetreten: boolean; link_offen: boolean; aktuell: boolean;
}
interface Detail extends Zeile {
  protokoll: { id: number; am: string; von: string; aktion_txt: string; text: string | null }[];
  historie: { id: number; nummer: string; art_txt: string; datum: string; status_txt: string; tco_name: string }[];
  kontakt: { email: string; telefon: string } | null; link: string | null;
}
interface Daten { arten: Texte; status: Texte; zustaende: Texte; pfand: { ausgabe: number; rueckgabe: number }; zeilen: Zeile[]; darf: { edit: boolean; admin: boolean }; ich: string }
interface Ansicht { alle: boolean; suche: string; filter: Record<string, string>; sort: { k: string; ab: boolean } | null }
interface Variante { key: string; name: string; global: boolean; standard: boolean; ansicht: Ansicht }
/** alle = false: nur aktuell ausgegebene Schlüssel und offene Quittungen */
const LEER: Ansicht = { alle: false, suche: '', filter: {}, sort: null };
const STATE: Record<string, 'Critical' | 'Positive' | 'None'> = { WARTET: 'Critical', QUITTIERT: 'Positive', STORNIERT: 'None' };
const heute = () => new Date().toLocaleDateString('sv-SE');
const zeitGenau = (iso: string) => new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dokid = (n: number) => String(n).padStart(6, '0');

interface Spalte { k: string; titel: string; text: (z: Zeile) => string; ordnung?: (z: Zeile) => string | number; zelle?: (z: Zeile) => ReactNode; filter?: boolean }
const SPALTEN: Spalte[] = [
  { k: 'nummer', titel: 'Vorgang', text: (z) => z.nummer, filter: false },
  { k: 'art', titel: 'Art', text: (z) => z.art_txt },
  { k: 'person', titel: 'Person', text: (z) => z.person, filter: false,
    zelle: (z) => <span>{z.person}{z.ausgetreten && <ObjectStatus state="Negative"> ausgetreten</ObjectStatus>}</span> },
  { k: 'datum', titel: 'Datum', text: (z) => dat(z.datum), ordnung: (z) => z.datum, filter: false },
  { k: 'tco', titel: 'Ausgegeben / empfangen von', text: (z) => z.tco_name || '–' },
  { k: 'pfand', titel: 'Pfand', text: (z) => (z.pfand != null ? eur(z.pfand) : '–'), ordnung: (z) => z.pfand ?? -1, filter: false },
  { k: 'status', titel: 'Quittung', text: (z) => (z.ueberfaellig ? 'Quittung überfällig' : z.status_txt),
    zelle: (z) => <ObjectStatus state={z.ueberfaellig ? 'Negative' : STATE[z.status]} inverted>{z.ueberfaellig ? 'Quittung überfällig' : z.status_txt}</ObjectStatus> },
  { k: 'quittung', titel: 'Quittiert durch', text: (z) => z.quittung_txt ?? '–' },
  { k: 'rechnung', titel: 'Rechnung / Buchung', text: (z) => z.rgnr ?? (z.internenr ? `FI ${z.internenr}` : '–'), filter: false },
  { k: 'beleg', titel: 'Beleg', text: (z) => (z.doc_id ? dokid(z.doc_id) : '–'), filter: false },
  { k: 'stand', titel: 'Stand', text: (z) => (z.ausgegeben ? 'Schlüssel ausgegeben' : z.status === 'STORNIERT' ? 'storniert' : z.art === 'RUECKGABE' ? 'zurückgegeben' : 'früherer Vorgang') },
];

export function Hallenschluessel() {
  const [daten, setDaten] = useState<Daten | null>(null);
  const [ansicht, setAnsicht] = useState<Ansicht | null>(null);
  const [varianten, setVarianten] = useState<Variante[]>([]);
  const [aktiv, setAktiv] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [hinweise, setHinweise] = useState<string[]>([]);
  const [offen, setOffen] = useState<number | null>(() => Number(new URLSearchParams(window.location.search).get('id')) || null);
  const [dlg, setDlg] = useState<null | 'ausgabe' | 'altdaten' | 'abgleich' | 'cfg' | 'variante'>(null);
  const [rueck, setRueck] = useState<Zeile | null>(null);
  const laden = () => api.get<Daten>(S).then(setDaten).catch((e) => setError((e as Error).message));
  useEffect(() => {
    laden();
    api.get<{ varianten: Variante[]; standard: Variante | null }>(`${S}/varianten/liste`).then((r) => {
      setVarianten(r.varianten);
      if (r.standard) { setAktiv(r.standard.key); setAnsicht(r.standard.ansicht); } else setAnsicht(LEER);
    }).catch(() => setAnsicht(LEER));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!daten || !ansicht) {
    return <AppPage title="Hallenschlüssel">{error ? <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip> : <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />}</AppPage>;
  }
  const a = ansicht;
  const setA = (x: Partial<Ansicht>) => setAnsicht({ ...a, ...x });
  const basis = daten.zeilen.filter((z) => a.alle || z.ausgegeben || z.status === 'WARTET');
  const such = a.suche.trim().toLowerCase();
  const zeilen = basis
    .filter((z) => SPALTEN.every((sp) => !a.filter[sp.k] || sp.text(z) === a.filter[sp.k]))
    .filter((z) => !such || `${z.nummer} ${z.person} ${z.tco_name} ${z.rgnr ?? ''} ${z.schluessel_nr ?? ''} ${z.bemerkung ?? ''}`.toLowerCase().includes(such));
  const sp = a.sort ? SPALTEN.find((x) => x.k === a.sort!.k) : undefined;
  if (sp) {
    const w = (z: Zeile) => (sp.ordnung ?? sp.text)(z);
    zeilen.sort((x, y) => {
      const p = w(x), q = w(y);
      const c = typeof p === 'number' && typeof q === 'number' ? p - q : String(p).localeCompare(String(q), 'de', { numeric: true });
      return a.sort!.ab ? c : -c;
    });
  }
  const werte = (x: Spalte): string[] => Array.from(new Set<string>(basis.map((z) => x.text(z)))).sort((p, q) => p.localeCompare(q, 'de', { numeric: true }));
  const variante = varianten.find((v) => v.key === aktiv);
  const fertig = (r?: { text?: string; hinweise?: string[] }) => {
    setDlg(null); setRueck(null);
    if (r) { if (r.text) toast(r.text, 6000); setHinweise(r.hinweise ?? []); laden(); }
  };
  async function varianteLoeschen() {
    if (!variante) return;
    try {
      const r = await api.del<{ text: string }>(`${S}/varianten/liste`, { key: variante.key });
      toast(r.text); setVarianten(varianten.filter((v) => v.key !== variante.key)); setAktiv('');
    } catch (e) { setError((e as Error).message); }
  }
  const anzahl = daten.zeilen.filter((z) => z.ausgegeben).length;

  return (
    <AppPage title="Hallenschlüssel" subtitle={`${anzahl} Schlüssel ausgegeben · Pfand ${eur(daten.pfand.ausgabe)} laut Hallenprodukt`}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {hinweise.length > 0 && <MessageStrip design="Critical" onClose={() => setHinweise([])} style={{ marginBottom: '0.5rem' }}>{hinweise.join(' · ')}</MessageStrip>}
      <div className="portal-row" style={{ justifyContent: 'space-between', marginBottom: '0.5rem', gap: '0.5rem', flexWrap: 'wrap' }}>
        <div className="portal-row" style={{ gap: '0.5rem' }}>
          <Label showColon>Variante</Label>
          <Select style={{ minWidth: '12rem' }} accessibleName="Variante"
                  onChange={(e) => {
                    const key = (e.detail.selectedOption as HTMLElement).dataset.v ?? '';
                    setAktiv(key); setAnsicht(varianten.find((v) => v.key === key)?.ansicht ?? LEER);
                  }}>
            <Option data-v="" selected={!aktiv}>Standardansicht</Option>
            {varianten.map((v) => <Option key={v.key} data-v={v.key} selected={aktiv === v.key}>{v.name}{v.standard ? ' ★' : ''}{v.global ? ' (für alle)' : ''}</Option>)}
          </Select>
          <Button design="Transparent" icon="save" onClick={() => setDlg('variante')}>Variante sichern …</Button>
          {variante && (!variante.global || daten.darf.admin) && <Button design="Transparent" icon="delete" tooltip="Variante löschen" onClick={varianteLoeschen} />}
        </div>
        <div className="portal-row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
          <Input placeholder="Suchen …" value={a.suche} style={{ width: '12rem' }} onInput={(e) => setA({ suche: e.target.value })} />
          <SegmentedButton accessibleName="Umfang" onSelectionChange={(e) => setA({ alle: (e.detail.selectedItems[0] as HTMLElement).dataset.u === 'alle' })}>
            <SegmentedButtonItem data-u="aktuell" selected={!a.alle}>Ausgegeben / offen</SegmentedButtonItem>
            <SegmentedButtonItem data-u="alle" selected={a.alle}>Alle Vorgänge</SegmentedButtonItem>
          </SegmentedButton>
          {daten.darf.edit && <Button design="Emphasized" icon="add" onClick={() => setDlg('ausgabe')}>Schlüssel ausgeben</Button>}
          {daten.darf.admin && <Button design="Transparent" icon="paste" onClick={() => setDlg('altdaten')}>Altdaten einfügen</Button>}
          {daten.darf.admin && <Button design="Transparent" icon="compare" onClick={() => setDlg('abgleich')}>FI-Abgleich</Button>}
          {daten.darf.admin && <Button design="Transparent" icon="action-settings" tooltip="Einstellungen" onClick={() => setDlg('cfg')} />}
          <Button design="Transparent" icon="refresh" tooltip="Neu laden" onClick={laden} />
        </div>
      </div>
      <div className="portal-ih__rahmen">
        <table className="portal-ih__tabelle portal-ih__liste">
          <thead>
            <tr>
              {SPALTEN.map((x) => (
                <th key={x.k} style={{ cursor: 'pointer', userSelect: 'none' }} title="Sortieren"
                    onClick={() => setA({ sort: a.sort?.k === x.k ? (a.sort.ab ? { k: x.k, ab: false } : null) : { k: x.k, ab: true } })}>
                  {x.titel}{a.sort?.k === x.k && <Icon name={a.sort.ab ? 'sort-ascending' : 'sort-descending'} style={{ marginInlineStart: '0.25rem', width: '0.8rem', height: '0.8rem' }} />}
                </th>
              ))}
              <th />
            </tr>
            <tr>
              {SPALTEN.map((x) => (
                <th key={x.k}>
                  {x.filter !== false && (
                    <Select accessibleName={`${x.titel} filtern`} style={{ width: '100%', minWidth: '6rem' }}
                            onChange={(e) => setA({ filter: { ...a.filter, [x.k]: (e.detail.selectedOption as HTMLElement).dataset.w ?? '' } })}>
                      <Option data-w="" selected={!a.filter[x.k]}>Alle</Option>
                      {werte(x).map((w) => <Option key={w} data-w={w} selected={a.filter[x.k] === w}>{w}</Option>)}
                    </Select>
                  )}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {zeilen.map((z) => (
              <tr key={z.id} className="portal-ih__zeile" onClick={() => setOffen(z.id)} title="Vorgang öffnen">
                {SPALTEN.map((x) => <td key={x.k}>{x.zelle ? x.zelle(z) : x.text(z)}</td>)}
                <td style={{ whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                  {daten.darf.edit && z.ausgegeben && <Button design="Transparent" icon="undo" onClick={() => setRueck(z)}>Rückgabe</Button>}
                </td>
              </tr>
            ))}
            {!zeilen.length && <tr><td colSpan={SPALTEN.length + 1} className="portal-muted">{basis.length ? 'Kein Vorgang passt zu den Filtern.' : 'Keine Vorgänge.'}</td></tr>}
          </tbody>
        </table>
        <Text className="portal-muted portal-small">{zeilen.length} von {basis.length} Vorgang/Vorgängen</Text>
      </div>

      {dlg === 'ausgabe' && <AusgabeDialog daten={daten} onClose={fertig} />}
      {rueck && <RueckgabeDialog z={rueck} daten={daten} onClose={fertig} />}
      {dlg === 'altdaten' && <AltdatenDialog onClose={fertig} />}
      {dlg === 'abgleich' && <AbgleichDialog onClose={() => { setDlg(null); laden(); }} />}
      {dlg === 'cfg' && <EinstellungenDialog onClose={fertig} />}
      {dlg === 'variante' && (
        <VarianteDialog ansicht={a} vorschlag={variante} admin={daten.darf.admin} onClose={(v) => {
          setDlg(null);
          if (v) { setVarianten([...varianten.filter((x) => x.key !== v.key).map((x) => (v.standard && x.global === v.global ? { ...x, standard: false } : x)), v]); setAktiv(v.key); }
        }} />
      )}
      {offen && (
        <DetailDialog id={offen} darf={daten.darf} onRueckgabe={(z) => { setOffen(null); setRueck(z); }} onClose={(neu) => {
          setOffen(null);
          if (window.location.search.includes('id=')) window.history.replaceState(null, '', window.location.pathname);
          if (neu) laden();
        }} />
      )}
    </AppPage>
  );
}

type Fertig = (r?: { text?: string; hinweise?: string[] }) => void;

function AusgabeDialog({ daten, onClose }: { daten: Daten; onClose: Fertig }) {
  interface P { adrnr: string; name: string; info: string; hat: boolean }
  const [personen, setPersonen] = useState<P[] | null>(null);
  const [q, setQ] = useState('');
  const [person, setPerson] = useState<P | null>(null);
  const [f, setF] = useState({ datum: heute(), schluessel_nr: '', bemerkung: '', ausgegeben_von: daten.ich, mit_rechnung: true });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get<P[]>(`${S}/personen`).then(setPersonen).catch((e) => setError((e as Error).message)); }, []);
  const such = q.trim().toLowerCase();
  const treffer = such.length < 2 ? [] : (personen ?? []).filter((p) => p.name.toLowerCase().includes(such)).slice(0, 12);
  async function sichern() {
    if (!person) { setError('Bitte eine Person wählen.'); return; }
    setBusy(true); setError(null);
    try { onClose(await api.post<{ text: string; hinweise: string[] }>(`${S}/ausgabe`, { adrnr: person.adrnr, ...f })); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open headerText="Hallenschlüssel ausgeben" style={{ width: 'min(34rem, 96vw)' }} onClose={() => onClose()}
            footer={<Bar endContent={<><Button design="Emphasized" icon="key" loading={busy} disabled={!person} onClick={sichern}>Ausgabe erfassen</Button><Button onClick={() => onClose()}>Abbrechen</Button></>} />}>
      <div className="portal-bk__form">
        {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
        <Label showColon required>Empfänger (Mitglied oder Kunde)</Label>
        {person ? (
          <div className="portal-row" style={{ justifyContent: 'space-between' }}>
            <Text><b>{person.name}</b> · {person.info}</Text>
            <Button design="Transparent" icon="decline" tooltip="Andere Person" onClick={() => setPerson(null)} />
          </div>
        ) : (
          <>
            <Input value={q} placeholder="Name suchen (mindestens 2 Zeichen) …" onInput={(e) => setQ(e.target.value)} />
            {!personen && <BusyIndicator active />}
            {treffer.map((p) => (
              <div key={p.adrnr} className="portal-ih__zeile" style={{ padding: '0.25rem 0.5rem', opacity: p.hat ? 0.6 : 1 }} onClick={() => !p.hat && setPerson(p)}>
                {p.name} <span className="portal-muted">· {p.info}{p.hat ? ' · hat bereits einen Schlüssel' : ''}</span>
              </div>
            ))}
          </>
        )}
        <Label showColon required>Ausgegeben am</Label>
        <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.datum} onChange={(e) => setF({ ...f, datum: e.detail.value })} />
        <Label showColon>Ausgegeben von (TCO)</Label>
        <Input value={f.ausgegeben_von} maxlength={100} onInput={(e) => setF({ ...f, ausgegeben_von: e.target.value })} />
        <Label showColon>Schlüsselnummer (optional)</Label>
        <Input value={f.schluessel_nr} maxlength={30} placeholder="Schlüssel sind nicht nummeriert – nur falls vorhanden" onInput={(e) => setF({ ...f, schluessel_nr: e.target.value })} />
        <Label showColon>Bemerkung</Label>
        <TextArea rows={2} maxlength={500} value={f.bemerkung} onInput={(e) => setF({ ...f, bemerkung: e.target.value })} />
        <CheckBox wrappingType="Normal" text={`Pfand ${eur(daten.pfand.ausgabe)} als Position in die Hallenrechnung der Person`} checked={f.mit_rechnung} onChange={(e) => setF({ ...f, mit_rechnung: e.target.checked })} />
        <Text className="portal-muted portal-small">Nach dem Erfassen bekommt die Person per E-Mail einen Link, um den Erhalt online zu quittieren. Der Beleg wird in Paperless abgelegt.</Text>
      </div>
    </Dialog>
  );
}

function RueckgabeDialog({ z, daten, onClose }: { z: Zeile; daten: Daten; onClose: Fertig }) {
  const [f, setF] = useState({ datum: heute(), zustand: 'OK', bemerkung: '', empfangen_von: daten.ich, gutschrift: true, bestaetigt: true });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function sichern() {
    setBusy(true); setError(null);
    try { onClose(await api.post<{ text: string; hinweise: string[] }>(`${S}/rueckgabe`, { adrnr: z.adrnr, ...f })); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open headerText={`Rückgabe: ${z.person}`} style={{ width: 'min(32rem, 96vw)' }} onClose={() => onClose()}
            footer={<Bar endContent={<><Button design="Emphasized" icon="undo" loading={busy} onClick={sichern}>Rückgabe erfassen</Button><Button onClick={() => onClose()}>Abbrechen</Button></>} />}>
      <div className="portal-bk__form">
        {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
        <Text>Schlüssel ausgegeben am {dat(z.datum)}{z.tco_name ? ` von ${z.tco_name}` : ''}{z.schluessel_nr ? ` · Schlüssel ${z.schluessel_nr}` : ''}.</Text>
        <Label showColon required>Zurückgegeben am</Label>
        <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.datum} onChange={(e) => setF({ ...f, datum: e.detail.value })} />
        <Label showColon>Empfangen von (TCO)</Label>
        <Input value={f.empfangen_von} maxlength={100} onInput={(e) => setF({ ...f, empfangen_von: e.target.value })} />
        <Label showColon>Zustand</Label>
        <Select onChange={(e) => { const zu = (e.detail.selectedOption as HTMLElement).dataset.z ?? 'OK'; setF({ ...f, zustand: zu, gutschrift: zu === 'OK' }); }}>
          {Object.entries(daten.zustaende).map(([k, t]) => <Option key={k} data-z={k} selected={f.zustand === k}>{t}</Option>)}
        </Select>
        <Label showColon>Bemerkung</Label>
        <TextArea rows={2} maxlength={500} value={f.bemerkung} onInput={(e) => setF({ ...f, bemerkung: e.target.value })} />
        <CheckBox wrappingType="Normal" text={`Pfand ${eur(daten.pfand.rueckgabe)} als Gutschrift (negativer Betrag) in die Hallenrechnung`} checked={f.gutschrift} onChange={(e) => setF({ ...f, gutschrift: e.target.checked })} />
        <CheckBox wrappingType="Normal" text="Ich bestätige den Empfang des Schlüssels für den TCO" checked={f.bestaetigt} onChange={(e) => setF({ ...f, bestaetigt: e.target.checked })} />
        {!f.bestaetigt && <Text className="portal-muted portal-small">Ohne Bestätigung wartet die Rückgabe im Arbeitsvorrat, bis der Empfang bestätigt ist.</Text>}
      </div>
    </Dialog>
  );
}

function DetailDialog({ id, darf, onClose, onRueckgabe }: { id: number; darf: Daten['darf']; onClose: (neu: boolean) => void; onRueckgabe: (z: Zeile) => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [geaendert, setGeaendert] = useState(false);
  const [pdf, setPdf] = useState(false);
  const [storno, setStorno] = useState<string | null>(null);
  const laden = () => api.get<Detail>(`${S}/${id}`).then(setD).catch((e) => setError((e as Error).message));
  useEffect(() => { laden(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function aktion(fn: () => Promise<{ text: string; hinweise?: string[] }>) {
    setBusy(true); setError(null);
    try {
      const r = await fn();
      toast(r.text, 5000); setGeaendert(true);
      if (r.hinweise?.length) setError(r.hinweise.join(' · '));
      await laden();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open headerText={d ? `${d.nummer} · ${d.art_txt} · ${d.person}` : 'Hallenschlüssel'} style={{ width: 'min(50rem, 98vw)' }} onClose={() => onClose(geaendert)}
            footer={<Bar startContent={d ? <Button icon="print" onClick={() => setPdf(true)}>Beleg</Button> : undefined}
                         endContent={<Button onClick={() => onClose(geaendert)}>Schließen</Button>} />}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {!d ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : (
        <div className="portal-bk__form">
          <div className="portal-row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            <ObjectStatus state={d.ueberfaellig ? 'Negative' : STATE[d.status]} inverted>{d.ueberfaellig ? 'Quittung überfällig' : d.status_txt}</ObjectStatus>
            {d.ausgegeben && <ObjectStatus state="Information" inverted>Schlüssel ausgegeben</ObjectStatus>}
            {d.ausgetreten && <ObjectStatus state="Negative" inverted>ausgetreten</ObjectStatus>}
          </div>
          <Text>
            {d.art === 'AUSGABE' ? 'Ausgegeben' : 'Zurückgegeben'} am <b>{dat(d.datum)}</b>, {d.art === 'AUSGABE' ? 'ausgegeben' : 'empfangen'} von <b>{d.tco_name || '–'}</b>
            {d.schluessel_nr ? ` · Schlüssel ${d.schluessel_nr}` : ''}{d.zustand_txt ? ` · Zustand: ${d.zustand_txt}` : ''}{d.pfand != null ? ` · Pfand ${eur(d.pfand)}` : ''}
          </Text>
          <Text>
            {d.rgnr ? <><Link href="/tco/halle">Hallenrechnung</Link> {d.rgnr}{d.art === 'RUECKGABE' ? ' (Gutschrift)' : ''}</> : d.internenr
              ? <>FI-Buchung <Link href={`/tco/fi?buchung=${encodeURIComponent(d.internenr)}`}>{d.internenr}</Link> (Kasse)</> : 'Ohne Rechnung/Buchung'}
            {' · '}{d.doc_id ? `Beleg in Paperless: DOKID ${dokid(d.doc_id)}` : 'Beleg noch nicht in Paperless'}
          </Text>
          {d.status === 'QUITTIERT' && <Text>Quittiert: {d.quittung_txt}{d.quittiert_von ? ` – ${d.quittiert_von}` : ''}{d.quittiert_am ? ` am ${zeitGenau(d.quittiert_am)}` : ''}{d.nachweis ? ` (${d.nachweis})` : ''}</Text>}
          {d.bemerkung && <Text style={{ whiteSpace: 'pre-line' }}>{d.bemerkung}</Text>}
          {d.kontakt && <Text className="portal-muted">{d.kontakt.email || 'keine E-Mail-Adresse'}{d.kontakt.telefon ? ` · ${d.kontakt.telefon}` : ''}</Text>}
          {d.link && (
            <MessageStrip design="Information" hideCloseButton>
              Quittungslink für den Kunden: <span style={{ wordBreak: 'break-all' }}>{d.link}</span>
            </MessageStrip>
          )}
          {darf.edit && d.status !== 'STORNIERT' && (
            <div className="portal-row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
              {d.link_offen && <Button icon="email" disabled={busy} onClick={() => aktion(() => api.post<{ text: string }>(`${S}/${id}/link`))}>Quittungslink erneut senden</Button>}
              {d.art === 'RUECKGABE' && d.status === 'WARTET' && <Button design="Emphasized" icon="accept" disabled={busy} onClick={() => aktion(() => api.post<{ text: string; hinweise: string[] }>(`${S}/${id}/empfang`))}>Empfang bestätigen</Button>}
              {d.ausgegeben && <Button icon="undo" disabled={busy} onClick={() => onRueckgabe(d)}>Rückgabe erfassen</Button>}
              <Button icon="upload-to-cloud" disabled={busy} onClick={() => aktion(() => api.post<{ text: string; hinweise: string[] }>(`${S}/${id}/beleg`))}>Beleg in Paperless ablegen</Button>
              <DokumentKnopf id={id} disabled={busy} text="Eigenes Dokument ablegen" onFertig={() => { setGeaendert(true); laden(); }} onFehler={setError} />
              {d.aktuell && <Button design="Negative" icon="cancel" disabled={busy} onClick={() => setStorno('')}>Stornieren</Button>}
            </div>
          )}
          <Title level="H6">Protokoll</Title>
          <div className="portal-ih__rahmen"><table className="portal-ih__tabelle">
            <thead><tr><th>Zeitpunkt</th><th>Benutzer</th><th>Aktion</th><th>Text</th></tr></thead>
            <tbody>
              {d.protokoll.map((v) => <tr key={v.id}><td style={{ whiteSpace: 'nowrap' }}>{zeitGenau(v.am)}</td><td>{v.von}</td><td style={{ whiteSpace: 'nowrap' }}><b>{v.aktion_txt}</b></td><td>{v.text}</td></tr>)}
              {!d.protokoll.length && <tr><td colSpan={4} className="portal-muted">Kein Protokoll (aus dem Mitgliederstamm übernommen).</td></tr>}
            </tbody>
          </table></div>
          {d.historie.length > 0 && (
            <>
              <Title level="H6">Weitere Vorgänge von {d.person}</Title>
              <Text>{d.historie.map((h) => `${dat(h.datum)} ${h.art_txt} (${h.nummer}, ${h.status_txt}${h.tco_name ? `, ${h.tco_name}` : ''})`).join(' · ')}</Text>
            </>
          )}
        </div>
      )}
      <PdfDialog url={pdf && d ? `${S}/${id}/beleg.pdf` : null} title={`Beleg ${d?.nummer ?? ''}`} filename={`Hallenschluessel_${d?.nummer ?? ''}.pdf`} onClose={() => setPdf(false)} />
      {storno !== null && (
        <Dialog open headerText="Vorgang stornieren" style={{ width: 'min(26rem, 96vw)' }} onClose={() => setStorno(null)}
                footer={<Bar endContent={<>
                  <Button design="Negative" disabled={storno.trim().length < 3} onClick={() => { const grund = storno; setStorno(null); aktion(() => api.post<{ text: string; hinweise: string[] }>(`${S}/${id}/storno`, { grund })); }}>Stornieren</Button>
                  <Button onClick={() => setStorno(null)}>Abbrechen</Button>
                </>} />}>
          <div className="portal-bk__form">
            <Label showColon required>Grund</Label>
            <TextArea rows={2} maxlength={300} value={storno} onInput={(e) => setStorno(e.target.value)} />
            <Text className="portal-muted portal-small">Die Position in der Hallenrechnung wird entfernt, solange die Rechnung noch änderbar ist.</Text>
          </div>
        </Dialog>
      )}
    </Dialog>
  );
}

/** Datei wählen und als Dokument zum Vorgang in Paperless ablegen (z. B. Scan eines alten Belegs) */
function DokumentKnopf({ id, text, disabled, onFertig, onFehler }: { id: number; text: string; disabled?: boolean; onFertig: (docId: number) => void; onFehler: (m: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  async function ablegen(f: File | undefined) {
    if (!f) return;
    setBusy(true);
    try {
      const r = await api.post<{ text: string; doc_id: number; hinweise: string[] }>(`${S}/${id}/dokument`, { datei: f.name, inhalt: await dateiLesen(f) });
      toast(r.text, 5000);
      if (r.hinweise.length) onFehler(r.hinweise.join(' · '));
      onFertig(r.doc_id);
    } catch (e) { onFehler((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <>
      <input ref={input} type="file" accept=".pdf,image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; ablegen(f); }} />
      <Button icon="attachment" loading={busy} disabled={disabled || busy} onClick={() => input.current?.click()}>{text}</Button>
    </>
  );
}

/**
 * Altdaten per Copy & Paste in vier Schritten: 1) einfügen → 2) **Vorschau** (gelesene Daten ansehen, Zeilen an- und abwählen,
 * nicht erkannte oder falsch erkannte Personen von Hand einem Mitglied/Kunden zuweisen) → 3) speichern → 4) danach je Vorgang
 * die Dokumente in Paperless ablegen. Gebucht wird erst beim Speichern und nur für die Zeilen mit Haken „buchen“ (Vorgabe: keine).
 * Strg+V fügt überall im Dialog den Text ein – das Bild, das Excel mitkopiert, wird nicht als Dokument abgelegt.
 */
function AltdatenDialog({ onClose }: { onClose: Fertig }) {
  interface P { adrnr: string; name: string; info: string }
  interface Pruef {
    zeile: number; person: string; adrnr: string | null; name: string | null; ausgabe: string | null; ausgegeben_von: string; pfand: number | null; rueckgabe: string | null; empfangen_von: string;
    doc_ausgabe: number | null; doc_rueckgabe: number | null; schluessel_nr: string; bemerkung: string; fehler: string[]; hinweise: string[]; vorhanden: boolean; zugewiesen: boolean; vorschlaege: P[];
  }
  const [text, setText] = useState('');
  const [p, setP] = useState<{ spalten: string[]; zeilen: Pruef[]; kassenkonto: string } | null>(null);
  const [zuordnung, setZuordnung] = useState<Record<string, string>>({});
  const [ab, setAb] = useState<Set<number>>(new Set());
  const [buchen, setBuchen] = useState<Set<number>>(new Set());
  const [zuweisen, setZuweisen] = useState<Pruef | null>(null);
  const [personen, setPersonen] = useState<P[] | null>(null);
  const [q, setQ] = useState('');
  interface Neu { id: number; nummer: string; art_txt: string; person: string; datum: string; doc_id: number | null; internenr: string | null }
  const [fertig, setFertig] = useState<{ text: string; vorgaenge: Neu[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Schritt 1: Strg+V überall im Dialog fügt den Text ein; die Ablage (Bild aus Excel) bleibt außen vor
  const schritt1 = !p && !fertig;
  useEffect(() => {
    if (!schritt1) return undefined;
    const paste = (ev: ClipboardEvent) => {
      const t = ev.clipboardData?.getData('text/plain') ?? '';
      if (!t.trim()) return;
      ev.stopPropagation();
      const imFeld = ev.composedPath().some((x) => x instanceof HTMLElement && /^(TEXTAREA|INPUT|UI5-TEXTAREA|UI5-INPUT)$/.test(x.tagName));
      if (!imFeld) { ev.preventDefault(); setText(t); }
    };
    document.addEventListener('paste', paste, true);
    return () => document.removeEventListener('paste', paste, true);
  }, [schritt1]);
  async function vorschau(z: Record<string, string> = zuordnung) {
    setBusy(true); setError(null);
    try { setP(await api.post(`${S}/altdaten/pruefen`, { text, zuordnung: z })); setZuordnung(z); setZuweisen(null); setQ(''); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  function zurueck() { setP(null); setZuordnung({}); setAb(new Set()); setBuchen(new Set()); setZuweisen(null); }
  function waehlen(z: Pruef) {
    setZuweisen(z); setQ('');
    if (!personen) api.get<P[]>(`${S}/personen`).then(setPersonen).catch((e) => setError((e as Error).message));
  }
  const umschalten = (set: Set<number>, n: number, an: boolean) => { const s = new Set(set); if (an) s.add(n); else s.delete(n); return s; };
  // übernommen werden gewählte Zeilen ohne Fehler, die es noch nicht gibt
  const moeglich = (z: Pruef) => !z.fehler.length && !z.vorhanden;
  const gewaehlt = (p?.zeilen ?? []).filter((z) => moeglich(z) && !ab.has(z.zeile));
  const mitBuchung = gewaehlt.filter((z) => buchen.has(z.zeile) && (z.pfand ?? 0) > 0);
  const buchbar = gewaehlt.filter((z) => (z.pfand ?? 0) > 0);
  const offen = (p?.zeilen ?? []).filter((z) => z.fehler.length).length;
  async function uebernehmen() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string; vorgaenge: Neu[] }>(`${S}/altdaten`, { text, zuordnung, zeilen: gewaehlt.map((z) => z.zeile), buchen: false, buchen_zeilen: mitBuchung.map((z) => z.zeile) });
      toast(r.text, 6000); setFertig(r); setP(null);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const such = q.trim().toLowerCase();
  const treffer = such.length < 2 ? [] : (personen ?? []).filter((x) => x.name.toLowerCase().includes(such)).slice(0, 12);
  return (
    <Dialog open headerText={fertig ? 'Altdaten – Dokumente ablegen' : p ? 'Altdaten – Vorschau' : 'Altdaten einfügen (Copy & Paste)'} style={{ width: 'min(78rem, 98vw)' }} onClose={() => onClose(fertig ? {} : undefined)}
            footer={fertig ? <Bar endContent={<Button design="Emphasized" onClick={() => onClose({})}>Fertig</Button>} /> : <Bar endContent={<>
              {!p && <Button design="Emphasized" icon="show" loading={busy} disabled={!text.trim()} onClick={() => vorschau({})}>Vorschau</Button>}
              {p && <Button icon="nav-back" disabled={busy} onClick={zurueck}>Zurück zum Einfügen</Button>}
              {p && <Button design="Emphasized" icon="accept" loading={busy} disabled={!gewaehlt.length} onClick={uebernehmen}>
                {gewaehlt.length} Zeile(n) speichern{mitBuchung.length ? ` · ${mitBuchung.length} mit Kassenbuchung` : ' · ohne Buchung'}
              </Button>}
              <Button onClick={() => onClose()}>Abbrechen</Button>
            </>} />}>
      <div className="portal-bk__form">
        {error && <MessageStrip design="Negative" onClose={() => setError(null)}><span style={{ whiteSpace: 'pre-line' }}>{error}</span></MessageStrip>}
        {fertig && (
          <>
            <MessageStrip design="Positive" hideCloseButton>{fertig.text} Jetzt kannst du zu jedem Vorgang das Dokument (PDF oder Foto des alten Belegs) in Paperless ablegen – oder später im Vorgang.</MessageStrip>
            <div className="portal-ih__rahmen" style={{ maxHeight: '52vh', overflowY: 'auto' }}><table className="portal-ih__tabelle">
              <thead><tr><th>Vorgang</th><th>Art</th><th>Person</th><th>Datum</th><th>FI-Buchung</th><th>Dokument in Paperless</th><th /></tr></thead>
              <tbody>
                {fertig.vorgaenge.map((v) => (
                  <tr key={v.id}>
                    <td>{v.nummer}</td><td>{v.art_txt}</td><td>{v.person}</td><td>{dat(v.datum)}</td><td>{v.internenr ?? '–'}</td>
                    <td>{v.doc_id ? <ObjectStatus state="Positive">DOKID {dokid(v.doc_id)}</ObjectStatus> : <span className="portal-muted">noch keins</span>}</td>
                    <td><DokumentKnopf id={v.id} text={v.doc_id ? 'Neue Version' : 'Dokument ablegen'} onFehler={setError}
                                       onFertig={(doc) => setFertig({ ...fertig, vorgaenge: fertig.vorgaenge.map((x) => (x.id === v.id ? { ...x, doc_id: doc } : x)) })} /></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </>
        )}
        {!p && !fertig && (
          <>
            <Text className="portal-muted portal-small">
              Zeilen aus Excel kopieren und hier einfügen (Strg+V). Spalten in dieser Reihenfolge – oder mit Kopfzeile in beliebiger Reihenfolge:<br />
              Person (Mitgliedsnr. oder „Vorname Nachname“) · Ausgabe am · ausgegeben von · Pfand · Rückgabe am · empfangen von · [Paperless-ID Beleg Ausgabe] · [Paperless-ID Beleg Rückgabe] · Schlüsselnr. · Bemerkung<br />
              Dokumente werden hier nicht abgefragt – die beiden Paperless-Spalten dürfen leer bleiben oder fehlen. Du legst die Dokumente nach dem Speichern je Vorgang ab.
            </Text>
            <TextArea rows={10} value={text} placeholder={'Max Muster\t01.10.2019\tBen H.\t25,00\t15.03.2022\tAnna V.\t501\t502'} onInput={(e) => setText(e.target.value)} />
            <Text className="portal-muted portal-small">Ablauf: 1) einfügen · 2) Vorschau – gelesene Daten ansehen und Mitglieder zuweisen · 3) speichern · 4) Dokumente ablegen. Mit „Vorschau“ wird noch nichts gespeichert oder gebucht.</Text>
          </>
        )}
        {p && (
          <>
            <MessageStrip design={offen ? 'Critical' : 'Information'} hideCloseButton>
              {p.zeilen.length} Zeile(n) gelesen – noch nichts gespeichert. {gewaehlt.length} zur Übernahme gewählt, {p.zeilen.filter((z) => z.vorhanden).length} bereits vorhanden
              {offen ? `, ${offen} noch zu klären (Person zuweisen) – sie werden sonst nicht übernommen` : ''}.
            </MessageStrip>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <Text className="portal-muted portal-small">Buchung auf das Kassenkonto {p.kassenkonto} (FI-Beleg mit verknüpftem Paperless-Beleg) nur für Zeilen mit Haken „buchen“:</Text>
              <Button design="Transparent" disabled={!buchbar.length} onClick={() => setBuchen(new Set(buchbar.map((z) => z.zeile)))}>alle buchen</Button>
              <Button design="Transparent" disabled={!buchen.size} onClick={() => setBuchen(new Set())}>keine buchen</Button>
            </div>
            <div className="portal-ih__rahmen" style={{ maxHeight: '46vh', overflowY: 'auto' }}><table className="portal-ih__tabelle">
              <thead><tr><th title="übernehmen">✓</th><th>Zeile</th><th>Eingefügt</th><th>Mitglied / Kunde</th><th>Ausgabe</th><th>von</th><th style={{ textAlign: 'right' }}>Pfand</th><th>Rückgabe</th><th>von</th><th>Belege</th><th>Bemerkung</th><th>buchen</th><th>Prüfung</th></tr></thead>
              <tbody>
                {p.zeilen.map((z) => {
                  const an = moeglich(z) && !ab.has(z.zeile);
                  const nurPerson = z.fehler.length > 0 && z.fehler.every((f) => /nicht gefunden|Person fehlt/.test(f));
                  return (
                    <tr key={z.zeile} className={z.vorhanden || ab.has(z.zeile) ? 'portal-ih__inaktiv' : undefined}>
                      <td><CheckBox checked={an} disabled={!moeglich(z)} onChange={(e) => setAb(umschalten(ab, z.zeile, !e.target.checked))} /></td>
                      <td>{z.zeile}</td><td>{z.person}</td>
                      <td>
                        {z.name ? <>{z.name}{z.zugewiesen ? <span className="portal-muted"> · zugewiesen</span> : null}</> : <ObjectStatus state="Critical">nicht erkannt</ObjectStatus>}
                        {' '}<Button design="Transparent" icon="edit" tooltip="Mitglied/Kunden zuweisen" disabled={busy || z.vorhanden} onClick={() => waehlen(z)} />
                      </td>
                      <td>{dat(z.ausgabe)}</td><td>{z.ausgegeben_von}</td><td style={{ textAlign: 'right' }}>{z.pfand != null ? eur(z.pfand) : ''}</td>
                      <td>{dat(z.rueckgabe)}</td><td>{z.empfangen_von}</td><td>{[z.doc_ausgabe, z.doc_rueckgabe].filter(Boolean).join(' / ')}</td>
                      <td>{[z.schluessel_nr ? `Nr. ${z.schluessel_nr}` : '', z.bemerkung].filter(Boolean).join(' · ')}</td>
                      <td>{(z.pfand ?? 0) > 0 && <CheckBox checked={an && buchen.has(z.zeile)} disabled={!an} onChange={(e) => setBuchen(umschalten(buchen, z.zeile, e.target.checked))} />}</td>
                      <td>{z.fehler.length ? <ObjectStatus state={nurPerson ? 'Critical' : 'Negative'}>{z.fehler.join('; ')}</ObjectStatus> : z.hinweise.length ? z.hinweise.join('; ') : <ObjectStatus state="Positive">in Ordnung</ObjectStatus>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
            {zuweisen && (
              <div className="portal-ih__rahmen" style={{ padding: '0.5rem' }}>
                <Label showColon>Zeile {zuweisen.zeile} „{zuweisen.person}“ – Mitglied oder Kunden zuweisen</Label>
                {zuweisen.vorschlaege.map((x) => (
                  <div key={x.adrnr} className="portal-ih__zeile" style={{ padding: '0.25rem 0.5rem' }} onClick={() => vorschau({ ...zuordnung, [zuweisen.zeile]: x.adrnr })}>
                    {x.name} <span className="portal-muted">· {x.info} · Vorschlag</span>
                  </div>
                ))}
                <Input style={{ width: '100%' }} placeholder="Name suchen (mind. 2 Zeichen)" value={q} onInput={(e) => setQ(e.target.value)} />
                {!personen && <BusyIndicator active />}
                {treffer.map((x) => (
                  <div key={x.adrnr} className="portal-ih__zeile" style={{ padding: '0.25rem 0.5rem' }} onClick={() => vorschau({ ...zuordnung, [zuweisen.zeile]: x.adrnr })}>
                    {x.name} <span className="portal-muted">· {x.info}</span>
                  </div>
                ))}
                {zuordnung[zuweisen.zeile] && <Button design="Transparent" onClick={() => { const z = { ...zuordnung }; delete z[zuweisen.zeile]; vorschau(z); }}>Zuweisung aufheben</Button>}
                <Button design="Transparent" onClick={() => setZuweisen(null)}>Abbrechen</Button>
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

/**
 * Abgleich mit früheren Kontobewegungen: Buchungen der FI-Belege auf zwei wählbaren Konten gegen die Schlüsselvorgänge.
 * Vorschläge (Rechnung, Name im Buchungstext, Betrag, Datum) lassen sich gesammelt übernehmen; es wird nichts gebucht.
 */
function AbgleichDialog({ onClose }: { onClose: () => void }) {
  interface Kand { id: number; nummer: string; person: string; datum: string; art_txt: string; grund?: string }
  interface AZeile {
    internenr: string; konto: string; konto_name: string; datum: string; text: string; betrag: number; richtung: string; richtung_txt: string; rgnr: string | null; belege: number[];
    status: 'VERKNUEPFT' | 'VORSCHLAG' | 'MEHRDEUTIG' | 'OFFEN'; vorgang: Kand | null; kandidaten: Kand[]; grund: string; person: { adrnr: string; name: string; info: string } | null;
  }
  interface A { konto1: string; konto2: string; namen: Texte; zeilen: AZeile[]; ohneBuchung: Kand[]; summe: { buchungen: number; verknuepft: number; vorschlag: number; mehrdeutig: number; offen: number } }
  interface P { adrnr: string; name: string; info: string }
  const [a, setA] = useState<A | null>(null);
  const [konten, setKonten] = useState({ konto1: '', konto2: '' });
  const [wahl, setWahl] = useState<Record<string, number>>({});
  const [nurOffen, setNurOffen] = useState(true);
  const [neu, setNeu] = useState<AZeile | null>(null);
  const [personen, setPersonen] = useState<P[] | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = (z: AZeile) => `${z.internenr}:${z.richtung}`;
  async function laden() {
    try {
      const d = await api.get<A>(`${S}/abgleich/daten`);
      setA(d); setKonten({ konto1: d.konto1, konto2: d.konto2 });
      setWahl(Object.fromEntries(d.zeilen.filter((z) => z.status === 'VORSCHLAG' && z.vorgang).map((z) => [key(z), z.vorgang!.id])));
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { laden(); }, []);
  async function tun(fn: () => Promise<{ text: string }>) {
    setBusy(true); setError(null);
    try { toast((await fn()).text, 6000); setNeu(null); setQ(''); await laden(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const paare = (a?.zeilen ?? []).filter((z) => z.status !== 'VERKNUEPFT' && wahl[key(z)]).map((z) => ({ internenr: z.internenr, vorgang_id: wahl[key(z)] }));
  const zeilen = (a?.zeilen ?? []).filter((z) => !nurOffen || z.status !== 'VERKNUEPFT');
  function anlegen(z: AZeile) {
    if (z.person) { tun(() => api.post(`${S}/abgleich/anlegen`, { internenr: z.internenr, richtung: z.richtung, adrnr: z.person!.adrnr })); return; }
    setNeu(z); setQ('');
    if (!personen) api.get<P[]>(`${S}/personen`).then(setPersonen).catch((e) => setError((e as Error).message));
  }
  const such = q.trim().toLowerCase();
  const treffer = such.length < 2 ? [] : (personen ?? []).filter((p) => p.name.toLowerCase().includes(such)).slice(0, 12);
  const STAT: Record<AZeile['status'], { t: string; s: 'Positive' | 'Information' | 'Critical' | 'None' }> = {
    VERKNUEPFT: { t: 'verknüpft', s: 'Positive' }, VORSCHLAG: { t: 'Vorschlag', s: 'Information' }, MEHRDEUTIG: { t: 'mehrdeutig', s: 'Critical' }, OFFEN: { t: 'kein Vorgang', s: 'None' },
  };
  return (
    <Dialog open headerText="Abgleich mit Kontobewegungen (FI-Belege)" style={{ width: 'min(78rem, 98vw)' }} onClose={() => onClose()}
            footer={<Bar endContent={<>
              <Button design="Emphasized" icon="accept" loading={busy} disabled={!paare.length} onClick={() => tun(() => api.post(`${S}/abgleich/verknuepfen`, { paare }))}>{paare.length} Verknüpfung(en) übernehmen</Button>
              <Button onClick={() => onClose()}>Schließen</Button>
            </>} />}>
      <div className="portal-bk__form">
        {error && <MessageStrip design="Negative" onClose={() => setError(null)}><span style={{ whiteSpace: 'pre-line' }}>{error}</span></MessageStrip>}
        <Text className="portal-muted portal-small">
          Alle nicht stornierten Buchungen auf den beiden Konten werden den Schlüsselvorgängen gegenübergestellt (Rechnung, Name im Buchungstext, Betrag, Datum).
          Verknüpfen trägt die FI-Buchung am Vorgang ein und hängt dessen Beleg an die Buchung – es wird nichts gebucht.
        </Text>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'end', flexWrap: 'wrap' }}>
          <div><Label showColon>Konto 1</Label><br /><Input style={{ width: '8rem' }} maxlength={10} value={konten.konto1} onInput={(e) => setKonten({ ...konten, konto1: e.target.value.trim() })} /></div>
          <div><Label showColon>Konto 2</Label><br /><Input style={{ width: '8rem' }} maxlength={10} value={konten.konto2} onInput={(e) => setKonten({ ...konten, konto2: e.target.value.trim() })} /></div>
          <Button icon="synchronize" disabled={busy || !a || (konten.konto1 === a.konto1 && konten.konto2 === a.konto2)} onClick={() => tun(() => api.put(`${S}/abgleich/konten`, konten))}>Konten übernehmen</Button>
          {a && <Text className="portal-muted portal-small">{[a.konto1, a.konto2].map((k) => `${k} ${a.namen[k] ?? ''}`.trim()).join(' · ')}</Text>}
          <CheckBox text="nur nicht verknüpfte" checked={nurOffen} onChange={(e) => setNurOffen(e.target.checked)} />
        </div>
        {!a ? <BusyIndicator active /> : (
          <>
            <MessageStrip design="Information" hideCloseButton>
              {a.summe.buchungen} Buchung(en): {a.summe.verknuepft} verknüpft, {a.summe.vorschlag} mit Vorschlag, {a.summe.mehrdeutig} mehrdeutig, {a.summe.offen} ohne Vorgang
              {a.ohneBuchung.length ? ` · ${a.ohneBuchung.length} Vorgang/Vorgänge mit Pfand ohne Buchung` : ''}
            </MessageStrip>
            <div className="portal-ih__rahmen" style={{ maxHeight: '46vh', overflowY: 'auto' }}><table className="portal-ih__tabelle">
              <thead><tr><th>Datum</th><th>Buchung</th><th>Konto</th><th>Art</th><th style={{ textAlign: 'right' }}>Betrag</th><th>Buchungstext</th><th>Status</th><th>Schlüsselvorgang</th><th /></tr></thead>
              <tbody>
                {!zeilen.length && <tr><td colSpan={9} className="portal-muted">Keine Buchungen.</td></tr>}
                {zeilen.map((z) => (
                  <tr key={key(z)} className={z.status === 'VERKNUEPFT' ? 'portal-ih__inaktiv' : undefined}>
                    <td>{dat(z.datum)}</td>
                    <td><Link href={`/tco/fi?buchung=${encodeURIComponent(z.internenr)}`} target="_blank">{z.internenr}</Link></td>
                    <td title={z.konto_name}>{z.konto}</td><td>{z.richtung_txt}</td><td style={{ textAlign: 'right' }}>{eur(z.betrag)}</td>
                    <td>{z.text}{z.rgnr ? <span className="portal-muted"> · Rg. {z.rgnr}</span> : null}</td>
                    <td><ObjectStatus state={STAT[z.status].s}>{STAT[z.status].t}</ObjectStatus></td>
                    <td>
                      {z.status === 'VERKNUEPFT' && z.vorgang && <>{z.vorgang.nummer} · {z.vorgang.person}</>}
                      {(z.status === 'VORSCHLAG' || z.status === 'MEHRDEUTIG') && (
                        <>
                          <select value={wahl[key(z)] ?? ''} onChange={(e) => setWahl({ ...wahl, [key(z)]: Number(e.target.value) })}>
                            <option value="">– nicht verknüpfen –</option>
                            {z.kandidaten.map((k) => <option key={k.id} value={k.id}>{k.nummer} · {k.person} · {dat(k.datum)}</option>)}
                          </select>
                          <div className="portal-muted portal-small">{z.kandidaten.find((k) => k.id === wahl[key(z)])?.grund ?? z.grund}</div>
                        </>
                      )}
                      {z.status === 'OFFEN' && (z.person ? <span className="portal-muted">{z.person.name} · {z.person.info}</span> : <span className="portal-muted">Person nicht erkannt</span>)}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {z.status === 'VERKNUEPFT' && z.vorgang && <Button design="Transparent" icon="disconnected" tooltip="Verknüpfung lösen" disabled={busy} onClick={() => tun(() => api.post(`${S}/abgleich/loesen`, { vorgang_id: z.vorgang!.id }))} />}
                      {z.status === 'OFFEN' && <Button design="Transparent" icon="add" disabled={busy} tooltip="Altfall-Vorgang aus dieser Buchung anlegen" onClick={() => anlegen(z)}>Vorgang anlegen</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
            {neu && (
              <div className="portal-ih__rahmen" style={{ padding: '0.5rem' }}>
                <Label showColon>{neu.richtung_txt} vom {dat(neu.datum)} ({eur(neu.betrag)}, „{neu.text}“) – Person wählen</Label>
                <Input style={{ width: '100%' }} placeholder="Name suchen (mind. 2 Zeichen)" value={q} onInput={(e) => setQ(e.target.value)} />
                {!personen && <BusyIndicator active />}
                {treffer.map((p) => (
                  <div key={p.adrnr} className="portal-ih__zeile" style={{ padding: '0.25rem 0.5rem' }} onClick={() => tun(() => api.post(`${S}/abgleich/anlegen`, { internenr: neu.internenr, richtung: neu.richtung, adrnr: p.adrnr }))}>
                    {p.name} <span className="portal-muted">· {p.info}</span>
                  </div>
                ))}
                <Button design="Transparent" onClick={() => setNeu(null)}>Abbrechen</Button>
              </div>
            )}
            {a.ohneBuchung.length > 0 && (
              <Text className="portal-muted portal-small">Vorgänge mit Pfand ohne FI-Buchung und ohne Hallenrechnung: {a.ohneBuchung.map((v) => `${v.nummer} ${v.person} (${v.art_txt} ${dat(v.datum)})`).join(' · ')}</Text>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

function EinstellungenDialog({ onClose }: { onClose: Fertig }) {
  interface Cfg { bedingungen: string; bedingungen_text: string; quittung_tage: number; link_tage: number; kassenkonto: string; pfand: { ausgabe: number; rueckgabe: number; kontoAusgabe: string; kontoRueckgabe: string } }
  const [c, setC] = useState<Cfg | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.get<Cfg>(`${S}/einstellungen/daten`).then(setC).catch((e) => setError((e as Error).message)); }, []);
  async function sichern() {
    if (!c) return;
    try { onClose(await api.put<{ text: string }>(`${S}/einstellungen/daten`, { bedingungen: c.bedingungen, quittung_tage: Number(c.quittung_tage), link_tage: Number(c.link_tage), kassenkonto: c.kassenkonto })); }
    catch (e) { setError((e as Error).message); }
  }
  return (
    <Dialog open headerText="Einstellungen Hallenschlüssel" style={{ width: 'min(40rem, 96vw)' }} onClose={() => onClose()}
            footer={<Bar endContent={<><Button design="Emphasized" icon="save" disabled={!c} onClick={sichern}>Sichern</Button><Button onClick={() => onClose()}>Abbrechen</Button></>} />}>
      {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
      {!c ? <BusyIndicator active /> : (
        <div className="portal-bk__form">
          <MessageStrip design="Information" hideCloseButton>
            Pfand und Konto kommen aus den Hallenprodukten (Hallenpreise): Ausgabe {eur(c.pfand.ausgabe)} auf Konto {c.pfand.kontoAusgabe}, Rückgabe {eur(c.pfand.rueckgabe)} auf Konto {c.pfand.kontoRueckgabe}.
          </MessageStrip>
          <Label showColon>Spielregeln zum Schlüssel (Beleg und Online-Quittung)</Label>
          <TextArea rows={8} maxlength={4000} value={c.bedingungen} placeholder={c.bedingungen_text} onInput={(e) => setC({ ...c, bedingungen: e.target.value })} />
          <Text className="portal-muted portal-small">Leer = Standardtext (wird als Platzhalter angezeigt).</Text>
          <Label showColon>Hinweis im Arbeitsvorrat, wenn nach … Tagen nicht quittiert</Label>
          <Input type="Number" value={String(c.quittung_tage)} onInput={(e) => setC({ ...c, quittung_tage: Number(e.target.value) })} />
          <Label showColon>Quittungslink gültig (Tage)</Label>
          <Input type="Number" value={String(c.link_tage)} onInput={(e) => setC({ ...c, link_tage: Number(e.target.value) })} />
          <Label showColon>Kassenkonto für Altdaten</Label>
          <Input value={c.kassenkonto} maxlength={10} onInput={(e) => setC({ ...c, kassenkonto: e.target.value })} />
        </div>
      )}
    </Dialog>
  );
}

function VarianteDialog({ ansicht, vorschlag, admin, onClose }: { ansicht: Ansicht; vorschlag?: Variante; admin: boolean; onClose: (v: Variante | null) => void }) {
  const [name, setName] = useState(vorschlag?.name ?? '');
  const [standard, setStandard] = useState(vorschlag?.standard ?? false);
  const [global, setGlobal] = useState(vorschlag?.global ?? false);
  const [error, setError] = useState<string | null>(null);
  async function sichern() {
    try {
      const r = await api.post<{ text: string; variante: Omit<Variante, 'ansicht'> }>(`${S}/varianten/liste`, { name, standard, global, ansicht });
      toast(r.text); onClose({ ...r.variante, ansicht });
    } catch (e) { setError((e as Error).message); }
  }
  return (
    <Dialog open headerText="Variante sichern" style={{ width: 'min(26rem, 96vw)' }} onClose={() => onClose(null)}
            footer={<Bar endContent={<><Button design="Emphasized" icon="save" onClick={sichern}>Sichern</Button><Button onClick={() => onClose(null)}>Abbrechen</Button></>} />}>
      <div className="portal-bk__form">
        {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
        <Label showColon required>Name</Label>
        <Input value={name} maxlength={30} onInput={(e) => setName(e.target.value)} />
        <CheckBox text="Als Standard beim Öffnen laden" checked={standard} onChange={(e) => setStandard(e.target.checked)} />
        {admin && <CheckBox text="Für alle Benutzer" checked={global} onChange={(e) => setGlobal(e.target.checked)} />}
      </div>
    </Dialog>
  );
}
