import { BusinessError } from '../../../../server/src/errors.js';
import { addTage, runden } from '../format.js';
import type { Db, Verein } from '../verein.js';

/**
 * Clubhausabrechnung – Port von Z2UI5_CL_TCO_CLUBHAUSABR / ZCL_TCO_CLUBHAUS.
 * Getränkerechnungen (tco.werg) mit EK-Preisen, Forderungsliste je Monat gegenüber
 * der Clubhauswirtin (VK der eingekauften Getränke − Reinigung − Provision − Einzahlungen),
 * Absatzstatistik und Zuordnung der Paperless-Belege über die FI-Zuordnung.
 */

export const PFANDRUECKGABE = 'PFANDRÜCKGABE';
export const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MWST = 1.19;
const TOL = 0.05;
const MAX_TAGE = 60;

export interface ChCfg { konto_einnahmen: string; konto_ware: string; reinigung: number; provision: number; wirt: string; feld_json: string }
export const chCfg = (v: Verein): ChCfg => ({
  konto_einnahmen: v.ch_konto_einnahmen, konto_ware: v.ch_konto_ware, reinigung: Number(v.ch_reinigung),
  provision: Number(v.ch_provision), wirt: v.ch_wirt, feld_json: v.ch_feld_json,
});

// ---------------------------------------------------------------------------
// Getränke (tco.produkte, Schlüssel ab 100)
// ---------------------------------------------------------------------------

export interface Getraenk { prod_key: string; valid_from: string; valid_to: string; text: string; preis: number; menge: number }

export async function getraenkeLesen(db: Db): Promise<Getraenk[]> {
  const r = await db`select prod_key, to_char(valid_from, 'YYYY-MM-DD') as valid_from, to_char(valid_to, 'YYYY-MM-DD') as valid_to,
                            upper(trim(coalesce(text, ''))) as text, coalesce(preis, 0)::float8 as preis, menge
                       from tco.produkte where length(prod_key) = 3 and prod_key >= '100' and prod_key < '200'
                      order by prod_key::int, valid_from`;
  return r.map((x) => ({ ...x, menge: Number(String(x.menge ?? '').replace(',', '.')) || 0 })) as unknown as Getraenk[];
}

/** Getränk mit Gültigkeit zum Datum (sonst der nächste noch gültige Satz) */
export function getraenkAm(g: Getraenk[], text: string, datum: string): Getraenk | undefined {
  const l = g.filter((x) => x.text === text.toUpperCase());
  return l.find((x) => x.valid_from <= datum && x.valid_to >= datum) ?? l.find((x) => x.valid_to >= datum) ?? l[l.length - 1];
}

/** Produktliste für die Erfassung (je Schlüssel der jüngste Text) */
export function produktliste(g: Getraenk[]): string[] {
  const m = new Map<string, Getraenk>();
  for (const x of g) m.set(x.prod_key, x);
  const keys = [...m.keys()].sort((a, b) => Number(a) - Number(b));
  return [...new Set(keys.map((k) => m.get(k)!.text).filter(Boolean))];
}

