import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { BusyIndicator, Button, Icon, Input, Label, MessageStrip, ObjectStatus, Option, Select, Text, TextArea } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { Section } from '@core/components/Section';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { dat, wtag } from '../util';
import {
  berichtWerten, FORMATE, formatAnpassen, type MatchErgebnis, type SbDaten, type SbFormat, type SbMatch, type SbSpieler, type SbWertung,
} from '../../server/sport/spielbericht-logik';
import { BERICHT_STATUS, SB, lkText, zeitpunkt, type BerichtAntwort, type Seite } from './spielbericht-api';
import './spielerdaten.css';
import './spielbericht.css';

/**
 * Spielbericht eines Mannschaftsspieltags (/tco/spielberichte/:id) – digitale Fassung des DTB-Spielberichts:
 * Kopf (Wettbewerb, Heim/Gast, Datum, OSR), Einzel und Doppel mit Spielern aus den Meldelisten (Melde-Pos. und ID-Nr.
 * werden übernommen), Sätze mit Match-Tiebreak, Aufgabe und kampflos, Summen und Sieger werden beim Tippen gerechnet
 * und geprüft (gleiche Logik wie im Server: server/sport/spielbericht-logik.ts). Statt Unterschriften geben die
 * Mannschaftsführer (und ggf. der OSR) den gesicherten Bericht frei; jede Änderung setzt die Freigaben zurück.
 * Eingereicht ist der Bericht gesperrt; das PDF hat den Aufbau des Papierformulars.
 */
const SEITE = { a: 'Heim', b: 'Gast' } as const;
const WERTUNG: Record<SbWertung, string> = { gespielt: 'gespielt', aufgabe: 'Aufgabe', wo: 'kampflos' };
const zahlOderNull = (v: string): number | null => { const t = v.replace(/\D/g, '').slice(0, 2); return t === '' ? null : Number(t); };
const PILL: Record<string, string> = { fertig: '', laeuft: 'portal-spb__pill--laeuft', offen: 'portal-spb__pill--offen', fehler: 'portal-spb__pill--fehler' };

function Pill({ e }: { e: MatchErgebnis }) {
  if (e.status === 'fertig') {
    return <span className={`portal-spb__pill ${e.sieger === 'a' ? 'portal-spb__pill--heim' : 'portal-spb__pill--gast'}`}>{SEITE[e.sieger!]} {e.sieger === 'a' ? '1:0' : '0:1'}</span>;
  }
  return <span className={`portal-spb__pill ${PILL[e.status]}`}>{e.status === 'fehler' ? 'Prüfen' : e.status === 'laeuft' ? 'läuft' : 'offen'}</span>;
}

/** Spielerauswahl aus der Meldeliste; ohne Liste freie Eingabe des Namens */
function SpielerWahl({ seite, wert, ohne, gesperrt, label, onChange }: {
  seite: Seite; wert: SbSpieler | null; ohne?: boolean; gesperrt: boolean; label: string; onChange: (p: SbSpieler | null) => void;
}) {
  if (!seite.spieler.length) {
    return (
      <input className="portal-spb__feld" disabled={gesperrt} aria-label={label} placeholder="Name (keine Meldeliste)" value={wert?.name ?? ''}
             onChange={(e) => onChange(e.target.value.trim() ? { rang: null, name: e.target.value, id_nr: null, mannschaft: null } : null)} />
    );
  }
  const fremd = wert && !seite.spieler.some((p) => p.rang === wert.rang && p.name === wert.name);
  return (
    <select className="portal-spb__feld" disabled={gesperrt} aria-label={label} value={wert ? String(wert.rang ?? 'x') : ''}
            onChange={(e) => {
              const p = seite.spieler.find((x) => String(x.rang) === e.target.value);
              onChange(p ? { rang: p.rang, name: p.name, id_nr: p.id_nr, mannschaft: p.mannschaft ?? null } : null);
            }}>
      <option value="">{ohne ? 'Pos.' : '– Spieler wählen –'}</option>
      {fremd && <option value={String(wert!.rang ?? 'x')}>{wert!.rang ?? '–'} · {wert!.name} (nicht mehr in der Liste)</option>}
      {seite.spieler.map((p) => (
        <option key={p.rang} value={String(p.rang)}>{p.rang} · {ohne ? p.name.split(' ').slice(-1)[0] : p.name}{p.mannschaft && p.mannschaft !== seite.nr ? ` (M${p.mannschaft})` : ''}</option>
      ))}
    </select>
  );
}
const meta = (p: SbSpieler | null, seite: Seite) => {
  if (!p) return 'Melde-Pos. – · ID-Nr. –';
  const lk = seite.spieler.find((x) => x.rang === p.rang)?.lk;
  return `Melde-Pos. ${p.rang ?? '–'} · ID-Nr. ${p.id_nr ?? '–'}${lk != null ? ` · ${lkText(lk)}` : ''}`;
};

