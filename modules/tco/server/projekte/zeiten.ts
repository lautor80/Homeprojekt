import { BusinessError } from '../../../../server/src/errors.js';
import type { Aufgabe } from '../../../../server/src/lib/arbeitsvorrat.js';
import { heute } from '../format.js';
import type { Db } from '../verein.js';

/**
 * Projekte – Rückmeldung der geleisteten Stunden.
 *
 * Mitglieder melden ihre Stunden selbst (Mein Bereich → Meine Zeiten → Projekt): die Person kommt allein aus dem
 * angemeldeten Benutzer (tco.mitgliedera.benutzer_id), nie aus der Anfrage. Melden darf, wer im Projekt eingeplant ist
 * – oder jedes Mitglied, wenn das Projekt „offen für alle“ ist – und nur auf genehmigte und laufende Projekte.
 * Der Planer bestätigt oder weist zurück; im Soll-Ist zählen nur bestätigte Stunden. Für Helfer ohne Zugang erfasst der
 * Planer selbst (gleich bestätigt). Projektstunden sind unbezahlt und berühren die Trainingszeiten (tco.jt_*) nicht.
 */

export type ZeitStatus = 'GEMELDET' | 'BESTAETIGT' | 'ABGELEHNT';
export const ZEIT_STATUS_TEXT: Record<ZeitStatus, string> = { GEMELDET: 'gemeldet', BESTAETIGT: 'bestätigt', ABGELEHNT: 'zurückgewiesen' };
/** Projekte, auf die gemeldet werden kann */
export const MELDBAR = ['GENEHMIGT', 'UMSETZUNG'];

export interface Zeit {
  id: number; projekt_id: number; projekt: string; vorgang_id: number | null; vorgang: string | null; adrnr: string | null; name: string;
  datum: string; stunden: number; taetigkeit: string | null; status: ZeitStatus; status_text: string; grund: string | null;
  erfasst_von: string | null; entschieden_von: string | null; entschieden_am: string | null;
}
export interface ZeitSummen {
  /** bestätigte Stunden und ihr Wert zum externen Satz; gemeldet = wartet auf Bestätigung */
  stunden: number; wert: number; gemeldet: number;
  personen: { name: string; adrnr: string | null; geplant: number; gemeldet: number; bestaetigt: number; offen: number }[];
}

const cent = (v: number) => Math.round(Number((v * 100).toPrecision(12))) / 100;

export async function zeitenLesen(db: Db, f: { projekt?: number; adrnr?: string }): Promise<Zeit[]> {
  const rows = await db`
    select z.id, z.projekt_id, p.bezeichnung as projekt, z.vorgang_id, v.bezeichnung as vorgang, z.adrnr, z.name, z.datum::text as datum, z.stunden::float8 as stunden,
           z.taetigkeit, z.status, z.grund, z.erfasst_von, z.entschieden_von, z.entschieden_am::text as entschieden_am
      from tco.hh_projekt_zeit z join tco.hh_projekt p on p.id = z.projekt_id left join tco.hh_projekt_vorgang v on v.id = z.vorgang_id
     where ${f.projekt === undefined ? db`true` : db`z.projekt_id = ${f.projekt}`} and ${f.adrnr === undefined ? db`true` : db`z.adrnr = ${f.adrnr}`}
     order by z.datum desc, z.id desc`;
  return rows.map((z) => ({
    id: Number(z.id), projekt_id: Number(z.projekt_id), projekt: z.projekt, vorgang_id: z.vorgang_id === null ? null : Number(z.vorgang_id), vorgang: z.vorgang ?? null,
    adrnr: z.adrnr ?? null, name: z.name, datum: z.datum, stunden: Number(z.stunden), taetigkeit: z.taetigkeit ?? null, status: z.status as ZeitStatus,
    status_text: ZEIT_STATUS_TEXT[z.status as ZeitStatus], grund: z.grund ?? null, erfasst_von: z.erfasst_von ?? null, entschieden_von: z.entschieden_von ?? null, entschieden_am: z.entschieden_am ?? null,
  }));
}

