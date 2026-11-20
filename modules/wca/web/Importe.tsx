import { useState } from 'react';
import { Button, MessageStrip } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { ImportKnopf } from '@core/components/ImportDialog';
import { Section } from '@core/components/Section';
import { useLoad } from '@core/components/useLoad';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import type { ImportZeile } from '../server/typen';
import { dat, type Spalte, summe, Tabelle, W, zahl } from './util';
import { WcaImport } from './WcaImport';

const zeit = (iso: string) => `${dat(iso)} ${new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;

/** Liste der importierten Tempo-Exporte; Löschen entfernt den Import samt seinen Einträgen */
export function Importe() {
  const can = useCan();
  const edit = can('wca.import:edit');
  const d = useLoad(() => api.get<ImportZeile[]>(`${W}/importe`), []);
  const [loeschen, setLoeschen] = useState<ImportZeile | null>(null);
  const [imp, setImp] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function bestaetigt(reason: string) {
    const z = loeschen!;
    setLoeschen(null);
    try {
      await api.del(`${W}/importe/${z.id}`, { reason });
      toast(`Import „${z.datei}“ gelöscht`);
      d.reload();
    } catch (e) { setError((e as Error).message); }
  }

  const spalten: Spalte<ImportZeile>[] = [
    { titel: 'Datei', wert: (z) => z.datei, sort: (z) => z.datei, summe: () => 'Summe' },
    { titel: 'Zeitraum', fest: true, wert: (z) => (z.von ? `${dat(z.von)} – ${dat(z.bis)}` : ''), sort: (z) => z.von ?? '' },
    { titel: 'Personen', rechts: true, wert: (z) => z.personen, sort: (z) => z.personen },
    { titel: 'Einträge', rechts: true, wert: (z) => z.eintraege, sort: (z) => z.eintraege, summe: summe((z) => z.eintraege) },
    { titel: 'Stunden', rechts: true, wert: (z) => zahl(z.stunden), sort: (z) => z.stunden, summe: summe((z) => z.stunden) },
    { titel: 'Importiert am', fest: true, wert: (z) => zeit(z.importiertAm), sort: (z) => z.importiertAm },
    { titel: 'Von', wert: (z) => z.importiertVon ?? '' },
    ...(edit ? [{ titel: ' ', wert: (z: ImportZeile) => <Button design="Transparent" icon="delete" tooltip="Import löschen" onClick={() => setLoeschen(z)} /> }] : []),
  ];

  return (
    <AppPage title="WCA Importe" subtitle="Importierte Tempo-Zeitexporte"
             actions={edit ? <ImportKnopf tooltip="Tempo-Teamreports (CSV) importieren" onClick={() => setImp(true)} /> : undefined}>
      {(d.error || error) && <MessageStrip design="Negative" onClose={() => setError(null)}>{d.error ?? error}</MessageStrip>}
      <Section title="Importe" count={d.data?.length} flush>
        <Tabelle<ImportZeile> spalten={spalten} zeilen={d.data ?? []} schluessel={(z) => z.id} sortierung={{ titel: 'Importiert am', ab: true }}
                              leer={d.loading ? 'Wird geladen …' : 'Noch keine Importe'} />
      </Section>
      <p className="portal-muted portal-small">
        Überschneiden sich Dateien, gilt je Person und Tag die zuletzt importierte Datei. Wird ein Import gelöscht, entfallen seine Buchungen;
        ältere, von ihm ersetzte Buchungstage kommen nicht zurück – die betreffende Datei dann erneut importieren.
      </p>
      <ConfirmDialog open={!!loeschen} title="Import löschen" danger askReason confirmText="Löschen"
                     text={loeschen ? `Import „${loeschen.datei}“ mit ${loeschen.eintraege} Einträgen (${zahl(loeschen.stunden)} h) löschen?` : ''}
                     onConfirm={bestaetigt} onCancel={() => setLoeschen(null)} />
      {imp && <WcaImport onClose={() => setImp(false)} onUebernommen={() => d.reload()} />}
    </AppPage>
  );
}
