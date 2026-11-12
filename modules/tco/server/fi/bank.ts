import { BusinessError } from '../../../../server/src/errors.js';
import { csvParse, dekodieren } from '../../../../server/src/lib/sapcsv.js';
import type { Db } from '../verein.js';
import { addTage, runden } from '../format.js';
import { kontenLesen, kontostand, offeneRechnungen } from './daten.js';
import type { Position } from './buchen.js';
import { laufZuZahlung, offeneLaeufe, type OffenerLauf } from '../soll/logik.js';

/** Bankimport (BANK_FILE_READ, BANK_MATCH_EXISTING, BANK_PROPOSE_ACCOUNTS, BANK_PROPOSE_DOCS) */

export interface BankUmsatz {
  id: number;
  datum: string;
  valuta: string | null;
  name: string;
  zweck: string;
  buchungstext: string;
  betrag: number;
  saldo: number | null;
  status: 'neu' | 'gebucht';
  statusText: string;
  /** Vorbelegung */
  positionen: Position[];
  herkunft: string;            // Herkunft der Vorbelegung
  art: 'regel' | 'historie' | 'keine';
  belegVorschlag: { doks: number[]; text: string } | null;
  buchungsText: string;        // Text der Buchung („Name Verwendungszweck“)
  laufid: string | null;       // Sollstellung (Sammelgutschrift)
}

export interface BankDatei {
  konto: string;
  info: string;
  iban: string | null;
  von: string;
  bis: string;
  endsaldo: number | null;
  saldoFi: number;              // Kontostand lt. FI zum letzten Buchungstag (ohne neue Umsätze)
  umsaetze: BankUmsatz[];
  hinweise: string[];
  laeufe: OffenerLauf[];       // offene Sollstellungen zur manuellen Zuordnung
}

const DATUM = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const datum = (s: string) => {
  const m = DATUM.exec(s.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};
export function betragLesen(s: string): number {
  let t = s.replace(/[€\s+]/g, '').trim();
  if (!t) return 0;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (!/^-?\d+(\.\d{1,2})?$/.test(t)) t = t.replace(/\./g, '');
  const n = Number(t);
  return Number.isFinite(n) ? runden(n) : 0;
}

/** „Name Verwendungszweck“ ohne technische SEPA-Anhänge (BANK_SHORT_TEXT) */
export function kurzText(name: string, zweck: string, max = 60): string {
  const z = zweck.replace(/\b(EREF|MREF|CRED|KREF|ABWA|ABWE|IBAN|BIC|SVWZ|PURP)[:+].*$/i, '').replace(/\s+/g, ' ').trim();
  const t = [name.trim(), z].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) : t;
}

/** Schlüssel für Muster (Historie, Belegvorschlag): Name max. 25 Zeichen bzw. ohne Namen die ersten 14 des Zwecks */
function musterSchluessel(name: string, zweck: string): string {
  const k = (name.trim() ? name.trim().slice(0, 25) : zweck.trim().slice(0, 14)).toUpperCase();
  return k.length >= 3 ? k : '';
}

/** Namensteile (mind. 3 Zeichen, ohne Umlaut-/Großschreibungsunterschiede) */
const namensTeile = (s: string) => s.toUpperCase().replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Ü/g, 'UE').replace(/ß/g, 'SS')
  .split(/[^A-Z0-9]+/).filter((t) => t.length >= 3);

/**
 * Offene Hallenrechnung zu einer Gutschrift ohne Rechnungsnummer im Text (RGNR_BY_AMOUNT):
 * offener Betrag = Gutschrift. Gibt es mehrere, gewinnt die einzige, deren Kunde zum Namen des Zahlers passt;
 * sonst kein Vorschlag.
 */
