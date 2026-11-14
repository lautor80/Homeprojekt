import { sql, type Tx } from '../../../server/src/db.js';
import { paperlessZugang } from '../../../server/src/lib/verbindungen.js';
import { BusinessError } from '../../../server/src/errors.js';

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------
export interface Adresse {
  adrnr: number;
  kundenname: string;
  kundenname2: string | null;
  anrede: string | null;
  name: string | null;
  vorname: string | null;
  strasse: string | null;
  hausnummer: string | null;
  land: string | null;
  plz: string | null;
  ort: string | null;
  telefon: string | null;
  fax: string | null;
  email: string | null;
  gln: string | null;
  markt: string | null;
  ustid: string | null;
}

export interface Stop {
  pos: number;
  firma: string | null;
  strasse: string | null;
  land: string | null;
  plzort: string | null;
  ladenummer: string | null;
  datum: string | null;
  zeit: string | null;
  firma_e: string | null;
  strasse_e: string | null;
  land_e: string | null;
  plzort_e: string | null;
  datum_e: string | null;
  zeit_e: string | null;
}

export interface Traeger {
  pos: number;
  produkt: string | null;
  prod_txt: string | null;
  menge: number;
  preis: number;
}

export interface Auftrag {
  auftragsnr: string;
  anlagedatum: string;
  kunde: number | null;
  unternehmer: number | null;
  rechnungsempfaenger: number | null;
  rgbetrag: number;
  kennzeichen: string | null;
  fahrzeugtyp: string | null;
  frachtpreis_ek: number;
  frachtpreis_vk: number;
  ladenummer: string | null;
  ladegut: string | null;
  gewicht: string | null;
  lademeter: number | null;
  ladeweise: string | null;
  palettentausch: string | null;
  ordernummer: string | null;
  datumladen1: string | null;
  datumentladen1: string | null;
  besonderheiten: string | null;
  faktura: string | null;
  fakturadatum: string | null;
  steuerrelevant: boolean;
  /** ohne MwSt: RC = Reverse Charge, DRITTLAND = steuerfreier Transport in ein Drittland (#121); null = aus dem Land abgeleitet */
  steuerbefreiung: 'RC' | 'DRITTLAND' | null;
  dok_fehlen: boolean;
  leistungsdatum: string | null;
}

export interface AuftragKomplett extends Auftrag {
  stops: Stop[];
  traeger: Traeger[];
  kundeAdr: Adresse | null;
  unternehmerAdr: Adresse | null;
  reAdr: Adresse | null;
  typ: 'F' | 'H';
}

export interface Firma {
  name: string;
  strasse: string;
  plz: string;
  ort: string;
  land: string;
  ustid: string;
  steuernr: string;
  kontakt: string;
  telefon: string;
  fax: string;
  email: string;
  bank: string;
  iban: string;
  bic: string;
  zahlungsziel_tage: number;
  ust_satz: number;
  rechnung_startnr: number;
  logo: string | null;
  /** aus core.verbindungen („paperless“), nur lesend */
  paperless_url: string;
  paperless_token: string;
  /** Auftragsbedingungen (AGB) auf dem Transportauftrag, Absätze durch Leerzeile getrennt */
  auftragsbedingungen?: string;
}

export type WerteTyp = 'FAHRZEUGTYP' | 'LADEGUT' | 'LADEWEISE' | 'PALETTENTAUSCH';
export const WERTE_TYPEN: WerteTyp[] = ['FAHRZEUGTYP', 'LADEGUT', 'LADEWEISE', 'PALETTENTAUSCH'];

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------
type Db = Tx;
const DB = sql as unknown as Tx;

