import { useEffect, useState } from 'react';
import { Bar, Button, ComboBox, ComboBoxItem, Dialog, Input, MessageStrip, Title } from '@ui5/webcomponents-react';
import { api, ApiError } from '@core/api';
import { FieldBox, FormGrid, TextField } from '@core/components/FormFields';
import { toast } from '@core/toast';
import { SperrHinweis, useSperre } from '@core/sperre';
import { LAENDER } from './laender';
import { T, type Adresse, type AdrDD } from './util';
import { AuswahlBox } from '@core/components/AuswahlBox';

const leer: Adresse = {
  kundenname: '', kundenname2: null, anrede: null, name: null, vorname: null, strasse: null, hausnummer: null, land: 'DE',
  plz: null, ort: null, telefon: null, fax: null, email: null, gln: null, markt: null, ustid: null,
};

/**
 * Kontakt anlegen oder bearbeiten (wie KONTAKT_POPUP_DISPLAY):
 * Bearbeiten nur für die Kontakte des geöffneten Auftrags; Dublettenprüfung –
 * beim zweiten Klick wird trotzdem gespeichert.
 */
export function KontaktDialog({ modus, auswahl, onClose, onSaved }: {
  modus: 'NEU' | 'EDIT' | null;
  auswahl: AdrDD[];
  onClose: () => void;
  onSaved: (adrnr: number) => void;
}) {
  const [nr, setNr] = useState<string>('');
  const [k, setK] = useState<Adresse>(leer);
  const [hinweis, setHinweis] = useState<string | null>(null);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!modus) return;
    setHinweis(null);
    setForce(false);
    if (modus === 'NEU') {
      setNr('');
      setK(leer);
    } else if (auswahl.length) {
      setNr(auswahl[0].key);
    }
  }, [modus]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (modus !== 'EDIT' || !nr) return;
    setForce(false);
    api.get<Adresse>(`${T}/adressen/${nr}`).then(setK).catch((e) => setHinweis(e.message));
  }, [nr, modus]);

  const set = (f: keyof Adresse) => (v: string) => {
    setK({ ...k, [f]: v });
    setForce(false);
  };

  async function save() {
    setBusy(true);
    try {
      const body = { ...k, force };
      const r = modus === 'EDIT'
        ? await api.put<{ adrnr: number }>(`${T}/adressen/${nr}`, body)
        : await api.post<{ adrnr: number }>(`${T}/adressen`, body);
      toast(modus === 'EDIT' ? `Kontakt "${k.kundenname}" gespeichert.` : `Kontakt "${k.kundenname}" angelegt - jetzt im Dropdown auswählbar.`);
      onSaved(r.adrnr);
    } catch (e) {
      setHinweis((e as Error).message);
      if (e instanceof ApiError && e.code === 'DUBLETTE') setForce(true);
    } finally {
      setBusy(false);
    }
  }

  const edit = modus === 'EDIT';
  const sperre = useSperre('ADRESSE', edit && nr ? nr : null, edit, { bezeichnung: `Kontakt ${k.kundenname || nr}` });
  return (
    <Dialog open={!!modus} headerText={edit ? 'Kontakt bearbeiten' : 'Neuer Kontakt'} onClose={onClose}
            style={{ width: 'min(56rem, 95vw)' }}
            footer={<Bar endContent={<>
              <Button design="Emphasized" icon={edit ? 'save' : 'add-contact'} loading={busy} disabled={edit && !sperre.eigen} onClick={save}>{edit ? 'Speichern' : 'Anlegen'}</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      {edit && <SperrHinweis s={sperre} style={{ marginBottom: '0.75rem' }} />}
      {hinweis && <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.75rem' }}>{hinweis}</MessageStrip>}
      {edit && (
        <>
          <MessageStrip hideCloseButton style={{ marginBottom: '0.75rem' }}>
            Auswählbar sind nur die Kontakte dieses Auftrags. Änderungen gelten für alle Aufträge, denen der Kontakt zugeordnet ist.
          </MessageStrip>
          <FieldBox label="Kontakt">
            <AuswahlBox wert={nr} leerErlaubt={false} eintraege={auswahl.map((a) => ({ key: a.key, text: a.text, zusatz: a.zusatz }))} onWaehle={(k) => setNr(k ?? '')} />
          </FieldBox>
        </>
      )}
      <Title level="H5" style={{ margin: '1rem 0 0.5rem' }}>Firma und Anschrift</Title>
      <FormGrid>
        <TextField label="Name" required value={k.kundenname} onChange={set('kundenname')} />
        <TextField label="Name 2" value={k.kundenname2} onChange={set('kundenname2')} />
        <TextField label="Straße" value={k.strasse} onChange={set('strasse')} />
        <TextField label="Hausnummer" value={k.hausnummer} onChange={set('hausnummer')} />
        <FieldBox label="Land">
          <AuswahlBox wert={k.land ?? ''} eintraege={LAENDER.map(([c, n]) => ({ key: c, text: n, zusatz: c }))} onWaehle={(x) => set('land')(x ?? '')} />
        </FieldBox>
        <TextField label="PLZ" value={k.plz} onChange={set('plz')} />
        <TextField label="Ort" value={k.ort} onChange={set('ort')} />
        <TextField label="USt-IdNr." value={k.ustid} onChange={set('ustid')} />
      </FormGrid>
      <Title level="H5" style={{ margin: '1rem 0 0.5rem' }}>Ansprechpartner und Kontakt</Title>
      <FormGrid>
        <FieldBox label="Anrede">
          <ComboBox value={k.anrede ?? ''} onInput={(e) => set('anrede')(e.target.value)} onChange={(e) => set('anrede')(e.target.value)}>
            <ComboBoxItem text="Herr" />
            <ComboBoxItem text="Frau" />
          </ComboBox>
        </FieldBox>
        <TextField label="Vorname" value={k.vorname} onChange={set('vorname')} />
        <TextField label="Nachname" value={k.name} onChange={set('name')} />
        <TextField label="Telefon" type="Tel" value={k.telefon} onChange={set('telefon')} />
        <TextField label="Fax" type="Tel" value={k.fax} onChange={set('fax')} />
        <TextField label="E-Mail" type="Email" value={k.email} onChange={set('email')} />
        <TextField label="GLN" value={k.gln} onChange={set('gln')} />
        <TextField label="Markt" value={k.markt} onChange={set('markt')} />
      </FormGrid>
    </Dialog>
  );
}

/** Neuer Listenwert (Fahrzeugtyp, Ladegut, Ladeweise) */
export function WertDialog({ typ, onClose, onSaved }: { typ: string | null; onClose: () => void; onSaved: (typ: string, key: string) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setText(''); setError(null); }, [typ]);
  const titel = typ === 'FAHRZEUGTYP' ? 'Neuer Fahrzeugtyp' : typ === 'LADEGUT' ? 'Neues Ladegut' : typ === 'LADEWEISE' ? 'Neue Ladeweise' : 'Neuer Wert';
  async function save() {
    try {
      const r = await api.post<{ key: string }>(`${T}/werte`, { typ, text });
      toast(`Wert "${text}" angelegt.`);
      onSaved(typ!, r.key);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Dialog open={!!typ} headerText={titel} onClose={onClose}
            footer={<Bar endContent={<>
              <Button design="Emphasized" disabled={!text.trim()} onClick={save}>Anlegen</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
      <FieldBox label="Bezeichnung" required>
        <Input value={text} maxlength={60} onInput={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && text.trim() && save()} />
      </FieldBox>
    </Dialog>
  );
}
