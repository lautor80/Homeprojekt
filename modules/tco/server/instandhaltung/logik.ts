/**
 * Instandhaltung / Schadensmeldung (#205): Datenzugriff und Abläufe.
 *
 * Mitglieder melden Schäden (App „Schaden melden“, auch per QR-Code am Ort), Platzwart/Hallenwart/Vorstand bearbeiten
 * sie in der App „Schadensmeldungen“ (Bereich Instandhaltung). Offene Meldungen stehen im Arbeitsvorrat auf der Startseite und in der Vereinsübersicht (dashboard/arbeitsvorrat.ts),
 * die Kachel „Offene Schäden“ in den Kennzahlen. E-Mails werden hier nur zusammengestellt – versendet wird in routes.ts.
 *
 * Stammdaten: Orte („Wo?“, mit Gruppe), Kategorien, Matrix Kategorie × Ort (was wo gemeldet werden kann), Zuständigkeit
 * je Benutzer für Orte und/oder Kategorien. Zuständig sein kann nur, wer über eine Rolle die Berechtigung
 * „Schadensmeldungen bearbeiten“ hat. Jeder Schritt steht mit Zeitstempel, Benutzer und Aktion im Protokoll (tco.ih_verlauf).
 */
import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import { addTage, dat, heute } from '../format.js';
import { festeLoeschen, festeSpeichern } from '../platz/belegungen.js';
import {
  ANLAGE_TYPEN, AUSWIRKUNG, aufgabeState, DOK_ARTEN, empfaenger, eskalationFaellig, feldAenderungen, fotoLesen, istOffen, kurz, meldungsNummer,
  PRIORITAET, prioritaetVorschlag, STATUS, STATUS_OFFEN, ueberfaellig, wechselFehler, zustaendigRang,
  type AnlageTyp, type Auswirkung, type DokArt, type Prioritaet, type Status,
} from './regeln.js';

export const P_IH = {
  melden: 'tco.schaden:melden',
  display: 'tco.instandhaltung:display',
  edit: 'tco.instandhaltung:edit',
  admin: 'tco.instandhaltung:admin',
};

/** Zusammengestellte E-Mail (Versand in routes.ts, danach Protokolleintrag an der Meldung) */
export interface Mail { an: string; betreff: string; text: string; objekt: string; meldung_id: number }
export interface Ich { id: string | null; name: string }

export const AKTIONEN = {
  ANGELEGT: 'Gemeldet', STATUS: 'Status', ZUSTAENDIG: 'Zuständigkeit', FELD: 'Änderung', KOMMENTAR: 'Kommentar', FOTO: 'Foto',
  FOTO_GELOESCHT: 'Foto gelöscht', DOKUMENT: 'Dokument verknüpft', DOKUMENT_GELOEST: 'Dokument gelöst', SPERRE: 'Platzsperre', SPERRE_AUF: 'Sperre aufgehoben', MAIL: 'E-Mail', FORMULAR: 'Formular',
  ERINNERUNG: 'Erinnerung', FOTOFRIST: 'Fotos gelöscht (Frist)',
} as const;
export type Aktion = keyof typeof AKTIONEN;

/** Protokolleintrag: Zeitstempel (now), Benutzer, Aktion, Text; fuer_melder = in „Meine Meldungen“ sichtbar */
export async function protokoll(tx: Db, meldungId: number, ich: Ich, aktion: Aktion, text: string | null, o: { status?: Status | null; fuerMelder?: boolean } = {}) {
  await tx`insert into tco.ih_verlauf (meldung_id, von, benutzer_id, aktion, status, text, fuer_melder)
           values (${meldungId}, ${ich.name}, ${ich.id}, ${aktion}, ${o.status ?? null}, ${text}, ${o.fuerMelder ?? false})`;
}

// ---------------------------------------------------------------- Stammdaten

export interface Anlage {
  id: number; kuerzel: string; bezeichnung: string; gruppe: string; typ: AnlageTyp; platz_id: number | null; platz: string | null; sort: number; aktiv: boolean;
}
export interface Kategorie { id: number; bezeichnung: string; sort: number; aktiv: boolean }

export async function anlagenLesen(db: Db, nurAktiv = false): Promise<Anlage[]> {
  return (await db`
    select a.id, a.kuerzel, a.bezeichnung, a.gruppe, a.typ, a.platz_id, p.name as platz, a.sort, a.aktiv
      from tco.ih_anlage a left join tco.plaetze p on p.id = a.platz_id
     where ${!nurAktiv} or a.aktiv
     order by a.gruppe, a.sort, a.bezeichnung`) as unknown as Anlage[];
}

export async function kategorienLesen(db: Db, nurAktiv = false): Promise<Kategorie[]> {
  return (await db`select id, bezeichnung, sort, aktiv from tco.ih_kategorie where ${!nurAktiv} or aktiv order by sort, bezeichnung`) as unknown as Kategorie[];
}

/** Matrix: Paare [Ort, Kategorie], die gemeldet werden können */
export async function matrixLesen(db: Db): Promise<[number, number][]> {
  return (await db`select anlage_id, kategorie_id from tco.ih_anlage_kategorie order by 1, 2`).map((r) => [r.anlage_id as number, r.kategorie_id as number]);
}

export async function matrixSichern(tx: Db, paare: [number, number][]): Promise<string> {
  const uniq = [...new Map(paare.map(([a, k]) => [`${a}:${k}`, [a, k] as [number, number]])).values()];
  const a = uniq.map((p) => p[0]);
  const k = uniq.map((p) => p[1]);
  const [n] = await tx`select count(*)::int as n from unnest(${a}::int[], ${k}::int[]) as x(a, k)
                        where not exists (select 1 from tco.ih_anlage where id = x.a) or not exists (select 1 from tco.ih_kategorie where id = x.k)`;
  if (n.n) throw new BusinessError('Unbekannter Ort oder unbekannte Kategorie in der Matrix.');
  await tx`delete from tco.ih_anlage_kategorie x
            where not exists (select 1 from unnest(${a}::int[], ${k}::int[]) as y(a, k) where y.a = x.anlage_id and y.k = x.kategorie_id)`;
  await tx`insert into tco.ih_anlage_kategorie (anlage_id, kategorie_id) select * from unnest(${a}::int[], ${k}::int[]) on conflict do nothing`;
  return `Matrix gesichert (${uniq.length} Kombination${uniq.length === 1 ? '' : 'en'}).`;
}

