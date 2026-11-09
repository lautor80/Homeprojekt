import { useEffect, useState, type ClipboardEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  Bar, BusyIndicator, Button, Dialog, FlexBox, Input, Label, MessageStrip, ObjectStatus, Option, SegmentedButton, SegmentedButtonItem, Select, Text, TextArea,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AuswahlBox } from '@core/components/AuswahlBox';
import { H, RG_STATUS, eur } from './util';

/**
 * Rechnungen ohne Hallenbuchung (z. B. „Teilnahme Winterhallenrunde“): eine Position, je Person eine Rechnung.
 * Personen einzeln suchen, als Namensliste einfügen oder per Bild aus der Zwischenablage (Texterkennung über Paperless).
 * Jede erkannte Zeile wird zur Entscheidung vorgelegt: Mitglied/Kunde aus den Vorschlägen, neuer Kunde oder auslassen.
 */
interface Kandidat { key: string; art: 'M' | 'K'; name: string; info: string }
interface Treffer { zeile: string; vorschlaege: (Kandidat & { punkte: number })[]; vorname: string; nachname: string }
interface Produkt { prod_key: string; text: string; preis: number; valid_from: string; valid_to: string }
/**
 * Entscheidung je Zeile: Schlüssel eines Kandidaten, NEU (Kunde anlegen) oder AUS (auslassen);
 * Ziel-Rechnung (null = noch nicht geprüft, NEU = neue Rechnung) und optional abweichender Betrag.
 */
interface Zeile { id: string; zeile: string; wahl: string; vorschlaege: Treffer['vorschlaege']; vorname: string; nachname: string; email: string; rgnr: string | null; betrag: string }
/** bestehende Rechnung einer Person */
interface PersonRechnung { rgnr: string; status: string; betrag: number; angelegt_am: string | null; versendet: string | null; aenderbar: boolean }
const zahl = (v: string) => Number(v.replace(/\./g, (m, i, t: string) => (t.includes(',') ? '' : m)).replace(',', '.'));

let lfd = 0;
const zeileAus = (t: Treffer): Zeile => ({
  id: `z${++lfd}`, zeile: t.zeile, vorschlaege: t.vorschlaege, vorname: t.vorname, nachname: t.nachname, email: '', rgnr: null, betrag: '',
  wahl: t.vorschlaege[0] && t.vorschlaege[0].punkte >= 90 ? t.vorschlaege[0].key : t.vorschlaege[0]?.key ?? 'NEU',
});

