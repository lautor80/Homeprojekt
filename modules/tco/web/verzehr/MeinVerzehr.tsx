import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bar, BusyIndicator, Button, DatePicker, Dialog, Icon, Label, MessageStrip, ObjectStatus, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { Empty, Section } from '@core/components/Section';
import { PdfDialog } from '@core/components/PdfDialog';
import { toast } from '@core/toast';
import { dat, eur } from '../util';
import { Preiswahl } from './Preiswahl';
import {
  isoHeute, klein, monatsname, pdfOeffnen, STATUS_STATE, STATUS_TEXT, VZ, wuensche, ZAHLART_TEXT, type Beleg, type Mengen, type Posten, type Preisliste,
} from './typen';
import './verzehr.css';

/**
 * „Mein Verzehr“: Verzehr im Clubhaus auf das eigene Mitgliedskonto anschreiben, offene Positionen und
 * Sammelabrechnungen sehen. Der Server kennt nur das dem Benutzer zugeordnete Mitglied.
 */
interface Meine {
  adrnr: string; heute: string; monat: string; titel: string; offen: (Posten & { stornierbar: boolean })[]; betrag: number; belege: Beleg[];
  mindestbetrag: number; storno_stunden: number; info_text: string; paperless: boolean;
}

export function MeinVerzehr() {
  const [liste, setListe] = useState<Preisliste | null>(null);
  const [m, setM] = useState<Meine | null>(null);
  const [mengen, setMengen] = useState<Mengen>({});
  const [datum, setDatum] = useState(isoHeute());
  const [error, setError] = useState<string | null>(null);
  const [kein, setKein] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bestaetigen, setBestaetigen] = useState(false);
  const [pdf, setPdf] = useState<{ url: string; titel: string } | null>(null);

  const laden = () => Promise.all([api.get<Preisliste>(`${VZ}/preisliste`), api.get<Meine>(`${VZ}/meine`)])
    .then(([l, me]) => { setListe(l); setM(me); setKein(null); })
    .catch((e) => { if ((e as { status?: number }).status === 403) setKein(e.message); else setError(e.message); });
  useEffect(() => { laden(); }, []);

  async function aktion(fn: () => Promise<unknown>, meldung?: string) {
    setBusy(true); setError(null);
    try { await fn(); if (meldung) toast(meldung, 5000); await laden(); return true; } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  }
  const pdfZeigen = (url: string, titel: string) => (klein() ? pdfOeffnen(url, setError) : setPdf({ url, titel }));

  if (kein) {
    return <AppPage title="Mein Verzehr"><div className="portal-vz"><MessageStrip design="Critical" hideCloseButton>{kein}</MessageStrip></div></AppPage>;
  }
  const offenSumme = m?.betrag ?? 0;
  const heuteOffen = (m?.offen ?? []).filter((p) => p.datum === datum);

  return (
    <AppPage title="Mein Verzehr" subtitle="Verzehr im Clubhaus auf dein Konto anschreiben – Abrechnung gesammelt zum Monatsende">
      <div className="portal-vz">
        {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.75rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
        {!m || !liste ? (!error && <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />) : (
          <BusyIndicator active={busy} delay={300} style={{ display: 'block', width: '100%' }}>
            <div className="portal-busy-inhalt">
              <div className="portal-vz__kopf">
                <div>
                  <div className="portal-vz__kopf-label">Offen auf deinem Konto</div>
                  <div className="portal-vz__kopf-wert">{eur(offenSumme)}</div>
                </div>
                <div>
                  <div className="portal-vz__kopf-label">Positionen</div>
                  <div className="portal-vz__kopf-wert">{m.offen.length}</div>
                </div>
                <div style={{ flexBasis: '100%' }}>
                  <Text className="portal-muted portal-small">
                    Abrechnung zum Monatsende per {m.belege[0]?.zahlart ? ZAHLART_TEXT[m.belege[0].zahlart] : 'Lastschrift oder Überweisung'}
                    {m.mindestbetrag > 0 ? ` · unter ${eur(m.mindestbetrag)} wird in den Folgemonat übertragen` : ''}.
                  </Text>
                </div>
              </div>
              {m.info_text && <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.75rem' }}>{m.info_text}</MessageStrip>}

              <Section title="Verzehr erfassen" actions={
                <DatePicker formatPattern="EEE, dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={datum} maxDate={m.heute} style={{ width: '12rem' }}
                            onChange={(e) => e.detail.value && setDatum(e.detail.value)} />
              }>
                <Preiswahl liste={liste} mengen={mengen} setMengen={setMengen} gast={false} busy={busy}
                           aktion={() => setBestaetigen(true)} aktionText="Auf mein Konto" />
              </Section>

              <Section title={`Offene Positionen`} count={m.offen.length} flush>
                {m.offen.length ? (
                  <div className="portal-vz__liste">
                    {[...m.offen].reverse().map((p) => (
                      <div key={p.id} className="portal-vz__eintrag">
                        <div style={{ minWidth: 0 }}>
                          <div className="portal-vz__eintrag-titel">{p.anzahl} × {p.text}</div>
                          <div className="portal-vz__eintrag-info">
                            <span>{dat(p.datum)} {p.zeit}</span>
                            {!p.selbst && <span>erfasst von {p.erfasst_von}</span>}
                          </div>
                        </div>
                        <div className="portal-vz__eintrag-rechts">
                          <span>{eur(p.betrag)}</span>
                          {p.stornierbar && (
                            <Button icon="delete" design="Transparent" tooltip="Stornieren" disabled={busy}
                                    onClick={() => aktion(() => api.post(`${VZ}/meine/storno`, { id: p.id }), 'Position storniert.')} />
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : <Empty>Keine offenen Positionen – alles abgerechnet.</Empty>}
              </Section>

              <Section title="Meine Abrechnungen" count={m.belege.length} flush>
                {m.belege.length ? (
                  <div className="portal-vz__liste">
                    {m.belege.map((b) => (
                      <button key={b.rgnr} type="button" className="portal-vz__eintrag" style={{ background: 'none', border: 0, borderBottom: '1px solid var(--sapList_BorderColor)', font: 'inherit', textAlign: 'left', cursor: 'pointer', width: '100%' }}
                              onClick={() => pdfZeigen(`${VZ}/meine/beleg/${b.rgnr}/pdf`, `Verzehrabrechnung ${b.monat ? monatsname(b.monat) : b.rgnr}`)}>
                        <div style={{ minWidth: 0 }}>
                          <div className="portal-vz__eintrag-titel">{b.monat ? monatsname(b.monat) : b.rgnr}</div>
                          <div className="portal-vz__eintrag-info">
                            <span>{b.rgnr} · {b.posten} Pos.</span>
                            <ObjectStatus state={STATUS_STATE[b.status]}>{b.status === 'BEZAHLT' && b.bezahlt_am ? `bezahlt ${dat(b.bezahlt_am)}` : b.status === 'GESTELLT' && b.faellig ? `${b.zahlart === 'LASTSCHRIFT' ? 'Lastschrift' : `fällig ${dat(b.faellig)}`}` : STATUS_TEXT[b.status]}</ObjectStatus>
                          </div>
                        </div>
                        <div className="portal-vz__eintrag-rechts"><span>{eur(b.betrag)}</span><Icon name="pdf-attachment" style={{ color: 'var(--sapContent_IconColor)' }} /></div>
                      </button>
                    ))}
                  </div>
                ) : <Empty>Noch keine Abrechnung.</Empty>}
              </Section>
            </div>
          </BusyIndicator>
        )}
      </div>

      {bestaetigen && liste && createPortal(
        <Dialog open headerText="Auf mein Konto anschreiben" onClose={() => setBestaetigen(false)}
                footer={<Bar endContent={<>
                  <Button design="Emphasized" icon="accept" disabled={busy} onClick={async () => {
                    let text = '';
                    const ok = await aktion(async () => { text = (await api.post<{ text: string }>(`${VZ}/meine/buchen`, { datum, positionen: wuensche(mengen) })).text; });
                    setBestaetigen(false);
                    if (ok) { toast(text, 5000); setMengen({}); }
                  }}>Anschreiben</Button>
                  <Button onClick={() => setBestaetigen(false)}>Abbrechen</Button>
                </>} />}>
          <div className="portal-vz__form" style={{ maxWidth: '26rem' }}>
            <Label>Für {dat(datum)}{heuteOffen.length ? ` (bereits ${heuteOffen.length} Position(en) an diesem Tag)` : ''}:</Label>
            {liste.produkte.filter((p) => (mengen[p.prod_key] ?? 0) > 0).map((p) => (
              <div key={p.prod_key} className="portal-vz__zeile"><span>{mengen[p.prod_key]} × {p.text}</span><span>{eur(mengen[p.prod_key] * p.preis)}</span></div>
            ))}
            <Text className="portal-muted portal-small">Der Betrag wird mit der nächsten Sammelabrechnung fällig. Ein Storno ist {m?.storno_stunden ?? 12} Stunden lang möglich.</Text>
          </div>
        </Dialog>,
        document.body,
      )}
      {pdf && <PdfDialog url={pdf.url} title={pdf.titel} filename={`${pdf.titel.replace(/[^\wäöüÄÖÜß-]+/g, '_')}.pdf`} onClose={() => setPdf(null)} />}
    </AppPage>
  );
}
