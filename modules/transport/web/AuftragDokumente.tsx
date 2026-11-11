import { useEffect, useState } from 'react';
import { useCan } from '@core/session';
import { MailEntwurfDialog } from './MailEntwurf';
import { Button, Icon, Link, MessageStrip, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AblageFlaeche, useAblageZiel, type AblageErgebnis, type AblageZiel } from '@core/ablage';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { download, PdfDialog } from '@core/components/PdfDialog';
import { toast } from '@core/toast';
import { T, dat } from './util';
import { OrdnerDateien } from './Ablageordner';
import { ablegen, ordnerStatus } from './ordner';

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

export function AuftragDokumente({ nr, edit, ordnerStand = 0 }: { nr: string; edit: boolean; ordnerStand?: number }) {
  const [d, setD] = useState<{ paperless: boolean; dokumente: Dok[] } | null>(null);
  // Ablageordner auf diesem PC (#121): hineingezogene Dateien landen zusätzlich dort
  const [ordner, setOrdner] = useState(false);
  const [stand, setStand] = useState(0);
  useEffect(() => { ordnerStatus().then((o) => setOrdner(!!o)).catch(() => setOrdner(false)); }, []);
  const [pdf, setPdf] = useState<Dok | null>(null);
  const can = useCan();
  const [mail, setMail] = useState(false);
  const [loesen, setLoesen] = useState<Dok | null>(null);
  const [error, setError] = useState<string | null>(null);
  const laden = () => api.get<{ paperless: boolean; dokumente: Dok[] }>(`${T}/auftraege/${nr}/dokumente`).then(setD).catch((e) => setError(e.message));
  useEffect(() => { laden(); }, [nr]); // eslint-disable-line react-hooks/exhaustive-deps

  const ziel: AblageZiel = {
    titel: `Auftrag ${nr}`,
    annehmen: async (files): Promise<AblageErgebnis> => {
      const ids: number[] = [];
      const texte: string[] = [];
      let lokal = 0;
      let lokalFehler = '';
      try {
        for (const f of files) {
          if (ordner) {
            try { if (await ablegen(nr, f.name, f)) lokal++; } catch (e) { lokalFehler = (e as Error).message; }
          }
          if (d?.paperless) {
            const r = await api.post<{ id: number; text: string }>(`${T}/auftraege/${nr}/dokumente`, { datei: f.name, inhalt: await lesen(f) });
            ids.push(r.id); texte.push(r.text);
          }
        }
      } finally { laden(); setStand((v) => v + 1); }
      const ord = ordner ? (lokal ? ` · ${lokal} im Ablageordner gespeichert` : ` · Ablageordner: ${lokalFehler || 'kein Zugriff (unten „Zugriff erlauben“)'}`) : '';
      return {
        text: (d?.paperless
          ? (files.length === 1 ? texte[0] : `${ids.length} Datei(en) in Paperless abgelegt und Auftrag ${nr} zugeordnet`)
          : `${lokal} Datei(en) im Ablageordner von Auftrag ${nr} gespeichert`) + (d?.paperless ? ord : ''),
        rueckgaengig: async () => { for (const id of ids) await api.del(`${T}/auftraege/${nr}/dokumente/${id}`); laden(); },
      };
    },
  };
  // Strg+V und Ablagefeld der Navigation legen beim geöffneten Auftrag ab
  useAblageZiel(edit && (d?.paperless || ordner) ? ziel : null);

  const oeffnen = (x: Dok) => {
    const url = `${T}/auftraege/${nr}/dokumente/${x.doc_id}/datei`;
    if (istPdf(x)) setPdf(x);
    else download(url, x.datei || `Dokument_${x.doc_id}`).catch((e) => setError((e as Error).message));
  };

  if (!d) return <Text>Lade Dokumente …</Text>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
      {!d.paperless && <MessageStrip hideCloseButton design="Information">Paperless ist nicht eingerichtet (Administration → Anbindungen).</MessageStrip>}
      {can('transport.versand:execute') && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button icon="email" onClick={() => setMail(true)}>E-Mail mit Anhängen…</Button>
        </div>
      )}
      {mail && <MailEntwurfDialog nr={nr} dokumente={d.dokumente} onClose={() => setMail(false)} />}
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
      <OrdnerDateien nr={nr} version={ordnerStand + stand} />
      {edit && (d.paperless || ordner) && <AblageFlaeche ziel={ziel} text={`Dokumente zum Auftrag hierher ziehen (z. B. unterschriebener Lieferschein, CMR, Foto), klicken zum Auswählen oder Screenshot mit Strg+V einfügen${ordner ? ' – sie landen auch im Ablageordner' : ''}`} />}
      {!edit && !d.dokumente.length && d.paperless && <Text className="portal-muted">Keine Dokumente in Paperless zugeordnet.</Text>}
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
