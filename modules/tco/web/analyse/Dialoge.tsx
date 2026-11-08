import { useState } from 'react';
import { Button, CheckBox, FlexBox, Label, MessageStrip, Option, Select, Title } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { CheckField, FormGrid, TextField } from '@core/components/FormFields';
import { Auswahlfeld, Dlg } from '../mitglieder/Dialoge';
import { AN, FILTER_STANDARD, type Filter, type Init, type Sicht, type Spalte, type Variante } from './typen';

const mitAlle = (l: string[], alle = 'alle'): [string, string][] => [['', alle], ...l.map((x) => [x, x] as [string, string])];

/** Filter und Sortierung (POPUP_FILTER) – Arbeitsstand wird erst mit „Übernehmen“ wirksam */
export function FilterDialog({ init, filter, onClose }: { init: Init; filter: Filter; onClose: (f: Filter | null) => void }) {
  const [f, setF] = useState<Filter>({ ...filter });
  const s = (k: keyof Filter) => (v: string) => setF({ ...f, [k]: v });
  return (
    <Dlg titel="Filter und Sortierung" onClose={() => onClose(null)} breite="min(900px, 95vw)"
         fuss={<>
           <Button icon="clear-filter" onClick={() => setF({ ...FILTER_STANDARD, status: '', vertrag_scope: '' })}>Alle Filter löschen</Button>
           <Button design="Emphasized" onClick={() => onClose(f)}>Übernehmen</Button>
         </>}>
      <Title level="H5" style={{ marginBottom: '0.5rem' }}>Mitglied</Title>
      <FormGrid>
        <Auswahlfeld label="Status" value={f.status} optionen={[['', 'alle'], ['A', 'nur aktive'], ['X', 'nur ausgetretene']]} onChange={s('status')} />
        <Auswahlfeld label="Geschlecht" value={f.geschlecht} optionen={mitAlle(init.werte.geschlechter)} onChange={s('geschlecht')} />
        <Auswahlfeld label="Altersgruppe" value={f.altersgruppe} optionen={mitAlle(init.werte.altersgruppen)} onChange={s('altersgruppe')} />
        <Auswahlfeld label="Ort" value={f.ort} optionen={mitAlle(init.werte.orte)} onChange={s('ort')} />
        <TextField label="Alter von" value={f.alter_von} onChange={s('alter_von')} placeholder="z.B. 18" />
        <TextField label="Alter bis" value={f.alter_bis} onChange={s('alter_bis')} placeholder="z.B. 60" />
        <TextField label="PLZ enthält" value={f.plz} onChange={s('plz')} placeholder="z.B. 666" />
        <TextField label="Eintritt Jahr von" value={f.eintritt_von} onChange={s('eintritt_von')} placeholder="JJJJ" />
        <TextField label="Eintritt Jahr bis" value={f.eintritt_bis} onChange={s('eintritt_bis')} placeholder="JJJJ" />
        <Auswahlfeld label="Zahlungsart" value={f.zahlungsart} optionen={mitAlle(init.werte.zahlungsarten)} onChange={s('zahlungsart')} />
        <Auswahlfeld label="Zahlungsweise" value={f.zahlweise} optionen={mitAlle(init.werte.zahlweisen)} onChange={s('zahlweise')} />
      </FormGrid>
      <Title level="H5" style={{ margin: '1rem 0 0.5rem' }}>Verträge</Title>
      <FormGrid>
        <Auswahlfeld label="Vertragsart" value={f.vertragsart} optionen={mitAlle(init.werte.vertragsarten)} onChange={s('vertragsart')} />
        <Auswahlfeld label="Vertragsstatus" value={f.vertrag_scope} optionen={[['', 'alle Verträge'], ['A', 'nur aktive Verträge'], ['B', 'nur beendete Verträge']]} onChange={s('vertrag_scope')} />
        <Auswahlfeld label="Vertragsbestand" value={f.vertragsbest} optionen={[['', 'alle Mitglieder'], ['M', 'nur mit Vertrag'], ['O', 'nur ohne Vertrag']]} onChange={s('vertragsbest')} />
      </FormGrid>
      <Title level="H5" style={{ margin: '1rem 0 0.5rem' }}>Sortierung</Title>
      <FormGrid>
        <Auswahlfeld label="Sortieren nach" value={f.sort_by} optionen={init.sortierungen} onChange={s('sort_by')} />
        <CheckField label="Richtung" checked={f.sort_desc} onChange={(v) => setF({ ...f, sort_desc: v })} />
      </FormGrid>
      <Label style={{ display: 'block', marginTop: '0.5rem' }}>Alle Kriterien wirken UND-verknüpft. Richtung angehakt = absteigend.</Label>
    </Dlg>
  );
}

