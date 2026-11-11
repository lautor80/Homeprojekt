import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bar, Button, Dialog, FlexBox, Icon, MessageStrip, ObjectStatus, Text, Title } from '@ui5/webcomponents-react';
import { api, qs } from '@core/api';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { toast } from '@core/toast';
import { F } from './typen';

/**
 * #3: FI-Perioden (Monate) abschließen. Abgeschlossen ist immer ein lückenloser Zeitraum bis zu einem Monat:
 * „Bis hier abschließen“ schließt alle offenen Monate davor mit, „Ab hier öffnen“ öffnet auch alle späteren wieder.
 */
interface Monat { monat: number; name: string; geschlossen: boolean; geschlossen_am: string | null; geschlossen_von: string | null; buchungen: number; vergangen: boolean }
interface Perioden { jahr: number; monate: Monat[]; abgeschlossenBis: string | null }
type Frage = { art: 'abschliessen' | 'oeffnen'; m: Monat };

export function PeriodenDialog({ open, jahr: start, edit, onClose, onChanged }: {
  open: boolean; jahr: number; edit: boolean; onClose: () => void; onChanged: (abgeschlossenBis: string | null) => void;
}) {
  const [jahr, setJahr] = useState(start);
  const [d, setD] = useState<Perioden | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [frage, setFrage] = useState<Frage | null>(null);
  useEffect(() => { if (open) setJahr(start); }, [open, start]);
  const laden = () => api.get<Perioden>(`${F}/perioden${qs({ jahr })}`).then((r) => { setD(r); onChanged(r.abgeschlossenBis); }).catch((e) => setFehler(e.message));
  useEffect(() => { if (open) { setD(null); setFehler(null); laden(); } }, [open, jahr]); // eslint-disable-line react-hooks/exhaustive-deps

  async function ausfuehren(f: Frage, grund: string) {
    setFrage(null);
    try {
      const r = await api.post<{ text: string }>(`${F}/perioden/${f.art}`, { jahr, monat: f.m.monat, grund });
      toast(r.text);
      await laden();
    } catch (e) { setFehler((e as Error).message); }
  }

  return createPortal(<>
    <Dialog open={open} headerText="FI-Perioden" onClose={onClose} style={{ width: 'min(44rem, 95vw)' }}
            footer={<Bar endContent={<Button onClick={onClose}>Schließen</Button>} />}>
      <FlexBox alignItems="Center" justifyContent="SpaceBetween" style={{ marginBottom: '0.5rem' }}>
        <Button icon="navigation-left-arrow" design="Transparent" tooltip="Vorjahr" onClick={() => setJahr(jahr - 1)} />
        <Title level="H4">Geschäftsjahr {jahr}</Title>
        <Button icon="navigation-right-arrow" design="Transparent" tooltip="Folgejahr" onClick={() => setJahr(jahr + 1)} />
      </FlexBox>
      <MessageStrip hideCloseButton style={{ marginBottom: '0.5rem' }}>
        In einer abgeschlossenen Periode können keine Buchungen mehr erfasst, storniert oder in ihren Werten geändert werden
        (Bankimport, manuelle Buchung, Storno). Belege, Notizen und Rechnungsbezüge bleiben pflegbar.
        Abgeschlossen wird immer bis einschließlich des gewählten Monats; der laufende Monat bleibt offen.
      </MessageStrip>
      {fehler && <MessageStrip design="Negative" onClose={() => setFehler(null)} style={{ marginBottom: '0.5rem' }}>{fehler}</MessageStrip>}
      {d && (
        <div style={{ display: 'grid', gridTemplateColumns: '8rem 6rem minmax(0, 1fr) auto', gap: '0.35rem 0.75rem', alignItems: 'center' }}>
          {d.monate.map((m) => (
            <div key={m.monat} style={{ display: 'contents' }}>
              <Text style={{ fontWeight: 'bold' }}>{m.name}</Text>
              <Text>{m.buchungen} Buchung{m.buchungen === 1 ? '' : 'en'}</Text>
              <span>
                {m.geschlossen
                  ? <ObjectStatus state="Positive" icon={<Icon name="locked" />}>abgeschlossen{m.geschlossen_am ? ` am ${new Date(m.geschlossen_am).toLocaleDateString('de-DE')}` : ''}{m.geschlossen_von ? ` von ${m.geschlossen_von}` : ''}</ObjectStatus>
                  : <ObjectStatus state={m.vergangen ? 'Critical' : 'None'} icon={<Icon name="unlocked" />}>{m.vergangen ? 'offen' : 'offen (laufend/künftig)'}</ObjectStatus>}
              </span>
              <span>
                {edit && !m.geschlossen && m.vergangen && <Button design="Transparent" icon="locked" onClick={() => setFrage({ art: 'abschliessen', m })}>Bis hier abschließen</Button>}
                {edit && m.geschlossen && <Button design="Transparent" icon="unlocked" onClick={() => setFrage({ art: 'oeffnen', m })}>Ab hier öffnen</Button>}
              </span>
            </div>
          ))}
        </div>
      )}
    </Dialog>
    <ConfirmDialog open={!!frage}
                   title={frage?.art === 'oeffnen' ? 'Periode wieder öffnen' : 'Perioden abschließen'}
                   text={frage?.art === 'oeffnen'
                     ? `${frage.m.name} ${jahr} und alle späteren abgeschlossenen Perioden wieder öffnen? Danach sind dort wieder Buchungen und Stornos möglich.`
                     : `Alle offenen Perioden bis einschließlich ${frage?.m.name ?? ''} ${jahr} abschließen? Danach sind dort keine Buchungen, Stornos oder Änderungen mehr möglich.`}
                   confirmText={frage?.art === 'oeffnen' ? 'Öffnen' : 'Abschließen'}
                   askReason={frage?.art === 'oeffnen'} danger={frage?.art === 'oeffnen'}
                   onConfirm={(grund) => frage && ausfuehren(frage, grund)} onCancel={() => setFrage(null)} />
  </>, document.body);
}
