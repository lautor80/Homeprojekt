import { useEffect, useState } from 'react';
import { feld } from '@core/components/Varianten';
import {
  Bar, Button, BusyIndicator, Dialog, Label, MessageStrip, ObjectStatus, RadioButton, Text, TextArea,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { AuswahlBox } from '@core/components/AuswahlBox';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { Section } from '@core/components/Section';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { TCO, dat } from '../util';

/**
 * Registrierungen von Mitgliedern (Kassenwart): Abgleich über Geburtsdatum bzw. Mitgliedsnummer (Wahl des Nutzers),
 * Freigabe mit Rolle „Mitglied“ und Zuordnung zum Mitglied, alternativ als externer Hallennutzer, oder Ablehnung
 * mit Begründung (wird per E-Mail mitgeteilt).
 */
const R = `${TCO}/registrierungen/mitglieder`;
interface Vorschlag { art: 'MITGLIED' | 'EP3'; schluessel: string; name: string; grund: string; info: string }
interface Registrierung {
  id: number; benutzername: string; anzeigename: string; email: string; telefon: string | null; nachricht: string | null;
  geburtsdatum: string | null; mitgliedsnr: string | null; ep3_zuid: string | null; ep3_alias: string | null;
  anrede: string | null; strasse: string | null; plz: string | null; ort: string | null;
  status: 'OFFEN' | 'BESTAETIGT' | 'ABGELEHNT'; erstellt: string; bearbeitet_am: string | null; bearbeitet_von: string | null; bemerkung: string | null;
  vorschlaege: Vorschlag[];
}
const zeit = (iso: string) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
const STATUS = { OFFEN: ['offen', 'Critical'], BESTAETIGT: ['freigegeben', 'Positive'], ABGELEHNT: ['abgelehnt', 'Negative'] } as const;
const zelle = { padding: '0.4rem 0.5rem', verticalAlign: 'top' } as const;

export function MitgliedRegistrierungen() {
  const can = useCan();
  const [liste, setListe] = useState<Registrierung[] | null>(null);
  const [alle, setAlle] = useState(false);
  const [frei, setFrei] = useState<Registrierung | null>(null);
  const [weg, setWeg] = useState<Registrierung | null>(null);
  const [error, setError] = useState<string | null>(null);
  const laden = () => api.get<Registrierung[]>(`${R}?status=${alle ? 'ALLE' : 'OFFEN'}`).then((l) => {
    setListe(l);
    // aus dem Arbeitsvorrat: ?id= öffnet die Freigabe direkt
    const id = Number(new URLSearchParams(window.location.search).get('id'));
    const r = id ? l.find((x) => x.id === id && x.status === 'OFFEN') : null;
    if (r) { setFrei(r); window.history.replaceState(null, '', window.location.pathname); }
  }).catch((e) => setError(e.message));
  useEffect(() => { setListe(null); laden(); }, [alle]); // eslint-disable-line react-hooks/exhaustive-deps

  async function ablehnen(r: Registrierung, grund: string) {
    try {
      const x = await api.post<{ text: string }>(`${R}/${r.id}/ablehnen`, { bemerkung: grund });
      toast(x.text, 6000);
      laden();
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <AppPage varianten={{ repid: 'tco.registrierungen', ansicht: { alle }, onAnwenden: (a) => { setAlle(feld(a, 'alle', alle)); } }} title="Registrierungen" subtitle="Mitglieder, die einen Zugang zum Portal beantragt haben"
             actions={<Button design="Transparent" icon={alle ? 'filter' : 'history'} onClick={() => setAlle(!alle)}>{alle ? 'Nur offene' : 'Auch erledigte'}</Button>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {!liste ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : (
        <Section title="Registrierungen" count={liste.length} flush>
          {!liste.length ? <Text className="portal-muted" style={{ display: 'block', padding: '1rem' }}>Keine offenen Registrierungen.</Text> : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead><tr>{['Eingegangen', 'Person', 'Nachweis', 'Vorschlag', 'Status', ''].map((h) => <th key={h} style={{ ...zelle, textAlign: 'left' }}><Label>{h}</Label></th>)}</tr></thead>
                <tbody>
                  {liste.map((r) => {
                    const v = r.vorschlaege.find((x) => x.art === 'MITGLIED');
                    return (
                      <tr key={r.id} style={{ borderTop: '1px solid var(--sapList_BorderColor)' }}>
                        <td style={zelle}><Text>{zeit(r.erstellt)}</Text></td>
                        <td style={zelle}><Text>{[r.anrede, r.anzeigename].filter(Boolean).join(' ')}</Text><br /><Label>{[r.strasse, [r.plz, r.ort].filter(Boolean).join(' ')].filter(Boolean).join(', ')}</Label><br /><Label>{r.email}{r.telefon ? ` · ${r.telefon}` : ''} · Benutzer {r.benutzername}</Label></td>
                        <td style={zelle}><Text>{r.geburtsdatum ? `Geburtsdatum ${dat(r.geburtsdatum)}` : r.mitgliedsnr ? `Mitgliedsnr. ${r.mitgliedsnr}` : '–'}</Text></td>
                        <td style={zelle}>
                          {r.status !== 'OFFEN' ? <Text className="portal-muted">{r.bemerkung ?? ''}</Text>
                            : v ? <Text>{v.name} <span className="portal-muted">· {v.info} · {v.grund}</span></Text>
                              : <ObjectStatus state="Critical">kein passendes Mitglied gefunden</ObjectStatus>}
                        </td>
                        <td style={zelle}><ObjectStatus state={STATUS[r.status][1]} inverted>{STATUS[r.status][0]}</ObjectStatus></td>
                        <td style={{ ...zelle, whiteSpace: 'nowrap' }}>
                          {r.status === 'OFFEN' && can('tco.registrierung:mitglied') ? <>
                            <Button design="Emphasized" icon="accept" onClick={() => setFrei(r)}>Prüfen</Button>
                            <Button design="Transparent" icon="decline" onClick={() => setWeg(r)}>Ablehnen</Button>
                          </> : <Label>{r.bearbeitet_von}{r.bearbeitet_am ? `, ${zeit(r.bearbeitet_am)}` : ''}</Label>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}
      <MessageStrip hideCloseButton style={{ marginTop: '0.5rem' }}>
        Freigegebene Mitglieder erhalten ausschließlich die Systemrolle „Mitglied“ (eigene Daten, Platzbuchung, Verzehr, Vereinskalender) und melden sich mit dem gewählten Kennwort an.
      </MessageStrip>
      {frei && <FreigabeDialog r={frei} onClose={() => setFrei(null)} onDone={(text) => { setFrei(null); toast(text, 6000); laden(); }} />}
      <ConfirmDialog open={!!weg} danger askReason title="Registrierung ablehnen" confirmText="Ablehnen"
                     text={`Registrierung von ${weg?.anzeigename ?? ''} ablehnen? Die Begründung wird der Person per E-Mail mitgeteilt.`}
                     onCancel={() => setWeg(null)} onConfirm={(grund) => { const r = weg!; setWeg(null); ablehnen(r, grund); }} />
    </AppPage>
  );
}

function FreigabeDialog({ r, onClose, onDone }: { r: Registrierung; onClose: () => void; onDone: (text: string) => void }) {
  const v = r.vorschlaege.find((x) => x.art === 'MITGLIED');
  const [modus, setModus] = useState<'MITGLIED' | 'HALLE'>('MITGLIED');
  const [adrnr, setAdrnr] = useState(v?.schluessel ?? '');
  const [bemerkung, setBemerkung] = useState('');
  const [kandidaten, setKandidaten] = useState<{ adrnr: string; name: string; mitglnrn: string | null }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get<typeof kandidaten>(`${R}/kandidaten`).then(setKandidaten).catch(() => undefined); }, []);
  const eintraege = [
    ...r.vorschlaege.filter((x) => x.art === 'MITGLIED' && !kandidaten.some((k) => k.adrnr === x.schluessel)).map((x) => ({ key: x.schluessel, text: x.name, zusatz: x.info })),
    ...kandidaten.map((k) => ({ key: k.adrnr, text: k.name, zusatz: k.mitglnrn ? `Nr. ${k.mitglnrn}` : k.adrnr })),
  ];
  async function freigeben() {
    setBusy(true); setError(null);
    try {
      const x = await api.post<{ text: string }>(`${R}/${r.id}/freigeben`, modus === 'MITGLIED' ? { adrnr, bemerkung: bemerkung || null } : { hallennutzer: true, bemerkung: bemerkung || null });
      onDone(x.text);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open headerText={`Registrierung prüfen – ${r.anzeigename}`} style={{ width: 'min(38rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={<>
              <Button design="Emphasized" icon="accept" loading={busy} disabled={modus === 'MITGLIED' && !adrnr} onClick={freigeben}>Freigeben</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      <div className="portal-bk__form">
        {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
        <Text>
          {r.anrede} {r.anzeigename} · {r.strasse}, {r.plz} {r.ort}<br />
          Benutzer <b>{r.benutzername}</b> · {r.email}{r.telefon ? ` · ${r.telefon}` : ''}<br />
          Nachweis: {r.geburtsdatum ? `Geburtsdatum ${dat(r.geburtsdatum)}` : `Mitgliedsnummer ${r.mitgliedsnr ?? '–'}`}
          {r.ep3_zuid && <> · EP3-Konto <b>{r.ep3_alias ?? r.ep3_zuid}</b> nachgewiesen</>}
        </Text>
        {r.nachricht && <MessageStrip design="Information" hideCloseButton>Mitteilung: {r.nachricht}</MessageStrip>}
        {v ? <MessageStrip design="Positive" hideCloseButton>Vorschlag: {v.name} – {v.info} ({v.grund})</MessageStrip>
          : <MessageStrip design="Critical" hideCloseButton>Kein Mitglied passt zu Name und {r.geburtsdatum ? 'Geburtsdatum' : 'Mitgliedsnummer'}. Bitte prüfen.</MessageStrip>}
        <RadioButton name="frei" text="Als Mitglied freigeben (Rolle Mitglied)" checked={modus === 'MITGLIED'} onChange={() => setModus('MITGLIED')} />
        {modus === 'MITGLIED' && (
          <AuswahlBox wert={adrnr} placeholder="Mitglied suchen" style={{ width: '100%' }} eintraege={eintraege} onWaehle={(k) => setAdrnr(k ?? '')} />
        )}
        <RadioButton name="frei" text="Kein Mitglied – als externen Hallennutzer freigeben (nur Einzelbuchungen)" checked={modus === 'HALLE'} onChange={() => setModus('HALLE')} />
        <Label showColon>Bemerkung (intern)</Label>
        <TextArea rows={2} value={bemerkung} maxlength={500} onInput={(e) => setBemerkung(e.target.value)} />
      </div>
    </Dialog>
  );
}
