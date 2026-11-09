import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import { condense } from '../format.js';

/**
 * Mitgliedergruppen: Mitglieder werden nach Kategorien gruppiert (z. B. Spielbetrieb → Mannschaftsspieler → Herren 40,
 * reine Hallennutzer, Mitglieder ohne Teilnahme am Spielbetrieb). Die Gruppen bilden einen Baum (parent_id),
 * ein Mitglied kann mehreren Gruppen angehören. Es sind dieselben Gruppen, auf die der Vereinskalender
 * Veranstaltungen einschränkt (Mannschaftsplanung) – wer in einer Untergruppe ist, gehört auch zu den Gruppen darüber.
 */

export interface GruppenMitglied { adrnr: string; name: string; mitglnrn: string; rolle: string | null; ausgetreten: boolean }
export interface Gruppe {
  id: number; parent_id: number | null; name: string; beschreibung: string | null; aktiv: boolean;
  /** Namen von der obersten Ebene bis zur Gruppe, z. B. „Spielbetrieb › Mannschaften › Herren 40“ */
  pfad: string;
  /** 0 = oberste Ebene */
  ebene: number;
  /** direkt zugeordnete Mitglieder */
  mitglieder: GruppenMitglied[];
  /** Personen in der Gruppe einschließlich aller Untergruppen (jede Person einmal) */
  gesamt: number;
}

export const PFAD_TRENNER = ' › ';

/** Mitglied zur Aufnahme in eine Gruppe; Geschlecht, Jahrgang und Alter (heute, volle Jahre) für die Filter des Dialogs */
export interface AufnahmeMitglied { adrnr: string; name: string; geschlecht: 'M' | 'W' | ''; jahrgang: number | null; alter: number | null }

/** Aktive Mitglieder zur Auswahl (mit Eintritt, ohne Austritt – wie „Aktive Mitglieder“ der Mitgliederliste); ohne Geburtsdatum bleiben Jahrgang und Alter leer */
export async function aufnahmeMitglieder(db: Db): Promise<AufnahmeMitglied[]> {
  const r = await db`select adrnr, vorname, nachname, geschlecht,
                            extract(year from geburtsdatum)::int as jahrgang,
                            extract(year from age(current_date, geburtsdatum))::int as lebensalter
                       from tco.mitglieder where eintritt is not null and austritt is null order by nachname, vorname`;
  return r.map((x) => {
    const g = String(x.geschlecht ?? '').trim();
    return {
      adrnr: x.adrnr as string, name: condense(`${x.nachname ?? ''}, ${x.vorname ?? ''}`),
      geschlecht: g === '1' ? 'M' : g === '2' ? 'W' : '',
      jahrgang: x.jahrgang == null ? null : Number(x.jahrgang), alter: x.lebensalter == null ? null : Number(x.lebensalter),
    };
  });
}

/** Alle Gruppen in Baumreihenfolge (Eltern vor Kindern, je Ebene nach Name) mit den direkt zugeordneten Mitgliedern */
export async function gruppenLesen(db: Db): Promise<Gruppe[]> {
  const g = await db`select id, parent_id, name, beschreibung, aktiv from tco.kal_gruppen`;
  const m = await db`select gm.gruppe_id, gm.adrnr, gm.rolle, coalesce(mi.mitglnrn, '') as mitglnrn,
                            coalesce(nullif(trim(concat_ws(' ', mi.vorname, mi.nachname)), ''), gm.adrnr) as name,
                            (mi.austritt is not null and mi.austritt < current_date) as ausgetreten
                       from tco.kal_gruppe_mitglieder gm left join tco.mitglieder mi on mi.adrnr = gm.adrnr
                      order by lower(mi.nachname), lower(mi.vorname), gm.adrnr`;
  const je = new Map<number, GruppenMitglied[]>();
  for (const y of m) {
    const l = je.get(Number(y.gruppe_id)) ?? [];
    l.push({ adrnr: y.adrnr as string, name: y.name as string, mitglnrn: String(y.mitglnrn ?? '').trim(), rolle: (y.rolle as string | null) ?? null, ausgetreten: !!y.ausgetreten });
    je.set(Number(y.gruppe_id), l);
  }
  const alle = g.map((x) => ({
    id: Number(x.id), parent_id: x.parent_id == null ? null : Number(x.parent_id), name: x.name as string,
    beschreibung: (x.beschreibung as string | null) ?? null, aktiv: !!x.aktiv,
  }));
  const ids = new Set(alle.map((x) => x.id));
  const kinder = new Map<number | null, typeof alle>();
  for (const x of alle) {
    // verwaiste Gruppen (Elterngruppe fehlt) erscheinen auf der obersten Ebene
    const p = x.parent_id != null && ids.has(x.parent_id) ? x.parent_id : null;
    kinder.set(p, [...(kinder.get(p) ?? []), x]);
  }
  for (const l of kinder.values()) l.sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true, sensitivity: 'base' }) || a.id - b.id);
  const out: Gruppe[] = [];
  const gesehen = new Set<number>();
  const lauf = (p: number | null, pfad: string, ebene: number): Set<string> => {
    const personen = new Set<string>();
    for (const x of kinder.get(p) ?? []) {
      if (gesehen.has(x.id)) continue;
      gesehen.add(x.id);
      const eintrag: Gruppe = { ...x, pfad: pfad ? `${pfad}${PFAD_TRENNER}${x.name}` : x.name, ebene, mitglieder: je.get(x.id) ?? [], gesamt: 0 };
      out.push(eintrag);
      const eigene = new Set(eintrag.mitglieder.map((y) => y.adrnr));
      for (const a of lauf(x.id, eintrag.pfad, ebene + 1)) eigene.add(a);
      eintrag.gesamt = eigene.size;
      for (const a of eigene) personen.add(a);
    }
    return personen;
  };
  lauf(null, '', 0);
  return out;
}

