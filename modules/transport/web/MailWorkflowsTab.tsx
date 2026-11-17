import { useEffect, useState } from 'react';
import { Bar, Button, CheckBox, Input, Label, MessageStrip, Option, Select, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { FieldBox, FormGrid } from '@core/components/FormFields';
import { Section } from '@core/components/Section';
import { useCan, useFunktion } from '@core/session';
import { SperrHinweis, useSperre } from '@core/sperre';
import { toast } from '@core/toast';
import { T } from './util';
import { mb, type Speicher } from './eingang/typen';

/**
 * Administration → Einstellungen → Euroflex → Mail-Workflows: Eingang (Posteingang über n8n) und Versand („Versenden…“).
 * GET/PUT /workflow-einstellungen, Belegung über GET /eingang/speicher. Vertrag und Bedeutung der Felder:
 * docs/euroflex-mailworkflows.md, Abschnitt „Einstellungen“; Typen in modules/transport/server/mailworkflows.ts.
 */
type Art = 'T' | 'L' | 'R';
interface Eingang {
  ablageziel: 'lokal' | 'paperless'; schwelle: number; ordnerZugeordnet: string; ordnerPruefen: string;
  mailAlsPdf: boolean; ocr: boolean; speicherWarnungMb: number;
}
interface ArtEinstellung { vorauswahl: boolean; modus: 'entwurf' | 'senden' }
/** Rechnungsversand: festes Absender-Postfach und BCC (Funktion transport.versand.rechnung) */
interface Rechnung { absender: string; bcc: string }
interface Einstellungen { eingang: Eingang; versand: Record<Art, ArtEinstellung>; rechnung: Rechnung }

const ARTEN: { art: Art; text: string }[] = [
  { art: 'T', text: 'Transportauftrag' },
  { art: 'L', text: 'Lieferschein' },
  { art: 'R', text: 'Rechnung' },
];

export function MailWorkflowsTab() {
  const can = useCan();
  const funktion = useFunktion();
  const [e, setE] = useState<Einstellungen | null>(null);
  // Zahlen als Text bearbeiten, damit ein leeres Feld beim Tippen möglich ist
  const [schwelle, setSchwelle] = useState('');
  const [warnMb, setWarnMb] = useState('');
  const [speicher, setSpeicher] = useState<Speicher | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sperre = useSperre('MAILWORKFLOW', '1', true, { bezeichnung: 'Mail-Workflows Euroflex' });
  const ro = !sperre.eigen;

  useEffect(() => {
    api.get<Einstellungen>(`${T}/workflow-einstellungen`).then((x) => {
      setE(x); setSchwelle(String(x.eingang.schwelle)); setWarnMb(String(x.eingang.speicherWarnungMb));
    }).catch((x) => setError((x as Error).message));
  }, []);
  const speicherLaden = () => api.get<Speicher>(`${T}/eingang/speicher`).then(setSpeicher).catch(() => setSpeicher(null));
  useEffect(() => { if (can('transport.eingang:display')) speicherLaden(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!e) return error ? <MessageStrip design="Negative">{error}</MessageStrip> : null;

  const ein = <K extends keyof Eingang>(k: K) => (v: Eingang[K]) => setE({ ...e, eingang: { ...e.eingang, [k]: v } });
  const art = (a: Art, x: Partial<ArtEinstellung>) => setE({ ...e, versand: { ...e.versand, [a]: { ...e.versand[a], ...x } } });
  const zahl = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN);
  const schwelleOk = zahl(schwelle) >= 1 && zahl(schwelle) <= 100;
  const warnOk = zahl(warnMb) >= 10 && zahl(warnMb) <= 100_000;
  const automatischSenden = funktion('transport.versand.automatisch');
  const automatischAblegen = funktion('transport.eingang.automatik');
  const rechnungsVersand = funktion('transport.versand.rechnung');
  const rechnung = e.rechnung ?? { absender: '', bcc: '' };
  const rech = (x: Partial<Rechnung>) => setE({ ...e, rechnung: { ...rechnung, ...x } });

  async function speichern() {
    if (!e || !schwelleOk || !warnOk) return;
    setBusy(true); setError(null);
    try {
      const body: Einstellungen = { ...e, eingang: { ...e.eingang, schwelle: zahl(schwelle), speicherWarnungMb: zahl(warnMb) } };
      await api.put(`${T}/workflow-einstellungen`, body);
      setE(body);
      toast('Einstellungen der Mail-Workflows gesichert');
      if (can('transport.eingang:display')) speicherLaden();
    } catch (x) { setError((x as Error).message); } finally { setBusy(false); }
  }

  return (
    <>
      <SperrHinweis s={sperre} />
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}

      <Section title="Eingang (Posteingang)">
        <Text className="portal-muted" style={{ display: 'block', marginBottom: '0.75rem' }}>
          n8n holt die E-Mails aus dem Outlook-365-Postfach. Das Portal liest die Anhänge (OCR), ordnet sie einem Auftrag zu und legt sie ab
          oder stellt sie in die Prüfliste der App „Posteingang“.
        </Text>
        <FormGrid>
          <FieldBox label="Ablageziel">
            <Select disabled={ro} onChange={(x) => ein('ablageziel')(((x.detail.selectedOption as HTMLElement).dataset.k ?? 'lokal') as Eingang['ablageziel'])}>
              <Option data-k="lokal" selected={e.eingang.ablageziel === 'lokal'}>Lokal – Ablageordner des PCs (Unterordner „Eingang“)</Option>
              <Option data-k="paperless" selected={e.eingang.ablageziel === 'paperless'}>Paperless</Option>
            </Select>
          </FieldBox>
          <FieldBox label="Schwelle für automatisches Ablegen (1–100)" required>
            <Input type="Number" value={schwelle} readonly={ro} valueState={schwelleOk ? 'None' : 'Negative'} data-kein-autofill
                   onInput={(x) => setSchwelle(x.target.value)} style={{ width: '8rem' }} />
          </FieldBox>
          <FieldBox label="Outlook-Ordner nach Zuordnung" required>
            <Input value={e.eingang.ordnerZugeordnet} readonly={ro} data-kein-autofill style={{ width: '100%' }}
                   valueState={e.eingang.ordnerZugeordnet.trim() ? 'None' : 'Negative'} onInput={(x) => ein('ordnerZugeordnet')(x.target.value)} />
          </FieldBox>
          <FieldBox label="Outlook-Ordner zum Prüfen" required>
            <Input value={e.eingang.ordnerPruefen} readonly={ro} data-kein-autofill style={{ width: '100%' }}
                   valueState={e.eingang.ordnerPruefen.trim() ? 'None' : 'Negative'} onInput={(x) => ein('ordnerPruefen')(x.target.value)} />
          </FieldBox>
          <FieldBox label="Verarbeitung">
            <CheckBox text="E-Mail selbst zusätzlich als PDF ablegen" checked={e.eingang.mailAlsPdf} readonly={ro} onChange={(x) => ein('mailAlsPdf')(x.target.checked)} />
            <CheckBox text="Texterkennung (OCR) für Anhänge" checked={e.eingang.ocr} readonly={ro} onChange={(x) => ein('ocr')(x.target.checked)} />
          </FieldBox>
          <FieldBox label="Speicherwarnung ab (MB)" required>
            <Input type="Number" value={warnMb} readonly={ro} valueState={warnOk ? 'None' : 'Negative'} data-kein-autofill
                   onInput={(x) => setWarnMb(x.target.value)} style={{ width: '8rem' }} />
          </FieldBox>
        </FormGrid>
        {!automatischAblegen && (
          <MessageStrip hideCloseButton design="Information" style={{ marginTop: '0.75rem' }}>
            Die Funktion „Automatisch ablegen“ ist aus (Administration → Funktionen) – jede E-Mail landet in der Prüfliste, die Schwelle wirkt nicht.
          </MessageStrip>
        )}
        {speicher && (
          <div style={{ marginTop: '0.75rem' }}>
            {speicher.warnung ? (
              <MessageStrip hideCloseButton design="Critical">
                {mb(speicher.bytes)} MB in {speicher.dateien} Datei(en) warten auf Übernahme – mehr als die Warnschwelle von {speicher.warnungMb} MB.
                Die Dateien werden übernommen, sobald jemand den Auftrag mit verbundenem Ablageordner öffnet; sie werden nie automatisch gelöscht.
              </MessageStrip>
            ) : (
              <Text className="portal-muted">
                Belegter Speicher: {mb(speicher.bytes)} MB in {speicher.dateien} Datei(en) warten auf Übernahme (Warnung ab {speicher.warnungMb} MB).
              </Text>
            )}
          </div>
        )}
      </Section>

      <Section title="Versand („Versenden…“)">
        <Text className="portal-muted" style={{ display: 'block', marginBottom: '0.75rem' }}>
          Welche Dokumentarten im Dialog „Versenden…“ vorausgewählt sind und ob die E-Mails als Entwurf in Outlook landen oder direkt gesendet werden.
        </Text>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(8rem, max-content) max-content minmax(10rem, 14rem)', gap: '0.5rem 1.5rem', alignItems: 'center', overflowX: 'auto' }}>
          <Label>Dokumentart</Label><Label>Vorausgewählt</Label><Label>Modus</Label>
          {ARTEN.map(({ art: a, text }) => [
            <Text key={`${a}t`}><b>{a}</b> {text}</Text>,
            <CheckBox key={`${a}v`} checked={e.versand[a].vorauswahl} readonly={ro} accessibleName={`${text} vorausgewählt`}
                      onChange={(x) => art(a, { vorauswahl: x.target.checked })} />,
            <Select key={`${a}m`} disabled={ro} accessibleName={`Modus ${text}`}
                    onChange={(x) => art(a, { modus: ((x.detail.selectedOption as HTMLElement).dataset.k ?? 'entwurf') as ArtEinstellung['modus'] })}>
              <Option data-k="entwurf" selected={e.versand[a].modus === 'entwurf'}>Entwurf in Outlook</Option>
              <Option data-k="senden" selected={e.versand[a].modus === 'senden'}>Senden</Option>
            </Select>,
          ])}
        </div>
        <MessageStrip hideCloseButton design={automatischSenden ? 'Information' : 'Critical'} style={{ marginTop: '0.75rem' }}>
          „Senden“ greift nur, wenn die Funktion „Automatisch senden“ an ist (und der Benutzer das Recht dazu hat).
          {!automatischSenden && ' Die Funktion ist zurzeit aus (Administration → Funktionen) – alle E-Mails werden als Entwurf in Outlook abgelegt.'}
        </MessageStrip>
      </Section>

      <Section title="Rechnungsversand">
        <Text className="portal-muted" style={{ display: 'block', marginBottom: '0.75rem' }}>
          Gilt für jede E-Mail mit einer Rechnung: im Dialog „E-Mail mit Anhängen…“ (Vorlage Rechnung), bei „Versenden…“ und in der
          E-Mail-Datei. Eine Rechnung geht dabei immer als eigene E-Mail, ohne weitere Dokumente. Leer = Postfach des Benutzers bzw. kein BCC.
        </Text>
        <FormGrid>
          <FieldBox label="Absender-Postfach (z. B. Buchhaltung)">
            <Input style={{ width: '100%' }} type="Email" value={rechnung.absender} readonly={ro} placeholder="buchhaltung@firma.de"
                   onInput={(x) => rech({ absender: x.target.value })} />
          </FieldBox>
          <FieldBox label="BCC – erhält jede Rechnung (z. B. DATEV-Upload-Adresse)">
            <Input style={{ width: '100%' }} value={rechnung.bcc} readonly={ro} placeholder="…@uploadmail.datev.de"
                   onInput={(x) => rech({ bcc: x.target.value })} />
          </FieldBox>
        </FormGrid>
        <MessageStrip hideCloseButton design={rechnungsVersand ? 'Information' : 'Critical'} style={{ marginTop: '0.75rem' }}>
          {rechnungsVersand
            ? 'Das Absender-Postfach muss in Microsoft 365 für die n8n-App freigegeben sein (wie die Postfächer der Benutzer). Die Adressen stehen nur in der Datenbank des Portals.'
            : 'Die Funktion „Rechnungsversand: Absender-Postfach und BCC“ ist aus (Administration → Funktionen) – Rechnungen gehen wie alle E-Mails aus dem Postfach des Benutzers und ohne BCC hinaus.'}
        </MessageStrip>
      </Section>

      <Bar endContent={<Button design="Emphasized" icon="save" disabled={ro || busy || !schwelleOk || !warnOk
        || !e.eingang.ordnerZugeordnet.trim() || !e.eingang.ordnerPruefen.trim()} onClick={speichern}>Sichern</Button>} />
    </>
  );
}
