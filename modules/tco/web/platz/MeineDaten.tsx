import { useEffect, useState } from 'react';
import { BusyIndicator, Button, Input, Label, MessageStrip, Option, SegmentedButton, SegmentedButtonItem, Select, Tab, TabContainer } from '@ui5/webcomponents-react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { MeineZeiten } from '../jt/MeineZeiten';
import { MeineProjektzeiten } from '../projekte/MeineProjektzeiten';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { Section } from '@core/components/Section';
import { toast } from '@core/toast';
import { useCan } from '@core/session';
import { MeineMitgliedschaft } from '../mitglieder/MeineMitgliedschaft';
import { TCO } from '../util';

/** Meine Daten: Hallennutzer pflegen ihre Kontaktdaten selbst – eigener Kundenstammsatz bzw. zugeordnetes Mitglied (Mitgliedsstamm) */
interface Daten { quelle?: 'KUNDE' | 'MITGLIED'; benutzername: string; kundennummer: string; anrede: string; vorname: string; nachname: string; strasse: string; plz: string; ort: string; email: string; telefon: string }

/**
 * Eine App „Meine Daten“ (#232, N2): Mitglieder sehen alles zu ihrer Mitgliedschaft (Kontakt, Bank, Verträge, Änderungen),
 * externe Hallennutzer ihre Kontaktdaten. Bisher zwei Apps mit überschneidendem Inhalt.
 */
export function MeineDatenApp() {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const stamm = can('tco.meinedaten:edit') ? <MeineMitgliedschaft /> : can('tco.meinkonto:edit') ? <MeineDaten /> : null;
  const training = can('tco.jtmeine:edit'), projekt = can('tco.projektzeiten:edit');
  // ohne Zeiterfassung bleibt die App, wie sie war
  if (!training && !projekt) return stamm;
  const reiter = params.get('reiter') === 'zeiten' || !stamm ? 'zeiten' : 'daten';
  const art = !training || (projekt && params.get('art') === 'projekt') ? 'projekt' : 'training';
  const setze = (n: Record<string, string>) => setParams({ ...Object.fromEntries(params), ...n }, { replace: true });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <TabContainer tabLayout="Inline" collapsed className="portal-reiter-nur-kopf" onTabSelect={(e) => setze({ reiter: (e.detail.tab as HTMLElement).dataset.key! })}>
        {stamm && <Tab data-key="daten" text="Meine Daten" icon="customer" selected={reiter === 'daten'} />}
        <Tab data-key="zeiten" text="Meine Zeiten" icon="time-entry-request" selected={reiter === 'zeiten'} />
      </TabContainer>
      {reiter === 'zeiten' && training && projekt && (
        <div style={{ padding: '0.75rem var(--portal-page-x, 1rem) 0' }}>
          <SegmentedButton onSelectionChange={(e) => setze({ art: (e.detail.selectedItems[0] as HTMLElement).dataset.art! })}>
            <SegmentedButtonItem data-art="training" selected={art === 'training'}>Training</SegmentedButtonItem>
            <SegmentedButtonItem data-art="projekt" selected={art === 'projekt'}>Projekt</SegmentedButtonItem>
          </SegmentedButton>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        {reiter === 'daten' ? stamm : art === 'training' ? <MeineZeiten /> : (
          <AppPage title="Meine Zeiten" subtitle="Arbeitsstunden auf Projekte melden – unbezahlt, zählen als Eigenleistung des Projekts"><MeineProjektzeiten /></AppPage>
        )}
      </div>
    </div>
  );
}

/** Alte Adresse „Meine Trainingszeiten“ – die Zeiterfassung ist jetzt ein Reiter in „Meine Daten“ */
export function ZuMeinenZeiten() { return <Navigate to="/tco/meine-daten?reiter=zeiten" replace />; }

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
    <AppPage title="Meine Daten" subtitle={d ? `Benutzer ${d.benutzername} · ${d.quelle === 'MITGLIED' ? 'Mitgliedsnummer' : 'Kundennummer'} ${d.kundennummer}` : undefined}
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
