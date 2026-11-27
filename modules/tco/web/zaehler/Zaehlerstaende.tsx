import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BusyIndicator, Button, CheckBox, DatePicker, Dialog, Icon, Input, MessageStrip, MultiComboBox, MultiComboBoxItem, ObjectStatus, Option,
  SegmentedButton, SegmentedButtonItem, Select, Tab, TabContainer, Text, TextArea,
} from '@ui5/webcomponents-react';
import { FussLeiste } from '@core/components/DialogFuss';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { Filter, Filters, HeaderKpi } from '@core/components/Filters';
import { CheckField, FieldBox, FormGrid, TextField } from '@core/components/FormFields';
import { IconAktionen } from '@core/components/IconAktionen';
import { ImportDialog, ImportKnopf, type ImportSchritt } from '@core/components/ImportDialog';
import { PdfDialog, download } from '@core/components/PdfDialog';
import { Empty, Section } from '@core/components/Section';
import { feld } from '@core/components/Varianten';
import { useCan, useFunktion } from '@core/session';
import { toast } from '@core/toast';
import { dat, eur } from '../util';
import {
  ART_KURZ, FOTO_URL, MEDIUM_ICON, Z, dieserMonat, faelligkeit, mediumText, mitEinheit, monatPlus, periodeText, prozent, standText, vEinheit,
  zahl, zahlEingabe, zahlLesen,
} from './format';
import { SaeulenDiagramm, Sparkline } from './Diagramme';
import { StandErfassenDialog } from './StandErfassen';
import { QrDialog } from './QrCode';
import {
  MEDIEN, type Auswertung, type ImportErgebnis, type Medium, type Raster, type Zaehler, type ZaehlerDetail, type ZaehlerStamm, type ZaehlerZeile,
  type Zaehlerstand,
} from './typen';
import './zaehler.css';

/**
 * Zählerstände (TC Oberthal → Instandhaltung): Zählerstände von Strom, Gas, Wasser, Wärme, PV … erfassen und auswerten.
 * Reiter: Übersicht (alle Zähler mit Fälligkeit, Verbrauch, Prognose, Sparkline) · Auswertung (Zähler und Zeitraum wählen,
 * gruppierte Säulen je Zähler, Tabelle mit Summen) · Ablesungen (alle Stände, neueste zuerst) · Stammdaten (nur mit
 * tco.zaehler:admin, als letzter Reiter). Oben rechts: Zählerstand erfassen, Importieren (Funktion „tco.zaehler.import“),
 * Ablesebogen (PDF) und CSV-Export.
 */
type Reiter = 'uebersicht' | 'auswertung' | 'ablesungen' | 'stammdaten';
interface Ansicht extends Record<string, unknown> {
  tab: Reiter; medium: string; standort: string; nurUeberfaellig: boolean; inaktive: boolean; darstellung: 'karten' | 'liste';
  raster: Raster; wert: 'verbrauch' | 'kosten';
}
const LEER: Ansicht = { tab: 'uebersicht', medium: '', standort: '', nurUeberfaellig: false, inaktive: false, darstellung: 'karten', raster: 'monat', wert: 'verbrauch' };
/** Farbe folgt dem Zähler (Position in der Gesamtliste), nicht dem Rang in der Auswahl */
const farbeVon = (alle: { id: number }[], id: number) => (Math.max(0, alle.findIndex((z) => z.id === id)) % 11) + 1;