/** Gruppen-IDs samt aller Untergruppen */
export async function mitUntergruppen(db: Db, ids: number[]): Promise<number[]> {
  if (!ids.length) return [];
  return (await db`with recursive g as (
                     select id from tco.kal_gruppen where id = any(${ids})
                     union
                     select k.id from tco.kal_gruppen k join g on k.parent_id = g.id)
                   select id from g`).map((r) => Number(r.id));
}

/** Gruppen eines Mitglieds: die direkt zugeordneten und alle Gruppen darüber */
export async function gruppenMitVorfahren(db: Db, adrnr: string | null): Promise<number[]> {
  if (!adrnr) return [];
  return (await db`with recursive g as (
                     select k.id, k.parent_id from tco.kal_gruppe_mitglieder gm join tco.kal_gruppen k on k.id = gm.gruppe_id where gm.adrnr = ${adrnr}
                     union
                     select p.id, p.parent_id from tco.kal_gruppen p join g on g.parent_id = p.id)
                   select id from g`).map((r) => Number(r.id));
}

/** direkte Zuordnungen eines Mitglieds */
export async function mitgliedGruppen(db: Db, adrnr: string): Promise<{ id: number; rolle: string | null }[]> {
  return (await db`select gruppe_id, rolle from tco.kal_gruppe_mitglieder where adrnr = ${adrnr} order by gruppe_id`)
    .map((r) => ({ id: Number(r.gruppe_id), rolle: (r.rolle as string | null) ?? null }));
}

/** Adressnummern aller Personen einer Gruppe einschließlich ihrer Untergruppen */
export async function personenDerGruppe(db: Db, id: number): Promise<Set<string>> {
  const ids = await mitUntergruppen(db, [id]);
  if (!ids.length) return new Set();
  return new Set((await db`select distinct adrnr from tco.kal_gruppe_mitglieder where gruppe_id = any(${ids})`).map((r) => r.adrnr as string));
}

async function gruppeHolen(tx: Db, id: number) {
  const [g] = await tx`select id, parent_id, name from tco.kal_gruppen where id = ${id}`;
  if (!g) throw new BusinessError('Gruppe nicht gefunden.', 404);
  return { id: Number(g.id), parent_id: g.parent_id == null ? null : Number(g.parent_id), name: g.name as string };
}

/**
 * Gruppe anlegen oder ändern. parent_id: undefined = übergeordnete Gruppe nicht ändern (bei Neuanlage: oberste Ebene),
 * null = oberste Ebene. Eine Gruppe kann nicht unter sich selbst oder eine ihrer Untergruppen gehängt werden.
 */
