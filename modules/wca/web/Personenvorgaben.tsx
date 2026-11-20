import { useEffect, useMemo, useState } from 'react';
import { Button, CheckBox, DatePicker, Input, MessageStrip, MultiComboBox, MultiComboBoxItem } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { Section } from '@core/components/Section';
import { toast } from '@core/toast';
import type { PersonVorgabe } from '../server/typen';
import type { EinstellungenAntwort } from './Pruefregeln';
import { eingabeZahl, W, WOCHENTAGE, zahlEingabe } from './util';

const leer = (person: string): PersonVorgabe => ({ person, standort: null, sollTag: null, arbeitstage: null, von: null, bis: null, ausblenden: false });
const gleich = (a: PersonVorgabe, b: PersonVorgabe) => JSON.stringify(a) === JSON.stringify(b);

/** Vorgaben je Person: überschreiben die abgeleiteten Werte (leer = abgeleitet); „Ausblenden“ nimmt die Person aus allen Ansichten */
export function Personenvorgaben({ daten, edit, onGeaendert }: { daten: EinstellungenAntwort; edit: boolean; onGeaendert: () => void }) {
  const [suche, setSuche] = useState('');
  const [nurGesetzt, setNurGesetzt] = useState(false);
  const zeilen = useMemo(() => {
    const m = new Map(daten.vorgaben.map((v) => [v.person, v]));
    const alle = [...new Set([...daten.personen, ...m.keys()])].sort((x, y) => x.localeCompare(y, 'de'));
    return alle.map((p) => ({ gespeichert: m.get(p) ?? null, person: p }));
  }, [daten]);
  const s = suche.trim().toLowerCase();
  const sichtbar = zeilen.filter((z) => (!s || z.person.toLowerCase().includes(s)) && (!nurGesetzt || z.gespeichert));

  return (
    <Section title="Personenvorgaben" count={daten.vorgaben.length} flush
             actions={<>
               <Input placeholder="Person …" value={suche} showClearIcon onInput={(e) => setSuche(e.target.value)} style={{ width: '12rem' }} />
               <CheckBox text="nur mit Vorgabe" checked={nurGesetzt} onChange={(e) => setNurGesetzt(e.target.checked)} />
             </>}>
      <p className="portal-muted portal-small" style={{ padding: '0 1rem' }}>
        Leere Felder werden aus den Buchungen abgeleitet (Standort aus den internen Projekten, Soll je Tag und Arbeitstage aus den letzten Wochen,
        Im Team von–bis aus erster und letzter Buchung). Ausgeblendete Personen erscheinen in keiner Ansicht.
      </p>
      {sichtbar.length ? (
        <div className="portal-tabrahmen">
          <table className="portal-wca-tabelle portal-wca-vorgaben">
            <thead>
              <tr><th>Person</th><th>Standort</th><th>Soll h/Tag</th><th>Arbeitstage</th><th>Von</th><th>Bis</th><th>Ausblenden</th><th /></tr>
            </thead>
            <tbody>
              {sichtbar.map((z) => <VorgabeZeile key={z.person} person={z.person} gespeichert={z.gespeichert} edit={edit} onGeaendert={onGeaendert} />)}
            </tbody>
          </table>
        </div>
      ) : <div className="portal-empty">Keine Personen – erst Zeitexporte importieren.</div>}
    </Section>
  );
}

function VorgabeZeile({ person, gespeichert, edit, onGeaendert }: { person: string; gespeichert: PersonVorgabe | null; edit: boolean; onGeaendert: () => void }) {
  const basis = gespeichert ?? leer(person);
  const [v, setV] = useState<PersonVorgabe>(basis);
  const [soll, setSoll] = useState(zahlEingabe(basis.sollTag));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loeschen, setLoeschen] = useState(false);
  useEffect(() => { setV(basis); setSoll(zahlEingabe(basis.sollTag)); }, [gespeichert]); // eslint-disable-line react-hooks/exhaustive-deps
  const geaendert = !gleich(v, basis);
  const ro = !edit;
  const set = (t: Partial<PersonVorgabe>) => setV((alt) => ({ ...alt, ...t }));

  async function speichern() {
    setBusy(true); setError(null);
    try {
      const { person: _p, ...body } = v; // eslint-disable-line @typescript-eslint/no-unused-vars
      await api.put(`${W}/personen/${encodeURIComponent(person)}`, body);
      toast(`Vorgabe für ${person} gesichert`);
      onGeaendert();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function entfernen() {
    setLoeschen(false);
    setBusy(true); setError(null);
    try {
      await api.del(`${W}/personen/${encodeURIComponent(person)}`);
      toast(`Vorgabe für ${person} gelöscht`);
      onGeaendert();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <tr>
      <td>
        {person}
        {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
      </td>
      <td><Input style={{ width: '4.5rem' }} value={v.standort ?? ''} placeholder="abgel." readonly={ro} onInput={(e) => set({ standort: e.target.value.trim().toUpperCase() || null })} /></td>
      <td>
        <Input style={{ width: '5rem' }} value={soll} placeholder="abgel." readonly={ro}
               onInput={(e) => { setSoll(e.target.value); set({ sollTag: eingabeZahl(e.target.value) }); }} />
      </td>
      <td>
        <MultiComboBox style={{ width: '12rem' }} readonly={ro} noTypeahead placeholder="abgeleitet" accessibleName={`Arbeitstage ${person}`}
                       onSelectionChange={(e) => {
                         const tage = (e.detail.items as unknown as HTMLElement[]).map((i) => Number(i.dataset.t)).sort();
                         set({ arbeitstage: tage.length ? tage : null });
                       }}>
          {WOCHENTAGE.map((t, i) => <MultiComboBoxItem key={t} data-t={i} text={t} selected={!!v.arbeitstage?.includes(i)} />)}
        </MultiComboBox>
      </td>
      <td><DatePicker style={{ width: '9rem' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={v.von ?? ''} readonly={ro} onChange={(e) => set({ von: e.detail.value || null })} /></td>
      <td><DatePicker style={{ width: '9rem' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={v.bis ?? ''} readonly={ro} onChange={(e) => set({ bis: e.detail.value || null })} /></td>
      <td><CheckBox checked={v.ausblenden} readonly={ro} accessibleName={`${person} ausblenden`} onChange={(e) => set({ ausblenden: e.target.checked })} /></td>
      <td className="portal-nowrap">
        {edit && <Button design="Emphasized" icon="save" tooltip="Sichern" disabled={!geaendert} loading={busy} onClick={speichern} />}
        {edit && geaendert && <Button design="Transparent" icon="undo" tooltip="Verwerfen" onClick={() => { setV(basis); setSoll(zahlEingabe(basis.sollTag)); }} />}
        {edit && gespeichert && <Button design="Transparent" icon="delete" tooltip="Vorgabe löschen (wieder ableiten)" disabled={busy} onClick={() => setLoeschen(true)} />}
        {gespeichert && <ChangeHistoryButton objectType="WCA_PERSON" objectKey={person} />}
        <ConfirmDialog open={loeschen} title="Vorgabe löschen" confirmText="Löschen" danger
                       text={`Vorgabe für ${person} löschen? Danach gelten wieder die abgeleiteten Werte.`}
                       onConfirm={entfernen} onCancel={() => setLoeschen(false)} />
      </td>
    </tr>
  );
}
