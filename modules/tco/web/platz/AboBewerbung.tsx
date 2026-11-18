import { useEffect, useState } from 'react';
import { BusyIndicator, Button, Label, Link, MessageStrip, ObjectStatus, Option, Select, Text } from '@ui5/webcomponents-react';
import { useNavigate } from 'react-router-dom';
import '../sport/spielerdaten.css';
import { api } from '@core/api';
import { Empty, Section } from '@core/components/Section';
import { toast } from '@core/toast';
import { useCan } from '@core/session';
import { TCO, dat, eur } from '../util';

/**
 * Abo-Bewerbung für die Halle (#11): sieben Tage auf einen Blick, je Stunde der Stand aus Sicht des Benutzers.
 * Bestätigen (bisherige Abonnenten), bewerben (auch mehrere Stunden am Stück), Position in der Warteliste, Angebot annehmen.
 * Nichts davon bucht – ein Abo entsteht erst mit der Freigabe durch den Kassenwart (Platzverwaltung → Abo-Saison).
 */
const PB = `${TCO}/platz`;
const WT = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export interface Saison { id: number; name: string; von: string; bis: string; bestaetigen_bis: string; nachruecken_ab: string; annahme_tage: number; mail_pause_bis: string | null }
interface Feld { platz_id: number; wochentag: number; von: number; bis: number; status: string; wartende: number; position: number | null; wunsch_id: number | null; preis: number | null; einheiten: number; gesamt: number; hinweis: string | null }
interface Mein { id: number; art: string; platz: string; platz_id: number; wochentag: number; von: string; bis: string; status: string; text: string; wartende: number; position: number | null; annehmen_bis: string | null; kosten: string | null }
interface Raster { saison: Saison | null; unterjaehrig: boolean; plaetze: { id: number; name: string }[]; felder: Feld[]; meine: Mein[]; maxBewerbungen: number }

const FELD: Record<string, { titel: string; klasse: string }> = {
  frei: { titel: 'Frei', klasse: 'frei' }, vergeben: { titel: 'Vergeben', klasse: 'vergeben' }, offen: { titel: 'Mein Abo', klasse: 'offen' },
  bestaetigt: { titel: 'Mein Abo', klasse: 'mein' }, freigegeben: { titel: 'Mein Abo', klasse: 'mein' }, bewerbung: { titel: 'Beworben', klasse: 'bewerbung' },
  angebot: { titel: 'Angebot', klasse: 'offen' }, angenommen: { titel: 'Angenommen', klasse: 'mein' }, gesperrt: { titel: 'Belegt', klasse: 'gesperrt' },
};
export const STATUS: Record<string, string> = {
  OFFEN: 'Bestätigung offen', BESTAETIGT: 'bestätigt – wartet auf Freigabe', ABGEGEBEN: 'abgegeben', VERFALLEN: 'verfallen', WARTET: 'auf der Warteliste',
  ANGEBOTEN: 'angeboten', ANGENOMMEN: 'angenommen – wartet auf Freigabe', ABGELEHNT: 'abgelehnt', ZURUECKGEZOGEN: 'zurückgezogen', FREIGEGEBEN: 'freigegeben',
};

