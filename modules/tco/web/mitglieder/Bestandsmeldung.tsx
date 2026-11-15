import { useEffect, useState } from 'react';
import { AnalyticalTable, Button, DatePicker, FlexBox, Label, Link, MessageStrip, Text } from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { download } from '@core/components/PdfDialog';
import { einstellungLink } from '@core/einstellungen';
import { Dlg } from './Dialoge';
import { MG } from './typen';

interface Bestand {
  stichtag: string;
  kopf: { schluessel: string; nummer: string; bezeichnung: string; ansprechpartner: string; fachverband: string };
  zeilen: { jahrgang: number; m: number; w: number; d: number }[];
  summe: { m: number; w: number; d: number; gesamt: number };
  hinweise: { adrnr: string; name: string; grund: string }[];
  fehlt: string[];
}

const SPALTEN: AnalyticalTableColumnDefinition[] = [
  { Header: 'Jahrgang', accessor: 'jahrgang', width: 100 },
  { Header: 'männlich', accessor: 'm', hAlign: 'End' },
  { Header: 'weiblich', accessor: 'w', hAlign: 'End' },
  { Header: 'divers', accessor: 'd', hAlign: 'End' },
];

/**
 * LSVS-Bestandsmeldung: Vorschau der Zahlen zum Stichtag und Austauschdatei (DOSB-Schnittstelle „SV-LSB“)
 * zum Hochladen in Schritt 3 der Bestandsmeldung im LSVSnet.
 */
export function BestandsmeldungDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (adrnr: string) => void }) {
  const [stichtag, setStichtag] = useState('');
  const [b, setB] = useState<Bestand | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setBusy(true);
    api.get<Bestand>(`${MG}/bestandsmeldung${stichtag ? `?stichtag=${stichtag}` : ''}`)
      .then((r) => { setB(r); if (!stichtag) setStichtag(r.stichtag); setError(null); })
      .catch((e) => setError(e.message)).finally(() => setBusy(false));
  }, [stichtag]);

  const herunterladen = () => b && download(`${MG}/bestandsmeldung/xml?stichtag=${b.stichtag}`, `LSVS_Bestandsmeldung_${b.stichtag.slice(0, 4)}.xml`)
    .catch((e) => setError((e as Error).message));

  return (
    <Dlg titel="LSVS-Bestandsmeldung" onClose={onClose} breite="min(720px, 95vw)"
         fuss={<Button design="Emphasized" icon="download" disabled={!b || b.fehlt.length > 0 || !b.summe.gesamt} onClick={herunterladen}>XML-Datei herunterladen</Button>}>
      <MessageStrip hideCloseButton style={{ marginBottom: '0.75rem' }}>
        Die Datei im LSVSnet unter Bestandserhebung in Schritt 3 hochladen. Gezählt wird jedes Mitglied am Stichtag
        (Eintritt am oder vor dem Stichtag, kein Austritt davor) – A-Meldung alle Mitglieder, B-Meldung dieselben Zahlen beim Fachverband Tennis.
      </MessageStrip>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {b && b.fehlt.length > 0 && (
        <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>
          Es fehlt: {b.fehlt.join(', ')} – bitte unter{' '}
          <Link onClick={() => window.location.assign(einstellungLink('tco', 'verein'))}>Einstellungen → TC Oberthal → Verein und Bank</Link> eintragen.
        </MessageStrip>
      )}
      <FlexBox alignItems="Center" wrap="Wrap" style={{ gap: '0.5rem 1.5rem', marginBottom: '0.75rem' }}>
        <FlexBox alignItems="Center" style={{ gap: '0.5rem' }}>
          <Label>Stichtag</Label>
          <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={stichtag} onChange={(e) => e.detail.value && setStichtag(e.detail.value)} />
        </FlexBox>
        {b && <Text><b>{b.summe.gesamt}</b> Mitglieder · {b.summe.m} männlich · {b.summe.w} weiblich · {b.summe.d} divers</Text>}
      </FlexBox>
      {b && (
        <Text style={{ display: 'block', marginBottom: '0.5rem' }} className="portal-muted">
          Verein {b.kopf.nummer || '–'} · {b.kopf.bezeichnung} · Ansprechpartner {b.kopf.ansprechpartner || '–'} · Fachverband {b.kopf.fachverband || '–'} · Software {b.kopf.schluessel || '–'}
        </Text>
      )}
      <AnalyticalTable minRows={1} columns={SPALTEN} data={b?.zeilen ?? []} visibleRows={Math.min(Math.max(b?.zeilen.length ?? 1, 1), 12)} loading={busy}
                       noDataText="Keine Mitglieder zum Stichtag" />
      {b && b.hinweise.length > 0 && (
        <MessageStrip design="Critical" hideCloseButton style={{ marginTop: '0.75rem' }}>
          {b.hinweise.length} Mitglied{b.hinweise.length === 1 ? '' : 'er'} fehlen in der Datei, weil Angaben fehlen:
          <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.25rem' }}>
            {b.hinweise.map((h) => (
              <li key={h.adrnr}><Link onClick={() => { onOpen(h.adrnr); onClose(); }}>{h.name}</Link> – {h.grund}</li>
            ))}
          </ul>
        </MessageStrip>
      )}
    </Dlg>
  );
}
