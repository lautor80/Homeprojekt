import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bar, BusyIndicator, Button, CheckBox, Dialog, Input, Label, MessageStrip, ObjectStatus, Option, SegmentedButton, SegmentedButtonItem, Select, Tab,
  TabContainer, Text, TextArea, Title,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { PdfDialog } from '@core/components/PdfDialog';
import { Section } from '@core/components/Section';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { TCO, dat, eur } from '../util';
import { AUSWIRKUNG_STATE, FOTO_URL, STATUS_STATE, fotoVerkleinern, zeitpunkt, type Foto } from './foto';
import './instandhaltung.css';

/**
 * Instandhaltung (#205): Schadensmeldungen bearbeiten (Status, Zuständiger, Kommentare, Fotos, Kosten, Platzsperre), Formular
 * drucken und in Paperless ablegen, lückenloses Protokoll. Stammdaten: Orte („Wo?“), Kategorien, Matrix Kategorie × Ort,
 * Zuständigkeiten je Benutzer, Einstellungen, QR-Codes. Offene Meldungen stehen zusätzlich im Arbeitsvorrat der Vereinsübersicht;
 * der Link dort öffnet /tco/instandhaltung?id=<Meldung>.
 */
const I = `${TCO}/instandhaltung`;
type Texte = Record<string, string>;
interface Zeile {
  id: number; nummer: string; anlage: string; gruppe: string; anlage_id: number; platz: string | null; platz_id: number | null; kategorie: string;
  beschreibung: string; auswirkung: string; auswirkung_txt: string; status: string; status_txt: string; offen: boolean; eingang: string;
  melder_name: string; zustaendig: string | null; zustaendig_name: string | null; duplikat_von: number | null; duplikat_nummer: string | null;
  erledigung: string | null; kosten: number | null; firma: string | null; paperless: string | null; stunden: number | null;
  sperre_id: number | null; sperre_von: string | null; fotos: number; formular_doc_id: number | null; formular_am: string | null;
}
interface Detail extends Omit<Zeile, 'fotos'> {
  fotos: { id: number; art: string; name: string; am: string; von: string }[];
  protokoll: { id: number; am: string; von: string; username: string | null; aktion: string; aktion_txt: string; status_txt: string | null; text: string | null; fuer_melder: boolean }[];
  buchungen: { datum: string; von: string; bis: string; kunde: string }[];
  zustaendige: { id: string; name: string; rang: number }[];
}
interface Bearbeiter { id: string; name: string; rollen: string[] }
interface Daten { status: Texte; auswirkungen: Texte; typen: Texte; anlaesse: Texte; bearbeiter: Bearbeiter[]; zeilen: Zeile[] }
const zeitGenau = (iso: string) => new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function Instandhaltung() {
  const can = useCan();
  const [error, setError] = useState<string | null>(null);
  return (
    <AppPage title="Instandhaltung" subtitle="Schadensmeldungen bearbeiten – offene Meldungen stehen auch im Arbeitsvorrat der Vereinsübersicht">
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {can('tco.instandhaltung:admin') ? (
        <TabContainer contentBackgroundDesign="Transparent">
          <Tab text="Meldungen" selected><Meldungen onError={setError} /></Tab>
          <Tab text="Stammdaten"><Stammdaten onError={setError} /></Tab>
        </TabContainer>
      ) : <Meldungen onError={setError} />}
    </AppPage>
  );
}

function Meldungen({ onError }: { onError: (e: string) => void }) {
  const can = useCan();
  const navigate = useNavigate();
  const [daten, setDaten] = useState<Daten | null>(null);
  const [alle, setAlle] = useState(false);
  const [offen, setOffen] = useState<number | null>(() => Number(new URLSearchParams(window.location.search).get('id')) || null);
  const laden = () => api.get<Daten>(`${I}?filter=${alle ? 'ALLE' : 'OFFEN'}`).then(setDaten).catch((e) => onError(e.message));
  useEffect(() => { laden(); }, [alle]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="portal-row" style={{ justifyContent: 'flex-end', marginBottom: '0.5rem', gap: '0.5rem' }}>
        {can('tco.schaden:melden') && <Button design="Transparent" icon="add" onClick={() => navigate('/tco/schaden')}>Schaden melden</Button>}
        <Button design="Transparent" icon={alle ? 'filter' : 'history'} onClick={() => setAlle(!alle)}>{alle ? 'Nur offene' : 'Auch erledigte'}</Button>
        <Button design="Transparent" icon="refresh" tooltip="Neu laden" onClick={laden} />
      </div>
      {!daten ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : !daten.zeilen.length ? (
        <MessageStrip hideCloseButton design="Positive">{alle ? 'Noch keine Schadensmeldungen.' : 'Keine offenen Schadensmeldungen – alles in Ordnung.'}</MessageStrip>
      ) : daten.zeilen.map((z) => (
        <Section key={z.id} title={`${z.nummer} · ${z.anlage} · ${z.kategorie}`}
                 status={<span>
                   <ObjectStatus state={AUSWIRKUNG_STATE[z.auswirkung]}>{z.auswirkung_txt}</ObjectStatus>{' '}
                   <ObjectStatus state={STATUS_STATE[z.status]} inverted>{z.status_txt}</ObjectStatus>
                 </span>}
                 actions={<Button design="Emphasized" icon="detail-view" onClick={() => setOffen(z.id)}>Öffnen</Button>}>
          <Text style={{ display: 'block', whiteSpace: 'pre-line' }}>{z.beschreibung}</Text>
          <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.35rem' }}>
            Gemeldet {zeitpunkt(z.eingang)} von {z.melder_name}
            {z.zustaendig_name ? ` · zuständig: ${z.zustaendig_name}` : ' · noch niemand zuständig'}
            {z.fotos ? ` · ${z.fotos} Foto${z.fotos === 1 ? '' : 's'}` : ''}
            {z.sperre_id ? ` · ${z.platz} gesperrt` : ''}
            {z.duplikat_nummer ? ` · Duplikat von ${z.duplikat_nummer}` : ''}
            {z.formular_doc_id ? ` · Formular in Paperless (DOKID ${String(z.formular_doc_id).padStart(6, '0')})` : ''}
          </Text>
        </Section>
      ))}
      {offen && daten && (
        <DetailDialog id={offen} daten={daten} onClose={(neu) => {
          setOffen(null);
          if (window.location.search.includes('id=')) window.history.replaceState(null, '', window.location.pathname);
          if (neu) laden();
        }} onError={onError} />
      )}
    </>
  );
}

