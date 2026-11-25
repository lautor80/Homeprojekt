/**
 * Vorstandssitzungen – Verlauf eines Themas über mehrere Sitzungen („Kette“).
 *
 * Zusammenhängende Tagesordnungspunkte tragen dieselbe Kennung (vs_tops.kette = Id des ersten Punkts; leer = der Punkt selbst).
 * Ein Thema des Parkplatzes merkt sich seine Kette (vs_themen.kette), damit sie beim Parken und Wiederaufnehmen erhalten bleibt.
 *
 * Automatisch verkettet wird:
 *  - ein vertagter Punkt, den die Folgesitzung übernimmt (Tagesordnungsvorschlag),
 *  - ein Punkt, der aus dem Themenparkplatz eingeplant wird (Kette des Themas),
 *  - ein Punkt, der in den Parkplatz verschoben wird (das neue Thema übernimmt die Kette des Punkts),
 *  - ein neu angelegter Punkt, wenn der letzte gleichnamige Punkt einer früheren Sitzung vertagt wurde.
 * Von Hand lässt sich ein Punkt (oder ein geparktes Thema) mit einem Punkt einer anderen Sitzung verketten und die
 * Verkettung eines Punkts wieder lösen.
 */
import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import { EINTRAG_SQL, eintragAus, namensPersonen, type Eintrag } from './logik.js';
import { sitzungNr, STATUS_TEXT, verantwortlicheAnzeigen, type Status } from './regeln.js';

export interface VerlaufPunkt {
  top_id: number; sitzung_id: number; sitzung_nr: string; sitzung_titel: string; sitzung_status: Status; sitzung_status_text: string;
  datum: string; titel: string; status: 'OFFEN' | 'ERLEDIGT' | 'VERTAGT'; verantwortlich: string | null; text: string | null; eintraege: Eintrag[];
}

const DATUM = (db: Db) => db`coalesce((e.beginn at time zone 'Europe/Berlin')::date, s.datum)`;
/** Titel für den Vergleich gleichnamiger Punkte (wie titelSchluessel): Leerraum zusammengefasst, Kleinschreibung */
const TITEL = (db: Db, alias: 't' | 'p') => (alias === 't'
  ? db`lower(regexp_replace(btrim(t.titel), '\\s+', ' ', 'g'))`
  : db`lower(regexp_replace(btrim(p.titel), '\\s+', ' ', 'g'))`);

/**
 * Alle Punkte der Ketten (Schlüssel = Kette), chronologisch; mit Protokolltext und Einträgen.
 * Ohne auchEinzeln nur Ketten mit mindestens zwei Punkten (ein Punkt allein hat keinen Verlauf).
 */
export async function verlaufLesen(db: Db, ketten: number[], o: { auchEinzeln?: boolean } = {}): Promise<Map<number, VerlaufPunkt[]>> {
  const m = new Map<number, VerlaufPunkt[]>();
  const k = [...new Set(ketten)];
  if (!k.length) return m;
  const rows = await db`
    select coalesce(t.kette, t.id) as k, t.id, t.titel, t.status, t.verantwortlich, t.text, s.id as sid, s.jahr, s.lfd, s.titel as s_titel, s.status as s_status,
           ${DATUM(db)}::text as datum
      from tco.vs_tops t join tco.vs_sitzungen s on s.id = t.sitzung_id left join tco.kal_events e on e.id = s.event_id
     where coalesce(t.kette, t.id) = any(${k})
       and (${!!o.auchEinzeln}::boolean or exists (select 1 from tco.vs_tops o where coalesce(o.kette, o.id) = coalesce(t.kette, t.id) and o.id <> t.id))
     order by ${DATUM(db)}, s.id, t.id`;
  if (!rows.length) return m;
  const ids = rows.map((r) => Number(r.id));
  const eintraege = (await db`select ${EINTRAG_SQL(db)} from tco.vs_eintraege x where x.top_id = any(${ids}) order by x.pos, x.id`).map(eintragAus);
  const personen = await namensPersonen(db);
  for (const r of rows) {
    const status = r.s_status as Status;
    const p: VerlaufPunkt = {
      top_id: Number(r.id), sitzung_id: Number(r.sid), sitzung_nr: sitzungNr(Number(r.jahr), Number(r.lfd)), sitzung_titel: r.s_titel as string,
      sitzung_status: status, sitzung_status_text: STATUS_TEXT[status], datum: r.datum as string, titel: r.titel as string,
      status: r.status as VerlaufPunkt['status'], verantwortlich: verantwortlicheAnzeigen((r.verantwortlich as string) ?? null, personen),
      text: (r.text as string) ?? null,
      eintraege: eintraege.filter((e) => e.top_id === Number(r.id)).map((e) => ({ ...e, verantwortlich: verantwortlicheAnzeigen(e.verantwortlich, personen) })),
    };
    const l = m.get(Number(r.k)) ?? [];
    l.push(p);
    m.set(Number(r.k), l);
  }
  return m;
}

