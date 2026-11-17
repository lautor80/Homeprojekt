import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { feld } from '@core/components/Varianten';
import { useNavigate } from 'react-router-dom';
import {
  AnalyticalTable, Bar, Button, CheckBox, DatePicker, Dialog, FlexBox, Icon, Input, Label, Link, MessageStrip, ObjectStatus, Option, SegmentedButton,
  SegmentedButtonItem, Select, Text, Title,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api, qs } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { Filter, Filters, HeaderKpi } from '@core/components/Filters';
import { einstellungLink } from '@core/einstellungen';
import { useCan, useFunktion } from '@core/session';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { toast } from '@core/toast';
import { DocsDialog, InfoDialog, MailDialog, XRechnungDialog, type Doc, type MailRow, type XRes } from './dialogs';
import { MenuButton, T, betrag, dat, type KeyText, type ListRow } from './util';
import { ordnerBereit } from './ordner';
import { AblageOrdnerEinstellung } from './Ablageordner';
import { VersandDialog } from './VersandDialog';
import { symbole, terminText, type SymbolZustand } from './termin';

// Filter und Auswahl bleiben beim Wechsel ins Detail und zurück erhalten
const merk = {
  jahr: String(new Date().getFullYear()),
  fakt: 'ALL',
  status: 'OPEN' as 'ALL' | 'OPEN' | 'DONE' | 'CLOSED',
  suche: '',
  ansicht: 'LIST' as 'LIST' | 'TREE',
  zahlung: 'ALL' as ZahlungFilter,
  auswahl: new Set<string>(),
};

// Filter „Zahlung“ (Spalte Abrechnung, Recht transport.abrechnung:display)
type ZahlungFilter = 'ALL' | 'ANGELEGT' | 'OFFEN' | 'UEBERFAELLIG' | 'BEZAHLT';
const ZAHLUNG: { key: ZahlungFilter; text: string }[] = [
  { key: 'ALL', text: 'Alle' },
  { key: 'ANGELEGT', text: 'Nur angelegt' },
  { key: 'OFFEN', text: 'Abgerechnet, nicht bezahlt' },
  { key: 'UEBERFAELLIG', text: 'Zahlung überfällig' },
  { key: 'BEZAHLT', text: 'Bezahlt' },
];

/** Aussehen der Symbole angelegt · abgerechnet · bezahlt – Farben aus dem Theme, offen gestrichelt (nicht nur über die Farbe erkennbar) */
const SYMBOL_STIL: Record<SymbolZustand, CSSProperties> = {
  erledigt: { color: 'var(--sapInformativeColor, var(--sapInformationColor))', background: 'var(--sapInformationBackgroundColor)', border: '1px solid var(--sapInformationBorderColor)' },
  bezahlt: { color: 'var(--sapPositiveColor)', background: 'var(--sapSuccessBackground)', border: '1px solid var(--sapSuccessBorderColor)' },
  offen: { color: 'var(--sapContent_LabelColor)', background: 'transparent', border: '1px dashed var(--sapContent_LabelColor)' },
  ueberfaellig: { color: 'var(--sapCriticalColor)', background: 'var(--sapWarningBackground)', border: '1px solid var(--sapWarningBorderColor)' },
};
const SYMBOL_ICON = ['create-form', 'receipt', 'money-bills'];
const HINWEIS_FARBE: Partial<Record<SymbolZustand, string>> = { bezahlt: 'var(--sapPositiveTextColor)', ueberfaellig: 'var(--sapCriticalTextColor)' };

/** Zelle „Abrechnung“: drei Symbole, darunter ein kurzer Hinweis; Tooltip mit Datum bzw. Rechnungsnummer */
function AbrechnungZelle({ r }: { r: ListRow }) {
  if (!r.abrechnung) return null;
  const s = symbole(r.abrechnung, r.faktura, r.fakturadatum, r.anlagedatum);
  return (
    <FlexBox direction="Column" style={{ gap: '2px' }}>
      <FlexBox style={{ gap: '4px' }}>
        {s.symbole.map((x, i) => (
          <span key={i} role="img" aria-label={x.text} title={x.text}
                style={{ ...SYMBOL_STIL[x.zustand], display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 22, borderRadius: 6, boxSizing: 'border-box' }}>
            <Icon name={SYMBOL_ICON[i]} aria-hidden="true" style={{ width: 14, height: 14, color: 'inherit' }} />
          </span>
        ))}
      </FlexBox>
      <span style={{ fontSize: 'var(--sapFontSmallSize)', color: HINWEIS_FARBE[s.symbole[2].zustand] ?? 'var(--sapContent_LabelColor)', whiteSpace: 'nowrap' }}>{s.hinweis}</span>
    </FlexBox>
  );
}

