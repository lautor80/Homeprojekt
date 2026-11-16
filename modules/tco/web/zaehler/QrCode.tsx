import { Bar, Button, Dialog, Icon, Link, Text } from '@ui5/webcomponents-react';
import { toast } from '@core/toast';
import { ERFASSEN_PFAD, QR_URL } from './format';
import './zaehler.css';

/** QR-Code zum Ausdrucken: führt am Zähler direkt zur Erfassung mit vorbelegtem Zähler */
export function QrDialog({ id, nummer, bezeichnung, standort, onClose }: { id: number; nummer: string; bezeichnung: string; standort: string | null; onClose: () => void }) {
  const link = `${window.location.origin}${ERFASSEN_PFAD(id)}`;
  function drucken() {
    const w = window.open('', '_blank', 'width=480,height=640');
    if (!w) { toast('Bitte Pop-ups für das Portal erlauben, um den QR-Code zu drucken.'); return; }
    const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>QR-Code ${esc(nummer)}</title>
      <style>body{font-family:Arial,Helvetica,sans-serif;text-align:center;margin:2rem}img{width:6cm;height:6cm}h1{font-size:16pt;margin:.5rem 0 0}p{margin:.25rem 0;font-size:11pt}</style>
      </head><body><img src="${esc(new URL(QR_URL(id), window.location.origin).href)}" alt="QR-Code" onload="setTimeout(function(){window.print()},200)">
      <h1>${esc(nummer)} · ${esc(bezeichnung)}</h1>${standort ? `<p>${esc(standort)}</p>` : ''}<p>Zählerstand erfassen: QR-Code scannen</p></body></html>`);
    w.document.close();
  }
  return (
    <Dialog open headerText={`QR-Code ${nummer}`} onClose={onClose} style={{ width: 'min(26rem, 96vw)' }}
            footer={<Bar endContent={<>
              <Button design="Emphasized" icon="print" onClick={drucken}>Drucken</Button>
              <Button onClick={onClose}>Schließen</Button>
            </>} />}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', textAlign: 'center' }}>
        <img className="zs-qr" src={QR_URL(id)} alt={`QR-Code für ${bezeichnung}`} />
        <Text><Icon name="hint" style={{ verticalAlign: 'middle', marginRight: '0.25rem' }} />QR-Code am Zähler anbringen: Wer ihn scannt, landet nach der Anmeldung direkt bei der Erfassung dieses Zählers.</Text>
        <Link href={link} target="_blank" wrappingType="Normal">{link}</Link>
      </div>
    </Dialog>
  );
}
