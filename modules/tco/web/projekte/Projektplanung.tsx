import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BusyIndicator, Button, CheckBox, DatePicker, Dialog, Input, MessageStrip, ObjectStatus, Option, Select, Tab, TabContainer, Text,
} from '@ui5/webcomponents-react';
import { FussLeiste } from '@core/components/DialogFuss';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { AuswahlBox } from '@core/components/AuswahlBox';
import { PdfDialog } from '@core/components/PdfDialog';
import { Empty, Section } from '@core/components/Section';
import { toast } from '@core/toast';
import { TCO, dat } from '../util';
import { monatKurz, PROJEKT_STATE, ProjektDialog, type Projekt, type ProjektListe } from '../haushalt/Projekte';
import { euro, zahlText } from '../haushalt/typen';
import { Gantt, type GanttVorgang } from './Gantt';
import '../haushalt/haushalt.css';
import './projekte.css';

/**
 * App „Projekte“: die Projekte des Haushaltsplans mit allem, was zur Umsetzung gehört. Die Kostenplanung (Positionen,
 * Finanzierung, Genehmigung) ist derselbe Dialog wie im Haushaltsplan. Dazu kommen die Terminplanung mit abhängigen
 * Vorgängen (Gantt-Diagramm, kritischer Weg), der Arbeitseinsatz der Mitglieder mit Stunden und externem Verrechnungssatz,
 * das Material mit Menge und Preis – und der Projektantrag als PDF mit Ablage in Paperless.
 *
 * Termine und Ressourcen sichern sich mit jeder Änderung selbst; der Server rechnet Termine, Puffer und Summen neu.
 */
const PJ = `${TCO}/projekte`;
/** auf Projekte in diesem Status können Mitglieder Stunden melden */
const MELDBAR = ['GENEHMIGT', 'UMSETZUNG'];

interface Summen { stunden: number; eigenleistung: number; personen: number; material: number; material_beschafft: number }
interface Termin { beginn: string; ende: string; tage: number; fertig: number }
interface Vorgang extends GanttVorgang { beginn_fix: string | null; verantwortlich: string | null; notiz: string | null }
interface Arbeit { id: number; vorgang_id: number | null; adrnr: string | null; name: string; taetigkeit: string | null; personen: number; stunden: number; satz: number | null; satz_gilt: number; wert: number }
interface Material { id: number; vorgang_id: number | null; bezeichnung: string; menge: number; einheit: string | null; preis: number; lieferant: string | null; beschafft: boolean; summe: number }
type ZeitStatus = 'GEMELDET' | 'BESTAETIGT' | 'ABGELEHNT';
export interface Zeit { id: number; projekt_id: number; projekt: string; vorgang_id: number | null; vorgang: string | null; adrnr: string | null; name: string; datum: string; stunden: number; taetigkeit: string | null; status: ZeitStatus; status_text: string; grund: string | null; erfasst_von: string | null; entschieden_von: string | null }
interface Ist { stunden: number; wert: number; gemeldet: number; personen: { name: string; adrnr: string | null; geplant: number; gemeldet: number; bestaetigt: number; offen: number }[] }
export const ZEIT_STATE: Record<ZeitStatus, 'Critical' | 'Positive' | 'Negative'> = { GEMELDET: 'Critical', BESTAETIGT: 'Positive', ABGELEHNT: 'Negative' };
interface Planung { stundensatz: number; offen_fuer_alle: boolean; zeiten: Zeit[]; ist: Ist; vorgaenge: Vorgang[]; arbeit: Arbeit[]; material: Material[]; termin: Termin; summen: Summen; paperless: { id: number; am: string } | null }
interface Sicht { projekt: Projekt; planung: Planung }
type Zeile = Projekt & { termin: Termin; summen: Summen; vorgaenge: number; ist: { stunden: number; gemeldet: number; wert: number } };
interface Liste extends Omit<ProjektListe, 'projekte'> {
  projekte: Zeile[]; pflege: boolean; konten: { konto: string; name: string; art: 'E' | 'A' }[]; mitglieder: { adrnr: string; name: string }[]; paperless: boolean; jahr: number;
}

/** Entwurf der Planung in der Oberfläche: Zahlen als Text (deutsche Schreibweise), Vorgänger als „1; 2+3“ */
interface VZ { key: string; bezeichnung: string; beginn: string; dauer: string; fertig: string; verantwortlich: string; vor: string }
interface AZ { vorgang: string; adrnr: string; name: string; taetigkeit: string; personen: string; stunden: string; satz: string }
interface MZ { vorgang: string; bezeichnung: string; menge: string; einheit: string; preis: string; lieferant: string; beschafft: boolean }
interface Entwurf { stundensatz: string; offen: boolean; v: VZ[]; a: AZ[]; m: MZ[] }

const std = (v: number) => v.toLocaleString('de-DE', { maximumFractionDigits: 1 });
const vorText = (v: Vorgang) => v.vorgaenger.map((x) => `${x.nr}${x.abstand ? `${x.abstand > 0 ? '+' : ''}${x.abstand}` : ''}`).join('; ');
function entwurfAus(p: Planung): Entwurf {
  const key = (id: number | null) => (id === null ? '' : String(id));
  return {
    stundensatz: zahlText(p.stundensatz), offen: p.offen_fuer_alle,
    v: p.vorgaenge.map((x) => ({ key: String(x.id), bezeichnung: x.bezeichnung, beginn: x.beginn_fix ?? '', dauer: String(x.dauer), fertig: String(x.fertig), verantwortlich: x.verantwortlich ?? '', vor: vorText(x) })),
    a: p.arbeit.map((x) => ({ vorgang: key(x.vorgang_id), adrnr: x.adrnr ?? '', name: x.name, taetigkeit: x.taetigkeit ?? '', personen: String(x.personen), stunden: zahlText(x.stunden), satz: x.satz === null ? '' : zahlText(x.satz) })),
    m: p.material.map((x) => ({ vorgang: key(x.vorgang_id), bezeichnung: x.bezeichnung, menge: zahlText(x.menge), einheit: x.einheit ?? '', preis: zahlText(x.preis), lieferant: x.lieferant ?? '', beschafft: x.beschafft })),
  };
}
/** „1; 2+3; 4-1“ → Vorgänger nach Zeilennummer; wirft bei unlesbarer Angabe */
function vorLesen(text: string, zeilen: VZ[], selbst: number): { key: string; abstand: number }[] {
  return text.split(/[;,\s]+/).filter(Boolean).map((t) => {
    const m = /^(\d+)([+-]\d+)?$/.exec(t);
    const z = m ? zeilen[Number(m[1]) - 1] : undefined;
    if (!m || !z) throw new Error(`Vorgang ${selbst + 1}: Vorgänger „${t}“ nicht erkannt – erlaubt sind Zeilennummern, z. B. „1; 2+3“ (3 Tage nach Vorgang 2).`);
    return { key: z.key, abstand: Number(m[2] ?? 0) };
  });
}