export interface Einstellungen { vorstand_email: string; foto_frist_monate: number; paperless_typen: string; paperless_pfade: string }
export async function einstellungenLesen(db: Db): Promise<Einstellungen> {
  const [e] = await db`select vorstand_email, foto_frist_monate, paperless_typen, paperless_pfade from tco.ih_einstellungen where id = 1`;
  return {
    vorstand_email: e?.vorstand_email ?? '', foto_frist_monate: Number(e?.foto_frist_monate ?? 24),
    paperless_typen: e?.paperless_typen ?? '', paperless_pfade: e?.paperless_pfade ?? '',
  };
}

export interface Bearbeiter { id: string; name: string; email: string | null; rollen: string[] }

/** Personen, die zuständig sein können: aktive Benutzer mit einer Rolle, die „Schadensmeldungen bearbeiten“ enthält */
export async function bearbeiterLesen(db: Db): Promise<Bearbeiter[]> {
  return (await db`
    select u.id, u.display_name as name, u.email, array_agg(distinct r.name order by r.name) as rollen
      from core.users u
      join core.user_roles ur on ur.user_id = u.id
      join core.roles r on r.id = ur.role_id
      join core.role_permissions rp on rp.role_id = ur.role_id
     where u.active and rp.permission in (${P_IH.edit}, '*')
     group by u.id, u.display_name, u.email
     order by 2`) as unknown as Bearbeiter[];
}

async function istBearbeiter(db: Db, benutzerId: string): Promise<boolean> {
  const [r] = await db`select 1 from core.users u join core.user_roles ur on ur.user_id = u.id join core.role_permissions rp on rp.role_id = ur.role_id
                        where u.id = ${benutzerId} and u.active and rp.permission in (${P_IH.edit}, '*') limit 1`;
  return !!r;
}

export interface Zustaendigkeit { id: number; benutzer_id: string; name: string; anlage_id: number | null; anlage: string | null; kategorie_id: number | null; kategorie: string | null; berechtigt: boolean }

export async function zustaendigkeitenLesen(db: Db): Promise<Zustaendigkeit[]> {
  const bearb = new Set((await bearbeiterLesen(db)).map((b) => b.id));
  const rows = await db`
    select z.id, z.benutzer_id, u.display_name as name, z.anlage_id, a.bezeichnung as anlage, z.kategorie_id, k.bezeichnung as kategorie
      from tco.ih_zustaendig z join core.users u on u.id = z.benutzer_id
      left join tco.ih_anlage a on a.id = z.anlage_id left join tco.ih_kategorie k on k.id = z.kategorie_id
     order by u.display_name, a.bezeichnung nulls first, k.bezeichnung nulls first`;
  return rows.map((r) => ({ ...r, berechtigt: bearb.has(r.benutzer_id) })) as unknown as Zustaendigkeit[];
}

export async function zustaendigkeitAnlegen(tx: Db, e: { benutzer_id: string; anlage_id: number | null; kategorie_id: number | null }): Promise<string> {
  if (!e.anlage_id && !e.kategorie_id) throw new BusinessError('Bitte einen Ort, eine Kategorie oder beides wählen.');
  if (!(await istBearbeiter(tx, e.benutzer_id))) {
    throw new BusinessError('Zuständig sein kann nur, wer über eine Rolle die Berechtigung „Schadensmeldungen bearbeiten“ hat (Administration → Benutzer und Rechte → Rollen).');
  }
  const r = await tx`insert into tco.ih_zustaendig (benutzer_id, anlage_id, kategorie_id) values (${e.benutzer_id}, ${e.anlage_id}, ${e.kategorie_id})
                     on conflict do nothing`;
  if (!r.count) throw new BusinessError('Diese Zuständigkeit gibt es schon.');
  return 'Zuständigkeit angelegt.';
}

export async function zustaendigkeitLoeschen(tx: Db, id: number): Promise<string> {
  const r = await tx`delete from tco.ih_zustaendig where id = ${id}`;
  if (!r.count) throw new BusinessError('Zuständigkeit nicht gefunden.', 404);
  return 'Zuständigkeit gelöscht.';
}

/** Zuständige für Ort + Kategorie (nur berechtigte, aktive Benutzer), der spezifischste zuerst */
export async function zustaendigeFuer(db: Db, anlageId: number, kategorieId: number): Promise<{ id: string; name: string; email: string | null; rang: number }[]> {
  const rows = await db`
    select z.anlage_id, z.kategorie_id, u.id, u.display_name as name, u.email
      from tco.ih_zustaendig z join core.users u on u.id = z.benutzer_id
     where (z.anlage_id is null or z.anlage_id = ${anlageId}) and (z.kategorie_id is null or z.kategorie_id = ${kategorieId})`;
  const bearb = new Set((await bearbeiterLesen(db)).map((b) => b.id));
  const best = new Map<string, { id: string; name: string; email: string | null; rang: number }>();
  for (const r of rows) {
    const rang = zustaendigRang(r as never, anlageId, kategorieId);
    if (rang === null || !bearb.has(r.id)) continue;
    const alt = best.get(r.id);
    if (!alt || rang < alt.rang) best.set(r.id, { id: r.id, name: r.name, email: r.email, rang });
  }
  return [...best.values()].sort((a, b) => a.rang - b.rang || a.name.localeCompare(b.name, 'de'));
}

