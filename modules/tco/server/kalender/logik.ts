import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import { condense } from '../format.js';
import { gruppenMitVorfahren, mitUntergruppen } from '../gruppen/logik.js';

/**
 * Vereinskalender: Veranstaltungen ankündigen und beschreiben, Mitglieder melden sich an bzw. ab.
 * Gruppen (z. B. Mannschaften) schränken Veranstaltungen auf ihre Mitglieder ein und zeigen,
 * wer noch keine Rückmeldung gegeben hat (Mannschaftsplanung). Es sind die Mitgliedergruppen (Baum):
 * eine Veranstaltung für eine Gruppe gilt auch für die Mitglieder ihrer Untergruppen.
 *
 * Sichtbarkeit: Wer pflegen darf, sieht alles. Mitglieder sehen Veranstaltungen ohne Gruppe und die
 * ihrer Gruppen; Namen der Zusagen nur, wenn die Veranstaltung das erlaubt.
 */

export const KATEGORIEN = {
  VERANSTALTUNG: 'Veranstaltung', MANNSCHAFT: 'Mannschaft / Spieltag', TRAINING: 'Training', TURNIER: 'Turnier', ARBEITSEINSATZ: 'Arbeitseinsatz', SITZUNG: 'Sitzung',
} as const;
export type Kategorie = keyof typeof KATEGORIEN;
export type Status = 'ZUSAGE' | 'ABSAGE' | 'VIELLEICHT';

export interface Event {
  id: number; titel: string; beschreibung: string | null; ort: string | null; kategorie: Kategorie; beginn: string; ende: string | null; ganztags: boolean;
  anmeldung: boolean; anmeldeschluss: string | null; max_teilnehmer: number | null; begleitung: boolean; teilnehmer_sichtbar: boolean;
  gruppen: number[]; abgesagt: boolean; erstellt_von: string | null;
}
export interface EventDaten extends Omit<Event, 'id' | 'erstellt_von'> { }

const EVENT_FELDER = (db: Db) => db`
  e.id, e.titel, e.beschreibung, e.ort, e.kategorie, e.beginn, e.ende, e.ganztags, e.anmeldung, e.anmeldeschluss, e.max_teilnehmer,
  e.begleitung, e.teilnehmer_sichtbar, e.gruppen, e.abgesagt, e.erstellt_von`;
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const eventAus = (r: Record<string, unknown>): Event => ({
  ...(r as unknown as Event), beginn: iso(r.beginn)!, ende: iso(r.ende), anmeldeschluss: iso(r.anmeldeschluss), gruppen: (r.gruppen as number[]) ?? [],
});

/** Gruppen, in denen ein Mitglied ist – auch die übergeordneten (wer in „Herren 40“ ist, gehört zu „Mannschaften“) */
export async function meineGruppen(db: Db, adrnr: string | null): Promise<number[]> {
  return gruppenMitVorfahren(db, adrnr);
}

const sichtbar = (e: Event, gruppen: number[], alles: boolean) => alles || !e.gruppen.length || e.gruppen.some((g) => gruppen.includes(g));

/** offene Anmeldung? (nicht abgesagt, nicht vorbei, vor Anmeldeschluss) */
export function anmeldungOffen(e: Event, jetzt = new Date()): string | null {
  if (!e.anmeldung) return 'Für diese Veranstaltung gibt es keine Anmeldung.';
  if (e.abgesagt) return 'Die Veranstaltung ist abgesagt.';
  if (new Date(e.ende ?? e.beginn) < jetzt) return 'Die Veranstaltung ist vorbei.';
  if (e.anmeldeschluss && new Date(e.anmeldeschluss) < jetzt) return 'Der Anmeldeschluss ist vorbei.';
  return null;
}

export interface Zeitraum { von: string; bis: string }

