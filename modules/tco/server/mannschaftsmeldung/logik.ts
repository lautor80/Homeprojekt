/**
 * Mannschaftsmeldung / Anmeldematrix (Sport → Anmeldematrix, Mein Bereich → Mannschaftsmeldung).
 *
 * Der Sportwart legt je Saison eine Abfrage an und wählt die Mannschaften (Altersklassen) aus den Mitgliedergruppen.
 * Ist die Abfrage offen, gibt jedes Mitglied – auch für die Personen seiner Familie – je Mannschaft an:
 *   1 = fest teilnehmen · 2 = als Ersatz · 3 = nicht teilnehmen  (keine Angabe = noch offen)
 * Alle sehen alle Mannschaften der Abfrage. Bis zur Frist (einschließlich) und solange die Abfrage offen ist, lässt sich die
 * Angabe ändern. Die Anmeldematrix zeigt alle Personen mit Rückmeldung und alle Mitglieder der gewählten Gruppen.
 */
import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import { condense, heute } from '../format.js';
import { gruppenLesen, personenDerGruppe } from '../gruppen/logik.js';
import { familieLesen } from '../kalender/logik.js';

export type Wahl = 1 | 2 | 3;
export const WAHL_TEXT: Record<Wahl, string> = { 1: 'fest', 2: 'Ersatz', 3: 'nicht' };
export type AbfrageStatus = 'entwurf' | 'offen' | 'geschlossen';

export interface Abfrage { id: number; titel: string; saison: string; frist: string | null; hinweis: string; status: AbfrageStatus }
export interface Mannschaft { gruppe_id: number; name: string; pfad: string }

/** Zählung je Mannschaft: fest / Ersatz / nicht / ohne Angabe (aus den Zeilen der Matrix) */
export function zaehlen(mannschaften: { gruppe_id: number }[], zeilen: { wahl: Record<number, Wahl | undefined> }[]) {
  return mannschaften.map((m) => {
    const z = { gruppe_id: m.gruppe_id, fest: 0, ersatz: 0, nicht: 0, offen: 0 };
    for (const p of zeilen) {
      const w = p.wahl[m.gruppe_id];
      if (w === 1) z.fest++; else if (w === 2) z.ersatz++; else if (w === 3) z.nicht++; else z.offen++;
    }
    return z;
  });
}

/** kann noch geantwortet werden? offen und Frist nicht vorbei */
export const antwortMoeglich = (a: Pick<Abfrage, 'status' | 'frist'>, h = heute()) => a.status === 'offen' && (!a.frist || a.frist >= h);

const abfrageAus = (r: Record<string, unknown>): Abfrage => ({
  id: Number(r.id), titel: String(r.titel), saison: String(r.saison ?? ''), frist: (r.frist as string | null) ?? null, hinweis: String(r.hinweis ?? ''), status: r.status as AbfrageStatus,
});

async function mannschaftenLesen(db: Db, abfrageIds: number[]): Promise<Map<number, Mannschaft[]>> {
  const pfade = new Map((await gruppenLesen(db)).map((g) => [g.id, g]));
  const rows = await db`select abfrage_id, gruppe_id from tco.mm_mannschaften where abfrage_id = any(${abfrageIds}::int[]) order by abfrage_id, position, gruppe_id`;
  const out = new Map<number, Mannschaft[]>();
  for (const r of rows) {
    const g = pfade.get(Number(r.gruppe_id));
    if (!g) continue;
    out.set(Number(r.abfrage_id), [...(out.get(Number(r.abfrage_id)) ?? []), { gruppe_id: g.id, name: g.name, pfad: g.pfad }]);
  }
  return out;
}

// ---------------------------------------------------------------- Verwaltung (Sportwart)

export async function abfragenLesen(db: Db) {
  const rows = await db`
    select a.id, a.titel, a.saison, a.frist::text as frist, a.hinweis, a.status,
           (select count(*)::int from tco.mm_mannschaften m where m.abfrage_id = a.id) as mannschaften,
           (select count(distinct x.adrnr)::int from tco.mm_antworten x where x.abfrage_id = a.id) as personen
      from tco.mm_abfragen a order by a.id desc`;
  return rows.map((r) => ({ ...abfrageAus(r), mannschaften: Number(r.mannschaften), personen: Number(r.personen) }));
}