export async function getraenkSpeichern(tx: Db, d: { prod_key: string | null; text: string; menge: number; preis: number; ab: string }) {
  const text = d.text.trim().toUpperCase();
  if (!text) throw new BusinessError('Bitte einen Produkttext angeben.');
  if (!(d.preis >= 0) || !(d.menge > 0)) throw new BusinessError('Bitte VK-Preis je Flasche und Flaschen je Kiste angeben.');
  let key = d.prod_key;
  if (!key) {
    const [n] = await tx`select coalesce(max(prod_key::int), 99) + 1 as k from tco.produkte where length(prod_key) = 3 and prod_key >= '100' and prod_key < '190'`;
    key = String(n.k);
    const [dup] = await tx`select 1 from tco.produkte where length(prod_key) = 3 and prod_key >= '100' and prod_key < '200' and upper(trim(text)) = ${text}`;
    if (dup) throw new BusinessError(`Das Getränk „${text}“ gibt es bereits.`);
    await tx`insert into tco.produkte (prod_key, valid_from, valid_to, text, preis, typ, menge) values (${key}, ${d.ab}, '9999-12-31', ${text}, ${d.preis}, 'G', ${String(d.menge)})`;
    return `Getränk ${text} angelegt.`;
  }
  const [c] = await tx`select prod_key, to_char(valid_from, 'YYYY-MM-DD') as valid_from, to_char(valid_to, 'YYYY-MM-DD') as valid_to, typ
                         from tco.produkte where prod_key = ${key} and valid_from <= ${d.ab} and valid_to >= ${d.ab}`;
  if (!c) throw new BusinessError('Zu diesem Datum gibt es keinen gültigen Satz.');
  if (c.valid_from === d.ab) {
    await tx`update tco.produkte set text = ${text}, preis = ${d.preis}, menge = ${String(d.menge)}
              where prod_key = ${key} and valid_from = ${c.valid_from} and valid_to = ${c.valid_to}`;
    return 'Getränk geändert.';
  }
  await tx`update tco.produkte set valid_to = ${addTage(d.ab, -1)} where prod_key = ${key} and valid_from = ${c.valid_from} and valid_to = ${c.valid_to}`;
  await tx`insert into tco.produkte (prod_key, valid_from, valid_to, text, preis, typ, menge) values (${key}, ${d.ab}, ${c.valid_to}, ${text}, ${d.preis}, ${c.typ}, ${String(d.menge)})`;
  return `Neuer Preis ab ${d.ab.split('-').reverse().join('.')} angelegt.`;
}

// ---------------------------------------------------------------------------
// Getränkerechnungen
// ---------------------------------------------------------------------------

export interface Pos { produkt: string; anzahl: number; ekpreis: number; ekpreis_vor: number; pospreis: number; brutto: number }

/** Netto/Brutto einer Zeile (Pfandrückgabe negativ und ohne MwSt.) */
export function rechnen(p: Pick<Pos, 'produkt' | 'anzahl' | 'ekpreis'> & { ekpreis_vor?: number }): Pos {
  const vor = p.ekpreis_vor ?? 0;
  if (!(p.anzahl > 0)) return { produkt: p.produkt, anzahl: 0, ekpreis: 0, ekpreis_vor: p.ekpreis ? Math.abs(p.ekpreis) : vor, pospreis: 0, brutto: 0 };
  let ek = p.ekpreis || vor;
  if (p.produkt === PFANDRUECKGABE && ek > 0) ek = -ek;
  const pos = p.anzahl * ek;
  return { produkt: p.produkt, anzahl: p.anzahl, ekpreis: ek, ekpreis_vor: vor || Math.abs(ek), pospreis: runden(pos), brutto: runden(p.produkt === PFANDRUECKGABE ? pos : pos * MWST) };
}

export async function letztePreise(db: Db): Promise<Map<string, number>> {
  const r = await db`select distinct on (upper(produkt)) upper(produkt) as produkt, ekpreis::float8 as ekpreis
                       from tco.werg where anzahl > 0 order by upper(produkt), datum desc, rgnr desc`;
  return new Map(r.map((x) => [x.produkt, Number(x.ekpreis)]));
}

export interface RgKopf { rgnr: string; datum: string; brutto: number; positionen: number; belege: string[] }