export interface AnlageEingabe { kuerzel: string; bezeichnung: string; gruppe: string; typ: AnlageTyp; platz_id: number | null; sort: number; aktiv: boolean }
export async function anlageSichern(tx: Db, id: number | null, e: AnlageEingabe): Promise<{ id: number; text: string }> {
  const kuerzel = e.kuerzel.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,29}$/.test(kuerzel)) throw new BusinessError('Kürzel: nur Kleinbuchstaben, Ziffern, „-“ und „_“ (höchstens 30 Zeichen) – es steht im QR-Link.');
  if (!(e.typ in ANLAGE_TYPEN)) throw new BusinessError('Unbekannter Typ.');
  const [dop] = await tx`select id from tco.ih_anlage where lower(kuerzel) = ${kuerzel} and id is distinct from ${id}`;
  if (dop) throw new BusinessError(`Das Kürzel „${kuerzel}“ ist schon vergeben.`);
  if (e.platz_id) {
    const [p] = await tx`select 1 from tco.plaetze where id = ${e.platz_id}`;
    if (!p) throw new BusinessError('Der gewählte Platz existiert nicht.');
  }
  const werte = { kuerzel, bezeichnung: e.bezeichnung.trim(), gruppe: e.gruppe.trim(), typ: e.typ, platz_id: e.platz_id ?? null, sort: e.sort, aktiv: e.aktiv };
  if (id) {
    const r = await tx`update tco.ih_anlage set ${tx(werte)} where id = ${id}`;
    if (!r.count) throw new BusinessError('Ort nicht gefunden.', 404);
    return { id, text: `„${werte.bezeichnung}“ gesichert.` };
  }
  const [r] = await tx`insert into tco.ih_anlage ${tx(werte)} returning id`;
  // neuer Ort: alle aktiven Kategorien zulassen (in der Matrix änderbar)
  await tx`insert into tco.ih_anlage_kategorie (anlage_id, kategorie_id) select ${r.id}, id from tco.ih_kategorie where aktiv on conflict do nothing`;
  return { id: r.id, text: `„${werte.bezeichnung}“ angelegt – alle Kategorien sind zugelassen (Matrix).` };
}

export interface KategorieEingabe { bezeichnung: string; sort: number; aktiv: boolean }
export async function kategorieSichern(tx: Db, id: number | null, e: KategorieEingabe): Promise<{ id: number; text: string }> {
  const bezeichnung = e.bezeichnung.trim();
  const [dop] = await tx`select id from tco.ih_kategorie where lower(bezeichnung) = lower(${bezeichnung}) and id is distinct from ${id}`;
  if (dop) throw new BusinessError(`Die Kategorie „${bezeichnung}“ gibt es schon.`);
  const werte = { bezeichnung, sort: e.sort, aktiv: e.aktiv };
  if (id) {
    const r = await tx`update tco.ih_kategorie set ${tx(werte)} where id = ${id}`;
    if (!r.count) throw new BusinessError('Kategorie nicht gefunden.', 404);
    return { id, text: `Kategorie „${bezeichnung}“ gesichert.` };
  }
  const [r] = await tx`insert into tco.ih_kategorie ${tx(werte)} returning id`;
  await tx`insert into tco.ih_anlage_kategorie (anlage_id, kategorie_id) select id, ${r.id} from tco.ih_anlage where aktiv on conflict do nothing`;
  return { id: r.id, text: `Kategorie „${bezeichnung}“ angelegt – an allen Orten zugelassen (Matrix).` };
}

/**
 * Einstellungen sichern – nur die übergebenen Angaben ändern sich: Benachrichtigung und Fotos pflegt das Kapitel
 * „Instandhaltung“ der Einstellungen, die Paperless-Auswahl der Reiter „Paperless“ der Schnittstellen (#232).
 */
export async function einstellungenSichern(tx: Db, e: { vorstand_email?: string; foto_frist_monate?: number; paperless_typen?: string; paperless_pfade?: string }): Promise<string> {
  const alt = await einstellungenLesen(tx);
  const mail = e.vorstand_email ?? alt.vorstand_email;
  const liste = mail.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  if (liste.some((x) => !empfaenger(x).length)) throw new BusinessError('Bitte gültige E-Mail-Adressen angeben (mehrere mit Komma trennen).');
  const norm = (x: string | undefined, a: string) => (x === undefined ? a : x.split(',').map((t) => t.trim()).filter(Boolean).join(', '));
  await tx`update tco.ih_einstellungen set vorstand_email = ${empfaenger(mail).join(', ')}, foto_frist_monate = ${e.foto_frist_monate ?? alt.foto_frist_monate},
                  paperless_typen = ${norm(e.paperless_typen, alt.paperless_typen)}, paperless_pfade = ${norm(e.paperless_pfade, alt.paperless_pfade)} where id = 1`;
  return 'Einstellungen gesichert.';
}

// ---------------------------------------------------------------- Melden

export interface MeldungEingabe { anlage_id: number; kategorie_id: number; beschreibung: string; auswirkung: Auswirkung; fotos: { name: string; data: string }[] }

export async function meldungAnlegen(tx: Db, d: MeldungEingabe, ich: Ich): Promise<{ id: number; nummer: string; text: string }> {
  const [a] = await tx`select id, bezeichnung from tco.ih_anlage where id = ${d.anlage_id} and aktiv`;
  if (!a) throw new BusinessError('Bitte wählen, wo der Schaden ist.');
  const [k] = await tx`select id, bezeichnung from tco.ih_kategorie where id = ${d.kategorie_id} and aktiv`;
  if (!k) throw new BusinessError('Bitte eine Kategorie wählen.');
  const [m] = await tx`select 1 from tco.ih_anlage_kategorie where anlage_id = ${a.id} and kategorie_id = ${k.id}`;
  if (!m) throw new BusinessError(`„${k.bezeichnung}“ kann bei „${a.bezeichnung}“ nicht gemeldet werden – bitte eine passende Kategorie wählen.`);
  if (!d.beschreibung.trim()) throw new BusinessError('Bitte kurz beschreiben, was kaputt ist.');
  if (d.fotos.length > 3) throw new BusinessError('Höchstens 3 Fotos.');
  const fotos = d.fotos.map((f) => {
    try { return { name: f.name.slice(0, 120) || 'foto', ...fotoLesen(f.data) }; } catch (e) { throw new BusinessError((e as Error).message); }
  });
  const zust = (await zustaendigeFuer(tx, a.id, k.id))[0] ?? null;
  const [r] = await tx`
    insert into tco.ih_meldung (nummer, anlage_id, kategorie_id, beschreibung, auswirkung, prioritaet, melder_id, melder_name, zustaendig)
    values ('neu-' || gen_random_uuid()::text, ${a.id}, ${k.id}, ${d.beschreibung.trim()}, ${d.auswirkung}, ${prioritaetVorschlag(d.auswirkung)},
            ${ich.id}, ${ich.name}, ${zust?.id ?? null})
    returning id, extract(year from eingang at time zone 'Europe/Berlin')::int as jahr`;
  const nummer = meldungsNummer(r.jahr, r.id);
  await tx`update tco.ih_meldung set nummer = ${nummer} where id = ${r.id}`;
  await protokoll(tx, r.id, ich, 'ANGELEGT', `Schaden gemeldet: ${a.bezeichnung} – ${k.bezeichnung} (${AUSWIRKUNG[d.auswirkung]})`, { status: 'NEU', fuerMelder: true });
  if (zust) await protokoll(tx, r.id, ich, 'ZUSTAENDIG', `Zuständig laut Stammdaten: ${zust.name}`);
  for (const f of fotos) {
    await tx`insert into tco.ih_anhang (meldung_id, art, name, mime, daten, groesse, von) values (${r.id}, 'VORHER', ${f.name}, ${f.mime}, ${f.daten}, ${f.daten.length}, ${ich.name})`;
  }
  if (fotos.length) await protokoll(tx, r.id, ich, 'FOTO', `${fotos.length} Foto${fotos.length === 1 ? '' : 's'} bei der Meldung`);
  return { id: r.id, nummer, text: `Danke! Deine Meldung ${nummer} ist eingegangen – die Zuständigen sind informiert.` };
}