export async function gruppeSpeichern(tx: Db, id: number | null, d: { name: string; beschreibung?: string | null; aktiv: boolean; parent_id?: number | null }) {
  const name = condense(d.name);
  if (!name) throw new BusinessError('Bitte einen Namen angeben.');
  const alt = id ? await gruppeHolen(tx, id) : null;
  const parent = d.parent_id === undefined ? (alt?.parent_id ?? null) : d.parent_id;
  if (parent != null) {
    const p = await gruppeHolen(tx, parent).catch(() => null);
    if (!p) throw new BusinessError('Die übergeordnete Gruppe gibt es nicht.');
    if (id && (await mitUntergruppen(tx, [id])).includes(parent)) {
      throw new BusinessError(`„${name}“ kann nicht unter sich selbst oder eine eigene Untergruppe gehängt werden.`);
    }
  }
  const [dup] = await tx`select id from tco.kal_gruppen
                          where lower(name) = lower(${name}) and coalesce(parent_id, 0) = ${parent ?? 0} and id <> ${id ?? 0}`;
  if (dup) throw new BusinessError(`Die Gruppe „${name}“ gibt es ${parent == null ? '' : 'auf dieser Ebene '}bereits.`);
  if (id) {
    await tx`update tco.kal_gruppen set name = ${name}, beschreibung = ${d.beschreibung?.trim() || null}, aktiv = ${d.aktiv}, parent_id = ${parent} where id = ${id}`;
    // verschoben: Mitglieder der Gruppe (und ihrer Untergruppen) stehen nicht noch einmal in den neuen Gruppen darüber
    if (parent !== (alt?.parent_id ?? null)) await hierarchieBereinigen(tx);
    return id;
  }
  const [n] = await tx`insert into tco.kal_gruppen (name, beschreibung, aktiv, parent_id) values (${name}, ${d.beschreibung?.trim() || null}, ${d.aktiv}, ${parent}) returning id`;
  return Number(n.id);
}

export async function gruppeLoeschen(tx: Db, id: number) {
  const g = await gruppeHolen(tx, id);
  const [k] = await tx`select count(*)::int as n from tco.kal_gruppen where parent_id = ${id}`;
  if (Number(k.n)) throw new BusinessError(`„${g.name}“ hat noch ${k.n} Untergruppe${Number(k.n) === 1 ? '' : 'n'} – bitte zuerst diese löschen oder verschieben.`);
  const [n] = await tx`select count(*)::int as n from tco.kal_events where ${id} = any(gruppen) and beginn >= now()`;
  if (Number(n.n)) throw new BusinessError(`Die Gruppe ist noch ${n.n} kommenden Veranstaltung(en) zugeordnet.`);
  await tx`delete from tco.kal_gruppen where id = ${id}`;
  return g.name;
}

// ---------------------------------------------------------------- Hierarchieregel
// Wer in einer Untergruppe ist, gehört zwingend auch zu allen Gruppen darüber. Deshalb wird ein Mitglied entlang
// einer Linie (Gruppe – Untergruppe – …) nur einmal geführt, und zwar in der untersten Gruppe. In parallelen Gruppen
// (z. B. Herren 30 und Herren 40) kann es mehrfach stehen.

/** Gruppen über einer Gruppe (ohne sie selbst) */
async function vorfahren(db: Db, id: number): Promise<number[]> {
  return (await db`with recursive g as (
                     select id, parent_id from tco.kal_gruppen where id = ${id}
                     union
                     select p.id, p.parent_id from tco.kal_gruppen p join g on g.parent_id = p.id)
                   select id from g where id <> ${id}`).map((r) => Number(r.id));
}

/** Mitglieder, die schon über eine Untergruppe zur Gruppe gehören: Adressnummer → Name der Untergruppe */
async function ueberUntergruppe(db: Db, gruppeId: number, adrnrs: string[]): Promise<Map<string, string>> {
  const unter = (await mitUntergruppen(db, [gruppeId])).filter((x) => x !== gruppeId);
  if (!unter.length || !adrnrs.length) return new Map();
  const r = await db`select gm.adrnr, k.name from tco.kal_gruppe_mitglieder gm join tco.kal_gruppen k on k.id = gm.gruppe_id
                      where gm.gruppe_id = any(${unter}) and gm.adrnr = any(${adrnrs}) order by k.name`;
  return new Map(r.map((x) => [x.adrnr as string, x.name as string]));
}

/** Zuordnungen in den Gruppen darüber entfernen (das Mitglied steht jetzt in der Untergruppe). Liefert die Zahl der Entfernten. */
async function ausUebergeordnetenEntfernen(tx: Db, gruppeId: number, adrnrs: string[]): Promise<number> {
  const ueber = await vorfahren(tx, gruppeId);
  if (!ueber.length || !adrnrs.length) return 0;
  return (await tx`delete from tco.kal_gruppe_mitglieder where gruppe_id = any(${ueber}) and adrnr = any(${adrnrs}) returning adrnr`).length;
}

/**
 * Alle Gruppen bereinigen: Zuordnungen entfernen, die es in einer Untergruppe noch einmal gibt
 * (nach dem Verschieben einer Gruppe; dieselbe Anweisung steht in Migration 040).
 */
export async function hierarchieBereinigen(tx: Db): Promise<number> {
  return (await tx`with recursive linie as (
                     select id as oben, id as unten from tco.kal_gruppen
                     union
                     select l.oben, k.id from tco.kal_gruppen k join linie l on k.parent_id = l.unten)
                   delete from tco.kal_gruppe_mitglieder gm
                    using linie l, tco.kal_gruppe_mitglieder u
                    where l.oben = gm.gruppe_id and l.unten <> l.oben and u.gruppe_id = l.unten and u.adrnr = gm.adrnr
                   returning gm.adrnr`).length;
}

