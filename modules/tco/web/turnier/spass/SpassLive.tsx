import { useEffect, useState, type ReactNode } from 'react';
import { MessageStrip } from '@ui5/webcomponents-react';
import type { LiveProps } from '../api';
import type { RanglistenZeile, SpassLiveDaten, SpassPlatzDaten } from '../../../server/turnier/spass-logik';
import './spass.css';

/**
 * Turniere – Live-Ansicht Spaßturnier (öffentlich, Verwaltung, Beamer mit `gross`): Countdown der laufenden Runde,
 * Platzkarten mit Teams und Spielstand, Pausen, Rangliste (Quote → Siege → Spieldifferenz) und Rundenübersicht.
 * Die Bausteine (Uhr, Platzkarte, Rangliste) nutzen auch Verwaltung, „Mein Turnier“ und die Eingabe am Platz.
 */

export const RUNDE_STATUS_TEXT = { geplant: 'ausgelost, noch nicht gestartet', laeuft: 'läuft', abgeschlossen: 'abgeschlossen' } as const;

/** Restzeit in Sekunden bis endeUm (null = keine laufende Uhr); stand = Serverzeit der Antwort gleicht falsche Uhren aus */
export function useRestzeit(endeUm: string | null | undefined, stand?: string): number | null {
  const [jetzt, setJetzt] = useState(() => Date.now());
  const [versatz, setVersatz] = useState(0);
  useEffect(() => { if (stand) setVersatz(new Date(stand).getTime() - Date.now()); }, [stand]);
  useEffect(() => {
    if (!endeUm) return;
    const h = setInterval(() => setJetzt(Date.now()), 1000);
    return () => clearInterval(h);
  }, [endeUm]);
  if (!endeUm) return null;
  return Math.round((new Date(endeUm).getTime() - (jetzt + versatz)) / 1000);
}