/**
 * Soll-Ist der Stunden je Person (reine Funktion). Person = Mitglied (adrnr) bzw. Name der freien Angabe. Der Wert der
 * geleisteten Stunden rechnet mit dem Satz der Planzeile der Person (erste mit eigenem Satz), sonst mit der Vorgabe.
 */
export function zeitenSummen(
  zeiten: Pick<Zeit, 'adrnr' | 'name' | 'stunden' | 'status'>[],
  arbeit: { adrnr: string | null; name: string; personen: number; stunden: number; satz: number | null }[], stundensatz: number,
): ZeitSummen {
  const key = (x: { adrnr: string | null; name: string }) => x.adrnr ?? `~${x.name.trim().toLowerCase()}`;
  const personen = new Map<string, ZeitSummen['personen'][number] & { satz: number }>();
  const hole = (x: { adrnr: string | null; name: string }) => {
    let p = personen.get(key(x));
    if (!p) { p = { name: x.name, adrnr: x.adrnr, geplant: 0, gemeldet: 0, bestaetigt: 0, offen: 0, satz: stundensatz }; personen.set(key(x), p); }
    return p;
  };
  for (const a of arbeit) { const p = hole(a); p.geplant = cent(p.geplant + a.personen * a.stunden); if (a.satz !== null && p.satz === stundensatz) p.satz = a.satz; }
  let stunden = 0, wert = 0, gemeldet = 0;
  for (const z of zeiten) {
    const p = hole(z);
    if (z.status === 'GEMELDET') { p.gemeldet = cent(p.gemeldet + z.stunden); gemeldet = cent(gemeldet + z.stunden); }
    if (z.status === 'BESTAETIGT') { p.bestaetigt = cent(p.bestaetigt + z.stunden); stunden = cent(stunden + z.stunden); wert = cent(wert + z.stunden * p.satz); }
  }
  return {
    stunden, wert, gemeldet,
    personen: [...personen.values()].map(({ satz: _s, ...p }) => ({ ...p, offen: cent(Math.max(0, p.geplant - p.bestaetigt)) })).sort((a, b) => a.name.localeCompare(b.name, 'de')),
  };
}

/** Mitglied des angemeldeten Benutzers (oder null) */
export async function meinMitglied(db: Db, benutzerId: string | null | undefined): Promise<{ adrnr: string; name: string } | null> {
  if (!benutzerId) return null;
  const [m] = await db`select m.adrnr, m.vorname, m.nachname from tco.mitgliedera a join tco.mitglieder m on m.adrnr = a.adrnr where a.benutzer_id = ${benutzerId}`;
  return m ? { adrnr: m.adrnr as string, name: `${m.nachname ?? ''}, ${m.vorname ?? ''}`.replace(/\s+/g, ' ').replace(/^, |, $/g, '').trim() } : null;
}

export interface MeldbaresProjekt { id: number; bezeichnung: string; eingeplant: boolean; vorgaenge: { id: number; nr: number; bezeichnung: string }[] }

/** Projekte, auf die dieses Mitglied melden darf: genehmigt oder in Umsetzung, und eingeplant oder „offen für alle“ */
export async function meldbareProjekte(db: Db, adrnr: string): Promise<MeldbaresProjekt[]> {
  const pr = await db`
    select p.id, p.bezeichnung, exists (select 1 from tco.hh_projekt_arbeit a where a.projekt_id = p.id and a.adrnr = ${adrnr}) as eingeplant
      from tco.hh_projekt p
     where p.status = any(${MELDBAR}) and (p.offen_fuer_alle or exists (select 1 from tco.hh_projekt_arbeit a where a.projekt_id = p.id and a.adrnr = ${adrnr}))
     order by p.bezeichnung, p.id`;
  if (!pr.length) return [];
  const vg = await db`select id, projekt_id, bezeichnung from tco.hh_projekt_vorgang where projekt_id = any(${pr.map((p) => Number(p.id))}) order by projekt_id, pos, id`;
  return pr.map((p) => ({
    id: Number(p.id), bezeichnung: p.bezeichnung, eingeplant: !!p.eingeplant,
    vorgaenge: vg.filter((v) => v.projekt_id === p.id).map((v, i) => ({ id: Number(v.id), nr: i + 1, bezeichnung: v.bezeichnung })),
  }));
}

