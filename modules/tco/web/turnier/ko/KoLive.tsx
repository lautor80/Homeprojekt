import { MessageStrip } from '@ui5/webcomponents-react';
import type { KoLiveDaten, KoLiveFeld, KoLiveSpiel } from '../../../server/turnier/ko-logik';
import { ergebnisText, type LiveProps } from '../api';
import './ko.css';

/**
 * Turniere – Live-Ansicht Modus „ko“: Tableau von Hauptfeld und Nebenrunde als nebeneinander stehende Rundenspalten
 * (horizontal scrollbar), Setzplatz-Kennzeichen, Sieger fett, Ergebnis aus Sicht des Siegers. gross = Beamer.
 */
export function KoLive({ live, gross }: LiveProps<KoLiveDaten>) {
  const d = live.daten;
  const namen = new Map(live.teilnehmer.map((t) => [t.id, t.name]));
  if (!d?.ausgelost) return <MessageStrip hideCloseButton>Das Feld ist noch nicht ausgelost.</MessageStrip>;
  return <KoTableau daten={d} namen={namen} gross={gross} />;
}

interface TableauProps {
  daten: KoLiveDaten;
  namen: Map<number, string>;
  gross?: boolean;
  /** Verwaltung: Klick auf ein Spiel mit feststehender Paarung */
  onSpiel?: (s: KoLiveSpiel, feld: 'haupt' | 'neben') => void;
}

/** Tableau beider Felder (auch von der Verwaltung genutzt) */
export function KoTableau({ daten, namen, gross, onSpiel }: TableauProps) {
  return (
    <div className={`portal-ko${gross ? ' portal-ko--gross' : ''}`}>
      {daten.haupt && <Feld titel="Hauptfeld" feld={daten.haupt} art="haupt" daten={daten} namen={namen} onSpiel={onSpiel} />}
      {daten.neben && <Feld titel="Nebenrunde" feld={daten.neben} art="neben" daten={daten} namen={namen} onSpiel={onSpiel} />}
    </div>
  );
}

function Feld({ titel, feld, art, daten, namen, onSpiel }: { titel: string; feld: KoLiveFeld; art: 'haupt' | 'neben' } & Omit<TableauProps, 'gross'>) {
  return (
    <div>
      <h4 className="portal-ko__feldtitel">
        {titel}
        {feld.sieger != null && <span className="portal-ko__sieger">Sieger: <b>{namen.get(feld.sieger) ?? '?'}</b></span>}
      </h4>
      <div className="portal-ko__tableau" role="list" aria-label={titel}>
        {feld.runden.map((r) => (
          <div key={r.nr} className="portal-ko__runde" role="listitem">
            <div className="portal-ko__rundentitel" title={r.titel}>
              {r.titel}
              {art === 'neben' && r.einstieg != null && <span className="portal-ko__einstieg">Einstieg Verlierer {r.einstieg}. Runde</span>}
            </div>
            <div className="portal-ko__spiele">
              {r.spiele.map((s) => <SpielKarte key={s.id} s={s} daten={daten} namen={namen} onSpiel={onSpiel ? () => onSpiel(s, art) : undefined} />)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SpielKarte({ s, daten, namen, onSpiel }: { s: KoLiveSpiel; daten: KoLiveDaten; namen: Map<number, string>; onSpiel?: () => void }) {
  const frei = s.wertung === 'freilos';
  const zeile = (seite: 'a' | 'b') => {
    const id = s[seite];
    const setz = id != null ? daten.gesetzte[id] : undefined;
    const sieger = s.sieger === seite;
    return (
      <div className={`portal-ko__zeile${sieger ? ' portal-ko__zeile--sieger' : ''}`}>
        {id != null
          ? <span className="portal-ko__name" title={namen.get(id)}>{namen.get(id) ?? '?'}</span>
          : <span className="portal-ko__name portal-ko__leer">{frei ? 'Freilos' : '–'}</span>}
        {setz != null && <span className="portal-ko__setz" title={`Setzplatz ${setz}`}>{setz}</span>}
      </div>
    );
  };
  const text = s.wertung === 'freilos' ? '' : ergebnisText(s, s.sieger === 'b' ? 'b' : 'a');
  const inhalt = (
    <>
      {zeile('a')}
      {zeile('b')}
      {text && <div className="portal-ko__ergebnis">{text}</div>}
    </>
  );
  const klickbar = onSpiel && s.a != null && s.b != null && !frei;
  const titel = `${s.a != null ? namen.get(s.a) ?? '?' : '–'} gegen ${s.b != null ? namen.get(s.b) ?? '?' : '–'}${text ? `: ${text}` : ''}`;
  return klickbar
    ? <button type="button" className="portal-ko__spiel" onClick={onSpiel} title={`${titel} – Ergebnis eintragen`}>{inhalt}</button>
    : <div className={`portal-ko__spiel${frei ? ' portal-ko__spiel--frei' : ''}`} title={titel}>{inhalt}</div>;
}
