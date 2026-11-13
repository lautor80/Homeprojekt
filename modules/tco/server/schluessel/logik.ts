/**
 * Hallenschlüssel (#215): Ausgabe und Rückgabe als Vorgänge.
 *
 *  - Ein Schlüssel je Person; tco.schluessel bleibt der aktuelle Stand (Platz buchen „Halle aufsperren“, Arbeitsvorrat, Mitgliederstamm)
 *    und wird hier fortgeschrieben. Schlüssel sind nicht nummeriert – die Schlüsselnummer ist ein freies Feld.
 *  - Neue Vorgänge laufen über die Hallenabrechnung: Ausgabe = Rechnungsposition 008, Rückgabe = Gutschrift 009 (negativer Betrag);
 *    Pfandhöhe und Konto kommen aus dem Hallenprodukt. Zahlung/Erstattung über die Bankbewegungen wie bei jeder Hallenrechnung.
 *  - Der Kunde quittiert die Ausgabe online (Link mit Token), der TCO bestätigt den Empfang bei der Rückgabe.
 *  - Altfälle kommen per Copy & Paste (regeln.ts → altdatenLesen) und werden direkt auf das Kassenkonto gebucht, Beleg verknüpft.
 */
import { randomBytes } from 'node:crypto';
import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import { dat, heute, runden } from '../format.js';
import { kontaktLesen, zuidAusAdrnr } from '../kommunikation.js';
import { ERLOES_STANDARD, adrnrErmitteln, kopfLesen, manuellePosition, positionEntfernen, rechnungAnlegen, rgAenderbar } from '../halle/daten.js';
import { KEY_SCHLUESSEL_AUSGABE, KEY_SCHLUESSEL_RUECKNAHME } from '../halle/preis.js';
import { kandidatLesen } from '../halle/sammel.js';
import { umsaetzeBuchen } from '../fi/buchen.js';
import {
  ART, BEDINGUNGEN_STANDARD, QUITTUNG, STATUS, ZUSTAND, altdatenLesen, quittungUeberfaellig, type AltZeile, type Art, type Status, type Zustand,
} from './regeln.js';
import { protokoll, vorgangAnlegen, type Ich } from './vorgang.js';

export const P_SCHL = { display: 'tco.schluessel:display', edit: 'tco.schluessel:edit', admin: 'tco.schluessel:admin' };

export const AKTIONEN: Record<string, string> = {
  ANGELEGT: 'Angelegt', RECHNUNG: 'Hallenrechnung', QUITTUNG: 'Quittung', EMPFANG: 'Empfang bestätigt', BELEG: 'Beleg', MAIL: 'E-Mail',
  STORNO: 'Storno', IMPORT: 'Übernahme', BUCHUNG: 'FI-Buchung', LINK: 'Quittungslink',
};

export interface Mail { an: string; betreff: string; text: string; objekt: string; vorgang_id: number }

// ---------------------------------------------------------------- Einstellungen

export interface Cfg { bedingungen: string; quittung_tage: number; link_tage: number; kassenkonto: string }
export async function cfgLesen(db: Db): Promise<Cfg & { bedingungen_text: string }> {
  const [c] = await db`select bedingungen, quittung_tage, link_tage, kassenkonto from tco.schluessel_cfg where id = 1`;
  const bedingungen = (c?.bedingungen ?? '').trim();
  return {
    bedingungen, bedingungen_text: bedingungen || BEDINGUNGEN_STANDARD, quittung_tage: Number(c?.quittung_tage ?? 7), link_tage: Number(c?.link_tage ?? 30),
    kassenkonto: c?.kassenkonto ?? '1000',
  };
}

export async function cfgSichern(tx: Db, c: Cfg): Promise<string> {
  const [k] = await tx`select 1 from tco.fikonten where konto = ${c.kassenkonto}`;
  if (!k) throw new BusinessError(`Konto ${c.kassenkonto} ist nicht im Kontenstamm.`);
  await tx`update tco.schluessel_cfg set bedingungen = ${c.bedingungen.trim()}, quittung_tage = ${c.quittung_tage}, link_tage = ${c.link_tage}, kassenkonto = ${c.kassenkonto} where id = 1`;
  return 'Einstellungen gesichert.';
}

/** Pfand und Erlöskonto aus dem Hallenprodukt (Ausgabe 008, Rücknahme 009 – ohne 009 gelten die Werte der Ausgabe) */
export async function produktLesen(db: Db, key: string, datum = heute()): Promise<{ preis: number; konto: string; text: string } | null> {
  const [p] = await db`select preis::float8 as preis, erloeskonto, text from tco.produkte where prod_key = ${key}
                        order by (${datum}::date between valid_from and valid_to) desc, valid_to desc limit 1`;
  return p ? { preis: Math.abs(Number(p.preis ?? 0)), konto: (p.erloeskonto ?? '').trim() || ERLOES_STANDARD, text: p.text ?? '' } : null;
}
export async function pfandLesen(db: Db, datum = heute()): Promise<{ ausgabe: number; rueckgabe: number; kontoAusgabe: string; kontoRueckgabe: string }> {
  const a = await produktLesen(db, KEY_SCHLUESSEL_AUSGABE, datum);
  const r = await produktLesen(db, KEY_SCHLUESSEL_RUECKNAHME, datum);
  return {
    ausgabe: a?.preis ?? 0, rueckgabe: r?.preis || a?.preis || 0,
    kontoAusgabe: a?.konto ?? ERLOES_STANDARD, kontoRueckgabe: r?.konto ?? a?.konto ?? ERLOES_STANDARD,
  };
}