async function abfrage(db: Db, id: number): Promise<Abfrage> {
  const [r] = await db`select id, titel, saison, frist::text as frist, hinweis, status from tco.mm_abfragen where id = ${id}`;
  if (!r) throw new BusinessError('Abfrage nicht gefunden.', 404);
  return abfrageAus(r);
}

/** Gruppen zur Auswahl der Mannschaften; vorgeschlagen sind Gruppen ohne Untergruppen unterhalb einer „Mannschaft…“-Gruppe */
export async function gruppenAuswahl(db: Db) {
  const g = (await gruppenLesen(db)).filter((x) => x.aktiv);
  const eltern = new Set(g.map((x) => x.parent_id).filter((x): x is number => x != null));
  return g.map((x) => ({ id: x.id, name: x.name, pfad: x.pfad, ebene: x.ebene, regel: x.regel, blatt: !eltern.has(x.id), vorschlag: !eltern.has(x.id) && /mannschaft/i.test(x.pfad.split(' › ').slice(0, -1).join(' ')) }));
}

export interface AbfrageEingabe { titel: string; saison: string; frist: string | null; hinweis: string; status: AbfrageStatus; gruppen: number[] }

export async function abfrageSpeichern(tx: Db, id: number | null, b: AbfrageEingabe): Promise<{ id: number; text: string }> {
  const gruppen = [...new Set(b.gruppen)];
  if (b.status !== 'entwurf' && !gruppen.length) throw new BusinessError('Bitte mindestens eine Mannschaft auswählen.');
  const da = await tx`select id from tco.kal_gruppen where id = any(${gruppen}::int[])`;
  if (da.length !== gruppen.length) throw new BusinessError('Mindestens eine Gruppe gibt es nicht mehr – bitte die Auswahl aktualisieren.');
  let n = id;
  if (n == null) {
    const [r] = await tx`insert into tco.mm_abfragen (titel, saison, frist, hinweis, status) values (${condense(b.titel)}, ${condense(b.saison)}, ${b.frist}, ${b.hinweis.trim()}, ${b.status}) returning id`;
    n = Number(r.id);
  } else {
    const [r] = await tx`update tco.mm_abfragen set titel = ${condense(b.titel)}, saison = ${condense(b.saison)}, frist = ${b.frist}, hinweis = ${b.hinweis.trim()}, status = ${b.status}
                          where id = ${n} returning id`;
    if (!r) throw new BusinessError('Abfrage nicht gefunden.', 404);
  }
  // entfernte Mannschaften verlieren ihre Antworten (Kaskade), übrige behalten sie
  const [weg] = await tx`select count(*)::int as n from tco.mm_antworten where abfrage_id = ${n} and gruppe_id <> all(${gruppen}::int[])`;
  await tx`delete from tco.mm_mannschaften where abfrage_id = ${n} and gruppe_id <> all(${gruppen}::int[])`;
  for (const [i, g] of gruppen.entries()) {
    await tx`insert into tco.mm_mannschaften (abfrage_id, gruppe_id, position) values (${n}, ${g}, ${i + 1})
             on conflict (abfrage_id, gruppe_id) do update set position = excluded.position`;
  }
  const zusatz = weg.n ? ` ${weg.n} Angabe${weg.n === 1 ? '' : 'n'} zu entfernten Mannschaften gelöscht.` : '';
  return { id: n, text: `Abfrage „${condense(b.titel)}“ gesichert (${gruppen.length} Mannschaft${gruppen.length === 1 ? '' : 'en'}).${zusatz}` };
}

export async function abfrageLoeschen(tx: Db, id: number): Promise<string> {
  const [r] = await tx`delete from tco.mm_abfragen where id = ${id} returning titel`;
  if (!r) throw new BusinessError('Abfrage nicht gefunden.', 404);
  return `Abfrage „${r.titel}“ mit allen Angaben gelöscht.`;
}