export function rechnungAmBetrag<R extends { rgnr_txt: string; kunde: string; offen: number }>(offene: R[], betrag: number, name: string): (R & { name: boolean }) | null {
  const kand = offene.filter((r) => runden(r.offen) === runden(betrag));
  if (!kand.length) return null;
  const zahler = new Set(namensTeile(name));
  const mitName = kand.filter((r) => { const t = namensTeile(r.kunde); return t.length > 0 && t.every((x) => zahler.has(x)); });
  if (mitName.length === 1) return { ...mitName[0], name: true };
  if (kand.length === 1) return { ...kand[0], name: false };
  return null;
}

/** CSV-Umsatzexport der Bank lesen (IF-09) */
export function bankDateiLesen(buf: Buffer) {
  const text = dekodieren(buf).replace(/^sep=.\r?\n/i, '');
  const rows = csvParse(text, ';');
  if (!rows.length) throw new BusinessError('Die Datei enthält keine Umsätze.');
  const kopf = rows[0].map((h) => h.trim().toLowerCase());
  const sp = (n: string) => kopf.indexOf(n.toLowerCase());
  const c = {
    tag: sp('Buchungstag'), valuta: sp('Valutadatum'), name: sp('Name Zahlungsbeteiligter'), iban: sp('IBAN Zahlungsbeteiligter'),
    text: sp('Buchungstext'), zweck: sp('Verwendungszweck'), betrag: sp('Betrag'), saldo: sp('Saldo nach Buchung'),
    kto: sp('Bezeichnung Auftragskonto'), ktoIban: sp('IBAN Auftragskonto'), bank: sp('Bankname Auftragskonto'),
  };
  if (c.tag < 0 || c.zweck < 0 || c.betrag < 0) {
    throw new BusinessError(`Keine Bankdatei: Spalten Buchungstag/Verwendungszweck/Betrag nicht gefunden. Erste Zeile: "${rows[0].join(';').slice(0, 120)}"`);
  }
  const f = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').replace(/\s*\n\s*/g, ' ').trim() : '');
  const umsaetze: Omit<BankUmsatz, 'status' | 'statusText' | 'positionen' | 'herkunft' | 'art' | 'belegVorschlag' | 'buchungsText' | 'laufid'>[] = [];
  let id = 0;
  for (const r of rows.slice(1)) {
    const d = datum(f(r, c.tag));
    if (!d) continue;
    umsaetze.push({
      id: ++id, datum: d, valuta: datum(f(r, c.valuta)), name: f(r, c.name), zweck: f(r, c.zweck),
      buchungstext: f(r, c.text).toUpperCase(), betrag: betragLesen(f(r, c.betrag)),
      saldo: c.saldo >= 0 && f(r, c.saldo) ? betragLesen(f(r, c.saldo)) : null,
    });
  }
  if (!umsaetze.length) throw new BusinessError('In der Datei wurden keine Umsätze erkannt.');
  const erste = rows[1] ?? [];
  const iban = f(erste, c.ktoIban).replace(/\s/g, '').toUpperCase() || null;
  const info = [f(erste, c.kto), iban, f(erste, c.bank)].filter(Boolean).join(' · ');
  return { umsaetze, iban, info };
}

/** Endsaldo des letzten Buchungstags über die Kette „Saldo nach Buchung“ */
function endsaldo(u: { datum: string; betrag: number; saldo: number | null }[], bis: string): number | null {
  const tag = u.filter((x) => x.datum === bis && x.saldo !== null);
  if (!tag.length) return u.find((x) => x.saldo !== null)?.saldo ?? null;
  const vorher = new Set(tag.map((x) => runden(x.saldo! - x.betrag)));
  const letzte = tag.filter((x) => !vorher.has(runden(x.saldo!)) || tag.length === 1);
  return (letzte[0] ?? tag[0]).saldo;
}

/**
 * Datei verarbeiten: Abgleich mit vorhandenen Buchungen, Vorbelegung, Belegvorschlag.
 * `offeneBelege`: nicht zugeordnete Paperless-Belege (für den Vorschlag „offener Beleg mit gleichem Betrag“).
 */