export function SammelDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (text: string) => void }) {
  const [kand, setKand] = useState<Kandidat[]>([]);
  const [produkte, setProdukte] = useState<Produkt[]>([]);
  const [zeilen, setZeilen] = useState<Zeile[]>([]);
  const [text, setText] = useState('');
  const [pos, setPos] = useState({ prod_key: '', beschreibung: '', menge: '1', preis: '' });
  /** JE = Betrag je Person, SPLIT = Gesamtbetrag auf die Personen aufteilen (Splitbuchung) */
  const [modus, setModus] = useState<'JE' | 'SPLIT'>('JE');
  const [gesamt, setGesamt] = useState('');
  /** bestehende Rechnungen je Person (Schlüssel M:/K:) */
  const [rgs, setRgs] = useState<Record<string, PersonRechnung[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocrText, setOcrText] = useState<string | null>(null);
  /** Paperless-Beleg der Namensliste (Screenshot) – wird beim Sichern mit den Positionen verknüpft */
  const [beleg, setBeleg] = useState<{ id: number; eigen: boolean; titel?: string } | null>(null);
  const [dokid, setDokid] = useState('');

  useEffect(() => {
    if (!open) return;
    setZeilen([]); setText(''); setError(null); setOcrText(null); setPos({ prod_key: '', beschreibung: '', menge: '1', preis: '' }); setBeleg(null); setDokid('');
    setModus('JE'); setGesamt(''); setRgs({});
    const h = new Date().toLocaleDateString('sv-SE');
    api.get<Kandidat[]>(`${H}/sammel/kandidaten`).then(setKand).catch((e) => setError(e.message));
    api.get<{ produkte: Produkt[] }>(`${H}/preise`).then((r) => setProdukte(r.produkte.filter((p) => p.valid_from <= h && p.valid_to >= h))).catch(() => undefined);
  }, [open]);

  // nach Auswahl der Person: bestehende Rechnungen laden und – falls änderbar – als Ziel vorschlagen
  const offeneKeys = zeilen.map((z) => z.wahl).filter((k) => /^[MK]:/.test(k) && !(k in rgs));
  useEffect(() => {
    if (!open || !offeneKeys.length) return;
    api.post<Record<string, PersonRechnung[]>>(`${H}/sammel/rechnungen`, { keys: [...new Set(offeneKeys)] })
      .then((r) => setRgs((alt) => ({ ...alt, ...r })))
      .catch(() => setRgs((alt) => ({ ...alt, ...Object.fromEntries(offeneKeys.map((k) => [k, []])) })));
  }, [open, offeneKeys.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (zeilen.some((z) => z.rgnr === null && z.wahl in rgs)) {
      setZeilen((l) => l.map((z) => (z.rgnr === null && z.wahl in rgs ? { ...z, rgnr: rgs[z.wahl].find((x) => x.aenderbar)?.rgnr ?? 'NEU' } : z)));
    }
  }, [rgs, zeilen]);
  if (!open) return null;

  /** eigener, nicht verwendeter Beleg wird beim Verwerfen bzw. Ersetzen in Paperless wieder gelöscht */
  const verwerfen = (b = beleg) => { if (b?.eigen) api.post(`${H}/sammel/verwerfen`, { dokid: b.id }).catch(() => undefined); };
  const schliessen = () => { verwerfen(); onClose(); };

  const frei = pos.prod_key === '093';
  const produkt = produkte.find((p) => p.prod_key === pos.prod_key);
  const einzel = frei ? Number(pos.preis.replace(',', '.')) : produkt?.preis ?? 0;
  const menge = Number(pos.menge.replace(',', '.')) || 0;
  const aktiv = zeilen.filter((z) => z.wahl !== 'AUS');
  const fehlerNeu = aktiv.some((z) => z.wahl === 'NEU' && !z.nachname.trim());
  // Beträge je Person: fester Preis × Menge oder Anteil am Gesamtbetrag; manuell geänderte Beträge zählen vorab
  const manuell = (z: Zeile) => z.betrag.trim() !== '' && Number.isFinite(zahl(z.betrag));
  const gesamtCent = Math.round(zahl(gesamt || '0') * 100);
  const anteile = (() => {
    const m = new Map<string, number>();
    if (modus === 'JE') { for (const z of aktiv) m.set(z.id, manuell(z) ? zahl(z.betrag) : Math.round(einzel * menge * 100) / 100); return m; }
    const fest = aktiv.filter(manuell);
    const frei = aktiv.filter((z) => !manuell(z));
    const rest = gesamtCent - fest.reduce((x, z) => x + Math.round(zahl(z.betrag) * 100), 0);
    fest.forEach((z) => m.set(z.id, zahl(z.betrag)));
    const basis = frei.length ? Math.floor(rest / frei.length) : 0;
    const extra = rest - basis * frei.length;              // Cent-Rest auf die ersten Personen
    frei.forEach((z, i) => m.set(z.id, (basis + (i < extra ? 1 : 0)) / 100));
    return m;
  })();
  const summe = Math.round(aktiv.reduce((x, z) => x + (anteile.get(z.id) ?? 0), 0) * 100) / 100;
  const splitFehler = modus === 'SPLIT' && (gesamtCent <= 0 ? 'Bitte den Gesamtbetrag angeben.' : Math.round(summe * 100) !== gesamtCent ? `Die Beträge ergeben ${eur(summe)} statt ${eur(gesamtCent / 100)}.` : null);
  const posOk = !!pos.prod_key && (modus === 'SPLIT' || menge > 0) && (!frei || (pos.beschreibung.trim() && (modus === 'SPLIT' || Number.isFinite(einzel))));
  const rgText = (x: PersonRechnung) => `${x.rgnr} · ${RG_STATUS[x.status] ?? x.status} · ${eur(x.betrag)}`;

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
      const r = await api.post<{ text: string; docId: number; treffer: Treffer[] }>(`${H}/sammel/bild`, { bild: daten });
      verwerfen();
      setBeleg({ id: r.docId, eigen: true });
      setDokid(String(r.docId));
      setOcrText(r.text);
      if (!r.treffer.length) throw new Error('Im Bild wurden keine Namen erkannt.');
      hinzu(r.treffer);
    });
  };
  const dokidLesen = () => lauf('dokid', async () => {
    const r = await api.post<{ text: string; titel: string; docId: number; treffer: Treffer[] }>(`${H}/sammel/dokid`, { dokid });
    if (beleg?.id !== r.docId) verwerfen();
    setBeleg({ id: r.docId, eigen: beleg?.id === r.docId ? beleg.eigen : false, titel: r.titel });
    setOcrText(r.text);
    if (!r.treffer.length) throw new Error('Im Beleg wurden keine Namen erkannt.');
    setZeilen([]);
    hinzu(r.treffer);
  });
  const setze = (id: string, x: Partial<Zeile>) => setZeilen((l) => l.map((z) => (z.id === id ? { ...z, ...x } : z)));

  return createPortal(
    <Dialog open headerText="Rechnungen ohne Hallenbuchung" onClose={schliessen} style={{ width: 'min(60rem, 96vw)' }} resizable
            footer={<Bar startContent={<Text>{aktiv.length} Person(en) · {aktiv.filter((z) => z.rgnr && z.rgnr !== 'NEU' && z.wahl !== 'NEU').length} an bestehende Rechnung · zusammen {eur(summe)}</Text>}
                         endContent={<>
                           <Button design="Emphasized" icon="create" disabled={!!busy || !aktiv.length || !posOk || fehlerNeu || !!splitFehler || aktiv.some((z) => z.rgnr === null && z.wahl !== 'NEU')}
                                   onClick={() => lauf('anlegen', async () => {
                                     const r = await api.post<{ text: string }>(`${H}/sammel`, {
                                       position: { prod_key: pos.prod_key, beschreibung: pos.beschreibung || null, menge: modus === 'SPLIT' ? '1' : pos.menge, preis: frei && modus === 'JE' ? pos.preis : null },
                                       anhaengen: false, belegDocId: beleg?.id ?? null,
                                       empfaenger: aktiv.map((z) => ({
                                         ...(z.wahl === 'NEU' ? { neu: { vorname: z.vorname, nachname: z.nachname, email: z.email || null } } : { key: z.wahl }),
                                         rgnr: z.wahl === 'NEU' ? 'NEU' : z.rgnr ?? 'NEU',
                                         // Splitbuchung bzw. abweichender Betrag: Preis je Person (Menge 1 bzw. Betrag ÷ Menge)
                                         preis: modus === 'SPLIT' ? anteile.get(z.id) : manuell(z) ? Math.round((zahl(z.betrag) / (menge || 1)) * 100) / 100 : undefined,
                                       })),
                                     });
                                     onDone(r.text);
                                   })}>{aktiv.length} Rechnung(en) erzeugen</Button>
                           <Button onClick={schliessen}>Abbrechen</Button>
                         </>} />}>
      <div className="portal-sr" onPaste={einfuegen}>
        {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ whiteSpace: 'pre-line' }}>{error}</MessageStrip>}

        <section>
          <FlexBox alignItems="Center" wrap="Wrap" style={{ gap: '0.5rem 1rem' }}>
            <Label showColon>1 · Rechnungsposition</Label>
            <SegmentedButton onSelectionChange={(e) => setModus((e.detail.selectedItems[0] as HTMLElement).dataset.m as 'JE' | 'SPLIT')}>
              <SegmentedButtonItem data-m="JE" selected={modus === 'JE'}>Betrag je Person</SegmentedButtonItem>
              <SegmentedButtonItem data-m="SPLIT" selected={modus === 'SPLIT'}>Gesamtbetrag aufteilen</SegmentedButtonItem>
            </SegmentedButton>
            {modus === 'SPLIT' && <Input value={gesamt} placeholder="Gesamtbetrag €" style={{ width: '9rem' }} onInput={(e) => setGesamt(e.target.value)} valueState={gesamtCent > 0 ? 'None' : 'Critical'} accessibleName="Gesamtbetrag" />}
          </FlexBox>
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
            <Input value={modus === 'SPLIT' ? '1' : pos.menge} readonly={modus === 'SPLIT'} placeholder="Menge" onInput={(e) => setPos({ ...pos, menge: e.target.value })} />
            <Input value={modus === 'SPLIT' ? '' : pos.preis} readonly={!frei || modus === 'SPLIT'} placeholder={modus === 'SPLIT' ? 'Anteil' : 'Preis €'} onInput={(e) => setPos({ ...pos, preis: e.target.value })} />
          </div>
          <Text className="portal-muted portal-small">
            {modus === 'SPLIT'
              ? 'Splitbuchung: Der Gesamtbetrag wird gleichmäßig auf die Personen verteilt (Cent-Rest auf die ersten). Einzelne Beträge lassen sich unten anpassen – der Rest verteilt sich auf die übrigen.'
              : 'Für freie Texte und Beträge das Produkt „093 – Sonstiges“ wählen; feste Produkte (z. B. Winterhallenrunde) unter Hallenpreise anlegen. Abweichende Beträge je Person unten eintragen.'}
          </Text>
        </section>

        <section>
          <Label showColon>2 · Personen</Label>
          <FlexBox wrap="Wrap" style={{ gap: '0.5rem' }} alignItems="Center">
            <AuswahlBox eintraege={kand.map((k) => ({ key: k.key, text: k.name, zusatz: k.info }))} wert="" placeholder="Mitglied oder Kunde suchen …" style={{ width: '22rem' }}
                        onWaehle={(k) => { const c = kand.find((x) => x.key === k); if (c) hinzu([{ zeile: c.name, vorschlaege: [{ ...c, punkte: 100 }], vorname: '', nachname: '' }]); }} />
            <Button icon="add-employee" onClick={() => setZeilen((l) => [...l, { id: `z${++lfd}`, zeile: 'Neuer Kunde', wahl: 'NEU', vorschlaege: [], vorname: '', nachname: '', email: '', rgnr: 'NEU', betrag: '' }])}>Neuer Kunde</Button>
          </FlexBox>
          <div className="portal-sr__einfuegen">
            <TextArea rows={3} value={text} placeholder={'Namen einfügen – eine Person je Zeile (auch „Nachname, Vorname“).\nOder ein Bild mit Namen hier mit Strg+V einfügen.'} onInput={(e) => setText(e.target.value)} />
            <Button icon="synchronize" disabled={!text.trim() || !!busy} onClick={abgleichen}>Abgleichen</Button>
          </div>
          <FlexBox wrap="Wrap" alignItems="Center" style={{ gap: '0.5rem' }}>
            <Label>Paperless-Beleg (DOKID)</Label>
            <Input value={dokid} style={{ width: '8rem' }} placeholder="z. B. 4711" onInput={(e) => setDokid(e.target.value.replace(/\D/g, ''))}
                   onKeyDown={(e) => e.key === 'Enter' && dokid && dokidLesen()} />
            <Button icon="refresh" disabled={!dokid || !!busy} onClick={dokidLesen}>Erneut lesen</Button>
            {beleg && <>
              <Button icon="show" design="Transparent" onClick={() => window.open(`${H}/paperless/${beleg.id}/pdf`, '_blank')}>Beleg ansehen</Button>
              <ObjectStatus state="Information">wird beim Sichern mit den Positionen verknüpft{beleg.titel ? ` · ${beleg.titel}` : ''}</ObjectStatus>
            </>}
          </FlexBox>
          {(busy === 'bild' || busy === 'dokid') && <BusyIndicator active size="S" text={busy === 'bild' ? 'Bild wird in Paperless abgelegt, Texterkennung läuft …' : 'Beleg wird gelesen …'} style={{ display: 'block', margin: '0.5rem 0' }} />}
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
                    <Select style={{ width: '100%' }} onChange={(e) => setze(z.id, { wahl: (e.detail.selectedOption as HTMLElement).dataset.k!, rgnr: null })}>
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
                    {z.wahl !== 'AUS' && (() => {
                      const liste = rgs[z.wahl] ?? [];
                      const offen = liste.filter((x) => x.aenderbar);
                      const gesperrt = liste.filter((x) => !x.aenderbar);
                      return (
                        <div className="portal-sr__ziel">
                          {z.wahl === 'NEU'
                            ? <Text className="portal-muted portal-small">Neuer Kunde → neue Rechnung</Text>
                            : !(z.wahl in rgs) ? <BusyIndicator active size="S" text="Rechnungen werden geprüft …" />
                              : (
                                <Select style={{ width: '100%' }} onChange={(e) => setze(z.id, { rgnr: (e.detail.selectedOption as HTMLElement).dataset.r! })}
                                        accessibleName="Rechnung für diese Position">
                                  <Option data-r="NEU" selected={z.rgnr === 'NEU'}>Neue Rechnung anlegen</Option>
                                  {offen.map((x) => <Option key={x.rgnr} data-r={x.rgnr} selected={z.rgnr === x.rgnr}>An {rgText(x)} anhängen</Option>)}
                                </Select>
                              )}
                          <Input value={z.betrag} placeholder={eur(anteile.get(z.id) ?? 0)} style={{ width: '100%' }} accessibleName="Betrag dieser Person"
                                 onInput={(e) => setze(z.id, { betrag: e.target.value })} valueState={z.betrag && !manuell(z) ? 'Negative' : 'None'} />
                          {z.wahl in rgs && (
                            <span className="portal-muted portal-small portal-sr__ziel-info">
                              {offen.length ? `${offen.length} offene Rechnung(en) – Position kann angehängt werden` : 'keine offene Rechnung'}
                              {gesperrt.length ? ` · ${gesperrt.map((x) => rgText(x)).join(', ')} bereits versendet` : ''}
                            </span>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
            </div>
            <FlexBox wrap="Wrap" alignItems="Center" style={{ gap: '0.5rem' }}>
              <Text className="portal-small">Alle Zeilen:</Text>
              <Button design="Transparent" onClick={() => setZeilen((l) => l.map((z) => ({ ...z, rgnr: z.wahl in rgs ? rgs[z.wahl].find((x) => x.aenderbar)?.rgnr ?? 'NEU' : z.rgnr })))}>an offene Rechnung anhängen</Button>
              <Button design="Transparent" onClick={() => setZeilen((l) => l.map((z) => ({ ...z, rgnr: 'NEU' })))}>neue Rechnungen</Button>
              <Button design="Transparent" disabled={!zeilen.some((z) => z.betrag)} onClick={() => setZeilen((l) => l.map((z) => ({ ...z, betrag: '' })))}>Beträge zurücksetzen</Button>
            </FlexBox>
            {splitFehler && <MessageStrip design="Critical" hideCloseButton>{splitFehler}</MessageStrip>}
          </section>
        )}
      </div>
    </Dialog>,
    document.body,
  );
}