// ---------------------------------------------------------------- Lesen

const personKey = (adrnr: string) => (adrnr.startsWith('99') ? `K:${zuidAusAdrnr(adrnr)}` : `M:${adrnr}`);

const SELECT = (db: Db) => db`
  select v.id, v.nummer, v.art, v.adrnr, v.person, v.datum::text as datum, v.schluessel_nr, v.pfand::float8 as pfand, v.zustand, v.tco_name, v.status,
         v.quittiert_am, v.quittiert_von, v.quittiert_art, v.nachweis, v.rgnr, v.rgpos, v.internenr, v.doc_id, v.quelle, v.bemerkung, v.angelegt_am, v.angelegt_von,
         v.token is not null and v.status = 'WARTET' and v.art = 'AUSGABE' as link_offen, v.token_bis,
         m.austritt::text as austritt,
         -- aktuell: letzter nicht stornierter Vorgang der Person
         v.id = (select x.id from tco.schluessel_vorgang x where x.adrnr = v.adrnr and x.status <> 'STORNIERT' order by x.datum desc, x.id desc limit 1) as aktuell
    from tco.schluessel_vorgang v left join tco.mitglieder m on m.adrnr = v.adrnr`;

function mitTexten<T extends Record<string, unknown>>(z: T, tage: number) {
  const aktiv = z.aktuell === true && z.art === 'AUSGABE' && z.status !== 'STORNIERT';
  return {
    ...z, art_txt: ART[z.art as Art], status_txt: STATUS[z.status as Status], zustand_txt: z.zustand ? ZUSTAND[z.zustand as Zustand] : null,
    quittung_txt: z.quittiert_art ? QUITTUNG[z.quittiert_art as keyof typeof QUITTUNG] : null,
    /** Schlüssel ist derzeit bei dieser Person */
    ausgegeben: aktiv,
    ueberfaellig: quittungUeberfaellig({ art: String(z.art), status: String(z.status), datum: String(z.datum) }, heute(), tage),
    ausgetreten: aktiv && !!z.austritt && String(z.austritt) < heute(),
  };
}

export async function listeLesen(db: Db) {
  const cfg = await cfgLesen(db);
  const rows = await db`${SELECT(db)} order by v.datum desc, v.id desc limit 5000`;
  return rows.map((r) => mitTexten(r, cfg.quittung_tage));
}

export async function vorgangLesen(db: Db, id: number) {
  const cfg = await cfgLesen(db);
  const [v] = await db`${SELECT(db)} where v.id = ${id}`;
  if (!v) throw new BusinessError('Vorgang nicht gefunden.', 404);
  return mitTexten(v, cfg.quittung_tage);
}

export async function protokollLesen(db: Db, id: number) {
  const rows = await db`select id, am, von, aktion, text from tco.schluessel_verlauf where vorgang_id = ${id} order by am, id`;
  return rows.map((r) => ({ ...r, aktion_txt: AKTIONEN[r.aktion as string] ?? r.aktion }));
}

export async function detailLesen(db: Db, id: number) {
  const v = await vorgangLesen(db, id);
  const historie = await db`select id, nummer, art, datum::text as datum, status, tco_name from tco.schluessel_vorgang
                             where adrnr = ${v.adrnr as string} and id <> ${id} order by datum desc, id desc limit 30`;
  return {
    ...v, protokoll: await protokollLesen(db, id), kontakt: await kontaktLesen(db, v.adrnr as string).then((k) => (k ? { email: k.email, telefon: k.mobil || k.telefon } : null)),
    historie: historie.map((h) => ({ ...h, art_txt: ART[h.art as Art], status_txt: STATUS[h.status as Status] })),
  };
}

async function bestandLesen(tx: Db, adrnr: string) {
  const [s] = await tx`select counter, ausgabe::text as ausgabe, ruecknahme::text as ruecknahme from tco.schluessel where adrnr = ${adrnr} for update`;
  return s as { counter: string | null; ausgabe: string | null; ruecknahme: string | null } | undefined;
}