export function Spielbericht() {
  const { id } = useParams();
  const navigate = useNavigate();
  const edit = useCan()('tco.spielbericht:edit');
  const [r, setR] = useState<BerichtAntwort | null>(null);
  const [d, setD] = useState<SbDaten | null>(null);
  const [dirty, setDirty] = useState(false);
  const [namen, setNamen] = useState({ heim: '', gast: '', osr: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frage, setFrage] = useState<'einreichen' | 'zuruecknehmen' | null>(null);

  const laden = () => api.get<BerichtAntwort>(`${SB}/${id}`).then((x) => { setR(x); setD(x.daten); setDirty(false); }).catch((e) => setError(e.message));
  useEffect(() => { laden(); }, [id]);

  if (!r || !d) {
    return (
      <AppPage title="Spielbericht">
        {error ? <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip> : <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />}
      </AppPage>
    );
  }
  const st = r.spieltag;
  const w = berichtWerten(d, { a: r.heim.nr, b: r.gast.nr });
  const eingereicht = r.status === 'eingereicht';
  const gesperrt = !edit || eingereicht || busy;
  const aendern = (fn: (x: SbDaten) => void) => { const n = structuredClone(d); fn(n); setD(n); setDirty(true); };
  const fehlt = w.pruefungen.filter((p) => !p.ok);
  const freigabeFehlt = !r.freigaben.heim || !r.freigaben.gast || (!!d.osr.trim() && !r.freigaben.osr);
  const bereit = w.vollstaendig && !freigabeFehlt && !dirty && r.gespeichert;

  async function aktion(fn: () => Promise<{ text: string }>) {
    setBusy(true); setError(null);
    try { const x = await fn(); toast(x.text, 6000); await laden(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const sichern = () => aktion(() => api.put<{ text: string }>(`${SB}/${id}`, { daten: d }));
  const freigeben = (rolle: 'heim' | 'gast' | 'osr', name: string | null) => aktion(async () => {
    const x = await api.post<{ text: string }>(`${SB}/${id}/freigabe`, { rolle, name });
    setNamen((n) => ({ ...n, [rolle]: '' }));
    return x;
  });

  const saetze = (m: SbMatch, e: MatchErgebnis, art: 'einzel' | 'doppel', i: number, titel: string) => [0, 1, 2].map((j) => {
    const aus = gesperrt || m.wertung === 'wo' || (j === 2 && !e.mtbNoetig && m.saetze[2][0] == null && m.saetze[2][1] == null);
    const cls = `portal-spb__satz${e.satzFehler[j] ? ' portal-spb__satz--fehler' : ''}`;
    const satz = (k: 0 | 1) => (
      <input className={cls} inputMode="numeric" disabled={aus} placeholder={aus && !gesperrt ? '–' : ''} value={m.saetze[j][k] ?? ''}
             aria-label={`${titel}, ${j === 2 ? 'Match-Tiebreak' : `Satz ${j + 1}`}, ${k ? 'Gast' : 'Heim'}`}
             onChange={(ev) => aendern((x) => { x[art][i].saetze[j][k] = zahlOderNull(ev.target.value); })} />
    );
    return <td key={j}><div className="portal-spb__saetze">{satz(0)}<span>:</span>{satz(1)}</div></td>;
  });
  const wertung = (m: SbMatch, art: 'einzel' | 'doppel', i: number, titel: string) => (
    <td>
      <select className="portal-spb__feld portal-spb__feld--klein" disabled={gesperrt} aria-label={`${titel}, Wertung`} value={m.wertung}
              onChange={(e) => aendern((x) => { x[art][i].wertung = e.target.value as SbWertung; if (e.target.value === 'gespielt') x[art][i].sieger = null; })}>
        {Object.entries(WERTUNG).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
      </select>
      {m.wertung !== 'gespielt' && (
        <select className="portal-spb__feld portal-spb__feld--klein" disabled={gesperrt} aria-label={`${titel}, wer gewinnt`} value={m.sieger ?? ''}
                onChange={(e) => aendern((x) => { x[art][i].sieger = (e.target.value || null) as 'a' | 'b' | null; })}>
          <option value="">– gewinnt –</option><option value="a">Heim gewinnt</option><option value="b">Gast gewinnt</option>
        </select>
      )}
    </td>
  );
  const ergebnisZellen = (e: MatchErgebnis) => (
    <>
      <td className="portal-spb__num">{e.status === 'offen' ? '–' : `${e.spiele[0]}:${e.spiele[1]}`}</td>
      <td className="portal-spb__num">{e.status === 'offen' ? '–' : `${e.saetze[0]}:${e.saetze[1]}`}</td>
      <td><Pill e={e} /></td>
    </>
  );
  const kopf = (titel: ReactNode) => (
    <thead><tr>
      <th>Nr.</th><th className="portal-spb__heim">{titel} Heim</th><th className="portal-spb__gast">{titel} Gast</th>
      <th>Satz 1</th><th>Satz 2</th><th>Match-Tiebreak</th><th>Wertung</th><th>Spiele</th><th>Sätze</th><th>Punkte</th>
    </tr></thead>
  );
  const summe = (text: string, s: typeof w.summe) => (
    <tr className="portal-spb__summe"><td /><td colSpan={6}>{text}</td>
      <td className="portal-spb__num">{s.spiele[0]}:{s.spiele[1]}</td><td className="portal-spb__num">{s.saetze[0]}:{s.saetze[1]}</td><td className="portal-spb__num">{s.punkte[0]}:{s.punkte[1]}</td></tr>
  );
  const hinweise = (liste: string[]) => liste.map((h) => <MessageStrip key={h} design="Critical" hideCloseButton style={{ marginBottom: '0.4rem' }}>{h}</MessageStrip>);
  const listeHinweis = (s: Seite, wer: string) => (s.liste
    ? <span>{wer}: Meldeliste {s.liste.konkurrenz} ({s.spieler.length} Spieler)</span>
    : <span style={{ color: 'var(--sapCriticalTextColor)' }}>{wer}: keine Meldeliste – Namen frei eintragen oder unter Spielberichte → Meldelisten importieren</span>);

  const sieger = w.sieger === 'a' ? st.heim : w.sieger === 'b' ? st.gast : w.sieger === 'x' ? 'Unentschieden' : 'noch offen';
  const status = BERICHT_STATUS[r.gespeichert ? r.status : 'kein'];

  return (
    <AppPage title="Spielbericht" subtitle={`${st.heim} – ${st.gast} · ${st.liga} · ${wtag(st.datum)} ${dat(st.datum)}${st.uhrzeit ? `, ${st.uhrzeit} Uhr` : ''}`}
             actions={<>
               <ObjectStatus state={status.state} inverted>{status.text}</ObjectStatus>
               <Button icon="nav-back" design="Transparent" onClick={() => navigate('/tco/spielberichte')}>Übersicht</Button>
               <Button icon="pdf-attachment" disabled={!r.gespeichert} tooltip={r.gespeichert ? 'Spielbericht als PDF' : 'Erst sichern'} onClick={() => window.open(`${SB}/${id}/pdf`, '_blank')}>PDF</Button>
               {r.gespeichert && <ChangeHistoryButton objectType="SPIELBERICHT" objectKey={String(st.id)} />}
             </>}
             footer={edit && !eingereicht ? <>
               {dirty && <Text className="portal-muted portal-small" style={{ marginRight: '0.75rem' }}>Ungesicherte Änderungen{r.freigaben.heim || r.freigaben.gast ? ' – beim Sichern werden die Freigaben zurückgesetzt' : ''}</Text>}
               <Button design="Emphasized" icon="save" disabled={busy || (!dirty && r.gespeichert)} onClick={sichern}>Sichern</Button>
               <Button design="Transparent" disabled={busy || !dirty} onClick={() => { setD(r.daten); setDirty(false); }}>Verwerfen</Button>
             </> : undefined}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.75rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      {eingereicht && r.eingereicht && (
        <MessageStrip design="Positive" hideCloseButton style={{ marginBottom: '0.75rem' }}>
          Eingereicht am {zeitpunkt(r.eingereicht.am)} von {r.eingereicht.von}. Der Bericht ist schreibgeschützt.
        </MessageStrip>
      )}

      {/* Spielstand */}
      <div className="portal-spb__stand">
        <div><div className="portal-spb__label">Heim · Gastgeber</div><div className="portal-spb__team portal-spb__heim">{st.heim}</div></div>
        <div className="portal-spb__mitte">
          <div className="portal-spb__gross">{w.summe.punkte[0]} : {w.summe.punkte[1]}</div>
          <div className="portal-muted portal-small">Match-Punkte · Sätze {w.summe.saetze[0]}:{w.summe.saetze[1]} · Spiele {w.summe.spiele[0]}:{w.summe.spiele[1]}</div>
          <div className="portal-muted portal-small">Einzel {w.summeEinzel.punkte[0]}:{w.summeEinzel.punkte[1]} · Doppel {w.summeDoppel.punkte[0]}:{w.summeDoppel.punkte[1]} · {w.fertig}/{w.anzahl} Spiele</div>
        </div>
        <div style={{ textAlign: 'right' }}><div className="portal-spb__label">Gast</div><div className="portal-spb__team portal-spb__gast">{st.gast}</div></div>
      </div>

      <Section title="Begegnung">
        <div className="portal-spb__felder">
          <div><Label showColon>Wettbewerb</Label><Text>{st.liga}</Text></div>
          <div><Label showColon>Saison</Label><Text>{st.saison}</Text></div>
          <div><Label showColon>Spielort</Label><Text>{[st.halle, st.platz].filter(Boolean).join(', ') || '–'}{st.nr ? ` · Spiel-Nr. ${st.nr}` : ''}</Text></div>
          <div>
            <Label showColon>Mannschaftsstärke</Label>
            <Select disabled={gesperrt} accessibleName="Mannschaftsstärke" onChange={(e) => {
              const f = (e.detail.selectedOption as HTMLElement).dataset.f as SbFormat;
              aendern((x) => Object.assign(x, formatAnpassen(x, f)));
            }}>
              {(Object.keys(FORMATE) as SbFormat[]).map((f) => <Option key={f} data-f={f} selected={d.format === f}>{f === '6er' ? '6er' : '4er'}-Mannschaft ({FORMATE[f].text})</Option>)}
            </Select>
          </div>
          <div>
            <Label for="sb-osr" showColon>Oberschiedsrichter</Label>
            <Input id="sb-osr" disabled={gesperrt} value={d.osr} placeholder="nur falls angesetzt" onInput={(e) => aendern((x) => { x.osr = e.target.value; })} />
          </div>
        </div>
        <div className="portal-muted portal-small" style={{ marginTop: '0.5rem', display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
          {listeHinweis(r.heim, 'Heim')}{listeHinweis(r.gast, 'Gast')}
        </div>
      </Section>

      <Section title={`Einzel (${w.summeEinzel.punkte[0]}:${w.summeEinzel.punkte[1]})`}>
        {hinweise(w.hinweiseEinzel)}
        <div className="portal-sd__rahmen portal-tabrahmen">
          <table className="portal-sd__tabelle portal-spb__tabelle">
            {kopf('Einzel')}
            <tbody>
              {d.einzel.map((m, i) => {
                const t = `Einzel ${i + 1}`;
                return (
                  <tr key={i}>
                    <td className="portal-spb__nr">{i + 1}</td>
                    {(['a', 'b'] as const).map((s) => {
                      const seite = s === 'a' ? r.heim : r.gast;
                      return (
                        <td key={s} className="portal-spb__spieler">
                          <SpielerWahl seite={seite} wert={m[s][0]} gesperrt={gesperrt} label={`${t}, Spieler ${SEITE[s]}`}
                                       onChange={(p) => aendern((x) => { x.einzel[i][s] = [p]; })} />
                          <div className="portal-muted portal-small">{meta(m[s][0], seite)}</div>
                        </td>
                      );
                    })}
                    {saetze(m, w.einzel[i], 'einzel', i, t)}
                    {wertung(m, 'einzel', i, t)}
                    {ergebnisZellen(w.einzel[i])}
                  </tr>
                );
              })}
              {summe('Summe Einzel', w.summeEinzel)}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={`Doppel (${w.summeDoppel.punkte[0]}:${w.summeDoppel.punkte[1]})`}>
        {hinweise(w.hinweiseDoppel)}
        <div className="portal-sd__rahmen portal-tabrahmen">
          <table className="portal-sd__tabelle portal-spb__tabelle">
            {kopf('Pos. + Pos.')}
            <tbody>
              {d.doppel.map((m, i) => {
                const t = `Doppel ${i + 1}`;
                return (
                  <tr key={i}>
                    <td className="portal-spb__nr">{i + 1}</td>
                    {(['a', 'b'] as const).map((s) => {
                      const seite = s === 'a' ? r.heim : r.gast;
                      const [x, y] = m[s];
                      return (
                        <td key={s} className="portal-spb__spieler">
                          <div className="portal-spb__paar">
                            {[0, 1].map((k) => (
                              <SpielerWahl key={k} seite={seite} wert={m[s][k]} ohne gesperrt={gesperrt} label={`${t}, ${SEITE[s]} Spieler ${k + 1}`}
                                           onChange={(p) => aendern((z) => { z.doppel[i][s][k] = p; })} />
                            ))}
                            <span className="portal-spb__summe-pos">= {x?.rang != null && y?.rang != null ? x.rang + y.rang : '–'}</span>
                          </div>
                          <div className="portal-muted portal-small">{x && y ? `${x.name} / ${y.name}` : 'Paarung unvollständig'}</div>
                        </td>
                      );
                    })}
                    {saetze(m, w.doppel[i], 'doppel', i, t)}
                    {wertung(m, 'doppel', i, t)}
                    {ergebnisZellen(w.doppel[i])}
                  </tr>
                );
              })}
              {summe('Summe Doppel', w.summeDoppel)}
            </tbody>
          </table>
        </div>
      </Section>

      <div className="portal-spb__drei">
        <Section title="Spielinfos">
          <div className="portal-spb__felder portal-spb__felder--eng">
            <div><Label for="sb-zu" showColon>Zuschauer</Label>
              <input id="sb-zu" className="portal-spb__feld" inputMode="numeric" disabled={gesperrt} value={d.zuschauer ?? ''}
                     onChange={(e) => aendern((x) => { const t = e.target.value.replace(/\D/g, '').slice(0, 5); x.zuschauer = t ? Number(t) : null; })} /></div>
            <div><Label for="sb-beginn" showColon>Beginn</Label>
              <input id="sb-beginn" className="portal-spb__feld" type="time" disabled={gesperrt} value={d.beginn} onChange={(e) => aendern((x) => { x.beginn = e.target.value; })} /></div>
            <div><Label for="sb-ende" showColon>Ende</Label>
              <input id="sb-ende" className="portal-spb__feld" type="time" disabled={gesperrt} value={d.ende} onChange={(e) => aendern((x) => { x.ende = e.target.value; })} /></div>
          </div>
        </Section>
        <Section title="Bemerkungen">
          <TextArea rows={4} disabled={gesperrt} value={d.bemerkungen} maxlength={2000} placeholder="Vorkommnisse, Verlegungen, Proteste"
                    onInput={(e) => aendern((x) => { x.bemerkungen = e.target.value; })} style={{ width: '100%' }} />
        </Section>
        <Section title="Sieger">
          <div className="portal-spb__sieger">{sieger}</div>
          <Text className="portal-muted portal-small">
            {w.sieger && w.entschieden && w.fertig < w.anzahl ? 'Steht bereits fest – offene Spiele trotzdem eintragen.' : w.sieger ? 'Aus Match-Punkten, dann Sätzen, dann Spielen.' : `Zwischenstand nach ${w.fertig} von ${w.anzahl} Spielen.`}
          </Text>
        </Section>
      </div>

      <Section title="Freigabe statt Unterschrift">
        <Text className="portal-muted portal-small" style={{ display: 'block', marginBottom: '0.5rem' }}>
          Den gesicherten Bericht bestätigen beide Mannschaftsführer mit ihrem Namen – der Gast z. B. hier am Gerät. Wird danach etwas geändert,
          werden die Freigaben zurückgesetzt. Der Oberschiedsrichter gibt nur frei, wenn einer eingetragen ist.
        </Text>
        <div className="portal-spb__drei">
          {([['heim', 'Mannschaftsführer Heim', st.heim], ['gast', 'Mannschaftsführer Gast', st.gast], ['osr', 'Oberschiedsrichter', d.osr || 'nicht angesetzt']] as const).map(([rolle, titel, unter]) => {
            const f = r.freigaben[rolle];
            const unnoetig = rolle === 'osr' && !d.osr.trim() && !f;
            return (
              <div key={rolle} className={`portal-spb__karte${f ? ' portal-spb__karte--ok' : ''}`}>
                <div className="portal-spb__label">{titel}</div>
                <div className="portal-muted portal-small">{unter}</div>
                {f ? (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 600 }}><Icon name="accept" />{f.name}</div>
                    <div className="portal-muted portal-small">freigegeben {zeitpunkt(f.am)}{f.von && f.von !== f.name ? ` · erfasst von ${f.von}` : ''}</div>
                    {edit && !eingereicht && <Button design="Transparent" disabled={busy} onClick={() => freigeben(rolle, null)}>Zurücknehmen</Button>}
                  </>
                ) : unnoetig ? <Text className="portal-muted portal-small">Nicht erforderlich.</Text> : (
                  <>
                    <Input disabled={gesperrt || dirty || !r.gespeichert} value={namen[rolle]} placeholder="Vor- und Nachname" accessibleName={`${titel}: Name`}
                           onInput={(e) => setNamen({ ...namen, [rolle]: e.target.value })} />
                    <Button disabled={gesperrt || dirty || !r.gespeichert || namen[rolle].trim().length < 2} onClick={() => freigeben(rolle, namen[rolle])}>Bericht freigeben</Button>
                    {(dirty || !r.gespeichert) && edit && !eingereicht && <Text className="portal-muted portal-small">Erst sichern, dann freigeben.</Text>}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Einreichen" actions={edit ? (eingereicht
        ? <Button icon="undo" disabled={busy} onClick={() => setFrage('zuruecknehmen')}>Einreichung zurücknehmen</Button>
        : <Button design="Emphasized" icon="paper-plane" disabled={busy || !bereit} onClick={() => setFrage('einreichen')}>Spielbericht einreichen</Button>) : undefined}>
        <ul className="portal-spb__pruefung">
          {w.pruefungen.map((p) => <li key={p.id} className={p.ok ? 'ok' : ''}><Icon name={p.ok ? 'accept' : 'circle-task'} />{p.text}</li>)}
          <li className={!freigabeFehlt ? 'ok' : ''}><Icon name={!freigabeFehlt ? 'accept' : 'circle-task'} />Freigabe durch beide Mannschaftsführer{d.osr.trim() ? ' und den OSR' : ''}</li>
          {dirty && <li><Icon name="circle-task" />Änderungen sichern</li>}
        </ul>
        {!eingereicht && fehlt.length === 0 && !freigabeFehlt && !dirty && (
          <Text className="portal-muted portal-small">Alles erfüllt. Nach dem Einreichen ist der Bericht gesperrt; das PDF kann an Spielleiter und Gegner gehen.</Text>
        )}
      </Section>

      <ConfirmDialog open={frage === 'einreichen'} title="Spielbericht einreichen" confirmText="Einreichen"
                     text={`${st.heim} – ${st.gast}: ${w.summe.punkte[0]}:${w.summe.punkte[1]} Match-Punkte, Sieger ${sieger}. Danach ist der Bericht gesperrt.`}
                     onConfirm={() => { setFrage(null); aktion(() => api.post<{ text: string }>(`${SB}/${id}/einreichen`)); }} onCancel={() => setFrage(null)} />
      <ConfirmDialog open={frage === 'zuruecknehmen'} title="Einreichung zurücknehmen" confirmText="Zurücknehmen" danger
                     text="Der Bericht wird wieder ein Entwurf und kann geändert werden. Ein bereits weitergegebenes PDF bitte ersetzen."
                     onConfirm={() => { setFrage(null); aktion(() => api.post<{ text: string }>(`${SB}/${id}/zuruecknehmen`)); }} onCancel={() => setFrage(null)} />
    </AppPage>
  );
}
