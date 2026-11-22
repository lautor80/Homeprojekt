import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bar, Button, CheckBox, DatePicker, Dialog, FlexBox, Input, List, ListItemStandard, MessageStrip, MultiComboBox, MultiComboBoxItem, ObjectStatus,
  Option, Select, Text, TextArea,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { FieldBox, FormGrid } from '@core/components/FormFields';
import { Empty, Section } from '@core/components/Section';
import { toast } from '@core/toast';
import { TCO, dat } from '../util';
import { AushangInhalt, bildUrl, STIL, type Stil } from './Aushang';

/**
 * Platzverwaltung → Reiter „Aushang“ (Recht tco.platz:aushang): Hinweise für „Platz buchen“ pflegen – Titel, Text, Bilder
 * (Fotos werden vor dem Hochladen verkleinert), Darstellung, Zeitraum, Zielrollen, einmal je Benutzer oder bei jedem
 * Aufruf, Bestätigungspflicht. Dazu: Vorschau, wer hat gesehen/bestätigt, als Rundschreiben-Entwurf übernehmen.
 */
const A = `${TCO}/aushaenge`;
type Anzeige = 'EINMAL' | 'IMMER';
type Stand = 'AKTUELL' | 'GEPLANT' | 'ABGELAUFEN' | 'AUS';
interface Bild { id: number; dateiname: string; groesse: number }
interface Aushang {
  id: number; titel: string; text: string; stil: Stil; gueltig_von: string; gueltig_bis: string | null; rollen: string[]; anzeige: Anzeige;
  bestaetigen: boolean; aktiv: boolean; neue_bucher: boolean; stand: Stand; bilder: Bild[]; gesehen: number; bestaetigt: number; bestand: number; geaendert_von: string | null;
}
type Form = Pick<Aushang, 'titel' | 'text' | 'stil' | 'gueltig_von' | 'gueltig_bis' | 'rollen' | 'anzeige' | 'bestaetigen' | 'aktiv' | 'neue_bucher'>;
interface GesehenZeile { user_id: string; name: string; gesehen_am: string; bestaetigt_am: string | null; vorab: boolean }
interface Daten { liste: Aushang[]; rollen: { id: string; name: string }[]; heute: string; bild_max: number; bild_anzahl: number; rundschreiben: boolean }

const STAND: Record<Stand, { text: string; state: 'Positive' | 'Information' | 'None' | 'Critical' }> = {
  AKTUELL: { text: 'wird angezeigt', state: 'Positive' }, GEPLANT: { text: 'geplant', state: 'Information' },
  ABGELAUFEN: { text: 'abgelaufen', state: 'None' }, AUS: { text: 'ausgeschaltet', state: 'Critical' },
};
const LEER = (heute: string): Form => ({ titel: '', text: '', stil: 'WARNUNG', gueltig_von: heute, gueltig_bis: null, rollen: [], anzeige: 'EINMAL', bestaetigen: false, aktiv: true, neue_bucher: false });
const gewaehlt = (e: { detail: { items: unknown } }) => (e.detail.items as HTMLElement[]).map((i) => i.dataset.k ?? '').filter(Boolean);
const leseDatei = (f: Blob) => new Promise<string>((ok, err) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => err(r.error); r.readAsDataURL(f); });

/** Foto im Browser auf höchstens 1600 px (lange Seite) verkleinern und als JPEG senden – kleine Bilder bleiben, wie sie sind */
async function bildVorbereiten(f: File): Promise<{ dateiname: string; data: string }> {
  const url = URL.createObjectURL(f);
  try {
    const img = await new Promise<HTMLImageElement>((ok, err) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => err(new Error(`„${f.name}“ lässt sich nicht als Bild lesen (JPG, PNG oder WebP).`));
      i.src = url;
    });
    const faktor = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    if (faktor === 1 && f.size <= 1024 * 1024 && /^image\/(jpeg|png|webp)$/.test(f.type)) return { dateiname: f.name, data: await leseDatei(f) };
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * faktor);
    c.height = Math.round(img.naturalHeight * faktor);
    const g = c.getContext('2d');
    if (!g) throw new Error('Der Browser kann das Bild nicht verkleinern.');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return { dateiname: `${f.name.replace(/\.[^.]+$/, '') || 'Bild'}.jpg`, data: c.toDataURL('image/jpeg', 0.85) };
  } finally { URL.revokeObjectURL(url); }
}

