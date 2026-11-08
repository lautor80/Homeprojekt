import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import { addTage, condense, heute, runden } from '../format.js';

/**
 * Clubhaus-Verzehr: Mitglieder schreiben ihren Verzehr auf das eigene Konto an und zahlen gesammelt
 * zum Monatsende (Sammelabrechnung); Gäste zahlen am Abend an der Theke (Gastbeleg).
 * Preise: tco.produkte – Getränke 100–199 (Clubhausabrechnung), Speisen 200–299, Sonstiges 300–399,
 * optional ein eigener Gästepreis. Jede Position speichert Text und Preis als Momentaufnahme.
 *
 * Sicherheit: „Mein Verzehr“ arbeitet ausschließlich mit der Adressnummer des angemeldeten Benutzers;
 * die Theke sieht von Mitgliedern nur Namen; Stornos der Mitglieder nur innerhalb der Frist und nur solange
 * die Position noch nicht abgerechnet ist.
 */

export const RUBRIKEN = { G: 'Getränke', S: 'Speisen', X: 'Sonstiges' } as const;
export type Rubrik = keyof typeof RUBRIKEN;
const BEREICH: Record<Rubrik, [number, number]> = { G: [100, 199], S: [200, 299], X: [300, 399] };
export const ZAHLARTEN = ['BAR', 'KARTE', 'PAYPAL', 'UEBERWEISUNG', 'LASTSCHRIFT'] as const;
export type Zahlart = (typeof ZAHLARTEN)[number];
export const ZAHLART_TEXT: Record<Zahlart, string> = { BAR: 'Bar', KARTE: 'Karte', PAYPAL: 'PayPal', UEBERWEISUNG: 'Überweisung', LASTSCHRIFT: 'Lastschrift' };

export interface Produkt { prod_key: string; rubrik: Rubrik; text: string; preis: number; preis_gast: number | null; valid_from: string; valid_to: string }
export interface Cfg { mindestbetrag: number; zahlungsziel_tage: number; storno_stunden: number; erloeskonto: string; forderungskonto: string; info_text: string }
export interface Posten {
  id: number; datum: string; zeit: string; adrnr: string | null; rgnr: string | null; prod_key: string; text: string;
  anzahl: number; preis: number; betrag: number; selbst: boolean; erfasst_von: string | null; erfasst_am: string;
  storniert_am: string | null; storniert_von: string | null; storno_grund: string | null;
}
export interface Beleg {
  rgnr: string; art: 'GAST' | 'SAMMEL'; adrnr: string | null; gast_name: string | null; gast_gruppe: string | null; email: string | null; mobil: string | null;
  datum: string; monat: string | null; status: 'OFFEN' | 'GESTELLT' | 'BEZAHLT' | 'STORNIERT'; betrag: number; zahlart: Zahlart | null;
  faellig: string | null; bezahlt_am: string | null; doc_id: number | null; versand_am: string | null; versand_art: string | null;
  laufid: string | null; erstellt_von: string | null; bemerkung: string | null;
}

const rubrikVon = (key: string): Rubrik | null => {
  const n = Number(key);
  if (!/^\d{3}$/.test(key) || !Number.isFinite(n)) return null;
  for (const [r, [a, b]] of Object.entries(BEREICH)) if (n >= a && n <= b) return r as Rubrik;
  return null;
};
export const monatVon = (datum: string) => datum.slice(0, 7).replace('-', '');
export const monatsgrenzen = (monat: string) => {
  const j = Number(monat.slice(0, 4)), m = Number(monat.slice(4, 6));
  return { von: `${monat.slice(0, 4)}-${monat.slice(4, 6)}-01`, bis: new Date(Date.UTC(j, m, 0)).toISOString().slice(0, 10) };
};
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
export const monatsname = (monat: string) => `${MONATE[Number(monat.slice(4, 6)) - 1]} ${monat.slice(0, 4)}`;

// ---------------------------------------------------------------- Konfiguration

export async function cfgLesen(db: Db): Promise<Cfg> {
  const [c] = await db`select mindestbetrag::float8 as mindestbetrag, zahlungsziel_tage, storno_stunden, erloeskonto, forderungskonto, info_text from tco.vz_cfg where id = 1`;
  return c
    ? { ...(c as unknown as Cfg), mindestbetrag: Number(c.mindestbetrag) }
    : { mindestbetrag: 5, zahlungsziel_tage: 14, storno_stunden: 12, erloeskonto: '', forderungskonto: '', info_text: '' };
}