/** Bestand je Person aus dem letzten nicht stornierten Vorgang neu ableiten (nach Storno und Übernahme) */
export async function bestandAbleiten(tx: Db, adrnr: string) {
  const [a] = await tx`select datum::text as datum, doc_id from tco.schluessel_vorgang where adrnr = ${adrnr} and art = 'AUSGABE' and status <> 'STORNIERT' order by datum desc, id desc limit 1`;
  if (!a) { await tx`delete from tco.schluessel where adrnr = ${adrnr}`; return; }
  const [r] = await tx`select datum::text as datum, doc_id from tco.schluessel_vorgang where adrnr = ${adrnr} and art = 'RUECKGABE' and status <> 'STORNIERT' and datum >= ${a.datum}
                        order by datum desc, id desc limit 1`;
  const beleg = (d: number | null) => (d ? String(d) : null);
  await tx`insert into tco.schluessel (adrnr, counter, ausgabe, ausgabebeleg, ruecknahme, ruecknahmebeleg)
           values (${adrnr}, '01', ${a.datum}, ${beleg(a.doc_id)}, ${r?.datum ?? null}, ${beleg(r?.doc_id ?? null)})
           on conflict (adrnr) do update set ausgabe = excluded.ausgabe, ruecknahme = excluded.ruecknahme,
             ausgabebeleg = coalesce(excluded.ausgabebeleg, case when tco.schluessel.ausgabe = excluded.ausgabe then tco.schluessel.ausgabebeleg end),
             ruecknahmebeleg = coalesce(excluded.ruecknahmebeleg, case when tco.schluessel.ruecknahme = excluded.ruecknahme then tco.schluessel.ruecknahmebeleg end)`;
}

// ---------------------------------------------------------------- Hallenrechnung

/** offene Rechnung („In Bearbeitung“) der Person, sonst eine neue – die Rechnung trägt die Adressnummer */
async function rechnungFuer(tx: Db, adrnr: string): Promise<{ rgnr: string; neu: boolean }> {
  const k = await kandidatLesen(tx, personKey(adrnr));
  const rows = await tx`select rgnr_txt from tco.rgkopf where (adrnr = ${adrnr} or (adrnr is null and upper(trim(kunde)) = ${k.kunde})) and status = '1'
                         order by rgnr_txt desc limit 5`;
  for (const r of rows) {
    if (rgAenderbar(await kopfLesen(tx, r.rgnr_txt))) {
      await tx`update tco.rgkopf set adrnr = ${adrnr} where rgnr_txt = ${r.rgnr_txt} and adrnr is null`;
      return { rgnr: r.rgnr_txt, neu: false };
    }
  }
  const rgnr = await rechnungAnlegen(tx, k.kunde);
  await tx`update tco.rgkopf set adrnr = ${adrnr} where rgnr_txt = ${rgnr}`;
  return { rgnr, neu: true };
}

// ---------------------------------------------------------------- Ausgabe / Rückgabe

export interface AusgabeEingabe { adrnr: string; datum: string; schluessel_nr?: string | null; bemerkung?: string | null; ausgegeben_von?: string | null; mit_rechnung: boolean }

export async function ausgabe(tx: Db, e: AusgabeEingabe, ich: Ich): Promise<{ id: number; nummer: string; text: string }> {
  const k = await kandidatLesen(tx, personKey(e.adrnr));
  if (e.datum > heute()) throw new BusinessError('Das Ausgabedatum liegt in der Zukunft.');
  const s = await bestandLesen(tx, e.adrnr);
  if (s?.ausgabe && !s.ruecknahme) throw new BusinessError(`${k.name} hat seit ${dat(s.ausgabe)} bereits einen Hallenschlüssel – je Person ist nur ein Schlüssel vorgesehen.`);
  const pfand = (await pfandLesen(tx)).ausgabe;
  let rg: { rgnr: string; rgpos: number; neu: boolean } | null = null;
  if (e.mit_rechnung) {
    const r = await rechnungFuer(tx, e.adrnr);
    const p = await manuellePosition(tx, r.rgnr, { prod_key: KEY_SCHLUESSEL_AUSGABE, menge: 1 }, { ohneSchluessel: true });
    rg = { rgnr: r.rgnr, rgpos: p.rgpos, neu: r.neu };
  }
  const cfg = await cfgLesen(tx);
  const tco: Ich = e.ausgegeben_von?.trim() && e.ausgegeben_von.trim() !== ich.name ? { id: null, name: e.ausgegeben_von.trim() } : ich;
  const v = await vorgangAnlegen(tx, {
    art: 'AUSGABE', adrnr: e.adrnr, person: k.name, datum: e.datum, schluessel_nr: e.schluessel_nr, pfand: e.mit_rechnung ? pfand : null, tco,
    mitToken: true, linkTage: cfg.link_tage, rgnr: rg?.rgnr, rgpos: rg?.rgpos, bemerkung: e.bemerkung, angelegt_von: ich.name,
  });
  await protokoll(tx, v.id, ich, 'ANGELEGT', `Schlüssel an ${k.name} ausgegeben am ${dat(e.datum)} von ${tco.name}${e.schluessel_nr?.trim() ? ` (Schlüssel ${e.schluessel_nr.trim()})` : ''}`);
  if (rg) await protokoll(tx, v.id, ich, 'RECHNUNG', `Pfand ${pfand.toFixed(2).replace('.', ',')} € als Position ${rg.rgpos} in Rechnung ${rg.rgnr}${rg.neu ? ' (neu angelegt)' : ''}`);
  await bestandAbleiten(tx, e.adrnr);
  return { id: v.id, nummer: v.nummer, text: `Ausgabe ${v.nummer} an ${k.name} erfasst${rg ? ` – Pfand in Rechnung ${rg.rgnr}` : ''}.` };
}