export interface ZeitEingabe { projekt_id: number; vorgang_id?: number | null; datum: string; stunden: number; taetigkeit?: string | null }

async function vorgangPruefen(tx: Db, projekt: number, vorgang: number | null | undefined) {
  if (!vorgang) return;
  const [v] = await tx`select 1 from tco.hh_projekt_vorgang where id = ${vorgang} and projekt_id = ${projekt}`;
  if (!v) throw new BusinessError('Der Vorgang gehört nicht zu diesem Projekt.');
}
function eingabePruefen(e: ZeitEingabe) {
  if (!(e.stunden > 0) || e.stunden > 24) throw new BusinessError('Bitte Stunden zwischen 0 und 24 je Tag angeben.');
  if (e.datum > heute()) throw new BusinessError('Stunden lassen sich erst melden, wenn sie geleistet sind – das Datum liegt in der Zukunft.');
}

/** Eigene Stunden melden – `adrnr` kommt vom Aufrufer aus der Anmeldung, nie aus der Anfrage */
export async function zeitMelden(tx: Db, mitglied: { adrnr: string; name: string }, e: ZeitEingabe, benutzer: string): Promise<number> {
  eingabePruefen(e);
  if (!(await meldbareProjekte(tx, mitglied.adrnr)).some((p) => p.id === e.projekt_id)) {
    throw new BusinessError('Auf dieses Projekt können Sie keine Stunden melden – Sie sind dort nicht eingeplant oder das Projekt läuft nicht.', 403);
  }
  await vorgangPruefen(tx, e.projekt_id, e.vorgang_id);
  const [r] = await tx`insert into tco.hh_projekt_zeit (projekt_id, vorgang_id, adrnr, name, datum, stunden, taetigkeit, erfasst_von)
                       values (${e.projekt_id}, ${e.vorgang_id ?? null}, ${mitglied.adrnr}, ${mitglied.name}, ${e.datum}, ${e.stunden}, ${e.taetigkeit?.trim() || null}, ${benutzer}) returning id`;
  return Number(r.id);
}

/** Eigene Meldung zurückziehen – nur die eigene und nur, solange sie nicht bestätigt ist */
export async function zeitZurueckziehen(tx: Db, adrnr: string, id: number) {
  const [z] = await tx`select status from tco.hh_projekt_zeit where id = ${id} and adrnr = ${adrnr} for update`;
  if (!z) throw new BusinessError('Meldung nicht gefunden.', 404);
  if (z.status === 'BESTAETIGT') throw new BusinessError('Die Stunden sind bereits bestätigt – ändern kann sie nur noch der Projektverantwortliche.');
  await tx`delete from tco.hh_projekt_zeit where id = ${id}`;
}

