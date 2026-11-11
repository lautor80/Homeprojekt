import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import { addTage, condense, dat } from '../format.js';
import { minuten } from '../halle/preis.js';

/**
 * Feste Platzbelegungen ohne Buchung (Jugendtraining, Schnuppertraining, Sperrzeiten, Veranstaltungen). Sie belegen die Plätze im
 * Kalender für alle sichtbar – mit Bezeichnung, aber ohne personenbezogene Daten – und verhindern Buchungen.
 */
export const BELEGUNG_ARTEN = { TRAINING: 'Training', SCHNUPPER: 'Schnuppertraining', SPERRE: 'Gesperrt', VERANSTALTUNG: 'Veranstaltung' } as const;
export type BelegungArt = keyof typeof BELEGUNG_ARTEN;

export interface FesteBelegung {
  id: number; bezeichnung: string; art: BelegungArt; plaetze: number[]; wochentage: string; datum_von: string; datum_bis: string;
  zeit_von: string; zeit_bis: string; hinweis: string | null; aktiv: boolean; quelle: string; ext_id: string | null;
}
export type BelegungEingabe = Omit<FesteBelegung, 'id' | 'quelle' | 'ext_id'>;

const isoWt = (iso: string) => ((new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;

export async function festeLesen(db: Db, von?: string, bis?: string, nurAktiv = false): Promise<FesteBelegung[]> {
  const rows = await db`
    select id, bezeichnung, art, plaetze, wochentage, datum_von::text, datum_bis::text,
           to_char(zeit_von, 'HH24:MI') as zeit_von, to_char(zeit_bis, 'HH24:MI') as zeit_bis, hinweis, aktiv, quelle, ext_id
      from tco.platzbelegungen
     where true ${nurAktiv ? db`and aktiv` : db``}
       ${von && bis ? db`and datum_von <= ${bis} and datum_bis >= ${von}` : db``}
     order by datum_von, zeit_von, id`;
  return rows.map((r) => ({ ...r, plaetze: (r.plaetze ?? []).map(Number), zeit_bis: r.zeit_bis === '00:00' ? '24:00' : r.zeit_bis }) as FesteBelegung);
}

/** Termine der festen Belegungen im Zeitraum je Platz (für die Belegungsprüfung) */
export function festeTermine(liste: FesteBelegung[], platzIds: number[], von: string, bis: string) {
  const out: { id: number; platzId: number; datum: string; von: number; bis: number; bezeichnung: string; art: BelegungArt; hinweis: string | null }[] = [];
  for (const f of liste) {
    if (!f.aktiv) continue;
    const ziele = f.plaetze.length ? platzIds.filter((p) => f.plaetze.includes(p)) : platzIds;
    if (!ziele.length) continue;
    const start = f.datum_von > von ? f.datum_von : von;
    const ende = f.datum_bis < bis ? f.datum_bis : bis;
    for (let d = start; d <= ende; d = addTage(d, 1)) {
      if (!f.wochentage.includes(String(isoWt(d)))) continue;
      for (const p of ziele) out.push({ id: f.id, platzId: p, datum: d, von: minuten(f.zeit_von), bis: f.zeit_bis === '24:00' ? 1440 : minuten(f.zeit_bis) || 1440, bezeichnung: f.bezeichnung, art: f.art, hinweis: f.hinweis });
    }
  }
  return out;
}

function pruefen(e: BelegungEingabe) {
  if (!condense(e.bezeichnung)) throw new BusinessError('Bitte eine Bezeichnung angeben (z. B. „Jugendtraining“).');
  if (!/^[1-7]{1,7}$/.test(e.wochentage)) throw new BusinessError('Bitte mindestens einen Wochentag wählen.');
  if (e.datum_bis < e.datum_von) throw new BusinessError('Das Ende liegt vor dem Beginn.');
  const v = minuten(e.zeit_von);
  const b = e.zeit_bis === '24:00' ? 1440 : minuten(e.zeit_bis);
  if (b <= v) throw new BusinessError('Die Endzeit liegt vor der Startzeit.');
}

export async function festeSpeichern(tx: Db, id: number | null, e: BelegungEingabe): Promise<{ id: number; text: string }> {
  pruefen(e);
  const zeitBis = e.zeit_bis === '24:00' ? '00:00' : e.zeit_bis;
  const werte = {
    bezeichnung: condense(e.bezeichnung), art: e.art, plaetze: e.plaetze, wochentage: [...new Set(e.wochentage)].sort().join(''),
    datum_von: e.datum_von, datum_bis: e.datum_bis, zeit_von: e.zeit_von, zeit_bis: zeitBis, hinweis: e.hinweis?.trim() || null, aktiv: e.aktiv,
  };
  if (id) {
    const [alt] = await tx`select quelle from tco.platzbelegungen where id = ${id}`;
    if (!alt) throw new BusinessError('Belegung nicht gefunden.', 404);
    if (alt.quelle !== 'PORTAL') throw new BusinessError('Aus EP3 übernommene Belegungen werden in EP3 gepflegt (der nächste Import überschreibt sie).');
    await tx`update tco.platzbelegungen set ${tx(werte)} where id = ${id}`;
    return { id, text: `„${werte.bezeichnung}“ gesichert.` };
  }
  const [r] = await tx`insert into tco.platzbelegungen ${tx(werte)} returning id`;
  return { id: r.id, text: `„${werte.bezeichnung}“ angelegt.` };
}

export async function festeLoeschen(tx: Db, id: number): Promise<string> {
  const [r] = await tx`delete from tco.platzbelegungen where id = ${id} and quelle = 'PORTAL' returning bezeichnung`;
  if (!r) throw new BusinessError('Belegung nicht gefunden oder aus EP3 übernommen.', 404);
  return `„${r.bezeichnung}“ gelöscht.`;
}

/** Kurztext eines Termins, z. B. „Jugendtraining (Training)“ */
export const festeText = (b: { bezeichnung: string; art: BelegungArt }) => b.bezeichnung;

/**
 * EP3-Events (bs_events: EID, SID/PLATZ, DATETIME_START, DATETIME_END, NAME, STATUS) übernehmen: ersetzt alle aus EP3
 * übernommenen Belegungen. Mehrtägige Events belegen jeden Tag ganztägig (erster/letzter Tag ab/bis Uhrzeit nicht unterschieden).
 */
export async function ep3EventsImportieren(tx: Db, rows: string[][], idx: (n: string) => number, platzNachName: (n: string) => number | null): Promise<string> {
  const i = { eid: idx('EID'), platz: ['PLATZ', 'SQUARE', 'SQUARE_NAME', 'SNAME'].map(idx).find((x) => x >= 0) ?? -1, sid: idx('SID'),
    start: idx('DATETIME_START'), ende: idx('DATETIME_END'), name: ['NAME', 'TITEL', 'TITLE'].map(idx).find((x) => x >= 0) ?? -1, status: idx('STATUS') };
  if (i.eid < 0 || i.start < 0 || i.ende < 0) throw new BusinessError('Spalten EID / DATETIME_START / DATETIME_END nicht gefunden.');
  await tx`delete from tco.platzbelegungen where quelle = 'EP3'`;
  let n = 0;
  let ohnePlatz = 0;
  for (const r of rows) {
    const eid = (r[i.eid] ?? '').trim();
    if (!eid) continue;
    if (i.status >= 0 && /disabled|deleted/i.test(r[i.status] ?? '')) continue;
    const s = (r[i.start] ?? '').trim().replace('T', ' ');
    const e = (r[i.ende] ?? '').trim().replace('T', ' ');
    const m1 = /^(\d{4}-\d{2}-\d{2})[ ]?(\d{2}:\d{2})?/.exec(s);
    const m2 = /^(\d{4}-\d{2}-\d{2})[ ]?(\d{2}:\d{2})?/.exec(e);
    if (!m1 || !m2) continue;
    const platzName = i.platz >= 0 ? (r[i.platz] ?? '').trim() : '';
    let plaetze: number[] = [];
    if (platzName) {
      const p = platzNachName(platzName);
      if (p === null) { ohnePlatz++; continue; }
      plaetze = [p];
    }
    const eintaegig = m1[1] === m2[1];
    const vonZ = eintaegig ? m1[2] ?? '00:00' : '00:00';
    let bisZ = eintaegig ? m2[2] ?? '00:00' : '00:00';
    if (bisZ === '23:59') bisZ = '00:00';
    if (eintaegig && bisZ !== '00:00' && bisZ <= vonZ) continue;
    const name = condense(i.name >= 0 ? r[i.name] ?? '' : '') || 'Belegung (EP3)';
    const art = /training|jugend|kurs|ag\b/i.test(name) ? 'TRAINING' : /sperr|gesperrt|wartung|pflege|reinigung|geschlossen|renovier/i.test(name) ? 'SPERRE' : 'VERANSTALTUNG';
    await tx`insert into tco.platzbelegungen (bezeichnung, art, plaetze, wochentage, datum_von, datum_bis, zeit_von, zeit_bis, quelle, ext_id)
             values (${name}, ${art}, ${plaetze}, '1234567', ${m1[1]}, ${m2[1]}, ${vonZ}, ${bisZ}, 'EP3', ${eid})
             on conflict (quelle, ext_id) where ext_id is not null do nothing`;
    n++;
  }
  return `Events: ${rows.length} gelesen, ${n} als feste Belegungen übernommen${ohnePlatz ? `, ${ohnePlatz} ohne bekannten Platz übersprungen` : ''}`;
}

export const zeitraumText = (f: FesteBelegung) => (f.datum_von === f.datum_bis ? dat(f.datum_von) : `${dat(f.datum_von)} – ${dat(f.datum_bis)}`);
