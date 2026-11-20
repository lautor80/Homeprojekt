import { useState } from 'react';
import { Button, MessageStrip, ObjectStatus, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AblageFlaeche } from '@core/ablage';
import { ImportDialog, type ImportSchritt } from '@core/components/ImportDialog';
import { toast } from '@core/toast';
import type { ImportAntwort } from '../server/typen';
import { dat, W, zahl } from './util';

interface Datei { name: string; csv: string; geaendert: string; groesse: number }

/** Datei als Data-URL lesen – die Zeichenkodierung erkennt der Server */
function lesen(f: File): Promise<Datei> {
  return new Promise((ok, err) => {
    const r = new FileReader();
    r.onload = () => ok({ name: f.name, csv: String(r.result), geaendert: new Date(f.lastModified || Date.now()).toISOString(), groesse: f.size });
    r.onerror = () => err(r.error);
    r.readAsDataURL(f);
  });
}

/** Import der Tempo-Teamreports (CSV): 1 Quelle → 2 Prüfen → 3 Übernehmen → 4 Protokoll */
export function WcaImport({ onClose, onUebernommen }: { onClose: () => void; onUebernommen: () => void }) {
  const [schritt, setSchritt] = useState<ImportSchritt>(1);
  const [dateien, setDateien] = useState<Datei[]>([]);
  const [antwort, setAntwort] = useState<ImportAntwort | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function hinzufuegen(files: File[]) {
    try {
      const neu = await Promise.all(files.map(lesen));
      setDateien((alt) => [...alt.filter((d) => !neu.some((n) => n.name === d.name)), ...neu]);
    } catch (e) { setError((e as Error).message); }
  }

  async function senden(uebernehmen: boolean) {
    setBusy(true); setError(null);
    if (uebernehmen) setSchritt(3);
    try {
      const r = await api.post<ImportAntwort>(`${W}/import`, { dateien: dateien.map(({ name, csv, geaendert }) => ({ name, csv, geaendert })), uebernehmen });
      setAntwort(r);
      setSchritt(uebernehmen ? 4 : 2);
      if (uebernehmen) {
        const ok = r.dateien.filter((d) => !d.fehler).length;
        toast(`${ok} ${ok === 1 ? 'Datei' : 'Dateien'} übernommen`);
        onUebernommen();
      }
    } catch (e) { setError((e as Error).message); setSchritt(uebernehmen ? 2 : 1); } finally { setBusy(false); }
  }

  const lesbar = antwort?.dateien.filter((d) => !d.fehler).length ?? 0;
  const fehlerhaft = (antwort?.dateien.length ?? 0) - lesbar;

  return (
    <ImportDialog open was="Tempo-Zeitexporte (CSV)" schritt={schritt} breit onClose={onClose}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {schritt === 1 && (
        <div className="portal-stack">
          <Text>
            Teamreport aus Tempo als CSV exportieren (Zeilen: Benutzer, Kategorietyp, Account, Team, Bereich, Schlüssel, Zeitnachweis; Spalten: Tage)
            und hier ablegen – mehrere Dateien auf einmal sind möglich. Überschneiden sich Dateien, gilt je Person und Tag die zuletzt importierte.
          </Text>
          <AblageFlaeche ziel={{ titel: 'Tempo-Zeitexport', annehmen: (fs) => { hinzufuegen(fs); } }} accept=".csv,.txt,text/csv,text/plain" groesse="Dialog"
                         titel="Tempo-Exporte hier ablegen" text="CSV-Dateien hierher ziehen oder klicken zum Auswählen" />
          {dateien.length > 0 && (
            <div className="portal-tabrahmen">
              <table className="portal-wca-tabelle">
                <thead><tr><th>Datei</th><th className="portal-wca-rechts">Größe</th><th>Geändert</th><th /></tr></thead>
                <tbody>
                  {dateien.map((d) => (
                    <tr key={d.name}>
                      <td>{d.name}</td>
                      <td className="portal-wca-rechts portal-nowrap">{zahl(d.groesse / 1024)} KB</td>
                      <td className="portal-nowrap">{dat(d.geaendert)}</td>
                      <td><Button design="Transparent" icon="delete" tooltip="Entfernen" onClick={() => setDateien(dateien.filter((x) => x !== d))} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="portal-row">
            <Button design="Emphasized" icon="inspection" disabled={!dateien.length} loading={busy} onClick={() => senden(false)}>Prüfen</Button>
          </div>
        </div>
      )}
      {schritt >= 2 && antwort && (
        <div className="portal-stack">
          {schritt === 4 ? (
            <MessageStrip design="Positive" hideCloseButton>
              {lesbar} {lesbar === 1 ? 'Datei' : 'Dateien'} übernommen{fehlerhaft ? `, ${fehlerhaft} wegen Fehlern ausgelassen` : ''}.
            </MessageStrip>
          ) : schritt === 2 ? (
            <MessageStrip design={fehlerhaft ? 'Critical' : 'Information'} hideCloseButton>
              {lesbar} von {antwort.dateien.length} Dateien können übernommen werden{fehlerhaft ? `; ${fehlerhaft} nicht lesbare werden ausgelassen` : ''}.
              „Ersetzt“ sind Buchungstage (Person × Tag), die eine ältere Datei ersetzt.
            </MessageStrip>
          ) : null}
          <ProtokollTabelle antwort={antwort} />
          {schritt === 2 && (
            <div className="portal-row">
              <Button design="Emphasized" icon="accept" disabled={!lesbar} loading={busy} onClick={() => senden(true)}>{lesbar} {lesbar === 1 ? 'Datei' : 'Dateien'} übernehmen</Button>
              <Button disabled={busy} onClick={() => { setSchritt(1); setAntwort(null); }}>Zurück</Button>
            </div>
          )}
          {schritt === 4 && <div className="portal-row"><Button design="Emphasized" onClick={onClose}>Fertig</Button></div>}
        </div>
      )}
    </ImportDialog>
  );
}

function ProtokollTabelle({ antwort }: { antwort: ImportAntwort }) {
  return (
    <div className="portal-tabrahmen">
      <table className="portal-wca-tabelle">
        <thead>
          <tr>
            <th>Datei</th><th>Zeitraum</th><th className="portal-wca-rechts">Personen</th><th className="portal-wca-rechts">Einträge</th>
            <th className="portal-wca-rechts">Stunden</th><th className="portal-wca-rechts">Ersetzt</th><th>Prüfung</th>
          </tr>
        </thead>
        <tbody>
          {antwort.dateien.map((d, i) => (
            <tr key={i}>
              <td>{d.datei}</td>
              <td className="portal-nowrap">{d.von ? `${dat(d.von)} – ${dat(d.bis)}` : ''}</td>
              <td className="portal-wca-rechts">{d.personen}</td>
              <td className="portal-wca-rechts">{d.eintraege}</td>
              <td className="portal-wca-rechts portal-nowrap">{zahl(d.stunden)}</td>
              <td className="portal-wca-rechts">{d.ersetzt || ''}</td>
              <td className="portal-wca-breit">
                {d.fehler ? <ObjectStatus state="Negative" showDefaultIcon>{d.fehler}</ObjectStatus>
                  : d.warnungen.length ? d.warnungen.map((w, j) => <div key={j}><ObjectStatus state="Critical" showDefaultIcon>{w}</ObjectStatus></div>)
                    : <ObjectStatus state="Positive" showDefaultIcon>in Ordnung</ObjectStatus>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