/**
 * Mitglied einer Gruppe zuordnen bzw. seine Rolle ändern. Gehört es schon über eine Untergruppe dazu, wird es nicht
 * noch einmal aufgenommen; stand es bisher in einer Gruppe darüber, wandert es in die Untergruppe.
 * Liefert, aus wie vielen übergeordneten Gruppen es dabei entfernt wurde.
 */
export async function gruppenMitgliedSetzen(tx: Db, gruppeId: number, adrnr: string, rolle: string | null): Promise<number> {
  const g = await gruppeHolen(tx, gruppeId);
  const [m] = await tx`select 1 from tco.mitglieder where adrnr = ${adrnr}`;
  if (!m) throw new BusinessError('Mitglied nicht gefunden.');
  const [da] = await tx`select 1 from tco.kal_gruppe_mitglieder where gruppe_id = ${gruppeId} and adrnr = ${adrnr}`;
  if (!da) {
    const unter = (await ueberUntergruppe(tx, gruppeId, [adrnr])).get(adrnr);
    if (unter) throw new BusinessError(`Das Mitglied gehört über die Untergruppe „${unter}“ bereits zu „${g.name}“ und wird dort nicht noch einmal aufgenommen.`);
  }
  await tx`insert into tco.kal_gruppe_mitglieder (gruppe_id, adrnr, rolle) values (${gruppeId}, ${adrnr}, ${condense(rolle ?? '') || null})
           on conflict (gruppe_id, adrnr) do update set rolle = excluded.rolle`;
  return ausUebergeordnetenEntfernen(tx, gruppeId, [adrnr]);
}

/**
 * Mehrere Mitglieder aufnehmen; bereits zugeordnete behalten ihre Rolle. Wer über eine Untergruppe schon dazugehört,
 * wird übersprungen; wer in einer Gruppe darüber stand, wandert in diese Gruppe.
 */
export async function gruppenMitgliederAufnehmen(tx: Db, gruppeId: number, adrnrs: string[]): Promise<{ neu: number; ueberUntergruppe: number; ausUebergeordneter: number }> {
  await gruppeHolen(tx, gruppeId);
  const liste = [...new Set(adrnrs)];
  const vorhanden = new Set((await tx`select adrnr from tco.mitglieder where adrnr = any(${liste})`).map((r) => r.adrnr as string));
  const fehlt = liste.filter((a) => !vorhanden.has(a));
  if (fehlt.length) throw new BusinessError(`Mitglied nicht gefunden: ${fehlt.join(', ')}.`);
  const unter = await ueberUntergruppe(tx, gruppeId, liste);
  const rest = liste.filter((a) => !unter.has(a));
  let neu = 0;
  for (const a of rest) {
    const r = await tx`insert into tco.kal_gruppe_mitglieder (gruppe_id, adrnr) values (${gruppeId}, ${a}) on conflict do nothing returning adrnr`;
    neu += r.length;
  }
  return { neu, ueberUntergruppe: unter.size, ausUebergeordneter: await ausUebergeordnetenEntfernen(tx, gruppeId, rest) };
}

/**
 * Mitglied von einer Gruppe in eine andere verschieben (Ziehen im Baum); die Rolle wandert mit.
 * Steht es in der Zielgruppe schon, entfällt nur die bisherige Zuordnung. Liefert den Namen der Zielgruppe.
 */
export async function gruppenMitgliedVerschieben(tx: Db, von: number, nach: number, adrnr: string): Promise<string> {
  const ziel = await gruppeHolen(tx, nach);
  if (von === nach) return ziel.name;
  const [alt] = await tx`delete from tco.kal_gruppe_mitglieder where gruppe_id = ${von} and adrnr = ${adrnr} returning rolle`;
  if (!alt) throw new BusinessError('Das Mitglied ist der bisherigen Gruppe nicht mehr zugeordnet – bitte die Ansicht aktualisieren.');
  const [da] = await tx`select 1 from tco.kal_gruppe_mitglieder where gruppe_id = ${nach} and adrnr = ${adrnr}`;
  if (!da) await gruppenMitgliedSetzen(tx, nach, adrnr, (alt.rolle as string | null) ?? null);
  return ziel.name;
}

export async function gruppenMitgliedEntfernen(tx: Db, gruppeId: number, adrnr: string) {
  await tx`delete from tco.kal_gruppe_mitglieder where gruppe_id = ${gruppeId} and adrnr = ${adrnr}`;
}
