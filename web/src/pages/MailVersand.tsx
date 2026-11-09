import { useEffect, useState } from 'react';
import { Button, ComboBox, ComboBoxItem, DateTimePicker, Input, Label, MessageStrip, ObjectStatus, Option, Select, Text, Title } from '@ui5/webcomponents-react';
import { api } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useSession } from '../session';

/**
 * Zusätze der Anbindung „E-Mail-Versand (n8n)“ (Administration → Anbindungen): Ersatzabsender je Anwendung
 * (Einstellungen der Anbindung) sowie Mailprotokoll, Testmail und „Erneut senden“.
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

/** Letzte E-Mail-Versuche über n8n und Testmail – zeigt, ob ein Aufruf bei n8n ankam und mit welchem Ergebnis */
interface Proto { id: number; zeit: string; anwendung: string; objekt: string; an: string; betreff: string; absender: string | null; von: string | null; status: string; fehler: string | null; benutzer: string | null;
  erneut: boolean; erneut_hinweis: string | null; erneut_neuer_link: boolean; erneut_am: string | null; erneut_von: string | null; erneut_status: string | null }
const PROTO = '/api/mail/protokoll';

export function MailProtokoll() {
  const { me } = useSession();
  const [liste, setListe] = useState<Proto[] | null>(null);
  const [an, setAn] = useState(me.user.email ?? '');
  const [busy, setBusy] = useState(false);
  const [meldung, setMeldung] = useState<{ ok: boolean; text: string } | null>(null);
  const [erneutBusy, setErneutBusy] = useState<number | null>(null);
  // Filter: Anwendung und Zeitraum (Tag und Uhrzeit)
  const [filter, setFilter] = useState({ anwendung: '', von: '', bis: '' });
  const [anwendungen, setAnwendungen] = useState<string[]>([]);
  const [leeren, setLeeren] = useState(false);
  const gefiltert = !!(filter.anwendung || filter.von || filter.bis);
  const query = () => {
    const q = new URLSearchParams();
    if (filter.anwendung) q.set('anwendung', filter.anwendung);
    if (filter.von) q.set('von', filter.von);
    if (filter.bis) q.set('bis', filter.bis);
    return q.toString();
  };
  const laden = () => {
    api.get<string[]>(`${PROTO}/anwendungen`).then(setAnwendungen).catch(() => undefined);
    return api.get<Proto[]>(`${PROTO}${query() ? `?${query()}` : ''}`).then(setListe).catch((e) => { setListe([]); setMeldung({ ok: false, text: (e as Error).message }); });
  };
  useEffect(() => { laden(); }, [filter.anwendung, filter.von, filter.bis]); // eslint-disable-line react-hooks/exhaustive-deps
  async function protokollLeeren() {
    setLeeren(false); setMeldung(null);
    try {
      const r = await api.del<{ text: string }>(PROTO, {
        ...(filter.anwendung ? { anwendung: filter.anwendung } : {}), ...(filter.von ? { von: filter.von } : {}), ...(filter.bis ? { bis: filter.bis } : {}),
      });
      setMeldung({ ok: true, text: r.text });
    } catch (e) { setMeldung({ ok: false, text: (e as Error).message }); }
    finally { laden(); }
  }
  const zeitraumText = [filter.anwendung && `Anwendung „${filter.anwendung}“`, filter.von && `ab ${filter.von.replace('T', ' ')}`, filter.bis && `bis ${filter.bis.replace('T', ' ')}`].filter(Boolean).join(', ');
  async function test() {
    setBusy(true); setMeldung(null);
    try { const r = await api.post<{ text: string }>('/api/mail/test', { an }); setMeldung({ ok: true, text: r.text }); }
    catch (e) { setMeldung({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); laden(); }
  }
  const [frage, setFrage] = useState<Proto | null>(null);
  async function erneut(p: Proto) {
    setFrage(null);
    setErneutBusy(p.id); setMeldung(null);
    try {
      const r = await api.post<{ text: string; warnungen: string[] }>(`${PROTO}/${p.id}/erneut`);
      setMeldung({ ok: true, text: [r.text, ...r.warnungen].join(' · ') });
    } catch (e) { setMeldung({ ok: false, text: (e as Error).message }); }
    finally { setErneutBusy(null); laden(); }
  }
  const STATUS: Record<string, ['Positive' | 'Negative' | 'Critical' | 'Information', string]> = {
    gesendet: ['Positive', 'gesendet'], entwurf: ['Information', 'Entwurf'], fehler: ['Negative', 'Fehler'], nicht_gesendet: ['Critical', 'nicht gesendet'],
  };
  const zelle = { padding: '0.2rem 0.4rem', verticalAlign: 'top' } as const;
  return (
    <div style={{ padding: '0.75rem 0 0' }}>
      <Title level="H6">Mailprotokoll und Testmail</Title>
      <div className="portal-row" style={{ gap: '0.5rem', margin: '0.4rem 0' }}>
        <Input value={an} type="Email" placeholder="Empfänger der Testmail" style={{ width: '18rem' }} onInput={(e) => setAn(e.target.value)} />
        <Button icon="paper-plane" loading={busy} disabled={!an.includes('@')} onClick={test}>Testmail senden</Button>
        <Button design="Transparent" icon="refresh" onClick={laden}>Aktualisieren</Button>
      </div>
      <div className="portal-row" style={{ gap: '0.5rem', margin: '0.4rem 0', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <Label>Anwendung</Label><br />
          <Select style={{ width: '12rem' }} onChange={(e) => setFilter({ ...filter, anwendung: (e.detail.selectedOption as HTMLElement).dataset.wert ?? '' })}>
            <Option data-wert="" selected={!filter.anwendung}>Alle</Option>
            {anwendungen.map((a) => <Option key={a} data-wert={a} selected={filter.anwendung === a}>{a}</Option>)}
          </Select>
        </div>
        <div>
          {/* displayFormat statt formatPattern: sonst übernimmt „OK“ im Popup die Auswahl nicht (#16) */}
          <Label>Von (Tag, Uhrzeit)</Label><br />
          <DateTimePicker value={filter.von} valueFormat="yyyy-MM-dd'T'HH:mm" displayFormat="dd.MM.yyyy HH:mm" style={{ width: '13rem' }}
                          onChange={(e) => setFilter({ ...filter, von: e.detail.value })} />
        </div>
        <div>
          <Label>Bis (Tag, Uhrzeit)</Label><br />
          <DateTimePicker value={filter.bis} valueFormat="yyyy-MM-dd'T'HH:mm" displayFormat="dd.MM.yyyy HH:mm" style={{ width: '13rem' }}
                          onChange={(e) => setFilter({ ...filter, bis: e.detail.value })} />
        </div>
        {gefiltert && <Button design="Transparent" icon="clear-filter" onClick={() => setFilter({ anwendung: '', von: '', bis: '' })}>Filter zurücksetzen</Button>}
        <Button design="Transparent" icon="delete" disabled={!liste?.length} onClick={() => setLeeren(true)}
                tooltip={gefiltert ? 'Alle Einträge im gewählten Filter löschen' : 'Das ganze Mailprotokoll löschen'}>
          {gefiltert ? 'Gefilterte Einträge löschen' : 'Protokoll leeren'}
        </Button>
      </div>
      <ConfirmDialog open={leeren} danger title={gefiltert ? 'Gefilterte Protokolleinträge löschen' : 'Mailprotokoll leeren'} confirmText="Löschen"
                     text={gefiltert
                       ? `Alle Einträge mit ${zeitraumText} werden gelöscht (nicht nur die angezeigten). Gespeicherte Inhalte zum erneuten Senden gehen dabei verloren.`
                       : 'Das gesamte Mailprotokoll wird gelöscht. Gespeicherte Inhalte zum erneuten Senden gehen dabei verloren.'}
                     onConfirm={protokollLeeren} onCancel={() => setLeeren(false)} />
      <ConfirmDialog open={!!frage} title="Neuen Zugangslink senden" confirmText="Erneut senden"
                     text={`Für ${frage?.an ?? ''} wird ein neuer Zugangslink erzeugt und gesendet. Ältere Links – auch auf bereits gedruckten Briefen – werden ungültig.`}
                     onConfirm={() => frage && erneut(frage)} onCancel={() => setFrage(null)} />
      {meldung && <MessageStrip design={meldung.ok ? 'Positive' : 'Negative'} onClose={() => setMeldung(null)} style={{ marginBottom: '0.4rem' }}>{meldung.text}</MessageStrip>}
      {!liste?.length ? <Text className="portal-muted">{gefiltert ? 'Keine Einträge im gewählten Filter.' : 'Noch keine Versandversuche protokolliert.'}</Text> : (
        <div style={{ maxHeight: '18rem', overflowY: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead><tr>{['Zeit', 'Anwendung', 'An', 'Betreff', 'Absender', 'Status', ''].map((h) => <th key={h} style={{ ...zelle, textAlign: 'left' }}><Label>{h}</Label></th>)}</tr></thead>
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
                    {p.erneut_am && (
                      <><br /><Text className="portal-small" style={{ color: p.erneut_status === 'fehler' ? 'var(--sapNegativeTextColor)' : 'var(--sapPositiveTextColor)' }}>
                        {p.erneut_status === 'fehler' ? 'Wiederholung fehlgeschlagen' : 'Erneut gesendet'} am {p.erneut_am.slice(8, 10)}.{p.erneut_am.slice(5, 7)}. {p.erneut_am.slice(11, 16)}{p.erneut_von ? ` von ${p.erneut_von}` : ''}
                      </Text></>
                    )}
                  </td>
                  <td style={{ ...zelle, whiteSpace: 'nowrap' }}>
                    {p.erneut && (
                      <Button icon="redo" design="Transparent" loading={erneutBusy === p.id} disabled={erneutBusy !== null}
                              tooltip={p.erneut_neuer_link ? 'Neuen Zugangslink erzeugen und senden' : 'Dieselbe E-Mail (mit Anhängen) erneut senden'}
                              onClick={() => (p.erneut_neuer_link ? setFrage(p) : erneut(p))}>Erneut senden</Button>
                    )}
                    {p.erneut_hinweis && <Text className="portal-muted portal-small" style={{ whiteSpace: 'normal', display: 'block', maxWidth: '16rem' }}>{p.erneut_hinweis}</Text>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
