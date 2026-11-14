import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bar, BusyIndicator, Button, Dialog, Label, MessageStrip, Text, TextArea } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { Attribute, Attributes } from '@core/components/Attributes';
import { download, usePdf } from '@core/components/PdfDialog';
import { toast } from '@core/toast';
import { TCO, dat } from '../util';

interface Kuendigung {
  id: number; status: 'OFFEN' | 'FREIGEGEBEN' | 'ABGESCHLOSSEN' | 'ABGELEHNT'; adrnr: string; name: string; mitglnrn: string; email: string | null;
  eingang: string; eingereicht_von: string; grund: string | null; text: string; bearbeitet_von: string | null; ablehnung: string | null; abgelegt: boolean; gesendet: boolean;
}

/** Knopf am Eintrag „Kündigung freigeben“ im Arbeitsvorrat (Startseite und Vereinsübersicht) */
export function KuendigungKnopf({ id, onFertig }: { id: number; onFertig: () => void }) {
  const [offen, setOffen] = useState(false);
  return (
    <>
      <Button design="Transparent" icon="approvals" tooltip="Kündigung ansehen, freigeben oder ablehnen; danach die Kündigungsbestätigung prüfen und senden" onClick={() => setOffen(true)}>Bearbeiten</Button>
      {offen && <KuendigungFreigabeDialog id={id} onClose={() => { setOffen(false); onFertig(); }} />}
    </>
  );
}

/**
 * Kündigung eines Mitglieds freigeben (#232): Erst die Freigabe führt die Kündigung aus. Danach zeigt der Dialog die
 * Kündigungsbestätigung zur Prüfung; „An das Mitglied senden“ legt sie in der Mitgliederakte ab und verschickt sie per E-Mail.
 */
function KuendigungFreigabeDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const basis = `${TCO}/mitglieder/kuendigungen/${id}`;
  const [k, setK] = useState<Kuendigung | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hinweise, setHinweise] = useState<string[]>([]);
  const [ablehnen, setAblehnen] = useState(false);
  const [grund, setGrund] = useState('');
  const laden = useCallback(() => api.get<Kuendigung>(basis).then(setK).catch((e) => setError((e as Error).message)), [basis]);
  useEffect(() => { laden(); }, [laden]);
  const freigegeben = k?.status === 'FREIGEGEBEN';
  // Kündigungsbestätigung zur Prüfung – erst nach der Freigabe vorhanden
  const pdf = usePdf(freigegeben ? `${basis}/pdf` : null);

  async function aktion(fn: () => Promise<{ text: string; hinweise?: string[]; fertig?: boolean }>, schliessen: (r: { fertig?: boolean }) => boolean) {
    setBusy(true); setError(null); setHinweise([]);
    try {
      const r = await fn();
      toast(r.text, 8000);
      if (r.hinweise?.length) setHinweise(r.hinweise);
      if (schliessen(r) && !r.hinweise?.length) { onClose(); return; }
      await laden();
    } catch (e) { setError((e as Error).message); await laden(); } finally { setBusy(false); }
  }
  const erledigt = k?.status === 'ABGESCHLOSSEN' || k?.status === 'ABGELEHNT';

  return createPortal(
    <Dialog open headerText={freigegeben ? 'Kündigungsbestätigung prüfen und senden' : 'Kündigung freigeben'} resizable onClose={onClose}
            style={{ width: freigegeben ? 'min(60rem, 96vw)' : 'min(36rem, 96vw)', height: freigegeben ? '90vh' : undefined }}
            footer={<Bar endContent={<>
              {k?.status === 'OFFEN' && !ablehnen && <Button design="Emphasized" icon="accept" disabled={busy} onClick={() => aktion(() => api.post(`${basis}/freigeben`, {}), () => false)}>Freigeben</Button>}
              {k?.status === 'OFFEN' && !ablehnen && <Button design="Negative" icon="decline" disabled={busy} onClick={() => setAblehnen(true)}>Ablehnen</Button>}
              {k?.status === 'OFFEN' && ablehnen && <Button design="Negative" icon="decline" disabled={busy || grund.trim().length < 3} onClick={() => aktion(() => api.post(`${basis}/ablehnen`, { grund }), () => true)}>Ablehnung senden</Button>}
              {k?.status === 'OFFEN' && ablehnen && <Button disabled={busy} onClick={() => setAblehnen(false)}>Zurück</Button>}
              {freigegeben && <Button design="Emphasized" icon="email" disabled={busy || !pdf.blobUrl} onClick={() => aktion(() => api.post(`${basis}/senden`, {}), (r) => !!r.fertig)}>An das Mitglied senden</Button>}
              {freigegeben && <Button icon="download" disabled={busy || !pdf.blobUrl} onClick={() => download(`${basis}/pdf`, `Kuendigungsbestaetigung_${k?.name.replace(/\s+/g, '_') ?? id}.pdf`).catch((e) => setError((e as Error).message))}>Herunterladen</Button>}
              {freigegeben && hinweise.length > 0 && <Button disabled={busy} tooltip="Die Bestätigung selbst zustellen (herunterladen, drucken) und den Vorgang abschließen" onClick={() => aktion(() => api.post(`${basis}/senden`, { ohneMail: true }), (r) => !!r.fertig)}>Ohne E-Mail abschließen</Button>}
              <Button onClick={onClose}>Schließen</Button>
            </>} />}>
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {hinweise.map((h) => <MessageStrip key={h} design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>{h}</MessageStrip>)}
      {!k ? (error ? null : <BusyIndicator active style={{ display: 'block' }} />) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', height: freigegeben ? '100%' : undefined }}>
          <Attributes narrow>
            <Attribute label="Mitglied" strong>{k.name}{k.mitglnrn ? ` (Nr. ${k.mitglnrn})` : ''}</Attribute>
            <Attribute label="Kündigungsdatum (Eingang)" strong>{dat(k.eingang)}</Attribute>
            <Attribute label="Eingereicht von">{k.eingereicht_von}</Attribute>
            <Attribute label="E-Mail">{k.email || '– keine hinterlegt –'}</Attribute>
            <Attribute label={k.status === 'OFFEN' ? 'Beantragt' : 'Ausgeführt'} wide>{k.text}</Attribute>
            {k.grund && <Attribute label="Grund des Mitglieds" wide>{k.grund}</Attribute>}
            {k.bearbeitet_von && <Attribute label={k.status === 'ABGELEHNT' ? 'Abgelehnt von' : 'Freigegeben von'}>{k.bearbeitet_von}</Attribute>}
            {k.ablehnung && <Attribute label="Grund der Ablehnung" wide>{k.ablehnung}</Attribute>}
          </Attributes>
          {k.status === 'OFFEN' && !ablehnen && (
            <Text className="portal-muted portal-small">
              Bis zur Freigabe ändert sich an Mitgliedschaft und Verträgen nichts. Mit der Freigabe wird die Kündigung zum Kündigungsdatum ausgeführt;
              anschließend erscheint hier die Kündigungsbestätigung zur Prüfung, bevor sie an das Mitglied geht.
            </Text>
          )}
          {k.status === 'OFFEN' && ablehnen && (
            <div>
              <Label showColon required>Grund der Ablehnung (geht per E-Mail an das Mitglied)</Label>
              <TextArea rows={3} maxlength={500} value={grund} onInput={(e) => setGrund(e.target.value)} style={{ width: '100%' }} />
            </div>
          )}
          {freigegeben && pdf.error && <MessageStrip design="Negative" hideCloseButton>{pdf.error}</MessageStrip>}
          {freigegeben && !pdf.blobUrl && !pdf.error && <BusyIndicator active style={{ display: 'block' }} />}
          {freigegeben && pdf.blobUrl && <iframe title="Kündigungsbestätigung" src={pdf.blobUrl} style={{ flex: 1, minHeight: '50vh', width: '100%', border: '1px solid var(--sapList_BorderColor)' }} />}
          {erledigt && <MessageStrip design="Information" hideCloseButton>{k.status === 'ABGELEHNT' ? 'Diese Kündigung wurde abgelehnt.' : k.gesendet ? 'Die Kündigungsbestätigung ist versendet.' : 'Abgeschlossen ohne E-Mail.'}</MessageStrip>}
        </div>
      )}
    </Dialog>,
    document.body,
  );
}
