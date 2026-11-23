import { BusinessError } from '../../../../server/src/errors.js';
import {
  bicGueltig, ibanGueltig, istEwr, normalisieren, pain008, referenzGueltig, sepaText, type Lastschrift, type Meldung,
} from '../../../../server/src/lib/sepa.js';
import type { Db, Verein } from '../verein.js';
import { addTage, condense, dat, heute, runden } from '../format.js';
import { konfigFehlt, konfigLesen, type Konfig } from '../soll/logik.js';
import { betragNeu, rechnungAufteilung, zahlungAufteilen } from './daten.js';
import { KEY_SONSTIGES } from './preis.js';

/**
 * Hallenrechnungen per SEPA-Lastschrift.
 *
 *  - Zahlart je Person (tco.halle_zahlart): Nach dem Einschalten (Einstellungen) fragt das Portal Hallenbucher und Mitglieder
 *    mit Hallenrechnungen einmal, ob sie künftig per Lastschrift zahlen. Mitglieder mit Lastschrift-Mandat können die
 *    Bankverbindung ihrer Mitgliedschaft nehmen (quelle MITGLIED), alle anderen erteilen ein eigenes Mandat (quelle EIGEN).
 *  - Rechnung: Die Zahlart wird beim ersten Druck festgeschrieben (rgkopf.zahlart); bei Lastschrift kündigt die Rechnung
 *    den frühesten Einzug an (Druckdatum + Vorabankündigung, rgkopf.einzug_ab) – statt GiroCode.
 *  - Lauf: separat und manuell (App „Hallen-Lastschrift“). Technisch ein Lauf der Sollstellung mit typ = 'HALLE' und einer
 *    Position je Rechnung (vertragnr = Rechnungsnummer): Der Bankimport erkennt die Sammelgutschrift, bucht sie auf die
 *    Erlöskonten der Rechnungen und markiert sie als bezahlt (Rechnungs-PDF als Beleg).
 *  - Rücklastschrift: Der Bankimport erkennt die Rückbelastung an der End-to-End-Referenz. Beim Buchen werden Erlös und
 *    Bankgebühr zurückgebucht, die Rechnung ist wieder offen (Zahlart Überweisung, „In Bearbeitung“ zum erneuten Versand)
 *    und trägt die Rücklastschriftgebühr als zusätzliche Position.
 */

export const ZAHLART_TEXT = { LASTSCHRIFT: 'SEPA-Lastschrift', UEBERWEISUNG: 'Überweisung' } as const;
export type Zahlart = keyof typeof ZAHLART_TEXT;

// ---------------------------------------------------------------- Einstellungen
export interface LsKonfig { aktiv: boolean; vorankuendigung: number; gebuehr: number | null; gebuehr_konto: string }

export async function lsKonfigLesen(db: Db): Promise<LsKonfig> {
  const [c] = await db`select aktiv, vorankuendigung, gebuehr::float8 as gebuehr, gebuehr_konto from tco.halle_ls_cfg where id = 1`;
  return { aktiv: !!c?.aktiv, vorankuendigung: Number(c?.vorankuendigung ?? 5), gebuehr: c?.gebuehr ?? null, gebuehr_konto: c?.gebuehr_konto ?? '4970' };
}

export async function lsKonfigSpeichern(tx: Db, c: LsKonfig, benutzer: string): Promise<void> {
  const [k] = await tx`select 1 from tco.fikonten where konto = ${c.gebuehr_konto}`;
  if (!k) throw new BusinessError(`Konto ${c.gebuehr_konto} ist nicht im Kontenstamm.`);
  await tx`insert into tco.halle_ls_cfg (id, aktiv, vorankuendigung, gebuehr, gebuehr_konto, geaendert_von, geaendert_am)
           values (1, ${c.aktiv}, ${c.vorankuendigung}, ${c.gebuehr}, ${c.gebuehr_konto}, ${benutzer}, now())
           on conflict (id) do update set aktiv = excluded.aktiv, vorankuendigung = excluded.vorankuendigung, gebuehr = excluded.gebuehr,
             gebuehr_konto = excluded.gebuehr_konto, geaendert_von = excluded.geaendert_von, geaendert_am = excluded.geaendert_am`;
}

// ---------------------------------------------------------------- Mandat einer Person
export interface Mandat {
  adrnr: string; quelle: 'MITGLIED' | 'EIGEN'; kontoinhaber: string; iban: string; bic: string;
  mandatsref: string; mandatsdatum: string | null; erstmalig: boolean;
}

/** Bankverbindung und Mandat aus der Mitgliedschaft – nur, wenn das Mitglied selbst per Lastschrift zahlt und ein aktives Mandat hat */
export async function mitgliedsMandat(db: Db, adrnr: string, stichtag = heute()): Promise<Omit<Mandat, 'erstmalig'> | null> {
  if (adrnr.startsWith('99')) return null;
  const [m] = await db`
    select m.adrnr, m.vorname, m.nachname, m.zahlungsart, m.iban1, m.bic1, m.abwkontoinh, m.adrnrkih, m.austritt::text as austritt,
           s.mandatsnr, s.status, s.angelegtam::text as angelegtam, s.gueltigbis::text as gueltigbis
      from tco.mitglieder m left join tco.sepa s on s.adrnr = m.adrnr
     where m.adrnr = ${adrnr}`;
  if (!m || m.zahlungsart !== 'L' || !s(m.mandatsnr) || !m.status || !m.angelegtam) return null;
  const kih = s(m.adrnrkih).replace(/^0+/, '');
  if (kih && kih !== s(m.adrnr).replace(/^0+/, '')) return null; // zahlt über eine andere Person
  if (m.gueltigbis && m.gueltigbis < stichtag) return null;
  if (m.austritt && m.austritt < stichtag) return null;
  const iban = normalisieren(m.iban1);
  if (!ibanGueltig(iban)) return null;
  const inhaber = s(m.abwkontoinh).replace(/^(Herr|Frau)\s+/, '') || condense(`${s(m.vorname)} ${s(m.nachname)}`);
  return { adrnr, quelle: 'MITGLIED', kontoinhaber: inhaber, iban, bic: normalisieren(m.bic1), mandatsref: s(m.mandatsnr), mandatsdatum: m.angelegtam };
}
const s = (v: unknown) => String(v ?? '').trim();

