import { BusinessError } from '../../../../server/src/errors.js';
import type { Db, Verein } from '../verein.js';
import { condense, dat, heute, nameSchoen, runden, wochentag, WOCHENTAG_TEXT, zeit } from '../format.js';
import { adrnrAusZuid, kanalLesen, kontaktLesen, type Kontakt } from '../kommunikation.js';
import {
  KEY_ABO, KEY_EINZEL, KEY_SCHLUESSEL_AUSGABE, KEY_SCHLUESSEL_RUECKNAHME, KEY_SONSTIGES,
  preisBerechnen, preiseLesen, type Preise,
} from './preis.js';

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

export const RG_STATUS: Record<string, string> = {
  '1': 'In Bearbeitung', '2': 'Gedruckt', '3': 'Versendet', '4': 'Bezahlt', '5': 'Teilbezahlt', '6': 'Forderung ausgefallen',
};

export interface Rechnung {
  rgnr_txt: string;
  kunde: string;
  adrnr: string | null;
  betrag: number;
  status: string;
  angelegt_am: string | null;
  gedruckt: string | null;
  versendet: string | null;
  bezahlt: string | null;
  doknr: string | null;
  anzahl: number;
  gezahlt: number;
  offen: number;
  aenderbar: boolean;
  wiedereroeffnet: boolean;
}

export interface Buchung {
  bid: string;
  datum: string;
  time_start: string;
  time_ende: string;
  kunde: string;
  status: string;          // wirksam (Abo als Einzel = 1)
  art: 'Abo' | 'Einzel';
  text: string | null;
  termine: number;         // Abo: offene Termine der Serie
  betrag: number;
  dauer: number;
  prodKey: string | null;
  fehler: string | null;
  vergangen: boolean;
  zukunft: boolean;        // Datum nach heute (für automatische Zuordnung)
  platz?: string | null;
}

export interface Person {
  kunde: string;
  name: string;
  offeneBuchungen: number;
  betragBuchungen: number;
  rechnungen: { rgnr_txt: string; status: string; betrag: number; offen: number; versendet: string | null }[];
  offenRechnungen: number;
  betrag: number;
  gruppe: string;
  /** Hinweise, die Rechnung oder Versand behindern */
  probleme: Problem[];
}

export interface Selektion {
  status: string[];          // leer = alle
  druckVon?: string | null;
  druckBis?: string | null;
  buchungen: boolean;
}

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------

/** Rechnung nimmt Positionen auf: Status 1/2, oder 5 ohne Versanddatum */
export const rgAenderbar = (r: { status: string; versendet: string | null }) =>
  r.status === '1' || r.status === '2' || (r.status === '5' && !r.versendet);

/** Terminende erreicht */
export function vergangen(datum: string, ende: string | null, jetzt = new Date()): boolean {
  const h = heute();
  if (datum < h) return true;
  if (datum > h) return false;
  const now = `${String(jetzt.getHours()).padStart(2, '0')}:${String(jetzt.getMinutes()).padStart(2, '0')}`;
  return !!ende && ende.slice(0, 5) <= now;
}