/** Der Planer erfasst für ein Mitglied oder für Helfer ohne Zugang – gleich bestätigt */
export async function zeitErfassen(tx: Db, e: ZeitEingabe & { adrnr?: string | null; name?: string | null }, benutzer: string): Promise<number> {
  eingabePruefen({ ...e, stunden: Math.min(e.stunden, 24) });
  if (!(e.stunden > 0) || e.stunden > 500) throw new BusinessError('Bitte die Stunden angeben (höchstens 500 je Zeile, z. B. für mehrere Helfer zusammen).');
  const [p] = await tx`select status from tco.hh_projekt where id = ${e.projekt_id}`;
  if (!p) throw new BusinessError(`Projekt ${e.projekt_id} nicht gefunden.`, 404);
  if (p.status === 'ABGESCHLOSSEN' || p.status === 'ABGELEHNT') throw new BusinessError('Auf ein abgeschlossenes oder abgelehntes Projekt werden keine Stunden mehr erfasst.');
  await vorgangPruefen(tx, e.projekt_id, e.vorgang_id);
  let name = e.name?.trim() || '';
  const adrnr = e.adrnr?.trim() || null;
  if (adrnr) {
    const [m] = await tx`select vorname, nachname from tco.mitglieder where adrnr = ${adrnr}`;
    if (!m) throw new BusinessError(`Das Mitglied ${adrnr} gibt es nicht.`);
    name = `${m.nachname ?? ''}, ${m.vorname ?? ''}`.replace(/\s+/g, ' ').replace(/^, |, $/g, '').trim();
  }
  if (!name) throw new BusinessError('Bitte angeben, wer gearbeitet hat (Mitglied oder z. B. „Helfer“).');
  const [r] = await tx`insert into tco.hh_projekt_zeit (projekt_id, vorgang_id, adrnr, name, datum, stunden, taetigkeit, status, erfasst_von, entschieden_von, entschieden_am)
                       values (${e.projekt_id}, ${e.vorgang_id ?? null}, ${adrnr}, ${name}, ${e.datum}, ${e.stunden}, ${e.taetigkeit?.trim() || null}, 'BESTAETIGT', ${benutzer}, ${benutzer}, now()) returning id`;
  return Number(r.id);
}

/** Bestätigen, zurückweisen (mit Begründung) oder die Entscheidung zurücknehmen */
export async function zeitEntscheiden(tx: Db, id: number, status: ZeitStatus, grund: string | null, benutzer: string): Promise<number> {
  const [z] = await tx`select projekt_id from tco.hh_projekt_zeit where id = ${id} for update`;
  if (!z) throw new BusinessError('Meldung nicht gefunden.', 404);
  if (status === 'ABGELEHNT' && !grund?.trim()) throw new BusinessError('Bitte kurz begründen, warum die Stunden zurückgewiesen werden.');
  const offen = status === 'GEMELDET';
  await tx`update tco.hh_projekt_zeit set status = ${status}, grund = ${status === 'ABGELEHNT' ? grund!.trim() : null},
                  entschieden_von = ${offen ? null : benutzer}, entschieden_am = ${offen ? null : tx`now()`} where id = ${id}`;
  return Number(z.projekt_id);
}

export async function zeitLoeschen(tx: Db, id: number): Promise<number> {
  const [z] = await tx`delete from tco.hh_projekt_zeit where id = ${id} returning projekt_id`;
  if (!z) throw new BusinessError('Meldung nicht gefunden.', 404);
  return Number(z.projekt_id);
}

/** Arbeitsvorrat der Planer: je Projekt die gemeldeten, noch nicht bestätigten Stunden */
export async function aufgaben(db: Db): Promise<Aufgabe[]> {
  const rows = await db`
    select p.id, p.bezeichnung, count(*)::int as n, sum(z.stunden)::float8 as stunden, min(z.erfasst_am)::date::text as seit, count(distinct coalesce(z.adrnr, z.name))::int as personen
      from tco.hh_projekt_zeit z join tco.hh_projekt p on p.id = z.projekt_id where z.status = 'GEMELDET' group by p.id, p.bezeichnung order by 5, p.id`;
  return rows.map((r) => ({
    key: `HHPROJEKTZEIT:${r.id}`, bereich: 'Vorstand', icon: 'time-entry-request', state: 'Information' as const,
    titel: `Projektstunden bestätigen: ${r.bezeichnung}`,
    text: `${r.n} Meldung${r.n === 1 ? '' : 'en'} von ${r.personen} Person${r.personen === 1 ? '' : 'en'} · ${Number(r.stunden).toLocaleString('de-DE', { maximumFractionDigits: 2 })} Stunden – im Reiter „Zeiten“ bestätigen oder zurückweisen`,
    datum: r.seit ?? null, pfad: '/tco/projekte',
  }));
}