/** wirksames Mandat einer Person für Hallenrechnungen (null = keine Lastschrift möglich) und der Grund */
export async function mandatLesen(db: Db, adrnr: string | null): Promise<{ mandat: Mandat | null; grund: string }> {
  if (!adrnr) return { mandat: null, grund: 'Keine Adressnummer an der Rechnung' };
  const [z] = await db`select zahlart, status, quelle, kontoinhaber, iban, bic, mandatsref, mandatsdatum::text as mandatsdatum,
                              widerrufen_am::date::text as widerrufen_am from tco.halle_zahlart where adrnr = ${adrnr}`;
  if (!z || z.zahlart !== 'LASTSCHRIFT') return { mandat: null, grund: 'Person hat keine Lastschrift gewählt' };
  if (z.status !== 'AKTIV') return { mandat: null, grund: `Mandat widerrufen${z.widerrufen_am ? ` am ${dat(z.widerrufen_am)}` : ''}` };
  let m: Omit<Mandat, 'erstmalig'> | null;
  if (z.quelle === 'MITGLIED') {
    m = await mitgliedsMandat(db, adrnr);
    if (!m) return { mandat: null, grund: 'Lastschrift-Mandat der Mitgliedschaft fehlt oder ist nicht mehr aktiv' };
  } else {
    m = { adrnr, quelle: 'EIGEN', kontoinhaber: s(z.kontoinhaber), iban: normalisieren(z.iban), bic: normalisieren(z.bic), mandatsref: s(z.mandatsref),
      mandatsdatum: z.mandatsdatum ?? null };
  }
  // Erstlastschrift: ein eigenes Mandat, das noch in keinem (nicht stornierten) Lauf eingezogen wurde
  const [vor] = m.quelle === 'EIGEN'
    ? await db`select 1 from tco.soll_pos p join tco.soll_kopf k on k.laufid = p.laufid where p.mandatsref = ${m.mandatsref} and k.status <> 'S' limit 1`
    : [{}];
  return { mandat: { ...m, erstmalig: !vor }, grund: '' };
}

/**
 * Mandatsreferenz für ein eigenes Hallen-Mandat: TCOH-<Adressnummer>-<lfd. Nr.>. Eine Referenz, die schon in einem Lauf
 * stand, wird nie wieder vergeben (auch nicht nach einem Widerruf).
 */
async function neueMandatsref(tx: Db, adrnr: string): Promise<string> {
  const basis = `TCOH-${adrnr.replace(/^0+/, '')}`;
  for (let i = 1; ; i++) {
    const ref = `${basis}-${i}`;
    const [da] = await tx`select 1 from tco.halle_zahlart where mandatsref = ${ref}
                          union all select 1 from tco.soll_pos where mandatsref = ${ref} limit 1`;
    if (!da) return ref;
  }
}

export const mandatsText = (v: Pick<Verein, 'name'>, glaeubigerId: string, vorankuendigung: number) => [
  `Ich ermächtige den ${v.name} (Gläubiger-ID ${glaeubigerId || '–'}), Zahlungen für meine Hallenrechnungen von meinem Konto mittels Lastschrift einzuziehen. `
  + `Zugleich weise ich mein Kreditinstitut an, die vom ${v.name} auf mein Konto gezogenen Lastschriften einzulösen.`,
  'Hinweis: Ich kann innerhalb von acht Wochen, beginnend mit dem Belastungsdatum, die Erstattung des belasteten Betrages verlangen. Es gelten dabei die mit meinem Kreditinstitut vereinbarten Bedingungen.',
  `Die Vorabankündigung über Betrag und Fälligkeit erfolgt mit der Rechnung, spätestens ${vorankuendigung} Kalendertage vor dem Einzug.`,
  'Kosten einer Rücklastschrift, die ich zu vertreten habe (z. B. mangelnde Deckung, erloschenes Konto, unberechtigter Widerspruch), werden der Rechnung hinzugefügt.',
].join('\n\n');

export interface Entscheidung {
  zahlart: Zahlart;
  /** nur Lastschrift: Bankverbindung der Mitgliedschaft verwenden */
  mitglied?: boolean;
  kontoinhaber?: string | null; iban?: string | null; bic?: string | null;
  /** Mandatstext bestätigt (Pflicht bei Lastschrift) */
  zustimmung?: boolean;
  mandatsdatum?: string | null;
}

/**
 * Zahlart einer Person festlegen (Portal: die Person selbst; Verwaltung: Papiermandat erfassen bzw. Überweisung eintragen).
 * Offene, noch nicht gedruckte Rechnungen folgen der Entscheidung (beim Druck); gedruckte behalten ihre Zahlart.
 */
