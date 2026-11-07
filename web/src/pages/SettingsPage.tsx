import { useEffect, useState } from 'react';
import { Button, FileUploader, Input, MessageStrip, Panel } from '@ui5/webcomponents-react';
import { api } from '../api';
import { AppPage } from '../components/AppPage';
import { useLoad } from '../components/useLoad';
import { FieldBox, FormGrid, TextField } from '../components/FormFields';
import { ChangeHistoryButton } from '../components/ChangeHistory';
import { useSession } from '../session';
import { applyBranding } from '../branding';
import { toast } from '../toast';

type S = Record<string, string | null>;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export function SettingsPage() {
  const { reload } = useSession();
  const loaded = useLoad(() => api.get<S>('/api/settings'));
  const [s, setS] = useState<S>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (loaded.data) setS(loaded.data); }, [loaded.data]);

  const set = (k: string) => (v: string | null) => setS({ ...s, [k]: v });

  async function onLogo(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    if (file.size > 300_000) return setError('Logo ist zu groß (max. 300 KB).');
    setS({ ...s, 'org.logo': await readAsDataUrl(file) });
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = {
        'org.name': s['org.name'] ?? '',
        'org.logo': s['org.logo'] || null,
        'org.color': s['org.color'] || undefined,
        'org.address': s['org.address'] ?? '',
        'integration.paperless.url': s['integration.paperless.url'] ?? '',
        'integration.n8n.url': s['integration.n8n.url'] ?? '',
      };
      const saved = await api.put<S>('/api/settings', body);
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

  return (
    <AppPage
      title="Einstellungen"
      actions={<><ChangeHistoryButton objectType="SETTING" objectKey="org.name" /></>}
      footer={<Button design="Emphasized" loading={busy} onClick={save}>Sichern</Button>}
    >
      {(error || loaded.error) && <MessageStrip design="Negative" style={{ marginBottom: '1rem' }}>{error ?? loaded.error}</MessageStrip>}
      <Panel headerText="Organisation" fixed>
        <FormGrid>
          <TextField label="Name" required value={s['org.name']} onChange={set('org.name')} />
          <FieldBox label="Akzentfarbe">
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input type="color" value={s['org.color'] || '#0a6ed1'} onChange={(e) => set('org.color')(e.target.value)}
                     style={{ width: 44, height: 32, border: 'none', background: 'none' }} />
              <Input value={s['org.color'] ?? ''} placeholder="#0a6ed1" onInput={(e) => set('org.color')(e.target.value)} />
            </div>
          </FieldBox>
          <TextField label="Anschrift (für Ausdrucke)" multiline wide value={s['org.address']} onChange={set('org.address')} />
          <FieldBox label="Logo (PNG/JPEG/SVG, max. 300 KB)" wide>
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
              {s['org.logo'] && <img src={s['org.logo']} alt="Logo" style={{ maxHeight: 64, maxWidth: 200 }} />}
              <FileUploader accept="image/png,image/jpeg,image/svg+xml" hideInput onChange={(e) => onLogo(e.detail.files)}>
                <Button icon="upload">Logo wählen</Button>
              </FileUploader>
              {s['org.logo'] && <Button design="Transparent" icon="delete" onClick={() => set('org.logo')(null)}>Entfernen</Button>}
            </div>
          </FieldBox>
        </FormGrid>
      </Panel>
      <Panel headerText="Integrationen" fixed style={{ marginTop: '1rem' }}>
        <FormGrid>
          <TextField label="Paperless-URL" value={s['integration.paperless.url']} onChange={set('integration.paperless.url')} placeholder="https://paperless.example.org" />
          <TextField label="n8n-URL" value={s['integration.n8n.url']} onChange={set('integration.n8n.url')} placeholder="https://n8n.example.org" />
        </FormGrid>
      </Panel>
    </AppPage>
  );
}
