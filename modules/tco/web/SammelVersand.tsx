import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bar, BusyIndicator, Button, CheckBox, Dialog, Icon, Input, Label, MessageStrip, ObjectStatus, ProgressIndicator, Text,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { H, dat, eur } from './util';
import './halle.css';

/**
 * Sammelversand von Hallenrechnungen: alle Rechnungen „In Bearbeitung“ werden vorgeschlagen, die Auswahl lässt sich
 * über eine Wertgrenze (Mindestbetrag) eingrenzen. Je Empfänger ist ersichtlich, ob eine E-Mail-Adresse gepflegt ist.
 * Ablauf: Auswahl → Freigabe → Druck (Ablage in Paperless) und Versand per E-Mail → Protokoll als Tabelle.
 */
interface Vorschlag {
  rgnr: string; kunde: string; name: string; adrnr: string | null; betrag: number; positionen: number; angelegt_am: string | null;
  email: string; wiedereroeffnet: boolean; hinweis: string | null;
}
interface Zeile { quelle: string; ok: boolean; text: string; rgnrs: string[] }
type Phase = 'auswahl' | 'freigabe' | 'versand' | 'protokoll';

const zahl = (v: string) => Number(v.trim().replace(/\./g, (m, _i, t: string) => (t.includes(',') ? '' : m)).replace(',', '.'));
const klein = () => window.matchMedia?.('(max-width: 700px)').matches ?? false;
const empfaenger = (x: Vorschlag) => `${x.adrnr ?? x.kunde}|${x.email.toLowerCase()}`;

