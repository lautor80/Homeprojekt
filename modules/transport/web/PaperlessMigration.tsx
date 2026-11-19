import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnalyticalTable, Bar, Button, CheckBox, Input, Link, MessageStrip, ObjectStatus, Text } from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { Section } from '@core/components/Section';
import { T } from './util';
import {
  auftragFuer, dateiDatum, ignorieren, kandidaten, typErlaubt, uebertragbar, zaehlen, type MigEintrag, type MigStatus,
} from './migration-logik';

/**
 * Administration → Schnittstellen → Paperless → „Migration lokaler Auftragsordner“:
 * Einen Ordner auf diesem PC wählen (z. B. den bisherigen Ablageordner <Ordner>/<Jahr>/<Auftrag>/…). Das Programm durchsucht
 * alle Unterordner; jede Datei unter einem Ordner, der nach der Auftragsnummer benannt ist, geht einzeln nach Paperless –
 * mit Custom Field „Auftrag“ = Nummer, Dokumentdatum = Datum der Datei im Ordner. Testlauf: eine Datei oder ein Auftrag.
 * Erneutes Übertragen ist gefahrlos: Dubletten erkennt Paperless, dann wird nur die Auftragsnummer ergänzt.
 */
interface Ordner { name: string; values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle> }

const lesen = (f: File) => new Promise<string>((ok, err) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result));
  r.onerror = () => err(r.error);
  r.readAsDataURL(f);
});
const moeglich = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

const STATUS: Record<MigStatus, { text: string; state: 'None' | 'Positive' | 'Negative' | 'Critical' | 'Information' }> = {
  offen: { text: 'offen', state: 'None' },
  laeuft: { text: 'wird übertragen …', state: 'Information' },
  neu: { text: 'übertragen', state: 'Positive' },
  vorhanden: { text: 'war schon da – ergänzt', state: 'Positive' },
  verarbeitung: { text: 'Paperless verarbeitet noch', state: 'Critical' },
  fehler: { text: 'Fehler', state: 'Negative' },
  uebersprungen: { text: 'übersprungen', state: 'None' },
};

