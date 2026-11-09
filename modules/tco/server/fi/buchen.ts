import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import { dat, runden } from '../format.js';
import { laufPositionen, laufVerbucht, laufZuruecksetzen } from '../soll/logik.js';
import { rechnungAufteilung, zahlungAufteilen } from '../halle/daten.js';

/** Schreibende FI-Logik: Buchen, Storno, Rechnung und Belege zuordnen, Notizen */

export interface Position {
  gkonto: string;
  betrag: number;          // vorzeichenbehaftet wie der Umsatz: + = Eingang auf dem Geldkonto
  text?: string | null;
  rgnr?: string | null;    // Hallenrechnung (Erfassung mit Gegenkonto 8003; beim Buchen Aufteilung auf die Erlöskonten der Rechnung)
  /** intern: Teil einer nach Erlöskonten aufgeteilten Rechnungszahlung (gleiche Nummer = eine Zahlung) */
  rgTeil?: number;
}

export interface Umsatz {
  konto: string;           // Bank- oder Kassenkonto
  datum: string;
  text: string;
  betrag: number;          // + Eingang (Soll), − Ausgang (Haben)
  positionen: Position[];
  belege?: number[];
  notiz?: string | null;
  /** Sammelgutschrift einer Sollstellung: Positionen kommen aus dem Lauf */
  laufid?: string | null;
}

export interface Gebucht { internenr: string; belnr: string; rechnungen: string[]; belege: number[]; laufid: string | null }

const TEXT_MAX = 60;
const kurz = (s: string, n = TEXT_MAX) => (s.length > n ? s.slice(0, n) : s);

/** Sperre für die Nummernvergabe (interne Nummer und Belegnummern) bis Transaktionsende */
async function sperren(tx: Db) {
  await tx`select pg_advisory_xact_lock(hashtext('tco.fibuchungen'))`;
}

async function naechsteInterne(tx: Db): Promise<string> {
  const [r] = await tx`select coalesce(max(internenr::bigint), 0) + 1 as n from tco.fibuchungen where internenr ~ '^[0-9]+$'`;
  return String(r.n).padStart(10, '0');
}

/**
 * Nächste ext. Belegnummer des Kontos im Jahr (BANK_BELNR_LAST + 1): höchste numerische Belegnummer
 * (Teil vor dem Komma), die genau einer internen Nummer gehört – Sammeleinzüge zählen nicht.
 */
export async function naechsteBelnr(tx: Db, konto: string, jahr: number): Promise<string> {
  const [r] = await tx`
    select coalesce(max(n), 0) + 1 as n from (
      select split_part(belnr, ',', 1)::bigint as n
        from tco.fibuchungen
       where konto = ${konto} and jahr = ${jahr} and split_part(coalesce(belnr, ''), ',', 1) ~ '^[0-9]{1,12}$'
       group by split_part(belnr, ',', 1) having count(distinct internenr) = 1) x`;
  return String(r.n);
}

