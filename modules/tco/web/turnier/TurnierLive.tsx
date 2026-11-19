import { useCallback, useEffect, useState } from 'react';
import { BusyIndicator, Link, MessageStrip, Text, Title } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import type { OeffentlichProps } from '@core/platform';
import { dat } from '../util';
import { STATUS_TEXT, TO, type LiveDaten } from './api';
import { MODUS_UI } from './modi';

/**
 * Öffentliche Live-Seite /turnier-live?t=<kennung>[&beamer=1]: lädt alle 15 s neu (Beamer alle 10 s) und zeigt die
 * Live-Ansicht des Modus. Beamer: volle Breite, große Schrift, ohne Seitenrahmen.
 */
export function TurnierLive({ orgName, logo }: OeffentlichProps) {
  const [q] = useState(() => new URLSearchParams(window.location.search));
  const kennung = q.get('t') ?? '';
  const beamer = q.get('beamer') === '1';
  const [live, setLive] = useState<LiveDaten | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aktualisiert, setAktualisiert] = useState<Date | null>(null);

  const laden = useCallback(async () => {
    if (!kennung) { setError('Der Link ist unvollständig – es fehlt die Turnier-Kennung.'); return; }
    try {
      setLive(await api.get<LiveDaten>(`${TO}/oeffentlich/${encodeURIComponent(kennung)}/live`));
      setAktualisiert(new Date());
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [kennung]);
  useEffect(() => {
    laden();
    const h = setInterval(() => { if (document.visibilityState !== 'hidden') laden(); }, beamer ? 10_000 : 15_000);
    return () => clearInterval(h);
  }, [laden, beamer]);
  useEffect(() => { if (live) document.title = `${live.turnier.name} – live`; }, [live]);

  const Live = live ? MODUS_UI[live.turnier.modus].Live : null;
  const stand = aktualisiert ? `aktualisiert ${aktualisiert.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : '';

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--sapBackgroundColor)', fontSize: beamer ? '1.4rem' : undefined, boxSizing: 'border-box' }}>
      <div style={{ maxWidth: beamer ? 'none' : '80rem', margin: '0 auto', padding: beamer ? '1rem 2rem' : '1rem clamp(0.5rem, 3vw, 2rem)' }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
          {logo && <img src={logo} alt="" style={{ maxHeight: beamer ? '4rem' : '2.5rem' }} />}
          <div style={{ flex: 1, minWidth: '12rem' }}>
            <Title level={beamer ? 'H1' : 'H3'} wrappingType="Normal">{live?.turnier.name ?? orgName}</Title>
            {live && (
              <Text className="portal-muted" style={beamer ? { fontSize: '1.2rem' } : undefined}>
                {orgName} · {live.turnier.modus_text} · {STATUS_TEXT[live.turnier.status]}
              </Text>
            )}
          </div>
          <Text className="portal-muted" style={{ fontSize: beamer ? '1.1rem' : '0.8rem', whiteSpace: 'nowrap' }}>{stand}</Text>
        </header>
        {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '1rem' }}>{error}{live ? ' – angezeigt wird der letzte Stand.' : ''}</MessageStrip>}
        {!live ? (!error && <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />) : <>
          {!beamer && live.turnier.status === 'anmeldung' && (
            <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '1rem' }}>
              Die Anmeldung ist offen{live.turnier.meldeschluss ? ` bis ${dat(live.turnier.meldeschluss)}` : ''}.{' '}
              <Link href={`/turnier?t=${encodeURIComponent(kennung)}`}>Jetzt anmelden</Link>
            </MessageStrip>
          )}
          {Live && <Live live={live} gross={beamer} />}
        </>}
      </div>
    </div>
  );
}