export function PaperlessMigration() {
  const navigate = useNavigate();
  const [wurzel, setWurzel] = useState<string | null>(null);
  const [liste, setListe] = useState<MigEintrag[]>([]);
  const dateien = useRef(new Map<string, FileSystemFileHandle>());
  const [suchen, setSuchen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paperless, setPaperless] = useState(true);
  const [mitUnbekannten, setMitUnbekannten] = useState(false);
  const [filter, setFilter] = useState('');
  const [nurOffen, setNurOffen] = useState(false);
  const [laeuft, setLaeuft] = useState(false);
  const [frage, setFrage] = useState(false);
  const halt = useRef(false);

  const setzen = (key: string, status: MigStatus, text = '') => setListe((l) => l.map((e) => (e.key === key ? { ...e, status, text } : e)));

  async function waehlen() {
    setError(null);
    let h: Ordner;
    try {
      h = await (window as unknown as { showDirectoryPicker(o: object): Promise<Ordner> }).showDirectoryPicker({ id: 'euroflex-migration', mode: 'read' });
    } catch (e) { if ((e as DOMException).name !== 'AbortError') setError((e as Error).message); return; }
    setWurzel(h.name); setListe([]); dateien.current.clear();
    const funde: { ordner: string[]; datei: string; groesse: number; geaendert: number; handle: FileSystemFileHandle }[] = [];
    let n = 0;
    setSuchen('Durchsuche Ordner …');
    try {
      // alle Unterordner durchgehen; Pfad = Ordnernamen unterhalb des gewählten Ordners
      const durchsuchen = async (o: Ordner, pfad: string[]) => {
        for await (const x of o.values()) {
          if (x.kind === 'directory') await durchsuchen(x as unknown as Ordner, [...pfad, x.name]);
          else if (!ignorieren(x.name)) {
            const f = await (x as FileSystemFileHandle).getFile();
            funde.push({ ordner: pfad, datei: x.name, groesse: f.size, geaendert: f.lastModified, handle: x as FileSystemFileHandle });
            if (++n % 50 === 0) setSuchen(`Durchsuche Ordner … ${n} Dateien`);
          }
        }
      };
      await durchsuchen(h, []);
      setSuchen(`${n} Dateien gefunden – prüfe Auftragsnummern …`);
      const r = await api.post<{ bekannt: string[]; paperless: boolean }>(`${T}/migration/pruefen`, { nummern: kandidaten(funde.map((f) => f.ordner)) });
      setPaperless(r.paperless);
      const bekannt = new Set(r.bekannt);
      const l: MigEintrag[] = funde.map((f, i) => {
        const z = auftragFuer(f.ordner, bekannt);
        const key = `${i}`;
        dateien.current.set(key, f.handle);
        const pfad = [...f.ordner, f.datei].join('/');
        const grund = !z ? 'kein Ordner mit Auftragsnummer im Pfad' : !typErlaubt(f.datei) ? 'Dateityp wird von Paperless nicht angenommen' : !z.bekannt ? `Auftrag ${z.nr} gibt es im Portal nicht` : '';
        return { key, pfad, ordner: f.ordner, datei: f.datei, groesse: f.groesse, datum: dateiDatum(f.geaendert), nr: z?.nr ?? null, bekannt: !!z?.bekannt, status: 'offen' as MigStatus, text: grund };
      }).sort((a, b) => (a.nr ?? '￿').localeCompare(b.nr ?? '￿') || a.pfad.localeCompare(b.pfad));
      setListe(l);
    } catch (e) { setError((e as Error).message); } finally { setSuchen(null); }
  }

  async function uebertragen(e: MigEintrag): Promise<boolean> {
    const h = dateien.current.get(e.key);
    if (!h || !e.nr) return false;
    setzen(e.key, 'laeuft');
    try {
      const inhalt = await lesen(await h.getFile());
      const r = await api.post<{ status: 'neu' | 'vorhanden' | 'laeuft'; id: number | null; text: string }>(`${T}/migration/datei`, {
        auftragsnr: e.nr, datei: e.datei, pfad: [wurzel, e.pfad].filter(Boolean).join('/'), datum: e.datum, inhalt,
      });
      setzen(e.key, r.status === 'laeuft' ? 'verarbeitung' : r.status, r.text);
      return true;
    } catch (x) { setzen(e.key, 'fehler', (x as Error).message); return false; }
  }

  const sichtbar = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return liste.filter((e) => (!f || (e.nr ?? '').toLowerCase().includes(f) || e.pfad.toLowerCase().includes(f))
      && (!nurOffen || ((e.status === 'offen' || e.status === 'verarbeitung' || e.status === 'fehler') && uebertragbar(e, mitUnbekannten))));
  }, [liste, filter, nurOffen, mitUnbekannten]);
  const offen = sichtbar.filter((e) => (e.status === 'offen' || e.status === 'verarbeitung' || e.status === 'fehler') && uebertragbar(e, mitUnbekannten));
  const z = zaehlen(liste, mitUnbekannten);

  async function alle() {
    setFrage(false); setLaeuft(true); halt.current = false;
    try {
      for (const e of offen) {
        if (halt.current) break;
        await uebertragen(e);
      }
    } finally { setLaeuft(false); }
  }

  const columns: AnalyticalTableColumnDefinition[] = useMemo(() => [
    { Header: 'Auftrag', accessor: 'nr', width: 150, Cell: ({ row }: Cell) => {
      const e = row.original as MigEintrag;
      if (!e.nr) return <Text className="portal-muted">–</Text>;
      return e.bekannt ? <Link onClick={() => navigate(`/transport/auftraege/${encodeURIComponent(e.nr!)}`)}>{e.nr}</Link> : <Text>{e.nr} (unbekannt)</Text>;
    } },
    { Header: 'Datei (Pfad im Ordner)', accessor: 'pfad', minWidth: 280, Cell: ({ row }: Cell) => <div title={row.original.pfad} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}><b>{row.original.datei}</b><br /><Text className="portal-muted">{row.original.ordner.join('/') || '(oberste Ebene)'}</Text></div> },
    { Header: 'Datum', accessor: 'datum', width: 110, Cell: ({ value }: Cell) => `${value.slice(8, 10)}.${value.slice(5, 7)}.${value.slice(0, 4)}` },
    { Header: 'Größe', accessor: 'groesse', width: 90, hAlign: 'End', Cell: ({ value }: Cell) => `${Math.max(1, Math.round(Number(value) / 1024)).toLocaleString('de-DE')} KB` },
    { Header: 'Status', accessor: 'status', minWidth: 260, Cell: ({ row }: Cell) => {
      const e = row.original as MigEintrag;
      const s = e.status === 'offen' && !uebertragbar(e, mitUnbekannten) ? { text: 'wird nicht übertragen', state: 'None' as const } : STATUS[e.status];
      return <div style={{ whiteSpace: 'normal' }}><ObjectStatus state={s.state}>{s.text}</ObjectStatus>{e.text && <div className="portal-muted portal-small">{e.text}</div>}</div>;
    } },
    { Header: '', id: 'aktion', width: 130, Cell: ({ row }: Cell) => {
      const e = row.original as MigEintrag;
      return uebertragbar(e, mitUnbekannten) && e.status !== 'neu' && e.status !== 'vorhanden'
        ? <Button design="Transparent" icon="upload-to-cloud" disabled={laeuft || e.status === 'laeuft'} onClick={() => { void uebertragen(e); }}>Übertragen</Button>
        : null;
    } },
  ], [mitUnbekannten, laeuft, navigate, wurzel]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!moeglich) return <MessageStrip design="Critical" hideCloseButton>Die Ordnerauswahl braucht Chrome oder Edge am PC.</MessageStrip>;
  return (
    <>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}
      {!paperless && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '1rem' }}>Paperless ist für Euroflex nicht eingerichtet (oben im Reiter: Adresse und API-Token).</MessageStrip>}
      <Section title="Lokale Auftragsordner nach Paperless übernehmen">
        <Text style={{ display: 'block', marginBottom: '0.75rem' }}>
          Ordner auf diesem PC wählen – z. B. den Ablageordner mit <code>Jahr/Auftragsnummer/…</code>. Alle Unterordner werden durchsucht.
          Jede Datei unter einem Ordner, der nach der Auftragsnummer benannt ist (auch in Unterordnern wie „Eingang“), geht einzeln
          nach Paperless: Custom Field <b>„Auftrag“</b> = Auftragsnummer, Dokumentdatum = Datum der Datei im Ordner, Korrespondent = Kunde,
          Tag „Migration“, Notiz mit dem bisherigen Pfad (anpassbar unten in den Ablageregeln, Kontext „Migration lokaler Auftragsordner“).
          Erst mit einer Datei testen, dann den Auftrag im Portal öffnen und prüfen. Wiederholen ist gefahrlos: Dateien, die schon in
          Paperless sind, werden nicht doppelt angelegt – es wird nur die Auftragsnummer ergänzt.
        </Text>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <Button icon="open-folder" design="Emphasized" disabled={laeuft || !!suchen} onClick={() => { void waehlen(); }}>{wurzel ? 'Anderen Ordner wählen …' : 'Ordner wählen …'}</Button>
          {wurzel && <Text>Gewählt: <b>{wurzel}</b></Text>}
          {suchen && <Text className="portal-muted">{suchen}</Text>}
        </div>
      </Section>

      {liste.length > 0 && (
        <Section title="Gefundene Dateien" count={`${z.dateien} Dateien · ${z.auftraege} Aufträge`} flush>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap', padding: '0.5rem 1rem' }}>
            <Input placeholder="Auftrag oder Pfad filtern (z. B. 2026_0153)" value={filter} showClearIcon onInput={(e) => setFilter(e.target.value)} style={{ width: '18rem' }} />
            <CheckBox text="nur offene" checked={nurOffen} onChange={(e) => setNurOffen(e.target.checked)} />
            <CheckBox text="auch Ordner, deren Auftrag es im Portal nicht gibt" checked={mitUnbekannten} onChange={(e) => setMitUnbekannten(e.target.checked)} />
            <Text className="portal-muted">
              {z.fertig} übertragen · {z.offen} offen{z.fehler ? ` · ${z.fehler} Fehler` : ''}{z.ohneAuftrag ? ` · ${z.ohneAuftrag} ohne Auftrag` : ''}{z.unbekannt ? ` · ${z.unbekannt} unbekannter Auftrag` : ''}{z.typ ? ` · ${z.typ} Dateityp nicht möglich` : ''}
            </Text>
          </div>
          <AnalyticalTable minRows={1} columns={columns} data={sichtbar} visibleRows={Math.min(Math.max(sichtbar.length, 1), 15)} rowHeight={56}
                           scaleWidthMode="Smart" noDataText="Keine Dateien für diesen Filter" />
        </Section>
      )}

      {liste.length > 0 && (
        <Bar endContent={<>
          {laeuft && <Button icon="stop" onClick={() => { halt.current = true; }}>Anhalten</Button>}
          <Button icon="lab" disabled={laeuft || !offen.length} onClick={() => { void uebertragen(offen[0]); }} tooltip={offen[0] ? `${offen[0].pfad} → Auftrag ${offen[0].nr}` : undefined}>
            Testlauf: 1 Datei
          </Button>
          <Button design="Emphasized" icon="upload-to-cloud" loading={laeuft} disabled={laeuft || !offen.length || !paperless} onClick={() => setFrage(true)}>
            {filter.trim() ? `Gefilterte übertragen (${offen.length})` : `Alle übertragen (${offen.length})`}
          </Button>
        </>} />
      )}

      <ConfirmDialog open={frage} title="Dateien nach Paperless übertragen?" confirmText="Übertragen"
                     text={`${offen.length} Datei(en) aus ${new Set(offen.map((e) => e.nr)).size} Auftrag/Aufträgen werden nacheinander nach Paperless übertragen. Die Seite dabei geöffnet lassen; „Anhalten“ stoppt nach der laufenden Datei.`}
                     onConfirm={() => { void alle(); }} onCancel={() => setFrage(false)} />
    </>
  );
}
