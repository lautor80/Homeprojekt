import { useEffect, useState } from 'react';
import { BusyIndicator, Button, DatePicker, Input, Label, MessageStrip, ObjectStatus, Option, Select, Text } from '@ui5/webcomponents-react';
import type { ReactNode } from 'react';
import '../sport/spielerdaten.css';
import { api } from '@core/api';
import { Empty, Section } from '@core/components/Section';
import { toast } from '@core/toast';
import { useCan } from '@core/session';
import { TCO, dat, eur } from '../util';

/**
 * Abo-Bewerbung für die Halle (#11): sieben Tage auf einen Blick, je Stunde der Stand aus Sicht des Benutzers.
 * Bestätigen (bisherige Abonnenten), bewerben (auch mehrere Stunden am Stück), Position in der Warteliste, Angebot annehmen.
 * Nichts davon bucht – ein Abo entsteht erst mit der Freigabe durch den Kassenwart (unten, mit Recht „Platzverwaltung“).
 */
const PB = `${TCO}/platz`;
const WT = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

interface Saison { id: number; name: string; von: string; bis: string; bestaetigen_bis: string; nachruecken_ab: string; annahme_tage: number; mail_pause_bis: string | null }
interface Feld { platz_id: number; wochentag: number; von: number; bis: number; status: string; wartende: number; position: number | null; wunsch_id: number | null; preis: number | null; einheiten: number; gesamt: number; hinweis: string | null }
interface Mein { id: number; art: string; platz: string; platz_id: number; wochentag: number; von: string; bis: string; status: string; text: string; wartende: number; position: number | null; annehmen_bis: string | null; kosten: string | null }
interface Raster { saison: Saison | null; unterjaehrig: boolean; plaetze: { id: number; name: string }[]; felder: Feld[]; meine: Mein[]; maxBewerbungen: number }
interface VWunsch { id: number; art: string; name: string; mitglied: boolean; platz: string; text: string; status: string; angelegt: string; mail_fehler: string | null; wartende: number; position: number | null; wochentag: number; von: string; kosten: string | null }
interface Verwaltung { saison: Saison | null; wuensche: VWunsch[] }

const FELD: Record<string, { titel: string; klasse: string }> = {
  frei: { titel: 'Frei', klasse: 'frei' }, vergeben: { titel: 'Vergeben', klasse: 'vergeben' }, offen: { titel: 'Mein Abo', klasse: 'offen' },
  bestaetigt: { titel: 'Mein Abo', klasse: 'mein' }, freigegeben: { titel: 'Mein Abo', klasse: 'mein' }, bewerbung: { titel: 'Beworben', klasse: 'bewerbung' },
  angebot: { titel: 'Angebot', klasse: 'offen' }, angenommen: { titel: 'Angenommen', klasse: 'mein' }, gesperrt: { titel: 'Belegt', klasse: 'gesperrt' },
};
const STATUS: Record<string, string> = {
  OFFEN: 'Bestätigung offen', BESTAETIGT: 'bestätigt – wartet auf Freigabe', ABGEGEBEN: 'abgegeben', VERFALLEN: 'verfallen', WARTET: 'auf der Warteliste',
  ANGEBOTEN: 'angeboten', ANGENOMMEN: 'angenommen – wartet auf Freigabe', ABGELEHNT: 'abgelehnt', ZURUECKGEZOGEN: 'zurückgezogen', FREIGEGEBEN: 'freigegeben',
};

function Tabelle({ kopf, children }: { kopf: string[]; children: ReactNode }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="portal-sd__tabelle"><thead><tr>{kopf.map((k, i) => <th key={i}>{k}</th>)}</tr></thead><tbody>{children}</tbody></table>
    </div>
  );
}

export function AboBewerbung() {
  const can = useCan();
  const admin = can('tco.platz:admin');
  const [r, setR] = useState<Raster | null>(null);
  const [v, setV] = useState<Verwaltung | null>(null);
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
      if (admin) setV(await api.get<Verwaltung>(`${PB}/admin/abosaison`));
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
      {admin && v && <AboVerwaltung v={v} busy={busy} tun={tun} />}
    </>
  );
}

/**
 * Kassenwart: Saison eröffnen (immer aktuelles Jahr / Folgejahr), Fristen und E-Mail-Pause einstellen, Übersicht als Tabellen:
 * Abos des Vorjahres (Bestätigung) und Warteliste in ihrer Reihenfolge – jeweils mit Freigabe.
 */