/** bereits offene Meldungen an einem Ort (gegen Doppelmeldungen; ohne Melder) */
export async function offeneZurAnlage(db: Db, anlageId: number) {
  return db`
    select m.id, m.nummer, k.bezeichnung as kategorie, m.beschreibung, m.auswirkung, m.status,
           to_char(m.eingang at time zone 'Europe/Berlin', 'YYYY-MM-DD') as eingang
      from tco.ih_meldung m join tco.ih_kategorie k on k.id = m.kategorie_id
     where m.anlage_id = ${anlageId} and m.status = any(${STATUS_OFFEN})
     order by m.eingang desc`;
}

/** „Meine Meldungen“: eigene Meldungen mit den für Melder freigegebenen Protokolleinträgen */
export async function meineLesen(db: Db, userId: string) {
  const zeilen = await db`
    select m.id, m.nummer, a.bezeichnung as anlage, k.bezeichnung as kategorie, m.beschreibung, m.auswirkung, m.status, m.eingang,
           m.erledigung, m.erledigt_am
      from tco.ih_meldung m join tco.ih_anlage a on a.id = m.anlage_id join tco.ih_kategorie k on k.id = m.kategorie_id
     where m.melder_id = ${userId}
     order by m.eingang desc limit 100`;
  if (!zeilen.length) return [];
  const ids = zeilen.map((z) => z.id as number);
  const verlauf = await db`select meldung_id, am, von, status, text from tco.ih_verlauf where meldung_id = any(${ids}) and fuer_melder order by am, id`;
  const fotos = await db`select id, meldung_id, art from tco.ih_anhang where meldung_id = any(${ids}) order by id`;
  return zeilen.map((z) => ({
    ...z, status_txt: STATUS[z.status as Status], auswirkung_txt: AUSWIRKUNG[z.auswirkung as Auswirkung],
    verlauf: verlauf.filter((v) => v.meldung_id === z.id).map(({ meldung_id: _m, ...v }) => ({ ...v, status_txt: v.status ? STATUS[v.status as Status] : null })),
    fotos: fotos.filter((f) => f.meldung_id === z.id).map((f) => ({ id: f.id, art: f.art })),
  }));
}

// ---------------------------------------------------------------- Bearbeiten

const KOPF = (db: Db) => db`
  select m.id, m.nummer, m.anlage_id, a.bezeichnung as anlage, a.gruppe, a.platz_id, p.name as platz, m.kategorie_id, k.bezeichnung as kategorie,
         m.beschreibung, m.auswirkung, m.prioritaet, m.geplant_bis::text as geplant_bis, m.ende_ist::text as ende_ist,
         m.status, m.eingang, m.melder_id, m.melder_name, mu.email as melder_email,
         m.zustaendig, zu.display_name as zustaendig_name, zu.email as zustaendig_email,
         m.duplikat_von, d.nummer as duplikat_nummer, m.erledigung, m.kosten::float8 as kosten, m.firma, m.paperless, m.stunden::float8 as stunden,
         m.sperre_id, s.datum_von::text as sperre_von, s.datum_bis::text as sperre_bis,
         m.status_am, m.erinnert_am, m.erledigt_am, m.geaendert_am, m.geaendert_von, m.formular_doc_id, m.formular_am,
         (select count(*)::int from tco.ih_anhang x where x.meldung_id = m.id) as fotos,
         (select count(*)::int from tco.ih_dokument x where x.meldung_id = m.id) as dokumente
    from tco.ih_meldung m
    join tco.ih_anlage a on a.id = m.anlage_id
    join tco.ih_kategorie k on k.id = m.kategorie_id
    left join tco.plaetze p on p.id = a.platz_id
    left join core.users mu on mu.id = m.melder_id
    left join core.users zu on zu.id = m.zustaendig
    left join tco.ih_meldung d on d.id = m.duplikat_von
    left join tco.platzbelegungen s on s.id = m.sperre_id`;

const mitTexten = <T extends Record<string, unknown>>(z: T) => ({
  ...z, status_txt: STATUS[z.status as Status], auswirkung_txt: AUSWIRKUNG[z.auswirkung as Auswirkung], offen: istOffen(String(z.status)),
  prioritaet_txt: PRIORITAET[z.prioritaet as Prioritaet] ?? String(z.prioritaet ?? ''),
  ueberfaellig: ueberfaellig({ status: String(z.status), geplant_bis: (z.geplant_bis as string | null) ?? null }, heute()),
});
const PRIO_ORDER = (db: Db) => db`case m.prioritaet when 'SEHR_HOCH' then 0 when 'HOCH' then 1 when 'MITTEL' then 2 else 3 end`;

export async function listeLesen(db: Db, filter: 'OFFEN' | 'ALLE') {
  const rows = await db`${KOPF(db)}
    where ${filter === 'ALLE'} or m.status = any(${STATUS_OFFEN})
    order by ${PRIO_ORDER(db)}, m.eingang desc
    limit 2000`;
  return rows.map(mitTexten);
}

export async function kopfLesen(db: Db, id: number) {
  const [m] = await db`${KOPF(db)} where m.id = ${id}`;
  if (!m) throw new BusinessError('Meldung nicht gefunden.', 404);
  return mitTexten(m);
}

