import { useState, type ReactNode } from 'react';
import { Button, Dialog, MessageStrip, ObjectStatus } from '@ui5/webcomponents-react';
import { FussLeiste } from '@core/components/DialogFuss';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { CheckField, FormGrid, TextField } from '@core/components/FormFields';
import { Empty, Section } from '@core/components/Section';
import { useLoad } from '@core/components/useLoad';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { AuswahlFeld, dat, DatumFeld, heute, M, Tabelle, zahl, ZahlFeld, type Ablesung, type Einheit, type Zaehler } from './util';

const EDIT = 'miete.zaehler:edit';
const ARTEN = [{ key: 'strom', text: 'Strom' }, { key: 'waerme', text: 'Wärme' }, { key: 'wasser', text: 'Wasser' }, { key: 'gas', text: 'Gas' }, { key: 'sonstig', text: 'Sonstiges' }];
/** Würde der Zähler hinter „hauptId“ einen Kreis bilden (hinter sich selbst oder einem eigenen Unterzähler)? Wie zaehlerKreis im Server. */
function zaehlerKreis(alle: Pick<Zaehler, 'id' | 'haupt_id'>[], id: number, hauptId: number | null): boolean {
  let p = hauptId;
  const gesehen = new Set<number>();
  while (p !== null && p !== undefined) {
    if (p === id || gesehen.has(p)) return true;
    gesehen.add(p);
    p = alle.find((z) => z.id === p)?.haupt_id ?? null;
  }
  return false;
}
const stand = (v: number) => v.toLocaleString('de-DE', { maximumFractionDigits: 3 });

/**
 * Zähler und Ablesungen. Hauptzähler (ohne Wohnung) = Zähler des Versorgers, z. B. Heizstrom oder Hausstrom;
 * Unterzähler (mit Wohnung und Hauptzähler) messen den Verbrauch einer Partei. Gemeinschaftszähler (ohne Wohnung,
 * hinter einem Haupt- oder Unterzähler) messen gemeinsamen Verbrauch wie Waschküche, Keller oder Heizungsstrom; liegen sie
 * hinter dem Zähler einer Partei, wird ihr Verbrauch dort abgezogen. Gemeinsamer Verbrauch wird je Kostenart nach Fläche,
 * Personen oder zu gleichen Teilen geteilt.
 */
