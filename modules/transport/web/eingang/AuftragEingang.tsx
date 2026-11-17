import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, FlexBox, Icon, Link, MessageStrip, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { PdfDialog } from '@core/components/PdfDialog';
import { useCan, useFunktion } from '@core/session';
import { toast } from '@core/toast';
import { T } from '../util';
import { ablegenUnterordner, ordnerMoeglich, ordnerStatus, ordnerWaehlen, UNTERORDNER_EINGANG } from '../ordner';
import { STATUS_TEXT, dateiUrl, groesse, istPdf, liste, zeitText, type AuftragEingangDokument } from './typen';

/**
 * Auftrag → Dokumente, Abschnitt „Aus dem Posteingang“ (nur mit Funktion „Posteingang“): Dateien, die der Posteingang an
 * diesem Auftrag abgelegt hat. Mit Ablageziel „lokal“ warten sie im Portal (Status „wartet“), bis jemand den Auftrag mit
 * verbundenem Ablageordner öffnet: Dann schreibt der Browser sie nach <Auftragsordner>/Eingang/ und meldet jede mit
 * POST /eingang/dokumente/:id/uebernommen – der Server löscht daraufhin den Inhalt.
 * Laden des Inhalts verlangt transport.eingang:edit, das Melden transport.auftraege:edit; ohne diese Rechte nur ein Hinweis.
 */
type OrdnerZustand = 'pruefen' | 'kein' | 'zugriff' | 'bereit';