/** Kette eines Punkts */
export async function ketteVonTop(db: Db, topId: number): Promise<{ kette: number; sitzung_id: number }> {
  const [t] = await db`select coalesce(kette, id) as k, sitzung_id from tco.vs_tops where id = ${topId}`;
  if (!t) throw new BusinessError('Den Tagesordnungspunkt gibt es nicht (mehr).', 404);
  return { kette: Number(t.k), sitzung_id: Number(t.sitzung_id) };
}

/** Kette alt in die Kette neu überführen (Punkte und Themen) */
async function kettenVerbinden(tx: Db, alt: number, neu: number) {
  if (alt === neu) return;
  await tx`update tco.vs_tops set kette = ${neu} where coalesce(kette, id) = ${alt}`;
  await tx`update tco.vs_themen set kette = ${neu} where kette = ${alt}`;
}

/**
 * Automatisch: Wurde der letzte gleichnamige Punkt einer früheren Sitzung vertagt, setzt der neue Punkt dessen Kette fort.
 * Rückgabe: Kette oder null.
 */
export async function automatischVerketten(tx: Db, topId: number): Promise<number | null> {
  const [v] = await tx`
    with hier as (
      select t.id, t.sitzung_id, ${TITEL(tx, 't')} as titel, ${DATUM(tx)} as d
        from tco.vs_tops t join tco.vs_sitzungen s on s.id = t.sitzung_id left join tco.kal_events e on e.id = s.event_id
       where t.id = ${topId} and t.kette is null)
    select p.id, p.kette, p.status
      from hier h, tco.vs_tops p join tco.vs_sitzungen s on s.id = p.sitzung_id left join tco.kal_events e on e.id = s.event_id
     where ${TITEL(tx, 'p')} = h.titel and p.sitzung_id <> h.sitzung_id and (${DATUM(tx)}, s.id) < (h.d, h.sitzung_id)
     order by ${DATUM(tx)} desc, s.id desc, p.id desc
     limit 1`;
  if (!v || v.status !== 'VERTAGT') return null;
  const k = v.kette == null ? Number(v.id) : Number(v.kette);
  await tx`update tco.vs_tops set kette = ${k} where id = ${topId}`;
  return k;
}

/** Punkt mit einem Punkt einer anderen Sitzung verketten (die Ketten werden zusammengeführt) */
export async function topVerketten(tx: Db, topId: number, mitTopId: number) {
  if (topId === mitTopId) throw new BusinessError('Ein Punkt lässt sich nicht mit sich selbst verketten.');
  const a = await ketteVonTop(tx, topId);
  const b = await ketteVonTop(tx, mitTopId);
  if (a.sitzung_id === b.sitzung_id) throw new BusinessError('Beide Punkte gehören zur selben Sitzung – bitte einen Punkt aus einer anderen Sitzung wählen.');
  if (a.kette === b.kette) throw new BusinessError('Die Punkte sind schon verkettet.');
  // die Kette des früheren Punkts bleibt erhalten
  const [frueher] = await tx`
    select t.id from tco.vs_tops t join tco.vs_sitzungen s on s.id = t.sitzung_id left join tco.kal_events e on e.id = s.event_id
     where t.id = any(${[topId, mitTopId]}) order by ${DATUM(tx)}, s.id, t.id limit 1`;
  const [ziel, quelle] = Number(frueher.id) === topId ? [a.kette, b.kette] : [b.kette, a.kette];
  await kettenVerbinden(tx, quelle, ziel);
  // ein Thema, das den Punkt gerade führt, aber noch keine Kette kennt, übernimmt sie
  await tx`update tco.vs_themen set kette = ${ziel} where kette is null and top_id = any(${[topId, mitTopId]})`;
}

