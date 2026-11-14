import { useEffect, useState } from 'react';
import { Button, BusyIndicator, CheckBox, Input, Label, MessageStrip, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { CenterCard } from '@core/pages/AuthPages';
import type { OeffentlichProps } from '@core/platform';
import { NichtVerfuegbar, istAbgeschaltet } from '@core/components/NichtVerfuegbar';
import { TCO, dat, eur } from '../util';

/**
 * Öffentliche Seite /schluessel-quittung?token=… (#215): Der Kunde quittiert online den Erhalt seines Hallenschlüssels –
 * mit dem Link aus der E-Mail, auch ohne Portal-Konto.
 */
interface Info {
  nummer: string; person: string; datum: string; schluessel_nr: string | null; pfand: number | null; ausgegeben_von: string;
  quittiert: boolean; quittiert_am: string | null; abgelaufen: boolean; bedingungen: string; verein: string;
}

export function SchluesselQuittung({ orgName, logo, onFertig }: OeffentlichProps) {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [ok, setOk] = useState(false);
  const [fertig, setFertig] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Funktionsschalter (#232, F1): Die App „Hallenschlüssel“ ist abgeschaltet */
  const [aus, setAus] = useState(false);
  useEffect(() => {
    api.get<Info>(`${TCO}/schluessel/quittung?token=${encodeURIComponent(token)}`).then((i) => { setInfo(i); setName(i.person); })
      .catch((e) => (istAbgeschaltet(e) ? setAus(true) : setError((e as Error).message)));
  }, [token]);
  async function quittieren() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string }>(`${TCO}/schluessel/quittung`, { token, name, zustimmung: ok });
      setFertig(r.text);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  if (aus) return <NichtVerfuegbar orgName={orgName} logo={logo} titel="Hallenschlüssel" onFertig={onFertig} />;
  return (
    <CenterCard title={orgName} subtitle="Hallenschlüssel – Erhalt quittieren" logo={logo} breit>
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}
      {!info && !error && <BusyIndicator active style={{ display: 'block', padding: '1rem 0' }} />}
      {info && (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          <Text>
            <b>{info.person}</b>, du hast am <b>{dat(info.datum)}</b>{info.ausgegeben_von ? <> von <b>{info.ausgegeben_von}</b></> : null} einen Hallenschlüssel
            {info.schluessel_nr ? ` (Nr. ${info.schluessel_nr})` : ''} bekommen{info.pfand ? <> – Pfand <b>{eur(info.pfand)}</b> über die Hallenrechnung</> : null}. Vorgang {info.nummer}.
          </Text>
          <div style={{ whiteSpace: 'pre-line', background: 'var(--sapList_HeaderBackground, #f5f6f7)', borderRadius: '0.5rem', padding: '0.75rem' }}>{info.bedingungen}</div>
          {fertig || info.quittiert ? (
            <MessageStrip design="Positive" hideCloseButton>{fertig ?? `Der Erhalt ist bereits quittiert${info.quittiert_am ? ` (${new Date(info.quittiert_am).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })})` : ''} – vielen Dank!`}</MessageStrip>
          ) : info.abgelaufen ? (
            <MessageStrip design="Critical" hideCloseButton>Der Link ist abgelaufen. Bitte beim Hallenwart einen neuen Link anfordern.</MessageStrip>
          ) : (
            <>
              <Label showColon>Dein Name</Label>
              <Input value={name} maxlength={100} onInput={(e) => setName(e.target.value)} />
              <CheckBox wrappingType="Normal" text="Ich habe den Hallenschlüssel erhalten und bin mit den Spielregeln einverstanden." checked={ok} onChange={(e) => setOk(e.target.checked)} />
              <Button design="Emphasized" disabled={!ok || !name.trim()} loading={busy} onClick={quittieren}>Erhalt quittieren</Button>
            </>
          )}
        </div>
      )}
      <Button design="Transparent" style={{ width: '100%', marginTop: '1rem' }} onClick={onFertig}>Zum Vereinsportal</Button>
    </CenterCard>
  );
}