export function ZaehlerSeite() {
  const can = useCan();
  const zs = useLoad(() => api.get<Zaehler[]>(`${M}/zaehler`), []);
  const einheiten = useLoad(() => api.get<Einheit[]>(`${M}/einheiten`), []);
  const [dialog, setDialog] = useState<Partial<Zaehler> | null>(null);
  const [ablesen, setAblesen] = useState<Zaehler | null>(null);
  const alle = zs.data ?? [];
  const haupt = alle.filter((z) => !z.haupt_id);
  const einheit = (id: number | null) => einheiten.data?.find((e) => e.id === id)?.kuerzel ?? '';

  /** Zähler mit allen dahinter liegenden Zählern, eingerückt nach Tiefe */
  const baum = (z: Zaehler, tiefe: number, gesehen = new Set<number>()): ReactNode[] => {
    if (gesehen.has(z.id)) return [];
    gesehen.add(z.id);
    return [karte(z, tiefe), ...alle.filter((u) => u.haupt_id === z.id).flatMap((u) => baum(u, tiefe + 1, gesehen))];
  };

  async function entfernen(a: Ablesung) {
    try { await api.del(`${M}/ablesungen/${a.id}`); toast('Ablesung gelöscht'); zs.reload(); } catch (e) { toast((e as Error).message); }
  }

  const karte = (z: Zaehler, tiefe: number) => {
    const letzte = z.ablesungen[z.ablesungen.length - 1];
    return (
      <Section key={z.id} title={`${tiefe ? `${'\u00a0\u00a0'.repeat(tiefe - 1)}↳ ` : ''}${z.bezeichnung}`} count={z.ablesungen.length}
        status={<>{z.einheit_id ? <ObjectStatus state="Information">{einheit(z.einheit_id)}</ObjectStatus> : z.haupt_id ? <ObjectStatus state="Indication05">Gemeinschaft</ObjectStatus> : <ObjectStatus>Hauptzähler</ObjectStatus>}
          {!z.aktiv && <ObjectStatus state="Critical">inaktiv</ObjectStatus>}</>}
        actions={can(EDIT) && <>
          <Button icon="add" onClick={() => setAblesen(z)}>Ablesung</Button>
          <Button design="Transparent" icon="edit" tooltip="Zähler ändern" onClick={() => setDialog(z)} />
        </>} flush>
        <div className="portal-muted" style={{ padding: '0.25rem 0.75rem', fontSize: '0.8rem' }}>
          {[z.nummer && `Nr. ${z.nummer}`, ARTEN.find((a) => a.key === z.art)?.text, letzte && `zuletzt ${stand(letzte.stand)} ${z.masseinheit} am ${dat(letzte.datum)}`].filter(Boolean).join(' · ')}
        </div>
        <Tabelle<Ablesung & { verbrauch: number | null }> schluessel={(a) => a.id} leer="Noch keine Ablesung"
          zeilen={[...z.ablesungen].reverse().map((a, i, l) => ({ ...a, verbrauch: l[i + 1] ? a.stand - l[i + 1].stand : null }))} spalten={[
            { titel: 'Datum', wert: (a) => dat(a.datum) },
            { titel: `Stand (${z.masseinheit})`, rechts: true, wert: (a) => stand(a.stand) },
            { titel: 'Verbrauch seit Vorablesung', rechts: true, wert: (a) => (a.verbrauch === null ? '' : stand(a.verbrauch)) },
            { titel: 'Notiz', wert: (a) => a.notiz ?? '' },
            ...(can(EDIT) ? [{ titel: '', wert: (a: Ablesung) => <Button design="Transparent" icon="delete" tooltip="Löschen" onClick={() => entfernen(a)} /> }] : []),
          ]} />
      </Section>
    );
  };

  return (
    <AppPage title="Zähler" subtitle={`${alle.length} Zähler`}
      actions={can(EDIT) && <Button icon="add" design="Emphasized" onClick={() => setDialog({ art: 'strom', masseinheit: 'kWh', aktiv: true })}>Zähler anlegen</Button>}>
      {zs.error && <MessageStrip design="Negative" hideCloseButton>{zs.error}</MessageStrip>}
      <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.75rem' }}>
        Zum Jahreswechsel (31.12.) und bei jedem Mieterwechsel alle Zähler ablesen. Fehlen Stände, werden Zwischenstände linear geschätzt; ohne eingrenzende Ablesungen verteilt die Abrechnung nach Wohnfläche.
      </MessageStrip>
      {!alle.length && <Empty>Noch keine Zähler. Beispiel: Hauptzähler „Heizstrom“ (Wärmepumpe) und je Wohnung ein Unterzähler.</Empty>}
      {haupt.flatMap((h) => baum(h, 0))}
      {dialog && <ZaehlerDialog z={dialog} alle={alle} einheiten={einheiten.data ?? []} onClose={(neu) => { setDialog(null); if (neu) zs.reload(); }} />}
      {ablesen && <AblesungDialog z={ablesen} onClose={(neu) => { setAblesen(null); if (neu) zs.reload(); }} />}
    </AppPage>
  );
}

