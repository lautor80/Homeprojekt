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
  /** abgesagte Termine „platzId|datum“ (tco.platzbelegung_ausfall) */
  ausfall?: string[];
}

/** stabiler Schlüssel einer Belegung für Absagen – EP3-Belegungen bekommen bei jedem Import eine neue id */
export const ausfallSchluessel = (f: { id: number; quelle: string; ext_id: string | null }) => (f.quelle === 'EP3' && f.ext_id ? `EP3:${f.ext_id}` : String(f.id));
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
  const aus = await db`select schluessel, platz_id, datum::text as datum from tco.platzbelegung_ausfall
                        ${von && bis ? db`where datum between ${von} and ${bis}` : db``}`;
  const jeBelegung = new Map<string, string[]>();
  for (const a of aus) jeBelegung.set(a.schluessel, [...(jeBelegung.get(a.schluessel) ?? []), `${a.platz_id}|${a.datum}`]);
  return rows.map((r) => {
    const f = { ...r, plaetze: (r.plaetze ?? []).map(Number), zeit_bis: r.zeit_bis === '00:00' ? '24:00' : r.zeit_bis } as FesteBelegung;
    return { ...f, ausfall: jeBelegung.get(ausfallSchluessel(f)) ?? [] };
  });
}

/**
 * Einen Termin einer festen Belegung absagen (Platzverwaltung → Termin → „Diesen Termin absagen“), auch nachträglich:
 * der Platz ist frei, die Zeit zählt nicht mehr als belegt. Mit `zuruecknehmen` gilt der Termin wieder.
 */
export async function festeAbsagen(tx: Db, id: number, platzId: number, datum: string, o: { grund?: string | null; wer: string; zuruecknehmen?: boolean }): Promise<string> {
  const [f] = await tx`select id, bezeichnung, quelle, ext_id, plaetze, wochentage, datum_von::text as dv, datum_bis::text as db from tco.platzbelegungen where id = ${id}`;
  if (!f) throw new BusinessError('Belegung nicht gefunden.', 404);
  const k = ausfallSchluessel({ id: f.id, quelle: f.quelle, ext_id: f.ext_id });
  if (o.zuruecknehmen) {
    const r = await tx`delete from tco.platzbelegung_ausfall where schluessel = ${k} and platz_id = ${platzId} and datum = ${datum}`;
    if (!r.count) throw new BusinessError('Dieser Termin ist nicht abgesagt.');
    return `${f.bezeichnung} am ${dat(datum)} gilt wieder.`;
  }
  const plaetze = (f.plaetze ?? []).map(Number);
  if (datum < f.dv || datum > f.db || !String(f.wochentage).includes(String(isoWt(datum))) || (plaetze.length && !plaetze.includes(platzId))) {
    throw new BusinessError(`${f.bezeichnung} findet am ${dat(datum)} auf diesem Platz nicht statt.`);
  }
  await tx`insert into tco.platzbelegung_ausfall (schluessel, platz_id, datum, grund, angelegt_von) values (${k}, ${platzId}, ${datum}, ${o.grund ?? null}, ${o.wer})
           on conflict do nothing`;
  return `${f.bezeichnung} am ${dat(datum)} abgesagt – der Platz ist frei und die Zeit zählt nicht mehr als belegt.`;
}

/** Termine der festen Belegungen im Zeitraum je Platz (für die Belegungsprüfung) */
export function festeTermine(liste: FesteBelegung[], platzIds: number[], von: string, bis: string) {
  const out: { id: number; platzId: number; datum: string; von: number; bis: number; bezeichnung: string; art: BelegungArt; hinweis: string | null;
    /** nur dieser eine Tag und dieser eine Platz (z. B. aus der Belegung eingetragen) – einzeln änderbar */ einmalig: boolean; portal: boolean }[] = [];
  for (const f of liste) {
    if (!f.aktiv) continue;
    const ziele = f.plaetze.length ? platzIds.filter((p) => f.plaetze.includes(p)) : platzIds;
    if (!ziele.length) continue;
    const start = f.datum_von > von ? f.datum_von : von;
    const ende = f.datum_bis < bis ? f.datum_bis : bis;
    for (let d = start; d <= ende; d = addTage(d, 1)) {
      if (!f.wochentage.includes(String(isoWt(d)))) continue;
      for (const p of ziele) {
        if (f.ausfall?.includes(`${p}|${d}`)) continue; // abgesagt
        out.push({ id: f.id, platzId: p, datum: d, von: minuten(f.zeit_von), bis: f.zeit_bis === '24:00' ? 1440 : minuten(f.zeit_bis) || 1440, bezeichnung: f.bezeichnung, art: f.art,
          hinweis: f.hinweis, einmalig: f.datum_von === f.datum_bis && f.plaetze.length === 1, portal: f.quelle === 'PORTAL' });
      }
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
    const [alt] = await tx`select quelle, ext_id from tco.platzbelegungen where id = ${id}`;
    if (!alt) throw new BusinessError('Belegung nicht gefunden.', 404);
    // Absagen hängen bei EP3-Belegungen am EP3-Schlüssel – nach der Übernahme ins Portal gilt die id
    if (alt.quelle === 'EP3' && alt.ext_id) {
      await tx`update tco.platzbelegung_ausfall set schluessel = ${String(id)} where schluessel = ${`EP3:${alt.ext_id}`}`;
    }
    // aus EP3 übernommen: EP3 gibt es nicht mehr – beim Ändern wird die Belegung ins Portal übernommen (quelle PORTAL,
    // ext_id bleibt; ein erneuter EP3-Import legt sie dann nicht noch einmal an)
    await tx`update tco.platzbelegungen set ${tx({ ...werte, quelle: 'PORTAL' })} where id = ${id}`;
    return { id, text: `„${werte.bezeichnung}“ gesichert.` };
  }
  const [r] = await tx`insert into tco.platzbelegungen ${tx(werte)} returning id`;
  return { id: r.id, text: `„${werte.bezeichnung}“ angelegt.` };
}

export async function festeLoeschen(tx: Db, id: number): Promise<string> {
  const [r] = await tx`delete from tco.platzbelegungen where id = ${id} returning bezeichnung`;
  if (!r) throw new BusinessError('Belegung nicht gefunden.', 404);
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
             select ${name}, ${art}, ${plaetze}, '1234567', ${m1[1]}::date, ${m2[1]}::date, ${vonZ}::time, ${bisZ}::time, 'EP3', ${eid}
              where not exists (select 1 from tco.platzbelegungen where ext_id = ${eid} and quelle = 'PORTAL')
             on conflict (quelle, ext_id) where ext_id is not null do nothing`;
    n++;
  }
  return `Events: ${rows.length} gelesen, ${n} als feste Belegungen übernommen${ohnePlatz ? `, ${ohnePlatz} ohne bekannten Platz übersprungen` : ''}`;
}

export const zeitraumText = (f: FesteBelegung) => (f.datum_von === f.datum_bis ? dat(f.datum_von) : `${dat(f.datum_von)} – ${dat(f.datum_bis)}`);
