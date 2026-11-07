import type { Db } from '../verein.js';
import { runden, wochentag, WOCHENTAG_TEXT } from '../format.js';

/**
 * Hallenpreise (Port von ZCL_TCO_RECHNUNGEN=>PREISGRUPPEN / CALC_BOOKING_PRICE).
 * Produkte einer Gruppe werden gemeinsam bewertet; innerhalb einer Gruppe darf sich
 * ein Zeitfenster am selben Tag nicht mit unterschiedlichem Preis überschneiden.
 */
export const PREISGRUPPEN: { gruppe: Gruppe; text: string; keys: string[] }[] = [
  { gruppe: 'ABO', text: 'Abo', keys: ['001', '002', '003', '011'] },
  { gruppe: 'EINZEL_WINTER', text: 'Einzelbuchung Winter', keys: ['005', '006', '007', '012'] },
  { gruppe: 'EINZEL_SOMMER', text: 'Einzelbuchung Sommer', keys: ['010'] },
];
export type Gruppe = 'ABO' | 'EINZEL_WINTER' | 'EINZEL_SOMMER';

export const KEY_ABO = PREISGRUPPEN[0].keys;
export const KEY_EINZEL = [...PREISGRUPPEN[1].keys, ...PREISGRUPPEN[2].keys];
export const KEY_SCHLUESSEL_AUSGABE = '008';
export const KEY_SCHLUESSEL_RUECKNAHME = '009';
export const KEY_SONSTIGES = '093';

export function gruppeVon(key: string): Gruppe | null {
  return PREISGRUPPEN.find((g) => g.keys.includes(key))?.gruppe ?? null;
}

export interface Produkt { prod_key: string; valid_from: string; valid_to: string; text: string | null; preis: number; typ: string | null; menge: string | null }
export interface Fenster { prod_key: string; valid_from: string; valid_to: string; tag: string; zeit_von: string; zeit_bis: string }
export interface Preise { produkte: Produkt[]; matrix: Fenster[] }

export async function preiseLesen(db: Db): Promise<Preise> {
  const produkte = (await db`select prod_key, valid_from::text, valid_to::text, text, preis::float8 as preis, typ, menge
                               from tco.produkte where prod_key < '100' order by prod_key, valid_from`) as unknown as Produkt[];
  const matrix = (await db`select prod_key, valid_from::text, valid_to::text, tag, zeit_von::text, zeit_bis::text
                             from tco.prmatrix order by prod_key, valid_from, tag, zeit_von`) as unknown as Fenster[];
  return { produkte, matrix };
}

/** Sommersaison 01.05.–15.09. (nur für Einzelbuchungen) */
export const istSommer = (datum: string) => datum.slice(5) >= '05-01' && datum.slice(5) <= '09-15';

export const minuten = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export interface PreisErgebnis {
  betrag: number;
  dauer: number;
  prodKey: string | null;
  fehler: string | null;
}

/**
 * Preis einer Buchung: jede Buchungsminute genau einmal bepreisen,
 * Betrag = Σ Stundenpreis × Minuten / 60, erst am Ende auf 2 Stellen gerundet.
 * status: '1' Einzel, '3' Abo (bereits um „Abo als Einzel“ korrigiert), '2'/'4' kein Preis.
 */