export interface RueckgabeEingabe {
  adrnr: string; datum: string; zustand: Zustand; bemerkung?: string | null; empfangen_von?: string | null;
  /** Pfand als Gutschrift (negative Position) in die Hallenrechnung */
  gutschrift: boolean;
  /** Empfang sofort bestätigen (der Erfassende hat den Schlüssel selbst entgegengenommen) */
  bestaetigt: boolean;
}

export async function rueckgabe(tx: Db, e: RueckgabeEingabe, ich: Ich): Promise<{ id: number; nummer: string; text: string }> {
  const k = await kandidatLesen(tx, personKey(e.adrnr));
  const s = await bestandLesen(tx, e.adrnr);
  if (!s?.ausgabe || s.ruecknahme) throw new BusinessError(`Für ${k.name} ist kein ausgegebener Hallenschlüssel erfasst.`);
  if (e.datum < s.ausgabe) throw new BusinessError(`Die Rückgabe liegt vor der Ausgabe (${dat(s.ausgabe)}).`);
  if (e.datum > heute()) throw new BusinessError('Das Rückgabedatum liegt in der Zukunft.');
  const [aus] = await tx`select schluessel_nr from tco.schluessel_vorgang where adrnr = ${e.adrnr} and art = 'AUSGABE' and status <> 'STORNIERT' order by datum desc, id desc limit 1`;
  const pfand = (await pfandLesen(tx)).rueckgabe;
  let rg: { rgnr: string; rgpos: number; neu: boolean } | null = null;
  if (e.gutschrift) {
    if (!pfand) throw new BusinessError('Im Hallenprodukt ist kein Pfand hinterlegt – bitte ohne Gutschrift erfassen oder den Preis pflegen (Hallenpreise).');
    const r = await rechnungFuer(tx, e.adrnr);
    const p = await manuellePosition(tx, r.rgnr, { prod_key: KEY_SCHLUESSEL_RUECKNAHME, menge: 1, preis: -pfand }, { preisVorgabe: true, ohneSchluessel: true });
    rg = { rgnr: r.rgnr, rgpos: p.rgpos, neu: r.neu };
  }
  const tco: Ich = e.empfangen_von?.trim() && e.empfangen_von.trim() !== ich.name ? { id: null, name: e.empfangen_von.trim() } : ich;
  const v = await vorgangAnlegen(tx, {
    art: 'RUECKGABE', adrnr: e.adrnr, person: k.name, datum: e.datum, schluessel_nr: aus?.schluessel_nr ?? null, pfand: e.gutschrift ? pfand : null, zustand: e.zustand,
    tco, status: e.bestaetigt ? 'QUITTIERT' : 'WARTET', quittiert_von: e.bestaetigt ? ich.name : null, quittiert_art: 'TCO',
    rgnr: rg?.rgnr, rgpos: rg?.rgpos, bemerkung: e.bemerkung, angelegt_von: ich.name,
  });
  await protokoll(tx, v.id, ich, 'ANGELEGT', `Schlüssel von ${k.name} zurückgegeben am ${dat(e.datum)}, empfangen von ${tco.name} – Zustand: ${ZUSTAND[e.zustand]}`);
  if (rg) await protokoll(tx, v.id, ich, 'RECHNUNG', `Gutschrift Pfand −${pfand.toFixed(2).replace('.', ',')} € als Position ${rg.rgpos} in Rechnung ${rg.rgnr}${rg.neu ? ' (neu angelegt)' : ''}`);
  else await protokoll(tx, v.id, ich, 'RECHNUNG', 'Keine Gutschrift – das Pfand wird nicht erstattet');
  if (e.bestaetigt) await protokoll(tx, v.id, ich, 'EMPFANG', `Empfang durch ${ich.name} bestätigt`);
  await bestandAbleiten(tx, e.adrnr);
  return { id: v.id, nummer: v.nummer, text: `Rückgabe ${v.nummer} von ${k.name} erfasst${rg ? ` – Gutschrift in Rechnung ${rg.rgnr}` : ''}.` };
}

/** TCO bestätigt den Empfang des Schlüssels (Rückgabe) */
export async function empfangBestaetigen(tx: Db, id: number, ich: Ich): Promise<string> {
  const [v] = await tx`select nummer, art, status from tco.schluessel_vorgang where id = ${id} for update`;
  if (!v) throw new BusinessError('Vorgang nicht gefunden.', 404);
  if (v.art !== 'RUECKGABE') throw new BusinessError('Den Empfang bestätigt der TCO nur bei einer Rückgabe – die Ausgabe quittiert der Kunde.');
  if (v.status !== 'WARTET') throw new BusinessError(`${v.nummer} ist bereits ${STATUS[v.status as Status].toLowerCase()}.`);
  await tx`update tco.schluessel_vorgang set status = 'QUITTIERT', quittiert_am = now(), quittiert_von = ${ich.name}, quittiert_art = 'TCO' where id = ${id}`;
  await protokoll(tx, id, ich, 'EMPFANG', `Empfang durch ${ich.name} bestätigt`);
  return `Empfang zu ${v.nummer} bestätigt.`;
}

