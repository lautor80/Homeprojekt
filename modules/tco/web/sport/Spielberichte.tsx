import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BusyIndicator, Button, CheckBox, Input, Label, MessageStrip, ObjectStatus, Option, Select, Tab, TabContainer, Text, TextArea } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { ImportDialog, ImportKnopf, type ImportSchritt } from '@core/components/ImportDialog';
import { Section } from '@core/components/Section';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { dat, wtag } from '../util';
import { htmlTabelle } from '../kalender/Massenanlage';
import { vereinUndNummer } from '../../server/sport/spielbericht-logik';
import {
  BERICHT_STATUS, SB, lkText, saisonHeute, type ListeDetail, type ListeKopf, type ListeVorschau, type Spieltage, type SpieltagZeile, type VorschauSpieltag,
} from './spielbericht-api';
import './spielerdaten.css';
import './spielbericht.css';

/**
 * Spielberichte (Sport → Spielberichte): Übersicht der Mannschaftsspieltage mit dem Stand des Spielberichts und – als
 * Unterkapitel – die Meldelisten. Beide werden aus STB.LIGA.NU übernommen: Tabelle dort markieren, kopieren und im
 * Dialog „Importieren“ einfügen (Spielplan bzw. namentliche Mannschaftsmeldung). Ein Klick auf einen Spieltag öffnet
 * den Spielbericht (/tco/spielberichte/:id).
 */
type Reiter = 'spieltage' | 'meldelisten';

/** Textfeld, das eine aus dem Browser kopierte Tabelle (HTML) als Tabulator-Text übernimmt */
function Einfuegen({ text, setText, platzhalter }: { text: string; setText: (t: string) => void; platzhalter: string }) {
  return (
    <div onPaste={(e) => {
      const t = htmlTabelle(e.clipboardData.getData('text/html'));
      if (t) { e.preventDefault(); setText(text.trim() ? `${text.replace(/\s+$/, '')}\n${t}` : t); }
    }}>
      <TextArea rows={12} value={text} onInput={(e) => setText(e.target.value)} placeholder={platzhalter} style={{ width: '100%' }} />
    </div>
  );
}

