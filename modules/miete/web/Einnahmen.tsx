import { useEffect, useState } from 'react';
import { Button, CheckBox, Dialog, MessageStrip } from '@ui5/webcomponents-react';
import { FussLeiste } from '@core/components/DialogFuss';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { Filter, Filters, HeaderKpi } from '@core/components/Filters';
import { FormGrid, TextField } from '@core/components/FormFields';
import { Section } from '@core/components/Section';
import { useLoad } from '@core/components/useLoad';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { aufteilungFesteMiete, folgemonatVorlage } from './folgemonat';
import { AuswahlFeld, dat, DatumFeld, eur, heute, JahrAuswahl, M, monatText, summe, Tabelle, zahl, zahlText, ZahlFeld, type Vertrag } from './util';

interface Zahlung { id: number; vertrag_id: number; nummer: string; name: string; einheit: string; datum: string; monat: string; betrag: number; anteil_miete: number; anteil_nk: number; notiz: string | null }
interface Soll { vertrag_id: number; name: string; einheit: string; miete: number; nk: number; bezahlt: number }

const EDIT = 'miete.zahlungen:edit';

/** Mieteingänge je Leistungsmonat, aufgeteilt in Kaltmiete und Nebenkosten-Abschlag */
export function Einnahmen() {
  const can = useCan();
  const [jahr, setJahr] = useState(new Date().getFullYear());
  const liste = useLoad(() => api.get<Zahlung[]>(`${M}/zahlungen?jahr=${jahr}`), [jahr]);
  const vertraege = useLoad(() => api.get<Vertrag[]>(`${M}/vertraege`), []);
  const [dialog, setDialog] = useState<Partial<Zahlung> | null>(null);
  /** Kopie in den Folgemonat: Kaltmiete bleibt fest, keine Vorbelegung aus dem Soll */
  const [kopie, setKopie] = useState(false);
  const oeffnen = (x: Partial<Zahlung>, alsKopie = false) => { setKopie(alsKopie); setDialog(x); };
  const [monatslauf, setMonatslauf] = useState(false);
  const [loeschen, setLoeschen] = useState<Zahlung | null>(null);
  const z = liste.data ?? [];

  async function entfernen(reason: string) {
    const x = loeschen!;
    setLoeschen(null);
    try { await api.del(`${M}/zahlungen/${x.id}`, { reason }); toast('Mieteingang gelöscht'); liste.reload(); } catch (e) { toast((e as Error).message); }
  }

  return (
    <AppPage title="Mieteinnahmen" subtitle={`${z.length} Eingänge ${jahr}`}
      actions={can(EDIT) && <>
        <Button icon="add" design="Emphasized" onClick={() => oeffnen({ datum: heute(), monat: `${heute().slice(0, 7)}-01` })}>Eingang erfassen</Button>
        <Button icon="activity-items" onClick={() => setMonatslauf(true)}>Monat buchen</Button>
      </>}
      header={<Filters>
        <Filter label="Jahr"><JahrAuswahl jahr={jahr} onChange={setJahr} /></Filter>
        <HeaderKpi label="Kaltmiete" value={eur(z.reduce((s, x) => s + x.anteil_miete, 0))} />
        <HeaderKpi label="Nebenkosten-Abschläge" value={eur(z.reduce((s, x) => s + x.anteil_nk, 0))} />
        <HeaderKpi label="Gesamt" value={eur(z.reduce((s, x) => s + x.betrag, 0))} />
      </Filters>}>
      {liste.error && <MessageStrip design="Negative" hideCloseButton>{liste.error}</MessageStrip>}
      <Section title="Eingänge" count={z.length} flush>
        <Tabelle<Zahlung> schluessel={(x) => x.id} zeilen={z} leer="Noch keine Mieteingänge in diesem Jahr" onZeile={can(EDIT) ? (x) => oeffnen(x) : undefined} spalten={[
          { titel: 'Monat', fest: true, wert: (x) => monatText(x.monat), summe: () => 'Summe' },
          { titel: 'Eingang', fest: true, wert: (x) => dat(x.datum) },
          { titel: 'Mieter', wert: (x) => `${x.name} (${x.einheit})` },
          { titel: 'Betrag', rechts: true, wert: (x) => eur(x.betrag), summe: summe((x) => x.betrag) },
          { titel: 'Kaltmiete', rechts: true, wert: (x) => eur(x.anteil_miete), summe: summe((x) => x.anteil_miete) },
          { titel: 'NK-Abschlag', rechts: true, wert: (x) => eur(x.anteil_nk), summe: summe((x) => x.anteil_nk) },
          { titel: 'Notiz', wert: (x) => x.notiz ?? '' },
          ...(can(EDIT) ? [{ titel: '', wert: (x: Zahlung) => <>
            <Button design="Transparent" icon="copy" tooltip="In den Folgemonat kopieren" onClick={(e) => { e.stopPropagation(); oeffnen(folgemonatVorlage(x), true); }} />
            <Button design="Transparent" icon="delete" tooltip="Löschen" onClick={(e) => { e.stopPropagation(); setLoeschen(x); }} />
          </> }] : []),
        ]} />
      </Section>
      {dialog && <ZahlungDialog z={dialog} kopie={kopie} vertraege={vertraege.data ?? []} onClose={(neu) => { setDialog(null); if (neu) liste.reload(); }} />}
      {monatslauf && <MonatslaufDialog onClose={(neu) => { setMonatslauf(false); if (neu) liste.reload(); }} />}
      <ConfirmDialog open={!!loeschen} danger askReason title="Mieteingang löschen" confirmText="Löschen"
        text={loeschen ? `Eingang vom ${dat(loeschen.datum)} über ${eur(loeschen.betrag)} (${loeschen.name}) löschen?` : ''}
        onConfirm={entfernen} onCancel={() => setLoeschen(null)} />
    </AppPage>
  );
}