export async function cfgSpeichern(tx: Db, c: Cfg) {
  await tx`insert into tco.vz_cfg (id, mindestbetrag, zahlungsziel_tage, storno_stunden, erloeskonto, forderungskonto, info_text)
           values (1, ${c.mindestbetrag}, ${c.zahlungsziel_tage}, ${c.storno_stunden}, ${c.erloeskonto}, ${c.forderungskonto}, ${c.info_text})
           on conflict (id) do update set mindestbetrag = excluded.mindestbetrag, zahlungsziel_tage = excluded.zahlungsziel_tage,
             storno_stunden = excluded.storno_stunden, erloeskonto = excluded.erloeskonto, forderungskonto = excluded.forderungskonto, info_text = excluded.info_text`;
}

// ---------------------------------------------------------------- Preisliste

/** Preisliste zum Stichtag (alle Rubriken) */
export async function preislisteLesen(db: Db, stichtag = heute()): Promise<Produkt[]> {
  const rows = await db`select prod_key, text, coalesce(preis, 0)::float8 as preis, preis_gast::float8 as preis_gast,
                               to_char(valid_from, 'YYYY-MM-DD') as valid_from, to_char(valid_to, 'YYYY-MM-DD') as valid_to
                          from tco.produkte where length(prod_key) = 3 and prod_key >= '100' and prod_key <= '399'
                           and valid_from <= ${stichtag} and valid_to >= ${stichtag} and coalesce(preis, 0) > 0
                         order by prod_key`;
  return rows.flatMap((r) => {
    const rubrik = rubrikVon(r.prod_key);
    return rubrik ? [{ prod_key: r.prod_key, rubrik, text: condense(r.text ?? ''), preis: Number(r.preis), preis_gast: r.preis_gast == null ? null : Number(r.preis_gast), valid_from: r.valid_from, valid_to: r.valid_to }] : [];
  });
}

/** Speise/Sonstiges anlegen oder ab Stichtag neu bepreisen (Getränke: Clubhausabrechnung → Getränke) */
export async function produktSpeichern(tx: Db, d: { prod_key?: string | null; rubrik: Rubrik; text: string; preis: number; preis_gast: number | null; ab: string }) {
  const text = condense(d.text);
  if (!text) throw new BusinessError('Bitte eine Bezeichnung angeben.');
  if (d.preis <= 0) throw new BusinessError('Bitte einen Preis größer 0 angeben.');
  let key = d.prod_key ?? '';
  if (!key) {
    if (d.rubrik === 'G') throw new BusinessError('Getränke werden unter Clubhausabrechnung → Getränke angelegt.');
    const [a, b] = BEREICH[d.rubrik];
    const [n] = await tx`select coalesce(max(prod_key::int), ${a - 1}) + 1 as k from tco.produkte where length(prod_key) = 3 and prod_key >= ${String(a)} and prod_key <= ${String(b)}`;
    if (Number(n.k) > b) throw new BusinessError(`Für ${RUBRIKEN[d.rubrik]} sind alle Schlüssel vergeben.`);
    const [dup] = await tx`select 1 from tco.produkte where length(prod_key) = 3 and prod_key >= ${String(a)} and prod_key <= ${String(b)} and upper(trim(text)) = ${text.toUpperCase()}`;
    if (dup) throw new BusinessError(`„${text}“ gibt es bereits.`);
    key = String(n.k);
    await tx`insert into tco.produkte (prod_key, valid_from, valid_to, text, preis, preis_gast, typ, menge) values (${key}, ${d.ab}, '9999-12-31', ${text}, ${d.preis}, ${d.preis_gast}, ${d.rubrik}, '1')`;
    return key;
  }
  const [c] = await tx`select to_char(valid_from, 'YYYY-MM-DD') as valid_from, to_char(valid_to, 'YYYY-MM-DD') as valid_to, typ, menge
                         from tco.produkte where prod_key = ${key} and valid_from <= ${d.ab} and valid_to >= ${d.ab}`;
  if (!c) throw new BusinessError('Zum Stichtag ist kein Preis hinterlegt.');
  if (c.valid_from === d.ab) {
    await tx`update tco.produkte set text = ${text}, preis = ${d.preis}, preis_gast = ${d.preis_gast} where prod_key = ${key} and valid_from = ${c.valid_from} and valid_to = ${c.valid_to}`;
    return key;
  }
  if (d.ab < heute()) throw new BusinessError('Eine Preisänderung gilt frühestens ab heute.');
  await tx`update tco.produkte set valid_to = ${addTage(d.ab, -1)} where prod_key = ${key} and valid_from = ${c.valid_from} and valid_to = ${c.valid_to}`;
  await tx`insert into tco.produkte (prod_key, valid_from, valid_to, text, preis, preis_gast, typ, menge) values (${key}, ${d.ab}, ${c.valid_to}, ${text}, ${d.preis}, ${d.preis_gast}, ${c.typ}, ${c.menge})`;
  return key;
}