export function AushangVerwaltung() {
  const [d, setD] = useState<Daten | null>(null);
  const [id, setId] = useState<number | 'neu' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const laden = () => api.get<Daten>(A).then(setD).catch((e) => setError((e as Error).message));
  useEffect(() => { void laden(); }, []);
  if (!d) return error ? <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip> : null;
  const sel = id === 'neu' ? null : d.liste.find((a) => a.id === id) ?? null;

  return (
    <div style={{ display: 'grid', gap: '0.75rem' }}>
      <MessageStrip design="Information" hideCloseButton>
        Hinweise für „Platz buchen“: Sie öffnen sich beim Aufruf der Hallenbuchung – einmal je Benutzer oder bei jedem Aufruf, auf Wunsch mit Pflicht
        zur Bestätigung. Fotos bitte ohne erkennbare Personen oder Kennzeichen.
      </MessageStrip>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
      <Section title="Aushänge" count={d.liste.length} actions={<Button icon="add" design="Emphasized" onClick={() => setId('neu')}>Neuer Aushang</Button>}>
        {d.liste.length === 0 ? <Empty>Noch kein Aushang.</Empty> : (
          <List onItemClick={(e) => setId(Number((e.detail.item as HTMLElement).dataset.id))}>
            {d.liste.map((a) => (
              <ListItemStandard key={a.id} data-id={a.id} type="Active" selected={a.id === id} icon={STIL[a.stil].icon}
                                description={`${dat(a.gueltig_von)} – ${a.gueltig_bis ? dat(a.gueltig_bis) : 'unbefristet'} · ${a.neue_bucher ? 'für neue Hallenbucher' : a.anzeige === 'IMMER' ? 'bei jedem Aufruf' : 'einmal je Benutzer'}`
                                  + ` · gesehen ${a.gesehen}${a.bestaetigen ? `, bestätigt ${a.bestaetigt}` : ''}${a.bilder.length ? ` · ${a.bilder.length} Bild${a.bilder.length === 1 ? '' : 'er'}` : ''}`}
                                additionalText={STAND[a.stand].text} additionalTextState={STAND[a.stand].state}>
                {a.titel || '(ohne Titel)'}
              </ListItemStandard>
            ))}
          </List>
        )}
      </Section>
      {id !== null && (
        <Editor key={String(id)} a={sel} d={d} onFehler={setError}
                onGesichert={(neu) => { void laden(); setId(neu); }} onWeg={() => { setId(null); void laden(); }} onBilder={() => void laden()} />
      )}
    </div>
  );
}

