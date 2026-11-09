import { useEffect, useState } from 'react';
import {
  AnalyticalTable, Bar, Button, Icon, CheckBox, Dialog, Input, Label, MessageStrip, ObjectStatus, ProgressIndicator, RadioButton, Switch, Text, TextArea, TimePicker, Title,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api, ApiError } from '../api';
import { AppPage } from '../components/AppPage';
import { Section } from '../components/Section';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { download } from '../components/PdfDialog';
import { useCan } from '../session';
import { toast } from '../toast';
import { AblageDialog } from '../ablage';

/**
 * Sicherung und Rücksicherung aller Daten und Einstellungen (alle Anwendungen):
 * Sicherung erstellen (Bereiche, Änderungsbelege, optional verschlüsselt), Liste mit Download,
 * Hochladen, Prüfen und Rücksichern einzelner Bereiche mit automatischer Sicherheitskopie.
 * Formate: .portal (kompakt, optional verschlüsselt) oder ZIP mit XML-Dateien (lesbar, bearbeitbar, importierbar).
 */
interface SchemaInfo { schema: string; text: string; tabellen: number; zeilen: number }
interface Kurz { erstellt: string; von: string; notiz: string; art: string; schemas: string[]; verschluesselt: boolean; mitAenderungsbelegen: boolean; tabellen: number; zeilen: number }
interface Datei { name: string; groesse: number; geaendert: string; info: Kurz | null; verschluesselt: boolean; format: 'portal' | 'zip' }
interface Uebersicht {
  datenbank: number; schemas: SchemaInfo[]; pfad: string; dauerhaft: boolean; dateien: Datei[];
  nacht: { name: string; groesse: number; geaendert: string }[];
  letzteRuecksicherung: { zeitpunkt: string; datei: string; schemas: string[]; von: string; sicherheitskopie: string } | null;
  laufend: Job | null;
}
interface Job {
  id: string; art: 'sicherung' | 'nextcloud'; von: string; phase: string; text: string; detail: string; prozent: number;
  laufzeitSekunden: number; restSekunden: number | null; fertig: boolean; fehler: string | null; ergebnis: { name?: string; text?: string } | null;
}
interface Export {
  aktiv: boolean; url: string; benutzer: string; passwort: string; ordner: string; uhrzeit: string; format: 'portal' | 'zip'; datei_passwort: string;
  mit_aenderungsbelegen: boolean; aufbewahrung_tage: number; letzter_lauf: string | null; letzter_erfolg: string | null; letzte_meldung: string | null;
  letzte_datei: string | null; letzte_dauer_s: number | null; letzter_fehler: boolean; fehlt: string[];
}

/** Sekunden lesbar: „ca. 2 Min. 10 s“ */
function dauer(s: number | null): string {
  if (s === null) return 'wird geschätzt …';
  if (s < 60) return `ca. ${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `ca. ${m} Min.${s % 60 && m < 5 ? ` ${s % 60} s` : ''}` : `ca. ${Math.floor(m / 60)} Std. ${m % 60} Min.`;
}

/** Hintergrundauftrag abfragen, bis er fertig ist */
async function abwarten(id: string, onStand: (j: Job) => void): Promise<Job> {
  for (;;) {
    const j = await api.get<Job>(`/api/backup/job/${id}`);
    onStand(j);
    if (j.fertig) return j;
    await new Promise((ok) => setTimeout(ok, 1000));
  }
}

function Fortschritt({ j }: { j: Job }) {
  return (
    <div className="portal-bk__fortschritt">
      <ProgressIndicator value={j.prozent} displayValue={`${j.prozent} %`} valueState={j.fehler ? 'Negative' : j.fertig ? 'Positive' : 'None'} style={{ width: '100%' }} />
      <div className="portal-bk__fortschritt-text">
        <span><strong>{j.text}</strong>{j.detail ? ` – ${j.detail}` : ''}</span>
        <span>{j.fertig ? `${j.laufzeitSekunden} s` : `läuft seit ${j.laufzeitSekunden} s · noch ${dauer(j.restSekunden)}`}</span>
      </div>
    </div>
  );
}
interface Pruefung {
  manifest: { erstellt: string; von: string; notiz: string; schemas: string[]; mitAenderungsbelegen: boolean };
  schemas: { schema: string; text: string; status: 'gleich' | 'aelter' | 'neuer' | 'inaktiv'; tabellen: number; zeilen: number; hinweise: string[] }[];
}

const mb = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`);
const zeit = (iso: string) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
const ART: Record<string, string> = { manuell: 'manuell', automatisch: 'automatisch', 'vor-ruecksicherung': 'vor Rücksicherung' };
const STATUS: Record<string, { text: string; state: 'Positive' | 'Critical' | 'Negative' | 'None' }> = {
  gleich: { text: 'gleicher Stand', state: 'Positive' }, aelter: { text: 'älterer Stand', state: 'Critical' },
  neuer: { text: 'neuerer Stand – nicht möglich', state: 'Negative' }, inaktiv: { text: 'nicht aktiv', state: 'None' },
};

