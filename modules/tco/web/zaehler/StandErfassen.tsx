import { useEffect, useRef, useState } from 'react';
import {
  Button, DatePicker, Dialog, Input, MessageStrip, Option, Select, Text, TextArea,
} from '@ui5/webcomponents-react';
import { FussLeiste } from '@core/components/DialogFuss';
import { ApiError, api } from '@core/api';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { FieldBox, FormGrid } from '@core/components/FormFields';
import { toast } from '@core/toast';
import { dat } from '../util';
import { fotoVerkleinern } from '../instandhaltung/foto';
import { FOTO_URL, Z, heute, mitEinheit, standText, vEinheit, zahlEingabe, zahlLesen } from './format';
import { STAND_ARTEN, type Pruefung, type StandArt, type StandEingabe, type ZaehlerZeile, type Zaehlerstand } from './typen';

/**
 * Zählerstand erfassen oder ändern – als Dialog (App „Zählerstände“, Detailseite) und als Handy-Seite am Zähler (QR-Code,
 * ZaehlerErfassen). Stand mit deutschem Komma; Foto direkt mit der Kamera (`capture="environment"`), im Browser per
 * Canvas auf höchstens 1600 px verkleinert und als JPEG-data:-URL gesendet (fotoVerkleinern, wie bei Schadensmeldungen).
 * Während der Eingabe prüft der Server entprellt (POST /zaehler/:id/staende/pruefen): Verbrauch seit der vorigen
 * Ablesung, Fehler (Speichern gesperrt) und Warnung (Speichern nur nach Bestätigung, dann mit `bestaetigt: true`).
 */
export interface Gespeichert { id: number; zaehlerId: number; verbrauch: number | null }

interface Optionen {
  zaehler: ZaehlerZeile[];
  zaehlerId?: number;
  /** Ändern eines vorhandenen Stands (PUT /zaehler/staende/:sid) */
  bearbeiten?: Zaehlerstand;
  onGespeichert: (g: Gespeichert) => void;
}