function ZahlungDialog({ z, kopie = false, vertraege, onClose }: { z: Partial<Zahlung>; kopie?: boolean; vertraege: Vertrag[]; onClose: (neu: boolean) => void }) {
  const [f, setF] = useState({
    vertrag_id: z.vertrag_id ?? vertraege.find((v) => !v.ende || v.ende >= heute())?.id ?? null,
    datum: z.datum ?? heute(), monat: z.monat ?? `${heute().slice(0, 7)}-01`,
    betrag: zahlText(z.betrag), miete: zahlText(z.anteil_miete), nk: zahlText(z.anteil_nk), notiz: z.notiz ?? '',
  });
  const [soll, setSoll] = useState<Soll | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Soll des Monats laden; bei neuer Erfassung Betrag und Aufteilung vorbelegen
  useEffect(() => {
    if (!f.vertrag_id || !/^\d{4}-\d{2}-\d{2}$/.test(f.monat)) return;
    api.get<Soll[]>(`${M}/soll?monat=${f.monat}`).then((l) => {
      const s = l.find((x) => x.vertrag_id === f.vertrag_id) ?? null;
      setSoll(s);
      if (!z.id && !kopie && s) {
        // nur den noch offenen Rest vorschlagen, im Verhältnis des Solls aufgeteilt
        const sollG = s.miete + s.nk;
        const rest = Math.max(0, Math.round((sollG - s.bezahlt) * 100) / 100);
        const nk = sollG > 0 ? Math.round(rest * s.nk / sollG * 100) / 100 : 0;
        setF((alt) => ({ ...alt, betrag: zahlText(rest), nk: zahlText(nk), miete: zahlText(Math.round((rest - nk) * 100) / 100) }));
      }
    }).catch(() => setSoll(null));
  }, [f.vertrag_id, f.monat]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Betrag geändert: Aufteilung im Verhältnis des Solls (wie der Server), sonst alles zur Miete.
   *  Kopie in den Folgemonat: Kaltmiete bleibt gleich, die Abweichung geht in den Abschlag. */
  function betragNeu(v: string) {
    const b = zahl(v);
    if (kopie) { const t = aufteilungFesteMiete(b, zahl(f.miete)); setF({ ...f, betrag: v, miete: zahlText(t.miete), nk: zahlText(t.nk) }); return; }
    const sollG = (soll?.miete ?? 0) + (soll?.nk ?? 0);
    const nk = !soll || sollG <= 0 ? 0 : b >= sollG ? soll.nk : Math.round(b * soll.nk / sollG * 100) / 100;
    setF({ ...f, betrag: v, nk: zahlText(nk), miete: zahlText(Math.round((b - nk) * 100) / 100) });
  }

  async function sichern() {
    setBusy(true); setFehler(null);
    try {
      const body = { vertrag_id: f.vertrag_id, datum: f.datum, monat: f.monat, betrag: zahl(f.betrag), anteil_miete: zahl(f.miete), anteil_nk: zahl(f.nk), notiz: f.notiz };
      if (z.id) await api.put(`${M}/zahlungen/${z.id}`, body); else await api.post(`${M}/zahlungen`, body);
      toast('Mieteingang gesichert');
      onClose(true);
    } catch (e) { setFehler((e as Error).message); } finally { setBusy(false); }
  }
  const differenz = Math.round((zahl(f.betrag) - zahl(f.miete) - zahl(f.nk)) * 100) / 100;

  return (
    <Dialog open headerText={z.id ? 'Mieteingang ändern' : kopie ? 'Mieteingang in Folgemonat kopieren' : 'Mieteingang erfassen'} style={{ width: 'min(36rem, 95vw)' }} onClose={() => onClose(false)}
      footer={<FussLeiste endContent={<>
        <Button design="Emphasized" loading={busy} disabled={!f.vertrag_id || differenz !== 0} onClick={sichern}>Sichern</Button>
        <Button onClick={() => onClose(false)}>Abbrechen</Button>
      </>} />}>
      {fehler && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.75rem' }}>{fehler}</MessageStrip>}
      {kopie && <p className="portal-muted" style={{ marginTop: 0 }}>Kopie des Vormonats. Ändert sich der Betrag, bleibt die Kaltmiete gleich – die Abweichung geht in den Nebenkosten-Abschlag.</p>}
      <FormGrid>
        <AuswahlFeld label="Mietverhältnis" required value={f.vertrag_id} onChange={(v) => setF({ ...f, vertrag_id: v })}
          optionen={vertraege.map((v) => ({ key: v.id, text: `${v.name} (${v.einheit})${v.ende && v.ende < heute() ? ' – beendet' : ''}` }))} />
        <DatumFeld label="Leistungsmonat (ein Tag im Monat)" required value={f.monat} onChange={(v) => setF({ ...f, monat: v ? `${v.slice(0, 7)}-01` : v })} />
        <DatumFeld label="Eingangsdatum" required value={f.datum} onChange={(v) => setF({ ...f, datum: v })} />
        <ZahlFeld label="Betrag" required value={f.betrag} onChange={betragNeu} />
        <ZahlFeld label="davon Kaltmiete" value={f.miete} onChange={(v) => setF({ ...f, miete: v, nk: zahlText(Math.round((zahl(f.betrag) - zahl(v)) * 100) / 100) })} />
        <ZahlFeld label="davon Nebenkosten-Abschlag" value={f.nk} onChange={(v) => setF({ ...f, nk: v, miete: zahlText(Math.round((zahl(f.betrag) - zahl(v)) * 100) / 100) })} />
        <TextField label="Notiz" wide value={f.notiz} onChange={(v) => setF({ ...f, notiz: v })} />
      </FormGrid>
      {soll && <MessageStrip design="Information" hideCloseButton style={{ marginTop: '0.75rem' }}>
        Soll {monatText(f.monat)}: Kaltmiete {eur(soll.miete)} + Abschlag {eur(soll.nk)} = {eur(soll.miete + soll.nk)}{soll.bezahlt ? ` · bereits erfasst ${eur(soll.bezahlt)}` : ''}
      </MessageStrip>}
      {differenz !== 0 && <MessageStrip design="Critical" hideCloseButton style={{ marginTop: '0.75rem' }}>Kaltmiete und Abschlag weichen um {eur(differenz)} vom Betrag ab.</MessageStrip>}
      {z.id && <div style={{ marginTop: '0.75rem' }}><ChangeHistoryButton objectType="MIETZAHLUNG" objectKey={String(z.id)} /></div>}
    </Dialog>
  );
}

/** Monatslauf: Eingänge in Höhe des Solls für alle gewählten Mietverhältnisse erfassen (Dauerauftrag ist pünktlich eingegangen) */
function MonatslaufDialog({ onClose }: { onClose: (neu: boolean) => void }) {
  const [monat, setMonat] = useState(`${heute().slice(0, 7)}-01`);
  const [datum, setDatum] = useState(heute());
  const soll = useLoad(() => api.get<Soll[]>(`${M}/soll?monat=${monat}`), [monat]);
  const [wahl, setWahl] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  useEffect(() => { setWahl(new Set((soll.data ?? []).filter((s) => !s.bezahlt).map((s) => s.vertrag_id))); }, [soll.data]);

  async function buchen() {
    setBusy(true); setFehler(null);
    try {
      const r = await api.post<{ erfasst: number }>(`${M}/zahlungen/monat`, { monat, datum, vertrag_ids: [...wahl] });
      toast(`${r.erfasst} Mieteingänge erfasst`);
      onClose(true);
    } catch (e) { setFehler((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Dialog open headerText="Monat buchen" style={{ width: 'min(40rem, 95vw)' }} onClose={() => onClose(false)}
      footer={<FussLeiste endContent={<>
        <Button design="Emphasized" loading={busy} disabled={!wahl.size} onClick={buchen}>{wahl.size} Eingänge erfassen</Button>
        <Button onClick={() => onClose(false)}>Abbrechen</Button>
      </>} />}>
      <p className="portal-muted" style={{ marginTop: 0 }}>Erfasst für jedes gewählte Mietverhältnis einen Eingang in Höhe des Solls (Kaltmiete und Abschlag). Bereits erfasste Monate bleiben unberührt.</p>
      {fehler && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.75rem' }}>{fehler}</MessageStrip>}
      <FormGrid>
        <DatumFeld label="Leistungsmonat" required value={monat} onChange={(v) => setMonat(v ? `${v.slice(0, 7)}-01` : monat)} />
        <DatumFeld label="Eingangsdatum" required value={datum} onChange={setDatum} />
      </FormGrid>
      <div style={{ marginTop: '0.75rem' }}>
        <Tabelle<Soll> schluessel={(s) => s.vertrag_id} zeilen={soll.data ?? []} leer="Kein Soll in diesem Monat" spalten={[
          { titel: '', wert: (s) => <CheckBox checked={wahl.has(s.vertrag_id)} disabled={!!s.bezahlt} onChange={(e) => { const n = new Set(wahl); if (e.target.checked) n.add(s.vertrag_id); else n.delete(s.vertrag_id); setWahl(n); }} /> },
          { titel: 'Mieter', wert: (s) => `${s.name} (${s.einheit})` },
          { titel: 'Kaltmiete', rechts: true, wert: (s) => eur(s.miete) },
          { titel: 'Abschlag', rechts: true, wert: (s) => eur(s.nk) },
          { titel: 'Erfasst', rechts: true, wert: (s) => (s.bezahlt ? eur(s.bezahlt) : '') },
        ]} />
      </div>
    </Dialog>
  );
}