// ---------------------------------------------------------------- Online-Quittung des Kunden

/** Vorgang zum Quittungslink (ohne interne Daten) */
export async function quittungInfo(db: Db, token: string) {
  const [v] = await db`select id, nummer, person, datum::text as datum, schluessel_nr, pfand::float8 as pfand, tco_name, status, quittiert_am, token_bis, art
                         from tco.schluessel_vorgang where token = ${token}`;
  if (!v || v.art !== 'AUSGABE') throw new BusinessError('Dieser Link ist ungültig.', 404);
  if (v.status === 'STORNIERT') throw new BusinessError('Diese Schlüsselausgabe wurde storniert – es gibt nichts zu quittieren.', 410);
  const cfg = await cfgLesen(db);
  return {
    id: v.id as number, nummer: v.nummer as string, person: v.person as string, datum: v.datum as string, schluessel_nr: v.schluessel_nr as string | null,
    pfand: v.pfand as number | null, ausgegeben_von: v.tco_name as string, quittiert: v.status === 'QUITTIERT', quittiert_am: v.quittiert_am as Date | null,
    abgelaufen: v.status === 'WARTET' && !!v.token_bis && new Date(v.token_bis) < new Date(), bedingungen: cfg.bedingungen_text,
  };
}

export async function quittieren(tx: Db, token: string, name: string, nachweis: string, benutzer: Ich | null): Promise<{ id: number; nummer: string; text: string }> {
  const [v] = await tx`select id, nummer, art, status, token_bis, person from tco.schluessel_vorgang where token = ${token} for update`;
  if (!v || v.art !== 'AUSGABE') throw new BusinessError('Dieser Link ist ungültig.', 404);
  if (v.status === 'QUITTIERT') return { id: v.id, nummer: v.nummer, text: 'Der Erhalt ist bereits quittiert – vielen Dank!' };
  if (v.status !== 'WARTET') throw new BusinessError('Diese Schlüsselausgabe wurde storniert – es gibt nichts zu quittieren.', 410);
  if (v.token_bis && new Date(v.token_bis) < new Date()) throw new BusinessError('Der Link ist abgelaufen. Bitte beim Hallenwart einen neuen Link anfordern.', 410);
  const wer = name.trim() || v.person;
  await tx`update tco.schluessel_vorgang set status = 'QUITTIERT', quittiert_am = now(), quittiert_von = ${wer}, quittiert_art = 'KUNDE', nachweis = ${nachweis} where id = ${v.id}`;
  await protokoll(tx, v.id, benutzer ?? { id: null, name: wer }, 'QUITTUNG', `Erhalt online quittiert von ${wer} (${nachweis})`);
  return { id: v.id, nummer: v.nummer, text: 'Danke – der Erhalt des Hallenschlüssels ist quittiert. Viel Spaß in der Halle!' };
}

/** offene Quittungen des angemeldeten Benutzers (Meine Mitgliedschaft) */
export async function meineOffenen(db: Db, adrnr: string | null) {
  if (!adrnr) return [];
  return db`select nummer, datum::text as datum, token from tco.schluessel_vorgang
             where adrnr = ${adrnr} and art = 'AUSGABE' and status = 'WARTET' and token is not null and (token_bis is null or token_bis > now()) order by datum`;
}

/** Quittungslink erneuern (neue Gültigkeit) und Mail an den Kunden zusammenstellen */
export async function linkErneuern(tx: Db, id: number, ich: Ich): Promise<{ text: string; mails: Mail[] }> {
  const [v] = await tx`select nummer, art, status from tco.schluessel_vorgang where id = ${id} for update`;
  if (!v) throw new BusinessError('Vorgang nicht gefunden.', 404);
  if (v.art !== 'AUSGABE' || v.status !== 'WARTET') throw new BusinessError('Einen Quittungslink gibt es nur für Ausgaben, die noch nicht quittiert sind.');
  const cfg = await cfgLesen(tx);
  await tx`update tco.schluessel_vorgang set token = coalesce(token, ${randomBytes(24).toString('hex')}), token_bis = now() + make_interval(days => ${cfg.link_tage}), erinnert_am = now() where id = ${id}`;
  await protokoll(tx, id, ich, 'LINK', `Quittungslink erneuert (gültig ${cfg.link_tage} Tage)`);
  const mails = await mailQuittung(tx, id, true);
  return { text: mails.length ? `Quittungslink zu ${v.nummer} wird per E-Mail gesendet.` : `Quittungslink zu ${v.nummer} erneuert – es ist keine E-Mail-Adresse hinterlegt, bitte den Link aus dem Vorgang weitergeben.`, mails };
}

