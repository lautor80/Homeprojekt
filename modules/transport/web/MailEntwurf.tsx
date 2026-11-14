import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bar, Button, CheckBox, Dialog, Input, Label, MessageStrip, Option, Select, Text, TextArea } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { toast } from '@core/toast';
import { T } from './util';
import { dateienImOrdner, dateiLesen } from './ordner';

/**
 * E-Mail zum Auftrag mit Anhängen (#121): Vorlage (Transportauftrag, Lieferschein, Rechnung – Texte aus den Stammdaten,
 * Empfänger wie beim Versenden) oder freier Text, anpassbar; Anhänge aus dem Ablageordner des Auftrags und aus Paperless wählen.
 * „Entwurf öffnen“ erzeugt eine E-Mail-Datei (.eml, als Entwurf gekennzeichnet) mit den Anhängen – sie öffnet sich im
 * Standard-Mailprogramm (Outlook, Thunderbird, Apple Mail) als neue, noch nicht gesendete Nachricht.
 * mailto: kann keine Anhänge übergeben; ohne Anhänge geht es auch direkt per mailto.
 *
 * Ist die Anbindung „Euroflex E-Mail-Versand“ eingerichtet (#235), sendet „Senden“ die E-Mail über Outlook 365 aus dem Postfach
 * des Benutzers: eine E-Mail an den Empfänger und parallel eine eigene E-Mail an die feste zweite Adresse der Anbindung.
 * „Entwurf in Outlook“ legt dieselben E-Mails nur als Entwürfe im Postfach ab.
 */
type Art = 'T' | 'L' | 'R' | 'FREI';
const ARTEN: Record<Art, string> = { T: 'Transportauftrag (an Unternehmer)', L: 'Lieferschein (an Kunde)', R: 'Rechnung (an Kunde)', FREI: 'Freier Text' };
interface Vorschlag { an: string; betreff: string; text: string; faktura: string | null }
interface Anhang { key: string; name: string; quelle: 'ORDNER' | 'PAPERLESS'; docId?: number; groesse?: number }
export interface MailDok { doc_id: number; titel: string | null; datei: string | null }
/** Versand über Outlook 365 (Anbindung „Euroflex E-Mail-Versand“) */
interface VersandInfo { eingerichtet: boolean; postfach: string | null; kopieAn: string; maxMb: number }
type Rolle = 'kunde' | 'kopie';
interface VersandErgebnis { status: 'gesendet' | 'entwurf' | 'teilweise' | 'fehler'; text: string; mails: { rolle: Rolle; an: string; status: string; fehler?: string }[] }
const datenUrl = (f: Blob) => new Promise<string>((ok, err) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result));
  r.onerror = () => err(r.error);
  r.readAsDataURL(f);
});

