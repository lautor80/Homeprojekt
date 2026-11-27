import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Dialog, MessageStrip } from '@ui5/webcomponents-react';
import { FussLeiste } from '@core/components/DialogFuss';
import { BelegAblage } from './BelegAblage';
import { KEIN_FRACHTAUFTRAG, belegErkennen } from './api';
import { belegMerken, type BelegState } from './vormerkung';

/**
 * Auftragsliste → Neu → „Frachtauftrag aus Beleg…“: Ablagezone für genau einen Beleg (hineinziehen oder auswählen). Der Beleg wird
 * gelesen und die Neuanlage des Frachtauftrags öffnet sich vorbefüllt; Vorschlag und Datei gehen über die Vormerkung mit
 * (vormerkung.ts), nicht über die Adresse. Sieht der Beleg nicht nach einem Frachtauftrag aus, bleibt der Dialog offen.
 */
export function BelegNeuDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [laedt, setLaedt] = useState(false);
  const [meldung, setMeldung] = useState<{ text: string; fehler: boolean } | null>(null);
  /** Nummer des laufenden Lesevorgangs – Schließen des Dialogs verwirft sein Ergebnis */
  const lauf = useRef(0);
  useEffect(() => { if (open) setMeldung(null); }, [open]);

  async function lesen(datei: File) {
    const meiner = ++lauf.current;
    setLaedt(true); setMeldung(null);
    try {
      const vorschlag = await belegErkennen(datei);
      if (meiner !== lauf.current) return;
      if (!vorschlag.istFrachtauftrag) { setMeldung({ text: KEIN_FRACHTAUFTRAG, fehler: false }); return; }
      const state: BelegState = { beleg: belegMerken({ vorschlag, dateiName: datei.name, datei, eingang: null }) };
      navigate('/transport/auftraege/neu/F', { state });
    } catch (e) {
      if (meiner === lauf.current) setMeldung({ text: `Der Beleg „${datei.name}“ konnte nicht gelesen werden: ${(e as Error).message}`, fehler: true });
    } finally {
      if (meiner === lauf.current) setLaedt(false);
    }
  }
  const schliessen = () => { lauf.current++; setLaedt(false); onClose(); };

  if (!open) return null;
  return (
    <Dialog open headerText="Frachtauftrag aus Beleg" style={{ width: 'min(40rem, 96vw)' }} onClose={schliessen}
            footer={<FussLeiste endContent={<Button onClick={schliessen}>Abbrechen</Button>} />}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {meldung && <MessageStrip design={meldung.fehler ? 'Negative' : 'Critical'} hideCloseButton>{meldung.text}</MessageStrip>}
        <BelegAblage onDatei={(f) => { void lesen(f); }} laedt={laedt} />
      </div>
    </Dialog>
  );
}