// ---------------------------------------------------------------- Storno

export async function stornieren(tx: Db, id: number, grund: string, ich: Ich): Promise<{ text: string; hinweise: string[] }> {
  const [v] = await tx`select * from tco.schluessel_vorgang where id = ${id} for update`;
  if (!v) throw new BusinessError('Vorgang nicht gefunden.', 404);
  if (v.status === 'STORNIERT') throw new BusinessError(`${v.nummer} ist bereits storniert.`);
  if (!grund.trim()) throw new BusinessError('Bitte einen Grund für das Storno angeben.');
  const [letzter] = await tx`select id from tco.schluessel_vorgang where adrnr = ${v.adrnr} and status <> 'STORNIERT' order by datum desc, id desc limit 1`;
  if (letzter?.id !== id) throw new BusinessError('Storniert werden kann nur der letzte Vorgang der Person – bitte zuerst den späteren Vorgang stornieren.');
  const hinweise: string[] = [];
  if (v.rgnr && v.rgpos) {
    try {
      await positionEntfernen(tx, v.rgnr, v.rgpos, `Storno ${v.nummer}: ${grund.trim()}`);
      await protokoll(tx, id, ich, 'RECHNUNG', `Position ${v.rgpos} aus Rechnung ${v.rgnr} entfernt`);
    } catch (e) {
      if (!(e instanceof BusinessError)) throw e;
      hinweise.push(`Die Position in Rechnung ${v.rgnr} konnte nicht entfernt werden (${e.message}) – bitte in der Hallenabrechnung mit einer Gegenposition korrigieren.`);
    }
  }
  if (v.internenr) hinweise.push(`Die FI-Buchung ${v.internenr} bleibt bestehen – bitte bei Bedarf in FI-Belege stornieren.`);
  await tx`update tco.schluessel_vorgang set status = 'STORNIERT', token = null where id = ${id}`;
  await protokoll(tx, id, ich, 'STORNO', grund.trim());
  await bestandAbleiten(tx, v.adrnr);
  return { text: `${v.nummer} storniert.`, hinweise };
}

// ---------------------------------------------------------------- E-Mails

/** Mail an den Kunden mit dem Quittungslink ({portal} ersetzt routes.ts) */
export async function mailQuittung(db: Db, id: number, erinnerung = false): Promise<Mail[]> {
  const [v] = await db`select nummer, adrnr, person, datum::text as datum, token, tco_name, pfand::float8 as pfand, rgnr from tco.schluessel_vorgang where id = ${id}`;
  const k = v ? await kontaktLesen(db, v.adrnr) : null;
  if (!v?.token || !k?.email) return [];
  return [{
    an: k.email, objekt: v.nummer, vorgang_id: id, betreff: `${erinnerung ? 'Erinnerung: ' : ''}Bitte quittiere den Erhalt deines Hallenschlüssels (${v.nummer})`,
    text: `Hallo ${k.vorname || v.person},\n\ndu hast am ${dat(v.datum)} ${v.tco_name ? `von ${v.tco_name} ` : ''}einen Hallenschlüssel bekommen. `
      + `Bitte bestätige uns kurz den Erhalt – das dauert nur einen Klick:\n\n{portal}/schluessel-quittung?token=${v.token}\n\n`
      + `${v.pfand ? `Das Pfand von ${v.pfand.toFixed(2).replace('.', ',')} € steht auf deiner nächsten Hallenrechnung${v.rgnr ? ` (${v.rgnr})` : ''} und kommt bei der Rückgabe wieder zurück.\n\n` : ''}`
      + 'Die Spielregeln zum Schlüssel findest du auf der Seite hinter dem Link.',
  }];
}

/** Bestätigung an den Kunden nach bestätigter Rückgabe */
export async function mailRueckgabe(db: Db, id: number): Promise<Mail[]> {
  const [v] = await db`select nummer, adrnr, person, datum::text as datum, tco_name, pfand::float8 as pfand, rgnr, status, art from tco.schluessel_vorgang where id = ${id}`;
  const k = v ? await kontaktLesen(db, v.adrnr) : null;
  if (!v || v.art !== 'RUECKGABE' || v.status !== 'QUITTIERT' || !k?.email) return [];
  return [{
    an: k.email, objekt: v.nummer, vorgang_id: id, betreff: `Hallenschlüssel zurückgegeben (${v.nummer})`,
    text: `Hallo ${k.vorname || v.person},\n\nwir bestätigen: Du hast deinen Hallenschlüssel am ${dat(v.datum)} zurückgegeben${v.tco_name ? `, entgegengenommen von ${v.tco_name}` : ''}.\n\n`
      + `${v.pfand ? `Das Pfand von ${v.pfand.toFixed(2).replace('.', ',')} € schreiben wir dir über die Hallenrechnung${v.rgnr ? ` ${v.rgnr}` : ''} gut.\n\n` : ''}Danke und bis bald auf dem Platz!`,
  }];
}

