import { useEffect, useState, type ClipboardEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  Bar, BusyIndicator, Button, CheckBox, Dialog, FlexBox, Input, Label, MessageStrip, ObjectStatus, Option, Select, Text, TextArea,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AuswahlBox } from '@core/components/AuswahlBox';
import { H, eur } from './util';

/**
 * Rechnungen ohne Hallenbuchung (z. B. „Teilnahme Winterhallenrunde“): eine Position, je Person eine Rechnung.
 * Personen einzeln suchen, als Namensliste einfügen oder per Bild aus der Zwischenablage (Texterkennung über Paperless).
 * Jede erkannte Zeile wird zur Entscheidung vorgelegt: Mitglied/Kunde aus den Vorschlägen, neuer Kunde oder auslassen.
 */
interface Kandidat { key: string; art: 'M' | 'K'; name: string; info: string }
interface Treffer { zeile: string; vorschlaege: (Kandidat & { punkte: number })[]; vorname: string; nachname: string }
interface Produkt { prod_key: string; text: string; preis: number; valid_from: string; valid_to: string }
/** Entscheidung je Zeile: Schlüssel eines Kandidaten, NEU (Kunde anlegen) oder AUS (auslassen) */
interface Zeile { id: string; zeile: string; wahl: string; vorschlaege: Treffer['vorschlaege']; vorname: string; nachname: string; email: string }

let lfd = 0;
const zeileAus = (t: Treffer): Zeile => ({
  id: `z${++lfd}`, zeile: t.zeile, vorschlaege: t.vorschlaege, vorname: t.vorname, nachname: t.nachname, email: '',
  wahl: t.vorschlaege[0] && t.vorschlaege[0].punkte >= 90 ? t.vorschlaege[0].key : t.vorschlaege[0]?.key ?? 'NEU',
});