export async function bankAbgleich(db: Db, konto: string, buf: Buffer,
  offeneBelege: { id: number; datum: string | null; betrag: number | null }[]): Promise<BankDatei> {
  const d = bankDateiLesen(buf);
  const laeufe = await offeneLaeufe(db);
  const hinweise: string[] = [];

  // IBAN-Prüfung gegen das FI-Konto (E13)
  if (d.iban) {
    const [k] = await db`select iban from tco.fibankiban where konto = ${konto}`;
    if (k && k.iban !== d.iban) {
      throw new BusinessError(`Die Datei gehört zur IBAN ${d.iban}, Konto ${konto} ist mit IBAN ${k.iban} verknüpft. Bitte das richtige Konto wählen.`);
    }
    const [andere] = await db`select konto from tco.fibankiban where iban = ${d.iban} and konto <> ${konto}`;
    if (andere) throw new BusinessError(`Die Datei gehört zu Konto ${andere.konto} (IBAN ${d.iban}), nicht zu Konto ${konto}.`);
    if (!k) hinweise.push(`IBAN ${d.iban} wird beim Buchen mit Konto ${konto} verknüpft.`);
  }

  const datumListe = d.umsaetze.map((x) => x.datum).sort();
  const von = datumListe[0];
  const bis = datumListe[datumListe.length - 1];
  const u: BankUmsatz[] = d.umsaetze.map((x) => ({
    ...x, status: 'neu', statusText: 'neu', positionen: [], herkunft: '', art: 'keine', belegVorschlag: null,
    buchungsText: kurzText(x.name, x.zweck), laufid: null,
  }));

  // ---- Abgleich (drei Läufe, jede vorhandene Buchung höchstens einmal)
  const vorhanden = (await db`
    select internenr, min(datum)::text as datum, sum(coalesce(soll, 0) - coalesce(haben, 0))::float8 as betrag,
           split_part(min(coalesce(belnr, '')), ',', 1) as belnr
      from tco.fibuchungen
     where konto = ${konto} and datum between ${addTage(von, -12)} and ${addTage(bis, 12)}
     group by internenr`).map((r) => ({ ...r, betrag: runden(r.betrag), frei: true })) as { internenr: string; datum: string; betrag: number; belnr: string; frei: boolean }[];
  const tage = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);
  for (const x of u) {
    const t = vorhanden.find((v) => v.frei && v.betrag === x.betrag && (v.datum === x.datum || v.datum === x.valuta));
    if (t) { t.frei = false; x.status = 'gebucht'; x.statusText = `bereits gebucht (intern ${t.internenr})`; }
  }
  for (const x of u.filter((y) => y.status === 'neu')) {
    const t = vorhanden.filter((v) => v.frei && v.betrag === x.betrag && tage(v.datum, x.datum) <= 7)
      .sort((a, b) => tage(a.datum, x.datum) - tage(b.datum, x.datum))[0];
    if (t) { t.frei = false; x.status = 'gebucht'; x.statusText = `bereits gebucht (intern ${t.internenr})`; }
  }
  for (const x of u.filter((y) => y.status === 'neu')) {
    const gruppen = new Map<string, typeof vorhanden>();
    for (const v of vorhanden.filter((y) => y.frei && y.belnr && tage(y.datum, x.datum) <= 12)) {
      const k = `${v.datum}|${v.belnr}`;
      gruppen.set(k, [...(gruppen.get(k) ?? []), v]);
    }
    for (const g of gruppen.values()) {
      if (g.length < 2 || runden(g.reduce((s, v) => s + v.betrag, 0)) !== x.betrag) continue;
      g.forEach((v) => { v.frei = false; });
      x.status = 'gebucht';
      x.statusText = `bereits gebucht (Sammelposition ${g.length} Belege, ${g[0].belnr})`;
      break;
    }
  }

  // ---- Vorbelegung Gegenkonto
  const jahr = Number(bis.slice(0, 4));
  const gk = new Set((await kontenLesen(db, jahr)).filter((k) => k.aktiv && k.konto !== konto).map((k) => k.konto));
  const rgnrDa = new Map((await db`select rgnr_txt, status, betrag::float8 as betrag from tco.rgkopf`).map((r) => [r.rgnr_txt as string, r]));
  const offeneRg = (await offeneRechnungen(db) as unknown as { rgnr_txt: string; kunde: string; offen: number }[]).filter((r) => r.offen > 0);
  const rgVergeben = new Set<string>();
  const historie = await db`
    select internenr, upper(coalesce(text, '')) as text, gkonto, datum::text as datum,
           (coalesce(soll, 0) - coalesce(haben, 0))::float8 as betrag
      from tco.fibuchungen
     where konto = ${konto} and posnr = 0 and datum >= ${addTage(bis, -730)} and storno_zu is null
     order by datum desc`;

  const setze = (x: BankUmsatz, gkonto: string, herkunft: string, art: 'regel' | 'historie', extra: Partial<Position> = {}) => {
    if (!gk.has(gkonto)) {
      x.herkunft = `${herkunft} – Konto ${gkonto} ist ${jahr} nicht in Verwendung`;
      return false;
    }
    x.positionen = [{ gkonto, betrag: x.betrag, text: null, rgnr: null, ...extra }];
    x.herkunft = herkunft;
    x.art = art;
    return true;
  };

  const laufVergeben = new Set<string>();
  for (const x of u.filter((y) => y.status === 'neu')) {
    const nz = `${x.name} ${x.zweck}`;
    // Sammelgutschrift einer Sollstellung (Summe passt, Fälligkeit ±14 Tage)
    if (x.betrag > 0) {
      const l = laufZuZahlung(laeufe.filter((y) => !laufVergeben.has(y.laufid)), x.betrag, x.datum);
      if (l && setze(x, l.konto, `Regel: ${l.text} – wird je Position aufgeteilt`, 'regel')) {
        x.laufid = l.laufid;
        laufVergeben.add(l.laufid);
        x.buchungsText = `SEPA-Sammeleinzug ${l.sollper.slice(4, 6)}/${l.sollper.slice(0, 4)} Lauf ${Number(l.laufid)}`;
        continue;
      }
    }
    const zweckU = x.zweck.toUpperCase();
    if (konto === '654' && /teilzahlung darlehen/i.test(nz)) { setze(x, '1360', 'Regel: Teilzahlung Darlehen', 'regel'); continue; }
    if (konto === '654' && /abschluss per/i.test(nz)) { setze(x, '2100', 'Regel: Darlehenszinsen', 'regel'); continue; }
    if (x.betrag > 0) {
      const m = [...nz.matchAll(/(?<!\d)(20\d{2})\D{0,4}(\d{3})(?!\d)/g)].map((y) => `${y[1]}_${y[2]}`).find((n) => rgnrDa.has(n));
      if (m) {
        const rg = rgnrDa.get(m)!;
        const offen = rg.status !== '4' && rg.status !== '6';
        setze(x, '8003', `Regel: Hallenrechnung ${m} im Text${offen ? '' : ' (bereits abgeschlossen)'}`, 'regel', { rgnr: offen ? m : null });
        if (offen) rgVergeben.add(m);
        continue;
      }
      if (/sumup/i.test(nz)) {
        if (setze(x, '8005', 'Regel: SumUp-Auszahlung – Gebühren bitte eintragen', 'regel')) {
          x.positionen.push({ gkonto: '4970', betrag: 0, text: 'SumUp Gebühren', rgnr: null });
        }
        continue;
      }
    }
    if (zweckU.startsWith('ABSCHLUSS PER') || x.buchungstext.includes('ABSCHLUSS')) { setze(x, '4970', 'Regel: Kontoabschluss', 'regel'); continue; }
    if (x.buchungstext.includes('EINR.-LASTSCHRIFT')) {
      const mon = Number(x.datum.slice(5, 7));
      setze(x, mon === 1 || mon === 7 ? '8002' : '8006', 'Regel: Sammeleinzug (Lastschrift) – Sollstellung bereits verbucht?', 'regel');
      continue;
    }
    if (x.buchungstext.includes('RETOURE') && zweckU.includes('JUGENDTR')) { setze(x, '8006', 'Regel: Rücklastschrift Jugendtraining', 'regel'); continue; }

    // Hallenrechnung am Betrag: offener Betrag gleich der Gutschrift – bei mehreren entscheidet der Name des Zahlers
    if (x.betrag > 0) {
      const rg = rechnungAmBetrag(offeneRg.filter((r) => !rgVergeben.has(r.rgnr_txt)), x.betrag, x.name);
      if (rg && setze(x, '8003', `Vorschlag: offene Hallenrechnung ${rg.rgnr_txt} (${rg.kunde}) mit gleichem Betrag${rg.name ? ' und Namen' : ' – bitte prüfen'}`, 'regel', { rgnr: rg.rgnr_txt })) {
        rgVergeben.add(rg.rgnr_txt);
        continue;
      }
    }

    const key = musterSchluessel(x.name, x.zweck);
    if (!key) continue;
    const treffer = historie.filter((h) => h.text.startsWith(key) && Math.sign(h.betrag) === Math.sign(x.betrag) && h.gkonto);
    if (!treffer.length) continue;
    const anz = new Map<string, { n: number; zuletzt: string }>();
    for (const h of treffer) {
      const a = anz.get(h.gkonto) ?? { n: 0, zuletzt: '' };
      a.n++;
      if (h.datum > a.zuletzt) a.zuletzt = h.datum;
      anz.set(h.gkonto, a);
    }
    const [best] = [...anz].sort((a, b) => b[1].n - a[1].n || b[1].zuletzt.localeCompare(a[1].zuletzt));
    setze(x, best[0], `Historie: ${best[1].n}× auf ${best[0]} gebucht`, 'historie');
  }

  // ---- Belegvorschlag
  const vergeben = new Set<number>();
  for (const x of u.filter((y) => y.status === 'neu' && !y.laufid)) {
    const key = musterSchluessel(x.name, x.zweck);
    if (!key) continue;
    const gkonto = x.positionen[0]?.gkonto ?? null;
    const muster = historie.filter((h) => h.text.startsWith(key) && Math.sign(h.betrag) === Math.sign(x.betrag) && (!gkonto || h.gkonto === gkonto));
    if (!muster.length) continue;
    const dauer = await db`
      select ltrim(doknr, '0')::int as dok, count(distinct internenr)::int as n from tco.fipapermap
       where internenr = any(${muster.map((m) => m.internenr)}) and ltrim(doknr, '0') ~ '^[0-9]+$'
       group by 1 having count(distinct internenr) >= 2 order by n desc`;
    if (dauer.length) {
      x.belegVorschlag = { doks: dauer.map((r) => r.dok), text: `Beleg-Vorschlag: Dauerbeleg (bis ${dauer[0].n}× bei Vorbuchungen verknüpft)` };
      continue;
    }
    const passend = offeneBelege.filter((b) => b.betrag !== null && runden(Math.abs(b.betrag)) === runden(Math.abs(x.betrag))
      && b.datum && b.datum >= addTage(x.datum, -60) && b.datum <= addTage(x.datum, 10) && !vergeben.has(b.id));
    if (passend.length === 1) {
      vergeben.add(passend[0].id);
      x.belegVorschlag = { doks: [passend[0].id], text: `Beleg-Vorschlag: offener Beleg ${passend[0].id} mit gleichem Betrag` };
    }
  }

  return {
    konto, info: d.info, iban: d.iban, von, bis, endsaldo: endsaldo(u, bis),
    saldoFi: await kontostand(db, konto, bis), umsaetze: u, hinweise, laeufe,
  };
}