// ---------------------------------------------------------------- Import Spieltage
function SpieltageImport({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [zeilen, setZeilen] = useState<VorschauSpieltag[] | null>(null);
  const [ignoriert, setIgnoriert] = useState(0);
  const [wahl, setWahl] = useState<Set<number>>(new Set());
  const [ergebnis, setErgebnis] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const schritt: ImportSchritt = ergebnis ? 4 : zeilen ? 3 : text.trim() ? 2 : 1;

  async function pruefen() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ zeilen: VorschauSpieltag[]; ignoriert: number }>(`${SB}/spieltage/vorschau`, { text });
      if (!r.zeilen.length) throw new Error('Im Text wurde kein Spieltag erkannt (eine Zeile je Spiel mit Datum, Liga, Heim und Gast).');
      setZeilen(r.zeilen); setIgnoriert(r.ignoriert);
      setWahl(new Set(r.zeilen.filter((z) => z.status !== 'fehler').map((z) => z.zeile)));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function uebernehmen() {
    if (!zeilen) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string }>(`${SB}/spieltage`, { zeilen: zeilen.filter((z) => wahl.has(z.zeile)) });
      setErgebnis(r.text); toast(r.text); onDone();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <ImportDialog open was="Mannschaftsspieltage aus STB.LIGA.NU" schritt={schritt} breit onClose={onClose}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      {ergebnis ? <MessageStrip design="Positive" hideCloseButton>{ergebnis}</MessageStrip> : !zeilen ? (
        <Section title="Spielplan einfügen">
          <Text className="portal-muted" style={{ display: 'block', marginBottom: '0.5rem' }}>
            1. In STB.LIGA.NU den <b>Spielplan des Vereins</b> (oder einer Mannschaft) öffnen. 2. Die Tabelle mit der Maus markieren, kopieren
            und hier mit Strg+V einfügen – auch eine von Claude aus einem Screenshot aufgeteilte Tabelle („|“) geht. 3. Prüfen und übernehmen.
            Gleiche Begegnungen werden aktualisiert (z. B. verlegte Uhrzeit), nicht doppelt angelegt.
          </Text>
          <Einfuegen text={text} setText={setText}
                     platzhalter={'Tag | Datum | Uhrzeit | Nr. | Halle | Platz | Liga | Heimmannschaft | Gastmannschaft\nSa | 16.05.2026 | 11:00 | 4711 | Anlage TC Oberthal | 1-3 | Herren 40 Verbandsliga | TC Oberthal 1 | TC Beispielstadt 2'} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
            <Button design="Emphasized" icon="inspection" disabled={busy || !text.trim()} onClick={pruefen}>Prüfen</Button>
          </div>
        </Section>
      ) : (
        <Section title={`Vorschau (${zeilen.length} Spieltage)`} actions={<>
          <Button design="Emphasized" icon="accept" disabled={busy || !wahl.size} onClick={uebernehmen}>{wahl.size} übernehmen</Button>
          <Button design="Transparent" disabled={busy} onClick={() => setZeilen(null)}>Zurück</Button>
        </>}>
          {ignoriert > 0 && <Text className="portal-muted portal-small" style={{ display: 'block', marginBottom: '0.4rem' }}>{ignoriert} Textzeile(n) ohne Datum übergangen.</Text>}
          <div className="portal-sd__rahmen portal-tabrahmen">
            <table className="portal-sd__tabelle">
              <thead><tr><th /><th>Datum</th><th>Uhrzeit</th><th>Liga</th><th>Heim</th><th>Gast</th><th>Ort</th><th>Saison</th><th>Status</th></tr></thead>
              <tbody>
                {zeilen.map((z) => (
                  <tr key={z.zeile}>
                    <td>{z.status !== 'fehler' && (
                      <CheckBox checked={wahl.has(z.zeile)} accessibleName={`${z.heim} – ${z.gast} übernehmen`}
                                onChange={(e) => { const n = new Set(wahl); if (e.target.checked) n.add(z.zeile); else n.delete(z.zeile); setWahl(n); }} />
                    )}</td>
                    <td>{z.datum ? `${wtag(z.datum)} ${dat(z.datum)}` : '–'}</td><td>{z.uhrzeit ?? ''}</td><td>{z.liga}</td><td>{z.heim}</td><td>{z.gast}</td>
                    <td className="portal-muted">{[z.halle, z.platz].filter(Boolean).join(', ')}</td><td>{z.saison}</td>
                    <td>{z.status === 'fehler'
                      ? <ObjectStatus state="Negative">Zeile {z.zeile}: {z.fehler}</ObjectStatus>
                      : <ObjectStatus state={z.status === 'neu' ? 'Positive' : 'Information'}>{z.status === 'neu' ? 'neu' : 'wird aktualisiert'}</ObjectStatus>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </ImportDialog>
  );
}

// ---------------------------------------------------------------- Import Meldeliste
function MeldelisteImport({ vereine, onClose, onDone }: { vereine: string[]; onClose: () => void; onDone: () => void }) {
  const [saison, setSaison] = useState(saisonHeute());
  const [verein, setVerein] = useState(vereine[0] ?? '');
  const [konkurrenz, setKonkurrenz] = useState('');
  const [text, setText] = useState('');
  const [v, setV] = useState<ListeVorschau | null>(null);
  const [ergebnis, setErgebnis] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const schritt: ImportSchritt = ergebnis ? 4 : v ? 3 : text.trim() ? 2 : 1;

  async function pruefen() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<ListeVorschau>(`${SB}/meldelisten/vorschau`, { text });
      if (!r.spieler.length && !r.fehler.length) throw new Error('In der Tabelle wurden keine Spieler erkannt (je Zeile Rang und Name).');
      setV(r);
      if (r.konkurrenz && !konkurrenz.trim()) setKonkurrenz(r.konkurrenz);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function speichern() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string }>(`${SB}/meldelisten`, { saison, verein, konkurrenz, text });
      setErgebnis(r.text); toast(r.text); onDone();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <ImportDialog open was="Meldeliste aus STB.LIGA.NU" schritt={schritt} breit onClose={onClose}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      {ergebnis ? (
        <>
          <MessageStrip design="Positive" hideCloseButton>{ergebnis}</MessageStrip>
          <div style={{ marginTop: '0.75rem' }}>
            <Button icon="add" onClick={() => { setErgebnis(null); setV(null); setText(''); setKonkurrenz(''); }}>Weitere Meldeliste einfügen</Button>
          </div>
        </>
      ) : (
        <Section title="Meldeliste einfügen" actions={v ? <>
          <Button design="Emphasized" icon="save" disabled={busy || !!v.fehler.length || !v.spieler.length || !konkurrenz.trim() || !verein.trim()} onClick={speichern}>Speichern</Button>
          <Button design="Transparent" disabled={busy} onClick={() => setV(null)}>Zurück</Button>
        </> : undefined}>
          <Text className="portal-muted" style={{ display: 'block', marginBottom: '0.5rem' }}>
            In STB.LIGA.NU beim Verein die <b>namentliche Mannschaftsmeldung</b> einer Konkurrenz öffnen (z. B. „Herren 40“), die Tabelle
            (Rang, Mannschaft, LK, ID-Nummer, Name) markieren, kopieren und hier einfügen. Für Gegner genauso – dann stehen beim Spielbericht
            beide Aufstellungen zur Auswahl. Ein erneuter Import ersetzt die Liste.
          </Text>
          <div className="portal-spb__felder">
            <div><Label for="ml-saison" showColon required>Saison</Label><Input id="ml-saison" value={saison} onInput={(e) => setSaison(e.target.value)} /></div>
            <div>
              <Label for="ml-verein" showColon required>Verein</Label>
              <Input id="ml-verein" value={verein} onInput={(e) => setVerein(e.target.value)} placeholder="z. B. TC Oberthal" />
              {vereine.length > 0 && (
                <div className="portal-spb__chips">{vereine.slice(0, 8).map((x) => <Button key={x} design={x === verein ? 'Emphasized' : 'Transparent'} onClick={() => setVerein(x)}>{x}</Button>)}</div>
              )}
            </div>
            <div><Label for="ml-konk" showColon required>Konkurrenz</Label><Input id="ml-konk" value={konkurrenz} onInput={(e) => setKonkurrenz(e.target.value)} placeholder="z. B. Herren 40" /></div>
          </div>
          {!v ? (
            <>
              <Einfuegen text={text} setText={setText}
                         platzhalter={'Herren 40\nRang | Mannschaft | LK | ID-Nummer | Name, Vorname | Nation\n1 | 1 | LK 8,4 | 17845502 | Vogel, Andreas | GER'} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
                <Button design="Emphasized" icon="inspection" disabled={busy || !text.trim()} onClick={pruefen}>Prüfen</Button>
              </div>
            </>
          ) : (
            <>
              {v.fehler.length > 0 && (
                <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>
                  {v.fehler.map((f) => `Zeile ${f.zeile}: ${f.text}`).join('\n')}
                </MessageStrip>
              )}
              <Text className="portal-muted portal-small" style={{ display: 'block', marginBottom: '0.4rem' }}>
                {v.spieler.length} Spieler erkannt{v.ignoriert ? ` · ${v.ignoriert} Zeile(n) ohne Spieler übergangen` : ''}.
              </Text>
              <div className="portal-sd__rahmen portal-tabrahmen">
                <table className="portal-sd__tabelle">
                  <thead><tr><th>Rang</th><th>Mannschaft</th><th>Name</th><th>Vorname</th><th>ID-Nr.</th><th>LK</th><th>Nation</th></tr></thead>
                  <tbody>{v.spieler.map((s) => (
                    <tr key={`${s.zeile}`}><td><b>{s.rang}</b></td><td>{s.mannschaft ?? '–'}</td><td>{s.nachname}</td><td>{s.vorname}</td><td>{s.id_nr ?? '–'}</td><td>{lkText(s.lk) || '–'}</td><td>{s.nation}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            </>
          )}
        </Section>
      )}
    </ImportDialog>
  );
}

// ---------------------------------------------------------------- Seite
export function Spielberichte() {
  const can = useCan();
  const darfImport = can('tco.spielbericht:import');
  const navigate = useNavigate();
  const [tab, setTab] = useState<Reiter>('spieltage');
  const [sp, setSp] = useState<Spieltage | null>(null);
  const [listen, setListen] = useState<ListeKopf[] | null>(null);
  const [saison, setSaison] = useState('');
  const [dialog, setDialog] = useState<Reiter | null>(null);
  const [offen, setOffen] = useState<ListeDetail | null>(null);
  const [loeschen, setLoeschen] = useState<{ art: Reiter; id: number; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const laden = () => Promise.all([
    api.get<Spieltage>(`${SB}/spieltage`).then((r) => { setSp(r); setSaison((s) => s || r.saisons[0] || ''); }),
    api.get<ListeKopf[]>(`${SB}/meldelisten`).then(setListen),
  ]).catch((e) => setError(e.message));
  useEffect(() => { laden(); }, []);

  const zeilen = (sp?.zeilen ?? []).filter((z) => !saison || z.saison === saison);
  // Vereine aus den Spieltagen: eigener (kommt am häufigsten vor) zuerst
  const vereine = useMemo(() => {
    const n = new Map<string, number>();
    for (const z of sp?.zeilen ?? []) for (const t of [z.heim, z.gast]) { const v = vereinUndNummer(t).verein; n.set(v, (n.get(v) ?? 0) + 1); }
    return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'de')).map(([v]) => v);
  }, [sp]);

  async function listeOeffnen(id: number) {
    if (offen?.id === id) { setOffen(null); return; }
    try { setOffen(await api.get<ListeDetail>(`${SB}/meldelisten/${id}`)); } catch (e) { setError((e as Error).message); }
  }
  async function loeschenAusfuehren() {
    if (!loeschen) return;
    try {
      const r = await api.del<{ text: string }>(`${SB}/${loeschen.art === 'spieltage' ? 'spieltage' : 'meldelisten'}/${loeschen.id}`);
      toast(r.text); setOffen(null); await laden();
    } catch (e) { setError((e as Error).message); } finally { setLoeschen(null); }
  }

  const ergebnis = (z: SpieltagZeile) => (z.punkte ? `${z.punkte[0]}:${z.punkte[1]}` : z.fertig ? `${z.fertig}/${z.anzahl} Spiele` : '');

  return (
    <AppPage title="Spielberichte" subtitle="Mannschaftsspieltage, Meldelisten und Spielberichte nach dem DTB-Formular"
             actions={darfImport ? <ImportKnopf tooltip={tab === 'spieltage' ? 'Spieltage aus STB.LIGA.NU einfügen' : 'Meldeliste aus STB.LIGA.NU einfügen'} onClick={() => setDialog(tab)} /> : undefined}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      {!sp || !listen ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : (
        <TabContainer tabLayout="Inline" contentBackgroundDesign="Transparent" onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key as Reiter)}>
          <Tab data-key="spieltage" text="Spieltage" icon="appointment-2" additionalText={String(zeilen.length)} selected={tab === 'spieltage'}>
            <div className="portal-sd__filter" style={{ paddingTop: '0.5rem' }}>
              <Select accessibleName="Saison" style={{ width: '12rem' }} onChange={(e) => setSaison((e.detail.selectedOption as HTMLElement).dataset.s ?? '')}>
                <Option data-s="" selected={!saison}>Alle Saisons</Option>
                {sp.saisons.map((s) => <Option key={s} data-s={s} selected={s === saison}>{s}</Option>)}
              </Select>
              <Button design="Transparent" icon="refresh" tooltip="Aktualisieren" onClick={laden} />
            </div>
            <div className="portal-sd__rahmen portal-tabrahmen">
              <table className="portal-sd__tabelle portal-spb__liste">
                <thead><tr><th>Datum</th><th>Liga</th><th>Heim</th><th>Gast</th><th>Ort</th><th>Meldelisten</th><th>Spielbericht</th><th>Ergebnis</th><th /></tr></thead>
                <tbody>
                  {zeilen.map((z) => {
                    const st = BERICHT_STATUS[z.status];
                    return (
                      <tr key={z.id} className="portal-spb__klick" onClick={() => navigate(`/tco/spielberichte/${z.id}`)}>
                        <td style={{ whiteSpace: 'nowrap' }}><b>{wtag(z.datum)} {dat(z.datum)}</b>{z.uhrzeit && <div className="portal-muted portal-small">{z.uhrzeit} Uhr</div>}</td>
                        <td>{z.liga}{z.nr && <div className="portal-muted portal-small">Spiel-Nr. {z.nr}</div>}</td>
                        <td>{z.heim}</td><td>{z.gast}</td>
                        <td className="portal-muted">{[z.halle, z.platz].filter(Boolean).join(', ')}</td>
                        <td className="portal-small">{z.listeHeim ? 'Heim ✓' : 'Heim –'} · {z.listeGast ? 'Gast ✓' : 'Gast –'}</td>
                        <td><ObjectStatus state={st.state}>{st.text}</ObjectStatus>{z.status === 'entwurf' && <div className="portal-muted portal-small">{z.freigaben}/2 Freigaben</div>}</td>
                        <td><b>{ergebnis(z)}</b></td>
                        <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                          <Button design="Transparent" icon="navigation-right-arrow" tooltip="Spielbericht öffnen" onClick={() => navigate(`/tco/spielberichte/${z.id}`)} />
                          {darfImport && z.status === 'kein' && (
                            <Button design="Transparent" icon="delete" tooltip="Spieltag löschen" onClick={() => setLoeschen({ art: 'spieltage', id: z.id, text: `${dat(z.datum)} ${z.heim} – ${z.gast}` })} />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!zeilen.length && (
                <Text className="portal-muted" style={{ display: 'block', padding: '0.75rem 1rem' }}>
                  Noch keine Spieltage{darfImport ? ' – über „Importieren“ den Spielplan aus STB.LIGA.NU einfügen.' : '.'}
                </Text>
              )}
            </div>
          </Tab>
          <Tab data-key="meldelisten" text="Meldelisten" icon="list" additionalText={String(listen.length)} selected={tab === 'meldelisten'}>
            <Text className="portal-muted portal-small" style={{ display: 'block', padding: '0.5rem 0' }}>
              Je Saison, Verein und Konkurrenz eine Liste. Zum Spieltag passt die Liste, deren Verein im Mannschaftsnamen und deren Konkurrenz
              in der Liga steht („TC Oberthal 1“ in „Herren 40 Verbandsliga“ → TC Oberthal, Herren 40). Mitglieder werden über die ID-Nr. erkannt.
            </Text>
            <div className="portal-sd__rahmen portal-tabrahmen">
              <table className="portal-sd__tabelle">
                <thead><tr><th>Saison</th><th>Verein</th><th>Konkurrenz</th><th>Spieler</th><th>Stand</th><th /></tr></thead>
                <tbody>
                  {listen.map((l) => (
                    <Fragment key={l.id}>
                      <tr className="portal-spb__klick" onClick={() => listeOeffnen(l.id)}>
                        <td>{l.saison}</td><td><b>{l.verein}</b></td><td>{l.konkurrenz}</td><td>{l.spieler}</td><td className="portal-muted">{dat(l.stand.slice(0, 10))}</td>
                        <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                          <Button design="Transparent" icon={offen?.id === l.id ? 'collapse' : 'expand'} tooltip="Spieler anzeigen" onClick={() => listeOeffnen(l.id)} />
                          {darfImport && <Button design="Transparent" icon="delete" tooltip="Meldeliste löschen" onClick={() => setLoeschen({ art: 'meldelisten', id: l.id, text: `${l.verein} ${l.konkurrenz} (${l.saison})` })} />}
                        </td>
                      </tr>
                      {offen?.id === l.id && (
                        <tr><td colSpan={6} style={{ background: 'var(--sapList_AlternatingBackground, #fafafa)' }}>
                          <div className="portal-tabrahmen">
                          <table className="portal-sd__tabelle">
                            <thead><tr><th>Rang</th><th>Mannschaft</th><th>Name</th><th>ID-Nr.</th><th>LK</th><th>Nation</th><th>Mitglied</th></tr></thead>
                            <tbody>{offen.spieler.map((s) => (
                              <tr key={s.rang}><td><b>{s.rang}</b></td><td>{s.mannschaft ?? '–'}</td><td>{s.nachname}, {s.vorname}</td><td>{s.id_nr ?? '–'}</td><td>{lkText(s.lk) || '–'}</td><td>{s.nation}</td><td>{s.adrnr ? '✓' : ''}</td></tr>
                            ))}</tbody>
                          </table>
                          </div>
                        </td></tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
              {!listen.length && (
                <Text className="portal-muted" style={{ display: 'block', padding: '0.75rem 1rem' }}>
                  Noch keine Meldelisten{darfImport ? ' – über „Importieren“ die namentliche Mannschaftsmeldung aus STB.LIGA.NU einfügen.' : '.'}
                </Text>
              )}
            </div>
          </Tab>
        </TabContainer>
      )}
      {dialog === 'spieltage' && <SpieltageImport onClose={() => setDialog(null)} onDone={laden} />}
      {dialog === 'meldelisten' && <MeldelisteImport vereine={vereine} onClose={() => setDialog(null)} onDone={laden} />}
      <ConfirmDialog open={!!loeschen} title={loeschen?.art === 'spieltage' ? 'Spieltag löschen' : 'Meldeliste löschen'} danger confirmText="Löschen"
                     text={`${loeschen?.text ?? ''} wirklich löschen?${loeschen?.art === 'meldelisten' ? ' Bereits erfasste Spielberichte behalten ihre Aufstellung.' : ''}`}
                     onConfirm={loeschenAusfuehren} onCancel={() => setLoeschen(null)} />
    </AppPage>
  );
}