export async function rechnungenLesen(db: Db, jahr: number): Promise<RgKopf[]> {
  const r = await db`select rgnr, to_char(datum, 'YYYY-MM-DD') as datum, upper(produkt) as produkt, anzahl::float8 as anzahl, ekpreis::float8 as ekpreis
                       from tco.werg where datum between ${`${jahr}-01-01`} and ${`${jahr}-12-31`} order by rgnr, rgpos`;
  const b = await db`select rgnr, doknr from tco.werg_beleg order by rgnr, doknr`;
  const m = new Map<string, RgKopf>();
  for (const x of r) {
    const k = m.get(x.rgnr) ?? { rgnr: x.rgnr, datum: x.datum, brutto: 0, positionen: 0, belege: [] };
    k.datum = x.datum;
    k.brutto = runden(k.brutto + rechnen(x as any).brutto);
    k.positionen++;
    m.set(x.rgnr, k);
  }
  for (const x of b) m.get(x.rgnr)?.belege.push(x.doknr);
  return [...m.values()].sort((a, c) => c.datum.localeCompare(a.datum) || c.rgnr.localeCompare(a.rgnr));
}

/** Volle Produktvorlage mit letzten Preisen; gespeicherte Positionen darübergelegt */
export async function rechnungLesen(db: Db, rgnr: string | null): Promise<{ rgnr: string; datum: string | null; pos: Pos[] }> {
  const liste = produktliste(await getraenkeLesen(db));
  const preise = await letztePreise(db);
  const pos: Pos[] = liste.map((p) => rechnen({ produkt: p, anzahl: 0, ekpreis: 0, ekpreis_vor: preise.get(p) ?? 0 }));
  let datum: string | null = null;
  if (rgnr) {
    const r = await db`select to_char(datum, 'YYYY-MM-DD') as datum, upper(produkt) as produkt, anzahl::float8 as anzahl, ekpreis::float8 as ekpreis
                         from tco.werg where rgnr = ${rgnr} order by rgpos`;
    if (!r.length) throw new BusinessError(`Rechnung ${rgnr} nicht gefunden.`);
    for (const x of r) {
      datum = x.datum;
      const i = pos.findIndex((p) => p.produkt === x.produkt);
      const z = rechnen({ produkt: x.produkt, anzahl: Number(x.anzahl), ekpreis: Number(x.ekpreis) });
      if (i >= 0) pos[i] = z; else pos.push(z);
    }
  }
  return { rgnr: rgnr ?? '', datum, pos };
}

export async function rechnungSpeichern(tx: Db, d: { rgnrAlt: string | null; rgnr: string; datum: string; pos: { produkt: string; anzahl: number; ekpreis: number }[] }) {
  const rgnr = d.rgnr.trim();
  if (!rgnr) throw new BusinessError('Bitte eine Rechnungsnummer eingeben.');
  const zeilen = d.pos.filter((p) => p.anzahl > 0).map((p) => rechnen(p));
  if (!zeilen.length) throw new BusinessError('Keine Positionen mit Anzahl > 0 – nichts gespeichert.');
  if (zeilen.some((p) => !Number.isInteger(p.anzahl) || p.anzahl > 9999)) throw new BusinessError('Die Anzahl bitte als ganze Zahl angeben.');
  const monate = new Set<string>([d.datum.slice(0, 7)]);
  if (d.rgnrAlt && d.rgnrAlt !== rgnr) {
    const [x] = await tx`select 1 from tco.werg where rgnr = ${rgnr}`;
    if (x) throw new BusinessError(`Die Rechnungsnummer ${rgnr} gibt es bereits.`);
  } else if (!d.rgnrAlt) {
    const [x] = await tx`select 1 from tco.werg where rgnr = ${rgnr}`;
    if (x) throw new BusinessError(`Die Rechnungsnummer ${rgnr} gibt es bereits – bitte die vorhandene Rechnung öffnen.`);
  }
  const alt = d.rgnrAlt ?? rgnr;
  for (const r of await tx`select distinct to_char(datum, 'YYYY-MM') as m from tco.werg where rgnr = ${alt}`) monate.add(r.m);
  await tx`delete from tco.werg where rgnr = ${alt}`;
  let i = 0;
  for (const p of zeilen) {
    await tx`insert into tco.werg (rgnr, rgpos, datum, produkt, anzahl, ekpreis) values (${rgnr}, ${++i}, ${d.datum}, ${p.produkt}, ${p.anzahl}, ${p.ekpreis})`;
  }
  if (alt !== rgnr) await tx`update tco.werg_beleg set rgnr = ${rgnr} where rgnr = ${alt}`;
  return { anzahl: zeilen.length, monate: [...monate] };
}