function DetailDialog({ id, daten, onClose, onError }: { id: number; daten: Daten; onClose: (neu: boolean) => void; onError: (e: string) => void }) {
  const can = useCan();
  const edit = can('tco.instandhaltung:edit');
  const [d, setD] = useState<Detail | null>(null);
  const [f, setF] = useState({
    status: '', zustaendig: '', duplikat_von: '', erledigung: '', kosten: '', firma: '', paperless: '', stunden: '', kommentar: '', fuer_melder: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [geaendert, setGeaendert] = useState(false);
  const [formular, setFormular] = useState(false);
  const datei = useRef<HTMLInputElement>(null);
  const laden = () => api.get<Detail>(`${I}/${id}`).then((x) => {
    setD(x);
    setF({
      status: x.status, zustaendig: x.zustaendig ?? '', duplikat_von: x.duplikat_von ? String(x.duplikat_von) : '', erledigung: x.erledigung ?? '',
      kosten: x.kosten != null ? String(x.kosten) : '', firma: x.firma ?? '', paperless: x.paperless ?? '', stunden: x.stunden != null ? String(x.stunden) : '',
      kommentar: '', fuer_melder: false,
    });
  }).catch((e) => { onError(e.message); onClose(false); });
  useEffect(() => { laden(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const zahl = (s: string) => (s.trim() ? Number(s.replace(',', '.')) : null);
  async function aktion(fn: () => Promise<{ text: string }>) {
    setBusy(true); setError(null);
    try { const r = await fn(); toast(r.text, 5000); setGeaendert(true); await laden(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const sichern = () => aktion(() => api.put<{ text: string }>(`${I}/${id}`, {
    status: f.status, zustaendig: f.zustaendig || null, duplikat_von: f.duplikat_von ? Number(f.duplikat_von) : null, erledigung: f.erledigung || null,
    kosten: zahl(f.kosten), firma: f.firma || null, paperless: f.paperless || null, stunden: zahl(f.stunden), kommentar: f.kommentar || null, fuer_melder: f.fuer_melder,
  }));
  async function fotos(liste: FileList | null) {
    if (!liste?.length) return;
    try {
      const l: Foto[] = [];
      for (const x of Array.from(liste).slice(0, 5)) l.push(await fotoVerkleinern(x));
      await aktion(() => api.post<{ text: string }>(`${I}/${id}/fotos`, { fotos: l, art: 'NACHHER' }));
    } catch (e) { setError((e as Error).message); }
    if (datei.current) datei.current.value = '';
  }

  const ende = f.status === 'ERLEDIGT' || f.status === 'ABGELEHNT' || f.status === 'DUPLIKAT';
  const vorschlag = d?.zustaendige ?? [];
  const personen: Bearbeiter[] = [...daten.bearbeiter,
    ...(d?.zustaendig && !daten.bearbeiter.some((b) => b.id === d.zustaendig) ? [{ id: d.zustaendig, name: `${d.zustaendig_name} (ohne Berechtigung)`, rollen: [] }] : [])];
  return (
    <Dialog open headerText={d ? `${d.nummer} · ${d.anlage} · ${d.kategorie}` : 'Schadensmeldung'} style={{ width: 'min(52rem, 98vw)' }}
            onClose={() => onClose(geaendert)}
            footer={<Bar startContent={d ? <Button icon="print" onClick={() => setFormular(true)}>Formular …</Button> : undefined} endContent={<>
              {edit && d && <Button design="Emphasized" icon="save" loading={busy} onClick={sichern}>Sichern</Button>}
              <Button onClick={() => onClose(geaendert)}>Schließen</Button>
            </>} />}>
      {!d ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : (
        <div className="portal-bk__form">
          {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
          <div className="portal-row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            <ObjectStatus state={AUSWIRKUNG_STATE[d.auswirkung]} inverted>{d.auswirkung_txt}</ObjectStatus>
            <ObjectStatus state={STATUS_STATE[d.status]} inverted>{d.status_txt}</ObjectStatus>
            <Text className="portal-muted">Wo: {d.gruppe ? `${d.gruppe} · ` : ''}{d.anlage} · gemeldet {zeitpunkt(d.eingang)} von {d.melder_name}</Text>
          </div>
          <Text style={{ whiteSpace: 'pre-line' }}>{d.beschreibung}</Text>
          {d.fotos.length > 0 && (
            <div className="portal-row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
              {d.fotos.map((x) => (
                <a key={x.id} href={FOTO_URL(x.id)} target="_blank" rel="noreferrer" title={`${x.art === 'NACHHER' ? 'Nachher' : 'Vorher'} · ${x.von} · ${zeitpunkt(x.am)}`}>
                  <img src={FOTO_URL(x.id)} alt={x.name} style={{ width: '7rem', height: '7rem', objectFit: 'cover', borderRadius: '0.5rem', border: x.art === 'NACHHER' ? '2px solid var(--sapPositiveColor)' : undefined }} />
                </a>
              ))}
            </div>
          )}
          {d.formular_doc_id && (
            <MessageStrip design="Information" hideCloseButton>
              Formular in Paperless abgelegt (DOKID {String(d.formular_doc_id).padStart(6, '0')}{d.formular_am ? `, zuletzt ${zeitpunkt(d.formular_am)}` : ''}) – erneutes Ablegen erzeugt eine neue Version.
            </MessageStrip>
          )}

          {d.platz_id && (
            <Section title={`Platzbuchung: ${d.platz}`} plain>
              {d.sperre_id
                ? <MessageStrip design="Critical" hideCloseButton>{d.platz} ist seit {dat(d.sperre_von)} wegen dieses Schadens gesperrt (Sperrzeit in der Platzbuchung).</MessageStrip>
                : <Text className="portal-muted">Nicht gesperrt.</Text>}
              {d.buchungen.length > 0 && (
                <Text style={{ display: 'block', marginTop: '0.35rem' }}>
                  <b>Kommende Buchungen auf {d.platz}</b> (werden nicht automatisch storniert):<br />
                  {d.buchungen.slice(0, 10).map((b) => `${dat(b.datum)} ${b.von}–${b.bis} ${b.kunde}`).join(' · ')}{d.buchungen.length > 10 ? ` · … (${d.buchungen.length})` : ''}
                </Text>
              )}
              {edit && (
                <div className="portal-row" style={{ marginTop: '0.35rem' }}>
                  {d.sperre_id
                    ? <Button icon="unlocked" disabled={busy} onClick={() => aktion(() => api.del<{ text: string }>(`${I}/${id}/sperre`))}>Sperre aufheben</Button>
                    : <Button icon="locked" disabled={busy} onClick={() => aktion(() => api.post<{ text: string }>(`${I}/${id}/sperre`))}>Platz sperren (bis auf Weiteres)</Button>}
                </div>
              )}
            </Section>
          )}

          {edit && (
            <>
              <Title level="H6">Bearbeitung</Title>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(15rem, 1fr))', gap: '0.5rem 1rem' }}>
                <div className="portal-bk__form">
                  <Label showColon>Status</Label>
                  <Select onChange={(e) => setF({ ...f, status: (e.detail.selectedOption as HTMLElement).dataset.s ?? '' })}>
                    {Object.entries(daten.status).map(([k, t]) => <Option key={k} data-s={k} selected={f.status === k}>{t}</Option>)}
                  </Select>
                  <Label showColon>Zuständig</Label>
                  <Select onChange={(e) => setF({ ...f, zustaendig: (e.detail.selectedOption as HTMLElement).dataset.u ?? '' })}>
                    <Option data-u="" selected={!f.zustaendig}>– niemand –</Option>
                    {personen.map((b) => (
                      <Option key={b.id} data-u={b.id} selected={f.zustaendig === b.id}>
                        {b.name}{vorschlag.some((v) => v.id === b.id) ? ' ★' : ''}{b.rollen.length ? ` (${b.rollen.join(', ')})` : ''}
                      </Option>
                    ))}
                  </Select>
                  {vorschlag.length > 0 && <Text className="portal-muted portal-small">★ laut Stammdaten zuständig für Ort/Kategorie: {vorschlag.map((v) => v.name).join(', ')}</Text>}
                  {f.status === 'DUPLIKAT' && (
                    <>
                      <Label showColon required>Duplikat von</Label>
                      <Select onChange={(e) => setF({ ...f, duplikat_von: (e.detail.selectedOption as HTMLElement).dataset.m ?? '' })}>
                        <Option data-m="" selected={!f.duplikat_von}>Bitte wählen …</Option>
                        {daten.zeilen.filter((z) => z.id !== d.id).map((z) => <Option key={z.id} data-m={z.id} selected={f.duplikat_von === String(z.id)}>{z.nummer} · {z.anlage} · {z.kategorie}</Option>)}
                      </Select>
                    </>
                  )}
                  <Label showColon required={f.status === 'ABGELEHNT'}>{ende ? 'Erledigung / Grund (geht an den Melder)' : 'Erledigung'}</Label>
                  <TextArea rows={2} maxlength={2000} value={f.erledigung} onInput={(e) => setF({ ...f, erledigung: e.target.value })} />
                </div>
                <div className="portal-bk__form">
                  <Label showColon>Kosten (€)</Label>
                  <Input type="Number" value={f.kosten} onInput={(e) => setF({ ...f, kosten: e.target.value })} />
                  <Label showColon>Fremdfirma</Label>
                  <Input value={f.firma} maxlength={200} onInput={(e) => setF({ ...f, firma: e.target.value })} />
                  <Label showColon>Angebot/Rechnung (Paperless)</Label>
                  <Input value={f.paperless} maxlength={300} placeholder="Dokumentnummer oder Link" onInput={(e) => setF({ ...f, paperless: e.target.value })} />
                  <Label showColon>Helferstunden</Label>
                  <Input type="Number" value={f.stunden} onInput={(e) => setF({ ...f, stunden: e.target.value })} />
                </div>
              </div>
              <Label showColon>Kommentar</Label>
              <TextArea rows={2} maxlength={2000} value={f.kommentar} placeholder="z. B. Ersatzteil bestellt"
                        onInput={(e) => setF({ ...f, kommentar: e.target.value })} />
              <CheckBox text="Kommentar für den Melder sichtbar („Meine Meldungen“)" checked={f.fuer_melder} onChange={(e) => setF({ ...f, fuer_melder: e.target.checked })} />
              <input ref={datei} type="file" accept="image/*" capture="environment" multiple style={{ display: 'none' }} onChange={(e) => fotos(e.target.files)} />
              <div className="portal-row"><Button icon="camera" disabled={busy} onClick={() => datei.current?.click()}>Foto nach der Reparatur hinzufügen</Button></div>
              {ende && f.status !== d.status && <MessageStrip design="Information" hideCloseButton>Nach dem Sichern: „Formular …“ unten links druckt das Abschlussformular und legt es in Paperless ab.</MessageStrip>}
            </>
          )}
          {!edit && (d.erledigung || d.kosten != null) && (
            <Text>{d.erledigung}{d.kosten != null ? ` · Kosten ${eur(d.kosten)}` : ''}{d.firma ? ` · ${d.firma}` : ''}</Text>
          )}

          <Title level="H6">Protokoll</Title>
          <div className="portal-ih__rahmen">
            <table className="portal-ih__tabelle">
              <thead><tr><th>Zeitpunkt</th><th>Benutzer</th><th>Aktion</th><th>Text</th></tr></thead>
              <tbody>
                {d.protokoll.map((v) => (
                  <tr key={v.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{zeitGenau(v.am)}</td>
                    <td title={v.username ?? undefined}>{v.von}</td>
                    <td style={{ whiteSpace: 'nowrap' }}><b>{v.aktion_txt}</b></td>
                    <td>{v.text}{v.fuer_melder ? '' : <span className="portal-muted"> (intern)</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {formular && d && <FormularDialog d={d} anlaesse={daten.anlaesse} darfAblegen={edit} onClose={(neu) => { setFormular(false); if (neu) { setGeaendert(true); laden(); } }} />}
    </Dialog>
  );
}

/** Formular drucken (Vorschau) bzw. in Paperless ablegen – Anlass Abschluss oder Weitergabe (an …) */
function FormularDialog({ d, anlaesse, darfAblegen, onClose }: { d: Detail; anlaesse: Texte; darfAblegen: boolean; onClose: (neu: boolean) => void }) {
  const [anlass, setAnlass] = useState(d.offen ? 'WEITERGABE' : 'ABSCHLUSS');
  const [an, setAn] = useState(d.firma ?? '');
  const [bemerkung, setBemerkung] = useState('');
  const [pdf, setPdf] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hinweis, setHinweis] = useState<string[]>([]);
  const fehltAn = anlass === 'WEITERGABE' && !an.trim();
  const q = () => new URLSearchParams({ anlass, ...(anlass === 'WEITERGABE' && an ? { an } : {}), ...(bemerkung ? { bemerkung } : {}) }).toString();
  async function ablegen() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string; warnungen: string[] }>(`${I}/${d.id}/formular`, { anlass, an: anlass === 'WEITERGABE' ? an : null, bemerkung });
      toast(r.text, 6000);
      if (r.warnungen.length) setHinweis(r.warnungen); else onClose(true);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open headerText={`Formular ${d.nummer}`} style={{ width: 'min(32rem, 96vw)' }} onClose={() => onClose(hinweis.length > 0)}
            footer={<Bar endContent={<>
              <Button icon="print" disabled={fehltAn} onClick={() => setPdf(`${I}/${d.id}/formular.pdf?${q()}`)}>Drucken / Vorschau</Button>
              {darfAblegen && <Button design="Emphasized" icon="upload-to-cloud" loading={busy} disabled={fehltAn} onClick={ablegen}>In Paperless ablegen</Button>}
              <Button onClick={() => onClose(hinweis.length > 0)}>Schließen</Button>
            </>} />}>
      <div className="portal-bk__form">
        {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
        {hinweis.length > 0 && <MessageStrip design="Critical" hideCloseButton>Abgelegt, mit Hinweisen der Paperless-Zuordnung: {hinweis.join(' · ')}</MessageStrip>}
        <Label showColon>Anlass</Label>
        <SegmentedButton onSelectionChange={(e) => setAnlass((e.detail.selectedItems[0] as HTMLElement).dataset.a ?? 'ABSCHLUSS')}>
          {Object.entries(anlaesse).map(([k, t]) => <SegmentedButtonItem key={k} data-a={k} selected={anlass === k}>{t}</SegmentedButtonItem>)}
        </SegmentedButton>
        {anlass === 'WEITERGABE' && (
          <>
            <Label showColon required>Weitergabe an</Label>
            <Input value={an} maxlength={200} placeholder="z. B. Fremdfirma oder Platzwart" onInput={(e) => setAn(e.target.value)} />
          </>
        )}
        <Label showColon>{anlass === 'WEITERGABE' ? 'Hinweise zur Weitergabe' : 'Bemerkung'}</Label>
        <TextArea rows={3} maxlength={2000} value={bemerkung} onInput={(e) => setBemerkung(e.target.value)} />
        <Text className="portal-muted portal-small">
          Das Formular enthält Eckdaten, Beschreibung, Bearbeitung, Unterschriftsfelder, das vollständige Protokoll und die Fotos.
          Titel, Dokumenttyp, Speicherpfad und Tags in Paperless stehen unter Administration → Paperless-Zuordnung („Schadensmeldung“).
        </Text>
      </div>
      <PdfDialog url={pdf} title={`Formular ${d.nummer}`} filename={`Schadensmeldung_${d.nummer}.pdf`} onClose={() => setPdf(null)} />
    </Dialog>
  );
}

// ---------------------------------------------------------------- Stammdaten

interface StammDaten {
  anlagen: { id: number; kuerzel: string; bezeichnung: string; gruppe: string; typ: string; platz_id: number | null; platz: string | null; sort: number; aktiv: boolean }[];
  kategorien: { id: number; bezeichnung: string; sort: number; aktiv: boolean }[];
  matrix: [number, number][];
  zustaendigkeiten: { id: number; benutzer_id: string; name: string; anlage_id: number | null; anlage: string | null; kategorie_id: number | null; kategorie: string | null; berechtigt: boolean }[];
  einstellungen: { vorstand_email: string; foto_frist_monate: number };
  bearbeiter: { id: string; name: string; email: string | null; rollen: string[] }[];
  typen: Texte;
  plaetze: { id: number; name: string }[];
}
type AnlageForm = { id: number | null; kuerzel: string; bezeichnung: string; gruppe: string; typ: string; platz_id: string; sort: string; aktiv: boolean };
type KatForm = { id: number | null; bezeichnung: string; sort: string; aktiv: boolean };

function Stammdaten({ onError }: { onError: (e: string) => void }) {
  const [s, setS] = useState<StammDaten | null>(null);
  const [cfg, setCfg] = useState({ vorstand_email: '', foto_frist_monate: '24' });
  const [anlage, setAnlage] = useState<AnlageForm | null>(null);
  const [kat, setKat] = useState<KatForm | null>(null);
  const [zust, setZust] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [matrix, setMatrix] = useState<Set<string>>(new Set());
  const [matrixGeaendert, setMatrixGeaendert] = useState(false);
  const laden = () => api.get<StammDaten>(`${I}/stamm/daten`).then((x) => {
    setS(x); setCfg({ vorstand_email: x.einstellungen.vorstand_email, foto_frist_monate: String(x.einstellungen.foto_frist_monate) });
    setMatrix(new Set(x.matrix.map(([a, k]) => `${a}:${k}`))); setMatrixGeaendert(false);
  }).catch((e) => onError(e.message));
  useEffect(() => { laden(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function ausfuehren(fn: () => Promise<{ text: string }>) {
    try { const r = await fn(); toast(r.text); laden(); } catch (e) { onError((e as Error).message); }
  }
  const umschalten = (a: number, k: number) => {
    const n = new Set(matrix); const key = `${a}:${k}`;
    if (n.has(key)) n.delete(key); else n.add(key);
    setMatrix(n); setMatrixGeaendert(true);
  };
  if (!s) return <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />;
  const orte = s.anlagen.filter((a) => a.aktiv);
  return (
    <>
      <Section title="Wo? – Orte und Anlagen" count={s.anlagen.length}
               actions={<>
                 <Button design="Transparent" icon="print" onClick={() => setQr(`${I}/stamm/qr.pdf`)}>QR-Codes drucken</Button>
                 <Button design="Transparent" icon="add" onClick={() => setAnlage({ id: null, kuerzel: '', bezeichnung: '', gruppe: '', typ: 'PLATZ', platz_id: '', sort: '0', aktiv: true })}>Ort anlegen</Button>
               </>}>
        <div className="portal-ih__rahmen"><table className="portal-ih__tabelle">
          <thead><tr><th>Gruppe</th><th>Wo (Bezeichnung)</th><th>Kürzel (QR-Link)</th><th>Typ</th><th>Platzbuchung</th><th /></tr></thead>
          <tbody>
            {s.anlagen.map((a) => (
              <tr key={a.id} className={a.aktiv ? undefined : 'portal-ih__inaktiv'}>
                <td>{a.gruppe || '–'}</td><td>{a.bezeichnung}{!a.aktiv && ' (inaktiv)'}</td><td>{a.kuerzel}</td><td>{s.typen[a.typ]}</td><td>{a.platz ?? '–'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <Button design="Transparent" icon="print" tooltip="QR-Code drucken" disabled={!a.aktiv} onClick={() => setQr(`${I}/stamm/qr.pdf?anlage=${a.id}`)} />
                  <Button design="Transparent" icon="edit" tooltip="Bearbeiten"
                          onClick={() => setAnlage({ id: a.id, kuerzel: a.kuerzel, bezeichnung: a.bezeichnung, gruppe: a.gruppe, typ: a.typ, platz_id: a.platz_id ? String(a.platz_id) : '', sort: String(a.sort), aktiv: a.aktiv })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </Section>

      <Section title="Kategorien" count={s.kategorien.length}
               actions={<Button design="Transparent" icon="add" onClick={() => setKat({ id: null, bezeichnung: '', sort: '0', aktiv: true })}>Kategorie anlegen</Button>}>
        <div className="portal-ih__rahmen"><table className="portal-ih__tabelle">
          <thead><tr><th>Kategorie</th><th>Orte</th><th /></tr></thead>
          <tbody>
            {s.kategorien.map((k) => (
              <tr key={k.id} className={k.aktiv ? undefined : 'portal-ih__inaktiv'}>
                <td>{k.bezeichnung}{!k.aktiv && ' (inaktiv)'}</td>
                <td>{orte.filter((a) => matrix.has(`${a.id}:${k.id}`)).length} von {orte.length}</td>
                <td style={{ textAlign: 'right' }}>
                  <Button design="Transparent" icon="edit" tooltip="Bearbeiten" onClick={() => setKat({ id: k.id, bezeichnung: k.bezeichnung, sort: String(k.sort), aktiv: k.aktiv })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </Section>

      <Section title="Matrix: welche Kategorie an welchem Ort"
               actions={<Button design={matrixGeaendert ? 'Emphasized' : 'Transparent'} icon="save" disabled={!matrixGeaendert}
                                onClick={() => ausfuehren(() => api.put<{ text: string }>(`${I}/stamm/matrix`, { paare: [...matrix].map((x) => x.split(':').map(Number)) }))}>Matrix sichern</Button>}>
        <div className="portal-ih__rahmen"><table className="portal-ih__tabelle portal-ih__matrix">
          <thead><tr><th>Kategorie \ Wo</th>{orte.map((a) => <th key={a.id} title={a.gruppe}>{a.bezeichnung}</th>)}</tr></thead>
          <tbody>
            {s.kategorien.filter((k) => k.aktiv).map((k) => (
              <tr key={k.id}>
                <td>{k.bezeichnung}</td>
                {orte.map((a) => (
                  <td key={a.id} style={{ textAlign: 'center' }}>
                    <CheckBox checked={matrix.has(`${a.id}:${k.id}`)} accessibleName={`${k.bezeichnung} bei ${a.bezeichnung}`} onChange={() => umschalten(a.id, k.id)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table></div>
        <Text className="portal-muted portal-small">Beim Melden stehen am gewählten Ort nur die angekreuzten Kategorien zur Auswahl.</Text>
      </Section>

      <Section title="Zuständigkeiten" count={s.zustaendigkeiten.length}
               actions={<Button design="Transparent" icon="add" disabled={!s.bearbeiter.length} onClick={() => setZust(true)}>Zuständigkeit anlegen</Button>}>
        {!s.bearbeiter.length && (
          <MessageStrip design="Critical" hideCloseButton>Noch niemand hat die Berechtigung „Schadensmeldungen bearbeiten“. Bitte zuerst in Administration → Rollen einer Rolle zuordnen und die Rolle den Personen geben.</MessageStrip>
        )}
        <div className="portal-ih__rahmen"><table className="portal-ih__tabelle">
          <thead><tr><th>Person</th><th>Wo</th><th>Kategorie</th><th /></tr></thead>
          <tbody>
            {s.zustaendigkeiten.map((z) => (
              <tr key={z.id} className={z.berechtigt ? undefined : 'portal-ih__inaktiv'}>
                <td>{z.name}{!z.berechtigt && ' (ohne Berechtigung – wird nicht benachrichtigt)'}</td>
                <td>{z.anlage ?? 'alle Orte'}</td><td>{z.kategorie ?? 'alle Kategorien'}</td>
                <td style={{ textAlign: 'right' }}>
                  <Button design="Transparent" icon="delete" tooltip="Löschen" onClick={() => ausfuehren(() => api.del<{ text: string }>(`${I}/stamm/zustaendig/${z.id}`))} />
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <Text className="portal-muted portal-small">
          Eine neue Meldung geht an alle passenden Personen; Hauptzuständiger wird der spezifischste Eintrag (Ort und Kategorie vor nur Kategorie vor nur Ort).
          Ohne passenden Eintrag geht sie an die Vorstand-E-Mail.
        </Text>
        <Title level="H6" style={{ marginTop: '0.75rem' }}>Personen mit Berechtigung (über ihre Rollen)</Title>
        <Text>{s.bearbeiter.map((b) => `${b.name} (${b.rollen.join(', ')})`).join(' · ') || '–'}</Text>
      </Section>

      <Section title="Benachrichtigung und Fotos">
        <div className="portal-bk__form" style={{ maxWidth: '36rem' }}>
          <Label showColon>E-Mail Vorstand</Label>
          <Input value={cfg.vorstand_email} placeholder="vorstand@… (mehrere mit Komma)" onInput={(e) => setCfg({ ...cfg, vorstand_email: e.target.value })} />
          <Text className="portal-muted portal-small">Erhält jedes Sicherheitsrisiko (und nach 24 h ohne Reaktion eine Erinnerung) sowie Meldungen ohne passende Zuständigkeit.</Text>
          <Label showColon>Fotos erledigter Meldungen löschen nach (Monaten)</Label>
          <Input type="Number" value={cfg.foto_frist_monate} onInput={(e) => setCfg({ ...cfg, foto_frist_monate: e.target.value })} />
          <div className="portal-row">
            <Button design="Emphasized" icon="save"
                    onClick={() => ausfuehren(() => api.put<{ text: string }>(`${I}/stamm/einstellungen`, { vorstand_email: cfg.vorstand_email, foto_frist_monate: Number(cfg.foto_frist_monate) }))}>Sichern</Button>
          </div>
        </div>
      </Section>

      {anlage && <AnlageDialog f={anlage} s={s} onClose={(neu) => { setAnlage(null); if (neu) laden(); }} />}
      {kat && <KategorieDialog f={kat} onClose={(neu) => { setKat(null); if (neu) laden(); }} />}
      {zust && <ZustaendigDialog s={s} onClose={(neu) => { setZust(false); if (neu) laden(); }} />}
      <PdfDialog url={qr} title="QR-Codes Schadensmeldung" filename="qr-schadensmeldung.pdf" onClose={() => setQr(null)} />
    </>
  );
}

function AnlageDialog({ f: start, s, onClose }: { f: AnlageForm; s: StammDaten; onClose: (neu: boolean) => void }) {
  const [f, setF] = useState(start);
  const [error, setError] = useState<string | null>(null);
  const gruppen = [...new Set(s.anlagen.map((a) => a.gruppe).filter(Boolean))];
  async function sichern() {
    try {
      const body = { kuerzel: f.kuerzel, bezeichnung: f.bezeichnung, gruppe: f.gruppe, typ: f.typ, platz_id: f.platz_id ? Number(f.platz_id) : null, sort: Number(f.sort) || 0, aktiv: f.aktiv };
      const r = await (f.id ? api.put<{ text: string }>(`${I}/stamm/anlagen/${f.id}`, body) : api.post<{ text: string }>(`${I}/stamm/anlagen`, body));
      toast(r.text); onClose(true);
    } catch (e) { setError((e as Error).message); }
  }
  return (
    <Dialog open headerText={f.id ? 'Ort bearbeiten' : 'Ort anlegen'} style={{ width: 'min(28rem, 96vw)' }} onClose={() => onClose(false)}
            footer={<Bar endContent={<><Button design="Emphasized" icon="save" onClick={sichern}>Sichern</Button><Button onClick={() => onClose(false)}>Abbrechen</Button></>} />}>
      <div className="portal-bk__form">
        {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
        <Label showColon required>Wo (Bezeichnung)</Label>
        <Input value={f.bezeichnung} maxlength={80} placeholder="z. B. Platz 3, Herrenumkleide, Terrasse" onInput={(e) => setF({ ...f, bezeichnung: e.target.value })} />
        <Label showColon>Gruppe</Label>
        <Input value={f.gruppe} maxlength={60} placeholder={gruppen.length ? `z. B. ${gruppen.slice(0, 3).join(', ')}` : 'z. B. Außenplätze'} onInput={(e) => setF({ ...f, gruppe: e.target.value })} />
        <Label showColon required>Kürzel (im QR-Link)</Label>
        <Input value={f.kuerzel} maxlength={30} placeholder="z. B. platz3" onInput={(e) => setF({ ...f, kuerzel: e.target.value })} />
        <Label showColon>Typ</Label>
        <Select onChange={(e) => setF({ ...f, typ: (e.detail.selectedOption as HTMLElement).dataset.t ?? 'SONSTIGES' })}>
          {Object.entries(s.typen).map(([k, t]) => <Option key={k} data-t={k} selected={f.typ === k}>{t}</Option>)}
        </Select>
        <Label showColon>Platz der Platzbuchung (für die Sperre)</Label>
        <Select onChange={(e) => setF({ ...f, platz_id: (e.detail.selectedOption as HTMLElement).dataset.p ?? '' })}>
          <Option data-p="" selected={!f.platz_id}>– keiner –</Option>
          {s.plaetze.map((p) => <Option key={p.id} data-p={p.id} selected={f.platz_id === String(p.id)}>{p.name}</Option>)}
        </Select>
        <Label showColon>Reihenfolge</Label>
        <Input type="Number" value={f.sort} onInput={(e) => setF({ ...f, sort: e.target.value })} />
        <CheckBox text="aktiv (auswählbar beim Melden)" checked={f.aktiv} onChange={(e) => setF({ ...f, aktiv: e.target.checked })} />
      </div>
    </Dialog>
  );
}

function KategorieDialog({ f: start, onClose }: { f: KatForm; onClose: (neu: boolean) => void }) {
  const [f, setF] = useState(start);
  const [error, setError] = useState<string | null>(null);
  async function sichern() {
    try {
      const body = { bezeichnung: f.bezeichnung, sort: Number(f.sort) || 0, aktiv: f.aktiv };
      const r = await (f.id ? api.put<{ text: string }>(`${I}/stamm/kategorien/${f.id}`, body) : api.post<{ text: string }>(`${I}/stamm/kategorien`, body));
      toast(r.text); onClose(true);
    } catch (e) { setError((e as Error).message); }
  }
  return (
    <Dialog open headerText={f.id ? 'Kategorie bearbeiten' : 'Kategorie anlegen'} style={{ width: 'min(28rem, 96vw)' }} onClose={() => onClose(false)}
            footer={<Bar endContent={<><Button design="Emphasized" icon="save" onClick={sichern}>Sichern</Button><Button onClick={() => onClose(false)}>Abbrechen</Button></>} />}>
      <div className="portal-bk__form">
        {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
        <Label showColon required>Bezeichnung</Label>
        <Input value={f.bezeichnung} maxlength={60} onInput={(e) => setF({ ...f, bezeichnung: e.target.value })} />
        <Label showColon>Reihenfolge</Label>
        <Input type="Number" value={f.sort} onInput={(e) => setF({ ...f, sort: e.target.value })} />
        <CheckBox text="aktiv (auswählbar beim Melden)" checked={f.aktiv} onChange={(e) => setF({ ...f, aktiv: e.target.checked })} />
        {!f.id && <Text className="portal-muted portal-small">Eine neue Kategorie ist zunächst an allen Orten zugelassen – einschränken in der Matrix.</Text>}
      </div>
    </Dialog>
  );
}

function ZustaendigDialog({ s, onClose }: { s: StammDaten; onClose: (neu: boolean) => void }) {
  const [f, setF] = useState({ benutzer_id: '', anlage_id: '', kategorie_id: '' });
  const [error, setError] = useState<string | null>(null);
  async function sichern() {
    try {
      const r = await api.post<{ text: string }>(`${I}/stamm/zustaendig`, {
        benutzer_id: f.benutzer_id, anlage_id: f.anlage_id ? Number(f.anlage_id) : null, kategorie_id: f.kategorie_id ? Number(f.kategorie_id) : null,
      });
      toast(r.text); onClose(true);
    } catch (e) { setError((e as Error).message); }
  }
  return (
    <Dialog open headerText="Zuständigkeit anlegen" style={{ width: 'min(28rem, 96vw)' }} onClose={() => onClose(false)}
            footer={<Bar endContent={<><Button design="Emphasized" icon="save" onClick={sichern}>Sichern</Button><Button onClick={() => onClose(false)}>Abbrechen</Button></>} />}>
      <div className="portal-bk__form">
        {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
        <Label showColon required>Person (Benutzer mit Berechtigung)</Label>
        <Select onChange={(e) => setF({ ...f, benutzer_id: (e.detail.selectedOption as HTMLElement).dataset.u ?? '' })}>
          <Option data-u="" selected={!f.benutzer_id}>Bitte wählen …</Option>
          {s.bearbeiter.map((b) => <Option key={b.id} data-u={b.id} selected={f.benutzer_id === b.id}>{b.name} ({b.rollen.join(', ')})</Option>)}
        </Select>
        <Label showColon>Wo</Label>
        <Select onChange={(e) => setF({ ...f, anlage_id: (e.detail.selectedOption as HTMLElement).dataset.a ?? '' })}>
          <Option data-a="" selected={!f.anlage_id}>alle Orte</Option>
          {s.anlagen.filter((a) => a.aktiv).map((a) => <Option key={a.id} data-a={a.id} selected={f.anlage_id === String(a.id)}>{a.gruppe ? `${a.gruppe} · ` : ''}{a.bezeichnung}</Option>)}
        </Select>
        <Label showColon>Kategorie</Label>
        <Select onChange={(e) => setF({ ...f, kategorie_id: (e.detail.selectedOption as HTMLElement).dataset.k ?? '' })}>
          <Option data-k="" selected={!f.kategorie_id}>alle Kategorien</Option>
          {s.kategorien.filter((k) => k.aktiv).map((k) => <Option key={k.id} data-k={k.id} selected={f.kategorie_id === String(k.id)}>{k.bezeichnung}</Option>)}
        </Select>
        <Text className="portal-muted portal-small">Mindestens Ort oder Kategorie wählen. Beispiel: Hallenwart für „Tennishalle“ (alle Kategorien), Elektriker für „Elektrik“ (alle Orte).</Text>
      </div>
    </Dialog>
  );
}