export function AuftragEingang({ nr, onUebernommen }: { nr: string; onUebernommen?: () => void }) {
  const funktion = useFunktion();
  const can = useCan();
  const aktiv = funktion('transport.eingang');
  const darfLaden = can('transport.eingang:edit');
  const darfMelden = can('transport.auftraege:edit');
  const [doks, setDoks] = useState<AuftragEingangDokument[] | null>(null);
  const [ordner, setOrdner] = useState<OrdnerZustand>('pruefen');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pdf, setPdf] = useState<AuftragEingangDokument | null>(null);
  // je Auftrag nur einmal automatisch übernehmen (auch bei doppelt laufenden Effekten)
  const automatisch = useRef<string | null>(null);

  const laden = useCallback(async () => {
    if (!aktiv) return;
    try { setDoks(liste<AuftragEingangDokument>(await api.get<unknown>(`${T}/auftraege/${nr}/eingang`), 'dokumente')); }
    catch { setDoks([]); } // ohne Recht oder ohne Server-Teil: Abschnitt bleibt weg
  }, [aktiv, nr]);
  const ordnerPruefen = useCallback(async () => {
    const st = ordnerMoeglich ? await ordnerStatus().catch(() => null) : null;
    setOrdner(!st ? 'kein' : st.zugriff ? 'bereit' : 'zugriff');
  }, []);
  useEffect(() => { laden(); ordnerPruefen(); }, [laden, ordnerPruefen]);

  const wartend = (doks ?? []).filter((d) => d.status === 'wartet' && d.ziel === 'lokal');

  const uebernehmen = useCallback(async (anfordern: boolean) => {
    const offen = (doks ?? []).filter((d) => d.status === 'wartet' && d.ziel === 'lokal');
    if (!offen.length || !darfLaden || !darfMelden) return;
    setBusy(true); setError(null);
    let n = 0;
    let fehler = '';
    try {
      for (let i = 0; i < offen.length; i++) {
        const d = offen[i];
        try {
          const res = await fetch(dateiUrl(d.id), { credentials: 'same-origin' });
          if (!res.ok) {
            const t = await res.text();
            throw new Error((() => { try { return JSON.parse(t).message; } catch { return null; } })() ?? `Fehler ${res.status}`);
          }
          // nur beim ersten Schreiben nach dem Zugriff fragen (direkt nach dem Klick)
          const pfad = await ablegenUnterordner(nr, UNTERORDNER_EINGANG, d.datei, await res.blob(), anfordern && i === 0);
          if (!pfad) { fehler = 'Kein Zugriff auf den Ablageordner.'; break; }
          await api.post(`${T}/eingang/dokumente/${d.id}/uebernommen`);
          n++;
        } catch (e) { fehler = `${d.datei}: ${(e as Error).message}`; }
      }
    } finally {
      setBusy(false);
      if (n) { toast(`${n} ${n === 1 ? 'Datei' : 'Dateien'} aus dem Posteingang übernommen`, 5000); onUebernommen?.(); }
      if (fehler) setError(`Übernahme in den Ablageordner unvollständig – ${fehler}`);
      await ordnerPruefen();
      await laden();
    }
  }, [doks, darfLaden, darfMelden, nr, onUebernommen, laden, ordnerPruefen]);

  // automatisch beim Öffnen: Ordner verbunden und Zugriff erteilt
  useEffect(() => {
    if (ordner !== 'bereit' || !wartend.length || !darfLaden || !darfMelden || automatisch.current === nr) return;
    automatisch.current = nr;
    uebernehmen(false);
  }, [ordner, wartend.length, darfLaden, darfMelden, nr, uebernehmen]);

  async function verbinden() {
    setError(null);
    try { await ordnerWaehlen(); await ordnerPruefen(); await uebernehmen(true); } catch (e) {
      if ((e as DOMException).name !== 'AbortError') setError((e as Error).message);
    }
  }

  if (!aktiv || !doks || !doks.length) return null;

  const anzahl = `${wartend.length} ${wartend.length === 1 ? 'Datei wartet' : 'Dateien warten'} auf Übernahme`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <FlexBox alignItems="Center" style={{ gap: '0.75rem', paddingLeft: 'calc(0.75rem + 1px)' }}>
        <Icon name="inbox" />
        <Text><b>Aus dem Posteingang</b> <span className="portal-muted">{wartend.length ? `· ${anzahl}` : ''}</span></Text>
        <Button design="Transparent" icon="refresh" tooltip="Neu laden" disabled={busy} onClick={() => { laden(); ordnerPruefen(); }} />
      </FlexBox>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
      {wartend.length > 0 && !busy && (
        !darfLaden || !darfMelden ? (
          <MessageStrip hideCloseButton design="Information">
            {anzahl} – zum Übernehmen in den Ablageordner fehlt das Recht „{!darfLaden ? 'Posteingang bearbeiten' : 'Aufträge ändern'}“.
          </MessageStrip>
        ) : ordner === 'kein' ? (
          <MessageStrip hideCloseButton design="Critical">
            {anzahl} –{' '}
            {ordnerMoeglich ? <Link onClick={verbinden}>Ablageordner verbinden</Link> : 'dieser Browser kann keinen Ablageordner verbinden (bitte Microsoft Edge oder Google Chrome verwenden)'}
          </MessageStrip>
        ) : ordner === 'zugriff' ? (
          <MessageStrip hideCloseButton design="Critical">
            {anzahl} – <Link onClick={() => uebernehmen(true)}>Zugriff auf den Ablageordner erlauben und übernehmen</Link>
          </MessageStrip>
        ) : null
      )}
      {busy && <Text className="portal-muted">Dateien werden in den Ablageordner (Unterordner „{UNTERORDNER_EINGANG}“) übernommen …</Text>}
      <div className="portal-ad">
        {doks.map((d) => (
          <div key={d.id} className="portal-ad__zeile">
            <Icon name={istPdf(d) ? 'pdf-attachment' : /^image\//.test(d.mime ?? '') ? 'picture' : 'document'} />
            <div style={{ minWidth: 0 }}>
              {d.status === 'wartet' && darfLaden
                ? <Link onClick={() => (istPdf(d) ? setPdf(d) : window.open(dateiUrl(d.id), '_blank', 'noopener'))}>{d.datei}</Link>
                : <Text>{d.datei}</Text>}
              <div className="portal-muted portal-small" style={{ overflowWrap: 'anywhere' }}>
                {[STATUS_TEXT[d.status] ?? d.status, d.status === 'uebernommen' ? `Unterordner „${UNTERORDNER_EINGANG}“` : '', groesse(d.groesse),
                  zeitText(d.datum), d.von ?? '', d.betreff ? `„${d.betreff}“` : ''].filter(Boolean).join(' · ')}
              </div>
            </div>
          </div>
        ))}
      </div>
      {pdf && <PdfDialog url={dateiUrl(pdf.id)} title={pdf.datei} filename={pdf.datei || 'dokument.pdf'} onClose={() => setPdf(null)} />}
    </div>
  );
}
