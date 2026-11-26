import { useEffect, useState } from 'react';
import { Bar, Button, CheckBox, FlexBox, Input, Label, MessageStrip, Option, Select, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { FieldBox, FormGrid } from '@core/components/FormFields';
import { Section } from '@core/components/Section';
import { useCan, useFunktion } from '@core/session';
import { SperrHinweis, useSperre } from '@core/sperre';
import { toast } from '@core/toast';
import { T } from './util';
import { mb, type Speicher } from './eingang/typen';

/**
 * Administration → Einstellungen → Euroflex → Mail-Workflows: Eingang (Posteingang über n8n, Eingangspostfächer) und Versand
 * (Vorauswahl, Modus, Absender-Postfach je Dokumentart, BCC für Rechnungen).
 * GET/PUT /workflow-einstellungen, Belegung über GET /eingang/speicher. Vertrag und Bedeutung der Felder:
 * docs/euroflex-mailworkflows.md, Abschnitt „Einstellungen“; Typen in modules/transport/server/mailworkflows.ts.
 */
type Art = 'T' | 'L' | 'R';
interface Eingang {
  ablageziel: 'lokal' | 'paperless'; schwelle: number; ordnerZugeordnet: string; ordnerPruefen: string;
  mailAlsPdf: boolean; ocr: boolean; speicherWarnungMb: number;
  /** Inhalte nach der Übernahme so viele Tage für „Erneut ablegen“ behalten (0 = sofort löschen) */
  aufbewahrenTage?: number;
  /** zugeordnete Dateien dauerhaft im Portal behalten (Standard) – jederzeit wieder herunterladbar; aus = nach aufbewahrenTage löschen */
  aufbewahrenDauerhaft?: boolean;
  /** Eingangspostfächer mit Bezeichnung (Anzeige und Filter im Posteingang) */
  postfaecher: Postfach[];
}
interface Postfach { adresse: string; bezeichnung: string }
/** je Dokumentart: Vorauswahl, Modus, festes Absender-Postfach und BCC (BCC nur bei Rechnung angeboten; Funktion transport.versand.rechnung) */
interface ArtEinstellung { vorauswahl: boolean; modus: 'entwurf' | 'senden'; absender: string; bcc: string }
interface Einstellungen { eingang: Eingang; versand: Record<Art, ArtEinstellung> }

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const adressenOk = (s: string) => s.split(/[,;\s]+/).filter(Boolean).every((a) => EMAIL_RE.test(a));

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
  const [tage, setTage] = useState('');
  const [speicher, setSpeicher] = useState<Speicher | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sperre = useSperre('MAILWORKFLOW', '1', true, { bezeichnung: 'Mail-Workflows Euroflex' });
  const ro = !sperre.eigen;

  useEffect(() => {
    api.get<Einstellungen>(`${T}/workflow-einstellungen`).then((x) => {
      setE(x); setSchwelle(String(x.eingang.schwelle)); setWarnMb(String(x.eingang.speicherWarnungMb)); setTage(String(x.eingang.aufbewahrenTage ?? 90));
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
  const dauerhaft = e.eingang.aufbewahrenDauerhaft ?? true;
  const tageOk = dauerhaft || (zahl(tage) >= 0 && zahl(tage) <= 3650);
  const automatischSenden = funktion('transport.versand.automatisch');
  const absenderFunktion = funktion('transport.versand.rechnung');
  const postfaecher = e.eingang.postfaecher ?? [];
  const setPostfaecher = (l: Postfach[]) => setE({ ...e, eingang: { ...e.eingang, postfaecher: l } });
  const postfachOk = (p: Postfach) => EMAIL_RE.test(p.adresse.trim());
  const postfaecherOk = postfaecher.every(postfachOk)
    && new Set(postfaecher.map((p) => p.adresse.trim().toLowerCase())).size === postfaecher.length;
  const versandOk = ARTEN.every(({ art: a }) => (!e.versand[a].absender?.trim() || EMAIL_RE.test(e.versand[a].absender.trim())) && adressenOk(e.versand[a].bcc ?? ''));

  async function speichern() {
    if (!e || !schwelleOk || !warnOk || !tageOk || !postfaecherOk || !versandOk) return;
    setBusy(true); setError(null);
    try {
      const body: Einstellungen = { ...e, eingang: { ...e.eingang, schwelle: zahl(schwelle), speicherWarnungMb: zahl(warnMb), aufbewahrenTage: Number.isFinite(zahl(tage)) ? zahl(tage) : 90, aufbewahrenDauerhaft: dauerhaft } };
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
          <FieldBox label="Schwelle für einen sicheren Vorschlag (1–100)" required>
            <Input type="Number" value={schwelle} readonly={ro} valueState={schwelleOk ? 'None' : 'Negative'} data-kein-autofill
                   onInput={(x) => setSchwelle(x.target.value)} style={{ width: '8rem' }} />
          </FieldBox>
          <FieldBox label="Outlook-Ordner nach Zuordnung (nicht mehr verwendet – E-Mails bleiben im Ordner, nur „gelesen“)" required>
            <Input value={e.eingang.ordnerZugeordnet} readonly={ro} data-kein-autofill style={{ width: '100%' }}
                   valueState={e.eingang.ordnerZugeordnet.trim() ? 'None' : 'Negative'} onInput={(x) => ein('ordnerZugeordnet')(x.target.value)} />
          </FieldBox>
          <FieldBox label="Outlook-Ordner zum Prüfen (nicht mehr verwendet)" required>
            <Input value={e.eingang.ordnerPruefen} readonly={ro} data-kein-autofill style={{ width: '100%' }}
                   valueState={e.eingang.ordnerPruefen.trim() ? 'None' : 'Negative'} onInput={(x) => ein('ordnerPruefen')(x.target.value)} />
          </FieldBox>
          <FieldBox label="Verarbeitung">
            <CheckBox text="E-Mail selbst zusätzlich als PDF ablegen" checked={e.eingang.mailAlsPdf} readonly={ro} onChange={(x) => ein('mailAlsPdf')(x.target.checked)} />
            <CheckBox text="Texterkennung (OCR) für Anhänge" checked={e.eingang.ocr} readonly={ro} onChange={(x) => ein('ocr')(x.target.checked)} />
          </FieldBox>
          <FieldBox label="Eingangspostfächer">
            <FlexBox direction="Column" style={{ gap: '0.5rem', width: '100%' }}>
              {postfaecher.map((p, i) => (
                <FlexBox key={i} alignItems="Center" wrap="Wrap" style={{ gap: '0.5rem' }}>
                  <Input style={{ flex: '2 1 14rem' }} type="Email" value={p.adresse} readonly={ro} placeholder="info@firma.de" accessibleName={`Eingangspostfach ${i + 1}`}
                         valueState={postfachOk(p) ? 'None' : 'Negative'} data-kein-autofill
                         onInput={(x) => setPostfaecher(postfaecher.map((q, j) => (j === i ? { ...q, adresse: x.target.value } : q)))} />
                  <Input style={{ flex: '1 1 9rem' }} value={p.bezeichnung} readonly={ro} placeholder="Bezeichnung, z. B. Buchhaltung" maxlength={60}
                         accessibleName={`Bezeichnung Postfach ${i + 1}`} data-kein-autofill
                         onInput={(x) => setPostfaecher(postfaecher.map((q, j) => (j === i ? { ...q, bezeichnung: x.target.value } : q)))} />
                  {!ro && <Button design="Transparent" icon="delete" tooltip="Postfach entfernen" accessibleName={`Postfach ${i + 1} entfernen`}
                                  onClick={() => setPostfaecher(postfaecher.filter((_, j) => j !== i))} />}
                </FlexBox>
              ))}
              {!ro && <div><Button icon="add" onClick={() => setPostfaecher([...postfaecher, { adresse: '', bezeichnung: '' }])}>Postfach hinzufügen</Button></div>}
              <Text className="portal-muted" style={{ fontSize: 'var(--sapFontSmallSize)' }}>
                Z. B. info@… und buchhaltung@… – im Posteingang steht bei jeder E-Mail, in welchem Postfach sie ankam, und es lässt sich danach filtern.
                Abgerufen werden die Postfächer, die im n8n-Workflow „Euroflex Maileingang“ unter POSTFAECHER stehen.
              </Text>
            </FlexBox>
          </FieldBox>
          <FieldBox label="Speicherwarnung ab (MB)" required>
            <Input type="Number" value={warnMb} readonly={ro} valueState={warnOk ? 'None' : 'Negative'} data-kein-autofill
                   onInput={(x) => setWarnMb(x.target.value)} style={{ width: '8rem' }} />
          </FieldBox>
          <FieldBox label="Zugeordnete Dateien aufbewahren">
            <FlexBox direction="Column" style={{ gap: '0.25rem' }}>
              <CheckBox text="Dauerhaft – jederzeit wieder herunterladbar" checked={dauerhaft} readonly={ro}
                        onChange={(x) => ein('aufbewahrenDauerhaft')(x.target.checked)} />
              {!dauerhaft && (
                <FlexBox alignItems="Center" style={{ gap: '0.5rem' }}>
                  <Input type="Number" value={tage} readonly={ro} valueState={tageOk ? 'None' : 'Negative'} data-kein-autofill
                         onInput={(x) => setTage(x.target.value)} style={{ width: '8rem' }} accessibleName="Aufbewahren (Tage)"
                         title="So lange behält das Portal zugeordnete Dateien (übernommen, in Paperless, Dublette) – 0 = sofort löschen" />
                  <Text>Tage, danach löschen</Text>
                </FlexBox>
              )}
            </FlexBox>
          </FieldBox>
        </FormGrid>
        <MessageStrip hideCloseButton design="Information" style={{ marginTop: '0.75rem' }}>
          Es wird nie automatisch abgelegt: Ab der Schwelle steht der Auftrag als grüner Vorschlag im Posteingang, darunter als Vorschlag
          mit Hinweis – jede Ablage bestätigt jemand mit „Ablage bestätigen“.
        </MessageStrip>
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
            {!!speicher.aufbewahrtDateien && (
              <Text className="portal-muted" style={{ display: 'block' }}>
                Zugeordnet und aufbewahrt (Herunterladen, „Erneut ablegen“): {mb(speicher.aufbewahrtBytes ?? 0)} MB in {speicher.aufbewahrtDateien} Datei(en)
                {speicher.aufbewahrenDauerhaft === false ? ` – werden nach ${speicher.aufbewahrenTage ?? 90} Tagen gelöscht.` : ' – dauerhaft.'}
              </Text>
            )}
          </div>
        )}
      </Section>

      <Section title="Versand">
        <Text className="portal-muted" style={{ display: 'block', marginBottom: '0.75rem' }}>
          Je Dokumentart: Vorauswahl im Dialog „Versenden…“, ob die E-Mail als Entwurf in Outlook landet oder direkt gesendet wird, und aus welchem
          Postfach sie hinausgeht. Absender und BCC gelten für jede E-Mail dieser Art – im Dialog „E-Mail mit Anhängen…“ (passende Vorlage), bei
          „Versenden…“ und in der E-Mail-Datei. Leer = Postfach des Benutzers bzw. kein BCC. Arten mit verschiedenem Absender gehen nie in
          einer E-Mail zusammen; eine Rechnung mit Absender oder BCC immer als eigene E-Mail, ohne weitere Dokumente.
        </Text>
        <div style={{ overflowX: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(8rem, max-content) max-content minmax(10rem, 13rem) minmax(13rem, 1fr) minmax(13rem, 1fr)', gap: '0.5rem 1.25rem', alignItems: 'center', minWidth: '52rem' }}>
            <Label>Dokumentart</Label><Label>Vorausgewählt</Label><Label>Modus</Label><Label>Absender-Postfach</Label><Label>BCC</Label>
            {ARTEN.map(({ art: a, text }) => {
              const v = e.versand[a];
              return [
                <Text key={`${a}t`}><b>{a}</b> {text}</Text>,
                <CheckBox key={`${a}v`} checked={v.vorauswahl} readonly={ro} accessibleName={`${text} vorausgewählt`}
                          onChange={(x) => art(a, { vorauswahl: x.target.checked })} />,
                <Select key={`${a}m`} disabled={ro} accessibleName={`Modus ${text}`}
                        onChange={(x) => art(a, { modus: ((x.detail.selectedOption as HTMLElement).dataset.k ?? 'entwurf') as ArtEinstellung['modus'] })}>
                  <Option data-k="entwurf" selected={v.modus === 'entwurf'}>Entwurf in Outlook</Option>
                  <Option data-k="senden" selected={v.modus === 'senden'}>Senden</Option>
                </Select>,
                <Input key={`${a}a`} style={{ width: '100%' }} type="Email" value={v.absender ?? ''} readonly={ro} data-kein-autofill
                       placeholder={a === 'R' ? 'buchhaltung@firma.de' : 'Postfach des Benutzers'} accessibleName={`Absender-Postfach ${text}`}
                       valueState={!v.absender?.trim() || EMAIL_RE.test(v.absender.trim()) ? 'None' : 'Negative'}
                       onInput={(x) => art(a, { absender: x.target.value })} />,
                a === 'R'
                  ? <Input key={`${a}b`} style={{ width: '100%' }} value={v.bcc ?? ''} readonly={ro} data-kein-autofill placeholder="…@uploadmail.datev.de"
                           accessibleName="BCC Rechnung – erhält jede Rechnung (z. B. DATEV-Upload)" valueState={adressenOk(v.bcc ?? '') ? 'None' : 'Negative'}
                           onInput={(x) => art(a, { bcc: x.target.value })} />
                  : <Text key={`${a}b`} className="portal-muted">–</Text>,
              ];
            })}
          </div>
        </div>
        <MessageStrip hideCloseButton design={automatischSenden ? 'Information' : 'Critical'} style={{ marginTop: '0.75rem' }}>
          „Senden“ greift nur, wenn die Funktion „Automatisch senden“ an ist (und der Benutzer das Recht dazu hat).
          {!automatischSenden && ' Die Funktion ist zurzeit aus (Administration → Funktionen) – alle E-Mails werden als Entwurf in Outlook abgelegt.'}
        </MessageStrip>
        <MessageStrip hideCloseButton design={absenderFunktion ? 'Information' : 'Critical'} style={{ marginTop: '0.5rem' }}>
          {absenderFunktion
            ? 'Jedes Absender-Postfach muss in Microsoft 365 für die n8n-App freigegeben sein (wie die Postfächer der Benutzer). BCC (z. B. DATEV-Upload) erhält jede Rechnung.'
            : 'Die Funktion „Versand: Absender je Dokumentart und BCC“ ist aus (Administration → Funktionen) – alle E-Mails gehen aus dem Postfach des Benutzers und ohne BCC hinaus.'}
        </MessageStrip>
      </Section>

      <Bar endContent={<Button design="Emphasized" icon="save" disabled={ro || busy || !schwelleOk || !warnOk || !tageOk
        || !e.eingang.ordnerZugeordnet.trim() || !e.eingang.ordnerPruefen.trim() || !postfaecherOk || !versandOk} onClick={speichern}>Sichern</Button>} />
    </>
  );
}
