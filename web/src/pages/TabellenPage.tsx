import { useEffect, useMemo, useState } from 'react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import {
  AnalyticalTable, Bar, Button, Dialog, Icon, Input, Label, MessageStrip, MultiComboBox, MultiComboBoxItem, ObjectStatus, Option, Select,
  SegmentedButton, SegmentedButtonItem, Text,
} from '@ui5/webcomponents-react';
import { api } from '../api';
import { AppPage } from '../components/AppPage';
import { Section } from '../components/Section';
import { useLoad } from '../components/useLoad';
import { AuswahlBox } from '../components/AuswahlBox';

/**
 * Tabellenansicht (Administration → Tabellenansicht, wie SE16): alle Tabellen der Schemas „core“ und der aktiven
 * Module mit Struktur und Inhalt. Selektion mit Bedingungen (=, ≠, <, ≤, >, ≥, Intervall, Muster, Liste, leer),
 * Feldauswahl, Sortierung, Gruppierung mit Kennzahlen (Anzahl, Summe, Durchschnitt, Min, Max) – alles serverseitig;
 * im Ergebnis zusätzlich Spaltenfilter, Sortierung und Gruppierung der Tabelle. Nur lesend, Export als CSV.
 * Geheimnisse (Hashes, Tokens, Passwörter) und Bankdaten ohne Berechtigung kommen maskiert vom Server.
 */
interface Tabelle { schema: string; tabelle: string; beschreibung: string | null; art: string; zeilen: string; spalten: number; bytes: string }
interface Spalte {
  name: string; typ: string; basistyp: string; pflicht: boolean; vorschlag: string | null; beschreibung: string | null;
  schluessel: number | null; schutz: 'GEHEIM' | 'iban' | 'bic' | 'text' | null; numerisch: boolean;
}
interface Struktur { schema: string; tabelle: string; zeilen: number; spalten: Spalte[] }
interface Ergebnis { spalten: { name: string; text: string; numerisch: boolean }[]; zeilen: (string | null)[][]; gesamt: number; mehr: boolean }

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
  const liste = useLoad(() => api.get<Tabelle[]>('/api/admin/tabellen'));
  const [wahl, setWahl] = useState<string | null>(null);
  const [struktur, setStruktur] = useState<Struktur | null>(null);
  const [sel, setSel] = useState<Selektion>(LEER);
  const [ansicht, setAnsicht] = useState<'DATEN' | 'STRUKTUR'>('DATEN');
  const [erg, setErg] = useState<Ergebnis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<(string | null)[] | null>(null);
  const [suche, setSuche] = useState('');

  useEffect(() => {
    setStruktur(null); setErg(null); setError(null); setDetail(null);
    if (!wahl) return;
    const [schema, tabelle] = wahl.split('.');
    api.get<Struktur>(`/api/admin/tabellen/${encodeURIComponent(schema)}/${encodeURIComponent(tabelle)}`)
      .then((s) => { setStruktur(s); setSel(gemerkt(wahl) ?? LEER); }).catch((e) => setError(e.message));
  }, [wahl]);

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
      setErg(weitere && erg ? { ...r, zeilen: [...erg.zeilen, ...r.zeilen] } : r);
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
    { Header: 'Zeilen (ca.)', id: 'zeilen', accessor: (t: Tabelle) => Number(t.zeilen), width: 120, hAlign: 'End', Cell: ({ value }: Cell) => zahl(value) },
    { Header: 'Spalten', accessor: 'spalten', width: 90, hAlign: 'End' },
    { Header: 'Größe', id: 'bytes', accessor: (t: Tabelle) => Number(t.bytes), width: 100, hAlign: 'End', Cell: ({ value }: Cell) => groesse(value) },
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
  const daten = useMemo(() => (erg?.zeilen ?? []).map((r) => Object.fromEntries(r.map((x, i) => [`c${i}`, x]))), [erg]);
  const ergSpalten: AnalyticalTableColumnDefinition[] = (erg?.spalten ?? []).map((s, i) => ({
    Header: s.text, accessor: `c${i}`, id: `c${i}`, hAlign: s.numerisch ? 'End' : 'Start',
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
    <AppPage
      title={struktur ? `Tabellenansicht: ${struktur.schema}.${struktur.tabelle}` : 'Tabellenansicht'}
      subtitle={struktur ? `${zahl(struktur.zeilen)} Einträge · ${spalten.length} Spalten` : liste.data ? `${liste.data.length} Tabellen` : undefined}
      actions={<>
        <AuswahlBox style={{ width: '22rem' }} placeholder="Tabelle wählen (Name oder Beschreibung)" wert={wahl ?? ''}
                    eintraege={(liste.data ?? []).map((t) => ({ key: `${t.schema}.${t.tabelle}`, text: `${t.schema}.${t.tabelle}`, zusatz: t.beschreibung ?? `${zahl(t.zeilen)} Zeilen` }))}
                    onWaehle={(k) => setWahl(k)} />
        {wahl && <Button icon="nav-back" onClick={() => setWahl(null)}>Alle Tabellen</Button>}
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
                <Button icon="excel-attachment" onClick={csv}>CSV</Button>
                <Text className="portal-muted portal-small">Spaltenkopf: filtern, sortieren und zusätzlich gruppieren · Zeile anklicken: alle Felder</Text>
              </>
            )}
          </div>

          {ansicht === 'STRUKTUR' && (
            <AnalyticalTable columns={strukturSpalten} data={spalten} filterable sortable visibleRows={Math.min(Math.max(spalten.length, 1), 25)} minRows={1} />
          )}
          {ansicht === 'DATEN' && (erg ? (
            <AnalyticalTable columns={ergSpalten} data={daten} loading={busy} filterable sortable groupable minRows={1}
                             visibleRowCountMode="Auto" style={{ height: 'max(20rem, calc(100vh - 520px))' }}
                             onRowClick={(e) => {
                               const row = e.detail.row as unknown as { original?: Record<string, string | null>; isGrouped?: boolean };
                               if (row.original && !row.isGrouped) setDetail(erg.spalten.map((_, i) => row.original![`c${i}`] ?? null));
                             }} />
          ) : (
            <Text className="portal-muted">Selektion festlegen und „Ausführen“ wählen.</Text>
          ))}

          {detail && erg && (
            <Dialog open headerText={`Eintrag aus ${struktur.schema}.${struktur.tabelle}`} style={{ width: 'min(48rem, 96vw)' }} onClose={() => setDetail(null)}
                    footer={<Bar endContent={<Button design="Emphasized" onClick={() => setDetail(null)}>Schließen</Button>} />}>
              <table className="portal-tabelle" style={{ width: '100%', fontSize: '0.875rem' }}>
                <tbody>
                  {erg.spalten.map((s, i) => {
                    const def = spalten.find((x) => x.name === s.name);
                    return (
                      <tr key={s.name}>
                        <td style={{ verticalAlign: 'top', whiteSpace: 'nowrap', paddingRight: '1rem' }}><b>{s.name}</b><br /><Label>{def?.typ}</Label></td>
                        <td style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{detail[i] === null ? <span className="portal-muted">∅ (null)</span> : detail[i]}</td>
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
    </AppPage>
  );
}
