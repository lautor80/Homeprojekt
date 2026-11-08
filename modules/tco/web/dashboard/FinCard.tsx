import { Icon, Label, MultiComboBox, MultiComboBoxItem } from '@ui5/webcomponents-react';
import { betrag } from '../util';
import { FinChart } from './Chart';
import type { Finanzen, Kpi, State } from './typen';

interface Props {
  kpi: Kpi;
  fin: Finanzen;
  onJahre: (sel: string[]) => void;
  onKonten: (sel: string[]) => void;
}

function Indikator({ title, value, state = 'None', strong }: { title: string; value: string; state?: State | 'Information'; strong?: boolean }) {
  return (
    <div className="portal-fincard__ind">
      <span className="portal-fincard__ind-title" style={strong ? { fontWeight: 700 } : undefined}>{title}</span>
      <span className={`portal-fincard__ind-value portal-fincard__ind-value--${state}`}>{value} <span className="portal-muted portal-small">EUR</span></span>
    </div>
  );
}

/**
 * Analytische Card „Saldo Konten“ (Port von render_fin_card): Kontostand mit Trend und Seitenindikatoren,
 * Liquidität zum aktuellen Monat, Auswahl Geschäftsjahre/Geldkonten und Diagramm Einnahmen/Ausgaben/Kontostand.
 */
export function FinCard({ kpi, fin, onJahre, onKonten }: Props) {
  const eb = fin.kontostand, ab = fin.anfangsbestand;
  const trend = eb > ab ? 'Up' : eb < ab ? 'Down' : 'None';
  const state: State = eb < 0 ? 'Negative' : eb >= ab ? 'Positive' : 'Critical';
  const mm = String(fin.liquiditaet.monat).padStart(2, '0');
  const liq = fin.liquiditaet;
  return (
    <div className="portal-fincard">
      <div className="portal-fincard__head">
        <div className="portal-fincard__main">
          <div className="portal-kpitile__title">{kpi.title}</div>
          <div className="portal-kpitile__subtitle">{fin.kontenText} - {fin.jahreText}</div>
          <div className="portal-kpitile__number" style={{ marginTop: '0.5rem' }}>
            <span className={`portal-kpitile__value portal-kpitile__value--${state}`}>{betrag(eb)}</span>
            <span className="portal-kpitile__scale">EUR</span>
            {trend !== 'None' && <Icon name={trend === 'Up' ? 'trend-up' : 'trend-down'} className={`portal-kpitile__trend portal-kpitile__trend--${state}`} />}
          </div>
          <div className="portal-kpitile__subtitle">{fin.stand ? `Kontostand Ende ${fin.stand}` : 'Keine Ist-Werte im Zeitraum'}</div>
        </div>
        <div className="portal-fincard__side">
          <Indikator title={`Anfangsbestand ${fin.anfangsjahr}`} value={betrag(ab)} />
          <Indikator title="Einnahmen" value={betrag(fin.einnahmen)} state="Positive" />
          <Indikator title="Ausgaben" value={betrag(fin.ausgaben)} state="Critical" />
          <Indikator title="Ergebnis" value={betrag(fin.ergebnis)} state={fin.ergebnis < 0 ? 'Negative' : 'Positive'} />
        </div>
      </div>
      <div className="portal-fincard__body">
        {/* Liquidität zum aktuellen Monat (unabhängig von der Auswahl): Geldkonten + offene Forderungen + Kredite */}
        <div className="portal-fincard__liq">
          <Indikator title={`Geldkonten ${mm}/${liq.jahr}`} value={betrag(liq.geld)} />
          <span className="portal-fincard__op">+</span>
          <Indikator title={liq.ford_stand ? `Forderungen Clubhaus ${liq.ford_stand}` : 'Forderungen Clubhaus'} value={betrag(liq.forderung)} state="Information" />
          <span className="portal-fincard__op">+</span>
          <Indikator title="Kredite (Darlehen)" value={betrag(liq.kredit)} state={liq.kredit < 0 ? 'Negative' : 'None'} />
          <span className="portal-fincard__op">=</span>
          <Indikator title="Liquidität" value={betrag(liq.liquiditaet)} state={liq.liquiditaet < 0 ? 'Negative' : 'Positive'} strong />
        </div>
        <div className="portal-fincard__sel">
          <Label>Geschäftsjahre:</Label>
          <MultiComboBox style={{ width: '16rem' }} placeholder="Jahre auswählen"
                         onSelectionChange={(e) => onJahre(e.detail.items.map((i) => (i as HTMLElement).dataset.key!))}>
            {fin.jahre.map((j) => <MultiComboBoxItem key={j.key} data-key={j.key} text={j.text} selected={fin.jahreSel.includes(j.key)} />)}
          </MultiComboBox>
          <Label>Konten:</Label>
          <MultiComboBox style={{ width: '30rem', maxWidth: '100%' }} placeholder="Geldkonten auswählen"
                         onSelectionChange={(e) => onKonten(e.detail.items.map((i) => (i as HTMLElement).dataset.key!))}>
            {fin.konten.map((k) => <MultiComboBoxItem key={k.key} data-key={k.key} text={k.text} selected={fin.kontenSel.includes(k.key)} />)}
          </MultiComboBox>
        </div>
        <FinChart title={`Einnahmen und Ausgaben je Monat, Entwicklung ${fin.kontenText} - ${fin.jahreText}`} data={fin.verlauf} mehrjahr={fin.mehrjahr} />
      </div>
    </div>
  );
}