/** Produkt zum Stichtag beenden (ab dem Folgetag nicht mehr in der Preisliste) */
export async function produktBeenden(tx: Db, prodKey: string, ab: string) {
  const r = await tx`update tco.produkte set valid_to = ${addTage(ab, -1)} where prod_key = ${prodKey} and valid_from < ${ab} and valid_to >= ${ab}`;
  await tx`delete from tco.produkte where prod_key = ${prodKey} and valid_from >= ${ab}`;
  if (!r.count) throw new BusinessError('Zum Stichtag ist kein gültiger Eintrag vorhanden.');
}

// ---------------------------------------------------------------- Buchen

export interface Wunsch { prod_key: string; anzahl: number }

function positionenBerechnen(liste: Produkt[], wuensche: Wunsch[], gast: boolean) {
  const out: { prod_key: string; text: string; anzahl: number; preis: number; betrag: number }[] = [];
  for (const w of wuensche) {
    if (!(w.anzahl > 0) || w.anzahl > 99) continue;
    const p = liste.find((x) => x.prod_key === w.prod_key);
    if (!p) throw new BusinessError(`Produkt ${w.prod_key} ist nicht in der Preisliste.`);
    const preis = gast && p.preis_gast != null ? p.preis_gast : p.preis;
    out.push({ prod_key: p.prod_key, text: p.text, anzahl: w.anzahl, preis, betrag: runden(w.anzahl * preis) });
  }
  if (!out.length) throw new BusinessError('Bitte mindestens eine Position mit Anzahl angeben.');
  return out;
}

export interface Erfasser { name: string; benutzerId: string | null }

/** Verzehr auf das Konto eines Mitglieds anschreiben (selbst oder Theke) */
export async function mitgliedBuchen(tx: Db, adrnr: string, datum: string, wuensche: Wunsch[], wer: Erfasser, selbst: boolean) {
  if (datum > heute()) throw new BusinessError('Verzehr kann nicht für die Zukunft angeschrieben werden.');
  const [m] = await tx`select 1 from tco.mitglieder where adrnr = ${adrnr}`;
  if (!m) throw new BusinessError('Mitglied nicht gefunden.');
  const [abg] = await tx`select rgnr from tco.vz_belege where art = 'SAMMEL' and adrnr = ${adrnr} and monat = ${monatVon(datum)} and status <> 'STORNIERT'`;
  if (abg) throw new BusinessError(`Der ${monatsname(monatVon(datum))} ist bereits abgerechnet (${abg.rgnr}) – bitte das Datum prüfen.`);
  const pos = positionenBerechnen(await preislisteLesen(tx, datum), wuensche, false);
  for (const p of pos) {
    await tx`insert into tco.vz_posten (datum, adrnr, prod_key, text, anzahl, preis, betrag, selbst, erfasst_von, erfasst_benutzer)
             values (${datum}, ${adrnr}, ${p.prod_key}, ${p.text}, ${p.anzahl}, ${p.preis}, ${p.betrag}, ${selbst}, ${wer.name}, ${wer.benutzerId})`;
  }
  return { anzahl: pos.length, betrag: runden(pos.reduce((s, p) => s + p.betrag, 0)) };
}

async function naechsteNummer(tx: Db, praefix: string, stellen: number) {
  const [r] = await tx`select coalesce(max(substr(rgnr, ${praefix.length + 1}::int)::int), 0) + 1 as n from tco.vz_belege where rgnr like ${`${praefix}%`} and substr(rgnr, ${praefix.length + 1}::int) ~ '^[0-9]+$'`;
  return `${praefix}${String(r.n).padStart(stellen, '0')}`;
}

