import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  BusyIndicator, Button, CheckBox, ComboBox, ComboBoxItem, DatePicker, FlexBox, Input, Label, Link, MessageStrip, ObjectPage, ObjectStatus,
  ObjectPageSection, ObjectPageSubSection, ObjectPageTitle, Option, SegmentedButton, SegmentedButtonItem, Select, Switch, Text, TextArea, Title,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { useCan, useFunktion } from '@core/session';
import { F_ARCHIV, belegeAblegen } from './archiv';
import { SperrHinweis, useSperre } from '@core/sperre';
import { toast } from '@core/toast';
import { DocsDialog, XRechnungDialog, type Doc, type XRes } from './dialogs';
import { AuftragDokumente } from './AuftragDokumente';
import { VersandDialog } from './VersandDialog';
import { KontaktDialog, WertDialog } from './KontaktDialog';
import { MenuButton, T, betrag, dat, type AdrDD, type Adresse, type Auftrag, type Fahrt, type Stop, type Traeger, type Werte } from './util';
import { AuswahlBox } from '@core/components/AuswahlBox';
import { StopFeld, type StopVorschlag } from './StopFeld';
import { anschrift, firmenTreffer, ortTreffer, strassenTreffer, zeitTreffer, type Vorschlaege } from './vorschlaege';
import { ablegenIn, auftragsOrdner, ordnerBereit } from './ordner';
import { BelegAblage } from './beleg/BelegAblage';
import { BelegKennzeichen, BelegPanel } from './beleg/BelegPanel';
import { F_BELEG, R_BELEG, belegAnhaengen } from './beleg/api';
import { anschriftZuKontakt, stopId, type FeldId, type StopFeldName } from './beleg/uebernahme';
import { useBelegMaske } from './beleg/useBelegMaske';

const LADENUMMER_TOOLTIP = 'Ladenummer aus der Auftragsnr. Kunde übernehmen';