// ---------------------------------------------------------------- Altdaten (Copy & Paste)

export interface AltPruefung extends AltZeile { adrnr: string | null; name: string | null; hinweise: string[]; vorhanden: boolean }

/** Einfügetext prüfen: Person finden (Mitgliedsnummer/Adressnummer oder Name), Dubletten erkennen */
export async function altdatenPruefen(db: Db, text: string): Promise<AltPruefung[]> {
  const out: AltPruefung[] = [];
  for (const z of altdatenLesen(text).slice(0, 1000)) {
    const p: AltPruefung = { ...z, fehler: [...z.fehler], adrnr: null, name: null, hinweise: [], vorhanden: false };
    if (z.person) {
      let adrnr: string | null = null;
      if (/^\d+$/.test(z.person)) {
        const nr = z.person.padStart(10, '0');
        const [m] = await db`select m.adrnr from tco.mitglieder m
                              where m.adrnr = ${nr} or ltrim(coalesce(m.mitglnrn, ''), '0') = ${String(Number(z.person))} order by (m.adrnr = ${nr}) desc limit 1`;
        adrnr = m?.adrnr ?? null;
      } else {
        const name = z.person.includes(',') ? z.person.split(',').map((t) => t.trim()).reverse().join(' ') : z.person;
        adrnr = await adrnrErmitteln(db, name);
      }
      if (!adrnr) p.fehler.push(`Person „${z.person}“ nicht gefunden (Mitgliedsnummer oder „Vorname Nachname“)`);
      else {
        p.adrnr = adrnr;
        p.name = (await kandidatLesen(db, personKey(adrnr)).catch(() => null))?.name ?? z.person;
        const da = await db`select art, datum::text as datum, quelle, internenr from tco.schluessel_vorgang where adrnr = ${adrnr} and status <> 'STORNIERT'`;
        const gleich = (art: Art, d: string | null) => !!d && da.some((x) => x.art === art && x.datum === d && x.quelle !== 'BESTAND');
        if (gleich('AUSGABE', z.ausgabe) && (!z.rueckgabe || gleich('RUECKGABE', z.rueckgabe))) { p.vorhanden = true; p.hinweise.push('Bereits übernommen – wird übersprungen'); }
        else if (da.some((x) => x.quelle === 'BESTAND')) p.hinweise.push('Ergänzt den Stand aus dem Mitgliederstamm');
      }
    }
    if (out.some((o) => o.adrnr && o.adrnr === p.adrnr && o.ausgabe === p.ausgabe && !o.fehler.length)) p.fehler.push('Doppelte Zeile für dieselbe Person und Ausgabe');
    out.push(p);
  }
  return out;
}

/**
 * Altdaten übernehmen: Vorgänge als abgeschlossene Altfälle; mit `buchen` je Ausgabe/Rückgabe mit Pfand eine FI-Buchung direkt
 * auf dem Kassenkonto (Gegenkonto = Erlöskonto des Hallenprodukts), der Paperless-Beleg wird mit der Buchung verknüpft.
 */
