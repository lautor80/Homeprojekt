import { useEffect, useMemo, useState } from 'react';
import {
  Bar, BusyIndicator, Button, Dialog, FlexBox, Icon, Input, Label, MessageStrip, ObjectStatus, Option, Select, Tab, TabContainer, Text, TextArea, Title,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { Section } from '@core/components/Section';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { TCO, dateiLesen } from '../util';
import './praesentation.css';

/**
 * App „Präsentationen“ (#146)
 *   Sammelkorb (Option C)  Kennzahlen, Diagramme und Tabellen sammeln (auch aus der Vereinsübersicht „Zur Präsentation“),
 *                          Reihenfolge, Titel und Kommentar je Folie festlegen → PowerPoint in der TCO-Standardvorlage.
 *   Vorlagen (Option B)    eigene PowerPoint-Vorlagen mit Platzhaltern hochladen → das Portal füllt sie mit aktuellen Werten.
 */
export const PR = `${TCO}/praesentation`;
type Art = 'KPI' | 'DIAGRAMM' | 'TABELLE' | 'TEXT' | 'KAPITEL';
interface KatalogEintrag { key: string; titel: string; bereich: string; art?: 'LINIE' | 'SAEULEN' }
interface Katalog { kpis: KatalogEintrag[]; diagramme: KatalogEintrag[]; tabellen: KatalogEintrag[] }
export interface KorbEintrag { id?: string; art: Art; schluessel?: string | null; titel?: string | null; text?: string | null }
interface Vorlage { id: number; name: string; beschreibung: string | null; dateiname: string; platzhalter: string[]; angelegt_am: string; angelegt_von: string | null; groesse: number }

const ART_TEXT: Record<Art, string> = { KPI: 'Kennzahl', DIAGRAMM: 'Diagramm', TABELLE: 'Tabelle', TEXT: 'Textfolie', KAPITEL: 'Kapitel' };
const ART_ICON: Record<Art, string> = { KPI: 'kpi-managing-my-area', DIAGRAMM: 'line-chart', TABELLE: 'table-view', TEXT: 'text', KAPITEL: 'header' };
const JAHRE = Array.from({ length: 6 }, (_x, i) => new Date().getFullYear() - i);

/** Base64-Datei vom Server herunterladen */
export function herunterladen(name: string, base64: string) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function Kopfdaten({ jahr, setJahr, titel, setTitel, untertitel, setUntertitel }: {
  jahr: number; setJahr: (j: number) => void; titel: string; setTitel: (s: string) => void; untertitel: string; setUntertitel: (s: string) => void;
}) {
  return (
    <div className="portal-pr-kopf">
      <div><Label>Geschäftsjahr</Label>
        <Select style={{ width: '100%' }} onChange={(e) => setJahr(Number((e.detail.selectedOption as HTMLElement).dataset.j))}>
          {JAHRE.map((j) => <Option key={j} data-j={j} selected={j === jahr}>{String(j)}</Option>)}
        </Select>
      </div>
      <div><Label>Titel</Label><Input style={{ width: '100%' }} value={titel} placeholder={`Vereinsname ${jahr}`} maxlength={200} onInput={(e) => setTitel(e.target.value)} /></div>
      <div><Label>Untertitel</Label><Input style={{ width: '100%' }} value={untertitel} placeholder="z. B. Mitgliederversammlung" maxlength={300} onInput={(e) => setUntertitel(e.target.value)} /></div>
    </div>
  );
}

// ---------------------------------------------------------------- Sammelkorb (Option C)
function Sammelkorb() {
  const [katalog, setKatalog] = useState<Katalog | null>(null);
  const [korb, setKorb] = useState<KorbEintrag[] | null>(null);
  const [jahr, setJahr] = useState(new Date().getFullYear());
  const [titel, setTitel] = useState('');
  const [untertitel, setUntertitel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leeren, setLeeren] = useState(false);
  useEffect(() => { api.get<Katalog>(`${PR}/katalog?jahr=${jahr}`).then(setKatalog).catch((e) => setError(e.message)); }, [jahr]);
  useEffect(() => { api.get<KorbEintrag[]>(`${PR}/korb`).then(setKorb).catch((e) => setError(e.message)); }, []);
  const name = (e: KorbEintrag) => {
    const l = e.art === 'KPI' ? katalog?.kpis : e.art === 'DIAGRAMM' ? katalog?.diagramme : e.art === 'TABELLE' ? katalog?.tabellen : undefined;
    return l?.find((x) => x.key === e.schluessel)?.titel ?? e.schluessel ?? '';
  };
  const speichern = async (l: KorbEintrag[]) => {
    setKorb(l);
    try { setKorb(await api.put<KorbEintrag[]>(`${PR}/korb`, l)); } catch (e) { setError((e as Error).message); }
  };
  const hinzu = (e: KorbEintrag) => speichern([...(korb ?? []), e]);
  const schieben = (i: number, d: number) => { const l = [...(korb ?? [])]; const [x] = l.splice(i, 1); l.splice(i + d, 0, x); speichern(l); };
  const aendern = (i: number, p: Partial<KorbEintrag>) => setKorb((k) => (k ?? []).map((x, j) => (j === i ? { ...x, ...p } : x)));
  const imKorb = (art: Art, key: string) => !!korb?.some((x) => x.art === art && x.schluessel === key);
  const bereiche = useMemo(() => [...new Set([...(katalog?.kpis ?? []), ...(katalog?.diagramme ?? []), ...(katalog?.tabellen ?? [])].map((x) => x.bereich))], [katalog]);

  async function erzeugen() {
    setBusy(true); setError(null);
    try {
      if (korb) await api.put(`${PR}/korb`, korb);
      const r = await api.post<{ name: string; datei: string; folien: number }>(`${PR}/korb/erzeugen`, { jahr, titel: titel || null, untertitel: untertitel || null });
      herunterladen(r.name, r.datei);
      toast(`Präsentation mit ${r.folien} Folien erstellt.`, 5000);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const zeile = (art: Art, x: KatalogEintrag) => (
    <div key={`${art}-${x.key}`} className="portal-pr-baustein">
      <Icon name={ART_ICON[art]} />
      <Text className="portal-pr-baustein__text">{x.titel}{art === 'DIAGRAMM' ? <span className="portal-muted"> · {x.art === 'LINIE' ? 'Linie' : 'Säulen'}</span> : null}</Text>
      <Button design="Transparent" icon={imKorb(art, x.key) ? 'accept' : 'add'} disabled={imKorb(art, x.key)} tooltip="In den Sammelkorb"
              onClick={() => hinzu({ art, schluessel: x.key })} />
    </div>
  );

  return (
    <>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <div className="portal-pr-raster">
        <Section title="Inhalte" status={<span className="portal-muted portal-small">Werte zum Geschäftsjahr {jahr}</span>}>
          {!katalog ? <BusyIndicator active /> : bereiche.map((b) => (
            <div key={b} className="portal-pr-gruppe">
              <Title level="H6">{b}</Title>
              {katalog.kpis.filter((x) => x.bereich === b).map((x) => zeile('KPI', x))}
              {katalog.diagramme.filter((x) => x.bereich === b).map((x) => zeile('DIAGRAMM', x))}
              {katalog.tabellen.filter((x) => x.bereich === b).map((x) => zeile('TABELLE', x))}
            </div>
          ))}
          <div className="portal-pr-gruppe">
            <Title level="H6">Eigene Folien</Title>
            <div className="portal-pr-baustein"><Icon name="text" /><Text className="portal-pr-baustein__text">Textfolie (Titel und Text)</Text>
              <Button design="Transparent" icon="add" onClick={() => hinzu({ art: 'TEXT', titel: 'Neue Folie', text: '' })} /></div>
            <div className="portal-pr-baustein"><Icon name="header" /><Text className="portal-pr-baustein__text">Kapiteltrenner</Text>
              <Button design="Transparent" icon="add" onClick={() => hinzu({ art: 'KAPITEL', titel: 'Kapitel', text: '' })} /></div>
          </div>
        </Section>
        <Section title="Sammelkorb" count={korb?.length}
                 actions={<>
                   {!!korb?.length && <Button design="Transparent" icon="delete" onClick={() => setLeeren(true)}>Leeren</Button>}
                 </>}>
          <Kopfdaten {...{ jahr, setJahr, titel, setTitel, untertitel, setUntertitel }} />
          {!korb ? <BusyIndicator active /> : !korb.length ? (
            <div className="portal-empty">Noch leer – links Inhalte hinzufügen oder in der Vereinsübersicht „Zur Präsentation“ wählen.</div>
          ) : (
            <ol className="portal-pr-korb">
              {korb.map((e, i) => (
                <li key={e.id ?? i} className="portal-pr-korb__eintrag">
                  <div className="portal-pr-korb__kopf">
                    <Icon name={ART_ICON[e.art]} />
                    <Text className="portal-pr-korb__name"><b>{ART_TEXT[e.art]}</b>{e.schluessel ? ` · ${name(e)}` : ''}</Text>
                    <Button design="Transparent" icon="navigation-up-arrow" disabled={i === 0} tooltip="nach oben" onClick={() => schieben(i, -1)} />
                    <Button design="Transparent" icon="navigation-down-arrow" disabled={i === korb.length - 1} tooltip="nach unten" onClick={() => schieben(i, 1)} />
                    <Button design="Transparent" icon="decline" tooltip="entfernen" onClick={() => speichern(korb.filter((_x, j) => j !== i))} />
                  </div>
                  <div className="portal-pr-korb__felder">
                    <Input value={e.titel ?? ''} placeholder={e.art === 'KPI' ? 'Folientitel (neue Folie ab hier, sonst „Kennzahlen“)' : `Folientitel${e.schluessel ? ` (Vorgabe: ${name(e)})` : ''}`}
                           onInput={(ev) => aendern(i, { titel: ev.target.value })} onChange={() => speichern(korb)} />
                    <TextArea rows={e.art === 'TEXT' ? 4 : 2} value={e.text ?? ''} placeholder={e.art === 'TEXT' ? 'Text der Folie' : 'Kommentar auf der Folie (optional)'}
                              onInput={(ev) => aendern(i, { text: ev.target.value })} onChange={() => speichern(korb)} />
                  </div>
                </li>
              ))}
            </ol>
          )}
          <FlexBox justifyContent="End" style={{ marginTop: '0.75rem', gap: '0.5rem' }}>
            <Button design="Emphasized" icon="download" disabled={busy || !korb?.length} onClick={erzeugen}>{busy ? 'Wird erstellt …' : 'PowerPoint erstellen'}</Button>
          </FlexBox>
          <Text className="portal-muted portal-small">
            Titelfolie und „Vielen Dank“ kommen automatisch dazu; aufeinanderfolgende Kennzahlen stehen zu viert auf einer Folie.
            Diagramme sind echte PowerPoint-Diagramme und bleiben in PowerPoint bearbeitbar.
          </Text>
        </Section>
      </div>
      <ConfirmDialog open={leeren} danger title="Sammelkorb leeren" confirmText="Leeren" text="Alle Einträge aus dem Sammelkorb entfernen?"
                     onCancel={() => setLeeren(false)} onConfirm={() => { setLeeren(false); speichern([]); }} />
    </>
  );
}

// ---------------------------------------------------------------- Vorlagen (Option B)
function Vorlagen() {
  const can = useCan();
  const pflegen = can('tco.praesentation:edit');
  const [liste, setListe] = useState<Vorlage[] | null>(null);
  const [wahl, setWahl] = useState<string>('beispiel');
  const [ph, setPh] = useState<{ name: string; bekannt: boolean }[] | null>(null);
  const [texte, setTexte] = useState<Record<string, string>>({});
  const [jahr, setJahr] = useState(new Date().getFullYear());
  const [titel, setTitel] = useState('');
  const [untertitel, setUntertitel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upload, setUpload] = useState(false);
  const [loeschen, setLoeschen] = useState<Vorlage | null>(null);
  const laden = () => api.get<Vorlage[]>(`${PR}/vorlagen`).then(setListe).catch((e) => setError(e.message));
  useEffect(() => { laden(); }, []);
  useEffect(() => {
    setPh(null); setTexte({});
    if (wahl === 'beispiel') { setPh([]); return; }
    api.get<{ platzhalter: { name: string; bekannt: boolean }[] }>(`${PR}/vorlagen/${wahl}?jahr=${jahr}`).then((r) => setPh(r.platzhalter)).catch((e) => setError(e.message));
  }, [wahl, jahr]);
  const offen = (ph ?? []).filter((p) => !p.bekannt && !/^(DIAGRAMM|TABELLE)/.test(p.name));

  async function erzeugen() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ name: string; datei: string }>(`${PR}/vorlagen/${wahl}/erzeugen`, { jahr, titel: titel || null, untertitel: untertitel || null, texte });
      herunterladen(r.name, r.datei);
      toast('Präsentation erstellt.', 4000);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const original = async (id: string) => {
    try { const r = await api.get<{ name: string; datei: string }>(`${PR}/vorlagen/${id}/datei`); herunterladen(r.name, r.datei); } catch (e) { setError((e as Error).message); }
  };

  return (
    <>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <div className="portal-pr-raster">
        <Section title="Vorlagen" count={liste ? liste.length + 1 : undefined}
                 actions={pflegen ? <Button icon="upload" onClick={() => setUpload(true)}>Vorlage hochladen</Button> : undefined}>
          {!liste ? <BusyIndicator active /> : (
            <div className="portal-pr-vorlagen">
              {[{ id: 'beispiel', name: 'TCO Beispielvorlage', beschreibung: 'Mitgeliefert: Überblick, Mitglieder, Finanzen, Halle – zeigt alle Platzhalterarten', n: null as number | null, v: null as Vorlage | null },
                ...liste.map((v) => ({ id: String(v.id), name: v.name, beschreibung: v.beschreibung, n: v.platzhalter.length, v }))].map((x) => (
                <div key={x.id} className={`portal-pr-vorlage${wahl === x.id ? ' portal-pr-vorlage--aktiv' : ''}`} role="button" tabIndex={0}
                     onClick={() => setWahl(x.id)} onKeyDown={(e) => { if (e.key === 'Enter') setWahl(x.id); }}>
                  <Icon name="ppt-attachment" />
                  <div className="portal-pr-vorlage__text">
                    <Text><b>{x.name}</b></Text>
                    <Text className="portal-muted portal-small">{x.beschreibung || '–'}{x.n !== null ? ` · ${x.n} Platzhalter` : ''}</Text>
                  </div>
                  <Button design="Transparent" icon="download" tooltip="Originaldatei" onClick={(e) => { e.stopPropagation(); original(x.id); }} />
                  {pflegen && x.v && <Button design="Transparent" icon="delete" tooltip="Löschen" onClick={(e) => { e.stopPropagation(); setLoeschen(x.v); }} />}
                </div>
              ))}
            </div>
          )}
          <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.75rem' }}>
            Platzhalter in eigenen Vorlagen: <code>{'{{MTG_GESAMT}}'}</code> (Wert), <code>{'{{MTG_GESAMT.text}}'}</code>, <code>.titel</code>, <code>.einheit</code> für jede
            Kennzahl der Vereinsübersicht; <code>{'{{jahr}}'}</code>, <code>{'{{stand.datum}}'}</code>, <code>{'{{verein.name}}'}</code>, <code>{'{{praesentation.titel}}'}</code>,
            {' '}<code>{'{{liq.summe}}'}</code> … Diagramm bzw. Tabelle: Objektname oder Alternativtext <code>{'{{DIAGRAMM:FIN_MONATE}}'}</code> bzw.
            {' '}<code>{'{{TABELLE:HAL_ABR}}'}</code> – Schlüssel wie im Sammelkorb. Eigene Platzhalter (z. B. <code>{'{{kommentar.vorstand}}'}</code>) fragt das Portal beim Erstellen ab.
          </Text>
        </Section>
        <Section title="Präsentation aus Vorlage">
          <Kopfdaten {...{ jahr, setJahr, titel, setTitel, untertitel, setUntertitel }} />
          {ph === null ? <BusyIndicator active /> : (
            <>
              {ph.length > 0 && (
                <div className="portal-pr-platzhalter">
                  {ph.map((p) => (
                    <ObjectStatus key={p.name} state={p.bekannt ? 'Positive' : 'Critical'} showDefaultIcon>{`{{${p.name}}}`}</ObjectStatus>
                  ))}
                </div>
              )}
              {offen.length > 0 && <Label style={{ marginTop: '0.75rem', display: 'block' }}>Eigene Platzhalter – Text eintragen (leer bleibt der Platzhalter stehen)</Label>}
              {offen.map((p) => (
                <div key={p.name} className="portal-pr-feld">
                  <Label>{p.name}</Label>
                  <TextArea rows={2} value={texte[p.name] ?? ''} onInput={(e) => setTexte({ ...texte, [p.name]: e.target.value })} />
                </div>
              ))}
            </>
          )}
          <FlexBox justifyContent="End" style={{ marginTop: '0.75rem' }}>
            <Button design="Emphasized" icon="download" disabled={busy || ph === null} onClick={erzeugen}>{busy ? 'Wird erstellt …' : 'PowerPoint erstellen'}</Button>
          </FlexBox>
        </Section>
      </div>
      {upload && <UploadDialog onClose={() => setUpload(false)} onFertig={(id) => { setUpload(false); laden(); setWahl(String(id)); }} />}
      <ConfirmDialog open={!!loeschen} danger title="Vorlage löschen" confirmText="Löschen" text={`Vorlage „${loeschen?.name ?? ''}“ löschen?`}
                     onCancel={() => setLoeschen(null)}
                     onConfirm={async () => {
                       const v = loeschen!; setLoeschen(null);
                       try { await api.del(`${PR}/vorlagen/${v.id}`); if (wahl === String(v.id)) setWahl('beispiel'); laden(); } catch (e) { setError((e as Error).message); }
                     }} />
    </>
  );
}

function UploadDialog({ onClose, onFertig }: { onClose: () => void; onFertig: (id: number) => void }) {
  const [name, setName] = useState('');
  const [beschreibung, setBeschreibung] = useState('');
  const [datei, setDatei] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function hochladen() {
    if (!datei) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ id: number; text: string }>(`${PR}/vorlagen`, { name, beschreibung: beschreibung || null, dateiname: datei.name, data: await dateiLesen(datei) });
      toast(r.text, 5000);
      onFertig(r.id);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open headerText="PowerPoint-Vorlage hochladen" style={{ width: 'min(32rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={<>
              <Button design="Emphasized" disabled={busy || !name.trim() || !datei} onClick={hochladen}>Hochladen</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      <div className="portal-pr-feld-liste">
        {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
        <div><Label required>Name</Label><Input style={{ width: '100%' }} value={name} maxlength={120} onInput={(e) => setName(e.target.value)} /></div>
        <div><Label>Beschreibung</Label><Input style={{ width: '100%' }} value={beschreibung} maxlength={1000} onInput={(e) => setBeschreibung(e.target.value)} /></div>
        <div><Label required>Datei (.pptx)</Label>
          <input type="file" accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
                 onChange={(e) => { const f = e.target.files?.[0] ?? null; setDatei(f); if (f && !name) setName(f.name.replace(/\.pptx$/i, '')); }} />
        </div>
        <Text className="portal-muted portal-small">Tipp: die TCO Beispielvorlage herunterladen, in PowerPoint anpassen und wieder hochladen.</Text>
      </div>
    </Dialog>
  );
}

export function Praesentationen() {
  const [tab, setTab] = useState<'korb' | 'vorlagen'>('korb');
  return (
    <AppPage title="Präsentationen" subtitle="PowerPoint im TCO-Design – aus dem Sammelkorb oder aus eigenen Vorlagen">
      <TabContainer onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.k as 'korb' | 'vorlagen')}>
        <Tab text="Sammelkorb" icon="cart" data-k="korb" selected={tab === 'korb'} />
        <Tab text="Vorlagen" icon="ppt-attachment" data-k="vorlagen" selected={tab === 'vorlagen'} />
      </TabContainer>
      <div style={{ marginTop: '0.75rem' }}>{tab === 'korb' ? <Sammelkorb /> : <Vorlagen />}</div>
    </AppPage>
  );
}