/** Gastbeleg anlegen oder erweitern (offener Beleg des Abends) */
export async function gastBuchen(tx: Db, d: { rgnr?: string | null; gast_name: string; gast_gruppe?: string | null; email?: string | null; mobil?: string | null; wuensche: Wunsch[] }, wer: Erfasser) {
  const name = condense(d.gast_name);
  if (!name && !condense(d.gast_gruppe ?? '')) throw new BusinessError('Bitte den Namen des Gastes oder die Gruppe angeben.');
  let rgnr = d.rgnr ?? null;
  if (rgnr) {
    const [b] = await tx`select status from tco.vz_belege where rgnr = ${rgnr} and art = 'GAST'`;
    if (!b) throw new BusinessError('Gastbeleg nicht gefunden.');
    if (b.status !== 'OFFEN') throw new BusinessError('Dieser Gastbeleg ist bereits kassiert – bitte einen neuen anlegen.');
    // nur gefüllte Angaben übernehmen (Erweiterung vom Handy schickt oft nur Positionen)
    await tx`update tco.vz_belege set gast_name = coalesce(${name || null}, gast_name), gast_gruppe = coalesce(${condense(d.gast_gruppe ?? '') || null}, gast_gruppe),
                                      email = coalesce(${condense(d.email ?? '') || null}, email), mobil = coalesce(${condense(d.mobil ?? '') || null}, mobil) where rgnr = ${rgnr}`;
  } else {
    rgnr = await naechsteNummer(tx, `VZG-${heute().slice(0, 4)}-`, 5);
    await tx`insert into tco.vz_belege (rgnr, art, gast_name, gast_gruppe, email, mobil, datum, status, erstellt_von)
             values (${rgnr}, 'GAST', ${name || null}, ${condense(d.gast_gruppe ?? '') || null}, ${condense(d.email ?? '') || null}, ${condense(d.mobil ?? '') || null}, ${heute()}, 'OFFEN', ${wer.name})`;
  }
  const pos = positionenBerechnen(await preislisteLesen(tx), d.wuensche, true);
  for (const p of pos) {
    await tx`insert into tco.vz_posten (datum, rgnr, prod_key, text, anzahl, preis, betrag, selbst, erfasst_von, erfasst_benutzer)
             values (${heute()}, ${rgnr}, ${p.prod_key}, ${p.text}, ${p.anzahl}, ${p.preis}, ${p.betrag}, false, ${wer.name}, ${wer.benutzerId})`;
  }
  await belegSummeSetzen(tx, rgnr);
  return rgnr;
}

export async function belegSummeSetzen(tx: Db, rgnr: string) {
  await tx`update tco.vz_belege b set betrag = coalesce((select sum(betrag) from tco.vz_posten where rgnr = b.rgnr and storniert_am is null), 0) where rgnr = ${rgnr}`;
}

/** Gastbeleg kassieren: Zahlart, bezahlt heute */
export async function gastKassieren(tx: Db, rgnr: string, zahlart: Zahlart, wer: Erfasser) {
  const [b] = await tx`select status, betrag::float8 as betrag from tco.vz_belege where rgnr = ${rgnr} and art = 'GAST'`;
  if (!b) throw new BusinessError('Gastbeleg nicht gefunden.');
  if (b.status !== 'OFFEN') throw new BusinessError('Dieser Gastbeleg ist bereits kassiert.');
  await belegSummeSetzen(tx, rgnr);
  const [s] = await tx`select betrag::float8 as betrag from tco.vz_belege where rgnr = ${rgnr}`;
  if (!(Number(s.betrag) > 0)) throw new BusinessError('Der Beleg hat keine Positionen.');
  await tx`update tco.vz_belege set status = 'BEZAHLT', zahlart = ${zahlart}, bezahlt_am = ${heute()}, bemerkung = ${`kassiert von ${wer.name}`} where rgnr = ${rgnr}`;
  return Number(s.betrag);
}

// ---------------------------------------------------------------- Storno

