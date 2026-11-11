import { useEffect, useState } from 'react';
import { Button, FlexBox, Icon, Link, MessageStrip, Text } from '@ui5/webcomponents-react';
import { Section } from '@core/components/Section';
import { toast } from '@core/toast';
import { DocsDialog, type Doc } from './dialogs';
import { dat } from './util';
import {
  anzeigePfad, auftragsOrdner, dateienImOrdner, dateiLesen, ordnerBereit, ordnerEntfernen, ordnerMoeglich, ordnerStatus, ordnerWaehlen,
  type OrdnerDatei,
} from './ordner';

/** Stammdaten → Firmendaten: Ablageordner auf diesem PC festlegen (#121) */
export function AblageOrdnerEinstellung() {
  const [st, setSt] = useState<{ name: string; zugriff: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lade = () => ordnerStatus().then(setSt).catch((e) => setError((e as Error).message));
  useEffect(() => { lade(); }, []);

  const waehlen = async () => {
    setError(null);
    try { const n = await ordnerWaehlen(); toast(`Ablageordner „${n}“ festgelegt`); lade(); } catch (e) {
      if ((e as DOMException).name !== 'AbortError') setError((e as Error).message);
    }
  };

  return (
    <Section title="Ablageordner auf diesem PC">
      {!ordnerMoeglich ? (
        <MessageStrip hideCloseButton design="Information">
          Dieser Browser kann keine Ordner auf dem PC beschreiben. Bitte Microsoft Edge oder Google Chrome verwenden.
        </MessageStrip>
      ) : (
        <>
          {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.75rem' }}>{error}</MessageStrip>}
          <Text style={{ display: 'block', marginBottom: '0.75rem' }}>
            Ausdrucke (Transportauftrag, Lieferschein, Rechnung) und in einen Auftrag gezogene Dateien werden zusätzlich in
            <b> Ordner\Jahr\Auftragsnummer</b> gespeichert und von dort geöffnet; der Auftragsordner entsteht bei der Anlage.
            Die Einstellung gilt für diesen PC und Browser. Nach einem Neustart des Browsers fragt er beim ersten Druck einmal nach dem Zugriff.
          </Text>
          <FlexBox alignItems="Center" wrap="Wrap" style={{ gap: '0.75rem' }}>
            <Icon name="folder" />
            <Text><b>{st ? st.name : 'Kein Ordner gewählt'}</b></Text>
            {st && <Text className={st.zugriff ? '' : 'portal-muted'}>{st.zugriff ? '· Zugriff erteilt' : '· Zugriff wird beim nächsten Druck erfragt'}</Text>}
            <Button icon="open-folder" onClick={waehlen}>{st ? 'Anderen Ordner wählen' : 'Ordner wählen'}</Button>
            {st && !st.zugriff && <Button design="Transparent" icon="unlocked" onClick={async () => { await ordnerBereit(true); lade(); }}>Zugriff erlauben</Button>}
            {st && <Button design="Transparent" icon="delete" onClick={async () => { await ordnerEntfernen(); lade(); }}>Nicht mehr verwenden</Button>}
          </FlexBox>
        </>
      )}
    </Section>
  );
}

const groesse = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB`);

/** Auftrag → Dokumente: Dateien im Ablageordner des Auftrags, Öffnen direkt aus dem Ordner */
export function OrdnerDateien({ nr, version }: { nr: string; version?: number }) {
  const [daten, setDaten] = useState<{ basis: string; dateien: OrdnerDatei[] } | null | undefined>(undefined);
  const [eingerichtet, setEingerichtet] = useState(false);
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lade = async () => {
    try {
      setEingerichtet(!!(await ordnerStatus()));
      setDaten(await dateienImOrdner(nr));
    } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { lade(); }, [nr, version]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ordnerMoeglich || !eingerichtet) return null;

  const oeffnen = async (x: OrdnerDatei) => {
    const f = await dateiLesen(nr, x.name);
    if (!f) return setError(`${x.name} ist im Ordner nicht mehr vorhanden.`);
    const url = URL.createObjectURL(f);
    if (/\.pdf$/i.test(x.name)) setDocs([{ url, filename: x.name, lokal: true }]);
    else { window.open(url, '_blank'); setTimeout(() => URL.revokeObjectURL(url), 60_000); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {/* eingerückt wie die Dateizeilen darunter (#121) */}
      <FlexBox alignItems="Center" style={{ gap: '0.75rem', paddingLeft: 'calc(0.75rem + 1px)' }}>
        <Icon name="folder" />
        <Text><b>Ablageordner</b> <span className="portal-muted">{daten ? anzeigePfad(daten.basis, nr) : ''}</span></Text>
        <Button design="Transparent" icon="refresh" tooltip="Neu einlesen" onClick={lade} />
      </FlexBox>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
      {daten === null && (
        <MessageStrip hideCloseButton design="Information">
          Kein Zugriff auf den Ablageordner.{' '}
          <Link onClick={async () => { if (await auftragsOrdner(nr, { anfordern: true })) lade(); }}>Zugriff erlauben</Link>
        </MessageStrip>
      )}
      {daten && !daten.dateien.length && <Text className="portal-muted">Noch keine Dateien im Ordner – Ausdrucke und hineingezogene Dateien landen hier.</Text>}
      {daten && daten.dateien.length > 0 && (
        <div className="portal-ad">
          {daten.dateien.map((x) => (
            <div key={x.name} className="portal-ad__zeile">
              <Icon name={/\.pdf$/i.test(x.name) ? 'pdf-attachment' : /\.(png|jpe?g|gif|webp|heic|tiff?)$/i.test(x.name) ? 'picture' : 'document'} />
              <div style={{ minWidth: 0 }}>
                <Link onClick={() => oeffnen(x)}>{x.name}</Link>
                <div className="portal-muted portal-small">{dat(new Date(x.geaendert).toISOString().slice(0, 10))} · {groesse(x.groesse)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      <DocsDialog docs={docs} onClose={() => { docs?.forEach((d) => URL.revokeObjectURL(d.url)); setDocs(null); }} />
    </div>
  );
}