/** Spaltenauswahl (POPUP_COLUMNS) */
export function SpaltenDialog({ spalten, cols, onClose }: { spalten: Spalte[]; cols: string[]; onClose: (cols: string[] | null) => void }) {
  const [sel, setSel] = useState<string[]>(cols);
  const toggle = (f: string, an: boolean) => setSel(an ? [...new Set([...sel, f])] : sel.filter((x) => x !== f));
  return (
    <Dlg titel="Spalten auswählen" onClose={() => onClose(null)} breite="min(480px, 95vw)"
         fuss={<>
           <Button onClick={() => setSel(spalten.map((s) => s.field))}>Alle</Button>
           <Button onClick={() => setSel([])}>Keine</Button>
           <Button design="Emphasized" disabled={!sel.length} onClick={() => onClose(sel)}>Übernehmen</Button>
         </>}>
      <FlexBox direction="Column">
        {spalten.map((s) => <CheckBox key={s.field} text={s.label} checked={sel.includes(s.field)} onChange={(e) => toggle(s.field, e.target.checked)} />)}
      </FlexBox>
    </Dlg>
  );
}

/** Anzeigevarianten (POPUP_VARIANTS): laden, löschen, aktuelle Sicht sichern */
export function VariantenDialog({ varianten, aktuell, sicht, onClose }: {
  varianten: Variante[]; aktuell: Variante | null; sicht: Sicht;
  onClose: (r: { varianten: Variante[]; geladen?: { variante: Variante; sicht: Sicht }; variante?: Variante | null; text?: string } | null) => void;
}) {
  const [liste, setListe] = useState(varianten);
  const [sel, setSel] = useState(aktuell?.key ?? liste[0]?.key ?? '');
  const [v, setV] = useState({ name: aktuell?.name ?? '', descr: aktuell?.descr ?? '', global: aktuell?.global ?? false, isdef: aktuell?.isdef ?? false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lauf = async (fn: () => Promise<void>) => { setBusy(true); setError(null); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return (
    <Dlg titel="Anzeigevarianten" onClose={() => onClose({ varianten: liste })} breite="min(560px, 95vw)"
         fuss={<Button design="Emphasized" disabled={busy || !v.name.trim()} onClick={() => lauf(async () => {
           const r = await api.post<{ variante: Variante; varianten: Variante[]; text: string }>(`${AN}/varianten`, { ...v, sicht });
           onClose({ varianten: r.varianten, variante: r.variante, text: r.text });
         })}>Sichern</Button>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <Title level="H5" style={{ marginBottom: '0.5rem' }}>Vorhandene Variante</Title>
      {liste.length ? (
        <FlexBox alignItems="End" style={{ gap: '0.5rem' }} wrap="Wrap">
          <div style={{ flex: '1 1 16rem' }}>
            <Label showColon>Variante</Label>
            <Select style={{ width: '100%' }} onChange={(e) => setSel((e.detail.selectedOption as HTMLElement).dataset.k ?? '')}>
              {liste.map((x) => <Option key={x.key} data-k={x.key} selected={x.key === sel}>{x.text}</Option>)}
            </Select>
          </div>
          <Button icon="open-folder" disabled={busy || !sel} onClick={() => lauf(async () => {
            const r = await api.get<{ variante: Variante; sicht: Sicht }>(`${AN}/varianten/laden?key=${encodeURIComponent(sel)}`);
            onClose({ varianten: liste, geladen: r });
          })}>Laden</Button>
          <Button icon="delete" disabled={busy || !sel} onClick={() => lauf(async () => {
            const r = await api.post<{ varianten: Variante[]; text: string }>(`${AN}/varianten/loeschen`, { key: sel });
            setListe(r.varianten); setSel(r.varianten[0]?.key ?? '');
            if (aktuell?.key === sel) onClose({ varianten: r.varianten, variante: null, text: r.text });
          })}>Löschen</Button>
        </FlexBox>
      ) : <Label>Noch keine Varianten gesichert.</Label>}
      <Title level="H5" style={{ margin: '1rem 0 0.5rem' }}>Aktuelle Sicht sichern</Title>
      <FormGrid>
        <TextField label="Name" required value={v.name} onChange={(x) => setV({ ...v, name: x.toUpperCase() })} placeholder="z.B. BEITRAEGE" />
        <TextField label="Beschreibung" value={v.descr} onChange={(x) => setV({ ...v, descr: x })} />
        <CheckField label="Sichtbarkeit: für alle Benutzer" checked={v.global} onChange={(x) => setV({ ...v, global: x })} />
        <CheckField label="Vorschlag: beim Start automatisch laden" checked={v.isdef} onChange={(x) => setV({ ...v, isdef: x })} />
      </FormGrid>
      <Label style={{ display: 'block', marginTop: '0.5rem' }}>Gesichert werden Spaltenauswahl, alle Filter, Sortierung, Gruppierung und Details.</Label>
    </Dlg>
  );
}