function AboVerwaltung({ v, busy, tun }: { v: Verwaltung; busy: boolean; tun: (fn: () => Promise<{ text?: string }>) => Promise<void> }) {
  const j = new Date().getFullYear();
  const s = v.saison;
  const NEU = { name: `${j}/${j + 1}`, von: `${j}-09-15`, bis: `${j + 1}-04-30`, bestaetigen_bis: `${j}-07-30`, nachruecken_ab: `${j}-08-15`, annahme_tage: '7', mail_pause_bis: '' };
  const [neu, setNeu] = useState(!s);
  const [f, setF] = useState(() => (s ? { name: s.name, von: s.von, bis: s.bis, bestaetigen_bis: s.bestaetigen_bis, nachruecken_ab: s.nachruecken_ab, annahme_tage: String(s.annahme_tage), mail_pause_bis: s.mail_pause_bis ?? '' } : NEU));
  const [vj, setVj] = useState({ von: `${j - 1}-09-15`, bis: `${j}-04-30` });
  // vor jedem Schritt, der E-Mails auslöst: nachfragen
  const [frage, setFrage] = useState<null | 'eroeffnen' | 'lauf'>(null);
  const feld = (k: keyof typeof f, label: string, breite = '9.5rem', fest = false) => (
    <span style={{ display: 'inline-flex', flexDirection: 'column' }}>
      <Label>{label}</Label>
      {k === 'name' || k === 'annahme_tage'
        ? <Input readonly={fest} value={f[k]} style={{ width: breite }} onInput={(e) => setF({ ...f, [k]: (e.target as unknown as { value: string }).value })} />
        : <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f[k]} style={{ width: breite }}
                      onChange={(e) => (e.detail.valid || !e.detail.value) && setF({ ...f, [k]: e.detail.value ?? '' })} />}
    </span>
  );
  const vjFeld = (k: 'von' | 'bis', label: string) => (
    <span style={{ display: 'inline-flex', flexDirection: 'column' }}><Label>{label}</Label>
      <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={vj[k]} style={{ width: '9.5rem' }}
                  onChange={(e) => e.detail.valid && e.detail.value && setVj({ ...vj, [k]: e.detail.value })} /></span>
  );
  const daten = { ...f, annahme_tage: Number(f.annahme_tage) || 7, mail_pause_bis: f.mail_pause_bis || null };
  const ausfuehren = (mail: boolean) => {
    const was = frage;
    setFrage(null);
    if (was === 'eroeffnen') return tun(async () => { const x = await api.post<{ text: string }>(`${PB}/admin/abosaison`, { ...daten, vorjahr_von: vj.von, vorjahr_bis: vj.bis, mail }); setNeu(false); return x; });
    return tun(() => api.post<{ text?: string }>(`${PB}/admin/abosaison/lauf`, { mail }));
  };
  const lebt = (w: VWunsch) => !['ZURUECKGEZOGEN', 'ABGELEHNT', 'VERFALLEN', 'ABGEGEBEN'].includes(w.status);
  const zeit = (a: VWunsch, b: VWunsch) => a.platz.localeCompare(b.platz) || a.wochentag - b.wochentag || a.von.localeCompare(b.von) || (a.position ?? 0) - (b.position ?? 0);
  const abos = v.wuensche.filter((w) => w.art === 'BESTAETIGUNG' && lebt(w)).sort(zeit);
  const warte = v.wuensche.filter((w) => w.art === 'BEWERBUNG' && lebt(w)).sort(zeit);
  const zeile = (w: VWunsch, warteliste: boolean) => (
    <tr key={w.id}>
      <td>{w.text}</td><td>{w.platz}</td>
      {warteliste && <td>{w.position != null ? `${w.position} von ${w.wartende}` : '–'}</td>}
      <td>{w.name}</td><td>{w.mitglied ? 'Mitglied' : 'kein Mitglied'}</td>
      <td><ObjectStatus state={['BESTAETIGT', 'ANGENOMMEN'].includes(w.status) ? 'Critical' : w.status === 'FREIGEGEBEN' ? 'Positive' : 'None'}>{STATUS[w.status] ?? w.status}</ObjectStatus></td>
      <td>{warteliste ? dat(w.angelegt) : w.wartende ? `${w.wartende} wartend` : '–'}</td>
      <td>{[w.kosten, w.mail_fehler].filter(Boolean).join(' · ') || '–'}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        {['BESTAETIGT', 'ANGENOMMEN'].includes(w.status) && <Button design="Emphasized" disabled={busy} onClick={() => tun(() => api.post<{ text?: string }>(`${PB}/admin/abowunsch/freigeben`, { id: w.id }))}>Freigeben</Button>}
        {w.status !== 'FREIGEGEBEN' && (
          <Button design="Transparent" disabled={busy} tooltip={warteliste ? 'Bewerbung ablehnen: Sie verlässt die Warteliste, die Nächsten rücken auf. Es wird nichts gebucht oder storniert.'
            : 'Abo für diese Saison nicht verlängern: Die Stunde wird frei und geht an die Warteliste. Es wird nichts storniert.'}
                  onClick={() => tun(() => api.post<{ text?: string }>(`${PB}/admin/abowunsch/abweisen`, { id: w.id }))}>Ablehnen</Button>
        )}
      </td>
    </tr>
  );
  return (
    <Section title="Abo-Saison verwalten (Kassenwart)" flush actions={s && !neu ? <Button design="Transparent" onClick={() => { setF(NEU); setNeu(true); }}>Neue Saison eröffnen</Button> : undefined}>
      <div className="portal-abo__detail">
        <span style={{ display: 'inline-flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {feld('name', 'Saison', '8rem', true)}{feld('von', 'Beginn')}{feld('bis', 'Ende')}{feld('bestaetigen_bis', 'Bestätigen bis')}{feld('nachruecken_ab', 'Nachrücken ab')}{feld('annahme_tage', 'Annahmefrist (Tage)', '8rem')}
          {feld('mail_pause_bis', 'E-Mail-Pause bis')}
          {neu && (
            <>
              {vjFeld('von', 'Abos des Vorjahres von')}{vjFeld('bis', 'bis')}
            </>
          )}
          {neu
            ? <Button design="Emphasized" disabled={busy} onClick={() => setFrage('eroeffnen')}>Saison eröffnen</Button>
            : <Button disabled={busy} onClick={() => tun(() => api.put<{ text?: string }>(`${PB}/admin/abosaison/${s!.id}`, daten))}>Fristen speichern</Button>}
          {s && !neu && <Button design="Transparent" disabled={busy} onClick={() => setFrage('lauf')}>Fällige Schritte jetzt ausführen</Button>}
          {neu && s && <Button design="Transparent" onClick={() => { setF({ name: s.name, von: s.von, bis: s.bis, bestaetigen_bis: s.bestaetigen_bis, nachruecken_ab: s.nachruecken_ab, annahme_tage: String(s.annahme_tage), mail_pause_bis: s.mail_pause_bis ?? '' }); setNeu(false); }}>Abbrechen</Button>}
        </span>
        {frage && (
          <MessageStrip design="Critical" hideCloseButton>
            {frage === 'eroeffnen' ? 'Sollen die bisherigen Abonnenten per E-Mail gebeten werden, ihr Abo zu bestätigen?' : 'Sollen die Betroffenen (Erinnerung, Angebote aus der Warteliste) per E-Mail informiert werden?'}{' '}
            <Button design="Emphasized" disabled={busy} onClick={() => ausfuehren(true)}>Ja, E-Mails senden</Button>{' '}
            <Button disabled={busy} onClick={() => ausfuehren(false)}>Ohne E-Mail ausführen</Button>{' '}
            <Button design="Transparent" onClick={() => setFrage(null)}>Abbrechen</Button>
          </MessageStrip>
        )}
        <Text className="portal-muted portal-small">
          {neu ? 'Beim Eröffnen werden die Hallenabos des Vorjahres zur Bestätigung vorgemerkt – es wird nichts gebucht. Training wird nicht abgefragt; es wird über die festen Belegungen der Platzverwaltung geblockt. Ist der Nachrück-Termin schon vorbei (laufende Saison), entfällt die Vormerkung; freie Stunden können dann sofort beworben werden. '
            : ''}
          E-Mail-Pause: Bis einschließlich dieses Datums ruht der automatische Lauf (keine Erinnerung, kein Verfall, keine Angebote, keine E-Mails). „Ablehnen“ nimmt einen Eintrag aus dem Verfahren – die Stunde wird frei bzw. die Warteliste rückt auf; gebucht oder storniert wird dabei nichts.
        </Text>
      </div>
      {s && (
        <>
          <div className="portal-abo__detail">
            <b>Abos des Vorjahres ({abos.length})</b>
            {abos.length ? <Tabelle kopf={['Zeit', 'Platz', 'Abonnent', '', 'Stand', 'Warteliste', 'Hinweis', '']}>{abos.map((w) => zeile(w, false))}</Tabelle> : <Text className="portal-muted">Keine Abos zur Bestätigung vorgemerkt.</Text>}
          </div>
          <div className="portal-abo__detail">
            <b>Warteliste ({warte.length})</b>
            {warte.length ? <Tabelle kopf={['Zeit', 'Platz', 'Position', 'Interessent', '', 'Stand', 'Beworben am', 'Hinweis', '']}>{warte.map((w) => zeile(w, true))}</Tabelle> : <Text className="portal-muted">Noch keine Bewerbungen.</Text>}
          </div>
        </>
      )}
    </Section>
  );
}
