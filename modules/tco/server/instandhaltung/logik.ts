/**
 * Instandhaltung / Schadensmeldung (#205): Datenzugriff und Abläufe.
 *
 * Mitglieder melden Schäden (App „Schaden melden“, auch per QR-Code an der Anlage), Platzwart/Hallenwart/Vorstand bearbeiten
 * sie in der App „Instandhaltung“. Offene Meldungen stehen im Arbeitsvorrat der Vereinsübersicht (dashboard/arbeitsvorrat.ts),
 * die Kachel „Offene Schäden“ in den Kennzahlen. E-Mails werden hier nur zusammengestellt – versendet wird in routes.ts.
 */
import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import { addTage, dat, heute } from '../format.js';
import { festeLoeschen, festeSpeichern } from '../platz/belegungen.js';
import {
  ANLAGE_TYPEN, AUSWIRKUNG, aufgabeState, empfaenger, eskalationFaellig, fotoLesen, istOffen, kurz, meldungsNummer, STATUS, STATUS_OFFEN,
  wechselFehler, type AnlageTyp, type Auswirkung, type Status,
} from './regeln.js';

export const P_IH = {
  melden: 'tco.schaden:melden',
  display: 'tco.instandhaltung:display',
  edit: 'tco.instandhaltung:edit',
  admin: 'tco.instandhaltung:admin',
};

/** Zusammengestellte E-Mail (Versand in routes.ts) */
export interface Mail { an: string; betreff: string; text: string; objekt: string }
export interface Ich { id: string | null; name: string }

// ---------------------------------------------------------------- Stammdaten

export interface Anlage { id: number; kuerzel: string; bezeichnung: string; typ: AnlageTyp; platz_id: number | null; platz: string | null; sort: number; aktiv: boolean }
export interface Kategorie { id: number; bezeichnung: string; zustaendig: string | null; zustaendig_name: string | null; sort: number; aktiv: boolean }

export async function anlagenLesen(db: Db, nurAktiv = false): Promise<Anlage[]> {
  return (await db`
    select a.id, a.kuerzel, a.bezeichnung, a.typ, a.platz_id, p.name as platz, a.sort, a.aktiv
      from tco.ih_anlage a left join tco.plaetze p on p.id = a.platz_id
     where ${!nurAktiv} or a.aktiv
     order by a.sort, a.bezeichnung`) as unknown as Anlage[];
}

export async function kategorienLesen(db: Db, nurAktiv = false): Promise<Kategorie[]> {
  return (await db`
    select k.id, k.bezeichnung, k.zustaendig, u.display_name as zustaendig_name, k.sort, k.aktiv
      from tco.ih_kategorie k left join core.users u on u.id = k.zustaendig
     where ${!nurAktiv} or k.aktiv
     order by k.sort, k.bezeichnung`) as unknown as Kategorie[];
}

export async function einstellungenLesen(db: Db): Promise<{ vorstand_email: string; foto_frist_monate: number }> {
  const [e] = await db`select vorstand_email, foto_frist_monate from tco.ih_einstellungen where id = 1`;
  return { vorstand_email: e?.vorstand_email ?? '', foto_frist_monate: Number(e?.foto_frist_monate ?? 24) };
}

/** Benutzer, die Meldungen bearbeiten dürfen (Auswahl Zuständiger) */
export async function bearbeiterLesen(db: Db): Promise<{ id: string; name: string; email: string | null }[]> {
  return (await db`
    select distinct u.id, u.display_name as name, u.email
      from core.users u
      join core.user_roles ur on ur.user_id = u.id
      join core.role_permissions rp on rp.role_id = ur.role_id
     where u.active and rp.permission in (${P_IH.edit}, '*')
     order by 2`) as unknown as { id: string; name: string; email: string | null }[];
}

