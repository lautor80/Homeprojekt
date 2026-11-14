import { useEffect, useState } from 'react';
import { Button, FlexBox, MessageStrip, ObjectStatus, Option, Panel, Select, Text } from '@ui5/webcomponents-react';
import { api } from '../api';
import { FieldBox, FormGrid, TextField } from '../components/FormFields';
import { ChangeHistoryButton } from '../components/ChangeHistory';
import { toast } from '../toast';
import { SperrHinweis, useSperre } from '../sperre';
import { MailAbsender, MailStand, type Absender } from './MailVersand';

/**
 * Zugang zu einem angeschlossenen System (Paperless, n8n-Webhooks, Nextcloud): Adresse, Anmeldeart, Zugangsdaten,
 * Verbindungstest. Geheimnisse kommen maskiert vom Server; die Maske beim Sichern bedeutet „unverändert“.
 * Steht seit #232 (S1) in der App „Schnittstellen“ im Reiter seiner Schnittstelle (SchnittstellenPage.tsx).
 */
type AuthArt = 'keine' | 'token' | 'header' | 'basic';
interface Werte { url: string; auth_art: AuthArt; auth_user: string | null; header_name: string | null; geheimnis: string; einstellungen: Record<string, unknown> }
export interface Def {
  /** Reiter der Schnittstelle in Administration → Schnittstellen, z. B. „Paperless“ */
  reiter: string;
  id: string; text: string; beschreibung: string; auth: AuthArt[]; pruefbar: boolean; header_name?: string;
  felder?: { url?: string; geheimnis?: string; auth_user?: string; header_name?: string };
  zusatz?: { key: string; text: string; platzhalter?: string }[];
  werte: Werte;
  /** Stand aus dem Arbeitsvorrat: offene Störung dieser Anbindung (dieselbe Quelle, zweite Anzeige) */
  stand?: { eingerichtet: boolean; gestoert: boolean; text: string; seit: string | null; anzahl: number };
}
export interface Gruppe { modul: string; name: string; verbindungen: Def[] }
interface Test { ok: boolean; text: string; dauer_ms?: number }

const AUTH_TEXT: Record<AuthArt, string> = { keine: 'keine Anmeldung', token: 'API-Token (Authorization: Token …)', header: 'Schlüssel im eigenen Header', basic: 'Benutzer und Passwort (Basic Auth)' };

export function Verbindung({ def }: { def: Def }) {
  const [w, setW] = useState<Werte>(def.werte);
  const [geaendert, setGeaendert] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<Test | null>(null);
  const sperre = useSperre('VERBINDUNG', def.id, geaendert, { bezeichnung: def.text });
  useEffect(() => { setW(def.werte); }, [def.werte]);
  const ro = geaendert && !sperre.eigen;
  const set = (k: keyof Werte) => (v: string | null) => { setW({ ...w, [k]: v ?? '' }); setGeaendert(true); };
  const f = def.felder ?? {};
  const geheimnisLabel = f.geheimnis ?? (w.auth_art === 'basic' ? 'Passwort' : w.auth_art === 'header' ? 'Schlüssel (Header-Wert)' : 'API-Token');

  async function sichern() {
    setBusy(true); setError(null);
    try {
      const r = await api.put<Werte>(`/api/verbindungen/${encodeURIComponent(def.id)}`, w);
      setW(r); setGeaendert(false);
      toast(`${def.text} gesichert`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function pruefen() {
    setBusy(true); setTest(null);
    try { setTest(await api.post<Test>(`/api/verbindungen/${encodeURIComponent(def.id)}/pruefen`, w)); }
    catch (e) { setTest({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  }

  return (
    <Panel headerText={def.text} fixed style={{ marginBottom: '1rem' }}>
      <Text style={{ display: 'block', marginBottom: '0.75rem', color: 'var(--sapContent_LabelColor)' }}>{def.beschreibung}</Text>
      {def.stand && (
        <div style={{ marginBottom: '0.75rem' }}>
          <ObjectStatus state={def.stand.gestoert ? 'Negative' : def.stand.eingerichtet ? 'Positive' : 'None'} showDefaultIcon={def.stand.eingerichtet}>
            Stand: {def.stand.gestoert
              ? `Störung seit ${def.stand.seit ? def.stand.seit.split('-').reverse().join('.') : '?'}${def.stand.anzahl > 1 ? ` (${def.stand.anzahl}×)` : ''} – ${def.stand.text} (steht auch im Arbeitsvorrat)`
              : def.stand.text}
          </ObjectStatus>
        </div>
      )}
      <SperrHinweis s={sperre} />
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.75rem' }}>{error}</MessageStrip>}
      <FormGrid>
        <TextField label={f.url ?? 'URL'} wide value={w.url} onChange={set('url')} readonly={ro} placeholder="http://…" />
        {def.auth.length > 1 && (
          <FieldBox label="Anmeldung">
            <Select style={{ width: '100%' }} disabled={ro} onChange={(e) => set('auth_art')((e.detail.selectedOption as HTMLElement).dataset.a ?? 'keine')}>
              {def.auth.map((a) => <Option key={a} data-a={a} selected={w.auth_art === a}>{AUTH_TEXT[a]}</Option>)}
            </Select>
          </FieldBox>
        )}
        {w.auth_art === 'basic' && <TextField label={f.auth_user ?? 'Benutzer'} value={w.auth_user} onChange={set('auth_user')} readonly={ro} />}
        {w.auth_art === 'header' && <TextField label={f.header_name ?? 'Header-Name'} value={w.header_name ?? def.header_name ?? ''} onChange={set('header_name')} readonly={ro} placeholder="X-TCO-Key" />}
        {w.auth_art !== 'keine' && <TextField label={geheimnisLabel} type="Password" value={w.geheimnis} onChange={set('geheimnis')} readonly={ro} />}
        {def.zusatz?.map((z) => (
          <TextField key={z.key} label={z.text} wide value={String(w.einstellungen?.[z.key] ?? '')} readonly={ro} placeholder={z.platzhalter}
                     onChange={(x) => { setW({ ...w, einstellungen: { ...w.einstellungen, [z.key]: x } }); setGeaendert(true); }} />
        ))}
      </FormGrid>
      {def.id === 'mail' && (
        <MailAbsender liste={((w.einstellungen as { absender?: Absender[] })?.absender) ?? []} ro={ro}
                      onChange={(l) => { setW({ ...w, einstellungen: { ...w.einstellungen, absender: l } }); setGeaendert(true); }} />
      )}
      <FlexBox alignItems="Center" wrap="Wrap" style={{ gap: '0.75rem', marginTop: '0.5rem' }}>
        <Button design="Emphasized" loading={busy} disabled={!geaendert || ro} onClick={sichern}>Sichern</Button>
        {def.pruefbar && <Button icon="connected" disabled={busy} onClick={pruefen}>{busy ? 'Prüfe …' : 'Verbindung prüfen'}</Button>}
        <ChangeHistoryButton objectType="VERBINDUNG" objectKey={def.id} />
        {test && <ObjectStatus state={test.ok ? 'Positive' : 'Negative'} showDefaultIcon>{test.text}{test.dauer_ms != null ? ` (${(test.dauer_ms / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} s)` : ''}</ObjectStatus>}
      </FlexBox>
      {def.id === 'mail' && <MailStand />}
    </Panel>
  );
}