/** Zelle „Route“: Orte, darunter Lade- und Entladezeit (Recht transport.ladezeiten:display) */
function RouteZelle({ r }: { r: ListRow }) {
  const laden = terminText(r.laden);
  const entladen = terminText(r.entladen);
  if (!laden && !entladen) return <Text>{r.route}</Text>;
  return (
    <FlexBox direction="Column" style={{ minWidth: 0 }}>
      <Text style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.route}</Text>
      <span className="portal-muted" style={{ fontSize: 'var(--sapFontSmallSize)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            title={`Laden ${laden || '–'} · Entladen ${entladen || '–'}`}>
        {laden && <><Icon name="arrow-top" aria-label="Laden" style={{ width: 12, height: 12, color: 'var(--sapInformativeColor, var(--sapInformationColor))', verticalAlign: 'middle' }} /> {laden}</>}
        {laden && entladen && <span style={{ margin: '0 0.5rem' }}>·</span>}
        {entladen && <><Icon name="arrow-bottom" aria-label="Entladen" style={{ width: 12, height: 12, color: 'var(--sapPositiveColor)', verticalAlign: 'middle' }} /> {entladen}</>}
      </span>
    </FlexBox>
  );
}

const FAKT: KeyText[] = [
  { key: 'ALL', text: 'Alle' },
  { key: '1', text: 'Seit Vortag' },
  { key: '30', text: 'Letzte 30 Tage' },
  { key: '90', text: 'Letzte 3 Monate' },
];

interface TreeRow {
  id: string;
  text: string;
  icon?: string;
  isPos: boolean;
  auftragsnr?: string;
  anlagedatum?: string | null;
  unternehmer?: string;
  route?: string;
  ladedatum?: string | null;
  rechnung?: string;
  rechnungState?: 'Positive' | 'Critical' | 'Information';
  einnahmen: number | null;
  ausgaben: number | null;
  saldo: number;
  subRows?: TreeRow[];
}

/**
 * Baumansicht: Ebene 1 = Auftragsart, Ebene 2 = Kunde, Ebene 3 = Aufträge (wie TREE_BUILD)
 *   Einnahmen = Rechnungsbetrag, Ausgaben = Frachtpreis EK, Saldo = Einnahmen - Ausgaben
 */
function baum(list: ListRow[]): { rows: TreeRow[]; saldo: number } {
  const arten = new Map<string, Map<string, ListRow[]>>();
  for (const r of list) {
    if (!arten.has(r.art)) arten.set(r.art, new Map());
    const k = arten.get(r.art)!;
    if (!k.has(r.kunde)) k.set(r.kunde, []);
    k.get(r.kunde)!.push(r);
  }
  let gesamt = 0;
  const rows: TreeRow[] = [...arten.entries()].sort(([a], [b]) => a.localeCompare(b, 'de')).map(([art, kunden]) => {
    let ein = 0;
    let aus = 0;
    let anz = 0;
    const sub = [...kunden.entries()].map(([kunde, pos]) => {
      const kEin = pos.reduce((s, p) => s + p.betrag, 0);
      const kAus = pos.reduce((s, p) => s + p.ek, 0);
      ein += kEin;
      aus += kAus;
      anz += pos.length;
      return {
        id: `${art}|${kunde}`,
        text: `${kunde || 'Ohne Kunde'} (${pos.length})`,
        icon: 'customer',
        isPos: false,
        einnahmen: kEin,
        ausgaben: kAus,
        saldo: kEin - kAus,
        subRows: [...pos].sort((a, b) => a.auftragsnr.localeCompare(b.auftragsnr)).map((p) => ({
          id: p.auftragsnr,
          text: p.auftragsnr,
          isPos: true,
          auftragsnr: p.auftragsnr,
          anlagedatum: p.anlagedatum,
          unternehmer: p.unternehmer,
          route: p.route,
          ladedatum: p.ladedatum,
          rechnung: p.faktura ? `Rechnung ${p.faktura} vom ${dat(p.fakturadatum)}` : p.status === 'Ohne Rechnung' ? `Ohne Rechnung abgeschlossen am ${dat(p.abgeschlossenAm)}` : 'Rechnung offen',
          rechnungState: p.faktura ? 'Positive' as const : p.status === 'Ohne Rechnung' ? 'Information' as const : 'Critical' as const,
          einnahmen: p.betrag || null,
          ausgaben: p.ek || null,
          saldo: p.betrag - p.ek,
        })),
      };
    }).sort((a, b) => a.text.localeCompare(b.text, 'de'));
    gesamt += ein - aus;
    return { id: art, text: `${art || 'Ohne Auftragsart'} (${anz})`, icon: 'shipping-status', isPos: false, einnahmen: ein, ausgaben: aus, saldo: ein - aus, subRows: sub };
  });
  return { rows, saldo: gesamt };
}

/**
 * Höhe bis zum unteren Fensterrand: Nur die Tabelle scrollt (visibleRowCountMode="Auto"),
 * Kopf und Spaltenüberschriften bleiben stehen – auch bei mehreren tausend Aufträgen.
 */
function useRestHoehe(deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  const [hoehe, setHoehe] = useState(480);
  useLayoutEffect(() => {
    const messen = () => {
      if (!ref.current) return;
      setHoehe(Math.max(320, Math.floor(window.innerHeight - ref.current.getBoundingClientRect().top - 24)));
    };
    messen();
    window.addEventListener('resize', messen);
    const ro = new ResizeObserver(messen);
    if (ref.current?.parentElement) ro.observe(ref.current.parentElement);
    return () => { window.removeEventListener('resize', messen); ro.disconnect(); };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { ref, hoehe };
}

const Saldo = ({ v }: { v: number }) => <ObjectStatus state={v < 0 ? 'Negative' : 'Positive'}><b>{betrag(v)} EUR</b></ObjectStatus>;

export function AuftraegeListe() {
  const navigate = useNavigate();
  const can = useCan();
  // Sammelversand „Versenden…“ über Outlook 365 (Funktion transport.versand.sammel); aus = bisheriges Menü „Versenden“ (EML je Dokument)
  const sammelversand = useFunktion()('transport.versand.sammel');
  const [jahre, setJahre] = useState<KeyText[]>([]);
  const [jahr, setJahr] = useState(merk.jahr);
  const [fakt, setFakt] = useState(merk.fakt);
  const [status, setStatus] = useState(merk.status);
  const [suche, setSuche] = useState(merk.suche);
  const [ansicht, setAnsicht] = useState(merk.ansicht);
  const [zahlung, setZahlung] = useState<ZahlungFilter>(merk.zahlung);
  // Spalte „Abrechnung“, Filter „Zahlung“ und Lade-/Entladezeiten: Recht + Funktionsschalter (Funktion aus = Recht nicht vorhanden)
  const mitAbrechnung = can('transport.abrechnung:display');
  const mitZeiten = can('transport.ladezeiten:display');
  const [basis, setBasis] = useState<ListRow[]>([]);
  const [auswahl, setAuswahlState] = useState<Set<string>>(merk.auswahl);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [firmaFehlt, setFirmaFehlt] = useState(false);
  const [baumEbene, setBaumEbene] = useState<'auf' | 'zu' | null>(null);

  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [mails, setMails] = useState<{ art: 'T' | 'L' | 'R'; rows: MailRow[] } | null>(null);
  const [versand, setVersand] = useState<string[] | null>(null);
  const [xr, setXr] = useState<XRes | null>(null);
  const [info, setInfo] = useState<{ title: string; text: string } | null>(null);
  const treeRef = useRef<{ toggleAllRowsExpanded?: (v: boolean) => void } | null>(null);
  const rahmen = useRestHoehe([ansicht, firmaFehlt, !!error]);

  const setAuswahl = (s: Set<string>) => {
    merk.auswahl = s;
    setAuswahlState(s);
  };

  const ladeInit = useCallback(async () => {
    const r = await api.get<{ jahre: KeyText[]; firmaUnvollstaendig: boolean }>(`${T}/init`);
    setJahre([...r.jahre, { key: 'ALL', text: 'Alle Jahre' }]);
    setFirmaFehlt(r.firmaUnvollstaendig);
    if (!r.jahre.some((j) => j.key === merk.jahr) && merk.jahr !== 'ALL') {
      merk.jahr = r.jahre.length ? 'ALL' : merk.jahr;
      setJahr(merk.jahr);
    }
  }, []);

  const lade = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setBasis(await api.get<ListRow[]>(`${T}/auftraege${qs({ jahr: merk.jahr, fakt: merk.fakt })}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    ladeInit().catch((e) => setError(e.message));
  }, [ladeInit]);
  useEffect(() => {
    merk.jahr = jahr;
    merk.fakt = fakt;
    lade();
  }, [jahr, fakt, lade]);
  useEffect(() => {
    merk.status = status;
    merk.suche = suche;
    merk.ansicht = ansicht;
    merk.zahlung = zahlung;
  }, [status, suche, ansicht, zahlung]);

  // Status- und Suchfilter (wie LIST_FILTER)
  const liste = useMemo(() => {
    const q = suche.trim().toUpperCase();
    return basis.filter((r) => {
      // „Offen“ = weder Rechnung noch ohne Rechnung abgeschlossen (ersetzt das frühere Ausbuchen mit 0 Euro)
      if (status === 'OPEN' && r.status !== 'Offen') return false;
      if (status === 'DONE' && !r.faktura) return false;
      if (status === 'CLOSED' && r.status !== 'Ohne Rechnung') return false;
      if (mitAbrechnung && zahlung !== 'ALL' && r.abrechnung) {
        const z = r.abrechnung.status;
        if (zahlung === 'ANGELEGT' && z !== 'angelegt') return false;
        if (zahlung === 'OFFEN' && z !== 'abgerechnet' && z !== 'ueberfaellig') return false;
        if (zahlung === 'UEBERFAELLIG' && z !== 'ueberfaellig') return false;
        if (zahlung === 'BEZAHLT' && z !== 'bezahlt') return false;
      }
      if (q && !`${r.auftragsnr} ${r.kennzeichen ?? ''} ${r.kunde} ${r.unternehmer} ${r.unternehmerNamen ?? ''} ${r.route} ${r.faktura ?? ''}`.toUpperCase().includes(q)) return false;
      return true;
    });
  }, [basis, status, suche, zahlung, mitAbrechnung]);

  const summe = useMemo(() => liste.reduce((s, r) => ({ ek: s.ek + r.ek, vk: s.vk + r.vk, betrag: s.betrag + r.betrag }), { ek: 0, vk: 0, betrag: 0 }), [liste]);
  const sel = useMemo(() => liste.filter((r) => auswahl.has(r.auftragsnr)), [liste, auswahl]);
  const offen = sel.filter((r) => r.status === 'Offen').length;
  const ohneRechnung = sel.filter((r) => r.status === 'Ohne Rechnung').length;
  const zahlbar = sel.filter((r) => r.faktura && r.abrechnung && r.abrechnung.status !== 'bezahlt').length;
  const bezahlt = sel.filter((r) => r.faktura && r.abrechnung?.status === 'bezahlt').length;
  const tree = useMemo(() => baum(liste), [liste]);

  useEffect(() => {
    if (baumEbene && treeRef.current?.toggleAllRowsExpanded) treeRef.current.toggleAllRowsExpanded(baumEbene === 'auf');
  }, [baumEbene, tree]);

  const [ordnerDialog, setOrdnerDialog] = useState(false);

  // ---------------------------------------------------------------- Aktionen
  async function rechnungen(sammel: boolean) {
    try {
      await ordnerBereit(true); // Ablageordner: Zugriff jetzt (beim Klick) erfragen
      const nrs = sel.filter((s) => s.status === 'Offen').map((s) => s.auftragsnr).sort(); // Server vergibt die Nummern in dieser Reihenfolge
      const r = await api.post<{ fakturen: string[]; ignoriert: number }>(`${T}/rechnungen`, { auftraege: sel.map((s) => s.auftragsnr), sammel });
      setAuswahl(new Set());
      await lade();
      await ladeInit();
      if (r.ignoriert) toast(`Aufgrund bereits bestehender Rechnungen wurden ${r.ignoriert} Aufträge nicht bearbeitet.`);
      // Einzelrechnungen: je Auftrag eine Rechnung (gleiche Reihenfolge), Sammelrechnung: in jeden Auftragsordner
      setDocs(r.fakturen.map((f, i) => ({ url: `${T}/pdf/R/${encodeURIComponent(f)}`, filename: `Rechnung_${f}.pdf`, ablage: sammel ? nrs : nrs[i] ? [nrs[i]] : [] })));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Rechnungen entfernen (#170, Recht transport.rechnungen:delete): erst prüfen, was betroffen ist, dann mit Grund bestätigen
  const [entfernen, setEntfernen] = useState<{ text: string; nrs: string[] } | null>(null);
  async function entfernenPruefen() {
    try {
      const nrs = sel.map((s) => s.auftragsnr);
      const r = await api.post<{ rechnungen: { faktura: string; auftraege: string[] }[]; zusaetzlich: string[] }>(`${T}/rechnungen/entfernen`, { auftraege: nrs, pruefen: true });
      if (!r.rechnungen.length) return toast('Unter der Auswahl ist kein fakturierter Auftrag.');
      const liste = r.rechnungen.map((x) => `${x.faktura} (Auftrag ${x.auftraege.join(', ')})`).join('; ');
      setEntfernen({
        nrs,
        text: `${r.rechnungen.length === 1 ? 'Rechnung' : `${r.rechnungen.length} Rechnungen`} ${liste} werden aus der Datenbank entfernt; die Aufträge sind danach wieder offen.`
          + (r.zusaetzlich.length ? ` Achtung: Sammelrechnung – auch Auftrag ${r.zusaetzlich.join(', ')} wird wieder offen.` : '')
          + ' Die Rechnungsnummer wird nicht neu vergeben. Bereits versendete oder in Paperless abgelegte Rechnungen bleiben dort bestehen.',
      });
    } catch (e) { setError((e as Error).message); }
  }
  // Ohne Rechnung abschließen / wieder öffnen (Recht transport.auftraege:edit)
  const [abschliessen, setAbschliessen] = useState<string[] | null>(null);
  async function abschliessenAusfuehren(grund: string) {
    const nrs = abschliessen ?? [];
    setAbschliessen(null);
    try {
      const r = await api.post<{ abgeschlossen: string[] }>(`${T}/auftraege/abschliessen`, { auftraege: nrs, grund });
      setAuswahl(new Set());
      await lade();
      toast(`${r.abgeschlossen.length === 1 ? `Auftrag ${r.abgeschlossen[0]}` : `${r.abgeschlossen.length} Aufträge`} ohne Rechnung abgeschlossen – zu finden unter Status „Ohne Rechnung“.`, 6000);
    } catch (e) { setError((e as Error).message); }
  }
  async function oeffnen() {
    try {
      const r = await api.post<{ geoeffnet: string[] }>(`${T}/auftraege/oeffnen`, { auftraege: sel.filter((s) => s.status === 'Ohne Rechnung').map((s) => s.auftragsnr) });
      setAuswahl(new Set());
      await lade();
      toast(`${r.geoeffnet.length === 1 ? `Auftrag ${r.geoeffnet[0]} ist` : `${r.geoeffnet.length} Aufträge sind`} wieder offen.`);
    } catch (e) { setError((e as Error).message); }
  }

  // Zusammenführen: mehrere offene Aufträge desselben Transports werden ein Auftrag mit mehreren Fahrten – erst prüfen, dann bestätigen
  const [zusammen, setZusammen] = useState<{ text: string; nrs: string[] } | null>(null);
  async function zusammenPruefen() {
    try {
      const nrs = sel.filter((s) => s.status === 'Offen').map((s) => s.auftragsnr);
      const r = await api.post<{ ziel: string; quellen: string[]; fehler: string[]; hinweise: string[]; fahrten: number }>(`${T}/auftraege/zusammenfuehren`, { auftraege: nrs, pruefen: true });
      if (r.fehler.length) return setError(`Zusammenführen nicht möglich: ${r.fehler.join(' ')}`);
      setZusammen({
        nrs,
        text: `Auftrag ${r.ziel} bleibt und hat danach ${r.fahrten} Fahrten. ${r.quellen.length === 1 ? `Auftrag ${r.quellen[0]} wird` : `Die Aufträge ${r.quellen.join(', ')} werden`} zu Fahrten von ${r.ziel} `
          + '(Unternehmer, Kennzeichen, Fahrzeugtyp, Frachtpreis VK, Ladedatum); Frachtpreis EK wird addiert, Besonderheiten und zugeordnete Dokumente ziehen um. '
          + `${r.quellen.length === 1 ? 'Der Auftrag entfällt' : 'Die Aufträge entfallen'} danach als eigene Aufträge – die ${r.quellen.length === 1 ? 'Nummer wird' : 'Nummern werden'} nicht neu vergeben, `
          + 'Dateien im Ablageordner bleiben dort liegen. Das lässt sich nicht automatisch rückgängig machen.'
          + (r.hinweise.length ? ` Hinweis: ${r.hinweise.join(' ')}` : ''),
      });
    } catch (e) { setError((e as Error).message); }
  }
  async function zusammenAusfuehren() {
    const nrs = zusammen?.nrs ?? [];
    setZusammen(null);
    try {
      const r = await api.post<{ ziel: string; fahrten: number }>(`${T}/auftraege/zusammenfuehren`, { auftraege: nrs });
      setAuswahl(new Set());
      await lade();
      await ladeInit();
      toast(`Auftrag ${r.ziel} hat jetzt ${r.fahrten} Fahrten.`, 6000);
    } catch (e) { setError((e as Error).message); }
  }

  // Zahlungseingang (Recht transport.zahlungen:edit): Datum wählen, gilt für die ganze Rechnung (auch Sammelrechnung)
  const [zahlDialog, setZahlDialog] = useState<string | null>(null);
  async function zahlungSetzen(bezahltAm: string | null) {
    setZahlDialog(null);
    try {
      const nrs = sel.filter((s) => s.faktura && (bezahltAm ? s.abrechnung?.status !== 'bezahlt' : s.abrechnung?.status === 'bezahlt')).map((s) => s.auftragsnr);
      const r = await api.post<{ rechnungen: string[]; auftraege: string[] }>(`${T}/zahlungen`, { auftraege: nrs, bezahltAm });
      setAuswahl(new Set());
      await lade();
      toast(`${r.rechnungen.length === 1 ? `Rechnung ${r.rechnungen[0]}` : `${r.rechnungen.length} Rechnungen`} ${bezahltAm ? `als bezahlt am ${dat(bezahltAm)} erfasst` : '– Zahlung zurückgenommen'}.`, 6000);
    } catch (e) { setError((e as Error).message); }
  }

  async function entfernenAusfuehren(grund: string) {
    const nrs = entfernen?.nrs ?? [];
    setEntfernen(null);
    try {
      const r = await api.post<{ rechnungen: { faktura: string }[] }>(`${T}/rechnungen/entfernen`, { auftraege: nrs, grund });
      setAuswahl(new Set());
      await lade();
      toast(`Rechnung ${r.rechnungen.map((x) => x.faktura).join(', ')} entfernt – Aufträge wieder offen.`, 6000);
    } catch (e) { setError((e as Error).message); }
  }

  async function drucken(art: 'T' | 'L' | 'R') {
    if (!sel.length) return toast('Bitte mindestens einen Auftrag auswählen.');
    await ordnerBereit(true); // Ablageordner: Zugriff jetzt (beim Klick) erfragen
    if (art === 'R') {
      const f = [...new Set(sel.filter((s) => s.faktura).map((s) => s.faktura!))];
      if (!f.length) return toast('Unter der Auswahl ist kein fakturierter Auftrag.');
      return setDocs(f.map((x) => ({
        url: `${T}/pdf/R/${encodeURIComponent(x)}`, filename: `Rechnung_${x}.pdf`,
        // in den Ordner jedes Auftrags der Rechnung – auch der nicht markierten (Sammelrechnung)
        ablage: [...new Set([...liste.filter((s) => s.faktura === x), ...sel.filter((s) => s.faktura === x)].map((s) => s.auftragsnr))],
      })));
    }
    // Transportauftrag: bei mehreren Fahrten je Fahrt ein PDF (Nummer „Auftrag-Fahrt“), abgelegt im Ordner des Auftrags
    setDocs(sel.flatMap((s) => (art === 'T' && s.fahrten > 1 ? Array.from({ length: s.fahrten }, (_, i) => `${s.auftragsnr}-${i + 1}`) : [s.auftragsnr]).map((id) => ({
      url: `${T}/pdf/${art}/${encodeURIComponent(id)}`,
      filename: `${art === 'T' ? 'Transportauftrag' : 'Lieferschein'}_${id}.pdf`,
      ablage: [s.auftragsnr],
    }))));
  }

  async function versenden(art: 'T' | 'L' | 'R') {
    const s = art === 'R' ? sel.filter((x) => x.faktura) : sel;
    if (!s.length) return toast(art === 'R' ? 'Unter der Auswahl ist kein fakturierter Auftrag.' : 'Bitte mindestens einen Auftrag auswählen.');
    try {
      setMails({ art, rows: await api.post<MailRow[]>(`${T}/mails`, { art, auftraege: s.map((x) => x.auftragsnr) }) });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function erechnung() {
    const offenNr = sel.filter((s) => !s.faktura).map((s) => s.auftragsnr);
    const fakturen = [...new Set(sel.filter((s) => s.faktura).map((s) => s.faktura!))];
    if (!fakturen.length) {
      return setInfo({ title: 'E-Rechnung', text: offenNr.length
        ? `Markiert ${offenNr.length === 1 ? 'ist' : 'sind'} nur nicht fakturierte Aufträge: ${offenNr.join(', ')}. Eine E-Rechnung gibt es erst nach der Rechnungserstellung.`
        : 'Bitte eine fakturierte Rechnung markieren.' });
    }
    if (fakturen.length > 1) {
      return setInfo({ title: 'E-Rechnung', text: `Es sind ${fakturen.length} Rechnungen markiert: ${sel.filter((s) => s.faktura).map((s) => `${s.faktura} (Auftrag ${s.auftragsnr})`).join(', ')}. Bitte nur eine Rechnung markieren.` });
    }
    try {
      const r = await api.get<XRes>(`${T}/xrechnung/${encodeURIComponent(fakturen[0])}`);
      const markiert = sel.filter((s) => s.faktura === fakturen[0]).length;
      if (r.anzahlAuftraege > markiert) {
        r.hinweise.unshift(`Rechnung ${r.faktura} ist eine Sammelrechnung über ${r.anzahlAuftraege} Aufträge - die E-Rechnung enthält wie die PDF-Rechnung alle ${r.anzahlAuftraege} Aufträge.`);
      }
      setXr(r);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function paperless() {
    const f = [...new Set(sel.filter((s) => s.faktura).map((s) => s.faktura!))];
    if (!f.length) return toast('Unter der Auswahl ist kein fakturierter Auftrag.');
    try {
      const r = await api.post<{ faktura: string; ok: boolean; message: string }[]>(`${T}/paperless`, { fakturen: f });
      setInfo({ title: 'Paperless', text: r.map((x) => `${x.faktura}: ${x.message}`).join('\n') });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // ---------------------------------------------------------------- Tabelle
  const columns: AnalyticalTableColumnDefinition[] = useMemo(() => [
    { Header: 'Status', accessor: 'status', id: 'status', width: 110, disableGroupBy: false },
    {
      Header: 'Auftrag', accessor: 'auftragsnr', width: 120, disableGroupBy: true,
      Cell: ({ row }: Cell) => row.isGrouped ? null : <div><b>{row.original.auftragsnr}</b><br /><Text>{row.original.fahrten > 1 ? `${row.original.fahrten} Fahrten` : row.original.kennzeichen}</Text></div>,
    },
    { Header: 'Art', accessor: 'art', width: 85, responsiveMinWidth: 1350 },
    { Header: 'Angelegt', accessor: 'anlagedatum', width: 95, responsiveMinWidth: 1450, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Kunde', accessor: 'kunde', minWidth: 120 },
    { Header: 'Unternehmer', accessor: 'unternehmer', minWidth: 110, responsiveMinWidth: 1250 },
    {
      Header: mitZeiten ? 'Route · Laden / Entladen' : 'Route', accessor: 'route', minWidth: mitZeiten ? 260 : 140,
      Cell: ({ row }: Cell) => row.isGrouped ? null : <RouteZelle r={row.original} />,
    },
    // Ladedatum steht mit Lade-/Entladezeiten schon in der Spalte Route
    ...(mitZeiten ? [] : [{ Header: 'Ladedatum', accessor: 'ladedatum', width: 95, responsiveMinWidth: 1150, Cell: ({ value }: Cell) => dat(value) }]),
    { Header: 'Fracht EK', accessor: 'ek', width: 105, hAlign: 'End', disableGroupBy: true, Cell: ({ row }: Cell) => row.isGrouped ? null : `${betrag(row.original.ek)} EUR` },
    { Header: 'Fracht VK', accessor: 'vk', width: 105, responsiveMinWidth: 1350, hAlign: 'End', disableGroupBy: true, Cell: ({ row }: Cell) => row.isGrouped ? null : `${betrag(row.original.vk)} EUR` },
    { Header: 'Betrag', accessor: 'betrag', width: 115, hAlign: 'End', disableGroupBy: true, Cell: ({ row }: Cell) => row.isGrouped ? null : <b>{betrag(row.original.betrag)} EUR</b> },
    {
      Header: 'Rechnung', accessor: 'faktura', width: 175, disableGroupBy: true,
      Cell: ({ row }: Cell) => row.isGrouped ? null : (
        <FlexBox direction="Column">
          <ObjectStatus state={row.original.faktura ? 'Positive' : row.original.status === 'Ohne Rechnung' ? 'Information' : 'Critical'}
                        title={row.original.abgeschlossenGrund ?? undefined}>
            {row.original.faktura ? `${row.original.faktura} vom ${dat(row.original.fakturadatum)}`
              : row.original.status === 'Ohne Rechnung' ? `ohne Rechnung, ${dat(row.original.abgeschlossenAm)}` : 'offen'}
          </ObjectStatus>
          {row.original.dokFehlen && <ObjectStatus state="Critical" icon={<Icon name="alert" />}>Dokumente fehlen</ObjectStatus>}
        </FlexBox>
      ),
    },
    ...(mitAbrechnung ? [{
      Header: 'Abrechnung', id: 'abrechnung', accessor: (r: ListRow) => r.abrechnung?.status ?? '', width: 120, disableGroupBy: true,
      headerTooltip: 'angelegt · abgerechnet · bezahlt – überfällig erst 3 Tage nach Fälligkeit; ohne Rechnung abgeschlossen gilt als bezahlt',
      Cell: ({ row }: Cell) => row.isGrouped ? null : <AbrechnungZelle r={row.original} />,
    }] : []),
  ], [mitZeiten, mitAbrechnung]);

  const groupBy = useMemo(() => ['status'], []);
  const selectedRowIds = useMemo(() => Object.fromEntries([...auswahl].map((k) => [k, true])), [auswahl]);
  const tableOptions = useMemo(() => ({
    getRowId: (r: ListRow) => r.auftragsnr,
    autoResetExpanded: false,
    initialState: { groupBy: ['status'], expanded: { 'status:Offen': true, 'status:Fakturiert': true, 'status:Ohne Rechnung': true } },
  }), []);

  const treeColumns: AnalyticalTableColumnDefinition[] = useMemo(() => [
    {
      Header: 'Art / Kunde / Auftrag', accessor: 'text', minWidth: 300,
      Cell: ({ row }: Cell) => {
        const r = row.original as TreeRow;
        return (
          <FlexBox alignItems="Center" style={{ gap: '0.25rem' }}>
            {r.isPos && (
              <CheckBox checked={auswahl.has(r.auftragsnr!)} onChange={(e) => {
                const s = new Set(auswahl);
                if (e.target.checked) s.add(r.auftragsnr!); else s.delete(r.auftragsnr!);
                setAuswahl(s);
              }} />
            )}
            {r.icon && <Icon name={r.icon} style={{ marginRight: '0.25rem' }} />}
            <FlexBox direction="Column">
              {r.isPos ? <Link onClick={() => navigate(`/transport/auftraege/${r.auftragsnr}`)}>{r.text}</Link> : <Text><b>{r.text}</b></Text>}
              {r.rechnung && <ObjectStatus state={r.rechnungState} icon={<Icon name={r.rechnungState === 'Positive' ? 'receipt' : 'money-bills'} />}>{r.rechnung}</ObjectStatus>}
            </FlexBox>
          </FlexBox>
        );
      },
    },
    { Header: 'Angelegt', accessor: 'anlagedatum', width: 95, responsiveMinWidth: 1450, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Unternehmer', accessor: 'unternehmer', width: 180 },
    { Header: 'Route', accessor: 'route', width: 230 },
    { Header: 'Ladedatum', accessor: 'ladedatum', width: 100, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Einnahmen', accessor: 'einnahmen', width: 120, hAlign: 'End', Cell: ({ value }: Cell) => (value ? betrag(value) : '') },
    { Header: 'Ausgaben', accessor: 'ausgaben', width: 120, hAlign: 'End', Cell: ({ value }: Cell) => (value ? betrag(value) : '') },
    { Header: 'Saldo', accessor: 'saldo', width: 150, hAlign: 'End', Cell: ({ value }: Cell) => <Saldo v={value} /> },
  ], [auswahl, navigate]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ebene 1 (Auftragsart) ist beim Öffnen aufgeklappt
  const treeOptions = useMemo(() => ({
    autoResetExpanded: false,
    getRowId: (r: TreeRow) => r.id,
    initialState: { expanded: { Fracht: true, 'Holzträger': true } },
  }), []);

  // ---------------------------------------------------------------- Kopf
  const header = (
    <Filters>
      <Filter label="Geschäftsjahr" width="11rem">
        <Select style={{ width: '100%' }} onChange={(e) => setJahr(e.detail.selectedOption.dataset.key!)}>
          {jahre.map((j) => <Option key={j.key} data-key={j.key} selected={j.key === jahr}>{j.text}</Option>)}
          {!jahre.some((j) => j.key === jahr) && <Option data-key={jahr} selected>{jahr}</Option>}
        </Select>
      </Filter>
      <Filter label="Fakturadatum" width="11rem">
        <Select style={{ width: '100%' }} onChange={(e) => setFakt(e.detail.selectedOption.dataset.key!)}>
          {FAKT.map((f) => <Option key={f.key} data-key={f.key} selected={f.key === fakt}>{f.text}</Option>)}
        </Select>
      </Filter>
      <Filter label="Status">
        <SegmentedButton onSelectionChange={(e) => setStatus((e.detail.selectedItems[0] as HTMLElement).dataset.key as typeof status)}>
          <SegmentedButtonItem data-key="ALL" selected={status === 'ALL'}>Alle</SegmentedButtonItem>
          <SegmentedButtonItem data-key="OPEN" selected={status === 'OPEN'}>Offen</SegmentedButtonItem>
          <SegmentedButtonItem data-key="DONE" selected={status === 'DONE'}>Fakturiert</SegmentedButtonItem>
          <SegmentedButtonItem data-key="CLOSED" selected={status === 'CLOSED'}>Ohne Rechnung</SegmentedButtonItem>
        </SegmentedButton>
      </Filter>
      {mitAbrechnung && (
        <Filter label="Zahlung" width="13rem">
          <Select style={{ width: '100%' }} onChange={(e) => setZahlung(e.detail.selectedOption.dataset.key as ZahlungFilter)}>
            {ZAHLUNG.map((f) => <Option key={f.key} data-key={f.key} selected={f.key === zahlung}>{f.text}</Option>)}
          </Select>
        </Filter>
      )}
      <Filter label="Suche" width="min(20rem, 100%)">
        <Input style={{ width: '100%' }} placeholder="Auftrag, Kunde, Kennzeichen, Ort …" value={suche} showClearIcon
               icon={<Icon name="search" />} onInput={(e) => setSuche(e.target.value)} />
      </Filter>
      <HeaderKpi label="Frachtpreis EK" value={`${betrag(summe.ek)} €`} />
      <HeaderKpi label="Frachtpreis VK" value={`${betrag(summe.vk)} €`} />
      <HeaderKpi label="Rechnungsbetrag" value={`${betrag(summe.betrag)} €`} />
      {ansicht === 'TREE' && <HeaderKpi label="Saldo" value={`${betrag(tree.saldo)} €`} state={tree.saldo < 0 ? 'Negative' : 'Positive'} />}
    </Filters>
  );

  const toolbar = (
    <Bar
      startContent={<>
        <Title level="H5">Aufträge ({liste.length.toLocaleString('de-DE')})</Title>
        {sel.length > 0 && (
          <span className="portal-muted" style={{ whiteSpace: 'nowrap' }}>
            · {sel.length} ausgewählt{offen ? `, davon ${offen} offen` : ''}
            {' '}<Link onClick={() => setAuswahl(new Set())}>Auswahl aufheben</Link>
          </span>
        )}
      </>}
      endContent={<>
        <Button design="Transparent" icon="open-folder" tooltip="Mein Ablageordner auf diesem PC: Ordner für Ausdrucke und abgelegte Dateien festlegen" onClick={() => setOrdnerDialog(true)}>Ablageordner</Button>
        <SegmentedButton onSelectionChange={(e) => setAnsicht((e.detail.selectedItems[0] as HTMLElement).dataset.key as typeof ansicht)}>
          <SegmentedButtonItem data-key="LIST" icon="list" selected={ansicht === 'LIST'} />
          <SegmentedButtonItem data-key="TREE" icon="tree" selected={ansicht === 'TREE'} />
        </SegmentedButton>
        {ansicht === 'TREE' && <>
          <Button icon="expand-all" design="Transparent" onClick={() => setBaumEbene('auf')} />
          <Button icon="collapse-all" design="Transparent" onClick={() => setBaumEbene('zu')} />
        </>}
        {can('transport.auftraege:edit') && (
          <MenuButton text="Neu" icon="create" design="Emphasized" items={[
            { text: 'Frachtauftrag', icon: 'shipping-status', onClick: () => navigate('/transport/auftraege/neu/F') },
            { text: 'Holzträgerauftrag', icon: 'product', onClick: () => navigate('/transport/auftraege/neu/H') },
          ]} />
        )}
        {can('transport.auftraege:edit') && (
          <MenuButton text="Auftrag" icon="shipping-status" disabled={!sel.length} items={[
            { text: 'Zusammenführen (mehrere Fahrten) …', icon: 'combine', disabled: offen < 2, onClick: zusammenPruefen },
            { text: 'Ohne Rechnung abschließen …', icon: 'complete', disabled: offen < 1, onClick: () => setAbschliessen(sel.filter((s) => s.status === 'Offen').map((s) => s.auftragsnr)) },
            { text: 'Wieder öffnen', icon: 'undo', disabled: ohneRechnung < 1, onClick: oeffnen },
          ]} />
        )}
        {can('transport.rechnungen:create') && <>
          <Button icon="lead" disabled={offen < 1} onClick={() => rechnungen(false)}>Einzelrechnungen</Button>
          <Button icon="collections-insight" disabled={offen < 2} onClick={() => rechnungen(true)}>Sammelrechnung</Button>
        </>}
        {can('transport.rechnungen:delete') && (
          <Button icon="delete" design="Transparent" disabled={sel.length - offen < 1} onClick={entfernenPruefen} tooltip="Rechnung der ausgewählten Aufträge entfernen">Rechnung entfernen</Button>
        )}
        {can('transport.zahlungen:edit') && (
          <MenuButton text="Zahlung" icon="money-bills" disabled={!zahlbar && !bezahlt} items={[
            { text: 'Als bezahlt markieren …', icon: 'accept', disabled: zahlbar < 1, onClick: () => setZahlDialog(new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)) },
            { text: 'Zahlung zurücknehmen', icon: 'undo', disabled: bezahlt < 1, onClick: () => zahlungSetzen(null) },
          ]} />
        )}
        <MenuButton text="Drucken" icon="print" disabled={!sel.length} items={[
          { text: 'Transportauftrag', icon: 'shipping-status', onClick: () => drucken('T') },
          { text: 'Lieferschein', icon: 'document-text', onClick: () => drucken('L') },
          { text: 'Rechnung', icon: 'lead', onClick: () => drucken('R') },
        ]} />
        {sammelversand && can('transport.versand:execute') && (
          <Button icon="paper-plane" disabled={!sel.length} onClick={() => setVersand(sel.map((s) => s.auftragsnr))}
                  tooltip="Ausgewählte Dokumente als E-Mails je Auftrag und Empfänger über Outlook 365">Versenden…</Button>
        )}
        {sammelversand ? (
          <MenuButton text="E-Rechnung / Paperless" icon="attachment-text-file" disabled={!sel.length || !can('transport.versand:execute')} items={[
            { text: 'E-Rechnung (ZUGFeRD / XRechnung)', icon: 'attachment-text-file', onClick: erechnung },
            { text: 'Rechnung an Paperless senden', icon: 'cloud', onClick: paperless },
          ]} />
        ) : (
          <MenuButton text="Versenden" icon="email" disabled={!sel.length || !can('transport.versand:execute')} items={[
            { text: 'Transportauftrag versenden', onClick: () => versenden('T') },
            { text: 'Lieferschein versenden', onClick: () => versenden('L') },
            { text: 'Rechnung versenden', onClick: () => versenden('R') },
            { text: 'E-Rechnung (ZUGFeRD / XRechnung)', icon: 'attachment-text-file', onClick: erechnung },
            { text: 'Rechnung an Paperless senden', icon: 'cloud', onClick: paperless },
          ]} />
        )}
      </>}
    />
  );

  return (
    <AppPage varianten={{ repid: 'transport.auftraege', ansicht: { jahr, fakt, status, suche, ansicht, zahlung }, onAnwenden: (a) => { setJahr(feld(a, 'jahr', jahr)); setFakt(feld(a, 'fakt', fakt)); setStatus(feld(a, 'status', status)); setSuche(feld(a, 'suche', suche)); setAnsicht(feld(a, 'ansicht', ansicht)); setZahlung(feld(a, 'zahlung', zahlung)); } }} title="Auftragsverwaltung" header={header}>
      {firmaFehlt && can('transport.stammdaten:edit') && (
        <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.5rem' }}>
          Firmendaten (Name, Bank) fehlen noch – sie werden für Rechnungen und E-Rechnungen benötigt:
          {' '}<Link onClick={() => navigate(einstellungLink('transport', 'firma'))}>Einstellungen öffnen</Link>
        </MessageStrip>
      )}
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <Dialog open={ordnerDialog} headerText="Ablageordner" onClose={() => setOrdnerDialog(false)} footer={<Bar endContent={<Button onClick={() => setOrdnerDialog(false)}>Schließen</Button>} />}>
        <div style={{ width: 'min(46rem, 88vw)' }}>{ordnerDialog && <AblageOrdnerEinstellung />}</div>
      </Dialog>
      {toolbar}
      <div ref={rahmen.ref} style={{ height: rahmen.hoehe }}>
      {ansicht === 'LIST' ? (
        <AnalyticalTable minRows={1}
          columns={columns}
          data={liste}
          loading={loading}
          groupBy={groupBy}
          groupable
          sortable
          filterable
          selectionMode="Multiple"
          selectionBehavior="RowSelector"
          selectedRowIds={selectedRowIds}
          reactTableOptions={tableOptions}
          onRowSelect={(e) => setAuswahl(new Set(Object.keys(e.detail.selectedRowIds).filter((k) => e.detail.selectedRowIds[k] && !k.includes(':'))))}
          onRowClick={(e) => {
            const r = e.detail.row;
            if (!r.isGrouped && (e.target as HTMLElement).closest('[data-column-id-cell="__ui5wcr__internal_selection_column"]') === null) {
              navigate(`/transport/auftraege/${r.original.auftragsnr}`);
            }
          }}
          rowHeight={52}
          visibleRowCountMode="Auto"
          noDataText="Keine Aufträge für die Auswahl"
        />
      ) : (
        <AnalyticalTable minRows={1}
          columns={treeColumns}
          data={tree.rows}
          isTreeTable
          loading={loading}
          tableInstance={treeRef as never}
          reactTableOptions={treeOptions}
          rowHeight={52}
          visibleRowCountMode="Auto"
          noDataText="Keine Aufträge für die Auswahl"
        />
      )}
      </div>

      <DocsDialog docs={docs} onClose={() => setDocs(null)} />
      <MailDialog art={mails?.art ?? 'T'} mails={mails?.rows ?? null} onClose={() => setMails(null)} />
      <VersandDialog auftraege={versand ?? []} open={!!versand} onClose={() => setVersand(null)} />
      <XRechnungDialog data={xr} onClose={() => setXr(null)} />
      <InfoDialog title={info?.title ?? ''} text={info?.text ?? null} onClose={() => setInfo(null)} />
      <ConfirmDialog open={!!abschliessen} title="Ohne Rechnung abschließen" confirmText="Abschließen" askReason
                     text={`${abschliessen?.length === 1 ? `Auftrag ${abschliessen[0]} bekommt` : `${abschliessen?.length ?? 0} Aufträge (${(abschliessen ?? []).join(', ')}) bekommen`} keine Rechnung und ${abschliessen?.length === 1 ? 'gilt' : 'gelten'} nicht mehr als offen. Nichts wird gelöscht – „Auftrag → Wieder öffnen“ macht es rückgängig. Der Grund steht im Änderungsbeleg und in der Liste.`}
                     onConfirm={abschliessenAusfuehren} onCancel={() => setAbschliessen(null)} />
      <ConfirmDialog open={!!zusammen} title="Aufträge zusammenführen" text={zusammen?.text ?? ''} confirmText="Zusammenführen" danger
                     onConfirm={zusammenAusfuehren} onCancel={() => setZusammen(null)} />
      <Dialog open={zahlDialog !== null} headerText="Zahlungseingang erfassen" onClose={() => setZahlDialog(null)}
              footer={<Bar endContent={<>
                <Button design="Emphasized" disabled={!zahlDialog} onClick={() => zahlungSetzen(zahlDialog)}>Als bezahlt markieren</Button>
                <Button onClick={() => setZahlDialog(null)}>Abbrechen</Button>
              </>} />}>
        <FlexBox direction="Column" style={{ gap: '0.75rem', width: 'min(26rem, 80vw)' }}>
          <Text>
            {(() => {
              const f = [...new Set(sel.filter((s) => s.faktura && s.abrechnung?.status !== 'bezahlt').map((s) => s.faktura!))];
              return `${f.length === 1 ? `Rechnung ${f[0]} gilt` : `${f.length} Rechnungen (${f.join(', ')}) gelten`} ab dem gewählten Datum als bezahlt – bei einer Sammelrechnung alle ihre Aufträge. „Zahlung → Zahlung zurücknehmen“ macht es rückgängig.`;
            })()}
          </Text>
          <FlexBox direction="Column" style={{ gap: '0.25rem' }}>
            <Label for="ef-zahldatum">Bezahlt am</Label>
            <DatePicker id="ef-zahldatum" formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={zahlDialog ?? ''} onChange={(e) => setZahlDialog(e.detail.value)} />
          </FlexBox>
        </FlexBox>
      </Dialog>
      <ConfirmDialog open={!!entfernen} title="Rechnung entfernen" text={entfernen?.text ?? ''} confirmText="Entfernen" askReason danger
                     onConfirm={entfernenAusfuehren} onCancel={() => setEntfernen(null)} />
    </AppPage>
  );
}
