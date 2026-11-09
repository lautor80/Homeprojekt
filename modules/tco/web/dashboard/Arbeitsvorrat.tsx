import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { Section } from '@core/components/Section';
import { DASH } from './typen';

export interface Aufgabe {
  key: string; bereich: string; titel: string; text: string; datum: string | null; icon: string;
  state: 'Information' | 'Critical' | 'Negative'; pfad: string; betrag?: number;
}

const dat = (iso: string) => iso.split('-').reverse().join('.');

/**
 * Arbeitsvorrat der Vereinsübersicht: offene Vorgänge (z. B. freigegebene Zeitnachweise der Trainer,
 * Registrierungen). Ein Klick öffnet die App, in der der Vorgang erledigt wird. Ohne Einträge unsichtbar.
 */
export function Arbeitsvorrat({ neu, leerText }: { neu: number; leerText?: string }) {
  const [liste, setListe] = useState<Aufgabe[]>([]);
  const navigate = useNavigate();
  useEffect(() => { api.get<Aufgabe[]>(`${DASH}/arbeitsvorrat`).then(setListe).catch(() => setListe([])); }, [neu]);
  if (!liste.length) {
    return leerText ? <Section title="Arbeitsvorrat" count={0}><span className="portal-muted">{leerText}</span></Section> : null;
  }
  return (
    <Section title="Arbeitsvorrat" count={liste.length} flush>
      <div className="portal-av">
        {liste.map((a) => (
          <button key={a.key} type="button" className={`portal-av__eintrag portal-av__eintrag--${a.state}`} onClick={() => navigate(a.pfad)}>
            <Icon name={a.icon} className="portal-av__icon" />
            <div className="portal-av__inhalt">
              <div className="portal-av__titel">{a.titel}</div>
              <div className="portal-av__text">{a.bereich} · {a.text}</div>
            </div>
            <div className="portal-av__datum">{a.datum ? dat(a.datum) : ''}</div>
            <Icon name="navigation-right-arrow" className="portal-av__pfeil" />
          </button>
        ))}
      </div>
    </Section>
  );
}