/** Menge einer manuellen Position (DAUER enthält „1“, „1.00“ oder „2,5“) */
export function menge(dauer: string | null): number {
  const n = Number(String(dauer ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/** Betrag einer Position: Buchung = PREIS, manuelle Position = PREIS × Menge */
export const posBetrag = (p: { bid: string | null; preis: number | null; dauer: string | null }) =>
  runden(p.bid ? Number(p.preis ?? 0) : Number(p.preis ?? 0) * menge(p.dauer));

// ---------------------------------------------------------------------------
// Adressnummer zu einem EP3-Namen
// ---------------------------------------------------------------------------

/**
 * 1. Mitglied mit gleichem „Vorname Nachname“ (ohne Groß-/Kleinschreibung, auch Doppelnamen)
 * 2. EP3-Kunde mit gleichem Namen oder Alias; aktive Konten zuerst, dann höchste ZUID.
 *    Ist dessen ZUID einem Mitglied zugeordnet (Mitglied → Zusatzdaten → ZUID), gilt das Mitglied.
 * Ergebnis: 00… Mitglied, 99 + ZUID (8-stellig) EP3-Kunde.
 */
export async function adrnrErmitteln(db: Db, kunde: string): Promise<string | null> {
  const name = condense(kunde).toUpperCase();
  if (!name) return null;
  const m = await db`select adrnr from tco.mitglieder
                      where upper(trim(coalesce(vorname, '') || ' ' || coalesce(nachname, ''))) = ${name}
                      order by austritt nulls first, adrnr desc`;
  if (m.length) return m[0].adrnr;
  const k = await db`
    select zuid from tco.kunden
     where upper(trim(coalesce(vorname, '') || ' ' || coalesce(nachname, ''))) = ${name} or upper(trim(zalias)) = ${name}
     order by case when coalesce(status, '') in ('blocked', 'deleted', 'disabled') then 1 else 0 end,
              length(zuid) desc, zuid desc
     limit 1`;
  if (!k.length) return null;
  const [mz] = await db`select adrnr from tco.mitgliedera where zuid = ${k[0].zuid} limit 1`;
  return mz?.adrnr ?? adrnrAusZuid(k[0].zuid);
}

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

/** Sommersaison für Abos: 01.05.–30.09. – auf den Außenplätzen keine Abrechnung */
export const sommerAbo = (datum: string) => datum.slice(5) >= '05-01' && datum.slice(5) <= '09-30';
/** Platz zählt als Halle (Stammdaten: Plätze, die auch im Sommer abgerechnet werden) */
export const istHalle = (platz: string | null | undefined, v: Verein) =>
  !!platz && (v.halle_plaetze || 'Halle').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)
    .some((h) => platz.trim().toUpperCase() === h || (h.length > 2 && platz.trim().toUpperCase().includes(h)));

/**
 * offene Buchungen (ASSIGNED leer), bepreist; Abos einmal je BID.
 * Abo-Termine vom 01.05. bis 30.09. entfallen, sofern nicht in der Halle gebucht (auch „Abo als Einzel“).
 */
export async function offeneBuchungen(db: Db, v: Verein, preise?: Preise, kunde?: string): Promise<Buchung[]> {
  const p = preise ?? await preiseLesen(db);
  const ausschluss = v.halle_ausschluss.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const rows = await db`
    select b.bid, b.datum::text, b.time_start::text, b.time_ende::text, b.kunde, b.status, b.platz,
           coalesce(t.text, b.text) as text, c.status_abw
      from tco.bookings b
      left join tco.bookingstxt t on t.bid = b.bid
      left join tco.bookings_ch c on c.bid = b.bid
     where coalesce(b.assigned, '') = ''
       and b.datum > ${v.halle_stichtag}
       and coalesce(b.status, '') not in ('2', '4')
       and not (upper(coalesce(b.kunde, '')) = any(${ausschluss}))
       ${kunde ? db`and b.kunde = ${kunde}` : db``}
     order by b.datum, b.time_start`;
  const out: Buchung[] = [];
  const abo = new Map<string, Buchung>();
  for (const r of rows) {
    if (r.status === '3' && sommerAbo(r.datum) && !istHalle(r.platz, v)) continue;
    const status = r.status === '3' && r.status_abw === '1' ? '1' : r.status;
    if (status === '3') {
      const a = abo.get(r.bid);
      if (a) { a.termine++; continue; }
    }
    const pr = preisBerechnen({ datum: r.datum, time_start: r.time_start, time_ende: r.time_ende, status }, p);
    const b: Buchung = {
      bid: r.bid, datum: r.datum, time_start: r.time_start, time_ende: r.time_ende, kunde: r.kunde ?? '', status,
      art: status === '3' ? 'Abo' : 'Einzel', text: r.text, termine: 1,
      betrag: pr.betrag, dauer: pr.dauer, prodKey: pr.prodKey, fehler: pr.fehler,
      vergangen: vergangen(r.datum, r.time_ende), zukunft: r.datum > heute(), platz: r.platz ?? null,
    };
    if (status === '3') abo.set(r.bid, b);
    out.push(b);
  }
  return out;
}

export async function rechnungenLesen(db: Db, sel: Selektion | null, kunde?: string, rgnr?: string): Promise<Rechnung[]> {
  const status = sel?.status?.length ? sel.status : null;
  const von = sel?.druckVon || null;
  const bis = sel?.druckBis || sel?.druckVon || null;
  const rows = await db`
    select k.rgnr_txt, k.kunde, k.adrnr, k.betrag::float8 as betrag, k.status, k.angelegt_am::text, k.gedruckt::text,
           k.versendet::text, k.bezahlt::text, k.doknr,
           (select count(*)::int from tco.rgpos p where p.rgnr_txt = k.rgnr_txt) as anzahl,
           coalesce((select sum(z.betrag)::float8 from tco.rgtz z where z.rgnr_txt = k.rgnr_txt), 0) as gezahlt
      from tco.rgkopf k
     where true
       ${rgnr ? db`and k.rgnr_txt = ${rgnr}` : db``}
       ${kunde ? db`and k.kunde = ${kunde}` : db``}
       ${status && !rgnr ? db`and k.status = any(${status})` : db``}
       ${von && !rgnr ? db`and (k.gedruckt is null or k.gedruckt between ${von} and ${bis})` : db``}
     order by k.rgnr_txt desc`;
  return rows.map((r) => {
    const offen = ['4', '6'].includes(r.status) ? 0 : Math.max(0, runden(r.betrag - r.gezahlt));
    return {
      ...(r as unknown as Rechnung),
      offen,
      aenderbar: rgAenderbar(r as unknown as Rechnung),
      wiedereroeffnet: !!r.versendet && ['1', '2'].includes(r.status),
    };
  });
}

/** Hinweis, der die Rechnungserstellung bzw. den Versand behindert (Personenliste und Detail) */
export interface Problem { art: 'KONTAKT' | 'ANSCHRIFT' | 'VERSAND' | 'PREIS'; schwere: 'Negative' | 'Critical'; text: string }

/** Probleme einer Person: fehlende Zuordnung/Anschrift/Versandweg, Buchungen ohne Preis */
export function problemeErmitteln(kunde: string, kontakt: Kontakt | null, buchungen: Pick<Buchung, 'fehler' | 'datum'>[], offeneRechnungen: number): Problem[] {
  const out: Problem[] = [];
  const brauchtRechnung = buchungen.length > 0 || offeneRechnungen > 0;
  if (!kontakt) {
    if (brauchtRechnung) out.push({ art: 'KONTAKT', schwere: 'Negative', text: `Zum EP3-Namen „${kunde}“ gibt es kein Mitglied und keinen EP3-Kunden – für den Druck fehlt die Anschrift.` });
  } else {
    if (brauchtRechnung && (!kontakt.strasse.trim() || !kontakt.plz.trim() || !kontakt.ort.trim())) out.push({ art: 'ANSCHRIFT', schwere: 'Critical', text: 'Anschrift unvollständig (Straße, PLZ oder Ort fehlt).' });
    if (brauchtRechnung && !kontakt.email && !kontakt.mobil) out.push({ art: 'VERSAND', schwere: 'Critical', text: 'Weder E-Mail noch Mobilnummer – Versand nur als Ausdruck.' });
  }
  const ohnePreis = buchungen.filter((b) => b.fehler);
  if (ohnePreis.length) {
    const f = [...new Set(ohnePreis.map((b) => b.fehler))];
    out.push({ art: 'PREIS', schwere: 'Negative', text: `${ohnePreis.length} Buchung(en) ohne Preis: ${f.slice(0, 2).join('; ')}${f.length > 2 ? ' …' : ''}` });
  }
  return out;
}

export async function personenLesen(db: Db, v: Verein, sel: Selektion) {
  const preise = await preiseLesen(db);
  const buchungen = sel.buchungen ? await offeneBuchungen(db, v, preise) : [];
  const rechnungen = await rechnungenLesen(db, sel);
  const map = new Map<string, Person>();
  const get = (kunde: string) => {
    let p = map.get(kunde);
    if (!p) {
      p = { kunde, name: nameSchoen(kunde), offeneBuchungen: 0, betragBuchungen: 0, rechnungen: [], offenRechnungen: 0, betrag: 0, gruppe: '', probleme: [] };
      map.set(kunde, p);
    }
    return p;
  };
  for (const b of buchungen) {
    const p = get(b.kunde);
    p.offeneBuchungen++;
    p.betragBuchungen = runden(p.betragBuchungen + b.betrag);
  }
  for (const r of rechnungen) {
    const p = get(r.kunde ?? '');
    p.rechnungen.push({ rgnr_txt: r.rgnr_txt, status: r.status, betrag: r.betrag, offen: r.offen, versendet: r.versendet });
    if (!['4', '6'].includes(r.status)) p.offenRechnungen++;
    p.betrag = runden(p.betrag + r.offen);
  }
  // Probleme je Person (Zuordnung, Anschrift, Versandweg, Preise) – nur wo noch etwas abzurechnen ist
  const buchungenJe = new Map<string, Buchung[]>();
  for (const b of buchungen) buchungenJe.set(b.kunde, [...(buchungenJe.get(b.kunde) ?? []), b]);
  for (const p of map.values()) {
    const offen = p.rechnungen.filter((r) => !['4', '6'].includes(r.status)).length;
    if (!p.offeneBuchungen && !offen) continue;
    const kontakt = await kontaktLesen(db, await adrnrErmitteln(db, p.kunde));
    p.probleme = problemeErmitteln(p.kunde, kontakt, buchungenJe.get(p.kunde) ?? [], offen);
  }
  const personen = [...map.values()].map((p) => {
    const min = p.rechnungen.map((r) => r.status).sort()[0];
    return {
      ...p,
      betrag: runden(p.betrag + p.betragBuchungen),
      gruppe: min ? `${min} – ${RG_STATUS[min]}` : '0 – Ohne Rechnung',
    };
  });
  return {
    personen,
    gesamtOffen: runden(personen.reduce((s, p) => s + p.betrag, 0)),
  };
}

export async function personDetail(db: Db, v: Verein, kunde: string, sel: Selektion) {
  const preise = await preiseLesen(db);
  const adrnr = await adrnrErmitteln(db, kunde);
  const kontakt = await kontaktLesen(db, adrnr);
  const buchungen = await offeneBuchungen(db, v, preise, kunde);
  const rechnungen = await rechnungenLesen(db, sel, kunde);
  return {
    kunde,
    name: kontakt ? condense(`${kontakt.vorname} ${kontakt.nachname}`) || nameSchoen(kunde) : nameSchoen(kunde),
    adrnr,
    kontakt,
    kanal: await kanalLesen(db, kontakt),
    rechnungen,
    buchungen,
    offeneRechnungen: rechnungen.filter((r) => !['4', '6'].includes(r.status)).length,
    probleme: problemeErmitteln(kunde, kontakt, buchungen, rechnungen.filter((r) => !['4', '6'].includes(r.status)).length),
    gezahlt: runden(rechnungen.reduce((s, r) => s + r.gezahlt, 0)),
    offenRechnungen: runden(rechnungen.reduce((s, r) => s + r.offen, 0)),
    betragBuchungen: runden(buchungen.reduce((s, b) => s + b.betrag, 0)),
  };
}

// ---------------------------------------------------------------------------
// Positionen (Anzeige und Druck)
// ---------------------------------------------------------------------------

export interface DruckPosition {
  rgpos: number;
  bid: string | null;
  datum: string | null;
  time_start: string | null;
  time_ende: string | null;
  prod_key: string | null;
  art: string;
  beschreibung: string;      // Spalten durch Tabulator getrennt (Art / Wochentag / Datum / Uhrzeit)
  anzahl: number;
  ep: number;
  betrag: number;
  storno: boolean;
  manuell: boolean;
}

export async function positionenLesen(db: Db, rgnr: string): Promise<DruckPosition[]> {
  const rows = await db`
    select p.rgpos, p.bid, p.datum::text, p.time_start::text, p.time_ende::text, p.dauer, p.prod_key,
           p.preis::float8 as preis, p.description, b.status as bstatus,
           (select text from tco.produkte pr where pr.prod_key = p.prod_key order by valid_to desc limit 1) as prodtext
      from tco.rgpos p
      left join lateral (select status from tco.bookings b where b.bid = p.bid and (p.datum is null or b.datum = p.datum)
                         order by b.datum limit 1) b on true
     where p.rgnr_txt = ${rgnr}
     order by p.datum nulls last, p.time_start nulls last, p.rgpos`;
  return rows.map((p) => {
    const key: string | null = p.prod_key;
    const manuell = !p.bid;
    const tag = p.datum ? WOCHENTAG_TEXT[wochentag(p.datum)] : '';
    const uhr = `${zeit(p.time_start)} - ${zeit(p.time_ende)} Uhr`;
    const dauerMin = menge(p.dauer);
    const istMiete = !manuell && key && (KEY_ABO.includes(key) || KEY_EINZEL.includes(key)) && dauerMin > 8;
    let anzahl = manuell ? dauerMin : istMiete ? dauerMin / 60 : dauerMin;
    const storno = p.bstatus === '2';
    if (storno) anzahl = 0;
    let art = manuell ? 'Manuell' : 'Buchung';
    let beschr: string;
    if (!manuell && key && KEY_ABO.includes(key)) { art = 'Abo'; beschr = `Abo\t${tag}\t\t${uhr}`; }
    else if (!manuell && key && KEY_EINZEL.includes(key)) { art = 'Einzel'; beschr = `Einzelbuchung\t${tag}\t${dat(p.datum)}\t${uhr}`; }
    else if (key === '004') beschr = 'Rabatt für Sonntagsnutzung';
    else if (key === KEY_SCHLUESSEL_AUSGABE || key === KEY_SCHLUESSEL_RUECKNAHME) beschr = 'Hallenschlüssel Pfand';
    else if (key === '091') beschr = 'Verkauf Trainingsbälle';
    else if (manuell) beschr = p.prodtext ?? 'Position';
    else beschr = `${dat(p.datum)} von ${zeit(p.time_start)} bis ${zeit(p.time_ende)} Uhr`;
    if (p.description) beschr = p.description;
    const betrag = manuell ? runden(p.preis * anzahl) : runden(p.preis ?? 0);
    const ep = manuell ? p.preis : anzahl > 0 ? runden(betrag / anzahl) : 0;
    return {
      rgpos: p.rgpos, bid: p.bid, datum: p.datum, time_start: p.time_start, time_ende: p.time_ende, prod_key: key,
      art, beschreibung: beschr, anzahl, ep, betrag, storno, manuell,
    };
  });
}

// ---------------------------------------------------------------------------
// Schreiben
// ---------------------------------------------------------------------------

export async function kopfLesen(tx: Db, rgnr: string) {
  const [k] = await tx`select rgnr_txt, kunde, adrnr, status, versendet::text, gedruckt::text, doknr, betrag::float8 as betrag
                         from tco.rgkopf where rgnr_txt = ${rgnr} for update`;
  if (!k) throw new BusinessError(`Rechnung ${rgnr} nicht gefunden`);
  return k as unknown as { rgnr_txt: string; kunde: string; adrnr: string | null; status: string; versendet: string | null; gedruckt: string | null; doknr: string | null; betrag: number };
}

/** Rechnungsbetrag = Summe der Positionen */
export async function betragNeu(tx: Db, rgnr: string): Promise<number> {
  const pos = await tx`select bid, preis::float8 as preis, dauer from tco.rgpos where rgnr_txt = ${rgnr}`;
  const summe = runden(pos.reduce((s, p) => s + posBetrag(p as never), 0));
  await tx`update tco.rgkopf set betrag = ${summe} where rgnr_txt = ${rgnr}`;
  return summe;
}

async function naechstePos(tx: Db, rgnr: string): Promise<number> {
  const [{ m }] = await tx`select coalesce(max(rgpos), 0)::int as m from tco.rgpos where rgnr_txt = ${rgnr}`;
  return m + 1;
}

export async function rechnungAnlegen(tx: Db, kunde: string): Promise<string> {
  if (!kunde.trim()) throw new BusinessError('Bitte zuerst eine Person auswählen');
  const jahr = Number(heute().slice(0, 4));
  const [{ mx }] = await tx`select coalesce(max(rgnr), 0)::int as mx from tco.rgkopf where jahr = ${jahr}`;
  await tx`insert into core.number_ranges (id, year, last_value) values ('TCO_HALLE', ${jahr}, ${mx})
           on conflict (id, year) do update set last_value = greatest(core.number_ranges.last_value, excluded.last_value)`;
  const [{ n }] = await tx`select core.next_number('TCO_HALLE', ${jahr})::int as n`;
  const rgnr = `${jahr}_${String(n).padStart(3, '0')}`;
  const adrnr = await adrnrErmitteln(tx, kunde);
  await tx`insert into tco.rgkopf (rgnr_txt, jahr, rgnr, kunde, betrag, waers, status, angelegt_am, adrnr)
           values (${rgnr}, ${jahr}, ${n}, ${kunde}, 0, 'EUR', '1', ${heute()}, ${adrnr})`;
  return rgnr;
}

/**
 * Buchungen einer Rechnung zuordnen (ASSIGN_RG / ASSIGN_PAST_RG / AUTO_BUCHEN).
 * Zukünftige Termine werden nie zugeordnet; ein Abo ergibt eine Position für die ganze Serie
 * und sperrt alle Termine der BID (auch später importierte, siehe Import).
 */
export async function zuordnen(tx: Db, v: Verein, rgnr: string, liste: { bid: string; datum: string }[], opt: { bisHeute?: boolean } = {}) {
  const k = await kopfLesen(tx, rgnr);
  if (!rgAenderbar(k)) throw new BusinessError(`Rechnung ${rgnr} nimmt keine Positionen mehr auf`);
  const preise = await preiseLesen(tx);
  let anzahl = 0;
  let preisfehler = 0;
  let zukunft = 0;
  let pos = await naechstePos(tx, rgnr);
  for (const { bid, datum } of liste) {
    const [b] = await tx`
      select b.bid, b.datum::text, b.time_start::text, b.time_ende::text, b.status, b.kunde, b.assigned, c.status_abw
        from tco.bookings b left join tco.bookings_ch c on c.bid = b.bid
       where b.bid = ${bid} and b.datum = ${datum} for update of b`;
    if (!b || (b.assigned ?? '') !== '') continue;
    const fertig = opt.bisHeute ? b.datum <= heute() : vergangen(b.datum, b.time_ende);
    if (!fertig) { zukunft++; continue; }
    const status = b.status === '3' && b.status_abw === '1' ? '1' : b.status;
    const pr = preisBerechnen({ datum: b.datum, time_start: b.time_start, time_ende: b.time_ende, status }, preise);
    if (pr.fehler) preisfehler++;
    await tx`insert into tco.rgpos (rgnr_txt, rgpos, bid, datum, time_start, time_ende, dauer, prod_key, preis)
             values (${rgnr}, ${pos++}, ${b.bid}, ${b.datum}, ${b.time_start}, ${b.time_ende}, ${String(pr.dauer)},
                     ${pr.prodKey}, ${pr.betrag})`;
    if (status === '3') await tx`update tco.bookings set assigned = 'Y' where bid = ${bid} and coalesce(assigned, '') = ''`;
    else await tx`update tco.bookings set assigned = 'Y' where bid = ${bid} and datum = ${datum}`;
    anzahl++;
  }
  if (anzahl) await betragNeu(tx, rgnr);
  return { anzahl, preisfehler, zukunft };
}

/** Position entfernen (UNASSIGN_RG); Buchungsposition gibt die Buchung wieder frei */
export async function positionEntfernen(tx: Db, rgnr: string, rgpos: number, begruendung?: string) {
  const k = await kopfLesen(tx, rgnr);
  if (!rgAenderbar(k)) throw new BusinessError(`Rechnung ${rgnr} ist bereits versendet oder gezahlt – keine Änderung möglich`);
  if (k.versendet && !begruendung?.trim()) {
    throw new BusinessError('Die Rechnung war bereits versendet – bitte eine Begründung angeben');
  }
  const [p] = await tx`select bid, datum::text, prod_key from tco.rgpos where rgnr_txt = ${rgnr} and rgpos = ${rgpos}`;
  if (!p) throw new BusinessError(`Position ${rgpos} nicht gefunden`);
  await tx`delete from tco.rgpos where rgnr_txt = ${rgnr} and rgpos = ${rgpos}`;
  if (p.bid) {
    const [b] = await tx`select status, (select status_abw from tco.bookings_ch c where c.bid = ${p.bid}) as abw
                           from tco.bookings where bid = ${p.bid} and datum = ${p.datum}`;
    const abo = b?.status === '3' && b?.abw !== '1';
    // Abo: alle Termine der Serie wieder frei, die keine andere Position mehr tragen
    if (abo) {
      const [weitere] = await tx`select 1 from tco.rgpos where bid = ${p.bid} limit 1`;
      if (!weitere) await tx`update tco.bookings set assigned = '' where bid = ${p.bid}`;
    } else await tx`update tco.bookings set assigned = '' where bid = ${p.bid} and datum = ${p.datum}`;
  }
  await betragNeu(tx, rgnr);
  return { kopf: k, position: p };
}

export async function positionenNummerieren(tx: Db, rgnr: string): Promise<number> {
  const k = await kopfLesen(tx, rgnr);
  if (!rgAenderbar(k)) throw new BusinessError(`Rechnung ${rgnr} ist bereits versendet oder gezahlt – keine Änderung möglich`);
  const pos = await tx`select rgpos from tco.rgpos where rgnr_txt = ${rgnr}
                        order by datum nulls last, time_start nulls last, rgpos`;
  // zweistufig, damit der Primärschlüssel nicht kollidiert
  await tx`update tco.rgpos set rgpos = rgpos + 100000 where rgnr_txt = ${rgnr}`;
  let i = 0;
  for (const p of pos) await tx`update tco.rgpos set rgpos = ${++i} where rgnr_txt = ${rgnr} and rgpos = ${p.rgpos + 100000}`;
  return i;
}

/** manuelle Position (MANPOS_SAVE) inkl. Schlüsselliste bei 008/009 */
export async function manuellePosition(tx: Db, rgnr: string, d: { prod_key: string; beschreibung?: string | null; menge: number; preis?: number | null }) {
  const k = await kopfLesen(tx, rgnr);
  if (!rgAenderbar(k)) throw new BusinessError('Versendete oder bezahlte Rechnungen nehmen keine Positionen mehr auf');
  if (!d.prod_key) throw new BusinessError('Bitte ein Produkt auswählen');
  if (!(d.menge > 0)) throw new BusinessError('Die Menge muss größer als null sein');
  const [pr] = await tx`select text, preis::float8 as preis, typ from tco.produkte
                         where prod_key = ${d.prod_key} and valid_from <= current_date and valid_to >= current_date
                         order by valid_from desc limit 1`;
  if (!pr) throw new BusinessError(`Produkt ${d.prod_key} ist heute nicht gültig`);
  const frei = d.prod_key === KEY_SONSTIGES;
  const preis = frei ? Number(d.preis) : pr.preis;
  if (!Number.isFinite(preis)) throw new BusinessError('Bitte einen Preis als Zahl erfassen');
  const text = frei ? (d.beschreibung ?? '').trim() : (d.beschreibung?.trim() || pr.text);
  if (frei && !text) throw new BusinessError('Bitte eine Beschreibung erfassen');
  const pos = await naechstePos(tx, rgnr);
  await tx`insert into tco.rgpos (rgnr_txt, rgpos, datum, dauer, prod_key, preis, description)
           values (${rgnr}, ${pos}, ${heute()}, ${String(d.menge)}, ${d.prod_key}, ${preis}, ${text})`;
  const betrag = await betragNeu(tx, rgnr);
  const hinweise: string[] = [];
  if ((d.prod_key === KEY_SCHLUESSEL_AUSGABE || d.prod_key === KEY_SCHLUESSEL_RUECKNAHME || pr.typ === '3') && k.adrnr) {
    hinweise.push(await schluesselFortschreiben(tx, k.adrnr, d.prod_key, rgnr));
  }
  return { rgpos: pos, betrag: runden(preis * d.menge), summe: betrag, hinweise: hinweise.filter(Boolean) };
}

async function schluesselFortschreiben(tx: Db, adrnr: string, key: string, rgnr: string): Promise<string> {
  const [{ datum }] = await tx`select angelegt_am::text as datum from tco.rgkopf where rgnr_txt = ${rgnr}`;
  const [s] = await tx`select counter, ausgabe::text, ruecknahme::text from tco.schluessel where adrnr = ${adrnr}`;
  if (key === KEY_SCHLUESSEL_RUECKNAHME) {
    if (!s?.ausgabe || s.ruecknahme) return 'Zu dieser Person ist kein ausgegebener Schlüssel erfasst';
    await tx`update tco.schluessel set ruecknahme = ${datum} where adrnr = ${adrnr}`;
    return `Schlüsselrückgabe zum ${dat(datum)} dokumentiert`;
  }
  if (s?.ausgabe && !s.ruecknahme) return `Achtung: seit ${dat(s.ausgabe)} ist bereits ein Schlüssel ausgegeben, die Schlüsselliste wurde nicht geändert`;
  const counter = String((Number(s?.counter ?? 0) || 0) + (s ? 1 : 1)).padStart(2, '0');
  await tx`insert into tco.schluessel (adrnr, counter, ausgabe, ruecknahme) values (${adrnr}, ${counter}, ${datum}, null)
           on conflict (adrnr) do update set counter = excluded.counter, ausgabe = excluded.ausgabe, ruecknahme = null,
                                             ausgabebeleg = null, ruecknahmebeleg = null`;
  return `Schlüsselausgabe zum ${dat(datum)} dokumentiert`;
}

/** Abo einer Serie als Einzelbuchungen abrechnen (ACT_BOOK_SINGLE) */
export async function aboEinzeln(tx: Db, bid: string) {
  await tx`insert into tco.bookings_ch (bid, status_abw) values (${bid}, '1')
           on conflict (bid) do update set status_abw = '1'`;
}

/** Abo wieder als Serie abrechnen (Rückweg, in SAP nicht vorhanden) */
export async function aboSerie(tx: Db, bid: string) {
  const [z] = await tx`select 1 from tco.bookings where bid = ${bid} and assigned = 'Y' limit 1`;
  if (z) throw new BusinessError('Einzelne Termine dieser Serie sind schon abgerechnet – Umstellen nicht möglich');
  await tx`delete from tco.bookings_ch where bid = ${bid}`;
}

/** Buchung irrelevant (ACT_BOOK_IRRELEVANT): Abo → alle Termine */
export async function irrelevant(tx: Db, bid: string, datum: string, zuruecknehmen = false) {
  const [b] = await tx`select b.status, c.status_abw from tco.bookings b left join tco.bookings_ch c on c.bid = b.bid
                        where b.bid = ${bid} and b.datum = ${datum}`;
  if (!b) throw new BusinessError(`Buchung ${bid} nicht gefunden`);
  const abo = b.status === '3' && b.status_abw !== '1';
  if (zuruecknehmen) {
    const [r] = await tx`select 1 from tco.rgpos where bid = ${bid} ${abo ? tx`` : tx`and datum = ${datum}`} limit 1`;
    if (r) throw new BusinessError('Die Buchung ist einer Rechnung zugeordnet – bitte dort entfernen');
    if (abo) await tx`update tco.bookings set assigned = '' where bid = ${bid}`;
    else await tx`update tco.bookings set assigned = '' where bid = ${bid} and datum = ${datum}`;
    return;
  }
  // „X“ = irrelevant (ohne Rechnung), „Y“ = abgerechnet; aus SAP übernommene Sätze tragen für beides „Y“
  if (abo) await tx`update tco.bookings set assigned = 'X' where bid = ${bid} and coalesce(assigned, '') = ''`;
  else await tx`update tco.bookings set assigned = 'X' where bid = ${bid} and datum = ${datum}`;
}

/** Statusänderungen der Rechnung */
export async function statusSetzen(tx: Db, rgnr: string, aktion: 'versendet' | 'bezahlt' | 'entsperren') {
  const k = await kopfLesen(tx, rgnr);
  if (aktion === 'versendet') {
    if (['4', '6'].includes(k.status)) throw new BusinessError(`Rechnung ${rgnr} ist bereits abgeschlossen`);
    const neu = k.status === '5' ? '5' : '3';
    await tx`update tco.rgkopf set versendet = ${heute()}, status = ${neu} where rgnr_txt = ${rgnr}`;
  } else if (aktion === 'bezahlt') {
    await tx`update tco.rgkopf set bezahlt = ${heute()}, status = '4' where rgnr_txt = ${rgnr}`;
  } else {
    if (k.status !== '3') throw new BusinessError('Nur versendete Rechnungen können wieder eröffnet werden');
    await tx`update tco.rgkopf set status = ${k.gedruckt ? '2' : '1'} where rgnr_txt = ${rgnr}`;
  }
  return k;
}

export async function kanalSichern(tx: Db, k: Kontakt | null, kanal: 'E' | 'W', benutzer: string) {
  if (!k) throw new BusinessError('Zu dieser Person ist keine Adressnummer bekannt');
  if (kanal === 'E' && !k.email) throw new BusinessError('Für diese Person ist keine E-Mail-Adresse hinterlegt');
  if (kanal === 'W' && !k.mobil) throw new BusinessError('Für diese Person ist keine Mobilnummer hinterlegt');
  await tx`insert into tco.kommpref (adrnr, kanal, geaendert_am, geaendert_von) values (${k.adrnr}, ${kanal}, ${heute()}, ${benutzer})
           on conflict (adrnr) do update set kanal = excluded.kanal, geaendert_am = excluded.geaendert_am, geaendert_von = excluded.geaendert_von`;
}

// ---------------------------------------------------------------------------
// Automatische Zuordnung (AUTO_VORSCHAU / AUTO_BUCHEN)
// ---------------------------------------------------------------------------

export async function autoVorschau(db: Db, v: Verein) {
  const buchungen = await offeneBuchungen(db, v);
  const kunden = [...new Set(buchungen.map((b) => b.kunde))].sort();
  const ziele = new Map<string, { rgnr: string; status: string; positionen: number }[]>();
  for (const k of kunden) {
    const r = await db`select k.rgnr_txt, k.status, k.versendet::text,
                              (select count(*)::int from tco.rgpos p where p.rgnr_txt = k.rgnr_txt) as positionen
                         from tco.rgkopf k where k.kunde = ${k} order by k.rgnr_txt desc`;
    ziele.set(k, r.filter((x) => rgAenderbar(x as never))
      .map((x) => ({ rgnr: x.rgnr_txt, status: x.status, positionen: Number(x.positionen) })));
  }
  return kunden.map((k) => {
    const z = ziele.get(k) ?? [];
    const vorschlag = z.find((x) => x.status === '1')?.rgnr ?? 'NEU';
    return {
      kunde: k,
      name: nameSchoen(k),
      ziele: z.map((x) => x.rgnr),
      zielInfo: z,
      ziel: vorschlag,
      buchungen: buchungen.filter((b) => b.kunde === k).map((b) => ({
        ...b,
        auswahl: !b.zukunft && !b.fehler,
        hinweis: b.fehler ? `Preisfehler: ${b.fehler}` : b.art === 'Abo' ? `Abo – gesamte Serie (${b.termine} Termine)` : '',
      })),
    };
  });
}

export async function autoBuchen(tx: Db, v: Verein, kunden: { kunde: string; ziel: string; buchungen: { bid: string; datum: string; ziel?: string }[] }[]) {
  let anzahl = 0;
  let neu = 0;
  let ergaenzt = 0;
  const gesperrt: string[] = [];
  let uebersprungen = 0;
  for (const k of kunden) {
    const proZiel = new Map<string, { bid: string; datum: string }[]>();
    for (const b of k.buchungen) {
      const z = b.ziel || k.ziel || 'NEU';
      proZiel.set(z, [...(proZiel.get(z) ?? []), b]);
    }
    for (const [ziel, liste] of proZiel) {
      let rgnr = ziel;
      if (ziel === 'NEU') {
        rgnr = await rechnungAnlegen(tx, k.kunde);
        neu++;
      } else {
        const [r] = await tx`select status, versendet::text from tco.rgkopf where rgnr_txt = ${ziel}`;
        if (!r || !rgAenderbar(r as never)) { gesperrt.push(ziel); uebersprungen += liste.length; continue; }
        ergaenzt++;
      }
      const e = await zuordnen(tx, v, rgnr, liste, { bisHeute: true });
      anzahl += e.anzahl;
      uebersprungen += liste.length - e.anzahl;
    }
  }
  let text = `${anzahl} Buchung(en) zugeordnet: ${neu} neue Rechnung(en), ${ergaenzt} bestehende ergänzt.`;
  if (uebersprungen) text += ` ${uebersprungen} Buchung(en) übersprungen (nicht mehr offen, zukünftig oder Ziel gesperrt).`;
  if (gesperrt.length) text += ` Gesperrte Zielrechnungen: ${gesperrt.join(', ')}.`;
  return { anzahl, neu, ergaenzt, text };
}