export function SammelVersandDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (t: string) => void }) {
  const [daten, setDaten] = useState<Vorschlag[] | null>(null);
  const [auswahl, setAuswahl] = useState<Set<string>>(new Set());
  const [grenze, setGrenze] = useState('');
  const [phase, setPhase] = useState<Phase>('auswahl');
  const [fortschritt, setFortschritt] = useState({ fertig: 0, gesamt: 0, name: '' });
  const [protokoll, setProtokoll] = useState<Zeile[]>([]);
  const [error, setError] = useState<string | null>(null);

  /** Vorschlag: alle versendbaren Rechnungen ab der Wertgrenze */
  const vorschlagen = (d: Vorschlag[], ab: string) => {
    const min = ab.trim() ? zahl(ab) : null;
    setAuswahl(new Set(d.filter((x) => !x.hinweis && (min === null || Number.isNaN(min) || x.betrag >= min)).map((x) => x.rgnr)));
  };

  useEffect(() => {
    if (!open) return;
    setDaten(null); setError(null); setGrenze(''); setPhase('auswahl'); setProtokoll([]);
    api.get<Vorschlag[]>(`${H}/sammelversand`).then((d) => { setDaten(d); vorschlagen(d, ''); }).catch((e) => setError(e.message));
  }, [open]);

  const liste = daten ?? [];
  const grenzeFehler = grenze.trim() !== '' && Number.isNaN(zahl(grenze));
  const gewaehlt = useMemo(() => liste.filter((x) => auswahl.has(x.rgnr)), [liste, auswahl]);
  const ohneMail = liste.filter((x) => !x.email);
  const gesperrt = liste.filter((x) => x.hinweis);
  const kz = {
    summe: gewaehlt.reduce((s, x) => s + x.betrag, 0),
    empfaenger: new Set(gewaehlt.map(empfaenger)).size,
    ohneMail: new Set(ohneMail.map((x) => x.adrnr ?? x.kunde)).size,
  };
  const waehlbar = liste.filter((x) => !x.hinweis);
  const alleGewaehlt = waehlbar.length > 0 && waehlbar.every((x) => auswahl.has(x.rgnr));
  const umschalten = (x: Vorschlag, an: boolean) => {
    if (x.hinweis) return;
    setAuswahl((a) => { const n = new Set(a); if (an) n.add(x.rgnr); else n.delete(x.rgnr); return n; });
  };

  /** je Empfänger ein Aufruf: Druck, Ablage und E-Mail – der Fortschritt bleibt sichtbar, Fehler halten die übrigen nicht auf */
  async function versenden() {
    const gruppen = new Map<string, Vorschlag[]>();
    for (const x of gewaehlt) gruppen.set(empfaenger(x), [...(gruppen.get(empfaenger(x)) ?? []), x]);
    const zeilen: Zeile[] = [];
    setPhase('versand'); setError(null);
    let fertig = 0;
    for (const g of gruppen.values()) {
      setFortschritt({ fertig, gesamt: gruppen.size, name: g[0].name });
      const rgnrs = g.map((x) => x.rgnr);
      try {
        const r = await api.post<{ zeilen: Zeile[] }>(`${H}/sammelversand`, { rgnrs });
        zeilen.push(...r.zeilen);
      } catch (e) {
        zeilen.push({ quelle: `${g[0].name} (${rgnrs.join(', ')})`, ok: false, text: (e as Error).message, rgnrs });
      }
      fertig += 1;
    }
    setProtokoll(zeilen);
    setPhase('protokoll');
  }

  const okZeilen = protokoll.filter((z) => z.ok);
  const versendet = okZeilen.reduce((s, z) => s + z.rgnrs.length, 0);
  const schliessen = () => {
    if (phase === 'versand') return;
    if (phase === 'protokoll') onDone(`Sammelversand: ${versendet} Rechnung(en) an ${okZeilen.length} Empfänger versendet${protokoll.length - okZeilen.length ? `, ${protokoll.length - okZeilen.length} Fehler` : ''}`);
    else onClose();
  };

  const fuss = phase === 'auswahl' ? (
    <Bar startContent={<Text className="portal-az__fuss"><b>{gewaehlt.length}</b> Rechnung(en) · <b>{kz.empfaenger}</b> Empfänger · <b>{eur(kz.summe)}</b></Text>}
         endContent={<>
           <Button design="Emphasized" icon="paper-plane" disabled={!gewaehlt.length} onClick={() => setPhase('freigabe')}>Weiter zur Freigabe</Button>
           <Button onClick={onClose}>Abbrechen</Button>
         </>} />
  ) : phase === 'freigabe' ? (
    <Bar endContent={<>
      <Button design="Emphasized" icon="accept" onClick={versenden}>Freigeben, drucken und versenden</Button>
      <Button onClick={() => setPhase('auswahl')}>Zurück</Button>
    </>} />
  ) : phase === 'protokoll' ? (
    <Bar endContent={<Button design="Emphasized" onClick={schliessen}>Schließen</Button>} />
  ) : undefined;

  return createPortal(
    <Dialog open={open} stretch={klein()} onClose={schliessen} className="portal-az__dialog"
            headerText={phase === 'protokoll' ? 'Protokoll Sammelversand' : phase === 'freigabe' ? 'Sammelversand freigeben' : 'Sammelversand Hallenrechnungen'}
            style={klein() ? undefined : { width: 'min(64rem, 96vw)', height: '90vh' }} footer={fuss}>
      <div className="portal-az">
        {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}

        {phase === 'auswahl' && <>
          <div className="portal-az__kpis">
            <div className="portal-az__kpi"><span>Ausgewählt</span><b>{gewaehlt.length} <small>von {liste.length}</small></b></div>
            <div className="portal-az__kpi"><span>Summe</span><b>{eur(kz.summe)}</b></div>
            <div className="portal-az__kpi"><span>Empfänger</span><b>{kz.empfaenger}</b></div>
            <div className={`portal-az__kpi${kz.ohneMail ? ' portal-az__kpi--warn' : ''}`}><span>Ohne E-Mail-Adresse</span><b>{kz.ohneMail} <small>Empfänger</small></b></div>
          </div>

          <div className="portal-az__leiste">
            <Label for="sv-grenze">Wertgrenze (Rechnungsbetrag ab)</Label>
            <Input id="sv-grenze" className="portal-sv__grenze" placeholder="z. B. 20,00" value={grenze} valueState={grenzeFehler ? 'Negative' : 'None'}
                   icon={<Icon name="lead" />} showClearIcon
                   onInput={(e) => { setGrenze(e.target.value); if (daten) vorschlagen(daten, e.target.value); }} />
            <Text className="portal-muted portal-small">€ – wählt alle versendbaren Rechnungen ab diesem Betrag</Text>
            <div className="portal-az__leiste-rechts">
              <Button design="Transparent" icon="favorite" tooltip="Vorschlag: alle versendbaren Rechnungen ab der Wertgrenze" onClick={() => daten && vorschlagen(daten, grenze)}>Vorschlag</Button>
              <Button design="Transparent" icon="multiselect-none" onClick={() => setAuswahl(new Set())}>Keine</Button>
            </div>
          </div>

          {kz.ohneMail > 0 && (
            <MessageStrip design="Critical" hideCloseButton>
              Für {kz.ohneMail} Empfänger ({ohneMail.length} Rechnung(en)) ist keine E-Mail-Adresse gepflegt. Diese Rechnungen sind nicht
              auswählbar – bitte die Adresse in den Stammdaten ergänzen oder die Rechnung einzeln versenden.
            </MessageStrip>
          )}
          {daten && kz.ohneMail === 0 && liste.length > 0 && (
            <MessageStrip design="Positive" hideCloseButton>Für alle Empfänger ist eine E-Mail-Adresse gepflegt.</MessageStrip>
          )}

          {!daten && !error && <BusyIndicator active style={{ display: 'block', padding: '3rem 0' }} />}
          {daten && !liste.length && (
            <div className="portal-az__leer"><Icon name="complete" /><Text>Keine Rechnung im Status „In Bearbeitung“.</Text></div>
          )}
          {liste.length > 0 && (
            <div className="portal-sv__tabelle-rahmen">
              <table className="portal-sv__tabelle">
                <thead>
                  <tr>
                    <th><CheckBox checked={alleGewaehlt} indeterminate={gewaehlt.length > 0 && !alleGewaehlt} accessibleName="Alle versendbaren Rechnungen auswählen"
                                  onChange={(e) => setAuswahl(e.target.checked ? new Set(waehlbar.map((x) => x.rgnr)) : new Set())} /></th>
                    <th><Label>Rechnung</Label></th>
                    <th><Label>Empfänger</Label></th>
                    <th><Label>E-Mail-Adresse</Label></th>
                    <th><Label>Erstellt</Label></th>
                    <th className="portal-sv__zahl"><Label>Pos.</Label></th>
                    <th className="portal-sv__zahl"><Label>Betrag</Label></th>
                  </tr>
                </thead>
                <tbody>
                  {liste.map((x) => {
                    const an = auswahl.has(x.rgnr);
                    return (
                      <tr key={x.rgnr} className={`${an ? 'portal-sv__zeile--an' : ''}${x.hinweis ? ' portal-sv__zeile--gesperrt' : ''}`}
                          onClick={(e) => { if ((e.target as HTMLElement).tagName !== 'UI5-CHECKBOX') umschalten(x, !an); }}>
                        <td><CheckBox checked={an} disabled={!!x.hinweis} accessibleName={`Rechnung ${x.rgnr} auswählen`} onChange={(e) => umschalten(x, e.target.checked)} /></td>
                        <td>
                          <Text>{x.rgnr}</Text>
                          {x.wiedereroeffnet && <div><ObjectStatus state="Critical">wieder eröffnet</ObjectStatus></div>}
                        </td>
                        <td><Text>{x.name}</Text></td>
                        <td>
                          {x.email
                            ? <ObjectStatus state="Positive" showDefaultIcon>{x.email}</ObjectStatus>
                            : <ObjectStatus state="Negative" showDefaultIcon>nicht gepflegt</ObjectStatus>}
                          {x.hinweis && x.email && <div><ObjectStatus state="Negative">{x.hinweis}</ObjectStatus></div>}
                        </td>
                        <td><Text>{dat(x.angelegt_am)}</Text></td>
                        <td className="portal-sv__zahl"><Text>{x.positionen}</Text></td>
                        <td className="portal-sv__zahl"><Text>{eur(x.betrag)}</Text></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Text className="portal-muted portal-small">
            Vorgeschlagen werden alle Rechnungen im Status „In Bearbeitung“. Der Versand erfolgt ausschließlich per E-Mail, je Empfänger
            eine E-Mail mit allen gewählten Rechnungen als Anhang.{gesperrt.length ? ` ${gesperrt.length} Rechnung(en) sind nicht versendbar.` : ''}
          </Text>
        </>}

        {phase === 'freigabe' && <>
          <MessageStrip design="Information" hideCloseButton>
            Mit der Freigabe werden <b>{gewaehlt.length}</b> Rechnung(en) über zusammen <b>{eur(kz.summe)}</b> gedruckt, in Paperless abgelegt und
            per E-Mail an <b>{kz.empfaenger}</b> Empfänger versendet. Die Rechnungen erhalten den Status „Versendet“.
          </MessageStrip>
          <div className="portal-sv__tabelle-rahmen">
            <table className="portal-sv__tabelle">
              <thead><tr><th><Label>Empfänger</Label></th><th><Label>E-Mail-Adresse</Label></th><th><Label>Rechnung</Label></th><th className="portal-sv__zahl"><Label>Betrag</Label></th></tr></thead>
              <tbody>
                {gewaehlt.map((x) => (
                  <tr key={x.rgnr}><td><Text>{x.name}</Text></td><td><Text>{x.email}</Text></td><td><Text>{x.rgnr}</Text></td><td className="portal-sv__zahl"><Text>{eur(x.betrag)}</Text></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>}

        {phase === 'versand' && (
          <div className="portal-sv__lauf">
            <Text>Druck und Versand laufen – bitte das Fenster geöffnet lassen.</Text>
            <ProgressIndicator value={fortschritt.gesamt ? Math.round((fortschritt.fertig / fortschritt.gesamt) * 100) : 0}
                               displayValue={`${fortschritt.fertig} von ${fortschritt.gesamt} Empfängern`} style={{ width: '100%' }} />
            <Text className="portal-muted">{fortschritt.name}</Text>
          </div>
        )}

        {phase === 'protokoll' && <>
          <MessageStrip design={protokoll.length === okZeilen.length ? 'Positive' : 'Critical'} hideCloseButton>
            {versendet} Rechnung(en) an {okZeilen.length} Empfänger versendet{protokoll.length - okZeilen.length ? `, ${protokoll.length - okZeilen.length} Fehler` : ''}.
          </MessageStrip>
          <div className="portal-sv__tabelle-rahmen">
            <table className="portal-sv__tabelle">
              <thead><tr><th><Label>Empfänger (Rechnung)</Label></th><th><Label>Ergebnis</Label></th><th><Label>Meldung</Label></th></tr></thead>
              <tbody>
                {protokoll.flatMap((z, i) => {
                  const teile = z.text.split(/\s·\s/).map((t) => t.trim()).filter(Boolean);
                  return teile.map((t, j) => (
                    <tr key={`${i}-${j}`}>
                      <td>{j === 0 && <Text>{z.quelle}</Text>}</td>
                      <td>{j === 0 && <ObjectStatus state={z.ok ? 'Positive' : 'Negative'} showDefaultIcon>{z.ok ? 'ok' : 'Fehler'}</ObjectStatus>}</td>
                      <td><Text>{t}</Text></td>
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          </div>
        </>}
      </div>
    </Dialog>,
    document.body,
  );
}
