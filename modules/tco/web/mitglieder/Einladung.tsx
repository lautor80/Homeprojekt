import { useEffect, useState } from 'react';
import { BusyIndicator, Button, CheckBox, FlexBox, Input, Label, MessageStrip, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { CenterCard } from '@core/pages/AuthPages';
import type { OeffentlichProps } from '@core/platform';
import { TCO } from '../util';

/** Öffentliche Seite /einladung?token=…: persönlichen Zugang (Link/QR-Code) einlösen – Benutzername und Kennwort wählen */
export function Einladung({ orgName, logo, onFertig }: OeffentlichProps) {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [info, setInfo] = useState<{ gueltig: boolean; vorname?: string; nachname?: string; benutzername?: string } | null>(null);
  const [f, setF] = useState({ benutzername: '', passwort: '', passwort2: '', datenschutz: false });
  const [error, setError] = useState<string | null>(null);
  const [fertig, setFertig] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<typeof info>(`${TCO}/einladung?token=${encodeURIComponent(token)}`)
      .then((r) => { setInfo(r); if (r?.benutzername) setF((x) => ({ ...x, benutzername: r.benutzername! })); })
      .catch((e) => setError(e.message));
  }, [token]);
  const full = { width: '100%' };
  const ok = f.benutzername.trim().length >= 3 && f.passwort.length >= 10 && f.passwort === f.passwort2 && f.datenschutz;
  async function absenden() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string }>(`${TCO}/einladung`, { token, benutzername: f.benutzername.trim(), passwort: f.passwort, datenschutz: f.datenschutz });
      setFertig(r.text);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const feld = (label: string, k: 'benutzername' | 'passwort' | 'passwort2', typ?: 'Password') => (
    <FlexBox direction="Column" style={{ gap: '0.25rem', marginBottom: '0.75rem' }}>
      <Label required showColon>{label}</Label>
      <Input style={full} type={typ} value={f[k]} onInput={(e) => setF({ ...f, [k]: e.target.value })}
             valueState={k === 'passwort2' && f.passwort2 && f.passwort !== f.passwort2 ? 'Negative' : 'None'} />
    </FlexBox>
  );
  return (
    <CenterCard title={orgName} subtitle="Zugang zum Vereinsportal einrichten" logo={logo}>
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}
      {fertig ? (
        <>
          <MessageStrip design="Positive" hideCloseButton style={{ marginBottom: '1rem' }}>{fertig}</MessageStrip>
          <Button design="Emphasized" style={full} onClick={onFertig}>Zur Anmeldung</Button>
        </>
      ) : !info ? (!error && <BusyIndicator active style={{ display: 'block', padding: '1rem 0' }} />) : !info.gueltig ? (
        <>
          <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '1rem' }}>
            Der Link ist ungültig, abgelaufen oder wurde bereits verwendet. Bitte beim Verein eine neue Einladung anfordern oder auf der Anmeldeseite registrieren.
          </MessageStrip>
          <Button design="Emphasized" style={full} onClick={onFertig}>Zur Anmeldung</Button>
        </>
      ) : (
        <>
          <Text style={{ display: 'block', marginBottom: '0.75rem' }}>
            Hallo {info.vorname} {info.nachname}, Ihr persönlicher Zugang ist vorbereitet. Wählen Sie Benutzername und Kennwort – danach können Sie sich sofort anmelden.
          </Text>
          {feld('Benutzername', 'benutzername')}
          {feld('Kennwort (mindestens 10 Zeichen)', 'passwort', 'Password')}
          {feld('Kennwort wiederholen', 'passwort2', 'Password')}
          <CheckBox text="Ich bin einverstanden, dass meine Angaben zur Nutzung des Vereinsportals verarbeitet werden." checked={f.datenschutz} wrappingType="Normal"
                    onChange={(e) => setF({ ...f, datenschutz: e.target.checked })} style={{ marginBottom: '0.75rem', marginLeft: '-0.5rem' }} />
          <Button design="Emphasized" style={full} loading={busy} disabled={!ok} onClick={absenden}>Zugang einrichten</Button>
        </>
      )}
    </CenterCard>
  );
}
