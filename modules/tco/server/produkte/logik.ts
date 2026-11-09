import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import { addTage, condense, heute } from '../format.js';

/**
 * Produkte pflegen (Einstellungen → Produkte): alle Produkte aus tco.produkte mit Preisen je Zeitraum,
 * Gästepreis und Erlöskonto. Bereiche nach Schlüssel:
 *   000–099 Halle (Zeitfenster/neue Zeiträume weiter in den Hallenpreisen), 100–199 Getränke,
 *   200–299 Speisen, 300–399 Sonstiges (Verzehr), ab 400 Sonstige Produkte.
 */
export const BEREICHE = {
  HALLE: { text: 'Halle', von: 0, bis: 99, typ: null as string | null },
  GETRAENK: { text: 'Getränke', von: 100, bis: 189, typ: 'G' },   // 190–199 bleiben Sonderschlüsseln (z. B. Pfand) vorbehalten
  SPEISE: { text: 'Speisen', von: 200, bis: 299, typ: 'S' },
  SONSTIGES: { text: 'Sonstiges (Verzehr)', von: 300, bis: 399, typ: 'X' },
  ANDERE: { text: 'Sonstige Produkte', von: 400, bis: 999, typ: null as string | null },
} as const;
export type Bereich = keyof typeof BEREICHE;

export function bereichVon(key: string): Bereich {
  const n = Number(key);
  if (!/^\d{3}$/.test(key) || n < 100) return 'HALLE';
  if (n <= 199) return 'GETRAENK';
  if (n <= 299) return 'SPEISE';
  if (n <= 399) return 'SONSTIGES';
  return 'ANDERE';
}

export interface ProduktZeile {
  prod_key: string; bereich: Bereich; valid_from: string; valid_to: string; text: string;
  preis: number | null; preis_gast: number | null; typ: string | null; menge: string | null; erloeskonto: string | null;
  aktuell: boolean; zukunft: boolean;
}

export async function produkteLesen(db: Db): Promise<ProduktZeile[]> {
  const h = heute();
  const rows = await db`select prod_key, to_char(valid_from, 'YYYY-MM-DD') as valid_from, to_char(valid_to, 'YYYY-MM-DD') as valid_to,
                               coalesce(text, '') as text, preis::float8 as preis, preis_gast::float8 as preis_gast, typ, menge, erloeskonto
                          from tco.produkte order by prod_key, valid_from`;
  return rows.map((r) => ({
    prod_key: r.prod_key, bereich: bereichVon(r.prod_key), valid_from: r.valid_from, valid_to: r.valid_to, text: r.text,
    preis: r.preis, preis_gast: r.preis_gast, typ: r.typ, menge: r.menge, erloeskonto: r.erloeskonto || null,
    aktuell: r.valid_from <= h && r.valid_to >= h, zukunft: r.valid_from > h,
  }));
}

/** Erlöskonten zur Auswahl: Kontenstamm ohne Bank-/Kassenkonten */
export async function erloeskontenLesen(db: Db) {
  return db`select konto, coalesce(name, '') as name from tco.fikonten where coalesce(kennzahl, '') not in ('BA', 'BK') order by konto`;
}

async function kontoPruefen(tx: Db, konto: string | null) {
  if (!konto) return;
  const [k] = await tx`select 1 from tco.fikonten where konto = ${konto}`;
  if (!k) throw new BusinessError(`Erlöskonto ${konto} ist nicht im Kontenstamm.`);
}

export interface Eigenschaften { text: string; preis: number | null; preis_gast: number | null; typ?: string | null; menge?: string | null; erloeskonto: string | null }

function eingabePruefen(e: Eigenschaften) {
  if (!condense(e.text)) throw new BusinessError('Bitte eine Bezeichnung angeben.');
  if (e.preis != null && !Number.isFinite(e.preis)) throw new BusinessError('Preis ungültig.');
  if (e.preis_gast != null && e.preis_gast < 0) throw new BusinessError('Gästepreis darf nicht negativ sein.');
}

/** Zeitraum eines Produkts ändern (Bezeichnung, Preise, Typ, Menge, Erlöskonto) – ohne Gültigkeit */
export async function zeitraumAendern(tx: Db, key: string, validFrom: string, e: Eigenschaften) {
  eingabePruefen(e);
  await kontoPruefen(tx, e.erloeskonto);
  const [c] = await tx`select typ, menge from tco.produkte where prod_key = ${key} and valid_from = ${validFrom}`;
  if (!c) throw new BusinessError(`Produkt ${key} ab ${validFrom} nicht gefunden.`);
  await tx`update tco.produkte set text = ${condense(e.text)}, preis = ${e.preis}, preis_gast = ${e.preis_gast},
                                   typ = ${e.typ === undefined ? c.typ : e.typ || null}, menge = ${e.menge === undefined ? c.menge : e.menge || null},
                                   erloeskonto = ${e.erloeskonto || null}
            where prod_key = ${key} and valid_from = ${validFrom}`;
  // Erlöskonto gilt für das Produkt als Ganzes: alle Zeiträume mitziehen, damit die Aufteilung nicht vom Datum abhängt
  await tx`update tco.produkte set erloeskonto = ${e.erloeskonto || null} where prod_key = ${key}`;
}

