import { useCallback, useEffect, useState } from 'react';
import { BusyIndicator, Button, MessageStrip, Text, Title } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { CenterCard } from '@core/pages/AuthPages';
import type { OeffentlichProps } from '@core/platform';
import { TO } from '../api';
import type { SpassPlatzAntwort } from '../../../server/turnier/spass-logik';
import { RUNDE_STATUS_TEXT, Uhr } from './SpassLive';
import './spass.css';

/**
 * Spaßturnier – Ergebniseingabe am Platz per QR-Code /turnier-platz?t=<kennung>&k=<schlüssel> (ohne Anmeldung, fürs Handy):
 * Platz wählen (wird im Browser gemerkt), Restzeit sehen, nach Ablauf die Spiele je Team eintragen und speichern.
 * Eintragen geht nur, solange die Runde läuft; danach trägt die Turnierleitung nach.
 */
type Platz = NonNullable<SpassPlatzAntwort['runde']>['plaetze'][number];

const speicher = (t: string) => `tco-turnier-platz-${t}`;
function gemerkt(t: string): number | null {
  try { const v = Number(localStorage.getItem(speicher(t))); return v > 0 ? v : null; } catch { return null; }
}
function merken(t: string, platz: number) {
  try { localStorage.setItem(speicher(t), String(platz)); } catch { /* egal */ }
}

export function SpassPlatz({ orgName, logo, onFertig }: OeffentlichProps) {
  const q = new URLSearchParams(window.location.search);
  const kennung = q.get('t') ?? '';
  const k = q.get('k') ?? '';
  const [d, setD] = useState<SpassPlatzAntwort | null>(null);
  const [fehler, setFehler] = useState<string | null>(!kennung || !k ? 'Der Platz-Link ist unvollständig – bitte den QR-Code erneut scannen.' : null);
  const [platz, setPlatz] = useState<number | null>(() => gemerkt(kennung));
  const [werte, setWerte] = useState<[number, number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState<string | null>(null);

  const laden = useCallback(async () => {
    if (!kennung || !k) return;
    try {
      setD(await api.get<SpassPlatzAntwort>(`${TO}/spass/platz/${encodeURIComponent(kennung)}?k=${encodeURIComponent(k)}`));
    } catch (e) { setFehler((e as Error).message); }
  }, [kennung, k]);
  useEffect(() => { laden(); const h = setInterval(laden, 20_000); return () => clearInterval(h); }, [laden]);

  const r = d?.runde ?? null;
  const p: Platz | undefined = r?.plaetze.find((x) => x.platz === platz);
  // Eingabe mit gespeichertem Ergebnis bzw. 0:0 vorbelegen, wenn Platz oder Runde wechseln
  const vorbelegung = p ? `${r!.nr}/${p.spiel_id}/${p.saetze?.[0]?.join(':') ?? ''}` : '';
  useEffect(() => { setWerte(p ? (p.saetze?.[0] ? [p.saetze[0][0], p.saetze[0][1]] : [0, 0]) : null); setOk(null); }, [vorbelegung]); // eslint-disable-line react-hooks/exhaustive-deps

  function waehlen(n: number) { setPlatz(n); merken(kennung, n); setOk(null); }
  const aendern = (i: 0 | 1, delta: number) => setWerte((w) => {
    if (!w) return w;
    const neu: [number, number] = [w[0], w[1]];
    neu[i] = Math.max(0, Math.min(99, neu[i] + delta));
    return neu;
  });

  async function speichern() {
    if (!p || !werte) return;
    setBusy(true); setFehler(null); setOk(null);
    try {
      const antwort = await api.post<SpassPlatzAntwort>(`${TO}/spass/platz/${encodeURIComponent(kennung)}/ergebnis`,
        { k, spiel_id: p.spiel_id, spiele_a: werte[0], spiele_b: werte[1] });
      setD(antwort);
      setOk(`Gespeichert: ${werte[0]}:${werte[1]}. Danke!`);
    } catch (e) { setFehler((e as Error).message); } finally { setBusy(false); }
  }

  const team = (namen: string[], i: 0 | 1) => (
    <div className="spass-eingabe__team">
      <span className="spass-eingabe__namen">{namen.join(' / ')}</span>
      <Button icon="less" accessibleName="ein Spiel weniger" disabled={!werte || werte[i] <= 0 || busy || r?.status !== 'laeuft'} onClick={() => aendern(i, -1)} />
      <span className="spass-eingabe__zahl" aria-live="polite">{werte?.[i] ?? 0}</span>
      <Button icon="add" accessibleName="ein Spiel mehr" disabled={!werte || busy || r?.status !== 'laeuft'} onClick={() => aendern(i, 1)} />
    </div>
  );

  return (
    <CenterCard title={orgName} subtitle={d ? d.turnier.name : 'Spaßturnier – Ergebnis am Platz'} logo={logo}>
      <div className="spass">
        {fehler && <MessageStrip design="Negative" onClose={() => setFehler(null)}>{fehler}</MessageStrip>}
        {!d ? (!fehler && <BusyIndicator active style={{ display: 'block', padding: '1rem 0' }} />) : !r ? (
          <MessageStrip hideCloseButton>Die erste Runde ist noch nicht ausgelost.</MessageStrip>
        ) : (
          <>
            <div className="spass-kopf">
              <span className="spass-kopf__titel">Runde {r.nr}</span>
              <span className="spass-label">{RUNDE_STATUS_TEXT[r.status]}</span>
              <Uhr endeUm={r.endeUm} stand={d.stand} status={r.status} />
            </div>
            {r.status !== 'laeuft' && (
              <MessageStrip hideCloseButton design={r.status === 'abgeschlossen' ? 'Information' : 'Critical'}>
                {r.status === 'geplant' ? 'Die Runde ist ausgelost, aber noch nicht gestartet.' : 'Die Runde ist abgeschlossen – die nächste wird gleich ausgelost.'}
              </MessageStrip>
            )}
            <div>
              <div className="spass-label" style={{ marginBottom: '0.25rem' }}>Auf welchem Platz spielt ihr?</div>
              <div className="spass-wahl">
                {r.plaetze.map((x) => (
                  <Button key={x.platz} design={x.platz === platz ? 'Emphasized' : 'Default'} onClick={() => waehlen(x.platz)}>{x.platz}</Button>
                ))}
              </div>
            </div>
            {p && werte && (
              <div className="spass-eingabe">
                <Title level="H5">Platz {p.platz} – gewonnene Spiele je Team</Title>
                {team(p.namen_a, 0)}
                <span className="spass-gegen" style={{ textAlign: 'center' }}>gegen</span>
                {team(p.namen_b, 1)}
                {ok && <MessageStrip design="Positive" hideCloseButton>{ok}</MessageStrip>}
                {r.status === 'laeuft' ? (
                  <Button design="Emphasized" icon="save" style={{ width: '100%' }} loading={busy} onClick={speichern}>
                    {p.wertung === 'gespielt' ? 'Ergebnis ändern' : 'Ergebnis speichern'}
                  </Button>
                ) : p.wertung === 'gespielt' && p.saetze?.[0] ? (
                  <Text>Eingetragen: {p.saetze[0][0]}:{p.saetze[0][1]}</Text>
                ) : null}
              </div>
            )}
            {r.pausen.length > 0 && <Text className="portal-muted portal-small">Pause: {r.pausen.join(', ')}</Text>}
            <Button design="Transparent" icon="refresh" onClick={laden}>Aktualisieren</Button>
          </>
        )}
        <Button design="Transparent" onClick={onFertig}>Zum Portal</Button>
      </div>
    </CenterCard>
  );
}
