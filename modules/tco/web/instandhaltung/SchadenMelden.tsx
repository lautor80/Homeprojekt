import { useEffect, useRef, useState } from 'react';
import {
  Bar, BusyIndicator, Button, Dialog, Label, MessageStrip, ObjectStatus, Option, Select, Text, TextArea,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { Section } from '@core/components/Section';
import { toast } from '@core/toast';
import { TCO, dat } from '../util';
import { AUSWIRKUNG_STATE, FOTO_URL, STATUS_STATE, fotoVerkleinern, zeitpunkt, type Foto } from './foto';

/**
 * Schaden melden (#205): mobil in unter einer Minute – Ort (per QR-Code vorbelegt: /tco/schaden?anlage=<kürzel>), Kategorie,
 * Auswirkung, Beschreibung, bis zu 3 Fotos. Vorher Hinweis auf bereits offene Meldungen am selben Ort. Darunter „Meine Meldungen“.
 */
const S = `${TCO}/schaden`;
interface Stamm {
  anlagen: { id: number; kuerzel: string; bezeichnung: string; typ: string }[];
  kategorien: { id: number; bezeichnung: string }[];
  auswirkungen: Record<string, string>;
}
interface Offen { id: number; nummer: string; kategorie: string; beschreibung: string; auswirkung: string; status: string; eingang: string }
interface Meine {
  id: number; nummer: string; anlage: string; kategorie: string; beschreibung: string; auswirkung: string; auswirkung_txt: string;
  status: string; status_txt: string; eingang: string; erledigung: string | null;
  verlauf: { am: string; von: string; status: string | null; status_txt: string | null; text: string | null }[];
  fotos: { id: number; art: string }[];
}
const LEER = { anlage: 0, kategorie: 0, auswirkung: '', beschreibung: '' };

export function SchadenMelden() {
  const [stamm, setStamm] = useState<Stamm | null>(null);
  const [f, setF] = useState(LEER);
  const [fotos, setFotos] = useState<Foto[]>([]);
  const [offen, setOffen] = useState<Offen[]>([]);
  const [meine, setMeine] = useState<Meine[] | null>(null);
  const [frage, setFrage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [erfolg, setErfolg] = useState<string | null>(null);
  const datei = useRef<HTMLInputElement>(null);

  const meineLaden = () => api.get<Meine[]>(`${S}/meine`).then(setMeine).catch((e) => setError(e.message));
  useEffect(() => {
    api.get<Stamm>(`${S}/stamm`).then((s) => {
      setStamm(s);
      const k = new URLSearchParams(window.location.search).get('anlage')?.toLowerCase();
      const a = k ? s.anlagen.find((x) => x.kuerzel.toLowerCase() === k || String(x.id) === k) : undefined;
      if (a) setF((x) => ({ ...x, anlage: a.id }));
    }).catch((e) => setError(e.message));
    meineLaden();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!f.anlage) { setOffen([]); return; }
    api.get<Offen[]>(`${S}/offen?anlage=${f.anlage}`).then(setOffen).catch(() => setOffen([]));
  }, [f.anlage]);

  async function fotosWaehlen(liste: FileList | null) {
    if (!liste?.length) return;
    setError(null);
    try {
      const neu: Foto[] = [];
      for (const x of Array.from(liste).slice(0, 3 - fotos.length)) neu.push(await fotoVerkleinern(x));
      setFotos([...fotos, ...neu]);
    } catch (e) { setError((e as Error).message); }
    if (datei.current) datei.current.value = '';
  }

  async function senden() {
    setFrage(false); setBusy(true); setError(null);
    try {
      const r = await api.post<{ nummer: string; text: string }>(S, {
        anlage_id: f.anlage, kategorie_id: f.kategorie, auswirkung: f.auswirkung, beschreibung: f.beschreibung, fotos,
      });
      setErfolg(r.text); toast(r.text, 6000);
      setF({ ...LEER, anlage: f.anlage }); setFotos([]);
      meineLaden();
      api.get<Offen[]>(`${S}/offen?anlage=${f.anlage}`).then(setOffen).catch(() => undefined);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const pruefen = () => {
    if (!f.anlage || !f.kategorie || !f.auswirkung || f.beschreibung.trim().length < 3) {
      setError('Bitte Ort, Kategorie und Auswirkung wählen und kurz beschreiben, was kaputt ist.');
      return;
    }
    if (offen.length) setFrage(true); else senden();
  };

  return (
    <AppPage title="Schaden melden" subtitle="Etwas kaputt auf der Anlage? Kurz melden – der Platzwart bzw. Vorstand wird informiert.">
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {erfolg && <MessageStrip design="Positive" onClose={() => setErfolg(null)} style={{ marginBottom: '0.5rem' }}>{erfolg}</MessageStrip>}
      {!stamm ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : (
        <Section title="Neue Meldung">
          <div className="portal-bk__form" style={{ maxWidth: '36rem' }}>
            <Label showColon required>Wo?</Label>
            <Select onChange={(e) => setF({ ...f, anlage: Number((e.detail.selectedOption as HTMLElement).dataset.id) })}>
              <Option data-id="0" selected={!f.anlage}>Bitte wählen …</Option>
              {stamm.anlagen.map((a) => <Option key={a.id} data-id={a.id} selected={f.anlage === a.id}>{a.bezeichnung}</Option>)}
            </Select>
            {offen.length > 0 && (
              <MessageStrip design="Information" hideCloseButton>
                <b>Hier ist schon gemeldet:</b>
                {offen.map((o) => <div key={o.id}>{o.nummer} · {o.kategorie} · {o.beschreibung.length > 80 ? `${o.beschreibung.slice(0, 79)}…` : o.beschreibung} ({dat(o.eingang)})</div>)}
              </MessageStrip>
            )}
            <Label showColon required>Was?</Label>
            <Select onChange={(e) => setF({ ...f, kategorie: Number((e.detail.selectedOption as HTMLElement).dataset.id) })}>
              <Option data-id="0" selected={!f.kategorie}>Bitte wählen …</Option>
              {stamm.kategorien.map((k) => <Option key={k.id} data-id={k.id} selected={f.kategorie === k.id}>{k.bezeichnung}</Option>)}
            </Select>
            <Label showColon required>Auswirkung</Label>
            <Select onChange={(e) => setF({ ...f, auswirkung: (e.detail.selectedOption as HTMLElement).dataset.a ?? '' })}>
              <Option data-a="" selected={!f.auswirkung}>Bitte wählen …</Option>
              {Object.entries(stamm.auswirkungen).map(([k, t]) => <Option key={k} data-a={k} selected={f.auswirkung === k}>{t}</Option>)}
            </Select>
            {f.auswirkung === 'SICHERHEIT' && (
              <MessageStrip design="Critical" hideCloseButton>Bei akuter Gefahr bitte die Stelle möglichst absichern und zusätzlich den Vorstand direkt anrufen.</MessageStrip>
            )}
            <Label showColon required>Beschreibung</Label>
            <TextArea rows={4} maxlength={2000} value={f.beschreibung} placeholder="Was ist kaputt? Wo genau?"
                      onInput={(e) => setF({ ...f, beschreibung: e.target.value })} />
            <Label showColon>Fotos (höchstens 3)</Label>
            <input ref={datei} type="file" accept="image/*" capture="environment" multiple style={{ display: 'none' }}
                   onChange={(e) => fotosWaehlen(e.target.files)} />
            <div className="portal-row" style={{ flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
              {fotos.map((x, i) => (
                <div key={i} style={{ position: 'relative' }}>
                  <img src={x.data} alt={x.name} style={{ width: '5.5rem', height: '5.5rem', objectFit: 'cover', borderRadius: '0.5rem', display: 'block' }} />
                  <Button design="Transparent" icon="decline" tooltip="Foto entfernen" style={{ position: 'absolute', top: 0, right: 0 }}
                          onClick={() => setFotos(fotos.filter((_, j) => j !== i))} />
                </div>
              ))}
              {fotos.length < 3 && <Button icon="camera" onClick={() => datei.current?.click()}>Foto aufnehmen / wählen</Button>}
            </div>
            <Text className="portal-muted portal-small">Bitte keine Personen fotografieren. Fotos werden verkleinert und nach Erledigung später gelöscht.</Text>
            <div className="portal-row" style={{ marginTop: '0.5rem' }}>
              <Button design="Emphasized" icon="paper-plane" loading={busy} onClick={pruefen}>Schaden melden</Button>
            </div>
          </div>
        </Section>
      )}

      <Section title="Meine Meldungen" count={meine?.length}>
        {!meine ? <BusyIndicator active /> : !meine.length ? <Text className="portal-muted">Du hast noch keinen Schaden gemeldet.</Text> : meine.map((m) => (
          <div key={m.id} style={{ borderBottom: '1px solid var(--sapList_BorderColor)', padding: '0.5rem 0' }}>
            <div className="portal-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.25rem 1rem' }}>
              <Text><b>{m.nummer}</b> · {m.anlage} · {m.kategorie}</Text>
              <span>
                <ObjectStatus state={AUSWIRKUNG_STATE[m.auswirkung]}>{m.auswirkung_txt}</ObjectStatus>{' '}
                <ObjectStatus state={STATUS_STATE[m.status]} inverted>{m.status_txt}</ObjectStatus>
              </span>
            </div>
            <Text style={{ display: 'block', whiteSpace: 'pre-line' }}>{m.beschreibung}</Text>
            {m.fotos.length > 0 && (
              <div className="portal-row" style={{ gap: '0.35rem', marginTop: '0.35rem' }}>
                {m.fotos.map((x) => <a key={x.id} href={FOTO_URL(x.id)} target="_blank" rel="noreferrer"><img src={FOTO_URL(x.id)} alt={x.art === 'NACHHER' ? 'Foto nach der Reparatur' : 'Foto'} style={{ width: '3.5rem', height: '3.5rem', objectFit: 'cover', borderRadius: '0.35rem' }} /></a>)}
              </div>
            )}
            {m.verlauf.map((v, i) => (
              <Text key={i} className="portal-muted portal-small" style={{ display: 'block' }}>
                {zeitpunkt(v.am)} · {v.von}{v.status_txt ? ` · ${v.status_txt}` : ''}{v.text ? `: ${v.text}` : ''}
              </Text>
            ))}
          </div>
        ))}
      </Section>

      {frage && (
        <Dialog open headerText="Schon bekannt?" onClose={() => setFrage(false)}
                footer={<Bar endContent={<>
                  <Button design="Emphasized" onClick={senden}>Trotzdem melden</Button>
                  <Button onClick={() => setFrage(false)}>Abbrechen</Button>
                </>} />}>
          <Text>An diesem Ort {offen.length === 1 ? 'ist bereits ein Schaden' : `sind bereits ${offen.length} Schäden`} gemeldet und in Bearbeitung.
            Wenn es sich um denselben Schaden handelt, ist keine neue Meldung nötig.</Text>
        </Dialog>
      )}
    </AppPage>
  );
}
