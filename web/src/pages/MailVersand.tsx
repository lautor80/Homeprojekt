import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, ComboBox, ComboBoxItem, Input, Label, MessageStrip, ObjectStatus, Text, Title } from '@ui5/webcomponents-react';
import { api } from '../api';
import { useCan, useSession } from '../session';

/**
 * Zusätze der Anbindung „E-Mail-Versand (n8n)“ (Administration → Schnittstellen → Anbindungen): Ersatzabsender je Anwendung
 * (Einstellungen der Anbindung), Testmail und die letzten Versandversuche als Stand der Anbindung. Das Protokoll selbst
 * gibt es nur einmal – in der App „E-Mail-Protokoll“ mit Filter, „Erneut senden“ und „Protokoll leeren“ (#232, S3).
 */
export interface Absender { anwendung: string; email: string; name?: string | null; antwort_an?: string | null }
const ANWENDUNGEN = ['*', 'Benutzer', 'Registrierung', 'Mitgliedsantrag', 'Mitglieder', 'Hallenrechnung', 'Verzehr', 'Platzbuchung', 'Rechnung'];

export function MailAbsender({ liste, ro, onChange }: { liste: Absender[]; ro: boolean; onChange: (l: Absender[]) => void }) {
  const set = (i: number, p: Partial<Absender>) => onChange(liste.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const zelle = { padding: '0.2rem 0.4rem' } as const;
  return (
    <div style={{ padding: '0.75rem 0 0' }}>
      <Title level="H6">Ersatzabsender je Anwendung</Title>
      <Text style={{ display: 'block', margin: '0.15rem 0 0.5rem', color: 'var(--sapContent_LabelColor)' }}>
        Gesendet wird mit der Adresse dessen, der auf „Senden“ drückt – sofern es dafür im n8n-Workflow ein SMTP-Konto gibt (KONTEN).
        Sonst und bei Mails ohne Anmeldung (Registrierung, Antrag, Passwort vergessen) gilt dieser Ersatz je Anwendung („*“ = alle übrigen),
        ohne Eintrag der Standard des Workflows. Antworten gehen dann an den Bearbeiter.
      </Text>
      {liste.length > 0 && (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead><tr>{['Anwendung', 'Absender-E-Mail', 'Absendername', 'Antworten an', ''].map((h) => <th key={h} style={{ ...zelle, textAlign: 'left' }}><Label>{h}</Label></th>)}</tr></thead>
          <tbody>
            {liste.map((a, i) => (
              <tr key={i}>
                <td style={zelle}>
                  <ComboBox value={a.anwendung} readonly={ro} style={{ width: '11rem' }} onInput={(e) => set(i, { anwendung: e.target.value })} onChange={(e) => set(i, { anwendung: e.target.value })}>
                    {ANWENDUNGEN.map((x) => <ComboBoxItem key={x} text={x} />)}
                  </ComboBox>
                </td>
                <td style={zelle}><Input value={a.email} readonly={ro} type="Email" style={{ width: '100%' }} onInput={(e) => set(i, { email: e.target.value })} /></td>
                <td style={zelle}><Input value={a.name ?? ''} readonly={ro} style={{ width: '100%' }} onInput={(e) => set(i, { name: e.target.value })} /></td>
                <td style={zelle}><Input value={a.antwort_an ?? ''} readonly={ro} type="Email" style={{ width: '100%' }} onInput={(e) => set(i, { antwort_an: e.target.value })} /></td>
                <td style={zelle}>{!ro && <Button design="Transparent" icon="delete" tooltip="Entfernen" onClick={() => onChange(liste.filter((_, j) => j !== i))} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!ro && <Button design="Transparent" icon="add" onClick={() => onChange([...liste, { anwendung: liste.length ? '' : '*', email: '', name: '', antwort_an: '' }])}>Absender hinzufügen</Button>}
    </div>
  );
}

/** Stand der Anbindung: Testmail und die letzten Versandversuche – zeigt, ob ein Aufruf bei n8n ankam und mit welchem Ergebnis */
interface Versuch { id: number; zeit: string; anwendung: string; objekt: string; an: string; betreff: string; absender: string | null; von: string | null; status: string; fehler: string | null }
const LETZTE = 5;

export function MailStand() {
  const { me } = useSession();
  const can = useCan();
  const navigate = useNavigate();
  const [liste, setListe] = useState<Versuch[] | null>(null);
  const [an, setAn] = useState(me.user.email ?? '');
  const [busy, setBusy] = useState(false);
  const [meldung, setMeldung] = useState<{ ok: boolean; text: string } | null>(null);
  const laden = () => api.get<Versuch[]>('/api/mail/protokoll').then((l) => setListe(l.slice(0, LETZTE)))
    .catch((e) => { setListe([]); setMeldung({ ok: false, text: (e as Error).message }); });
  useEffect(() => { laden(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function test() {
    setBusy(true); setMeldung(null);
    try { const r = await api.post<{ text: string }>('/api/mail/test', { an }); setMeldung({ ok: true, text: r.text }); }
    catch (e) { setMeldung({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); laden(); }
  }
  const STATUS: Record<string, ['Positive' | 'Negative' | 'Critical' | 'Information', string]> = {
    gesendet: ['Positive', 'gesendet'], entwurf: ['Information', 'Entwurf'], fehler: ['Negative', 'Fehler'], nicht_gesendet: ['Critical', 'nicht gesendet'],
  };
  const zelle = { padding: '0.2rem 0.4rem', verticalAlign: 'top' } as const;
  return (
    <div style={{ padding: '0.75rem 0 0' }}>
      <Title level="H6">Testmail und letzte Versandversuche</Title>
      <div className="portal-row" style={{ gap: '0.5rem', margin: '0.4rem 0', flexWrap: 'wrap' }}>
        <Input value={an} type="Email" placeholder="Empfänger der Testmail" style={{ width: '18rem' }} onInput={(e) => setAn(e.target.value)} />
        <Button icon="paper-plane" loading={busy} disabled={!an.includes('@')} onClick={test}>Testmail senden</Button>
        <Button design="Transparent" icon="refresh" onClick={laden}>Aktualisieren</Button>
        {can('core.mail:display') && <Button design="Transparent" icon="email" onClick={() => navigate('/admin/mailprotokoll')}>E-Mail-Protokoll öffnen</Button>}
      </div>
      {meldung && <MessageStrip design={meldung.ok ? 'Positive' : 'Negative'} onClose={() => setMeldung(null)} style={{ marginBottom: '0.4rem' }}>{meldung.text}</MessageStrip>}
      {!liste?.length ? <Text className="portal-muted">Noch keine Versandversuche protokolliert.</Text> : (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead><tr>{['Zeit', 'Anwendung', 'An', 'Betreff', 'Absender', 'Status'].map((h) => <th key={h} style={{ ...zelle, textAlign: 'left' }}><Label>{h}</Label></th>)}</tr></thead>
          <tbody>
            {liste.map((p) => (
              <tr key={p.id} style={{ borderTop: '1px solid var(--sapList_BorderColor)' }}>
                <td style={{ ...zelle, whiteSpace: 'nowrap' }}><Text>{p.zeit.slice(8, 10)}.{p.zeit.slice(5, 7)}. {p.zeit.slice(11, 16)}</Text></td>
                <td style={zelle}><Text>{p.anwendung} {p.objekt}</Text></td>
                <td style={zelle}><Text>{p.an}</Text></td>
                <td style={zelle}><Text>{p.betreff}</Text></td>
                <td style={zelle}><Text>{p.von ?? p.absender ?? '–'}</Text></td>
                <td style={zelle}>
                  <ObjectStatus state={(STATUS[p.status] ?? ['None', p.status])[0] as 'Positive'}>{(STATUS[p.status] ?? ['None', p.status])[1]}</ObjectStatus>
                  {p.fehler && <><br /><Text className="portal-muted portal-small">{p.fehler}</Text></>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.4rem' }}>
        Die letzten {LETZTE} Versuche. Alle E-Mails mit Filter, „Erneut senden“ und „Protokoll leeren“: Administration → Protokolle → E-Mail-Protokoll.
      </Text>
    </div>
  );
}
