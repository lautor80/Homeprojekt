import { useEffect, useState, type ReactNode } from 'react';
import { Bar, Button, Dialog, MessageStrip } from '@ui5/webcomponents-react';
import { createPortal } from 'react-dom';

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
      .then((b) => { u = URL.createObjectURL(b); setBlobUrl(u); })
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
    <Dialog open={!!url} headerText={title} onClose={onClose} resizable style={{ width: '80vw', height: '88vh' }}
            footer={<Bar endContent={<>
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
