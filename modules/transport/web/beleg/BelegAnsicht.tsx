import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Dialog, MessageStrip, Text } from '@ui5/webcomponents-react';
import { DialogFuss } from '@core/components/DialogFuss';
import { dateiUrl } from '../eingang/typen';
import type { BelegQuelle } from './vormerkung';

/**
 * Beleg zur Kontrolle ansehen: links die Datei (PDF oder Bild), rechts der Text, den die Erkennung gelesen hat.
 * Aufbau wie DokumentPopup.tsx (dort für Paperless-Dokumente eines gespeicherten Auftrags).
 */
export function BelegAnsicht({ quelle, onClose }: { quelle: BelegQuelle; onClose: () => void }) {
  const [vorschau, setVorschau] = useState<{ url: string; art: 'pdf' | 'bild' } | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const { datei, eingang } = quelle;
  const dokument = eingang?.dokument ?? null;

  useEffect(() => {
    let u: string | null = null;
    let ende = false;
    setVorschau(null); setFehler(null);
    const zeigen = async (b: Blob) => {
      if (ende) return;
      const kopf = new TextDecoder('latin1').decode(await b.slice(0, 1024).arrayBuffer());
      if (ende) return;
      if (b.type.startsWith('application/pdf') || kopf.includes('%PDF-')) { u = URL.createObjectURL(new Blob([b], { type: 'application/pdf' })); setVorschau({ url: u, art: 'pdf' }); return; }
      if (b.type.startsWith('image/')) { u = URL.createObjectURL(b); setVorschau({ url: u, art: 'bild' }); return; }
      throw new Error('Für diese Datei gibt es keine Vorschau.');
    };
    const laden = async (): Promise<Blob> => {
      if (datei) return datei;
      if (dokument === null) throw new Error('Die Datei liegt hier nicht vor.');
      const r = await fetch(dateiUrl(dokument), { credentials: 'same-origin' });
      if (!r.ok) {
        const t = await r.text();
        throw new Error((() => { try { return JSON.parse(t).message as string; } catch { return null; } })() ?? `Fehler ${r.status}`);
      }
      return r.blob();
    };
    laden().then(zeigen).catch((e) => { if (!ende) setFehler((e as Error).message); });
    return () => { ende = true; if (u) URL.revokeObjectURL(u); };
  }, [datei, dokument]);

  const text = quelle.vorschlag.text.trim();
  return createPortal(
    <Dialog open headerText={`Beleg: ${quelle.dateiName}`} onClose={onClose} resizable style={{ width: '90vw', height: '90vh' }}
            footer={<DialogFuss><Button onClick={onClose}>Schließen</Button></DialogFuss>}>
      <div style={{ display: 'flex', gap: '1rem', height: '100%', minHeight: 0 }}>
        <div style={{ flex: '1 1 55%', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {fehler && <MessageStrip design="Information" hideCloseButton>{fehler}</MessageStrip>}
          {!vorschau && !fehler && <Text className="portal-muted">Lade Vorschau …</Text>}
          {vorschau?.art === 'pdf' && <iframe title="Beleg" src={vorschau.url} style={{ flex: 1, width: '100%', border: 'none' }} />}
          {vorschau?.art === 'bild' && <div style={{ flex: 1, overflow: 'auto' }}><img alt={quelle.dateiName} src={vorschau.url} style={{ maxWidth: '100%' }} /></div>}
        </div>
        <div style={{ flex: '1 1 45%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem', minHeight: 0, borderLeft: '1px solid var(--sapGroup_ContentBorderColor)', paddingLeft: '1rem' }}>
          <div>
            <Text style={{ fontWeight: 'bold', display: 'block' }}>Gelesener Text</Text>
            <Text className="portal-muted portal-small">So hat das Portal den Beleg gelesen (Leseprofil „{quelle.vorschlag.profil}“) – Grundlage aller Vorschläge.</Text>
          </div>
          {text
            ? <pre style={{ flex: 1, overflow: 'auto', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit' }}>{text}</pre>
            : <Text className="portal-muted">Es wurde kein Text gelesen.</Text>}
        </div>
      </div>
    </Dialog>,
    document.body,
  );
}