export async function protokollLesen(db: Db, id: number) {
  const rows = await db`select v.id, v.am, v.von, v.benutzer_id, u.username, v.aktion, v.status, v.text, v.fuer_melder
                          from tco.ih_verlauf v left join core.users u on u.id = v.benutzer_id
                         where v.meldung_id = ${id} order by v.am, v.id`;
  return rows.map((v) => ({ ...v, aktion_txt: AKTIONEN[v.aktion as Aktion] ?? v.aktion, status_txt: v.status ? STATUS[v.status as Status] : null }));
}

export async function detailLesen(db: Db, id: number) {
  const m = await kopfLesen(db, id);
  const fotos = await db`select id, art, name, groesse, am, von from tco.ih_anhang where meldung_id = ${id} order by id`;
  // betroffene kommende Buchungen auf dem Platz (nur Anzeige, keine automatische Stornierung)
  const buchungen = m.platz && (m.sperre_id || m.auswirkung === 'UNBESPIELBAR' || m.auswirkung === 'SICHERHEIT') ? await db`
    select distinct b.datum::text as datum, to_char(b.time_start, 'HH24:MI') as von, to_char(b.time_ende, 'HH24:MI') as bis, coalesce(nullif(b.kunde, ''), 'Buchung') as kunde
      from tco.bookings b
     where upper(b.platz) = upper(${m.platz}) and b.datum >= ${heute()} and coalesce(b.status, '') not in ('2', '4')
     order by 1, 2 limit 50` : [];
  return {
    ...m, protokoll: await protokollLesen(db, id), fotos, buchungen, dokumente: await dokumenteLesen(db, id),
    zustaendige: await zustaendigeFuer(db, m.anlage_id as number, m.kategorie_id as number),
  };
}

export interface BearbeitenEingabe {
  /** nicht angegeben (undefined) = unverändert */
  status: Status; prioritaet?: Prioritaet; geplant_bis?: string | null; ende_ist?: string | null; zustaendig: string | null; duplikat_von: number | null; erledigung: string | null;
  kosten: number | null; firma: string | null; paperless: string | null; stunden: number | null;
  /** Kommentar (eigener Protokolleintrag) */
  kommentar: string | null; fuer_melder: boolean;
}

/** Bearbeiten: Status, Zuständiger, Kosten … – jede Änderung als eigener Protokolleintrag. Liefert die Mails. */
export async function bearbeiten(tx: Db, id: number, e: BearbeitenEingabe, ich: Ich): Promise<{ text: string; mails: Mail[] }> {
  const [alt] = await tx`select m.*, m.geplant_bis::text as geplant_bis, m.ende_ist::text as ende_ist, d.nummer as duplikat_nummer,
                                 u.display_name as zustaendig_name from tco.ih_meldung m
                           left join tco.ih_meldung d on d.id = m.duplikat_von left join core.users u on u.id = m.zustaendig
                          where m.id = ${id} for update of m`;
  if (!alt) throw new BusinessError('Meldung nicht gefunden.', 404);
  const fehler = wechselFehler(alt.status, e.status, { duplikatVon: e.duplikat_von, erledigung: e.erledigung });
  if (fehler) throw new BusinessError(fehler);
  let dupNummer: string | null = null;
  if (e.status === 'DUPLIKAT' && e.duplikat_von) {
    if (e.duplikat_von === id) throw new BusinessError('Eine Meldung kann kein Duplikat von sich selbst sein.');
    const [d] = await tx`select nummer from tco.ih_meldung where id = ${e.duplikat_von}`;
    if (!d) throw new BusinessError('Die Ursprungsmeldung gibt es nicht.');
    dupNummer = d.nummer;
  }
  let zustName: string | null = null;
  if (e.zustaendig && e.zustaendig !== alt.zustaendig) {
    if (!(await istBearbeiter(tx, e.zustaendig))) throw new BusinessError('Zuständig sein kann nur, wer die Berechtigung „Schadensmeldungen bearbeiten“ hat.');
  }
  if (e.zustaendig) zustName = (await tx`select display_name from core.users where id = ${e.zustaendig}`)[0]?.display_name ?? null;
  if (e.status === 'ZUGEWIESEN' && !e.zustaendig) throw new BusinessError('Bitte einen Zuständigen wählen.');
  const statusNeu = alt.status !== e.status;
  const ende = !istOffen(e.status);
  if (e.prioritaet !== undefined && !(e.prioritaet in PRIORITAET)) throw new BusinessError('Unbekannte Priorität.');
  if (e.ende_ist && !ende) throw new BusinessError('Das tatsächliche Enddatum gibt es erst beim Abschluss (Erledigt, Abgelehnt oder Duplikat).');
  if (e.ende_ist && e.ende_ist > heute()) throw new BusinessError('Das tatsächliche Enddatum liegt in der Zukunft.');
  const neu = {
    prioritaet: e.prioritaet ?? alt.prioritaet, geplant_bis: e.geplant_bis === undefined ? alt.geplant_bis : e.geplant_bis,
    ende_ist: ende ? (e.ende_ist || alt.ende_ist || heute()) : null,
    erledigung: e.erledigung?.trim() || null, kosten: e.kosten, firma: e.firma?.trim() || null, paperless: e.paperless?.trim() || null, stunden: e.stunden,
  };
  await tx`
    update tco.ih_meldung set status = ${e.status}, zustaendig = ${e.zustaendig}, duplikat_von = ${e.status === 'DUPLIKAT' ? e.duplikat_von : null},
           prioritaet = ${neu.prioritaet}, geplant_bis = ${neu.geplant_bis}, ende_ist = ${neu.ende_ist},
           erledigung = ${neu.erledigung}, kosten = ${neu.kosten}, firma = ${neu.firma}, paperless = ${neu.paperless}, stunden = ${neu.stunden},
           status_am = case when ${statusNeu} then now() else status_am end,
           erledigt_am = case when ${ende} then coalesce(case when ${statusNeu} then null else erledigt_am end, now()) else null end,
           geaendert_am = now(), geaendert_von = ${ich.name}
     where id = ${id}`;
  // Protokoll
  if (statusNeu) {
    const zusatz = e.status === 'DUPLIKAT' ? ` (Duplikat von ${dupNummer})` : ende && neu.erledigung ? ` – ${neu.erledigung}` : '';
    await protokoll(tx, id, ich, 'STATUS', `${STATUS[alt.status as Status]} → ${STATUS[e.status]}${zusatz}`, { status: e.status, fuerMelder: true });
  }
  if ((e.zustaendig ?? null) !== (alt.zustaendig ?? null)) {
    await protokoll(tx, id, ich, 'ZUSTAENDIG', `${alt.zustaendig_name ?? '–'} → ${zustName ?? '–'}`);
  }
  for (const t of feldAenderungen(alt, neu)) await protokoll(tx, id, ich, 'FELD', t);
  if (e.kommentar?.trim()) await protokoll(tx, id, ich, 'KOMMENTAR', e.kommentar.trim(), { fuerMelder: e.fuer_melder });

  const m = await kopfLesen(tx, id);
  const mails: Mail[] = [];
  if (statusNeu && ende && m.melder_email) {
    const was = e.status === 'ERLEDIGT' ? 'ist erledigt' : e.status === 'ABGELEHNT' ? 'wurde abgelehnt' : `ist bereits bekannt (${m.duplikat_nummer})`;
    mails.push({
      an: m.melder_email, objekt: m.nummer, meldung_id: id, betreff: `Deine Schadensmeldung ${m.nummer} ${was}`,
      text: `Hallo ${m.melder_name},\n\ndeine Meldung ${m.nummer} (${m.anlage} – ${m.kategorie}) ${was}.\n`
        + `${m.erledigung ? `\n${m.erledigung}\n` : ''}\nDanke fürs Melden!\n\nDen Verlauf siehst du im Vereinsportal unter „Schaden melden“ → „Meine Meldungen“.`,
    });
  }
  if (e.zustaendig && e.zustaendig !== alt.zustaendig && m.zustaendig_email) {
    mails.push({
      an: m.zustaendig_email, objekt: m.nummer, meldung_id: id, betreff: `Schaden ${m.nummer} dir zugewiesen: ${m.anlage} – ${m.kategorie}`,
      text: `Hallo ${m.zustaendig_name},\n\n${ich.name} hat dir die Schadensmeldung ${m.nummer} zugewiesen.\n\n${mailDetails(m)}\n\nZur Meldung: {portal}/tco/instandhaltung?id=${id}`,
    });
  }
  return { text: `${m.nummer} gesichert${statusNeu ? ` – Status „${STATUS[e.status]}“` : ''}.`, mails };
}

