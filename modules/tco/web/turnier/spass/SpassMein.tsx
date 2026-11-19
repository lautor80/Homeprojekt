import { useEffect, useState } from 'react';
import { BusyIndicator, MessageStrip, Switch, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { useLoad } from '@core/components/useLoad';
import { toast } from '@core/toast';
import { TO, type MeinProps } from '../api';
import type { SpassZugangAntwort } from '../../../server/turnier/spass-logik';
import { RUNDE_STATUS_TEXT, Uhr } from './SpassLive';
import './spass.css';

/**
 * Turniere – Ergänzung auf „Mein Turnier“ (Spaßturnier): eigener Platz in der aktuellen Runde mit Partner, Gegnern
 * und Restzeit; Pausenwunsch für die nächste Runde umschalten; eigener Rang.
 */
export function SpassMein({ schluessel, reload }: MeinProps) {
  const pfad = `${TO}/spass/zugang/${encodeURIComponent(schluessel)}`;
  const { data: d, error, reload: neu } = useLoad(() => api.get<SpassZugangAntwort>(pfad), [pfad]);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  // jede Minute aktualisieren (neue Runde, Start)
  useEffect(() => { const h = setInterval(neu, 60_000); return () => clearInterval(h); }, [neu]);

  async function pauseSetzen(pause: boolean) {
    setBusy(true); setFehler(null);
    try {
      await api.post(`${pfad}/pause`, { pause });
      toast(pause ? 'Du pausierst in der nächsten Runde.' : 'Du spielst in der nächsten Runde mit.');
      neu(); reload();
    } catch (e) { setFehler((e as Error).message); } finally { setBusy(false); }
  }

  if (error) return <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>;
  if (!d) return <BusyIndicator active style={{ display: 'block', padding: '1rem 0' }} />;
  const r = d.runde;
  return (
    <div className="spass" style={{ marginBottom: '1rem' }}>
      {fehler && <MessageStrip design="Negative" onClose={() => setFehler(null)}>{fehler}</MessageStrip>}
      {r && (
        <div className="spass-platz">
          <div className="spass-platz__kopf">
            <span className="spass-platz__nr">Runde {r.nr}</span>
            <span className="spass-label">{RUNDE_STATUS_TEXT[r.status]}</span>
          </div>
          <Uhr endeUm={r.endeUm} status={r.status} />
          {d.platz ? (
            <>
              <div className="spass-kopf__titel">Platz {d.platz.platz}</div>
              <div>Mit {d.platz.partner.join(' / ') || '–'}</div>
              <div className="spass-gegen">gegen</div>
              <div>{d.platz.gegner.join(' / ')}</div>
              {d.platz.wertung === 'gespielt' && d.platz.saetze?.[0] && (
                <div className="spass-label">
                  Ergebnis: {d.platz.saetze[0][d.platz.seite === 'a' ? 0 : 1]}:{d.platz.saetze[0][d.platz.seite === 'a' ? 1 : 0]} Spiele
                </div>
              )}
            </>
          ) : <div>{r.pause ? 'Du hast in dieser Runde Pause.' : 'Du bist in dieser Runde nicht eingeteilt.'}</div>}
        </div>
      )}
      {!d.fertig && (
        <div className="spass-team" style={{ flexWrap: 'wrap' }}>
          <Text>Ich möchte in der nächsten Runde pausieren</Text>
          <Switch checked={d.pause_naechste} disabled={busy} textOn="Ja" textOff="Nein" accessibleName="In der nächsten Runde pausieren"
                  onChange={(e) => pauseSetzen(e.target.checked)} />
        </div>
      )}
      {d.rang && d.rang.spiele > 0 && (
        <Text className="portal-muted">
          Dein Stand: Platz {d.rang.rang} · {d.rang.siege} Siege{d.rang.unentschieden ? `, ${d.rang.unentschieden} unentschieden` : ''}, {d.rang.niederlagen} Niederlagen ·
          Quote {Math.round(d.rang.quote * 100)} %
        </Text>
      )}
    </div>
  );
}