export function SammelDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (text: string) => void }) {
  const [kand, setKand] = useState<Kandidat[]>([]);
  const [produkte, setProdukte] = useState<Produkt[]>([]);
  const [zeilen, setZeilen] = useState<Zeile[]>([]);
  const [text, setText] = useState('');
  const [pos, setPos] = useState({ prod_key: '', beschreibung: '', menge: '1', preis: '' });
  const [anhaengen, setAnhaengen] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocrText, setOcrText] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setZeilen([]); setText(''); setError(null); setOcrText(null); setPos({ prod_key: '', beschreibung: '', menge: '1', preis: '' });
    const h = new Date().toLocaleDateString('sv-SE');
    api.get<Kandidat[]>(`${H}/sammel/kandidaten`).then(setKand).catch((e) => setError(e.message));
    api.get<{ produkte: Produkt[] }>(`${H}/preise`).then((r) => setProdukte(r.produkte.filter((p) => p.valid_from <= h && p.valid_to >= h))).catch(() => undefined);
  }, [open]);
  if (!open) return null;

  const frei = pos.prod_key === '093';
  const produkt = produkte.find((p) => p.prod_key === pos.prod_key);
  const einzel = frei ? Number(pos.preis.replace(',', '.')) : produkt?.preis ?? 0;
  const menge = Number(pos.menge.replace(',', '.')) || 0;
  const aktiv = zeilen.filter((z) => z.wahl !== 'AUS');
  const fehlerNeu = aktiv.some((z) => z.wahl === 'NEU' && !z.nachname.trim());
  const posOk = !!pos.prod_key && menge > 0 && (!frei || (pos.beschreibung.trim() && Number.isFinite(einzel)));

  async function lauf(art: string, fn: () => Promise<void>) {
    setBusy(art); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }
  const hinzu = (t: Treffer[]) => setZeilen((alt) => {
    const da = new Set(alt.filter((z) => z.wahl !== 'NEU' && z.wahl !== 'AUS').map((z) => z.wahl));
    return [...alt, ...t.map(zeileAus).map((z) => (da.has(z.wahl) ? { ...z, wahl: 'AUS' } : z))];
  });
  const abgleichen = () => lauf('text', async () => { hinzu(await api.post<Treffer[]>(`${H}/sammel/namen`, { text })); setText(''); });
  const einfuegen = (e: ClipboardEvent) => {
    const bild = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'))?.getAsFile();
    if (!bild) return;
    e.preventDefault();
    lauf('bild', async () => {
      const daten = await new Promise<string>((ok, fehler) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => fehler(r.error); r.readAsDataURL(bild); });
      const r = await api.post<{ text: string; treffer: Treffer[] }>(`${H}/sammel/bild`, { bild: daten });
      setOcrText(r.text);
      if (!r.treffer.length) throw new Error('Im Bild wurden keine Namen erkannt.');
      hinzu(r.treffer);
    });
  };
  const setze = (id: string, x: Partial<Zeile>) => setZeilen((l) => l.map((z) => (z.id === id ? { ...z, ...x } : z)));

  return createPortal(
    <Dialog open headerText="Rechnungen ohne Hallenbuchung" onClose={onClose} style={{ width: 'min(60rem, 96vw)' }} resizable
            footer={<Bar startContent={<Text>{aktiv.length} Rechnung(en) · je {eur(einzel * menge)} · gesamt {eur(einzel * menge * aktiv.length)}</Text>}
                         endContent={<>
                           <Button design="Emphasized" icon="create" disabled={!!busy || !aktiv.length || !posOk || fehlerNeu}
                                   onClick={() => lauf('anlegen', async () => {
                                     const r = await api.post<{ text: string }>(`${H}/sammel`, {
                                       position: { prod_key: pos.prod_key, beschreibung: pos.beschreibung || null, menge: pos.menge, preis: frei ? pos.preis : null },
                                       anhaengen,
                                       empfaenger: aktiv.map((z) => (z.wahl === 'NEU' ? { neu: { vorname: z.vorname, nachname: z.nachname, email: z.email || null } } : { key: z.wahl })),
                                     });
                                     onDone(r.text);
                                   })}>{aktiv.length} Rechnung(en) erzeugen</Button>
                           <Button onClick={onClose}>Abbrechen</Button>
                         </>} />}>
      <div className="portal-sr" onPaste={einfuegen}>
        {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ whiteSpace: 'pre-line' }}>{error}</MessageStrip>}

        <section>
          <Label showColon>1 · Rechnungsposition (für jede Person gleich)</Label>
          <div className="portal-sr__pos">
            <Select style={{ width: '100%' }} onChange={(e) => {
              const k = (e.detail.selectedOption as HTMLElement).dataset.k!;
              const p = produkte.find((x) => x.prod_key === k);
              setPos({ ...pos, prod_key: k, beschreibung: k === '093' ? pos.beschreibung : p?.text ?? '', preis: p ? String(p.preis).replace('.', ',') : '' });
            }}>
              <Option data-k="" selected={!pos.prod_key}>Produkt wählen …</Option>
              {produkte.map((p) => <Option key={p.prod_key} data-k={p.prod_key} selected={p.prod_key === pos.prod_key}>{p.prod_key} – {p.text} ({eur(p.preis)})</Option>)}
            </Select>
            <Input value={pos.beschreibung} maxlength={40} placeholder="Text auf der Rechnung, z. B. Teilnahme Winterhallenrunde 2026/27" onInput={(e) => setPos({ ...pos, beschreibung: e.target.value })} />
            <Input value={pos.menge} placeholder="Menge" onInput={(e) => setPos({ ...pos, menge: e.target.value })} />
            <Input value={pos.preis} readonly={!frei} placeholder="Preis €" onInput={(e) => setPos({ ...pos, preis: e.target.value })} />
          </div>
          <Text className="portal-muted portal-small">Für freie Texte und Beträge das Produkt „093 – Sonstiges“ wählen; feste Produkte (z. B. Winterhallenrunde) unter Hallenpreise anlegen.</Text>
        </section>

        <section>
          <Label showColon>2 · Personen</Label>
          <FlexBox wrap="Wrap" style={{ gap: '0.5rem' }} alignItems="Center">
            <AuswahlBox eintraege={kand.map((k) => ({ key: k.key, text: k.name, zusatz: k.info }))} wert="" placeholder="Mitglied oder Kunde suchen …" style={{ width: '22rem' }}
                        onWaehle={(k) => { const c = kand.find((x) => x.key === k); if (c) hinzu([{ zeile: c.name, vorschlaege: [{ ...c, punkte: 100 }], vorname: '', nachname: '' }]); }} />
            <Button icon="add-employee" onClick={() => setZeilen((l) => [...l, { id: `z${++lfd}`, zeile: 'Neuer Kunde', wahl: 'NEU', vorschlaege: [], vorname: '', nachname: '', email: '' }])}>Neuer Kunde</Button>
          </FlexBox>
          <div className="portal-sr__einfuegen">
            <TextArea rows={3} value={text} placeholder={'Namen einfügen – eine Person je Zeile (auch „Nachname, Vorname“).\nOder ein Bild mit Namen hier mit Strg+V einfügen.'} onInput={(e) => setText(e.target.value)} />
            <Button icon="synchronize" disabled={!text.trim() || !!busy} onClick={abgleichen}>Abgleichen</Button>
          </div>
          {busy === 'bild' && <BusyIndicator active size="S" text="Texterkennung läuft (Paperless) …" style={{ display: 'block', margin: '0.5rem 0' }} />}
          {ocrText !== null && <details className="portal-sr__ocr"><summary>Erkannter Text aus dem Bild</summary><pre>{ocrText}</pre></details>}
        </section>

        {zeilen.length > 0 && (
          <section>
            <Label showColon>3 · Zuordnung prüfen</Label>
            <div className="portal-sr__liste">
              {zeilen.map((z) => {
                const best = z.vorschlaege[0];
                return (
                  <div key={z.id} className={`portal-sr__zeile${z.wahl === 'AUS' ? ' portal-sr__zeile--aus' : ''}`}>
                    <div className="portal-sr__quelle">
                      <span>{z.zeile}</span>
                      {best ? <ObjectStatus state={best.punkte >= 90 ? 'Positive' : 'Critical'}>{best.punkte >= 90 ? 'eindeutig' : 'bitte prüfen'}</ObjectStatus>
                        : z.wahl !== 'NEU' || z.zeile !== 'Neuer Kunde' ? <ObjectStatus state="Negative">nicht gefunden</ObjectStatus> : null}
                    </div>
                    <Select style={{ width: '100%' }} onChange={(e) => setze(z.id, { wahl: (e.detail.selectedOption as HTMLElement).dataset.k! })}>
                      {z.vorschlaege.map((v) => <Option key={v.key} data-k={v.key} selected={z.wahl === v.key}>{v.name} – {v.info}</Option>)}
                      <Option data-k="NEU" selected={z.wahl === 'NEU'}>Neuen Kunden anlegen</Option>
                      <Option data-k="AUS" selected={z.wahl === 'AUS'}>Auslassen</Option>
                    </Select>
                    {z.wahl === 'NEU' ? (
                      <div className="portal-sr__neu">
                        <Input value={z.vorname} placeholder="Vorname" onInput={(e) => setze(z.id, { vorname: e.target.value })} />
                        <Input value={z.nachname} placeholder="Nachname *" valueState={z.nachname.trim() ? 'None' : 'Negative'} onInput={(e) => setze(z.id, { nachname: e.target.value })} />
                        <Input value={z.email} placeholder="E-Mail" onInput={(e) => setze(z.id, { email: e.target.value })} />
                      </div>
                    ) : <span />}
                    <Button icon="delete" design="Transparent" tooltip="Zeile entfernen" onClick={() => setZeilen((l) => l.filter((x) => x.id !== z.id))} />
                  </div>
                );
              })}
            </div>
            <CheckBox text="An eine offene Rechnung („In Bearbeitung“) der Person anhängen statt eine neue anzulegen" checked={anhaengen} onChange={(e) => setAnhaengen(e.target.checked)} />
          </section>
        )}
      </div>
    </Dialog>,
    document.body,
  );
}