export async function kommentieren(tx: Db, id: number, text: string, fuerMelder: boolean, ich: Ich): Promise<string> {
  const [m] = await tx`select nummer from tco.ih_meldung where id = ${id}`;
  if (!m) throw new BusinessError('Meldung nicht gefunden.', 404);
  if (!text.trim()) throw new BusinessError('Bitte einen Text eingeben.');
  await protokoll(tx, id, ich, 'KOMMENTAR', text.trim(), { fuerMelder });
  await tx`update tco.ih_meldung set geaendert_am = now(), geaendert_von = ${ich.name} where id = ${id}`;
  return `Kommentar zu ${m.nummer} gesichert.`;
}

export async function fotosAnhaengen(tx: Db, id: number, fotos: { name: string; data: string }[], art: 'VORHER' | 'NACHHER', ich: Ich): Promise<string> {
  const [m] = await tx`select nummer, (select count(*)::int from tco.ih_anhang where meldung_id = ${id}) as n from tco.ih_meldung where id = ${id}`;
  if (!m) throw new BusinessError('Meldung nicht gefunden.', 404);
  if (!fotos.length) throw new BusinessError('Bitte mindestens ein Foto wählen.');
  if (m.n + fotos.length > 10) throw new BusinessError('Höchstens 10 Fotos je Meldung.');
  for (const f of fotos) {
    let foto: { mime: string; daten: Buffer };
    try { foto = fotoLesen(f.data); } catch (e) { throw new BusinessError((e as Error).message); }
    await tx`insert into tco.ih_anhang (meldung_id, art, name, mime, daten, groesse, von) values (${id}, ${art}, ${f.name.slice(0, 120) || 'foto'}, ${foto.mime}, ${foto.daten}, ${foto.daten.length}, ${ich.name})`;
  }
  await protokoll(tx, id, ich, 'FOTO', `${fotos.length} Foto${fotos.length === 1 ? '' : 's'} (${art === 'NACHHER' ? 'nach der Reparatur' : 'Schaden'}) angehängt`, { fuerMelder: art === 'NACHHER' });
  return `${fotos.length} Foto${fotos.length === 1 ? '' : 's'} an ${m.nummer} angehängt.`;
}

export async function fotoLoeschen(tx: Db, fotoId: number, ich: Ich): Promise<string> {
  const [r] = await tx`delete from tco.ih_anhang where id = ${fotoId} returning name, meldung_id`;
  if (!r) throw new BusinessError('Foto nicht gefunden.', 404);
  await protokoll(tx, r.meldung_id, ich, 'FOTO_GELOESCHT', `Foto „${r.name}“ gelöscht`);
  return `Foto „${r.name}“ gelöscht.`;
}

/** Foto ausliefern: Bearbeiter oder der Melder selbst */
export async function fotoLesenDb(db: Db, fotoId: number, darfAlle: boolean, userId: string | null) {
  const [f] = await db`select f.mime, f.daten, m.melder_id from tco.ih_anhang f join tco.ih_meldung m on m.id = f.meldung_id where f.id = ${fotoId}`;
  if (!f || (!darfAlle && (!userId || f.melder_id !== userId))) throw new BusinessError('Foto nicht gefunden.', 404);
  return { mime: f.mime as string, daten: f.daten as Buffer };
}

/** Fotos einer Meldung mit Inhalt (Formular) */
export async function fotosMitDaten(db: Db, id: number) {
  return (await db`select id, art, name, mime, daten, am, von from tco.ih_anhang where meldung_id = ${id} order by art desc, id`)
    .map((f) => ({ id: f.id as number, art: f.art as string, name: f.name as string, mime: f.mime as string, daten: f.daten as Buffer, am: f.am as Date, von: f.von as string }));
}

// ---------------------------------------------------------------- Paperless-Dokumente

export interface DokumentInfo { doc_id: number; titel: string; korrespondent: string; datum: string | null }

/** Dokumente einer Meldung, je mit den FI-Buchungen, denen dasselbe Paperless-Dokument zugeordnet ist */
export async function dokumenteLesen(db: Db, id: number) {
  return db`
    select d.doc_id, d.art, d.titel, d.korrespondent, d.datum::text as datum, d.am, d.von,
           coalesce((select array_agg(distinct p.internenr order by p.internenr) from tco.fipapermap p where ltrim(p.doknr, '0') = d.doc_id::text), '{}') as fi
      from tco.ih_dokument d where d.meldung_id = ${id} order by d.am, d.doc_id`;
}