/** Thema (z. B. geparkt) mit einem früheren Punkt verketten */
export async function themaVerketten(tx: Db, themaId: number, mitTopId: number) {
  const [t] = await tx`select th.id, coalesce(th.kette, tp.kette, tp.id) as k from tco.vs_themen th left join tco.vs_tops tp on tp.id = th.top_id
                        where th.id = ${themaId} for update of th`;
  if (!t) throw new BusinessError('Das Thema gibt es nicht (mehr).', 404);
  const b = await ketteVonTop(tx, mitTopId);
  if (t.k != null && Number(t.k) === b.kette) throw new BusinessError('Das Thema ist mit diesem Punkt schon verkettet.');
  if (t.k != null) await kettenVerbinden(tx, Number(t.k), b.kette);
  await tx`update tco.vs_themen set kette = ${b.kette} where id = ${themaId}`;
}

/** Verkettung eines Punkts lösen: Er steht danach allein; die übrigen Punkte bleiben untereinander verkettet. */
export async function topLoesen(tx: Db, topId: number) {
  const { kette } = await ketteVonTop(tx, topId);
  const andere = (await tx`select id from tco.vs_tops where coalesce(kette, id) = ${kette} and id <> ${topId} order by id`).map((r) => Number(r.id));
  if (!andere.length) throw new BusinessError('Der Punkt ist mit keinem anderen verkettet.');
  if (kette === topId) {
    // der Punkt war der Anfang der Kette: die übrigen bekommen einen neuen Anfang
    const anfang = andere[0];
    await tx`update tco.vs_tops set kette = ${anfang} where id = any(${andere})`;
    await tx`update tco.vs_themen set kette = ${anfang} where kette = ${topId} and top_id is distinct from ${topId}`;
  }
  await tx`update tco.vs_tops set kette = null where id = ${topId}`;
  // ein Thema, das diesen Punkt führt, folgt ihm
  await tx`update tco.vs_themen set kette = ${topId} where top_id = ${topId}`;
}

/** Punkte anderer Sitzungen zur Auswahl beim Verketten: gleichnamige zuerst, dann vertagte, dann die jüngsten */
export async function punkteZurAuswahl(db: Db, o: { titel?: string | null; suche?: string | null; ohneSitzung?: number | null; ohneKette?: number | null }) {
  const q = o.suche?.trim() ? `%${o.suche.trim()}%` : null;
  const titel = o.titel?.trim() ? o.titel : null;
  const rows = await db`
    select t.id, t.titel, t.status, coalesce(t.kette, t.id) as k, s.id as sid, s.jahr, s.lfd, ${DATUM(db)}::text as datum,
           (${titel}::text is not null and ${TITEL(db, 't')} = lower(regexp_replace(btrim(${titel}::text), '\\s+', ' ', 'g'))) as gleich
      from tco.vs_tops t join tco.vs_sitzungen s on s.id = t.sitzung_id left join tco.kal_events e on e.id = s.event_id
     where (${o.ohneSitzung ?? null}::int is null or t.sitzung_id <> ${o.ohneSitzung ?? null}::int)
       and (${o.ohneKette ?? null}::int is null or coalesce(t.kette, t.id) <> ${o.ohneKette ?? null}::int)
       and (${q}::text is null or t.titel ilike ${q} or t.text ilike ${q})
       and t.titel !~* '^(begrüßung|genehmigung des protokolls|verschiedenes)'
     order by gleich desc, (t.status = 'VERTAGT') desc, ${DATUM(db)} desc, s.id desc, t.pos
     limit 60`;
  return rows.map((r) => ({
    id: Number(r.id), titel: r.titel as string, status: r.status as VerlaufPunkt['status'], kette: Number(r.k), gleichnamig: !!r.gleich,
    sitzung_id: Number(r.sid), sitzung_nr: sitzungNr(Number(r.jahr), Number(r.lfd)), datum: r.datum as string,
  }));
}
