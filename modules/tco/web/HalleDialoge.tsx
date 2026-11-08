import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bar, BusyIndicator, Button, CheckBox, Dialog, FlexBox, Input, Label, Link, MessageStrip, Option,
  Select, Text, TextArea, Title,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { H, RG_STATUS, dat, eur, type PaperlessInfo, type PersonDetail, type Rechnung } from './util';

const portal = (el: React.ReactElement) => createPortal(el, document.body);

function Feld({ label, children, required }: { label: string; children: React.ReactNode; required?: boolean }) {
  return (
    <FlexBox direction="Column" style={{ marginBottom: '0.75rem' }}>
      <Label required={required} showColon>{label}</Label>
      {children}
    </FlexBox>
  );
}

// ---------------------------------------------------------------------------
// Manuelle Position
// ---------------------------------------------------------------------------
interface Produkt { prod_key: string; valid_from: string; valid_to: string; text: string; preis: number; typ: string | null }

export function PositionDialog({ open, rgnr, onClose, onSaved }: { open: boolean; rgnr: string | null; onClose: () => void; onSaved: (t: string) => void }) {
  const [produkte, setProdukte] = useState<Produkt[]>([]);
  const [key, setKey] = useState('');
  const [text, setText] = useState('');
  const [menge, setMenge] = useState('1');
  const [preis, setPreis] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKey(''); setText(''); setMenge('1'); setPreis(''); setError(null);
    const h = new Date().toISOString().slice(0, 10);
    api.get<{ produkte: Produkt[] }>(`${H}/preise`).then((r) => setProdukte(r.produkte.filter((p) => p.valid_from <= h && p.valid_to >= h)));
  }, [open]);

  const p = produkte.find((x) => x.prod_key === key);
  const frei = key === '093';

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ text: string }>(`${H}/rechnungen/${encodeURIComponent(rgnr!)}/positionen`, {
        prod_key: key, beschreibung: text || null, menge, preis: frei ? preis : null,
      });
      onSaved(r.text);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return portal(
    <Dialog open={open} headerText={`Neue Position zu ${rgnr ?? ''}`} onClose={onClose} style={{ width: 'min(34rem, 95vw)' }}
            footer={<Bar endContent={<>
              <Button design="Emphasized" loading={busy} disabled={!key} onClick={save}>Übernehmen</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.75rem' }}>{error}</MessageStrip>}
      <Feld label="Produkt" required>
        <Select onChange={(e) => {
          const k = (e.detail.selectedOption as HTMLElement).dataset.k!;
          setKey(k);
          const pr = produkte.find((x) => x.prod_key === k);
          setText(k === '093' ? '' : pr?.text ?? '');
          setPreis(pr ? String(pr.preis).replace('.', ',') : '');
        }}>
          <Option data-k="" selected={!key}>Produkt wählen …</Option>
          {produkte.map((x) => <Option key={x.prod_key} data-k={x.prod_key} selected={x.prod_key === key}>{x.prod_key} – {x.text} ({eur(x.preis)})</Option>)}
        </Select>
      </Feld>
      <Feld label="Beschreibung (erscheint auf der Rechnung)" required={frei}>
        <Input value={text} maxlength={40} onInput={(e) => setText(e.target.value)} />
      </Feld>
      <FlexBox style={{ gap: '1rem' }}>
        <Feld label="Menge" required><Input value={menge} onInput={(e) => setMenge(e.target.value)} style={{ width: '8rem' }} /></Feld>
        <Feld label="Einzelpreis (EUR)" required={frei}>
          <Input value={preis} readonly={!frei} onInput={(e) => setPreis(e.target.value)} style={{ width: '10rem' }} />
        </Feld>
      </FlexBox>
      {p && (p.prod_key === '008' || p.prod_key === '009') && (
        <MessageStrip hideCloseButton>Die Schlüsselliste wird mit dem Anlagedatum der Rechnung fortgeschrieben ({p.prod_key === '008' ? 'Ausgabe' : 'Rücknahme'}).</MessageStrip>
      )}
      {frei && <MessageStrip hideCloseButton>„Sonstiges“: Text und Preis frei, der Preis darf negativ sein (Gutschrift).</MessageStrip>}
    </Dialog>,
  );
}

// ---------------------------------------------------------------------------
// E-Mail-Versand über n8n
// ---------------------------------------------------------------------------
interface MailText { an: string; mobil: string; link: string | null; betreff: string; text: string; whatsapp: string }

function RechnungsAuswahl({ detail, auswahl, setAuswahl }: { detail: PersonDetail | null; auswahl: string[]; setAuswahl: (a: string[]) => void }) {
  const offen = (detail?.rechnungen ?? []).filter((r) => !['4', '6'].includes(r.status));
  return (
    <FlexBox direction="Column">
      {offen.map((r) => (
        <CheckBox key={r.rgnr_txt} checked={auswahl.includes(r.rgnr_txt)}
                  text={`${r.rgnr_txt} · ${eur(r.betrag)} · ${RG_STATUS[r.status]} · ${r.doknr ? `Paperless ${r.doknr}` : 'wird beim Versand gedruckt und abgelegt'}`}
                  onChange={(e) => setAuswahl(e.target.checked ? [...auswahl, r.rgnr_txt] : auswahl.filter((x) => x !== r.rgnr_txt))} />
      ))}
    </FlexBox>
  );
}

export function MailDialog({ rgnrs, detail, onClose, onDone }: { rgnrs: string[] | null; detail: PersonDetail | null; onClose: () => void; onDone: (t: string, w?: string[]) => void }) {
  const [auswahl, setAuswahl] = useState<string[]>([]);
  const [an, setAn] = useState('');
  const [cc, setCc] = useState('');
  const [betreff, setBetreff] = useState('');
  const [text, setText] = useState('');
  const [vorschlag, setVorschlag] = useState('');
  const [neudruck, setNeudruck] = useState(true);
  const [entwurf, setEntwurf] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!rgnrs?.length) return;
    setAuswahl(rgnrs); setError(null); setCc(''); setNeudruck(true); setEntwurf(false);
    api.get<MailText>(`${H}/rechnungen/${encodeURIComponent(rgnrs[0])}/mailtext?rgnrs=${encodeURIComponent(rgnrs.join(','))}`).then((t) => {
      setAn(t.an); setBetreff(t.betreff); setText(t.text); setVorschlag(t.text);
    }).catch((e) => setError(e.message));
  }, [rgnrs]);

  // unveränderten Vorschlag an die Auswahl anpassen
  useEffect(() => {
    if (!rgnrs?.length || !auswahl.length || text !== vorschlag) return;
    api.get<MailText>(`${H}/rechnungen/${encodeURIComponent(auswahl[0])}/mailtext?rgnrs=${encodeURIComponent(auswahl.join(','))}`).then((t) => {
      setBetreff(t.betreff); setText(t.text); setVorschlag(t.text);
    }).catch(() => undefined);
  }, [auswahl]); // eslint-disable-line react-hooks/exhaustive-deps

  async function senden() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ text: string; warnungen: string[] }>(`${H}/mail`, { rgnrs: auswahl, an, cc, betreff, text, neudruck, entwurf });
      onDone(r.text, r.warnungen);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return portal(
    <Dialog open={!!rgnrs} headerText="Rechnung per E-Mail senden" onClose={onClose} style={{ width: 'min(46rem, 95vw)' }}
            footer={<Bar endContent={<>
              <Button design="Emphasized" icon="paper-plane" loading={busy} disabled={!auswahl.length || !an} onClick={senden}>{entwurf ? 'Entwurf ablegen' : 'Senden'}</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      <BusyIndicator active={busy} style={{ display: 'block' }}>
        <div className="portal-busy-inhalt">
          {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.75rem' }}>{error}</MessageStrip>}
          <Feld label="An" required><Input value={an} onInput={(e) => setAn(e.target.value)} /></Feld>
          <Feld label="Cc"><Input value={cc} onInput={(e) => setCc(e.target.value)} /></Feld>
          <Feld label="Anhänge (offene Rechnungen)"><RechnungsAuswahl detail={detail} auswahl={auswahl} setAuswahl={setAuswahl} /></Feld>
          <Feld label="Betreff" required><Input value={betreff} onInput={(e) => setBetreff(e.target.value)} /></Feld>
          <Feld label="Nachricht" required><TextArea rows={10} value={text} onInput={(e) => setText(e.target.value)} /></Feld>
          <CheckBox checked={neudruck} onChange={(e) => setNeudruck(e.target.checked)} text="Bereits gedruckte Rechnungen vorher neu drucken (neue Version in Paperless)" />
          <CheckBox checked={entwurf} onChange={(e) => setEntwurf(e.target.checked)} text="Nur als Entwurf im Postfach ablegen (nicht senden)" />
        </div>
      </BusyIndicator>
    </Dialog>,
  );
}

// ---------------------------------------------------------------------------
// WhatsApp (Klick-zu-Chat) mit Bestätigung
// ---------------------------------------------------------------------------
type WaLinks = { rgnr: string; link: string; docId: number }[];

export function WhatsAppDialog({ rgnrs, detail, onClose, onDone }: { rgnrs: string[] | null; detail: PersonDetail | null; onClose: () => void; onDone: (t: string) => void }) {
  const [auswahl, setAuswahl] = useState<string[]>([]);
  const [nummer, setNummer] = useState('');
  const [text, setText] = useState('');
  const [neudruck, setNeudruck] = useState(true);
  const [ergebnis, setErgebnis] = useState<{ url: string; links: WaLinks } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!rgnrs?.length) return;
    setAuswahl(rgnrs); setError(null); setErgebnis(null); setNeudruck(true);
    api.get<MailText>(`${H}/rechnungen/${encodeURIComponent(rgnrs[0])}/mailtext`).then((t) => {
      setNummer(t.mobil ? `+${t.mobil}` : ''); setText(t.whatsapp);
    }).catch((e) => setError(e.message));
  }, [rgnrs]);

  async function oeffnen() {
    // Fenster sofort öffnen, sonst blockiert der Browser das Pop-up nach der Wartezeit
    const win = window.open('about:blank', '_blank');
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ url: string; links: WaLinks }>(`${H}/whatsapp`, { rgnrs: auswahl, nummer, text, neudruck });
      setErgebnis(r);
      if (win) win.location.href = r.url; else window.open(r.url, '_blank');
    } catch (e) {
      win?.close();
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function bestaetigen() {
    setBusy(true);
    try {
      const r = await api.post<{ text: string }>(`${H}/whatsapp/bestaetigen`, { nummer, links: ergebnis!.links });
      onDone(r.text);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return portal(
    <Dialog open={!!rgnrs} headerText={ergebnis ? 'WhatsApp-Versand bestätigen' : 'Rechnung per WhatsApp senden'} onClose={onClose}
            style={{ width: 'min(46rem, 95vw)' }}
            footer={<Bar endContent={ergebnis ? <>
              <Button design="Emphasized" icon="accept" loading={busy} onClick={bestaetigen}>Gesendet – als versendet markieren</Button>
              <Button icon="refresh" onClick={() => window.open(ergebnis.url, '_blank')}>WhatsApp erneut öffnen</Button>
              <Button onClick={() => { onClose(); }}>Nicht gesendet</Button>
            </> : <>
              <Button design="Emphasized" icon="discussion" loading={busy} disabled={!auswahl.length || !nummer} onClick={oeffnen}>WhatsApp öffnen</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.75rem' }}>{error}</MessageStrip>}
      {ergebnis ? (
        <FlexBox direction="Column" style={{ gap: '0.5rem' }}>
          <Text>WhatsApp wurde in einem neuen Fenster geöffnet. Wurde die Nachricht gesendet?</Text>
          {ergebnis.links.map((l) => <Text key={l.rgnr}>Rechnung {l.rgnr}: <Link href={l.link} target="_blank">{l.link}</Link></Text>)}
          <Text style={{ color: 'var(--sapContent_LabelColor)' }}>„Nicht gesendet“ lässt den Status unverändert.</Text>
        </FlexBox>
      ) : (
        <>
          <Feld label="Mobilnummer" required><Input value={nummer} onInput={(e) => setNummer(e.target.value)} placeholder="+49 171 1234567" /></Feld>
          <Feld label="Rechnungen"><RechnungsAuswahl detail={detail} auswahl={auswahl} setAuswahl={setAuswahl} /></Feld>
          <Feld label="Nachricht – [LINKS] wird durch die Rechnungslinks ersetzt"><TextArea rows={9} value={text} onInput={(e) => setText(e.target.value)} /></Feld>
          <CheckBox checked={neudruck} onChange={(e) => setNeudruck(e.target.checked)} text="Bereits gedruckte Rechnungen vorher neu drucken (neue Version in Paperless)" />
        </>
      )}
    </Dialog>,
  );
}

// ---------------------------------------------------------------------------
// E-Mail-Text zum Kopieren, Zahlungen, Paperless-Fassungen
// ---------------------------------------------------------------------------
export function MailtextDialog({ rgnr, onClose }: { rgnr: string | null; onClose: () => void }) {
  const [t, setT] = useState<MailText | null>(null);
  useEffect(() => { setT(null); if (rgnr) api.get<MailText>(`${H}/rechnungen/${encodeURIComponent(rgnr)}/mailtext`).then(setT); }, [rgnr]);
  const mailto = t ? `mailto:${t.an}?subject=${encodeURIComponent(t.betreff)}&body=${encodeURIComponent(t.text)}` : '';
  return portal(
    <Dialog open={!!rgnr} headerText={`E-Mail-Text zu Rechnung ${rgnr ?? ''}`} onClose={onClose} style={{ width: 'min(44rem, 95vw)' }}
            footer={<Bar endContent={<>
              {t?.an && <Button icon="email" onClick={() => { window.location.href = mailto; }}>Im Mailprogramm öffnen</Button>}
              <Button design="Emphasized" onClick={onClose}>Schließen</Button>
            </>} />}>
      {!t ? <BusyIndicator active /> : (
        <>
          <Feld label="Empfänger"><Input readonly value={t.an || 'keine Adresse hinterlegt'} /></Feld>
          <Feld label="Freigabelink"><Input readonly value={t.link ?? 'noch nicht gedruckt'} /></Feld>
          <Feld label="Betreff"><Input readonly value={t.betreff} /></Feld>
          <Feld label="Nachricht"><TextArea readonly rows={10} value={t.text} /></Feld>
        </>
      )}
    </Dialog>,
  );
}

export function ZahlungenDialog({ rechnung, onClose }: { rechnung: Rechnung | null; onClose: () => void }) {
  const [z, setZ] = useState<{ fibeleg: string; betrag: number; datum: string | null; text: string | null }[] | null>(null);
  useEffect(() => { setZ(null); if (rechnung) api.get<typeof z>(`${H}/rechnungen/${encodeURIComponent(rechnung.rgnr_txt)}/zahlungen`).then(setZ); }, [rechnung]);
  const r = rechnung;
  return portal(
    <Dialog open={!!r} headerText={`Zahlungen zu Rechnung ${r?.rgnr_txt ?? ''}`} onClose={onClose} style={{ width: 'min(36rem, 95vw)' }}
            footer={<Bar endContent={<Button design="Emphasized" onClick={onClose}>Schließen</Button>} />}>
      {r && (
        <FlexBox direction="Column" style={{ gap: '0.5rem' }}>
          <FlexBox justifyContent="SpaceBetween"><Text>Rechnungsbetrag</Text><Text>{eur(r.betrag)}</Text></FlexBox>
          <FlexBox justifyContent="SpaceBetween"><Text>Gezahlt</Text><Text>{eur(r.gezahlt)}</Text></FlexBox>
          <FlexBox justifyContent="SpaceBetween"><Text style={{ fontWeight: 'bold' }}>{r.betrag - r.gezahlt < 0 ? 'Überzahlung' : 'Offen'}</Text>
            <Text style={{ fontWeight: 'bold' }}>{eur(Math.abs(r.betrag - r.gezahlt))}</Text></FlexBox>
          <Title level="H6" style={{ marginTop: '0.5rem' }}>Einzelzahlungen (aus FI-Belegen)</Title>
          {(z ?? []).map((x) => (
            <FlexBox key={x.fibeleg} justifyContent="SpaceBetween"><Text>{dat(x.datum)} · Beleg {x.fibeleg} · {x.text}</Text><Text>{eur(x.betrag)}</Text></FlexBox>
          ))}
        </FlexBox>
      )}
    </Dialog>,
  );
}

export function VersionenDialog({ info, onClose }: { info: PaperlessInfo | null; onClose: () => void }) {
  return portal(
    <Dialog open={!!info} headerText={`Paperless-Dokument ${info?.doknr ?? ''} – Fassungen`} onClose={onClose} style={{ width: 'min(32rem, 95vw)' }}
            footer={<Bar endContent={<Button design="Emphasized" onClick={onClose}>Schließen</Button>} />}>
      {(info?.versionen ?? []).map((v, i) => (
        <FlexBox key={v.id} justifyContent="SpaceBetween" style={{ padding: '0.25rem 0' }}>
          <Link onClick={() => window.open(`${H}/paperless/${v.id}/pdf`, '_blank')}>{v.isRoot ? 'Original' : v.label || `Fassung ${i + 1}`}</Link>
          <Text>{v.added ? dat(v.added) : ''}{i === (info?.versionen.length ?? 0) - 1 ? ' · aktuell' : ''}</Text>
        </FlexBox>
      ))}
    </Dialog>,
  );
}