export async function altdatenUebernehmen(tx: Db, text: string, o: { buchen: boolean }, ich: Ich): Promise<{ text: string; uebernommen: number; buchungen: string[]; uebersprungen: number }> {
  const zeilen = await altdatenPruefen(tx, text);
  const fehler = zeilen.filter((z) => z.fehler.length);
  if (fehler.length) throw new BusinessError(`Bitte zuerst die Fehler beheben:\n${fehler.slice(0, 10).map((z) => `Zeile ${z.zeile}: ${z.fehler.join('; ')}`).join('\n')}`);
  const cfg = await cfgLesen(tx);
  const buchungen: string[] = [];
  let n = 0;
  const betroffene = new Set<string>();
  async function einer(z: AltPruefung, art: Art, datum: string, tcoName: string, doc: number | null) {
    const adrnr = z.adrnr!;
    const pfand = z.pfand ?? 0;
    let internenr: string | null = null;
    if (o.buchen && pfand > 0) {
      const konten = await pfandLesen(tx, datum);
      const betrag = art === 'AUSGABE' ? pfand : -pfand;
      const [g] = await umsaetzeBuchen(tx, [{
        konto: cfg.kassenkonto, datum, text: `Hallenschlüssel Pfand ${art === 'AUSGABE' ? 'Ausgabe' : 'Rückgabe'} ${z.name}`.slice(0, 60), betrag,
        positionen: [{ gkonto: art === 'AUSGABE' ? konten.kontoAusgabe : konten.kontoRueckgabe, betrag, text: null, rgnr: null }],
        belege: doc ? [doc] : [], notiz: `Übernahme Altdaten Hallenschlüssel (${ich.name})`,
      }], ich.name);
      internenr = g.internenr;
      buchungen.push(g.internenr);
    }
    // Stand aus dem Mitgliederstamm (Quelle BESTAND) wird ergänzt statt verdoppelt
    const [alt] = await tx`select id, nummer from tco.schluessel_vorgang where adrnr = ${adrnr} and art = ${art} and quelle = 'BESTAND' and status <> 'STORNIERT' and internenr is null
                            order by (datum = ${datum}) desc, id limit 1`;
    let id: number;
    if (alt) {
      id = alt.id;
      await tx`update tco.schluessel_vorgang set datum = ${datum}, pfand = ${z.pfand}, tco_name = ${tcoName}, doc_id = coalesce(${doc}, doc_id), internenr = ${internenr},
                      schluessel_nr = coalesce(${z.schluessel_nr || null}, schluessel_nr), bemerkung = coalesce(${z.bemerkung || null}, bemerkung), quelle = 'IMPORT' where id = ${id}`;
    } else {
      id = (await vorgangAnlegen(tx, {
        art, adrnr, person: z.name ?? z.person, datum, schluessel_nr: z.schluessel_nr, pfand: z.pfand, tco: tcoName ? { id: null, name: tcoName } : null,
        status: 'QUITTIERT', quittiert_von: 'Altfall – Beleg in Paperless', quittiert_art: 'ALTFALL', internenr, doc_id: doc, quelle: 'IMPORT', bemerkung: z.bemerkung, angelegt_von: ich.name,
      })).id;
    }
    await protokoll(tx, id, ich, 'IMPORT', `Altfall übernommen: ${ART[art]} am ${dat(datum)}${tcoName ? ` (${art === 'AUSGABE' ? 'ausgegeben' : 'empfangen'} von ${tcoName})` : ''}${doc ? ` · Beleg ${String(doc).padStart(6, '0')}` : ''}`);
    if (internenr) await protokoll(tx, id, ich, 'BUCHUNG', `Pfand ${runden(pfand).toFixed(2).replace('.', ',')} € ${art === 'AUSGABE' ? 'Eingang' : 'Auszahlung'} Kasse ${cfg.kassenkonto}, FI-Buchung ${internenr}`);
    n++;
  }
  for (const z of zeilen) {
    if (z.vorhanden) continue;
    if (z.ausgabe) await einer(z, 'AUSGABE', z.ausgabe, z.ausgegeben_von, z.doc_ausgabe);
    if (z.rueckgabe) await einer(z, 'RUECKGABE', z.rueckgabe, z.empfangen_von, z.doc_rueckgabe);
    betroffene.add(z.adrnr!);
  }
  for (const a of betroffene) await bestandAbleiten(tx, a);
  const uebersprungen = zeilen.filter((z) => z.vorhanden).length;
  return {
    uebernommen: n, buchungen, uebersprungen,
    text: `${n} Vorgang/Vorgänge übernommen${buchungen.length ? `, ${buchungen.length} Kassenbuchung(en) angelegt` : ''}${uebersprungen ? `, ${uebersprungen} Zeile(n) übersprungen` : ''}.`,
  };
}

// ---------------------------------------------------------------- Vereinsübersicht

/** Arbeitsvorrat (Hallenwart): fehlende Quittungen, unbestätigte Rückgaben, Ausgetretene mit Schlüssel */
export async function aufgaben(db: Db) {
  const liste = await listeLesen(db);
  const out: { key: string; bereich: string; icon: string; state: 'Critical' | 'Information'; titel: string; text: string; datum: string; pfad: string }[] = [];
  for (const v of liste as unknown as (Record<string, unknown> & { id: number; nummer: string; person: string; datum: string; art: string; status: string; tco_name: string; ueberfaellig: boolean; ausgetreten: boolean; austritt: string | null })[]) {
    const pfad = `/tco/hallenschluessel?id=${v.id}`;
    if (v.ueberfaellig) {
      out.push({ key: `SCHLUESSEL:Q:${v.id}`, bereich: 'Hallenwart', icon: 'key', state: 'Critical', titel: `Schlüssel nicht quittiert: ${v.person}`,
        text: `Ausgabe ${v.nummer} vom ${dat(v.datum)} – der Kunde hat den Erhalt noch nicht online quittiert. Link erneut senden.`, datum: v.datum, pfad });
    }
    if (v.art === 'RUECKGABE' && v.status === 'WARTET') {
      out.push({ key: `SCHLUESSEL:E:${v.id}`, bereich: 'Hallenwart', icon: 'key', state: 'Information', titel: `Schlüsselrückgabe bestätigen: ${v.person}`,
        text: `Rückgabe ${v.nummer} vom ${dat(v.datum)}${v.tco_name ? `, empfangen von ${v.tco_name}` : ''} – Empfang noch nicht bestätigt.`, datum: v.datum, pfad });
    }
    if (v.ausgetreten) {
      out.push({ key: `SCHLUESSEL:A:${v.id}`, bereich: 'Hallenwart', icon: 'key', state: 'Critical', titel: `Schlüssel zurückfordern: ${v.person}`,
        text: `Ausgetreten zum ${dat(v.austritt)} – der Hallenschlüssel (Ausgabe ${dat(v.datum)}) ist noch nicht zurück.`, datum: v.austritt ?? v.datum, pfad });
    }
  }
  return out;
}