function Editor({ a, d, onFehler, onGesichert, onWeg, onBilder }: {
  a: Aushang | null; d: Daten; onFehler: (t: string | null) => void; onGesichert: (id: number) => void; onWeg: () => void; onBilder: () => void;
}) {
  const navigate = useNavigate();
  const [f, setF] = useState<Form>(() => (a ? { titel: a.titel, text: a.text, stil: a.stil, gueltig_von: a.gueltig_von, gueltig_bis: a.gueltig_bis,
    rollen: a.rollen, anzeige: a.anzeige, bestaetigen: a.bestaetigen, aktiv: a.aktiv, neue_bucher: a.neue_bucher } : LEER(d.heute)));
  const [neuAnzeigen, setNeuAnzeigen] = useState(false);
  const [geaendert, setGeaendert] = useState(!a);
  const [bilder, setBilder] = useState<Bild[]>(a?.bilder ?? []);
  const [busy, setBusy] = useState(false);
  const [vorschau, setVorschau] = useState(false);
  const [gesehen, setGesehen] = useState<GesehenZeile[] | null>(null);
  const [frage, setFrage] = useState(false);
  const datei = useRef<HTMLInputElement>(null);
  const setze = (x: Partial<Form>) => { setF((alt) => ({ ...alt, ...x })); setGeaendert(true); };

  const lauf = async (fn: () => Promise<void>) => {
    setBusy(true); onFehler(null);
    try { await fn(); } catch (e) { onFehler((e as Error).message); } finally { setBusy(false); }
  };
  const sichern = () => lauf(async () => {
    if (a) {
      await api.put(`${A}/${a.id}`, { ...f, neu_anzeigen: neuAnzeigen });
      toast(neuAnzeigen ? 'Gesichert – alle sehen den Aushang noch einmal' : 'Gesichert');
      setNeuAnzeigen(false); setGeaendert(false); onGesichert(a.id);
    } else {
      const r = await api.post<{ id: number }>(A, f);
      toast('Aushang angelegt – jetzt Bilder hinzufügen');
      onGesichert(r.id);
    }
  });
  const hochladen = (files: FileList | null) => lauf(async () => {
    if (!a || !files?.length) return;
    try {
      for (const file of Array.from(files)) {
        const b = await bildVorbereiten(file);
        setBilder((await api.post<{ bilder: Bild[] }>(`${A}/${a.id}/bilder`, b)).bilder);
      }
      onBilder();
    } finally { if (datei.current) datei.current.value = ''; }
  });
  const bildWeg = (b: Bild) => lauf(async () => { if (a) { setBilder((await api.del<{ bilder: Bild[] }>(`${A}/${a.id}/bilder/${b.id}`)).bilder); onBilder(); } });
  const loeschen = () => lauf(async () => { if (a) { await api.del(`${A}/${a.id}`); toast('Aushang gelöscht'); onWeg(); } });
  const wer = () => lauf(async () => { if (a) setGesehen((await api.get<{ zeilen: GesehenZeile[] }>(`${A}/${a.id}/gesehen`)).zeilen); });
  /** einem Benutzer wieder anzeigen – er sieht den Aushang beim nächsten Aufruf von „Platz buchen“ */
  const wiederAnzeigen = (g: GesehenZeile) => lauf(async () => {
    if (!a) return;
    await api.del(`${A}/${a.id}/gesehen/${g.user_id}`);
    toast(`${g.name} sieht den Aushang beim nächsten Aufruf wieder`);
    setGesehen((l) => l?.filter((x) => x.user_id !== g.user_id) ?? null);
    onBilder();
  });
  const alsRundschreiben = () => lauf(async () => {
    if (!a) return;
    const r = await api.post<{ id: number; text: string }>(`${A}/${a.id}/rundschreiben`);
    toast(r.text, 6000);
    navigate('/tco/rundschreiben');
  });

  return (
    <Section title={a ? `Aushang: ${a.titel || '(ohne Titel)'}` : 'Neuer Aushang'}
             actions={(
               <FlexBox wrap="Wrap" style={{ gap: '0.5rem' }}>
                 <Button design="Emphasized" icon="save" disabled={busy || !geaendert} onClick={sichern}>{a ? 'Sichern' : 'Anlegen'}</Button>
                 {a && <Button icon="show" disabled={busy} onClick={() => setVorschau(true)}>Vorschau</Button>}
                 {a && <Button icon="group" disabled={busy} onClick={wer}>Gesehen von ({a.gesehen})</Button>}
                 {a && d.rundschreiben && <Button icon="email" disabled={busy || geaendert} onClick={alsRundschreiben}
                                                  tooltip="Legt einen Rundschreiben-Entwurf mit Text und Bildern an – Empfänger: die Zielrollen bzw. alle, die buchen dürfen">Als Rundschreiben</Button>}
                 {a && <ChangeHistoryButton objectType="AUSHANG" objectKey={String(a.id)} />}
                 {a && <Button icon="delete" design="Transparent" disabled={busy} onClick={() => setFrage(true)}>Löschen</Button>}
               </FlexBox>
             )}>
      <FormGrid>
        <FieldBox label="Titel" required>
          <Input style={{ width: '100%' }} value={f.titel} maxlength={150} placeholder="z. B. Bitte Halle sauber verlassen" onInput={(e) => setze({ titel: e.target.value })} />
        </FieldBox>
        <FieldBox label="Darstellung">
          <Select onChange={(e) => setze({ stil: (e.detail.selectedOption as HTMLElement).dataset.k as Stil })}>
            {(['INFO', 'WARNUNG', 'KRITISCH'] as Stil[]).map((s) => <Option key={s} data-k={s} selected={f.stil === s}>{STIL[s].text}</Option>)}
          </Select>
        </FieldBox>
        <FieldBox label="Text (Leerzeile = neuer Absatz, **fett**)" wide>
          <TextArea rows={8} growing growingMaxRows={20} value={f.text} onInput={(e) => setze({ text: e.target.value })} />
        </FieldBox>
        <FieldBox label="Gültig ab">
          <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.gueltig_von} onChange={(e) => e.detail.value && setze({ gueltig_von: e.detail.value })} />
        </FieldBox>
        <FieldBox label="Gültig bis (leer = unbefristet)">
          <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.gueltig_bis ?? ''} onChange={(e) => setze({ gueltig_bis: e.detail.value || null })} />
        </FieldBox>
        <FieldBox label="Für wen (leer = alle, die buchen dürfen)">
          <MultiComboBox noTypeahead placeholder="alle, die buchen dürfen" onSelectionChange={(e) => setze({ rollen: gewaehlt(e) })}>
            {d.rollen.map((r) => <MultiComboBoxItem key={r.id} data-k={r.id} text={r.name} selected={f.rollen.includes(r.id)} />)}
          </MultiComboBox>
        </FieldBox>
        <FieldBox label="Anzeigen">
          <Select disabled={f.neue_bucher} onChange={(e) => setze({ anzeige: (e.detail.selectedOption as HTMLElement).dataset.k as Anzeige })}>
            <Option data-k="EINMAL" selected={f.anzeige === 'EINMAL'}>einmal je Benutzer</Option>
            <Option data-k="IMMER" selected={f.anzeige === 'IMMER'}>bei jedem Aufruf von „Platz buchen“</Option>
          </Select>
        </FieldBox>
        <FieldBox label="Optionen" wide>
          <FlexBox wrap="Wrap" style={{ gap: '0 1.5rem' }}>
            <CheckBox text="Für neue Hallenbucher (einmal, mit Bestätigung)" checked={f.neue_bucher}
                      onChange={(e) => setze(e.target.checked ? { neue_bucher: true, anzeige: 'EINMAL', bestaetigen: true } : { neue_bucher: false })} />
            <CheckBox text="Bestätigung verlangen („Zur Kenntnis genommen“)" checked={f.bestaetigen} disabled={f.neue_bucher} onChange={(e) => setze({ bestaetigen: e.target.checked })} />
            <CheckBox text="Aktiv" checked={f.aktiv} onChange={(e) => setze({ aktiv: e.target.checked })} />
            {a && <CheckBox text="Beim Sichern allen noch einmal zeigen" checked={neuAnzeigen} onChange={(e) => { setNeuAnzeigen(e.target.checked); setGeaendert(true); }} />}
          </FlexBox>
        </FieldBox>
      </FormGrid>
      {f.neue_bucher && (
        <MessageStrip design="Information" hideCloseButton style={{ marginTop: '0.5rem' }}>
          Für neue Hallenbucher: Alle Benutzer, die es beim {a?.neue_bucher ? 'Einschalten' : 'Sichern'} schon gibt, gelten als informiert und sehen den Hinweis nicht.
          Wer sich danach registriert, sieht ihn beim ersten Aufruf von „Platz buchen“ – vor der ersten Buchung – und muss ihn bestätigen; danach erscheint er
          nicht mehr. Unter „Gesehen von“ lässt er sich einzelnen Benutzern wieder anzeigen, mit „Beim Sichern allen noch einmal zeigen“ allen.
        </MessageStrip>
      )}

      <div style={{ marginTop: '1rem' }}>
        <FlexBox alignItems="Center" style={{ gap: '0.5rem', marginBottom: '0.5rem' }}>
          <Text><b>Bilder</b> ({bilder.length}/{d.bild_anzahl})</Text>
          {a
            ? <Button icon="add-photo" disabled={busy || bilder.length >= d.bild_anzahl} onClick={() => datei.current?.click()}>Bild hinzufügen</Button>
            : <Text className="portal-muted portal-small">Bilder lassen sich nach dem Anlegen hinzufügen.</Text>}
        </FlexBox>
        <input ref={datei} type="file" multiple accept="image/*" style={{ display: 'none' }} onChange={(e) => hochladen(e.target.files)} />
        {a && bilder.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(8rem, 1fr))', gap: '0.5rem' }}>
            {bilder.map((b) => (
              <div key={b.id} style={{ position: 'relative', border: '1px solid var(--sapList_BorderColor)', borderRadius: '0.5rem', overflow: 'hidden' }}>
                <img src={bildUrl(a.id, b.id)} alt={b.dateiname} style={{ display: 'block', width: '100%', height: '7rem', objectFit: 'cover' }} />
                <Button icon="decline" design="Transparent" tooltip={`${b.dateiname} entfernen`} onClick={() => bildWeg(b)}
                        style={{ position: 'absolute', top: '0.25rem', right: '0.25rem', background: 'var(--sapBackgroundColor)' }} />
              </div>
            ))}
          </div>
        )}
        <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>
          JPG, PNG oder WebP; Fotos werden vor dem Hochladen auf höchstens 1600 Pixel verkleinert.
        </Text>
      </div>

      {vorschau && a && (
        <Dialog open headerText={f.titel || '(ohne Titel)'} state={STIL[f.stil].dialog} style={{ width: 'min(40rem, 96vw)' }} onClose={() => setVorschau(false)}
                footer={<Bar endContent={f.bestaetigen
                  ? <Button design="Emphasized" icon="accept" onClick={() => setVorschau(false)}>Zur Kenntnis genommen</Button>
                  : <Button design="Emphasized" onClick={() => setVorschau(false)}>Schließen</Button>} />}>
          <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.5rem' }}>Vorschau – so sieht es der Nutzer in „Platz buchen“.</MessageStrip>
          <AushangInhalt a={{ id: a.id, titel: f.titel, text: f.text, stil: f.stil, bestaetigen: f.bestaetigen, gueltig_bis: f.gueltig_bis, bilder }} />
        </Dialog>
      )}
      {gesehen && (
        <Dialog open headerText={`Gesehen von ${gesehen.filter((g) => !g.vorab).length}`} style={{ width: 'min(38rem, 96vw)' }} onClose={() => setGesehen(null)}
                footer={<Bar endContent={<Button onClick={() => setGesehen(null)}>Schließen</Button>} />}>
          {gesehen.length === 0 ? <Empty>Noch niemand.</Empty> : (
            <div style={{ display: 'grid', gap: '0.25rem' }}>
              {gesehen.map((g) => (
                <FlexBox key={g.user_id} alignItems="Center" justifyContent="SpaceBetween" style={{ gap: '0.5rem', padding: '0.25rem 0', borderBottom: '1px solid var(--sapList_BorderColor)' }}>
                  <div>
                    <Text><b>{g.name}</b></Text><br />
                    <Text className="portal-muted portal-small">
                      {g.vorab ? 'Bestand – gilt als informiert, nicht angezeigt'
                        : `gesehen ${new Date(g.gesehen_am).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}`
                          + (g.bestaetigt_am ? ` · bestätigt ${new Date(g.bestaetigt_am).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}` : '')}
                    </Text>
                  </div>
                  <Button icon="refresh" design="Transparent" disabled={busy} onClick={() => wiederAnzeigen(g)}
                          tooltip="Beim nächsten Aufruf von „Platz buchen“ wieder anzeigen (mit Bestätigung, falls verlangt)">wieder anzeigen</Button>
                </FlexBox>
              ))}
            </div>
          )}
        </Dialog>
      )}
      <ConfirmDialog open={frage} title="Aushang löschen" text={`„${f.titel || '(ohne Titel)'}“ samt Bildern und dem Nachweis, wer ihn gesehen hat, löschen?`}
                     confirmText="Löschen" danger onConfirm={() => { setFrage(false); void loeschen(); }} onCancel={() => setFrage(false)} />
      {a && <ObjectStatus state={STAND[a.stand].state} style={{ display: 'block', marginTop: '0.75rem' }}>{STAND[a.stand].text}{a.geaendert_von ? ` · zuletzt geändert von ${a.geaendert_von}` : ''}</ObjectStatus>}
    </Section>
  );
}