/** Ist das Dokument mit einer Meldung verknüpft (Voraussetzung für die Anzeige über die Instandhaltung)? */
export async function dokumentVerknuepft(db: Db, docId: number): Promise<boolean> {
  const [r] = await db`select 1 from tco.ih_dokument where doc_id = ${docId} limit 1`;
  return !!r;
}

export async function dokumenteVerknuepfen(tx: Db, id: number, docs: DokumentInfo[], art: DokArt, ich: Ich): Promise<string> {
  const [m] = await tx`select nummer from tco.ih_meldung where id = ${id}`;
  if (!m) throw new BusinessError('Meldung nicht gefunden.', 404);
  if (!(art in DOK_ARTEN)) throw new BusinessError('Unbekannte Dokumentart.');
  let n = 0;
  for (const d of docs) {
    const r = await tx`insert into tco.ih_dokument (meldung_id, doc_id, art, titel, korrespondent, datum, von)
                       values (${id}, ${d.doc_id}, ${art}, ${d.titel}, ${d.korrespondent}, ${d.datum}, ${ich.name})
                       on conflict (meldung_id, doc_id) do update set art = excluded.art, titel = excluded.titel, korrespondent = excluded.korrespondent`;
    if (r.count) n++;
    await protokoll(tx, id, ich, 'DOKUMENT', `Paperless ${String(d.doc_id).padStart(6, '0')} (${DOK_ARTEN[art]}): ${d.titel || '–'}${d.korrespondent ? ` · ${d.korrespondent}` : ''}`);
  }
  return `${n} Dokument${n === 1 ? '' : 'e'} mit ${m.nummer} verknüpft.`;
}

export async function dokumentLoesen(tx: Db, id: number, docId: number, ich: Ich): Promise<string> {
  const [r] = await tx`delete from tco.ih_dokument where meldung_id = ${id} and doc_id = ${docId} returning titel`;
  if (!r) throw new BusinessError('Dokument ist nicht verknüpft.', 404);
  await protokoll(tx, id, ich, 'DOKUMENT_GELOEST', `Paperless ${String(docId).padStart(6, '0')}: ${r.titel || '–'}`);
  return `Verknüpfung zu Dokument ${docId} gelöst.`;
}

// ---------------------------------------------------------------- Platzsperre

const SPERRE_TAGE = 365;

/** Platz bis auf Weiteres sperren (feste Belegung „Gesperrt“ ab heute ganztägig) */
export async function sperreSetzen(tx: Db, id: number, ich: Ich): Promise<string> {
  const m = await kopfLesen(tx, id);
  if (!m.platz_id) throw new BusinessError(`„${m.anlage}“ ist mit keinem Platz der Platzbuchung verknüpft (Instandhaltung → Stammdaten).`);
  if (m.sperre_id) throw new BusinessError(`${m.platz} ist für diese Meldung bereits gesperrt.`);
  const h = heute();
  const s = await festeSpeichern(tx, null, {
    bezeichnung: `Schaden: ${m.kategorie}`.slice(0, 80), art: 'SPERRE', plaetze: [m.platz_id as number], wochentage: '1234567',
    datum_von: h, datum_bis: addTage(h, SPERRE_TAGE), zeit_von: '00:00', zeit_bis: '24:00', hinweis: `${m.nummer}: ${kurz(String(m.beschreibung), 200)}`, aktiv: true,
  });
  await tx`update tco.ih_meldung set sperre_id = ${s.id}, geaendert_am = now(), geaendert_von = ${ich.name} where id = ${id}`;
  await protokoll(tx, id, ich, 'SPERRE', `${m.platz} in der Platzbuchung gesperrt (ab ${dat(h)}, bis auf Weiteres)`, { fuerMelder: true });
  return `${m.platz} ist ab heute bis auf Weiteres gesperrt.`;
}

/** Sperre beenden: ab heute wieder buchbar (heute angelegte Sperre wird gelöscht) */
export async function sperreAufheben(tx: Db, id: number, ich: Ich): Promise<string> {
  const m = await kopfLesen(tx, id);
  if (!m.sperre_id) throw new BusinessError('Für diese Meldung ist kein Platz gesperrt.');
  const h = heute();
  if (!m.sperre_von || m.sperre_von >= h) await festeLoeschen(tx, m.sperre_id as number);
  else await tx`update tco.platzbelegungen set datum_bis = ${addTage(h, -1)} where id = ${m.sperre_id}`;
  await tx`update tco.ih_meldung set sperre_id = null, geaendert_am = now(), geaendert_von = ${ich.name} where id = ${id}`;
  await protokoll(tx, id, ich, 'SPERRE_AUF', `Sperre von ${m.platz} aufgehoben – ab heute wieder buchbar`, { fuerMelder: true });
  return `${m.platz} ist ab heute wieder buchbar.`;
}

// ---------------------------------------------------------------- Benachrichtigungen

export function mailDetails(m: Record<string, unknown>): string {
  return [
    `Meldung:    ${m.nummer}`, `Wo:         ${m.anlage}`, `Kategorie:  ${m.kategorie}`,
    `Auswirkung: ${AUSWIRKUNG[m.auswirkung as Auswirkung]}`, `Gemeldet:   ${m.melder_name}`, '', String(m.beschreibung),
  ].join('\n');
}

/** neue Meldung: alle Zuständigen (Ort/Kategorie, sonst Vorstand); Sicherheitsrisiko zusätzlich immer an den Vorstand */
export async function mailsNeu(db: Db, id: number): Promise<Mail[]> {
  const m = await kopfLesen(db, id);
  const cfg = await einstellungenLesen(db);
  const zust = (await zustaendigeFuer(db, m.anlage_id as number, m.kategorie_id as number)).map((z) => z.email);
  const sicher = m.auswirkung === 'SICHERHEIT';
  const an = empfaenger(...zust, sicher || !empfaenger(...zust).length ? cfg.vorstand_email : '');
  if (!an.length) return [];
  return [{
    an: an.join(', '), objekt: String(m.nummer), meldung_id: id,
    betreff: `${sicher ? '⚠ SICHERHEITSRISIKO – ' : ''}Neuer Schaden ${m.nummer}: ${m.anlage} – ${m.kategorie}`,
    text: `Neue Schadensmeldung im Vereinsportal${sicher ? ' – bitte umgehend prüfen und ggf. absperren!' : '.'}\n\n${mailDetails(m)}\n\n`
      + `${m.fotos ? `${m.fotos} Foto(s) im Portal.\n\n` : ''}Zur Meldung: {portal}/tco/instandhaltung?id=${id}`,
  }];
}

