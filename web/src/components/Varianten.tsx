import { useEffect, useRef, useState } from 'react';
import { Bar, Button, CheckBox, Dialog, Input, Label, MessageStrip, Option, Select } from '@ui5/webcomponents-react';
import { api } from '../api';
import { toast } from '../toast';

/**
 * Ansichtsvarianten für Apps mit Tabellen (Vorbild: Hallenschlüssel): Die aktuelle Auswahl einer App – Filter, Suche,
 * Sortierung, Zeitraum … – lässt sich unter einem Namen sichern und wieder abrufen, je Benutzer, optional als Standard
 * (wird beim Öffnen geladen) oder für alle Benutzer.
 *
 * Die App übergibt ihre Auswahl als einfaches Objekt (`ansicht`, nur JSON-Werte) und übernimmt eine gewählte Variante in
 * `onAnwenden` – dort setzt sie nur die Felder, die die Variante enthält und die den erwarteten Typ haben (siehe `feld`).
 * An der App selbst ändert sich sonst nichts. `leer` ist die Ansicht ohne Variante („Standardansicht“).
 */
export interface VariantenProps<T extends Record<string, unknown>> {
  /** Kennung der Liste, z. B. 'tco.konten' */
  repid: string;
  ansicht: T;
  onAnwenden: (a: Partial<T>) => void;
  /** Ansicht für „Standardansicht“; ohne Angabe die Ansicht beim ersten Anzeigen */
  leer?: T;
}
interface Variante { key: string; name: string; global: boolean; standard: boolean; ansicht: Record<string, unknown> }

/** Feld einer gespeicherten Variante übernehmen, wenn es vorhanden ist und denselben Typ wie die Vorgabe hat */
export function feld<V>(a: Record<string, unknown>, k: string, vorgabe: V): V {
  const v = a[k];
  if (v === undefined) return vorgabe;
  if (vorgabe === null || vorgabe === undefined) return v as V;
  if (Array.isArray(vorgabe)) return (Array.isArray(v) ? v : vorgabe) as V;
  return (typeof v === typeof vorgabe || v === null ? v : vorgabe) as V;
}

export function Varianten<T extends Record<string, unknown>>({ repid, ansicht, onAnwenden, leer }: VariantenProps<T>) {
  const [varianten, setVarianten] = useState<Variante[]>([]);
  const [global, setGlobal] = useState(false);
  const [aktiv, setAktiv] = useState('');
  const [dlg, setDlg] = useState(false);
  const start = useRef(leer ?? ansicht);
  const anwenden = useRef(onAnwenden);
  anwenden.current = onAnwenden;
  useEffect(() => {
    let weg = false;
    api.get<{ varianten: Variante[]; standard: Variante | null; global: boolean }>(`/api/varianten/${encodeURIComponent(repid)}`).then((r) => {
      if (weg) return;
      setVarianten(r.varianten); setGlobal(r.global);
      // Standardvariante beim Öffnen – nicht bei einem Absprung mit Vorgaben in der Adresse (z. B. ?buchung=…)
      if (r.standard && !window.location.search) { setAktiv(r.standard.key); anwenden.current(r.standard.ansicht as Partial<T>); }
    }).catch(() => undefined);
    return () => { weg = true; };
  }, [repid]);
  const variante = varianten.find((v) => v.key === aktiv);
  async function loeschen() {
    if (!variante) return;
    try {
      const r = await api.del<{ text: string }>(`/api/varianten/${encodeURIComponent(repid)}`, { key: variante.key });
      toast(r.text); setVarianten(varianten.filter((v) => v.key !== variante.key)); setAktiv('');
    } catch (e) { toast((e as Error).message, 6000); }
  }
  return (
    <span className="portal-varianten" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', flexWrap: 'wrap' }}>
      <Select style={{ minWidth: '11rem' }} accessibleName="Ansichtsvariante"
              onChange={(e) => {
                const key = (e.detail.selectedOption as HTMLElement).dataset.v ?? '';
                setAktiv(key);
                anwenden.current((key ? varianten.find((v) => v.key === key)?.ansicht ?? {} : start.current) as Partial<T>);
              }}>
        <Option data-v="" selected={!aktiv}>Standardansicht</Option>
        {varianten.map((v) => <Option key={v.key} data-v={v.key} selected={aktiv === v.key}>{v.name}{v.standard ? ' ★' : ''}{v.global ? ' (für alle)' : ''}</Option>)}
      </Select>
      <Button design="Transparent" icon="save" tooltip="Aktuelle Ansicht als Variante sichern" accessibleName="Variante sichern" onClick={() => setDlg(true)} />
      {variante && (!variante.global || global) && <Button design="Transparent" icon="delete" tooltip="Variante löschen" accessibleName="Variante löschen" onClick={loeschen} />}
      {dlg && (
        <VarianteDialog repid={repid} ansicht={ansicht} vorschlag={variante} global={global} onClose={(v) => {
          setDlg(false);
          if (v) { setVarianten([...varianten.filter((x) => x.key !== v.key).map((x) => (v.standard && x.global === v.global ? { ...x, standard: false } : x)), v]); setAktiv(v.key); }
        }} />
      )}
    </span>
  );
}

function VarianteDialog({ repid, ansicht, vorschlag, global: darfGlobal, onClose }: { repid: string; ansicht: Record<string, unknown>; vorschlag?: Variante; global: boolean; onClose: (v: Variante | null) => void }) {
  const [name, setName] = useState(vorschlag?.name ?? '');
  const [standard, setStandard] = useState(vorschlag?.standard ?? false);
  const [global, setGlobal] = useState(vorschlag?.global ?? false);
  const [error, setError] = useState<string | null>(null);
  async function sichern() {
    try {
      const r = await api.post<{ text: string; variante: Variante }>(`/api/varianten/${encodeURIComponent(repid)}`, { name, standard, global, ansicht });
      toast(r.text); onClose(r.variante);
    } catch (e) { setError((e as Error).message); }
  }
  return (
    <Dialog open headerText="Variante sichern" style={{ width: 'min(26rem, 96vw)' }} onClose={() => onClose(null)}
            footer={<Bar endContent={<><Button design="Emphasized" disabled={!name.trim()} onClick={sichern}>Sichern</Button><Button onClick={() => onClose(null)}>Abbrechen</Button></>} />}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
        <Label showColon required>Name</Label>
        <Input value={name} maxlength={30} onInput={(e) => setName(e.target.value)} />
        <CheckBox text="als Standard beim Öffnen laden" checked={standard} onChange={(e) => setStandard(e.target.checked)} />
        {darfGlobal && <CheckBox text="für alle Benutzer" checked={global} onChange={(e) => setGlobal(e.target.checked)} />}
        <Label wrappingType="Normal">Gesichert wird die aktuelle Auswahl dieser App (Filter, Suche, Sortierung, Zeitraum). Ein vorhandener Name wird überschrieben.</Label>
      </div>
    </Dialog>
  );
}