export function Projektplanung() {
  const [l, setL] = useState<Liste | null>(null);
  const [s, setS] = useState<Sicht | null>(null);
  const [e, setE] = useState<Entwurf | null>(null);
  const [tab, setTab] = useState('uebersicht');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Projekt | 'neu' | null>(null);
  const [pdf, setPdf] = useState(false);
  const [zeit, setZeit] = useState<{ adrnr: string; name: string; datum: string; vorgang: string; stunden: string; taetigkeit: string } | null>(null);
  const [weisen, setWeisen] = useState<Zeit | null>(null);

  const laden = useCallback(() => api.get<Liste>(PJ).then(setL).catch((x) => setError((x as Error).message)), []);
  useEffect(() => { laden(); }, [laden]);
  const zeigen = (x: Sicht) => { setS(x); setE(entwurfAus(x.planung)); };
  const oeffnen = (id: number) => { setError(null); api.get<Sicht>(`${PJ}/${id}`).then((x) => { zeigen(x); setTab('uebersicht'); }).catch((x) => setError((x as Error).message)); };
  const zurueck = () => { setS(null); setE(null); setError(null); laden(); };

  const pflege = !!l?.pflege;
  const p = s?.projekt ?? null, pl = s?.planung ?? null;
  const aenderbar = pflege && !!p && p.status !== 'ABGESCHLOSSEN';

  /** Entwurf übernehmen und sofort sichern – der Server rechnet Termine und Summen neu */
  async function sichern(neu: Entwurf) {
    if (!p) return;
    setE(neu);
    setError(null);
    let body;
    try {
      body = {
        stundensatz: neu.stundensatz, offen_fuer_alle: neu.offen,
        vorgaenge: neu.v.map((x, i) => ({ key: x.key, bezeichnung: x.bezeichnung, beginn: x.beginn || null, dauer: x.dauer.trim() === '' ? 0 : Number(x.dauer), fertig: Number(x.fertig) || 0, verantwortlich: x.verantwortlich, vorgaenger: vorLesen(x.vor, neu.v, i) })),
        arbeit: neu.a.filter((x) => x.adrnr !== '?').map((x) => ({ vorgang: x.vorgang || null, adrnr: x.adrnr || null, name: x.name, taetigkeit: x.taetigkeit, personen: Number(x.personen) || 1, stunden: x.stunden, satz: x.satz })),
        material: neu.m.map((x) => ({ vorgang: x.vorgang || null, bezeichnung: x.bezeichnung, menge: x.menge, einheit: x.einheit, preis: x.preis, lieferant: x.lieferant, beschafft: x.beschafft })),
      };
    } catch (x) { setError((x as Error).message); return; }
    setBusy(true);
    try {
      // Zeilen „Mitglied“, in denen noch niemand gewählt ist, bleiben am Ende stehen
      const x = await api.put<Sicht>(`${PJ}/${p.id}/planung`, body);
      const neuE = entwurfAus(x.planung);
      setS(x);
      setE({ ...neuE, a: [...neuE.a, ...neu.a.filter((z) => z.adrnr === '?')] });
    } catch (x) { setError((x as Error).message); } finally { setBusy(false); }
  }
  const setV = (i: number, n: Partial<VZ>) => e && sichern({ ...e, v: e.v.map((x, k) => (k === i ? { ...x, ...n } : x)) });
  const setA = (i: number, n: Partial<AZ>) => e && sichern({ ...e, a: e.a.map((x, k) => (k === i ? { ...x, ...n } : x)) });
  const setM = (i: number, n: Partial<MZ>) => e && sichern({ ...e, m: e.m.map((x, k) => (k === i ? { ...x, ...n } : x)) });
  /** Vorgang entfernen: Verweise der Nachfolger (Zeilennummern) und der Ressourcen mitziehen */
  function vorgangWeg(i: number) {
    if (!e) return;
    const key = e.v[i].key;
    const neuNr = (t: string) => t.split(/[;,\s]+/).filter(Boolean).flatMap((x) => {
      const m = /^(\d+)([+-]\d+)?$/.exec(x);
      if (!m) return [x];
      const n = Number(m[1]);
      return n === i + 1 ? [] : [`${n > i + 1 ? n - 1 : n}${m[2] ?? ''}`];
    }).join('; ');
    sichern({ ...e, v: e.v.filter((_, k) => k !== i).map((x) => ({ ...x, vor: neuNr(x.vor) })), a: e.a.map((x) => (x.vorgang === key ? { ...x, vorgang: '' } : x)), m: e.m.map((x) => (x.vorgang === key ? { ...x, vorgang: '' } : x)) });
  }
  function verschieben(i: number, um: number) {
    if (!e) return;
    const j = i + um;
    if (j < 0 || j >= e.v.length) return;
    // Zeilennummern in den Vorgänger-Angaben tauschen, damit die Abhängigkeiten dieselben bleiben
    const tausch = (t: string) => t.split(/[;,\s]+/).filter(Boolean).map((x) => {
      const m = /^(\d+)([+-]\d+)?$/.exec(x);
      if (!m) return x;
      const n = Number(m[1]);
      return `${n === i + 1 ? j + 1 : n === j + 1 ? i + 1 : n}${m[2] ?? ''}`;
    }).join('; ');
    const v = e.v.map((x) => ({ ...x, vor: tausch(x.vor) }));
    [v[i], v[j]] = [v[j], v[i]];
    sichern({ ...e, v });
  }
  /** Aufruf, der die neue Sicht des Projekts liefert (Zeiten bestätigen, erfassen, Material übernehmen) */
  async function tun(fn: () => Promise<Sicht & { text?: string }>, danach?: () => void) {
    setBusy(true); setError(null);
    try { const x = await fn(); if (x.text) toast(x.text, 4000); zeigen(x); danach?.(); } catch (x) { setError((x as Error).message); } finally { setBusy(false); }
  }
  const neuerKey = () => `neu${Date.now()}${Math.round(Math.random() * 1000)}`;

  const vorgangWahl = (wert: string, onChange: (k: string) => void) => (
    <Select disabled={!aenderbar} onChange={(ev) => onChange((ev.detail.selectedOption as HTMLElement).dataset.k ?? '')}>
      <Option data-k="" selected={!wert}>– ohne –</Option>
      {e?.v.map((x, i) => <Option key={x.key} data-k={x.key} selected={wert === x.key}>{i + 1}. {x.bezeichnung}</Option>)}
    </Select>
  );
  const mitglieder = useMemo(() => (l?.mitglieder ?? []).map((m) => ({ key: m.adrnr, text: m.name })), [l]);

  // ---------------------------------------------------------------- Übersicht aller Projekte
  const uebersicht = l && (
    <Section title="Projekte" count={l.projekte.length} flush>
      {l.projekte.length === 0 ? <Empty>Noch keine Projekte. Mit „Neues Projekt“ beginnen: erst Zeitraum und Kosten, dann Termine, Arbeitseinsatz und Material.</Empty> : (
        <div className="hh-roll">
          <table className="hh-tab">
            <thead><tr><th>Projekt</th><th>Status</th><th>Zeitraum</th><th>Termine</th><th className="z">Kosten</th><th className="z">Finanzierung</th><th className="z">Eigenleistung</th><th className="z">Material</th></tr></thead>
            <tbody>
              {l.projekte.map((x) => (
                <tr key={x.id} className="pj-klick" onClick={() => oeffnen(x.id)}>
                  <td className="name"><b>{x.bezeichnung}</b><small>{[x.projektnr, x.verantwortlich].filter(Boolean).join(' · ')}</small></td>
                  <td><ObjectStatus state={PROJEKT_STATE[x.status]}>{x.status_text}</ObjectStatus></td>
                  <td>{monatKurz(x.beginn)} – {monatKurz(x.ende)}</td>
                  <td>{x.vorgaenge ? <>{dat(x.termin.beginn)} – {dat(x.termin.ende)}<small style={{ display: 'block' }} className="portal-muted">{x.vorgaenge} Vorgänge · {x.termin.fertig} % erledigt</small></> : <span className="portal-muted">noch nicht geplant</span>}</td>
                  <td className="z">{euro(x.budget.kosten)}</td>
                  <td className="z">{euro(x.budget.finanzierung)}{x.budget.luecke > 0 && <small style={{ display: 'block' }}><ObjectStatus state="Negative">Lücke {euro(x.budget.luecke)}</ObjectStatus></small>}</td>
                  <td className="z">{x.summen.stunden || x.ist.stunden ? <>{std(x.ist.stunden)} von {std(x.summen.stunden)} Std.<small style={{ display: 'block' }} className="portal-muted">{x.ist.gemeldet ? `${std(x.ist.gemeldet)} Std. zu bestätigen` : `Wert ${euro(x.summen.eigenleistung)}`}</small></> : '–'}</td>
                  <td className="z">{x.summen.material ? euro(x.summen.material) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );

  // ---------------------------------------------------------------- ein Projekt
  const kpi = (label: string, wert: string, zusatz?: string, state?: 'Negative' | 'Positive') => (
    <div className="pj-kpi"><span>{label}</span><b>{state ? <ObjectStatus state={state}>{wert}</ObjectStatus> : wert}</b>{zusatz && <small>{zusatz}</small>}</div>
  );
  const gantt = pl && (pl.vorgaenge.length
    ? <Gantt vorgaenge={pl.vorgaenge} beginn={pl.termin.beginn} ende={pl.termin.ende} />
    : <Empty>Noch keine Vorgänge. Im Reiter „Termine“ die Arbeitsschritte mit Dauer anlegen und über „nach“ voneinander abhängig machen.</Empty>);

  const detail = p && pl && e && (
    <TabContainer tabLayout="Inline" onTabSelect={(ev) => setTab((ev.detail.tab as HTMLElement).dataset.key!)}>
      <Tab data-key="uebersicht" text="Übersicht" icon="overview-chart" selected={tab === 'uebersicht'}>
        <Section title="Auf einen Blick">
          <div className="pj-kpis">
            {kpi('Status', p.status_text, p.status_von ? `${p.status_von}, ${dat(p.status_am)}` : undefined)}
            {kpi('Termine', pl.vorgaenge.length ? `${dat(pl.termin.beginn)} – ${dat(pl.termin.ende)}` : `${monatKurz(p.beginn)} – ${monatKurz(p.ende)}`, pl.vorgaenge.length ? `${pl.termin.tage} Tage · ${pl.termin.fertig} % erledigt` : 'Laufzeit laut Stammdaten')}
            {kpi('Kosten', euro(p.budget.kosten), p.projektnr ? `gebucht ${euro(p.ist.kosten)}` : undefined)}
            {kpi('Finanzierung', euro(p.budget.finanzierung), p.budget.luecke > 0 ? `Lücke ${euro(p.budget.luecke)}` : 'gedeckt', p.budget.luecke > 0 ? 'Negative' : undefined)}
            {kpi('Arbeitseinsatz geplant', `${std(pl.summen.stunden)} Std.`, `${pl.summen.personen} Person${pl.summen.personen === 1 ? '' : 'en'} · Wert ${euro(pl.summen.eigenleistung)}`)}
            {kpi('Geleistet (bestätigt)', `${std(pl.ist.stunden)} Std.`, `Wert ${euro(pl.ist.wert)}${pl.ist.gemeldet ? ` · ${std(pl.ist.gemeldet)} Std. warten auf Bestätigung` : ''}`)}
            {kpi('Material', euro(pl.summen.material), pl.summen.material ? `davon beschafft ${euro(pl.summen.material_beschafft)}` : undefined)}
          </div>
          {p.beschreibung && <Text style={{ display: 'block', marginTop: '0.75rem', whiteSpace: 'pre-line' }}>{p.beschreibung}</Text>}
        </Section>
        <Section title="Terminplan" count={pl.vorgaenge.length}>{gantt}</Section>
      </Tab>

      <Tab data-key="kosten" text="Kosten und Finanzierung" icon="money-bills" additionalText={String(p.positionen.length)} selected={tab === 'kosten'}>
        <Section title="Kosten, Finanzierung und Folgekosten" count={p.positionen.length} flush
                 actions={<Button design="Transparent" icon="edit" onClick={() => setDialog(p)}>{pflege ? 'Bearbeiten, beantragen' : 'Ansehen'}</Button>}>
          {p.positionen.length === 0 ? <Empty>Noch keine Positionen – über „Bearbeiten“ Kosten und Finanzierung planen (wie im Haushaltsplan).</Empty> : (
            <div className="hh-roll">
              <table className="hh-tab">
                <thead><tr><th>Art</th><th>Bezeichnung</th><th>Konto</th><th>Zeitraum</th><th className="z">Betrag</th></tr></thead>
                <tbody>
                  {p.positionen.map((x, i) => (
                    <tr key={i}><td>{x.art_text}</td><td className="name">{x.bezeichnung ?? ''}</td><td>{x.konto ?? ''}</td>
                      <td>{x.verteilung === 'JAEHRLICH' ? 'je Jahr' : x.von ? `${monatKurz(x.von)}${x.bis && x.bis !== x.von ? ` – ${monatKurz(x.bis)}` : ''}` : 'Laufzeit'}</td><td className="z">{euro(x.betrag)}</td></tr>
                  ))}
                  <tr className="hh-summe"><td colSpan={4}>Kosten</td><td className="z">{euro(p.budget.kosten)}</td></tr>
                  <tr className="hh-summe"><td colSpan={4}>Finanzierung</td><td className="z">{euro(p.budget.finanzierung)}</td></tr>
                  {p.budget.luecke > 0 && <tr className="hh-summe"><td colSpan={4}>Noch nicht finanziert</td><td className="z"><ObjectStatus state="Negative">{euro(p.budget.luecke)}</ObjectStatus></td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        <Section title="Vergleich mit der Ressourcenplanung">
          <div className="pj-kpis">
            {kpi('Kosten laut Kostenplanung', euro(p.budget.kosten))}
            {kpi('Material laut Ressourcenplanung', euro(pl.summen.material), pl.summen.material > p.budget.kosten ? 'liegt über den geplanten Kosten' : undefined, pl.summen.material > p.budget.kosten ? 'Negative' : undefined)}
            {kpi('Eigenleistung (kein Geldabfluss)', euro(pl.summen.eigenleistung), `${std(pl.summen.stunden)} Stunden zum externen Verrechnungssatz`)}
            {kpi('Wert des Projekts mit Eigenleistung', euro(p.budget.kosten + pl.summen.eigenleistung))}
          </div>
          <Text className="portal-muted" style={{ display: 'block', marginTop: '0.75rem' }}>
            Die Kostenplanung bleibt maßgeblich für Genehmigung und Haushaltsplan. Material und Eigenleistung stehen daneben – sie ändern die Kostenpositionen nicht von selbst.
          </Text>
        </Section>
        {p.verlauf.length > 0 && (
          <Section title="Verlauf der Genehmigung"><ul className="hh-liste">{p.verlauf.map((v, i) => <li key={i}>{dat(v.am)} · {v.von}: {v.status_text}{v.grund ? ` – „${v.grund}“` : ''}</li>)}</ul></Section>
        )}
      </Tab>

      <Tab data-key="termine" text="Termine" icon="gantt-bars" additionalText={String(pl.vorgaenge.length)} selected={tab === 'termine'}>
        <Section title="Vorgänge" count={e.v.length} flush
                 status={<Text className="portal-muted portal-small">„nach“: Zeilennummern der Vorgänger, z. B. „1; 2+3“ = nach Vorgang 1 und frühestens 3 Tage nach Vorgang 2 · Dauer 0 = Meilenstein</Text>}
                 actions={aenderbar && <Button design="Transparent" icon="add" disabled={busy}
                   onClick={() => sichern({ ...e, v: [...e.v, { key: neuerKey(), bezeichnung: 'Neuer Vorgang', beginn: '', dauer: '7', fertig: '0', verantwortlich: '', vor: e.v.length ? String(e.v.length) : '' }] })}>Vorgang</Button>}>
          {e.v.length === 0 ? <Empty>Noch keine Vorgänge. Der erste beginnt mit dem Projekt ({dat(pl.termin.beginn)}), jeder weitere nach seinem Vorgänger.</Empty> : (
            <div className="hh-roll">
              <table className="hh-tab pj-tab">
                <thead><tr><th>Nr.</th><th>Vorgang</th><th>Dauer (Tage)</th><th>nach</th><th>frühestens am</th><th>Beginn</th><th>Ende</th><th className="z">Puffer</th><th>erledigt %</th><th>Verantwortlich</th><th /></tr></thead>
                <tbody>
                  {e.v.map((x, i) => {
                    const g = pl.vorgaenge.find((y) => String(y.id) === x.key);
                    return (
                      <tr key={i}>
                        <td>{i + 1}</td>
                        <td className="breit"><Input key={`b${x.key}`} readonly={!aenderbar} value={x.bezeichnung} maxlength={160} accessibleName={`Vorgang ${i + 1}`} onChange={(ev) => { const t = ev.target.value.trim(); if (t && t !== x.bezeichnung) setV(i, { bezeichnung: t }); }} /></td>
                        <td className="schmal"><Input key={`d${x.key}:${x.dauer}`} readonly={!aenderbar} value={x.dauer} accessibleName={`Dauer ${x.bezeichnung}`} onChange={(ev) => { if (ev.target.value !== x.dauer) setV(i, { dauer: ev.target.value }); }} /></td>
                        <td className="schmal"><Input key={`v${x.key}:${x.vor}`} readonly={!aenderbar} value={x.vor} placeholder="–" accessibleName={`Vorgänger ${x.bezeichnung}`} onChange={(ev) => { if (ev.target.value !== x.vor) setV(i, { vor: ev.target.value }); }} /></td>
                        <td className="datum"><DatePicker key={`f${x.key}:${x.beginn}`} readonly={!aenderbar} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={x.beginn} accessibleName={`Frühester Beginn ${x.bezeichnung}`} onChange={(ev) => { if (ev.detail.value !== x.beginn) setV(i, { beginn: ev.detail.value }); }} /></td>
                        <td>{g ? dat(g.beginn) : ''}</td>
                        <td>{g ? (g.dauer ? dat(g.ende) : <span className="portal-muted">Meilenstein</span>) : ''}</td>
                        <td className="z">{g ? (g.kritisch ? <ObjectStatus state="Critical">kritisch</ObjectStatus> : `${g.puffer} T.`) : ''}</td>
                        <td className="schmal"><Input key={`e${x.key}:${x.fertig}`} readonly={!aenderbar} value={x.fertig} accessibleName={`Erledigt ${x.bezeichnung}`} onChange={(ev) => { if (ev.target.value !== x.fertig) setV(i, { fertig: ev.target.value }); }} /></td>
                        <td className="mittel"><Input key={`w${x.key}`} readonly={!aenderbar} value={x.verantwortlich} maxlength={100} accessibleName={`Verantwortlich ${x.bezeichnung}`} onChange={(ev) => { if (ev.target.value !== x.verantwortlich) setV(i, { verantwortlich: ev.target.value }); }} /></td>
                        <td>{aenderbar && <>
                          <Button design="Transparent" icon="navigation-up-arrow" tooltip="Nach oben" accessibleName={`${x.bezeichnung} nach oben`} disabled={busy || i === 0} onClick={() => verschieben(i, -1)} />
                          <Button design="Transparent" icon="navigation-down-arrow" tooltip="Nach unten" accessibleName={`${x.bezeichnung} nach unten`} disabled={busy || i === e.v.length - 1} onClick={() => verschieben(i, 1)} />
                          <Button design="Transparent" icon="delete" tooltip="Vorgang entfernen" accessibleName={`${x.bezeichnung} entfernen`} disabled={busy} onClick={() => vorgangWeg(i)} />
                        </>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        <Section title="Gantt-Diagramm" status={pl.vorgaenge.length > 0 && <Text className="portal-muted portal-small">{dat(pl.termin.beginn)} – {dat(pl.termin.ende)} · {pl.termin.tage} Tage · {pl.termin.fertig} % erledigt</Text>}>{gantt}</Section>
      </Tab>

      <Tab data-key="ressourcen" text="Ressourcen" icon="group" additionalText={String(pl.arbeit.length + pl.material.length)} selected={tab === 'ressourcen'}>
        <Section title="Arbeitseinsatz der Mitglieder" count={e.a.length} flush
                 status={<label className="portal-row" style={{ flexWrap: 'nowrap' }}><Text className="portal-muted portal-small">Externer Verrechnungssatz (€ je Stunde), Vorgabe</Text>
                   <Input key={`s${e.stundensatz}`} style={{ width: '6rem' }} readonly={!aenderbar} value={e.stundensatz} accessibleName="Externer Verrechnungssatz" onChange={(ev) => { if (ev.target.value !== e.stundensatz) sichern({ ...e, stundensatz: ev.target.value }); }} /></label>}
                 actions={aenderbar && <>
                   <Button design="Transparent" icon="add-employee" disabled={busy} onClick={() => setE({ ...e, a: [...e.a, { vorgang: '', adrnr: '?', name: '', taetigkeit: '', personen: '1', stunden: '4', satz: '' }] })}>Mitglied</Button>
                   <Button design="Transparent" icon="add" disabled={busy} onClick={() => sichern({ ...e, a: [...e.a, { vorgang: '', adrnr: '', name: 'Helfer', taetigkeit: '', personen: '2', stunden: '4', satz: '' }] })}>Helfer ohne Namen</Button>
                 </>}>
          {e.a.length === 0 ? <Empty>Noch kein Arbeitseinsatz geplant. „Mitglied“ wählt eine Person aus dem Mitgliederstamm, „Helfer ohne Namen“ plant eine Anzahl Personen, die noch gesucht werden.</Empty> : (
            <div className="hh-roll">
              <table className="hh-tab pj-tab">
                <thead><tr><th>Wer</th><th>Tätigkeit</th><th>Vorgang</th><th>Personen</th><th>Std. je Person</th><th>Satz €/Std.</th><th className="z">Stunden</th><th className="z">Wert (extern)</th><th /></tr></thead>
                <tbody>
                  {e.a.map((x, i) => {
                    const g = pl.arbeit[i];
                    const offen = x.adrnr === '?';
                    return (
                      <tr key={i}>
                        <td className="mittel">{x.adrnr
                          ? <AuswahlBox eintraege={mitglieder} wert={offen ? '' : x.adrnr} max={60} leerErlaubt={false} readonly={!aenderbar} placeholder="Mitglied suchen" style={{ minWidth: '13rem' }}
                                        onWaehle={(k) => { const m = l?.mitglieder.find((y) => y.adrnr === k); if (m && k !== x.adrnr) setA(i, { adrnr: m.adrnr, name: m.name }); }} />
                          : <Input key={`n${i}:${x.name}`} readonly={!aenderbar} value={x.name} maxlength={120} accessibleName="Wer" onChange={(ev) => { const t = ev.target.value.trim(); if (t && t !== x.name) setA(i, { name: t }); }} />}</td>
                        <td className="mittel"><Input key={`t${i}:${x.taetigkeit}`} readonly={!aenderbar || offen} value={x.taetigkeit} maxlength={200} accessibleName="Tätigkeit" onChange={(ev) => { if (ev.target.value !== x.taetigkeit) setA(i, { taetigkeit: ev.target.value }); }} /></td>
                        <td className="mittel">{offen ? '' : vorgangWahl(x.vorgang, (k) => setA(i, { vorgang: k }))}</td>
                        <td className="schmal">{x.adrnr ? '1' : <Input key={`p${i}:${x.personen}`} readonly={!aenderbar} value={x.personen} accessibleName="Personen" onChange={(ev) => { if (ev.target.value !== x.personen) setA(i, { personen: ev.target.value }); }} />}</td>
                        <td className="schmal"><Input key={`h${i}:${x.stunden}`} readonly={!aenderbar || offen} value={x.stunden} accessibleName="Stunden je Person" onChange={(ev) => { if (ev.target.value !== x.stunden) setA(i, { stunden: ev.target.value }); }} /></td>
                        <td className="schmal"><Input key={`z${i}:${x.satz}`} readonly={!aenderbar || offen} value={x.satz} placeholder={e.stundensatz || '0'} accessibleName="Satz" onChange={(ev) => { if (ev.target.value !== x.satz) setA(i, { satz: ev.target.value }); }} /></td>
                        <td className="z">{g && !offen ? std(g.personen * g.stunden) : ''}</td>
                        <td className="z">{g && !offen ? euro(g.wert) : ''}</td>
                        <td>{aenderbar && <Button design="Transparent" icon="delete" tooltip="Zeile entfernen" accessibleName="Arbeitseinsatz entfernen" disabled={busy}
                                                   onClick={() => (offen ? setE({ ...e, a: e.a.filter((_, k) => k !== i) }) : sichern({ ...e, a: e.a.filter((_, k) => k !== i) }))} />}</td>
                      </tr>
                    );
                  })}
                  <tr className="hh-summe"><td colSpan={6}>Summe · {pl.summen.personen} Person{pl.summen.personen === 1 ? '' : 'en'}</td><td className="z">{std(pl.summen.stunden)}</td><td className="z">{euro(pl.summen.eigenleistung)}</td><td /></tr>
                </tbody>
              </table>
            </div>
          )}
        </Section>
        <Section title="Material und Einkauf" count={e.m.length} flush
                 actions={aenderbar && <>
                   {pl.summen.material > 0 && <Button design="Transparent" icon="money-bills" disabled={busy} tooltip="Legt die Kostenposition „Material laut Ressourcenplanung“ an bzw. setzt sie auf die aktuelle Summe"
                                                        onClick={() => tun(() => api.post<Sicht & { text: string }>(`${PJ}/${p.id}/material-uebernehmen`))}>Als Kostenposition übernehmen</Button>}
                   <Button design="Transparent" icon="add" disabled={busy}
                   onClick={() => sichern({ ...e, m: [...e.m, { vorgang: '', bezeichnung: 'Neues Material', menge: '1', einheit: 'Stück', preis: '0', lieferant: '', beschafft: false }] })}>Material</Button>
                 </>}>
          {e.m.length === 0 ? <Empty>Noch kein Material geplant: was eingekauft werden muss, in welcher Menge und zu welchem Preis.</Empty> : (
            <div className="hh-roll">
              <table className="hh-tab pj-tab">
                <thead><tr><th>Material</th><th>Lieferant</th><th>Vorgang</th><th>Menge</th><th>Einheit</th><th>Einzelpreis €</th><th className="z">Summe</th><th>beschafft</th><th /></tr></thead>
                <tbody>
                  {e.m.map((x, i) => (
                    <tr key={i}>
                      <td className="breit"><Input key={`b${i}:${x.bezeichnung}`} readonly={!aenderbar} value={x.bezeichnung} maxlength={160} accessibleName="Material" onChange={(ev) => { const t = ev.target.value.trim(); if (t && t !== x.bezeichnung) setM(i, { bezeichnung: t }); }} /></td>
                      <td className="mittel"><Input key={`l${i}:${x.lieferant}`} readonly={!aenderbar} value={x.lieferant} maxlength={120} accessibleName="Lieferant" onChange={(ev) => { if (ev.target.value !== x.lieferant) setM(i, { lieferant: ev.target.value }); }} /></td>
                      <td className="mittel">{vorgangWahl(x.vorgang, (k) => setM(i, { vorgang: k }))}</td>
                      <td className="schmal"><Input key={`m${i}:${x.menge}`} readonly={!aenderbar} value={x.menge} accessibleName="Menge" onChange={(ev) => { if (ev.target.value !== x.menge) setM(i, { menge: ev.target.value }); }} /></td>
                      <td className="schmal"><Input key={`e${i}:${x.einheit}`} readonly={!aenderbar} value={x.einheit} maxlength={20} accessibleName="Einheit" onChange={(ev) => { if (ev.target.value !== x.einheit) setM(i, { einheit: ev.target.value }); }} /></td>
                      <td className="schmal"><Input key={`p${i}:${x.preis}`} readonly={!aenderbar} value={x.preis} accessibleName="Einzelpreis" onChange={(ev) => { if (ev.target.value !== x.preis) setM(i, { preis: ev.target.value }); }} /></td>
                      <td className="z">{pl.material[i] ? euro(pl.material[i].summe) : ''}</td>
                      <td><CheckBox accessibleName={`${x.bezeichnung} beschafft`} disabled={!aenderbar} checked={x.beschafft} onChange={(ev) => setM(i, { beschafft: ev.target.checked })} /></td>
                      <td>{aenderbar && <Button design="Transparent" icon="delete" tooltip="Material entfernen" accessibleName={`${x.bezeichnung} entfernen`} disabled={busy} onClick={() => sichern({ ...e, m: e.m.filter((_, k) => k !== i) })} />}</td>
                    </tr>
                  ))}
                  <tr className="hh-summe"><td colSpan={6}>Summe Material{pl.summen.material_beschafft ? ` · davon beschafft ${euro(pl.summen.material_beschafft)}` : ''}</td><td className="z">{euro(pl.summen.material)}</td><td colSpan={2} /></tr>
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </Tab>

      <Tab data-key="zeiten" text="Zeiten" icon="time-entry-request" additionalText={pl.ist.gemeldet ? `${std(pl.ist.gemeldet)} offen` : String(pl.zeiten.length)} selected={tab === 'zeiten'}>
        <Section title="Soll-Ist der Stunden" flush
                 status={<Text className="portal-muted portal-small">es zählen bestätigte Stunden · Wert geleistet {euro(pl.ist.wert)} von {euro(pl.summen.eigenleistung)}</Text>}
                 actions={<CheckBox text="offen für alle Mitglieder" disabled={!aenderbar || busy} checked={e.offen} title="Auch nicht eingeplante Mitglieder dürfen Stunden auf dieses Projekt melden"
                                    onChange={(ev) => sichern({ ...e, offen: ev.target.checked })} />}>
          {pl.ist.personen.length === 0 ? <Empty>Noch kein Arbeitseinsatz geplant und keine Stunden gemeldet.</Empty> : (
            <div className="hh-roll">
              <table className="hh-tab">
                <thead><tr><th>Wer</th><th className="z">geplant</th><th className="z">gemeldet</th><th className="z">bestätigt</th><th className="z">offen</th><th>Stand</th></tr></thead>
                <tbody>
                  {pl.ist.personen.map((x) => (
                    <tr key={`${x.adrnr}:${x.name}`}><td>{x.name}</td><td className="z">{std(x.geplant)}</td><td className="z">{x.gemeldet ? std(x.gemeldet) : '–'}</td><td className="z">{std(x.bestaetigt)}</td><td className="z">{std(x.offen)}</td>
                      <td>{x.bestaetigt > x.geplant ? <ObjectStatus state="Critical">{x.geplant ? 'über Plan' : 'nicht eingeplant'}</ObjectStatus> : x.geplant > 0 && x.bestaetigt >= x.geplant ? <ObjectStatus state="Positive">erfüllt</ObjectStatus> : ''}</td></tr>
                  ))}
                  <tr className="hh-summe"><td>Summe</td><td className="z">{std(pl.summen.stunden)}</td><td className="z">{std(pl.ist.gemeldet)}</td><td className="z">{std(pl.ist.stunden)}</td><td className="z">{std(Math.max(0, pl.summen.stunden - pl.ist.stunden))}</td><td /></tr>
                </tbody>
              </table>
            </div>
          )}
        </Section>
        <Section title="Rückmeldungen" count={pl.zeiten.length} flush
                 status={<Text className="portal-muted portal-small">Mitglieder melden unter Mein Bereich → Meine Zeiten{MELDBAR.includes(p.status) ? '' : ' – möglich, sobald das Projekt genehmigt ist'}</Text>}
                 actions={pflege && p.status !== 'ABGESCHLOSSEN' && p.status !== 'ABGELEHNT' && <Button design="Transparent" icon="add" disabled={busy}
                   onClick={() => setZeit({ adrnr: '', name: 'Helfer', datum: new Date().toISOString().slice(0, 10), vorgang: '', stunden: '4', taetigkeit: '' })}>Für jemanden erfassen</Button>}>
          {pl.zeiten.length === 0 ? <Empty>Noch keine Stunden gemeldet.</Empty> : (
            <div className="hh-roll">
              <table className="hh-tab">
                <thead><tr><th>Datum</th><th>Wer</th><th>Vorgang</th><th className="z">Stunden</th><th>Tätigkeit</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {pl.zeiten.map((x) => (
                    <tr key={x.id}>
                      <td>{dat(x.datum)}</td><td>{x.name}</td><td>{x.vorgang ?? '–'}</td><td className="z">{std(x.stunden)}</td><td className="name">{x.taetigkeit ?? ''}{x.grund && <small>zurückgewiesen: {x.grund}</small>}</td>
                      <td><ObjectStatus state={ZEIT_STATE[x.status]}>{x.status_text}</ObjectStatus>{x.entschieden_von && <small style={{ display: 'block' }} className="portal-muted">{x.entschieden_von}</small>}</td>
                      <td>{pflege && (x.status === 'GEMELDET' ? <>
                        <Button design="Transparent" icon="accept" disabled={busy} onClick={() => tun(() => api.post<Sicht>(`${PJ}/zeiten/${x.id}/status`, { status: 'BESTAETIGT' }))}>Bestätigen</Button>
                        <Button design="Transparent" icon="decline" disabled={busy} onClick={() => setWeisen(x)}>Zurückweisen</Button>
                      </> : <>
                        <Button design="Transparent" icon="undo" tooltip="Entscheidung zurücknehmen" accessibleName="Entscheidung zurücknehmen" disabled={busy} onClick={() => tun(() => api.post<Sicht>(`${PJ}/zeiten/${x.id}/status`, { status: 'GEMELDET' }))} />
                        <Button design="Transparent" icon="delete" tooltip="Meldung löschen" accessibleName="Meldung löschen" disabled={busy} onClick={() => tun(() => api.post<Sicht>(`${PJ}/zeiten/${x.id}/loeschen`))} />
                      </>)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </Tab>
    </TabContainer>
  );

  return (
    <AppPage title={p ? p.bezeichnung : 'Projekte'}
             subtitle={p ? `${p.status_text} · ${monatKurz(p.beginn)} – ${monatKurz(p.ende)}${p.verantwortlich ? ` · ${p.verantwortlich}` : ''}${p.projektnr ? ` · ${p.projektnr}` : ''}` : 'Kosten, Termine, Arbeitseinsatz und Material der Vereinsprojekte – mit Projektantrag'}
             actions={p ? <>
               <Button icon="nav-back" onClick={zurueck}>Übersicht</Button>
               <ObjectStatus state={PROJEKT_STATE[p.status]} inverted>{p.status_text}</ObjectStatus>
               <Button icon="edit" onClick={() => setDialog(p)}>{pflege ? 'Stammdaten, Kosten, Antrag stellen' : 'Stammdaten und Kosten'}</Button>
               <Button icon="pdf-attachment" design="Emphasized" onClick={() => setPdf(true)}>Projektantrag (PDF)</Button>
             </> : pflege ? <Button design="Emphasized" icon="add" onClick={() => setDialog('neu')}>Neues Projekt</Button> : undefined}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      {p && pl?.paperless && <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.5rem' }}>Der Projektantrag liegt in Paperless (DOKID {String(pl.paperless.id).padStart(6, '0')}, zuletzt {dat(pl.paperless.am)}).</MessageStrip>}
      <BusyIndicator active={!l || busy} delay={400} style={{ display: 'block', width: '100%' }}>
        <div className="portal-busy-inhalt">{p ? detail : uebersicht}</div>
      </BusyIndicator>

      {dialog && l && (
        <ProjektDialog p={dialog === 'neu' ? null : dialog} l={l} init={{ konten: l.konten }} edit={pflege} jahr={l.jahr} basis={PJ}
                       onClose={(geaendert) => {
                         const war = dialog;
                         setDialog(null);
                         if (!geaendert) return;
                         // nach dem Sichern: Projekt neu lesen; ein gelöschtes Projekt führt zurück in die Übersicht
                         if (war === 'neu') laden();
                         else api.get<Sicht>(`${PJ}/${war.id}`).then(zeigen).catch(zurueck);
                       }} />
      )}
      <Dialog open={!!zeit} headerText="Stunden für jemanden erfassen" onClose={() => setZeit(null)}
              footer={<FussLeiste endContent={<>
                <Button design="Emphasized" disabled={busy || !zeit || (!zeit.adrnr && !zeit.name.trim())}
                        onClick={() => zeit && p && tun(() => api.post<Sicht>(`${PJ}/${p.id}/zeiten`, { adrnr: zeit.adrnr || null, name: zeit.name, datum: zeit.datum, vorgang_id: zeit.vorgang ? Number(zeit.vorgang) : null, stunden: zeit.stunden, taetigkeit: zeit.taetigkeit }), () => setZeit(null))}>Erfassen</Button>
                <Button onClick={() => setZeit(null)}>Abbrechen</Button>
              </>} />}>
        {zeit && (
          <div className="hh-dialog" style={{ width: 'min(34rem, 88vw)' }}>
            <Text className="portal-muted">Für Mitglieder ohne Portalzugang oder für Helfer ohne Namen. Die Stunden gelten sofort als bestätigt.</Text>
            <label className="hh-feld"><span>Mitglied (leer lassen für eine freie Angabe)</span>
              <AuswahlBox eintraege={mitglieder} wert={zeit.adrnr} max={60} placeholder="Mitglied suchen" style={{ width: '100%' }} onWaehle={(k) => setZeit({ ...zeit, adrnr: k ?? '' })} /></label>
            {!zeit.adrnr && <label className="hh-feld"><span>Wer (freie Angabe)</span><Input style={{ width: '100%' }} value={zeit.name} maxlength={120} onInput={(ev) => setZeit({ ...zeit, name: ev.target.value })} /></label>}
            <div className="hh-leiste" style={{ paddingBottom: 0 }}>
              <label className="hh-feld"><span>Datum</span><DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={zeit.datum} onChange={(ev) => setZeit({ ...zeit, datum: ev.detail.value })} /></label>
              <label className="hh-feld"><span>Stunden (gesamt)</span><Input style={{ width: '6rem' }} value={zeit.stunden} onInput={(ev) => setZeit({ ...zeit, stunden: ev.target.value })} /></label>
              <label className="hh-feld" style={{ flex: '1 1 12rem' }}><span>Vorgang</span>
                <Select onChange={(ev) => setZeit({ ...zeit, vorgang: (ev.detail.selectedOption as HTMLElement).dataset.k ?? '' })}>
                  <Option data-k="" selected={!zeit.vorgang}>– ohne –</Option>
                  {pl?.vorgaenge.map((x) => <Option key={x.id} data-k={x.id} selected={zeit.vorgang === String(x.id)}>{x.nr}. {x.bezeichnung}</Option>)}
                </Select></label>
            </div>
            <label className="hh-feld"><span>Tätigkeit</span><Input style={{ width: '100%' }} value={zeit.taetigkeit} maxlength={300} onInput={(ev) => setZeit({ ...zeit, taetigkeit: ev.target.value })} /></label>
          </div>
        )}
      </Dialog>
      <ConfirmDialog open={!!weisen} title="Stunden zurückweisen" confirmText="Zurückweisen" askReason danger
                     text={weisen ? `${std(weisen.stunden)} Stunden von ${weisen.name} am ${dat(weisen.datum)} zurückweisen? Die Begründung sieht das Mitglied unter „Meine Zeiten“.` : ''}
                     onCancel={() => setWeisen(null)} onConfirm={(grund) => { const w = weisen; setWeisen(null); if (w) tun(() => api.post<Sicht>(`${PJ}/zeiten/${w.id}/status`, { status: 'ABGELEHNT', grund })); }} />
      <PdfDialog url={pdf && p ? `${PJ}/${p.id}/pdf` : null} title={p ? `Projektantrag ${p.bezeichnung}` : ''} filename={p ? `Projektantrag ${p.bezeichnung}.pdf` : 'Projektantrag.pdf'}
                 onClose={() => setPdf(false)}
                 actions={pflege && l?.paperless && p ? (
                   <Button icon="save" onClick={async () => {
                     try {
                       const r = await api.post<{ text: string; warnungen: string[] }>(`${PJ}/${p.id}/paperless`);
                       toast(r.text, 5000);
                       setPdf(false);
                       if (r.warnungen.length) setError(r.warnungen.join('\n'));
                       zeigen(await api.get<Sicht>(`${PJ}/${p.id}`));
                     } catch (x) { setError((x as Error).message); setPdf(false); }
                   }}>In Paperless ablegen</Button>
                 ) : undefined} />
    </AppPage>
  );
}