function pruefen(u: Umsatz, nr: number): string[] {
  const f: string[] = [];
  const wo = `${nr}. ${dat(u.datum)} ${u.text.slice(0, 30)}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(u.datum)) f.push(`${wo}: Datum fehlt`);
  if (!u.text.trim()) f.push(`${wo}: Buchungstext fehlt`);
  if (!u.betrag) f.push(`${wo}: Betrag ist 0`);
  if (!u.positionen.length) f.push(`${wo}: Gegenkonto fehlt`);
  u.positionen.forEach((p, i) => {
    const pw = u.positionen.length > 1 ? `${wo}, Position ${i + 1}` : wo;
    if (!p.gkonto) f.push(`${pw}: Gegenkonto fehlt`);
    else if (p.gkonto === u.konto) f.push(`${pw}: Gegenkonto = Buchungskonto`);
    if (!p.betrag) f.push(`${pw}: Betrag ist 0`);
    if (p.rgnr && p.gkonto !== '8003') f.push(`${pw}: Hallenrechnung nur bei Gegenkonto 8003`);
  });
  const summe = runden(u.positionen.reduce((s, p) => s + p.betrag, 0));
  if (u.positionen.length && summe !== runden(u.betrag)) {
    f.push(`${wo}: Summe der Positionen (${summe.toFixed(2)}) ≠ Betrag (${runden(u.betrag).toFixed(2)})`);
  }
  return f;
}

/**
 * Umsätze buchen (BANK_POST): je Umsatz eine interne Nummer; Geldkonto-Zeile POSNR 0,
 * Gegenseite je Position (Soll/Haben vertauscht, POSNR je Konto ab 0). Alles oder nichts.
 */
export async function umsaetzeBuchen(tx: Db, umsaetze: Umsatz[], benutzer: string): Promise<Gebucht[]> {
  // Sollstellung: je Position eine Erlöszeile (Splitbuchung), Summe muss zur Gutschrift passen
  const laufPos = new Map<Umsatz, { adrnr: string; vertragnr: string }[]>();
  for (const u of umsaetze) {
    if (!u.laufid) continue;
    const lp = await laufPositionen(tx, u.laufid);
    const summe = runden(lp.reduce((s, p) => s + p.betrag, 0));
    if (summe !== runden(u.betrag)) {
      throw new BusinessError(`${dat(u.datum)} ${u.text.slice(0, 30)}: Summe Sollstellung Lauf ${Number(u.laufid)} (${summe.toFixed(2)}) ≠ Gutschrift (${runden(u.betrag).toFixed(2)})`);
    }
    u.positionen = lp.map((p) => ({ gkonto: p.gkonto, betrag: p.betrag, text: p.text, rgnr: null }));
    laufPos.set(u, lp);
  }
  const fehler = umsaetze.flatMap((u, i) => pruefen(u, i + 1));
  if (fehler.length) throw new BusinessError(`Bitte folgende Umsätze prüfen:\n${fehler.join('\n')}`);
  // Hallenrechnung: Zahlung nach den Erlöskonten der Rechnungspositionen aufteilen (Splitbuchung)
  let teilNr = 0;
  for (const u of umsaetze) {
    const neu: Position[] = [];
    for (const p of u.positionen) {
      if (!p.rgnr) { neu.push(p); continue; }
      const teile = await rechnungAufteilung(tx, p.rgnr);
      const nr = ++teilNr;
      if (teile.length <= 1) { neu.push({ ...p, gkonto: teile[0]?.konto ?? p.gkonto, rgTeil: nr }); continue; }
      for (const t of zahlungAufteilen(p.betrag, teile)) neu.push({ ...p, gkonto: t.konto, betrag: t.betrag, rgTeil: nr });
    }
    u.positionen = neu;
  }
  await sperren(tx);

  const [k] = await tx`select count(*)::int as n from tco.fikonten where konto = any(${[...new Set(umsaetze.flatMap((u) => [u.konto, ...u.positionen.map((p) => p.gkonto)]))]})`;
  const konten = new Set(umsaetze.flatMap((u) => [u.konto, ...u.positionen.map((p) => p.gkonto)]));
  if (k.n !== konten.size) {
    const da = new Set((await tx`select konto from tco.fikonten where konto = any(${[...konten]})`).map((r) => r.konto as string));
    throw new BusinessError(`Konto nicht im Kontenstamm: ${[...konten].filter((x) => !da.has(x)).join(', ')}`);
  }
  // Kontenverwendung je Geschäftsjahr (Kontenstamm): nicht verwendete Konten sind gesperrt
  const jahre = [...new Set(umsaetze.map((u) => Number(u.datum.slice(0, 4))))];
  const gesperrt = await tx`select konto, jahr from tco.fikontojahr where not aktiv and konto = any(${[...konten]}) and jahr = any(${jahre})`;
  const verstoss = new Set<string>();
  for (const u of umsaetze) {
    const jahr = Number(u.datum.slice(0, 4));
    for (const k of [u.konto, ...u.positionen.map((p) => p.gkonto)]) {
      if (gesperrt.some((g) => g.konto === k && Number(g.jahr) === jahr)) verstoss.add(`${k} (${jahr})`);
    }
  }
  if (verstoss.size) {
    throw new BusinessError(`Konto im Kontenstamm für das Geschäftsjahr nicht in Verwendung: ${[...verstoss].join(', ')} – bitte ein anderes Konto wählen oder die Verwendung unter Einstellungen → Kontenstamm freigeben.`);
  }

  const out: Gebucht[] = [];
  const sortiert = [...umsaetze].sort((a, b) => a.datum.localeCompare(b.datum));
  for (const u of sortiert) {
    const internenr = await naechsteInterne(tx);
    const jahr = Number(u.datum.slice(0, 4));
    const monat = Number(u.datum.slice(5, 7));
    const belnr = await naechsteBelnr(tx, u.konto, jahr);
    const haupt = [...u.positionen].sort((a, b) => Math.abs(b.betrag) - Math.abs(a.betrag))[0];
    const zeilen: Record<string, unknown>[] = [{
      internenr, konto: u.konto, posnr: 0, jahr, monat, datum: u.datum, text: kurz(u.text.trim()),
      betrag: Math.abs(runden(u.betrag)), soll: u.betrag > 0 ? Math.abs(runden(u.betrag)) : 0, haben: u.betrag < 0 ? Math.abs(runden(u.betrag)) : 0,
      belnr, gkonto: haupt.gkonto, erfasst_von: benutzer,
    }];
    const posnr = new Map<string, number>();
    for (const p of u.positionen) {
      const n = posnr.get(p.gkonto) ?? 0;
      posnr.set(p.gkonto, n + 1);
      const b = Math.abs(runden(p.betrag));
      zeilen.push({
        internenr, konto: p.gkonto, posnr: n, jahr, monat, datum: u.datum, text: kurz((p.text || u.text).trim()),
        betrag: b, soll: p.betrag < 0 ? b : 0, haben: p.betrag > 0 ? b : 0, belnr, gkonto: u.konto, erfasst_von: benutzer,
      });
    }
    await tx`insert into tco.fibuchungen ${tx(zeilen as never, 'internenr', 'konto', 'posnr', 'jahr', 'monat', 'datum', 'text', 'betrag', 'soll', 'haben', 'belnr', 'gkonto', 'erfasst_von')}`;

    const rechnungen: string[] = [];
    const pn = new Map<string, number>();
    const gruppen = new Map<number, { rgnr: string; betrag: number; zeilen: { konto: string; posnr: number }[] }>();
    for (const p of u.positionen) {
      const n = pn.get(p.gkonto) ?? 0;
      pn.set(p.gkonto, n + 1);
      if (p.rgnr) {
        const g = gruppen.get(p.rgTeil ?? -n) ?? { rgnr: p.rgnr, betrag: 0, zeilen: [] };
        g.betrag = runden(g.betrag + p.betrag);
        g.zeilen.push({ konto: p.gkonto, posnr: n });
        gruppen.set(p.rgTeil ?? -n, g);
      }
    }
    for (const g of gruppen.values()) {
      const [z0] = g.zeilen;
      const allein = g.zeilen.length === u.positionen.length;
      await rechnungVerknuepfen(tx, {
        internenr, konto: z0.konto, posnr: z0.posnr, rgnr: g.rgnr,
        ...(g.zeilen.length > 1 ? { betrag: Math.abs(g.betrag), zeilen: allein ? null : g.zeilen } : {}),
      });
      rechnungen.push(g.rgnr);
    }
    const belege = u.belege?.length ? await belegeZuordnen(tx, internenr, u.belege) : [];
    if (u.notiz?.trim()) await notizAnlegen(tx, internenr, u.notiz, benutzer);
    if (u.laufid) await laufVerbucht(tx, u.laufid, internenr, u.datum);
    out.push({ internenr, belnr, rechnungen, belege, laufid: u.laufid ?? null });
  }
  return out;
}

/**
 * Hallenrechnung einer Position zuordnen (RGNR_LINK). Zahlung kleiner Rechnungsbetrag = Teilzahlung (rgtz).
 * Status 4 bei gezahlt ≥ Betrag, sonst 5; Zahldatum = Buchungsdatum; Rechnungs-PDF wird Beleg der Buchung.
 */
export async function rechnungVerknuepfen(tx: Db, z: {
  internenr: string; konto: string; posnr: number; rgnr: string;
  /** Splitbuchung nach Erlöskonten: Zahlbetrag aller Teilzeilen und die Zeilen (null = ganze Buchung) */
  betrag?: number; zeilen?: { konto: string; posnr: number }[] | null;
}) {
  const [rg] = await tx`select rgnr_txt, betrag::float8 as betrag, status, doknr, kunde from tco.rgkopf where rgnr_txt = ${z.rgnr} for update`;
  if (!rg) throw new BusinessError(`Rechnung ${z.rgnr} nicht gefunden`);
  if (rg.status === '4' || rg.status === '6') throw new BusinessError(`Rechnung ${z.rgnr} ist bereits abgeschlossen (${rg.status === '4' ? 'bezahlt' : 'ausgefallen'})`);
  const [b] = await tx`select datum::text as datum, betrag::float8 as betrag, rgnr_txt from tco.fibuchungen
                        where internenr = ${z.internenr} and konto = ${z.konto} and posnr = ${z.posnr}`;
  if (!b) throw new BusinessError(`Buchung ${z.internenr} nicht gefunden`);
  if (b.rgnr_txt) throw new BusinessError(`Buchung ${z.internenr} ist bereits Rechnung ${b.rgnr_txt} zugeordnet`);
  if (z.betrag != null) b.betrag = runden(z.betrag);
  const [{ n: anz }] = await tx`select count(*)::int as n from tco.fibuchungen where internenr = ${z.internenr} and konto = ${z.konto}`;
  const split = z.betrag == null && anz > 1;

  let gezahlt: number;
  let teil = false;
  if (b.betrag < rg.betrag) {
    teil = true;
    await tx`insert into tco.rgtz (rgnr_txt, fibeleg, betrag) values (${z.rgnr}, ${z.internenr}, ${b.betrag})
             on conflict (rgnr_txt, fibeleg) do update set betrag = tco.rgtz.betrag + excluded.betrag`;
    const [s] = await tx`select coalesce(sum(betrag), 0)::float8 as s from tco.rgtz where rgnr_txt = ${z.rgnr}`;
    gezahlt = s.s;
  } else {
    gezahlt = b.betrag;
  }
  const status = gezahlt >= rg.betrag - 0.004 ? '4' : '5';
  await tx`update tco.rgkopf set status = ${status}, bezahlt = ${b.datum} where rgnr_txt = ${z.rgnr}`;
  if (z.zeilen?.length) {
    for (const x of z.zeilen) {
      await tx`update tco.fibuchungen set rgnr_txt = ${z.rgnr} where internenr = ${z.internenr} and konto = ${x.konto} and posnr = ${x.posnr}`;
    }
  } else if (split) {
    await tx`update tco.fibuchungen set rgnr_txt = ${z.rgnr} where internenr = ${z.internenr} and konto = ${z.konto} and posnr = ${z.posnr}`;
  } else {
    await tx`update tco.fibuchungen set rgnr_txt = ${z.rgnr} where internenr = ${z.internenr}`;
  }
  let beleg: number | null = null;
  if (rg.doknr && /^\d+$/.test(String(rg.doknr).trim())) {
    beleg = Number(rg.doknr);
    await belegeZuordnen(tx, z.internenr, [beleg]);
  }
  const rest = runden(rg.betrag - gezahlt);
  return {
    rgnr: z.rgnr, status, teil, gezahlt: runden(gezahlt), rest, beleg,
    text: `Rechnung ${z.rgnr} (${rg.kunde}) ${status === '4' ? 'als bezahlt markiert' : 'teilbezahlt'}`
      + (teil ? `, Teilzahlung ${b.betrag.toFixed(2).replace('.', ',')} €` : '')
      + (rest > 0 ? `, offen ${rest.toFixed(2).replace('.', ',')} €` : rest < 0 ? `, Überzahlung ${(-rest).toFixed(2).replace('.', ',')} €` : '')
      + (beleg ? `, Rechnungs-PDF ${beleg} als Beleg verknüpft` : ''),
  };
}

/** Rechnungszuordnung einer Buchung zurücknehmen (Teilzahlung entfernen, Status neu bestimmen) */
async function rechnungLoesen(tx: Db, internenr: string, rgnr: string) {
  await tx`delete from tco.rgtz where rgnr_txt = ${rgnr} and fibeleg = ${internenr}`;
  const [rg] = await tx`select betrag::float8 as betrag, gedruckt, versendet from tco.rgkopf where rgnr_txt = ${rgnr} for update`;
  if (!rg) return;
  const [s] = await tx`select coalesce(sum(betrag), 0)::float8 as s from tco.rgtz where rgnr_txt = ${rgnr}`;
  const status = s.s > 0 ? (s.s >= rg.betrag - 0.004 ? '4' : '5') : rg.versendet ? '3' : rg.gedruckt ? '2' : '1';
  await tx`update tco.rgkopf set status = ${status}, bezahlt = ${status === '4' || status === '5' ? tx`bezahlt` : null} where rgnr_txt = ${rgnr}`;
}

/**
 * Storno (STORNO_POST): Gegenbuchung aller Positionen mit vertauschtem Soll/Haben, gleichem Datum und Betrag.
 * Hallenrechnung der Ursprungsbuchung wird wieder offen (Teilzahlung entfernt), Stornogrund an beiden Buchungen.
 */
export async function stornieren(tx: Db, internenr: string, grund: string, benutzer: string) {
  if (!grund.trim()) throw new BusinessError('Bitte einen Stornogrund angeben');
  await sperren(tx);
  const rows = await tx`select * from tco.fibuchungen where internenr = ${internenr} order by konto, posnr`;
  if (!rows.length) throw new BusinessError(`Buchung ${internenr} nicht gefunden`);
  if (rows.some((r) => r.storno_zu)) throw new BusinessError(`Buchung ${internenr} ist selbst ein Storno und kann nicht storniert werden`);
  const [schon] = await tx`select internenr from tco.fibuchungen where storno_zu = ${internenr} limit 1`;
  if (schon) throw new BusinessError(`Buchung ${internenr} wurde bereits storniert (Storno-Beleg ${schon.internenr})`);

  const neu = await naechsteInterne(tx);
  // Belegnummer aus der Folge des Geldkontos der Buchung (nicht der angeklickten Zeile)
  const geld = await tx`select konto from tco.fikonten where konto = any(${rows.map((r) => r.konto)}) and kennzahl in ('BA', 'BK')`;
  const haupt = rows.find((r) => r.posnr === 0 && geld.some((g) => g.konto === r.konto)) ?? rows[0];
  const belnr = await naechsteBelnr(tx, haupt.konto, haupt.jahr);
  const zeilen = rows.map((r) => ({
    internenr: neu, konto: r.konto, posnr: r.posnr, jahr: r.jahr, monat: r.monat, datum: r.datum,
    text: kurz(`Storno ${internenr}: ${r.text ?? ''}`), betrag: r.betrag, soll: r.haben, haben: r.soll,
    belnr, gkonto: r.gkonto, storno_zu: internenr, erfasst_von: benutzer,
  }));
  await tx`insert into tco.fibuchungen ${tx(zeilen as never, 'internenr', 'konto', 'posnr', 'jahr', 'monat', 'datum', 'text', 'betrag', 'soll', 'haben', 'belnr', 'gkonto', 'storno_zu', 'erfasst_von')}`;

  const rechnungen = [...new Set(rows.map((r) => r.rgnr_txt).filter(Boolean))] as string[];
  for (const rg of rechnungen) await rechnungLoesen(tx, internenr, rg);
  const lauf = await laufZuruecksetzen(tx, internenr);
  await notizAnlegen(tx, neu, `Stornogrund (Storno zu ${internenr}): ${grund.trim()}`, benutzer);
  await notizAnlegen(tx, internenr, `Storniert durch ${neu}: ${grund.trim()}`, benutzer);
  return {
    internenr: neu, belnr, rechnungen, lauf,
    text: `Buchung ${internenr} storniert – Storno-Beleg ${neu} (ext. ${belnr})`
      + (rechnungen.length ? `; Rechnung ${rechnungen.join(', ')} wieder offen` : '')
      + (lauf ? `; Sollstellung Lauf ${Number(lauf)} wieder offen` : ''),
  };
}

/** Belege zuordnen (fipapermap, Konto leer wie in SAP); liefert die neu verknüpften Dokument-IDs */
export async function belegeZuordnen(tx: Db, internenr: string, doks: number[]): Promise<number[]> {
  const neu: number[] = [];
  for (const d of [...new Set(doks)]) {
    const r = await tx`insert into tco.fipapermap (internenr, konto, doknr) values (${internenr}, '', ${String(d)})
                        on conflict do nothing`;
    if (r.count) neu.push(d);
  }
  return neu;
}

export async function belegEntfernen(tx: Db, internenr: string, dok: number): Promise<number> {
  const r = await tx`delete from tco.fipapermap where internenr = ${internenr} and ltrim(doknr, '0') = ${String(dok)}`;
  if (!r.count) throw new BusinessError(`Beleg ${dok} ist Buchung ${internenr} nicht zugeordnet`);
  const [rest] = await tx`select count(*)::int as n from tco.fipapermap where ltrim(doknr, '0') = ${String(dok)}`;
  return rest.n;
}

export async function notizAnlegen(tx: Db, internenr: string, text: string, benutzer: string) {
  const t = text.trim().slice(0, 255);
  if (!t) throw new BusinessError('Leere Notiz');
  await tx`insert into tco.finotiz (internenr, erstellt_von, notiz) values (${internenr}, ${benutzer}, ${t})`;
}
