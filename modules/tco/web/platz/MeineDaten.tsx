import { useEffect, useState } from 'react';
import { BusyIndicator, Button, Input, Label, MessageStrip, Option, Select } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { Section } from '@core/components/Section';
import { toast } from '@core/toast';
import { TCO } from '../util';

/** Meine Daten: externe Hallennutzer pflegen ihre Kontaktdaten selbst (nur der eigene Kundenstammsatz) */
interface Daten { benutzername: string; kundennummer: string; anrede: string; vorname: string; nachname: string; strasse: string; plz: string; ort: string; email: string; telefon: string }

export function MeineDaten() {
  const [d, setD] = useState<Daten | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get<Daten>(`${TCO}/meinkonto`).then(setD).catch((e) => setError(e.message)); }, []);
  const set = (k: keyof Daten) => (e: { target: { value: string } }) => setD((x) => (x ? { ...x, [k]: e.target.value } : x));

  async function speichern() {
    if (!d) return;
    setBusy(true); setError(null);
    try {
      const r = await api.put<{ text: string }>(`${TCO}/meinkonto`, d);
      toast(r.text);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const feld = (label: string, k: keyof Daten, props: Record<string, unknown> = {}) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
      <Label required={!['telefon'].includes(k)} showColon>{label}</Label>
      <Input value={d?.[k] ?? ''} onInput={set(k)} style={{ width: '100%' }} {...props} />
    </div>
  );
  return (
    <AppPage title="Meine Daten" subtitle={d ? `Benutzer ${d.benutzername} · Kundennummer ${d.kundennummer}` : undefined}
             actions={d ? <Button design="Emphasized" icon="save" loading={busy} onClick={speichern}>Speichern</Button> : undefined}>
      {error && <MessageStrip design={d ? 'Negative' : 'Information'} hideCloseButton={!d} onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {!d ? (!error && <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />) : (
        <Section title="Kontaktdaten">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))', gap: '0.75rem 1rem', padding: '0.5rem 0' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <Label required showColon>Anrede</Label>
              <Select onChange={(e) => setD({ ...d, anrede: (e.detail.selectedOption as HTMLElement).dataset.a ?? '' })}>
                <Option data-a="" selected={!d.anrede}>bitte wählen</Option>
                {['Frau', 'Herr', 'Divers'].map((a) => <Option key={a} data-a={a} selected={d.anrede === a}>{a}</Option>)}
              </Select>
            </div>
            {feld('Vorname', 'vorname')}
            {feld('Nachname', 'nachname')}
            {feld('Straße und Hausnummer', 'strasse')}
            {feld('PLZ', 'plz')}
            {feld('Ort', 'ort')}
            {feld('E-Mail', 'email', { type: 'Email' })}
            {feld('Telefon', 'telefon', { type: 'Tel' })}
          </div>
          <MessageStrip hideCloseButton style={{ marginTop: '0.5rem' }}>
            Die E-Mail-Adresse gilt auch für die Anmeldung und „Passwort vergessen“. Ihr Kennwort ändern Sie über das Benutzermenü oben rechts.
          </MessageStrip>
        </Section>
      )}
    </AppPage>
  );
}
