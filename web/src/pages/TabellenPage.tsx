import { useEffect, useMemo, useRef, useState } from 'react';
import { feld } from '../components/Varianten';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import {
  AnalyticalTable, Bar, Button, CheckBox, Dialog, Icon, Input, Label, MessageStrip, MultiComboBox, MultiComboBoxItem, ObjectStatus, Option, Select,
  SegmentedButton, SegmentedButtonItem, Text,
} from '@ui5/webcomponents-react';
import { api } from '../api';
import { AppPage } from '../components/AppPage';
import { Section } from '../components/Section';
import { useLoad } from '../components/useLoad';
import { AuswahlBox } from '../components/AuswahlBox';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useCan } from '../session';
import { toast } from '../toast';

/**
 * Tabellenansicht (Administration → System → Tabellenansicht, wie SE16): alle Tabellen der Schemas „core“ und der aktiven
 * Module mit Struktur und Inhalt. Selektion mit Bedingungen (=, ≠, <, ≤, >, ≥, Intervall, Muster, Liste, leer),
 * Feldauswahl, Sortierung, Gruppierung mit Kennzahlen (Anzahl, Summe, Durchschnitt, Min, Max) – alles serverseitig;
 * im Ergebnis zusätzlich Spaltenfilter, Sortierung und Gruppierung der Tabelle. Export als CSV.
 * Mit core.tabellen:edit: im Eintrag „Werte ändern“ – einzelne Werte eines Satzes ändern (ohne Änderungsbeleg).
 * Mit core.tabellen:delete: markierte Sätze löschen – sie landen 7 Tage im Papierkorb und lassen sich wiederherstellen (#34).
 * Geheimnisse (Hashes, Tokens, Passwörter) und Bankdaten ohne Berechtigung kommen maskiert vom Server.
 */
interface Tabelle { schema: string; tabelle: string; beschreibung: string | null; art: string; zeilen: string; spalten: number; bytes: string }
interface Spalte {
  name: string; typ: string; basistyp: string; pflicht: boolean; vorschlag: string | null; beschreibung: string | null;
  schluessel: number | null; schutz: 'GEHEIM' | 'iban' | 'bic' | 'text' | null; numerisch: boolean;
}
interface Struktur { schema: string; tabelle: string; zeilen: number; spalten: Spalte[]; /** Spalten, die der Benutzer hier ändern darf */ aenderbar?: string[] }
interface Ergebnis {
  spalten: { name: string; text: string; numerisch: boolean }[]; zeilen: (string | null)[][]; gesamt: number; mehr: boolean;
  /** Primärschlüssel je Zeile (nur für löschbare Tabellen, ungruppiert) */
  schluesselSpalten: string[] | null; schluessel: string[][] | null;
}

type Op = 'EQ' | 'NE' | 'LT' | 'LE' | 'GT' | 'GE' | 'BT' | 'CP' | 'NP' | 'IN' | 'NULL' | 'NNULL';
const OPS: { op: Op; text: string; hilfe?: string }[] = [
  { op: 'EQ', text: '= gleich' }, { op: 'NE', text: '≠ ungleich' },
  { op: 'CP', text: 'enthält / Muster', hilfe: 'Text oder Muster: * beliebig viele, + genau ein Zeichen' },
  { op: 'NP', text: 'enthält nicht', hilfe: 'Text oder Muster: * beliebig viele, + genau ein Zeichen' },
  { op: 'BT', text: '[ ] von … bis' }, { op: 'GE', text: '≥ ab' }, { op: 'GT', text: '> größer' }, { op: 'LE', text: '≤ bis' }, { op: 'LT', text: '< kleiner' },
  { op: 'IN', text: 'in Liste', hilfe: 'Werte mit ; trennen' }, { op: 'NULL', text: 'ist leer' }, { op: 'NNULL', text: 'ist nicht leer' },
];
type Fn = 'SUM' | 'AVG' | 'MIN' | 'MAX' | 'COUNT_DISTINCT';
const FNS: { fn: Fn; text: string }[] = [
  { fn: 'SUM', text: 'Summe' }, { fn: 'AVG', text: 'Durchschnitt' }, { fn: 'MIN', text: 'Minimum' }, { fn: 'MAX', text: 'Maximum' }, { fn: 'COUNT_DISTINCT', text: 'Anzahl verschiedene' },
];
interface Bedingung { spalte: string; op: Op; wert: string; bis: string }
interface Sort { spalte: string; absteigend: boolean }
interface Kennzahl { fn: Fn; spalte: string }
interface Selektion { felder: string[]; filter: Bedingung[]; sortierung: Sort[]; nach: string[]; summen: Kennzahl[]; limit: number }
const LEER: Selektion = { felder: [], filter: [], sortierung: [], nach: [], summen: [], limit: 500 };

const groesse = (b: number) => (b >= 1048576 ? `${(b / 1048576).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB` : `${Math.ceil(b / 1024).toLocaleString('de-DE')} KB`);
const zahl = (n: number | string) => Number(n).toLocaleString('de-DE');
const schutzText = { GEHEIM: 'geheim (nie sichtbar)', iban: 'Bankdaten (IBAN)', bic: 'Bankdaten (BIC)', text: 'Bankdaten (Name)' };

