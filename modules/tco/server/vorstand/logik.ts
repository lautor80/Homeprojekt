/**
 * Vorstandssitzungen: Sitzungen mit Teilnehmern (Vorstand + Gäste), Tagesordnung, Beschlüssen, Aufgaben und Anlagen,
 * Verknüpfung mit einer Veranstaltung des Vereinskalenders, Freigabe des Protokolls und Import alter Protokolle (Markdown).
 *
 * Der Vorstand ist die Mitgliedergruppe aus der Einstellung (tco.vs_cfg) – ohne Einstellung die Gruppe mit dem Namen
 * „Vorstand“ –, samt ihrer Untergruppen. Die Rolle eines Mitglieds ist seine Rolle in der Gruppe, sonst der Name der Untergruppe.
 */
import { linkPruefen } from './format.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { dateityp } from '../../../../server/src/lib/dateityp.js';
import type { Aufgabe } from '../../../../server/src/lib/arbeitsvorrat.js';
import { dat, heute } from '../format.js';
import type { Db } from '../verein.js';
import { mdZaehlen, type MdProtokoll } from './markdown.js';
import {
  ART_TEXT, beschlussfaehig, beschlussNr, ergebnisAus, personZuordnen, sitzungNr, STATUS_TEXT, UEBERGAENGE, verantwortlicheAnzeigen,
  type Ergebnis, type Person, type Status, type Teilnahme,
} from './regeln.js';

export const P_VS = { display: 'tco.vorstand:display', edit: 'tco.vorstand:edit', approve: 'tco.vorstand:approve' };

/** Anlagen: je Datei und je Sitzung zusammen */
export const ANLAGE_MAX = 15 * 1024 * 1024;
export const ANLAGEN_SITZUNG_MAX = 60 * 1024 * 1024;

const leer = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);
const tagZeit = (z: unknown) => (z ? new Date(z as string).toISOString() : null);

// ---------------------------------------------------------------- Vorstand (Mitgliedergruppe)

export async function cfgLesen(db: Db): Promise<{ gruppe_id: number | null; gruppe: string | null; automatisch: boolean }> {
  const [c] = await db`select c.gruppe_id, g.name from tco.vs_cfg c left join tco.kal_gruppen g on g.id = c.gruppe_id where c.id = 1`;
  if (c?.gruppe_id) return { gruppe_id: Number(c.gruppe_id), gruppe: c.name as string, automatisch: false };
  const [g] = await db`select id, name from tco.kal_gruppen where lower(trim(name)) = 'vorstand' order by (parent_id is null) desc, id limit 1`;
  return { gruppe_id: g ? Number(g.id) : null, gruppe: (g?.name as string) ?? null, automatisch: true };
}

/**
 * Personen für die Anzeige der Verantwortlichen („Vorname Nachname“ statt „laub“): Mitglieder der Vorstandsgruppe und alle
 * Mitglieder, die je als Vorstand an einer Sitzung teilgenommen haben (auch frühere Vorstände in alten Protokollen).
 */
export async function namensPersonen(db: Db): Promise<Person[]> {
  const vs = await vorstandLesen(db, (await cfgLesen(db)).gruppe_id);
  const tn = await db`select distinct m.adrnr, coalesce(m.vorname, '') as vorname, coalesce(m.nachname, '') as nachname
                        from tco.vs_teilnehmer p join tco.mitglieder m on m.adrnr = p.adrnr`;
  const alle = new Map<string, Person>();
  for (const p of [...vs, ...tn.map((r) => ({ adrnr: r.adrnr as string, vorname: r.vorname as string, nachname: r.nachname as string }))]) {
    if (p.nachname.trim() && !alle.has(p.adrnr)) alle.set(p.adrnr, { adrnr: p.adrnr, vorname: p.vorname.trim(), nachname: p.nachname.trim() });
  }
  return [...alle.values()];
}
/** Verantwortliche beim Sichern in die Form „Vorname Nachname“ bringen (Unklares bleibt, wie eingegeben) */
async function verantwortlicheNormal(db: Db, v: string | null | undefined): Promise<string | null> {
  const t = leer(v);
  return t ? verantwortlicheAnzeigen(t, await namensPersonen(db)) : null;
}

export async function cfgSpeichern(tx: Db, gruppeId: number | null) {
  if (gruppeId != null) {
    const [g] = await tx`select 1 from tco.kal_gruppen where id = ${gruppeId}`;
    if (!g) throw new BusinessError('Die Mitgliedergruppe gibt es nicht (mehr).');
  }
  await tx`insert into tco.vs_cfg (id, gruppe_id) values (1, ${gruppeId}) on conflict (id) do update set gruppe_id = excluded.gruppe_id`;
}

export interface VorstandMitglied extends Person { name: string; rolle: string | null }

