import { useMemo, useRef, useState, type Dispatch, type PointerEvent, type SetStateAction } from 'react';
import {
  Button, DatePicker, Input, Label, MessageStrip, Option, Popover, SegmentedButton, SegmentedButtonItem, Select, Text, Title,
} from '@ui5/webcomponents-react';
import { Section } from '@core/components/Section';
import { toast } from '@core/toast';
import { dat, eur } from './util';
import './hallenpreise.css';

/**
 * Hallenpreise als Wochenplan (#11): die sieben Wochentage nebeneinander, je Preisgruppe (Einzelbuchung Winter/Sommer, Abo)
 * und Zeitraum. Preis links auswählen und im Plan als Block eintragen – wie eine Buchung. Blöcke lassen sich an den
 * Kanten verlängern, verschieben und auf andere Tage übernehmen. Gearbeitet wird auf denselben Daten wie in den Tabellen
 * (Produkte, Zeitfenster); Prüfen und Speichern bleiben unverändert.
 */
export interface Produkt { prod_key: string; valid_from: string; valid_to?: string; text: string; preis: number | string; typ: string | null; erloeskonto?: string | null }
export interface Fenster { prod_key: string; valid_from: string; tag: string; zeit_von: string; zeit_bis: string }
export interface Gruppe { gruppe: string; text: string; keys: string[] }

const TAGE = ['MONTAG', 'DIENSTAG', 'MITTWOCH', 'DONNERSTAG', 'FREITAG', 'SAMSTAG', 'SONNTAG'];
const TAG_TEXT: Record<string, string> = { MONTAG: 'Montag', DIENSTAG: 'Dienstag', MITTWOCH: 'Mittwoch', DONNERSTAG: 'Donnerstag', FREITAG: 'Freitag', SAMSTAG: 'Samstag', SONNTAG: 'Sonntag' };
const WERKTAGE = TAGE.slice(0, 5);
const WOCHENENDE = TAGE.slice(5);
const RASTER = 30;
const REM_JE_STD = 2.75;
const FARBEN = 5;

const min = (t: string) => (/^\d{1,2}:\d{2}/.test(t) ? Number(t.split(':')[0]) * 60 + Number(t.split(':')[1]) : NaN);
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const zeitOk = (t: string) => /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/.test(t);
const num = (v: number | string) => (typeof v === 'number' ? v : Number(String(v).replace(/\./g, '').replace(',', '.')));
const isoHeute = () => new Date().toISOString().slice(0, 10);
const vortag = (iso: string) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
const klemmen = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface Zug {
  art: 'neu' | 'oben' | 'unten' | 'move'; tag: string; f: Fenster | null; startM: number; y: number;
  von: number; bis: number; origVon: number; origBis: number; lo: number; hi: number; bewegt: boolean;
}