/** Auswahl je Tabelle für die Sitzung merken (Browser-Speicher, best effort) */
function gemerkt(key: string): Selektion | null {
  try { const v = sessionStorage.getItem(`tabellen:${key}`); return v ? { ...LEER, ...JSON.parse(v) } : null; } catch { return null; }
}
function merken(key: string, s: Selektion) {
  try { sessionStorage.setItem(`tabellen:${key}`, JSON.stringify(s)); } catch { /* ohne Speicher */ }
}

export function TabellenPage() {
  const can = useCan();
  const darfLoeschen = can('core.tabellen:delete');
  const liste = useLoad(() => api.get<Tabelle[]>('/api/admin/tabellen'));
  /** markierte Ergebniszeilen (Index) und Sicherheitsabfrage zum Löschen */
  const [markiert, setMarkiert] = useState<number[]>([]);
  /** zählt bei jeder neuen Selektion hoch – die Ergebnistabelle wird dann neu aufgebaut, alte Markierungen verfallen */
  const [ergNr, setErgNr] = useState(0);
  /** Zeitpunkt der letzten Markierung: ein Klick auf das Kästchen soll nicht zusätzlich den Detaildialog öffnen */
  const letzteMarkierung = useRef(0);
  const [frage, setFrage] = useState(false);
  const [papierkorb, setPapierkorb] = useState(false);
  const [wahl, setWahl] = useState<string | null>(null);
  const [struktur, setStruktur] = useState<Struktur | null>(null);
  const [sel, setSel] = useState<Selektion>(LEER);
  const [ansicht, setAnsicht] = useState<'DATEN' | 'STRUKTUR'>('DATEN');
  const [erg, setErg] = useState<Ergebnis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<(string | null)[] | null>(null);
  /** Zeile des geöffneten Eintrags (für den Schlüssel beim Ändern) und Bearbeitungsstand: Spalte → neuer Wert (null = leer/NULL) */
  const [detailIdx, setDetailIdx] = useState<number | null>(null);
  const [bearbeiten, setBearbeiten] = useState<Record<string, string | null> | null>(null);
  const [aendernFehler, setAendernFehler] = useState<string | null>(null);
  const [speichert, setSpeichert] = useState(false);
  const [suche, setSuche] = useState('');

  useEffect(() => {
    setStruktur(null); setErg(null); setError(null); setDetail(null); setMarkiert([]);
    if (!wahl) return;
    const [schema, tabelle] = wahl.split('.');
    api.get<Struktur>(`/api/admin/tabellen/${encodeURIComponent(schema)}/${encodeURIComponent(tabelle)}`)
      .then((s) => { setStruktur(s); setSel(gemerkt(wahl) ?? LEER); }).catch((e) => setError(e.message));
  }, [wahl]);

  // Ändern einzelner Werte (core.tabellen:edit): nur ungruppiert, mit Schlüssel der Zeile und für die vom Server freigegebenen Spalten
  const aenderbareSpalten = struktur?.aenderbar ?? [];
  const detailSchluessel = detailIdx !== null ? erg?.schluessel?.[detailIdx] ?? null : null;
  /** Wert einer Spalte vormerken; entspricht er wieder dem bisherigen, entfällt die Änderung */
  function setze1(spalte: string, neu: string | null, alt: string | null) {
    const n = { ...(bearbeiten ?? {}) };
    if (neu === alt) delete n[spalte]; else n[spalte] = neu;
    setBearbeiten(n);
  }
  async function aendern() {
    if (!struktur || !erg || !detail || !bearbeiten || !detailSchluessel) return;
    setSpeichert(true); setAendernFehler(null);
    try {
      const alt = Object.fromEntries(Object.keys(bearbeiten).map((k) => [k, detail[erg.spalten.findIndex((s) => s.name === k)] ?? null]));
      const r = await api.post<{ text: string }>(`/api/admin/tabellen/${struktur.schema}/${struktur.tabelle}/aendern`, { schluessel: detailSchluessel, werte: bearbeiten, alt });
      toast(r.text, 6000);
      setDetail(null); setBearbeiten(null);
      await ausfuehren();
    } catch (e) { setAendernFehler((e as Error).message); } finally { setSpeichert(false); }
  }

  async function ausfuehren(weitere = false) {
    if (!struktur) return;
    setBusy(true); setError(null);
    merken(wahl!, sel);
    try {
      const r = await api.post<Ergebnis>(`/api/admin/tabellen/${encodeURIComponent(struktur.schema)}/${encodeURIComponent(struktur.tabelle)}/daten`, {
        felder: sel.felder,
        filter: sel.filter.filter((f) => f.spalte),
        sortierung: sel.sortierung.filter((s) => s.spalte),
        gruppierung: sel.nach.length || sel.summen.length ? { nach: sel.nach, summen: sel.summen.filter((k) => k.spalte) } : null,
        limit: sel.limit,
        offset: weitere && erg ? erg.zeilen.length : 0,
      });
      setErg(weitere && erg ? { ...r, zeilen: [...erg.zeilen, ...r.zeilen], schluessel: r.schluessel && erg.schluessel ? [...erg.schluessel, ...r.schluessel] : r.schluessel } : r);
      if (!weitere) { setMarkiert([]); setErgNr((n) => n + 1); }
      setAnsicht('DATEN');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  function csv() {
    if (!erg || !struktur) return;
    const z = [erg.spalten.map((s) => s.text), ...erg.zeilen.map((r) => r.map((x) => x ?? ''))];
    const text = z.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
    a.download = `${struktur.schema}.${struktur.tabelle}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  const spalten = struktur?.spalten ?? [];
  const begriffe = suche.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const tabellen = (liste.data ?? []).filter((t) => begriffe.every((b) => `${t.schema}.${t.tabelle} ${t.beschreibung ?? ''}`.toLowerCase().includes(b)));

  // ------------------------------------------------------------------ Übersicht aller Tabellen
  const uebersicht: AnalyticalTableColumnDefinition[] = [
    { Header: 'Schema', accessor: 'schema', width: 110 },
    { Header: 'Tabelle', accessor: 'tabelle', width: 220 },
    { Header: 'Art', accessor: 'art', width: 110 },
    { Header: 'Beschreibung', accessor: 'beschreibung' },
    { Header: 'Zeilen (ca.)', id: 'zeilen', accessor: (t: Record<string, any>) => Number((t as Tabelle).zeilen), width: 120, hAlign: 'End', Cell: ({ value }: Cell) => zahl(value) },
    { Header: 'Spalten', accessor: 'spalten', width: 90, hAlign: 'End' },
    { Header: 'Größe', id: 'bytes', accessor: (t: Record<string, any>) => Number((t as Tabelle).bytes), width: 100, hAlign: 'End', Cell: ({ value }: Cell) => groesse(value) },
  ];

  // ------------------------------------------------------------------ Struktur der gewählten Tabelle
  const strukturSpalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Spalte', accessor: 'name', width: 200 },
    { Header: 'Typ', accessor: 'typ', width: 190 },
    { Header: 'Schlüssel', accessor: 'schluessel', width: 90, Cell: ({ value }: Cell) => (value ? <Icon name="key" title={`Primärschlüssel, Position ${value}`} /> : '') },
    { Header: 'Pflicht', accessor: 'pflicht', width: 80, Cell: ({ value }: Cell) => (value ? <Icon name="accept" /> : '') },
    { Header: 'Vorschlagswert', accessor: 'vorschlag', width: 200 },
    { Header: 'Schutz', accessor: 'schutz', width: 180, Cell: ({ value }: Cell) => (value ? <ObjectStatus state={value === 'GEHEIM' ? 'Negative' : 'Critical'}>{schutzText[value as keyof typeof schutzText]}</ObjectStatus> : '') },
    { Header: 'Beschreibung', accessor: 'beschreibung' },
  ];

  // ------------------------------------------------------------------ Ergebnis
  const daten = useMemo(() => (erg?.zeilen ?? []).map((r, z) => ({ _i: z, ...Object.fromEntries(r.map((x, i) => [`c${i}`, x])) })), [erg]);
  const zeilenOptionen = useMemo(() => ({ getRowId: (r: { _i: number }) => String(r._i), autoResetSelectedRows: false, autoResetSortBy: false, autoResetFilters: false }), []);
  const loeschbar = darfLoeschen && !!erg?.schluessel;
  const markiertIds = useMemo(() => Object.fromEntries(markiert.map((i) => [String(i), true])), [markiert]);

  async function loeschen(grund: string) {
    if (!struktur || !erg?.schluessel) return;
    setFrage(false); setError(null);
    // nur Schlüssel geladener Zeilen senden; fehlende melden statt den ganzen Vorgang scheitern zu lassen
    const schluessel = markiert.map((i) => erg.schluessel![i]).filter((k): k is string[] => Array.isArray(k));
    const fehlen = markiert.length - schluessel.length;
    if (!schluessel.length) { setError('Die markierten Zeilen sind nicht mehr geladen – bitte erneut ausführen und markieren.'); setMarkiert([]); return; }
    setBusy(true);
    try {
      const r = await api.post<{ text: string }>(`/api/admin/tabellen/${encodeURIComponent(struktur.schema)}/${encodeURIComponent(struktur.tabelle)}/loeschen`,
        { schluessel, grund });
      toast(fehlen ? `${r.text} ${fehlen} markierte Zeile(n) waren nicht mehr geladen und wurden übersprungen.` : r.text, 8000);
    } catch (e) { setError((e as Error).message); }
    // immer neu laden: Markierung leeren, Treffer und Anzahl aktualisieren
    setBusy(false);
    setMarkiert([]);
    api.get<Struktur>(`/api/admin/tabellen/${encodeURIComponent(struktur.schema)}/${encodeURIComponent(struktur.tabelle)}`).then(setStruktur).catch(() => undefined);
    await ausfuehren();
  }
  const ergSpalten: AnalyticalTableColumnDefinition[] = (erg?.spalten ?? []).map((s, i) => ({
    Header: s.text, accessor: `c${i}`, id: `c${i}`, hAlign: s.numerisch ? 'End' : 'Begin',
    minWidth: 90, width: Math.min(320, Math.max(90, s.text.length * 9 + 30)),
    Cell: ({ value }: Cell) => (value === null ? <span className="portal-muted">∅</span> : <span title={String(value).length > 60 ? String(value) : undefined}>{String(value)}</span>),
  }));

  const setze = (s: Partial<Selektion>) => setSel((x) => ({ ...x, ...s }));
  const spaltenOptionen = (aktuell: string) => [
    <Option key="" data-v="" selected={!aktuell}>– Spalte –</Option>,
    ...spalten.map((s) => <Option key={s.name} data-v={s.name} selected={s.name === aktuell}>{s.name}</Option>),
  ];
  const wertVon = (e: { detail: { selectedOption: unknown } }) => (e.detail.selectedOption as HTMLElement).dataset.v ?? '';
  const gruppiert = sel.nach.length > 0 || sel.summen.length > 0;

  return (
    <AppPage varianten={{ repid: 'core.tabellen', ansicht: { wahl, ansicht, suche }, onAnwenden: (a) => { setWahl(feld(a, 'wahl', wahl)); setAnsicht(feld(a, 'ansicht', ansicht)); setSuche(feld(a, 'suche', suche)); } }}
      title={struktur ? `Tabellenansicht: ${struktur.schema}.${struktur.tabelle}` : 'Tabellenansicht'}
      subtitle={struktur ? `${zahl(struktur.zeilen)} Einträge · ${spalten.length} Spalten` : liste.data ? `${liste.data.length} Tabellen` : undefined}
      actions={<>
        <AuswahlBox style={{ width: '22rem' }} placeholder="Tabelle wählen (Name oder Beschreibung)" wert={wahl ?? ''}
                    eintraege={(liste.data ?? []).map((t) => ({ key: `${t.schema}.${t.tabelle}`, text: `${t.schema}.${t.tabelle}`, zusatz: t.beschreibung ?? `${zahl(t.zeilen)} Zeilen` }))}
                    onWaehle={(k) => setWahl(k)} />
        {wahl && <Button icon="nav-back" onClick={() => setWahl(null)}>Alle Tabellen</Button>}
        {darfLoeschen && <Button icon="trash" onClick={() => setPapierkorb(true)}>Papierkorb</Button>}
      </>}
    >
      {liste.error && <MessageStrip design="Negative">{liste.error}</MessageStrip>}
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}

      {!wahl && (
        <>
          <div className="portal-row" style={{ marginBottom: '0.5rem' }}>
            <Input data-kein-autofill icon={<Icon name="search" />} placeholder="Suchen: Schema, Tabelle, Beschreibung" value={suche} style={{ width: '22rem' }}
                   onInput={(e) => setSuche(e.target.value)} showClearIcon />
          </div>
          <AnalyticalTable columns={uebersicht} data={tabellen} loading={liste.loading} filterable sortable groupable
                           visibleRowCountMode="Auto" style={{ height: 'calc(100vh - 220px)' }}
                           onRowClick={(e) => { const t = e.detail.row.original as Tabelle; setWahl(`${t.schema}.${t.tabelle}`); }} />
        </>
      )}

      {wahl && struktur && (
        <>
          <Section title="Selektion" actions={<>
            <Button design="Emphasized" icon="media-play" loading={busy} onClick={() => ausfuehren()}>Ausführen</Button>
            <Button design="Transparent" icon="reset" onClick={() => { setSel(LEER); setErg(null); }}>Zurücksetzen</Button>
          </>}>
            <div style={{ display: 'grid', gap: '0.75rem' }} onKeyDown={(e) => { if (e.key === 'F8' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); ausfuehren(); } }}>
              {/* Bedingungen */}
              <div>
                <Label showColon>Bedingungen (alle müssen zutreffen)</Label>
                {sel.filter.map((f, i) => {
                  const op = OPS.find((o) => o.op === f.op)!;
                  const aendern = (x: Partial<Bedingung>) => setze({ filter: sel.filter.map((y, j) => (j === i ? { ...y, ...x } : y)) });
                  return (
                    <div key={i} className="portal-row" style={{ gap: '0.5rem', marginTop: '0.25rem', flexWrap: 'wrap' }}>
                      <Select style={{ width: '14rem' }} onChange={(e) => aendern({ spalte: wertVon(e) })}>{spaltenOptionen(f.spalte)}</Select>
                      <Select style={{ width: '11rem' }} onChange={(e) => aendern({ op: wertVon(e) as Op })}>
                        {OPS.map((o) => <Option key={o.op} data-v={o.op} selected={o.op === f.op}>{o.text}</Option>)}
                      </Select>
                      {f.op !== 'NULL' && f.op !== 'NNULL' && (
                        <Input value={f.wert} placeholder={op.hilfe ?? (f.op === 'BT' ? 'von' : 'Wert')} style={{ width: '14rem' }} onInput={(e) => aendern({ wert: e.target.value })} />
                      )}
                      {f.op === 'BT' && <Input value={f.bis} placeholder="bis" style={{ width: '14rem' }} onInput={(e) => aendern({ bis: e.target.value })} />}
                      <Button design="Transparent" icon="decline" tooltip="Bedingung entfernen" onClick={() => setze({ filter: sel.filter.filter((_, j) => j !== i) })} />
                    </div>
                  );
                })}
                <Button design="Transparent" icon="add" onClick={() => setze({ filter: [...sel.filter, { spalte: '', op: 'EQ', wert: '', bis: '' }] })}>Bedingung</Button>
                <Text className="portal-muted portal-small" style={{ display: 'block' }}>
                  Datum als JJJJ-MM-TT, Dezimalzahlen mit Punkt. „enthält“ ignoriert Groß-/Kleinschreibung. Ausführen auch mit F8 oder Strg+Enter.
                </Text>
              </div>

              {/* Felder, Sortierung, Trefferzahl */}
              <div className="portal-row" style={{ gap: '1.5rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div style={{ display: 'grid', gap: '0.25rem', minWidth: '20rem', flex: 1 }}>
                  <Label showColon>Felder (leer = alle)</Label>
                  <MultiComboBox data-kein-autofill disabled={gruppiert} style={{ width: '100%' }}
                                 onSelectionChange={(e) => setze({ felder: spalten.map((s) => s.name).filter((n) => e.detail.items.some((x) => x.dataset.v === n)) })}>
                    {spalten.map((s) => <MultiComboBoxItem key={s.name} data-v={s.name} text={s.name} additionalText={s.typ} selected={sel.felder.includes(s.name)} />)}
                  </MultiComboBox>
                </div>
                <div style={{ display: 'grid', gap: '0.25rem' }}>
                  <Label showColon>Sortierung</Label>
                  {sel.sortierung.map((s, i) => (
                    <div key={i} className="portal-row" style={{ gap: '0.5rem' }}>
                      <Select style={{ width: '14rem' }} onChange={(e) => setze({ sortierung: sel.sortierung.map((y, j) => (j === i ? { ...y, spalte: wertVon(e) } : y)) })}>
                        {gruppiert
                          ? [<Option key="" data-v="" selected={!s.spalte}>– Feld –</Option>,
                             ...sel.nach.map((n) => <Option key={n} data-v={n} selected={s.spalte === n}>{n}</Option>),
                             <Option key="anzahl" data-v="anzahl" selected={s.spalte === 'anzahl'}>Anzahl</Option>,
                             ...sel.summen.filter((k) => k.spalte).map((k) => { const v = `${k.fn}:${k.spalte}`; return <Option key={v} data-v={v} selected={s.spalte === v}>{FNS.find((f) => f.fn === k.fn)!.text} {k.spalte}</Option>; })]
                          : spaltenOptionen(s.spalte)}
                      </Select>
                      <SegmentedButton onSelectionChange={(e) => setze({ sortierung: sel.sortierung.map((y, j) => (j === i ? { ...y, absteigend: (e.detail.selectedItems[0] as HTMLElement).dataset.v === 'ab' } : y)) })}>
                        <SegmentedButtonItem data-v="auf" icon="sort-ascending" tooltip="aufsteigend" selected={!s.absteigend} />
                        <SegmentedButtonItem data-v="ab" icon="sort-descending" tooltip="absteigend" selected={s.absteigend} />
                      </SegmentedButton>
                      <Button design="Transparent" icon="decline" tooltip="entfernen" onClick={() => setze({ sortierung: sel.sortierung.filter((_, j) => j !== i) })} />
                    </div>
                  ))}
                  {sel.sortierung.length < 5 && <Button design="Transparent" icon="add" onClick={() => setze({ sortierung: [...sel.sortierung, { spalte: '', absteigend: false }] })}>Sortierfeld</Button>}
                </div>
                <div style={{ display: 'grid', gap: '0.25rem' }}>
                  <Label showColon>Max. Trefferzahl</Label>
                  <Select style={{ width: '9rem' }} onChange={(e) => setze({ limit: Number(wertVon(e)) })}>
                    {[100, 500, 1000, 5000].map((n) => <Option key={n} data-v={String(n)} selected={sel.limit === n}>{zahl(n)}</Option>)}
                  </Select>
                </div>
              </div>

              {/* Gruppierung */}
              <div className="portal-row" style={{ gap: '1.5rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div style={{ display: 'grid', gap: '0.25rem', minWidth: '20rem', flex: 1 }}>
                  <Label showColon>Gruppieren nach (verdichtet mit Anzahl)</Label>
                  <MultiComboBox data-kein-autofill style={{ width: '100%' }}
                                 onSelectionChange={(e) => {
                                   const nach = e.detail.items.map((x) => x.dataset.v!).slice(0, 5);
                                   // Reihenfolge wie gewählt; Sortierung auf gültige Felder beschränken
                                   setze({ nach, sortierung: [] });
                                 }}>
                    {spalten.map((s) => <MultiComboBoxItem key={s.name} data-v={s.name} text={s.name} additionalText={s.typ} selected={sel.nach.includes(s.name)} />)}
                  </MultiComboBox>
                </div>
                <div style={{ display: 'grid', gap: '0.25rem' }}>
                  <Label showColon>Kennzahlen je Gruppe</Label>
                  {sel.summen.map((k, i) => {
                    const aendern = (x: Partial<Kennzahl>) => setze({ summen: sel.summen.map((y, j) => (j === i ? { ...y, ...x } : y)), sortierung: [] });
                    const nurZahl = k.fn === 'SUM' || k.fn === 'AVG';
                    return (
                      <div key={i} className="portal-row" style={{ gap: '0.5rem' }}>
                        <Select style={{ width: '11rem' }} onChange={(e) => aendern({ fn: wertVon(e) as Fn })}>
                          {FNS.map((f) => <Option key={f.fn} data-v={f.fn} selected={f.fn === k.fn}>{f.text}</Option>)}
                        </Select>
                        <Select style={{ width: '14rem' }} onChange={(e) => aendern({ spalte: wertVon(e) })}>
                          <Option data-v="" selected={!k.spalte}>– Spalte –</Option>
                          {spalten.filter((s) => !nurZahl || (s.numerisch && !s.schutz)).map((s) => <Option key={s.name} data-v={s.name} selected={s.name === k.spalte}>{s.name}</Option>)}
                        </Select>
                        <Button design="Transparent" icon="decline" tooltip="entfernen" onClick={() => setze({ summen: sel.summen.filter((_, j) => j !== i), sortierung: [] })} />
                      </div>
                    );
                  })}
                  {sel.summen.length < 10 && <Button design="Transparent" icon="add" onClick={() => setze({ summen: [...sel.summen, { fn: 'SUM', spalte: '' }] })}>Kennzahl</Button>}
                </div>
              </div>
            </div>
          </Section>

          <div className="portal-row" style={{ gap: '0.75rem', margin: '0.75rem 0 0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <SegmentedButton onSelectionChange={(e) => setAnsicht((e.detail.selectedItems[0] as HTMLElement).dataset.v as typeof ansicht)}>
              <SegmentedButtonItem data-v="DATEN" icon="table-view" selected={ansicht === 'DATEN'}>Daten</SegmentedButtonItem>
              <SegmentedButtonItem data-v="STRUKTUR" icon="tree" selected={ansicht === 'STRUKTUR'}>Struktur ({spalten.length})</SegmentedButtonItem>
            </SegmentedButton>
            {ansicht === 'DATEN' && erg && (
              <>
                <Text>
                  {zahl(erg.zeilen.length)} von {zahl(erg.gesamt)} {gruppiert ? 'Gruppen' : 'Treffern'} angezeigt
                </Text>
                {erg.mehr && <Button icon="download-from-cloud" loading={busy} onClick={() => ausfuehren(true)}>Weitere {zahl(sel.limit)} laden</Button>}
                {loeschbar && <Button design="Negative" icon="delete" disabled={!markiert.length || busy} onClick={() => setFrage(true)}
                                     tooltip="Markierte Sätze löschen – 7 Tage im Papierkorb wiederherstellbar">Löschen{markiert.length ? ` (${markiert.length})` : ''}</Button>}
                <Button icon="excel-attachment" onClick={csv}>CSV</Button>
                <Text className="portal-muted portal-small">Spaltenkopf: filtern, sortieren und zusätzlich gruppieren · Zeile anklicken: alle Felder</Text>
              </>
            )}
          </div>

          {ansicht === 'STRUKTUR' && (
            <AnalyticalTable columns={strukturSpalten} data={spalten} filterable sortable visibleRows={Math.min(Math.max(spalten.length, 1), 25)} minRows={1} />
          )}
          {ansicht === 'DATEN' && (erg ? (
            <AnalyticalTable key={`erg-${ergNr}`} columns={ergSpalten} data={daten} loading={busy} filterable sortable groupable minRows={1}
                             {...(loeschbar ? { selectionMode: 'Multiple' as const, selectionBehavior: 'RowSelector' as const, reactTableOptions: zeilenOptionen,
                               selectedRowIds: markiertIds,
                               onRowSelect: (e: { detail: { selectedRowIds: Record<string, boolean> } }) => {
                                 letzteMarkierung.current = Date.now();
                                 // nur Zeilen des aktuellen Ergebnisses (veraltete Kennungen fallen weg)
                                 setMarkiert(Object.keys(e.detail.selectedRowIds).filter((k) => e.detail.selectedRowIds[k]).map(Number).filter((i) => i >= 0 && i < daten.length));
                               } } : {})}
                             visibleRowCountMode="Auto" style={{ height: 'max(20rem, calc(100vh - 520px))' }}
                             onRowClick={(e) => {
                               const row = e.detail.row as unknown as { original?: Record<string, string | null>; isGrouped?: boolean };
                               if (!row.original || row.isGrouped) return;
                               const original = row.original;
                               // Klick auf das Markierungskästchen: nur markieren, keinen Dialog öffnen (Reihenfolge der Ereignisse egal)
                               const t = Date.now();
                               setTimeout(() => {
                                 if (letzteMarkierung.current >= t - 50) return;
                                 setDetail(erg.spalten.map((_, i) => original[`c${i}`] ?? null));
                                 setDetailIdx(typeof (original as { _i?: unknown })._i === 'number' ? (original as unknown as { _i: number })._i : null);
                                 setBearbeiten(null); setAendernFehler(null);
                               }, 0);
                             }} />
          ) : (
            <Text className="portal-muted">Selektion festlegen und „Ausführen“ wählen.</Text>
          ))}

          {detail && erg && (
            <Dialog open headerText={`Eintrag aus ${struktur.schema}.${struktur.tabelle}${bearbeiten ? ' ändern' : ''}`} style={{ width: 'min(52rem, 96vw)' }} onClose={() => setDetail(null)}
                    footer={<Bar endContent={<>
                      {!bearbeiten && detailSchluessel && aenderbareSpalten.length > 0 && <Button icon="edit" onClick={() => { setBearbeiten({}); setAendernFehler(null); }}>Werte ändern</Button>}
                      {bearbeiten && <Button design="Emphasized" icon="save" loading={speichert} disabled={speichert || !Object.keys(bearbeiten).length} onClick={aendern}>Speichern</Button>}
                      {bearbeiten && <Button disabled={speichert} onClick={() => setBearbeiten(null)}>Abbrechen</Button>}
                      {!bearbeiten && <Button design="Emphasized" onClick={() => setDetail(null)}>Schließen</Button>}
                    </>} />}>
              {aendernFehler && <MessageStrip design="Negative" onClose={() => setAendernFehler(null)} style={{ marginBottom: '0.5rem' }}>{aendernFehler}</MessageStrip>}
              {bearbeiten && (
                <>
                  <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>
                    Direkte Änderung in der Datenbank: Die fachlichen Prüfungen der Apps greifen hier nicht, und es wird kein Änderungsbeleg geschrieben.
                  </MessageStrip>
                </>
              )}
              <table className="portal-tabelle" style={{ width: '100%', fontSize: '0.875rem' }}>
                <tbody>
                  {erg.spalten.map((s, i) => {
                    const def = spalten.find((x) => x.name === s.name);
                    return (
                      <tr key={s.name}>
                        <td style={{ verticalAlign: 'top', whiteSpace: 'nowrap', paddingRight: '1rem' }}><b>{s.name}</b><br /><Label>{def?.typ}</Label></td>
                        <td style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                          {bearbeiten && aenderbareSpalten.includes(s.name) && (detail[i] ?? '').length < 2000 ? (
                            <span style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                              <Input style={{ flex: 1 }} disabled={bearbeiten[s.name] === null && s.name in bearbeiten}
                                     value={s.name in bearbeiten ? bearbeiten[s.name] ?? '' : detail[i] ?? ''}
                                     valueState={s.name in bearbeiten ? 'Information' : 'None'}
                                     onInput={(e) => setze1(s.name, e.target.value, detail[i])} />
                              {!def?.pflicht && <CheckBox text="leer (NULL)" checked={s.name in bearbeiten ? bearbeiten[s.name] === null : detail[i] === null}
                                                          onChange={(e) => setze1(s.name, e.target.checked ? null : '', detail[i])} />}
                            </span>
                          ) : detail[i] === null ? <span className="portal-muted">∅ (null)</span> : detail[i]}
                          {bearbeiten && !aenderbareSpalten.includes(s.name) && <span className="portal-muted portal-small"> · {def?.schluessel ? 'Schlüssel' : def?.schutz ? 'geschützt' : 'nicht änderbar'}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Dialog>
          )}
        </>
      )}
      {wahl && !struktur && !error && <Text>Lade …</Text>}
      {struktur && erg?.schluessel && (
        <ConfirmDialog open={frage} danger askReason title={`${markiert.length} Satz/Sätze löschen?`} confirmText="Löschen"
                       text={`Die markierten Sätze werden aus ${struktur.schema}.${struktur.tabelle} gelöscht (Schlüssel: ${erg.schluesselSpalten!.join(', ')}). `
                         + 'Sie bleiben 7 Tage im Papierkorb und lassen sich dort wiederherstellen. Sätze mit abhängigen Einträgen in anderen Tabellen werden nicht gelöscht. Bitte einen Grund angeben.'}
                       onConfirm={loeschen} onCancel={() => setFrage(false)} />
      )}
      {papierkorb && <PapierkorbDialog tabelle={struktur ? `${struktur.schema}.${struktur.tabelle}` : null}
                                       onClose={(geaendert) => { setPapierkorb(false); if (geaendert && erg) ausfuehren(); }} />}
    </AppPage>
  );
}

/** Papierkorb der Tabellenansicht: gelöschte Sätze der letzten 7 Tage wiederherstellen oder endgültig entfernen (#34) */
interface Eintrag { id: number; vorgang: string; schema: string; tabelle: string; schluessel: Record<string, unknown>; geloescht_am: string; geloescht_von: string; grund: string | null; verfaellt_am: string }
function PapierkorbDialog({ tabelle, onClose }: { tabelle: string | null; onClose: (geaendert: boolean) => void }) {
  const [liste, setListe] = useState<Eintrag[] | null>(null);
  const [nurDiese, setNurDiese] = useState(!!tabelle);
  const [wahl, setWahl] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meldungen, setMeldungen] = useState<{ id: number; ok: boolean; text: string }[]>([]);
  const [geaendert, setGeaendert] = useState(false);
  const [endgueltig, setEndgueltig] = useState(false);
  const laden = () => api.get<Eintrag[]>('/api/admin/tabellen/papierkorb').then((l) => { setListe(l); setWahl(new Set()); }).catch((e) => setError(e.message));
  useEffect(() => { laden(); }, []);
  const sichtbar = (liste ?? []).filter((e) => !nurDiese || `${e.schema}.${e.tabelle}` === tabelle);
  const zeit = (iso: string) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
  const umschalten = (id: number) => setWahl((w) => { const n = new Set(w); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  async function los(art: 'wiederherstellen' | 'entfernen') {
    setBusy(true); setError(null); setEndgueltig(false);
    try {
      const r = await api.post<{ text: string; zeilen?: { id: number; ok: boolean; text: string }[] }>(`/api/admin/tabellen/papierkorb/${art}`, { ids: [...wahl] });
      toast(r.text, 6000);
      setMeldungen((r.zeilen ?? []).filter((z) => !z.ok));
      if (art === 'wiederherstellen') setGeaendert(true);
      await laden();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const zelle = { padding: '0.3rem 0.5rem', borderTop: '1px solid var(--sapList_BorderColor)', verticalAlign: 'top' } as const;
  return (
    <Dialog open headerText="Papierkorb der Tabellenansicht" style={{ width: 'min(64rem, 96vw)' }} onClose={() => onClose(geaendert)}
            footer={<Bar startContent={<Button design="Transparent" icon="delete" disabled={!wahl.size || busy} onClick={() => setEndgueltig(true)}>Endgültig entfernen</Button>}
                         endContent={<>
                           <Button design="Emphasized" icon="undo" disabled={!wahl.size || busy} onClick={() => los('wiederherstellen')}>{wahl.size} wiederherstellen</Button>
                           <Button onClick={() => onClose(geaendert)}>Schließen</Button>
                         </>} />}>
      <Text style={{ display: 'block', marginBottom: '0.5rem' }}>
        Gelöschte Sätze bleiben 7 Tage hier und werden danach automatisch entfernt. Wiederhergestellt wird der Satz genau so, wie er gelöscht wurde.
      </Text>
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {meldungen.map((m) => <MessageStrip key={m.id} design="Critical" hideCloseButton style={{ marginBottom: '0.25rem' }}>Eintrag {m.id}: {m.text}</MessageStrip>)}
      <div className="portal-row" style={{ gap: '1rem', marginBottom: '0.5rem' }}>
        {tabelle && <CheckBox text={`nur ${tabelle}`} checked={nurDiese} onChange={(e) => setNurDiese(e.target.checked)} />}
        <Button design="Transparent" onClick={() => setWahl(new Set(sichtbar.map((e) => e.id)))}>alle wählen</Button>
        <Button design="Transparent" onClick={() => setWahl(new Set())}>keine</Button>
      </div>
      {!liste ? <Text>Lade …</Text> : !sichtbar.length ? <Text className="portal-muted">Der Papierkorb ist leer.</Text> : (
        <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.875rem' }}>
            <thead><tr>{['', 'Tabelle', 'Schlüssel', 'Gelöscht', 'von', 'Grund', 'verfällt'].map((h) => <th key={h} style={{ ...zelle, borderTop: 'none', textAlign: 'left' }}><Label>{h}</Label></th>)}</tr></thead>
            <tbody>{sichtbar.map((e) => (
              <tr key={e.id}>
                <td style={zelle}><CheckBox checked={wahl.has(e.id)} onChange={() => umschalten(e.id)} accessibleName={`Eintrag ${e.id} wählen`} /></td>
                <td style={zelle}>{e.schema}.{e.tabelle}</td>
                <td style={zelle}>{Object.entries(e.schluessel).map(([k, v]) => `${k} = ${String(v)}`).join(', ')}</td>
                <td style={zelle}>{zeit(e.geloescht_am)}</td>
                <td style={zelle}>{e.geloescht_von}</td>
                <td style={zelle}>{e.grund ?? ''}</td>
                <td style={zelle}>{zeit(e.verfaellt_am)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <ConfirmDialog open={endgueltig} danger title={`${wahl.size} Eintrag/Einträge endgültig entfernen?`} confirmText="Endgültig entfernen"
                     text="Die gewählten Sätze lassen sich danach nicht mehr wiederherstellen." onConfirm={() => los('entfernen')} onCancel={() => setEndgueltig(false)} />
    </Dialog>
  );
}