/** Storno einer Position (Mitglied: nur eigene, innerhalb der Frist; Theke: heutige; Admin: alle offenen) */
export async function postenStornieren(tx: Db, id: number, wer: Erfasser, grund: string, grenzen: { adrnr?: string; nurHeute?: boolean; fristStunden?: number }) {
  const [p] = await tx`select id, datum::text as datum, adrnr, rgnr, erfasst_am, storniert_am from tco.vz_posten where id = ${id}`;
  if (!p) throw new BusinessError('Position nicht gefunden.');
  if (p.storniert_am) throw new BusinessError('Diese Position ist bereits storniert.');
  if (grenzen.adrnr && p.adrnr !== grenzen.adrnr) throw new BusinessError('Position nicht gefunden.', 404);
  if (p.rgnr) {
    const [b] = await tx`select art, status from tco.vz_belege where rgnr = ${p.rgnr}`;
    if (b && (b.art === 'SAMMEL' || b.status !== 'OFFEN')) throw new BusinessError('Diese Position ist bereits abgerechnet – Storno nur über den Beleg.');
  }
  if (grenzen.nurHeute && p.datum !== heute()) throw new BusinessError('An der Theke können nur Positionen von heute storniert werden.');
  if (grenzen.fristStunden !== undefined) {
    const alter = (Date.now() - new Date(p.erfasst_am).getTime()) / 36e5;
    if (alter > grenzen.fristStunden) throw new BusinessError(`Ein Storno ist nur innerhalb von ${grenzen.fristStunden} Stunden möglich – bitte beim Clubhauswart melden.`);
  }
  await tx`update tco.vz_posten set storniert_am = now(), storniert_von = ${wer.name}, storno_grund = ${condense(grund) || null} where id = ${id}`;
  if (p.rgnr) await belegSummeSetzen(tx, p.rgnr);
}

// ---------------------------------------------------------------- Lesen

const POSTEN = (db: Db) => db`select id, to_char(datum, 'YYYY-MM-DD') as datum, to_char(zeit, 'HH24:MI') as zeit, adrnr, rgnr, prod_key, text,
                                    anzahl::float8 as anzahl, preis::float8 as preis, betrag::float8 as betrag, selbst, erfasst_von,
                                    to_char(erfasst_am at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as erfasst_am,
                                    to_char(storniert_am at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as storniert_am, storniert_von, storno_grund
                               from tco.vz_posten`;
const mapPosten = (r: Record<string, unknown>): Posten => ({ ...(r as unknown as Posten), id: Number(r.id), anzahl: Number(r.anzahl), preis: Number(r.preis), betrag: Number(r.betrag) });

/** offene (noch nicht abgerechnete) Positionen eines Mitglieds */
export async function offenePosten(db: Db, adrnr: string): Promise<Posten[]> {
  const rows = await db`${POSTEN(db)} where adrnr = ${adrnr} and rgnr is null and storniert_am is null order by datum, zeit, id`;
  return rows.map(mapPosten);
}

export async function belegPosten(db: Db, rgnr: string): Promise<Posten[]> {
  const rows = await db`${POSTEN(db)} where rgnr = ${rgnr} order by datum, zeit, id`;
  return rows.map(mapPosten);
}

export async function belegLesen(db: Db, rgnr: string): Promise<Beleg | null> {
  const [b] = await db`select rgnr, art, adrnr, gast_name, gast_gruppe, email, mobil, to_char(datum, 'YYYY-MM-DD') as datum, monat, status,
                              betrag::float8 as betrag, zahlart, to_char(faellig, 'YYYY-MM-DD') as faellig, to_char(bezahlt_am, 'YYYY-MM-DD') as bezahlt_am, doc_id,
                              to_char(versand_am at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as versand_am, versand_art, laufid, erstellt_von, bemerkung
                         from tco.vz_belege where rgnr = ${rgnr}`;
  return b ? { ...(b as unknown as Beleg), betrag: Number(b.betrag) } : null;
}

export interface Filter { von: string; bis: string; adrnr?: string; rgnr?: string; art?: 'MITGLIED' | 'GAST'; status?: 'OFFEN' | 'ABGERECHNET' | 'BEZAHLT' | 'STORNIERT'; suche?: string }

