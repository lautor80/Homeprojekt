import { useEffect, useState } from 'react';
import { Bar, BusyIndicator, Button, Dialog, MessageStrip, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { useFunktion } from '@core/session';
import { toast } from '@core/toast';

/**
 * Rollenabgleich der Vereinsbenutzer (modules/tco/server/mitglieder/rollen.ts): Mitglieder haben „Mitglied“ und
 * „Hallennutzer“, Nichtmitglieder nur „Hallennutzer“. Zeigt zuerst, was sich ändern würde, und passt erst auf Knopfdruck an.
 * Derselbe Abgleich läuft regelmäßig im Hintergrund (alle 6 Stunden).
 */
interface Aenderung { username: string; name: string; mitglied: boolean; ergaenzt: string[]; entzogen: string[] }
const R = '/api/m/tco/benutzer/rollenabgleich';
const zelle = { padding: '0.35rem 0.6rem', textAlign: 'left' as const, verticalAlign: 'top' as const };

/** Knopf in der Benutzerverwaltung (WebModule.benutzerAktionen) – abschaltbar über den Funktionsschalter */
export function RollenabgleichKnopf({ onGeaendert }: { onGeaendert: () => void }) {
  const an = useFunktion()('tco.benutzer.rollenabgleich');
  const [offen, setOffen] = useState(false);
  if (!an) return null;
  return (
    <>
      <Button icon="role" tooltip="Mitglieder: Rollen „Mitglied“ und „Hallennutzer“ – Nichtmitglieder: nur „Hallennutzer“" onClick={() => setOffen(true)}>Rollen prüfen</Button>
      {offen && <RollenabgleichDialog onClose={() => setOffen(false)} onGeaendert={onGeaendert} />}
    </>
  );
}

function RollenabgleichDialog({ onClose, onGeaendert }: { onClose: () => void; onGeaendert: () => void }) {
  const [v, setV] = useState<{ aenderungen: Aenderung[]; text: string } | null>(null);
  const [fertig, setFertig] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.get<{ aenderungen: Aenderung[]; text: string }>(R).then(setV).catch((e) => setError((e as Error).message)); }, []);
  async function anpassen() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ aenderungen: Aenderung[]; text: string }>(R);
      setV(r); setFertig(true); toast(r.text, 6000); onGeaendert();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open headerText="Rollen prüfen" style={{ width: 'min(48rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={<>
              {v && v.aenderungen.length > 0 && !fertig && <Button design="Emphasized" icon="accept" loading={busy} onClick={anpassen}>Jetzt anpassen</Button>}
              <Button onClick={onClose}>{fertig || !v?.aenderungen.length ? 'Schließen' : 'Abbrechen'}</Button>
            </>} />}>
      <Text style={{ display: 'block', marginBottom: '0.75rem' }}>
        Mitglieder haben die Rollen „Mitglied“ und „Hallennutzer“, Nichtmitglieder (Hallenkunden, ausgetretene Mitglieder) nur „Hallennutzer“.
        Weitere Rollen bleiben unverändert. Der Abgleich läuft zusätzlich alle 6 Stunden von selbst.
      </Text>
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {!v && !error && <BusyIndicator active style={{ display: 'block', padding: '1.5rem 0' }} />}
      {v && <MessageStrip design={fertig ? 'Positive' : v.aenderungen.length ? 'Information' : 'Positive'} hideCloseButton style={{ marginBottom: '0.5rem' }}>{v.text}</MessageStrip>}
      {v && v.aenderungen.length > 0 && (
        <div style={{ overflowX: 'auto', maxHeight: '50vh' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead><tr style={{ borderBottom: '1px solid var(--sapList_BorderColor)' }}>
              <th style={zelle}>Benutzer</th><th style={zelle}>Status</th><th style={zelle}>{fertig ? 'Ergänzt' : 'Erhält'}</th><th style={zelle}>{fertig ? 'Entzogen' : 'Verliert'}</th>
            </tr></thead>
            <tbody>
              {v.aenderungen.map((a) => (
                <tr key={a.username} style={{ borderBottom: '1px solid var(--sapList_BorderColor)' }}>
                  <td style={zelle}>{a.name}<br /><span className="portal-muted">{a.username}</span></td>
                  <td style={zelle}>{a.mitglied ? 'Mitglied' : 'Nichtmitglied'}</td>
                  <td style={zelle}>{a.ergaenzt.join(', ') || '–'}</td>
                  <td style={zelle}>{a.entzogen.join(', ') || '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}
