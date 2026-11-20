import { Button, ObjectStatus } from '@ui5/webcomponents-react';
import { useNavigate } from 'react-router-dom';
import { Section } from '@core/components/Section';
import { useCan } from '@core/session';
import type { RegelInfo } from '../server/typen';
import { ARTEN, KATEGORIEN, type Spalte, Tabelle, zahl } from './util';

/** Reiter „Regeln“: alle Prüfregeln mit Treffern im Zeitraum (ohne Stufenfilter); Pflege in der App „Prüfregeln“ */
export function ReiterRegeln({ regeln }: { regeln: RegelInfo[] }) {
  const can = useCan();
  const nav = useNavigate();
  const spalten: Spalte<RegelInfo>[] = [
    { titel: 'Regel', fest: true, wert: (r) => <b>{r.id}</b>, sort: (r) => r.id },
    { titel: 'Name', wert: (r) => r.name, sort: (r) => r.name },
    { titel: 'Art', wert: (r) => `${KATEGORIEN[r.kategorie] ?? r.kategorie} · ${ARTEN[r.art] ?? r.art}`, sort: (r) => r.kategorie + r.art },
    { titel: 'Erkennung', breit: true, wert: (r) => r.erkennung },
    { titel: 'Tipp', breit: true, wert: (r) => r.tipp },
    { titel: 'Anzahl', rechts: true, wert: (r) => r.anzahl, sort: (r) => r.anzahl, summe: (rs) => rs.reduce((s, r) => s + r.anzahl, 0) },
    { titel: 'h', rechts: true, wert: (r) => zahl(r.stunden), sort: (r) => r.stunden },
    { titel: 'Aktiv', wert: (r) => <ObjectStatus state={r.aktiv ? 'Positive' : 'None'} showDefaultIcon={r.aktiv}>{r.aktiv ? 'aktiv' : 'aus'}</ObjectStatus>, sort: (r) => Number(r.aktiv) },
  ];
  return (
    <Section title="Prüfregeln" count={regeln.length} flush
             actions={can('wca.einstellungen:display') ? <Button icon="action-settings" onClick={() => nav('/wca/einstellungen')}>Prüfregeln pflegen</Button> : undefined}>
      <Tabelle<RegelInfo> spalten={spalten} zeilen={regeln} schluessel={(r) => r.id} leer="Keine Regeln" />
    </Section>
  );
}
