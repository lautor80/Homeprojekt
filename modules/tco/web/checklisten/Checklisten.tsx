import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  AnalyticalTable, Bar, BusyIndicator, Button, CheckBox, DatePicker, Dialog, FlexBox, Icon, Input, Link, MessageStrip, ObjectStatus, Option, Select, SuggestionItem, Text, TextArea,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { Section } from '@core/components/Section';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { PdfDialog } from '@core/components/PdfDialog';
import { ImportDialog, ImportKnopf } from '@core/components/ImportDialog';
import { Empty } from '@core/components/Section';
import { toast } from '@core/toast';
import { TCO, dat } from '../util';
import '../gruppen/gruppen.css';
import './checklisten.css';

/**
 * Checklisten für Veranstaltungen: Kategorien, verantwortliche Person, Schritte mit Terminbezug. Eine Checkliste gilt für
 * eine oder mehrere Veranstaltungen des Vereinskalenders (oder freie Termine) – abgehakt wird je Veranstaltung.
 * Checklisten und einzelne Schritte lassen sich kopieren, jede Checkliste als PDF drucken.
 *
 * Die Übersicht ist ein Baum im Layout der Mitgliedergruppen (Kategorie → Checkliste → Schritt): gepflegt wird direkt im Baum,
 * verschoben per Ziehen und Ablegen – Checkliste auf eine Kategorie, Schritt auf eine Checkliste (ans Ende) oder auf einen
 * Schritt (davor). Ganze Tabellen kommen über „Importieren“ aus der Zwischenablage (aus Excel kopiert).
 */
const CL = `${TCO}/checklisten`;

type Stand = 'ERLEDIGT' | 'UEBERFAELLIG' | 'BALD' | 'OFFEN';
interface Kategorie { id: number; name: string; aktiv: boolean; anzahl: number }
interface Schritt {
  id: number; pos: number; titel: string; beschreibung: string | null; verantwortlich: string | null; tage_vor: number | null; faellig: string | null; termin_text: string;
  /** Hierarchie: übergeordneter Schritt, Stufe 1–5, Gliederungsnummer, Blatt = ohne Unterschritte */
  parent_id: number | null; ebene: number; nr: string; blatt: boolean;
}
interface BezugSchritt { schritt_id: number; faellig: string | null; stand: Stand; erledigt: { am: string; von: string | null; notiz: string | null } | null; /** Schritt mit Unterschritten: Fortschritt über seine Blätter */ gruppe?: Fortschritt }
interface Fortschritt { gesamt: number; erledigt: number; ueberfaellig: number; bald: number }
interface Bezug { id: number; event_id: number | null; titel: string; termin: string; ort: string | null; abgesagt: boolean; schritte: BezugSchritt[]; fortschritt: Fortschritt }
interface Checkliste {
  id: number; titel: string; beschreibung: string | null; kategorie_id: number | null; kategorie: string | null;
  verantwortlich: string | null; verantwortlich_id: string | null; geaendert_am: string; geaendert_von: string | null;
  schritte: Schritt[]; bezuege: Bezug[];
}
interface Event { id: number; titel: string; termin: string; ort: string | null; abgesagt: boolean }
interface Daten { checklisten: Checkliste[]; kategorien: Kategorie[]; personen: { id: string; name: string }[]; events: Event[]; stand_text: Record<Stand, string>; import_spalten: string[]; max_stufen: number; pflege: boolean }
/** Zeile des Baums: Kategorie (k; null = „Ohne Kategorie“), Checkliste (c) oder Schritt (s in c) */
interface Zeile { id: string; text: string; art: 'K' | 'C' | 'S'; k?: Kategorie | null; c?: Checkliste; s?: Schritt; subRows?: Zeile[] }
type Tabelle = { toggleAllRowsExpanded?: (v: boolean) => void; toggleRowExpanded?: (id: string, v?: boolean) => void };
/** was gerade gezogen wird: eine Checkliste oder ein Schritt */
type Gezogen = { art: 'C'; id: number; kategorie: number | null } | { art: 'S'; id: number; von: number };
const ZIEL = 'portal-gr__ziel';
interface ImportAntwort {
  fehler: string[]; kopfzeile: boolean; uebernommen: boolean;
  zeilen: { zeile: number; kategorie: string; checkliste: string; schritt: string; verantwortlich: string; hinweise: string; tage_vor: number | null; faellig: string | null }[];
  ergebnis: { kategorien: string[]; checklisten: string[]; ergaenzt: string[]; schritte: number } | null;
}
const terminWort = (t: { tage_vor: number | null; faellig: string | null }) => (t.faellig ? dat(t.faellig) : t.tage_vor == null ? '' : t.tage_vor === 0 ? 'am Tag' : `${Math.abs(t.tage_vor)} Tage ${t.tage_vor > 0 ? 'vorher' : 'danach'}`);

const STATE: Record<Stand, 'Positive' | 'Negative' | 'Critical' | 'None'> = { ERLEDIGT: 'Positive', UEBERFAELLIG: 'Negative', BALD: 'Critical', OFFEN: 'None' };
const summe = (c: Checkliste): Fortschritt => c.bezuege.reduce((s, b) => ({
  gesamt: s.gesamt + b.fortschritt.gesamt, erledigt: s.erledigt + b.fortschritt.erledigt,
  ueberfaellig: s.ueberfaellig + b.fortschritt.ueberfaellig, bald: s.bald + b.fortschritt.bald,
}), { gesamt: 0, erledigt: 0, ueberfaellig: 0, bald: 0 });
const tagZeit = (iso: string) => new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

function StandAnzeige({ f }: { f: Fortschritt }) {
  if (!f.gesamt) return <span className="portal-muted">–</span>;
  return (
    <span>
      {f.erledigt} von {f.gesamt}
      {f.ueberfaellig > 0 && <ObjectStatus state="Negative" inverted style={{ marginLeft: '0.5rem' }}>{f.ueberfaellig} überfällig</ObjectStatus>}
      {!f.ueberfaellig && f.bald > 0 && <ObjectStatus state="Critical" inverted style={{ marginLeft: '0.5rem' }}>{f.bald} bald fällig</ObjectStatus>}
      {f.erledigt === f.gesamt && <ObjectStatus state="Positive" inverted style={{ marginLeft: '0.5rem' }}>fertig</ObjectStatus>}
    </span>
  );
}

/** Fortschritt als Balken mit „x von y“ und Prozent – für Gruppen von Schritten, Veranstaltungen und Kategorien */
function Balken({ f }: { f: Fortschritt }) {
  if (!f.gesamt) return <span className="portal-muted">–</span>;
  const p = Math.round((100 * f.erledigt) / f.gesamt);
  return (
    <span className="portal-cl__fortschritt" title={`${f.erledigt} von ${f.gesamt} erledigt${f.ueberfaellig ? `, ${f.ueberfaellig} überfällig` : ''}${f.bald ? `, ${f.bald} bald fällig` : ''}`}>
      <span className="portal-cl__balken"><i style={{ width: `${p}%` }} /></span>
      <span className="portal-cl__zahl">{f.erledigt}/{f.gesamt} · {p} %</span>
      {f.ueberfaellig > 0 && <ObjectStatus state="Negative" inverted>{f.ueberfaellig} überfällig</ObjectStatus>}
    </span>
  );
}
const plus = (a: Fortschritt, b: Fortschritt): Fortschritt => ({ gesamt: a.gesamt + b.gesamt, erledigt: a.erledigt + b.erledigt, ueberfaellig: a.ueberfaellig + b.ueberfaellig, bald: a.bald + b.bald });
const NULL: Fortschritt = { gesamt: 0, erledigt: 0, ueberfaellig: 0, bald: 0 };
/** Fortschritt eines Schritts über alle Veranstaltungen der Checkliste (Gruppe: ihre Blätter; Blatt: je Veranstaltung ein Haken) */
const schrittFortschritt = (c: Checkliste, id: number): Fortschritt => c.bezuege.reduce((f, b) => {
  const z = b.schritte.find((t) => t.schritt_id === id);
  return z ? plus(f, z.gruppe ?? { gesamt: 1, erledigt: z.erledigt ? 1 : 0, ueberfaellig: z.stand === 'UEBERFAELLIG' ? 1 : 0, bald: z.stand === 'BALD' ? 1 : 0 }) : f;
}, NULL);