/** Verzehrbuch: alle Positionen im Zeitraum mit Name der Person bzw. des Gastes */
export async function verzehrbuch(db: Db, f: Filter) {
  const rows = await db`
    select p.id, to_char(p.datum, 'YYYY-MM-DD') as datum, to_char(p.zeit, 'HH24:MI') as zeit, p.adrnr, p.rgnr, p.prod_key, p.text,
           p.anzahl::float8 as anzahl, p.preis::float8 as preis, p.betrag::float8 as betrag, p.selbst, p.erfasst_von,
           to_char(p.storniert_am at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as storniert_am, p.storno_grund,
           coalesce(nullif(trim(concat_ws(' ', m.vorname, m.nachname)), ''), b.gast_name, b.gast_gruppe, p.adrnr) as person,
           b.gast_gruppe, b.art as beleg_art, b.status as beleg_status, b.zahlart, b.rgnr as beleg_rgnr,
           coalesce(sb.rgnr, b.rgnr) as abrechnung
      from tco.vz_posten p
      left join tco.vz_belege b on b.rgnr = p.rgnr
      left join tco.vz_belege sb on sb.rgnr = p.rgnr and sb.art = 'SAMMEL'
      left join tco.mitglieder m on m.adrnr = coalesce(p.adrnr, b.adrnr)
     where p.datum between ${f.von} and ${f.bis}
       ${f.adrnr ? db`and coalesce(p.adrnr, b.adrnr) = ${f.adrnr}` : db``}
       ${f.rgnr ? db`and p.rgnr = ${f.rgnr}` : db``}
       ${f.art === 'GAST' ? db`and p.adrnr is null and b.art = 'GAST'` : f.art === 'MITGLIED' ? db`and coalesce(p.adrnr, b.adrnr) is not null` : db``}
       ${f.status === 'STORNIERT' ? db`and p.storniert_am is not null`
         : f.status === 'OFFEN' ? db`and p.storniert_am is null and (p.rgnr is null or b.status = 'OFFEN')`
           : f.status === 'ABGERECHNET' ? db`and p.storniert_am is null and b.status = 'GESTELLT'`
             : f.status === 'BEZAHLT' ? db`and p.storniert_am is null and b.status = 'BEZAHLT'` : db``}
       ${f.suche ? db`and (p.text ilike ${`%${f.suche}%`} or m.nachname ilike ${`%${f.suche}%`} or m.vorname ilike ${`%${f.suche}%`} or b.gast_name ilike ${`%${f.suche}%`} or b.gast_gruppe ilike ${`%${f.suche}%`})` : db``}
     order by p.datum desc, p.zeit desc, p.id desc`;
  return rows.map((r) => ({
    ...(r as unknown as Record<string, unknown>), id: Number(r.id), anzahl: Number(r.anzahl), preis: Number(r.preis), betrag: Number(r.betrag),
    status: r.storniert_am ? 'STORNIERT' : !r.rgnr || r.beleg_status === 'OFFEN' ? 'OFFEN' : r.beleg_status === 'BEZAHLT' ? 'BEZAHLT' : 'ABGERECHNET',
    gast: !r.adrnr && r.beleg_art === 'GAST',
  }));
}

/** Kennzahlen zum Zeitraum */
export async function kennzahlen(db: Db, von: string, bis: string) {
  const [u] = await db`select coalesce(sum(betrag), 0)::float8 as umsatz, count(*)::int as posten, count(distinct datum)::int as abende
                         from tco.vz_posten where datum between ${von} and ${bis} and storniert_am is null`;
  const [o] = await db`select coalesce(sum(p.betrag), 0)::float8 as betrag, count(distinct p.adrnr)::int as personen
                         from tco.vz_posten p where p.adrnr is not null and p.rgnr is null and p.storniert_am is null`;
  const [g] = await db`select coalesce(sum(b.betrag), 0)::float8 as betrag, count(*)::int as belege
                         from tco.vz_belege b where b.art = 'GAST' and b.status = 'BEZAHLT' and b.datum between ${von} and ${bis}`;
  const [go] = await db`select coalesce(sum(b.betrag), 0)::float8 as betrag, count(*)::int as belege from tco.vz_belege b where b.art = 'GAST' and b.status = 'OFFEN'`;
  const [r] = await db`select coalesce(sum(b.betrag), 0)::float8 as betrag, count(*)::int as belege from tco.vz_belege b where b.art = 'SAMMEL' and b.status = 'GESTELLT'`;
  const produkte = await db`select text, sum(anzahl)::float8 as anzahl, sum(betrag)::float8 as betrag from tco.vz_posten
                             where datum between ${von} and ${bis} and storniert_am is null group by text order by 3 desc limit 8`;
  const tage = await db`select to_char(datum, 'YYYY-MM-DD') as datum, sum(betrag)::float8 as betrag, count(*)::int as posten from tco.vz_posten
                         where datum between ${von} and ${bis} and storniert_am is null group by datum order by 1 desc limit 31`;
  return {
    umsatz: Number(u.umsatz), posten: u.posten, abende: u.abende,
    offenKonten: { betrag: Number(o.betrag), personen: o.personen },
    gaeste: { betrag: Number(g.betrag), belege: g.belege }, gaesteOffen: { betrag: Number(go.betrag), belege: go.belege },
    rechnungenOffen: { betrag: Number(r.betrag), belege: r.belege },
    produkte: produkte.map((p) => ({ text: p.text, anzahl: Number(p.anzahl), betrag: Number(p.betrag) })),
    tage: tage.map((t) => ({ datum: t.datum, betrag: Number(t.betrag), posten: t.posten })),
  };
}

