import { useCallback, useEffect, useState } from 'react';
import { Bar, Button, Input, Label, MessageStrip, ObjectStatus, Panel, Text, TextArea } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { SperrHinweis, useSperre } from '@core/sperre';
import { toast } from '@core/toast';
import { TCO, dat } from '../util';

interface Vorlage { betreff: string; text: string }
interface Mailtext {
  schluessel: string; bereich: string; name: string; wann: string; pflicht: string[];
  platzhalter: { name: string; text: string }[]; standard: Vorlage; eigen: Vorlage | null; geaendert: { von: string; am: string } | null;
}

/**
 * Einstellungen → TC Oberthal → E-Mail-Texte (#232): die Texte der E-Mails des Vereins vorbelegen. Je Anlass steht der
 * Standardtext des Portals bereit; wird er geändert und gesichert, gilt der eigene Text – für automatische E-Mails fest,
 * in Dialogen mit änderbarem Text als Vorbelegung. „Standardtext“ nimmt den eigenen Text wieder zurück.
 */
export function MailtexteKapitel() {
  const [liste, setListe] = useState<Mailtext[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const laden = useCallback(() => api.get<Mailtext[]>(`${TCO}/mailtexte`).then(setListe).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { laden(); }, [laden]);
  if (!liste) return error ? <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip> : null;
  const bereiche = [...new Set(liste.map((t) => t.bereich))];
  return (
    <>
      <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '1rem' }}>
        Je Anlass steht der Standardtext bereit. Ändern und sichern legt den Text des Vereins fest – er gilt ab der nächsten E-Mail.
        Platzhalter in geschweiften Klammern werden beim Versand ersetzt. {liste.filter((t) => t.eigen).length} von {liste.length} Texten sind vom Verein festgelegt.
      </MessageStrip>
      {bereiche.map((b) => (
        <div key={b} style={{ marginBottom: '1rem' }}>
          <div className="portal-schnitt__bereich">{b}</div>
          {liste.filter((t) => t.bereich === b).map((t) => <EinText key={`${t.schluessel}:${t.geaendert?.am ?? ''}:${t.eigen ? 1 : 0}`} t={t} onGeaendert={laden} />)}
        </div>
      ))}
    </>
  );
}

function EinText({ t, onGeaendert }: { t: Mailtext; onGeaendert: () => void }) {
  const start = t.eigen ?? t.standard;
  const [v, setV] = useState<Vorlage>(start);
  const [offen, setOffen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const geaendert = v.betreff !== start.betreff || v.text !== start.text;
  // gesperrt wird erst, wenn jemand tippt – Lesen blockiert niemanden
  const sperre = useSperre('TCO_MAILTEXT', t.schluessel, geaendert, { bezeichnung: `E-Mail-Text ${t.name}` });
  const ro = geaendert && !sperre.eigen;

  async function aktion(fn: () => Promise<{ text: string }>) {
    setBusy(true); setError(null);
    try { toast((await fn()).text); onGeaendert(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Panel collapsed={!offen} onToggle={(e) => setOffen(!(e.target as unknown as { collapsed: boolean }).collapsed)} style={{ marginBottom: '0.5rem' }}
           header={(
             <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', width: '100%' }}>
               <Text style={{ fontWeight: 'bold' }}>{t.name}</Text>
               <ObjectStatus state={t.eigen ? 'Information' : 'None'}>{t.eigen ? `Text des Vereins${t.geaendert ? ` (${dat(t.geaendert.am)}, ${t.geaendert.von})` : ''}` : 'Standardtext'}</ObjectStatus>
             </div>
           )}>
      {offen && (
        <div style={{ display: 'grid', gap: '0.5rem' }}>
          <Text className="portal-muted portal-small">Wird verschickt: {t.wann}</Text>
          <SperrHinweis s={sperre} />
          {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
          <Label showColon>Betreff</Label>
          <Input value={v.betreff} readonly={ro} maxlength={200} style={{ width: '100%' }} onInput={(e) => setV({ ...v, betreff: e.target.value })} />
          <Label showColon>Text</Label>
          <TextArea rows={12} growing value={v.text} readonly={ro} maxlength={20000} style={{ width: '100%' }} onInput={(e) => setV({ ...v, text: e.target.value })} />
          <div>
            <Label showColon>Platzhalter</Label>
            {t.platzhalter.map((p) => (
              <Text key={p.name} className="portal-small" style={{ display: 'block' }}>
                <b>{`{${p.name}}`}</b> – {p.text}{t.pflicht.includes(p.name) ? ' (muss im Text stehen)' : ''}
              </Text>
            ))}
          </div>
          <Bar endContent={<>
            <ChangeHistoryButton objectType="TCO_MAILTEXT" objectKey={t.schluessel} />
            {t.eigen && <Button design="Transparent" icon="reset" disabled={busy} tooltip="Den Text des Vereins verwerfen – es gilt wieder der Standardtext des Portals"
                                onClick={() => aktion(() => api.del(`${TCO}/mailtexte/${encodeURIComponent(t.schluessel)}`))}>Standardtext</Button>}
            {geaendert && <Button disabled={busy} onClick={() => setV(start)}>Verwerfen</Button>}
            <Button design="Emphasized" icon="save" disabled={busy || ro || (!geaendert && !!t.eigen)} tooltip={!geaendert && !t.eigen ? 'Den Standardtext unverändert als Text des Vereins festlegen' : undefined}
                    onClick={() => aktion(() => api.put(`${TCO}/mailtexte/${encodeURIComponent(t.schluessel)}`, v))}>Sichern</Button>
          </>} />
        </div>
      )}
    </Panel>
  );
}