export async function rechnungLoeschen(tx: Db, rgnr: string) {
  const m = await tx`select distinct to_char(datum, 'YYYY-MM') as m from tco.werg where rgnr = ${rgnr}`;
  await tx`delete from tco.werg_beleg where rgnr = ${rgnr}`;
  await tx`delete from tco.werg where rgnr = ${rgnr}`;
  return m.map((x) => x.m as string);
}

// ---------------------------------------------------------------------------
// Belegtext (JSON aus Paperless/n8n oder OCR-Text) → Positionen
// ---------------------------------------------------------------------------

const REGELN: [string, string | null, string][] = [
  ['PFANDR', null, 'PFANDRÜCKGABE'], ['RÜCKGABE', null, 'PFANDRÜCKGABE'], ['LEERGUT', null, 'PFANDRÜCKGABE'], ['PFAND', null, 'PFAND'],
  ['DIESEL', null, 'DIESELPAUSCHALE'], ['LOGISTIK', null, 'DIESELPAUSCHALE'],
  ['PAULAN', 'RADLER', 'PAULANER WEIZENRADLER'], ['PAULAN', null, 'PAULANER WEIZENBIER'],
  ['FRANZISK', 'DUNKEL', 'FRANZISKANER DUNKEL'], ['FRANZISK', null, 'FRANZISKANER HEFE-TRÜB'], ['ERDINGER', null, 'ERDINGER ALKOHOLFREI'],
  ['BITBURG', 'RADLER', 'BITBURGER RADLER'], ['BITBURG', '0,0', 'BITBURGER 0,0%'], ['BITBURG', null, 'BITBURGER PILS'],
  ['GRAPEFRUIT', null, 'KARLSBERG GRÜNDELS GRAPEFRUIT'], ['FRESH', null, 'KARLSBERG GRÜNDELS FRESH'], ['FEINGOLD', null, 'KARLSBERG FEINGOLD'],
  ['GRÜNDELS', null, 'KARLSBERG GRÜNDELS'], ['KARLSBERG', 'LIGHT', 'KARLSBERG LIGHT'], ['KARLSBERG', null, 'KARLSBERG URPILS'],
  ['UR-PILS', null, 'KARLSBERG URPILS'], ['URPILS', null, 'KARLSBERG URPILS'], ['KB ', null, 'KARLSBERG GRÜNDELS GRAPEFRUIT'],
  ['MALZ', null, 'MALZBIER'], ['ORANGINA', null, 'ORANGINA'], ['COLA', null, 'COLA, LIMO 0,2 L'], ['LIMO', null, 'COLA, LIMO 0,2 L'],
  ['SPRUDEL', '0,7', 'MINERALWASSER 0,7 L'], ['SPRUDEL', null, 'MINERALWASSER 0,25 L'], ['GEROLST', '0,7', 'MINERALWASSER 0,7 L'],
  ['GEROLST', null, 'MINERALWASSER 0,25 L'], ['WASSER', '0,7', 'MINERALWASSER 0,7 L'], ['WASSER', null, 'MINERALWASSER 0,25 L'],
  ['SCHWEPPES', null, 'SCHWEPPES'], ['SÄFTE', '1 L', 'SÄFTE 1 L'], ['SAFT', null, 'SÄFTE 0,2 L'], ['SÄFTE', null, 'SÄFTE 0,2 L'],
  ['WEIN', null, 'WEIN'], ['SPIRITUOSE', null, 'SPIRITUOSEN'],
];