function ZaehlerDialog({ z, alle, einheiten, onClose }: { z: Partial<Zaehler>; alle: Zaehler[]; einheiten: Einheit[]; onClose: (neu: boolean) => void }) {
  const [f, setF] = useState({ bezeichnung: z.bezeichnung ?? '', nummer: z.nummer ?? '', art: z.art ?? 'strom', masseinheit: z.masseinheit ?? 'kWh',
    einheit_id: z.einheit_id ?? null as number | null, haupt_id: z.haupt_id ?? null as number | null, aktiv: z.aktiv ?? true });
  const [fehler, setFehler] = useState<string | null>(null);
  async function sichern() {
    try {
      if (z.id) await api.put(`${M}/zaehler/${z.id}`, f); else await api.post(`${M}/zaehler`, f);
      toast('Zähler gesichert'); onClose(true);
    } catch (e) { setFehler((e as Error).message); }
  }
  return (
    <Dialog open headerText={z.id ? 'Zähler ändern' : 'Zähler anlegen'} style={{ width: 'min(36rem, 95vw)' }} onClose={() => onClose(false)}
      footer={<FussLeiste endContent={<><Button design="Emphasized" disabled={!f.bezeichnung.trim()} onClick={sichern}>Sichern</Button><Button onClick={() => onClose(false)}>Abbrechen</Button></>} />}>
      {fehler && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.75rem' }}>{fehler}</MessageStrip>}
      <FormGrid>
        <TextField label="Bezeichnung" required value={f.bezeichnung} onChange={(v) => setF({ ...f, bezeichnung: v })} placeholder="z. B. Heizstrom Wärmepumpe" />
        <TextField label="Zählernummer" value={f.nummer} onChange={(v) => setF({ ...f, nummer: v })} />
        <AuswahlFeld label="Art" value={f.art} optionen={ARTEN} onChange={(v) => setF({ ...f, art: v ?? 'strom' })} />
        <TextField label="Maßeinheit" value={f.masseinheit} onChange={(v) => setF({ ...f, masseinheit: v })} />
        <AuswahlFeld label="Wohnung (Unterzähler)" value={f.einheit_id} leer="(keine – Haupt- oder Gemeinschaftszähler)" onChange={(v) => setF({ ...f, einheit_id: v })}
          optionen={einheiten.map((e) => ({ key: e.id, text: `${e.kuerzel} – ${e.bezeichnung}` }))} />
        <AuswahlFeld label="Liegt hinter Zähler" value={f.haupt_id} leer="(keinem – Hauptzähler)" onChange={(v) => setF({ ...f, haupt_id: v })}
          optionen={alle.filter((x) => !z.id || !zaehlerKreis(alle, z.id, x.id)).map((x) => ({ key: x.id, text: x.haupt_id ? `↳ ${x.bezeichnung}` : x.bezeichnung }))} />
        <CheckField label="Aktiv" checked={f.aktiv} onChange={(v) => setF({ ...f, aktiv: v })} />
      </FormGrid>
      {f.haupt_id && !f.einheit_id && <MessageStrip design="Information" hideCloseButton style={{ marginTop: '0.75rem' }}>
        Gemeinschaftszähler: Sein Verbrauch wird vom Zähler, hinter dem er liegt, abgezogen und als gemeinsamer Verbrauch geteilt –
        nach Fläche, Personen oder zu gleichen Teilen, wie bei der Kostenart eingestellt.
      </MessageStrip>}
      {z.id && <div style={{ marginTop: '0.75rem' }}><ChangeHistoryButton objectType="ZAEHLER" objectKey={String(z.id)} /></div>}
    </Dialog>
  );
}

function AblesungDialog({ z, onClose }: { z: Zaehler; onClose: (neu: boolean) => void }) {
  const [f, setF] = useState({ datum: heute(), stand: '', notiz: '' });
  const [fehler, setFehler] = useState<string | null>(null);
  const letzte = z.ablesungen[z.ablesungen.length - 1];
  const kleiner = letzte && f.stand !== '' && zahl(f.stand) < letzte.stand && f.datum > letzte.datum;
  async function sichern() {
    try { await api.post(`${M}/zaehler/${z.id}/ablesungen`, { ...f, stand: zahl(f.stand) }); toast('Ablesung gesichert'); onClose(true); } catch (e) { setFehler((e as Error).message); }
  }
  return (
    <Dialog open headerText={`Ablesung ${z.bezeichnung}`} style={{ width: 'min(30rem, 95vw)' }} onClose={() => onClose(false)}
      footer={<FussLeiste endContent={<><Button design="Emphasized" disabled={f.stand === '' || !f.datum} onClick={sichern}>Sichern</Button><Button onClick={() => onClose(false)}>Abbrechen</Button></>} />}>
      {fehler && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.75rem' }}>{fehler}</MessageStrip>}
      <FormGrid columns={1}>
        <DatumFeld label="Datum" required value={f.datum} onChange={(v) => setF({ ...f, datum: v })} />
        <ZahlFeld label="Zählerstand" einheit={z.masseinheit} required value={f.stand} onChange={(v) => setF({ ...f, stand: v })} />
        <TextField label="Notiz" value={f.notiz} onChange={(v) => setF({ ...f, notiz: v })} placeholder="z. B. Jahresablesung, Mieterwechsel" />
      </FormGrid>
      {letzte && <p className="portal-muted">Letzte Ablesung: {stand(letzte.stand)} {z.masseinheit} am {dat(letzte.datum)}</p>}
      {kleiner && <MessageStrip design="Critical" hideCloseButton>Der Stand ist kleiner als bei der letzten Ablesung – Zählerwechsel? Dann einen neuen Zähler anlegen.</MessageStrip>}
    </Dialog>
  );
}