/** Veranstaltungen im Zeitraum mit Zahlen und eigener Rückmeldung */
export async function eventsLesen(db: Db, z: Zeitraum, o: { adrnr: string | null; alles: boolean }) {
  const gruppen = await meineGruppen(db, o.adrnr);
  const rows = await db`select ${EVENT_FELDER(db)},
           (select count(*) from tco.kal_anmeldungen a where a.event_id = e.id and a.status = 'ZUSAGE')::int as zusagen,
           (select coalesce(sum(a.begleitung), 0) from tco.kal_anmeldungen a where a.event_id = e.id and a.status = 'ZUSAGE')::int as begleitpersonen,
           (select count(*) from tco.kal_anmeldungen a where a.event_id = e.id and a.status = 'ABSAGE')::int as absagen,
           (select count(*) from tco.kal_anmeldungen a where a.event_id = e.id and a.status = 'VIELLEICHT')::int as vielleicht,
           (select a.status from tco.kal_anmeldungen a where a.event_id = e.id and a.adrnr = ${o.adrnr ?? ''}) as mein_status,
           (select a.begleitung from tco.kal_anmeldungen a where a.event_id = e.id and a.adrnr = ${o.adrnr ?? ''}) as meine_begleitung,
           (select a.kommentar from tco.kal_anmeldungen a where a.event_id = e.id and a.adrnr = ${o.adrnr ?? ''}) as mein_kommentar
      from tco.kal_events e
     where coalesce(e.ende, e.beginn) >= ${z.von}::date and e.beginn < (${z.bis}::date + 1)
     order by e.beginn, e.id`;
  const namen = new Map((await db`select id, name from tco.kal_gruppen`).map((g) => [Number(g.id), g.name as string]));
  return rows.map((r) => ({ e: eventAus(r), r })).filter(({ e }) => sichtbar(e, gruppen, o.alles)).map(({ e, r }) => ({
    ...e, gruppen_namen: e.gruppen.map((g) => namen.get(g) ?? `Gruppe ${g}`),
    zusagen: Number(r.zusagen), begleitpersonen: Number(r.begleitpersonen), absagen: Number(r.absagen), vielleicht: Number(r.vielleicht),
    mein_status: (r.mein_status as Status | null) ?? null, meine_begleitung: Number(r.meine_begleitung ?? 0), mein_kommentar: (r.mein_kommentar as string | null) ?? null,
    offen: anmeldungOffen(e), voll: !!e.max_teilnehmer && Number(r.zusagen) + Number(r.begleitpersonen) >= e.max_teilnehmer,
  }));
}

export async function eventLesen(db: Db, id: number): Promise<Event> {
  const [r] = await db`select ${EVENT_FELDER(db)} from tco.kal_events e where e.id = ${id}`;
  if (!r) throw new BusinessError('Veranstaltung nicht gefunden.', 404);
  return eventAus(r);
}

/** Teilnehmer und – bei Gruppen – wer noch nicht geantwortet hat */
export async function teilnehmer(db: Db, e: Event, o: { alles: boolean }) {
  const rows = await db`select a.adrnr, a.status, a.begleitung, a.kommentar, a.geaendert_am, a.geaendert_von,
                               coalesce(nullif(trim(concat_ws(' ', m.vorname, m.nachname)), ''), a.adrnr) as name, m.nachname, m.vorname
                          from tco.kal_anmeldungen a left join tco.mitglieder m on m.adrnr = a.adrnr
                         where a.event_id = ${e.id} order by m.nachname, m.vorname`;
  let offen: { adrnr: string; name: string }[] = [];
  if (e.gruppen.length && o.alles) {
    offen = (await db`select distinct gm.adrnr, coalesce(nullif(trim(concat_ws(' ', m.vorname, m.nachname)), ''), gm.adrnr) as name, m.nachname, m.vorname
                        from tco.kal_gruppe_mitglieder gm left join tco.mitglieder m on m.adrnr = gm.adrnr
                       where gm.gruppe_id = any(${await mitUntergruppen(db, e.gruppen)}) and not exists (select 1 from tco.kal_anmeldungen a where a.event_id = ${e.id} and a.adrnr = gm.adrnr)
                       order by m.nachname, m.vorname`).map((r) => ({ adrnr: r.adrnr, name: r.name }));
  }
  const liste = rows.map((r) => ({
    adrnr: r.adrnr as string, name: r.name as string, status: r.status as Status, begleitung: Number(r.begleitung), kommentar: r.kommentar as string | null,
    geaendert_am: iso(r.geaendert_am), geaendert_von: r.geaendert_von as string | null,
  }));
  // Mitglieder ohne Pflegerecht: nur Namen der Zusagen, ohne Kommentare/Adressnummern
  if (!o.alles) {
    return { zusagen: e.teilnehmer_sichtbar ? liste.filter((x) => x.status === 'ZUSAGE').map((x) => ({ name: x.name, begleitung: x.begleitung })) : [], liste: [], offen: [] };
  }
  return { zusagen: liste.filter((x) => x.status === 'ZUSAGE').map((x) => ({ name: x.name, begleitung: x.begleitung })), liste, offen };
}