export interface AnlageEingabe { kuerzel: string; bezeichnung: string; typ: AnlageTyp; platz_id: number | null; sort: number; aktiv: boolean }
export async function anlageSichern(tx: Db, id: number | null, e: AnlageEingabe): Promise<{ id: number; text: string }> {
  const kuerzel = e.kuerzel.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,29}$/.test(kuerzel)) throw new BusinessError('Kürzel: nur Kleinbuchstaben, Ziffern, „-“ und „_“ (höchstens 30 Zeichen) – es steht im QR-Link.');
  if (!(e.typ in ANLAGE_TYPEN)) throw new BusinessError('Unbekannter Anlagentyp.');
  const [dop] = await tx`select id from tco.ih_anlage where lower(kuerzel) = ${kuerzel} and id is distinct from ${id}`;
  if (dop) throw new BusinessError(`Das Kürzel „${kuerzel}“ ist schon vergeben.`);
  if (e.platz_id) {
    const [p] = await tx`select 1 from tco.plaetze where id = ${e.platz_id}`;
    if (!p) throw new BusinessError('Der gewählte Platz existiert nicht.');
  }
  const werte = { kuerzel, bezeichnung: e.bezeichnung.trim(), typ: e.typ, platz_id: e.platz_id ?? null, sort: e.sort, aktiv: e.aktiv };
  if (id) {
    const r = await tx`update tco.ih_anlage set ${tx(werte)} where id = ${id}`;
    if (!r.count) throw new BusinessError('Anlage nicht gefunden.', 404);
    return { id, text: `Anlage „${werte.bezeichnung}“ gesichert.` };
  }
  const [r] = await tx`insert into tco.ih_anlage ${tx(werte)} returning id`;
  return { id: r.id, text: `Anlage „${werte.bezeichnung}“ angelegt.` };
}

export interface KategorieEingabe { bezeichnung: string; zustaendig: string | null; sort: number; aktiv: boolean }
export async function kategorieSichern(tx: Db, id: number | null, e: KategorieEingabe): Promise<{ id: number; text: string }> {
  const bezeichnung = e.bezeichnung.trim();
  const [dop] = await tx`select id from tco.ih_kategorie where lower(bezeichnung) = lower(${bezeichnung}) and id is distinct from ${id}`;
  if (dop) throw new BusinessError(`Die Kategorie „${bezeichnung}“ gibt es schon.`);
  if (e.zustaendig) {
    const [u] = await tx`select 1 from core.users where id = ${e.zustaendig}`;
    if (!u) throw new BusinessError('Der zuständige Benutzer existiert nicht.');
  }
  const werte = { bezeichnung, zustaendig: e.zustaendig ?? null, sort: e.sort, aktiv: e.aktiv };
  if (id) {
    const r = await tx`update tco.ih_kategorie set ${tx(werte)} where id = ${id}`;
    if (!r.count) throw new BusinessError('Kategorie nicht gefunden.', 404);
    return { id, text: `Kategorie „${bezeichnung}“ gesichert.` };
  }
  const [r] = await tx`insert into tco.ih_kategorie ${tx(werte)} returning id`;
  return { id: r.id, text: `Kategorie „${bezeichnung}“ angelegt.` };
}

export async function einstellungenSichern(tx: Db, e: { vorstand_email: string; foto_frist_monate: number }): Promise<string> {
  const liste = e.vorstand_email.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  const ok = empfaenger(e.vorstand_email);
  if (liste.some((x) => !empfaenger(x).length)) throw new BusinessError('Bitte gültige E-Mail-Adressen angeben (mehrere mit Komma trennen).');
  await tx`update tco.ih_einstellungen set vorstand_email = ${ok.join(', ')}, foto_frist_monate = ${e.foto_frist_monate} where id = 1`;
  return 'Einstellungen gesichert.';
}

// ---------------------------------------------------------------- Melden

export interface MeldungEingabe { anlage_id: number; kategorie_id: number; beschreibung: string; auswirkung: Auswirkung; fotos: { name: string; data: string }[] }

