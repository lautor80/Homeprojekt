import { useEffect, useRef, useState } from 'react';
import { Button, BusyIndicator, MessageStrip } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { CenterCard } from '@core/pages/AuthPages';
import type { OeffentlichProps } from '@core/platform';
import { NichtVerfuegbar, istAbgeschaltet } from '@core/components/NichtVerfuegbar';
import { TCO } from '../util';

/** Öffentliche Seite /registrierung-bestaetigen?token=…: E-Mail bestätigen, Zugang wird sofort freigeschaltet */
export function RegistrierungBestaetigen({ orgName, logo, onFertig }: OeffentlichProps) {
  const [ergebnis, setErgebnis] = useState<{ ok: boolean; text: string } | null>(null);
  const gesendet = useRef(false);
  /** Funktionsschalter (#232, F1): Die Registrierung ist abgeschaltet */
  const [aus, setAus] = useState(false);
  useEffect(() => {
    if (gesendet.current) return;
    gesendet.current = true;
    const token = new URLSearchParams(window.location.search).get('token') ?? '';
    api.post<{ text: string }>(`${TCO}/platz/registrierung/bestaetigen`, { token })
      .then((r) => setErgebnis({ ok: true, text: r.text }))
      .catch((e) => (istAbgeschaltet(e) ? setAus(true) : setErgebnis({ ok: false, text: (e as Error).message })));
  }, []);
  if (aus) return <NichtVerfuegbar orgName={orgName} logo={logo} titel="Registrierung" onFertig={onFertig} />;
  return (
    <CenterCard title={orgName} subtitle="Registrierung bestätigen" logo={logo}>
      {!ergebnis ? <BusyIndicator active style={{ display: 'block', padding: '1rem 0' }} /> : (
        <>
          <MessageStrip design={ergebnis.ok ? 'Positive' : 'Negative'} hideCloseButton style={{ marginBottom: '1rem' }}>{ergebnis.text}</MessageStrip>
          <Button design="Emphasized" style={{ width: '100%' }} onClick={onFertig}>Zur Anmeldung</Button>
        </>
      )}
    </CenterCard>
  );
}