export function preisBerechnen(
  b: { datum: string; time_start: string | null; time_ende: string | null; status: string | null },
  p: Preise,
): PreisErgebnis {
  const r: PreisErgebnis = { betrag: 0, dauer: 0, prodKey: null, fehler: null };
  if (!b.time_start || !b.time_ende) return { ...r, fehler: 'Ungültiges Datum bzw. ungültige Uhrzeit der Buchung' };
  const von = minuten(b.time_start);
  const bis = minuten(b.time_ende);
  if (bis <= von) return { ...r, fehler: 'Ungültiges Datum bzw. ungültige Uhrzeit der Buchung' };
  r.dauer = bis - von;

  let gruppe: Gruppe;
  switch (b.status) {
    case '3': gruppe = 'ABO'; break;
    case '1': gruppe = istSommer(b.datum) ? 'EINZEL_SOMMER' : 'EINZEL_WINTER'; break;
    case '2': case '4': return r;
    default: return { ...r, fehler: `Buchungsstatus ${b.status ?? '–'} wird nicht bepreist` };
  }
  const keys = PREISGRUPPEN.find((g) => g.gruppe === gruppe)!.keys;
  const tag = wochentag(b.datum);
  const preisVon = new Map<string, number>();
  for (const pr of p.produkte) {
    if (keys.includes(pr.prod_key) && pr.valid_from <= b.datum && pr.valid_to >= b.datum) preisVon.set(pr.prod_key, pr.preis);
  }
  const fenster = p.matrix
    .filter((f) => keys.includes(f.prod_key) && f.tag === tag && f.valid_from <= b.datum && f.valid_to >= b.datum && preisVon.has(f.prod_key))
    .map((f) => ({ key: f.prod_key, von: minuten(f.zeit_von), bis: minuten(f.zeit_bis), preis: preisVon.get(f.prod_key)! }));
  if (!fenster.length) return { ...r, fehler: `Keine gültigen Hallenpreise für ${WOCHENTAG_TEXT[tag]} hinterlegt` };

  const proKey = new Map<string, { preis: number; min: number }>();
  let lueckeVon = -1;
  let lueckeBis = 0;
  let konfliktVon = -1;
  let konfliktProd = '';
  for (let m = von; m < bis; m++) {
    const hits = fenster.filter((f) => f.von <= m && f.bis > m);
    if (!hits.length) {
      if (lueckeVon < 0) lueckeVon = m;
      lueckeBis = m + 1;
      continue;
    }
    const first = hits[0];
    const anders = hits.find((h) => h.preis !== first.preis);
    if (anders && konfliktVon < 0) {
      konfliktVon = m;
      konfliktProd = `${first.key}/${anders.key}`;
    }
    const e = proKey.get(first.key) ?? { preis: first.preis, min: 0 };
    e.min++;
    proKey.set(first.key, e);
  }
  const msg: string[] = [];
  if (lueckeVon >= 0) msg.push(`Kein Hallenpreis für ${WOCHENTAG_TEXT[tag]} ${hhmm(lueckeVon)} bis ${hhmm(lueckeBis)} Uhr hinterlegt`);
  if (konfliktVon >= 0) msg.push(`Überschneidende Zeitfenster mit unterschiedlichen Preisen (${konfliktProd}) ab ${hhmm(konfliktVon)} Uhr`);

  let sum = 0;
  let maxMin = 0;
  for (const [key, e] of proKey) {
    if (e.min > maxMin) { maxMin = e.min; r.prodKey = key; }
    sum += (e.preis * e.min) / 60;
  }
  if (msg.length) return { ...r, fehler: msg.join('; ') };
  r.betrag = runden(sum);
  return r;
}

// ---------------------------------------------------------------------------
// Preispflege: Prüfung und Speichern (PRICE_CHECK / PRICE_MAINT_SAVE)
// ---------------------------------------------------------------------------

export interface PflegeProdukt { prod_key: string; valid_from: string; text: string; preis: number; typ?: string | null }
export interface PflegeFenster { prod_key: string; valid_from: string; tag: string; zeit_von: string; zeit_bis: string }
export interface Befund { art: 'Fehler' | 'Hinweis'; text: string }

