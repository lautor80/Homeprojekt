import { useEffect, useState } from 'react';
import { useCan } from '@core/session';
import { MailEntwurfDialog } from './MailEntwurf';
import { Button, Icon, Link, MessageStrip, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AblageFlaeche, useAblageZiel, type AblageErgebnis, type AblageZiel } from '@core/ablage';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { DokumentPopup } from './DokumentPopup';
import { toast } from '@core/toast';
import { T, dat } from './util';
import { OrdnerDateien } from './Ablageordner';
import { ordnerStatus } from './ordner';
import { auftragAblegen } from './auftragAblage';
import { AuftragEingang } from './eingang/AuftragEingang';

/**
 * Dokumente zum Auftrag (Paperless): alle im Portal verknüpften Dokumente und alle, deren Custom Field „Auftrag“ in Paperless die
 * Auftragsnummer nennt (Migration lokaler Ordner, Rechnungen). Klick öffnet ein Popup mit Vorschau und Kommentaren, der
 * Pfeil daneben das Dokument in Paperless. Dateien hineinziehen, auswählen oder Screenshot mit Strg+V einfügen.
 * Ablage mit Titel „Auftrag … – Dateiname“, Kunde als Korrespondent und Tag „Auftrag …“.
 * E-Mails (.eml, z. B. aus Outlook hineingezogen) werden zerlegt: Ihre Anhänge werden wie einzelne Dateien abgelegt
 * (Ablageordner und Paperless), die E-Mail selbst nur im Ablageordner (eml.ts).
 * Abschnitt „Aus dem Posteingang“ (eingang/AuftragEingang.tsx): Dateien aus dem Euroflex-Posteingang; mit Ablageziel „lokal“
 * werden wartende Dateien beim Öffnen in den Unterordner „Eingang“ des Ablageordners übernommen.
 */
interface Dok {
  doc_id: number; titel: string | null; datei: string | null; erstellt_am: string | null; erstellt_von: string | null;
  /** Dokumentdatum in Paperless */ datum: string | null;
  /** portal = im Portal verknüpft, feld = über das Custom Field „Auftrag“ in Paperless, beide = beides */ quelle: 'portal' | 'feld' | 'beide';
  notizen: number | null; link: string | null;
}
interface Liste { paperless: boolean; warnung?: string | null; dokumente: Dok[] }

const istPdf = (d: Dok) => /\.pdf$/i.test(d.datei ?? '');