export function AboBewerbung() {
  const can = useCan();
  const navigate = useNavigate();
  const admin = can('tco.platz:admin');
  const [r, setR] = useState<Raster | null>(null);
  const [platz, setPlatz] = useState<number | null>(null);
  const [wahl, setWahl] = useState<Feld | null>(null);
  const [bis, setBis] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  const laden = async () => {
    try {
      const x = await api.get<Raster>(`${PB}/abowunsch`);
      setR(x);
      setPlatz((p) => p ?? x.plaetze[0]?.id ?? null);
    } catch (e) { setFehler((e as Error).message); }
  };
  useEffect(() => { laden(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const tun = async (fn: () => Promise<{ text?: string }>) => {
    setBusy(true); setFehler(null);
    try { const x = await fn(); toast(x.text ?? 'Gespeichert.', 7000); setWahl(null); setBis(null); await laden(); }
    catch (e) { setFehler((e as Error).message); } finally { setBusy(false); }
  };
  const aktion = (id: number, a: string) => tun(() => api.post<{ text?: string }>(`${PB}/abowunsch/${id}/${a}`, {}));

  if (!r) return <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />;
  const s = r.saison;
  const felder = r.felder.filter((f) => f.platz_id === platz);
  const zeiten = [...new Set(felder.map((f) => f.von))].sort((a, b) => a - b);
  // mehrere Stunden am Stück: ab der gewählten Stunde, solange der Tag weitergeht
  const enden = wahl ? felder.filter((f) => f.wochentag === wahl.wochentag && f.von >= wahl.von).sort((a, b) => a.von - b.von)
    .filter((f, i, l) => i === 0 || l[i - 1].bis === f.von).filter((f, i, l) => l.slice(0, i + 1).every((x) => x.status !== 'gesperrt')).map((f) => f.bis) : [];
  const mein = wahl?.wunsch_id ? r.meine.find((m) => m.id === wahl.wunsch_id) ?? null : null;
  const zeigeAktionen = (m: Mein) => (
    <span style={{ display: 'inline-flex', gap: '0.5rem', flexWrap: 'wrap' }}>
      {m.status === 'OFFEN' && <Button design="Emphasized" disabled={busy} onClick={() => aktion(m.id, 'bestaetigen')}>Abo bestätigen</Button>}
      {(m.status === 'OFFEN' || m.status === 'BESTAETIGT') && <Button disabled={busy} onClick={() => aktion(m.id, 'abgeben')}>Abo nicht verlängern</Button>}
      {m.status === 'WARTET' && <Button disabled={busy} onClick={() => aktion(m.id, 'zurueckziehen')}>Bewerbung zurückziehen</Button>}
      {m.status === 'ANGEBOTEN' && <Button design="Emphasized" disabled={busy} onClick={() => aktion(m.id, 'annehmen')}>Angebot annehmen</Button>}
      {m.status === 'ANGEBOTEN' && <Button disabled={busy} onClick={() => aktion(m.id, 'ablehnen')}>Ablehnen</Button>}
    </span>
  );

  return (
    <>
      {fehler && <MessageStrip design="Negative" onClose={() => setFehler(null)} style={{ marginBottom: '0.75rem' }}>{fehler}</MessageStrip>}
      {!s ? <Section title="Abo-Bewerbung" flush><Empty>Derzeit ist keine Saison zur Bewerbung geöffnet.</Empty></Section> : (
        <>
          <MessageStrip hideCloseButton style={{ marginBottom: '0.75rem' }}>
            Saison {s.name} ({dat(s.von)} bis {dat(s.bis)}): Bisherige Abonnenten bestätigen bis {dat(s.bestaetigen_bis)}. Ab {dat(s.nachruecken_ab)} werden freie Stunden der Warteliste angeboten –
            Mitglieder zuerst, sonst nach Eingang. Eine Bewerbung bucht nichts; das Abo gilt erst nach der Freigabe durch den Kassenwart.
            {r.unterjaehrig ? ` Die Saison läuft bereits: Freie Stunden können weiterhin als Abo beworben werden – berechnet werden die Einheiten bis ${dat(s.bis)} zum Einzelpreis der jeweiligen Stunde.` : ''}
          </MessageStrip>
          {r.meine.length > 0 && (
            <Section title="Meine Abos und Bewerbungen" count={r.meine.length} flush>
              <div className="portal-abo__karten">
                {r.meine.map((m) => (
                  <div key={m.id} className="portal-abo__karte">
                    <b>{m.text}</b>
                    <span className="portal-muted">{m.platz} · {m.art === 'BESTAETIGUNG' ? 'Abo des Vorjahres' : 'Bewerbung'}</span>
                    <ObjectStatus state={['BESTAETIGT', 'ANGENOMMEN', 'FREIGEGEBEN'].includes(m.status) ? 'Positive' : ['OFFEN', 'ANGEBOTEN'].includes(m.status) ? 'Critical' : 'None'}>{STATUS[m.status] ?? m.status}</ObjectStatus>
                    {m.position != null && <span>Position {m.position} von {m.wartende}</span>}
                    {m.art === 'BESTAETIGUNG' && m.wartende > 0 && <span>{m.wartende} Interessent{m.wartende === 1 ? '' : 'en'} auf der Warteliste</span>}
                    {m.annehmen_bis && <span>annehmen bis {dat(m.annehmen_bis)}</span>}
                    {m.kosten && <span>{m.kosten}</span>}
                    <div className="portal-abo__karte-aktionen">{zeigeAktionen(m)}</div>
                  </div>
                ))}
              </div>
            </Section>
          )}
          <Section title="Hallenstunden der Woche" flush actions={r.plaetze.length > 1 ? (
            <Select style={{ width: '12rem' }} onChange={(e) => { setPlatz(Number((e.detail.selectedOption as HTMLElement).dataset.id)); setWahl(null); }}>
              {r.plaetze.map((p) => <Option key={p.id} data-id={p.id} selected={p.id === platz}>{p.name}</Option>)}
            </Select>
          ) : undefined}>
            <div className="portal-abo__legende">
              <span><i className="portal-abo__f--mein" />Mein Abo</span><span><i className="portal-abo__f--offen" />Bestätigung/Angebot offen</span>
              <span><i className="portal-abo__f--bewerbung" />Meine Bewerbung</span><span><i className="portal-abo__f--vergeben" />Vergeben</span><span><i className="portal-abo__f--frei" />Frei</span>
              <span>Betrag je Stunde: Gesamtwert bis {dat(s.bis)} = Anzahl Einheiten × {r.unterjaehrig ? 'Einzelpreis' : 'Abo-Preis'}</span>
            </div>
            <div className="portal-abo__raster">
              <div />
              {[1, 2, 3, 4, 5, 6, 7].map((t) => <div key={t} className="portal-abo__kopf">{WT[t]}</div>)}
              {zeiten.map((z) => (
                [<div key={`z${z}`} className="portal-abo__zeit">{hm(z)}</div>,
                  ...[1, 2, 3, 4, 5, 6, 7].map((t) => {
                    const f = felder.find((x) => x.wochentag === t && x.von === z);
                    if (!f) return <div key={`${t}|${z}`} />;
                    const a = FELD[f.status] ?? FELD.frei;
                    const gewaehlt = wahl && wahl.wochentag === t && z >= wahl.von && z < (bis ?? wahl.bis);
                    return (
                      <button key={`${t}|${z}`} type="button" className={`portal-abo__feld portal-abo__f--${a.klasse}${gewaehlt ? ' portal-abo__feld--wahl' : ''}`}
                              disabled={f.status === 'gesperrt'} onClick={() => { setWahl(f); setBis(null); }}>
                        <b>{a.titel}</b>
                        <span>{f.status === 'gesperrt' ? f.hinweis : f.position != null ? `Platz ${f.position} von ${f.wartende}` : f.wartende ? `${f.wartende} warte${f.wartende === 1 ? 't' : 'n'}` : f.status === 'frei' ? 'bewerben' : ''}</span>
                        {f.status === 'frei' && f.preis != null && (
                          <span className="portal-abo__preis" title={f.preis ? `${f.einheiten} Einheiten × ${eur(f.preis)} (${r.unterjaehrig ? 'Einzelpreis' : 'Abo-Preis'})` : undefined}>
                            {f.preis ? <>{eur(f.gesamt)}<small> · {f.einheiten} × {eur(f.preis)}</small></> : 'kostenfrei'}
                          </span>
                        )}
                      </button>
                    );
                  })]
              ))}
            </div>
            {wahl && (
              <div className="portal-abo__detail">
                <b>{WT[wahl.wochentag]} {hm(wahl.von)}–{hm(bis ?? wahl.bis)} Uhr</b>
                {wahl.status === 'freigegeben' && !mein ? <Text>Das ist Ihr laufendes Abo.</Text> : mein ? (
                  <>
                    <Text>{mein.text}: {STATUS[mein.status] ?? mein.status}{mein.position != null ? ` – Position ${mein.position} von ${mein.wartende}` : ''}.</Text>
                    {zeigeAktionen(mein)}
                  </>
                ) : (
                  <>
                    <Text>
                      {wahl.status === 'vergeben' ? 'Die Stunde ist im Abo vergeben. ' : 'Für diese Stunde gibt es noch kein Abo. '}
                      {wahl.wartende ? `${wahl.wartende} Interessent${wahl.wartende === 1 ? ' wartet' : 'en warten'} bereits. ` : 'Bisher gibt es keine Interessenten. '}
                      Die Bewerbung ist unverbindlich und führt nie direkt zu einer Buchung.
                    </Text>
                    <span style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                      <Label>bis</Label>
                      <Select style={{ width: '8rem' }} onChange={(e) => setBis(Number((e.detail.selectedOption as HTMLElement).dataset.b))}>
                        {enden.map((b) => <Option key={b} data-b={b} selected={b === (bis ?? wahl.bis)}>{hm(b)} Uhr</Option>)}
                      </Select>
                      <Button design="Emphasized" disabled={busy}
                              onClick={() => tun(() => api.post<{ text?: string }>(`${PB}/abowunsch`, { platz_id: wahl.platz_id, wochentag: wahl.wochentag, von: hm(wahl.von), bis: hm(bis ?? wahl.bis) }))}>
                        {wahl.status === 'vergeben' ? 'Auf die Warteliste setzen' : 'Für diese Zeit bewerben'}
                      </Button>
                    </span>
                  </>
                )}
              </div>
            )}
          </Section>
        </>
      )}
      {admin && (
        <MessageStrip hideCloseButton style={{ marginTop: '0.75rem' }}>
          Kassenwart: Saison eröffnen, Fristen, Freigabe und Warteliste stehen jetzt in der Platzverwaltung.{' '}
          <Link onClick={() => navigate('/tco/platzverwaltung?tab=abosaison')}>Abo-Saison verwalten: Platzverwaltung → Abo-Saison</Link>
        </MessageStrip>
      )}
    </>
  );
}
