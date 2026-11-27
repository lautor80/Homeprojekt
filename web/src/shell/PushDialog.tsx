import { useEffect, useState } from 'react';
import { Button, BusyIndicator, CheckBox, Dialog, MessageStrip, Text, Title } from '@ui5/webcomponents-react';
import { FussLeiste } from '../components/DialogFuss';
import { api } from '../api';
import { useSession } from '../session';
import { toast } from '../toast';
import { alsAppGeoeffnet, istIos, pushAbo, pushAusschalten, pushEinschalten, pushMoeglich, type PushArt, type PushStand } from '../push';

/**
 * Benachrichtigungen (Benutzermenü): Push-Nachrichten aufs Handy je Gerät ein- und ausschalten und je Art wählen,
 * was ankommen soll. Die Auswahl der Arten gilt für alle eigenen Geräte.
 */
export function PushDialog({ onClose }: { onClose: () => void }) {
  const { me } = useSession();
  const [stand, setStand] = useState<PushStand | null>(null);
  const [hier, setHier] = useState<string | null>(null);   // endpoint dieses Geräts, wenn eingeschaltet
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const moeglich = pushMoeglich();

  useEffect(() => {
    api.get<PushStand>('/api/push').then(setStand).catch((e) => setError(e.message));
    pushAbo().then((a) => setHier(a?.endpoint ?? null)).catch(() => setHier(null));
  }, []);

  const tun = async (fn: () => Promise<PushStand | null | void>, danach?: () => Promise<void> | void) => {
    setBusy(true); setError(null);
    try {
      const s = await fn();
      if (s) { setStand(s); if (s.text) toast(s.text); }
      await danach?.();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const abgleich = async () => setHier((await pushAbo())?.endpoint ?? null);

  // eingeschaltet ist dieses Gerät nur, wenn der Server es auch (für diesen Benutzer) kennt
  const an = !!hier && !!stand?.geraete.some((g) => g.endpoint === hier);
  const andere = stand?.geraete.filter((g) => g.endpoint !== hier) ?? [];
  const schalten = (a: PushArt, wert: boolean) => {
    if (!stand) return;
    const aus = stand.arten.filter((x) => (x.id === a.id ? !wert : !x.an)).map((x) => x.id);
    void tun(() => api.put<PushStand>('/api/push/arten', { aus }));
  };
  const gruppen = [...new Set((stand?.arten ?? []).map((a) => a.gruppe))];
  const datum = (s: string | null) => (s ? new Date(s).toLocaleDateString('de-DE') : '');

  return (
    <Dialog open headerText="Benachrichtigungen" onClose={onClose} style={{ width: 'min(560px, 95vw)' }}
            footer={<FussLeiste endContent={<Button onClick={onClose}>Schließen</Button>} />}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.75rem' }}>{error}</MessageStrip>}
      {!stand && !error && <BusyIndicator active delay={0} style={{ width: '100%', padding: '2rem 0' }} />}
      {stand && (
        <>
          <Title level="H5">Dieses Gerät</Title>
          {!moeglich && (
            <MessageStrip design="Information" hideCloseButton style={{ margin: '0.5rem 0' }}>
              {istIos() && !alsAppGeoeffnet()
                ? 'Auf dem iPhone und iPad kommen Push-Nachrichten nur an, wenn das Portal als App auf dem Home-Bildschirm liegt: in Safari auf „Teilen“ tippen, „Zum Home-Bildschirm“ wählen, das Portal von dort öffnen und hier einschalten.'
                : 'Dieser Browser unterstützt keine Push-Nachrichten. Die Auswahl unten gilt für deine anderen Geräte.'}
            </MessageStrip>
          )}
          {moeglich && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', margin: '0.5rem 0 0.25rem' }}>
              <Text style={{ flex: '1 1 12rem' }}>{an ? 'Push-Nachrichten sind eingeschaltet.' : 'Push-Nachrichten sind ausgeschaltet.'}</Text>
              {an
                ? <>
                    <Button disabled={busy} onClick={() => void tun(async () => { const r = await api.post<{ text: string }>('/api/push/test'); toast(r.text); })}>Testnachricht</Button>
                    <Button disabled={busy} onClick={() => void tun(() => pushAusschalten(), abgleich)}>Ausschalten</Button>
                  </>
                : <Button design="Emphasized" icon="bell" disabled={busy} onClick={() => void tun(() => pushEinschalten(stand.schluessel, me.user.id), abgleich)}>Einschalten</Button>}
            </div>
          )}

          <Title level="H5" style={{ marginTop: '1rem' }}>Was möchtest du aufs Handy bekommen?</Title>
          <Text className="portal-muted portal-small">Gilt für alle deine Geräte. E-Mails und der Arbeitsvorrat im Portal bleiben davon unberührt.</Text>
          {gruppen.map((g) => (
            <div key={g} style={{ marginTop: '0.5rem' }}>
              <Text style={{ fontWeight: 'bold' }}>{g}</Text>
              {stand.arten.filter((a) => a.gruppe === g).map((a) => (
                <div key={a.id}><CheckBox text={a.text} checked={a.an} disabled={busy} onChange={(e) => schalten(a, e.target.checked)} /></div>
              ))}
            </div>
          ))}
          {!stand.arten.length && <Text>Für dich gibt es zurzeit keine Benachrichtigungen.</Text>}

          {andere.length > 0 && (
            <>
              <Title level="H5" style={{ marginTop: '1rem' }}>Weitere Geräte</Title>
              {andere.map((g) => (
                <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.25rem' }}>
                  <Text style={{ flex: 1 }}>{g.name || 'Gerät'} <span className="portal-muted portal-small">seit {datum(g.erstellt_am)}</span></Text>
                  <Button design="Transparent" icon="delete" tooltip="Gerät entfernen" disabled={busy}
                          onClick={() => void tun(() => api.post<PushStand>('/api/push/geraet/abmelden', { id: g.id }))} />
                </div>
              ))}
            </>
          )}
        </>
      )}
    </Dialog>
  );
}
