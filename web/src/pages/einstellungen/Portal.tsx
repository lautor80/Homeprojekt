import { useEffect, useState } from 'react';
import { Bar, Button, Input, MessageStrip, Panel, Text } from '@ui5/webcomponents-react';
import { api } from '../../api';
import { useLoad } from '../../components/useLoad';
import { FieldBox, FormGrid, TextField } from '../../components/FormFields';
import { ChangeHistoryButton } from '../../components/ChangeHistory';
import { useCan, useSession } from '../../session';
import { enabledModules } from '../../modules';
import { logoVerwendungen } from '../../einstellungen';
import { applyBranding } from '../../branding';
import { toast } from '../../toast';
import { SperrHinweis, useSperre } from '../../sperre';
import { AblageFlaeche } from '../../ablage';

/**
 * Kapitel „Portal“ der App Einstellungen (#232, E1): Allgemein (Name, Anschrift, Portal-Adresse) und Erscheinungsbild
 * (Akzentfarbe, Logo der Oberfläche). Jedes Kapitel sichert nur seine eigenen Schlüssel und sperrt nur diese.
 */
type S = Record<string, string | null>;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/** Laden, Sperren und Sichern einer festen Liste von Einstellungen */
function useEinstellungen(schluessel: readonly string[], wert: (s: S) => Record<string, string | null | undefined>) {
  const { reload } = useSession();
  const loaded = useLoad(() => api.get<S>('/api/settings'));
  const [s, setS] = useState<S>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (loaded.data) setS(loaded.data); }, [loaded.data]);
  // eslint-disable-next-line react-hooks/rules-of-hooks -- feste Liste, Reihenfolge stabil
  const sperren = schluessel.map((k) => useSperre('SETTING', k, true, { bezeichnung: 'Einstellungen' }));
  const sperre = sperren.find((x) => !x.eigen) ?? sperren[0];
  const darf = sperren.every((x) => x.eigen);
  const set = (k: string) => (v: string | null) => setS((alt) => ({ ...alt, [k]: v }));
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.put<S>('/api/settings', wert(s));
      setS(saved);
      applyBranding(saved);
      toast('Einstellungen gesichert');
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const kopf = (
    <>
      <SperrHinweis s={{ ...sperre, erneut: () => sperren.forEach((x) => x.erneut()) }} />
      {(error || loaded.error) && <MessageStrip design="Negative" style={{ marginBottom: '1rem' }}>{error ?? loaded.error}</MessageStrip>}
    </>
  );
  const fuss = (beleg: string) => (
    <Bar style={{ marginTop: '1rem' }} endContent={<>
      <ChangeHistoryButton objectType="SETTING" objectKey={beleg} />
      <Button design="Emphasized" loading={busy} disabled={!darf} onClick={save}>Sichern</Button>
    </>} />
  );
  return { s, set, setS, setError, kopf, fuss };
}

/** Portal › Allgemein */
export function PortalAllgemein() {
  const e = useEinstellungen(['org.name', 'org.address', 'portal.url'], (s) => ({
    'org.name': s['org.name'] ?? '', 'org.address': s['org.address'] ?? '', 'portal.url': s['portal.url'] ?? '',
  }));
  return (
    <>
      {e.kopf}
      <Panel headerText="Organisation" fixed>
        <FormGrid>
          <TextField label="Name" required value={e.s['org.name']} onChange={e.set('org.name')} />
          <TextField label="Anschrift (für Ausdrucke)" multiline wide value={e.s['org.address']} onChange={e.set('org.address')} />
        </FormGrid>
      </Panel>
      <Panel headerText="Portal" fixed style={{ marginTop: '1rem' }}>
        <FormGrid>
          <TextField label="Portal-Adresse (für Links in E-Mails)" value={e.s['portal.url']} onChange={e.set('portal.url')} placeholder="https://portal.tc-oberthal.de" />
        </FormGrid>
        <Text style={{ display: 'block', marginTop: '0.5rem', color: 'var(--sapContent_LabelColor)' }}>
          Angeschlossene Systeme (Paperless, n8n) werden unter Administration → Schnittstellen gepflegt.
        </Text>
      </Panel>
      {e.fuss('org.name')}
    </>
  );
}

/**
 * Portal › Erscheinungsbild: Akzentfarbe und alle Logos an einer Stelle (#232, E2) – das Logo der Oberfläche und die Logos
 * der Anwendungen (WebModule.logos). Jeder Block sichert für sich; man sieht die Blöcke, die man pflegen darf.
 */
export function PortalErscheinungsbild() {
  const { me } = useSession();
  const can = useCan();
  const logos = logoVerwendungen(enabledModules(me.modules), can);
  return (
    <>
      {can('core.settings:edit') && <PortalOberflaeche />}
      {logos.map(({ modul, name, logo }) => {
        const Formular = logo.component;
        return <Panel key={`${modul}.${logo.id}`} headerText={`Logo ${name}: ${logo.text}`} fixed style={{ marginTop: '1rem' }}><Formular /></Panel>;
      })}
    </>
  );
}

function PortalOberflaeche() {
  const e = useEinstellungen(['org.color', 'org.logo'], (s) => ({ 'org.color': s['org.color'] || undefined, 'org.logo': s['org.logo'] || null }));
  async function onLogo(files: FileList | File[] | null) {
    const file = files?.[0];
    if (!file) return;
    if (file.size > 300_000) return e.setError('Logo ist zu groß (max. 300 KB).');
    e.set('org.logo')(await readAsDataUrl(file));
  }
  return (
    <>
      {e.kopf}
      <Panel headerText="Oberfläche des Portals" fixed>
        <FormGrid>
          <FieldBox label="Akzentfarbe">
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input type="color" value={e.s['org.color'] || '#0a6ed1'} onChange={(ev) => e.set('org.color')(ev.target.value)}
                     style={{ width: 44, height: 32, border: 'none', background: 'none' }} />
              <Input value={e.s['org.color'] ?? ''} placeholder="#0a6ed1" onInput={(ev) => e.set('org.color')(ev.target.value)} />
            </div>
          </FieldBox>
          <FieldBox label="Logo der Oberfläche (PNG/JPEG/SVG, max. 300 KB)" wide>
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
              {e.s['org.logo'] && <img src={e.s['org.logo']} alt="Logo" style={{ maxHeight: 64, maxWidth: 200 }} />}
              <div style={{ flex: 1, minWidth: '14rem', maxWidth: '28rem' }}>
                <AblageFlaeche ziel={{ titel: 'Logo', annehmen: (f) => { onLogo(f); } }} accept="image/png,image/jpeg,image/svg+xml" multiple={false}
                               groesse="Dot" titel="Logo hier ablegen" text="PNG, JPEG oder SVG hierher ziehen oder klicken zum Auswählen" />
              </div>
              {e.s['org.logo'] && <Button design="Transparent" icon="delete" onClick={() => e.set('org.logo')(null)}>Entfernen</Button>}
            </div>
          </FieldBox>
        </FormGrid>
      </Panel>
      {e.fuss('org.color')}
    </>
  );
}
