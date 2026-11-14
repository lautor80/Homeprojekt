import { useEffect, useMemo, useState } from 'react';
import { AnalyticalTable, Bar, Button, CheckBox, MessageStrip, ObjectStatus, Text } from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AblageFlaeche } from '@core/ablage';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { Section } from '@core/components/Section';
import { T } from './util';

/**
 * Stammdaten → Datenimport (#121): CSV-Exporte aus SAP einlesen, prüfen und übernehmen.
 * Modus „neu“: nur neue Sätze anlegen; „ersetzen“ (Neuaufbau): Tabellen vorher leeren.
 */
interface ImpStatus { key: string; datei: string; tabelle: string; status: string; state: 'None' | 'Positive' | 'Negative' | 'Critical'; anzahl: number | null; neu: number | null; hinweis: string }
interface Datei { name: string; data: string }

function readBase64(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = rej;
    r.readAsDataURL(f);
  });
}

export function Datenimport({ onDone }: { onDone?: () => void }) {
  const [files, setFiles] = useState<Datei[]>([]);
  const [status, setStatus] = useState<ImpStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ergebnis, setErgebnis] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [modus, setModus] = useState<'neu' | 'ersetzen'>('neu');
  const [frage, setFrage] = useState(false);

  async function pruefen(dateien: Datei[], m: 'neu' | 'ersetzen') {
    setError(null);
    try {
      setStatus(await api.post<ImpStatus[]>(`${T}/import/pruefen`, { dateien, modus: m }));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => { pruefen([], 'neu'); }, []);

  async function add(list: FileList | File[] | null) {
    if (!list?.length) return;
    const neu = [...files];
    for (const f of Array.from(list)) {
      const i = neu.findIndex((x) => x.name === f.name);
      const e = { name: f.name, data: await readBase64(f) };
      if (i >= 0) neu[i] = e; else neu.push(e);
    }
    setFiles(neu);
    setErgebnis(null);
    await pruefen(neu, modus);
  }

  function leeren() {
    setFiles([]);
    setErgebnis(null);
    setModus('neu');
    pruefen([], 'neu');
  }

  async function start(reason?: string) {
    setFrage(false);
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ text: string }>(`${T}/import/ausfuehren`, { dateien: files, modus, reason });
      setErgebnis(r.text);
      setFiles([]);
      setModus('neu');
      await pruefen([], 'neu');
      onDone?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const columns: AnalyticalTableColumnDefinition[] = useMemo(() => [
    { Header: 'Datei', accessor: 'datei', minWidth: 200, Cell: ({ row }: Cell) => <div><b>{row.original.datei}</b><br /><Text className="portal-muted">{row.original.tabelle}</Text></div> },
    { Header: 'Status', accessor: 'status', width: 140, Cell: ({ row }: Cell) => <ObjectStatus state={row.original.state}>{row.original.status}</ObjectStatus> },
    { Header: 'Sätze', accessor: 'anzahl', width: 90, hAlign: 'End', Cell: ({ value }: Cell) => (value === null || value === undefined ? '' : Number(value).toLocaleString('de-DE')) },
    { Header: modus === 'ersetzen' ? 'werden angelegt' : 'davon neu', accessor: 'neu', width: 130, hAlign: 'End', Cell: ({ value }: Cell) => (value === null || value === undefined ? '' : Number(value).toLocaleString('de-DE')) },
    { Header: 'Hinweis', accessor: 'hinweis', minWidth: 260 },
  ], [modus]);
  const rows = status ?? [];
  const eingelesen = rows.some((s) => s.status === 'eingelesen');
  const gesperrt = !eingelesen || (modus === 'ersetzen' && rows.some((s) => s.state === 'Negative'));

  return (
    <>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}
      {ergebnis && (
        <MessageStrip design="Positive" onClose={() => setErgebnis(null)} style={{ marginBottom: '1rem' }}>
          <div style={{ whiteSpace: 'pre-line' }}><b>Import abgeschlossen</b>{'\n'}{ergebnis}</div>
        </MessageStrip>
      )}
      <Section title="SAP-Export einlesen">
        <Text style={{ display: 'block', marginBottom: '0.75rem' }}>
          Alle CSV-Dateien des SAP-Exports auf einmal ablegen: Aufträge, Aufträge_POs, Adressen, ZEU_TRAEGER, optional ZEU_PRODUKTE,
          Wertelisten und ZEU_RGNRKREIS. Jede Datei wird am Spaltenkopf erkannt – der Dateiname ist egal. SAP-Tabellen ohne
          Gegenstück im Portal (ZEU_DOSSIER, ZEU_LADEGUT_T, ZGN_ALV_FIELDS, ZGN_CUST) werden erkannt und übersprungen.
        </Text>
        <AblageFlaeche ziel={{ titel: 'SAP-Import', annehmen: (f) => { add(f); } }} accept=".csv,text/csv"
                       titel="CSV-Dateien hier ablegen" text="Hierher ziehen oder klicken zum Auswählen – sie werden sofort eingelesen und geprüft." />
        <div style={{ marginTop: '0.75rem' }}>
          <CheckBox text="Neuaufbau: vorhandene Aufträge, Stops, Träger und Adressen vorher löschen (Produkte/Wertelisten nur, wenn ihre Datei dabei ist)"
                    wrappingType="Normal" checked={modus === 'ersetzen'}
                    onChange={(e) => { const m = e.target.checked ? 'ersetzen' : 'neu'; setModus(m); void pruefen(files, m); }} />
        </div>
        {modus === 'ersetzen' ? (
          <MessageStrip design="Critical" hideCloseButton style={{ marginTop: '0.5rem' }}>
            Neuaufbau: Die Tabellen werden geleert und komplett aus den Dateien angelegt – im Portal erfasste Aufträge, die
            nicht in der Datei stehen, gehen verloren. Erforderlich sind Aufträge, Aufträge_POs, Adressen und ZEU_TRAEGER;
            mit ZEU_RGNRKREIS werden die Nummernkreise genau auf den SAP-Stand gesetzt. Vorher eine Sicherung ziehen
            (Administration → System → Sicherung, Bereich Euroflex).
          </MessageStrip>
        ) : (
          <Text className="portal-muted" style={{ display: 'block', marginTop: '0.25rem' }}>
            Ohne Neuaufbau werden nur neue Sätze angelegt, vorhandene bleiben unverändert (leere Adressen werden ergänzt).
          </Text>
        )}
      </Section>

      <Section title="Prüfung" count={files.length ? `${files.length} Datei(en)` : undefined} flush
               actions={files.length ? <Button design="Transparent" icon="clear-all" onClick={leeren}>Dateien entfernen</Button> : undefined}>
        <AnalyticalTable minRows={1} columns={columns} data={rows} visibleRows={Math.max(rows.length, 1)} rowHeight={52}
                         scaleWidthMode="Smart" noDataText="Noch keine Dateien eingelesen" />
      </Section>

      <Bar endContent={
        <Button design={modus === 'ersetzen' ? 'Negative' : 'Emphasized'} icon="upload-to-cloud" loading={busy} disabled={gesperrt}
                onClick={() => (modus === 'ersetzen' ? setFrage(true) : start())}>
          {modus === 'ersetzen' ? 'Neu aufbauen' : 'Importieren'}
        </Button>
      } />

      <ConfirmDialog open={frage} danger askReason title="Euroflex-Daten neu aufbauen?" confirmText="Neu aufbauen"
                     text="Aufträge, Stops, Träger und Adressen (und Produkte/Wertelisten, wenn ihre Datei dabei ist) werden gelöscht und aus den Dateien neu angelegt. Das lässt sich nur über eine Sicherung rückgängig machen."
                     onConfirm={(r) => { void start(r); }} onCancel={() => setFrage(false)} />
    </>
  );
}