/** Eingabe der verantwortlichen Person: freier Text mit den Benutzern des Portals als Vorschlag */
function PersonFeld({ wert, personen, onChange, placeholder }: { wert: string; personen: Daten['personen']; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <Input value={wert} showSuggestions placeholder={placeholder} onInput={(e) => onChange(e.target.value)} onChange={(e) => onChange(e.target.value)}>
      {personen.map((p) => <SuggestionItem key={p.id} text={p.name} />)}
    </Input>
  );
}

type KopfForm = { id?: number; titel: string; beschreibung: string; kategorie_id: number | null; verantwortlich: string };
type SchrittForm = { id?: number; checkliste: number; /** übergeordneter Schritt (null = oberste Stufe) */ unter: number | null; unterVorher: number | null; titel: string; beschreibung: string; verantwortlich: string; art: 'OHNE' | 'TAGE' | 'DATUM'; tage: string; danach: boolean; faellig: string };
type BezugForm = { events: number[]; suche: string; termin: string; bezeichnung: string };

export function Checklisten() {
  const [d, setD] = useState<Daten | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offen, setOffen] = useState<number | null>(null);
  const [bezugId, setBezugId] = useState<number | null>(null);
  const [filter, setFilter] = useState({ suche: '', schritte: true, nurOffen: false });
  const [imp, setImp] = useState<{ text: string; antwort: ImportAntwort | null } | null>(null);
  const tabelle = useRef<Tabelle | null>(null);
  const gezogen = useRef<Gezogen | null>(null);
  const [markiert, setMarkiert] = useState<number[]>([]);
  const [kopf, setKopf] = useState<KopfForm | null>(null);
  const [schritt, setSchritt] = useState<SchrittForm | null>(null);
  const [bezug, setBezug] = useState<BezugForm | null>(null);
  const [kopie, setKopie] = useState<{ id: number; titel: string; bezuege: boolean } | null>(null);
  const [ziel, setZiel] = useState<number | null>(null);
  const [kategorien, setKategorien] = useState<{ neu: string } | null>(null);
  const [pdf, setPdf] = useState<string | null>(null);
  const [frage, setFrage] = useState<{ titel: string; text: string; tun: () => Promise<unknown> } | null>(null);

  const laden = useCallback(() => api.get<Daten>(CL).then(setD).catch((e) => setError(e.message)), []);
  useEffect(() => { laden(); }, [laden]);

  /** Aufruf mit Fehleranzeige; danach neu laden */
  async function tun<T>(fn: () => Promise<T>, danach?: (r: T) => void) {
    setBusy(true); setError(null);
    try {
      const r = await fn();
      const t = (r as { text?: string } | null)?.text;
      if (t) toast(t);
      await laden();
      danach?.(r);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const c = useMemo(() => d?.checklisten.find((x) => x.id === offen) ?? null, [d, offen]);
  const b = useMemo(() => c?.bezuege.find((x) => x.id === bezugId) ?? c?.bezuege[0] ?? null, [c, bezugId]);
  const pflege = !!d?.pflege;
  // Baum: Kategorien (auch leere – als Ziel beim Ablegen) → Checklisten → Schritte; mit Suchtext bleiben Treffer und ihre Knoten darüber
  const such = filter.suche.trim().toLowerCase();
  const baum = useMemo<Zeile[]>(() => {
    if (!d) return [];
    const passt = (...t: (string | null | undefined)[]) => t.some((x) => !!x && x.toLowerCase().includes(such));
    const knoten = (k: Kategorie | null): Zeile[] => {
      const kPasst = !such || passt(k?.name ?? 'Ohne Kategorie');
      const kinder = d.checklisten.filter((x) => x.kategorie_id === (k?.id ?? null)).flatMap((x): Zeile[] => {
        const f = summe(x);
        if (filter.nurOffen && !(f.gesamt > f.erledigt)) return [];
        const cPasst = kPasst || passt(x.titel, x.beschreibung, x.verantwortlich, ...x.bezuege.map((y) => y.titel));
        const schritte = x.schritte.filter((y) => cPasst || passt(y.titel, y.beschreibung, y.verantwortlich));
        if (!cPasst && !schritte.length) return [];
        // Schritte verschachteln (die Liste steht in Baumreihenfolge); bei einer Suche bleiben Treffer mit ihren übergeordneten Schritten
        const sichtbar = new Set(schritte.map((y) => y.id));
        if (!cPasst) for (const y of schritte) for (let p = y.parent_id; p !== null; p = x.schritte.find((t) => t.id === p)?.parent_id ?? null) sichtbar.add(p);
        const blaetter: Zeile[] = [];
        if (filter.schritte || (such && !cPasst)) {
          const stapel: Zeile[] = [];
          for (const y of x.schritte.filter((t) => sichtbar.has(t.id))) {
            const zeile: Zeile = { id: `s${y.id}`, text: y.titel, art: 'S', c: x, s: y, subRows: [] };
            stapel.length = y.ebene - 1;
            (stapel[y.ebene - 2]?.subRows ?? blaetter).push(zeile);
            stapel[y.ebene - 1] = zeile;
          }
        }
        return [{ id: `c${x.id}`, text: x.titel, art: 'C', k, c: x, subRows: blaetter }];
      });
      if (!kinder.length && (such ? !kPasst : filter.nurOffen || (!k && !pflege))) return [];
      return [{ id: `k${k?.id ?? 0}`, text: k?.name ?? 'Ohne Kategorie', art: 'K', k, subRows: kinder }];
    };
    return [...d.kategorien.flatMap(knoten), ...knoten(null)];
  }, [d, such, filter.schritte, filter.nurOffen, pflege]);
  const anzahlZeilen = (z: Zeile[]): number => z.reduce((n, x) => n + 1 + (x.subRows ? anzahlZeilen(x.subRows) : 0), 0);
  // beim ersten Laden die Gliederung zeigen (Kategorien aufgeklappt); bei einer Suche alle Treffer
  const geladen = !!d;
  useEffect(() => {
    if (!geladen || offen) return;
    for (const z of baum) tabelle.current?.toggleRowExpanded?.(z.id, true);
  }, [geladen, offen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (such) tabelle.current?.toggleAllRowsExpanded?.(true); }, [such, baum]);

  const oeffnen = (id: number | null) => { setOffen(id); setBezugId(null); setMarkiert([]); setError(null); };

  // ---------------------------------------------------------------- Aktionen
  function kopfSichern() {
    if (!kopf) return;
    const person = d?.personen.find((p) => p.name === kopf.verantwortlich.trim());
    const body = { titel: kopf.titel, beschreibung: kopf.beschreibung, kategorie_id: kopf.kategorie_id, verantwortlich: kopf.verantwortlich, verantwortlich_id: person?.id ?? null };
    tun(() => (kopf.id ? api.put<{ text: string }>(`${CL}/${kopf.id}`, body) : api.post<{ id: number; text: string }>(CL, body)),
      () => { tabelle.current?.toggleRowExpanded?.(`k${kopf.kategorie_id ?? 0}`, true); setKopf(null); });
  }

  function schrittSichern() {
    if (!schritt) return;
    const tage = Number(schritt.tage);
    if (schritt.art === 'TAGE' && (!Number.isInteger(tage) || tage < 0)) { setError('Bitte die Tage als ganze Zahl angeben.'); return; }
    if (schritt.art === 'DATUM' && !schritt.faellig) { setError('Bitte das Datum angeben.'); return; }
    const body = {
      titel: schritt.titel, beschreibung: schritt.beschreibung, verantwortlich: schritt.verantwortlich,
      tage_vor: schritt.art === 'TAGE' ? (schritt.danach ? -tage : tage) : null, faellig: schritt.art === 'DATUM' ? schritt.faellig : null,
    };
    tun(async () => {
      if (!schritt.id) { await api.post(`${CL}/${schritt.checkliste}/schritte`, { ...body, parent_id: schritt.unter }); return null; }
      await api.put(`${CL}/schritte/${schritt.id}`, body);
      // unter einen anderen Schritt gehängt (oder auf die oberste Stufe geholt)
      if (schritt.unter !== schritt.unterVorher) await api.post(`${CL}/schritte/${schritt.id}/verschieben`, { ziel: schritt.checkliste, unter: schritt.unter });
      return null;
    }, () => { tabelle.current?.toggleRowExpanded?.(`c${schritt.checkliste}`, true); setSchritt(null); });
  }

  function verschieben(i: number, um: number) {
    if (!c) return;
    // getauscht wird innerhalb der Geschwister (gleicher übergeordneter Schritt)
    const ids = c.schritte.filter((s) => s.parent_id === c.schritte[i].parent_id).map((s) => s.id);
    const k = ids.indexOf(c.schritte[i].id), j = k + um;
    if (j < 0 || j >= ids.length) return;
    [ids[k], ids[j]] = [ids[j], ids[k]];
    tun(() => api.post(`${CL}/${c.id}/reihenfolge`, { schritte: ids }).then(() => null));
  }

  const schrittForm = (checkliste: number, s?: Schritt, unter: number | null = null): SchrittForm => ({
    id: s?.id, checkliste, unter: s ? s.parent_id : unter, unterVorher: s ? s.parent_id : unter, titel: s?.titel ?? '', beschreibung: s?.beschreibung ?? '', verantwortlich: s?.verantwortlich ?? '',
    art: s?.faellig ? 'DATUM' : s?.tage_vor != null ? 'TAGE' : 'OHNE', tage: s?.tage_vor != null ? String(Math.abs(s.tage_vor)) : '14', danach: (s?.tage_vor ?? 0) < 0, faellig: s?.faellig ?? '',
  });

  // ---------------------------------------------------------------- Ziehen und Ablegen im Baum
  // Checkliste auf Kategorie = dorthin verschieben; Schritt auf Checkliste = ans Ende, Schritt auf Schritt = davor
  const darfAuf = (ziel: Zeile) => {
    const g = gezogen.current;
    if (!g) return false;
    if (g.art === 'C') return ziel.art === 'K' && (ziel.k?.id ?? null) !== g.kategorie;
    if (ziel.art === 'C') return ziel.c!.id !== g.von || ziel.c!.schritte.filter((t) => t.parent_id === null).at(-1)?.id !== g.id;
    if (ziel.art !== 'S' || ziel.s!.id === g.id) return false;
    // nicht vor einen eigenen Unterschritt
    const quelle = ziel.c!.schritte.find((t) => t.id === g.id);
    return !quelle || !ziel.s!.nr.startsWith(`${quelle.nr}.`);
  };
  const ziehStart = (e: DragEvent<HTMLElement>, was: Gezogen, text: string) => {
    gezogen.current = was;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', text);
  };
  const ablage = (ziel: Zeile) => ({
    onDragOver: (e: DragEvent<HTMLElement>) => { if (darfAuf(ziel)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; e.currentTarget.classList.add(ZIEL); } },
    onDragLeave: (e: DragEvent<HTMLElement>) => e.currentTarget.classList.remove(ZIEL),
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      e.currentTarget.classList.remove(ZIEL);
      const g = gezogen.current;
      gezogen.current = null;
      if (!g || !darfAufMit(g, ziel)) return;
      if (g.art === 'C') tun(() => api.post<{ text: string }>(`${CL}/${g.id}/kategorie`, { kategorie_id: ziel.k?.id ?? null }));
      else tun(() => api.post<{ text: string }>(`${CL}/schritte/${g.id}/verschieben`, { ziel: ziel.c!.id, vor: ziel.art === 'S' ? ziel.s!.id : null }));
      tabelle.current?.toggleRowExpanded?.(ziel.art === 'S' ? `c${ziel.c!.id}` : ziel.id, true);
    },
  });
  const darfAufMit = (g: Gezogen, ziel: Zeile) => { gezogen.current = g; const ok = darfAuf(ziel); gezogen.current = null; return ok; };
  const ziehbar = pflege && !busy;
  const ziehEnde = () => { gezogen.current = null; };

  const kopfNeu = (kategorie: number | null) => setKopf({ titel: '', beschreibung: '', kategorie_id: kategorie, verantwortlich: '' });
  const kopfAendern = (x: Checkliste) => setKopf({ id: x.id, titel: x.titel, beschreibung: x.beschreibung ?? '', kategorie_id: x.kategorie_id, verantwortlich: x.verantwortlich ?? '' });
  const loeschenFrage = (x: Checkliste) => setFrage({
    titel: 'Checkliste löschen', text: `Checkliste „${x.titel}“ mit allen Schritten und dem Stand je Veranstaltung löschen?`,
    tun: () => api.del(`${CL}/${x.id}`).then((r) => { if (offen === x.id) oeffnen(null); return r; }),
  });

  const columns: AnalyticalTableColumnDefinition[] = useMemo(() => [
    {
      Header: 'Kategorie / Checkliste / Schritt', accessor: 'text', minWidth: 260,
      Cell: ({ row }: Cell) => {
        const z = row.original as Zeile;
        if (z.art === 'K') {
          return (
            <div className="portal-gr__zelle portal-cl__zelle" {...(pflege ? ablage(z) : {})}>
              <Icon name="folder" />
              {z.k ? <Text><b>{z.text}</b></Text> : <Text className="portal-muted">{z.text}</Text>}
              {z.k && !z.k.aktiv && <ObjectStatus state="Critical">abgeschaltet</ObjectStatus>}
            </div>
          );
        }
        if (z.art === 'C') {
          const x = z.c!;
          return (
            <div className="portal-gr__zelle portal-cl__zelle" draggable={ziehbar} onDragStart={(e) => ziehStart(e, { art: 'C', id: x.id, kategorie: x.kategorie_id }, x.titel)} onDragEnd={ziehEnde} {...(pflege ? ablage(z) : {})}>
              <Icon name="activities" />
              <Link onClick={() => oeffnen(x.id)}><b>{x.titel}</b></Link>
              {x.beschreibung && <span className="portal-muted portal-small">{x.beschreibung.split('\n')[0]}</span>}
            </div>
          );
        }
        const y = z.s!;
        return (
          <div className="portal-gr__zelle portal-cl__zelle" draggable={ziehbar} onDragStart={(e) => ziehStart(e, { art: 'S', id: y.id, von: z.c!.id }, y.titel)} onDragEnd={ziehEnde} {...(pflege ? ablage(z) : {})}>
            <Icon name={y.blatt ? 'task' : 'group-2'} />
            <span className="portal-cl__nr">{y.nr}</span>
            <Text>{y.blatt ? y.titel : <b>{y.titel}</b>}</Text>
            {y.beschreibung && <span className="portal-muted portal-small">{y.beschreibung.split('\n')[0]}</span>}
          </div>
        );
      },
    },
    {
      Header: 'Verantwortlich', id: 'wer', width: 150,
      Cell: ({ row }: Cell) => {
        const z = row.original as Zeile;
        if (z.art === 'K') return '';
        if (z.art === 'C') return <Text>{z.c!.verantwortlich ?? ''}</Text>;
        return z.s!.verantwortlich ? <Text>{z.s!.verantwortlich}</Text> : <Text className="portal-muted">{z.c!.verantwortlich ?? ''}</Text>;
      },
    },
    {
      Header: 'Termin / Veranstaltungen', id: 'termin', width: 210,
      Cell: ({ row }: Cell) => {
        const z = row.original as Zeile;
        if (z.art === 'K') return <Text className="portal-muted">{z.subRows?.length ?? 0} Checkliste{z.subRows?.length === 1 ? '' : 'n'}</Text>;
        if (z.art === 'S') return z.s!.blatt ? <Text>{z.s!.termin_text}</Text> : <Text className="portal-muted">{z.c!.schritte.filter((t) => t.blatt && t.nr.startsWith(`${z.s!.nr}.`)).length} Unterschritte</Text>;
        const x = z.c!;
        if (!x.bezuege.length) return <Text className="portal-muted">Vorlage (ohne Termin)</Text>;
        const n = x.bezuege.find((y) => y.fortschritt.erledigt < y.fortschritt.gesamt) ?? x.bezuege[0];
        return <Text>{n.titel} · {dat(n.termin)}{x.bezuege.length > 1 ? ` · +${x.bezuege.length - 1}` : ''}</Text>;
      },
    },
    {
      Header: 'Fortschritt', id: 'stand', width: 230,
      Cell: ({ row }: Cell) => {
        const z = row.original as Zeile;
        // überall derselbe Balken: Kategorie = Summe ihrer Checklisten, Checkliste = alle Veranstaltungen, Schritt = seine Blätter bzw. Haken je Veranstaltung
        if (z.art === 'C') return <Balken f={summe(z.c!)} />;
        if (z.art === 'S') return z.c!.bezuege.length ? <Balken f={schrittFortschritt(z.c!, z.s!.id)} /> : '';
        return <Balken f={(z.subRows ?? []).reduce((f, k) => plus(f, summe(k.c!)), NULL)} />;
      },
    },
    ...(pflege ? [{
      Header: '', id: 'aktionen', width: 250, hAlign: 'End' as const,
      Cell: ({ row }: Cell) => {
        const z = row.original as Zeile;
        if (z.art === 'K') {
          return (
            <FlexBox justifyContent="End">
              <Button icon="add-activity" design="Transparent" tooltip={`Neue Checkliste in „${z.text}“`} disabled={busy} onClick={() => kopfNeu(z.k?.id ?? null)} />
              {z.k && <Button icon="edit" design="Transparent" tooltip="Kategorien pflegen (umbenennen, abschalten, löschen)" disabled={busy} onClick={() => setKategorien({ neu: '' })} />}
            </FlexBox>
          );
        }
        if (z.art === 'C') {
          const x = z.c!;
          return (
            <FlexBox justifyContent="End">
              <Button icon="add" design="Transparent" tooltip="Schritt anlegen" disabled={busy} onClick={() => setSchritt(schrittForm(x.id))} />
              <Button icon="edit" design="Transparent" tooltip="Checkliste ändern" disabled={busy} onClick={() => kopfAendern(x)} />
              <Button icon="copy" design="Transparent" tooltip="Checkliste kopieren" disabled={busy} onClick={() => setKopie({ id: x.id, titel: `${x.titel} (Kopie)`, bezuege: false })} />
              <Button icon="pdf-attachment" design="Transparent" tooltip="PDF" onClick={() => setPdf(`${CL}/${x.id}/pdf`)} />
              <Button icon="delete" design="Transparent" tooltip="Checkliste löschen" disabled={busy} onClick={() => loeschenFrage(x)} />
            </FlexBox>
          );
        }
        const y = z.s!;
        return (
          <FlexBox justifyContent="End">
            {y.ebene < (d?.max_stufen ?? 5) && <Button icon="add" design="Transparent" tooltip={`Unterschritt zu „${y.titel}“ anlegen`} disabled={busy} onClick={() => setSchritt(schrittForm(z.c!.id, undefined, y.id))} />}
            <Button icon="edit" design="Transparent" tooltip="Schritt ändern oder umhängen" disabled={busy} onClick={() => setSchritt(schrittForm(z.c!.id, y))} />
            <Button icon="delete" design="Transparent" tooltip="Schritt löschen" disabled={busy} onClick={() => setFrage({
              titel: 'Schritt löschen', text: `Schritt „${y.titel}“ aus „${z.c!.titel}“ löschen${y.blatt ? '' : ' – mit allen Unterschritten'}? Er entfällt für alle zugeordneten Veranstaltungen.`, tun: () => api.del(`${CL}/schritte/${y.id}`),
            })} />
          </FlexBox>
        );
      },
    }] : []),
  ], [pflege, busy, d, offen]); // eslint-disable-line react-hooks/exhaustive-deps
  const tabellenOptionen = useMemo(() => ({ autoResetExpanded: false, getRowId: (r: Zeile) => r.id }), []);

  /** Bestand als Tabelle (dieselben Spalten wie der Import) – zum Bearbeiten in Excel */
  const alsTabelle = (nurKopf: boolean) => {
    if (!d) return '';
    const zelle = (t: string | null | undefined) => (t ?? '').replace(/[\t\r\n]+/g, ' ');
    const zeilen = [d.import_spalten.join('\t')];
    if (!nurKopf) {
      for (const x of d.checklisten) {
        if (!x.schritte.length) zeilen.push([zelle(x.kategorie), zelle(x.titel), '', '', '', ''].join('\t'));
        // Unterschritte als Weg „Aufbau > Zelt“ – so liest sie der Import wieder ein
        const weg: string[] = [];
        for (const y of x.schritte) {
          weg.length = y.ebene - 1;
          weg[y.ebene - 1] = zelle(y.titel).replace(/>/g, '›');
          zeilen.push([zelle(x.kategorie), zelle(x.titel), weg.join(' > '), zelle(y.verantwortlich), y.blatt ? terminWort(y) : '', zelle(y.beschreibung)].join('\t'));
        }
      }
    }
    return zeilen.join('\n');
  };
  const kopiere = (text: string, meldung: string) => navigator.clipboard.writeText(text).then(() => toast(meldung)).catch(() => setError('Die Zwischenablage ist nicht erreichbar – bitte den Text von Hand markieren und kopieren.'));
  async function importieren(pruefen: boolean) {
    if (!imp) return;
    setBusy(true); setError(null);
    try {
      const antwort = await api.post<ImportAntwort>(`${CL}/import`, { text: imp.text, pruefen });
      setImp({ ...imp, antwort });
      if (antwort.uebernommen) { toast('Import übernommen.'); await laden(); tabelle.current?.toggleAllRowsExpanded?.(true); }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  // ---------------------------------------------------------------- Ansichten
  const uebersicht = d && (
    <div className="portal-section">
      <div className="portal-row" style={{ marginBottom: '0.5rem' }}>
        <Input value={filter.suche} placeholder="Kategorie, Checkliste, Schritt oder Person suchen" showClearIcon style={{ width: 'min(24rem, 100%)' }} onInput={(e) => setFilter({ ...filter, suche: e.target.value })} />
        <CheckBox text="Schritte anzeigen" checked={filter.schritte} onChange={(e) => setFilter({ ...filter, schritte: e.target.checked })} />
        <CheckBox text="nur mit offenen Schritten" checked={filter.nurOffen} onChange={(e) => setFilter({ ...filter, nurOffen: e.target.checked })} />
        <div style={{ flex: 1 }} />
        <Button icon="expand-all" design="Transparent" tooltip="Alles aufklappen" onClick={() => tabelle.current?.toggleAllRowsExpanded?.(true)} />
        <Button icon="collapse-all" design="Transparent" tooltip="Alles zuklappen" onClick={() => tabelle.current?.toggleAllRowsExpanded?.(false)} />
      </div>
      {pflege && d.checklisten.length > 0 && (
        <div className="portal-gr__oben">
          Ziehen und Ablegen: Checkliste auf eine Kategorie ziehen = dorthin verschieben. Schritt auf eine Checkliste ziehen = dorthin verschieben (ans Ende), auf einen Schritt = davor einordnen (auf dessen Stufe, mit allen Unterschritten). Unterschritte über „+“ am Schritt; umhängen über „Ändern“.
        </div>
      )}
      {!d.checklisten.length && !d.kategorien.length ? (
        <Empty>
          Noch keine Checklisten. Lege zuerst die Kategorien an – z. B. „Vereinsfest“, „Turnier“, „Arbeitseinsatz“ – und darin die Checklisten mit ihren Schritten,
          oder übernimm eine Tabelle aus Excel mit „Importieren“.
        </Empty>
      ) : (
        <AnalyticalTable minRows={1} columns={columns} data={baum} isTreeTable tableInstance={tabelle as never} reactTableOptions={tabellenOptionen}
                         visibleRows={Math.max(anzahlZeilen(baum), 1)} noDataText="Keine Checkliste und kein Schritt zu dieser Auswahl" />
      )}
    </div>
  );

  const detail = d && c && (
    <>
      <Section title="Checkliste" actions={pflege && <Button design="Transparent" icon="edit" onClick={() => kopfAendern(c)}>Ändern</Button>}>
        <div className="portal-cl__zwei">
          <div className="portal-cl__feld"><span>Kategorie</span><Text>{c.kategorie ?? '–'}</Text></div>
          <div className="portal-cl__feld"><span>Verantwortlich</span><Text>{c.verantwortlich ?? '–'}</Text></div>
          <div className="portal-cl__feld"><span>Zuletzt geändert</span><Text>{tagZeit(c.geaendert_am)}{c.geaendert_von ? ` · ${c.geaendert_von}` : ''}</Text></div>
        </div>
        {c.beschreibung && <Text style={{ display: 'block', marginTop: '0.75rem', whiteSpace: 'pre-line' }}>{c.beschreibung}</Text>}
      </Section>

      <Section title="Gültig für" count={c.bezuege.length}
               actions={pflege && <Button design="Transparent" icon="add" onClick={() => setBezug({ events: [], suche: '', termin: '', bezeichnung: '' })}>Veranstaltung zuordnen</Button>}>
        {c.bezuege.length === 0
          ? <Text className="portal-muted">Noch keiner Veranstaltung zugeordnet – die Checkliste ist eine Vorlage. Abgehakt wird je Veranstaltung bzw. Termin.</Text>
          : (
            <div className="portal-cl__bezuege">
              {c.bezuege.map((x) => (
                <button key={x.id} type="button" className={`portal-cl__bezug${b?.id === x.id ? ' portal-cl__bezug--aktiv' : ''}`} onClick={() => setBezugId(x.id)}>
                  <b>{x.titel}</b>
                  <span>{dat(x.termin)}{x.event_id ? '' : ' · freier Termin'}{x.abgesagt ? ' · abgesagt' : ''}</span>
                  <span className="portal-cl__klein">{x.fortschritt.erledigt} von {x.fortschritt.gesamt} erledigt{x.fortschritt.ueberfaellig ? ` · ${x.fortschritt.ueberfaellig} überfällig` : ''}</span>
                  <span className="portal-cl__balken"><i style={{ width: `${x.fortschritt.gesamt ? (100 * x.fortschritt.erledigt) / x.fortschritt.gesamt : 0}%` }} /></span>
                </button>
              ))}
            </div>
          )}
      </Section>

      <Section title={b ? `Schritte – ${b.titel}, ${dat(b.termin)}` : 'Schritte'} count={c.schritte.length} flush
               actions={<>
                 {b && pflege && <Button design="Transparent" icon="decline" onClick={() => setFrage({
                   titel: 'Zuordnung entfernen', text: `„${b.titel}“ (${dat(b.termin)}) von dieser Checkliste lösen? Der Stand der Schritte für diese Veranstaltung geht verloren.`,
                   tun: () => api.del(`${CL}/bezuege/${b.id}`),
                 })}>Zuordnung entfernen</Button>}
                 {pflege && markiert.length > 0 && <Button design="Transparent" icon="copy" onClick={() => setZiel(0)}>{markiert.length} kopieren nach …</Button>}
                 {pflege && <Button design="Transparent" icon="add" onClick={() => setSchritt(schrittForm(c.id))}>Schritt</Button>}
               </>}>
        {c.schritte.length === 0
          ? <div className="portal-empty" style={{ padding: '0.75rem 1rem' }}>Noch keine Schritte.</div>
          : (
            <div className="portal-tabrahmen">
              <table className="portal-cl__tab">
                <thead>
                  <tr>
                    {pflege && <th className="schmal" title="Zum Kopieren markieren">Kopieren</th>}
                    {b && <th className="schmal">Erledigt</th>}
                    <th>Schritt</th><th>Verantwortlich</th><th>{b ? 'Fällig' : 'Termin'}</th>{b && <th>Stand / Fortschritt</th>}{pflege && <th className="schmal" />}
                  </tr>
                </thead>
                <tbody>
                  {c.schritte.map((s, i) => {
                    const z = b?.schritte.find((x) => x.schritt_id === s.id);
                    const reihe = c.schritte.filter((t) => t.parent_id === s.parent_id);
                    const fertig = s.blatt ? !!z?.erledigt : z?.stand === 'ERLEDIGT';
                    return (
                      <tr key={s.id} className={`${fertig ? 'erledigt' : ''}${s.blatt ? '' : ' gruppe'}`}>
                        {pflege && <td className="schmal mitte"><CheckBox accessibleName={`${s.titel} zum Kopieren markieren`} checked={markiert.includes(s.id)}
                          onChange={(e) => setMarkiert(e.target.checked ? [...markiert, s.id] : markiert.filter((m) => m !== s.id))} /></td>}
                        {b && <td className="schmal mitte"><CheckBox accessibleName={s.blatt ? `${s.titel} erledigt` : `${s.titel}: alle Unterschritte erledigt`} checked={fertig} indeterminate={!s.blatt && !fertig && (z?.gruppe?.erledigt ?? 0) > 0}
                          disabled={!pflege || busy} title={s.blatt ? undefined : 'Hakt alle Unterschritte ab bzw. öffnet sie wieder'}
                          onChange={(e) => { const erledigt = e.target.checked; tun(() => api.post(`${CL}/bezuege/${b.id}/schritte/${s.id}`, { erledigt }).then(() => null)); }} /></td>}
                        <td style={{ paddingLeft: `${0.625 + (s.ebene - 1) * 1.5}rem` }}><span className="portal-cl__titel"><span className="portal-cl__nr">{s.nr}</span> {s.titel}</span>{s.beschreibung && <span className="portal-cl__klein">{s.beschreibung}</span>}</td>
                        <td>{s.verantwortlich ?? <span className="portal-muted">{s.blatt ? c.verantwortlich ?? '–' : ''}</span>}</td>
                        <td>{b ? (z?.faellig ? dat(z.faellig) : '–') : (s.blatt ? s.termin_text || '–' : '')}{b && s.blatt && s.termin_text && !s.faellig && <span className="portal-cl__klein">{s.termin_text}</span>}
                          {b && !s.blatt && z?.faellig && <span className="portal-cl__klein">nächster offener Unterschritt</span>}</td>
                        {b && <td>{z?.gruppe ? <Balken f={z.gruppe} /> : z && <ObjectStatus state={STATE[z.stand]} inverted={z.stand !== 'OFFEN'}>{d.stand_text[z.stand]}</ObjectStatus>}
                          {z?.erledigt && <span className="portal-cl__klein">{tagZeit(z.erledigt.am)}{z.erledigt.von ? ` · ${z.erledigt.von}` : ''}</span>}</td>}
                        {pflege && (
                          <td className="schmal">
                            <Button design="Transparent" icon="navigation-up-arrow" tooltip="Nach oben (innerhalb der Stufe)" accessibleName={`${s.titel} nach oben`} disabled={reihe[0].id === s.id || busy} onClick={() => verschieben(i, -1)} />
                            <Button design="Transparent" icon="navigation-down-arrow" tooltip="Nach unten (innerhalb der Stufe)" accessibleName={`${s.titel} nach unten`} disabled={reihe.at(-1)!.id === s.id || busy} onClick={() => verschieben(i, 1)} />
                            {s.ebene < d.max_stufen && <Button design="Transparent" icon="add" tooltip="Unterschritt anlegen" accessibleName={`Unterschritt zu ${s.titel}`} onClick={() => setSchritt(schrittForm(c.id, undefined, s.id))} />}
                            <Button design="Transparent" icon="edit" tooltip="Ändern oder umhängen" accessibleName={`${s.titel} ändern`} onClick={() => setSchritt(schrittForm(c.id, s))} />
                            <Button design="Transparent" icon="delete" tooltip="Löschen" accessibleName={`${s.titel} löschen`} onClick={() => setFrage({
                              titel: 'Schritt löschen', text: `Schritt „${s.titel}“ löschen${s.blatt ? '' : ' – mit allen Unterschritten'}? Er entfällt für alle zugeordneten Veranstaltungen.`, tun: () => api.del(`${CL}/schritte/${s.id}`),
                            })} />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </Section>
    </>
  );

  const pdfUrl = (alle: boolean) => (c ? `${CL}/${c.id}/pdf${!alle && b ? `?bezug=${b.id}` : ''}` : null);
  const eventsFrei = useMemo(() => {
    if (!d || !c || !bezug) return [];
    const schon = new Set(c.bezuege.map((x) => x.event_id));
    const worte = bezug.suche.toLowerCase().split(/\s+/).filter(Boolean);
    return d.events.filter((e) => !schon.has(e.id) && worte.every((w) => `${e.titel} ${e.ort ?? ''} ${dat(e.termin)}`.toLowerCase().includes(w)));
  }, [d, c, bezug]);

  return (
    <AppPage title={c ? c.titel : 'Checklisten'}
             subtitle={c ? `${c.kategorie ?? 'ohne Kategorie'} · ${c.schritte.length} Schritte · ${c.bezuege.length ? `${c.bezuege.length} Veranstaltung${c.bezuege.length === 1 ? '' : 'en'}` : 'Vorlage'}` : 'Veranstaltungen vorbereiten: Schritte, Verantwortliche und Termine'}
             actions={c ? <>
               <Button icon="nav-back" onClick={() => oeffnen(null)}>Übersicht</Button>
               <Button icon="pdf-attachment" onClick={() => setPdf(pdfUrl(false))}>PDF</Button>
               {c.bezuege.length > 1 && <Button icon="pdf-attachment" design="Transparent" onClick={() => setPdf(pdfUrl(true))}>PDF alle Veranstaltungen</Button>}
               {pflege && <Button icon="copy" onClick={() => setKopie({ id: c.id, titel: `${c.titel} (Kopie)`, bezuege: false })}>Kopieren</Button>}
               {pflege && <Button icon="delete" design="Transparent" onClick={() => loeschenFrage(c)}>Löschen</Button>}
             </> : <>
               {pflege && <Button design="Emphasized" icon="add" onClick={() => kopfNeu(null)}>Neue Checkliste</Button>}
               {pflege && <Button icon="tags" onClick={() => setKategorien({ neu: '' })}>Kategorien</Button>}
               {pflege && <ImportKnopf tooltip="Tabelle aus der Zwischenablage übernehmen (aus Excel kopiert)" onClick={() => setImp({ text: '', antwort: null })} />}
             </>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      <BusyIndicator active={!d} delay={300} style={{ display: 'block', width: '100%' }}>
        <div className="portal-busy-inhalt">{c ? detail : uebersicht}</div>
      </BusyIndicator>

      {/* ---------- Checkliste anlegen / ändern */}
      <Dialog open={!!kopf} headerText={kopf?.id ? 'Checkliste ändern' : 'Neue Checkliste'} onClose={() => setKopf(null)}
              footer={<Bar endContent={<><Button design="Emphasized" disabled={busy || !kopf?.titel.trim()} onClick={kopfSichern}>Sichern</Button><Button onClick={() => setKopf(null)}>Abbrechen</Button></>} />}>
        {kopf && d && (
          <div className="portal-cl__dialog">
            <label className="portal-cl__feld"><span>Titel</span><Input value={kopf.titel} maxlength={160} onInput={(e) => setKopf({ ...kopf, titel: e.target.value })} /></label>
            <div className="portal-cl__zwei">
              <label className="portal-cl__feld"><span>Kategorie</span>
                <Select onChange={(e) => setKopf({ ...kopf, kategorie_id: Number((e.detail.selectedOption as HTMLElement).dataset.k) || null })}>
                  <Option data-k="" selected={!kopf.kategorie_id}>ohne</Option>
                  {d.kategorien.filter((k) => k.aktiv || k.id === kopf.kategorie_id).map((k) => <Option key={k.id} data-k={k.id} selected={kopf.kategorie_id === k.id}>{k.name}</Option>)}
                </Select></label>
              <label className="portal-cl__feld"><span>Verantwortlich</span>
                <PersonFeld wert={kopf.verantwortlich} personen={d.personen} onChange={(v) => setKopf({ ...kopf, verantwortlich: v })} placeholder="Name – Benutzer werden vorgeschlagen" /></label>
            </div>
            <label className="portal-cl__feld"><span>Beschreibung</span><TextArea rows={4} value={kopf.beschreibung} onInput={(e) => setKopf({ ...kopf, beschreibung: e.target.value })} /></label>
          </div>
        )}
      </Dialog>

      {/* ---------- Schritt */}
      <Dialog open={!!schritt} headerText={schritt?.id ? 'Schritt ändern' : 'Neuer Schritt'} onClose={() => setSchritt(null)}
              footer={<Bar endContent={<><Button design="Emphasized" disabled={busy || !schritt?.titel.trim()} onClick={schrittSichern}>Sichern</Button><Button onClick={() => setSchritt(null)}>Abbrechen</Button></>} />}>
        {schritt && d && (
          <div className="portal-cl__dialog">
            <label className="portal-cl__feld"><span>Schritt</span><Input value={schritt.titel} maxlength={200} onInput={(e) => setSchritt({ ...schritt, titel: e.target.value })} /></label>
            {(() => {
              const liste = d.checklisten.find((x) => x.id === schritt.checkliste)?.schritte ?? [];
              const selbst = liste.find((t) => t.id === schritt.id);
              // wählbar: Schritte, unter denen noch eine Stufe frei ist – nicht der Schritt selbst und nichts darunter
              const wahl = liste.filter((t) => t.ebene < d.max_stufen && (!selbst || (t.id !== selbst.id && !t.nr.startsWith(`${selbst.nr}.`))));
              return (
                <label className="portal-cl__feld"><span>Unterschritt von (bis zu {d.max_stufen} Stufen)</span>
                  <Select onChange={(e) => setSchritt({ ...schritt, unter: Number((e.detail.selectedOption as HTMLElement).dataset.u) || null })}>
                    <Option data-u="" selected={schritt.unter === null}>– oberste Stufe –</Option>
                    {wahl.map((t) => <Option key={t.id} data-u={t.id} selected={schritt.unter === t.id}>{'\u00a0\u00a0'.repeat(t.ebene - 1)}{t.nr} {t.titel}</Option>)}
                  </Select></label>
              );
            })()}
            <label className="portal-cl__feld"><span>Hinweise</span><TextArea rows={3} value={schritt.beschreibung} onInput={(e) => setSchritt({ ...schritt, beschreibung: e.target.value })} /></label>
            <label className="portal-cl__feld"><span>Verantwortlich (leer = wie die Checkliste)</span>
              <PersonFeld wert={schritt.verantwortlich} personen={d.personen} onChange={(v) => setSchritt({ ...schritt, verantwortlich: v })} /></label>
            <div className="portal-cl__zwei">
              <label className="portal-cl__feld"><span>Termin</span>
                <Select onChange={(e) => setSchritt({ ...schritt, art: ((e.detail.selectedOption as HTMLElement).dataset.a ?? 'OHNE') as SchrittForm['art'] })}>
                  <Option data-a="OHNE" selected={schritt.art === 'OHNE'}>ohne Termin</Option>
                  <Option data-a="TAGE" selected={schritt.art === 'TAGE'}>bezogen auf die Veranstaltung</Option>
                  <Option data-a="DATUM" selected={schritt.art === 'DATUM'}>festes Datum</Option>
                </Select></label>
              {schritt.art === 'TAGE' && (
                <label className="portal-cl__feld"><span>Tage</span>
                  <div className="portal-row" style={{ flexWrap: 'nowrap' }}>
                    <Input type="Number" style={{ width: '6rem' }} value={schritt.tage} onInput={(e) => setSchritt({ ...schritt, tage: e.target.value })} />
                    <Select style={{ minWidth: '8rem' }} onChange={(e) => setSchritt({ ...schritt, danach: (e.detail.selectedOption as HTMLElement).dataset.d === '1' })}>
                      <Option data-d="0" selected={!schritt.danach}>vorher</Option>
                      <Option data-d="1" selected={schritt.danach}>danach</Option>
                    </Select>
                  </div></label>
              )}
              {schritt.art === 'DATUM' && (
                <label className="portal-cl__feld"><span>Fällig am</span>
                  <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={schritt.faellig} onChange={(e) => setSchritt({ ...schritt, faellig: e.detail.value })} /></label>
              )}
            </div>
            {schritt.art === 'TAGE' && <Text className="portal-muted">Die Fälligkeit ergibt sich je Veranstaltung aus ihrem Datum (0 Tage = am Tag selbst).</Text>}
          </div>
        )}
      </Dialog>

      {/* ---------- Veranstaltung / Termin zuordnen */}
      <Dialog open={!!bezug} headerText="Veranstaltung zuordnen" onClose={() => setBezug(null)}
              footer={<Bar endContent={<>
                <Button design="Emphasized" disabled={busy || !bezug || (!bezug.events.length && !bezug.termin)}
                        onClick={() => bezug && c && tun(() => api.post<{ text: string }>(`${CL}/${c.id}/bezuege`, { events: bezug.events, termin: bezug.termin || null, bezeichnung: bezug.bezeichnung }), () => setBezug(null))}>Zuordnen</Button>
                <Button onClick={() => setBezug(null)}>Abbrechen</Button>
              </>} />}>
        {bezug && (
          <div className="portal-cl__dialog">
            <Text>Die Checkliste gilt für jede gewählte Veranstaltung – mit eigenem Stand je Veranstaltung.</Text>
            <Input placeholder="Veranstaltung suchen" value={bezug.suche} showClearIcon onInput={(e) => setBezug({ ...bezug, suche: e.target.value })} />
            {eventsFrei.length === 0
              ? <Text className="portal-muted">Keine (weitere) Veranstaltung im Vereinskalender gefunden.</Text>
              : (
                <div className="portal-tabrahmen" style={{ maxHeight: '40vh' }}>
                  <table className="portal-cl__tab">
                    <thead><tr><th className="schmal" /><th>Veranstaltung</th><th>Datum</th><th>Ort</th></tr></thead>
                    <tbody>
                      {eventsFrei.map((e) => (
                        <tr key={e.id}>
                          <td className="schmal mitte"><CheckBox accessibleName={`${e.titel} wählen`} checked={bezug.events.includes(e.id)}
                            onChange={(ev) => setBezug({ ...bezug, events: ev.target.checked ? [...bezug.events, e.id] : bezug.events.filter((x) => x !== e.id) })} /></td>
                          <td>{e.titel}{e.abgesagt && <ObjectStatus state="Negative"> abgesagt</ObjectStatus>}</td><td>{dat(e.termin)}</td><td>{e.ort ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            <Text className="portal-muted">Oder ein freier Termin, der nicht im Vereinskalender steht:</Text>
            <div className="portal-cl__zwei">
              <label className="portal-cl__feld"><span>Datum</span>
                <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={bezug.termin} onChange={(e) => setBezug({ ...bezug, termin: e.detail.value })} /></label>
              <label className="portal-cl__feld"><span>Bezeichnung</span><Input value={bezug.bezeichnung} maxlength={160} onInput={(e) => setBezug({ ...bezug, bezeichnung: e.target.value })} /></label>
            </div>
          </div>
        )}
      </Dialog>

      {/* ---------- Checkliste kopieren */}
      <Dialog open={!!kopie} headerText="Checkliste kopieren" onClose={() => setKopie(null)}
              footer={<Bar endContent={<>
                <Button design="Emphasized" disabled={busy || !kopie?.titel.trim()}
                        onClick={() => kopie && tun(() => api.post<{ id: number; text: string }>(`${CL}/${kopie.id}/kopieren`, { titel: kopie.titel, bezuege: kopie.bezuege }), (r) => { setKopie(null); if (offen) oeffnen(r.id); })}>Kopieren</Button>
                <Button onClick={() => setKopie(null)}>Abbrechen</Button>
              </>} />}>
        {kopie && (
          <div className="portal-cl__dialog">
            <label className="portal-cl__feld"><span>Titel der Kopie</span><Input value={kopie.titel} maxlength={160} onInput={(e) => setKopie({ ...kopie, titel: e.target.value })} /></label>
            <CheckBox text="Veranstaltungen und Termine mitnehmen (Stand beginnt neu)" checked={kopie.bezuege} onChange={(e) => setKopie({ ...kopie, bezuege: e.target.checked })} />
            <Text className="portal-muted">Kopiert werden Kategorie, Verantwortliche und alle Schritte – nie der Stand (abgehakt).</Text>
          </div>
        )}
      </Dialog>

      {/* ---------- Schritte in eine andere Checkliste kopieren */}
      <Dialog open={ziel !== null} headerText={`${markiert.length} Schritt${markiert.length === 1 ? '' : 'e'} kopieren nach …`} onClose={() => setZiel(null)}
              footer={<Bar endContent={<>
                <Button design="Emphasized" disabled={busy || !ziel}
                        onClick={() => ziel && tun(() => api.post<{ text: string }>(`${CL}/schritte/kopieren`, { schritte: markiert, ziel }), () => { setZiel(null); setMarkiert([]); })}>Kopieren</Button>
                <Button onClick={() => setZiel(null)}>Abbrechen</Button>
              </>} />}>
        {ziel !== null && d && (
          <div className="portal-cl__dialog">
            <label className="portal-cl__feld"><span>Ziel-Checkliste</span>
              <Select onChange={(e) => setZiel(Number((e.detail.selectedOption as HTMLElement).dataset.c ?? 0))}>
                <Option data-c="0" selected={!ziel}>bitte wählen</Option>
                {d.checklisten.map((x) => <Option key={x.id} data-c={x.id} selected={ziel === x.id}>{x.titel}{x.id === c?.id ? ' (diese)' : ''}{x.kategorie ? ` · ${x.kategorie}` : ''}</Option>)}
              </Select></label>
            <Text className="portal-muted">Die Schritte werden ans Ende der gewählten Checkliste angefügt – mit Hinweisen, Verantwortlichen und Terminbezug, ohne Stand.</Text>
          </div>
        )}
      </Dialog>

      {/* ---------- Kategorien */}
      <Dialog open={!!kategorien} headerText="Kategorien" onClose={() => setKategorien(null)} footer={<Bar endContent={<Button onClick={() => setKategorien(null)}>Schließen</Button>} />}>
        {kategorien && d && (
          <div className="portal-cl__dialog">
            {d.kategorien.length > 0 && (
              <div className="portal-tabrahmen" style={{ maxHeight: '45vh' }}>
                <table className="portal-cl__tab">
                  <thead><tr><th>Kategorie</th><th>Checklisten</th><th>Aktiv</th><th className="schmal" /></tr></thead>
                  <tbody>
                    {d.kategorien.map((k) => (
                      <tr key={k.id}>
                        <td className="mitte"><Input key={`${k.id}:${k.name}`} value={k.name} maxlength={80} accessibleName={`Name ${k.name}`}
                          onChange={(e) => { const name = e.target.value.trim(); if (name && name !== k.name) tun(() => api.post<{ text: string }>(`${CL}/kategorien`, { id: k.id, name, aktiv: k.aktiv })); }} /></td>
                        <td className="mitte">{k.anzahl}</td>
                        <td className="mitte"><CheckBox accessibleName={`${k.name} aktiv`} checked={k.aktiv} onChange={(e) => { const aktiv = e.target.checked; tun(() => api.post<{ text: string }>(`${CL}/kategorien`, { id: k.id, name: k.name, aktiv })); }} /></td>
                        <td className="schmal"><Button design="Transparent" icon="delete" tooltip={k.anzahl ? 'Wird verwendet – abschalten statt löschen' : 'Löschen'} accessibleName={`${k.name} löschen`} disabled={k.anzahl > 0 || busy}
                          onClick={() => tun(() => api.del<{ text: string }>(`${CL}/kategorien/${k.id}`))} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="portal-row" style={{ flexWrap: 'nowrap' }}>
              <Input style={{ flex: 1 }} placeholder="Neue Kategorie, z. B. Turnier, Vereinsfest, Arbeitseinsatz" value={kategorien.neu} maxlength={80} onInput={(e) => setKategorien({ neu: e.target.value })} />
              <Button icon="add" disabled={busy || !kategorien.neu.trim()} onClick={() => tun(() => api.post<{ text: string }>(`${CL}/kategorien`, { name: kategorien.neu }), () => setKategorien({ neu: '' }))}>Anlegen</Button>
            </div>
            <Text className="portal-muted">Abgeschaltete Kategorien bleiben an ihren Checklisten stehen, sind aber für neue nicht mehr wählbar.</Text>
          </div>
        )}
      </Dialog>

      {/* ---------- Import aus der Zwischenablage */}
      <ImportDialog open={!!imp} was="Checklisten aus einer Tabelle" breit schritt={!imp?.antwort ? 1 : imp.antwort.uebernommen ? 4 : 2} onClose={() => setImp(null)}>
        {imp && d && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <Text>
              Tabelle in Excel markieren, kopieren und hier einfügen. Spalten: <b>{d.import_spalten.join(' · ')}</b> – in dieser Reihenfolge oder mit den Spaltennamen in der ersten Zeile.
              Leere Zellen bei Kategorie und Checkliste übernehmen den Wert der Zeile darüber. Unterschritte als Weg in der Spalte Schritt: „Aufbau &gt; Zelt &gt; Heringe“ (bis zu {d.max_stufen} Stufen). Termin: Zahl oder „14 Tage vorher“, „3 Tage danach“, „am Tag“ oder ein Datum.
            </Text>
            <div className="portal-row">
              <Button icon="paste" onClick={() => navigator.clipboard.readText().then((t) => setImp({ text: t, antwort: null })).catch(() => setError('Die Zwischenablage ist nicht erreichbar – bitte mit Strg+V in das Feld einfügen.'))}>Aus Zwischenablage einfügen</Button>
              <Button icon="copy" design="Transparent" onClick={() => kopiere(alsTabelle(true), 'Kopfzeile kopiert – in Excel einfügen.')}>Kopfzeile als Ausgangstabelle kopieren</Button>
              {d.checklisten.length > 0 && <Button icon="copy" design="Transparent" onClick={() => kopiere(alsTabelle(false), 'Bestand kopiert – in Excel einfügen.')}>Bestand als Tabelle kopieren</Button>}
            </div>
            <TextArea rows={8} value={imp.text} placeholder={`${d.import_spalten.join('\t')}\nVereinsfest\tSommerfest\tGetränke bestellen\tThekenwart\t14 Tage vorher\tBestellliste vom Vorjahr`}
                      style={{ width: '100%', fontFamily: 'monospace' }} onInput={(e) => setImp({ text: e.target.value, antwort: null })} />
            {imp.antwort?.fehler.map((f) => <MessageStrip key={f} design="Negative" hideCloseButton>{f}</MessageStrip>)}
            {imp.antwort?.ergebnis && (
              <MessageStrip design={imp.antwort.uebernommen ? 'Positive' : 'Information'} hideCloseButton>
                {imp.antwort.uebernommen ? 'Übernommen: ' : imp.antwort.fehler.length ? 'Ohne die fehlerhaften Zeilen wären es: ' : 'Wird angelegt: '}
                {imp.antwort.ergebnis.kategorien.length} Kategorie{imp.antwort.ergebnis.kategorien.length === 1 ? '' : 'n'}, {imp.antwort.ergebnis.checklisten.length} neue Checkliste{imp.antwort.ergebnis.checklisten.length === 1 ? '' : 'n'}, {imp.antwort.ergebnis.schritte} Schritt{imp.antwort.ergebnis.schritte === 1 ? '' : 'e'}
                {imp.antwort.ergebnis.ergaenzt.length > 0 && ` · an bestehende Checklisten angefügt: ${imp.antwort.ergebnis.ergaenzt.join(', ')}`}
                {imp.antwort.kopfzeile && ' · erste Zeile als Spaltennamen erkannt'}
              </MessageStrip>
            )}
            {imp.antwort && imp.antwort.zeilen.length > 0 && !imp.antwort.uebernommen && (
              <div className="portal-tabrahmen" style={{ maxHeight: '32vh' }}>
                <table className="portal-cl__tab">
                  <thead><tr><th>Zeile</th>{d.import_spalten.map((x) => <th key={x}>{x}</th>)}</tr></thead>
                  <tbody>
                    {imp.antwort.zeilen.map((z) => (
                      <tr key={z.zeile}><td>{z.zeile}</td><td>{z.kategorie}</td><td>{z.checkliste}</td><td>{z.schritt}</td><td>{z.verantwortlich}</td><td>{terminWort(z)}</td><td>{z.hinweise}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="portal-row">
              <Button design={imp.antwort && !imp.antwort.fehler.length ? 'Default' : 'Emphasized'} disabled={busy || !imp.text.trim()} onClick={() => importieren(true)}>Prüfen</Button>
              <Button design="Emphasized" disabled={busy || !imp.antwort || imp.antwort.fehler.length > 0 || imp.antwort.uebernommen || !imp.antwort.zeilen.length} onClick={() => importieren(false)}>Übernehmen</Button>
              {imp.antwort && imp.antwort.fehler.length > 0 && <Text className="portal-muted">Übernommen wird erst, wenn keine Zeile mehr einen Fehler hat.</Text>}
            </div>
          </div>
        )}
      </ImportDialog>

      <ConfirmDialog open={!!frage} title={frage?.titel ?? ''} text={frage?.text ?? ''} confirmText="Ja" danger
                     onConfirm={() => { const f = frage; setFrage(null); if (f) tun(f.tun); }} onCancel={() => setFrage(null)} />
      <PdfDialog url={pdf} title={c ? `Checkliste ${c.titel}` : 'Checkliste'} filename={`Checkliste ${c?.titel ?? ''}.pdf`} onClose={() => setPdf(null)} />
    </AppPage>
  );
}