export async function zahlartSetzen(tx: Db, v: Verein, adrnr: string, e: Entscheidung,
  wer: { name: string; benutzerId?: string | null; ip?: string | null; verwaltung?: boolean }): Promise<{ text: string; mandatsref: string | null }> {
  const cfg = await lsKonfigLesen(tx);
  const gl = await konfigLesen(tx, v);
  const [alt] = await tx`select * from tco.halle_zahlart where adrnr = ${adrnr} for update`;
  if (e.zahlart === 'UEBERWEISUNG') {
    await tx`insert into tco.halle_zahlart (adrnr, zahlart, quelle, status, erfasst_ueber, entschieden_am, entschieden_von, benutzer_id, ip)
             values (${adrnr}, 'UEBERWEISUNG', null, 'AKTIV', ${wer.verwaltung ? 'VERWALTUNG' : 'PORTAL'}, now(), ${wer.name}, ${wer.benutzerId ?? null}, ${wer.ip ?? null})
             on conflict (adrnr) do update set zahlart = 'UEBERWEISUNG', quelle = null, kontoinhaber = null, iban = null, bic = null, mandatsref = null,
               mandatsdatum = null, mandatstext = null, status = 'AKTIV', erfasst_ueber = excluded.erfasst_ueber, entschieden_am = now(),
               entschieden_von = excluded.entschieden_von, benutzer_id = excluded.benutzer_id, ip = excluded.ip, widerrufen_am = null, widerrufen_von = null, grund = null`;
    const offen = await offeneAufUeberweisung(tx, adrnr);
    return { mandatsref: null, text: `Hallenrechnungen werden per Überweisung bezahlt.${offen ? ` ${offen} bereits angekündigte Lastschrift(en) auf Überweisung umgestellt – bitte Rechnung neu versenden.` : ''}` };
  }
  if (!e.zustimmung) throw new BusinessError('Bitte das SEPA-Lastschriftmandat bestätigen.');
  if (!gl.gl_id) throw new BusinessError('Der Verein hat noch keine Gläubiger-ID hinterlegt – die Lastschrift ist noch nicht möglich.');
  const text = mandatsText(v, gl.gl_id, cfg.vorankuendigung);
  if (e.mitglied) {
    const m = await mitgliedsMandat(tx, adrnr);
    if (!m) throw new BusinessError('Für die Mitgliedschaft liegt kein aktives Lastschrift-Mandat vor – bitte eine Bankverbindung angeben.');
    await tx`insert into tco.halle_zahlart (adrnr, zahlart, quelle, mandatstext, status, erfasst_ueber, entschieden_am, entschieden_von, benutzer_id, ip)
             values (${adrnr}, 'LASTSCHRIFT', 'MITGLIED', ${text}, 'AKTIV', ${wer.verwaltung ? 'VERWALTUNG' : 'PORTAL'}, now(), ${wer.name}, ${wer.benutzerId ?? null}, ${wer.ip ?? null})
             on conflict (adrnr) do update set zahlart = 'LASTSCHRIFT', quelle = 'MITGLIED', kontoinhaber = null, iban = null, bic = null, mandatsref = null,
               mandatsdatum = null, mandatstext = excluded.mandatstext, status = 'AKTIV', erfasst_ueber = excluded.erfasst_ueber, entschieden_am = now(),
               entschieden_von = excluded.entschieden_von, benutzer_id = excluded.benutzer_id, ip = excluded.ip, widerrufen_am = null, widerrufen_von = null, grund = null`;
    return { mandatsref: m.mandatsref, text: `Hallenrechnungen werden künftig per Lastschrift von ${ibanMaske(m.iban)} eingezogen (Mandat ${m.mandatsref}).` };
  }
  const iban = normalisieren(e.iban);
  const bic = normalisieren(e.bic);
  const inhaber = sepaText(condense(e.kontoinhaber ?? ''), 70).trim();
  if (!inhaber) throw new BusinessError('Bitte den Kontoinhaber angeben.');
  if (!ibanGueltig(iban)) throw new BusinessError('Die IBAN ist ungültig – bitte prüfen.');
  if (!istEwr(iban.slice(0, 2)) && !bicGueltig(bic)) throw new BusinessError('Für ein Konto außerhalb des EWR wird die BIC benötigt.');
  if (bic && !bicGueltig(bic)) throw new BusinessError('Die BIC ist ungültig – bitte prüfen oder leer lassen.');
  const datum = e.mandatsdatum && wer.verwaltung ? e.mandatsdatum : heute();
  if (datum > heute()) throw new BusinessError('Das Mandatsdatum darf nicht in der Zukunft liegen.');
  // gleiche Bankverbindung: Mandat bleibt (Referenz und Datum), sonst neues Mandat
  const gleich = alt && alt.zahlart === 'LASTSCHRIFT' && alt.quelle === 'EIGEN' && alt.status === 'AKTIV' && alt.iban === iban && alt.mandatsref;
  const ref = gleich ? alt.mandatsref as string : await neueMandatsref(tx, adrnr);
  if (!referenzGueltig(ref)) throw new BusinessError(`Mandatsreferenz ${ref} ist ungültig.`);
  await tx`insert into tco.halle_zahlart (adrnr, zahlart, quelle, kontoinhaber, iban, bic, mandatsref, mandatsdatum, mandatstext, status, erfasst_ueber,
                                          entschieden_am, entschieden_von, benutzer_id, ip)
           values (${adrnr}, 'LASTSCHRIFT', 'EIGEN', ${inhaber}, ${iban}, ${bic || null}, ${ref}, ${gleich ? alt.mandatsdatum : datum}, ${text}, 'AKTIV',
                   ${wer.verwaltung ? 'VERWALTUNG' : 'PORTAL'}, now(), ${wer.name}, ${wer.benutzerId ?? null}, ${wer.ip ?? null})
           on conflict (adrnr) do update set zahlart = 'LASTSCHRIFT', quelle = 'EIGEN', kontoinhaber = excluded.kontoinhaber, iban = excluded.iban, bic = excluded.bic,
             mandatsref = excluded.mandatsref, mandatsdatum = excluded.mandatsdatum, mandatstext = excluded.mandatstext, status = 'AKTIV',
             erfasst_ueber = excluded.erfasst_ueber, entschieden_am = now(), entschieden_von = excluded.entschieden_von, benutzer_id = excluded.benutzer_id,
             ip = excluded.ip, widerrufen_am = null, widerrufen_von = null, grund = null`;
  return { mandatsref: ref, text: `SEPA-Lastschriftmandat ${ref} erteilt – Hallenrechnungen werden künftig von ${ibanMaske(iban)} eingezogen.` };
}

