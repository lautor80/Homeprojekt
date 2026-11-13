import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { feld } from '@core/components/Varianten';
import { BusyIndicator, Button, CheckBox, Icon, Input, MessageStrip, ObjectStatus, Option, Select, Tab, TabContainer, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { useAblageZiel } from '@core/ablage';
import { AppPage } from '@core/components/AppPage';
import { Section } from '@core/components/Section';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { TCO, dat, dateiLesen } from '../util';
import './spielerdaten.css';

/**
 * Spielerdaten aus nuLiga (#162, Sportwart): Die im Verbandsportal heruntergeladene Datei „Mitgliederdaten“ (CSV) wird per
 * Drag & Drop abgelegt und mit den aktiven Mitgliedern abgeglichen. Die Vorschau zeigt Treffer mit ID-Nr. und LK (alt → neu),
 * unsichere Treffer zum Prüfen sowie Mitglieder bzw. Personen ohne Gegenstück; übernommen wird erst mit „Übernehmen“.
 *
 * Übersicht (Leiste): „Alle“, „Mit ID-Nr.“, „Ohne ID-Nr.“ – alle aktiven Mitglieder mit Eintrittsdatum, jüngster Eintritt zuerst,
 * Suche über Name, Vorname, ID-Nr. und Mitgliedsnummer. Mitglieder ohne ID-Nr. lassen sich gesammelt als „Für Meldung irrelevant“
 * kennzeichnen; sie werden danach nicht mehr selektiert und stehen nur noch im Reiter „Für Meldung irrelevant“ (dort zurücknehmbar).
 * Der Abgleich hat einen eigenen Reiter.
 */
const S = `${TCO}/sport/spielerdaten`;
const lk = (v: number | null | undefined) => (v == null ? '–' : `LK ${v.toFixed(1).replace('.', ',')}`);

interface Zeile { adrnr: string; name: string; nachname: string; vorname: string; mitglnrn: string; geburtsdatum: string | null; eintritt: string | null; id_nr: string | null; lk: number | null; lk_stand: string | null; irrelevant: boolean | null; verlauf: { jahr: number; lk: number }[] }
interface Stand { zeilen: Zeile[]; anzahl: { mitglieder: number; mitId: number; ohneId: number; irrelevant: number; mitLk: number }; letzterAbgleich: string | null }
interface Treffer {
  adrnr: string; zeile: number; name: string; mitglnrn: string; geburtsdatum: string | null; inDatei: string; art: string; sicher: boolean; hinweis: string | null;
  id_alt: string | null; id_neu: string | null; lk_alt: number | null; lk_neu: number | null; aenderung: boolean;
}
interface Rest { name: string; geburtsdatum: string | null; id_nr: string | null; lk: number | null }
interface Abgleich {
  treffer: Treffer[]; ohneTreffer: (Rest & { adrnr: string })[]; nurDatei: (Rest & { zeile: number })[]; personen: number;
  anzahl: { aenderungen: number; unveraendert: number; pruefen: number; ohneTreffer: number; nurDatei: number };
}
const schluessel = (t: { adrnr: string; zeile: number }) => `${t.adrnr}|${t.zeile}`;
/** nach Anfangsbuchstaben gruppieren (Ä → A, Sonstiges unter #), aufsteigend */
function buchstaben<T extends { name: string }>(liste: T[]): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const x of [...liste].sort((a, b) => a.name.localeCompare(b.name, 'de'))) {
    const c = x.name.trim().charAt(0).normalize('NFD').charAt(0).toUpperCase();
    const k = /[A-Z]/.test(c) ? c : '#';
    m.set(k, [...(m.get(k) ?? []), x]);
  }
  return [...m.entries()].sort(([a], [b]) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)));
}