export async function meldungAnlegen(tx: Db, d: MeldungEingabe, ich: Ich): Promise<{ id: number; nummer: string; text: string }> {
  const [a] = await tx`select id, bezeichnung from tco.ih_anlage where id = ${d.anlage_id} and aktiv`;
  if (!a) throw new BusinessError('Bitte den Ort / die Anlage wählen.');
  const [k] = await tx`select id, zustaendig from tco.ih_kategorie where id = ${d.kategorie_id} and aktiv`;
  if (!k) throw new BusinessError('Bitte eine Kategorie wählen.');
  if (!d.beschreibung.trim()) throw new BusinessError('Bitte kurz beschreiben, was kaputt ist.');
  if (d.fotos.length > 3) throw new BusinessError('Höchstens 3 Fotos.');
  const fotos = d.fotos.map((f) => {
    try { return { name: f.name.slice(0, 120) || 'foto', ...fotoLesen(f.data) }; } catch (e) { throw new BusinessError((e as Error).message); }
  });
  const [r] = await tx`
    insert into tco.ih_meldung (nummer, anlage_id, kategorie_id, beschreibung, auswirkung, melder_id, melder_name, zustaendig)
    values ('neu-' || gen_random_uuid()::text, ${a.id}, ${k.id}, ${d.beschreibung.trim()}, ${d.auswirkung}, ${ich.id}, ${ich.name}, ${k.zustaendig ?? null})
    returning id, extract(year from eingang at time zone 'Europe/Berlin')::int as jahr`;
  const nummer = meldungsNummer(r.jahr, r.id);
  await tx`update tco.ih_meldung set nummer = ${nummer} where id = ${r.id}`;
  await tx`insert into tco.ih_verlauf (meldung_id, von, status, text) values (${r.id}, ${ich.name}, 'NEU', 'Schaden gemeldet')`;
  for (const f of fotos) {
    await tx`insert into tco.ih_anhang (meldung_id, art, name, mime, daten, groesse, von) values (${r.id}, 'VORHER', ${f.name}, ${f.mime}, ${f.daten}, ${f.daten.length}, ${ich.name})`;
  }
  return { id: r.id, nummer, text: `Danke! Deine Meldung ${nummer} ist eingegangen – die Zuständigen sind informiert.` };
}

/** bereits offene Meldungen an einer Anlage (gegen Doppelmeldungen; ohne Melder) */
export async function offeneZurAnlage(db: Db, anlageId: number) {
  return db`
    select m.id, m.nummer, k.bezeichnung as kategorie, m.beschreibung, m.auswirkung, m.status,
           to_char(m.eingang at time zone 'Europe/Berlin', 'YYYY-MM-DD') as eingang
      from tco.ih_meldung m join tco.ih_kategorie k on k.id = m.kategorie_id
     where m.anlage_id = ${anlageId} and m.status = any(${STATUS_OFFEN})
     order by m.eingang desc`;
}

/** „Meine Meldungen“: eigene Meldungen mit dem für Melder sichtbaren Verlauf */
export async function meineLesen(db: Db, userId: string) {
  const zeilen = await db`
    select m.id, m.nummer, a.bezeichnung as anlage, k.bezeichnung as kategorie, m.beschreibung, m.auswirkung, m.status, m.eingang,
           m.erledigung, m.erledigt_am
      from tco.ih_meldung m join tco.ih_anlage a on a.id = m.anlage_id join tco.ih_kategorie k on k.id = m.kategorie_id
     where m.melder_id = ${userId}
     order by m.eingang desc limit 100`;
  if (!zeilen.length) return [];
  const ids = zeilen.map((z) => z.id as number);
  const verlauf = await db`select meldung_id, am, von, status, text from tco.ih_verlauf where meldung_id = any(${ids}) and fuer_melder order by am`;
  const fotos = await db`select id, meldung_id, art from tco.ih_anhang where meldung_id = any(${ids}) order by id`;
  return zeilen.map((z) => ({
    ...z, status_txt: STATUS[z.status as Status], auswirkung_txt: AUSWIRKUNG[z.auswirkung as Auswirkung],
    verlauf: verlauf.filter((v) => v.meldung_id === z.id).map(({ meldung_id: _m, ...v }) => ({ ...v, status_txt: v.status ? STATUS[v.status as Status] : null })),
    fotos: fotos.filter((f) => f.meldung_id === z.id).map((f) => ({ id: f.id, art: f.art })),
  }));
}

// ---------------------------------------------------------------- Bearbeiten