/** Mandat widerrufen (Verwaltung): künftig Überweisung; angekündigte Lastschriften außerhalb eines Laufs werden umgestellt */
export async function mandatWiderrufen(tx: Db, adrnr: string, grund: string, wer: string): Promise<string> {
  const [z] = await tx`select zahlart, status from tco.halle_zahlart where adrnr = ${adrnr} for update`;
  if (!z || z.zahlart !== 'LASTSCHRIFT' || z.status !== 'AKTIV') throw new BusinessError('Für diese Person ist kein aktives Mandat hinterlegt.');
  await tx`update tco.halle_zahlart set status = 'WIDERRUFEN', widerrufen_am = now(), widerrufen_von = ${wer}, grund = ${grund} where adrnr = ${adrnr}`;
  const offen = await offeneAufUeberweisung(tx, adrnr);
  return `Mandat widerrufen.${offen ? ` ${offen} angekündigte Lastschrift(en) auf Überweisung umgestellt – bitte die Rechnung(en) neu versenden.` : ''}`;
}

/** offene Lastschrift-Rechnungen ohne Lauf auf Überweisung umstellen (erneuter Versand nötig) */
async function offeneAufUeberweisung(tx: Db, adrnr: string): Promise<number> {
  const r = await tx`update tco.rgkopf set zahlart = 'UEBERWEISUNG', einzug_ab = null,
                       status = case when status = '3' then case when gedruckt is not null then '2' else '1' end else status end
                      where adrnr = ${adrnr} and zahlart = 'LASTSCHRIFT' and laufid is null and status in ('1', '2', '3')`;
  return r.count;
}

export const ibanMaske = (iban: string | null | undefined) => {
  const i = normalisieren(iban);
  return i ? `${i.slice(0, 4)} •••• ${i.slice(-4)}` : '';
};

// ---------------------------------------------------------------- Rechnung: Zahlart beim Druck
export interface RechnungLastschrift { iban: string; mandatsref: string; glaeubigerId: string; einzugAb: string; kontoinhaber: string }

/**
 * Zahlart einer Rechnung beim Druck: festgeschriebene Zahlart, sonst die der Person (nur wenn eingeschaltet).
 * Lastschrift nur mit wirksamem Mandat; frühester Einzug = erster Druck + Vorabankündigung.
 * `schreiben`: Zahlart und Einzugsdatum festschreiben (beim Druck, nicht bei der Vorschau).
 */
export async function rechnungZahlart(db: Db, v: Verein, k: { rgnr_txt: string; adrnr: string | null; zahlart?: string | null; einzug_ab?: string | null; laufid?: string | null },
  schreiben?: (sql: (tx: Db) => Promise<unknown>) => Promise<unknown>): Promise<RechnungLastschrift | null> {
  const cfg = await lsKonfigLesen(db);
  let zahlart = k.zahlart as Zahlart | null | undefined;
  if (!zahlart) {
    const [z] = k.adrnr && cfg.aktiv ? await db`select zahlart, status from tco.halle_zahlart where adrnr = ${k.adrnr}` : [];
    zahlart = z?.zahlart === 'LASTSCHRIFT' && z.status === 'AKTIV' ? 'LASTSCHRIFT' : 'UEBERWEISUNG';
  }
  let ls: RechnungLastschrift | null = null;
  if (zahlart === 'LASTSCHRIFT') {
    const { mandat } = await mandatLesen(db, k.adrnr);
    const gl = await konfigLesen(db, v);
    if (mandat && gl.gl_id) {
      ls = { iban: mandat.iban, mandatsref: mandat.mandatsref, glaeubigerId: gl.gl_id, kontoinhaber: mandat.kontoinhaber,
        einzugAb: k.einzug_ab ?? addTage(heute(), cfg.vorankuendigung) };
    } else if (!k.laufid) zahlart = 'UEBERWEISUNG';
  }
  if (schreiben && (zahlart !== k.zahlart || (ls && !k.einzug_ab))) {
    await schreiben((tx) => tx`update tco.rgkopf set zahlart = ${zahlart}, einzug_ab = ${ls?.einzugAb ?? null} where rgnr_txt = ${k.rgnr_txt}`);
  }
  return ls;
}

/** werden alle Rechnungen per Lastschrift eingezogen (Text der Rechnungsmail)? – liest nur, schreibt nichts fest */
export async function rechnungenPerLastschrift(db: Db, v: Verein, rgnrs: string[]): Promise<boolean> {
  if (!rgnrs.length) return false;
  const rows = await db`select rgnr_txt, adrnr, zahlart, einzug_ab::text as einzug_ab, laufid from tco.rgkopf where rgnr_txt = any(${rgnrs})`;
  if (rows.length !== rgnrs.length) return false;
  for (const r of rows) if (!(await rechnungZahlart(db, v, r as never))) return false;
  return true;
}

// ---------------------------------------------------------------- Lauf
export interface HallePos {
  key: string; rgnr: string; kunde: string; adrnr: string; betrag: number; status: string; versendet: string | null; einzug_ab: string | null;
  kontoinhaber: string; iban: string; bic: string; mandatsref: string; mandatsdatum: string | null; sequenz: 'FRST' | 'RCUR'; quelle: string;
  meldung: string; state: 'Positive' | 'Critical' | 'Negative' | 'Information';
}

/**
 * Vorschlag: gedruckte bzw. versendete Lastschrift-Rechnungen ohne Lauf, deren angekündigter Einzug spätestens am
 * Fälligkeitstag liegt. Ausgeschlossen (mit Grund): ohne wirksames Mandat, Einzug später angekündigt, noch nicht gedruckt, teilbezahlt.
 */