export function produktZuText(zeile: string): string | null {
  const z = zeile.toUpperCase();
  return REGELN.find(([k1, k2]) => z.includes(k1) && (!k2 || z.includes(k2)))?.[2] ?? null;
}

/** deutsche Beträge inkl. typischer OCR-Fehler ("17:18", "15,47,", "1.234,50") */
export function zahlLesen(t: string): number | null {
  let v = t.replace(/[^0-9,.:]/g, '').replace(/:/g, ',').replace(/^[,.]+|[,.]+$/g, '');
  if (!v) return null;
  if (v.includes(',') && v.includes('.')) v = v.replace(/\./g, '');
  v = v.replace(/,/g, '.');
  if ((v.match(/\./g) ?? []).length > 1) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Positionen aus einem Belegtext übernehmen: JSON (Feld „JSON“ in Paperless, n8n) oder OCR-Zeilen.
 * Mehrere Zeilen auf dasselbe Produkt ergeben einen gewichteten Durchschnittspreis.
 */
export function belegtextUebernehmen(text: string, pos: Pos[], kopf: { rgnr: string; datum: string }) {
  const out = pos.map((p) => ({ ...p }));
  const warn: string[] = [];
  const prot: string[] = [];
  let ok = 0, rep = 0, n = 0;
  const setzen = (produkt: string, menge: number, preis: number, quelle: string) => {
    const p = out.find((x) => x.produkt === produkt);
    if (!p) { warn.push(`„${quelle}“ → ${produkt} nicht in der Produktliste`); return; }
    if (p.anzahl > 0 && p.ekpreis !== preis) {
      const w = p.anzahl * p.ekpreis + menge * preis;
      p.anzahl += menge;
      p.ekpreis = runden(w / p.anzahl);
      prot.push(`${produkt}: mehrere Zeilen, Durchschnittspreis gebildet`);
    } else { p.anzahl += menge; p.ekpreis = preis; }
    Object.assign(p, rechnen(p));
    ok++;
  };
  const t = text.trim();
  if (t.startsWith('{')) {
    let j: { auftragsnummer?: string; datum?: string; positionen?: { menge?: number; text?: string; preis?: number; gesamt?: number }[] };
    try { j = JSON.parse(t); } catch { return { pos: out, kopf, info: 'JSON konnte nicht gelesen werden.', warn: '' }; }
    if (!j.positionen?.length) return { pos: out, kopf, info: 'JSON enthält keine Positionen.', warn: '' };
    if (!kopf.rgnr && j.auftragsnummer) kopf = { ...kopf, rgnr: String(j.auftragsnummer).trim() };
    const d = String(j.datum ?? '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) kopf = { ...kopf, datum: d };
    else if (/^\d{2}\.\d{2}\.\d{4}$/.test(d)) kopf = { ...kopf, datum: d.split('.').reverse().join('-') };
    for (const p of j.positionen) {
      n++;
      const produkt = produktZuText(p.text ?? '');
      const menge = Number(p.menge ?? 0);
      if (!produkt) { warn.push(`„${p.text}“ (Menge ${menge}, ${p.preis} EUR)`); continue; }
      if (!(menge > 0)) { warn.push(`„${p.text}“ → keine Menge erkannt`); continue; }
      let preis = Number(p.preis ?? 0);
      if (p.gesamt && Math.abs(menge * preis - p.gesamt) > 0.02) {
        const c = runden(p.gesamt / menge);
        if (c > 0 && c < 1000) { preis = c; rep++; }
      }
      setzen(produkt, menge, preis, p.text ?? '');
    }
    return {
      pos: out, kopf,
      info: `JSON: ${ok} von ${n} Positionen übernommen${rep ? `, ${rep} Preise korrigiert` : ''}. Bitte Werte prüfen!`,
      warn: warn.length ? `${warn.length} Position(en) nicht zugeordnet – bitte manuell ergänzen: ${warn.join(' · ')}` : '',
    };
  }
  for (const zeile of t.split(/\r?\n/)) {
    const produkt = produktZuText(zeile);
    if (!produkt) continue;
    const tok = zeile.replace(/\s+/g, ' ').trim().split(' ');
    let menge = 0, vorInt = false;
    for (const x of tok) {
      const c = x.replace(/[^0-9]/g, '');
      const istInt = !!c && c.length <= 2 && c === x.replace(/[,.]$/, '');
      if (istInt) { menge = Number(c); if (vorInt) break; vorInt = true; } else if (vorInt) break;
    }
    if (!(menge > 0)) { warn.push(`„${zeile.trim()}“ → Menge unklar`); continue; }
    let gesamt: number | null = null, preis: number | null = null;
    for (let i = tok.length - 1; i >= 0 && (gesamt === null || preis === null); i--) {
      const w = zahlLesen(tok[i]);
      if (w !== null && w > 0) { if (gesamt === null) gesamt = w; else preis = w; }
    }
    let status = '';
    if (preis !== null && gesamt !== null && Math.abs(menge * preis - gesamt) <= 0.02) status = 'OK';
    else if (gesamt !== null && gesamt / menge < 1000) {
      const c = runden(gesamt / menge);
      if (Math.abs(menge * c - gesamt) <= 0.02) { preis = c; status = 'REP'; }
    }
    if (!status && preis !== null && preis < 1000) status = 'OHNE_GESAMT';
    if (!status) { warn.push(`„${zeile.trim()}“ → Beträge unklar`); continue; }
    if (status === 'REP') rep++;
    setzen(produkt, menge, preis!, zeile.trim());
  }
  return {
    pos: out, kopf,
    info: `${ok} Positionen übernommen${rep ? `, ${rep} Preise aus Gesamtbetrag korrigiert` : ''}${prot.length ? `. ${prot.join(' / ')}` : ''}. Bitte Werte prüfen!`,
    warn: warn.length ? `${warn.length} Zeile(n) nicht zugeordnet – bitte manuell ergänzen: ${warn.join(' · ')}` : '',
  };
}

// ---------------------------------------------------------------------------
// Forderungsliste
// ---------------------------------------------------------------------------

export interface Ford {
  jahr: number; monat: number; ekbrutto: number; vkbrutto: number; reinigung: number; provision: number; forderung: number;
  einzahlungen: number; offene_posten: number; doc_id: number | null;
}

const montage = (jahr: number, monat: number) => {
  let n = 0;
  const tage = new Date(Date.UTC(jahr, monat, 0)).getUTCDate();
  for (let d = 1; d <= tage; d++) if (new Date(Date.UTC(jahr, monat - 1, d)).getUTCDay() === 1) n++;
  return n;
};

async function uebertrag(tx: Db, jahr: number, monat: number): Promise<number> {
  const [vj, vm] = monat === 1 ? [jahr - 1, 12] : [jahr, monat - 1];
  const r = await tx`select monat, offene_posten::float8 as op from tco.forderungen where jahr = ${vj} and monat in (${vm}, 13) order by monat`;
  return Number(r.find((x) => x.monat === vm)?.op ?? (vm === 12 ? r.find((x) => x.monat === 13)?.op : 0) ?? 0);
}

/** Monat und Folgemonate bis Dezember neu berechnen (+ Endübertrag 13) */
export async function forderungBerechnen(tx: Db, v: Verein, jahr: number, abMonat: number): Promise<void> {
  const cfg = chCfg(v);
  const g = await getraenkeLesen(tx);
  let op = await uebertrag(tx, jahr, abMonat);
  for (let m = abMonat; m <= 12; m++) {
    const von = `${jahr}-${String(m).padStart(2, '0')}-01`;
    const bis = new Date(Date.UTC(jahr, m, 0)).toISOString().slice(0, 10);
    const w = await tx`select to_char(datum, 'YYYY-MM-DD') as datum, upper(produkt) as produkt, anzahl::float8 as anzahl, ekpreis::float8 as ekpreis
                         from tco.werg where datum between ${von} and ${bis}`;
    let ek = 0, vk = 0;
    for (const x of w) {
      ek += rechnen(x as any).brutto;
      const p = getraenkAm(g, x.produkt, x.datum);
      if (p) vk += p.menge * p.preis * Number(x.anzahl);
    }
    const reinigung = -runden(montage(jahr, m) * cfg.reinigung);
    const provision = -runden(vk * cfg.provision / 100);
    vk = runden(vk);
    const forderung = runden(vk + reinigung + provision);
    const [e] = await tx`select coalesce(sum(betrag), 0)::float8 as s from tco.fibuchungen where konto = ${cfg.konto_einnahmen} and jahr = ${jahr} and monat = ${m}`;
    const einzahlungen = -runden(Number(e.s));
    op = runden(op + forderung + einzahlungen);
    await tx`insert into tco.forderungen (jahr, monat, ekbrutto, vkbrutto, reinigung, provision, forderung, einzahlungen, offene_posten, waers)
             values (${jahr}, ${m}, ${runden(ek)}, ${vk}, ${reinigung}, ${provision}, ${forderung}, ${einzahlungen}, ${op}, 'EUR')
             on conflict (jahr, monat) do update set ekbrutto = excluded.ekbrutto, vkbrutto = excluded.vkbrutto, reinigung = excluded.reinigung,
               provision = excluded.provision, forderung = excluded.forderung, einzahlungen = excluded.einzahlungen,
               offene_posten = excluded.offene_posten, waers = 'EUR'`;
  }
  await tx`insert into tco.forderungen (jahr, monat, offene_posten, waers) values (${jahr}, 13, ${op}, 'EUR')
           on conflict (jahr, monat) do update set offene_posten = excluded.offene_posten`;
}

export async function forderungenLesen(db: Db, jahr: number): Promise<Ford[]> {
  const r = await db`select jahr, monat, coalesce(ekbrutto, 0)::float8 as ekbrutto, coalesce(vkbrutto, 0)::float8 as vkbrutto,
                            coalesce(reinigung, 0)::float8 as reinigung, coalesce(provision, 0)::float8 as provision,
                            coalesce(forderung, 0)::float8 as forderung, coalesce(einzahlungen, 0)::float8 as einzahlungen,
                            coalesce(offene_posten, 0)::float8 as offene_posten,
                            case when rechnung ~ '^[0-9]+$' then rechnung::int end as doc_id
                       from tco.forderungen where jahr = ${jahr} order by monat`;
  const l = r as unknown as Ford[];
  const leer = (monat: number, op = 0): Ford => ({ jahr, monat, ekbrutto: 0, vkbrutto: 0, reinigung: 0, provision: 0, forderung: 0, einzahlungen: 0, offene_posten: op, doc_id: null });
  if (!l.some((x) => x.monat === 0)) {
    const [u] = await db`select offene_posten::float8 as op from tco.forderungen where jahr = ${jahr - 1} and monat = 13`;
    if (u) l.unshift(leer(0, Number(u.op)));
  }
  for (let m = 1; m <= 12; m++) if (!l.some((x) => x.monat === m)) l.push(leer(m));
  return l.sort((a, b) => a.monat - b.monat);
}

export async function einzahlungenLesen(db: Db, v: Verein, jahr: number, bisMonat: number) {
  const manuell = (v.fi_manuell_konten ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const r = await db`select to_char(datum, 'YYYY-MM-DD') as datum, text, betrag::float8 as betrag, gkonto, internenr
                       from tco.fibuchungen where konto = ${v.ch_konto_einnahmen} and jahr = ${jahr} and monat <= ${bisMonat}
                      order by datum, internenr`;
  return r.map((x) => ({ ...x, bar: manuell.includes(x.gkonto ?? '') })) as unknown as { datum: string; text: string; betrag: number; gkonto: string; internenr: string; bar: boolean }[];
}

// ---------------------------------------------------------------------------
// Absatzstatistik (Rohdaten je Jahr und Produkt)
// ---------------------------------------------------------------------------

export async function absatzLesen(db: Db, provisionProz: number) {
  const g = await getraenkeLesen(db);
  const stamm = new Map<string, Getraenk>();
  for (const x of g) stamm.set(x.text, x); // jüngster Satz je Text
  const w = await db`select extract(year from datum)::int as jahr, upper(produkt) as produkt, sum(anzahl)::float8 as anzahl,
                            sum(anzahl * ekpreis)::float8 as ek_ges
                       from tco.werg where datum is not null and coalesce(produkt, '') <> '' group by 1, 2 order by 1, 2`;
  const fehlt = new Set<string>();
  const rows = [];
  for (const x of w) {
    const s = stamm.get(x.produkt);
    if (!s) { fehlt.add(x.produkt); continue; }
    const flaschen = x.anzahl * s.menge;
    const vk = flaschen * s.preis;
    const prov = vk * provisionProz / 100;
    rows.push({ jahr: x.jahr, produkt: x.produkt, vkmenge: s.menge, vkpreis: s.preis, anzahl: x.anzahl, flaschen, ek_ges: x.ek_ges, vk_ges: vk, provision: prov, ergebnis: vk - prov - x.ek_ges });
  }
  const jahre = [...new Set(rows.map((r) => r.jahr))].sort().slice(-12);
  return { rows: rows.filter((r) => jahre.includes(r.jahr)), jahre, fehlt: [...fehlt] };
}

// ---------------------------------------------------------------------------
// Paperless-Belege (Kandidaten über die FI-Zuordnung auf dem Wareneingangskonto)
// ---------------------------------------------------------------------------

export interface PlDoc { doknr: string; internenr: string | null; titel: string; created: string | null; betrag: number; auftragsnr: string; json: string | null }

export async function kandidatenIds(db: Db, v: Verein, jahr: number): Promise<{ doknr: string; internenr: string }[]> {
  const r = await db`select distinct on (ltrim(m.doknr, '0')) ltrim(m.doknr, '0') as doknr, m.internenr
                       from tco.fipapermap m join tco.fibuchungen b on b.internenr = m.internenr
                      where b.konto = ${v.ch_konto_ware} and b.datum between ${`${jahr}-01-01`} and ${`${jahr + 1}-03-31`}
                      order by ltrim(m.doknr, '0'), m.internenr`;
  return r.filter((x) => /^\d+$/.test(x.doknr)) as unknown as { doknr: string; internenr: string }[];
}

export function treffer(docs: PlDoc[], vergeben: Map<string, string>, rg: { rgnr: string; datum: string; brutto: number }): { doc: PlDoc; art: 'A' | 'B' } | null {
  const frei = (d: PlDoc) => !vergeben.has(d.doknr) || vergeben.get(d.doknr) === rg.rgnr;
  const a = docs.find((d) => d.auftragsnr === rg.rgnr && frei(d));
  if (a) return { doc: a, art: 'A' };
  if (!rg.brutto) return null;
  let best: PlDoc | null = null, bestTage = Infinity;
  for (const d of docs) {
    if (d.auftragsnr && d.auftragsnr !== rg.rgnr) continue;
    if (Math.abs(d.betrag - rg.brutto) > TOL) continue;
    const tage = d.created && rg.datum ? Math.abs(Date.parse(d.created) - Date.parse(rg.datum)) / 86_400_000 : 0;
    if (tage > MAX_TAGE || tage >= bestTage || !frei(d)) continue;
    best = d; bestTage = tage;
  }
  return best ? { doc: best, art: 'B' } : null;
}

export const NAH_TAGE = MAX_TAGE;
export const TOLERANZ = TOL;
