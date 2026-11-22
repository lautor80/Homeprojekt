import { useEffect, useState } from 'react';
import { Button, FlexBox, Input, Label, MessageStrip, Option, Select, Text } from '@ui5/webcomponents-react';
import { api, qs } from '@core/api';
import { Section } from '@core/components/Section';
import { toast } from '@core/toast';
import { TCO } from '../util';

/** Saison wie auf dem Server (teilnehmer/zeiten.ts): der Winter zählt zum Jahr, in dem er beginnt */
export interface SaisonRef { jahr: number; saison: 'SOMMER' | 'WINTER' }
export interface Trainingszeit { wochentag: number; von: string; bis: string; bemerkung: string }

export const WOCHENTAGE = [
  { nr: 1, kurz: 'Mo', lang: 'Montag' }, { nr: 2, kurz: 'Di', lang: 'Dienstag' }, { nr: 3, kurz: 'Mi', lang: 'Mittwoch' },
  { nr: 4, kurz: 'Do', lang: 'Donnerstag' }, { nr: 5, kurz: 'Fr', lang: 'Freitag' }, { nr: 6, kurz: 'Sa', lang: 'Samstag' },
  { nr: 7, kurz: 'So', lang: 'Sonntag' },
];

/** April–September Sommer, Oktober–Dezember Winter des Jahres, Januar–März Winter des Vorjahres */
export function saisonHeute(d = new Date()): SaisonRef {
  const j = d.getFullYear(), m = d.getMonth() + 1;
  if (m >= 4 && m <= 9) return { jahr: j, saison: 'SOMMER' };
  return m >= 10 ? { jahr: j, saison: 'WINTER' } : { jahr: j - 1, saison: 'WINTER' };
}
export const saisonText = ({ jahr, saison }: SaisonRef) =>
  (saison === 'SOMMER' ? `Sommer ${jahr}` : `Winter ${jahr}/${String((jahr + 1) % 100).padStart(2, '0')}`);

/** Auswahl: zwei Jahre zurück bis ein Jahr voraus (und die gewählte Saison, falls sie außerhalb liegt), chronologisch */
export function saisonOptionen(gewaehlt: SaisonRef): SaisonRef[] {
  const h = saisonHeute().jahr;
  const l: SaisonRef[] = [];
  for (let j = h - 2; j <= h + 1; j++) l.push({ jahr: j, saison: 'SOMMER' }, { jahr: j, saison: 'WINTER' });
  if (!l.some((o) => o.jahr === gewaehlt.jahr && o.saison === gewaehlt.saison)) l.push(gewaehlt);
  return l.sort((a, b) => a.jahr - b.jahr || (a.saison === 'SOMMER' ? -1 : 1) - (b.saison === 'SOMMER' ? -1 : 1));
}

/** Uhrzeiten im Viertelstundentakt 07:00–22:00 (eine abweichende gespeicherte Zeit bleibt wählbar) */
const UHRZEITEN = Array.from({ length: (22 - 7) * 4 + 1 }, (_, i) => {
  const min = 7 * 60 + i * 15;
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
});
const plus = (t: string, min: number) => {
  const [h, m] = t.split(':').map(Number);
  const x = Math.min(h * 60 + m + min, 22 * 60);
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
};

function Uhrzeit({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (v: string) => void }) {
  const werte = UHRZEITEN.includes(value) ? UHRZEITEN : [...UHRZEITEN, value].sort();
  return (
    <Select disabled={disabled} style={{ width: '6.5rem' }} onChange={(e) => onChange((e.detail.selectedOption as HTMLElement).dataset.k!)}>
      {werte.map((u) => <Option key={u} data-k={u} selected={u === value}>{u}</Option>)}
    </Select>
  );
}

/**
 * Trainingszeiten einer Person je Saison (im Detail der Teilnehmerliste): Saison wählen, Termine Mo–So mit
 * Beginn/Ende und Bemerkung zuordnen, speichern. Ohne tco.teilnehmer:edit nur Anzeige.
 */
