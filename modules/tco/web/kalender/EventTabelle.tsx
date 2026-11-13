import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Varianten, feld } from '@core/components/Varianten';
import { createPortal } from 'react-dom';
import {
  AnalyticalTable, Bar, BusyIndicator, Button, CheckBox, Dialog, Icon, Input, Label, Link, MessageStrip, ObjectStatus, Option, Select, Text,
  type AnalyticalTableColumnDefinition, type AnalyticalTableCellInstance as Cell,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { toast } from '@core/toast';
import { TCO } from '../util';
import '../halle.css';
import './kalender.css';

/**
 * Vereinskalender (#16): flache Tabelle aller Veranstaltungen – Filter und Sortierung je Spalte, Mehrfachauswahl,
 * Massenbearbeitung, Massenlöschung und Regelwerk für die Standardzuordnung zu einer Gruppe („Text abc in Spalte Titel => Gruppe“).
 */
const K = `${TCO}/kalender`;
interface Ev {
  id: number; titel: string; beschreibung: string | null; ort: string | null; kategorie: string; beginn: string; ende: string | null; ganztags: boolean;
  anmeldung: boolean; gruppen: number[]; gruppen_namen: string[]; abgesagt: boolean; zusagen: number; begleitpersonen: number; absagen: number;
}
interface Zeile extends Ev { beginn_text: string; art: string; gruppe: string; anmeldung_text: string; begegnung: string; zusagen_gesamt: number; status_text: string }
type GruppeKurz = { id: number; name: string; aktiv: boolean };
type SortZeile = { original: Zeile };
interface Regel { feld: string; text: string; gruppe_id: number; aktiv: boolean }
interface RegelZeile { id: number; titel: string; beginn: string; bisher: string; neu: string }

const beginnText = (e: Ev) => new Date(e.beginn).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', ...(e.ganztags ? {} : { hour: '2-digit', minute: '2-digit' } as const) });
const klein = () => window.matchMedia?.('(max-width: 700px)').matches ?? false;

export function EventTabelle({ aktiv, version, kategorien, gruppen, onOeffnen, onGeaendert, onError }: {
  aktiv: boolean; /** ändert sich, wenn im Kalender etwas gespeichert wurde */ version: number; kategorien: Record<string, string>; gruppen: GruppeKurz[];
  onOeffnen: (id: number) => void; onGeaendert: () => void; onError: (m: string) => void;
}) {
  const [events, setEvents] = useState<Ev[] | null>(null);
  const [auswahl, setAuswahl] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [vergangene, setVergangene] = useState(false);
  const [suche, setSuche] = useState('');
  const [regeln, setRegeln] = useState(false);
  const [ueberschreiben, setUeberschreiben] = useState(false);
  const [zuordnung, setZuordnung] = useState<{ text: string; zeilen: RegelZeile[] } | null>(null);
  const [loeschen, setLoeschen] = useState(false);
  const leer = { titel: '', ort: '', kategorie: '', gruppe: '', anmeldung: '' };
  const [m, setM] = useState(leer);

  // Nur die Tabelle scrollt: Der Rahmen bekommt genau die Resthöhe des Fensters, die Tabelle (visibleRowCountMode="Auto") füllt ihn aus.
  // Eine Höhe direkt an der Tabelle macht deren Hülle zum zweiten Scrollbereich, in dem auch die Kopfzeile wegläuft.
  const kopf = useRef<HTMLDivElement>(null);
  const rahmen = useRef<HTMLDivElement>(null);
  const [hoehe, setHoehe] = useState(480);
  const geladen = events !== null;
  useLayoutEffect(() => {
    if (!geladen || !aktiv) return;
    const UNTEN = 40; // Innenabstände von Reiter und Seite unterhalb der Tabelle
    const messen = () => {
      if (!rahmen.current) return;
      setHoehe(Math.max(320, Math.floor(window.innerHeight - rahmen.current.getBoundingClientRect().top - UNTEN)));
    };
    messen();
    window.addEventListener('resize', messen);
    const ro = new ResizeObserver(messen); // Leisten brechen je nach Breite um
    if (kopf.current) ro.observe(kopf.current);
    return () => { window.removeEventListener('resize', messen); ro.disconnect(); };
  }, [geladen, aktiv]);

  const laden = () => api.get<{ events: Ev[] }>(`${K}?von=2000-01-01&bis=2099-12-31`).then((r) => setEvents(r.events)).catch((e) => onError(e.message));
  useEffect(() => { if (aktiv) laden(); }, [aktiv, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const heute = useMemo(() => { const h = new Date(); h.setHours(0, 0, 0, 0); return h.getTime(); }, []);
  const alleZeilen: Zeile[] = useMemo(() => (events ?? [])
    .filter((e) => vergangene || new Date(e.ende ?? e.beginn).getTime() >= heute)
    .map((e) => ({
      ...e, beginn_text: beginnText(e), art: kategorien[e.kategorie] ?? e.kategorie, gruppe: e.gruppen_namen.join(', ') || 'alle Mitglieder',
      anmeldung_text: e.anmeldung ? 'ja' : 'nein', begegnung: (e.beschreibung ?? '').split('\n')[0], zusagen_gesamt: e.zusagen + e.begleitpersonen, status_text: e.abgesagt ? 'abgesagt' : '',
    })), [events, vergangene, kategorien, heute]);
  // Textsuche über alle Textspalten: jedes Wort muss vorkommen, Groß-/Kleinschreibung egal
  const zeilen: Zeile[] = useMemo(() => {
    const worte = suche.toLowerCase().split(/\s+/).filter(Boolean);
    if (!worte.length) return alleZeilen;
    return alleZeilen.filter((z) => {
      const text = [z.beginn_text, z.titel, z.art, z.ort ?? '', z.gruppe, z.begegnung, z.status_text].join(' ').toLowerCase();
      return worte.every((w) => text.includes(w));
    });
  }, [alleZeilen, suche]);
  // Auswahl nur für angezeigte Zeilen
  const sichtbar = useMemo(() => new Set(zeilen.map((z) => z.id)), [zeilen]);
  const gewaehlt = auswahl.filter((id) => sichtbar.has(id));
  const selectedRowIds = useMemo(() => Object.fromEntries(gewaehlt.map((id) => [String(id), true])), [gewaehlt.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  async function lauf(fn: () => Promise<{ text?: string } | void>) {
    setBusy(true);
    try {
      const r = await fn();
      if (r && r.text) toast(r.text, 5000);
      await laden();
      onGeaendert();
    } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  }
  const mGesetzt = !!(m.titel.trim() || m.ort.trim() || m.kategorie || m.gruppe || m.anmeldung);
  const massenAendern = () => lauf(async () => {
    const r = await api.post<{ text: string }>(`${K}/masse/aendern`, {
      ids: gewaehlt,
      ...(m.titel.trim() ? { titel: m.titel.trim() } : {}), ...(m.ort.trim() ? { ort: m.ort.trim() } : {}), ...(m.kategorie ? { kategorie: m.kategorie } : {}),
      ...(m.gruppe ? { gruppen: m.gruppe === '-' ? [] : [Number(m.gruppe)] } : {}), ...(m.anmeldung ? { anmeldung: m.anmeldung === 'an' } : {}),
    });
    setM(leer);
    return r;
  });
  const massenLoeschen = () => lauf(async () => {
    setLoeschen(false);
    const r = await api.post<{ text: string }>(`${K}/masse/loeschen`, { ids: gewaehlt });
    setAuswahl([]);
    return r;
  });
  const regelnAnwenden = () => lauf(async () => {
    const r = await api.post<{ text: string; zeilen: RegelZeile[] }>(`${K}/regeln/anwenden`, { ...(gewaehlt.length ? { ids: gewaehlt } : {}), ueberschreiben });
    setZuordnung(r);
  });

  const columns = useMemo((): AnalyticalTableColumnDefinition[] => [
    {
      Header: 'Beginn', accessor: 'beginn_text', width: 190,
      sortType: (a: SortZeile, b: SortZeile) => a.original.beginn.localeCompare(b.original.beginn),
    },
    {
      Header: 'Titel', accessor: 'titel', minWidth: 240,
      Cell: ({ row }: Cell) => <Link onClick={() => onOeffnen(row.original.id)} style={row.original.abgesagt ? { textDecoration: 'line-through' } : undefined}>{row.original.titel}</Link>,
    },
    { Header: 'Art', accessor: 'art', width: 170, Cell: ({ row }: Cell) => <span className={`portal-kal__legende-art portal-kal__chip--art-${row.original.kategorie}`}>{row.original.art}</span> },
    { Header: 'Ort', accessor: 'ort', minWidth: 180 },
    { Header: 'Gruppe', accessor: 'gruppe', minWidth: 180, Cell: ({ row }: Cell) => <Text className={row.original.gruppen.length ? undefined : 'portal-muted'}>{row.original.gruppe}</Text> },
    { Header: 'Begegnung / Beschreibung', accessor: 'begegnung', minWidth: 240 },
    { Header: 'Anmeldung', accessor: 'anmeldung_text', width: 110 },
    { Header: 'Zusagen', accessor: 'zusagen_gesamt', width: 100, hAlign: 'End' },
    { Header: 'Absagen', accessor: 'absagen', width: 100, hAlign: 'End' },
    {
      Header: 'Status', accessor: 'status_text', width: 110,
      Cell: ({ row }: Cell) => (row.original.abgesagt ? <ObjectStatus state="Negative">abgesagt</ObjectStatus> : <span />),
    },
  ], [onOeffnen]);
  const tabellenOptionen = useMemo(() => ({ getRowId: (r: Zeile) => String(r.id), autoResetSelectedRows: false, autoResetSortBy: false, autoResetFilters: false }), []);

  if (!events) return <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />;
  return (
    <>
      <div ref={kopf}>
      <div className="portal-kal__leiste" style={{ marginTop: 0 }}>
        <Text><b>{zeilen.length}</b>{zeilen.length !== alleZeilen.length ? ` von ${alleZeilen.length}` : ''} Veranstaltung(en){gewaehlt.length ? ` · ${gewaehlt.length} ausgewählt` : ''}</Text>
        <Input icon={<Icon name="search" />} placeholder="Suchen (Titel, Ort, Gruppe, Begegnung …)" accessibleName="Tabelle durchsuchen" showClearIcon
               value={suche} onInput={(e) => setSuche(e.target.value)} style={{ width: 'min(22rem, 100%)' }} />
<Varianten repid="tco.kalender.tabelle" ansicht={{ suche, vergangene }} onAnwenden={(a) => { setSuche(feld(a, 'suche', suche)); setVergangene(feld(a, 'vergangene', vergangene)); }} />
        <CheckBox text="Vergangene anzeigen" checked={vergangene} onChange={(e) => setVergangene(e.target.checked)} />
        <span style={{ flex: 1 }} />
        <Button icon="activities" tooltip="Regeln „Text in Spalte => Gruppe“ pflegen" onClick={() => setRegeln(true)}>Regelwerk</Button>
        <CheckBox text="vorhandene Gruppe überschreiben" checked={ueberschreiben} onChange={(e) => setUeberschreiben(e.target.checked)} />
        <Button icon="synchronize" disabled={busy} tooltip="Gruppe nach dem Regelwerk zuordnen – für die ausgewählten Zeilen, ohne Auswahl für alle Veranstaltungen"
                onClick={regelnAnwenden}>Regelwerk anwenden{gewaehlt.length ? ` (${gewaehlt.length})` : ' (alle)'}</Button>
      </div>
      <div className="portal-kal__masse-bearbeiten" style={{ marginBottom: '0.5rem' }}>
        <Label>Massenbearbeitung für {gewaehlt.length} ausgewählte Zeile(n) – ausgefüllte Felder werden als neue Werte gesetzt</Label>
        <div className="portal-az__leiste" style={{ position: 'static' }}>
          <Input placeholder="Neuer Titel" accessibleName="Neuer Titel" value={m.titel} maxlength={120} onInput={(e) => setM({ ...m, titel: e.target.value })} style={{ width: '14rem' }} />
          <Input placeholder="Neuer Ort" accessibleName="Neuer Ort" value={m.ort} maxlength={120} onInput={(e) => setM({ ...m, ort: e.target.value })} style={{ width: '12rem' }} />
          <Select accessibleName="Art" style={{ width: '12rem' }} onChange={(e) => setM({ ...m, kategorie: (e.detail.selectedOption as HTMLElement).dataset.k ?? '' })}>
            <Option data-k="" selected={!m.kategorie}>Art unverändert</Option>
            {Object.entries(kategorien).map(([k, t]) => <Option key={k} data-k={k} selected={m.kategorie === k}>{t}</Option>)}
          </Select>
          <Select accessibleName="Gruppe" style={{ width: '16rem' }} onChange={(e) => setM({ ...m, gruppe: (e.detail.selectedOption as HTMLElement).dataset.g ?? '' })}>
            <Option data-g="" selected={!m.gruppe}>Gruppe unverändert</Option>
            <Option data-g="-" selected={m.gruppe === '-'}>ohne Gruppe (alle Mitglieder)</Option>
            {gruppen.filter((g) => g.aktiv).map((g) => <Option key={g.id} data-g={g.id} selected={m.gruppe === String(g.id)}>{g.name}</Option>)}
          </Select>
          <Select accessibleName="Anmeldung" style={{ width: '13rem' }} onChange={(e) => setM({ ...m, anmeldung: (e.detail.selectedOption as HTMLElement).dataset.a ?? '' })}>
            <Option data-a="" selected={!m.anmeldung}>Anmeldung unverändert</Option>
            <Option data-a="an" selected={m.anmeldung === 'an'}>mit An- und Abmeldung</Option>
            <Option data-a="aus" selected={m.anmeldung === 'aus'}>ohne Anmeldung</Option>
          </Select>
          <Button icon="multi-select" design="Emphasized" disabled={busy || !gewaehlt.length || !mGesetzt} onClick={massenAendern}>Auf Auswahl anwenden</Button>
          <Button icon="delete" design="Negative" disabled={busy || !gewaehlt.length} tooltip="Ausgewählte Veranstaltungen löschen" onClick={() => setLoeschen(true)}>
            Auswahl löschen{gewaehlt.length ? ` (${gewaehlt.length})` : ''}
          </Button>
        </div>
      </div>
      </div>
      <div ref={rahmen} style={{ height: hoehe }}>
      <AnalyticalTable minRows={1} columns={columns} data={zeilen} loading={busy} filterable sortable
                       selectionMode="Multiple" selectionBehavior="RowSelector" selectedRowIds={selectedRowIds} reactTableOptions={tabellenOptionen}
                       onRowSelect={(e) => setAuswahl(Object.keys(e.detail.selectedRowIds).filter((k) => e.detail.selectedRowIds[k]).map(Number))}
                       visibleRowCountMode="Auto"
                       noDataText={suche.trim() ? 'Keine Veranstaltung passt zur Suche.' : vergangene ? 'Noch keine Veranstaltungen.' : 'Keine künftigen Veranstaltungen – „Vergangene anzeigen“ blendet die übrigen ein.'} />
      </div>
      {regeln && <EventRegelnDialog gruppen={gruppen} onClose={() => setRegeln(false)} />}
      {loeschen && createPortal(
        <Dialog open headerText="Veranstaltungen löschen" state="Negative" onClose={() => setLoeschen(false)} style={{ width: 'min(36rem, 96vw)' }}
                footer={<Bar endContent={<>
                  <Button design="Negative" icon="delete" disabled={busy || !gewaehlt.length} onClick={massenLoeschen}>{gewaehlt.length} löschen</Button>
                  <Button onClick={() => setLoeschen(false)}>Abbrechen</Button>
                </>} />}>
          <div className="portal-az">
            <Text>
              {gewaehlt.length === 1 ? 'Die ausgewählte Veranstaltung' : `Die ${gewaehlt.length} ausgewählten Veranstaltungen`} endgültig löschen?
              Veranstaltungen mit Anmeldungen (Zusage oder „vielleicht“) bleiben stehen. Das Löschen lässt sich nicht rückgängig machen.
            </Text>
            <ul style={{ margin: 0, paddingLeft: '1.25rem', maxHeight: '14rem', overflow: 'auto' }}>
              {zeilen.filter((z) => gewaehlt.includes(z.id)).map((z) => <li key={z.id}><Text>{z.beginn_text} · {z.titel}</Text></li>)}
            </ul>
          </div>
        </Dialog>,
        document.body,
      )}
      {zuordnung && createPortal(
        <Dialog open headerText="Regelwerk angewendet" onClose={() => setZuordnung(null)} style={{ width: 'min(60rem, 96vw)' }}
                footer={<Bar endContent={<Button design="Emphasized" onClick={() => setZuordnung(null)}>Schließen</Button>} />}>
          <div className="portal-az">
            <MessageStrip design={zuordnung.zeilen.length ? 'Positive' : 'Information'} hideCloseButton>
              {zuordnung.text}{!zuordnung.zeilen.length && !ueberschreiben ? ' Veranstaltungen mit Gruppe bleiben unverändert, solange „vorhandene Gruppe überschreiben“ nicht gesetzt ist.' : ''}
            </MessageStrip>
            {zuordnung.zeilen.length > 0 && (
              <div className="portal-sv__tabelle-rahmen">
                <table className="portal-sv__tabelle">
                  <thead><tr><th><Label>Beginn</Label></th><th><Label>Veranstaltung</Label></th><th><Label>Gruppe bisher</Label></th><th><Label>Gruppe neu</Label></th></tr></thead>
                  <tbody>
                    {zuordnung.zeilen.map((z) => (
                      <tr key={z.id}>
                        <td style={{ whiteSpace: 'nowrap' }}><Text>{new Date(z.beginn).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</Text></td>
                        <td><Text>{z.titel}</Text></td><td><Text>{z.bisher || '–'}</Text></td><td><Text>{z.neu}</Text></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Dialog>,
        document.body,
      )}
    </>
  );
}

// ---------------------------------------------------------------- Regelwerk „Text in Spalte => Gruppe“
interface RegelForm extends Regel { key: number }
let lfd = 0;

function EventRegelnDialog({ gruppen, onClose }: { gruppen: GruppeKurz[]; onClose: () => void }) {
  const [zeilen, setZeilen] = useState<RegelForm[] | null>(null);
  const [felder, setFelder] = useState<Record<string, string>>({});
  const [gesichert, setGesichert] = useState('[]');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const kern = (l: RegelForm[]) => JSON.stringify(l.map(({ feld, text, gruppe_id, aktiv }) => ({ feld, text: text.trim(), gruppe_id, aktiv })));
  const uebernehmen = (r: Regel[]) => { const l = r.map((x) => ({ ...x, key: ++lfd })); setZeilen(l); setGesichert(kern(l)); };
  useEffect(() => {
    api.get<{ regeln: Regel[]; felder: Record<string, string> }>(`${K}/regeln`).then((r) => { setFelder(r.felder); uebernehmen(r.regeln); })
      .catch((e) => { setError(e.message); setZeilen([]); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const liste = zeilen ?? [];
  const geaendert = kern(liste) !== gesichert;
  const fehler = liste.some((z) => !z.text.trim() || !z.gruppe_id);
  const setze = (key: number, x: Partial<RegelForm>) => setZeilen((l) => (l ?? []).map((z) => (z.key === key ? { ...z, ...x } : z)));
  async function sichern() {
    setBusy(true); setError(null);
    try {
      const r = await api.put<{ regeln: Regel[]; text: string }>(`${K}/regeln`, { regeln: liste.map(({ feld, text, gruppe_id, aktiv }) => ({ feld, text: text.trim(), gruppe_id, aktiv })) });
      uebernehmen(r.regeln);
      toast(r.text, 4000);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return createPortal(
    <Dialog open stretch={klein()} headerText="Regelwerk: Gruppe aus Text ableiten" onClose={() => !busy && onClose()}
            style={klein() ? undefined : { width: 'min(64rem, 96vw)' }}
            footer={<Bar startContent={geaendert ? <ObjectStatus state="Critical">Änderungen noch nicht gesichert</ObjectStatus> : undefined}
                         endContent={<>
                           <Button design="Emphasized" disabled={busy || !geaendert || fehler} onClick={sichern}>Regeln sichern</Button>
                           <Button disabled={busy} onClick={onClose}>Schließen</Button>
                         </>} />}>
      <div className="portal-az">
        {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
        <MessageStrip design="Information" hideCloseButton>
          Enthält die gewählte Spalte den Text, wird die Veranstaltung der Gruppe zugeordnet, z. B. „Herren 40“ im Titel → Gruppe „Herren 40“.
          Die erste passende Regel gilt. Groß- und Kleinschreibung spielt keine Rolle.
        </MessageStrip>
        {!zeilen && <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />}
        {zeilen && (
          <div className="portal-sv__tabelle-rahmen">
            <table className="portal-sv__tabelle">
              <thead><tr><th><Label>Spalte</Label></th><th><Label>enthält den Text</Label></th><th><Label>Gruppe</Label></th><th><Label>Aktiv</Label></th><th /></tr></thead>
              <tbody>
                {liste.map((z) => (
                  <tr key={z.key}>
                    <td>
                      <Select accessibleName="Spalte" style={{ width: '15rem' }} onChange={(e) => setze(z.key, { feld: (e.detail.selectedOption as HTMLElement).dataset.f ?? 'titel' })}>
                        {Object.entries(felder).map(([f, t]) => <Option key={f} data-f={f} selected={z.feld === f}>{t}</Option>)}
                      </Select>
                    </td>
                    <td><Input value={z.text} maxlength={120} accessibleName="Text" valueState={z.text.trim() ? 'None' : 'Negative'} style={{ width: '100%', minWidth: '12rem' }} onInput={(e) => setze(z.key, { text: e.target.value })} /></td>
                    <td>
                      <Select accessibleName="Gruppe" valueState={z.gruppe_id ? 'None' : 'Negative'} style={{ width: 'min(22rem, 100%)', minWidth: '14rem' }}
                              onChange={(e) => setze(z.key, { gruppe_id: Number((e.detail.selectedOption as HTMLElement).dataset.g) || 0 })}>
                        <Option data-g="0" selected={!z.gruppe_id}>Gruppe wählen …</Option>
                        {gruppen.map((g) => <Option key={g.id} data-g={g.id} selected={g.id === z.gruppe_id}>{g.name}</Option>)}
                      </Select>
                    </td>
                    <td><CheckBox checked={z.aktiv} accessibleName="Aktiv" onChange={(e) => setze(z.key, { aktiv: e.target.checked })} /></td>
                    <td><Button icon="delete" design="Transparent" tooltip="Regel löschen" onClick={() => setZeilen(liste.filter((x) => x.key !== z.key))} /></td>
                  </tr>
                ))}
                {!liste.length && <tr><td colSpan={5}><Text className="portal-muted">Noch keine Regel – z. B. Spalte „Titel“, Text „Herren 40“, Gruppe „Herren 40“.</Text></td></tr>}
              </tbody>
            </table>
          </div>
        )}
        <div><Button icon="add" design="Transparent" disabled={!zeilen} onClick={() => setZeilen([...liste, { key: ++lfd, feld: 'titel', text: '', gruppe_id: 0, aktiv: true }])}>Regel hinzufügen</Button></div>
        <Text className="portal-muted portal-small">
          Das Regelwerk wirkt in der Tabelle über „Regelwerk anwenden“ und beim Einfügen eines Spielplans über „Mehrere anlegen“ (Vorschlag der Gruppe).
          Ohne passende Regel schlägt „Mehrere anlegen“ weiter die Gruppe vor, deren Name in der Liga vorkommt.
        </Text>
      </div>
    </Dialog>,
    document.body,
  );
}
