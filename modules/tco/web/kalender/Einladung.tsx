import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bar, Button, Dialog, FlexBox, Input, Label, MessageStrip, SegmentedButton, SegmentedButtonItem, Text, TextArea } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { toast } from '@core/toast';
import { TCO } from '../util';

/**
 * Einladungslink einer Veranstaltung: kopieren, teilen oder per E-Mail an die Mitglieder senden, für die sie gilt.
 * Der Link führt auf die Veranstaltung im Portal; an- und abmelden kann sich nur, wer angemeldet ist – wer noch keinen
 * Zugang hat, registriert sich auf der Anmeldeseite auf dem üblichen Weg.
 */
type An = 'OFFEN' | 'ALLE';
interface Vorschau {
  link: string | null; betreff: string; text: string; grund: string | null; senden: boolean;
  personen: { name: string; mail: boolean; zugang: boolean; offen: boolean }[];
  verlauf: { an: An; gesendet: number; fehler: number; von: string; am: string }[];
}
interface Ergebnis { text: string; gesendet: number; fehler: string[]; ohneMail: string[] }

/** Adresse der Veranstaltung – muss zu veranstaltungLink() im Server passen */
export const VERANSTALTUNG_PARAM = 'veranstaltung';
const eigenerLink = (id: number) => `${window.location.origin}/tco/kalender?${VERANSTALTUNG_PARAM}=${id}`;
const zeit = (am: string) => new Date(am).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function EinladungDialog({ id, titel, onClose }: { id: number; titel: string; onClose: () => void }) {
  const [v, setV] = useState<Vorschau | null>(null);
  const [an, setAn] = useState<An>('OFFEN');
  const [betreff, setBetreff] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fertig, setFertig] = useState<Ergebnis | null>(null);
  const laden = () => api.get<Vorschau>(`${TCO}/kalender/${id}/einladung`).then((x) => {
    setV(x);
    setBetreff((b) => b || x.betreff);
    setText((t) => t || x.text);
  }).catch((e) => setError((e as Error).message));
  useEffect(() => { laden(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const link = v?.link ?? eigenerLink(id);
  const gewaehlt = (v?.personen ?? []).filter((p) => an === 'ALLE' || p.offen);
  const mitMail = gewaehlt.filter((p) => p.mail);
  const ohneMail = gewaehlt.filter((p) => !p.mail);
  const ohneZugang = mitMail.filter((p) => !p.zugang).length;
  const teilbar = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const kopieren = () => navigator.clipboard?.writeText(link).then(() => toast('Link kopiert.')).catch(() => setError('Der Link ließ sich nicht kopieren – bitte von Hand markieren.'));
  const teilen = () => navigator.share({ title: titel, text: `Einladung: ${titel}`, url: link }).catch(() => undefined);
  async function senden() {
    setBusy(true); setError(null);
    try {
      setFertig(await api.post<Ergebnis>(`${TCO}/kalender/${id}/einladung`, { an, betreff, text }));
      await laden();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return createPortal(
    <Dialog open headerText={`Einladen: ${titel}`} onClose={onClose} style={{ width: 'min(44rem, 96vw)' }}
            footer={<Bar endContent={<>
              {v?.senden && !fertig && <Button design="Emphasized" icon="email" disabled={busy || !mitMail.length || !betreff.trim() || !text.trim()} onClick={senden}>
                {mitMail.length ? `An ${mitMail.length} ${mitMail.length === 1 ? 'Mitglied' : 'Mitglieder'} senden` : 'Senden'}
              </Button>}
              <Button onClick={onClose}>Schließen</Button>
            </>} />}>
      <div className="portal-kal__form">
        {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
        <div>
          <Label showColon>Link zur Veranstaltung</Label>
          <FlexBox style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            <Input readonly value={link} style={{ flex: '1 1 16rem' }} accessibleName="Link zur Veranstaltung" />
            <Button icon="copy" onClick={kopieren}>Kopieren</Button>
            {teilbar && <Button icon="share-2" onClick={teilen}>Teilen</Button>}
          </FlexBox>
          <Text className="portal-muted" style={{ display: 'block', marginTop: '0.35rem' }}>
            Der Link öffnet die Veranstaltung im Portal. An- und abmelden kann sich nur, wer angemeldet ist – wer noch keinen Zugang hat, registriert sich auf der Anmeldeseite.
          </Text>
        </div>

        {v?.grund && <MessageStrip design="Information" hideCloseButton>{v.grund}</MessageStrip>}
        {fertig && (
          <MessageStrip design={fertig.fehler.length ? 'Critical' : 'Positive'} hideCloseButton>
            {fertig.text}
            {fertig.fehler.length > 0 && <div style={{ whiteSpace: 'pre-wrap', marginTop: '0.35rem' }}>{fertig.fehler.join('\n')}</div>}
            {fertig.ohneMail.length > 0 && <div style={{ marginTop: '0.35rem' }}>Ohne E-Mail-Adresse: {fertig.ohneMail.join(', ')}</div>}
          </MessageStrip>
        )}

        {v?.senden && !fertig && <>
          <div>
            <Label showColon>Per E-Mail einladen</Label>
            <SegmentedButton onSelectionChange={(e) => setAn((e.detail.selectedItems[0] as HTMLElement).dataset.a as An)}>
              <SegmentedButtonItem data-a="OFFEN" selected={an === 'OFFEN'}>Ohne Rückmeldung ({v.personen.filter((p) => p.offen).length})</SegmentedButtonItem>
              <SegmentedButtonItem data-a="ALLE" selected={an === 'ALLE'}>Alle Eingeladenen ({v.personen.length})</SegmentedButtonItem>
            </SegmentedButton>
            {ohneMail.length > 0 && (
              <Text className="portal-muted" style={{ display: 'block', marginTop: '0.35rem' }}>
                Ohne E-Mail-Adresse ({ohneMail.length}): {ohneMail.slice(0, 12).map((p) => p.name).join(', ')}{ohneMail.length > 12 ? ' …' : ''}
              </Text>
            )}
            {ohneZugang > 0 && (
              <Text className="portal-muted" style={{ display: 'block', marginTop: '0.35rem' }}>
                {ohneZugang} {ohneZugang === 1 ? 'Empfänger hat' : 'Empfänger haben'} noch keinen Zugang zum Portal – sie erhalten statt {'{Zugang}'} den Hinweis auf die Registrierung.
              </Text>
            )}
          </div>
          <div><Label showColon required>Betreff</Label><Input value={betreff} style={{ width: '100%' }} disabled={busy} onInput={(e) => setBetreff(e.target.value)} /></div>
          <div>
            <Label showColon required>Text</Label>
            <TextArea value={text} rows={12} growing growingMaxRows={22} style={{ width: '100%' }} disabled={busy} onInput={(e) => setText(e.target.value)} />
            <Text className="portal-muted" style={{ display: 'block', marginTop: '0.35rem' }}>
              {'{Vorname}'} und {'{Zugang}'} werden je Empfänger ersetzt. Die Vorbelegung legt der Verein unter Einstellungen → E-Mail-Texte fest.
            </Text>
          </div>
        </>}

        {v && v.verlauf.length > 0 && (
          <div>
            <Label showColon>Bereits eingeladen</Label>
            {v.verlauf.map((x, i) => (
              <Text key={i} style={{ display: 'block' }}>
                {zeit(x.am)}{x.von ? ` · ${x.von}` : ''} · {x.an === 'OFFEN' ? 'ohne Rückmeldung' : 'alle Eingeladenen'} · {x.gesendet} gesendet{x.fehler ? `, ${x.fehler} nicht zugestellt` : ''}
              </Text>
            ))}
          </div>
        )}
      </div>
    </Dialog>,
    document.body,
  );
}
