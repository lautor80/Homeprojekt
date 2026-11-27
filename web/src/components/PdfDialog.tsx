import { useEffect, useState, type ReactNode } from 'react';
import { Button, Dialog, MessageStrip } from '@ui5/webcomponents-react';
import { FussLeiste } from './DialogFuss';
import { createPortal } from 'react-dom';

/** Blob mit PDF-Inhalt („%PDF-“ in den ersten 1024 Bytes) als application/pdf; sonst null */
export async function alsPdf(b: Blob): Promise<Blob | null> {
  const kopf = new TextDecoder('latin1').decode(await b.slice(0, 1024).arrayBuffer());
  return kopf.includes('%PDF-') ? new Blob([b], { type: 'application/pdf' }) : null;
}

/** PDF von einer API-Adresse laden und als Blob-URL liefern */
export function usePdf(url: string | null) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    let u: string | null = null;
    setBlobUrl(null);
    setError(null);
    fetch(url, { credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) throw new Error(JSON.parse((await r.text()) || '{}').message ?? `Fehler ${r.status}`);
        return r.blob();
      })
      .then(async (b) => {
        // Server lieferte keinen PDF-Typ (z. B. application/octet-stream): ist der Inhalt ein PDF, als PDF anzeigen – sonst
        // zeigt der Browser im Rahmen nichts an und lädt eine namenlose Datei herunter
        const pdf = b.type.startsWith('application/pdf') ? b : await alsPdf(b);
        if (!pdf) throw new Error('Die Datei ist kein PDF und kann hier nicht angezeigt werden – bitte „Herunterladen“ verwenden.');
        u = URL.createObjectURL(pdf); setBlobUrl(u);
      })
      .catch((e) => setError(e.message));
    return () => { if (u) URL.revokeObjectURL(u); };
  }, [url]);
  return { blobUrl, error };
}

/** Datei aus einer API-Antwort herunterladen */
export async function download(url: string, filename: string) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(JSON.parse(t || '{}').message ?? `Fehler ${res.status}`);
  }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** PDF in einem Dialog anzeigen; weitere Knöpfe über "actions" */
export function PdfDialog({ url, title, filename, actions, onClose }: {
  url: string | null; title: string; filename: string; actions?: ReactNode; onClose: () => void;
}) {
  const { blobUrl, error } = usePdf(url);
  const [dlError, setDlError] = useState<string | null>(null);
  return createPortal(
    <Dialog open={!!url} headerText={title} onClose={onClose} resizable style={{ width: 'min(72rem, 96vw)', height: '88vh' }}
            footer={<FussLeiste endContent={<>
              {actions}
              <Button icon="download" disabled={!url} onClick={() => url && download(url, filename).catch((e) => setDlError(e.message))}>Herunterladen</Button>
              <Button onClick={onClose}>Schließen</Button>
            </>} />}>
      {(error || dlError) && <MessageStrip design="Negative" hideCloseButton>{error ?? dlError}</MessageStrip>}
      {blobUrl && <iframe title="PDF" src={blobUrl} style={{ width: '100%', height: '100%', border: 'none' }} />}
    </Dialog>,
    document.body,
  );
}