export function Trainingszeiten({ adrnr, start, edit, onGespeichert }: { adrnr: string; start: SaisonRef; edit: boolean; onGespeichert: () => void }) {
  const url = `${TCO}/teilnehmer/${encodeURIComponent(adrnr)}/zeiten`;
  const [saison, setSaison] = useState<SaisonRef>(start);
  const [zeiten, setZeiten] = useState<Trainingszeit[]>([]);
  const [geaendert, setGeaendert] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    api.get<{ zeiten: Trainingszeit[] }>(`${url}${qs({ jahr: saison.jahr, saison: saison.saison })}`)
      .then((r) => { setZeiten(r.zeiten); setGeaendert(false); })
      .catch((e) => setError(e.message));
  }, [url, saison.jahr, saison.saison]);

  const aendern = (i: number, z: Partial<Trainingszeit>) => { setZeiten(zeiten.map((x, k) => (k === i ? { ...x, ...z } : x))); setGeaendert(true); };
  const neu = () => {
    const letzte = zeiten[zeiten.length - 1];
    const tag = letzte ? (letzte.wochentag % 7) + 1 : 1;
    const von = letzte?.von ?? '16:00';
    setZeiten([...zeiten, { wochentag: tag, von, bis: letzte?.bis ?? plus(von, 60), bemerkung: '' }]);
    setGeaendert(true);
  };

  async function speichern() {
    setBusy(true); setError(null);
    try {
      const r = await api.put<{ zeiten: Trainingszeit[] }>(url, { ...saison, zeiten });
      setZeiten(r.zeiten); setGeaendert(false);
      toast(`Trainingszeiten ${saisonText(saison)} gespeichert.`);
      onGespeichert();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Section title={`Trainingszeiten ${saisonText(saison)}`} count={zeiten.length}
             actions={<>
               <Select style={{ width: '11rem' }} onChange={(e) => {
                 const [j, s] = ((e.detail.selectedOption as HTMLElement).dataset.k ?? '').split('|');
                 setSaison({ jahr: Number(j), saison: s as SaisonRef['saison'] });
               }}>
                 {saisonOptionen(saison).map((o) => (
                   <Option key={`${o.jahr}|${o.saison}`} data-k={`${o.jahr}|${o.saison}`} selected={o.jahr === saison.jahr && o.saison === saison.saison}>{saisonText(o)}</Option>
                 ))}
               </Select>
               {edit && <Button icon="add" design="Transparent" onClick={neu}>Trainingstag</Button>}
               {edit && <Button design="Emphasized" icon="save" disabled={!geaendert || busy} onClick={speichern}>Speichern</Button>}
             </>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {!zeiten.length && <Text className="portal-muted">Keine Trainingszeiten für {saisonText(saison)}{edit ? ' – über „Trainingstag“ hinzufügen.' : '.'}</Text>}
      <FlexBox direction="Column" style={{ gap: '0.4rem' }}>
        {zeiten.map((z, i) => (
          <FlexBox key={i} alignItems="Center" wrap="Wrap" style={{ gap: '0.5rem' }}>
            <Select disabled={!edit} style={{ width: '9.5rem' }} onChange={(e) => aendern(i, { wochentag: Number((e.detail.selectedOption as HTMLElement).dataset.k) })}>
              {WOCHENTAGE.map((w) => <Option key={w.nr} data-k={String(w.nr)} selected={w.nr === z.wochentag}>{w.lang}</Option>)}
            </Select>
            <Label>von</Label>
            <Uhrzeit value={z.von} disabled={!edit} onChange={(v) => aendern(i, { von: v, bis: z.bis <= v ? plus(v, 60) : z.bis })} />
            <Label>bis</Label>
            <Uhrzeit value={z.bis} disabled={!edit} onChange={(v) => aendern(i, { bis: v })} />
            <Input disabled={!edit} style={{ flex: '1 1 10rem', minWidth: '8rem' }} placeholder="Bemerkung (z. B. Gruppe, Platz, Trainer)" maxlength={200}
                   value={z.bemerkung} onInput={(e) => aendern(i, { bemerkung: e.target.value })} />
            {edit && <Button icon="delete" design="Transparent" tooltip="Trainingstag entfernen"
                             onClick={() => { setZeiten(zeiten.filter((_, k) => k !== i)); setGeaendert(true); }} />}
          </FlexBox>
        ))}
      </FlexBox>
    </Section>
  );
}
