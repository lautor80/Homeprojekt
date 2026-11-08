import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bar, BusyIndicator, Button, Dialog, Input, Label, MessageStrip, ObjectStatus, SegmentedButton, SegmentedButtonItem, Text, ToggleButton } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { AuswahlBox } from '@core/components/AuswahlBox';
import { Empty, Section } from '@core/components/Section';
import { PdfDialog } from '@core/components/PdfDialog';
import { toast } from '@core/toast';
import { useCan } from '@core/session';
import { dat, eur } from '../util';
import { Preiswahl } from './Preiswahl';
import { klein, pdfOeffnen, STATUS_STATE, STATUS_TEXT, VZ, wuensche, ZAHLART_TEXT, type Beleg, type Mengen, type Posten, type Preisliste, type Zahlart } from './typen';
import './verzehr.css';

/**
 * Theke: Gastbelege anlegen, erweitern und kassieren (Bar/Karte/PayPal), Beleg als PDF, E-Mail oder WhatsApp;
 * Verzehr für Mitglieder ohne Handy anschreiben; heutige Positionen stornieren.
 */
interface Init { offen: Beleg[]; heute: Beleg[]; mitglieder: { adrnr: string; name: string }[]; paperless: boolean; mail: boolean }
type Modus = 'GAST' | 'MITGLIED';
interface HeutePosten extends Posten { person: string; status: string; gast: boolean; beleg_rgnr: string | null }