export async function halleVorschlag(db: Db, faellig: string): Promise<{ pos: HallePos[]; excl: HallePos[] }> {
  const rows = await db`
    select rgnr_txt, kunde, adrnr, betrag::float8 as betrag, status, versendet::text as versendet, einzug_ab::text as einzug_ab
      from tco.rgkopf
     where zahlart = 'LASTSCHRIFT' and laufid is null and status in ('1', '2', '3', '5')
     order by kunde, rgnr_txt`;
  const pos: HallePos[] = [];
  const excl: HallePos[] = [];
  const mandate = new Map<string, Awaited<ReturnType<typeof mandatLesen>>>();
  for (const r of rows) {
    const p: HallePos = {
      key: r.rgnr_txt, rgnr: r.rgnr_txt, kunde: r.kunde ?? '', adrnr: r.adrnr ?? '', betrag: runden(r.betrag), status: r.status, versendet: r.versendet,
      einzug_ab: r.einzug_ab, kontoinhaber: '', iban: '', bic: '', mandatsref: '', mandatsdatum: null, sequenz: 'RCUR', quelle: '', meldung: '', state: 'Positive',
    };
    if (!mandate.has(p.adrnr)) mandate.set(p.adrnr, await mandatLesen(db, p.adrnr || null));
    const { mandat, grund } = mandate.get(p.adrnr)!;
    if (mandat) {
      Object.assign(p, { kontoinhaber: mandat.kontoinhaber, iban: mandat.iban, bic: mandat.bic, mandatsref: mandat.mandatsref, mandatsdatum: mandat.mandatsdatum,
        sequenz: mandat.erstmalig ? 'FRST' : 'RCUR', quelle: mandat.quelle });
    }
    let meldung = '';
    if (r.status === '1') meldung = 'Noch nicht gedruckt – die Rechnung ist die Vorabankündigung';
    else if (r.status === '5') meldung = 'Teilbezahlt – Rest bitte per Überweisung';
    else if (!(p.betrag > 0)) meldung = 'Kein Betrag zum Einzug';
    else if (!mandat) meldung = grund;
    else if (!p.einzug_ab) meldung = 'Einzugstermin wurde nicht angekündigt – bitte Rechnung neu drucken';
    else if (p.einzug_ab > faellig) meldung = `Einzug angekündigt ab ${dat(p.einzug_ab)}`;
    else if (!ibanGueltig(p.iban)) meldung = `IBAN ${p.iban} ungültig`;
    else if (!referenzGueltig(p.mandatsref)) meldung = `Mandatsreferenz ${p.mandatsref} ungültig`;
    else if (!p.mandatsdatum) meldung = 'Mandatsdatum fehlt';
    else if (!istEwr(p.iban.slice(0, 2)) && !p.bic) meldung = `BIC für Konto in ${p.iban.slice(0, 2)} (außerhalb EWR) fehlt`;
    if (meldung) excl.push({ ...p, meldung, state: r.status === '1' || (p.einzug_ab ?? '') > faellig ? 'Information' : 'Negative' });
    else pos.push(p);
  }
  return { pos, excl };
}

export interface HalleTx { adrnr: string; kontoinhaber: string; iban: string; bic: string; mandatsref: string; mandatsdatum: string; sequenz: 'FRST' | 'RCUR'; betrag: number; e2e_id: string; zweck: string; rechnungen: string[] }

/** Je Person, Mandat und IBAN eine Lastschrift; Verwendungszweck mit den Rechnungsnummern; End-to-End-Referenz für Rücklastschriften */
export function halleLastschriften(pos: Pick<HallePos, 'adrnr' | 'kontoinhaber' | 'iban' | 'bic' | 'mandatsref' | 'mandatsdatum' | 'sequenz' | 'betrag' | 'rgnr'>[], laufid: string | null): HalleTx[] {
  const lauf = laufid ? String(Number(laufid)) : '';
  const out: HalleTx[] = [];
  for (const p of [...pos].sort((a, b) => a.adrnr.localeCompare(b.adrnr) || a.rgnr.localeCompare(b.rgnr))) {
    let t = out.find((x) => x.adrnr === p.adrnr && x.mandatsref === p.mandatsref && x.iban === p.iban);
    if (!t) {
      t = { adrnr: p.adrnr, kontoinhaber: p.kontoinhaber, iban: p.iban, bic: p.bic, mandatsref: p.mandatsref, mandatsdatum: p.mandatsdatum ?? '', sequenz: p.sequenz,
        betrag: 0, e2e_id: lauf ? `TCOH${lauf}-${out.length + 1}` : '', zweck: '', rechnungen: [] };
      out.push(t);
    }
    t.betrag = runden(t.betrag + p.betrag);
    t.rechnungen.push(p.rgnr);
  }
  for (const t of out) t.zweck = sepaText(`TC OBERTHAL HALLENRECHNUNG ${t.rechnungen.join(' ')}`, 140).toUpperCase();
  return out;
}

