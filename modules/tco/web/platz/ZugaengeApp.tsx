import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MessageStrip, SegmentedButton, SegmentedButtonItem, Tab, TabContainer } from '@ui5/webcomponents-react';
import { AppPage, Eingebettet } from '@core/components/AppPage';
import { useCan, useFunktion } from '@core/session';
import { toast } from '@core/toast';
import { MitgliedRegistrierungen } from './MitgliedRegistrierungen';
import { BenutzerZuordnung } from './Platzverwaltung';
import { Ep3Abgleich, Registrierungen } from './Zugaenge';

/**
 * Zugänge (#232, N3): alles rund um Zugänge und Zuordnungen an einer Stelle – bisher vier Orte
 * (Mitglieder → Registrierungen, Platzverwaltung → Zugänge, Platzverwaltung → Benutzer, dort der EP3-Abgleich).
 *
 *   Registrierungen   Umschalter Mitglieder / Hallennutzer – jeweils mit dem bisherigen Recht
 *   Zuordnung         Benutzer ↔ Mitglied bzw. EP3-Kunde (Massenpflege; der einzelne Benutzer bleibt im Benutzer-Dialog)
 *   EP3-Abgleich      EP3-Kunden mit Benutzern abgleichen (abschaltbar über den Funktionsschalter)
 *
 * Adresse: /tco/zugaenge?tab=registrierungen|zuordnung|ep3 (&art=mitglied|halle). Die alten Adressen führen hierher.
 */
type Aktion = (fn: () => Promise<unknown>, nachher?: () => unknown) => Promise<boolean>;
type Art = 'mitglied' | 'halle';

export function ZugaengeApp() {
  const can = useCan();
  const mitglied = can('tco.registrierung:mitglied');
  const halle = can('tco.platz:admin');
  const ep3An = useFunktion()('tco.platz.ep3abgleich');
  const [params, setParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const tabs = [
    { key: 'registrierungen', text: 'Registrierungen', icon: 'add-employee', da: mitglied || halle },
    { key: 'zuordnung', text: 'Zuordnung', icon: 'employee', da: halle },
    { key: 'ep3', text: 'EP3-Abgleich', icon: 'synchronize', da: halle && ep3An },
  ].filter((t) => t.da);
  const tab = tabs.find((t) => t.key === params.get('tab'))?.key ?? tabs[0]?.key;
  const art: Art = !mitglied ? 'halle' : !halle ? 'mitglied' : params.get('art') === 'halle' ? 'halle' : 'mitglied';
  const setze = (neu: Record<string, string>) => { const p = new URLSearchParams(params); Object.entries(neu).forEach(([k, v]) => p.set(k, v)); setParams(p, { replace: true }); };

  const aktion: Aktion = async (fn, nachher) => {
    setError(null);
    try {
      const r = await fn();
      const t = (r as { text?: string } | undefined)?.text;
      if (t) toast(t, 5000);
      await nachher?.();
      return true;
    } catch (e) { setError((e as Error).message); return false; }
  };

  if (!tab) return <AppPage title="Zugänge"><MessageStrip design="Information" hideCloseButton>Für keinen der Reiter liegt eine Berechtigung vor.</MessageStrip></AppPage>;
  return (
    <AppPage title="Zugänge" subtitle="Registrierungen freigeben, Benutzer zuordnen, EP3-Kunden abgleichen">
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <TabContainer tabLayout="Inline" contentBackgroundDesign="Transparent" onTabSelect={(e) => setze({ tab: (e.detail.tab as HTMLElement).dataset.key! })}>
        {tabs.map((t) => (
          <Tab key={t.key} data-key={t.key} text={t.text} icon={t.icon} selected={tab === t.key}>
            {tab === t.key && t.key === 'registrierungen' && (
              <div style={{ paddingTop: '0.5rem' }}>
                {mitglied && halle && (
                  <SegmentedButton style={{ marginBottom: '0.75rem' }} accessibleName="Art der Registrierung"
                                   onSelectionChange={(e) => setze({ art: (e.detail.selectedItems[0] as HTMLElement).dataset.a ?? 'mitglied' })}>
                    <SegmentedButtonItem data-a="mitglied" selected={art === 'mitglied'}>Mitglieder</SegmentedButtonItem>
                    <SegmentedButtonItem data-a="halle" selected={art === 'halle'}>Hallennutzer</SegmentedButtonItem>
                  </SegmentedButton>
                )}
                {art === 'mitglied' ? <Eingebettet><MitgliedRegistrierungen /></Eingebettet> : <Registrierungen aktion={aktion} onOffen={() => undefined} />}
              </div>
            )}
            {tab === t.key && t.key === 'zuordnung' && <BenutzerZuordnung aktion={aktion} />}
            {tab === t.key && t.key === 'ep3' && <Ep3Abgleich aktion={aktion} />}
          </Tab>
        ))}
      </TabContainer>
    </AppPage>
  );
}