export type BelegZeile = Beleg & { person: string | null; mitglied_email: string; posten: number };

export async function belegeLesen(db: Db, f: { von?: string; bis?: string; art?: 'GAST' | 'SAMMEL'; status?: string; monat?: string }): Promise<BelegZeile[]> {
  const rows = await db`
    select b.rgnr, b.art, b.adrnr, b.gast_name, b.gast_gruppe, b.email, b.mobil, to_char(b.datum, 'YYYY-MM-DD') as datum, b.monat, b.status,
           b.betrag::float8 as betrag, b.zahlart, to_char(b.faellig, 'YYYY-MM-DD') as faellig, to_char(b.bezahlt_am, 'YYYY-MM-DD') as bezahlt_am, b.doc_id,
           to_char(b.versand_am at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as versand_am, b.versand_art, b.laufid, b.erstellt_von, b.bemerkung,
           coalesce(nullif(trim(concat_ws(' ', m.vorname, m.nachname)), ''), b.gast_name, b.gast_gruppe) as person,
           coalesce(m.email, '') as mitglied_email,
           (select count(*) from tco.vz_posten p where p.rgnr = b.rgnr and p.storniert_am is null)::int as posten
      from tco.vz_belege b left join tco.mitglieder m on m.adrnr = b.adrnr
     where 1 = 1
       ${f.von ? db`and b.datum >= ${f.von}` : db``} ${f.bis ? db`and b.datum <= ${f.bis}` : db``}
       ${f.art ? db`and b.art = ${f.art}` : db``} ${f.status ? db`and b.status = ${f.status}` : db``} ${f.monat ? db`and b.monat = ${f.monat}` : db``}
     order by b.datum desc, b.rgnr desc`;
  return rows.map((r) => ({ ...(r as unknown as BelegZeile), betrag: Number(r.betrag) }));
}

// ---------------------------------------------------------------- Monatsabschluss

export interface AbschlussZeile { adrnr: string; name: string; email: string; zahlungsart: string | null; posten: number; betrag: number; zahlart: Zahlart; uebertrag: boolean; abgerechnet: string | null }

/** Vorschau: je Mitglied die offenen Positionen bis Monatsende (inkl. Überträge aus Vormonaten) */
export async function abschlussVorschau(db: Db, monat: string): Promise<AbschlussZeile[]> {
  const cfg = await cfgLesen(db);
  const { bis } = monatsgrenzen(monat);
  const rows = await db`
    select p.adrnr, count(*)::int as posten, sum(p.betrag)::float8 as betrag, m.vorname, m.nachname, coalesce(m.email, '') as email, m.zahlungsart,
           (select rgnr from tco.vz_belege b where b.art = 'SAMMEL' and b.adrnr = p.adrnr and b.monat = ${monat} and b.status <> 'STORNIERT' limit 1) as abgerechnet
      from tco.vz_posten p join tco.mitglieder m on m.adrnr = p.adrnr
     where p.adrnr is not null and p.rgnr is null and p.storniert_am is null and p.datum <= ${bis}
     group by p.adrnr, m.vorname, m.nachname, m.email, m.zahlungsart
     order by m.nachname, m.vorname`;
  return rows.map((r) => ({
    adrnr: r.adrnr, name: `${r.nachname ?? ''}, ${r.vorname ?? ''}`, email: r.email, zahlungsart: r.zahlungsart, posten: r.posten, betrag: Number(r.betrag),
    zahlart: r.zahlungsart === 'L' ? 'LASTSCHRIFT' : 'UEBERWEISUNG', uebertrag: Number(r.betrag) < cfg.mindestbetrag, abgerechnet: r.abgerechnet,
  }));
}