export interface MatrixZeile {
  adrnr: string; name: string; geburtsjahr: number | null; geschlecht: string;
  /** Mitglied einer der gewählten Gruppen (sollte antworten) */
  inGruppe: boolean;
  wahl: Record<number, Wahl | undefined>;
  bemerkung: string;
  geaendert: string | null;
}

export async function matrixLesen(db: Db, id: number) {
  const a = await abfrage(db, id);
  const mannschaften = (await mannschaftenLesen(db, [id])).get(id) ?? [];
  // Mitglieder der gewählten Gruppen (samt Untergruppen) und alle mit Rückmeldung
  const inGruppe = new Set<string>();
  for (const m of mannschaften) for (const p of await personenDerGruppe(db, m.gruppe_id)) inGruppe.add(p);
  const antworten = await db`select adrnr, gruppe_id, wahl, geaendert_am::text as am from tco.mm_antworten where abfrage_id = ${id}`;
  const bem = new Map((await db`select adrnr, text from tco.mm_bemerkungen where abfrage_id = ${id}`).map((r) => [r.adrnr as string, r.text as string]));
  const alle = [...new Set([...inGruppe, ...antworten.map((x) => x.adrnr as string), ...bem.keys()])];
  const personen = await db`select adrnr, vorname, nachname, extract(year from geburtsdatum)::int as jahr, coalesce(geschlecht, '') as geschlecht,
                                   (austritt is null or austritt >= current_date) as aktiv
                              from tco.mitglieder where adrnr = any(${alle}::text[])`;
  const zeilen: MatrixZeile[] = personen
    .filter((p) => p.aktiv || antworten.some((x) => x.adrnr === p.adrnr))
    .map((p) => {
      const eigene = antworten.filter((x) => x.adrnr === p.adrnr);
      return {
        adrnr: p.adrnr, name: condense(`${p.nachname ?? ''}, ${p.vorname ?? ''}`), geburtsjahr: p.jahr ?? null, geschlecht: String(p.geschlecht).trim(),
        inGruppe: inGruppe.has(p.adrnr),
        wahl: Object.fromEntries(eigene.map((x) => [Number(x.gruppe_id), Number(x.wahl) as Wahl])),
        bemerkung: bem.get(p.adrnr) ?? '',
        geaendert: eigene.map((x) => x.am as string).sort().at(-1) ?? null,
      };
    })
    .sort((x, y) => x.name.localeCompare(y.name, 'de'));
  return {
    abfrage: a, mannschaften, zeilen, summen: zaehlen(mannschaften, zeilen),
    anzahl: { personen: zeilen.length, mitRueckmeldung: zeilen.filter((z) => Object.keys(z.wahl).length).length },
  };
}

/** Matrix als CSV (Semikolon, für Excel) */
export async function matrixCsv(db: Db, id: number): Promise<{ name: string; csv: string }> {
  const m = await matrixLesen(db, id);
  const q = (v: unknown) => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const kopf = ['Name', 'Jahrgang', 'Mitgl.-Nr. (Adr.)', ...m.mannschaften.map((x) => x.name), 'Bemerkung'];
  const zeilen = m.zeilen.map((z) => [z.name, z.geburtsjahr ?? '', z.adrnr, ...m.mannschaften.map((x) => z.wahl[x.gruppe_id] ?? ''), z.bemerkung]);
  const legende = ['', '', '1 = fest, 2 = Ersatz, 3 = nicht'];
  return { name: `Anmeldematrix ${m.abfrage.titel}`, csv: `﻿${[kopf, ...zeilen, legende].map((z) => z.map(q).join(';')).join('\r\n')}\r\n` };
}

// ---------------------------------------------------------------- Angaben speichern (Mitglied selbst oder Sportwart)

export interface Angabe { adrnr: string; wahl: { gruppe_id: number; wahl: Wahl | null }[]; bemerkung: string }