/** Neuer Preis ab Stichtag: laufenden Zeitraum am Vortag beenden, neuen Zeitraum mit den Eigenschaften anlegen */
export async function neuerPreis(tx: Db, key: string, ab: string, e: Eigenschaften) {
  if (bereichVon(key) === 'HALLE') throw new BusinessError('Hallenprodukte haben Zeitfenster – neue Zeiträume bitte in den Hallenpreisen anlegen.');
  eingabePruefen(e);
  await kontoPruefen(tx, e.erloeskonto);
  if (ab < heute()) throw new BusinessError('Ein neuer Preis gilt frühestens ab heute.');
  const [c] = await tx`select to_char(valid_from, 'YYYY-MM-DD') as valid_from, to_char(valid_to, 'YYYY-MM-DD') as valid_to, typ, menge
                         from tco.produkte where prod_key = ${key} and valid_from <= ${ab} and valid_to >= ${ab}`;
  if (!c) throw new BusinessError(`Produkt ${key} ist zum ${ab} nicht gültig.`);
  if (c.valid_from === ab) return zeitraumAendern(tx, key, ab, e);
  await tx`update tco.produkte set valid_to = ${addTage(ab, -1)} where prod_key = ${key} and valid_from = ${c.valid_from}`;
  await tx`insert into tco.produkte (prod_key, valid_from, valid_to, text, preis, preis_gast, typ, menge, erloeskonto)
           values (${key}, ${ab}, ${c.valid_to}, ${condense(e.text)}, ${e.preis}, ${e.preis_gast}, ${e.typ === undefined ? c.typ : e.typ || null},
                   ${e.menge === undefined ? c.menge : e.menge || null}, ${e.erloeskonto || null})`;
}

/** Produkt anlegen: nächster freier Schlüssel im Bereich */
export async function produktAnlegen(tx: Db, bereich: Bereich, ab: string, e: Eigenschaften): Promise<string> {
  if (bereich === 'HALLE') throw new BusinessError('Hallenprodukte bitte in den Hallenpreisen anlegen (Zeitfenster).');
  eingabePruefen(e);
  await kontoPruefen(tx, e.erloeskonto);
  const b = BEREICHE[bereich];
  const text = condense(e.text);
  const [dup] = await tx`select 1 from tco.produkte where length(prod_key) = 3 and prod_key::int between ${b.von} and ${b.bis}
                            and upper(trim(text)) = ${text.toUpperCase()}`;
  if (dup) throw new BusinessError(`„${text}“ gibt es in ${b.text} bereits.`);
  const [n] = await tx`select coalesce(max(prod_key::int), ${b.von - 1}) + 1 as k from tco.produkte
                        where prod_key ~ '^[0-9]{3}$' and prod_key::int between ${b.von} and ${b.bis}`;
  if (Number(n.k) > b.bis) throw new BusinessError(`In ${b.text} sind alle Schlüssel vergeben.`);
  const key = String(n.k).padStart(3, '0');
  await tx`insert into tco.produkte (prod_key, valid_from, valid_to, text, preis, preis_gast, typ, menge, erloeskonto)
           values (${key}, ${ab}, '9999-12-31', ${text}, ${e.preis}, ${e.preis_gast}, ${e.typ || b.typ}, ${e.menge || '1'}, ${e.erloeskonto || null})`;
  return key;
}

/** Produkt zum Stichtag beenden: gilt bis zum Vortag, spätere Zeiträume entfallen */
export async function produktBeenden(tx: Db, key: string, ab: string) {
  if (bereichVon(key) === 'HALLE') throw new BusinessError('Hallenprodukte bitte in den Hallenpreisen beenden (Zeitfenster).');
  const r = await tx`update tco.produkte set valid_to = ${addTage(ab, -1)} where prod_key = ${key} and valid_from < ${ab} and valid_to >= ${ab}`;
  if (!r.count) throw new BusinessError('Zum Stichtag ist kein gültiger Zeitraum vorhanden.');
  await tx`delete from tco.produkte where prod_key = ${key} and valid_from >= ${ab}`;
}

/** Massenpflege: Erlöskonto für alle Produkte eines Bereichs (alle Zeiträume); nurOhne = nur Produkte ohne eigenes Konto */
export async function bereichKontoSetzen(tx: Db, bereich: Bereich, konto: string | null, nurOhne: boolean): Promise<number> {
  await kontoPruefen(tx, konto);
  const b = BEREICHE[bereich];
  const r = await tx`update tco.produkte set erloeskonto = ${konto}
                      where prod_key ~ '^[0-9]{3}$' and prod_key::int between ${b.von} and ${b.bis}
                        ${nurOhne ? tx`and coalesce(erloeskonto, '') = ''` : tx``}
                      returning prod_key`;
  return new Set(r.map((x) => x.prod_key as string)).size;
}
