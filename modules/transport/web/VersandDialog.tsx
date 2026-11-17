import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  Bar, BusyIndicator, Button, CheckBox, Dialog, Input, Label, MessageStrip, ObjectStatus, SegmentedButton, SegmentedButtonItem, Text, TextArea, Title,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { toast } from '@core/toast';
import { useCan } from '@core/session';
import { DialogFuss } from '@core/components/DialogFuss';
import { T } from './util';
import { dateienImOrdner, dateiLesen } from './ordner';
import { emlHerunterladen } from './MailEntwurf';

/**
 * Dialog „Versenden…“ (Sammelversand über Outlook 365 und n8n) – Vertrag: docs/euroflex-mailworkflows.md, „Ausgang (Sammelversand)“.
 * Links Dokumentarten (und bei einem Auftrag weitere Dateien), rechts die Vorschau: eine E-Mail je Auftrag und Empfänger.
 * Der Server erzeugt die PDFs und entscheidet über den Modus; die Oberfläche zeigt ihn nur an.
 */
type Art = 'T' | 'L' | 'R';
type Modus = 'entwurf' | 'senden';
type Rolle = 'unternehmer' | 'kunde' | 'rechnungsempfaenger';
interface Einstellungen {
  vorauswahl: Art[]; modus: Record<Art, Modus>; senden_erlaubt: boolean; eingerichtet: boolean; postfach: string | null; kopie_an: string; max_mb: number;
}
interface VorschauMail {
  schluessel: string; auftragsnr: string; fahrt?: number; rolle: Rolle; empfaenger_name: string | null;
  an: string; cc: string; betreff: string; text: string; arten: Art[]; anhaenge: { name: string; groesse: number }[]; modus: Modus;
  fehler?: string; hinweis?: string;
  /** Rechnungsversand: Absender-Postfach und BCC dieser E-Mail */
  absender?: string; bcc?: string;
}
interface Vorschau { mails: VorschauMail[]; senden_erlaubt: boolean }
interface Ergebnis { schluessel: string; status: 'entwurf' | 'gesendet' | 'fehler'; text: string }
type Bearbeitung = Pick<VorschauMail, 'an' | 'cc' | 'betreff' | 'text'>;
interface Weitere { key: string; name: string; quelle: 'ORDNER' | 'PAPERLESS'; docId?: number; groesse?: number }