export function Wochenplan({ produkte, fenster, gruppen, edit, setProdukte, setFenster, geaendert, onFehler }: {
  produkte: Produkt[]; fenster: Fenster[]; gruppen: Gruppe[]; edit: boolean;
  setProdukte: Dispatch<SetStateAction<Produkt[]>>; setFenster: Dispatch<SetStateAction<Fenster[]>>;
  /** nach jeder Änderung: die Prüfung ist nicht mehr aktuell */
  geaendert: () => void; onFehler: (text: string | null) => void;
}) {
  const [gruppe, setGruppe] = useState('EINZEL_WINTER');
  const [zWahl, setZWahl] = useState<string | null>(null);
  const [keyWahl, setKeyWahl] = useState('');
  const [sel, setSel] = useState<Fenster | null>(null);
  const [vorschau, setVorschau] = useState<{ tag: string; von: number; bis: number; f: Fenster | null } | null>(null);
  const [neuAb, setNeuAb] = useState('');
  const zug = useRef<Zug | null>(null);
  const zuletztGezogen = useRef(0);

  const keys = useMemo(() => gruppen.find((g) => g.gruppe === gruppe)?.keys ?? [], [gruppen, gruppe]);
  // Zeiträume der Gruppe: jedes „Gültig ab“ eines ihrer Preise
  const zeitraeume = useMemo(() => [...new Set(produkte.filter((p) => keys.includes(p.prod_key)).map((p) => p.valid_from))].sort(), [produkte, keys]);
  const standard = [...zeitraeume].reverse().find((x) => x <= isoHeute()) ?? zeitraeume[0] ?? '';
  const z = zWahl && zeitraeume.includes(zWahl) ? zWahl : standard;
  const zBis = (ab: string) => { const n = zeitraeume.find((x) => x > ab); return n ? dat(vortag(n)) : 'unbegrenzt'; };

  /** je Schlüssel der Preis, der im gewählten Zeitraum gilt (jüngstes „Gültig ab“ bis zum Beginn des Zeitraums) */
  const gueltigAm = (stichtag: string) => {
    const m = new Map<string, { p: Produkt; i: number }>();
    produkte.forEach((p, i) => {
      if (!keys.includes(p.prod_key) || p.valid_from > stichtag) return;
      const alt = m.get(p.prod_key);
      if (!alt || alt.p.valid_from < p.valid_from) m.set(p.prod_key, { p, i });
    });
    return m;
  };
  const gueltig = useMemo(() => gueltigAm(z), [produkte, keys, z]); // eslint-disable-line react-hooks/exhaustive-deps
  const preise = keys.filter((k) => gueltig.has(k)).map((k) => ({ key: k, ...gueltig.get(k)!, farbe: keys.indexOf(k) % FARBEN }));
  const key = preise.some((x) => x.key === keyWahl) ? keyWahl : preise[0]?.key ?? '';
  const gewaehlt = preise.find((x) => x.key === key);
  const farbe = (k: string) => `portal-hpw__f${keys.indexOf(k) % FARBEN}`;

  /** Zeitfenster gehört zum Plan: Preis der Gruppe in der Fassung, die im Zeitraum gilt */
  const imPlan = (f: Fenster) => gueltig.get(f.prod_key)?.p.valid_from === f.valid_from && !Number.isNaN(min(f.zeit_von)) && !Number.isNaN(min(f.zeit_bis));
  const bloecke = fenster.map((f, i) => ({ f, i, von: min(f.zeit_von), bis: min(f.zeit_bis) })).filter((b) => imPlan(b.f) && b.bis > b.von);
  const von0 = Math.min(7 * 60, ...bloecke.map((b) => Math.floor(b.von / 60) * 60));
  const bis0 = Math.max(23 * 60, ...bloecke.map((b) => Math.ceil(b.bis / 60) * 60));
  const y = (m: number) => `${((m - von0) / 60) * REM_JE_STD}rem`;
  const h = (m: number) => `${(m / 60) * REM_JE_STD}rem`;
  const stunden: number[] = [];
  for (let m = von0; m <= bis0; m += 60) stunden.push(m);

  /** freie Zeit um [von, bis] am Tag: bis zum Ende des Blocks davor bzw. zum Beginn des Blocks danach */
  const grenzen = (tag: string, von: number, bis: number, ohne: Fenster | null): [number, number] => {
    const andere = bloecke.filter((b) => b.f.tag === tag && b.f !== ohne);
    return [Math.max(von0, ...andere.filter((b) => b.bis <= von).map((b) => b.bis)), Math.min(bis0, ...andere.filter((b) => b.von >= bis).map((b) => b.von))];
  };
  /** Zeiten ohne Preis je Tag (innerhalb des angezeigten Rasters) */
  const luecken = (tag: string) => {
    const out: [number, number][] = [];
    let m = von0;
    for (const b of bloecke.filter((x) => x.f.tag === tag).sort((a, c) => a.von - c.von)) {
      if (b.von > m) out.push([m, b.von]);
      m = Math.max(m, b.bis);
    }
    if (m < bis0) out.push([m, bis0]);
    return out;
  };
  const ohnePreis = TAGE.reduce((n, t) => n + luecken(t).length, 0);

  /** den Bereich [von, bis] am Tag aus den übrigen Blöcken des Plans herausschneiden (der neue Eintrag gewinnt) */
  const ausschneiden = (l: Fenster[], tag: string, von: number, bis: number, ohne: Fenster | null): Fenster[] => l.flatMap((f) => {
    if (f === ohne || f.tag !== tag || !imPlan(f)) return [f];
    const a = min(f.zeit_von), b = min(f.zeit_bis);
    if (b <= von || a >= bis) return [f];
    return [...(a < von ? [{ ...f, zeit_bis: hhmm(von) }] : []), ...(b > bis ? [{ ...f, zeit_von: hhmm(bis) }] : [])];
  });

  // ---------------------------------------------------------------- Ziehen im Plan
  const minuteAus = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return von0 + ((e.clientY - r.top) / r.height) * (bis0 - von0);
  };
  const runter = (tag: string) => (e: PointerEvent<HTMLDivElement>) => {
    if (!edit || e.button !== 0) return;
    const ziel = e.target as HTMLElement;
    const el = ziel.closest<HTMLElement>('[data-b]');
    const m = minuteAus(e);
    if (el) {
      const f = fenster[Number(el.dataset.b)];
      if (!f) return;
      const griff = ziel.closest<HTMLElement>('[data-griff]')?.dataset.griff;
      const von = min(f.zeit_von), bis = min(f.zeit_bis);
      const [lo, hi] = grenzen(tag, von, bis, f);
      zug.current = { art: griff === 'oben' ? 'oben' : griff === 'unten' ? 'unten' : 'move', tag, f, startM: m, y: e.clientY, von, bis, origVon: von, origBis: bis, lo: Math.min(lo, von), hi: Math.max(hi, bis), bewegt: false };
    } else {
      if (!key) { onFehler('Bitte zuerst links einen Preis auswählen bzw. anlegen.'); return; }
      const s = klemmen(Math.floor(m / RASTER) * RASTER, von0, bis0 - RASTER);
      const [lo, hi] = grenzen(tag, s, s, null);
      if (hi - lo < RASTER) return;
      const start = klemmen(s, lo, hi - RASTER);
      zug.current = { art: 'neu', tag, f: null, startM: start, y: e.clientY, von: start, bis: Math.min(start + 60, hi), origVon: start, origBis: start, lo, hi, bewegt: false };
      setVorschau({ tag, von: start, bis: Math.min(start + 60, hi), f: null });
      setSel(null);
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const bewegen = (e: PointerEvent<HTMLDivElement>) => {
    const g = zug.current;
    if (!g) return;
    if (Math.abs(e.clientY - g.y) > 4) g.bewegt = true;
    if (!g.bewegt) return;
    const m = Math.round(minuteAus(e) / RASTER) * RASTER;
    if (g.art === 'neu') {
      const a = klemmen(m, g.lo, g.hi);
      g.von = Math.min(g.startM, a);
      g.bis = Math.max(g.startM + RASTER, a);
      if (a < g.startM) g.bis = g.startM + RASTER;
      g.bis = Math.min(g.bis, g.hi);
    } else if (g.art === 'oben') g.von = klemmen(m, g.lo, g.bis - RASTER);
    else if (g.art === 'unten') g.bis = klemmen(m, g.von + RASTER, g.hi);
    else {
      const laenge = g.origBis - g.origVon;
      const delta = Math.round((minuteAus(e) - g.startM) / RASTER) * RASTER;
      g.von = klemmen(g.origVon + delta, g.lo, g.hi - laenge);
      g.bis = g.von + laenge;
    }
    setVorschau({ tag: g.tag, von: g.von, bis: g.bis, f: g.f });
  };
  const hoch = (e: PointerEvent<HTMLDivElement>) => {
    const g = zug.current;
    zug.current = null;
    setVorschau(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!g) return;
    if (g.bewegt) zuletztGezogen.current = Date.now();
    if (g.art === 'neu') {
      const p = gueltig.get(key);
      if (!p || g.bis - g.von < RASTER) return;
      const neu: Fenster = { prod_key: key, valid_from: p.p.valid_from, tag: g.tag, zeit_von: hhmm(g.von), zeit_bis: hhmm(g.bis) };
      setFenster((l) => [...l, neu]);
      geaendert();
      return;
    }
    const alt = g.f!;
    if (!g.bewegt) { setSel(alt); return; }
    if (g.von === g.origVon && g.bis === g.origBis) return;
    const neu = { ...alt, zeit_von: hhmm(g.von), zeit_bis: hhmm(g.bis) };
    setFenster((l) => l.map((x) => (x === alt ? neu : x)));
    if (sel === alt) setSel(neu);
    geaendert();
  };

  // ---------------------------------------------------------------- Block bearbeiten (Popover)
  const selIndex = sel ? fenster.indexOf(sel) : -1;
  const aendern = (f: Partial<Fenster>) => {
    if (!sel) return;
    const neu = { ...sel, ...f };
    const von = min(neu.zeit_von), bis = min(neu.zeit_bis);
    if (!zeitOk(neu.zeit_von) || !zeitOk(neu.zeit_bis) || !(bis > von)) { onFehler('Bitte gültige Uhrzeiten im Format HH:MM angeben (Von vor Bis).'); return; }
    onFehler(null);
    setFenster((l) => ausschneiden(l, neu.tag, von, bis, sel).map((x) => (x === sel ? neu : x)));
    setSel(neu);
    geaendert();
  };
  const uebernehmen = (tage: string[]) => {
    if (!sel) return;
    const von = min(sel.zeit_von), bis = min(sel.zeit_bis);
    const ziel = tage.filter((t) => t !== sel.tag);
    setFenster((l) => ziel.reduce((r, t) => [...ausschneiden(r, t, von, bis, null), { ...sel, tag: t }], l));
    geaendert();
    toast(`${sel.zeit_von}–${sel.zeit_bis} auf ${ziel.length} weitere${ziel.length === 1 ? 'n Tag' : ' Tage'} übernommen`);
  };
  const loeschen = () => {
    if (!sel) return;
    setFenster((l) => l.filter((x) => x !== sel));
    setSel(null);
    geaendert();
  };

  // ---------------------------------------------------------------- Preise und Zeiträume
  const setPreis = (i: number, f: Partial<Produkt>) => { setProdukte((l) => l.map((x, j) => (j === i ? { ...x, ...f } : x))); geaendert(); };
  const freierSchluessel = keys.find((k) => !gueltig.has(k));
  const preisAnlegen = () => {
    if (!freierSchluessel) return;
    setProdukte((l) => [...l, { prod_key: freierSchluessel, valid_from: z || isoHeute(), text: '', preis: 0, typ: gruppe === 'ABO' ? '1' : '2' }]);
    setKeyWahl(freierSchluessel);
    geaendert();
  };
  /** Vorschlag für einen neuen Zeitraum: Monatserster nach dem jüngsten Zeitraum bzw. nach heute */
  const vorschlagAb = () => {
    const basis = [zeitraeume[zeitraeume.length - 1] ?? '', isoHeute()].sort().pop()!;
    const d = new Date(`${basis.slice(0, 7)}-01T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    return d.toISOString().slice(0, 10);
  };
  const ab = neuAb || vorschlagAb();
  /** neuer Zeitraum: alle Preise der Gruppe mit ihren Zuordnungen ab dem Datum kopieren */
  const zeitraumAnlegen = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ab)) { onFehler('Bitte ein Datum für den neuen Zeitraum angeben.'); return; }
    if (zeitraeume.includes(ab)) { onFehler(`Ab ${dat(ab)} beginnt bereits ein Zeitraum.`); return; }
    const vorlage = [...gueltigAm(ab).values()].map((x) => x.p);
    if (!vorlage.length) { onFehler(`Am ${dat(ab)} gilt noch kein Preis dieser Gruppe, der kopiert werden könnte.`); return; }
    onFehler(null);
    setProdukte((l) => [...l, ...vorlage.map((p) => ({ ...p, valid_from: ab, valid_to: undefined }))]);
    setFenster((l) => [...l, ...l.filter((f) => vorlage.some((p) => p.prod_key === f.prod_key && p.valid_from === f.valid_from)).map((f) => ({ ...f, valid_from: ab }))]);
    setZWahl(ab);
    setNeuAb('');
    setSel(null);
    geaendert();
    toast(`Neuer Zeitraum ab ${dat(ab)} angelegt – Preise und Zuordnungen wurden übernommen und können jetzt angepasst werden`);
  };

  const blockInhalt = (k: string, von: number, bis: number) => {
    const p = gueltig.get(k)?.p;
    return (
      <>
        <b>{hhmm(von)}–{hhmm(bis)}</b>
        <b>{k} {p?.text}</b>
        {bis - von > 60 && p && <span>{eur(num(p.preis))} je Stunde</span>}
      </>
    );
  };

  return (
    <>
      <div className="portal-hpw__leiste">
        <div className="portal-hpw__feld">
          <Label>Preisgruppe</Label>
          <SegmentedButton onSelectionChange={(e) => { setGruppe((e.detail.selectedItems[0] as HTMLElement).dataset.g!); setZWahl(null); setSel(null); }}>
            {gruppen.map((g) => <SegmentedButtonItem key={g.gruppe} data-g={g.gruppe} selected={g.gruppe === gruppe}>{g.text}</SegmentedButtonItem>)}
          </SegmentedButton>
        </div>
        <div className="portal-hpw__feld">
          <Label>Zeitraum</Label>
          <Select style={{ width: '17rem' }} disabled={!zeitraeume.length} onChange={(e) => { setZWahl((e.detail.selectedOption as HTMLElement).dataset.z!); setSel(null); }}>
            {[...zeitraeume].reverse().map((x) => <Option key={x} data-z={x} selected={x === z}>{`${dat(x)} – ${zBis(x)}${x === standard ? ' (aktuell)' : ''}`}</Option>)}
          </Select>
        </div>
        {edit && (
          <div className="portal-hpw__feld">
            <Label>Neuer Zeitraum ab</Label>
            <div className="portal-row" style={{ flexWrap: 'nowrap' }}>
              <DatePicker style={{ width: '9.5rem' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={ab} onChange={(e) => setNeuAb(e.detail.value)} />
              <Button icon="duplicate" onClick={zeitraumAnlegen}>Anlegen</Button>
            </div>
          </div>
        )}
      </div>
      {ohnePreis > 0 && preise.length > 0 && (
        <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.75rem' }}>
          Im angezeigten Zeitraster gibt es schraffierte Zeiten ohne Preis. Buchungen dort ergeben in der Hallenabrechnung einen Preisfehler.
        </MessageStrip>
      )}

      <div className="portal-hpw">
        <Section title="Preise der Gruppe" count={preise.length}
                 actions={edit && freierSchluessel ? <Button design="Transparent" icon="add" onClick={preisAnlegen}>Preis</Button> : undefined}>
          <div className="portal-hpw__preise">
            {!preise.length && <Text className="portal-muted">Für diese Gruppe ist noch kein Preis angelegt.</Text>}
            {preise.map((x) => (
              <button key={x.key} type="button" className={`portal-hpw__preis ${farbe(x.key)}${x.key === key ? ' portal-hpw__preis--an' : ''}`} aria-pressed={x.key === key} onClick={() => setKeyWahl(x.key)}>
                <span className="portal-hpw__preis-farbe" aria-hidden="true" />
                <span className="portal-hpw__preis-text">
                  <span className="portal-hpw__preis-name">{x.key} {x.p.text || 'ohne Bezeichnung'}</span>
                  <span className="portal-muted portal-small">{x.key === key ? (edit ? 'ausgewählt – im Plan ziehen' : 'ausgewählt') : 'antippen zum Auswählen'}</span>
                </span>
                <span className="portal-hpw__preis-wert">{eur(num(x.p.preis))}</span>
              </button>
            ))}
            {gewaehlt && (
              <>
                <Title level="H6" style={{ marginTop: '0.5rem' }}>Ausgewählter Preis</Title>
                <div className="portal-hpw__feld">
                  <Label>Bezeichnung</Label>
                  <Input style={{ width: '100%' }} value={gewaehlt.p.text} readonly={!edit} onChange={(e) => setPreis(gewaehlt.i, { text: e.target.value })} />
                </div>
                <div className="portal-hpw__feld">
                  <Label>Preis je Stunde (EUR)</Label>
                  <Input style={{ width: '100%' }} value={String(gewaehlt.p.preis).replace('.', ',')} readonly={!edit} onChange={(e) => setPreis(gewaehlt.i, { preis: e.target.value })} />
                </div>
                <Text className="portal-muted portal-small">
                  Schlüssel {gewaehlt.key}, gültig ab {dat(gewaehlt.p.valid_from)}
                  {gewaehlt.p.valid_from !== z ? ' – der Preis wurde in diesem Zeitraum nicht neu angelegt; Änderungen wirken ab diesem Datum.' : ''}
                </Text>
              </>
            )}
            {edit && (
              <Text className="portal-muted portal-small" style={{ marginTop: '0.25rem' }}>
                Eintragen: Preis wählen, dann im Wochenplan von der Anfangs- zur Endzeit ziehen (Raster 30 Minuten). Ein Block lässt sich an den
                Kanten verlängern und verschieben; ein Klick öffnet Zeiten, Preis und „Übernehmen auf“.
              </Text>
            )}
          </div>
        </Section>

        <Section title="Wochenplan" flush>
          <div className="portal-hpw__plan">
            <div className="portal-hpw__kopf">
              <div />
              {TAGE.map((t) => <div key={t} className="portal-hpw__tag">{TAG_TEXT[t]}</div>)}
            </div>
            <div className="portal-hpw__raster" style={{ height: h(bis0 - von0) }}>
              <div className="portal-hpw__zeiten">
                {stunden.map((m) => <div key={m} className="portal-hpw__stunde" style={{ top: y(m) }}>{hhmm(m)}</div>)}
              </div>
              {TAGE.map((t) => (
                <div key={t} className={`portal-hpw__spalte${edit ? ' portal-hpw__spalte--pflege' : ''}`}
                     onPointerDown={runter(t)} onPointerMove={bewegen} onPointerUp={hoch} onPointerCancel={hoch}>
                  {stunden.slice(0, -1).map((m) => <div key={m} className="portal-hpw__linie" style={{ top: y(m) }} />)}
                  {preise.length > 0 && luecken(t).map(([a, b]) => (
                    <div key={a} className="portal-hpw__luecke" style={{ top: y(a), height: h(b - a) }}>{b - a >= 60 ? 'kein Preis' : ''}</div>
                  ))}
                  {bloecke.filter((b) => b.f.tag === t).map((b) => {
                    const lauf = vorschau?.f === b.f ? vorschau : null;
                    const von = lauf ? lauf.von : b.von;
                    const bis = lauf ? lauf.bis : b.bis;
                    return (
                      <button key={b.i} id={`hp-block-${b.i}`} type="button" data-b={b.i}
                              className={`portal-hpw__block ${farbe(b.f.prod_key)}${edit ? ' portal-hpw__block--pflege' : ''}${sel === b.f ? ' portal-hpw__block--an' : ''}${bis - von <= 30 ? ' portal-hpw__block--kurz' : ''}`}
                              style={{ top: y(von), height: h(bis - von) }}
                              title={`${TAG_TEXT[t]} ${hhmm(von)}–${hhmm(bis)} Uhr: ${b.f.prod_key} ${gueltig.get(b.f.prod_key)?.p.text ?? ''}`}
                              onClick={() => { if (edit && Date.now() - zuletztGezogen.current > 300) setSel(b.f); }}>
                        {edit && <span className="portal-hpw__griff portal-hpw__griff--oben" data-griff="oben" />}
                        {blockInhalt(b.f.prod_key, von, bis)}
                        {edit && <span className="portal-hpw__griff portal-hpw__griff--unten" data-griff="unten" />}
                      </button>
                    );
                  })}
                  {vorschau && !vorschau.f && vorschau.tag === t && (
                    <div className={`portal-hpw__block portal-hpw__block--neu ${farbe(key)}`} style={{ top: y(vorschau.von), height: h(vorschau.bis - vorschau.von) }}>
                      {blockInhalt(key, vorschau.von, vorschau.bis)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </Section>
      </div>

      {edit && sel && selIndex >= 0 && (
        <Popover open opener={`hp-block-${selIndex}`} placement="End" headerText={`Preiszuordnung · ${TAG_TEXT[sel.tag] ?? sel.tag}`} onClose={() => setSel(null)}>
          <div className="portal-hpw__dialog">
            <div className="portal-hpw__feld">
              <Label>Preis</Label>
              <Select style={{ width: '100%' }} onChange={(e) => { const k = (e.detail.selectedOption as HTMLElement).dataset.k!; aendern({ prod_key: k, valid_from: gueltig.get(k)!.p.valid_from }); }}>
                {preise.map((x) => <Option key={x.key} data-k={x.key} selected={x.key === sel.prod_key}>{`${x.key} ${x.p.text} · ${eur(num(x.p.preis))}`}</Option>)}
              </Select>
            </div>
            <div className="portal-hpw__dialog-zeit">
              <div className="portal-hpw__feld"><Label>Von</Label><Input style={{ width: '100%' }} value={sel.zeit_von} placeholder="HH:MM" onChange={(e) => aendern({ zeit_von: e.target.value.trim() })} /></div>
              <div className="portal-hpw__feld"><Label>Bis</Label><Input style={{ width: '100%' }} value={sel.zeit_bis} placeholder="HH:MM" onChange={(e) => aendern({ zeit_bis: e.target.value.trim() })} /></div>
            </div>
            <div className="portal-hpw__feld">
              <Label>Übernehmen auf</Label>
              <div className="portal-row">
                <Button onClick={() => uebernehmen(WERKTAGE)}>Mo–Fr</Button>
                <Button onClick={() => uebernehmen(WOCHENENDE)}>Sa/So</Button>
                <Button onClick={() => uebernehmen(TAGE)}>alle Tage</Button>
              </div>
              <Text className="portal-muted portal-small">Vorhandene Zuordnungen in dieser Zeit werden an den Zieltagen ersetzt.</Text>
            </div>
            <div className="portal-row" style={{ justifyContent: 'space-between' }}>
              <Button design="Negative" icon="delete" onClick={loeschen}>Löschen</Button>
              <Button design="Emphasized" onClick={() => setSel(null)}>Fertig</Button>
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}