/** Gültig-bis ableiten: Vortag des nächsten Gültig-ab desselben Produkts, sonst 31.12.9999 */
export function gueltigBis(produkte: { prod_key: string; valid_from: string }[]): Map<string, string> {
  const m = new Map<string, string>();
  const byKey = new Map<string, string[]>();
  for (const p of produkte) byKey.set(p.prod_key, [...(byKey.get(p.prod_key) ?? []), p.valid_from]);
  for (const [key, vons] of byKey) {
    const s = [...new Set(vons)].sort();
    s.forEach((v, i) => {
      if (i < s.length - 1) {
        const d = new Date(`${s[i + 1]}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() - 1);
        m.set(`${key}|${v}`, d.toISOString().slice(0, 10));
      } else m.set(`${key}|${v}`, '9999-12-31');
    });
  }
  return m;
}

export function preisePruefen(produkte: PflegeProdukt[], fenster: PflegeFenster[]): Befund[] {
  const b: Befund[] = [];
  const re = /^\d{2}:\d{2}/;
  const bis = gueltigBis(produkte);
  const dupl = new Set<string>();
  for (const p of produkte) {
    if (!p.prod_key || !/^\d{3}$/.test(p.prod_key)) b.push({ art: 'Fehler', text: `Produktschlüssel „${p.prod_key}“: dreistellig, z. B. 005` });
    else if (Number(p.prod_key) >= 100) b.push({ art: 'Fehler', text: `Produkt ${p.prod_key}: Schlüssel ab 100 gehören zum Clubhaus` });
    if (!p.valid_from) b.push({ art: 'Fehler', text: `Produkt ${p.prod_key}: Gültig ab fehlt` });
    if (!p.text?.trim()) b.push({ art: 'Fehler', text: `Produkt ${p.prod_key}: Bezeichnung fehlt` });
    if (!Number.isFinite(p.preis)) b.push({ art: 'Fehler', text: `Produkt ${p.prod_key}: Preis fehlt` });
    const k = `${p.prod_key}|${p.valid_from}`;
    if (dupl.has(k)) b.push({ art: 'Fehler', text: `Produkt ${p.prod_key} ab ${p.valid_from} ist doppelt erfasst` });
    dupl.add(k);
    if (p.prod_key && Number(p.prod_key) < 100 && !gruppeVon(p.prod_key) && p.typ !== '3' && fenster.some((f) => f.prod_key === p.prod_key)) {
      b.push({ art: 'Hinweis', text: `Produkt ${p.prod_key} gehört zu keiner Preisgruppe und geht nicht in die Preisfindung ein` });
    }
  }
  const tage = Object.keys(WOCHENTAG_TEXT);
  const fx = fenster.map((f, i) => ({ ...f, i }));
  for (const f of fx) {
    const nr = `Zeitfenster ${f.prod_key} ${WOCHENTAG_TEXT[f.tag] ?? f.tag} ${f.zeit_von}–${f.zeit_bis}`;
    if (!f.prod_key || !f.valid_from || !tage.includes(f.tag) || !re.test(f.zeit_von) || !re.test(f.zeit_bis)) {
      b.push({ art: 'Fehler', text: `${nr}: unvollständig (Produkt, Gültigkeit, Tag, Von, Bis)` });
      continue;
    }
    if (minuten(f.zeit_von) >= minuten(f.zeit_bis)) b.push({ art: 'Fehler', text: `${nr}: Von muss vor Bis liegen` });
    if (!produkte.some((p) => p.prod_key === f.prod_key && p.valid_from === f.valid_from)) {
      b.push({ art: 'Fehler', text: `${nr}: kein Produktpreis ${f.prod_key} ab ${f.valid_from}` });
    }
  }
  // Überschneidungen innerhalb einer Preisgruppe am selben Tag
  const preis = new Map(produkte.map((p) => [`${p.prod_key}|${p.valid_from}`, p.preis]));
  const gemeldet = new Set<string>();
  for (const a of fx) {
    for (const c of fx) {
      if (c.i <= a.i || a.tag !== c.tag) continue;
      const ga = gruppeVon(a.prod_key);
      if (!ga || ga !== gruppeVon(c.prod_key)) continue;
      const aBis = bis.get(`${a.prod_key}|${a.valid_from}`) ?? '9999-12-31';
      const cBis = bis.get(`${c.prod_key}|${c.valid_from}`) ?? '9999-12-31';
      if (a.valid_from > cBis || c.valid_from > aBis) continue;
      if (!(minuten(a.zeit_von) < minuten(c.zeit_bis) && minuten(c.zeit_von) < minuten(a.zeit_bis))) continue;
      if (a.prod_key === c.prod_key && a.valid_from === c.valid_from) continue; // wird beim Speichern zusammengefasst
      const pa = preis.get(`${a.prod_key}|${a.valid_from}`);
      const pc = preis.get(`${c.prod_key}|${c.valid_from}`);
      const key = `${a.tag}|${a.prod_key}|${c.prod_key}|${pa === pc}`;
      if (gemeldet.has(key)) continue;
      gemeldet.add(key);
      b.push(pa === pc
        ? { art: 'Hinweis', text: `${WOCHENTAG_TEXT[a.tag]}: ${a.prod_key} und ${c.prod_key} überschneiden sich mit gleichem Preis` }
        : { art: 'Fehler', text: `${WOCHENTAG_TEXT[a.tag]}: ${a.prod_key} (${a.zeit_von}–${a.zeit_bis}) und ${c.prod_key} (${c.zeit_von}–${c.zeit_bis}) überschneiden sich mit unterschiedlichem Preis` });
    }
  }
  return b;
}

/** angrenzende oder überlappende Fenster eines Produkts am selben Tag zusammenfassen */
export function fensterZusammenfassen(f: PflegeFenster[]): PflegeFenster[] {
  const gruppen = new Map<string, PflegeFenster[]>();
  for (const x of f) {
    const k = `${x.prod_key}|${x.valid_from}|${x.tag}`;
    gruppen.set(k, [...(gruppen.get(k) ?? []), x]);
  }
  const out: PflegeFenster[] = [];
  for (const liste of gruppen.values()) {
    const s = [...liste].sort((a, b) => minuten(a.zeit_von) - minuten(b.zeit_von));
    let cur = { ...s[0] };
    for (const x of s.slice(1)) {
      if (minuten(x.zeit_von) <= minuten(cur.zeit_bis)) {
        if (minuten(x.zeit_bis) > minuten(cur.zeit_bis)) cur.zeit_bis = x.zeit_bis;
      } else {
        out.push(cur);
        cur = { ...x };
      }
    }
    out.push(cur);
  }
  return out;
}