/** stündlicher Lauf: Erinnerung bei Sicherheitsrisiko ohne Reaktion (24 h), Fotos erledigter Meldungen nach Frist löschen */
export async function lauf(tx: Db, jetzt = new Date()): Promise<{ mails: Mail[]; erinnert: string[]; fotosGeloescht: number }> {
  const sys: Ich = { id: null, name: 'system' };
  const cfg = await einstellungenLesen(tx);
  const kandidaten = await tx`select id, auswirkung, status, status_am, erinnert_am from tco.ih_meldung
                               where auswirkung = 'SICHERHEIT' and status = any(${STATUS_OFFEN})`;
  const mails: Mail[] = [];
  const erinnert: string[] = [];
  for (const k of kandidaten) {
    if (!eskalationFaellig(k as never, jetzt)) continue;
    const m = await kopfLesen(tx, k.id);
    await tx`update tco.ih_meldung set erinnert_am = ${jetzt} where id = ${k.id}`;
    await protokoll(tx, k.id, sys, 'ERINNERUNG', 'Sicherheitsrisiko seit über 24 Stunden ohne Statuswechsel – Erinnerung an Zuständige und Vorstand');
    erinnert.push(String(m.nummer));
    const an = empfaenger(m.zustaendig_email as string | null, cfg.vorstand_email);
    if (an.length) {
      mails.push({
        an: an.join(', '), objekt: String(m.nummer), meldung_id: k.id, betreff: `⚠ ERINNERUNG Sicherheitsrisiko ${m.nummer}: ${m.anlage} – ${m.kategorie}`,
        text: `Die Meldung ${m.nummer} ist ein Sicherheitsrisiko und seit über 24 Stunden unverändert (Status „${STATUS[m.status as Status]}“).\n\n`
          + `${mailDetails(m)}\n\nZur Meldung: {portal}/tco/instandhaltung?id=${k.id}`,
      });
    }
  }
  const geloescht = await tx`
    delete from tco.ih_anhang f using tco.ih_meldung m
     where m.id = f.meldung_id and m.erledigt_am is not null and m.status <> all(${STATUS_OFFEN})
       and m.erledigt_am < ${jetzt}::timestamptz - make_interval(months => ${cfg.foto_frist_monate})
    returning f.meldung_id`;
  const je = new Map<number, number>();
  for (const g of geloescht) je.set(g.meldung_id, (je.get(g.meldung_id) ?? 0) + 1);
  for (const [mid, n] of je) await protokoll(tx, mid, sys, 'FOTOFRIST', `${n} Foto${n === 1 ? '' : 's'} nach Ablauf der Frist (${cfg.foto_frist_monate} Monate) gelöscht`);
  return { mails, erinnert, fotosGeloescht: geloescht.length };
}

// ---------------------------------------------------------------- Vereinsübersicht

/** Einträge für den Arbeitsvorrat (Bereich „Instandhaltung“): jede offene Meldung einzeln */
export async function aufgaben(db: Db) {
  const rows = await db`${KOPF(db)} where m.status = any(${STATUS_OFFEN})
    order by case m.auswirkung when 'SICHERHEIT' then 0 else 1 end, ${PRIO_ORDER(db)}, m.eingang`;
  const h = heute();
  return rows.map((m) => {
    const spaet = ueberfaellig({ status: m.status, geplant_bis: m.geplant_bis }, h);
    const teile = [kurz(String(m.beschreibung), 100), `Priorität ${PRIORITAET[m.prioritaet as Prioritaet] ?? m.prioritaet}`, `gemeldet von ${m.melder_name}`, STATUS[m.status as Status]];
    if (m.geplant_bis) teile.push(`${spaet ? 'überfällig seit' : 'geplant bis'} ${dat(m.geplant_bis)}`);
    if (m.zustaendig_name) teile.push(`zuständig: ${m.zustaendig_name}`);
    if (m.sperre_id) teile.push(`${m.platz} gesperrt`);
    return {
      key: `SCHADEN:${m.id}`, bereich: 'Instandhaltung',
      icon: m.auswirkung === 'SICHERHEIT' ? 'alert' : m.sperre_id ? 'locked' : 'technical-object',
      state: spaet && aufgabeState(String(m.auswirkung)) === 'Information' ? 'Critical' as const : aufgabeState(String(m.auswirkung)),
      titel: `${m.auswirkung === 'SICHERHEIT' ? 'Sicherheitsrisiko' : 'Schaden'}: ${m.anlage} – ${m.kategorie}`,
      text: teile.join(' · '),
      datum: new Date(m.eingang as string).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }),
      pfad: `/tco/instandhaltung?id=${m.id}`,
    };
  });
}

/** Kennzahlen der Vereinsübersicht: offene Schäden, Sicherheitsrisiken, gesperrte Plätze */
export async function kennzahlen(db: Db) {
  const [r] = await db`
    select count(*)::int as offen,
           count(*) filter (where auswirkung = 'SICHERHEIT')::int as sicher,
           count(*) filter (where status = 'NEU')::int as neu,
           count(distinct sperre_id)::int as gesperrt,
           count(*) filter (where geplant_bis < (now() at time zone 'Europe/Berlin')::date)::int as ueberfaellig,
           to_char(min(eingang) at time zone 'Europe/Berlin', 'YYYY-MM-DD') as aeltester
      from tco.ih_meldung where status = any(${STATUS_OFFEN})`;
  const [j] = await db`select count(*)::int as n, coalesce(sum(kosten), 0)::float8 as kosten from tco.ih_meldung
                        where status = 'ERLEDIGT' and erledigt_am >= date_trunc('year', now())`;
  return {
    offen: Number(r.offen), sicher: Number(r.sicher), neu: Number(r.neu), gesperrt: Number(r.gesperrt), ueberfaellig: Number(r.ueberfaellig),
    erledigtJahr: Number(j.n), kostenJahr: Number(j.kosten), aeltester: r.aeltester ? dat(r.aeltester) : null,
  };
}