/** Mitglieder der Vorstandsgruppe samt Untergruppen (ohne Ausgetretene) */
export async function vorstandLesen(db: Db, gruppeId: number | null): Promise<VorstandMitglied[]> {
  if (!gruppeId) return [];
  const rows = await db`
    with recursive baum as (
      select id, name, 0 as tiefe from tco.kal_gruppen where id = ${gruppeId}
      union all select g.id, g.name, b.tiefe + 1 from tco.kal_gruppen g join baum b on g.parent_id = b.id
    )
    select distinct on (m.adrnr) m.adrnr, coalesce(m.vorname, '') as vorname, coalesce(m.nachname, '') as nachname,
           coalesce(nullif(trim(gm.rolle), ''), case when b.tiefe > 0 then b.name end) as rolle
      from baum b join tco.kal_gruppe_mitglieder gm on gm.gruppe_id = b.id join tco.mitglieder m on m.adrnr = gm.adrnr
     where m.austritt is null or m.austritt >= current_date
     order by m.adrnr, (gm.rolle is null), b.tiefe`;
  return rows.map((r) => ({
    adrnr: r.adrnr as string, vorname: r.vorname as string, nachname: r.nachname as string, rolle: (r.rolle as string) ?? null,
    name: [r.nachname, r.vorname].filter(Boolean).join(', '),
  })).sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

// ---------------------------------------------------------------- Lesen

export interface Sitzung {
  id: number; nr: string; jahr: number; lfd: number; titel: string; art: 'VORSTAND' | 'ERWEITERT'; art_text: string;
  datum: string; beginn: string | null; ende: string | null; ort: string | null;
  status: Status; status_text: string; leitung: string | null; protokoll_von: string | null; bemerkung: string | null; importiert: boolean;
  freigegeben_am: string | null; freigegeben_von: string | null; geaendert_am: string; geaendert_von: string | null;
  event: { id: number; titel: string; beginn: string; ende: string | null; ort: string | null; abgesagt: boolean; zusagen: number; absagen: number } | null;
}
export interface Teilnehmer { id: number; adrnr: string | null; name: string; rolle: string | null; art: 'VORSTAND' | 'GAST'; status: Teilnahme; rueckmeldung: string | null }
export interface Eintrag {
  id: number; top_id: number; pos: number; art: 'BESCHLUSS' | 'AUFGABE' | 'INFO'; text: string;
  nr: string | null; ja: number | null; nein: number | null; enthaltung: number | null; ergebnis: Ergebnis | null;
  verantwortlich: string | null; faellig: string | null; erledigt_am: string | null; erledigt_von: string | null;
}
export interface Top { id: number; pos: number; nr: number; titel: string; verantwortlich: string | null; text: string | null; status: 'OFFEN' | 'ERLEDIGT' | 'VERTAGT'; eintraege: Eintrag[] }
/** Datei oder Verknüpfung (url gesetzt, dann ist dateiname die Bezeichnung und groesse 0) */
export interface Anlage { id: number; top_id: number | null; dateiname: string; mime: string; groesse: number; url: string | null; erstellt_am: string; erstellt_von: string | null }
export interface SitzungDetail extends Sitzung {
  teilnehmer: Teilnehmer[]; tops: Top[]; anlagen: Anlage[];
  beschlussfaehig: ReturnType<typeof beschlussfaehig>;
  /** Folgestatus, die von hier aus erreichbar sind */
  naechste: Status[];
}

const SITZUNG_SQL = (db: Db) => db`
  s.id, s.jahr, s.lfd, s.titel, s.art, s.status, s.leitung, s.protokoll_von, s.bemerkung, s.importiert, s.freigegeben_am, s.freigegeben_von,
  s.geaendert_am, s.geaendert_von, s.event_id,
  coalesce((e.beginn at time zone 'Europe/Berlin')::date, s.datum) as datum,
  to_char(case when e.id is not null and not e.ganztags then (e.beginn at time zone 'Europe/Berlin')::time else s.beginn end, 'HH24:MI') as beginn,
  to_char(case when e.id is not null and e.ende is not null and not e.ganztags then (e.ende at time zone 'Europe/Berlin')::time else s.ende end, 'HH24:MI') as ende,
  coalesce(e.ort, s.ort) as ort,
  e.titel as e_titel, e.beginn as e_beginn, e.ende as e_ende, e.ort as e_ort, e.abgesagt as e_abgesagt,
  (select count(*) from tco.kal_anmeldungen a where a.event_id = e.id and a.status = 'ZUSAGE')::int as e_zusagen,
  (select count(*) from tco.kal_anmeldungen a where a.event_id = e.id and a.status = 'ABSAGE')::int as e_absagen`;

function sitzungAus(r: Record<string, unknown>): Sitzung {
  const status = r.status as Status, art = r.art as 'VORSTAND' | 'ERWEITERT';
  return {
    id: Number(r.id), nr: sitzungNr(Number(r.jahr), Number(r.lfd)), jahr: Number(r.jahr), lfd: Number(r.lfd), titel: r.titel as string,
    art, art_text: ART_TEXT[art], datum: r.datum as string, beginn: (r.beginn as string) ?? null, ende: (r.ende as string) ?? null, ort: (r.ort as string) ?? null,
    status, status_text: STATUS_TEXT[status], leitung: (r.leitung as string) ?? null, protokoll_von: (r.protokoll_von as string) ?? null,
    bemerkung: (r.bemerkung as string) ?? null, importiert: !!r.importiert,
    freigegeben_am: tagZeit(r.freigegeben_am), freigegeben_von: (r.freigegeben_von as string) ?? null,
    geaendert_am: tagZeit(r.geaendert_am)!, geaendert_von: (r.geaendert_von as string) ?? null,
    event: r.event_id && r.e_titel ? {
      id: Number(r.event_id), titel: r.e_titel as string, beginn: tagZeit(r.e_beginn)!, ende: tagZeit(r.e_ende), ort: (r.e_ort as string) ?? null,
      abgesagt: !!r.e_abgesagt, zusagen: Number(r.e_zusagen), absagen: Number(r.e_absagen),
    } : null,
  };
}

export interface SitzungZeile extends Sitzung { tops: number; beschluesse: number; aufgaben_offen: number; anlagen: number; anwesend: number; vorstand: number }

export async function sitzungenLesen(db: Db, f: { jahr?: number | null; suche?: string | null } = {}): Promise<SitzungZeile[]> {
  const q = leer(f.suche) ? `%${f.suche!.trim()}%` : null;
  const rows = await db`
    select ${SITZUNG_SQL(db)},
      (select count(*) from tco.vs_tops t where t.sitzung_id = s.id)::int as n_tops,
      (select count(*) from tco.vs_eintraege x join tco.vs_tops t on t.id = x.top_id where t.sitzung_id = s.id and x.art = 'BESCHLUSS')::int as n_beschl,
      (select count(*) from tco.vs_eintraege x join tco.vs_tops t on t.id = x.top_id where t.sitzung_id = s.id and x.art = 'AUFGABE' and x.erledigt_am is null)::int as n_aufg,
      (select count(*) from tco.vs_anlagen a where a.sitzung_id = s.id)::int as n_anl,
      (select count(*) from tco.vs_teilnehmer p where p.sitzung_id = s.id and p.art = 'VORSTAND' and p.status = 'ANWESEND')::int as n_anw,
      (select count(*) from tco.vs_teilnehmer p where p.sitzung_id = s.id and p.art = 'VORSTAND')::int as n_vs
    from tco.vs_sitzungen s left join tco.kal_events e on e.id = s.event_id
    where (${f.jahr ?? null}::int is null or extract(year from coalesce((e.beginn at time zone 'Europe/Berlin')::date, s.datum))::int = ${f.jahr ?? null}::int)
      and (${q}::text is null or s.titel ilike ${q} or s.bemerkung ilike ${q}
           or exists (select 1 from tco.vs_tops t left join tco.vs_eintraege x on x.top_id = t.id
                       where t.sitzung_id = s.id and (t.titel ilike ${q} or t.text ilike ${q} or x.text ilike ${q})))
    order by coalesce((e.beginn at time zone 'Europe/Berlin')::date, s.datum) desc, s.id desc`;
  return rows.map((r) => ({
    ...sitzungAus(r), tops: Number(r.n_tops), beschluesse: Number(r.n_beschl), aufgaben_offen: Number(r.n_aufg), anlagen: Number(r.n_anl),
    anwesend: Number(r.n_anw), vorstand: Number(r.n_vs),
  }));
}

const EINTRAG_SQL = (db: Db) => db`
  x.id, x.top_id, x.pos, x.art, x.text, x.nr_jahr, x.nr_lfd, x.ja, x.nein, x.enthaltung, x.ergebnis, x.verantwortlich, x.faellig, x.erledigt_am, x.erledigt_von`;
const eintragAus = (r: Record<string, unknown>): Eintrag => ({
  id: Number(r.id), top_id: Number(r.top_id), pos: Number(r.pos), art: r.art as Eintrag['art'], text: r.text as string,
  nr: r.nr_jahr ? beschlussNr(Number(r.nr_jahr), Number(r.nr_lfd)) : null,
  ja: (r.ja as number) ?? null, nein: (r.nein as number) ?? null, enthaltung: (r.enthaltung as number) ?? null, ergebnis: (r.ergebnis as Ergebnis) ?? null,
  verantwortlich: (r.verantwortlich as string) ?? null, faellig: (r.faellig as string) ?? null,
  erledigt_am: tagZeit(r.erledigt_am), erledigt_von: (r.erledigt_von as string) ?? null,
});

export async function sitzungLesen(db: Db, id: number): Promise<SitzungDetail> {
  const [r] = await db`select ${SITZUNG_SQL(db)} from tco.vs_sitzungen s left join tco.kal_events e on e.id = s.event_id where s.id = ${id}`;
  if (!r) throw new BusinessError('Die Sitzung gibt es nicht (mehr).', 404);
  const s = sitzungAus(r);
  const teilnehmer = (await db`
    select p.id, p.adrnr, p.name, p.rolle, p.art, p.status, a.status as rueckmeldung
      from tco.vs_teilnehmer p left join tco.kal_anmeldungen a on a.event_id = ${s.event?.id ?? null}::int and a.adrnr = p.adrnr
     where p.sitzung_id = ${id} order by (p.art = 'GAST'), lower(p.name), p.id`).map((t) => ({
    id: Number(t.id), adrnr: (t.adrnr as string) ?? null, name: t.name as string, rolle: (t.rolle as string) ?? null,
    art: t.art as Teilnehmer['art'], status: t.status as Teilnahme, rueckmeldung: (t.rueckmeldung as string) ?? null,
  }));
  const tops = (await db`select id, pos, titel, verantwortlich, text, status from tco.vs_tops where sitzung_id = ${id} order by pos, id`)
    .map((t, i): Top => ({ id: Number(t.id), pos: Number(t.pos), nr: i + 1, titel: t.titel as string, verantwortlich: (t.verantwortlich as string) ?? null,
      text: (t.text as string) ?? null, status: t.status as Top['status'], eintraege: [] as Eintrag[] }));
  const eintraege = (await db`select ${EINTRAG_SQL(db)} from tco.vs_eintraege x join tco.vs_tops t on t.id = x.top_id where t.sitzung_id = ${id} order by x.pos, x.id`).map(eintragAus);
  for (const e of eintraege) tops.find((t) => t.id === e.top_id)?.eintraege.push(e);
  // Verantwortliche immer mit Vornamen anzeigen (auch alte Kürzel wie „laub“, „kas“)
  const personen = tops.some((t) => t.verantwortlich || t.eintraege.some((e) => e.verantwortlich)) ? await namensPersonen(db) : [];
  for (const t of tops) {
    t.verantwortlich = verantwortlicheAnzeigen(t.verantwortlich, personen);
    for (const e of t.eintraege) e.verantwortlich = verantwortlicheAnzeigen(e.verantwortlich, personen);
  }
  const anlagen = (await db`select id, top_id, dateiname, mime, groesse, url, erstellt_am, erstellt_von from tco.vs_anlagen where sitzung_id = ${id} order by id`)
    .map((a) => ({ id: Number(a.id), top_id: a.top_id == null ? null : Number(a.top_id), dateiname: a.dateiname as string, mime: a.mime as string,
      groesse: Number(a.groesse), url: (a.url as string) ?? null, erstellt_am: tagZeit(a.erstellt_am)!, erstellt_von: (a.erstellt_von as string) ?? null }));
  return { ...s, teilnehmer, tops, anlagen, beschlussfaehig: beschlussfaehig(teilnehmer), naechste: UEBERGAENGE[s.status] };
}

export interface BeschlussZeile extends Eintrag { sitzung_id: number; sitzung_nr: string; sitzung_titel: string; datum: string; top: string }

/** Beschlüsse über alle Sitzungen (Register) */
export async function beschluesseLesen(db: Db, f: { jahr?: number | null; suche?: string | null } = {}): Promise<BeschlussZeile[]> {
  const q = leer(f.suche) ? `%${f.suche!.trim()}%` : null;
  const rows = await db`
    select ${EINTRAG_SQL(db)}, s.id as sitzung_id, s.jahr as s_jahr, s.lfd as s_lfd, s.titel as s_titel, t.titel as t_titel,
           coalesce((e.beginn at time zone 'Europe/Berlin')::date, s.datum) as s_datum
      from tco.vs_eintraege x join tco.vs_tops t on t.id = x.top_id join tco.vs_sitzungen s on s.id = t.sitzung_id
      left join tco.kal_events e on e.id = s.event_id
     where x.art = 'BESCHLUSS' and (${f.jahr ?? null}::int is null or x.nr_jahr = ${f.jahr ?? null}::int)
       and (${q}::text is null or x.text ilike ${q} or t.titel ilike ${q})
     order by x.nr_jahr desc, x.nr_lfd desc`;
  return rows.map((r) => ({ ...eintragAus(r), sitzung_id: Number(r.sitzung_id), sitzung_nr: sitzungNr(Number(r.s_jahr), Number(r.s_lfd)),
    sitzung_titel: r.s_titel as string, datum: r.s_datum as string, top: r.t_titel as string }));
}

export interface AufgabeZeile extends Eintrag { sitzung_id: number; sitzung_nr: string; datum: string; top: string; stand: 'ERLEDIGT' | 'UEBERFAELLIG' | 'BALD' | 'OFFEN' }

export function aufgabeStand(erledigt: boolean, faellig: string | null, stichtag: string): AufgabeZeile['stand'] {
  if (erledigt) return 'ERLEDIGT';
  if (!faellig) return 'OFFEN';
  if (faellig < stichtag) return 'UEBERFAELLIG';
  const bald = new Date(`${stichtag}T12:00:00Z`); bald.setUTCDate(bald.getUTCDate() + 7);
  return faellig <= bald.toISOString().slice(0, 10) ? 'BALD' : 'OFFEN';
}

/** Aufgaben aus allen Sitzungen; offen = nur nicht erledigte */
export async function aufgabenLesen(db: Db, f: { offen?: boolean } = {}): Promise<AufgabeZeile[]> {
  const rows = await db`
    select ${EINTRAG_SQL(db)}, s.id as sitzung_id, s.jahr as s_jahr, s.lfd as s_lfd, t.titel as t_titel,
           coalesce((e.beginn at time zone 'Europe/Berlin')::date, s.datum) as s_datum
      from tco.vs_eintraege x join tco.vs_tops t on t.id = x.top_id join tco.vs_sitzungen s on s.id = t.sitzung_id
      left join tco.kal_events e on e.id = s.event_id
     where x.art = 'AUFGABE' and (not ${!!f.offen}::boolean or x.erledigt_am is null)
     order by (x.erledigt_am is not null), x.faellig nulls last, s_datum desc, x.id`;
  const h = heute();
  const personen = rows.some((r) => r.verantwortlich) ? await namensPersonen(db) : [];
  return rows.map((r) => {
    const e = eintragAus(r);
    e.verantwortlich = verantwortlicheAnzeigen(e.verantwortlich, personen);
    return { ...e, sitzung_id: Number(r.sitzung_id), sitzung_nr: sitzungNr(Number(r.s_jahr), Number(r.s_lfd)), datum: r.s_datum as string,
      top: r.t_titel as string, stand: aufgabeStand(!!e.erledigt_am, e.faellig, h) };
  });
}

/** Veranstaltungen zur Auswahl: Sitzungen zuerst, ab 60 Tagen zurück */
export async function eventsZurAuswahl(db: Db) {
  const rows = await db`
    select e.id, e.titel, e.kategorie, e.beginn, e.ort, e.abgesagt,
           (select s.id from tco.vs_sitzungen s where s.event_id = e.id limit 1) as sitzung_id
      from tco.kal_events e where e.beginn >= now() - interval '60 days'
     order by (e.kategorie = 'SITZUNG') desc, e.beginn, e.id limit 300`;
  return rows.map((r) => ({ id: Number(r.id), titel: r.titel as string, kategorie: r.kategorie as string, beginn: tagZeit(r.beginn)!,
    ort: (r.ort as string) ?? null, abgesagt: !!r.abgesagt, sitzung_id: r.sitzung_id == null ? null : Number(r.sitzung_id) }));
}

// ---------------------------------------------------------------- Schreiben: Sitzung

async function sitzungFuerAenderung(tx: Db, id: number, o: { auchFreigegeben?: boolean } = {}) {
  const [s] = await tx`select id, status, jahr from tco.vs_sitzungen where id = ${id} for update`;
  if (!s) throw new BusinessError('Die Sitzung gibt es nicht (mehr).', 404);
  if (s.status === 'FREIGEGEBEN' && !o.auchFreigegeben) {
    throw new BusinessError('Das Protokoll ist freigegeben und kann nicht mehr geändert werden. Für Korrekturen die Freigabe zurücknehmen.');
  }
  return { id: Number(s.id), status: s.status as Status, jahr: Number(s.jahr) };
}

async function beruehren(tx: Db, id: number, wer: string) {
  await tx`update tco.vs_sitzungen set geaendert_am = now(), geaendert_von = ${wer} where id = ${id}`;
}

async function sitzungZuTop(tx: Db, topId: number) {
  const [t] = await tx`select sitzung_id from tco.vs_tops where id = ${topId}`;
  if (!t) throw new BusinessError('Den Tagesordnungspunkt gibt es nicht (mehr).', 404);
  return Number(t.sitzung_id);
}

async function naechsteLfd(tx: Db, jahr: number) {
  // gegen gleichzeitiges Anlegen: Sperre je Jahr
  await tx`select pg_advisory_xact_lock(hashtext('tco.vs_sitzungen'), ${jahr})`;
  const [n] = await tx`select coalesce(max(lfd), 0) + 1 as n from tco.vs_sitzungen where jahr = ${jahr}`;
  return Number(n.n);
}

async function naechsteBeschlussNr(tx: Db, jahr: number) {
  await tx`select pg_advisory_xact_lock(hashtext('tco.vs_beschluss'), ${jahr})`;
  const [n] = await tx`select coalesce(max(nr_lfd), 0) + 1 as n from tco.vs_eintraege where nr_jahr = ${jahr}`;
  return Number(n.n);
}

/** Vorstandsmitglieder als Teilnehmer eintragen, die noch fehlen (Rolle wird nachgezogen) */
export async function vorstandEintragen(tx: Db, sitzungId: number): Promise<number> {
  const cfg = await cfgLesen(tx);
  const vs = await vorstandLesen(tx, cfg.gruppe_id);
  let n = 0;
  for (const m of vs) {
    const r = await tx`
      insert into tco.vs_teilnehmer (sitzung_id, adrnr, name, rolle, art) values (${sitzungId}, ${m.adrnr}, ${m.name}, ${m.rolle}, 'VORSTAND')
      on conflict (sitzung_id, adrnr) where adrnr is not null do update set rolle = coalesce(excluded.rolle, tco.vs_teilnehmer.rolle)
      returning (xmax = 0) as neu`;
    if (r[0]?.neu) n++;
  }
  return n;
}

/** Absagen aus der Veranstaltung als „entschuldigt“ übernehmen (nur offene Teilnehmer) */
export async function rueckmeldungenUebernehmen(tx: Db, sitzungId: number): Promise<number> {
  const r = await tx`
    update tco.vs_teilnehmer p set status = 'ENTSCHULDIGT'
      from tco.vs_sitzungen s, tco.kal_anmeldungen a
     where p.sitzung_id = ${sitzungId} and s.id = p.sitzung_id and a.event_id = s.event_id and a.adrnr = p.adrnr
       and a.status = 'ABSAGE' and p.status = 'OFFEN'`;
  return r.count;
}

export interface KopfEingabe {
  titel: string; art: 'VORSTAND' | 'ERWEITERT'; datum: string; beginn?: string | null; ende?: string | null; ort?: string | null;
  leitung?: string | null; protokoll_von?: string | null; bemerkung?: string | null;
}

/** Veranstaltung im Vereinskalender für die Sitzung anlegen (Kategorie Sitzung, Gruppe Vorstand, An-/Abmeldung) */
export async function eventFuerSitzung(tx: Db, s: { titel: string; datum: string; beginn: string | null; ende: string | null; ort: string | null }, wer: string, vergangen = false): Promise<number> {
  const cfg = await cfgLesen(tx);
  const beginn = s.beginn ?? '19:00';
  const [n] = await tx`
    insert into tco.kal_events (titel, ort, kategorie, beginn, ende, ganztags, anmeldung, gruppen, teilnehmer_sichtbar, erstellt_von)
    values (${s.titel}, ${s.ort}, 'SITZUNG', (${s.datum}::date + ${beginn}::time) at time zone 'Europe/Berlin',
            case when ${s.ende}::text is null then null else (${s.datum}::date + ${s.ende}::time) at time zone 'Europe/Berlin' end,
            ${!s.beginn}, ${!vergangen}, ${cfg.gruppe_id ? `{${cfg.gruppe_id}}` : '{}'}::int[], true, ${wer})
    returning id`;
  return Number(n.id);
}

async function eventPruefen(tx: Db, eventId: number, sitzungId: number | null) {
  const [e] = await tx`select e.id, (select s.id from tco.vs_sitzungen s where s.event_id = e.id and s.id is distinct from ${sitzungId}::int limit 1) as andere
                         from tco.kal_events e where e.id = ${eventId}`;
  if (!e) throw new BusinessError('Die Veranstaltung gibt es nicht (mehr).');
  if (e.andere) throw new BusinessError('Diese Veranstaltung ist schon mit einer anderen Sitzung verknüpft.');
}

/** Standard-Tagesordnung einer neuen Sitzung: Begrüßung, Protokoll der letzten Sitzung, vertagte Punkte, Verschiedenes */
async function tagesordnungVorschlagen(tx: Db, sitzungId: number, datum: string) {
  const [vor] = await tx`select id, jahr, lfd from tco.vs_sitzungen where id <> ${sitzungId} and datum < ${datum}::date order by datum desc, id desc limit 1`;
  const titel = ['Begrüßung und Feststellung der Beschlussfähigkeit'];
  if (vor) titel.push(`Genehmigung des Protokolls ${sitzungNr(Number(vor.jahr), Number(vor.lfd))}`);
  const vertagt = vor ? await tx`select titel, verantwortlich from tco.vs_tops where sitzung_id = ${vor.id} and status = 'VERTAGT' order by pos, id` : [];
  let pos = 0;
  for (const t of titel) await tx`insert into tco.vs_tops (sitzung_id, pos, titel) values (${sitzungId}, ${pos++}, ${t})`;
  for (const t of vertagt) await tx`insert into tco.vs_tops (sitzung_id, pos, titel, verantwortlich) values (${sitzungId}, ${pos++}, ${t.titel as string}, ${(t.verantwortlich as string) ?? null})`;
  await tx`insert into tco.vs_tops (sitzung_id, pos, titel) values (${sitzungId}, ${pos++}, 'Verschiedenes')`;
}

export async function sitzungAnlegen(tx: Db, e: KopfEingabe & { event_id?: number | null; event_anlegen?: boolean; vorlage?: boolean }, wer: string): Promise<number> {
  let d = { datum: e.datum, beginn: leer(e.beginn), ende: leer(e.ende), ort: leer(e.ort) };
  if (e.event_id) {
    await eventPruefen(tx, e.event_id, null);
    const [ev] = await tx`select (beginn at time zone 'Europe/Berlin')::date as datum, to_char((beginn at time zone 'Europe/Berlin')::time, 'HH24:MI') as beginn,
                                 to_char((ende at time zone 'Europe/Berlin')::time, 'HH24:MI') as ende, ort, ganztags from tco.kal_events where id = ${e.event_id}`;
    d = { datum: ev.datum as string, beginn: ev.ganztags ? d.beginn : (ev.beginn as string), ende: ev.ganztags ? d.ende : ((ev.ende as string) ?? d.ende), ort: (ev.ort as string) ?? d.ort };
  }
  const jahr = Number(d.datum.slice(0, 4));
  const lfd = await naechsteLfd(tx, jahr);
  const eventId = e.event_id ?? (e.event_anlegen ? await eventFuerSitzung(tx, { titel: e.titel.trim(), ...d }, wer) : null);
  const [r] = await tx`
    insert into tco.vs_sitzungen (jahr, lfd, titel, art, datum, beginn, ende, ort, event_id, leitung, protokoll_von, bemerkung, erstellt_von, geaendert_von)
    values (${jahr}, ${lfd}, ${e.titel.trim()}, ${e.art}, ${d.datum}, ${d.beginn}, ${d.ende}, ${d.ort}, ${eventId}, ${leer(e.leitung)}, ${leer(e.protokoll_von) ?? wer},
            ${leer(e.bemerkung)}, ${wer}, ${wer})
    returning id`;
  const id = Number(r.id);
  await vorstandEintragen(tx, id);
  if (eventId) await rueckmeldungenUebernehmen(tx, id);
  if (e.vorlage !== false) await tagesordnungVorschlagen(tx, id, d.datum);
  return id;
}

export async function sitzungAendern(tx: Db, id: number, e: KopfEingabe, wer: string) {
  await sitzungFuerAenderung(tx, id);
  await tx`
    update tco.vs_sitzungen set titel = ${e.titel.trim()}, art = ${e.art}, datum = ${e.datum}, beginn = ${leer(e.beginn)}, ende = ${leer(e.ende)},
           ort = ${leer(e.ort)}, leitung = ${leer(e.leitung)}, protokoll_von = ${leer(e.protokoll_von)}, bemerkung = ${leer(e.bemerkung)},
           geaendert_am = now(), geaendert_von = ${wer}
     where id = ${id}`;
}

export async function sitzungLoeschen(tx: Db, id: number) {
  const s = await sitzungFuerAenderung(tx, id);
  if (s.status !== 'GEPLANT' && s.status !== 'ENTWURF') throw new BusinessError('Löschen geht nur bei geplanten Sitzungen und Protokollen im Entwurf.');
  await tx`delete from tco.vs_sitzungen where id = ${id}`;
}

/** Veranstaltung verknüpfen (event_id), neu anlegen (anlegen) oder lösen (beides leer) */
export async function eventSetzen(tx: Db, id: number, o: { event_id?: number | null; anlegen?: boolean }, wer: string) {
  await sitzungFuerAenderung(tx, id);
  let eventId = o.event_id ?? null;
  if (eventId) await eventPruefen(tx, eventId, id);
  else if (o.anlegen) {
    const [s] = await tx`select titel, datum, to_char(beginn, 'HH24:MI') as beginn, to_char(ende, 'HH24:MI') as ende, ort from tco.vs_sitzungen where id = ${id}`;
    eventId = await eventFuerSitzung(tx, { titel: s.titel as string, datum: s.datum as string, beginn: (s.beginn as string) ?? null, ende: (s.ende as string) ?? null, ort: (s.ort as string) ?? null }, wer);
  }
  // beim Lösen die Daten der Veranstaltung in die Sitzung übernehmen, damit Datum und Ort erhalten bleiben
  await tx`
    update tco.vs_sitzungen s set
      datum = (e.beginn at time zone 'Europe/Berlin')::date,
      beginn = case when e.ganztags then s.beginn else (e.beginn at time zone 'Europe/Berlin')::time end,
      ende = case when e.ende is null or e.ganztags then s.ende else (e.ende at time zone 'Europe/Berlin')::time end,
      ort = coalesce(e.ort, s.ort)
      from tco.kal_events e
     where s.id = ${id} and e.id = s.event_id`;
  await tx`update tco.vs_sitzungen set event_id = ${eventId}, geaendert_am = now(), geaendert_von = ${wer} where id = ${id}`;
  if (eventId) await rueckmeldungenUebernehmen(tx, id);
  return eventId;
}

export async function statusSetzen(tx: Db, id: number, neu: Status, wer: string, darfFreigeben: boolean) {
  const s = await sitzungFuerAenderung(tx, id, { auchFreigegeben: true });
  if (s.status === neu) return;
  if (!UEBERGAENGE[s.status].includes(neu)) throw new BusinessError(`Von „${STATUS_TEXT[s.status]}“ geht es nicht nach „${STATUS_TEXT[neu]}“.`);
  if ((neu === 'FREIGEGEBEN' || s.status === 'FREIGEGEBEN') && !darfFreigeben) {
    throw new BusinessError('Protokolle freigeben bzw. die Freigabe zurücknehmen darf nur, wer das Recht zur Freigabe hat.', 403);
  }
  if (neu === 'FREIGEGEBEN') {
    const [t] = await tx`select count(*)::int as n from tco.vs_tops where sitzung_id = ${id}`;
    if (!Number(t.n)) throw new BusinessError('Ein Protokoll ohne Tagesordnungspunkte kann nicht freigegeben werden.');
    const [o] = await tx`select count(*)::int as n from tco.vs_teilnehmer where sitzung_id = ${id} and art = 'VORSTAND' and status = 'OFFEN'`;
    if (Number(o.n)) throw new BusinessError(`Bei ${o.n} Vorstandsmitglied${Number(o.n) === 1 ? '' : 'ern'} fehlt noch die Teilnahme (anwesend, entschuldigt oder fehlt).`);
  }
  const frei = neu === 'FREIGEGEBEN';
  await tx`update tco.vs_sitzungen set status = ${neu},
             freigegeben_am = ${frei ? new Date() : null}, freigegeben_von = ${frei ? wer : null},
             geaendert_am = now(), geaendert_von = ${wer} where id = ${id}`;
}

// ---------------------------------------------------------------- Teilnehmer

export async function teilnahmeSetzen(tx: Db, tid: number, status: Teilnahme, wer: string) {
  const [p] = await tx`select sitzung_id from tco.vs_teilnehmer where id = ${tid}`;
  if (!p) throw new BusinessError('Teilnehmer nicht gefunden.', 404);
  await sitzungFuerAenderung(tx, Number(p.sitzung_id));
  await tx`update tco.vs_teilnehmer set status = ${status} where id = ${tid}`;
  await beruehren(tx, Number(p.sitzung_id), wer);
}

/** alle noch offenen Teilnehmer auf einen Status setzen (z. B. „alle anwesend“) */
export async function teilnahmeAlle(tx: Db, id: number, status: Teilnahme, wer: string) {
  await sitzungFuerAenderung(tx, id);
  await tx`update tco.vs_teilnehmer set status = ${status} where sitzung_id = ${id} and status = 'OFFEN'`;
  await beruehren(tx, id, wer);
}

export async function gastAnlegen(tx: Db, id: number, g: { name: string; rolle?: string | null; status?: Teilnahme }, wer: string) {
  await sitzungFuerAenderung(tx, id);
  const [r] = await tx`insert into tco.vs_teilnehmer (sitzung_id, name, rolle, art, status) values (${id}, ${g.name.trim()}, ${leer(g.rolle)}, 'GAST', ${g.status ?? 'ANWESEND'}) returning id`;
  await beruehren(tx, id, wer);
  return Number(r.id);
}

export async function teilnehmerLoeschen(tx: Db, tid: number, wer: string) {
  const [p] = await tx`select sitzung_id from tco.vs_teilnehmer where id = ${tid}`;
  if (!p) throw new BusinessError('Teilnehmer nicht gefunden.', 404);
  await sitzungFuerAenderung(tx, Number(p.sitzung_id));
  await tx`delete from tco.vs_teilnehmer where id = ${tid}`;
  await beruehren(tx, Number(p.sitzung_id), wer);
}

// ---------------------------------------------------------------- Tagesordnung

export interface TopEingabe { titel: string; verantwortlich?: string | null; text?: string | null; status?: Top['status'] }

export async function topAnlegen(tx: Db, id: number, t: TopEingabe, wer: string): Promise<number> {
  await sitzungFuerAenderung(tx, id);
  // vor „Verschiedenes“ einordnen, wenn es der letzte Punkt ist
  const [letzt] = await tx`select id, pos, titel from tco.vs_tops where sitzung_id = ${id} order by pos desc, id desc limit 1`;
  const vorVerschiedenes = letzt && /^verschiedenes$/i.test(String(letzt.titel).trim()) && !/^verschiedenes$/i.test(t.titel.trim());
  const pos = vorVerschiedenes ? Number(letzt.pos) : letzt ? Number(letzt.pos) + 1 : 0;
  if (vorVerschiedenes) await tx`update tco.vs_tops set pos = pos + 1 where id = ${letzt.id}`;
  const [r] = await tx`insert into tco.vs_tops (sitzung_id, pos, titel, verantwortlich, text, status)
                       values (${id}, ${pos}, ${t.titel.trim()}, ${await verantwortlicheNormal(tx, t.verantwortlich)}, ${leer(t.text)}, ${t.status ?? 'OFFEN'}) returning id`;
  await beruehren(tx, id, wer);
  return Number(r.id);
}

export async function topAendern(tx: Db, topId: number, t: TopEingabe, wer: string) {
  const sid = await sitzungZuTop(tx, topId);
  await sitzungFuerAenderung(tx, sid);
  await tx`update tco.vs_tops set titel = ${t.titel.trim()}, verantwortlich = ${await verantwortlicheNormal(tx, t.verantwortlich)}, text = ${leer(t.text)}, status = ${t.status ?? 'OFFEN'} where id = ${topId}`;
  await beruehren(tx, sid, wer);
}

export async function topLoeschen(tx: Db, topId: number, wer: string) {
  const sid = await sitzungZuTop(tx, topId);
  await sitzungFuerAenderung(tx, sid);
  await tx`delete from tco.vs_tops where id = ${topId}`;
  await beruehren(tx, sid, wer);
}

/** Reihenfolge der Tagesordnungspunkte (alle Ids der Sitzung in der neuen Reihenfolge) */
export async function topsOrdnen(tx: Db, id: number, ids: number[], wer: string) {
  await sitzungFuerAenderung(tx, id);
  const vorhanden = (await tx`select id from tco.vs_tops where sitzung_id = ${id}`).map((r) => Number(r.id));
  if (vorhanden.length !== ids.length || !vorhanden.every((x) => ids.includes(x))) throw new BusinessError('Die Tagesordnung hat sich inzwischen geändert – bitte neu laden.');
  for (let i = 0; i < ids.length; i++) await tx`update tco.vs_tops set pos = ${i} where id = ${ids[i]}`;
  await beruehren(tx, id, wer);
}

// ---------------------------------------------------------------- Einträge (Beschluss, Aufgabe, Info)

export interface EintragEingabe {
  art: 'BESCHLUSS' | 'AUFGABE' | 'INFO'; text: string;
  ja?: number | null; nein?: number | null; enthaltung?: number | null; ergebnis?: Ergebnis | null;
  verantwortlich?: string | null; faellig?: string | null; erledigt?: boolean;
}

function eintragWerte(e: EintragEingabe) {
  const b = e.art === 'BESCHLUSS', a = e.art === 'AUFGABE';
  return {
    ja: b ? e.ja ?? null : null, nein: b ? e.nein ?? null : null, enthaltung: b ? e.enthaltung ?? null : null,
    ergebnis: b ? e.ergebnis ?? ergebnisAus(e.ja, e.nein) : null,
    verantwortlich: a ? leer(e.verantwortlich) : null, faellig: a ? e.faellig || null : null,
  };
}

export async function eintragAnlegen(tx: Db, topId: number, e: EintragEingabe, wer: string, o: { erledigtVon?: string } = {}): Promise<number> {
  const sid = await sitzungZuTop(tx, topId);
  const s = await sitzungFuerAenderung(tx, sid);
  const w = eintragWerte(e);
  w.verantwortlich = await verantwortlicheNormal(tx, w.verantwortlich);
  const nr = e.art === 'BESCHLUSS' ? await naechsteBeschlussNr(tx, s.jahr) : null;
  const [p] = await tx`select coalesce(max(pos), -1) + 1 as p from tco.vs_eintraege where top_id = ${topId}`;
  const [r] = await tx`
    insert into tco.vs_eintraege (top_id, pos, art, text, nr_jahr, nr_lfd, ja, nein, enthaltung, ergebnis, verantwortlich, faellig, erledigt_am, erledigt_von)
    values (${topId}, ${Number(p.p)}, ${e.art}, ${e.text.trim()}, ${nr ? s.jahr : null}, ${nr}, ${w.ja}, ${w.nein}, ${w.enthaltung}, ${w.ergebnis},
            ${w.verantwortlich}, ${w.faellig}, ${e.art === 'AUFGABE' && e.erledigt ? new Date() : null}, ${e.art === 'AUFGABE' && e.erledigt ? o.erledigtVon ?? wer : null})
    returning id`;
  await beruehren(tx, sid, wer);
  return Number(r.id);
}

async function eintragSitzung(tx: Db, eid: number) {
  const [x] = await tx`select x.art, t.sitzung_id from tco.vs_eintraege x join tco.vs_tops t on t.id = x.top_id where x.id = ${eid}`;
  if (!x) throw new BusinessError('Den Eintrag gibt es nicht (mehr).', 404);
  return { art: x.art as EintragEingabe['art'], sid: Number(x.sitzung_id) };
}

export async function eintragAendern(tx: Db, eid: number, e: EintragEingabe, wer: string) {
  const alt = await eintragSitzung(tx, eid);
  await sitzungFuerAenderung(tx, alt.sid);
  if ((alt.art === 'BESCHLUSS') !== (e.art === 'BESCHLUSS')) {
    throw new BusinessError('Ein Beschluss behält seine Nummer – aus einem Beschluss wird kein anderer Eintrag und umgekehrt. Bitte löschen und neu anlegen.');
  }
  const w = eintragWerte(e);
  w.verantwortlich = await verantwortlicheNormal(tx, w.verantwortlich);
  await tx`update tco.vs_eintraege set art = ${e.art}, text = ${e.text.trim()}, ja = ${w.ja}, nein = ${w.nein}, enthaltung = ${w.enthaltung},
             ergebnis = ${w.ergebnis}, verantwortlich = ${w.verantwortlich}, faellig = ${w.faellig} where id = ${eid}`;
  await beruehren(tx, alt.sid, wer);
}

export async function eintragLoeschen(tx: Db, eid: number, wer: string) {
  const alt = await eintragSitzung(tx, eid);
  await sitzungFuerAenderung(tx, alt.sid);
  await tx`delete from tco.vs_eintraege where id = ${eid}`;
  await beruehren(tx, alt.sid, wer);
}

/** Aufgabe erledigt / wieder offen – geht auch nach der Freigabe des Protokolls */
export async function aufgabeErledigt(tx: Db, eid: number, erledigt: boolean, wer: string) {
  const alt = await eintragSitzung(tx, eid);
  if (alt.art !== 'AUFGABE') throw new BusinessError('Nur Aufgaben lassen sich abhaken.');
  await tx`update tco.vs_eintraege set erledigt_am = ${erledigt ? new Date() : null}, erledigt_von = ${erledigt ? wer : null} where id = ${eid}`;
}

// ---------------------------------------------------------------- Anlagen

export async function anlageAnlegen(tx: Db, id: number, a: { top_id?: number | null; dateiname: string; mime: string; inhalt: Buffer }, wer: string, o: { auchFreigegeben?: boolean } = {}) {
  await sitzungFuerAenderung(tx, id, o);
  if (a.top_id) {
    const [t] = await tx`select 1 from tco.vs_tops where id = ${a.top_id} and sitzung_id = ${id}`;
    if (!t) throw new BusinessError('Der Tagesordnungspunkt gehört nicht zu dieser Sitzung.');
  }
  if (a.inhalt.length > ANLAGE_MAX) throw new BusinessError(`„${a.dateiname}“ ist zu groß (höchstens ${ANLAGE_MAX / 1024 / 1024} MB je Datei).`);
  const [s] = await tx`select coalesce(sum(groesse), 0)::bigint as g from tco.vs_anlagen where sitzung_id = ${id}`;
  if (Number(s.g) + a.inhalt.length > ANLAGEN_SITZUNG_MAX) throw new BusinessError(`Die Anlagen dieser Sitzung wären zusammen größer als ${ANLAGEN_SITZUNG_MAX / 1024 / 1024} MB.`);
  const name = a.dateiname.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200);
  const [r] = await tx`insert into tco.vs_anlagen (sitzung_id, top_id, dateiname, mime, groesse, inhalt, erstellt_von)
                       values (${id}, ${a.top_id ?? null}, ${name}, ${a.mime}, ${a.inhalt.length}, ${a.inhalt}, ${wer}) returning id`;
  await beruehren(tx, id, wer);
  return Number(r.id);
}

