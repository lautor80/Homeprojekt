import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { BusyIndicator, Button, Dialog, Label, MessageStrip, Text, TextArea } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { Attribute, Attributes } from '@core/components/Attributes';
import { DialogFuss } from '@core/components/DialogFuss';
import { download } from '@core/components/PdfDialog';
import { toast } from '@core/toast';
import { TCO, dat } from '../util';

interface Antrag {
  id: number; typ: 'BEITRAGSWECHSEL' | 'JUGENDTRAINING'; typ_text: string; status: 'OFFEN' | 'FREIGEGEBEN' | 'ABGESCHLOSSEN' | 'ABGELEHNT';
  adrnr: string; name: string; mitglnrn: string | null; eingang: string; eingereicht_von: string; artname: string; ab: string; text: string; schritte: string[];
  email: string | null; mail_an: string | null; bearbeitet_von: string | null; ablehnung: string | null; abgelegt: boolean; gesendet: boolean;
}

/** Knopf am Eintrag „Beitragswechsel/Jugendtraining freigeben“ im Arbeitsvorrat */
export function AenderungKnopf({ id, onFertig }: { id: number; onFertig: () => void }) {
  const [offen, setOffen] = useState(false);
  return (
    <>
      <Button design="Transparent" icon="approvals" tooltip="Antrag ansehen, freigeben oder ablehnen – nach der Freigabe geht die Mitgliederinformation per E-Mail an das Mitglied" onClick={() => setOffen(true)}>Bearbeiten</Button>
      {offen && <AenderungDialog id={id} onClose={() => { setOffen(false); onFertig(); }} />}
    </>
  );
}

/**
 * Beitragswechsel oder Jugendtraining eines Mitglieds freigeben: Erst die Freigabe führt die Änderung aus; unmittelbar danach
 * wird die Mitgliederinformation in der Mitgliederakte abgelegt und per E-Mail an das Mitglied gesendet. Ablehnen: nichts
 * ändert sich, das Mitglied erhält den Grund per E-Mail.
 */
function AenderungDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const basis = `${TCO}/mitglieder/aenderungen/${id}`;
  const [a, setA] = useState<Antrag | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hinweise, setHinweise] = useState<string[]>([]);
  const [ablehnen, setAblehnen] = useState(false);
  const [grund, setGrund] = useState('');
  const laden = useCallback(() => api.get<Antrag>(basis).then(setA).catch((e) => setError((e as Error).message)), [basis]);
  useEffect(() => { laden(); }, [laden]);

  async function aktion(fn: () => Promise<{ text: string; hinweise?: string[]; fertig?: boolean }>) {
    setBusy(true); setError(null); setHinweise([]);
    try {
      const r = await fn();
      toast(r.text, 8000);
      if (r.hinweise?.length) setHinweise(r.hinweise);
      if ((r.fertig ?? true) && !r.hinweise?.length) { onClose(); return; }
      await laden();
    } catch (e) { setError((e as Error).message); await laden(); } finally { setBusy(false); }
  }
  const freigegeben = a?.status === 'FREIGEGEBEN';
  const pdfName = `Mitgliederinformation_${a?.name.replace(/\s+/g, '_') ?? id}.pdf`;

  return createPortal(
    <Dialog open headerText={a ? `${a.typ_text} freigeben` : 'Antrag freigeben'} resizable onClose={onClose} style={{ width: 'min(40rem, 96vw)' }}
            footer={<DialogFuss>
              {a?.status === 'OFFEN' && !ablehnen && <Button design="Emphasized" icon="accept" disabled={busy} onClick={() => aktion(() => api.post(`${basis}/freigeben`, {}))}>Freigeben und Mitglied informieren</Button>}
              {a?.status === 'OFFEN' && !ablehnen && <Button design="Negative" icon="decline" disabled={busy} onClick={() => setAblehnen(true)}>Ablehnen</Button>}
              {a?.status === 'OFFEN' && ablehnen && <Button design="Negative" icon="decline" disabled={busy || grund.trim().length < 3} onClick={() => aktion(() => api.post(`${basis}/ablehnen`, { grund }))}>Ablehnung senden</Button>}
              {a?.status === 'OFFEN' && ablehnen && <Button disabled={busy} onClick={() => setAblehnen(false)}>Zurück</Button>}
              {freigegeben && <Button design="Emphasized" icon="email" disabled={busy} onClick={() => aktion(() => api.post(`${basis}/senden`, {}))}>E-Mail erneut senden</Button>}
              {freigegeben && <Button icon="download" disabled={busy} onClick={() => download(`${basis}/pdf`, pdfName).catch((e) => setError((e as Error).message))}>Mitgliederinformation</Button>}
              {freigegeben && <Button disabled={busy} tooltip="Die Mitgliederinformation selbst zustellen (herunterladen, drucken) und den Antrag abschließen" onClick={() => aktion(() => api.post(`${basis}/senden`, { ohneMail: true }))}>Ohne E-Mail abschließen</Button>}
              <Button onClick={onClose}>Schließen</Button>
            </DialogFuss>}>
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {hinweise.map((h) => <MessageStrip key={h} design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>{h}</MessageStrip>)}
      {!a ? (error ? null : <BusyIndicator active style={{ display: 'block' }} />) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <Attributes narrow>
            <Attribute label="Mitglied" strong>{a.name}{a.mitglnrn ? ` (Nr. ${a.mitglnrn})` : ''}</Attribute>
            <Attribute label="Eingang">{dat(a.eingang)}</Attribute>
            <Attribute label="Eingereicht von">{a.eingereicht_von}</Attribute>
            <Attribute label={a.typ === 'BEITRAGSWECHSEL' ? 'Wechsel ab' : 'Trainingsbeginn'} strong>{dat(a.ab)}</Attribute>
            <Attribute label="E-Mail an">{a.mail_an ? `${a.mail_an} (zahlt) · ` : ''}{a.email || '– keine hinterlegt –'}</Attribute>
            <Attribute label={a.status === 'OFFEN' ? 'Beantragt' : 'Ausgeführt'} wide>{a.text}</Attribute>
            {a.bearbeitet_von && <Attribute label={a.status === 'ABGELEHNT' ? 'Abgelehnt von' : 'Freigegeben von'}>{a.bearbeitet_von}</Attribute>}
            {a.ablehnung && <Attribute label="Grund der Ablehnung" wide>{a.ablehnung}</Attribute>}
          </Attributes>
          {a.status === 'OFFEN' && !ablehnen && (<>
            <ol className="portal-vg__liste">{a.schritte.map((s) => <li key={s}>{s}</li>)}</ol>
            <Text className="portal-muted portal-small">
              Bis zur Freigabe ändert sich an den Verträgen nichts. Mit der Freigabe wird die Änderung ausgeführt und die Mitgliederinformation
              in der Mitgliederakte abgelegt und per E-Mail an das Mitglied gesendet (Kopie an den Verein).
            </Text>
          </>)}
          {a.status === 'OFFEN' && ablehnen && (
            <div>
              <Label showColon required>Grund der Ablehnung (geht per E-Mail an das Mitglied)</Label>
              <TextArea rows={3} maxlength={500} value={grund} onInput={(e) => setGrund(e.target.value)} style={{ width: '100%' }} />
            </div>
          )}
          {freigegeben && <MessageStrip design="Critical" hideCloseButton>Die Änderung ist ausgeführt, die Mitgliederinformation aber noch nicht beim Mitglied. Erneut senden oder herunterladen und ohne E-Mail abschließen.</MessageStrip>}
          {a.status === 'ABGESCHLOSSEN' && <MessageStrip design="Positive" hideCloseButton>{a.gesendet ? 'Die Mitgliederinformation ist versendet.' : 'Abgeschlossen ohne E-Mail.'}</MessageStrip>}
          {a.status === 'ABGELEHNT' && <MessageStrip design="Information" hideCloseButton>Dieser Antrag wurde abgelehnt.</MessageStrip>}
        </div>
      )}
    </Dialog>,
    document.body,
  );
}
