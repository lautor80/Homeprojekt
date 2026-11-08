import { useEffect, useState } from 'react';
import { Button, Icon, Link, MessageStrip, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AblageFlaeche, useAblageZiel, type AblageErgebnis, type AblageZiel } from '@core/ablage';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { download, PdfDialog } from '@core/components/PdfDialog';
import { toast } from '@core/toast';
import { T, dat } from './util';

/**
 * Dokumente zum Auftrag (Paperless): Dateien hineinziehen, auswählen oder Screenshot mit Strg+V einfügen.
 * Ablage mit Titel „Auftrag … – Dateiname“, Kunde als Korrespondent und Tag „Auftrag …“.
 */
interface Dok { doc_id: number; titel: string | null; datei: string | null; erstellt_am: string; erstellt_von: string | null }

const lesen = (f: File) => new Promise<string>((ok, err) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result));
  r.onerror = () => err(r.error);
  r.readAsDataURL(f);
});
const istPdf = (d: Dok) => /\.pdf$/i.test(d.datei ?? '');

export function AuftragDokumente({ nr, edit }: { nr: string; edit: boolean }) {
  const [d, setD] = useState<{ paperless: boolean; dokumente: Dok[] } | null>(null);
  const [pdf, setPdf] = useState<Dok | null>(null);
  const [loesen, setLoesen] = useState<Dok | null>(null);
  const [error, setError] = useState<string | null>(null);
  const laden = () => api.get<{ paperless: boolean; dokumente: Dok[] }>(`${T}/auftraege/${nr}/dokumente`).then(setD).catch((e) => setError(e.message));
  useEffect(() => { laden(); }, [nr]); // eslint-disable-line react-hooks/exhaustive-deps

  const ziel: AblageZiel = {
    titel: `Auftrag ${nr}`,
    annehmen: async (files): Promise<AblageErgebnis> => {
      const ids: number[] = [];
      const texte: string[] = [];
      try {
        for (const f of files) {
          const r = await api.post<{ id: number; text: string }>(`${T}/auftraege/${nr}/dokumente`, { datei: f.name, inhalt: await lesen(f) });
          ids.push(r.id); texte.push(r.text);
        }
      } finally { laden(); }
      return {
        text: files.length === 1 ? texte[0] : `${ids.length} Datei(en) in Paperless abgelegt und Auftrag ${nr} zugeordnet`,
        rueckgaengig: async () => { for (const id of ids) await api.del(`${T}/auftraege/${nr}/dokumente/${id}`); laden(); },
      };
    },
  };
  // Strg+V und Ablagefeld der Navigation legen beim geöffneten Auftrag ab
  useAblageZiel(edit && d?.paperless ? ziel : null);

  const oeffnen = (x: Dok) => {
    const url = `${T}/auftraege/${nr}/dokumente/${x.doc_id}/datei`;
    if (istPdf(x)) setPdf(x);
    else download(url, x.datei || `Dokument_${x.doc_id}`).catch((e) => setError((e as Error).message));
  };

  if (!d) return <Text>Lade Dokumente …</Text>;
  if (!d.paperless) return <MessageStrip hideCloseButton design="Information">Paperless ist nicht eingerichtet (Stammdaten → Firmendaten: URL und API-Token).</MessageStrip>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
      {d.dokumente.length > 0 && (
        <div className="portal-ad">
          {d.dokumente.map((x) => (
            <div key={x.doc_id} className="portal-ad__zeile">
              <Icon name={istPdf(x) ? 'pdf-attachment' : /\.(png|jpe?g|gif|webp|heic|tiff?)$/i.test(x.datei ?? '') ? 'picture' : 'document'} />
              <div style={{ minWidth: 0 }}>
                <Link onClick={() => oeffnen(x)}>{x.datei || x.titel || `Dokument ${x.doc_id}`}</Link>
                <div className="portal-muted portal-small">Paperless {x.doc_id} · {dat(x.erstellt_am.slice(0, 10))}{x.erstellt_von ? ` · ${x.erstellt_von}` : ''}</div>
              </div>
              {edit && <Button design="Transparent" icon="decline" tooltip="Zuordnung lösen (Dokument bleibt in Paperless)" onClick={() => setLoesen(x)} />}
            </div>
          ))}
        </div>
      )}
      {edit && <AblageFlaeche ziel={ziel} text="Dokumente zum Auftrag hierher ziehen (z. B. unterschriebener Lieferschein, CMR, Foto), klicken zum Auswählen oder Screenshot mit Strg+V einfügen" />}
      {!edit && !d.dokumente.length && <Text className="portal-muted">Keine Dokumente zugeordnet.</Text>}
      {pdf && <PdfDialog url={`${T}/auftraege/${nr}/dokumente/${pdf.doc_id}/datei`} title={pdf.titel ?? pdf.datei ?? ''} filename={pdf.datei ?? 'dokument.pdf'} onClose={() => setPdf(null)} />}
      <ConfirmDialog open={!!loesen} title="Zuordnung lösen" confirmText="Lösen"
                     text={`„${loesen?.datei ?? ''}“ vom Auftrag ${nr} lösen? Das Dokument bleibt in Paperless erhalten.`}
                     onCancel={() => setLoesen(null)}
                     onConfirm={async () => {
                       const x = loesen!; setLoesen(null);
                       try { const r = await api.del<{ text: string }>(`${T}/auftraege/${nr}/dokumente/${x.doc_id}`); toast(r.text); laden(); } catch (e) { setError((e as Error).message); }
                     }} />
    </div>
  );
}