export function AuftragDokumente({ nr, edit, ablegen: darfAblegen = edit, ordnerStand = 0, faktura }: {
  nr: string; edit: boolean;
  /** Dokumente ablegen (Ablagefeld, Strg+V, Ablagefeld der Navigation) – mit Recht zum Ändern auch ohne Bearbeitungsmodus */ ablegen?: boolean;
  ordnerStand?: number; /** Rechnung des Auftrags: die E-Mail startet dann mit „Rechnung (an Kunde)“ */ faktura?: string | null }) {
  const [d, setD] = useState<Liste | null>(null);
  // Ablageordner auf diesem PC (#121): hineingezogene Dateien landen zusätzlich dort
  const [ordner, setOrdner] = useState(false);
  const [stand, setStand] = useState(0);
  useEffect(() => { ordnerStatus().then((o) => setOrdner(!!o)).catch(() => setOrdner(false)); }, []);
  const [popup, setPopup] = useState<Dok | null>(null);
  const can = useCan();
  const [mail, setMail] = useState(false);
  const [loesen, setLoesen] = useState<Dok | null>(null);
  const [error, setError] = useState<string | null>(null);
  const laden = () => api.get<Liste>(`${T}/auftraege/${nr}/dokumente`).then(setD).catch((e) => setError(e.message));
  useEffect(() => { laden(); }, [nr]); // eslint-disable-line react-hooks/exhaustive-deps

  const ziel: AblageZiel = {
    titel: `Auftrag ${nr}`,
    annehmen: (eingang): Promise<AblageErgebnis> => auftragAblegen(nr, eingang, { paperless: !!d?.paperless, ordner, danach: () => { laden(); setStand((v) => v + 1); } }),
  };
  // Strg+V und Ablagefeld der Navigation legen beim geöffneten Auftrag ab – auch ohne Bearbeitungsmodus, sonst landet die Datei
  // mit der allgemeinen Voreinstellung (anderer Dokumenttyp/Korrespondent, ohne Feld „Auftrag“) in Paperless
  useAblageZiel(darfAblegen && (d?.paperless || ordner) ? ziel : null);

  // Popup mit Vorschau und Kommentaren (DokumentPopup.tsx)
  const oeffnen = (x: Dok) => setPopup(x);

  if (!d) return <Text>Lade Dokumente …</Text>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
      {d.warnung && <MessageStrip hideCloseButton design="Critical">{d.warnung} – angezeigt werden nur die im Portal verknüpften Dokumente.</MessageStrip>}
      {!d.paperless && <MessageStrip hideCloseButton design="Information">Paperless ist nicht eingerichtet (Administration → Schnittstellen → „Paperless-ngx Euroflex“).</MessageStrip>}
      {can('transport.versand:execute') && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button icon="email" onClick={() => setMail(true)}>E-Mail mit Anhängen…</Button>
        </div>
      )}
      {mail && <MailEntwurfDialog nr={nr} dokumente={d.dokumente} start={faktura ? 'R' : 'T'} onClose={() => setMail(false)} />}
      {d.dokumente.length > 0 && (
        <div className="portal-ad">
          {d.dokumente.map((x) => (
            <div key={x.doc_id} className="portal-ad__zeile">
              <Icon name={istPdf(x) ? 'pdf-attachment' : /\.(png|jpe?g|gif|webp|heic|tiff?)$/i.test(x.datei ?? '') ? 'picture' : 'document'} />
              <div style={{ minWidth: 0 }}>
                <Link onClick={() => oeffnen(x)}>{x.datei || x.titel || `Dokument ${x.doc_id}`}</Link>
                <div className="portal-muted portal-small">
                  Paperless {x.doc_id}{x.datum ? ` · ${dat(x.datum)}` : x.erstellt_am ? ` · ${dat(x.erstellt_am.slice(0, 10))}` : ''}{x.erstellt_von ? ` · ${x.erstellt_von}` : ''}
                  {x.quelle === 'feld' ? ' · über Feld „Auftrag“' : ''}
                  {x.notizen ? <> · <Icon name="comment" style={{ width: '0.75rem', height: '0.75rem', verticalAlign: 'middle' }} /> {x.notizen}</> : null}
                </div>
              </div>
              {x.link && <Button design="Transparent" icon="action" tooltip="In Paperless öffnen" onClick={() => window.open(x.link!, '_blank', 'noopener')} />}
              {edit && x.quelle !== 'feld' && <Button design="Transparent" icon="decline" tooltip="Zuordnung lösen (Dokument bleibt in Paperless)" onClick={() => setLoesen(x)} />}
            </div>
          ))}
        </div>
      )}
      <OrdnerDateien nr={nr} version={ordnerStand + stand} />
      <AuftragEingang nr={nr} onUebernommen={() => setStand((v) => v + 1)} />
      {darfAblegen && (d.paperless || ordner) && <AblageFlaeche ziel={ziel} text={`Dokumente zum Auftrag hierher ziehen (z. B. unterschriebener Lieferschein, CMR, Foto), klicken zum Auswählen oder Screenshot mit Strg+V einfügen; eine E-Mail aus Outlook (.eml) wird zerlegt und ihre Anhänge abgelegt${ordner ? ' – sie landen auch im Ablageordner' : ''}`} />}
      {!darfAblegen && !d.dokumente.length && d.paperless && <Text className="portal-muted">Keine Dokumente in Paperless zugeordnet.</Text>}
      {popup && <DokumentPopup nr={nr} docId={popup.doc_id} titel={popup.titel ?? popup.datei ?? `Dokument ${popup.doc_id}`} datei={popup.datei} link={popup.link}
                               edit={edit} onClose={() => setPopup(null)} onGeaendert={laden} />}
      <ConfirmDialog open={!!loesen} title="Zuordnung lösen" confirmText="Lösen"
                     text={`„${loesen?.datei ?? ''}“ vom Auftrag ${nr} lösen? Das Dokument bleibt in Paperless erhalten.`}
                     onCancel={() => setLoesen(null)}
                     onConfirm={async () => {
                       const x = loesen!; setLoesen(null);
                       try { const r = await api.del<{ text: string }>(`${T}/auftraege/${nr}/dokumente/${x.doc_id}`); toast(r.text); laden(); } catch (e) { setError((e as Error).message); }
                     }} />
    </div>
  );
}