export function BackupPage() {
  const can = useCan();
  const zurueck = can('core.backup:restore');
  const [d, setD] = useState<Uebersicht | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [auswahl, setAuswahl] = useState<string[] | null>(null);
  const [audit, setAudit] = useState(true);
  const [notiz, setNotiz] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [weg, setWeg] = useState<string | null>(null);
  const [rs, setRs] = useState<Datei | null>(null);
  const [format, setFormat] = useState<'portal' | 'zip'>('portal');
  const [xml, setXml] = useState<Datei | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [ablage, setAblage] = useState(false);

  const laden = () => api.get<Uebersicht>('/api/backup').then((r) => { setD(r); setAuswahl((a) => a ?? r.schemas.map((s) => s.schema)); return r; }).catch((e) => { setError(e.message); return null; });
  useEffect(() => {
    // läuft schon eine Sicherung (z. B. nach Neuladen der Seite), deren Fortschritt anzeigen
    laden().then((r) => { if (r?.laufend && r.laufend.art === 'sicherung') abwarten(r.laufend.id, setJob).then(() => laden()).catch(() => undefined); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function erstellen() {
    setBusy(true); setError(null);
    try {
      const start = await api.post<Job>('/api/backup/start', { schemas: auswahl, mitAenderungsbelegen: audit, notiz, format, passwort: format === 'zip' ? null : pw || null });
      setJob(start);
      const j = await abwarten(start.id, setJob);
      if (j.fehler) throw new Error(j.fehler);
      const r = j.ergebnis as { name: string; text: string };
      toast(r.text, 6000);
      setNotiz(''); setPw(''); setPw2('');
      await laden();
      await download(`/api/backup/datei/${encodeURIComponent(r.name)}`, r.name);
      setJob(null);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function hochladen(f: File) {
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/backup/hochladen', {
        method: 'POST', credentials: 'same-origin', body: f,
        headers: { 'content-type': 'application/octet-stream', 'x-portal-request': '1', 'x-dateiname': f.name.replace(/[^\w.-]/g, '_') },
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.message ?? `Fehler ${res.status}`);
      toast(j.text);
      await laden();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  /** vorhandene Sicherung als ZIP mit XML herunterladen (POST, verschlüsselt mit Passwort) */
  async function alsXml(f: Datei, passwort: string | null) {
    const res = await fetch(`/api/backup/datei/${encodeURIComponent(f.name)}/xml`, {
      method: 'POST', credentials: 'same-origin', body: JSON.stringify({ passwort }),
      headers: { 'content-type': 'application/json', 'x-portal-request': '1' },
    });
    if (!res.ok) { const t = await res.text(); throw new Error(JSON.parse(t || '{}').message ?? `Fehler ${res.status}`); }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob());
    a.download = f.name.replace(/\.(portal|zip)$/, '.zip');
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  const pwFehler = format === 'portal' && pw && pw.length < 8 ? 'mindestens 8 Zeichen' : pw && pw !== pw2 ? 'Wiederholung stimmt nicht überein' : null;

  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Erstellt', id: 'erstellt', width: 160, Cell: ({ row }: Cell) => zeit(row.original.info?.erstellt ?? row.original.geaendert) },
    {
      Header: 'Inhalt', id: 'inhalt', minWidth: 260,
      Cell: ({ row }: Cell) => {
        const i = row.original.info as Kurz | null;
        if (!i) return <Text className="portal-muted">{row.original.verschluesselt ? 'verschlüsselt – Inhalt nach Passworteingabe' : '–'}</Text>;
        const namen = i.schemas.map((s) => d?.schemas.find((x) => x.schema === s)?.text.split(' (')[0] ?? s).join(', ');
        return <div style={{ lineHeight: 1.3 }}><Text>{namen}</Text><br /><Label>{i.tabellen} Tabellen · {i.zeilen.toLocaleString('de-DE')} Datensätze{i.notiz ? ` · ${i.notiz}` : ''}</Label></div>;
      },
    },
    { Header: 'Art', id: 'art', width: 150, Cell: ({ row }: Cell) => <ObjectStatus state={row.original.info?.art === 'vor-ruecksicherung' ? 'Information' : 'None'}>{ART[row.original.info?.art ?? ''] ?? 'hochgeladen'}</ObjectStatus> },
    { Header: 'Von', id: 'von', width: 140, Cell: ({ row }: Cell) => row.original.info?.von ?? '–' },
    { Header: 'Größe', accessor: 'groesse', width: 90, hAlign: 'End', Cell: ({ value }: Cell) => mb(value) },
    { Header: 'Format', id: 'format', width: 90, Cell: ({ row }: Cell) => (row.original.format === 'zip' ? <ObjectStatus state="Information">ZIP/XML</ObjectStatus> : <Text>.portal</Text>) },
    { Header: '', id: 'schutz', width: 50, Cell: ({ row }: Cell) => (row.original.verschluesselt ? <ObjectStatus state="Positive" icon={<Icon name="locked" />} /> : null) },
    {
      Header: '', id: 'aktion', width: 270,
      Cell: ({ row }: Cell) => (
        <div className="portal-row" style={{ flexWrap: 'nowrap' }}>
          <Button design="Transparent" icon="download" tooltip="Herunterladen" onClick={() => download(`/api/backup/datei/${encodeURIComponent(row.original.name)}`, row.original.name).catch((e) => setError(e.message))} />
          {row.original.format === 'portal' && (
            <Button design="Transparent" icon="document-text" tooltip="Als XML (ZIP) herunterladen"
                    onClick={() => (row.original.verschluesselt ? setXml(row.original) : alsXml(row.original, null).catch((e) => setError(e.message)))} />
          )}
          {zurueck && <Button design="Transparent" icon="undo" onClick={() => setRs(row.original)}>Zurücksichern</Button>}
          <Button design="Transparent" icon="delete" tooltip="Löschen" onClick={() => setWeg(row.original.name)} />
        </div>
      ),
    },
  ];

  return (
    <AppPage title="Sicherung" subtitle="Daten und Einstellungen aller Anwendungen sichern und zurücksichern"
             actions={zurueck ? <>
               <Button icon="upload" disabled={busy} onClick={() => setAblage(true)}>Sicherung hochladen</Button>
             </> : undefined}>
      <AblageDialog open={ablage} titel="Sicherung hochladen" onClose={() => setAblage(false)} accept=".portal,.zip" multiple={false}
                    feldTitel="Sicherungsdatei hier ablegen" text=".portal- oder ZIP-Datei hierher ziehen oder klicken zum Auswählen – sie wird geprüft und erscheint in der Liste."
                    ziel={{ titel: 'Sicherung', annehmen: (f) => { hochladen(f[0]); } }} />
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      {d && !d.dauerhaft && (
        <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>
          Der Sicherungsordner {d.pfad} ist nicht als Volume bzw. Host-Ordner eingebunden – Sicherungen gehen beim nächsten Update oder Neustart
          des Containers verloren. Bitte jede Sicherung herunterladen und im Stack das Volume <code>portal_sicherungen:/app/data/sicherungen</code> eintragen.
        </MessageStrip>
      )}
      {d?.letzteRuecksicherung && (
        <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.5rem' }}>
          Letzte Rücksicherung: {zeit(d.letzteRuecksicherung.zeitpunkt)} durch {d.letzteRuecksicherung.von} aus {d.letzteRuecksicherung.datei}
          {' '}({d.letzteRuecksicherung.schemas.join(', ')}). Sicherheitskopie davor: {d.letzteRuecksicherung.sicherheitskopie}.
        </MessageStrip>
      )}

      <Section title="Sicherung erstellen" status={d ? <Text className="portal-muted">Datenbank {mb(d.datenbank)}</Text> : undefined}>
        <div className="portal-bk">
          <div>
            <Label showColon>Bereiche</Label>
            {d?.schemas.map((s) => (
              <div key={s.schema} className="portal-bk__bereich">
                <CheckBox text={s.text} checked={auswahl?.includes(s.schema) ?? true}
                          onChange={(e) => setAuswahl((a) => (e.target.checked ? [...new Set([...(a ?? []), s.schema])] : (a ?? []).filter((x) => x !== s.schema)))} />
                <span className="portal-muted portal-small">{s.tabellen} Tabellen · ca. {s.zeilen.toLocaleString('de-DE')} Datensätze</span>
              </div>
            ))}
            <CheckBox text="Änderungsbelege mitsichern" checked={audit} onChange={(e) => setAudit(e.target.checked)} />
          </div>
          <div className="portal-bk__form">
            <Label showColon>Notiz (optional)</Label>
            <TextArea rows={2} value={notiz} maxlength={300} placeholder="z. B. vor Jahresabschluss 2026" onInput={(e) => setNotiz(e.target.value)} />
            <Label showColon>Format</Label>
            <div className="portal-row">
              <RadioButton name="bk-format" text=".portal (kompakt, optional verschlüsselt)" checked={format === 'portal'} onChange={() => setFormat('portal')} />
              <RadioButton name="bk-format" text="ZIP mit XML (lesbar, unverschlüsselt)" checked={format === 'zip'} onChange={() => setFormat('zip')} />
            </div>
            {format === 'zip' && (
              <Text className="portal-muted portal-small">
                Je Tabelle eine XML-Datei (daten/&lt;bereich&gt;/&lt;tabelle&gt;.xml) plus manifest.xml. Die Datei lässt sich mit jedem ZIP-Programm öffnen, prüfen
                und – mit unveränderten Spalten – bearbeitet wieder hochladen und zurücksichern.
              </Text>
            )}
            {format === 'portal' && <>
            <Label showColon>Passwort (optional, verschlüsselt die Datei)</Label>
            <Input type="Password" data-kein-autofill value={pw} placeholder="leer = unverschlüsselt" onInput={(e) => setPw(e.target.value)} valueState={pwFehler && pw.length < 8 ? 'Negative' : 'None'} />
            {pw && <Input type="Password" data-kein-autofill value={pw2} placeholder="Passwort wiederholen" onInput={(e) => setPw2(e.target.value)} valueState={pw !== pw2 ? 'Negative' : 'None'} />}
            </>}
            {pwFehler && <Text style={{ color: 'var(--sapNegativeTextColor)' }} className="portal-small">Passwort: {pwFehler}</Text>}
            <Text className="portal-muted portal-small">
              Die Sicherung enthält alle Daten der gewählten Bereiche – auch Kennwort-Hashes, Bank- und Personendaten. Verschlüsselte Sicherungen lassen
              sich ohne Passwort nicht wiederherstellen. Dokumente selbst liegen in Paperless und werden dort gesichert.
            </Text>
            <div><Button design="Emphasized" icon="save" disabled={busy || !auswahl?.length || !!pwFehler} onClick={erstellen}>Sicherung erstellen und herunterladen</Button></div>
            {job && job.art === 'sicherung' && <Fortschritt j={job} />}
          </div>
        </div>
      </Section>

      <Section title="Sicherungen im Portal" count={d?.dateien.length ?? 0} flush
               status={d ? <Text className="portal-muted portal-small">Ablage: {d.pfad}{d.dauerhaft ? '' : ' (nicht dauerhaft!)'}</Text> : undefined}>
        <AnalyticalTable columns={columns} data={d?.dateien ?? []} loading={!d} visibleRows={Math.min(Math.max(d?.dateien.length ?? 0, 1), 12)} minRows={1}
                         noDataText="Noch keine Sicherung – oben erstellen oder eine Datei hochladen" />
      </Section>

      <NextcloudExport onError={setError} />

      <Section title="Nächtliche Datenbanksicherungen" count={d?.nacht.length ?? 0}>
        {d?.nacht.length ? (
          <>
            <div className="portal-bk__nacht">
              {d.nacht.slice(0, 14).map((n) => (
                <div key={n.name} className="portal-row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
                  <Text>{zeit(n.geaendert)}</Text><Text className="portal-muted">{n.name} · {mb(n.groesse)}</Text>
                  <Button design="Transparent" icon="download" onClick={() => download(`/api/backup/nacht/${encodeURIComponent(n.name)}`, n.name).catch((e) => setError(e.message))} />
                </div>
              ))}
            </div>
            <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>
              Vollständige Datenbankabzüge (pg_dump) des Backup-Dienstes. Zurückspielen auf dem Server: ./restore.sh data/backups/&lt;datei&gt;.dump
            </Text>
          </>
        ) : <Text className="portal-muted">Keine nächtlichen Sicherungen sichtbar (Ordner nicht eingebunden oder noch keine Sicherung gelaufen).</Text>}
      </Section>

      <ConfirmDialog open={!!weg} danger title="Sicherung löschen" confirmText="Löschen" text={`Sicherung ${weg ?? ''} endgültig löschen?`}
                     onCancel={() => setWeg(null)}
                     onConfirm={async () => { const n = weg!; setWeg(null); try { const r = await api.del<{ text: string }>(`/api/backup/datei/${encodeURIComponent(n)}`); toast(r.text); laden(); } catch (e) { setError((e as Error).message); } }} />
      {xml && <XmlDialog datei={xml} onClose={() => setXml(null)} laden={alsXml} />}
      {rs && <RuecksicherungDialog datei={rs} onClose={() => setRs(null)} onDone={laden} />}
    </AppPage>
  );
}

function RuecksicherungDialog({ datei, onClose, onDone }: { datei: Datei; onClose: () => void; onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [p, setP] = useState<Pruefung | null>(null);
  const [wahl, setWahl] = useState<string[]>([]);
  const [best, setBest] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ergebnis, setErgebnis] = useState<{ text: string; hinweise: string[]; abgemeldet: boolean } | null>(null);

  async function pruefen() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<Pruefung>(`/api/backup/datei/${encodeURIComponent(datei.name)}/pruefen`, { passwort: pw || null });
      setP(r);
      setWahl(r.schemas.filter((s) => s.status === 'gleich' || s.status === 'aelter').map((s) => s.schema));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  useEffect(() => { if (!datei.verschluesselt) pruefen(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function ausfuehren() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string; hinweise: string[]; abgemeldet: boolean }>(`/api/backup/datei/${encodeURIComponent(datei.name)}/ruecksichern`,
        { schemas: wahl, passwort: pw || null, bestaetigung: best });
      setErgebnis(r);
      if (!r.abgemeldet) onDone();
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? 'Sitzung beendet – bitte neu anmelden.' : (e as Error).message);
    } finally { setBusy(false); }
  }

  const fertig = !!ergebnis;
  return (
    <Dialog open headerText={`Zurücksichern – ${datei.name}`} style={{ width: 'min(48rem, 96vw)' }} onClose={fertig && ergebnis.abgemeldet ? () => window.location.reload() : onClose}
            footer={<Bar endContent={fertig
              ? <Button design="Emphasized" onClick={() => (ergebnis.abgemeldet ? window.location.reload() : onClose())}>{ergebnis.abgemeldet ? 'Neu anmelden' : 'Schließen'}</Button>
              : <>
                  <Button design="Negative" icon="undo" disabled={busy || !p || !wahl.length || best.trim().toUpperCase() !== 'WIEDERHERSTELLEN'} onClick={ausfuehren}>Jetzt zurücksichern</Button>
                  <Button onClick={onClose}>Abbrechen</Button>
                </>} />}>
      <div className="portal-bk__form">
        {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
        {ergebnis && (
          <>
            <MessageStrip design="Positive" hideCloseButton>{ergebnis.text}</MessageStrip>
            {ergebnis.hinweise.map((h) => <MessageStrip key={h} design="Information" hideCloseButton>{h}</MessageStrip>)}
            {ergebnis.abgemeldet && <MessageStrip design="Critical" hideCloseButton>Benutzer und Sitzungen wurden ersetzt – bitte mit den Zugangsdaten aus der Sicherung neu anmelden.</MessageStrip>}
          </>
        )}
        {!fertig && datei.verschluesselt && !p && (
          <>
            <Label showColon>Passwort der Sicherung</Label>
            <div className="portal-row" style={{ flexWrap: 'nowrap' }}>
              <Input type="Password" data-kein-autofill value={pw} style={{ flex: 1 }} onInput={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && pw && pruefen()} />
              <Button disabled={!pw || busy} onClick={pruefen}>Öffnen</Button>
            </div>
          </>
        )}
        {!fertig && !p && !datei.verschluesselt && !error && <Text>Sicherung wird geprüft …</Text>}
        {!fertig && p && (
          <>
            <Text>Sicherung vom <b>{zeit(p.manifest.erstellt)}</b> durch {p.manifest.von}{p.manifest.notiz ? ` – „${p.manifest.notiz}“` : ''}.</Text>
            <Title level="H6">Bereiche zurücksichern</Title>
            {p.schemas.map((s) => (
              <div key={s.schema} className="portal-bk__pruef">
                <CheckBox text={s.text} disabled={s.status === 'neuer' || s.status === 'inaktiv'} checked={wahl.includes(s.schema)}
                          onChange={(e) => setWahl(e.target.checked ? [...wahl, s.schema] : wahl.filter((x) => x !== s.schema))} />
                <div className="portal-row">
                  <ObjectStatus state={STATUS[s.status].state} inverted={s.status !== 'gleich'}>{STATUS[s.status].text}</ObjectStatus>
                  <span className="portal-muted portal-small">{s.tabellen} Tabellen · {s.zeilen.toLocaleString('de-DE')} Datensätze</span>
                </div>
                {s.hinweise.map((h) => <Text key={h} className="portal-small" style={{ display: 'block', color: s.status === 'neuer' ? 'var(--sapNegativeTextColor)' : 'var(--sapContent_LabelColor)' }}>{h}</Text>)}
              </div>
            ))}
            <MessageStrip design="Critical" hideCloseButton>
              Die aktuellen Daten der gewählten Bereiche werden vollständig durch den Stand der Sicherung ersetzt. Vorher legt das Portal automatisch eine
              Sicherheitskopie des aktuellen Stands aller Bereiche an. Zusammengehörige Bereiche am besten gemeinsam zurücksichern.
            </MessageStrip>
            <Label showColon required>Zur Bestätigung WIEDERHERSTELLEN eingeben</Label>
            <Input value={best} onInput={(e) => setBest(e.target.value)} placeholder="WIEDERHERSTELLEN" />
          </>
        )}
      </div>
    </Dialog>
  );
}

/** verschlüsselte Sicherung entschlüsseln und als ZIP mit XML herunterladen */
function XmlDialog({ datei, onClose, laden }: { datei: Datei; onClose: () => void; laden: (f: Datei, pw: string | null) => Promise<void> }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function los() {
    setBusy(true); setError(null);
    try { await laden(datei, pw); onClose(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open headerText={`Als XML (ZIP) – ${datei.name}`} style={{ width: 'min(30rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={<>
              <Button design="Emphasized" icon="download" disabled={!pw || busy} onClick={los}>Herunterladen</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      <div className="portal-bk__form">
        {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
        <Label showColon>Passwort der Sicherung</Label>
        <Input type="Password" data-kein-autofill value={pw} onInput={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && pw && los()} />
        <MessageStrip design="Critical" hideCloseButton>Die ZIP-Datei ist unverschlüsselt und enthält alle Daten der Sicherung im Klartext.</MessageStrip>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- täglicher Export in die Nextcloud
function NextcloudExport({ onError }: { onError: (t: string | null) => void }) {
  const [c, setC] = useState<Export | null>(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const laden = () => api.get<Export>('/api/backup/nextcloud').then(setC).catch((e) => onError(e.message));
  useEffect(() => { laden(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!c) return null;
  const set = (x: Partial<Export>) => setC({ ...c, ...x });
  const daten = () => ({
    aktiv: c.aktiv, url: c.url, benutzer: c.benutzer, passwort: c.passwort, ordner: c.ordner, uhrzeit: c.uhrzeit, format: c.format,
    datei_passwort: c.format === 'zip' ? '' : c.datei_passwort, mit_aenderungsbelegen: c.mit_aenderungsbelegen, aufbewahrung_tage: c.aufbewahrung_tage,
  });
  async function lauf(fn: () => Promise<void>) {
    setBusy(true); onError(null);
    try { await fn(); } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  }
  const status = c.letzter_lauf
    ? <ObjectStatus state={c.letzter_fehler ? 'Negative' : 'Positive'} showDefaultIcon>{c.letzter_fehler ? 'Fehler' : 'OK'} · {zeit(c.letzter_lauf)}</ObjectStatus>
    : <ObjectStatus state="None">noch nicht gelaufen</ObjectStatus>;
  return (
    <Section title="Täglicher Export in die Nextcloud" status={status}
             actions={<>
               <Button icon="connected" disabled={busy} onClick={() => lauf(async () => { toast((await api.post<{ text: string }>('/api/backup/nextcloud/testen', daten())).text, 6000); })}>Verbindung testen</Button>
               <Button icon="save" design="Emphasized" disabled={busy} onClick={() => lauf(async () => { const r = await api.put<Export & { text: string }>('/api/backup/nextcloud', daten()); setC(r); toast(r.text, 5000); })}>Speichern</Button>
             </>}>
      <div className="portal-bk">
        <div className="portal-bk__form">
          <Switch checked={c.aktiv} textOn="An" textOff="Aus" onChange={(e) => set({ aktiv: e.target.checked })} />
          <Text className="portal-muted portal-small">
            Erstellt jeden Tag ab der eingestellten Uhrzeit eine vollständige Sicherung (alle Bereiche) und lädt sie per WebDAV in den Zielordner.
            Ältere automatische Sicherungen im Ordner werden nach der Aufbewahrungsdauer gelöscht, andere Dateien bleiben unberührt.
          </Text>
          <Label showColon required>Nextcloud-Adresse</Label>
          <Input value={c.url} placeholder="https://cloud.beispiel.de" onInput={(e) => set({ url: e.target.value })} />
          <Label showColon required>Benutzer</Label>
          <Input value={c.benutzer} onInput={(e) => set({ benutzer: e.target.value })} />
          <Label showColon required>App-Passwort</Label>
          <Input type="Password" data-kein-autofill value={c.passwort} placeholder="Nextcloud → Einstellungen → Sicherheit → App-Passwort" onInput={(e) => set({ passwort: e.target.value })} />
          <Label showColon required>Zielordner</Label>
          <Input value={c.ordner} placeholder="/Vorstand/Portal-Sicherungen" onInput={(e) => set({ ordner: e.target.value })} />
        </div>
        <div className="portal-bk__form">
          <Label showColon>Uhrzeit</Label>
          <TimePicker formatPattern="HH:mm" value={c.uhrzeit} onChange={(e) => e.detail.value && set({ uhrzeit: e.detail.value })} style={{ width: '8rem' }} />
          <Label showColon>Format</Label>
          <div className="portal-row">
            <RadioButton name="nc-format" text=".portal (empfohlen)" checked={c.format === 'portal'} onChange={() => set({ format: 'portal' })} />
            <RadioButton name="nc-format" text="ZIP mit XML (unverschlüsselt)" checked={c.format === 'zip'} onChange={() => set({ format: 'zip' })} />
          </div>
          {c.format === 'portal' ? <>
            <Label showColon>Datei-Passwort (verschlüsselt die Sicherung)</Label>
            <Input type="Password" data-kein-autofill value={c.datei_passwort} placeholder="mindestens 8 Zeichen – dringend empfohlen" onInput={(e) => set({ datei_passwort: e.target.value })}
                   valueState={c.datei_passwort && c.datei_passwort.length < 8 ? 'Negative' : !c.datei_passwort ? 'Critical' : 'None'} />
          </> : <Text style={{ color: 'var(--sapCriticalTextColor)' }} className="portal-small">ZIP/XML ist unverschlüsselt – der Zielordner darf nur dem Vorstand zugänglich sein.</Text>}
          <CheckBox text="Änderungsbelege mitsichern" checked={c.mit_aenderungsbelegen} onChange={(e) => set({ mit_aenderungsbelegen: e.target.checked })} />
          <Label showColon>Aufbewahrung (Tage, 0 = nie löschen)</Label>
          <Input type="Number" value={String(c.aufbewahrung_tage)} onInput={(e) => set({ aufbewahrung_tage: Number(e.target.value) || 0 })} style={{ width: '8rem' }} />
        </div>
      </div>
      {c.letzte_meldung && (
        <MessageStrip design={c.letzter_fehler ? 'Negative' : 'Positive'} hideCloseButton style={{ marginTop: '0.75rem' }}>
          Letzter Lauf{c.letzter_lauf ? ` ${zeit(c.letzter_lauf)}` : ''}: {c.letzte_meldung}
          {c.letzter_erfolg && c.letzter_fehler ? ` – letzter erfolgreicher Export ${zeit(c.letzter_erfolg)}.` : ''}
        </MessageStrip>
      )}
      <div className="portal-row" style={{ marginTop: '0.75rem' }}>
        <Button icon="cloud" disabled={busy || !!c.fehlt.length}
                tooltip={c.fehlt.length ? `Zuerst speichern bzw. ergänzen: ${c.fehlt.join(', ')}` : undefined}
                onClick={() => lauf(async () => {
                  const start = await api.post<Job>('/api/backup/nextcloud/jetzt', {});
                  setJob(start);
                  const j = await abwarten(start.id, setJob);
                  await laden();
                  if (j.fehler) throw new Error(j.fehler);
                  toast(String(j.ergebnis?.text ?? 'Export fertig.'), 6000);
                })}>Jetzt exportieren</Button>
        {c.fehlt.length > 0 && <Text className="portal-muted portal-small">Noch einzurichten: {c.fehlt.join(', ')}</Text>}
      </div>
      {job && <Fortschritt j={job} />}
    </Section>
  );
}