const ARTEN: { art: Art; text: string; an: string }[] = [
  { art: 'T', text: 'Transportauftrag', an: 'je Fahrt → Unternehmer' },
  { art: 'L', text: 'Lieferschein', an: '→ Kunde' },
  { art: 'R', text: 'Rechnung + ZUGFeRD', an: '→ Rechnungsempfänger (sonst Kunde)' },
];
const ROLLE_TEXT: Record<Rolle, string> = { unternehmer: 'Unternehmer', kunde: 'Kunde', rechnungsempfaenger: 'Rechnungsempfänger' };
const STANDARD: Einstellungen = { vorauswahl: ['T', 'L'], modus: { T: 'entwurf', L: 'entwurf', R: 'entwurf' }, senden_erlaubt: false, eingerichtet: false, postfach: null, kopie_an: '', max_mb: 10 };
const groesse = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB`);
const datenUrl = (f: Blob) => new Promise<string>((ok, err) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result));
  r.onerror = () => err(r.error);
  r.readAsDataURL(f);
});
const base64Blob = (b64: string, typ: string) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: typ });
};
const td: CSSProperties = { padding: '0.4rem 0.5rem', verticalAlign: 'top' };

export function VersandDialog({ auftraege, open, onClose }: { auftraege: string[]; open: boolean; onClose: () => void }) {
  const [einst, setEinst] = useState<Einstellungen | null>(null);
  const [arten, setArten] = useState<Set<Art>>(new Set());
  const [xrechnung, setXrechnung] = useState(false);
  const [vorschau, setVorschau] = useState<Vorschau | null>(null);
  const [laden, setLaden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aenderungen, setAenderungen] = useState<Record<string, Bearbeitung>>({});
  const [weg, setWeg] = useState<'entwurf' | 'einstellung'>('entwurf');
  const [ergebnisse, setErgebnisse] = useState<Record<string, Ergebnis>>({});
  const [aktiv, setAktiv] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [weitere, setWeitere] = useState<Weitere[] | null>(null);
  const [wahl, setWahl] = useState<Set<string>>(new Set());
  const anfrage = useRef(0);
  // Recht transport.dialoge:execute (Funktionsschalter transport.dialoge.schliessen): Versand auslösen schließt den Dialog sofort, Ergebnis kommt als Meldung
  const direkt = useCan()('transport.dialoge:execute');
  const fehler = (text: string) => (direkt ? toast(`Versand fehlgeschlagen: ${text}`, 12000) : setError(text));
  const einzel = auftraege.length === 1 ? auftraege[0] : null;
  const schluessel = auftraege.join(',');

  // Beim Öffnen: Vorauswahl aus den Einstellungen (GET /versand/einstellungen, Recht versand:execute) – ohne Antwort Standard T + L
  useEffect(() => {
    if (!open) return;
    setVorschau(null); setError(null); setAenderungen({}); setErgebnisse({}); setAktiv(null); setXrechnung(false); setWahl(new Set()); setWeitere(null);
    let aus = false;
    api.get<Einstellungen>(`${T}/versand/einstellungen`)
      .then((e) => { if (aus) return; setEinst(e); setArten(new Set(e.vorauswahl)); setWeg(e.senden_erlaubt ? 'einstellung' : 'entwurf'); })
      .catch(() => { if (aus) return; setEinst(STANDARD); setArten(new Set(STANDARD.vorauswahl)); setWeg('entwurf'); });
    return () => { aus = true; };
  }, [open, schluessel]);

  // Weitere Auftragsdateien nur bei einem Auftrag: Ablageordner und Paperless-Dokumente
  useEffect(() => {
    if (!open || !einzel) return;
    let aus = false;
    (async () => {
      const ordner = await dateienImOrdner(einzel).catch(() => null);
      const pl = await api.get<{ dokumente: { doc_id: number; titel: string | null; datei: string | null }[] }>(`${T}/auftraege/${encodeURIComponent(einzel)}/dokumente`)
        .catch(() => ({ dokumente: [] }));
      if (aus) return;
      setWeitere([
        ...(ordner?.dateien ?? []).filter((f) => !/\.eml$/i.test(f.name)).map((f) => ({ key: `O:${f.name}`, name: f.name, quelle: 'ORDNER' as const, groesse: f.groesse })),
        ...pl.dokumente.map((d) => ({ key: `P:${d.doc_id}`, name: d.datei || d.titel || `Dokument_${d.doc_id}.pdf`, quelle: 'PAPERLESS' as const, docId: d.doc_id })),
      ]);
    })();
    return () => { aus = true; };
  }, [open, einzel]);

  const artenListe = useMemo(() => ARTEN.map((a) => a.art).filter((a) => arten.has(a)), [arten]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Aufträge über ihren Schlüssel, nicht über die Array-Identität
  const auswahl = useMemo(() => ({ auftraege, arten: artenListe, xrechnung: xrechnung && artenListe.includes('R') }), [schluessel, artenListe, xrechnung]);

  // Vorschau neu rechnen, sobald sich die Auswahl ändert (Bearbeitungen je Schlüssel bleiben erhalten)
  useEffect(() => {
    if (!open || !einst) return;
    if (!artenListe.length) { setVorschau({ mails: [], senden_erlaubt: einst.senden_erlaubt }); return; }
    const nr = ++anfrage.current;
    setLaden(true); setError(null);
    const t = setTimeout(() => {
      api.post<Vorschau>(`${T}/versand/vorschau`, auswahl)
        .then((v) => { if (nr === anfrage.current) { setVorschau(v); setErgebnisse({}); } })
        .catch((e) => { if (nr === anfrage.current) setError((e as Error).message); })
        .finally(() => { if (nr === anfrage.current) setLaden(false); });
    }, 250);
    return () => clearTimeout(t);
  }, [open, einst, auswahl, artenListe.length]);

  const mails = vorschau?.mails ?? [];
  const sendenErlaubt = !!vorschau?.senden_erlaubt;
  const wert = (m: VorschauMail): Bearbeitung => aenderungen[m.schluessel] ?? { an: m.an, cc: m.cc, betreff: m.betreff, text: m.text };
  const modus = (m: VorschauMail): Modus => (weg === 'entwurf' || !sendenErlaubt ? 'entwurf' : m.modus);
  /** Dokumente erzeugt und Empfänger vorhanden */
  const sendbar = (m: VorschauMail) => m.anhaenge.length > 0 && !!wert(m).an.trim();
  const erledigt = (m: VorschauMail) => ergebnisse[m.schluessel] && ergebnisse[m.schluessel].status !== 'fehler';
  const offen = mails.filter((m) => sendbar(m) && !erledigt(m));
  const nachFehler = Object.values(ergebnisse).some((e) => e.status === 'fehler');
  const anzahlSenden = offen.filter((m) => modus(m) === 'senden').length;
  const anzahlEntwurf = offen.length - anzahlSenden;
  const hauptText = nachFehler ? `Fehlgeschlagene erneut ${anzahlSenden ? 'senden' : 'erzeugen'} (${offen.length})`
    : !anzahlSenden ? `${anzahlEntwurf} ${anzahlEntwurf === 1 ? 'Entwurf' : 'Entwürfe'} erzeugen`
    : !anzahlEntwurf ? `${anzahlSenden} ${anzahlSenden === 1 ? 'E-Mail' : 'E-Mails'} senden`
    : `${anzahlSenden} senden, ${anzahlEntwurf} als Entwurf`;

  const aendern = (m: VorschauMail, feld: keyof Bearbeitung, v: string) => setAenderungen((a) => ({ ...a, [m.schluessel]: { ...wert(m), [feld]: v } }));
  const artUmschalten = (a: Art, an: boolean) => setArten((s) => { const n = new Set(s); if (an) n.add(a); else n.delete(a); return n; });
  const wahlUmschalten = (k: string, an: boolean) => setWahl((w) => { const n = new Set(w); if (an) n.add(k); else n.delete(k); return n; });

  /** Dateien aus dem Ablageordner (Base64) und Paperless-Ids für den einen Auftrag */
  async function zusatzLaden() {
    const zusatz: { name: string; mime: string; inhalt_base64: string }[] = [];
    const paperless: number[] = [];
    if (!einzel || !weitere) return { zusatz, paperless };
    let bytes = 0;
    for (const x of weitere.filter((y) => wahl.has(y.key))) {
      if (x.quelle === 'PAPERLESS') { paperless.push(x.docId!); continue; }
      const f = await dateiLesen(einzel, x.name);
      if (!f) throw new Error(`${x.name} ist im Ablageordner nicht mehr vorhanden.`);
      bytes += f.size;
      if (einst && bytes > einst.max_mb * 1024 * 1024) throw new Error(`Die zusätzlichen Dateien sind zusammen größer als ${einst.max_mb} MB – bitte weniger Dateien wählen.`);
      zusatz.push({ name: x.name, mime: f.type, inhalt_base64: await datenUrl(f) });
    }
    return { zusatz, paperless };
  }

  async function ausfuehren() {
    if (!offen.length) return;
    setBusy(true); setError(null);
    if (direkt) { onClose(); toast(`${offen.length} ${offen.length === 1 ? 'E-Mail wird' : 'E-Mails werden'} erzeugt …`, 4000); }
    try {
      const { zusatz, paperless } = await zusatzLaden();
      const r = await api.post<{ ergebnisse: Ergebnis[] }>(`${T}/versand/ausfuehren`, {
        ...auswahl, nur_entwurf: weg === 'entwurf', zusatz, paperless,
        mails: offen.map((m) => ({ schluessel: m.schluessel, ...wert(m) })),
      });
      const neu = { ...ergebnisse };
      for (const e of r.ergebnisse) neu[e.schluessel] = e;
      setErgebnisse(neu);
      const gut = r.ergebnisse.filter((e) => e.status !== 'fehler').length;
      const schlecht = r.ergebnisse.length - gut;
      if (schlecht && direkt) {
        const texte = r.ergebnisse.filter((e) => e.status === 'fehler').map((e) => `${mails.find((m) => m.schluessel === e.schluessel)?.auftragsnr ?? e.schluessel}: ${e.text}`);
        toast(`${gut} erledigt, ${schlecht} fehlgeschlagen – ${texte.join(' · ')}. „Versenden …“ erneut öffnen, um es zu wiederholen.`, 15000);
      } else {
        toast(schlecht ? `${gut} erledigt, ${schlecht} fehlgeschlagen – Details in der Tabelle.` : `${gut} E-Mail(s) erledigt.`, 6000);
      }
    } catch (e) { fehler((e as Error).message); } finally { setBusy(false); }
  }

  /** Rückfallweg: je E-Mail eine EML-Datei (Entwurf), auch für Zeilen ohne Empfänger */
  async function eml() {
    const liste = mails.filter((m) => m.anhaenge.length > 0);
    if (!liste.length) return;
    setBusy(true); setError(null);
    if (direkt) onClose();
    try {
      const { zusatz, paperless } = await zusatzLaden();
      const r = await api.post<{ dateien: { name: string; inhalt_base64: string }[] }>(`${T}/versand/eml`, {
        ...auswahl, zusatz, paperless, mails: liste.map((m) => ({ schluessel: m.schluessel, ...wert(m) })),
      });
      for (const d of r.dateien) emlHerunterladen(base64Blob(d.inhalt_base64, 'message/rfc822'), d.name.replace(/\.eml$/i, ''));
      toast(`${r.dateien.length} E-Mail-Datei(en) heruntergeladen – in den Downloads öffnen.`, 6000);
    } catch (e) { fehler((e as Error).message); } finally { setBusy(false); }
  }

  const aktivMail = mails.find((m) => m.schluessel === aktiv) ?? null;
  const ohneAnbindung = einst && !einst.eingerichtet;

  if (!open) return null;
  return createPortal(
    <Dialog open style={{ width: 'min(84rem, 96vw)' }} onClose={onClose}
            header={<Bar startContent={<Title level="H5">Versenden – {auftraege.length} {auftraege.length === 1 ? 'Auftrag' : 'Aufträge'}</Title>}
                         endContent={<ObjectStatus state="Information" inverted>über Outlook 365 (n8n)</ObjectStatus>} />}
            footer={<DialogFuss>
              <SegmentedButton onSelectionChange={(e) => setWeg((e.detail.selectedItems[0] as HTMLElement).dataset.weg as 'entwurf' | 'einstellung')}>
                <SegmentedButtonItem data-weg="entwurf" selected={weg === 'entwurf'}>In Outlook-Entwürfe legen</SegmentedButtonItem>
                <SegmentedButtonItem data-weg="einstellung" selected={weg === 'einstellung'} disabled={!sendenErlaubt}
                                     tooltip={sendenErlaubt ? 'Je Dokumentart wie in den Einstellungen (Entwurf oder Senden)' : 'Direkt senden ist nicht freigegeben (Funktion „Automatisch senden“ und Recht nötig)'}>
                  Einstellung (senden)
                </SegmentedButtonItem>
              </SegmentedButton>
              <Button icon="download" disabled={busy || laden || !mails.some((m) => m.anhaenge.length)} onClick={eml}
                      tooltip="Je E-Mail eine E-Mail-Datei (.eml), die das Mailprogramm als Entwurf öffnet">Als EML herunterladen</Button>
              <Button onClick={onClose}>{Object.keys(ergebnisse).length ? 'Schließen' : 'Abbrechen'}</Button>
              <Button design="Emphasized" icon={anzahlSenden ? 'paper-plane' : 'write-new'} loading={busy}
                      disabled={busy || laden || !offen.length || !!ohneAnbindung} onClick={ausfuehren}>{hauptText}</Button>
            </DialogFuss>}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(15rem, 20rem) minmax(0, 1fr)', gap: '1rem', minHeight: '24rem' }}>
        {/* links: Dokumentarten und weitere Dateien */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <Title level="H6">Dokumente</Title>
          {ARTEN.map((a) => (
            <div key={a.art} style={{ display: 'flex', flexDirection: 'column' }}>
              <CheckBox text={a.text} checked={arten.has(a.art)} disabled={busy} onChange={(e) => artUmschalten(a.art, e.target.checked)} />
              <Text className="portal-muted portal-small" style={{ paddingLeft: '2.25rem', marginTop: '-0.5rem' }}>{a.an}</Text>
            </div>
          ))}
          <CheckBox text="XRechnung zusätzlich (XML)" checked={xrechnung && arten.has('R')} disabled={busy || !arten.has('R')} onChange={(e) => setXrechnung(e.target.checked)} />
          <Text className="portal-muted portal-small">Rechnungen nur bei fakturierten Aufträgen; eine Sammelrechnung geht einmal hinaus.</Text>
          {einzel && <>
            <Title level="H6" style={{ marginTop: '0.75rem' }}>Weitere Auftragsdateien</Title>
            {weitere === null ? <Text className="portal-muted">Lade Dateien …</Text> : !weitere.length ? (
              <Text className="portal-muted portal-small">Keine Dateien im Ablageordner oder in Paperless.</Text>
            ) : weitere.map((x) => (
              <div key={x.key} style={{ display: 'flex', flexDirection: 'column' }}>
                <CheckBox text={x.name} checked={wahl.has(x.key)} disabled={busy} onChange={(e) => wahlUmschalten(x.key, e.target.checked)} />
                <Text className="portal-muted portal-small" style={{ paddingLeft: '2.25rem', marginTop: '-0.5rem' }}>
                  {x.quelle === 'ORDNER' ? `Ablageordner${x.groesse ? ` · ${groesse(x.groesse)}` : ''}` : `Paperless ${x.docId}`}
                </Text>
              </div>
            ))}
            {!!wahl.size && <Text className="portal-muted portal-small">Gewählte Dateien hängen an jeder E-Mail dieses Auftrags.</Text>}
          </>}
        </div>

        {/* rechts: Vorschau der E-Mails */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', minWidth: 0 }}>
          {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
          {ohneAnbindung && (
            <MessageStrip design="Critical" hideCloseButton>
              Der Versand über Outlook 365 ist nicht eingerichtet (Administration → Schnittstellen → Euroflex E-Mail-Versand) – „Als EML herunterladen“ geht trotzdem.
            </MessageStrip>
          )}
          {einst?.eingerichtet && !einst.postfach && (
            <MessageStrip design="Critical" hideCloseButton>Für Ihren Benutzer ist kein Postfach hinterlegt – Entwürfe und Senden schlagen fehl.</MessageStrip>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Title level="H6">Vorschau: {mails.length} {mails.length === 1 ? 'E-Mail' : 'E-Mails'}</Title>
            {laden && <BusyIndicator active size="S" />}
            {einst?.postfach && <Text className="portal-muted portal-small">aus {einst.postfach}{einst.kopie_an ? ` · Kopie an ${einst.kopie_an}` : ''}</Text>}
          </div>
          <div className="portal-tabrahmen" style={{ overflow: 'auto', maxHeight: '22rem' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--sapList_BorderColor)' }}>
                  <th style={td}>Auftrag</th><th style={td}>An</th><th style={td}>Betreff</th><th style={td}>Anhänge</th><th style={td}>Modus</th><th style={td}>Status</th>
                </tr>
              </thead>
              <tbody>
                {mails.map((m) => {
                  const w = wert(m);
                  const e = ergebnisse[m.schluessel];
                  const ohneAn = !w.an.trim();
                  const kaputt = !m.anhaenge.length;
                  return (
                    <tr key={m.schluessel} onClick={() => setAktiv(m.schluessel === aktiv ? null : m.schluessel)}
                        style={{ cursor: 'pointer', borderBottom: '1px solid var(--sapList_BorderColor)',
                          background: m.schluessel === aktiv ? 'var(--sapList_SelectionBackgroundColor)' : ohneAn || kaputt ? 'var(--sapErrorBackground)' : undefined }}>
                      <td style={td}><Text>{m.auftragsnr}</Text></td>
                      <td style={td}>
                        <Text style={{ display: 'block', color: ohneAn ? 'var(--sapNegativeTextColor)' : undefined }}>{ohneAn ? 'Empfänger fehlt' : w.an}</Text>
                        <Text className="portal-muted portal-small">{ROLLE_TEXT[m.rolle]}{m.fahrt ? ` · Fahrt ${m.fahrt}` : ''}{m.empfaenger_name ? ` · ${m.empfaenger_name}` : ''}{w.cc ? ` · CC ${w.cc}` : ''}</Text>
                      </td>
                      <td style={td}><Text>{w.betreff}</Text></td>
                      <td style={td}>
                        {kaputt ? <Text style={{ color: 'var(--sapNegativeTextColor)' }}>{m.fehler ?? 'fehlt'}</Text>
                          : m.anhaenge.map((a) => <Text key={a.name} className="portal-small" style={{ display: 'block' }}>{a.name} ({groesse(a.groesse)})</Text>)}
                        {!!wahl.size && !kaputt && <Text className="portal-muted portal-small" style={{ display: 'block' }}>+ {wahl.size} weitere Datei(en)</Text>}
                        {(m.absender || m.bcc) && <Text className="portal-small portal-muted" style={{ display: 'block' }}>{m.absender ? `von ${m.absender}` : ''}{m.absender && m.bcc ? ' · ' : ''}{m.bcc ? `BCC ${m.bcc}` : ''}</Text>}
                        {m.hinweis && <Text className="portal-small" style={{ display: 'block', color: 'var(--sapCriticalTextColor)' }}>{m.hinweis}</Text>}
                      </td>
                      <td style={td}><ObjectStatus state={modus(m) === 'senden' ? 'Critical' : 'None'}>{modus(m) === 'senden' ? 'Senden' : 'Entwurf'}</ObjectStatus></td>
                      <td style={td}>
                        {e ? <ObjectStatus state={e.status === 'fehler' ? 'Negative' : 'Positive'} inverted title={e.text}>
                               {e.status === 'fehler' ? 'Fehler' : e.status === 'gesendet' ? 'gesendet' : 'Entwurf'}
                             </ObjectStatus>
                          : ohneAn || kaputt ? <ObjectStatus state="Negative">wird übersprungen</ObjectStatus>
                          : <Text className="portal-muted">bereit</Text>}
                        {e?.status === 'fehler' && <Text className="portal-small" style={{ display: 'block', color: 'var(--sapNegativeTextColor)' }}>{e.text}</Text>}
                      </td>
                    </tr>
                  );
                })}
                {!mails.length && !laden && (
                  <tr><td style={td} colSpan={6}><Text className="portal-muted">{artenListe.length ? 'Keine E-Mails für diese Auswahl.' : 'Bitte mindestens eine Dokumentart wählen.'}</Text></td></tr>
                )}
              </tbody>
            </table>
          </div>
          {aktivMail ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))', gap: '0.5rem', borderTop: '1px solid var(--sapList_BorderColor)', paddingTop: '0.5rem' }}>
              <div><Label required>An</Label><Input style={{ width: '100%' }} value={wert(aktivMail).an} disabled={busy || !!erledigt(aktivMail)} placeholder="E-Mail-Adresse, mehrere durch Komma"
                                                  onInput={(e) => aendern(aktivMail, 'an', e.target.value)} /></div>
              <div><Label>CC</Label><Input style={{ width: '100%' }} value={wert(aktivMail).cc} disabled={busy || !!erledigt(aktivMail)} placeholder="weitere Empfänger, durch Komma getrennt"
                                           onInput={(e) => aendern(aktivMail, 'cc', e.target.value)} /></div>
              <div style={{ gridColumn: '1 / -1' }}><Label required>Betreff</Label><Input style={{ width: '100%' }} maxlength={200} value={wert(aktivMail).betreff} disabled={busy || !!erledigt(aktivMail)}
                                                                                           onInput={(e) => aendern(aktivMail, 'betreff', e.target.value)} /></div>
              <div style={{ gridColumn: '1 / -1' }}><Label>Text</Label><TextArea style={{ width: '100%' }} rows={6} value={wert(aktivMail).text} disabled={busy || !!erledigt(aktivMail)}
                                                                                   onInput={(e) => aendern(aktivMail, 'text', e.target.value)} /></div>
            </div>
          ) : !!mails.length && (
            <Text className="portal-muted portal-small">Zeile anklicken, um Empfänger, CC, Betreff und Text dieser E-Mail zu ändern. Zeilen ohne Empfänger werden übersprungen.</Text>
          )}
        </div>
      </div>
    </Dialog>,
    document.body,
  );
}