export function useStandErfassung({ zaehler, zaehlerId, bearbeiten, onGespeichert }: Optionen) {
  const [zid, setZid] = useState<number>(bearbeiten?.zaehler_id ?? zaehlerId ?? 0);
  const [datum, setDatum] = useState(bearbeiten?.datum ?? heute());
  const [stand, setStand] = useState(bearbeiten ? zahlEingabe(bearbeiten.stand) : '');
  const [art, setArt] = useState<StandArt>(bearbeiten?.art ?? 'ABLESUNG');
  const [notiz, setNotiz] = useState(bearbeiten?.notiz ?? '');
  /** undefined = Foto unverändert, null = entfernen, string = neues Foto (data:-URL) */
  const [foto, setFoto] = useState<string | null | undefined>(undefined);
  const [pruefung, setPruefung] = useState<Pruefung | null>(null);
  const [prueft, setPrueft] = useState(false);
  const [frage, setFrage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lauf = useRef(0);

  useEffect(() => { if (!bearbeiten && zaehlerId) setZid(zaehlerId); }, [zaehlerId, bearbeiten]);
  const wert = zahlLesen(stand);
  const z = zaehler.find((x) => x.id === zid) ?? null;

  // Live-Prüfung, entprellt (nur bei neuen Ständen – beim Ändern prüft der Server beim Sichern)
  useEffect(() => {
    setPruefung(null);
    if (bearbeiten || !zid || wert === null || !datum) { setPrueft(false); return; }
    const n = ++lauf.current;
    setPrueft(true);
    const t = setTimeout(() => {
      api.post<Pruefung>(`${Z}/${zid}/staende/pruefen`, { datum, stand: wert, art, notiz: null } satisfies StandEingabe)
        .then((p) => { if (n === lauf.current) setPruefung(p); })
        .catch((e) => { if (n === lauf.current) setPruefung({ fehler: (e as Error).message, warnung: null, verbrauch: null, tagesverbrauch: null, vorher: null }); })
        .finally(() => { if (n === lauf.current) setPrueft(false); });
    }, 450);
    return () => clearTimeout(t);
  }, [zid, datum, wert, art, bearbeiten]);

  function zuruecksetzen(naechster?: number) {
    if (naechster !== undefined) setZid(naechster);
    setDatum(heute()); setStand(''); setArt('ABLESUNG'); setNotiz(''); setFoto(undefined); setPruefung(null); setError(null); setFrage(null);
  }

  async function fotoWaehlen(f: File | undefined) {
    if (!f) return;
    setError(null);
    try { setFoto((await fotoVerkleinern(f)).data); } catch (e) { setError((e as Error).message); }
  }

  async function speichern(bestaetigt = false) {
    setError(null);
    if (!zid) { setError('Bitte einen Zähler wählen.'); return; }
    if (!datum) { setError('Bitte das Datum der Ablesung angeben.'); return; }
    if (wert === null) { setError('Bitte den Zählerstand als Zahl eingeben (Komma als Dezimalzeichen).'); return; }
    if (!bestaetigt && pruefung?.warnung) { setFrage(pruefung.warnung); return; }
    setFrage(null); setBusy(true);
    const body: StandEingabe = { datum, stand: wert, art, notiz: notiz.trim() || null, ...(foto !== undefined ? { foto } : {}), ...(bestaetigt ? { bestaetigt: true } : {}) };
    try {
      if (bearbeiten) {
        await api.put(`${Z}/staende/${bearbeiten.id}`, body);
        toast('Zählerstand geändert');
        onGespeichert({ id: bearbeiten.id, zaehlerId: zid, verbrauch: null });
      } else {
        const r = await api.post<{ id: number; pruefung: Pruefung }>(`${Z}/${zid}/staende`, body);
        toast('Zählerstand gesichert');
        onGespeichert({ id: r.id, zaehlerId: zid, verbrauch: r.pruefung?.verbrauch ?? null });
      }
    } catch (e) {
      // Warnung ohne Bestätigung: 409 mit Text → Bestätigungsdialog, danach erneut mit bestaetigt: true
      if (e instanceof ApiError && e.status === 409) setFrage(e.message);
      else setError((e as Error).message);
    } finally { setBusy(false); }
  }

  const gesperrt = busy || !zid || wert === null || !!pruefung?.fehler;
  return {
    zid, setZid, datum, setDatum, stand, setStand, art, setArt, notiz, setNotiz, foto, setFoto, fotoWaehlen,
    pruefung, prueft, frage, setFrage, busy, error, setError, speichern, zuruecksetzen, gesperrt, wert, z, zaehler, bearbeiten,
  };
}
export type StandErfassung = ReturnType<typeof useStandErfassung>;

/** Die Eingabefelder (ohne Knöpfe) – Zähler wählbar, wenn kein fester Zähler vorgegeben ist */
export function StandFelder({ s, zaehlerWaehlbar = true }: { s: StandErfassung; zaehlerWaehlbar?: boolean }) {
  const datei = useRef<HTMLInputElement>(null);
  const z = s.z;
  const einheit = z?.einheit ?? '';
  const ve = z ? vEinheit(z) : '';
  const vorher = s.pruefung?.vorher ?? (s.bearbeiten ? null : z?.kennzahlen.letzteAblesung ?? null);
  const auswahl = [...s.zaehler].filter((x) => x.aktiv || x.id === s.zid)
    .sort((a, b) => (a.standort ?? '').localeCompare(b.standort ?? '', 'de') || a.nummer.localeCompare(b.nummer));
  const fotoAnzeige = s.foto ? s.foto : s.foto === undefined && s.bearbeiten?.hatFoto ? FOTO_URL(s.bearbeiten.id) : null;
  const p = s.pruefung;
  return (
    <FormGrid columns={1}>
      {s.error && <MessageStrip design="Negative" onClose={() => s.setError(null)}>{s.error}</MessageStrip>}
      {zaehlerWaehlbar && !s.bearbeiten ? (
        <FieldBox label="Zähler" required>
          <Select style={{ width: '100%' }} onChange={(e) => s.setZid(Number((e.detail.selectedOption as HTMLElement).dataset.id))}>
            <Option data-id="0" selected={!s.zid}>Bitte wählen …</Option>
            {auswahl.map((x) => (
              <Option key={x.id} data-id={x.id} selected={x.id === s.zid}>{`${x.nummer} · ${x.bezeichnung}${x.standort ? ` (${x.standort})` : ''}`}</Option>
            ))}
          </Select>
        </FieldBox>
      ) : z && (
        <FieldBox label="Zähler"><Text>{`${z.nummer} · ${z.bezeichnung}${z.standort ? ` (${z.standort})` : ''}`}</Text></FieldBox>
      )}
      {z && (
        <Text className="portal-muted">
          {vorher ? `Voriger Stand: ${standText(vorher.stand)} ${einheit} am ${dat(vorher.datum)}` : 'Noch keine Ablesung – dies wird der Anfangsstand.'}
          {z.zaehlernummer ? ` · Gerät Nr. ${z.zaehlernummer}` : ''}
        </Text>
      )}
      <FieldBox label="Datum" required>
        <DatePicker style={{ width: '100%' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={s.datum} maxDate={heute()}
                    onChange={(e) => s.setDatum(e.detail.value)} />
      </FieldBox>
      <FieldBox label={`Zählerstand${einheit ? ` (${einheit})` : ''}`} required>
        <Input style={{ width: '100%' }} value={s.stand} placeholder="z. B. 12345,6" data-kein-autofill
               valueState={s.stand.trim() && s.wert === null ? 'Negative' : 'None'}
               onInput={(e) => s.setStand(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter' && !s.gesperrt) s.speichern(); }}>
          {s.stand.trim() && s.wert === null && <div slot="valueStateMessage">Bitte nur Ziffern und ein Komma eingeben.</div>}
        </Input>
      </FieldBox>
      <FieldBox label="Art">
        <Select style={{ width: '100%' }} onChange={(e) => s.setArt((e.detail.selectedOption as HTMLElement).dataset.k as StandArt)}>
          {STAND_ARTEN.map((a) => <Option key={a.key} data-k={a.key} selected={a.key === s.art}>{a.text}</Option>)}
        </Select>
      </FieldBox>
      {s.prueft && <Text className="portal-muted portal-small">Wird geprüft …</Text>}
      {p?.fehler && <MessageStrip design="Negative" hideCloseButton>{p.fehler}</MessageStrip>}
      {!p?.fehler && p?.warnung && <MessageStrip design="Critical" hideCloseButton>{p.warnung} Beim Sichern wird eine Bestätigung verlangt.</MessageStrip>}
      {!p?.fehler && p && p.verbrauch !== null && (
        <MessageStrip design={p.warnung ? 'Critical' : 'Information'} hideCloseButton>
          {`Verbrauch seit ${p.vorher ? dat(p.vorher.datum) : 'der vorigen Ablesung'}: ${mitEinheit(p.verbrauch, ve)}`}
          {p.tagesverbrauch !== null ? ` (Ø ${mitEinheit(p.tagesverbrauch, ve)} je Tag)` : ''}
        </MessageStrip>
      )}
      <FieldBox label="Notiz">
        <TextArea rows={2} maxlength={500} value={s.notiz} placeholder="optional, z. B. Zähler schwer zugänglich" onInput={(e) => s.setNotiz(e.target.value)} />
      </FieldBox>
      <FieldBox label="Foto vom Zählwerk">
        <input ref={datei} type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
               onChange={(e) => { s.fotoWaehlen(e.target.files?.[0]); e.target.value = ''; }} />
        <div className="portal-row">
          {fotoAnzeige && <img src={fotoAnzeige} alt="Foto vom Zählwerk" style={{ width: '6rem', height: '6rem', objectFit: 'cover', borderRadius: '0.5rem' }} />}
          <Button icon="camera" onClick={() => datei.current?.click()}>{fotoAnzeige ? 'Anderes Foto' : 'Foto aufnehmen / wählen'}</Button>
          {fotoAnzeige && <Button design="Transparent" icon="delete" onClick={() => s.setFoto(s.bearbeiten?.hatFoto ? null : undefined)}>Foto entfernen</Button>}
        </div>
        <Text className="portal-muted portal-small">Optional – hilft bei Rückfragen. Das Foto wird vor dem Hochladen verkleinert.</Text>
      </FieldBox>
    </FormGrid>
  );
}

/** Bestätigung bei einer Warnung des Servers (z. B. ungewöhnlich hoher Verbrauch) */
export function WarnungBestaetigen({ s }: { s: StandErfassung }) {
  return (
    <ConfirmDialog open={!!s.frage} title="Zählerstand prüfen" confirmText="Trotzdem sichern"
                   text={`${s.frage ?? ''}\n\nIst der Stand richtig abgelesen? Dann trotzdem sichern.`}
                   onConfirm={() => s.speichern(true)} onCancel={() => s.setFrage(null)} />
  );
}

/** Dialog „Zählerstand erfassen“ bzw. „Zählerstand ändern“ */
export function StandErfassenDialog({ zaehler, zaehlerId, bearbeiten, onClose, onGespeichert }: Omit<Optionen, 'onGespeichert'> & {
  onClose: () => void; onGespeichert: (g: Gespeichert) => void;
}) {
  const s = useStandErfassung({ zaehler, zaehlerId, bearbeiten, onGespeichert });
  return (
    <>
      <Dialog open headerText={bearbeiten ? 'Zählerstand ändern' : 'Zählerstand erfassen'} onClose={onClose} style={{ width: 'min(34rem, 96vw)' }}
              footer={<FussLeiste endContent={<>
                <Button design="Emphasized" icon="save" disabled={s.gesperrt} loading={s.busy} onClick={() => s.speichern()}>Sichern</Button>
                <Button onClick={onClose}>Abbrechen</Button>
              </>} />}>
        <StandFelder s={s} zaehlerWaehlbar={!zaehlerId} />
      </Dialog>
      <WarnungBestaetigen s={s} />
    </>
  );
}