function Tabelle({ kopf, children, leer }: { kopf: ReactNode[]; children: ReactNode; leer?: string }) {
  return (
    <div className="portal-sd__rahmen">
      <table className="portal-sd__tabelle">
        <thead><tr>{kopf.map((k, i) => <th key={i}>{k}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
      {leer && <Text className="portal-muted" style={{ display: 'block', padding: '0.75rem 1rem' }}>{leer}</Text>}
    </div>
  );
}
const Wechsel = ({ alt, neu }: { alt: string; neu: string }) => (alt === neu ? <span>{neu}</span>
  : <span><span className="portal-muted" style={{ textDecoration: alt === '–' ? 'none' : 'line-through' }}>{alt}</span> → <b>{neu}</b></span>);

type Reiter = 'alle' | 'mit' | 'ohne' | 'irrelevant' | 'abgleich';

export function Spielerdaten() {
  const edit = useCan()('tco.sport:edit');
  const [stand, setStand] = useState<Stand | null>(null);
  const [a, setA] = useState<Abgleich | null>(null);
  const [datei, setDatei] = useState<{ name: string; inhalt: string } | null>(null);
  const [wahl, setWahl] = useState<Set<string>>(new Set());
  /** von Hand zugeordnet: Mitglied ohne Treffer (adrnr) → Zeile der nuLiga-Datei */
  const [hand, setHand] = useState<Map<string, number>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ueber, setUeber] = useState(false);
  const [suche, setSuche] = useState('');
  const [tab, setTabRoh] = useState<Reiter>('alle');
  const [marke, setMarke] = useState<Set<string>>(new Set());
  const setTab = (t: Reiter) => { setTabRoh(t); setMarke(new Set()); };
  const [lkWahl, setLkWahl] = useState('');
  const eingabe = useRef<HTMLInputElement>(null);

  const laden = () => api.get<Stand>(S).then(setStand).catch((e) => setError(e.message));
  useEffect(() => { laden(); }, []);

  async function ablegen(f: File | undefined) {
    if (!f || !edit) return;
    setError(null);
    setTab('abgleich');
    if (!/\.(csv|txt)$/i.test(f.name)) { setError('Bitte die CSV-Datei aus nuLiga ablegen (Mitglieder → „Download Mitgliederdaten (Excel, csv)“). Eine Excel-Datei bitte als CSV speichern.'); return; }
    if (f.size > 5_000_000) { setError('Die Datei ist zu groß.'); return; }
    setBusy(true);
    try {
      const inhalt = (await dateiLesen(f)).replace(/^data:[^,]*,/, '');
      const r = await api.post<Abgleich>(`${S}/abgleich`, { datei: inhalt });
      setDatei({ name: f.name, inhalt });
      setA(r);
      setHand(new Map());
      // vorausgewählt: sichere Treffer mit Änderung; unsichere müssen bewusst angehakt werden
      setWahl(new Set(r.treffer.filter((t) => t.sicher && t.aenderung).map(schluessel)));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  // Ablagefeld des Portals und Strg+V: Datei landet ebenfalls hier
  useAblageZiel(edit ? { titel: 'Spielerdaten (nuLiga)', annehmen: (files) => { ablegen(files[0]); } } : null);

  async function uebernehmen() {
    if (!a || !datei) return;
    setBusy(true); setError(null);
    try {
      const auswahl = [
        ...a.treffer.filter((t) => wahl.has(schluessel(t))).map((t) => ({ adrnr: t.adrnr, zeile: t.zeile })),
        ...[...hand].map(([adrnr, zeile]) => ({ adrnr, zeile, manuell: true })),
      ];
      const r = await api.post<{ text: string }>(`${S}/uebernehmen`, { datei: datei.inhalt, name: datei.name, auswahl });
      toast(r.text, 8000);
      // weiter prüfen: mit derselben Datei neu abgleichen – erledigte Fälle verschwinden, offene bleiben stehen
      const neu = await api.post<Abgleich>(`${S}/abgleich`, { datei: datei.inhalt });
      setA(neu);
      setWahl(new Set(neu.treffer.filter((t) => t.sicher && t.aenderung).map(schluessel)));
      setHand(new Map());
      await laden();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const drop = (ev: DragEvent) => { ev.preventDefault(); ev.stopPropagation(); setUeber(false); ablegen(ev.dataTransfer.files[0]); };
  const umschalten = (t: Treffer, an: boolean) => { const n = new Set(wahl); if (an) n.add(schluessel(t)); else n.delete(schluessel(t)); setWahl(n); };

  const mitAenderung = a?.treffer.filter((t) => t.sicher && t.aenderung) ?? [];
  const pruefen = a?.treffer.filter((t) => !t.sicher) ?? [];
  // Suche: jedes Wort muss vorkommen – in Name, Vorname, ID-Nr. oder Mitgliedsnummer („nils alt“ findet „Alt, Nils“)
  const worte = suche.toLowerCase().split(/[\s,;]+/).filter(Boolean);
  const gefunden = (stand?.zeilen ?? []).filter((z) => {
    const t = `${z.nachname} ${z.vorname} ${z.id_nr ?? ''} ${z.mitglnrn}`.toLowerCase();
    return worte.every((w) => t.includes(w));
  });
  // gekennzeichnete („Für Meldung irrelevant“) werden nicht mehr selektiert – nur noch im eigenen Reiter
  const aktiv = gefunden.filter((z) => z.irrelevant !== true);
  const gruppe: Record<Exclude<Reiter, 'abgleich'>, Zeile[]> = {
    alle: aktiv, mit: aktiv.filter((z) => z.id_nr), ohne: aktiv.filter((z) => !z.id_nr), irrelevant: gefunden.filter((z) => z.irrelevant === true),
  };
  const jahr = new Date().getFullYear();

  async function kennzeichnen(irrelevant: boolean) {
    if (!marke.size) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string }>(`${S}/irrelevant`, { adrnrs: [...marke], irrelevant });
      toast(r.text, 6000);
      setMarke(new Set());
      await laden();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const liste = (art: Exclude<Reiter, 'abgleich'>) => {
    const zeilen = gruppe[art].filter((z) => art === 'irrelevant' || !lkWahl || (lkWahl === 'mit') === (z.lk != null));
    const zeigeId = art !== 'ohne' && art !== 'irrelevant';
    // auswählbar: Mitglieder ohne ID-Nr. (mit ID-Nr. sind gemeldet – Kennzeichen automatisch „nein“)
    const waehlbar = edit ? zeilen.filter((z) => !z.id_nr) : [];
    const alleAn = waehlbar.length > 0 && waehlbar.every((z) => marke.has(z.adrnr));
    const leer = zeilen.length ? undefined
      : worte.length || lkWahl ? 'Keine Mitglieder zu dieser Suche.'
        : art === 'mit' ? 'Noch keine Spielerdaten – bitte die Datei aus nuLiga im Reiter „Abgleich mit nuLiga“ ablegen.'
          : art === 'ohne' ? 'Alle aktiven Mitglieder haben eine ID-Nr. oder sind als „Für Meldung irrelevant“ gekennzeichnet.'
            : art === 'irrelevant' ? 'Kein Mitglied ist als „Für Meldung irrelevant“ gekennzeichnet.' : 'Keine aktiven Mitglieder.';
    const kopf: ReactNode[] = [
      ...(edit ? [<CheckBox key="a" checked={alleAn} disabled={busy || !waehlbar.length} accessibleName="alle ohne ID-Nr. auswählen"
                            onChange={(e) => setMarke(e.target.checked ? new Set(waehlbar.map((z) => z.adrnr)) : new Set())} />] : []),
      'Name', 'Vorname', 'Geburtsdatum', 'Eintritt', 'Mitgl.-Nr.', ...(zeigeId ? ['ID-Nr.'] : []), 'LK', ...(zeigeId ? ['Stand', 'Vorjahre'] : []), 'Für Meldung irrelevant',
    ];
    return (
      <div style={{ paddingTop: '0.5rem' }}>
        <div className="portal-sd__filter">
          {art !== 'irrelevant' && (
            <Select style={{ width: '11rem' }} accessibleName="Auswahl nach LK" onChange={(e) => setLkWahl((e.detail.selectedOption as HTMLElement).dataset.k ?? '')}>
              {[['', 'mit und ohne LK'], ['mit', 'mit LK'], ['ohne', 'ohne LK']].map(([k, t]) => <Option key={k} data-k={k} selected={k === lkWahl}>{t}</Option>)}
            </Select>
          )}
          <Input placeholder="Suchen (Name, Vorname, ID-Nr.)" value={suche} showClearIcon style={{ width: '18rem' }} onInput={(e) => setSuche(e.target.value)} />
          <Button design="Transparent" icon="refresh" tooltip="Aktualisieren" onClick={laden} />
          {edit && art !== 'mit' && (art === 'irrelevant'
            ? <Button icon="undo" disabled={busy || !marke.size} onClick={() => kennzeichnen(false)}>Kennzeichen entfernen{marke.size ? ` (${marke.size})` : ''}</Button>
            : <Button icon="decline" disabled={busy || !marke.size} onClick={() => kennzeichnen(true)}>Für Meldung irrelevant{marke.size ? ` (${marke.size})` : ''}</Button>)}
          {stand && (
            <Text className="portal-muted portal-small">
              {stand.anzahl.mitglieder} aktive Mitglieder: {stand.anzahl.mitId} mit ID-Nr. ({stand.anzahl.mitLk} mit LK), {stand.anzahl.ohneId} ohne, {stand.anzahl.irrelevant} für Meldung irrelevant
              {stand.letzterAbgleich ? ` · letzter Abgleich ${dat(stand.letzterAbgleich)}` : ''} · sortiert nach Eintritt, jüngster zuerst
            </Text>
          )}
        </div>
        <Tabelle kopf={kopf} leer={leer}>
          {zeilen.map((z) => (
            <tr key={z.adrnr}>
              {edit && (
                <td style={{ width: '2.5rem' }}>
                  {!z.id_nr && (
                    <CheckBox checked={marke.has(z.adrnr)} disabled={busy} accessibleName={`${z.name} auswählen`}
                              onChange={(e) => { const n = new Set(marke); if (e.target.checked) n.add(z.adrnr); else n.delete(z.adrnr); setMarke(n); }} />
                  )}
                </td>
              )}
              <td><b>{z.nachname}</b></td><td>{z.vorname}</td><td>{dat(z.geburtsdatum)}</td><td>{dat(z.eintritt)}</td><td className="portal-muted">{z.mitglnrn || '–'}</td>
              {zeigeId && <td>{z.id_nr ?? '–'}</td>}
              <td>{z.id_nr ? <b>{lk(z.lk)}</b> : lk(z.lk)}</td>
              {zeigeId && <td>{dat(z.lk_stand)}</td>}
              {zeigeId && <td className="portal-muted">{z.verlauf.filter((v) => v.jahr < jahr).map((v) => `${v.jahr}: ${lk(v.lk)}`).join(' · ')}</td>}
              <td>{z.irrelevant === true ? 'Ja' : z.irrelevant === false ? 'Nein' : ''}</td>
            </tr>
          ))}
        </Tabelle>
        {edit && art !== 'mit' && art !== 'irrelevant' && zeilen.some((z) => !z.id_nr) && (
          <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>
            Mitglieder ohne ID-Nr. anhaken und als „Für Meldung irrelevant“ kennzeichnen – sie erscheinen danach nur noch im Reiter „Für Meldung irrelevant“.
            Mit ID-Nr. steht das Kennzeichen automatisch auf „Nein“.
          </Text>
        )}
      </div>
    );
  };

  const trefferZeile = (t: Treffer) => (
    <tr key={schluessel(t)}>
      <td><CheckBox checked={wahl.has(schluessel(t))} disabled={busy} accessibleName={`${t.name} übernehmen`} onChange={(e) => umschalten(t, e.target.checked)} /></td>
      <td><b>{t.name}</b><div className="portal-muted portal-small">{t.geburtsdatum ? dat(t.geburtsdatum) : 'ohne Geburtsdatum'}{t.mitglnrn ? ` · Nr. ${t.mitglnrn}` : ''}</div></td>
      <td>{t.inDatei}{t.hinweis && <div className="portal-small" style={{ color: 'var(--sapCriticalTextColor)' }}>{t.hinweis}</div>}</td>
      <td><Wechsel alt={t.id_alt ?? '–'} neu={t.id_neu ?? '–'} /></td>
      <td><Wechsel alt={lk(t.lk_alt)} neu={lk(t.lk_neu)} /></td>
    </tr>
  );

  return (
    <AppPage varianten={{ repid: 'tco.spielerdaten', ansicht: { suche, tab }, onAnwenden: (a) => { setSuche(feld(a, 'suche', suche)); setTab(feld(a, 'tab', tab)); } }} title="Spielerdaten (nuLiga)" subtitle="ID-Nr. und Leistungsklasse (LK) der Mitglieder mit der Verbandsliste abgleichen">
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}

      {!stand ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : (
        <TabContainer tabLayout="Inline" contentBackgroundDesign="Transparent" onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key as Reiter)}>
          <Tab data-key="alle" text="Alle" icon="group" additionalText={String(gruppe.alle.length)} selected={tab === 'alle'}>
            {tab === 'alle' && liste('alle')}
          </Tab>
          <Tab data-key="mit" text="Mit ID-Nr." icon="employee-approvals" additionalText={String(gruppe.mit.length)} selected={tab === 'mit'}>
            {tab === 'mit' && liste('mit')}
          </Tab>
          <Tab data-key="ohne" text="Ohne ID-Nr." icon="employee-rejections" additionalText={String(gruppe.ohne.length)} selected={tab === 'ohne'}>
            {tab === 'ohne' && liste('ohne')}
          </Tab>
          <Tab data-key="irrelevant" text="Für Meldung irrelevant" icon="decline" additionalText={String(gruppe.irrelevant.length)} selected={tab === 'irrelevant'}>
            {tab === 'irrelevant' && liste('irrelevant')}
          </Tab>
          {edit ? (
            <Tab data-key="abgleich" text="Abgleich mit nuLiga" icon="upload" selected={tab === 'abgleich'}>
              {tab === 'abgleich' && (
                <div style={{ paddingTop: '0.5rem' }}>
        <Section title="Abgleich mit nuLiga">
          <Text className="portal-muted" style={{ display: 'block', marginBottom: '0.5rem' }}>
            1. In nuLiga (stb.liga.nu) unter <b>Mitglieder</b> auf <b>Download Mitgliederdaten (Excel, csv)</b> klicken und die Datei speichern.
            {' '}2. Die Datei hier ablegen. 3. Vorschau prüfen und übernehmen. Die LK ändert sich jedes Jahr – den Abgleich einfach wiederholen.
          </Text>
          <div className={`portal-ablagebox${ueber ? ' portal-ablagebox--ueber' : ''}`} role="button" tabIndex={0}
               onClick={() => eingabe.current?.click()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') eingabe.current?.click(); }}
               onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setUeber(true); }} onDragLeave={() => setUeber(false)} onDrop={drop}>
            <Icon name="upload" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <b style={{ color: 'var(--sapTextColor)' }}>{datei ? datei.name : 'Mitgliederdaten aus nuLiga hier ablegen'}</b>
              <div>{datei ? 'Andere Datei ablegen oder anklicken, um neu abzugleichen.' : 'CSV-Datei hierher ziehen oder anklicken, um sie auszuwählen. Es wird noch nichts gespeichert.'}</div>
            </div>
            {busy && <BusyIndicator active size="S" />}
          </div>
          <input ref={eingabe} type="file" hidden accept=".csv,.txt,text/csv" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; ablegen(f); }} />
        </Section>

      {a && (
        <Section title="Vorschau" actions={<>
          <Button design="Emphasized" icon="accept" disabled={busy || !(wahl.size + hand.size)} onClick={uebernehmen}>{wahl.size + hand.size} übernehmen</Button>
          <Button design="Transparent" disabled={busy} onClick={() => { setA(null); setDatei(null); setHand(new Map()); }}>Schließen</Button>
        </>}>
          <div className="portal-sd__zahlen">
            <ObjectStatus state="Information" inverted>{a.personen} Personen in der Datei</ObjectStatus>
            <ObjectStatus state="Positive" inverted>{a.anzahl.aenderungen} Treffer mit Änderung</ObjectStatus>
            <ObjectStatus state="None" inverted>{a.anzahl.unveraendert} unverändert</ObjectStatus>
            {a.anzahl.pruefen > 0 && <ObjectStatus state="Critical" inverted>{a.anzahl.pruefen} bitte prüfen</ObjectStatus>}
            <ObjectStatus state="None" inverted>{a.anzahl.ohneTreffer} Mitglieder ohne Treffer</ObjectStatus>
            <ObjectStatus state="None" inverted>{a.anzahl.nurDatei} nur in nuLiga</ObjectStatus>
          </div>

          {pruefen.length > 0 && (
            <>
              <h4 className="portal-sd__titel">Bitte prüfen ({pruefen.length}) – wird nur übernommen, wenn angehakt</h4>
              <Tabelle kopf={['', 'Mitglied im Portal', 'Person in nuLiga', 'ID-Nr.', 'LK']}>{pruefen.map(trefferZeile)}</Tabelle>
            </>
          )}
          <h4 className="portal-sd__titel">Treffer mit Änderung ({mitAenderung.length})
            {mitAenderung.length > 0 && (
              <Button design="Transparent" style={{ marginLeft: '0.5rem' }} onClick={() => {
                const allean = mitAenderung.every((t) => wahl.has(schluessel(t)));
                const n = new Set(wahl); mitAenderung.forEach((t) => (allean ? n.delete(schluessel(t)) : n.add(schluessel(t)))); setWahl(n);
              }}>alle / keine</Button>
            )}
          </h4>
          <Tabelle kopf={['', 'Mitglied im Portal', 'Person in nuLiga', 'ID-Nr.', 'LK']} leer={mitAenderung.length ? undefined : 'Keine Änderungen – ID-Nr. und LK sind bereits aktuell.'}>
            {mitAenderung.map(trefferZeile)}
          </Tabelle>

          <details className="portal-sd__mehr" open={a.ohneTreffer.length > 0}>
            <summary>Mitglieder ohne Treffer in nuLiga ({a.ohneTreffer.length}){hand.size > 0 ? ` – ${hand.size} von Hand zugeordnet` : ''}</summary>
            <Tabelle kopf={['Mitglied', 'Geburtsdatum', 'ID-Nr. (gespeichert)', 'LK (gespeichert)', 'Von Hand zuordnen (nuLiga)']}>
              {a.ohneTreffer.map((m) => (
                <tr key={m.adrnr}>
                  <td>{m.name}</td><td>{dat(m.geburtsdatum)}</td><td>{m.id_nr ?? '–'}</td><td>{lk(m.lk)}</td>
                  <td>
                    <select className="portal-sd__zuordnen" disabled={busy} value={hand.get(m.adrnr) ?? ''} aria-label={`${m.name} einer Person aus nuLiga zuordnen`}
                            onChange={(e) => { const n = new Map(hand); if (e.target.value) n.set(m.adrnr, Number(e.target.value)); else n.delete(m.adrnr); setHand(n); }}>
                      <option value="">– nicht zuordnen –</option>
                      {a.nurDatei.filter((p) => hand.get(m.adrnr) === p.zeile || ![...hand.values()].includes(p.zeile)).map((p) => (
                        <option key={p.zeile} value={p.zeile}>{p.name}{p.geburtsdatum ? ` · ${dat(p.geburtsdatum)}` : ''} · {p.id_nr ? `ID ${p.id_nr}` : 'ohne ID-Nr.'}{p.lk != null ? ` · ${lk(p.lk)}` : ''}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </Tabelle>
            {a.ohneTreffer.length > 0 && (
              <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.4rem' }}>
                Zur Auswahl stehen alle Personen der Datei, die noch keinem Mitglied zugeordnet sind. Die Zuordnung wird mit „übernehmen“ gespeichert; danach wird neu abgeglichen.
              </Text>
            )}
          </details>
          <details className="portal-sd__mehr">
            <summary>Nur in nuLiga, kein aktives Mitglied im Portal ({a.nurDatei.length})</summary>
            {/* lange Liste: Baum nach Anfangsbuchstaben, aufsteigend */}
            {buchstaben(a.nurDatei).map(([b, liste]) => (
              <details key={b} className="portal-sd__buchstabe">
                <summary><b>{b}</b> <span className="portal-muted">({liste.length})</span></summary>
                <Tabelle kopf={['Person', 'Geburtsdatum', 'ID-Nr.', 'LK']}>
                  {liste.map((p) => <tr key={p.zeile}><td>{p.name}</td><td>{dat(p.geburtsdatum)}</td><td>{p.id_nr ?? '–'}</td><td>{lk(p.lk)}</td></tr>)}
                </Tabelle>
              </details>
            ))}
          </details>
        </Section>
      )}
                </div>
              )}
            </Tab>
          ) : null}
        </TabContainer>
      )}
    </AppPage>
  );
}
