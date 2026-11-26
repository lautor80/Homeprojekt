import { useRef, useState, type DragEvent } from 'react';
import { BusyIndicator, Icon } from '@ui5/webcomponents-react';
import { toast } from '@core/toast';
import { BELEG_ACCEPT, istBelegDatei } from './api';

/**
 * Ablagezone „Auftrag aus Beleg“: genau eine PDF-/PNG-/JPG-Datei hineinziehen oder anklicken und auswählen. Die Datei wird nur
 * an `onDatei` übergeben (Erkennung) – abgelegt wird hier nichts. Bewusst ein eigenes Feld und nicht das Ablagefeld aus
 * @core/ablage: Jenes legt Dateien ab (Paperless/Ablageordner) und meldet „Wird abgelegt bei …“.
 */
export function BelegAblage({ onDatei, laedt, text }: {
  onDatei: (datei: File) => void;
  /** Erkennung läuft: Ladeanzeige, keine weitere Datei */
  laedt: boolean;
  text?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const tiefe = useRef(0);
  const [ueber, setUeber] = useState(false);
  const hatDateien = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const uebergeben = (alle: File[]) => {
    if (laedt || !alle.length) return;
    const passend = alle.filter(istBelegDatei);
    if (!passend.length) { toast('Bitte eine PDF-Datei oder ein Bild (PNG, JPG) ablegen.', 5000); return; }
    if (alle.length > 1) toast(`Es wird ein Beleg gelesen: „${passend[0].name}“ – weitere Dateien bitte nach dem Speichern im Auftrag ablegen.`, 6000);
    onDatei(passend[0]);
  };
  const beschriftung = text ?? 'Auftrag aus Beleg: PDF oder Bild hierher ziehen oder auswählen';
  return (
    <>
      <input ref={input} type="file" accept={BELEG_ACCEPT} hidden
             onChange={(e) => { uebergeben(Array.from(e.target.files ?? []) as File[]); e.target.value = ''; }} />
      <div className={`portal-ablagebox${ueber ? ' portal-ablagebox--ueber' : ''}${laedt ? ' portal-ablagebox--aus' : ''}`}
           role="button" tabIndex={laedt ? -1 : 0} aria-label={beschriftung} aria-busy={laedt}
           onClick={() => { if (!laedt) input.current?.click(); }}
           onKeyDown={(e) => { if (!laedt && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); input.current?.click(); } }}
           onDragEnter={(e) => { if (hatDateien(e)) { e.preventDefault(); tiefe.current++; setUeber(true); } }}
           onDragOver={(e) => { if (hatDateien(e)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = laedt ? 'none' : 'copy'; } }}
           onDragLeave={() => { tiefe.current = Math.max(0, tiefe.current - 1); if (!tiefe.current) setUeber(false); }}
           onDrop={(e) => {
             if (!hatDateien(e)) return;
             e.preventDefault(); e.stopPropagation(); tiefe.current = 0; setUeber(false);
             uebergeben(Array.from(e.dataTransfer.files));
           }}>
        {laedt ? <BusyIndicator active size="S" /> : <Icon name={ueber ? 'download' : 'add-document'} />}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 'bold', color: 'var(--sapTextColor)' }}>
            {laedt ? 'Beleg wird gelesen …' : ueber ? 'Loslassen – der Beleg wird gelesen' : beschriftung}
          </div>
          <div className="portal-small">
            {laedt ? 'Das kann bei gescannten Belegen einen Moment dauern.'
              : 'Frachtauftrag des Kunden als PDF, PNG oder JPG. Das Portal liest den Text und füllt die Maske vor – gespeichert wird erst mit „Speichern“.'}
          </div>
        </div>
      </div>
    </>
  );
}