// ---------------------------------------------------------------- .eml (RFC 5322 / MIME)
const b64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/.{1,76}/g, '$&\r\n');
};
const utf8 = (s: string) => new TextEncoder().encode(s);
/** Kopfzeile mit Umlauten: RFC 2047 (UTF-8, Base64) */
const kopf = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...utf8(s)))}?=`);
const mime = (name: string) => {
  const e = name.split('.').pop()?.toLowerCase() ?? '';
  return ({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', xml: 'application/xml',
    txt: 'text/plain', csv: 'text/csv', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', zip: 'application/zip' } as Record<string, string>)[e]
    ?? 'application/octet-stream';
};

/** .eml-Datei herunterladen – der Browser öffnet sie (nach einmaliger Einstellung) im Standard-Mailprogramm als Entwurf */
export function emlHerunterladen(eml: Blob, name: string) {
  const url = URL.createObjectURL(eml);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'E-Mail'}.eml`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function emlErzeugen(m: { an: string; betreff: string; text: string; anhaenge: { name: string; daten: Blob }[] }): Promise<Blob> {
  const grenze = `----=_Euroflex_${Math.random().toString(36).slice(2)}`;
  const teile: string[] = [
    `To: ${m.an}`,
    `Subject: ${kopf(m.betreff)}`,
    // Outlook öffnet die Datei damit als Entwurf (Senden-Knopf statt Antworten)
    'X-Unsent: 1',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${grenze}"`,
    '',
    `--${grenze}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(utf8(m.text.replace(/\r?\n/g, '\r\n'))),
  ];
  for (const a of m.anhaenge) {
    const n = kopf(a.name);
    teile.push(`--${grenze}`, `Content-Type: ${mime(a.name)}; name="${n}"`, `Content-Disposition: attachment; filename="${n}"`,
      'Content-Transfer-Encoding: base64', '', b64(new Uint8Array(await a.daten.arrayBuffer())));
  }
  teile.push(`--${grenze}--`, '');
  return new Blob([teile.join('\r\n')], { type: 'message/rfc822' });
}

/** Browser öffnet .eml nach dem Download selbst (vom Benutzer bestätigt, je Browser gemerkt) */
export const AUTO = 'euroflex.eml.autoOeffnen';
export const autoOffen = () => { try { return localStorage.getItem(AUTO) === '1'; } catch { return false; } };

const groesse = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB`);
/** Vorschlag je Vorlage: passende Dateien vorauswählen (Name enthält Transportauftrag/Lieferschein/Rechnung) */
const passt = (art: Art, name: string) => (art === 'T' ? /transport/i : art === 'L' ? /liefer/i : art === 'R' ? /rechnung/i : /^$/).test(name);

export function MailEntwurfDialog({ nr, dokumente, onClose }: { nr: string; dokumente: MailDok[]; onClose: () => void }) {
  const [art, setArt] = useState<Art>('T');
  const [an, setAn] = useState('');
  const [cc, setCc] = useState('');
  const [info, setInfo] = useState<VersandInfo | null>(null);
  // nach einem Teilerfolg: nur noch die fehlgeschlagene E-Mail senden, damit niemand etwas doppelt bekommt
  const [offen, setOffen] = useState<Rolle[] | null>(null);
  const [betreff, setBetreff] = useState('');
  const [text, setText] = useState('');
  const [faktura, setFaktura] = useState<string | null>(null);
  const [ordner, setOrdner] = useState<Anhang[] | null>(null);
  const [wahl, setWahl] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [anleitung, setAnleitung] = useState(false);
  const [eingerichtet, setEingerichtet] = useState(false);
  // Teilen mit Dateien (Windows-Freigabe → Outlook/Mail) – nur wenn der Browser es kann
  const teilenMoeglich = typeof navigator !== 'undefined' && !!navigator.canShare
    && navigator.canShare({ files: [new File(['x'], 'test.pdf', { type: 'application/pdf' })] });

  useEffect(() => { api.get<VersandInfo>(`${T}/mail/info`).then(setInfo).catch(() => setInfo(null)); }, []);
  useEffect(() => {
    dateienImOrdner(nr).then((d) => setOrdner((d?.dateien ?? []).filter((f) => !/\.eml$/i.test(f.name))
      .map((f) => ({ key: `O:${f.name}`, name: f.name, quelle: 'ORDNER' as const, groesse: f.groesse })))).catch(() => setOrdner([]));
  }, [nr]);
  const anhaenge = useMemo<Anhang[]>(() => [
    ...(ordner ?? []),
    ...dokumente.map((d) => ({ key: `P:${d.doc_id}`, name: d.datei || d.titel || `Dokument_${d.doc_id}.pdf`, quelle: 'PAPERLESS' as const, docId: d.doc_id })),
  ], [ordner, dokumente]);

  // Vorlage laden: Empfänger, Betreff, Text wie beim Versenden aus der Auftragsliste
  useEffect(() => {
    if (art === 'FREI') { setBetreff(`Auftrag ${nr}`); setText(''); return; }
    setError(null);
    api.post<(Vorschlag & { auftragsnr: string })[]>(`${T}/mails`, { art, auftraege: [nr] })
      .then((r) => {
        const v = r[0];
        if (!v) { setError('Zu diesem Auftrag gibt es noch keine Rechnung.'); return; }
        setAn(v.an); setBetreff(v.betreff); setText(v.text); setFaktura(v.faktura);
      })
      .catch((e) => setError((e as Error).message));
  }, [art, nr]);
  // passende Dateien vorauswählen, sobald die Liste da ist bzw. die Vorlage wechselt
  useEffect(() => { setWahl(new Set(anhaenge.filter((x) => passt(art, x.name)).map((x) => x.key))); }, [art, anhaenge]);

  const umschalten = (k: string, an_: boolean) => setWahl((w) => { const n = new Set(w); if (an_) n.add(k); else n.delete(k); return n; });

  async function dateienLaden() {
    const dateien: { name: string; daten: Blob }[] = [];
    for (const x of anhaenge.filter((y) => wahl.has(y.key))) {
      if (x.quelle === 'ORDNER') {
        const f = await dateiLesen(nr, x.name);
        if (!f) throw new Error(`${x.name} ist im Ablageordner nicht mehr vorhanden.`);
        dateien.push({ name: x.name, daten: f });
      } else {
        const res = await fetch(`${T}/auftraege/${nr}/dokumente/${x.docId}/datei`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`${x.name} konnte nicht aus Paperless geladen werden (${res.status}).`);
        dateien.push({ name: x.name, daten: await res.blob() });
      }
    }
    return dateien;
  }
  async function entwurf() {
    setBusy(true); setError(null);
    try {
      const dateien = await dateienLaden();
      const eml = await emlErzeugen({ an: an.trim(), betreff, text, anhaenge: dateien });
      emlHerunterladen(eml, betreff || `Auftrag_${nr}`);
      toast(`E-Mail-Entwurf mit ${dateien.length} Anhang/Anhängen erstellt.`, 5000);
      // solange der Browser .eml nicht automatisch öffnet: einmal zeigen, wie man das einstellt
      if (autoOffen()) onClose(); else setAnleitung(true);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  /** Versand über Outlook 365 (n8n): Ordnerdateien lädt der Browser hoch, Paperless-Dokumente holt der Server selbst */
  async function senden(modus: 'senden' | 'entwurf') {
    setBusy(true); setError(null);
    try {
      const dateien: { name: string; inhalt: string }[] = [];
      const dokumenteIds: number[] = [];
      let bytes = 0;
      for (const x of anhaenge.filter((y) => wahl.has(y.key))) {
        if (x.quelle === 'PAPERLESS') { dokumenteIds.push(x.docId!); continue; }
        const f = await dateiLesen(nr, x.name);
        if (!f) throw new Error(`${x.name} ist im Ablageordner nicht mehr vorhanden.`);
        bytes += f.size;
        if (info && bytes > info.maxMb * 1024 * 1024) throw new Error(`Die Anhänge sind zusammen größer als ${info.maxMb} MB – bitte weniger Dateien wählen.`);
        dateien.push({ name: x.name, inhalt: await datenUrl(f) });
      }
      const r = await api.post<VersandErgebnis>(`${T}/auftraege/${nr}/mail`, {
        modus, an: an.trim(), cc: cc.trim(), betreff, text, dateien, dokumente: dokumenteIds, ...(offen ? { nur: offen } : {}),
      });
      if (r.status === 'gesendet' || r.status === 'entwurf') { toast(r.text, 8000); onClose(); return; }
      const fehlgeschlagen = r.mails.filter((m) => m.status === 'fehler').map((m) => m.rolle);
      if (r.status === 'teilweise') setOffen(fehlgeschlagen);
      setError(r.text);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  /** Windows-Teilen (Chrome/Edge): Anhänge direkt an Outlook bzw. die Mail-App übergeben – Empfänger kommt in die Zwischenablage */
  async function teilen() {
    setBusy(true); setError(null);
    try {
      const files = (await dateienLaden()).map((d) => new File([d.daten], d.name, { type: d.daten.type || mime(d.name) }));
      if (an.trim()) await navigator.clipboard?.writeText(an.trim()).catch(() => undefined);
      await navigator.share({ title: betreff, text, files });
      if (an.trim()) toast(`Empfänger ${an.trim()} ist in der Zwischenablage – im Mailprogramm mit Strg+V einfügen.`, 8000);
      onClose();
    } catch (e) {
      if ((e as DOMException).name !== 'AbortError') setError((e as Error).message);
    } finally { setBusy(false); }
  }
  const mailto = () => {
    window.location.href = `mailto:${an.trim()}?subject=${encodeURIComponent(betreff)}&body=${encodeURIComponent(text.replace(/\r?\n/g, '\r\n'))}`;
  };

  const outlook = !!info?.eingerichtet;
  if (anleitung) {
    return createPortal(
      <Dialog open headerText="E-Mail-Entwurf öffnen" style={{ width: 'min(36rem, 96vw)' }} onClose={onClose}
              footer={<Bar endContent={<Button design="Emphasized" onClick={() => { if (eingerichtet) { try { localStorage.setItem(AUTO, '1'); } catch { /* egal */ } } onClose(); }}>Fertig</Button>} />}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <Text>
            Der Entwurf wurde als E-Mail-Datei heruntergeladen. Aus Sicherheitsgründen darf eine Webseite keine Programme auf dem PC starten –
            der Browser kann die Datei aber <b>automatisch öffnen</b>, wenn Sie das einmal einstellen:
          </Text>
          <ol style={{ margin: 0, paddingLeft: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <li><Text>Downloads öffnen: <b>Strg+J</b> (oder das Download-Symbol oben rechts).</Text></li>
            <li><Text>Beim Eintrag der <b>.eml</b>-Datei auf <b>⋯</b> bzw. Rechtsklick.</Text></li>
            <li><Text><b>„Dateien dieses Typs immer öffnen“</b> wählen (Chrome und Edge).</Text></li>
          </ol>
          <Text>Ab dann öffnet sich jeder Entwurf direkt im Mailprogramm (Outlook mit „Senden“). Jetzt einfach die Datei in den Downloads anklicken.</Text>
          <CheckBox text="Ist eingerichtet – diesen Hinweis nicht mehr anzeigen" checked={eingerichtet} onChange={(e) => setEingerichtet(e.target.checked)} />
        </div>
      </Dialog>,
      document.body,
    );
  }
  return createPortal(
    <Dialog open headerText={`E-Mail zum Auftrag ${nr}`} style={{ width: 'min(44rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={<>
              {outlook && <Button design="Emphasized" icon="paper-plane" loading={busy} disabled={busy || !betreff.trim() || !an.trim() || !info?.postfach}
                                  tooltip={`Über Outlook 365 aus dem Postfach ${info?.postfach ?? '–'} senden`} onClick={() => senden('senden')}>{offen ? 'Rest senden' : 'Senden'}</Button>}
              {outlook && <Button icon="write-new" disabled={busy || !betreff.trim() || !an.trim() || !info?.postfach}
                                  tooltip="Als Entwurf im Outlook-Postfach ablegen und dort prüfen und senden" onClick={() => senden('entwurf')}>Entwurf in Outlook</Button>}
              <Button design={outlook ? 'Default' : 'Emphasized'} icon="email" loading={!outlook && busy} disabled={busy || !betreff.trim()}
                      tooltip="E-Mail-Datei (.eml) für das Mailprogramm auf diesem PC" onClick={entwurf}>{outlook ? 'E-Mail-Datei' : 'Entwurf öffnen'}</Button>
              {teilenMoeglich && <Button icon="share-2" disabled={busy || !betreff.trim()} tooltip="Windows-Teilen: Anhänge direkt an Outlook bzw. Mail übergeben" onClick={teilen}>Teilen…</Button>}
              <Button design="Transparent" disabled={busy} tooltip="Ohne Anhänge direkt im Mailprogramm" onClick={mailto}>Ohne Anhänge</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))', gap: '0.5rem' }}>
          <div><Label>Vorlage</Label>
            <Select style={{ width: '100%' }} onChange={(e) => setArt((e.detail.selectedOption as HTMLElement).dataset.a as Art)}>
              {(Object.keys(ARTEN) as Art[]).map((k) => <Option key={k} data-a={k} selected={art === k}>{ARTEN[k]}</Option>)}
            </Select>
          </div>
          <div><Label>An</Label><Input style={{ width: '100%' }} type="Email" value={an} placeholder="E-Mail-Adresse (auch im Mailprogramm ergänzbar)" onInput={(e) => setAn(e.target.value)} /></div>
        </div>
        {outlook && <div><Label>CC</Label><Input style={{ width: '100%' }} value={cc} placeholder="weitere Empfänger, durch Komma getrennt" onInput={(e) => setCc(e.target.value)} /></div>}
        <div><Label required>Betreff</Label><Input style={{ width: '100%' }} value={betreff} maxlength={200} onInput={(e) => setBetreff(e.target.value)} /></div>
        <div><Label>Nachricht</Label><TextArea style={{ width: '100%' }} rows={8} value={text} onInput={(e) => setText(e.target.value)} /></div>
        <Label>Anhänge{faktura && art === 'R' ? ` (Rechnung ${faktura})` : ''}</Label>
        {ordner === null ? <Text className="portal-muted">Lade Dateien …</Text> : !anhaenge.length ? (
          <Text className="portal-muted">Keine Dateien im Ablageordner oder in Paperless – zuerst drucken bzw. Dateien ablegen.</Text>
        ) : (
          <div className="portal-ad">
            {anhaenge.map((x) => (
              <div key={x.key} className="portal-ad__zeile" style={{ gridTemplateColumns: '2rem minmax(0, 1fr) auto' }}>
                <CheckBox checked={wahl.has(x.key)} onChange={(e) => umschalten(x.key, e.target.checked)} accessibleName={x.name} />
                <Text style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.name}</Text>
                <Text className="portal-muted portal-small">{x.quelle === 'ORDNER' ? `Ablageordner${x.groesse ? ` · ${groesse(x.groesse)}` : ''}` : `Paperless ${x.docId}`}</Text>
              </div>
            ))}
          </div>
        )}
        {outlook && (info?.postfach ? (
          <MessageStrip design={offen ? 'Critical' : 'Information'} hideCloseButton>
            {offen
              ? `Es fehlt noch: ${offen.map((r) => (r === 'kunde' ? `E-Mail an ${an.trim()}` : `E-Mail an die feste zweite Adresse ${info.kopieAn}`)).join(', ')}. „Rest senden“ sendet nur diese.`
              : `„Senden“ verschickt über Outlook 365 aus dem Postfach ${info.postfach}.${info.kopieAn ? ` Parallel geht dieselbe E-Mail mit denselben Anhängen als eigene E-Mail an ${info.kopieAn}.` : ' Eine feste zweite Adresse ist nicht eingetragen.'}`}
          </MessageStrip>
        ) : (
          <MessageStrip design="Critical" hideCloseButton>
            Für Ihren Benutzer ist kein Postfach hinterlegt – „Senden“ ist deshalb gesperrt (Administration → Anbindungen → Euroflex E-Mail-Versand, „Postfach je Benutzer“).
          </MessageStrip>
        ))}
        <Text className="portal-muted portal-small">
          „{outlook ? 'E-Mail-Datei' : 'Entwurf öffnen'}“ erstellt eine E-Mail-Datei (.eml) mit den gewählten Anhängen, die das Standard-Mailprogramm als neuen Entwurf öffnet
          (Outlook: direkt mit „Senden“) – {autoOffen() ? 'der Browser öffnet sie automatisch.' : 'einmal „Dateien dieses Typs immer öffnen“ einstellen, dann öffnet sie sich direkt.'}
          {teilenMoeglich ? ' „Teilen…“ übergibt Text und Anhänge über die Windows-Freigabe direkt an Outlook bzw. Mail (Empfänger per Strg+V einfügen).' : ''}
        </Text>
      </div>
    </Dialog>,
    document.body,
  );
}