export async function angabeSpeichern(tx: Db, id: number, b: Angabe, wer: string, o: { verwaltung: boolean }): Promise<string> {
  const a = await abfrage(tx, id);
  if (!o.verwaltung && !antwortMoeglich(a)) {
    throw new BusinessError(a.status !== 'offen' ? 'Diese Abfrage ist nicht (mehr) offen.' : 'Die Frist für diese Abfrage ist abgelaufen – bitte beim Sportwart melden.');
  }
  const gueltig = new Set((await tx`select gruppe_id from tco.mm_mannschaften where abfrage_id = ${id}`).map((r) => Number(r.gruppe_id)));
  for (const w of b.wahl) if (!gueltig.has(w.gruppe_id)) throw new BusinessError('Eine Mannschaft gehört nicht (mehr) zu dieser Abfrage – bitte neu laden.');
  let n = 0;
  for (const w of b.wahl) {
    if (w.wahl == null) await tx`delete from tco.mm_antworten where abfrage_id = ${id} and gruppe_id = ${w.gruppe_id} and adrnr = ${b.adrnr}`;
    else {
      await tx`insert into tco.mm_antworten (abfrage_id, gruppe_id, adrnr, wahl, geaendert_von) values (${id}, ${w.gruppe_id}, ${b.adrnr}, ${w.wahl}, ${wer})
               on conflict (abfrage_id, gruppe_id, adrnr) do update set wahl = excluded.wahl, geaendert_am = now(), geaendert_von = excluded.geaendert_von
               where tco.mm_antworten.wahl <> excluded.wahl`;
      n++;
    }
  }
  const t = b.bemerkung.trim();
  if (t) await tx`insert into tco.mm_bemerkungen (abfrage_id, adrnr, text) values (${id}, ${b.adrnr}, ${t}) on conflict (abfrage_id, adrnr) do update set text = excluded.text`;
  else await tx`delete from tco.mm_bemerkungen where abfrage_id = ${id} and adrnr = ${b.adrnr}`;
  const [p] = await tx`select vorname from tco.mitglieder where adrnr = ${b.adrnr}`;
  return `Mannschaftsmeldung${p?.vorname ? ` für ${p.vorname}` : ''} gesichert (${n} von ${gueltig.size} Mannschaften angegeben).`;
}

// ---------------------------------------------------------------- Mein Bereich

/** offene Abfragen (und die abgeschlossenen der letzten Saison zum Nachsehen) mit den Angaben der Familie */
export async function meineLesen(db: Db, adrnr: string) {
  const familie = await familieLesen(db, adrnr);
  const abfragen = (await db`select id, titel, saison, frist::text as frist, hinweis, status from tco.mm_abfragen
                              where status = 'offen' or (status = 'geschlossen' and updated_at > now() - interval '1 year') order by status desc, id desc`).map(abfrageAus);
  const ids = abfragen.map((a) => a.id), personen = familie.map((f) => f.adrnr);
  const ms = await mannschaftenLesen(db, ids);
  const antworten = await db`select abfrage_id, gruppe_id, adrnr, wahl from tco.mm_antworten where abfrage_id = any(${ids}::int[]) and adrnr = any(${personen}::text[])`;
  const bem = await db`select abfrage_id, adrnr, text from tco.mm_bemerkungen where abfrage_id = any(${ids}::int[]) and adrnr = any(${personen}::text[])`;
  return {
    abfragen: abfragen.map((a) => ({
      ...a, bearbeitbar: antwortMoeglich(a), mannschaften: ms.get(a.id) ?? [],
      personen: familie.map((f) => ({
        adrnr: f.adrnr, name: f.name,
        wahl: Object.fromEntries(antworten.filter((x) => Number(x.abfrage_id) === a.id && x.adrnr === f.adrnr).map((x) => [Number(x.gruppe_id), Number(x.wahl) as Wahl])),
        bemerkung: (bem.find((x) => Number(x.abfrage_id) === a.id && x.adrnr === f.adrnr)?.text as string | undefined) ?? '',
      })),
    })),
  };
}

/** gehört die Person zur Familie des angemeldeten Mitglieds? */
export async function zurFamilie(db: Db, eigene: string, adrnr: string) {
  const f = await familieLesen(db, eigene);
  if (!f.some((x) => x.adrnr === adrnr)) throw new BusinessError('Angaben nur für sich selbst und die eigene Familie möglich.', 403);
}
