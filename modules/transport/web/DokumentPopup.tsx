import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Dialog, Icon, Link, MessageStrip, Text, TextArea } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { DialogFuss } from '@core/components/DialogFuss';
import { download } from '@core/components/PdfDialog';
import { toast } from '@core/toast';
import { T, dat } from './util';

/**
 * Popup zu einem Paperless-Dokument im Auftrag: links die Vorschau (archivierte Fassung aus Paperless – PDF, auch für Bilder
 * und Office-Dateien), rechts die Kommentare (Notizen in Paperless) mit Eingabe für einen neuen Kommentar, dazu der Link in
 * die Paperless-Oberfläche und „Herunterladen“ (Original).
 */
interface Notiz { id: number; text: string; erstellt: string; von: string | null }
interface Info { titel: string | null; datei: string | null; datum: string | null; link: string; notizen: Notiz[] }

export function DokumentPopup({ nr, docId, titel, datei, link, edit, onClose, onGeaendert }: {
  nr: string; docId: number; titel: string; datei: string | null; link: string | null; edit: boolean; onClose: () => void; onGeaendert?: () => void;
}) {
  const basis = `${T}/auftraege/${encodeURIComponent(nr)}/dokumente/${docId}`;
  const [info, setInfo] = useState<Info | null>(null);
  const [vorschau, setVorschau] = useState<{ url: string; art: 'pdf' | 'bild' } | null>(null);
  const [vorschauFehler, setVorschauFehler] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [neu, setNeu] = useState('');
  const [speichern, setSpeichern] = useState(false);

  const notizenLaden = () => api.get<Info>(`${basis}/notizen`).then(setInfo).catch((e) => setError((e as Error).message));
  useEffect(() => { void notizenLaden(); }, [basis]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let u: string | null = null;
    setVorschau(null); setVorschauFehler(null);
    fetch(`${basis}/datei?vorschau=1`, { credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) {
          const t = await r.text();
          throw new Error((() => { try { return JSON.parse(t).message as string; } catch { return null; } })() ?? `Fehler ${r.status}`);
        }
        const b = await r.blob();
        const kopf = new TextDecoder('latin1').decode(await b.slice(0, 1024).arrayBuffer());
        if (b.type.startsWith('application/pdf') || kopf.includes('%PDF-')) { u = URL.createObjectURL(new Blob([b], { type: 'application/pdf' })); setVorschau({ url: u, art: 'pdf' }); return; }
        if (b.type.startsWith('image/')) { u = URL.createObjectURL(b); setVorschau({ url: u, art: 'bild' }); return; }
        throw new Error('Für diese Datei gibt es keine Vorschau – bitte „Herunterladen“ oder in Paperless öffnen.');
      })
      .catch((e) => setVorschauFehler((e as Error).message));
    return () => { if (u) URL.revokeObjectURL(u); };
  }, [basis]);

  async function kommentieren() {
    setSpeichern(true); setError(null);
    try {
      const r = await api.post<{ text: string }>(`${basis}/notizen`, { text: neu });
      toast(r.text); setNeu(''); await notizenLaden(); onGeaendert?.();
    } catch (e) { setError((e as Error).message); } finally { setSpeichern(false); }
  }

  const paperlessLink = info?.link ?? link;
  return createPortal(
    <Dialog open headerText={titel} onClose={onClose} resizable style={{ width: '90vw', height: '90vh' }}
            footer={<DialogFuss>
              {paperlessLink && <Button icon="action" onClick={() => window.open(paperlessLink, '_blank', 'noopener')}>In Paperless öffnen</Button>}
              <Button icon="download" onClick={() => download(`${basis}/datei`, datei || `Dokument_${docId}`).catch((e) => setError((e as Error).message))}>Herunterladen</Button>
              <Button onClick={onClose}>Schließen</Button>
            </DialogFuss>}>
      <div className="portal-teilung" style={{ display: 'flex', gap: '1rem', height: '100%', minHeight: 0 }}>
        <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {vorschauFehler && <MessageStrip design="Information" hideCloseButton>{vorschauFehler}</MessageStrip>}
          {!vorschau && !vorschauFehler && <Text className="portal-muted">Lade Vorschau …</Text>}
          {vorschau?.art === 'pdf' && <iframe title="Vorschau" src={vorschau.url} style={{ flex: 1, width: '100%', border: 'none' }} />}
          {vorschau?.art === 'bild' && <div style={{ flex: 1, overflow: 'auto' }}><img alt={titel} src={vorschau.url} style={{ maxWidth: '100%' }} /></div>}
        </div>
        <div style={{ flex: '0 0 22rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', minHeight: 0, borderLeft: '1px solid var(--sapGroup_ContentBorderColor)', paddingLeft: '1rem' }}>
          <div>
            <Text style={{ fontWeight: 'bold', display: 'block' }}>Paperless-Dokument {docId}</Text>
            <Text className="portal-muted portal-small">{info?.datei ?? datei ?? ''}{info?.datum ? ` · Datum ${dat(info.datum)}` : ''}</Text>
            {paperlessLink && <div><Link href={paperlessLink} target="_blank">In Paperless öffnen <Icon name="action" style={{ width: '0.8rem', height: '0.8rem' }} /></Link></div>}
          </div>
          {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
          <Text style={{ fontWeight: 'bold' }}>Kommentare{info ? ` (${info.notizen.length})` : ''}</Text>
          <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {!info && !error && <Text className="portal-muted">Lade Kommentare …</Text>}
            {info && !info.notizen.length && <Text className="portal-muted">Noch keine Kommentare.</Text>}
            {info?.notizen.map((n) => (
              <div key={n.id} style={{ background: 'var(--sapList_Background)', border: '1px solid var(--sapList_BorderColor)', borderRadius: '0.5rem', padding: '0.5rem' }}>
                <Text style={{ whiteSpace: 'pre-wrap', display: 'block' }}>{n.text}</Text>
                <Text className="portal-muted portal-small">{dat(n.erstellt?.slice(0, 10))} {n.erstellt?.slice(11, 16)}{n.von ? ` · ${n.von}` : ''}</Text>
              </div>
            ))}
          </div>
          {edit && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <TextArea rows={3} placeholder="Kommentar schreiben (wird in Paperless als Notiz gespeichert)" value={neu} onInput={(e) => setNeu(e.target.value)} />
              <Button design="Emphasized" icon="comment" disabled={!neu.trim()} loading={speichern} onClick={() => { void kommentieren(); }}>Kommentar speichern</Button>
            </div>
          )}
        </div>
      </div>
    </Dialog>,
    document.body,
  );
}