/** Verknüpfung (URL) als Anlage – zur Sitzung oder zu einem Tagesordnungspunkt; Bezeichnung leer = Rechnername der Adresse */
export async function linkAnlegen(tx: Db, id: number, a: { top_id?: number | null; url: string; bezeichnung?: string | null }, wer: string) {
  await sitzungFuerAenderung(tx, id);
  if (a.top_id) {
    const [t] = await tx`select 1 from tco.vs_tops where id = ${a.top_id} and sitzung_id = ${id}`;
    if (!t) throw new BusinessError('Der Tagesordnungspunkt gehört nicht zu dieser Sitzung.');
  }
  const url = linkPruefen(a.url);
  if (!url) throw new BusinessError('Bitte eine vollständige Web-Adresse angeben, z. B. https://www.tc-oberthal.de/…');
  const name = (a.bezeichnung ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || new URL(url).hostname.replace(/^www\./, '');
  const [r] = await tx`insert into tco.vs_anlagen (sitzung_id, top_id, dateiname, mime, groesse, url, erstellt_von)
                       values (${id}, ${a.top_id ?? null}, ${name}, 'text/uri-list', 0, ${url}, ${wer}) returning id`;
  await beruehren(tx, id, wer);
  return Number(r.id);
}

export async function anlageLoeschen(tx: Db, id: number, aid: number, wer: string) {
  await sitzungFuerAenderung(tx, id);
  const r = await tx`delete from tco.vs_anlagen where id = ${aid} and sitzung_id = ${id} returning id`;
  if (!r.length) throw new BusinessError('Die Anlage gibt es nicht (mehr).', 404);
  await beruehren(tx, id, wer);
}

// ---------------------------------------------------------------- Import alter Protokolle (Markdown)

export interface ImportDatei { name: string; inhalt: Buffer }
export interface ImportZeile {
  datei: string; datum: string | null; titel: string; tops: number; beschluesse: number; aufgaben: number;
  anlagen_gefunden: number; anlagen_fehlen: string[]; teilnehmer: number; zugeordnet: number; unklar: string[];
  veranstaltung: { id: number; titel: string } | null; status: 'BEREIT' | 'PRUEFEN' | 'DUPLIKAT' | 'FEHLER'; hinweise: string[];
  /** nach dem Übernehmen */
  sitzung_id?: number;
}

const istMd = (n: string) => /\.(md|markdown|txt)$/i.test(n);
const basisname = (n: string) => n.split(/[\\/]/).pop() ?? n;

/**
 * Markdown-Protokolle prüfen bzw. übernehmen. Übernommen werden nur Dateien mit Datum und ohne Duplikat (gleiches Datum
 * wie eine vorhandene Sitzung oder eine andere Datei dieses Imports). Anlagen werden in den übrigen Dateien (auch aus dem
 * ZIP) am Dateinamen gesucht; die Markdown-Datei selbst wird immer als Anlage abgelegt.
 */
export async function importAusfuehren(tx: Db, dateien: ImportDatei[], o: { schreiben: boolean; veranstaltung: boolean; freigeben: boolean }, wer: string, lesen: (inhalt: string, name: string) => MdProtokoll) {
  const md = dateien.filter((d) => istMd(d.name)).sort((a, b) => a.name.localeCompare(b.name));
  const andere = new Map(dateien.filter((d) => !istMd(d.name)).map((d) => [basisname(d.name).toLowerCase(), d]));
  if (!md.length) throw new BusinessError('Keine Markdown-Datei (.md) gefunden.');
  const cfg = await cfgLesen(tx);
  const vs = await vorstandLesen(tx, cfg.gruppe_id);
  const gelesen = md.map((d) => ({ d, p: lesen(d.inhalt.toString('utf8'), basisname(d.name)) }))
    .sort((a, b) => (a.p.datum ?? '9999').localeCompare(b.p.datum ?? '9999') || a.d.name.localeCompare(b.d.name));
  const zeilen: ImportZeile[] = [];
  const gesehen = new Set<string>();
  for (const { d, p } of gelesen) {
    const z = mdZaehlen(p);
    const namen = [...p.anwesend, ...p.entschuldigt];
    const zu = namen.map((n) => personZuordnen(n, vs));
    const unklar = namen.filter((_, i) => !zu[i]);
    const hinweise = [...p.hinweise];
    let status: ImportZeile['status'] = 'BEREIT';
    let veranstaltung: ImportZeile['veranstaltung'] = null;
    if (!p.datum) status = 'FEHLER';
    else {
      const [dup] = await tx`select s.id, s.jahr, s.lfd from tco.vs_sitzungen s left join tco.kal_events e on e.id = s.event_id
                              where s.art = ${p.art} and coalesce((e.beginn at time zone 'Europe/Berlin')::date, s.datum) = ${p.datum}::date limit 1`;
      if (dup) { status = 'DUPLIKAT'; hinweise.push(`Sitzung ${sitzungNr(Number(dup.jahr), Number(dup.lfd))} am selben Tag ist schon vorhanden`); }
      else if (gesehen.has(`${p.datum}|${p.art}`)) { status = 'DUPLIKAT'; hinweise.push('Eine andere Datei dieses Imports hat dasselbe Datum'); }
      const [ev] = await tx`select e.id, e.titel from tco.kal_events e
                             where (e.beginn at time zone 'Europe/Berlin')::date = ${p.datum ?? null}::date
                               and (e.kategorie = 'SITZUNG' or e.titel ilike '%vorstand%')
                               and not exists (select 1 from tco.vs_sitzungen s where s.event_id = e.id)
                             order by (e.kategorie = 'SITZUNG') desc, e.id limit 1`;
      if (ev) veranstaltung = { id: Number(ev.id), titel: ev.titel as string };
    }
    const fehlen = z.anlagen.filter((n) => !andere.has(n.toLowerCase()));
    if (status === 'BEREIT' && (fehlen.length || unklar.length)) status = 'PRUEFEN';
    if (fehlen.length) hinweise.push(`${fehlen.length} Anlage${fehlen.length === 1 ? '' : 'n'} nicht gefunden`);
    if (unklar.length) hinweise.push(`${unklar.length} Name${unklar.length === 1 ? '' : 'n'} keinem Vorstandsmitglied zugeordnet – als Gast übernommen`);
    const titel = p.titel ?? `${ART_TEXT[p.art]}${p.datum ? ` ${dat(p.datum)}` : ''}`;
    const zeile: ImportZeile = {
      datei: d.name, datum: p.datum, titel, tops: z.tops, beschluesse: z.beschluesse, aufgaben: z.aufgaben,
      anlagen_gefunden: z.anlagen.length - fehlen.length, anlagen_fehlen: fehlen, teilnehmer: namen.length + p.gaeste.length,
      zugeordnet: zu.filter(Boolean).length, unklar, veranstaltung, status, hinweise,
    };
    zeilen.push(zeile);
    if (p.datum) gesehen.add(`${p.datum}|${p.art}`);
    if (!o.schreiben || status === 'FEHLER' || status === 'DUPLIKAT') continue;

    // ---- übernehmen
    const datum = p.datum!;
    const jahr = Number(datum.slice(0, 4));
    const lfd = await naechsteLfd(tx, jahr);
    const eventId = veranstaltung?.id ?? (o.veranstaltung ? await eventFuerSitzung(tx, { titel, datum, beginn: p.beginn, ende: p.ende, ort: p.ort }, wer, true) : null);
    const [s] = await tx`
      insert into tco.vs_sitzungen (jahr, lfd, titel, art, datum, beginn, ende, ort, event_id, status, leitung, protokoll_von, bemerkung, importiert,
                                    freigegeben_am, freigegeben_von, erstellt_von, geaendert_von)
      values (${jahr}, ${lfd}, ${titel}, ${p.art}, ${datum}, ${p.beginn}, ${p.ende}, ${p.ort}, ${eventId}, ${o.freigeben ? 'FREIGEGEBEN' : 'ENTWURF'},
              ${p.leitung}, ${p.protokoll}, ${p.bemerkung || null}, true, ${o.freigeben ? new Date() : null}, ${o.freigeben ? wer : null}, ${wer}, ${wer})
      returning id`;
    const sid = Number(s.id);
    zeile.sitzung_id = sid;
    const zugeordnet = new Set<string>();
    const teilnehmer = [
      ...p.anwesend.map((n) => ({ n, status: 'ANWESEND' as Teilnahme })), ...p.entschuldigt.map((n) => ({ n, status: 'ENTSCHULDIGT' as Teilnahme })),
    ];
    for (const t of teilnehmer) {
      const m = personZuordnen(t.n, vs);
      if (m && !zugeordnet.has(m.adrnr)) {
        zugeordnet.add(m.adrnr);
        const v = vs.find((x) => x.adrnr === m.adrnr)!;
        await tx`insert into tco.vs_teilnehmer (sitzung_id, adrnr, name, rolle, art, status) values (${sid}, ${v.adrnr}, ${v.name}, ${v.rolle}, 'VORSTAND', ${t.status})`;
      } else if (!m) {
        await tx`insert into tco.vs_teilnehmer (sitzung_id, name, art, status) values (${sid}, ${t.n.replace(/\s*\(.*?\)\s*/g, ' ').trim()}, 'GAST', ${t.status})`;
      }
    }
    for (const g of p.gaeste) await tx`insert into tco.vs_teilnehmer (sitzung_id, name, art, status) values (${sid}, ${g}, 'GAST', 'ANWESEND')`;
    const anlage = async (name: string, topId: number | null) => {
      const f = andere.get(name.toLowerCase());
      if (!f) return;
      await tx`insert into tco.vs_anlagen (sitzung_id, top_id, dateiname, mime, groesse, inhalt, erstellt_von)
               values (${sid}, ${topId}, ${basisname(f.name)}, ${dateityp(f.name, null, f.inhalt)}, ${f.inhalt.length}, ${f.inhalt}, ${wer})`;
    };
    for (const a of p.anlagen) await anlage(a, null);
    let pos = 0;
    for (const t of p.tops) {
      const [tr] = await tx`insert into tco.vs_tops (sitzung_id, pos, titel, verantwortlich, text, status)
                            values (${sid}, ${pos++}, ${t.titel}, ${t.verantwortlich}, ${t.text || null}, 'ERLEDIGT') returning id`;
      const topId = Number(tr.id);
      let ep = 0;
      for (const e of t.eintraege) {
        const nr = e.art === 'BESCHLUSS' ? await naechsteBeschlussNr(tx, jahr) : null;
        const erl = e.art === 'AUFGABE' && e.erledigt;
        await tx`insert into tco.vs_eintraege (top_id, pos, art, text, nr_jahr, nr_lfd, ja, nein, enthaltung, ergebnis, verantwortlich, faellig, erledigt_am, erledigt_von)
                 values (${topId}, ${ep++}, ${e.art}, ${e.text}, ${nr ? jahr : null}, ${nr}, ${e.ja ?? null}, ${e.nein ?? null}, ${e.enthaltung ?? null},
                         ${e.ergebnis ?? null}, ${e.verantwortlich ?? null}, ${e.faellig ?? null}, ${erl ? new Date() : null}, ${erl ? 'Import' : null})`;
      }
      for (const a of t.anlagen) await anlage(a, topId);
    }
    await tx`insert into tco.vs_anlagen (sitzung_id, dateiname, mime, groesse, inhalt, erstellt_von)
             values (${sid}, ${basisname(d.name)}, 'text/markdown', ${d.inhalt.length}, ${d.inhalt}, ${wer})`;
  }
  return zeilen;
}

// ---------------------------------------------------------------- Arbeitsvorrat

/** offene Aufgaben (überfällig oder in 7 Tagen fällig) und Protokolle, die auf die Freigabe warten */
export async function aufgaben(db: Db, o: { aufgaben: boolean; freigabe: boolean }): Promise<Aufgabe[]> {
  const out: Aufgabe[] = [];
  if (o.aufgaben) {
    const h = heute();
    for (const a of (await aufgabenLesen(db, { offen: true })).filter((x) => x.stand === 'UEBERFAELLIG' || x.stand === 'BALD')) {
      out.push({
        key: `VS_AUFGABE:${a.id}`, bereich: 'Vorstand', icon: 'task', state: a.stand === 'UEBERFAELLIG' ? 'Negative' : 'Critical',
        titel: `${a.stand === 'UEBERFAELLIG' ? 'Überfällig' : 'Fällig'}: ${a.text.length > 80 ? `${a.text.slice(0, 79)}…` : a.text}`,
        text: `${a.verantwortlich ? `${a.verantwortlich} · ` : ''}bis ${dat(a.faellig)} · aus ${a.sitzung_nr} (${a.top})`,
        datum: a.faellig ?? h, pfad: `/tco/vorstand?sitzung=${a.sitzung_id}`,
        erledigen: { text: 'erledigt', url: `/vorstand/aufgaben/${a.id}/erledigt`, body: { erledigt: true } },
      });
    }
  }
  if (o.freigabe) {
    const rows = await db`select s.id, s.jahr, s.lfd, s.titel, s.datum, s.geaendert_am from tco.vs_sitzungen s where s.status = 'ENTWURF' order by s.datum`;
    for (const r of rows) {
      out.push({
        key: `VS_FREIGABE:${r.id}`, bereich: 'Vorstand', icon: 'approvals', state: 'Information',
        titel: `Protokoll freigeben: ${sitzungNr(Number(r.jahr), Number(r.lfd))}`, text: `${r.titel} vom ${dat(r.datum as string)} wartet auf die Freigabe.`,
        datum: r.datum as string, pfad: `/tco/vorstand?sitzung=${r.id}`,
      });
    }
  }
  return out;
}