/** Lauf erzeugen: Vorschlag neu ermitteln, abgewählte Rechnungen (`ohne`) weglassen, Datei prüfen, sichern */
export async function halleLaufErzeugen(tx: Db, cfg: Konfig, p: { faellig: string; ohne: string[] }, benutzer: string) {
  const fehlt = konfigFehlt(cfg);
  if (fehlt.length) throw new BusinessError(`Gläubigerdaten unvollständig: ${fehlt.join(', ')} (Einstellungen → Beitragseinzug).`);
  if (p.faellig < heute()) throw new BusinessError('Die Fälligkeit liegt in der Vergangenheit.');
  await tx`select pg_advisory_xact_lock(hashtext('tco.soll_kopf'))`;
  const v = await halleVorschlag(tx, p.faellig);
  const pos = v.pos.filter((x) => !p.ohne.includes(x.key));
  if (!pos.length) return { laufid: null, meldungen: [{ zeile: 0, zahlerNr: '', schwere: 'E', feld: 'Positionen', text: 'Keine Rechnungen für den Einzug vorhanden.' }] as Meldung[] };
  const [mx] = await tx`select coalesce(max(laufid::bigint), 0) + 1 as n from tco.soll_kopf where laufid ~ '^[0-9]+$'`;
  const laufid = String(mx.n).padStart(10, '0');
  const txs = halleLastschriften(pos, laufid);
  const jetzt = new Date();
  const d = heute();
  const zeit = `${String(jetzt.getHours()).padStart(2, '0')}:${String(jetzt.getMinutes()).padStart(2, '0')}:${String(jetzt.getSeconds()).padStart(2, '0')}`;
  const msgid = `H${dat(d)}-${zeit}`.replace(/:/g, '');
  const posten: Lastschrift[] = txs.map((t) => ({
    zahlerNr: t.adrnr.replace(/^0+/, ''), name: sepaText(t.kontoinhaber, 70), iban: t.iban, bic: t.bic, mandat: t.mandatsref,
    mandatsdatum: t.mandatsdatum, betrag: t.betrag, zweck: t.zweck, endToEndId: t.e2e_id, sequenz: t.sequenz,
  }));
  const r = pain008({
    glaeubiger: { name: cfg.gl_name.toUpperCase(), iban: cfg.iban, bic: cfg.bic, glaeubigerId: cfg.gl_id },
    faellig: p.faellig, posten, heute: d, zeit, variante: 'TCO02', nachrichtenId: msgid, pmtInfPrefix: 'TCOH',
  });
  if (r.fehler || !r.xml) return { laufid: null, meldungen: r.meldungen };
  const summe = runden(pos.reduce((s2, x) => s2 + x.betrag, 0));
  const sollper = `H${laufid}`;
  await tx`
    insert into tco.soll_kopf (laufid, typ, sollper, mit_mb, mit_jt, faellig, msgid, anz_pos, anz_tx, summe, status, ernam, erdat, erzeit, xml)
    values (${laufid}, 'HALLE', ${sollper}, false, false, ${p.faellig}, ${msgid}, ${pos.length}, ${txs.length}, ${summe}, 'E',
            ${benutzer}, current_date, localtime(0), ${r.xml})`;
  for (const x of pos) {
    const t = txs.find((y) => y.rechnungen.includes(x.rgnr))!;
    await tx`insert into tco.soll_pos (sollper, adrnr, vertragnr, laufid, art, artname, beitragsart, betrag, konto, mitglnr, mitglied_name,
                                       zahler_adrnr, zahler_name, fi_name, iban, bic, mandatsref, mandatsdatum, e2e_id, status, rgnr_txt, sequenz)
             values (${sollper}, ${x.adrnr || '-'}, ${x.rgnr}, ${laufid}, 'HR', ${`Hallenrechnung ${x.rgnr}`}, 'HR', ${x.betrag}, '8003', '', ${x.kunde},
                     ${x.adrnr || '-'}, ${x.kontoinhaber}, ${sepaText(x.kontoinhaber, 40).toUpperCase()}, ${x.iban}, ${x.bic || null}, ${x.mandatsref},
                     ${x.mandatsdatum}, ${t.e2e_id}, '', ${x.rgnr}, ${x.sequenz})`;
    await tx`update tco.rgkopf set laufid = ${laufid} where rgnr_txt = ${x.rgnr}`;
  }
  return { laufid, meldungen: r.meldungen, anzahl: pos.length, summe };
}

export async function halleLaeufeLesen(db: Db) {
  return db`
    select laufid, faellig::text as faellig, anz_pos, anz_tx, summe::float8 as summe, status, zahl_datum::text as zahl_datum, ernam, erdat::text as erdat,
           (select max(internenr) from tco.soll_pos p where p.laufid = k.laufid) as internenr,
           (select count(*)::int from tco.soll_pos p where p.laufid = k.laufid and p.rueck_internenr is not null) as rueck
      from tco.soll_kopf k where typ = 'HALLE' order by laufid desc`;
}

export async function halleLaufLesen(db: Db, laufid: string) {
  const [k] = await db`
    select laufid, faellig::text as faellig, msgid, anz_pos, anz_tx, summe::float8 as summe, status, zahl_datum::text as zahl_datum, ernam,
           erdat::text as erdat, erzeit::text as erzeit, xml is not null as hat_xml
      from tco.soll_kopf where laufid = ${laufid} and typ = 'HALLE'`;
  if (!k) throw new BusinessError('Lauf nicht gefunden.');
  const pos = await db`
    select rgnr_txt as rgnr, adrnr, mitglied_name as kunde, betrag::float8 as betrag, zahler_name as kontoinhaber, iban, bic, mandatsref,
           mandatsdatum::text as mandatsdatum, sequenz, e2e_id, status, internenr, rueck_internenr, rueck_datum::text as rueck_datum,
           rueck_gebuehr::float8 as rueck_gebuehr
      from tco.soll_pos where laufid = ${laufid} order by mitglied_name, rgnr_txt`;
  return { kopf: k, pos };
}

// ---------------------------------------------------------------- Rücklastschrift
export interface RueckKandidat { laufid: string; e2e: string; betrag: number; rechnungen: string[]; name: string }

/** verbuchte, noch nicht zurückgegebene Lastschriften der Hallen-Läufe (je End-to-End-Referenz) */
export async function rueckKandidaten(db: Db): Promise<RueckKandidat[]> {
  const rows = await db`
    select p.laufid, p.e2e_id, p.zahler_name, sum(p.betrag)::float8 as betrag, array_agg(p.rgnr_txt order by p.rgnr_txt) as rechnungen
      from tco.soll_pos p join tco.soll_kopf k on k.laufid = p.laufid
     where k.typ = 'HALLE' and p.status = 'V' and p.rueck_internenr is null and coalesce(p.e2e_id, '') <> ''
     group by p.laufid, p.e2e_id, p.zahler_name`;
  return rows.map((r) => ({ laufid: r.laufid, e2e: r.e2e_id, betrag: runden(r.betrag), rechnungen: r.rechnungen, name: r.zahler_name ?? '' }));
}