/** Positionen, die beim Abschluss des Monats auf die Sammelabrechnung eines Mitglieds kämen */
export async function abschlussPosten(db: Db, adrnr: string, monat: string): Promise<Posten[]> {
  const { bis } = monatsgrenzen(monat);
  const rows = await db`${POSTEN(db)} where adrnr = ${adrnr} and rgnr is null and storniert_am is null and datum <= ${bis} order by datum, zeit, id`;
  return rows.map(mapPosten);
}

/** Sammelabrechnungen anlegen: je Mitglied ein Beleg, Positionen werden zugeordnet */
export async function abschlussErzeugen(tx: Db, monat: string, nur: string[] | null, wer: Erfasser) {
  if (monat >= monatVon(heute())) throw new BusinessError('Der Monat kann erst nach Monatsende abgerechnet werden.');
  const cfg = await cfgLesen(tx);
  const { bis } = monatsgrenzen(monat);
  const zeilen = (await abschlussVorschau(tx, monat)).filter((z) => !z.abgerechnet && !z.uebertrag && (!nur || nur.includes(z.adrnr)));
  const belege: string[] = [];
  for (const z of zeilen) {
    const rgnr = await naechsteNummer(tx, `VZM-${monat.slice(0, 4)}-${monat.slice(4, 6)}-`, 4);
    await tx`insert into tco.vz_belege (rgnr, art, adrnr, datum, monat, status, betrag, zahlart, faellig, erstellt_von)
             values (${rgnr}, 'SAMMEL', ${z.adrnr}, ${heute()}, ${monat}, 'GESTELLT', ${z.betrag}, ${z.zahlart}, ${addTage(heute(), cfg.zahlungsziel_tage)}, ${wer.name})`;
    await tx`update tco.vz_posten set rgnr = ${rgnr} where adrnr = ${z.adrnr} and rgnr is null and storniert_am is null and datum <= ${bis}`;
    await belegSummeSetzen(tx, rgnr);
    belege.push(rgnr);
  }
  return belege;
}

export async function belegBezahlt(tx: Db, rgnr: string, datum: string, zahlart?: Zahlart | null) {
  const [b] = await tx`select status from tco.vz_belege where rgnr = ${rgnr}`;
  if (!b) throw new BusinessError('Beleg nicht gefunden.');
  if (b.status === 'BEZAHLT') throw new BusinessError('Der Beleg ist bereits bezahlt.');
  if (b.status === 'STORNIERT') throw new BusinessError('Der Beleg ist storniert.');
  await tx`update tco.vz_belege set status = 'BEZAHLT', bezahlt_am = ${datum}, zahlart = coalesce(${zahlart ?? null}, zahlart) where rgnr = ${rgnr}`;
}

/** Beleg stornieren: Positionen einer Sammelabrechnung werden wieder offen; Gastbeleg-Positionen werden storniert */
export async function belegStornieren(tx: Db, rgnr: string, wer: Erfasser, grund: string) {
  const b = await belegLesen(tx, rgnr);
  if (!b) throw new BusinessError('Beleg nicht gefunden.');
  if (b.status === 'STORNIERT') throw new BusinessError('Der Beleg ist bereits storniert.');
  if (b.laufid) throw new BusinessError(`Der Beleg ist im Lastschriftlauf ${Number(b.laufid)} enthalten – bitte zuerst den Lauf stornieren.`);
  if (b.art === 'SAMMEL') await tx`update tco.vz_posten set rgnr = null where rgnr = ${rgnr}`;
  else await tx`update tco.vz_posten set storniert_am = now(), storniert_von = ${wer.name}, storno_grund = ${condense(grund) || 'Beleg storniert'} where rgnr = ${rgnr} and storniert_am is null`;
  await tx`update tco.vz_belege set status = 'STORNIERT', bemerkung = ${`storniert von ${wer.name}: ${condense(grund)}`} where rgnr = ${rgnr}`;
}

/** Mitglieder für die Theke: nur Name und Adressnummer, keine weiteren Daten */
export async function mitgliederAuswahl(db: Db) {
  const rows = await db`select adrnr, vorname, nachname from tco.mitglieder where austritt is null or austritt >= current_date order by nachname, vorname`;
  return rows.map((r) => ({ adrnr: r.adrnr, name: condense(`${r.nachname ?? ''}, ${r.vorname ?? ''}`) }));
}