/** An- oder abmelden (Mitglied selbst oder Pflege für ein Mitglied) */
export async function rueckmelden(tx: Db, e: Event, adrnr: string, d: { status: Status; begleitung?: number; kommentar?: string | null }, wer: string, pflege: boolean) {
  if (!pflege) {
    const grund = anmeldungOffen(e);
    if (grund) throw new BusinessError(grund);
    if (e.gruppen.length && !(await meineGruppen(tx, adrnr)).some((g) => e.gruppen.includes(g))) {
      throw new BusinessError('Diese Veranstaltung ist nur für Mitglieder bestimmter Gruppen.', 403);
    }
  }
  const begleitung = e.begleitung ? Math.max(0, Math.min(20, d.begleitung ?? 0)) : 0;
  if (d.status === 'ZUSAGE' && e.max_teilnehmer) {
    const [s] = await tx`select coalesce(sum(1 + begleitung), 0)::int as n from tco.kal_anmeldungen where event_id = ${e.id} and status = 'ZUSAGE' and adrnr <> ${adrnr}`;
    if (Number(s.n) + 1 + begleitung > e.max_teilnehmer && !pflege) {
      throw new BusinessError(`Die Veranstaltung ist ausgebucht (${e.max_teilnehmer} Plätze).`);
    }
  }
  const [m] = await tx`select 1 from tco.mitglieder where adrnr = ${adrnr}`;
  if (!m) throw new BusinessError('Mitglied nicht gefunden.');
  await tx`insert into tco.kal_anmeldungen (event_id, adrnr, status, begleitung, kommentar, geaendert_am, geaendert_von)
           values (${e.id}, ${adrnr}, ${d.status}, ${begleitung}, ${condense(d.kommentar ?? '') || null}, now(), ${wer})
           on conflict (event_id, adrnr) do update set status = excluded.status, begleitung = excluded.begleitung, kommentar = excluded.kommentar,
             geaendert_am = excluded.geaendert_am, geaendert_von = excluded.geaendert_von`;
}

export async function rueckmeldungLoeschen(tx: Db, eventId: number, adrnr: string) {
  await tx`delete from tco.kal_anmeldungen where event_id = ${eventId} and adrnr = ${adrnr}`;
}

export async function eventSpeichern(tx: Db, id: number | null, d: EventDaten, wer: string): Promise<number> {
  if (!condense(d.titel)) throw new BusinessError('Bitte einen Titel angeben.');
  if (d.ende && d.ende < d.beginn) throw new BusinessError('Das Ende liegt vor dem Beginn.');
  if (d.gruppen.length) {
    const [g] = await tx`select count(*)::int as n from tco.kal_gruppen where id = any(${d.gruppen})`;
    if (Number(g.n) !== new Set(d.gruppen).size) throw new BusinessError('Unbekannte Gruppe ausgewählt.');
  }
  const werte = {
    titel: condense(d.titel), beschreibung: d.beschreibung?.trim() || null, ort: condense(d.ort ?? '') || null, kategorie: d.kategorie,
    beginn: d.beginn, ende: d.ende || null, ganztags: d.ganztags, anmeldung: d.anmeldung, anmeldeschluss: d.anmeldeschluss || null,
    max_teilnehmer: d.max_teilnehmer || null, begleitung: d.begleitung, teilnehmer_sichtbar: d.teilnehmer_sichtbar, gruppen: [...new Set(d.gruppen)], abgesagt: d.abgesagt,
  };
  if (id) {
    const r = await tx`update tco.kal_events set ${tx(werte as never)} where id = ${id}`;
    if (!r.count) throw new BusinessError('Veranstaltung nicht gefunden.', 404);
    return id;
  }
  const [n] = await tx`insert into tco.kal_events ${tx({ ...werte, erstellt_von: wer } as never)} returning id`;
  return Number(n.id);
}

// ---------------------------------------------------------------- Gruppen
// Die Gruppen sind die Mitgliedergruppen (Baum, siehe ../gruppen/logik.ts) – hier nur weitergereicht.
export { gruppeLoeschen, gruppenLesen, gruppenMitgliedEntfernen, gruppenMitgliedSetzen, gruppeSpeichern } from '../gruppen/logik.js';

/** Mitglieder zur Auswahl (Pflege) – nur Name und Adressnummer */
export async function mitgliederAuswahl(db: Db) {
  return (await db`select adrnr, vorname, nachname from tco.mitglieder where austritt is null or austritt >= current_date order by nachname, vorname`)
    .map((r) => ({ adrnr: r.adrnr as string, name: condense(`${r.nachname ?? ''}, ${r.vorname ?? ''}`) }));
}

/** Teilnehmerliste als CSV (Excel, Semikolon) */
export function teilnehmerCsv(e: Event, liste: { name: string; status: Status; begleitung: number; kommentar: string | null }[], offen: { name: string }[]) {
  const q = (s: string | number | null) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const T: Record<Status, string> = { ZUSAGE: 'Zusage', ABSAGE: 'Absage', VIELLEICHT: 'Vielleicht' };
  const zeilen = [['Name', 'Rückmeldung', 'Begleitpersonen', 'Kommentar'].map(q).join(';'),
    ...liste.map((x) => [x.name, T[x.status], x.begleitung, x.kommentar].map(q).join(';')),
    ...offen.map((x) => [x.name, 'keine Rückmeldung', '', ''].map(q).join(';'))];
  return `﻿${e.titel}\n${zeilen.join('\n')}\n`;
}
