import { useState } from 'react';
import { MessageStrip, ObjectStatus } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { Filter, Filters, HeaderKpi } from '@core/components/Filters';
import { Section } from '@core/components/Section';
import { useLoad } from '@core/components/useLoad';
import { eur, JahrAuswahl, M, monatText, summe, Tabelle } from './util';

interface Monat {
  monat: string; vergangen: boolean; sollMiete: number; sollNk: number; istMiete: number; istNk: number;
  kosten: number; umlagefaehig: number; nichtUmlagefaehig: number; mieteranteil: number; nkSaldo: number; ergebnis: number;
}
interface Offen { vertrag_id: number; nummer: string; name: string; einheit: string; soll: number; ist: number; offen: number }

const betragStatus = (v: number) => <ObjectStatus state={v < -0.005 ? 'Negative' : v > 0.005 ? 'Positive' : 'None'}>{eur(v)}</ObjectStatus>;

/**
 * Monatsübersicht: Mieteinnahmen getrennt nach Kaltmiete und Nebenkosten-Abschlag, gegenübergestellt den laufenden
 * Kosten (zeitanteilig nach Leistungszeitraum). „NK-Deckung“ = Abschläge der Mieter minus ihr Anteil an den umlagefähigen Kosten.
 */
export function Uebersicht() {
  const [jahr, setJahr] = useState(new Date().getFullYear());
  const d = useLoad(() => api.get<{ monate: Monat[]; offen: Offen[] }>(`${M}/uebersicht?jahr=${jahr}`), [jahr]);
  const ms = d.data?.monate ?? [];
  const sum = (f: (m: Monat) => number) => ms.reduce((s, m) => s + f(m), 0);
  const nkSaldo = sum((m) => m.nkSaldo);
  const offen = (d.data?.offen ?? []).reduce((s, o) => s + o.offen, 0);

  return (
    <AppPage title="Vermietung – Übersicht" subtitle={`Einnahmen und laufende Kosten ${jahr}`}
      header={<Filters>
        <Filter label="Jahr"><JahrAuswahl jahr={jahr} onChange={setJahr} /></Filter>
        <HeaderKpi label="Kaltmiete (Ist)" value={eur(sum((m) => m.istMiete))} />
        <HeaderKpi label="NK-Abschläge (Ist)" value={eur(sum((m) => m.istNk))} />
        <HeaderKpi label="Kosten gesamt" value={eur(sum((m) => m.kosten))} />
        <HeaderKpi label="NK-Deckung" value={eur(nkSaldo)} state={nkSaldo < 0 ? 'Negative' : 'Positive'} />
        <HeaderKpi label="Offene Mieten" value={eur(offen)} state={offen > 0.005 ? 'Critical' : 'None'} />
      </Filters>}>
      {d.error && <MessageStrip design="Negative" hideCloseButton>{d.error}</MessageStrip>}
      <Section title="Monate" flush>
        <Tabelle<Monat> schluessel={(m) => m.monat} zeilen={ms} spalten={[
          { titel: 'Monat', fest: true, wert: (m) => monatText(m.monat), summe: () => 'Summe' },
          { titel: 'Kaltmiete Soll', rechts: true, wert: (m) => eur(m.sollMiete), summe: summe((m) => m.sollMiete) },
          { titel: 'Kaltmiete Ist', rechts: true, wert: (m) => eur(m.istMiete), summe: summe((m) => m.istMiete) },
          { titel: 'NK-Abschlag Soll', rechts: true, wert: (m) => eur(m.sollNk), summe: summe((m) => m.sollNk) },
          { titel: 'NK-Abschlag Ist', rechts: true, wert: (m) => eur(m.istNk), summe: summe((m) => m.istNk) },
          { titel: 'Kosten umlagefähig', rechts: true, wert: (m) => eur(m.umlagefaehig), summe: summe((m) => m.umlagefaehig) },
          { titel: 'davon Mieter', rechts: true, wert: (m) => eur(m.mieteranteil), summe: summe((m) => m.mieteranteil) },
          { titel: 'NK-Deckung', rechts: true, wert: (m) => betragStatus(m.nkSaldo), summe: (z) => betragStatus(z.reduce((s, m) => s + m.nkSaldo, 0)) },
          { titel: 'nicht umlagefähig', rechts: true, wert: (m) => eur(m.nichtUmlagefaehig), summe: summe((m) => m.nichtUmlagefaehig) },
          { titel: 'Ergebnis', rechts: true, wert: (m) => betragStatus(m.ergebnis), summe: (z) => betragStatus(z.reduce((s, m) => s + m.ergebnis, 0)) },
        ]} />
      </Section>
      <Section title="Mietkonto je Mietverhältnis" flush>
        <Tabelle<Offen> schluessel={(o) => o.vertrag_id} zeilen={d.data?.offen ?? []} leer="Keine Mietverhältnisse in diesem Jahr" spalten={[
          { titel: 'Mieter', wert: (o) => `${o.name} (${o.einheit})` },
          { titel: 'Soll bis heute', rechts: true, wert: (o) => eur(o.soll) },
          { titel: 'Gezahlt', rechts: true, wert: (o) => eur(o.ist) },
          { titel: 'Offen', rechts: true, wert: (o) => <ObjectStatus state={o.offen > 0.005 ? 'Critical' : o.offen < -0.005 ? 'Information' : 'Positive'}>{o.offen < -0.005 ? `Überzahlt ${eur(-o.offen)}` : eur(o.offen)}</ObjectStatus> },
        ]} />
      </Section>
      <p className="portal-muted" style={{ fontSize: '0.8rem' }}>
        Kosten mit Leistungszeitraum (z. B. Jahresbescheid Grundsteuer, Versicherung) werden tageweise auf die Monate verteilt, Belege ohne Zeitraum zählen im Monat des Belegdatums.
        „davon Mieter“ ist der Anteil der vermieteten Wohnungen nach den Verteilerschlüsseln; der Rest (Eigennutzung, Leerstand) bleibt beim Vermieter.
      </p>
    </AppPage>
  );
}