const KOPF = (db: Db) => db`
  select m.id, m.nummer, m.anlage_id, a.bezeichnung as anlage, a.platz_id, p.name as platz, m.kategorie_id, k.bezeichnung as kategorie,
         m.beschreibung, m.auswirkung, m.status, m.eingang, m.melder_id, m.melder_name, mu.email as melder_email,
         m.zustaendig, zu.display_name as zustaendig_name, zu.email as zustaendig_email,
         m.duplikat_von, d.nummer as duplikat_nummer, m.erledigung, m.kosten::float8 as kosten, m.firma, m.paperless, m.stunden::float8 as stunden,
         m.sperre_id, s.datum_von::text as sperre_von, s.datum_bis::text as sperre_bis,
         m.status_am, m.erinnert_am, m.erledigt_am, m.geaendert_am, m.geaendert_von,
         (select count(*)::int from tco.ih_anhang x where x.meldung_id = m.id) as fotos
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
});

export async function listeLesen(db: Db, filter: 'OFFEN' | 'ALLE') {
  const rows = await db`${KOPF(db)}
    where ${filter === 'ALLE'} or m.status = any(${STATUS_OFFEN})
    order by case m.auswirkung when 'SICHERHEIT' then 0 when 'UNBESPIELBAR' then 1 else 2 end, m.eingang desc
    limit 500`;
  return rows.map(mitTexten);
}

export async function kopfLesen(db: Db, id: number) {
  const [m] = await db`${KOPF(db)} where m.id = ${id}`;
  if (!m) throw new BusinessError('Meldung nicht gefunden.', 404);
  return mitTexten(m);
}

export async function detailLesen(db: Db, id: number) {
  const m = await kopfLesen(db, id);
  const verlauf = await db`select id, am, von, status, text, fuer_melder from tco.ih_verlauf where meldung_id = ${id} order by am, id`;
  const fotos = await db`select id, art, name, groesse, am, von from tco.ih_anhang where meldung_id = ${id} order by id`;
  // betroffene kommende Buchungen auf dem Platz (nur Anzeige, keine automatische Stornierung)
  const buchungen = m.platz && (m.sperre_id || m.auswirkung === 'UNBESPIELBAR' || m.auswirkung === 'SICHERHEIT') ? await db`
    select distinct b.datum::text as datum, to_char(b.time_start, 'HH24:MI') as von, to_char(b.time_ende, 'HH24:MI') as bis, coalesce(nullif(b.kunde, ''), 'Buchung') as kunde
      from tco.bookings b
     where upper(b.platz) = upper(${m.platz}) and b.datum >= ${heute()} and coalesce(b.status, '') not in ('2', '4')
     order by 1, 2 limit 50` : [];
  return {
    ...m,
    verlauf: verlauf.map((v) => ({ ...v, status_txt: v.status ? STATUS[v.status as Status] : null })),
    fotos, buchungen,
  };
}

export interface BearbeitenEingabe {
  status: Status; zustaendig: string | null; duplikat_von: number | null; erledigung: string | null;
  kosten: number | null; firma: string | null; paperless: string | null; stunden: number | null;
  /** Kommentar zum Statuswechsel */
  kommentar: string | null; fuer_melder: boolean;
}

/** Bearbeiten: Status, Zuständiger, Kosten … Liefert die Mails an Melder (bei Abschluss) und neuen Zuständigen. */
export async function bearbeiten(tx: Db, id: number, e: BearbeitenEingabe, wer: string): Promise<{ text: string; mails: Mail[] }> {
  const [alt] = await tx`select * from tco.ih_meldung where id = ${id} for update`;
  if (!alt) throw new BusinessError('Meldung nicht gefunden.', 404);
  const fehler = wechselFehler(alt.status, e.status, { duplikatVon: e.duplikat_von, erledigung: e.erledigung });
  if (fehler) throw new BusinessError(fehler);
  if (e.duplikat_von) {
    if (e.duplikat_von === id) throw new BusinessError('Eine Meldung kann kein Duplikat von sich selbst sein.');
    const [d] = await tx`select 1 from tco.ih_meldung where id = ${e.duplikat_von}`;
    if (!d) throw new BusinessError('Die Ursprungsmeldung gibt es nicht.');
  }
  if (e.zustaendig) {
    const [u] = await tx`select 1 from core.users where id = ${e.zustaendig}`;
    if (!u) throw new BusinessError('Der zuständige Benutzer existiert nicht.');
  }
  // Zugewiesen ohne Zuständigen ergibt keinen Sinn
  if (e.status === 'ZUGEWIESEN' && !e.zustaendig) throw new BusinessError('Bitte einen Zuständigen wählen.');
  const statusNeu = alt.status !== e.status;
  const ende = !istOffen(e.status);
  await tx`
    update tco.ih_meldung set status = ${e.status}, zustaendig = ${e.zustaendig}, duplikat_von = ${e.status === 'DUPLIKAT' ? e.duplikat_von : null},
           erledigung = ${e.erledigung?.trim() || null}, kosten = ${e.kosten}, firma = ${e.firma?.trim() || null}, paperless = ${e.paperless?.trim() || null},
           stunden = ${e.stunden},
           status_am = case when ${statusNeu} then now() else status_am end,
           erledigt_am = case when ${ende} then coalesce(case when ${statusNeu} then null else erledigt_am end, now()) else null end,
           geaendert_am = now(), geaendert_von = ${wer}
     where id = ${id}`;
  const notiz = e.kommentar?.trim() || (statusNeu && ende && e.erledigung?.trim()) || null;
  if (statusNeu || notiz) {
    await tx`insert into tco.ih_verlauf (meldung_id, von, status, text, fuer_melder)
             values (${id}, ${wer}, ${statusNeu ? e.status : null}, ${notiz}, ${statusNeu ? true : e.fuer_melder})`;
  }
  const m = await kopfLesen(tx, id);
  const mails: Mail[] = [];
  const link = `/tco/instandhaltung?id=${id}`;
  if (statusNeu && ende && m.melder_email) {
    const was = e.status === 'ERLEDIGT' ? 'ist erledigt' : e.status === 'ABGELEHNT' ? 'wurde abgelehnt' : `ist bereits bekannt (${m.duplikat_nummer})`;
    mails.push({
      an: m.melder_email, objekt: m.nummer, betreff: `Deine Schadensmeldung ${m.nummer} ${was}`,
      text: `Hallo ${m.melder_name},\n\ndeine Meldung ${m.nummer} (${m.anlage} – ${m.kategorie}) ${was}.\n`
        + `${m.erledigung ? `\n${m.erledigung}\n` : ''}\nDanke fürs Melden!\n\nDen Verlauf siehst du im Vereinsportal unter „Schaden melden“ → „Meine Meldungen“.`,
    });
  }
  if (e.zustaendig && e.zustaendig !== alt.zustaendig && m.zustaendig_email) {
    mails.push({
      an: m.zustaendig_email, objekt: m.nummer, betreff: `Schaden ${m.nummer} dir zugewiesen: ${m.anlage} – ${m.kategorie}`,
      text: `Hallo ${m.zustaendig_name},\n\n${wer} hat dir die Schadensmeldung ${m.nummer} zugewiesen.\n\n${mailDetails(m)}\n\nZur Meldung: {portal}${link}`,
    });
  }
  return { text: `${m.nummer} gesichert${statusNeu ? ` – Status „${STATUS[e.status]}“` : ''}.`, mails };
}

export async function kommentieren(tx: Db, id: number, text: string, fuerMelder: boolean, wer: string): Promise<string> {
  const [m] = await tx`select nummer from tco.ih_meldung where id = ${id}`;
  if (!m) throw new BusinessError('Meldung nicht gefunden.', 404);
  if (!text.trim()) throw new BusinessError('Bitte einen Text eingeben.');
  await tx`insert into tco.ih_verlauf (meldung_id, von, text, fuer_melder) values (${id}, ${wer}, ${text.trim()}, ${fuerMelder})`;
  await tx`update tco.ih_meldung set geaendert_am = now(), geaendert_von = ${wer} where id = ${id}`;
  return `Kommentar zu ${m.nummer} gesichert.`;
}

export async function fotosAnhaengen(tx: Db, id: number, fotos: { name: string; data: string }[], art: 'VORHER' | 'NACHHER', wer: string): Promise<string> {
  const [m] = await tx`select nummer, (select count(*)::int from tco.ih_anhang where meldung_id = ${id}) as n from tco.ih_meldung where id = ${id}`;
  if (!m) throw new BusinessError('Meldung nicht gefunden.', 404);
  if (!fotos.length) throw new BusinessError('Bitte mindestens ein Foto wählen.');
  if (m.n + fotos.length > 10) throw new BusinessError('Höchstens 10 Fotos je Meldung.');
  for (const f of fotos) {
    let foto: { mime: string; daten: Buffer };
    try { foto = fotoLesen(f.data); } catch (e) { throw new BusinessError((e as Error).message); }
    await tx`insert into tco.ih_anhang (meldung_id, art, name, mime, daten, groesse, von) values (${id}, ${art}, ${f.name.slice(0, 120) || 'foto'}, ${foto.mime}, ${foto.daten}, ${foto.daten.length}, ${wer})`;
  }
  return `${fotos.length} Foto${fotos.length === 1 ? '' : 's'} an ${m.nummer} angehängt.`;
}

export async function fotoLoeschen(tx: Db, fotoId: number): Promise<string> {
  const [r] = await tx`delete from tco.ih_anhang where id = ${fotoId} returning name`;
  if (!r) throw new BusinessError('Foto nicht gefunden.', 404);
  return `Foto „${r.name}“ gelöscht.`;
}

/** Foto ausliefern: Bearbeiter oder der Melder selbst */
export async function fotoLesenDb(db: Db, fotoId: number, darfAlle: boolean, userId: string | null) {
  const [f] = await db`select f.mime, f.daten, m.melder_id from tco.ih_anhang f join tco.ih_meldung m on m.id = f.meldung_id where f.id = ${fotoId}`;
  if (!f || (!darfAlle && (!userId || f.melder_id !== userId))) throw new BusinessError('Foto nicht gefunden.', 404);
  return { mime: f.mime as string, daten: f.daten as Buffer };
}

// ---------------------------------------------------------------- Platzsperre

const SPERRE_TAGE = 365;

/** Platz bis auf Weiteres sperren (feste Belegung „Gesperrt“ ab heute ganztägig) */
export async function sperreSetzen(tx: Db, id: number, wer: string): Promise<string> {
  const m = await kopfLesen(tx, id);
  if (!m.platz_id) throw new BusinessError(`„${m.anlage}“ ist mit keinem Platz der Platzbuchung verknüpft (Instandhaltung → Stammdaten).`);
  if (m.sperre_id) throw new BusinessError(`${m.platz} ist für diese Meldung bereits gesperrt.`);
  const h = heute();
  const s = await festeSpeichern(tx, null, {
    bezeichnung: `Schaden: ${m.kategorie}`.slice(0, 80), art: 'SPERRE', plaetze: [m.platz_id as number], wochentage: '1234567',
    datum_von: h, datum_bis: addTage(h, SPERRE_TAGE), zeit_von: '00:00', zeit_bis: '24:00', hinweis: `${m.nummer}: ${kurz(String(m.beschreibung), 200)}`, aktiv: true,
  });
  await tx`update tco.ih_meldung set sperre_id = ${s.id}, geaendert_am = now(), geaendert_von = ${wer} where id = ${id}`;
  await tx`insert into tco.ih_verlauf (meldung_id, von, text) values (${id}, ${wer}, ${`${m.platz} in der Platzbuchung gesperrt`})`;
  return `${m.platz} ist ab heute bis auf Weiteres gesperrt.`;
}

/** Sperre beenden: ab heute wieder buchbar (heute angelegte Sperre wird gelöscht) */
export async function sperreAufheben(tx: Db, id: number, wer: string): Promise<string> {
  const m = await kopfLesen(tx, id);
  if (!m.sperre_id) throw new BusinessError('Für diese Meldung ist kein Platz gesperrt.');
  const h = heute();
  if (!m.sperre_von || m.sperre_von >= h) await festeLoeschen(tx, m.sperre_id as number);
  else await tx`update tco.platzbelegungen set datum_bis = ${addTage(h, -1)} where id = ${m.sperre_id}`;
  await tx`update tco.ih_meldung set sperre_id = null, geaendert_am = now(), geaendert_von = ${wer} where id = ${id}`;
  await tx`insert into tco.ih_verlauf (meldung_id, von, text) values (${id}, ${wer}, ${`Sperre von ${m.platz} aufgehoben`})`;
  return `${m.platz} ist ab heute wieder buchbar.`;
}

// ---------------------------------------------------------------- Benachrichtigungen

function mailDetails(m: Record<string, unknown>): string {
  return [
    `Meldung:    ${m.nummer}`, `Ort:        ${m.anlage}`, `Kategorie:  ${m.kategorie}`,
    `Auswirkung: ${AUSWIRKUNG[m.auswirkung as Auswirkung]}`, `Gemeldet:   ${m.melder_name}`, '', String(m.beschreibung),
  ].join('\n');
}

/** neue Meldung: Zuständiger (sonst Vorstand); Sicherheitsrisiko zusätzlich immer an den Vorstand */
export async function mailsNeu(db: Db, id: number): Promise<Mail[]> {
  const m = await kopfLesen(db, id);
  const cfg = await einstellungenLesen(db);
  const sicher = m.auswirkung === 'SICHERHEIT';
  const an = empfaenger(m.zustaendig_email as string | null, sicher || !m.zustaendig_email ? cfg.vorstand_email : '');
  if (!an.length) return [];
  return [{
    an: an.join(', '), objekt: String(m.nummer),
    betreff: `${sicher ? '⚠ SICHERHEITSRISIKO – ' : ''}Neuer Schaden ${m.nummer}: ${m.anlage} – ${m.kategorie}`,
    text: `Neue Schadensmeldung im Vereinsportal${sicher ? ' – bitte umgehend prüfen und ggf. absperren!' : '.'}\n\n${mailDetails(m)}\n\n`
      + `${m.fotos ? `${m.fotos} Foto(s) im Portal.\n\n` : ''}Zur Meldung: {portal}/tco/instandhaltung?id=${id}`,
  }];
}

/** stündlicher Lauf: Erinnerung bei Sicherheitsrisiko ohne Reaktion (24 h), Fotos erledigter Meldungen nach Frist löschen */
export async function lauf(tx: Db, jetzt = new Date()): Promise<{ mails: Mail[]; erinnert: string[]; fotosGeloescht: number }> {
  const cfg = await einstellungenLesen(tx);
  const kandidaten = await tx`select id, auswirkung, status, status_am, erinnert_am from tco.ih_meldung
                               where auswirkung = 'SICHERHEIT' and status = any(${STATUS_OFFEN})`;
  const mails: Mail[] = [];
  const erinnert: string[] = [];
  for (const k of kandidaten) {
    if (!eskalationFaellig(k as never, jetzt)) continue;
    const m = await kopfLesen(tx, k.id);
    await tx`update tco.ih_meldung set erinnert_am = ${jetzt} where id = ${k.id}`;
    await tx`insert into tco.ih_verlauf (meldung_id, von, text, fuer_melder) values (${k.id}, 'system', 'Erinnerung: Sicherheitsrisiko seit über 24 Stunden ohne Statuswechsel', false)`;
    erinnert.push(String(m.nummer));
    const an = empfaenger(m.zustaendig_email as string | null, cfg.vorstand_email);
    if (an.length) {
      mails.push({
        an: an.join(', '), objekt: String(m.nummer), betreff: `⚠ ERINNERUNG Sicherheitsrisiko ${m.nummer}: ${m.anlage} – ${m.kategorie}`,
        text: `Die Meldung ${m.nummer} ist ein Sicherheitsrisiko und seit über 24 Stunden unverändert (Status „${STATUS[m.status as Status]}“).\n\n`
          + `${mailDetails(m)}\n\nZur Meldung: {portal}/tco/instandhaltung?id=${k.id}`,
      });
    }
  }
  const geloescht = await tx`
    delete from tco.ih_anhang f using tco.ih_meldung m
     where m.id = f.meldung_id and m.erledigt_am is not null and m.status <> all(${STATUS_OFFEN})
       and m.erledigt_am < ${jetzt}::timestamptz - make_interval(months => ${cfg.foto_frist_monate})`;
  return { mails, erinnert, fotosGeloescht: geloescht.count };
}

// ---------------------------------------------------------------- Vereinsübersicht

/** Einträge für den Arbeitsvorrat (Bereich „Instandhaltung“): jede offene Meldung einzeln */
export async function aufgaben(db: Db) {
  const rows = await db`${KOPF(db)} where m.status = any(${STATUS_OFFEN})
    order by case m.auswirkung when 'SICHERHEIT' then 0 when 'UNBESPIELBAR' then 1 else 2 end, m.eingang`;
  return rows.map((m) => {
    const teile = [kurz(String(m.beschreibung), 100), `gemeldet von ${m.melder_name}`, STATUS[m.status as Status]];
    if (m.zustaendig_name) teile.push(`zuständig: ${m.zustaendig_name}`);
    if (m.sperre_id) teile.push(`${m.platz} gesperrt`);
    return {
      key: `SCHADEN:${m.id}`, bereich: 'Instandhaltung',
      icon: m.auswirkung === 'SICHERHEIT' ? 'alert' : m.sperre_id ? 'locked' : 'technical-object',
      state: aufgabeState(String(m.auswirkung)),
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
           to_char(min(eingang) at time zone 'Europe/Berlin', 'YYYY-MM-DD') as aeltester
      from tco.ih_meldung where status = any(${STATUS_OFFEN})`;
  const [j] = await db`select count(*)::int as n, coalesce(sum(kosten), 0)::float8 as kosten from tco.ih_meldung
                        where status = 'ERLEDIGT' and erledigt_am >= date_trunc('year', now())`;
  return { ...r, erledigtJahr: j.n as number, kostenJahr: j.kosten as number, aeltester: r.aeltester ? dat(r.aeltester) : null };
}