/**
 * Rücklastschrift zu einem Umsatz: Belastung, deren Verwendungszweck die End-to-End-Referenz einer eingezogenen Lastschrift
 * nennt (die Bank gibt sie bei der Rückgabe mit, z. B. „EREF+TCOH12-3“), Betrag mindestens der Einzug (Rest = Bankgebühr).
 */
export function rueckZuUmsatz(k: RueckKandidat[], u: { betrag: number; zweck: string }): RueckKandidat | null {
  if (u.betrag >= 0) return null;
  const zweck = u.zweck.toUpperCase().replace(/\s+/g, '');
  // ganze Referenz: TCOH12-1 darf nicht in TCOH12-10 gefunden werden
  const treffer = k.filter((x) => new RegExp(`${x.e2e.toUpperCase()}(?![0-9])`).test(zweck) && runden(-u.betrag) >= x.betrag);
  return treffer.sort((a, b) => b.e2e.length - a.e2e.length)[0] ?? null;
}

/**
 * Positionen der Rückbuchung: Erlös je Rechnung zurück (nach Erlöskonten wie beim Einzug), Bankgebühr (Differenz) auf
 * das Gebührenkonto. Vorzeichen wie die Belastung (negativ).
 */
export async function rueckPositionen(db: Db, laufid: string, e2e: string, betrag: number) {
  const pos = await db`select rgnr_txt, betrag::float8 as betrag, rueck_internenr from tco.soll_pos where laufid = ${laufid} and e2e_id = ${e2e} and status = 'V'`;
  if (!pos.length) throw new BusinessError(`Lastschrift ${e2e} ist nicht (mehr) als eingezogen verbucht.`);
  if (pos.some((p) => p.rueck_internenr)) throw new BusinessError(`Die Rücklastschrift ${e2e} ist bereits gebucht.`);
  const cfg = await lsKonfigLesen(db);
  const summe = runden(pos.reduce((x, p) => x + p.betrag, 0));
  const gebuehr = runden(Math.abs(betrag) - summe);
  if (gebuehr < 0) throw new BusinessError(`Rücklastschrift ${e2e}: Belastung ${Math.abs(betrag).toFixed(2)} ist kleiner als der Einzug ${summe.toFixed(2)}.`);
  const out: { gkonto: string; betrag: number; text: string; rgnr: null }[] = [];
  for (const p of pos) {
    for (const t of zahlungAufteilen(-p.betrag, await rechnungAufteilung(db, p.rgnr_txt))) {
      out.push({ gkonto: t.konto, betrag: t.betrag, text: `Rücklastschrift Hallenrechnung ${p.rgnr_txt}`, rgnr: null });
    }
  }
  if (gebuehr > 0) out.push({ gkonto: cfg.gebuehr_konto, betrag: -gebuehr, text: 'Rücklastschrift Bankgebühr', rgnr: null });
  return { positionen: out, gebuehr, rechnungen: pos.map((p) => p.rgnr_txt as string) };
}

/**
 * Nach dem Buchen der Rückbelastung: Rechnung wieder offen (In Bearbeitung, Zahlart Überweisung), Gebühr als Position.
 * Gebühr = Einstellung, sonst die tatsächliche Bankgebühr; bei mehreren Rechnungen trägt die erste die Gebühr.
 */
export async function rueckVerbucht(tx: Db, laufid: string, e2e: string, internenr: string, datum: string, bankgebuehr: number): Promise<string[]> {
  const cfg = await lsKonfigLesen(tx);
  const gebuehr = runden(cfg.gebuehr ?? bankgebuehr);
  const pos = await tx`select rgnr_txt from tco.soll_pos where laufid = ${laufid} and e2e_id = ${e2e} and status = 'V' and rueck_internenr is null order by rgnr_txt`;
  const texte: string[] = [];
  for (const [i, p] of pos.entries()) {
    const rgnr = p.rgnr_txt as string;
    let rgpos: number | null = null;
    if (i === 0 && gebuehr > 0) {
      const [{ m }] = await tx`select coalesce(max(rgpos), 0)::int as m from tco.rgpos where rgnr_txt = ${rgnr}`;
      rgpos = m + 1;
      await tx`insert into tco.rgpos (rgnr_txt, rgpos, datum, dauer, prod_key, preis, description, erloeskonto)
               values (${rgnr}, ${rgpos}, ${datum}, '1', ${KEY_SONSTIGES}, ${gebuehr}, ${`Rücklastschriftgebühr (Lastschrift vom ${dat(datum)})`}, ${cfg.gebuehr_konto})`;
      await betragNeu(tx, rgnr);
    }
    await tx`update tco.rgkopf set status = '1', bezahlt = null, zahlart = 'UEBERWEISUNG', einzug_ab = null, laufid = null where rgnr_txt = ${rgnr}`;
    await tx`update tco.soll_pos set rueck_internenr = ${internenr}, rueck_datum = ${datum}, rueck_gebuehr = ${rgpos ? gebuehr : 0}, rueck_rgpos = ${rgpos}
              where laufid = ${laufid} and rgnr_txt = ${rgnr}`;
    texte.push(rgnr);
  }
  return texte;
}

