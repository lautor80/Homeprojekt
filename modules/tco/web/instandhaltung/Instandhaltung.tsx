import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bar, BusyIndicator, Button, CheckBox, Dialog, Input, Label, MessageStrip, ObjectStatus, Option, Select, Tab, TabContainer, Text, TextArea, Title,
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
 * Instandhaltung (#205): Schadensmeldungen bearbeiten (Status, Zuständiger, Kommentare, Fotos, Kosten, Platzsperre) und
 * Stammdaten (Anlagen, Kategorien mit Zuständigen, Vorstand-E-Mail, Löschfrist, QR-Codes). Offene Meldungen stehen zusätzlich
 * im Arbeitsvorrat der Vereinsübersicht; der Link dort öffnet /tco/instandhaltung?id=<Meldung>.
 */
const I = `${TCO}/instandhaltung`;
type Texte = Record<string, string>;
interface Zeile {
  id: number; nummer: string; anlage: string; anlage_id: number; platz: string | null; platz_id: number | null; kategorie: string;
  beschreibung: string; auswirkung: string; auswirkung_txt: string; status: string; status_txt: string; offen: boolean; eingang: string;
  melder_name: string; zustaendig: string | null; zustaendig_name: string | null; duplikat_von: number | null; duplikat_nummer: string | null;
  erledigung: string | null; kosten: number | null; firma: string | null; paperless: string | null; stunden: number | null;
  sperre_id: number | null; sperre_von: string | null; fotos: number; geaendert_am: string | null; geaendert_von: string | null;
}
interface Detail extends Zeile {
  verlauf: { id: number; am: string; von: string; status: string | null; status_txt: string | null; text: string | null; fuer_melder: boolean }[];
  buchungen: { datum: string; von: string; bis: string; kunde: string }[];
}
interface DetailRoh extends Omit<Detail, 'fotos'> { fotos: { id: number; art: string; name: string; am: string; von: string }[] }
interface Daten {
  status: Texte; auswirkungen: Texte; typen: Texte; bearbeiter: { id: string; name: string }[]; zeilen: Zeile[];
  anlagen: { id: number; bezeichnung: string }[]; kategorien: { id: number; bezeichnung: string }[];
}

export function Instandhaltung() {
  const can = useCan();
  const [error, setError] = useState<string | null>(null);
  return (
    <AppPage title="Instandhaltung" subtitle="Schadensmeldungen der Mitglieder bearbeiten – offene Meldungen stehen auch im Arbeitsvorrat der Vereinsübersicht">
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
  const [d, setD] = useState<DetailRoh | null>(null);
  const [f, setF] = useState({
    status: '', zustaendig: '', duplikat_von: '', erledigung: '', kosten: '', firma: '', paperless: '', stunden: '', kommentar: '', fuer_melder: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [geaendert, setGeaendert] = useState(false);
  const datei = useRef<HTMLInputElement>(null);
  const laden = () => api.get<DetailRoh>(`${I}/${id}`).then((x) => {
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
  return (
    <Dialog open headerText={d ? `${d.nummer} · ${d.anlage} · ${d.kategorie}` : 'Schadensmeldung'} style={{ width: 'min(48rem, 98vw)' }}
            onClose={() => onClose(geaendert)}
            footer={<Bar endContent={<>
              {edit && d && <Button design="Emphasized" icon="save" loading={busy} onClick={sichern}>Sichern</Button>}
              <Button onClick={() => onClose(geaendert)}>Schließen</Button>
            </>} />}>
      {!d ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : (
        <div className="portal-bk__form">
          {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
          <div className="portal-row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            <ObjectStatus state={AUSWIRKUNG_STATE[d.auswirkung]} inverted>{d.auswirkung_txt}</ObjectStatus>
            <ObjectStatus state={STATUS_STATE[d.status]} inverted>{d.status_txt}</ObjectStatus>
            <Text className="portal-muted">Gemeldet {zeitpunkt(d.eingang)} von {d.melder_name}</Text>
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
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))', gap: '0.5rem 1rem' }}>
                <div className="portal-bk__form">
                  <Label showColon>Status</Label>
                  <Select onChange={(e) => setF({ ...f, status: (e.detail.selectedOption as HTMLElement).dataset.s ?? '' })}>
                    {Object.entries(daten.status).map(([k, t]) => <Option key={k} data-s={k} selected={f.status === k}>{t}</Option>)}
                  </Select>
                  <Label showColon>Zuständig</Label>
                  <Select onChange={(e) => setF({ ...f, zustaendig: (e.detail.selectedOption as HTMLElement).dataset.u ?? '' })}>
                    <Option data-u="" selected={!f.zustaendig}>– niemand –</Option>
                    {daten.bearbeiter.map((b) => <Option key={b.id} data-u={b.id} selected={f.zustaendig === b.id}>{b.name}</Option>)}
                    {d.zustaendig && !daten.bearbeiter.some((b) => b.id === d.zustaendig) && <Option data-u={d.zustaendig} selected={f.zustaendig === d.zustaendig}>{d.zustaendig_name}</Option>}
                  </Select>
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
                  <Label showColon>Paperless (Angebot/Rechnung)</Label>
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
            </>
          )}
          {!edit && (d.erledigung || d.kosten != null) && (
            <Text>{d.erledigung}{d.kosten != null ? ` · Kosten ${eur(d.kosten)}` : ''}{d.firma ? ` · ${d.firma}` : ''}</Text>
          )}

          <Title level="H6">Verlauf</Title>
          {d.verlauf.map((v) => (
            <Text key={v.id} className="portal-small" style={{ display: 'block' }}>
              {zeitpunkt(v.am)} · {v.von}{v.status_txt ? ` · ${v.status_txt}` : ''}{v.text ? `: ${v.text}` : ''}{!v.fuer_melder ? ' (intern)' : ''}
            </Text>
          ))}
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------- Stammdaten

interface StammDaten {
  anlagen: { id: number; kuerzel: string; bezeichnung: string; typ: string; platz_id: number | null; platz: string | null; sort: number; aktiv: boolean }[];
  kategorien: { id: number; bezeichnung: string; zustaendig: string | null; zustaendig_name: string | null; sort: number; aktiv: boolean }[];
  einstellungen: { vorstand_email: string; foto_frist_monate: number };
  bearbeiter: { id: string; name: string }[];
  typen: Texte;
  plaetze: { id: number; name: string }[];
}
type AnlageForm = { id: number | null; kuerzel: string; bezeichnung: string; typ: string; platz_id: string; sort: string; aktiv: boolean };
type KatForm = { id: number | null; bezeichnung: string; zustaendig: string; sort: string; aktiv: boolean };

function Stammdaten({ onError }: { onError: (e: string) => void }) {
  const [s, setS] = useState<StammDaten | null>(null);
  const [cfg, setCfg] = useState({ vorstand_email: '', foto_frist_monate: '24' });
  const [anlage, setAnlage] = useState<AnlageForm | null>(null);
  const [kat, setKat] = useState<KatForm | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const laden = () => api.get<StammDaten>(`${I}/stamm/daten`).then((x) => {
    setS(x); setCfg({ vorstand_email: x.einstellungen.vorstand_email, foto_frist_monate: String(x.einstellungen.foto_frist_monate) });
  }).catch((e) => onError(e.message));
  useEffect(() => { laden(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function cfgSichern() {
    try { const r = await api.put<{ text: string }>(`${I}/stamm/einstellungen`, { vorstand_email: cfg.vorstand_email, foto_frist_monate: Number(cfg.foto_frist_monate) }); toast(r.text); laden(); }
    catch (e) { onError((e as Error).message); }
  }
  if (!s) return <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />;
  return (
    <>
      <Section title="Benachrichtigung und Fotos">
        <div className="portal-bk__form" style={{ maxWidth: '36rem' }}>
          <Label showColon>E-Mail Vorstand</Label>
          <Input value={cfg.vorstand_email} placeholder="vorstand@… (mehrere mit Komma)" onInput={(e) => setCfg({ ...cfg, vorstand_email: e.target.value })} />
          <Text className="portal-muted portal-small">Erhält jedes Sicherheitsrisiko (und nach 24 h ohne Reaktion eine Erinnerung) sowie Meldungen, deren Kategorie keinen Zuständigen hat.</Text>
          <Label showColon>Fotos erledigter Meldungen löschen nach (Monaten)</Label>
          <Input type="Number" value={cfg.foto_frist_monate} onInput={(e) => setCfg({ ...cfg, foto_frist_monate: e.target.value })} />
          <div className="portal-row"><Button design="Emphasized" icon="save" onClick={cfgSichern}>Sichern</Button></div>
        </div>
      </Section>

      <Section title="Anlagen" count={s.anlagen.length}
               actions={<>
                 <Button design="Transparent" icon="print" onClick={() => setQr(`${I}/stamm/qr.pdf`)}>QR-Codes drucken</Button>
                 <Button design="Transparent" icon="add" onClick={() => setAnlage({ id: null, kuerzel: '', bezeichnung: '', typ: 'PLATZ', platz_id: '', sort: '0', aktiv: true })}>Anlage anlegen</Button>
               </>}>
        <div className="portal-ih__rahmen"><table className="portal-ih__tabelle">
          <thead><tr><th>Bezeichnung</th><th>Kürzel (QR-Link)</th><th>Typ</th><th>Platzbuchung</th><th /></tr></thead>
          <tbody>
            {s.anlagen.map((a) => (
              <tr key={a.id} className={a.aktiv ? undefined : 'portal-ih__inaktiv'}>
                <td>{a.bezeichnung}{!a.aktiv && ' (inaktiv)'}</td><td>{a.kuerzel}</td><td>{s.typen[a.typ]}</td><td>{a.platz ?? '–'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <Button design="Transparent" icon="print" tooltip="QR-Code drucken" disabled={!a.aktiv} onClick={() => setQr(`${I}/stamm/qr.pdf?anlage=${a.id}`)} />
                  <Button design="Transparent" icon="edit" tooltip="Bearbeiten"
                          onClick={() => setAnlage({ id: a.id, kuerzel: a.kuerzel, bezeichnung: a.bezeichnung, typ: a.typ, platz_id: a.platz_id ? String(a.platz_id) : '', sort: String(a.sort), aktiv: a.aktiv })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </Section>

      <Section title="Kategorien und Zuständige" count={s.kategorien.length}
               actions={<Button design="Transparent" icon="add" onClick={() => setKat({ id: null, bezeichnung: '', zustaendig: '', sort: '0', aktiv: true })}>Kategorie anlegen</Button>}>
        <div className="portal-ih__rahmen"><table className="portal-ih__tabelle">
          <thead><tr><th>Kategorie</th><th>Zuständig (erhält neue Meldungen)</th><th /></tr></thead>
          <tbody>
            {s.kategorien.map((k) => (
              <tr key={k.id} className={k.aktiv ? undefined : 'portal-ih__inaktiv'}>
                <td>{k.bezeichnung}{!k.aktiv && ' (inaktiv)'}</td><td>{k.zustaendig_name ?? '– Vorstand –'}</td>
                <td style={{ textAlign: 'right' }}>
                  <Button design="Transparent" icon="edit" tooltip="Bearbeiten"
                          onClick={() => setKat({ id: k.id, bezeichnung: k.bezeichnung, zustaendig: k.zustaendig ?? '', sort: String(k.sort), aktiv: k.aktiv })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <Text className="portal-muted portal-small">Zur Auswahl stehen Benutzer mit der Berechtigung „Schadensmeldungen bearbeiten“.</Text>
      </Section>

      {anlage && <AnlageDialog f={anlage} s={s} onClose={(neu) => { setAnlage(null); if (neu) laden(); }} />}
      {kat && <KategorieDialog f={kat} s={s} onClose={(neu) => { setKat(null); if (neu) laden(); }} />}
      <PdfDialog url={qr} title="QR-Codes Schadensmeldung" filename="qr-schadensmeldung.pdf" onClose={() => setQr(null)} />
    </>
  );
}

function AnlageDialog({ f: start, s, onClose }: { f: AnlageForm; s: StammDaten; onClose: (neu: boolean) => void }) {
  const [f, setF] = useState(start);
  const [error, setError] = useState<string | null>(null);
  async function sichern() {
    try {
      const body = { kuerzel: f.kuerzel, bezeichnung: f.bezeichnung, typ: f.typ, platz_id: f.platz_id ? Number(f.platz_id) : null, sort: Number(f.sort) || 0, aktiv: f.aktiv };
      const r = await (f.id ? api.put<{ text: string }>(`${I}/stamm/anlagen/${f.id}`, body) : api.post<{ text: string }>(`${I}/stamm/anlagen`, body));
      toast(r.text); onClose(true);
    } catch (e) { setError((e as Error).message); }
  }
  return (
    <Dialog open headerText={f.id ? 'Anlage bearbeiten' : 'Anlage anlegen'} style={{ width: 'min(28rem, 96vw)' }} onClose={() => onClose(false)}
            footer={<Bar endContent={<><Button design="Emphasized" icon="save" onClick={sichern}>Sichern</Button><Button onClick={() => onClose(false)}>Abbrechen</Button></>} />}>
      <div className="portal-bk__form">
        {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
        <Label showColon required>Bezeichnung</Label>
        <Input value={f.bezeichnung} maxlength={80} onInput={(e) => setF({ ...f, bezeichnung: e.target.value })} />
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

function KategorieDialog({ f: start, s, onClose }: { f: KatForm; s: StammDaten; onClose: (neu: boolean) => void }) {
  const [f, setF] = useState(start);
  const [error, setError] = useState<string | null>(null);
  async function sichern() {
    try {
      const body = { bezeichnung: f.bezeichnung, zustaendig: f.zustaendig || null, sort: Number(f.sort) || 0, aktiv: f.aktiv };
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
        <Label showColon>Zuständig</Label>
        <Select onChange={(e) => setF({ ...f, zustaendig: (e.detail.selectedOption as HTMLElement).dataset.u ?? '' })}>
          <Option data-u="" selected={!f.zustaendig}>– Vorstand (E-Mail aus den Einstellungen) –</Option>
          {s.bearbeiter.map((b) => <Option key={b.id} data-u={b.id} selected={f.zustaendig === b.id}>{b.name}</Option>)}
        </Select>
        <Label showColon>Reihenfolge</Label>
        <Input type="Number" value={f.sort} onInput={(e) => setF({ ...f, sort: e.target.value })} />
        <CheckBox text="aktiv (auswählbar beim Melden)" checked={f.aktiv} onChange={(e) => setF({ ...f, aktiv: e.target.checked })} />
      </div>
    </Dialog>
  );
}