export const zeitText = (s: number) => {
  const x = Math.max(0, s);
  return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`;
};

/** Countdown „12:34“ bzw. „Zeit abgelaufen“ */
export function Uhr({ endeUm, stand, status }: { endeUm: string | null; stand?: string; status: keyof typeof RUNDE_STATUS_TEXT }) {
  const rest = useRestzeit(status === 'laeuft' ? endeUm : null, stand);
  if (status !== 'laeuft' || rest === null) return null;
  if (rest <= 0) return <span className="spass-uhr spass-uhr--aus" role="timer">Zeit abgelaufen</span>;
  return <span className={`spass-uhr${rest <= 120 ? ' spass-uhr--knapp' : ''}`} role="timer" aria-label={`Restzeit ${zeitText(rest)}`}>{zeitText(rest)}</span>;
}

/** Karte eines Platzes: Team A gegen Team B, Spielstand */
export function Platzkarte({ p, name, aktion }: { p: Pick<SpassPlatzDaten, 'platz' | 'a' | 'b' | 'saetze' | 'wertung' | 'sieger'>; name: (id: number) => string; aktion?: ReactNode }) {
  const gewertet = p.wertung === 'gespielt' && p.saetze?.[0];
  const team = (ids: number[], seite: 'a' | 'b') => (
    <div className={`spass-team${gewertet && p.sieger === seite ? ' spass-team--sieger' : ''}`}>
      <span>{ids.map(name).join(' / ')}</span>
      {gewertet && <span className="spass-team__spiele">{p.saetze![0][seite === 'a' ? 0 : 1]}</span>}
    </div>
  );
  return (
    <div className={`spass-platz${gewertet ? ' spass-platz--gewertet' : ''}`}>
      <div className="spass-platz__kopf">
        <span className="spass-platz__nr">Platz {p.platz}</span>
        {gewertet ? <span className="spass-label">{p.sieger === 'x' ? 'unentschieden' : 'gewertet'}</span> : <span className="spass-label">offen</span>}
      </div>
      {team(p.a, 'a')}
      <span className="spass-gegen">gegen</span>
      {team(p.b, 'b')}
      {aktion}
    </div>
  );
}

const prozent = (q: number) => `${Math.round(q * 100)} %`;

/** Rangliste: Platz, Name, Quote, Siege/Unentschieden/Niederlagen, Spiele, Differenz, Runden/Pausen */
export function Rangliste({ zeilen, name, hervorheben }: { zeilen: RanglistenZeile[]; name: (id: number) => string; hervorheben?: number }) {
  if (!zeilen.length) return <MessageStrip hideCloseButton>Noch keine Teilnehmenden.</MessageStrip>;
  return (
    <div className="spass-tabelle-rahmen portal-tabrahmen">
      <table className="spass-tabelle">
        <thead>
          <tr>
            <th>#</th><th>Name</th><th title="Siegquote (Unentschieden zählen halb)">Quote</th><th title="Siege">S</th>
            <th className="spass-breit" title="Unentschieden">U</th><th className="spass-breit" title="Niederlagen">N</th>
            <th className="spass-breit" title="gewonnene : verlorene Spiele">Spiele</th><th title="Spieldifferenz">+/−</th>
            <th className="spass-breit" title="Runden gespielt / Pausen">Runden</th>
          </tr>
        </thead>
        <tbody>
          {zeilen.map((z) => (
            <tr key={z.teilnehmer_id} style={z.teilnehmer_id === hervorheben ? { fontWeight: 'bold' } : undefined}>
              <td>{z.rang}.</td>
              <td>{name(z.teilnehmer_id)}</td>
              <td>{z.spiele ? prozent(z.quote) : '–'}</td>
              <td>{z.siege}</td>
              <td className="spass-breit">{z.unentschieden}</td>
              <td className="spass-breit">{z.niederlagen}</td>
              <td className="spass-breit">{z.spielstand[0]}:{z.spielstand[1]}</td>
              <td>{z.differenz > 0 ? `+${z.differenz}` : z.differenz}</td>
              <td className="spass-breit">{z.runden}{z.pausen ? ` / ${z.pausen} P.` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Namen-Nachschlag aus der Teilnehmerliste der Live-Antwort */
export function namensListe(teilnehmer: { id: number; name: string }[]) {
  const m = new Map(teilnehmer.map((x) => [x.id, x.name]));
  return (id: number) => m.get(id) ?? '?';
}

export function SpassLive({ live, gross }: LiveProps<SpassLiveDaten>) {
  const d = live.daten;
  const name = namensListe(live.teilnehmer);
  if (!d || !('rangliste' in d)) return null;
  const r = d.runde;
  const gesamt = d.einstellungen.runden ? ` von ${d.einstellungen.runden}` : '';
  return (
    <div className={`spass${gross ? ' spass--gross' : ''}`}>
      {!r ? (
        <MessageStrip hideCloseButton>Die erste Runde ist noch nicht ausgelost.</MessageStrip>
      ) : (
        <>
          <div className="spass-kopf">
            <span className="spass-kopf__titel">Runde {r.nr}{gesamt}</span>
            <span className="spass-label">{RUNDE_STATUS_TEXT[r.status]} · {r.minuten} Minuten</span>
            <Uhr endeUm={r.endeUm} stand={live.stand} status={r.status} />
          </div>
          {d.fertig && r.status === 'abgeschlossen' && <MessageStrip design="Positive" hideCloseButton>Alle Runden sind gespielt – hier ist die Endwertung.</MessageStrip>}
          <div className="spass-plaetze">
            {r.plaetze.map((p) => <Platzkarte key={p.spiel_id} p={p} name={name} />)}
          </div>
          {r.pausen.length > 0 && (
            <div>
              <div className="spass-label" style={{ marginBottom: '0.25rem' }}>Pause in Runde {r.nr}</div>
              <div className="spass-pausen">
                {r.pausen.map((id) => <span key={id} className="spass-chip">{name(id)}{r.pausen_gewuenscht.includes(id) ? ' (gewünscht)' : ''}</span>)}
              </div>
            </div>
          )}
        </>
      )}
      <div>
        <div className="spass-kopf__titel" style={{ margin: '0.5rem 0 0.25rem' }}>Rangliste</div>
        <div className="spass-label" style={{ marginBottom: '0.25rem' }}>Nach Siegquote (Unentschieden zählt halb), dann Siegen, dann Spieldifferenz – unabhängig vom Partner.</div>
        <Rangliste zeilen={d.rangliste} name={name} />
      </div>
      {d.runden.length > 1 && !gross && (
        <div className="spass-label">
          Runden: {d.runden.map((x) => `${x.nr} (${x.gewertet}/${x.spiele} gewertet${x.status === 'abgeschlossen' ? '' : `, ${RUNDE_STATUS_TEXT[x.status]}`})`).join(' · ')}
        </div>
      )}
    </div>
  );
}