/** Storno der Rückbuchung: Gebühr von der Rechnung nehmen, Rechnung wieder bezahlt – nur solange sie nicht neu versendet oder bezahlt ist */
export async function rueckZuruecksetzen(tx: Db, internenr: string): Promise<string[]> {
  const pos = await tx`select p.laufid, p.rgnr_txt, p.rueck_rgpos, k.zahl_datum::text as zahl_datum
                         from tco.soll_pos p join tco.soll_kopf k on k.laufid = p.laufid where p.rueck_internenr = ${internenr}`;
  for (const p of pos) {
    const [rg] = await tx`select status from tco.rgkopf where rgnr_txt = ${p.rgnr_txt} for update`;
    const [tz] = await tx`select 1 from tco.rgtz where rgnr_txt = ${p.rgnr_txt} limit 1`;
    if (!rg || !['1', '2'].includes(rg.status) || tz) {
      throw new BusinessError(`Hallenrechnung ${p.rgnr_txt} wurde nach der Rücklastschrift bereits erneut versendet oder bezahlt – die Rückbuchung lässt sich nicht mehr stornieren.`);
    }
    if (p.rueck_rgpos) {
      await tx`delete from tco.rgpos where rgnr_txt = ${p.rgnr_txt} and rgpos = ${p.rueck_rgpos}`;
      await betragNeu(tx, p.rgnr_txt);
    }
    await tx`update tco.rgkopf set status = '4', bezahlt = ${p.zahl_datum}, zahlart = 'LASTSCHRIFT', laufid = ${p.laufid} where rgnr_txt = ${p.rgnr_txt}`;
    await tx`update tco.soll_pos set rueck_internenr = null, rueck_datum = null, rueck_gebuehr = null, rueck_rgpos = null
              where laufid = ${p.laufid} and rgnr_txt = ${p.rgnr_txt}`;
  }
  return pos.map((p) => p.rgnr_txt as string);
}

// ---------------------------------------------------------------- Portal: eigene Entscheidung
export interface MeineZahlart {
  /** Hinweis anzeigen (eingeschaltet, Person mit Hallenrechnungen bzw. Hallenbucher, noch nicht entschieden) */
  fragen: boolean;
  aktiv: boolean;
  zahlart: Zahlart | null;
  status: string | null;
  quelle: string | null;
  iban: string;
  mandatsref: string | null;
  /** Mitglied mit Lastschrift-Mandat: Bankverbindung der Mitgliedschaft (maskiert) */
  mitglied: { iban: string; kontoinhaber: string } | null;
  mandatstext: string;
  verein: string;
  glaeubigerId: string;
  vorankuendigung: number;
  name: string;
}

export async function meineZahlart(db: Db, v: Verein, adrnr: string, name: string): Promise<MeineZahlart> {
  const cfg = await lsKonfigLesen(db);
  const gl = await konfigLesen(db, v);
  const [z] = await db`select zahlart, status, quelle, iban, mandatsref from tco.halle_zahlart where adrnr = ${adrnr}`;
  const m = await mitgliedsMandat(db, adrnr);
  // Hallenbucher (99…) immer, Mitglieder nur mit Hallenrechnungen in den letzten zwei Jahren
  const [rg] = adrnr.startsWith('99') ? [{}] : await db`select 1 from tco.rgkopf where adrnr = ${adrnr} and angelegt_am >= current_date - interval '2 years' limit 1`;
  const eigen = z?.quelle === 'MITGLIED' ? m?.iban ?? '' : z?.iban ?? '';
  return {
    fragen: cfg.aktiv && !!gl.gl_id && !!rg && !z,
    aktiv: cfg.aktiv, zahlart: z?.zahlart ?? null, status: z?.status ?? null, quelle: z?.quelle ?? null, iban: ibanMaske(eigen),
    mandatsref: z?.quelle === 'MITGLIED' ? m?.mandatsref ?? null : z?.mandatsref ?? null,
    mitglied: m ? { iban: ibanMaske(m.iban), kontoinhaber: m.kontoinhaber } : null,
    mandatstext: mandatsText(v, gl.gl_id, cfg.vorankuendigung), verein: v.name, glaeubigerId: gl.gl_id, vorankuendigung: cfg.vorankuendigung, name,
  };
}

// ---------------------------------------------------------------- Verwaltung: Übersicht der Zahlarten
export async function zahlartenLesen(db: Db) {
  const rows = await db`
    select z.adrnr, z.zahlart, z.quelle, z.kontoinhaber, z.iban, z.bic, z.mandatsref, z.mandatsdatum::text as mandatsdatum, z.status, z.erfasst_ueber,
           to_char(z.entschieden_am at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as entschieden_am, z.entschieden_von,
           to_char(z.widerrufen_am at time zone 'Europe/Berlin', 'YYYY-MM-DD') as widerrufen_am, z.widerrufen_von, z.grund,
           coalesce(nullif(trim(concat_ws(' ', m.vorname, m.nachname)), ''),
                    (select nullif(trim(concat_ws(' ', k.vorname, k.nachname)), '') from tco.kunden k
                      where z.adrnr like '99%' and k.zuid = ltrim(substr(z.adrnr, 3), '0') order by k.zalias limit 1), z.adrnr) as name
      from tco.halle_zahlart z left join tco.mitglieder m on m.adrnr = z.adrnr
     order by name`;
  const out = [];
  for (const r of rows) {
    let { iban, bic, kontoinhaber, mandatsref, mandatsdatum } = r;
    if (r.quelle === 'MITGLIED') {
      const m = await mitgliedsMandat(db, r.adrnr);
      ({ iban, bic, kontoinhaber, mandatsref } = m ?? { iban: '', bic: '', kontoinhaber: '', mandatsref: '' });
      mandatsdatum = m?.mandatsdatum ?? null;
    }
    out.push({ ...r, iban: iban ?? '', bic: bic ?? '', kontoinhaber: kontoinhaber ?? '', mandatsref: mandatsref ?? '', mandatsdatum });
  }
  return out;
}

/** Personen für „Mandat erfassen“: Mitglieder und Hallenkunden mit Hallenrechnungen */
export async function personenMitRechnungen(db: Db) {
  return db`
    select distinct on (k.adrnr) k.adrnr, k.kunde
      from tco.rgkopf k where coalesce(k.adrnr, '') <> '' order by k.adrnr, k.rgnr_txt desc`;
}