export function Theke() {
  const can = useCan();
  const admin = can('tco.verzehr:admin');
  const [liste, setListe] = useState<Preisliste | null>(null);
  const [init, setInit] = useState<Init | null>(null);
  const [heute, setHeute] = useState<HeutePosten[]>([]);
  const [modus, setModus] = useState<Modus>('GAST');
  const [mengen, setMengen] = useState<Mengen>({});
  const [gast, setGast] = useState({ rgnr: '' as string, gast_name: '', gast_gruppe: '', email: '', mobil: '' });
  const [adrnr, setAdrnr] = useState('');
  const [kasse, setKasse] = useState<Beleg | null>(null);
  const [detail, setDetail] = useState<{ beleg: Beleg; posten: Posten[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pdf, setPdf] = useState<{ url: string; titel: string } | null>(null);

  const laden = () => Promise.all([api.get<Preisliste>(`${VZ}/preisliste`), api.get<Init>(`${VZ}/theke`), api.get<HeutePosten[]>(`${VZ}/theke/heute`)])
    .then(([l, i, h]) => { setListe(l); setInit(i); setHeute(h); })
    .catch((e) => setError(e.message));
  useEffect(() => { laden(); }, []);

  async function aktion(fn: () => Promise<unknown>, meldung?: string) {
    setBusy(true); setError(null);
    try { await fn(); if (meldung) toast(meldung, 5000); await laden(); return true; } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  }
  const pdfZeigen = (rgnr: string) => (klein() ? pdfOeffnen(`${VZ}/belege/${rgnr}/pdf`, setError) : setPdf({ url: `${VZ}/belege/${rgnr}/pdf`, titel: `Beleg ${rgnr}` }));
  const belegOeffnen = (rgnr: string) => api.get<{ beleg: Beleg; posten: Posten[] }>(`${VZ}/belege/${rgnr}`).then(setDetail).catch((e) => setError(e.message));
  const warnen = (w: string[]) => { if (w?.length) setError(w.join('\n')); };

  async function buchen() {
    if (modus === 'GAST') {
      let rgnr = '';
      const ok = await aktion(async () => {
        const r = await api.post<{ rgnr: string }>(`${VZ}/theke/gast`, { rgnr: gast.rgnr || null, gast_name: gast.gast_name, gast_gruppe: gast.gast_gruppe || null, email: gast.email || null, mobil: gast.mobil || null, positionen: wuensche(mengen) });
        rgnr = r.rgnr;
      });
      if (ok) { setMengen({}); setGast({ ...gast, rgnr }); toast(`Auf Gastbeleg ${rgnr} gebucht.`); }
    } else {
      let text = '';
      const ok = await aktion(async () => { text = (await api.post<{ text: string }>(`${VZ}/theke/mitglied`, { adrnr, positionen: wuensche(mengen) })).text; });
      if (ok) { setMengen({}); toast(text, 5000); }
    }
  }
  const gastWaehlen = (b: Beleg | null) => setGast(b ? { rgnr: b.rgnr, gast_name: b.gast_name ?? '', gast_gruppe: b.gast_gruppe ?? '', email: b.email ?? '', mobil: b.mobil ?? '' } : { rgnr: '', gast_name: '', gast_gruppe: '', email: '', mobil: '' });
  const offenerBeleg = init?.offen.find((b) => b.rgnr === gast.rgnr) ?? null;

  return (
    <AppPage title="Theke" subtitle="Gäste kassieren, Verzehr für Mitglieder anschreiben">
      <div className="portal-vz">
        {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.75rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
        {!liste || !init ? (!error && <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />) : (
          <BusyIndicator active={busy} delay={300} style={{ display: 'block', width: '100%' }}>
            <div className="portal-busy-inhalt">
              <div className="portal-vz__kopf">
                <SegmentedButton onSelectionChange={(e) => { setModus((e.detail.selectedItems[0] as HTMLElement).dataset.m as Modus); setMengen({}); }}>
                  <SegmentedButtonItem data-m="GAST" icon="customer" selected={modus === 'GAST'}>Gast</SegmentedButtonItem>
                  <SegmentedButtonItem data-m="MITGLIED" icon="employee" selected={modus === 'MITGLIED'}>Mitglied</SegmentedButtonItem>
                </SegmentedButton>
                <div><div className="portal-vz__kopf-label">Offene Gastbelege</div><div className="portal-vz__kopf-wert">{init.offen.length} · {eur(init.offen.reduce((s, b) => s + b.betrag, 0))}</div></div>
              </div>

              {modus === 'GAST' ? (
                <Section title={offenerBeleg ? `Gastbeleg ${offenerBeleg.rgnr} erweitern` : 'Neuer Gastbeleg'} actions={offenerBeleg && <Button design="Transparent" icon="add" onClick={() => gastWaehlen(null)}>Neuer Gast</Button>}>
                  {init.offen.length > 0 && !offenerBeleg && (
                    <div className="portal-vz__feld" style={{ marginBottom: '0.75rem' }}>
                      <Label>Offenen Beleg fortsetzen</Label>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
                        {init.offen.map((b) => (
                          <ToggleButton key={b.rgnr} pressed={false} onClick={() => gastWaehlen(b)}>{b.gast_name || b.gast_gruppe} · {eur(b.betrag)}</ToggleButton>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="portal-vz__aktionen" style={{ marginBottom: '0.75rem' }}>
                    <div className="portal-vz__feld"><Label required={!gast.gast_gruppe}>Name des Gastes</Label><Input value={gast.gast_name} onInput={(e) => setGast({ ...gast, gast_name: e.target.value })} style={{ width: '100%' }} /></div>
                    <div className="portal-vz__feld"><Label>Gruppe / Verein</Label><Input value={gast.gast_gruppe} onInput={(e) => setGast({ ...gast, gast_gruppe: e.target.value })} style={{ width: '100%' }} placeholder="z. B. Gastverein Medenspiel" /></div>
                    <div className="portal-vz__feld"><Label>E-Mail (für den Beleg)</Label><Input type="Email" value={gast.email} onInput={(e) => setGast({ ...gast, email: e.target.value })} style={{ width: '100%' }} /></div>
                    <div className="portal-vz__feld"><Label>Mobil (WhatsApp)</Label><Input type="Tel" value={gast.mobil} onInput={(e) => setGast({ ...gast, mobil: e.target.value })} style={{ width: '100%' }} /></div>
                  </div>
                  <Preiswahl liste={liste} mengen={mengen} setMengen={setMengen} gast busy={busy} aktion={buchen} aktionText={offenerBeleg ? 'Hinzufügen' : 'Beleg anlegen'}
                             zusatz={offenerBeleg && (
                               <div className="portal-vz__zeile" style={{ alignItems: 'center' }}>
                                 <span>Bisher auf dem Beleg: <strong>{eur(offenerBeleg.betrag)}</strong></span>
                                 <Button design="Emphasized" icon="payment-approval" disabled={busy || !offenerBeleg.betrag} onClick={() => setKasse(offenerBeleg)}>Kassieren</Button>
                               </div>
                             )} />
                </Section>
              ) : (
                <Section title="Verzehr für ein Mitglied anschreiben">
                  <div className="portal-vz__feld" style={{ marginBottom: '0.75rem' }}>
                    <Label required>Mitglied</Label>
                    <AuswahlBox eintraege={init.mitglieder.map((x) => ({ key: x.adrnr, text: x.name }))} wert={adrnr} onWaehle={(k) => setAdrnr(k ?? '')} placeholder="Name eingeben …" style={{ width: '100%' }} />
                  </div>
                  <Preiswahl liste={liste} mengen={mengen} setMengen={setMengen} gast={false} busy={busy || !adrnr} aktion={buchen} aktionText="Auf Konto anschreiben" />
                </Section>
              )}

              <Section title="Offene Gastbelege" count={init.offen.length} flush>
                {init.offen.length ? (
                  <div className="portal-vz__liste">
                    {init.offen.map((b) => (
                      <div key={b.rgnr} className="portal-vz__eintrag">
                        <div style={{ minWidth: 0 }}>
                          <div className="portal-vz__eintrag-titel">{b.gast_name || b.gast_gruppe}{b.gast_name && b.gast_gruppe ? ` · ${b.gast_gruppe}` : ''}</div>
                          <div className="portal-vz__eintrag-info"><span>{b.rgnr}</span><span>{dat(b.datum)}</span><span>{b.posten} Pos.</span>{b.datum < new Date().toLocaleDateString('sv-SE') && <ObjectStatus state="Critical">von einem früheren Abend</ObjectStatus>}</div>
                        </div>
                        <div className="portal-vz__eintrag-rechts">
                          <span>{eur(b.betrag)}</span>
                          <Button icon="detail-view" design="Transparent" tooltip="Positionen" onClick={() => belegOeffnen(b.rgnr)} />
                          <Button icon="payment-approval" design="Emphasized" disabled={busy || !b.betrag} onClick={() => setKasse(b)}>Kassieren</Button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : <Empty>Keine offenen Gastbelege.</Empty>}
              </Section>

              <Section title="Heute" count={heute.length} flush>
                {heute.length ? (
                  <div className="portal-vz__liste">
                    {heute.map((p) => (
                      <div key={p.id} className="portal-vz__eintrag" style={p.storniert_am ? { opacity: 0.55 } : undefined}>
                        <div style={{ minWidth: 0 }}>
                          <div className="portal-vz__eintrag-titel">{p.anzahl} × {p.text} <span style={{ fontWeight: 400 }}>· {p.person}</span></div>
                          <div className="portal-vz__eintrag-info">
                            <span>{p.zeit}</span><span>{p.gast ? `Gast ${p.beleg_rgnr ?? ''}` : 'Mitgliedskonto'}</span>
                            <ObjectStatus state={STATUS_STATE[p.status]}>{STATUS_TEXT[p.status]}</ObjectStatus>
                            {p.storno_grund && <span>{p.storno_grund}</span>}
                          </div>
                        </div>
                        <div className="portal-vz__eintrag-rechts">
                          <span>{eur(p.betrag)}</span>
                          {p.status === 'OFFEN' && (
                            <Button icon="delete" design="Transparent" tooltip="Stornieren" disabled={busy}
                                    onClick={() => aktion(() => api.post(`${VZ}/theke/storno`, { id: p.id, grund: 'Theke' }), 'Position storniert.')} />
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : <Empty>Heute noch keine Positionen.</Empty>}
              </Section>
              {init.heute.some((b) => b.status === 'BEZAHLT') && (
                <Section title="Heute kassiert" count={init.heute.filter((b) => b.status === 'BEZAHLT').length} flush>
                  <div className="portal-vz__liste">
                    {init.heute.filter((b) => b.status === 'BEZAHLT').map((b) => (
                      <div key={b.rgnr} className="portal-vz__eintrag">
                        <div style={{ minWidth: 0 }}>
                          <div className="portal-vz__eintrag-titel">{b.gast_name || b.gast_gruppe}</div>
                          <div className="portal-vz__eintrag-info"><span>{b.rgnr}</span><span>{b.zahlart ? ZAHLART_TEXT[b.zahlart] : ''}</span>{b.versand_art && <span>gesendet ({b.versand_art === 'MAIL' ? 'E-Mail' : 'WhatsApp'})</span>}</div>
                        </div>
                        <div className="portal-vz__eintrag-rechts"><span>{eur(b.betrag)}</span><Button icon="pdf-attachment" design="Transparent" tooltip="Beleg" onClick={() => belegOeffnen(b.rgnr)} /></div>
                      </div>
                    ))}
                  </div>
                </Section>
              )}
            </div>
          </BusyIndicator>
        )}
      </div>

      {kasse && <KasseDialog beleg={kasse} busy={busy} onClose={() => setKasse(null)} onKassieren={async (zahlart) => {
        let erg: { text: string; warnungen: string[]; beleg: Beleg } | null = null;
        const ok = await aktion(async () => { erg = await api.post(`${VZ}/theke/kassieren`, { rgnr: kasse.rgnr, zahlart }); });
        setKasse(null);
        if (ok && erg) { const e = erg as { text: string; warnungen: string[]; beleg: Beleg }; toast(e.text, 5000); warnen(e.warnungen); gastWaehlen(null); setDetail({ beleg: e.beleg, posten: await api.get<{ posten: Posten[] }>(`${VZ}/belege/${kasse.rgnr}`).then((r) => r.posten) }); }
      }} />}
      {detail && <BelegDialog d={detail} busy={busy} mail={init?.mail ?? false} paperless={init?.paperless ?? false} admin={admin} onClose={() => setDetail(null)}
                              onPdf={() => pdfZeigen(detail.beleg.rgnr)}
                              onMail={async (an) => { let t = ''; if (await aktion(async () => { const r = await api.post<{ text: string; warnungen: string[] }>(`${VZ}/belege/${detail.beleg.rgnr}/mail`, { an: an || null }); t = r.text; warnen(r.warnungen); })) { toast(t, 5000); setDetail(null); } }}
                              onWhatsapp={async (mobil) => {
                                const win = window.open('about:blank', '_blank');
                                try { const r = await api.post<{ url: string }>(`${VZ}/belege/${detail.beleg.rgnr}/whatsapp`, { mobil: mobil || null }); if (win) win.location.href = r.url; else window.open(r.url, '_blank'); laden(); }
                                catch (e) { win?.close(); setError((e as Error).message); }
                              }}
                              onStorno={async () => { if (await aktion(() => api.post(`${VZ}/belege/${detail.beleg.rgnr}/storno`, { grund: 'Theke' }), 'Beleg storniert.')) setDetail(null); }} />}
      {pdf && <PdfDialog url={pdf.url} title={pdf.titel} filename={`${pdf.titel.replace(/[^\wäöüÄÖÜß-]+/g, '_')}.pdf`} onClose={() => setPdf(null)} />}
    </AppPage>
  );
}

function KasseDialog({ beleg, busy, onClose, onKassieren }: { beleg: Beleg; busy: boolean; onClose: () => void; onKassieren: (z: Zahlart) => void }) {
  const [zahlart, setZahlart] = useState<Zahlart>('BAR');
  return createPortal(
    <Dialog open headerText={`${eur(beleg.betrag)} kassieren`} onClose={onClose}
            footer={<Bar endContent={<><Button design="Emphasized" icon="payment-approval" disabled={busy} onClick={() => onKassieren(zahlart)}>Kassiert – Beleg erstellen</Button><Button onClick={onClose}>Abbrechen</Button></>} />}>
      <div className="portal-vz__form" style={{ maxWidth: '24rem' }}>
        <Text>{beleg.gast_name || beleg.gast_gruppe}{beleg.gast_name && beleg.gast_gruppe ? ` · ${beleg.gast_gruppe}` : ''} · {beleg.rgnr}</Text>
        <div className="portal-vz__feld">
          <Label>Bezahlt per</Label>
          <div className="portal-vz__aktionen portal-vz__aktionen--3">
            {(['BAR', 'KARTE', 'PAYPAL'] as Zahlart[]).map((z) => (
              <ToggleButton key={z} pressed={zahlart === z} design={zahlart === z ? 'Emphasized' : 'Default'} onClick={() => setZahlart(z)}>{ZAHLART_TEXT[z]}</ToggleButton>
            ))}
          </div>
        </div>
        <Text className="portal-muted portal-small">Nach dem Kassieren kannst du den Beleg als PDF zeigen oder per E-Mail/WhatsApp senden.</Text>
      </div>
    </Dialog>,
    document.body,
  );
}

function BelegDialog({ d, busy, mail, paperless, admin, onClose, onPdf, onMail, onWhatsapp, onStorno }: {
  d: { beleg: Beleg; posten: Posten[] }; busy: boolean; mail: boolean; paperless: boolean; admin: boolean; onClose: () => void;
  onPdf: () => void; onMail: (an: string) => void; onWhatsapp: (mobil: string) => void; onStorno: () => void;
}) {
  const b = d.beleg;
  const [an, setAn] = useState(b.email ?? '');
  const [mobil, setMobil] = useState(b.mobil ?? '');
  return createPortal(
    <Dialog open stretch={klein()} headerText={`Beleg ${b.rgnr}`} onClose={onClose}
            footer={<Bar startContent={admin && b.status !== 'STORNIERT' ? <Button design="Negative" icon="delete" disabled={busy} onClick={onStorno}>Beleg stornieren</Button> : undefined}
                         endContent={<Button onClick={onClose}>Schließen</Button>} />}>
      <div className="portal-vz__form">
        <div className="portal-vz__zeile"><span><strong>{b.gast_name || b.gast_gruppe || b.person}</strong>{b.gast_name && b.gast_gruppe ? ` · ${b.gast_gruppe}` : ''}</span><ObjectStatus state={STATUS_STATE[b.status]} inverted>{STATUS_TEXT[b.status]}{b.zahlart ? ` · ${ZAHLART_TEXT[b.zahlart]}` : ''}</ObjectStatus></div>
        <div className="portal-vz__liste" style={{ border: '1px solid var(--sapList_BorderColor)', borderRadius: '0.5rem' }}>
          {d.posten.filter((p) => !p.storniert_am).map((p) => (
            <div key={p.id} className="portal-vz__eintrag"><span>{p.anzahl} × {p.text}</span><span>{eur(p.betrag)}</span></div>
          ))}
          <div className="portal-vz__eintrag"><strong>Gesamt</strong><strong>{eur(b.betrag)}</strong></div>
        </div>
        <div className="portal-vz__aktionen portal-vz__aktionen--3">
          <Button icon="pdf-attachment" onClick={onPdf}>PDF</Button>
          <Button icon="email" disabled={!mail || busy} tooltip={mail ? undefined : 'E-Mail-Versand (n8n) nicht eingerichtet'} onClick={() => onMail(an)}>E-Mail</Button>
          <Button icon="discussion" disabled={!paperless || busy} tooltip={paperless ? undefined : 'Für WhatsApp wird Paperless benötigt'} onClick={() => onWhatsapp(mobil)}>WhatsApp</Button>
        </div>
        <div className="portal-vz__aktionen">
          <div className="portal-vz__feld"><Label>E-Mail an</Label><Input type="Email" value={an} onInput={(e) => setAn(e.target.value)} style={{ width: '100%' }} /></div>
          <div className="portal-vz__feld"><Label>Mobilnummer</Label><Input type="Tel" value={mobil} onInput={(e) => setMobil(e.target.value)} style={{ width: '100%' }} /></div>
        </div>
      </div>
    </Dialog>,
    document.body,
  );
}