/** Feld im Formularraster: Label links, Inhalt rechts (wie SimpleForm ResponsiveGridLayout) */
/** oben: Beschriftung an der ersten Zeile ausrichten (Felder mit mehreren Zeilen) */
/** beleg: Kennzeichnung „Auftrag aus Beleg“ unter dem Feld (aus Beleg übernommen bzw. Rückfrage offen) */
function F({ label, required, oben, beleg, children }: { label: string; required?: boolean; oben?: boolean; beleg?: 'frage' | 'beleg' | null; children: ReactNode }) {
  return (
    <>
      <Label showColon required={required} style={{ alignSelf: oben ? 'start' : 'center', justifySelf: 'end', textAlign: 'right', ...(oben ? { paddingTop: '0.5rem' } : {}) }}>{label}</Label>
      <div style={{ minWidth: 0 }}>{children}<BelegKennzeichen art={beleg} /></div>
    </>
  );
}
function Spalte({ titel, children }: { titel?: string; children: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      {titel && <Title level="H5" style={{ marginBottom: '0.5rem', paddingLeft: '0.25rem' }}>{titel}</Title>}
      {/* Beschriftung so breit wie nötig, Feld daneben – auch auf sehr breiten Bildschirmen nah beieinander */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(7rem, max-content) minmax(0, 1fr)', gap: '0.5rem 0.75rem', maxWidth: '36rem' }}>{children}</div>
    </div>
  );
}
function Spalten({ n, children }: { n: number; children: ReactNode }) {
  // Einzug, damit Spaltentitel (Auftrag, Absender …) nicht am Kartenrand kleben
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${n === 3 ? 300 : 380}px, 1fr))`, gap: '1.25rem 2.5rem', padding: '0.25rem 1rem' }}>{children}</div>;
}

const full = { width: '100%' };

function adrText(a: Adresse | null | undefined) {
  return {
    strasse: `${a?.strasse ?? ''} ${a?.hausnummer ?? ''}`.trim(),
    ort: `${a?.land ?? ''} ${a?.plz ?? ''} ${a?.ort ?? ''}`.replace(/\s+/g, ' ').trim(),
    telefon: a?.telefon ?? '',
    email: a?.email ?? '',
  };
}

/** Objektseite Auftrag – Fracht- oder Holzträgerauftrag (wie VIEW_DETAIL) */
/** Vorbelegung für Firma und Straße des Empfängers bei der Auftragsanlage */
const LAUT_LFS = 'laut LFS';

export function AuftragDetail() {
  const { nr, typ: neuTyp } = useParams();
  const isNew = !!neuTyp;
  const navigate = useNavigate();
  const can = useCan();
  const darfAendern = can('transport.auftraege:edit');
  // Sammelversand „Versenden…“ über Outlook 365 (Funktion transport.versand.sammel, Recht transport.versand:execute)
  const funktion = useFunktion();
  const sammelversand = funktion('transport.versand.sammel') && can('transport.versand:execute');
  const [versand, setVersand] = useState(false);
  const sperre = useSperre('AUFTRAG', isNew ? null : nr, darfAendern, { bezeichnung: `Auftrag ${nr ?? ''}` });
  const darfBearbeiten = darfAendern && sperre.eigen;

  const [a, setA] = useState<Auftrag | null>(null);
  const [vorschau, setVorschau] = useState<string>('');
  const [adrDD, setAdrDD] = useState<AdrDD[]>([]);
  const [werte, setWerte] = useState<Werte | null>(null);
  const [adr, setAdr] = useState<Record<'kunde' | 'unternehmer' | 'rechnungsempfaenger', Adresse | null>>({ kunde: null, unternehmer: null, rechnungsempfaenger: null });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [xr, setXr] = useState<XRes | null>(null);
  const [ordnerStand, setOrdnerStand] = useState(0); // neu einlesen nach Druck/Ablage
  const [kontakt, setKontakt] = useState<'NEU' | 'EDIT' | null>(null);
  /** Kontakt, der beim Bearbeiten vorausgewählt ist (Menü „Kontakt bearbeiten“: Kunde, Unternehmer, Rechnungsempfänger) */
  const [kontaktStart, setKontaktStart] = useState<string | null>(null);
  /** Feld, in das ein neu angelegter Kontakt direkt übernommen wird (Menü „Kontakt anlegen“); Zahl = weitere Fahrt (Index) */
  const [kontaktZiel, setKontaktZiel] = useState<'kunde' | 'unternehmer' | 'rechnungsempfaenger' | number | null>(null);
  const [wertTyp, setWertTyp] = useState<string | null>(null);
  // Anzahl der gespeicherten weiteren Fahrten: gedruckt wird der gespeicherte Stand
  const [fahrtenGespeichert, setFahrtenGespeichert] = useState(0);
  const [abschliessen, setAbschliessen] = useState(false);
  const [korrigieren, setKorrigieren] = useState(false);
  // Auftrag aus Beleg (beleg/, docs/euroflex-belegerfassung.md): nur in der Neuanlage eines Frachtauftrags. Ein von der Auftragsliste
  // oder dem Posteingang mitgegebener Beleg wird übernommen; die Ablagezone hier braucht Recht und Funktion.
  const beleg = useBelegMaske({ aktiv: isNew && neuTyp === 'F', a, setA, kundeWaehlen: (n) => { void waehleAdresse('kunde', String(n)); } });
  const belegAblage = isNew && neuTyp === 'F' && darfAendern && can(R_BELEG) && funktion(F_BELEG);
  const [belegFrage, setBelegFrage] = useState(false);
  /** Vorbelegung für „Kontakt anlegen“ (Anschrift laut Beleg) */
  const [kontaktVorlage, setKontaktVorlage] = useState<Partial<Adresse> | null>(null);

  const ladeAdressen = useCallback(() => api.get<AdrDD[]>(`${T}/adressen`).then(setAdrDD), []);
  const ladeWerte = useCallback(() => api.get<Werte>(`${T}/werte`).then(setWerte), []);

  const lade = useCallback(async () => {
    setError(null);
    try {
      if (isNew) {
        const v = await api.get<Auftrag & { nummerVorschau: string }>(`${T}/neu/${neuTyp}`);
        setVorschau(v.nummerVorschau);
        // Empfänger des ersten Stops: Firma und Straße mit „laut LFS“ (laut Lieferschein) vorbelegt – bei Bedarf überschreiben.
        // Nur Frachtaufträge (Holzträgeraufträge haben keine Stops) und nur der erste Stop: ein vorbelegter zweiter würde immer mitgespeichert.
        const stops = v.stops.map((st, i) => (i === 0 && neuTyp === 'F' ? { ...st, firma_e: st.firma_e || LAUT_LFS, strasse_e: st.strasse_e || LAUT_LFS } : st));
        setFahrtenGespeichert(0);
        const vorlage: Auftrag = { ...v, stops, fahrten: [], kunde: null, unternehmer: null, rechnungsempfaenger: null, leistungsdatum: null, ordernummer: null,
          gewicht: null, lademeter: null, ladenummer: null, besonderheiten: null };
        // ein schon übernommener Beleg bleibt stehen, falls die Vorlage ein zweites Mal ankommt (Entwicklungsmodus lädt doppelt)
        if (beleg.angewendet.current) { setA((alt) => alt ?? vorlage); return; }
        setA(vorlage);
        setAdr({ kunde: null, unternehmer: null, rechnungsempfaenger: null });
      } else {
        const d = await api.get<Auftrag>(`${T}/auftraege/${nr}`);
        setFahrtenGespeichert(d.fahrten?.length ?? 0);
        setA(d);
        setAdr({ kunde: d.kundeAdr ?? null, unternehmer: d.unternehmerAdr ?? null, rechnungsempfaenger: d.reAdr ?? null });
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [isNew, neuTyp, nr]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { lade(); }, [lade]);
  useEffect(() => { ladeAdressen(); ladeWerte(); }, [ladeAdressen, ladeWerte]);
  // Vorschläge für die Stops aus früheren Aufträgen (Funktion transport.stops.vorschlaege) – einmal laden, gefiltert wird hier
  const mitVorschlaegen = can('transport.vorschlaege:display');
  const [vorschlaege, setVorschlaege] = useState<Vorschlaege | null>(null);
  useEffect(() => {
    if (!mitVorschlaegen) return;
    api.get<Vorschlaege>(`${T}/stops/vorschlaege`).then(setVorschlaege).catch(() => setVorschlaege(null));
  }, [mitVorschlaegen]);

  const typ = a?.typ ?? 'F';
  const showStops = typ === 'F';
  const showTraeger = typ === 'H' || (a?.traeger.some((t) => t.menge > 0) ?? false);
  const traegerSumme = useMemo(() => (a?.traeger ?? []).reduce((s, t) => s + t.menge * t.preis, 0), [a]);

  if (!a) return error ? <MessageStrip design="Negative">{error}</MessageStrip> : <BusyIndicator active style={{ margin: '2rem' }} />;

  // Fakturierte Aufträge (#121): gesperrt bis auf „Dokumente fehlen“, Besonderheiten und Dokumente
  const fakturiert = !isNew && !!a.faktura;
  const mayEdit = darfBearbeiten && !fakturiert;

  // Weitere Fahrten (ab Fahrt 2): eigener Unternehmer, eigenes Fahrzeug, eigener Frachtpreis VK – Fahrt 1 sind die Felder des Auftrags
  const fahrten: Fahrt[] = a.fahrten ?? [];
  const setFahrt = (i: number, p: Partial<Fahrt>) => setA({ ...a, fahrten: fahrten.map((f, j) => (j === i ? { ...f, ...p } : f)) });
  const fahrtNeu = () => setA({ ...a, fahrten: [...fahrten, { pos: fahrten.length + 2, unternehmer: null, kennzeichen: null, fahrzeugtyp: a.fahrzeugtyp, frachtpreis_vk: 0, ladedatum: null }] });
  const fahrtWeg = (i: number) => setA({ ...a, fahrten: fahrten.filter((_, j) => j !== i).map((f, j) => ({ ...f, pos: j + 2 })) });
  const vkSumme = a.frachtpreis_vk + fahrten.reduce((s, f) => s + (f.frachtpreis_vk || 0), 0);

  const set = <K extends keyof Auftrag>(k: K, v: Auftrag[K]) => setA({ ...a, [k]: v });
  const setStop = (i: number, f: keyof Stop, v: string | null) => {
    const stops = [...a.stops];
    stops[i] = { ...stops[i], [f]: v || null };
    setA({ ...a, stops });
  };
  /** Ladenummer des Stops aus der Auftragsnr. Kunde (Feld hat max. 30 Zeichen, die Auftragsnr. Kunde 40 – längere werden gekürzt) */
  const ladenummerUebernehmen = (i: number) => {
    const nr = (a.ordernummer ?? '').trim();
    if (!nr) return;
    setStop(i, 'ladenummer', nr.slice(0, 30));
    if (nr.length > 30) toast('Die Auftragsnr. Kunde ist länger als 30 Zeichen – für die Ladenummer wurde sie gekürzt.');
  };
  /** mehrere Felder eines Stops aus einem Vorschlag; nurLeere = vorhandene Eingaben nicht überschreiben */
  const setStopFelder = (i: number, felder: Partial<Stop>, nurLeere: boolean) => setA((x) => {
    if (!x) return x;
    const stops = [...x.stops];
    const alt = stops[i] as unknown as Record<string, unknown>;
    const neu: Record<string, unknown> = { ...alt };
    for (const [k, v] of Object.entries(felder)) if (v && (!nurLeere || !alt[k])) neu[k] = v;
    stops[i] = neu as unknown as Stop;
    return { ...x, stops };
  });
  const setTr = (i: number, f: keyof Traeger, v: string | number) => {
    const traeger = [...a.traeger];
    traeger[i] = { ...traeger[i], [f]: v };
    setA({ ...a, traeger });
  };

  async function waehleAdresse(f: 'kunde' | 'unternehmer' | 'rechnungsempfaenger', key: string | undefined) {
    const n = key ? Number(key) : null;
    setA((x) => (x ? { ...x, [f]: n } : x));
    setAdr((x) => ({ ...x, [f]: null }));
    if (n) {
      const d = await api.get<Adresse>(`${T}/adressen/${n}`);
      setAdr((x) => ({ ...x, [f]: d }));
    }
  }

  /** "Kundenadresse als Absender übernehmen" (STOP_KUNDE_UEBERNEHMEN) */
  function kundeUebernehmen(i: number) {
    const k = adr.kunde;
    if (!k) return toast('Bitte zuerst einen Kunden zuordnen.');
    const stops = [...a!.stops];
    stops[i] = {
      ...stops[i], firma: k.kundenname, strasse: `${k.strasse ?? ''} ${k.hausnummer ?? ''}`.trim(), land: k.land,
      plzort: `${k.plz ?? ''} ${k.ort ?? ''}`.trim(),
    };
    setA({ ...a!, stops });
  }

  /** trotzRueckfragen: der Benutzer hat bestätigt, dass er mit offenen Rückfragen aus dem Beleg speichern will */
  async function save(trotzRueckfragen = false) {
    // Auftrag aus Beleg: offene Rückfragen einmal nachfragen – blockiert wird nicht
    if (isNew && beleg.offen.length && !trotzRueckfragen) { setBelegFrage(true); return; }
    setBusy(true);
    setError(null);
    try {
      const body = { ...a, typ };
      if (isNew) {
        await ordnerBereit(true); // Ablageordner: Zugriff jetzt (beim Klick) erfragen
        const r = await api.post<{ auftragsnr: string }>(`${T}/auftraege`, body);
        // Auftragsordner im Ablageordner anlegen (#121)
        const o = await auftragsOrdner(r.auftragsnr).catch(() => null);
        const gespeichert = `Auftrag ${r.auftragsnr} gespeichert.${o ? ` Ordner ${o.basis}/${r.auftragsnr.slice(0, 4)}/${r.auftragsnr} angelegt.` : ''}`;
        const quelle = beleg.stand?.quelle;
        if (!quelle) {
          toast(gespeichert);
          // nach der Anlage zurück in die Auftragsliste (Filter und Suche der Liste bleiben erhalten)
          navigate('/transport/auftraege', { replace: true });
          return;
        }
        // Auftrag aus Beleg: Datei an den Auftrag hängen bzw. die E-Mail aus dem Posteingang zuordnen (vorhandene Wege, beleg/api.ts).
        // Der Auftrag ist gespeichert – schlägt das fehl, öffnet sich der Auftrag mit einem Hinweis.
        const x = await belegAnhaengen(r.auftragsnr, quelle, { eingangUebertragen: can('transport.eingang:edit') });
        if (x.ok) {
          toast(`${gespeichert}${x.text ? ` ${x.text}` : ''}`, 6000);
          navigate(quelle.eingang ? '/transport/posteingang' : '/transport/auftraege', { replace: true });
        } else {
          const hinweis = quelle.eingang
            ? `Der Auftrag ist gespeichert, aber die E-Mail aus dem Posteingang wurde ihm nicht zugeordnet: ${x.text} Bitte im Posteingang diesem Auftrag (${r.auftragsnr}) zuordnen.`
            : `Der Auftrag ist gespeichert, aber der Beleg „${quelle.dateiName}“ wurde nicht angehängt: ${x.text} Bitte die Datei unten unter „Dokumente“ ablegen.`;
          toast(gespeichert);
          navigate(`/transport/auftraege/${r.auftragsnr}`, { replace: true, state: { hinweis } });
        }
      } else {
        await api.put(`${T}/auftraege/${nr}`, body);
        toast(`Auftrag ${nr} gespeichert.`);
        // Speichern schließt den Auftrag: zurück in die Auftragsliste (Filter und Suche bleiben erhalten)
        navigate('/transport/auftraege');
      }
    } catch (e) {
      setError((e as Error).message);
      window.scrollTo({ top: 0 });
    } finally {
      setBusy(false);
    }
  }

  async function drucken(art: 'T' | 'L' | 'R') {
    if (isNew) return toast('Bitte den Auftrag zuerst speichern.');
    await ordnerBereit(true); // Ablageordner: Zugriff jetzt (beim Klick) erfragen
    if (art === 'R') {
      // Rechnung: dieselbe Vorschau wie „Versenden → E-Rechnung“ in der Auftragsliste (#121)
      try {
        const f = a!.faktura!;
        const r = await api.get<XRes>(`${T}/xrechnung/${encodeURIComponent(f)}`);
        // PDF im Ablageordner speichern – bei einer Sammelrechnung im Ordner jedes ihrer Aufträge; was nicht ankommt, wird gemeldet
        const ziele = r.auftraege?.length ? r.auftraege : [nr!];
        if (funktion(F_ARCHIV)) belegeAblegen([{ art: 'R', kennung: f }], 'druck');
        fetch(`${T}/pdf/R/${encodeURIComponent(f)}`, { credentials: 'same-origin' })
          .then(async (res) => { if (!res.ok) throw new Error(`Rechnung nicht lesbar (Fehler ${res.status})`); return ablegenIn(ziele, `Rechnung_${f}.pdf`, await res.blob()); })
          .then((x) => {
            if (x.pfade.length) { toast(`Gespeichert: ${x.pfade.join(' · ')}`, 5000); setOrdnerStand((v) => v + 1); }
            if (x.hinweis) setError(x.hinweis);
          })
          .catch((e) => setError(`Rechnung_${f}.pdf wurde nicht im Ablageordner gespeichert: ${(e as Error).message}`));
        if (r.anzahlAuftraege > 1) {
          r.hinweise.unshift(`Rechnung ${r.faktura} ist eine Sammelrechnung über ${r.anzahlAuftraege} Aufträge - die E-Rechnung enthält wie die PDF-Rechnung alle ${r.anzahlAuftraege} Aufträge.`);
        }
        setXr(r);
      } catch (e) {
        setError((e as Error).message);
      }
      return;
    }
    // Transportauftrag: bei mehreren Fahrten je Fahrt ein PDF an deren Unternehmer (Nummer „Auftrag-Fahrt“), alle im Ordner des Auftrags
    if (art === 'T' && fahrtenGespeichert !== (a!.fahrten?.length ?? 0)) toast('Die Fahrten wurden geändert – gedruckt wird der gespeicherte Stand. Bitte bei Bedarf zuerst speichern.', 6000);
    const ids = art === 'T' && fahrtenGespeichert > 0 ? Array.from({ length: fahrtenGespeichert + 1 }, (_, i) => `${nr}-${i + 1}`) : [nr!];
    const name = art === 'T' ? 'Transportauftrag' : art === 'L' ? 'Lieferschein' : 'Rechnung';
    setDocs(ids.map((id) => ({ url: `${T}/pdf/${art}/${encodeURIComponent(id)}`, filename: `${name}_${id}.pdf`, ablage: [nr!] })));
  }

  // Kontakte dieses Auftrags (für "Kontakt bearbeiten"): Kunde, Unternehmer (auch je weiterer Fahrt), abw. Rechnungsempfänger
  const kontakteAuftrag: AdrDD[] = [];
  const rollenAuftrag: { rolle: string; key: string }[] = [];
  const beteiligte: [string, number | null | undefined][] = [
    ['Kunde', a.kunde],
    [fahrten.length ? 'Unternehmer (Fahrt 1)' : 'Unternehmer', a.unternehmer],
    ...fahrten.map((f, i): [string, number | null | undefined] => [`Unternehmer (Fahrt ${i + 2})`, f.unternehmer]),
    ['Abw. Rechnungsempfänger', a.rechnungsempfaenger],
  ];
  for (const [rolle, n] of beteiligte) {
    if (!n) continue;
    rollenAuftrag.push({ rolle, key: String(n) });
    const vorh = kontakteAuftrag.find((k) => k.key === String(n));
    if (vorh) { vorh.zusatz = `${rolle}, ${vorh.zusatz}`; continue; }
    const dd = adrDD.find((d) => d.key === String(n));
    kontakteAuftrag.push({ key: String(n), text: dd?.text ?? `Kontakt ${n}`, zusatz: dd?.zusatz ? `${rolle} · ${dd.zusatz}` : rolle });
  }
  const kontaktBearbeiten = (key: string) => { setKontaktStart(key); setKontakt('EDIT'); };
  const kontaktAnlegen = (ziel: typeof kontaktZiel, vorlage: Partial<Adresse> | null = null) => { setKontaktVorlage(vorlage); setKontaktZiel(ziel); setKontakt('NEU'); };
  /** Kennzeichnung „aus Beleg“ / „Rückfrage offen“ für die Felder unter einer Beschriftung */
  const bm = (...ids: FeldId[]) => (isNew ? beleg.marke(...ids) : null);
  // Ziele für „Kontakt anlegen“ – nur solange der Auftrag bearbeitet werden darf
  const anlageZiele: { text: string; icon: string; ziel: typeof kontaktZiel }[] = mayEdit ? [
    { text: 'als Kunde', icon: 'customer', ziel: 'kunde' },
    { text: fahrten.length ? 'als Unternehmer (Fahrt 1)' : 'als Unternehmer', icon: 'shipping-status', ziel: 'unternehmer' },
    ...fahrten.map((_, i) => ({ text: `als Unternehmer (Fahrt ${i + 2})`, icon: 'shipping-status', ziel: i as typeof kontaktZiel })),
    { text: 'als abw. Rechnungsempfänger', icon: 'receipt', ziel: 'rechnungsempfaenger' },
    { text: 'ohne Zuordnung', icon: 'add-contact', ziel: null },
  ] : [];

  const titel = isNew
    ? `Neuer ${typ === 'H' ? 'Holzträgerauftrag' : 'Frachtauftrag'} ${vorschau}`
    : `${typ === 'H' ? 'Holzträgerauftrag' : 'Frachtauftrag'} ${nr}`;
  const unter = isNew ? 'Noch nicht gespeichert (Nummer wird beim Speichern vergeben)'
    : a.faktura ? `Fakturiert mit ${a.faktura} am ${dat(a.fakturadatum)}`
    : a.faktura_reserviert ? `Rechnung ${a.faktura_reserviert} zur Korrektur geöffnet`
    : a.abgeschlossen_am ? `Ohne Rechnung abgeschlossen am ${dat(a.abgeschlossen_am)}` : 'Offen';
  const kannAbschliessen = !isNew && darfBearbeiten && !a.faktura && !a.faktura_reserviert && !a.abgeschlossen_am;
  const darfRechnung = can('transport.rechnungen:create');

  /** Rechnung zur Korrektur öffnen: ganze Rechnung, Nummer und Datum bleiben vorgemerkt, der Vermerk kommt auf die neue Rechnung */
  async function korrekturOeffnen(vermerk: string) {
    setKorrigieren(false);
    try {
      const r = await api.post<{ rechnungen: { faktura: string; auftraege: string[] }[] }>(`${T}/rechnungen/korrigieren`, { auftraege: [nr], vermerk });
      await lade();
      const weitere = r.rechnungen.flatMap((x) => x.auftraege).filter((x) => x !== nr);
      toast(`Rechnung ${r.rechnungen.map((x) => x.faktura).join(', ')} zur Korrektur geöffnet${weitere.length ? ` (mit Auftrag ${weitere.join(', ')})` : ''}.`, 6000);
    } catch (e) { setError((e as Error).message); }
  }

  // Einzelrechnung direkt im Auftrag – wie „Einzelrechnungen“ in der Auftragsliste (offener Auftrag, Recht transport.rechnungen:create)
  const kannRechnung = !isNew && darfRechnung && !a.faktura && !a.faktura_reserviert && !a.abgeschlossen_am;
  /** Einzelrechnung erzeugen (derselbe Aufruf wie in der Liste), dann zur Vorschau; im Bearbeitungsmodus vorher speichern */
  async function einzelrechnung() {
    setBusy(true);
    setError(null);
    try {
      await ordnerBereit(true); // Ablageordner: Zugriff jetzt (beim Klick) erfragen
      if (darfBearbeiten) await api.put(`${T}/auftraege/${nr}`, { ...a, typ });
      const r = await api.post<{ fakturen: string[]; ignoriert: number }>(`${T}/rechnungen`, { auftraege: [nr], sammel: false });
      await lade();
      if (r.ignoriert) toast('Der Auftrag hat bereits eine Rechnung – es wurde keine neue erzeugt.');
      setDocs(r.fakturen.map((f) => ({ url: `${T}/pdf/R/${encodeURIComponent(f)}`, filename: `Rechnung_${f}.pdf`, ablage: [nr!] })));
    } catch (e) {
      setError((e as Error).message);
      window.scrollTo({ top: 0 });
    } finally {
      setBusy(false);
    }
  }

  /** Speichern und die zur Korrektur geöffnete Rechnung mit derselben Nummer neu erzeugen, dann zur Vorschau */
  async function speichernUndRechnung() {
    setBusy(true);
    setError(null);
    try {
      await ordnerBereit(true);
      await api.put(`${T}/auftraege/${nr}`, { ...a, typ });
      const r = await api.post<{ korrigiert: { faktura: string; auftraege: string[] }[] }>(`${T}/rechnungen`, { auftraege: [nr], sammel: false });
      await lade();
      toast(`Rechnung ${r.korrigiert.map((k) => k.faktura).join(', ')} mit unveränderter Nummer neu erzeugt.`, 6000);
      setDocs(r.korrigiert.map((k) => ({ url: `${T}/pdf/R/${encodeURIComponent(k.faktura)}`, filename: `Rechnung_${k.faktura}.pdf`, ablage: k.auftraege })));
    } catch (e) {
      setError((e as Error).message);
      window.scrollTo({ top: 0 });
    } finally {
      setBusy(false);
    }
  }
  /** Ohne Rechnung abschließen bzw. wieder öffnen – wirkt sofort (ungespeicherte Eingaben im Formular bleiben stehen) */
  async function abschluss(grund: string | null) {
    setAbschliessen(false);
    try {
      if (grund === null) await api.post(`${T}/auftraege/oeffnen`, { auftraege: [nr] });
      else await api.post(`${T}/auftraege/abschliessen`, { auftraege: [nr], grund });
      const d = await api.get<Auftrag>(`${T}/auftraege/${nr}`);
      setA((x) => (x ? { ...x, abgeschlossen_am: d.abgeschlossen_am ?? null, abgeschlossen_grund: d.abgeschlossen_grund ?? null } : x));
      toast(grund === null ? `Auftrag ${nr} ist wieder offen.` : `Auftrag ${nr} ohne Rechnung abgeschlossen.`);
    } catch (e) { setError((e as Error).message); }
  }

  // Anzeige: Name des gewählten Kontakts (der Schlüssel steht am Eintrag, nicht im Feld)
  const adrName = (f: 'kunde' | 'unternehmer' | 'rechnungsempfaenger') => {
    const n = a[f];
    if (!n) return '';
    return adrDD.find((d) => d.key === String(n))?.text ?? adr[f]?.kundenname ?? `Kontakt ${n}`;
  };
  const adrCombo = (f: 'kunde' | 'unternehmer' | 'rechnungsempfaenger') => (
    <AuswahlBox style={full} wert={a[f] ? String(a[f]) : ''} placeholder="Name oder Ort eingeben" readonly={!mayEdit} max={50}
                eintraege={adrDD.length ? adrDD : a[f] ? [{ key: String(a[f]), text: adrName(f) }] : []}
                onWaehle={(k) => waehleAdresse(f, k ?? undefined)} />
  );

  const beteiligter = (titelB: string, f: 'kunde' | 'unternehmer' | 'rechnungsempfaenger', mitTel = true) => {
    const t = adrText(adr[f]);
    return (
      <Spalte titel={titelB}>
        <F label="Name" beleg={f === 'kunde' ? bm('kunde') : null}>{adrCombo(f)}</F>
        <F label="Straße"><Text>{t.strasse}</Text></F>
        <F label="Land/PLZ/Ort"><Text>{t.ort}</Text></F>
        {mitTel && <F label="Telefon"><Text>{t.telefon}</Text></F>}
        <F label="E-Mail"><Text>{t.email}</Text></F>
      </Spalte>
    );
  };

  const werteSelect = (typW: keyof Werte, f: 'fahrzeugtyp' | 'ladegut' | 'ladeweise' | 'palettentausch', neu = true) => (
    <FlexBox style={{ gap: '0.5rem' }}>
      <Select style={{ flex: 1 }} disabled={!mayEdit} onChange={(e) => set(f, e.detail.selectedOption.dataset.key || null)}>
        {!a[f] && <Option data-key="" selected />}
        {(werte?.[typW] ?? []).filter((w) => w.aktiv || w.key === a[f]).map((w) => (
          <Option key={w.key} data-key={w.key} selected={w.key === a[f]}>{w.text}</Option>
        ))}
        {a[f] && werte && !werte[typW].some((w) => w.key === a[f]) && <Option data-key={a[f]!} selected>{a[f]}</Option>}
      </Select>
      {neu && mayEdit && <Button icon="add" onClick={() => setWertTyp(typW)}>Neu</Button>}
    </FlexBox>
  );

  const stopForm = (i: number) => {
    const s = a.stops[i];
    const inp = (f: keyof Stop, max: number, w?: string, ph?: string) => (
      <Input style={{ width: w ?? '100%' }} maxlength={max} value={(s[f] as string) ?? ''} readonly={!mayEdit} placeholder={ph}
             onInput={(e) => setStop(i, f, e.target.value)} />
    );
    // Datum mit fester Breite (schrumpft nicht neben dem Zeitfeld – sonst ist es abgeschnitten, #121); das Zeitfeld nimmt den Rest
    const datum = (f: 'datum' | 'datum_e') => (
      <DatePicker style={{ flex: '0 0 9.75rem', width: '9.75rem', minWidth: '9.75rem' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={s[f] ?? ''} readonly={!mayEdit}
                  onChange={(e) => setStop(i, f, e.detail.value)} />
    );
    const zeit = (f: 'zeit' | 'zeit_e') => (vorschlaege && mayEdit ? (
      <div style={{ flex: '1 1 9rem', minWidth: '9rem' }}>
        <StopFeld wert={s[f] ?? ''} max={30} placeholder="Uhrzeit / Zeitfenster" onWert={(v) => setStop(i, f, v)} onFelder={() => undefined}
                  vorschlaege={zeitTreffer(vorschlaege, s[f] ?? '').map((z) => ({ text: z, felder: {} }))} />
      </div>
    ) : (
      <Input style={{ flex: '1 1 9rem', minWidth: '9rem' }} maxlength={30} value={s[f] ?? ''} readonly={!mayEdit} placeholder="Uhrzeit / Zeitfenster"
             onInput={(e) => setStop(i, f, e.target.value)} />
    ));
    // Firma, Straße, PLZ/Ort mit Vorschlägen; e = Empfängerseite (Felder mit _e)
    const vf = (art: 'firma' | 'strasse' | 'plzort', e: boolean) => {
      const k = (f: 'firma' | 'strasse' | 'land' | 'plzort') => (e ? `${f}_e` : f) as keyof Stop;
      const feld = k(art);
      const wert = (s[feld] as string) ?? '';
      if (!vorschlaege || !mayEdit) return inp(feld, 30);
      const liste: StopVorschlag[] = art === 'firma'
        ? firmenTreffer(vorschlaege, wert).map((o) => ({ text: o.firma, zusatz: anschrift(o), felder: { [k('strasse')]: o.strasse, [k('land')]: o.land, [k('plzort')]: o.plzort } as Partial<Stop> }))
        : art === 'strasse'
          ? strassenTreffer(vorschlaege, wert, s[k('plzort')] as string | null).map((o) => ({ text: o.strasse, zusatz: [o.land, o.plzort].filter(Boolean).join(' '), felder: { [k('land')]: o.land, [k('plzort')]: o.plzort } as Partial<Stop> }))
          : ortTreffer(vorschlaege, wert).map((o) => ({ text: o.plzort, zusatz: o.land ?? undefined, felder: { [k('land')]: o.land } as Partial<Stop> }));
      return <StopFeld wert={wert} max={30} vorschlaege={liste} onWert={(v) => setStop(i, feld, v)} onFelder={(f, nurLeere) => setStopFelder(i, f, nurLeere)} />;
    };
    const sm = (...felder: StopFeldName[]) => bm(...felder.map((x) => stopId(i, x)));
    return (
      <Spalten n={2}>
        <Spalte titel="Absender">
          <F label="Firma" beleg={sm('firma')}>{vf('firma', false)}</F>
          <F label="Straße" beleg={sm('strasse')}>{vf('strasse', false)}</F>
          <F label="Land / PLZ Ort" beleg={sm('land', 'plzort')}><FlexBox style={{ gap: '0.5rem' }}>{inp('land', 3, '4rem')}<div style={{ flex: 1 }}>{vf('plzort', false)}</div></FlexBox></F>
          <F label="Ladenummer" beleg={sm('ladenummer')}>
            {mayEdit ? (
              <FlexBox alignItems="Center" style={{ gap: '0.25rem' }}>
                <div style={{ flex: 1, minWidth: 0 }}>{inp('ladenummer', 30)}</div>
                <Button icon="copy" design="Transparent" disabled={!a.ordernummer?.trim()} onClick={() => ladenummerUebernehmen(i)}
                        tooltip={LADENUMMER_TOOLTIP} accessibleName={LADENUMMER_TOOLTIP} />
              </FlexBox>
            ) : inp('ladenummer', 30)}
          </F>
          <F label="Zeitvorgabe Laden" beleg={sm('datum', 'zeit')}><FlexBox style={{ gap: '0.5rem', flexWrap: 'wrap' }}>{datum('datum')}{zeit('zeit')}</FlexBox></F>
        </Spalte>
        <Spalte titel="Empfänger">
          <F label="Firma" beleg={sm('firma_e')}>{vf('firma', true)}</F>
          <F label="Straße" beleg={sm('strasse_e')}>{vf('strasse', true)}</F>
          <F label="Land / PLZ Ort" required={!!s.firma_e} beleg={sm('land_e', 'plzort_e')}><FlexBox style={{ gap: '0.5rem' }}>{inp('land_e', 3, '4rem')}<div style={{ flex: 1 }}>{vf('plzort', true)}</div></FlexBox></F>
          <F label="Zeitvorgabe Entladen" beleg={sm('datum_e', 'zeit_e')}><FlexBox style={{ gap: '0.5rem', flexWrap: 'wrap' }}>{datum('datum_e')}{zeit('zeit_e')}</FlexBox></F>
        </Spalte>
      </Spalten>
    );
  };

  return (
    <>
      <ObjectPage
        style={{ height: '100%' }}
        mode="Default"
        hidePinButton
        titleArea={
          <ObjectPageTitle
            header={<Title level="H3" wrappingType="Normal">{titel}</Title>}
            subHeader={<Text>{unter}</Text>}
            actionsBar={
              <FlexBox style={{ gap: '0.5rem' }} alignItems="Center">
                {darfBearbeiten && <Button design="Emphasized" icon="save" loading={busy} onClick={() => { void save(); }}>Speichern</Button>}
                {!!a.faktura_reserviert && darfBearbeiten && darfRechnung && (
                  <Button icon="lead" loading={busy} onClick={speichernUndRechnung} tooltip={`Speichern und Rechnung ${a.faktura_reserviert} mit derselben Nummer neu erzeugen`}>Speichern und Rechnung erzeugen</Button>
                )}
                {kannRechnung && (
                  <Button icon="lead" loading={busy} onClick={einzelrechnung}
                          tooltip={`${darfBearbeiten ? 'Speichern und ' : ''}Rechnung für diesen Auftrag erzeugen – danach mit „Versenden…“ verschicken`}>Einzelrechnung</Button>
                )}
                {fakturiert && darfBearbeiten && darfRechnung && (
                  <Button icon="edit" onClick={() => setKorrigieren(true)} tooltip="Rechnung wieder öffnen, Auftrag ändern und mit derselben Rechnungsnummer neu erzeugen">Rechnung korrigieren</Button>
                )}
                {kannAbschliessen && <Button icon="complete" onClick={() => setAbschliessen(true)} tooltip="Der Auftrag bekommt keine Rechnung und gilt nicht mehr als offen">Ohne Rechnung abschließen</Button>}
                <MenuButton text="Drucken" icon="print" items={[
                  { text: 'Transportauftrag', onClick: () => drucken('T') },
                  { text: 'Lieferschein', onClick: () => drucken('L') },
                  { text: 'Rechnung', disabled: !a.faktura, onClick: () => drucken('R') },
                ]} />
                {sammelversand && !isNew && (
                  <Button icon="paper-plane" onClick={() => setVersand(true)} tooltip="Dokumente dieses Auftrags als E-Mails über Outlook 365">Versenden…</Button>
                )}
                {!isNew && <ChangeHistoryButton objectType="AUFTRAG" objectKey={nr!} />}
                {/* Abbrechen: ein Beleg aus dem Posteingang bleibt dort unverändert in der Prüfliste */}
                <Button icon="decline" design="Transparent" onClick={() => navigate(isNew && beleg.stand?.quelle.eingang ? '/transport/posteingang' : '/transport/auftraege')} />
              </FlexBox>
            }
          />
        }
      >
        <ObjectPageSection id="beteiligte" titleText="Beteiligte" hideTitleText>
          <ObjectPageSubSection id="beteiligte-sub" titleText="Beteiligte"
            actions={can('transport.kontakte:edit') ? <>
              {anlageZiele.length
                ? <MenuButton text="Kontakt anlegen" icon="add-contact" design="Transparent" items={anlageZiele.map((z) => ({ text: z.text, icon: z.icon, onClick: () => kontaktAnlegen(z.ziel) }))} />
                : <Button icon="add-contact" design="Transparent" onClick={() => kontaktAnlegen(null)}>Kontakt anlegen</Button>}
              {rollenAuftrag.length
                ? <MenuButton text="Kontakt bearbeiten" icon="edit" design="Transparent" items={rollenAuftrag.map((r) => ({
                    text: `${r.rolle}: ${kontakteAuftrag.find((k) => k.key === r.key)?.text ?? `Kontakt ${r.key}`}`,
                    icon: r.rolle === 'Kunde' ? 'customer' : r.rolle.startsWith('Unternehmer') ? 'shipping-status' : 'receipt',
                    onClick: () => kontaktBearbeiten(r.key),
                  }))} />
                : <Button icon="edit" design="Transparent" onClick={() => toast('Diesem Auftrag ist noch kein Kontakt zugeordnet.')}>Kontakt bearbeiten</Button>}
            </> : undefined}>
            <SperrHinweis s={sperre} style={{ marginBottom: '1rem' }} />
            {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}
            {/* Auftrag aus Beleg: Hinweis nach dem Speichern, Meldung der Erkennung, Hinweisband bzw. Ablagezone (nur Neuanlage Frachtauftrag) */}
            {!isNew && beleg.hinweis && <MessageStrip design="Critical" onClose={beleg.hinweisSchliessen} style={{ marginBottom: '1rem' }}>{beleg.hinweis}</MessageStrip>}
            {isNew && beleg.meldung && (
              <MessageStrip design={beleg.meldung.fehler ? 'Negative' : 'Critical'} onClose={beleg.meldungSchliessen} style={{ marginBottom: '1rem' }}>{beleg.meldung.text}</MessageStrip>
            )}
            {isNew && beleg.stand && (
              <BelegPanel beleg={beleg} a={a} adrDD={adrDD} werte={werte} bearbeitbar={mayEdit}
                          onKontakt={can('transport.kontakte:edit') ? (b) => kontaktAnlegen('kunde', anschriftZuKontakt(b)) : undefined} />
            )}
            {belegAblage && !beleg.stand && (
              <div style={{ marginBottom: '1rem' }}><BelegAblage onDatei={(f) => { void beleg.erkennen(f); }} laedt={beleg.laedt} /></div>
            )}
            {!!a.faktura && (
              <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '1rem' }}>
                Der Auftrag ist fakturiert ({a.faktura} vom {dat(a.fakturadatum)}) und kann nicht mehr geändert werden –
                ausgenommen „Dokumente fehlen“, die Besonderheiten und die Zuordnung von Dokumenten.
              </MessageStrip>
            )}
            {!!a.faktura_reserviert && (
              <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '1rem' }}>
                Rechnung {a.faktura_reserviert} vom {dat(a.fakturadatum_reserviert ?? null)} ist zur Korrektur geöffnet
                {a.rechnung_vermerk ? ` – Vermerk: ${a.rechnung_vermerk}` : ''}. Der Auftrag lässt sich bearbeiten;
                „Speichern und Rechnung erzeugen“ (oder „Einzelrechnungen“ in der Auftragsliste) vergibt wieder die Nummer {a.faktura_reserviert} mit
                demselben Rechnungsdatum. Der Vermerk steht mit dem Datum der Korrektur auf der neuen Rechnung.
              </MessageStrip>
            )}
            {!!a.faktura && !!a.rechnung_korrigiert_am && (
              <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '1rem' }}>
                Korrigierte Rechnung vom {dat(a.rechnung_korrigiert_am)}{a.rechnung_vermerk ? ` – ${a.rechnung_vermerk}` : ''}.
              </MessageStrip>
            )}
            {!!a.abgeschlossen_am && !a.faktura && (
              <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '1rem' }}>
                Ohne Rechnung abgeschlossen am {dat(a.abgeschlossen_am)}{a.abgeschlossen_grund ? ` – ${a.abgeschlossen_grund}` : ''}.
                {darfBearbeiten && <>{' '}<Link onClick={() => abschluss(null)}>Wieder öffnen</Link></>}
              </MessageStrip>
            )}
            <Spalten n={3}>
              {beteiligter('Kunde', 'kunde')}
              {beteiligter(fahrten.length ? 'Unternehmer (Fahrt 1)' : 'Unternehmer', 'unternehmer')}
              {beteiligter('Abweichender Rechnungsempfänger', 'rechnungsempfaenger', false)}
            </Spalten>
          </ObjectPageSubSection>
        </ObjectPageSection>

        <ObjectPageSection id="auftragsdaten" titleText="Auftragsdaten" hideTitleText>
          <ObjectPageSubSection id="auftragsdaten-sub" titleText="Auftragsdaten">
            <Spalten n={3}>
              <Spalte titel="Auftrag">
                <F label="Auftragsnummer"><Text>{isNew ? `${vorschau} (vorläufig)` : nr}</Text></F>
                <F label="Anlagedatum">
                  <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={a.anlagedatum ?? ''} readonly={!mayEdit}
                              onChange={(e) => set('anlagedatum', e.detail.value || null)} />
                </F>
                <F label="Leistungsdatum" beleg={bm('leistungsdatum')}>
                  <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={a.leistungsdatum ?? ''} readonly={!mayEdit}
                              onChange={(e) => set('leistungsdatum', e.detail.value || null)} />
                </F>
                <F label="Auftragsnr. Kunde" beleg={bm('ordernummer')}><Input style={full} maxlength={40} value={a.ordernummer ?? ''} readonly={!mayEdit} onInput={(e) => set('ordernummer', e.target.value)} /></F>
                <F label="Frachtpreis EK"><BetragInput value={a.frachtpreis_ek} readonly={!mayEdit} onChange={(v) => set('frachtpreis_ek', v)} /></F>
                <F label={fahrten.length ? 'Frachtpreis VK (Fahrt 1)' : 'Frachtpreis VK'} beleg={bm('frachtpreis_vk')}><BetragInput value={a.frachtpreis_vk} readonly={!mayEdit} onChange={(v) => set('frachtpreis_vk', v)} /></F>
              </Spalte>
              <Spalte titel="Fahrzeug und Ladung">
                <F label="Kennzeichen"><Input style={full} maxlength={20} value={a.kennzeichen ?? ''} readonly={!mayEdit} onInput={(e) => set('kennzeichen', e.target.value)} /></F>
                <F label="Fahrzeugtyp" beleg={bm('fahrzeugtyp')}>{werteSelect('FAHRZEUGTYP', 'fahrzeugtyp')}</F>
                <F label="Ladegut" beleg={bm('ladegut')}>{werteSelect('LADEGUT', 'ladegut')}</F>
                <F label="Gewicht" beleg={bm('gewicht')}>
                  <FlexBox alignItems="Center" style={{ gap: '0.5rem' }}>
                    <Input style={{ width: '8rem' }} maxlength={10} value={a.gewicht ?? ''} readonly={!mayEdit} onInput={(e) => set('gewicht', e.target.value)} />
                    <Text>in T</Text>
                  </FlexBox>
                </F>
                <F label="Lademeter" beleg={bm('lademeter')}>
                  <FlexBox alignItems="Center" style={{ gap: '0.5rem' }}>
                    <Input style={{ width: '8rem' }} value={a.lademeter === null || a.lademeter === undefined ? '' : String(a.lademeter).replace('.', ',')} readonly={!mayEdit}
                           onInput={(e) => set('lademeter', e.target.value.trim() ? e.target.value : null)} />
                    <Text>in M</Text>
                  </FlexBox>
                </F>
                <F label="Ladeweise" beleg={bm('ladeweise')}>{werteSelect('LADEWEISE', 'ladeweise')}</F>
                <F label="Palettentausch" beleg={bm('palettentausch')}>{werteSelect('PALETTENTAUSCH', 'palettentausch', false)}</F>
              </Spalte>
              <Spalte titel="Rechnung">
                <F label="MwSt berechnen"><CheckBox checked={a.steuerrelevant} readonly={!mayEdit}
                  onChange={(e) => setA({ ...a, steuerrelevant: e.target.checked, steuerbefreiung: e.target.checked ? null : a.steuerbefreiung ?? 'RC' })} /></F>
                {!a.steuerrelevant && (
                  // ohne MwSt: Grund wählen – Text erscheint so auf der Rechnung und in der E-Rechnung (#121)
                  <F label="Ohne MwSt, weil" required oben>
                    <div style={{ display: 'grid', gap: '0.35rem' }}>
                      {/* zwei kurze Schaltflächen nebeneinander, darunter der Text der Rechnung (#121);
                          auch nach der Faktura korrigierbar – ändert nur den Hinweistext, nicht die Beträge */}
                      <SegmentedButton style={{ width: '100%' }} accessibleName="Grund ohne Mehrwertsteuer"
                                       onSelectionChange={(e) => {
                                         const g = (e.detail.selectedItems[0] as HTMLElement | undefined)?.dataset.g as 'RC' | 'DRITTLAND' | undefined;
                                         if (g && g !== a.steuerbefreiung) set('steuerbefreiung', g);
                                       }}>
                        <SegmentedButtonItem data-g="RC" selected={a.steuerbefreiung === 'RC'} disabled={!darfBearbeiten}>Reverse Charge</SegmentedButtonItem>
                        <SegmentedButtonItem data-g="DRITTLAND" selected={a.steuerbefreiung === 'DRITTLAND'} disabled={!darfBearbeiten}>Drittland</SegmentedButtonItem>
                      </SegmentedButton>
                      {a.steuerbefreiung && (
                        <Text className="portal-small">
                          <span className="portal-muted">Auf der Rechnung: </span>
                          {a.steuerbefreiung === 'RC' ? 'Übergang der Steuerschuld auf den Leistungsempfänger (Reverse Charge)'
                            : 'Umsatzsteuerfreier Transport in ein Drittland gem. § 4 Nr. 3 Buchst. a Unterbuchstabe aa UStG'}
                        </Text>
                      )}
                      {!a.steuerbefreiung && <Text className="portal-muted portal-small">Noch nicht gewählt – bisher aus dem Land des Rechnungsempfängers abgeleitet.</Text>}
                      {fakturiert && <Text className="portal-muted portal-small">Rechnung {a.faktura}: Eine Änderung druckt die Rechnung mit dem neuen Text (Beträge bleiben).</Text>}
                    </div>
                  </F>
                )}
                {!isNew && <F label="Rechnungsbetrag"><Text><b>{betrag(a.rgbetrag)} EUR</b></Text></F>}
                <F label="Faktura">
                  {a.faktura
                    ? <ObjectStatus state="Positive">{a.faktura} vom {dat(a.fakturadatum)}</ObjectStatus>
                    : a.faktura_reserviert ? <ObjectStatus state="Critical">{a.faktura_reserviert} in Korrektur</ObjectStatus>
                    : a.abgeschlossen_am ? <ObjectStatus state="Information">ohne Rechnung abgeschlossen</ObjectStatus>
                    : <ObjectStatus state="Critical">offen</ObjectStatus>}
                </F>
                <F label="Dokumente fehlen">
                  <Switch textOn="Ja" textOff="Nein" checked={a.dok_fehlen} disabled={!darfBearbeiten} onChange={(e) => set('dok_fehlen', e.target.checked)} />
                </F>
              </Spalte>
            </Spalten>
          </ObjectPageSubSection>
        </ObjectPageSection>

        {showStops ? (
          <ObjectPageSection id="stops" titleText="Stops" hideTitleText>
            {[0, 1].map((i) => (
              <ObjectPageSubSection key={i} id={`stop${i + 1}`} titleText={i === 0 ? 'Erster Stop' : 'Zweiter Stop'}
                actions={mayEdit ? <Button icon="copy" design="Transparent" onClick={() => kundeUebernehmen(i)}>Kundenadresse als Absender übernehmen</Button> : undefined}>
                {stopForm(i)}
              </ObjectPageSubSection>
            ))}
          </ObjectPageSection>
        ) : <></>}

        {showStops ? (
          <ObjectPageSection id="fahrten" titleText="Weitere Fahrten" hideTitleText>
            <ObjectPageSubSection id="fahrten-sub" titleText={`Weitere Fahrten${fahrten.length ? ` (${fahrten.length})` : ''}`}
              actions={<FlexBox alignItems="Center" style={{ gap: '0.5rem' }}>
                {fahrten.length > 0 && <><Label>Frachtpreis VK aller {fahrten.length + 1} Fahrten:</Label><Text><b>{betrag(vkSumme)} EUR</b></Text></>}
                {mayEdit && <Button icon="add" design="Transparent" onClick={fahrtNeu}>Fahrt hinzufügen</Button>}
              </FlexBox>}>
              <Text className="portal-muted" style={{ display: 'block', padding: '0 1rem 0.5rem' }}>
                Fährt der Transport mit mehreren Fahrzeugen oder Unternehmern, bleibt es ein Auftrag mit einer Rechnung an den Kunden.
                Fahrt 1 steht oben (Unternehmer, Kennzeichen, Fahrzeugtyp, Frachtpreis VK); jede weitere Fahrt bekommt hier ihren Unternehmer
                und ihren eigenen Transportauftrag ({isNew ? 'Nummer-2' : `${nr}-2`}, …). Die Route gilt für alle Fahrten.
              </Text>
              {fahrten.length > 0 && (
                <div className="portal-tabrahmen">
                  <table style={{ width: '100%', minWidth: '62rem', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--sapList_BorderColor)' }}>
                        {['Fahrt', 'Unternehmer', 'Kennzeichen', 'Fahrzeugtyp', 'Ladedatum (falls abweichend)', 'Frachtpreis VK', ''].map((h) => (
                          <th key={h} style={{ padding: '0.5rem', fontWeight: 'normal', color: 'var(--sapContent_LabelColor)' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {fahrten.map((f, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--sapList_BorderColor)' }}>
                          <td style={{ padding: '0.25rem 0.5rem', whiteSpace: 'nowrap' }}><b>{isNew ? `Fahrt ${i + 2}` : `${nr}-${i + 2}`}</b></td>
                          <td style={{ padding: '0.25rem 0.5rem', minWidth: '16rem' }}>
                            <AuswahlBox style={full} wert={f.unternehmer ? String(f.unternehmer) : ''} placeholder="Name oder Ort eingeben" readonly={!mayEdit} max={50}
                                        eintraege={adrDD.length ? adrDD : f.unternehmer ? [{ key: String(f.unternehmer), text: f.unternehmerAdr?.kundenname ?? `Kontakt ${f.unternehmer}` }] : []}
                                        onWaehle={(k) => setFahrt(i, { unternehmer: k ? Number(k) : null })} />
                          </td>
                          <td style={{ padding: '0.25rem 0.5rem' }}>
                            <Input style={{ width: '10rem' }} maxlength={20} value={f.kennzeichen ?? ''} readonly={!mayEdit} onInput={(e) => setFahrt(i, { kennzeichen: e.target.value })} />
                          </td>
                          <td style={{ padding: '0.25rem 0.5rem' }}>
                            <Select style={{ width: '11rem' }} disabled={!mayEdit} onChange={(e) => setFahrt(i, { fahrzeugtyp: e.detail.selectedOption.dataset.key || null })}>
                              {!f.fahrzeugtyp && <Option data-key="" selected />}
                              {(werte?.FAHRZEUGTYP ?? []).filter((w) => w.aktiv || w.key === f.fahrzeugtyp).map((w) => (
                                <Option key={w.key} data-key={w.key} selected={w.key === f.fahrzeugtyp}>{w.text}</Option>
                              ))}
                              {f.fahrzeugtyp && werte && !werte.FAHRZEUGTYP.some((w) => w.key === f.fahrzeugtyp) && <Option data-key={f.fahrzeugtyp} selected>{f.fahrzeugtyp}</Option>}
                            </Select>
                          </td>
                          <td style={{ padding: '0.25rem 0.5rem' }}>
                            <DatePicker style={{ width: '9.75rem' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.ladedatum ?? ''} readonly={!mayEdit}
                                        onChange={(e) => setFahrt(i, { ladedatum: e.detail.value || null })} />
                          </td>
                          <td style={{ padding: '0.25rem 0.5rem' }}><BetragInput value={f.frachtpreis_vk} readonly={!mayEdit} onChange={(v) => setFahrt(i, { frachtpreis_vk: v })} /></td>
                          <td style={{ padding: '0.25rem 0.5rem', textAlign: 'right' }}>
                            {mayEdit && <Button icon="delete" design="Transparent" tooltip="Fahrt entfernen" accessibleName={`Fahrt ${i + 2} entfernen`} onClick={() => fahrtWeg(i)} />}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </ObjectPageSubSection>
          </ObjectPageSection>
        ) : <></>}

        {showTraeger ? (
          <ObjectPageSection id="traeger" titleText="Holzträger" hideTitleText>
            <ObjectPageSubSection id="traeger-sub" titleText="Holzträger"
              actions={<FlexBox alignItems="Center" style={{ gap: '0.5rem' }}><Label>Summe:</Label><Text><b>{betrag(traegerSumme)} EUR</b></Text></FlexBox>}>
              <div className="portal-tabrahmen">
              <table style={{ width: '100%', minWidth: '40rem', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--sapList_BorderColor)' }}>
                    <th style={{ padding: '0.5rem', width: '8rem', fontWeight: 'normal', color: 'var(--sapContent_LabelColor)' }}>Menge</th>
                    <th style={{ fontWeight: 'normal', color: 'var(--sapContent_LabelColor)' }}>Produkt</th>
                    <th style={{ width: '11rem', textAlign: 'right', fontWeight: 'normal', color: 'var(--sapContent_LabelColor)' }}>Einzelpreis</th>
                    <th style={{ width: '11rem', textAlign: 'right', paddingRight: '0.5rem', fontWeight: 'normal', color: 'var(--sapContent_LabelColor)' }}>Gesamtpreis</th>
                  </tr>
                </thead>
                <tbody>
                  {a.traeger.map((t, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--sapList_BorderColor)' }}>
                      <td style={{ padding: '0.25rem 0.5rem' }}>
                        <Input style={{ width: '6rem', textAlign: 'right' }} type="Number" value={String(t.menge)} readonly={!mayEdit}
                               onInput={(e) => setTr(i, 'menge', Math.max(0, Math.trunc(Number(e.target.value) || 0)))} />
                      </td>
                      <td><Input style={full} maxlength={40} value={t.prod_txt ?? ''} readonly={!mayEdit} onInput={(e) => setTr(i, 'prod_txt', e.target.value)} /></td>
                      <td style={{ textAlign: 'right' }}><BetragInput value={t.preis} readonly={!mayEdit} onChange={(v) => setTr(i, 'preis', v)} /></td>
                      <td style={{ textAlign: 'right', paddingRight: '0.5rem' }}><b>{betrag(t.menge * t.preis)} EUR</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </ObjectPageSubSection>
          </ObjectPageSection>
        ) : <></>}

        {!isNew && nr ? (
          <ObjectPageSection id="dokumente" titleText="Dokumente" hideTitleText>
            <ObjectPageSubSection id="dokumente-sub" titleText="Dokumente">
              <AuftragDokumente nr={nr} edit={darfBearbeiten} ablegen={darfAendern} ordnerStand={ordnerStand} faktura={a.faktura} />
            </ObjectPageSubSection>
          </ObjectPageSection>
        ) : <></>}

        <ObjectPageSection id="besonderheiten" titleText="Besonderheiten" hideTitleText>
          <ObjectPageSubSection id="besonderheiten-sub" titleText="Besonderheiten">
            <TextArea rows={8} growing style={full} value={a.besonderheiten ?? ''} readonly={!darfBearbeiten}
                      onInput={(e) => set('besonderheiten', e.target.value)} />
            <BelegKennzeichen art={bm('besonderheiten')} />
          </ObjectPageSubSection>
        </ObjectPageSection>
      </ObjectPage>
      <ConfirmDialog open={abschliessen} title="Ohne Rechnung abschließen" confirmText="Abschließen" askReason
                     text={`Auftrag ${nr} bekommt keine Rechnung und gilt nicht mehr als offen. Er bleibt erhalten und lässt sich jederzeit wieder öffnen. Der Grund steht im Änderungsbeleg und in der Auftragsliste.`}
                     onConfirm={(grund) => abschluss(grund)} onCancel={() => setAbschliessen(false)} />

      <ConfirmDialog open={korrigieren} title="Rechnung korrigieren" confirmText="Zur Korrektur öffnen" askReason
                     text={`Rechnung ${a.faktura ?? ''} wird zur Korrektur geöffnet – bei einer Sammelrechnung mit allen ihren Aufträgen. Danach lässt sich der Auftrag bearbeiten; „Speichern und Rechnung erzeugen“ vergibt wieder die Nummer ${a.faktura ?? ''} mit demselben Rechnungsdatum.\n\nBitte als Grund einen Vermerk angeben: Er erklärt die Änderung, steht mit dem Datum der Korrektur auf der neuen Rechnung und im Änderungsbeleg.`}
                     onConfirm={korrekturOeffnen} onCancel={() => setKorrigieren(false)} />
      <DocsDialog docs={docs} onClose={() => { setDocs(null); setOrdnerStand((v) => v + 1); }} />
      {!isNew && nr && <VersandDialog auftraege={[nr]} fakturiert={!!a.faktura} open={versand} onClose={() => setVersand(false)} />}
      <XRechnungDialog data={xr} onClose={() => setXr(null)} />
      <ConfirmDialog open={belegFrage} title="Rückfragen aus dem Beleg offen" confirmText="Trotzdem speichern"
                     text={`Zu ${beleg.offen.length === 1 ? 'einem Feld' : `${beleg.offen.length} Feldern`} ist der Beleg nicht eindeutig, und es ist noch nichts gewählt oder eingetragen: ${beleg.offen.map((r) => r.bezeichnung).join(', ')}.\n\nDiese Felder bleiben so, wie sie jetzt in der Maske stehen. Trotzdem speichern?`}
                     onConfirm={() => { setBelegFrage(false); void save(true); }} onCancel={() => setBelegFrage(false)} />
      <KontaktDialog modus={kontakt} auswahl={kontakteAuftrag} start={kontaktStart} vorlage={kontaktVorlage} onClose={() => setKontakt(null)}
                     onSaved={async (adrnr) => {
                       const neu = kontakt === 'NEU';
                       const ziel = kontaktZiel;
                       setKontakt(null); setKontaktZiel(null);
                       await ladeAdressen();
                       // neu angelegt: direkt in das gewählte Feld übernehmen
                       if (neu && typeof ziel === 'number') {
                         setA((x) => (x ? { ...x, fahrten: (x.fahrten ?? []).map((f, j) => (j === ziel ? { ...f, unternehmer: adrnr } : f)) } : x));
                       } else if (neu && typeof ziel === 'string') {
                         await waehleAdresse(ziel, String(adrnr));
                       }
                       if (neu && ziel !== null) {
                         const rolle = anlageZiele.find((z) => z.ziel === ziel)?.text.replace(/^als /, '') ?? '';
                         toast(`Neuer Kontakt als ${rolle} eingetragen – Auftrag speichern nicht vergessen.`, 6000);
                       }
                       // bearbeitet: Anschriften der Beteiligten neu laden
                       for (const f of ['kunde', 'unternehmer', 'rechnungsempfaenger'] as const) {
                         if (a[f] && !(neu && ziel === f)) waehleAdresse(f, String(a[f]));
                       }
                     }} />
      <WertDialog typ={wertTyp} onClose={() => setWertTyp(null)}
                  onSaved={async (t, key) => {
                    setWertTyp(null);
                    await ladeWerte();
                    const f = t === 'FAHRZEUGTYP' ? 'fahrzeugtyp' : t === 'LADEGUT' ? 'ladegut' : 'ladeweise';
                    setA((x) => (x ? { ...x, [f]: key } : x));
                  }} />
    </>
  );
}

/** Betragsfeld mit deutscher Eingabe (1.234,56) */
function BetragInput({ value, onChange, readonly }: { value: number; onChange: (v: number) => void; readonly?: boolean }) {
  const [txt, setTxt] = useState(betrag(value));
  useEffect(() => setTxt(betrag(value)), [value]);
  return (
    <Input style={{ width: '10rem', textAlign: 'right' }} value={txt} readonly={readonly} icon={<Text style={{ padding: '0 0.5rem' }}>EUR</Text>}
           onInput={(e) => setTxt(e.target.value)}
           onChange={(e) => {
             const n = Number(e.target.value.replace(/\./g, '').replace(',', '.'));
             if (Number.isFinite(n)) onChange(Math.round(n * 100) / 100);
             else setTxt(betrag(value));
           }} />
  );
}