/** Datum aus der DB (Date) als ISO-String JJJJ-MM-TT, ohne Zeitzonenverschiebung. */
export function isoDate(d: unknown): string | null {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const x = d as Date;
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

export const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
export const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

function mapAuftrag(r: Record<string, unknown>): Auftrag {
  return {
    auftragsnr: r.auftragsnr as string,
    anlagedatum: isoDate(r.anlagedatum)!,
    kunde: (r.kunde as number) ?? null,
    unternehmer: (r.unternehmer as number) ?? null,
    rechnungsempfaenger: (r.rechnungsempfaenger as number) ?? null,
    rgbetrag: num(r.rgbetrag),
    kennzeichen: r.kennzeichen as string | null,
    fahrzeugtyp: r.fahrzeugtyp as string | null,
    frachtpreis_ek: num(r.frachtpreis_ek),
    frachtpreis_vk: num(r.frachtpreis_vk),
    ladenummer: r.ladenummer as string | null,
    ladegut: r.ladegut as string | null,
    gewicht: r.gewicht as string | null,
    lademeter: r.lademeter === null || r.lademeter === undefined ? null : Number(r.lademeter),
    ladeweise: r.ladeweise as string | null,
    palettentausch: r.palettentausch as string | null,
    ordernummer: r.ordernummer as string | null,
    datumladen1: isoDate(r.datumladen1),
    datumentladen1: isoDate(r.datumentladen1),
    besonderheiten: r.besonderheiten as string | null,
    faktura: r.faktura as string | null,
    fakturadatum: isoDate(r.fakturadatum),
    steuerrelevant: !!r.steuerrelevant,
    steuerbefreiung: (r.steuerbefreiung as 'RC' | 'DRITTLAND' | null) ?? null,
    dok_fehlen: !!r.dok_fehlen,
    leistungsdatum: isoDate(r.leistungsdatum),
  };
}

const mapStop = (r: Record<string, unknown>): Stop => ({
  pos: Number(r.pos),
  firma: r.firma as string | null,
  strasse: r.strasse as string | null,
  land: r.land as string | null,
  plzort: r.plzort as string | null,
  ladenummer: r.ladenummer as string | null,
  datum: isoDate(r.datum),
  zeit: r.zeit as string | null,
  firma_e: r.firma_e as string | null,
  strasse_e: r.strasse_e as string | null,
  land_e: r.land_e as string | null,
  plzort_e: r.plzort_e as string | null,
  datum_e: isoDate(r.datum_e),
  zeit_e: r.zeit_e as string | null,
});

export const leererStop = (pos: number): Stop => ({
  pos, firma: null, strasse: null, land: null, plzort: null, ladenummer: null, datum: null, zeit: null,
  firma_e: null, strasse_e: null, land_e: null, plzort_e: null, datum_e: null, zeit_e: null,
});

export function stopHatDaten(s: Stop | undefined): boolean {
  return !!s && !!(s.firma || s.strasse || s.plzort || s.firma_e || s.strasse_e || s.plzort_e);
}

/**
 * Die Auftragsart ist nicht gespeichert – sie ergibt sich aus den Daten:
 * ohne Stops, aber mit Trägermengen = Holzträgerauftrag (H), sonst Frachtauftrag (F).
 */
export function auftragsTyp(stops: Stop[], traeger: Traeger[]): 'F' | 'H' {
  const hatStops = stops.some(stopHatDaten);
  const hatMenge = traeger.some((t) => t.menge > 0);
  return !hatStops && hatMenge ? 'H' : 'F';
}

/**
 * Rechnungsbetrag wie in ZCL_EU_AUFTRAG=>AUFTRAG_SPEICHERN:
 *   Summe Träger (Menge × Preis) + Frachtpreis EK, bei Steuerpflicht × (1 + USt-Satz).
 */
export function rechnungsbetrag(a: Pick<Auftrag, 'frachtpreis_ek' | 'steuerrelevant'>, traeger: Traeger[], ustSatz: number): number {
  let b = traeger.reduce((s, t) => s + t.menge * t.preis, 0) + a.frachtpreis_ek;
  if (a.steuerrelevant) b = (b * (100 + ustSatz)) / 100;
  return round2(b);
}

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------
/** Firmendaten; Paperless-Zugang kommt aus der eigenen Anbindung „Paperless-ngx Euroflex“ (Administration → Schnittstellen → Anbindungen; #232, S5) */
export async function firmaLesen(db: Db = DB): Promise<Firma> {
  const [f] = await db`select * from transport.firma where id = 1`;
  const pl = await paperlessZugang('transport', db);
  return {
    ...(f as unknown as Firma), zahlungsziel_tage: Number(f.zahlungsziel_tage), ust_satz: Number(f.ust_satz), rechnung_startnr: Number(f.rechnung_startnr),
    paperless_url: pl.url ?? '', paperless_token: pl.token ?? '',
  };
}

export async function adresseLesen(adrnr: number | null, db: Db = DB): Promise<Adresse | null> {
  if (!adrnr) return null;
  const [a] = await db`select * from transport.adressen where adrnr = ${adrnr}`;
  return (a as unknown as Adresse) ?? null;
}

export async function auftragLesen(nr: string, db: Db = DB): Promise<AuftragKomplett> {
  const [r] = await db`select * from transport.auftraege where auftragsnr = ${nr}`;
  if (!r) throw new BusinessError(`Auftrag ${nr} nicht gefunden.`, 404);
  const a = mapAuftrag(r);
  const stopRows = await db`select * from transport.stops where auftragsnr = ${nr} order by pos`;
  const trRows = await db`select pos, produkt, prod_txt, menge, preis from transport.traeger where auftragsnr = ${nr} order by pos`;
  const stops = stopRows.map(mapStop);
  const traeger = trRows.map((t) => ({ pos: Number(t.pos), produkt: t.produkt, prod_txt: t.prod_txt, menge: Number(t.menge), preis: num(t.preis) }));
  // immer zwei Stops liefern (Oberfläche zeigt erster/zweiter Stop)
  const s1 = stops.find((s) => s.pos === 1) ?? leererStop(1);
  const s2 = stops.find((s) => s.pos === 2) ?? leererStop(2);
  return {
    ...a,
    stops: [s1, s2],
    traeger,
    kundeAdr: await adresseLesen(a.kunde, db),
    unternehmerAdr: await adresseLesen(a.unternehmer, db),
    reAdr: await adresseLesen(a.rechnungsempfaenger, db),
    typ: auftragsTyp([s1, s2], traeger),
  };
}

export async function werteLesen(db: Db = DB) {
  const rows = await db`select typ, schluessel, text, sort, aktiv from transport.werte order by typ, sort, schluessel`;
  const res: Record<WerteTyp, { key: string; text: string; aktiv: boolean }[]> = {
    FAHRZEUGTYP: [], LADEGUT: [], LADEWEISE: [], PALETTENTAUSCH: [],
  };
  for (const r of rows) res[r.typ as WerteTyp].push({ key: r.schluessel, text: r.text, aktiv: r.aktiv });
  return res;
}

export async function wertText(typ: WerteTyp, key: string | null, db: Db = DB): Promise<string> {
  if (!key) return '';
  const [r] = await db`select text from transport.werte where typ = ${typ} and schluessel = ${key}`;
  return r?.text ?? key;
}

/** Aktive Produkte als Vorschlag für die Trägerbestellung. */
export async function traegerVorschlag(db: Db = DB): Promise<Traeger[]> {
  const rows = await db`select prod_key, text, preis from transport.produkte
                        where gueltig_bis is null or gueltig_bis >= current_date
                        order by sort, prod_key`;
  return rows.map((p, i) => ({ pos: i + 1, produkt: p.prod_key, prod_txt: p.text, menge: 0, preis: num(p.preis) }));
}

/** Alle Aufträge einer Faktura (Einzel- oder Sammelrechnung), sortiert nach Auftragsnummer. */
export async function fakturaAuftraege(faktura: string, db: Db = DB): Promise<AuftragKomplett[]> {
  const rows = await db`select auftragsnr from transport.auftraege where faktura = ${faktura} order by auftragsnr`;
  const res: AuftragKomplett[] = [];
  for (const r of rows) res.push(await auftragLesen(r.auftragsnr, db));
  return res;
}

/** Rechnungsempfänger: abweichender Rechnungsempfänger vor Kunde (vom ersten Auftrag). */
export const kaeufer = (a: AuftragKomplett): Adresse | null => a.reAdr ?? a.kundeAdr;

// ---------------------------------------------------------------------------
// Nummernkreise (Format JJJJ_NNNN)
// ---------------------------------------------------------------------------
export const NR_AUFTRAG = 'TRANSPORT_AUFTRAG';
export const NR_RECHNUNG = 'TRANSPORT_RECHNUNG';

/** Nächste Nummer im Format JJJJ_NNNN innerhalb der laufenden Transaktion. */
export async function naechsteNummer(tx: Tx, id: string, jahr: number, start = 1): Promise<string> {
  await tx`insert into core.number_ranges (id, year, last_value) values (${id}, ${jahr}, ${start - 1})
           on conflict (id, year) do nothing`;
  const [{ n }] = await tx`select core.next_number(${id}, ${jahr}) as n`;
  return `${jahr}_${String(n).padStart(4, '0')}`;
}

/** Vorschau der nächsten Nummer (ohne sie zu verbrauchen). */
export async function nummerVorschau(id: string, jahr: number, start = 1): Promise<string> {
  const [r] = await sql`select last_value from core.number_ranges where id = ${id} and year = ${jahr}`;
  const n = r ? Number(r.last_value) + 1 : start;
  return `${jahr}_${String(n).padStart(4, '0')}`;
}

/** Nummernkreis mindestens auf den Wert ziehen (z. B. nach Import). Liefert true, wenn angepasst. */
export async function nummernkreisNachziehen(tx: Tx, id: string, jahr: number, mindestens: number): Promise<boolean> {
  const r = await tx`
    insert into core.number_ranges (id, year, last_value) values (${id}, ${jahr}, ${mindestens})
    on conflict (id, year) do update set last_value = excluded.last_value
      where core.number_ranges.last_value < excluded.last_value
    returning 1`;
  return r.count > 0;
}

/** Nächste freie Adressnummer (höchste + 1, wie im Altreport). */
export async function naechsteAdrnr(tx: Tx): Promise<number> {
  await tx`select pg_advisory_xact_lock(4721)`;
  const [{ m }] = await tx`select coalesce(max(adrnr), 0)::int as m from transport.adressen`;
  return m + 1;
}