export function Zaehlerstaende() {
  const can = useCan();
  const funktion = useFunktion();
  const navigate = useNavigate();
  const admin = can('tco.zaehler:admin');
  const edit = can('tco.zaehler:edit');
  const importAn = edit && funktion('tco.zaehler.import');
  const [a, setAnsicht] = useState<Ansicht>(LEER);
  const setA = (x: Partial<Ansicht>) => setAnsicht((v) => ({ ...v, ...x }));
  const [zeilen, setZeilen] = useState<ZaehlerZeile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [erfassen, setErfassen] = useState(false);
  const [bogen, setBogen] = useState<string | null>(null);
  const [imp, setImp] = useState(false);
  const [stand, setStand] = useState(0);

  const laden = () => api.get<{ zeilen: ZaehlerZeile[] }>(`${Z}?alle=1`).then((r) => { setZeilen(r.zeilen); setStand((n) => n + 1); }).catch((e) => setError(e.message));
  useEffect(() => { laden(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const aktive = (zeilen ?? []).filter((z) => z.aktiv);
  const ueberfaellig = aktive.filter((z) => z.kennzahlen.ueberfaellig).length;
  const tab: Reiter = a.tab === 'stammdaten' && !admin ? 'uebersicht' : a.tab;

  async function exportieren() {
    try { await download(`${Z}/export.csv`, `zaehlerstaende-${dieserMonat()}.csv`); } catch (e) { setError((e as Error).message); }
  }

  return (
    <AppPage title="Zählerstände" subtitle="Strom, Gas, Wasser, Wärme und PV ablesen, Verbrauch auswerten und Kosten hochrechnen"
             varianten={{
               repid: 'tco.zaehler', ansicht: a, leer: LEER,
               onAnwenden: (v) => setAnsicht((x) => ({
                 tab: feld(v, 'tab', x.tab), medium: feld(v, 'medium', x.medium), standort: feld(v, 'standort', x.standort),
                 nurUeberfaellig: feld(v, 'nurUeberfaellig', x.nurUeberfaellig), inaktive: feld(v, 'inaktive', x.inaktive),
                 darstellung: feld(v, 'darstellung', x.darstellung), raster: feld(v, 'raster', x.raster), wert: feld(v, 'wert', x.wert),
               })),
             }}
             actions={<>
               {edit && <Button design="Emphasized" icon="add" disabled={!aktive.length} onClick={() => setErfassen(true)}>Zählerstand erfassen</Button>}
               {importAn && <ImportKnopf tooltip="Zählerstände aus einer CSV-Datei übernehmen" onClick={() => setImp(true)} />}
               <Button icon="print" tooltip="Ablesebogen aller aktiven Zähler mit letztem Stand zum Ausdrucken" onClick={() => setBogen(`${Z}/ablesebogen.pdf`)}>Ablesebogen</Button>
               <Button icon="excel-attachment" tooltip="Alle Zählerstände als CSV-Datei (Excel)" onClick={exportieren}>CSV-Export</Button>
             </>}
             header={
               <Filters>
                 <HeaderKpi label="Überfällige Ablesungen" value={zeilen ? String(ueberfaellig) : '–'} state={ueberfaellig ? 'Negative' : 'Positive'} />
                 <HeaderKpi label="Zähler gesamt (aktiv)" value={zeilen ? String(aktive.length) : '–'} />
               </Filters>
             }>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {!zeilen ? (!error && <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />) : (
        <TabContainer contentBackgroundDesign="Transparent" onTabSelect={(e) => setA({ tab: (e.detail.tab as HTMLElement).dataset.key as Reiter })}>
          <Tab data-key="uebersicht" text="Übersicht" selected={tab === 'uebersicht'}>
            {tab === 'uebersicht' && <Uebersicht zeilen={zeilen} a={a} setA={setA} onOeffnen={(id) => navigate(`/tco/zaehler/${id}`)} />}
          </Tab>
          <Tab data-key="auswertung" text="Auswertung" selected={tab === 'auswertung'}>
            {tab === 'auswertung' && <AuswertungTab zeilen={zeilen} a={a} setA={setA} onError={setError} />}
          </Tab>
          <Tab data-key="ablesungen" text="Ablesungen" selected={tab === 'ablesungen'}>
            {tab === 'ablesungen' && <Ablesungen zeilen={zeilen} stand={stand} onGeaendert={laden} onError={setError} />}
          </Tab>
          {admin && (
            <Tab data-key="stammdaten" text="Stammdaten" selected={tab === 'stammdaten'}>
              {tab === 'stammdaten' && <Stammdaten zeilen={zeilen} onGeaendert={laden} onError={setError} />}
            </Tab>
          )}
        </TabContainer>
      )}
      {erfassen && zeilen && (
        <StandErfassenDialog zaehler={zeilen} onClose={() => setErfassen(false)} onGespeichert={() => { setErfassen(false); laden(); }} />
      )}
      {imp && <ImportStaende onClose={() => setImp(false)} onUebernommen={laden} />}
      <PdfDialog url={bogen} title="Ablesebogen" filename={`ablesebogen-${dieserMonat()}.pdf`} onClose={() => setBogen(null)} />
    </AppPage>
  );
}

// ---------------------------------------------------------------- Übersicht: Karten oder Liste aller Zähler
function Uebersicht({ zeilen, a, setA, onOeffnen }: { zeilen: ZaehlerZeile[]; a: Ansicht; setA: (x: Partial<Ansicht>) => void; onOeffnen: (id: number) => void }) {
  const standorte = [...new Set(zeilen.map((z) => z.standort).filter((s): s is string => !!s))].sort((x, y) => x.localeCompare(y, 'de'));
  const sicht = zeilen
    .filter((z) => a.inaktive || z.aktiv)
    .filter((z) => !a.medium || z.medium === a.medium)
    .filter((z) => !a.standort || z.standort === a.standort)
    .filter((z) => !a.nurUeberfaellig || (z.aktiv && z.kennzahlen.ueberfaellig))
    // überfällige zuerst, dann Standort und Nummer
    .sort((x, y) => Number(y.aktiv && y.kennzahlen.ueberfaellig) - Number(x.aktiv && x.kennzahlen.ueberfaellig)
      || (x.standort ?? '').localeCompare(y.standort ?? '', 'de') || x.nummer.localeCompare(y.nummer));
  return (
    <>
      <Filters>
        <Filter label="Medium">
          <Select onChange={(e) => setA({ medium: (e.detail.selectedOption as HTMLElement).dataset.k ?? '' })}>
            <Option data-k="" selected={!a.medium}>Alle</Option>
            {MEDIEN.map((m) => <Option key={m.key} data-k={m.key} selected={a.medium === m.key}>{m.text}</Option>)}
          </Select>
        </Filter>
        <Filter label="Standort">
          <Select onChange={(e) => setA({ standort: (e.detail.selectedOption as HTMLElement).dataset.k ?? '' })}>
            <Option data-k="" selected={!a.standort}>Alle</Option>
            {standorte.map((s) => <Option key={s} data-k={s} selected={a.standort === s}>{s}</Option>)}
          </Select>
        </Filter>
        <Filter label="Auswahl">
          <div className="portal-row">
            <CheckBox text="nur überfällige" checked={a.nurUeberfaellig} onChange={(e) => setA({ nurUeberfaellig: e.target.checked })} />
            <CheckBox text="inaktive zeigen" checked={a.inaktive} onChange={(e) => setA({ inaktive: e.target.checked })} />
          </div>
        </Filter>
        <Filter label="Darstellung" end>
          <SegmentedButton onSelectionChange={(e) => setA({ darstellung: (e.detail.selectedItems[0] as HTMLElement).dataset.k as Ansicht['darstellung'] })}>
            <SegmentedButtonItem data-k="karten" icon="grid" tooltip="Karten" selected={a.darstellung === 'karten'} />
            <SegmentedButtonItem data-k="liste" icon="list" tooltip="Liste" selected={a.darstellung === 'liste'} />
          </SegmentedButton>
        </Filter>
      </Filters>
      {!zeilen.length ? (
        <Section><Empty>Noch keine Zähler angelegt{' '}– im Reiter „Stammdaten“ einen Zähler anlegen.</Empty></Section>
      ) : !sicht.length ? (
        <Section><Empty>Keine Zähler zu dieser Auswahl.</Empty></Section>
      ) : a.darstellung === 'karten' ? (
        <div className="zs-karten">{sicht.map((z) => <ZaehlerKarte key={z.id} z={z} onClick={() => onOeffnen(z.id)} />)}</div>
      ) : (
        <Section flush>
          <div className="portal-tabrahmen">
            <table className="zs-tabelle">
              <thead><tr>
                <th>Zähler</th><th>Standort</th><th>Status</th><th className="zahl">Letzter Stand</th><th>am</th>
                <th className="zahl">Verbrauch lfd. Jahr</th><th className="zahl">Prognose</th><th className="zahl">ggü. Vorjahr</th><th className="zahl">Kosten-Prognose</th><th>12 Monate</th>
              </tr></thead>
              <tbody>
                {sicht.map((z) => {
                  const k = z.kennzahlen, ve = vEinheit(z), f = faelligkeit(k);
                  return (
                    <tr key={z.id} className={`zs-klick${z.aktiv ? '' : ' zs-inaktiv'}`} onClick={() => onOeffnen(z.id)}>
                      <td><Icon name={MEDIUM_ICON[z.medium]} style={{ verticalAlign: 'middle', marginRight: '0.375rem' }} accessibleName={mediumText(z.medium)} />{z.nummer} · {z.bezeichnung}</td>
                      <td>{z.standort ?? ''}</td>
                      <td>{z.aktiv ? <ObjectStatus state={f.state}>{f.text}</ObjectStatus> : <ObjectStatus state="None">inaktiv</ObjectStatus>}</td>
                      <td className="zahl">{k.letzteAblesung ? `${standText(k.letzteAblesung.stand)} ${z.einheit}` : '–'}</td>
                      <td>{k.letzteAblesung ? dat(k.letzteAblesung.datum) : ''}</td>
                      <td className="zahl">{mitEinheit(k.verbrauchJahr, ve)}</td>
                      <td className="zahl">{mitEinheit(k.prognoseJahr, ve)}</td>
                      <td className="zahl"><Veraenderung v={k.veraenderungProzent} /></td>
                      <td className="zahl">{k.kostenPrognoseJahr !== null ? eur(k.kostenPrognoseJahr) : '–'}</td>
                      <td><Sparkline werte={z.verlauf12} titel="Monatsverbrauch der letzten 12 Monate" fmt={(v) => mitEinheit(v, ve)} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </>
  );
}

/** Veränderung ggü. Vorjahr: Mehrverbrauch Critical, Einsparung Positive */
function Veraenderung({ v }: { v: number | null }) {
  if (v === null) return <>–</>;
  return <ObjectStatus state={v > 5 ? 'Critical' : v < -5 ? 'Positive' : 'None'}>{prozent(v)}</ObjectStatus>;
}

function ZaehlerKarte({ z, onClick }: { z: ZaehlerZeile; onClick: () => void }) {
  const k = z.kennzahlen, ve = vEinheit(z), f = faelligkeit(k);
  return (
    <button type="button" className={`zs-karte${z.aktiv ? '' : ' zs-karte--inaktiv'}`} onClick={onClick}>
      <div className="zs-karte__kopf">
        <Icon name={MEDIUM_ICON[z.medium]} accessibleName={mediumText(z.medium)} style={{ width: '1.5rem', height: '1.5rem', color: 'var(--sapContent_IconColor)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="zs-karte__titel">{z.bezeichnung}</div>
          <div className="portal-muted portal-small">{z.nummer} · {mediumText(z.medium)}{z.standort ? ` · ${z.standort}` : ''}</div>
          {z.aktiv ? <ObjectStatus state={f.state} showDefaultIcon={f.state !== 'None'}>{f.text}</ObjectStatus> : <ObjectStatus state="None" inverted>inaktiv</ObjectStatus>}
        </div>
      </div>
      <div className="zs-karte__werte">
        <div><div className="zs-karte__label">Letzter Stand</div>{k.letzteAblesung ? `${standText(k.letzteAblesung.stand)} ${z.einheit}` : '–'}
          {k.letzteAblesung && <div className="portal-muted portal-small">am {dat(k.letzteAblesung.datum)}</div>}</div>
        <div><div className="zs-karte__label">Verbrauch lfd. Jahr</div>{mitEinheit(k.verbrauchJahr, ve)}</div>
        <div><div className="zs-karte__label">Prognose Jahr</div>{mitEinheit(k.prognoseJahr, ve)} <Veraenderung v={k.veraenderungProzent} /></div>
        <div><div className="zs-karte__label">Kosten-Prognose</div>{k.kostenPrognoseJahr !== null ? eur(k.kostenPrognoseJahr) : '–'}</div>
      </div>
      <div className="zs-karte__fuss">
        <span className="zs-karte__label">Monatsverbrauch 12 Monate</span>
        {z.verlauf12.length > 1 ? <Sparkline werte={z.verlauf12} titel="Monatsverbrauch der letzten 12 Monate" fmt={(v) => mitEinheit(v, ve)} /> : <span className="portal-muted portal-small">noch kein Verlauf</span>}
        {k.zielUeberschritten && <ObjectStatus state="Critical" showDefaultIcon>Jahresziel überschritten</ObjectStatus>}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------- Auswertung: Zähler × Zeitraum, Säulen je Zähler, Tabelle mit Summen
function AuswertungTab({ zeilen, a, setA, onError }: { zeilen: ZaehlerZeile[]; a: Ansicht; setA: (x: Partial<Ansicht>) => void; onError: (e: string) => void }) {
  const [ids, setIds] = useState<number[]>(() => zeilen.filter((z) => z.aktiv).map((z) => z.id));
  const [bis, setBis] = useState(dieserMonat());
  const [von, setVon] = useState(monatPlus(dieserMonat(), -11));
  const [daten, setDaten] = useState<Auswertung | null>(null);
  const [laedt, setLaedt] = useState(false);
  const raster = a.raster, kosten = a.wert === 'kosten';
  const zeitraumFalsch = von > bis;

  useEffect(() => {
    if (!ids.length || zeitraumFalsch) { setDaten(null); return; }
    let ok = true;
    setLaedt(true);
    api.get<Auswertung>(`${Z}/auswertung?ids=${ids.join(',')}&von=${von}&bis=${bis}&raster=${raster}`)
      .then((d) => { if (ok) setDaten(d); }).catch((e) => onError(e.message)).finally(() => { if (ok) setLaedt(false); });
    return () => { ok = false; };
  }, [ids.join(','), von, bis, raster]); // eslint-disable-line react-hooks/exhaustive-deps

  async function exportieren() {
    try { await download(`${Z}/export.csv?ids=${ids.join(',')}&von=${von}&bis=${bis}`, `zaehlerstaende-${von}-${bis}.csv`); } catch (e) { onError((e as Error).message); }
  }

  // Verbrauch: nach Einheit gruppieren (kWh und m³ nicht auf einer Achse); Kosten: alles in €
  const gruppen = new Map<string, Auswertung['reihen']>();
  for (const r of daten?.reihen ?? []) {
    const key = kosten ? '€' : r.einheit || '(ohne Einheit)';
    gruppen.set(key, [...(gruppen.get(key) ?? []), r]);
  }
  const fmt = (einheit: string) => (v: number) => (kosten ? eur(v) : mitEinheit(v, einheit));
  const sortiert = [...zeilen].sort((x, y) => Number(y.aktiv) - Number(x.aktiv) || x.nummer.localeCompare(y.nummer));

  return (
    <>
      <Filters>
        <Filter label="Zähler">
          <MultiComboBox style={{ minWidth: '14rem' }} noTypeahead accessibleName="Zähler" placeholder="Zähler wählen"
                         onSelectionChange={(x) => setIds((x.detail.items as unknown as HTMLElement[]).map((i) => Number(i.dataset.id)).filter(Boolean))}>
            {sortiert.map((z) => <MultiComboBoxItem key={z.id} data-id={z.id} text={`${z.nummer} ${z.bezeichnung}${z.aktiv ? '' : ' (inaktiv)'}`} selected={ids.includes(z.id)} />)}
          </MultiComboBox>
        </Filter>
        <Filter label="Von (Monat)">
          <DatePicker formatPattern="MM.yyyy" valueFormat="yyyy-MM" value={von} style={{ width: '9rem' }} onChange={(e) => e.detail.value && setVon(e.detail.value)} />
        </Filter>
        <Filter label="Bis (Monat)">
          <DatePicker formatPattern="MM.yyyy" valueFormat="yyyy-MM" value={bis} style={{ width: '9rem' }} onChange={(e) => e.detail.value && setBis(e.detail.value)} />
        </Filter>
        <Filter label="Raster">
          <SegmentedButton onSelectionChange={(e) => setA({ raster: (e.detail.selectedItems[0] as HTMLElement).dataset.k as Raster })}>
            <SegmentedButtonItem data-k="monat" selected={raster === 'monat'}>Monat</SegmentedButtonItem>
            <SegmentedButtonItem data-k="jahr" selected={raster === 'jahr'}>Jahr</SegmentedButtonItem>
          </SegmentedButton>
        </Filter>
        <Filter label="Wert">
          <SegmentedButton onSelectionChange={(e) => setA({ wert: (e.detail.selectedItems[0] as HTMLElement).dataset.k as Ansicht['wert'] })}>
            <SegmentedButtonItem data-k="verbrauch" selected={!kosten}>Verbrauch</SegmentedButtonItem>
            <SegmentedButtonItem data-k="kosten" selected={kosten}>Kosten</SegmentedButtonItem>
          </SegmentedButton>
        </Filter>
        <Filter label="Auswahl" end>
          <Button icon="excel-attachment" disabled={!ids.length || zeitraumFalsch} tooltip="Zählerstände der gewählten Zähler im Zeitraum als CSV" onClick={exportieren}>CSV-Export</Button>
        </Filter>
      </Filters>
      {zeitraumFalsch && <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>„Von“ liegt nach „Bis“ – bitte den Zeitraum korrigieren.</MessageStrip>}
      {!ids.length ? <Section><Empty>Bitte mindestens einen Zähler wählen.</Empty></Section> : !daten ? (
        laedt && <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />
      ) : (
        <>
          {!kosten && gruppen.size > 1 && (
            <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.5rem' }}>
              Die gewählten Zähler messen in unterschiedlichen Einheiten ({[...gruppen.keys()].join(', ')}) – je Einheit ein eigenes Diagramm. Zum Vergleich über alle Zähler „Kosten“ wählen.
            </MessageStrip>
          )}
          {kosten && daten.reihen.some((r) => r.kostenSumme === null) && (
            <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.5rem' }}>
              Für Zähler ohne Preise (Stammdaten: Arbeits- bzw. Grundpreis) sind keine Kosten berechnet.
            </MessageStrip>
          )}
          {[...gruppen.entries()].map(([einheit, reihen]) => (
            <Section key={einheit} title={kosten ? `Kosten je ${raster === 'monat' ? 'Monat' : 'Jahr'}` : `Verbrauch je ${raster === 'monat' ? 'Monat' : 'Jahr'} in ${einheit}`}>
              <SaeulenDiagramm titel={kosten ? 'Kosten in €' : `Verbrauch in ${einheit}`} kategorien={daten.perioden} fmt={fmt(einheit)}
                               kategorieText={(p, schmal) => (schmal && p.length > 4 ? periodeText(p).slice(0, 3) : periodeText(p))}
                               reihen={reihen.map((r) => ({ name: r.bezeichnung, farbe: farbeVon(zeilen, r.zaehlerId), werte: kosten ? r.kosten : r.verbrauch }))} />
              <div className="portal-tabrahmen">
                <table className="zs-tabelle">
                  <thead><tr><th>{raster === 'monat' ? 'Monat' : 'Jahr'}</th>{reihen.map((r) => <th key={r.zaehlerId} className="zahl">{r.bezeichnung}</th>)}{reihen.length > 1 && <th className="zahl">Summe</th>}</tr></thead>
                  <tbody>
                    {daten.perioden.map((p, i) => {
                      const werte = reihen.map((r) => (kosten ? r.kosten[i] : r.verbrauch[i]));
                      const summe = werte.reduce<number | null>((s, v) => (v === null ? s : (s ?? 0) + v), null);
                      return (
                        <tr key={p}>
                          <td>{periodeText(p, true)}</td>
                          {werte.map((v, j) => <td key={j} className="zahl">{v === null ? '–' : fmt(einheit)(v)}</td>)}
                          {reihen.length > 1 && <td className="zahl">{summe === null ? '–' : fmt(einheit)(summe)}</td>}
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot><tr>
                    <td>Summe</td>
                    {reihen.map((r) => <td key={r.zaehlerId} className="zahl">{kosten ? (r.kostenSumme === null ? '–' : eur(r.kostenSumme)) : mitEinheit(r.summe, einheit)}</td>)}
                    {reihen.length > 1 && <td className="zahl">{kosten ? eur(reihen.reduce((s, r) => s + (r.kostenSumme ?? 0), 0)) : mitEinheit(reihen.reduce((s, r) => s + r.summe, 0), einheit)}</td>}
                  </tr></tfoot>
                </table>
              </div>
            </Section>
          ))}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Ablesungen: alle Stände aller Zähler, neueste zuerst
interface AbleseZeile extends Zaehlerstand { zaehler: ZaehlerZeile }
function Ablesungen({ zeilen, stand, onGeaendert, onError }: { zeilen: ZaehlerZeile[]; stand: number; onGeaendert: () => void; onError: (e: string) => void }) {
  const can = useCan();
  const navigate = useNavigate();
  const edit = can('tco.zaehler:edit');
  const [liste, setListe] = useState<AbleseZeile[] | null>(null);
  const [zaehlerFilter, setZaehlerFilter] = useState(0);
  const [aendern, setAendern] = useState<AbleseZeile | null>(null);
  const [loeschen, setLoeschen] = useState<AbleseZeile | null>(null);
  const [foto, setFoto] = useState<AbleseZeile | null>(null);

  // Es gibt keinen Listen-Endpunkt über alle Zähler: die Stände kommen aus den Detailseiten der Zähler (GET /zaehler/:id)
  useEffect(() => {
    let ok = true;
    setListe(null);
    Promise.all(zeilen.map((z) => api.get<ZaehlerDetail>(`${Z}/${z.id}`).then((d) => d.staende.map((s) => ({ ...s, zaehler: z })))))
      .then((l) => { if (ok) setListe(l.flat().sort((x, y) => y.datum.localeCompare(x.datum) || y.id - x.id)); })
      .catch((e) => onError(e.message));
    return () => { ok = false; };
  }, [stand]); // eslint-disable-line react-hooks/exhaustive-deps

  async function standLoeschen(reason: string) {
    const s = loeschen!;
    setLoeschen(null);
    try { await api.del(`${Z}/staende/${s.id}`, { reason }); toast('Zählerstand gelöscht'); onGeaendert(); } catch (e) { onError((e as Error).message); }
  }

  const sicht = (liste ?? []).filter((s) => !zaehlerFilter || s.zaehler_id === zaehlerFilter);
  return (
    <>
      <Filters>
        <Filter label="Zähler">
          <Select onChange={(e) => setZaehlerFilter(Number((e.detail.selectedOption as HTMLElement).dataset.id))}>
            <Option data-id="0" selected={!zaehlerFilter}>Alle</Option>
            {zeilen.map((z) => <Option key={z.id} data-id={z.id} selected={zaehlerFilter === z.id}>{`${z.nummer} ${z.bezeichnung}`}</Option>)}
          </Select>
        </Filter>
      </Filters>
      <Section title="Ablesungen" count={liste ? sicht.length : undefined} flush>
        {!liste ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : !sicht.length ? <Empty>Noch keine Ablesungen.</Empty> : (
          <div className="portal-tabrahmen">
            <table className="zs-tabelle">
              <thead><tr>
                <th>Datum</th><th>Zähler</th><th className="zahl">Stand</th><th>Art</th><th className="zahl">Verbrauch seit vorher</th>
                <th>Notiz</th><th>Erfasst von</th><th>Foto</th>{edit && <th />}
              </tr></thead>
              <tbody>
                {sicht.map((s) => (
                  <tr key={s.id} className="zs-klick" onClick={() => navigate(`/tco/zaehler/${s.zaehler_id}`)}>
                    <td>{dat(s.datum)}</td>
                    <td><Icon name={MEDIUM_ICON[s.zaehler.medium]} style={{ verticalAlign: 'middle', marginRight: '0.375rem' }} accessibleName={mediumText(s.zaehler.medium)} />{s.zaehler.nummer} · {s.zaehler.bezeichnung}</td>
                    <td className="zahl">{standText(s.stand)} {s.zaehler.einheit}</td>
                    <td><ObjectStatus state={s.art === 'SCHAETZUNG' ? 'Critical' : s.art === 'ABLESUNG' ? 'None' : 'Information'}>{ART_KURZ[s.art]}</ObjectStatus></td>
                    <td className="zahl">{mitEinheit(s.verbrauch, vEinheit(s.zaehler))}</td>
                    <td className="umbruch">{s.notiz ?? ''}</td>
                    <td>{s.erfasstVon ?? ''}</td>
                    <td>{s.hatFoto && <Button design="Transparent" icon="camera" tooltip="Foto ansehen" onClick={(e) => { e.stopPropagation(); setFoto(s); }} />}</td>
                    {edit && (
                      <td><IconAktionen items={[
                        { text: 'Ändern', icon: 'edit', onClick: () => setAendern(s) },
                        { text: 'Löschen', icon: 'delete', onClick: () => setLoeschen(s) },
                      ]} /></td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      {aendern && (
        <StandErfassenDialog zaehler={zeilen} zaehlerId={aendern.zaehler_id} bearbeiten={aendern}
                             onClose={() => setAendern(null)} onGespeichert={() => { setAendern(null); onGeaendert(); }} />
      )}
      <ConfirmDialog open={!!loeschen} danger askReason title="Zählerstand löschen" confirmText="Löschen"
                     text={loeschen ? `Ablesung ${loeschen.zaehler.nummer} vom ${dat(loeschen.datum)} (${standText(loeschen.stand)} ${loeschen.zaehler.einheit}) löschen?` : ''}
                     onConfirm={standLoeschen} onCancel={() => setLoeschen(null)} />
      {foto && (
        <Dialog open headerText={`${foto.zaehler.nummer} · Ablesung vom ${dat(foto.datum)}`} onClose={() => setFoto(null)} style={{ width: 'min(52rem, 96vw)' }}
                footer={<FussLeiste endContent={<Button onClick={() => setFoto(null)}>Schließen</Button>} />}>
          <img src={FOTO_URL(foto.id)} alt={`Zählwerk am ${dat(foto.datum)}`} style={{ display: 'block', maxWidth: '100%', maxHeight: '70vh', margin: '0 auto' }} />
        </Dialog>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Stammdaten: Zähler anlegen, ändern, deaktivieren, löschen
function Stammdaten({ zeilen, onGeaendert, onError }: { zeilen: ZaehlerZeile[]; onGeaendert: () => void; onError: (e: string) => void }) {
  const [dlg, setDlg] = useState<Zaehler | 'neu' | null>(null);
  const [loeschen, setLoeschen] = useState<Zaehler | null>(null);
  const [qr, setQr] = useState<Zaehler | null>(null);
  const liste = [...zeilen].sort((x, y) => Number(y.aktiv) - Number(x.aktiv) || x.nummer.localeCompare(y.nummer));

  async function aktivSetzen(z: Zaehler, aktiv: boolean) {
    try {
      await api.put(`${Z}/${z.id}`, { ...stammVon(z), aktiv } satisfies ZaehlerStamm);
      toast(aktiv ? `${z.nummer} wieder aktiv` : `${z.nummer} deaktiviert`);
      onGeaendert();
    } catch (e) { onError((e as Error).message); }
  }
  async function entfernen(reason: string) {
    const z = loeschen!;
    setLoeschen(null);
    try { await api.del(`${Z}/${z.id}`, { reason }); toast(`${z.nummer} gelöscht`); onGeaendert(); } catch (e) { onError((e as Error).message); }
  }

  return (
    <>
      <Section title="Zähler" count={zeilen.length} flush actions={<Button icon="add" onClick={() => setDlg('neu')}>Zähler anlegen</Button>}>
        {!liste.length ? <Empty>Noch kein Zähler angelegt.</Empty> : (
          <div className="portal-tabrahmen">
            <table className="zs-tabelle">
              <thead><tr>
                <th>Nummer</th><th>Bezeichnung</th><th>Medium</th><th>Standort</th><th>Einheit</th><th className="zahl">Faktor</th>
                <th className="zahl">Intervall</th><th className="zahl">Preise</th><th className="zahl">Jahresziel</th><th>Status</th><th />
              </tr></thead>
              <tbody>
                {liste.map((z) => (
                  <tr key={z.id} className={z.aktiv ? undefined : 'zs-inaktiv'}>
                    <td>{z.nummer}</td>
                    <td>{z.bezeichnung}</td>
                    <td><Icon name={MEDIUM_ICON[z.medium]} style={{ verticalAlign: 'middle', marginRight: '0.375rem' }} />{mediumText(z.medium)}</td>
                    <td>{z.standort ?? ''}</td>
                    <td>{z.einheit}{z.verbrauchseinheit && z.verbrauchseinheit !== z.einheit ? ` → ${z.verbrauchseinheit}` : ''}</td>
                    <td className="zahl">{zahl(z.faktor, 4)}</td>
                    <td className="zahl">{z.intervall_tage ? `${z.intervall_tage} Tage` : '–'}</td>
                    <td className="zahl">
                      {z.arbeitspreis !== null ? `${eur(z.arbeitspreis)}/${vEinheit(z) || 'Einheit'}` : '–'}
                      {z.grundpreis_monat !== null && <div className="portal-muted portal-small">{`+ ${eur(z.grundpreis_monat)}/Monat`}</div>}
                    </td>
                    <td className="zahl">{z.jahresziel !== null ? mitEinheit(z.jahresziel, vEinheit(z)) : '–'}</td>
                    <td><ObjectStatus state={z.aktiv ? 'Positive' : 'None'}>{z.aktiv ? 'aktiv' : 'inaktiv'}</ObjectStatus></td>
                    <td><IconAktionen items={[
                      { text: 'Ändern', icon: 'edit', onClick: () => setDlg(z) },
                      { text: 'QR-Code für den Zähler', icon: 'qr-code', onClick: () => setQr(z), hidden: !z.aktiv },
                      { text: 'Deaktivieren', icon: 'hide', onClick: () => aktivSetzen(z, false), hidden: !z.aktiv },
                      { text: 'Wieder aktivieren', icon: 'show', onClick: () => aktivSetzen(z, true), hidden: z.aktiv },
                      { text: 'Löschen', icon: 'delete', onClick: () => setLoeschen(z) },
                    ]} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Text className="portal-muted portal-small">
        Löschen geht nur bei Zählern ohne Ablesungen. Wird ein Zähler nicht mehr abgelesen, ihn deaktivieren – seine Stände bleiben für Auswertungen und Vorjahresvergleiche erhalten.
      </Text>
      {dlg && <ZaehlerStammDialog zaehler={dlg === 'neu' ? null : dlg} onClose={() => setDlg(null)} onGesichert={() => { setDlg(null); onGeaendert(); }} />}
      {qr && <QrDialog id={qr.id} nummer={qr.nummer} bezeichnung={qr.bezeichnung} standort={qr.standort} onClose={() => setQr(null)} />}
      <ConfirmDialog open={!!loeschen} danger askReason title="Zähler löschen" confirmText="Löschen"
                     text={loeschen ? `Zähler ${loeschen.nummer} (${loeschen.bezeichnung}) löschen?\n\nLöschen geht nur ohne Ablesungen – einen Zähler mit Ständen bitte deaktivieren.` : ''}
                     onConfirm={entfernen} onCancel={() => setLoeschen(null)} />
    </>
  );
}

const stammVon = (z: Zaehler): ZaehlerStamm => ({
  bezeichnung: z.bezeichnung, medium: z.medium, einheit: z.einheit, standort: z.standort, zaehlernummer: z.zaehlernummer, faktor: z.faktor,
  verbrauchseinheit: z.verbrauchseinheit, stellen: z.stellen, intervall_tage: z.intervall_tage, arbeitspreis: z.arbeitspreis,
  grundpreis_monat: z.grundpreis_monat, jahresziel: z.jahresziel, aktiv: z.aktiv, notiz: z.notiz,
});
const einheitVon = (m: Medium) => MEDIEN.find((x) => x.key === m)?.einheit ?? '';

/** Formular „Zähler anlegen/ändern“ mit allen Feldern der Stammdaten (auch von der Objektseite aufgerufen) */
export function ZaehlerStammDialog({ zaehler, onClose, onGesichert }: { zaehler: Zaehler | null; onClose: () => void; onGesichert: (id: number) => void }) {
  const start = zaehler ? stammVon(zaehler) : null;
  const [f, setF] = useState({
    bezeichnung: start?.bezeichnung ?? '', medium: (start?.medium ?? 'STROM') as Medium, einheit: start?.einheit ?? 'kWh', standort: start?.standort ?? '',
    zaehlernummer: start?.zaehlernummer ?? '', faktor: zahlEingabe(start?.faktor ?? 1), verbrauchseinheit: start?.verbrauchseinheit ?? '',
    stellen: start?.stellen != null ? String(start.stellen) : '', intervall_tage: start?.intervall_tage != null ? String(start.intervall_tage) : '30',
    arbeitspreis: zahlEingabe(start?.arbeitspreis), grundpreis_monat: zahlEingabe(start?.grundpreis_monat), jahresziel: zahlEingabe(start?.jahresziel),
    aktiv: start?.aktiv ?? true, notiz: start?.notiz ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const hilfe = (t: string) => <Text className="portal-muted portal-small">{t}</Text>;

  async function sichern() {
    setError(null);
    const num = (t: string, name: string, ganz = false): number | null | false => {
      if (!t.trim()) return null;
      const n = zahlLesen(t);
      if (n === null || n < 0 || (ganz && !Number.isInteger(n))) { setError(`„${name}“ ist keine gültige ${ganz ? 'ganze ' : ''}Zahl.`); return false; }
      return n;
    };
    if (!f.bezeichnung.trim()) { setError('Bitte eine Bezeichnung angeben.'); return; }
    const faktor = num(f.faktor, 'Faktor'), stellen = num(f.stellen, 'Stellen', true), intervall = num(f.intervall_tage, 'Ableseintervall', true);
    const ap = num(f.arbeitspreis, 'Arbeitspreis'), gp = num(f.grundpreis_monat, 'Grundpreis'), ziel = num(f.jahresziel, 'Jahresziel');
    if ([faktor, stellen, intervall, ap, gp, ziel].includes(false)) return;
    if (faktor === 0) { setError('Der Faktor darf nicht 0 sein.'); return; }
    const body: ZaehlerStamm = {
      bezeichnung: f.bezeichnung.trim(), medium: f.medium, einheit: f.einheit.trim(), standort: f.standort.trim() || null,
      zaehlernummer: f.zaehlernummer.trim() || null, faktor: (faktor as number | null) ?? 1, verbrauchseinheit: f.verbrauchseinheit.trim() || null,
      stellen: stellen as number | null, intervall_tage: intervall as number | null, arbeitspreis: ap as number | null,
      grundpreis_monat: gp as number | null, jahresziel: ziel as number | null, aktiv: f.aktiv, notiz: f.notiz.trim() || null,
    };
    setBusy(true);
    try {
      if (zaehler) { await api.put(`${Z}/${zaehler.id}`, body); toast(`${zaehler.nummer} gesichert`); onGesichert(zaehler.id); } else {
        const r = await api.post<{ id: number; nummer?: string }>(Z, body);
        toast(`Zähler ${r.nummer ?? ''} angelegt`.replace('  ', ' '));
        onGesichert(r.id);
      }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const ve = f.verbrauchseinheit.trim() || f.einheit.trim();
  return (
    <Dialog open headerText={zaehler ? `Zähler ${zaehler.nummer} ändern` : 'Zähler anlegen'} onClose={onClose} style={{ width: 'min(48rem, 96vw)' }}
            footer={<FussLeiste endContent={<>
              <Button design="Emphasized" icon="save" loading={busy} onClick={sichern}>Sichern</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.75rem' }}>{error}</MessageStrip>}
      <FormGrid>
        <TextField label="Bezeichnung" required value={f.bezeichnung} onChange={set('bezeichnung')} placeholder="z. B. Strom Clubhaus" />
        <FieldBox label="Medium" required>
          <Select style={{ width: '100%' }} onChange={(e) => {
            const m = (e.detail.selectedOption as HTMLElement).dataset.k as Medium;
            // Einheit nach Medium vorbelegen, solange sie noch der Vorgabe des bisherigen Mediums entspricht
            setF((x) => ({ ...x, medium: m, einheit: !x.einheit.trim() || x.einheit === einheitVon(x.medium) ? einheitVon(m) : x.einheit }));
          }}>
            {MEDIEN.map((m) => <Option key={m.key} data-k={m.key} selected={f.medium === m.key}>{m.text}</Option>)}
          </Select>
        </FieldBox>
        <TextField label="Standort" value={f.standort} onChange={set('standort')} placeholder="z. B. Clubhaus Keller" />
        <TextField label="Zählernummer (Gerät)" value={f.zaehlernummer} onChange={set('zaehlernummer')} placeholder="Nummer auf dem Typenschild" />
        <FieldBox label="Einheit (Ablesung)">
          <Input style={{ width: '100%' }} value={f.einheit} onInput={(e) => set('einheit')(e.target.value)} />
          {hilfe('Einheit des Zählwerks, wird nach dem Medium vorbelegt.')}
        </FieldBox>
        <FieldBox label="Faktor">
          <Input style={{ width: '100%' }} value={f.faktor} onInput={(e) => set('faktor')(e.target.value)} />
          {hilfe('Umrechnung Ablesewert → Verbrauch. Meist 1; Wandlerzähler z. B. 40; Gas m³ → kWh: Brennwert × Zustandszahl (Gasrechnung, z. B. 10,5).')}
        </FieldBox>
        <FieldBox label="Verbrauchseinheit">
          <Input style={{ width: '100%' }} value={f.verbrauchseinheit} placeholder={f.einheit || 'wie Einheit'} onInput={(e) => set('verbrauchseinheit')(e.target.value)} />
          {hilfe('Einheit nach dem Faktor, z. B. kWh bei einem Gaszähler in m³. Leer = wie Einheit.')}
        </FieldBox>
        <FieldBox label="Vorkommastellen des Zählwerks">
          <Input style={{ width: '100%' }} value={f.stellen} placeholder="z. B. 6" onInput={(e) => set('stellen')(e.target.value)} />
          {hilfe('Für den Überlauf: Bei 6 Stellen folgt auf 999999 wieder 000000 – der Verbrauch wird dann richtig weitergezählt. Leer = kein Überlauf.')}
        </FieldBox>
        <FieldBox label="Ableseintervall (Tage)">
          <Input style={{ width: '100%' }} value={f.intervall_tage} placeholder="z. B. 30" onInput={(e) => set('intervall_tage')(e.target.value)} />
          {hilfe('Nach so vielen Tagen seit der letzten Ablesung gilt der Zähler als fällig (Erinnerung im Arbeitsvorrat). Leer = keine Erinnerung.')}
        </FieldBox>
        <FieldBox label={`Arbeitspreis (€ je ${ve || 'Einheit'}, brutto)`}>
          <Input style={{ width: '100%' }} value={f.arbeitspreis} placeholder="z. B. 0,32" onInput={(e) => set('arbeitspreis')(e.target.value)} />
        </FieldBox>
        <FieldBox label="Grundpreis (€ je Monat, brutto)">
          <Input style={{ width: '100%' }} value={f.grundpreis_monat} placeholder="z. B. 12,50" onInput={(e) => set('grundpreis_monat')(e.target.value)} />
        </FieldBox>
        <FieldBox label={`Jahresziel (${ve || 'Verbrauch'} je Kalenderjahr)`}>
          <Input style={{ width: '100%' }} value={f.jahresziel} onInput={(e) => set('jahresziel')(e.target.value)} />
          {hilfe('Liegt die Hochrechnung des laufenden Jahres darüber, erscheint ein Hinweis im Arbeitsvorrat. Leer = kein Ziel.')}
        </FieldBox>
        <CheckField label="Aktiv (wird abgelesen)" checked={f.aktiv} onChange={set('aktiv')} />
        <TextField label="Notiz" wide multiline value={f.notiz} onChange={set('notiz')} />
      </FormGrid>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Import: CSV → Prüfen → Übernehmen → Protokoll
async function dateiText(f: File): Promise<string> {
  const buf = await f.arrayBuffer();
  // Excel speichert CSV oft in Windows-1252: erst UTF-8 streng versuchen, sonst Windows-1252
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
}

function ImportStaende({ onClose, onUebernommen }: { onClose: () => void; onUebernommen: () => void }) {
  const [csv, setCsv] = useState('');
  const [name, setName] = useState('');
  const [schritt, setSchritt] = useState<ImportSchritt>(1);
  const [vorschau, setVorschau] = useState<ImportErgebnis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const datei = useRef<HTMLInputElement>(null);

  async function senden(uebernehmen: boolean) {
    setBusy(true); setError(null);
    if (uebernehmen) setSchritt(3);
    try {
      const r = await api.post<ImportErgebnis>(`${Z}/import`, { csv, uebernehmen });
      setVorschau(r);
      setSchritt(uebernehmen ? 4 : 2);
      if (uebernehmen) { toast(`${r.uebernommen} Zählerstände übernommen`); onUebernommen(); }
    } catch (e) { setError((e as Error).message); setSchritt(uebernehmen ? 2 : 1); } finally { setBusy(false); }
  }

  const ok = vorschau?.zeilen.filter((z) => !z.fehler).length ?? 0;
  const fehler = vorschau?.zeilen.filter((z) => z.fehler).length ?? 0;
  return (
    <ImportDialog open was="Zählerstände (CSV)" schritt={schritt} breit onClose={onClose}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {schritt === 1 && (
        <div className="portal-bk__form">
          <Text>CSV-Datei mit den Spalten <b>Zähler</b> (Nummer wie Z0001, Gerätenummer oder Bezeichnung), <b>Datum</b> (TT.MM.JJJJ), <b>Stand</b> (Komma als Dezimalzeichen) und optional <b>Art</b> und <b>Notiz</b>, getrennt durch Semikolon oder Komma – am einfachsten den CSV-Export als Vorlage nehmen.</Text>
          <input ref={datei} type="file" accept=".csv,text/csv,text/plain" style={{ display: 'none' }}
                 onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setName(f.name); setCsv(await dateiText(f)); } e.target.value = ''; }} />
          <div className="portal-row">
            <Button icon="open-folder" onClick={() => datei.current?.click()}>Datei wählen</Button>
            {name && <Text>{name}</Text>}
          </div>
          <Text className="portal-muted portal-small">… oder den Inhalt hier einfügen:</Text>
          <TextArea rows={8} value={csv} placeholder={'Zähler;Datum;Stand;Art;Notiz\nZ0001;01.11.2026;12345,6;ABLESUNG;'} onInput={(e) => { setCsv(e.target.value); setName(''); }} />
          <div className="portal-row">
            <Button design="Emphasized" icon="inspection" disabled={!csv.trim()} loading={busy} onClick={() => senden(false)}>Prüfen</Button>
          </div>
        </div>
      )}
      {schritt >= 2 && vorschau && (
        <div className="portal-bk__form">
          {schritt === 4 ? (
            <MessageStrip design="Positive" hideCloseButton>{vorschau.uebernommen} Zählerstände übernommen{fehler ? `, ${fehler} Zeilen wegen Fehlern ausgelassen` : ''}.</MessageStrip>
          ) : (
            <MessageStrip design={fehler ? 'Critical' : 'Information'} hideCloseButton>
              {ok} von {vorschau.zeilen.length} Zeilen können übernommen werden{fehler ? `; ${fehler} mit Fehler werden ausgelassen` : ''}. Warnungen gelten mit dem Übernehmen als bestätigt.
            </MessageStrip>
          )}
          <div className="portal-tabrahmen" style={{ maxHeight: '50vh' }}>
            <table className="zs-tabelle">
              <thead><tr><th className="zahl">Zeile</th><th>Zähler</th><th>Datum</th><th className="zahl">Stand</th><th>Art</th><th>Prüfung</th></tr></thead>
              <tbody>
                {vorschau.zeilen.map((z) => (
                  <tr key={z.zeile}>
                    <td className="zahl">{z.zeile}</td><td>{z.zaehler}</td><td>{dat(z.datum)}</td><td className="zahl">{standText(z.stand)}</td><td>{ART_KURZ[z.art] ?? z.art}</td>
                    <td className="umbruch">
                      {z.fehler ? <ObjectStatus state="Negative" showDefaultIcon>{z.fehler}</ObjectStatus>
                        : z.warnung ? <ObjectStatus state="Critical" showDefaultIcon>{z.warnung}</ObjectStatus>
                          : <ObjectStatus state="Positive" showDefaultIcon>in Ordnung</ObjectStatus>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {schritt < 4 && (
            <div className="portal-row">
              <Button design="Emphasized" icon="accept" disabled={!ok} loading={busy} onClick={() => senden(true)}>{ok} Zählerstände übernehmen</Button>
              <Button disabled={busy} onClick={() => { setSchritt(1); setVorschau(null); }}>Zurück</Button>
            </div>
          )}
        </div>
      )}
    </ImportDialog>
  );
}
