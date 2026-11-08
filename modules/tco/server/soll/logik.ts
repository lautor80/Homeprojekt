import { BusinessError } from '../../../../server/src/errors.js';
import {
  bicGueltig, faelligkeitVorschlag, glaeubigerIdGueltig, ibanGueltig, normalisieren, pain008, referenzGueltig, sepaText,
  type Lastschrift, type Meldung,
} from '../../../../server/src/lib/sepa.js';
import type { Db, Verein } from '../verein.js';
import { dat, heute, runden } from '../format.js';

/**
 * Sollstellung – Port von ZCL_TCO_SOLLSTELLUNG.
 * Vorschlag je Sollmonat, Lastschriftlauf mit pain.008, Storno. Die Verbuchung erfolgt ausschließlich
 * in FI Belege: der Bankimport erkennt die Sammelgutschrift (Summe, Fälligkeit ±14 Tage) und bucht sie
 * als Splitbuchung je Position; ein Storno dort setzt den Lauf zurück.
 */

export const STATUS: Record<string, { text: string; state: 'None' | 'Information' | 'Critical' | 'Positive' | 'Negative' }> = {
  E: { text: 'Datei erzeugt', state: 'Information' },
  Z: { text: 'Zahlung eingegangen', state: 'Critical' },
  V: { text: 'Verbucht', state: 'Positive' },
  S: { text: 'Storniert', state: 'Negative' },
};
const ART = { mitglied: 'MB', jugend: 'JT', spende: 'SP', verzehr: 'VZ' } as const;

/** Adressnummer vergleichbar machen: numerisch auf 10 Stellen, „0000000000“/leer = keine */
export function adrKey(a: unknown): string {
  const t = String(a ?? '').trim();
  if (!t) return '';
  if (/^\d+$/.test(t)) return Number(t) === 0 ? '' : t.padStart(10, '0');
  return t;
}
export const BEITRAGSART_TEXT: Record<string, string> = { MB: 'Mitgliedsbeitrag', JT: 'Jugendtraining', SP: 'Spende', VZ: 'Verzehr Clubhaus' };

// ---------------------------------------------------------------- Gläubigerdaten
export interface Konfig { gl_name: string; iban: string; bic: string; gl_id: string; bankkonto: string; vorlauf: number }

export async function konfigLesen(db: Db, v: Verein): Promise<Konfig> {
  const [c] = await db`select gl_name, iban, bic, gl_id, bankkonto, vorlauf from tco.soll_cfg where cfgid = 'TCO'`;
  return {
    gl_name: c?.gl_name ?? v.name ?? '', iban: c?.iban ?? (v.iban ?? ''), bic: c?.bic ?? (v.bic ?? ''), gl_id: c?.gl_id ?? '',
    bankkonto: c?.bankkonto ?? '1200', vorlauf: c?.vorlauf ?? 2,
  };
}

/** fehlende Pflichtangaben für die Datei */
export function konfigFehlt(c: Konfig): string[] {
  return [
    !c.gl_name && 'Name', !c.iban && 'IBAN', !c.gl_id && 'Gläubiger-ID', !c.bankkonto && 'Bankkonto FI',
  ].filter(Boolean) as string[];
}

export async function konfigSpeichern(tx: Db, c: Konfig, benutzer: string) {
  const k = { ...c, iban: normalisieren(c.iban), bic: normalisieren(c.bic), gl_id: normalisieren(c.gl_id), gl_name: c.gl_name.trim() };
  const f: string[] = [];
  if (k.iban && !ibanGueltig(k.iban)) f.push(`IBAN ${k.iban} ist ungültig.`);
  if (k.bic && !bicGueltig(k.bic)) f.push(`BIC ${k.bic} ist ungültig.`);
  if (k.gl_id && !glaeubigerIdGueltig(k.gl_id)) f.push(`Gläubiger-ID ${k.gl_id} ist ungültig (Format/Prüfziffer).`);
  if (k.bankkonto) {
    const [da] = await tx`select 1 from tco.fikonten where konto = ${k.bankkonto}`;
    if (!da) f.push(`Konto ${k.bankkonto} ist im Kontenplan nicht vorhanden.`);
  }
  if (f.length) throw new BusinessError(f.join(' '));
  await tx`
    insert into tco.soll_cfg (cfgid, gl_name, iban, bic, gl_id, bankkonto, vorlauf, aenam, aedat)
    values ('TCO', ${k.gl_name}, ${k.iban}, ${k.bic || null}, ${k.gl_id}, ${k.bankkonto}, ${k.vorlauf}, ${benutzer}, current_date)
    on conflict (cfgid) do update set gl_name = excluded.gl_name, iban = excluded.iban, bic = excluded.bic, gl_id = excluded.gl_id,
      bankkonto = excluded.bankkonto, vorlauf = excluded.vorlauf, aenam = excluded.aenam, aedat = excluded.aedat`;
}

// ---------------------------------------------------------------- Regeln
const artNorm = (a: string | null | undefined) => String(a ?? '').trim().replace(/^0+(?=\d)/, '');
export function beitragsart(art: string | null): 'MB' | 'JT' | 'SP' {
  const n = Number(artNorm(art));
  if (n === 90) return ART.jugend;
  if (Number.isFinite(n) && n >= 100) return ART.spende;
  return ART.mitglied;
}
const kontoVorschlag = (b: string) => (b === ART.jugend ? '8006' : b === ART.spende ? '8100' : '8002');
export const istBeitragsmonat = (sollper: string) => ['01', '07'].includes(sollper.slice(4, 6));

/** Turnus aus dem Vertragstext: monatlich, halbjährlich (Jan/Jul), vierteljährlich, jährlich (Jan), sonst nie */
export function turnusFaellig(turnus: string | null, monat: string): boolean {
  const t = (turnus ?? '').toLowerCase();
  if (t.includes('monat')) return true;
  if (t.includes('halb')) return monat === '01' || monat === '07';
  if (t.includes('viertel')) return ['01', '04', '07', '10'].includes(monat);
  if (t.includes('jähr') || t.includes('jaehr') || t.includes('jahr')) return monat === '01';
  return false;
}
const inLaufzeit = (d: string, beginn: string | null, ende: string | null) => !!beginn && d >= beginn && (!ende || d <= ende);

/** „Herr Max Meier“ → „Meier, Max“ (Sortierung nach Zahler) */
function sortName(inhaber: string, nachname: string, vorname: string): string {
  const inh = inhaber.trim();
  if (!inh) return `${nachname}, ${vorname}`.trim();
  if (inh.includes(',')) return inh;
  const t = inh.split(/\s+/);
  if (t.length < 2) return inh;
  let idx = t.length - 1;
  const nn = nachname.trim();
  if (nn) { const i = t.findIndex((x, j) => j >= 1 && x.includes(nn)); if (i >= 1) idx = i; }
  return `${t.slice(idx).join(' ')}, ${t.slice(0, idx).join(' ')}`;
}

export interface SollPos {
  key: string; sollper: string; adrnr: string; vertragnr: string; art: string; artname: string; beitragsart: string;
  betrag: number; konto: string; mitglnr: string; mitglied_name: string; zahler_adrnr: string; zahler_name: string;
  zahler_sort: string; fi_name: string; iban: string; bic: string; mandatsref: string; mandatsdatum: string | null;
  laufid: string | null; meldung: string; state: 'Positive' | 'Critical' | 'Negative' | 'Information'; grund: string;
}

/** Vorschlag (VORSCHLAG_ERMITTELN) */
export async function vorschlag(db: Db, sollper: string, mitMb: boolean, mitJt: boolean, faellig: string | null, mitVz = false) {
  const stichtag = `${sollper.slice(0, 4)}-${sollper.slice(4, 6)}-01`;
  const monat = sollper.slice(4, 6);
  const vtr = await db`
    select adrnr, vertragnr, art, coalesce(artname, '') as artname, coalesce(mitglnr, '') as mitglnr, sollstellung,
           vertragbegin::text as beginn, vertragende::text as ende, coalesce(betrag, 0)::float8 as betrag, zahler_adrnr, betrag_indiv
      from tco.vertraege
     where vertragbegin <= ${stichtag} and (vertragende is null or vertragende >= ${stichtag})`;
  const mg = new Map((await db`select * from tco.mitglieder`).map((m) => [adrKey(m.adrnr), m]));
  const sepa = new Map((await db`select adrnr, mandatsnr, status, angelegtam::text as angelegtam, gueltigbis::text as gueltigbis from tco.sepa`).map((s) => [adrKey(s.adrnr), s]));
  const done = new Map((await db`select adrnr, vertragnr, laufid from tco.soll_pos where sollper = ${sollper}`).map((d) => [`${d.adrnr}|${d.vertragnr}`, d.laufid as string]));
  const beitraege = new Map((await db`select art, erloeskonto from tco.beitrag`).map((b) => [artNorm(b.art), b.erloeskonto as string | null]));
  const preise = await db`select art, gueltig_ab::text as ab, gueltig_bis::text as bis, betrag::float8 as betrag from tco.beitrag_pr`;
  const preis = (art: string, d: string) => preise.find((p) => artNorm(p.art) === artNorm(art) && p.ab <= d && (!p.bis || p.bis >= d));

  const pos: SollPos[] = [];
  const excl: SollPos[] = [];
  for (const v of vtr) {
    const bart = beitragsart(v.art);
    if (bart === ART.jugend ? !mitJt : !mitMb) continue;
    // Beitragsstamm maßgeblich, individueller Betrag nur als Ausnahme
    const betrag = runden(v.betrag_indiv ? v.betrag : preis(v.art, stichtag)?.betrag ?? v.betrag);
    if (betrag <= 0) continue;
    if (!turnusFaellig(v.sollstellung, monat)) continue;
    const p: SollPos = {
      key: `${v.adrnr}|${v.vertragnr}`, sollper, adrnr: v.adrnr, vertragnr: v.vertragnr, art: artNorm(v.art), artname: v.artname.trim(),
      beitragsart: bart, betrag, konto: beitraege.get(artNorm(v.art)) || kontoVorschlag(bart), mitglnr: String(v.mitglnr).replace(/^0+/, ''),
      mitglied_name: '', zahler_adrnr: '', zahler_name: '', zahler_sort: '', fi_name: '', iban: '', bic: '', mandatsref: '',
      mandatsdatum: null, laufid: null, meldung: '', state: 'Positive', grund: '',
    };
    const m = mg.get(adrKey(v.adrnr));
    if (!m) { excl.push({ ...p, meldung: 'Mitglied nicht gefunden', state: 'Negative', grund: 'Mitglied nicht gefunden' }); continue; }
    p.mitglied_name = `${m.nachname ?? ''}, ${m.vorname ?? ''}`;
    if (faellig && !inLaufzeit(faellig, v.beginn, v.ende)) {
      excl.push({ ...p, state: 'Negative', grund: 'Einzugsdatum außerhalb der Vertragslaufzeit',
        meldung: `Einzugsdatum ${dat(faellig)} außerhalb der Vertragslaufzeit (${dat(v.beginn)} - ${v.ende ? dat(v.ende) : 'unbefristet'})` });
      continue;
    }
    const erg = zahlerPruefen(p, m, v.zahler_adrnr, bart, { mg, sepa, done, stichtag });
    if ('excl' in erg) excl.push(erg.excl); else pos.push(erg.pos);
  }

  // Verzehrabrechnungen Clubhaus (Sammelabrechnungen mit Zahlart Lastschrift, noch in keinem Lauf)
  if (mitVz) {
    const belege = await db`select b.rgnr, b.adrnr, b.monat, b.betrag::float8 as betrag, coalesce(nullif(c.erloeskonto, ''), '8400') as konto
                              from tco.vz_belege b left join tco.vz_cfg c on c.id = 1
                             where b.art = 'SAMMEL' and b.status = 'GESTELLT' and b.zahlart = 'LASTSCHRIFT' and b.laufid is null and b.datum <= ${stichtag}::date + interval '1 month'
                             order by b.rgnr`;
    for (const b of belege) {
      const p: SollPos = {
        key: `${b.adrnr}|${b.rgnr}`, sollper, adrnr: b.adrnr, vertragnr: b.rgnr, art: 'VZ', artname: `Verzehr Clubhaus ${b.monat.slice(4, 6)}/${b.monat.slice(0, 4)}`,
        beitragsart: ART.verzehr, betrag: runden(Number(b.betrag)), konto: b.konto, mitglnr: '',
        mitglied_name: '', zahler_adrnr: '', zahler_name: '', zahler_sort: '', fi_name: '', iban: '', bic: '', mandatsref: '',
        mandatsdatum: null, laufid: null, meldung: '', state: 'Positive', grund: '',
      };
      const m = mg.get(adrKey(b.adrnr));
      if (!m) { excl.push({ ...p, meldung: 'Mitglied nicht gefunden', state: 'Negative', grund: 'Mitglied nicht gefunden' }); continue; }
      p.mitglied_name = `${m.nachname ?? ''}, ${m.vorname ?? ''}`;
      p.mitglnr = String(m.mitglnrn ?? '').replace(/^0+/, '');
      const erg = zahlerPruefen(p, m, null, ART.verzehr, { mg, sepa, done, stichtag });
      if ('excl' in erg) excl.push(erg.excl); else pos.push(erg.pos);
    }
  }
  pos.sort((a, b) => a.zahler_sort.localeCompare(b.zahler_sort, 'de') || a.zahler_adrnr.localeCompare(b.zahler_adrnr)
    || a.mitglied_name.localeCompare(b.mitglied_name, 'de') || a.beitragsart.localeCompare(b.beitragsart) || a.vertragnr.localeCompare(b.vertragnr));
  excl.sort((a, b) => a.grund.localeCompare(b.grund) || a.mitglied_name.localeCompare(b.mitglied_name, 'de'));
  return { pos, excl };
}


/** Zahler, Bankverbindung und SEPA-Mandat prüfen (gemeinsam für Verträge und Verzehrabrechnungen) */
function zahlerPruefen(p: SollPos, m: Record<string, any>, zahlerAdrnr: unknown, bart: string,
  k: { mg: Map<string, Record<string, any>>; sepa: Map<string, Record<string, any>>; done: Map<string, string>; stichtag: string }): { pos: SollPos } | { excl: SollPos } {
    // Zahler: explizit am Vertrag (≠ Mitglied), sonst abweichender Zahler des Mitglieds, sonst das Mitglied.
    // Ein Vertrag, der das Mitglied selbst als Zahler nennt, gilt als „ohne abweichenden Zahler“.
    let z = m;
    const mAdr = adrKey(m.adrnr);
    const vAdr = adrKey(zahlerAdrnr);
    const vtrZahler = !!vAdr && vAdr !== mAdr;
    const kih = adrKey(m.adrnrkih);
    if (vtrZahler) {
      const zz = k.mg.get(vAdr);
      if (!zz) {
        return { excl: ({ ...p, state: 'Negative', grund: 'Zahler am Vertrag nicht gefunden', meldung: `Zahler ${vAdr.replace(/^0+/, '')} am Vertrag nicht gefunden` }) };
      }
      z = zz;
    } else if (kih && kih !== mAdr) {
      const zz = k.mg.get(kih);
      if (!zz) {
        return { excl: ({ ...p, state: 'Negative', grund: 'Abweichender Zahler nicht gefunden', meldung: `Abweichender Zahler ${kih.replace(/^0+/, '')} des Mitglieds nicht gefunden` }) };
      }
      z = zz;
    }
    p.zahler_adrnr = z.adrnr;
    let inhaber = String((vtrZahler ? z.abwkontoinh : m.abwkontoinh) ?? '').trim();
    if (!inhaber && !vtrZahler && z.adrnr !== m.adrnr) inhaber = String(z.abwkontoinh ?? '').trim();
    inhaber = inhaber.replace(/^(Herr|Frau)\s+/, '');
    p.zahler_name = inhaber || `${z.vorname ?? ''} ${z.nachname ?? ''}`.trim();
    p.zahler_sort = sortName(p.zahler_name, z.nachname ?? '', z.vorname ?? '');
    p.fi_name = sepaText(`${z.nachname ?? ''} ${z.vorname ?? ''}`, 40).toUpperCase();
    p.iban = normalisieren(z.iban1);
    p.bic = normalisieren(z.bic1);
    let s = k.sepa.get(adrKey(z.adrnr));
    if (!s && !vtrZahler) s = k.sepa.get(mAdr);
    if (s) { p.mandatsref = String(s.mandatsnr ?? '').trim(); p.mandatsdatum = s.angelegtam; }
    const zahlart = vtrZahler && z.zahlungsart ? z.zahlungsart : m.zahlungsart || z.zahlungsart;

    const lauf = k.done.get(p.key);
    let meldung = '';
    let state: SollPos['state'] = 'Negative';
    let grund = '';
    if (lauf) { meldung = `Bereits eingezogen (Lauf ${Number(lauf)})`; state = 'Information'; grund = 'Bereits eingezogen'; p.laufid = lauf; }
    else if (bart !== ART.jugend && m.austritt && m.austritt < k.stichtag) { meldung = `Ausgetreten zum ${dat(String(m.austritt).slice(0, 10))}`; state = 'Critical'; grund = 'Mitglied ausgetreten'; }
    else if (zahlart !== 'L') { meldung = `Keine Lastschrift (Zahlungsart "${zahlart ?? ''}")`; state = 'Critical'; }
    else if (!p.iban) meldung = 'IBAN fehlt';
    else if (!ibanGueltig(p.iban)) meldung = `IBAN ${p.iban} ungültig`;
    else if (!p.mandatsref) meldung = 'Mandatsreferenz fehlt';
    else if (!referenzGueltig(p.mandatsref)) meldung = `Mandatsreferenz ${p.mandatsref} ungültig`;
    else if (!s || !p.mandatsdatum) meldung = 'Kein SEPA-Mandat / Mandatsdatum fehlt';
    else if (!s.status) meldung = 'SEPA-Mandat ist nicht aktiv';
    else if (s.gueltigbis && s.gueltigbis < k.stichtag) meldung = `SEPA-Mandat gültig bis ${dat(s.gueltigbis)}`;
    else if (p.mandatsdatum > heute()) meldung = `Mandatsdatum ${dat(p.mandatsdatum)} liegt in der Zukunft`;
    else if (!['DE', 'AT', 'BE', 'BG', 'CY', 'CZ', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'].includes(p.iban.slice(0, 2)) && !p.bic) {
      meldung = `BIC für Konto in ${p.iban.slice(0, 2)} (außerhalb EWR) fehlt`;
    }
    if (meldung) return { excl: { ...p, meldung, state, grund: grund || meldung } };
    if (z.einzuglastmandliegtvor !== 'J' && (vtrZahler || m.einzuglastmandliegtvor !== 'J')) {
      p.meldung = 'Kennzeichen "Mandat liegt vor" nicht gesetzt';
      p.state = 'Critical';
    }
    return { pos: p };
}

export interface Tx { zahler_adrnr: string; zahler_name: string; fi_name: string; iban: string; bic: string; mandatsref: string; mandatsdatum: string; betrag: number; anzahl: number; e2e_id: string; zweck: string; positionen: string }

/** Je Zahler, Mandat und IBAN eine Lastschrift; Verwendungszweck wie in SAP */
export function lastschriften(pos: Pick<SollPos, 'zahler_adrnr' | 'zahler_name' | 'fi_name' | 'iban' | 'bic' | 'mandatsref' | 'mandatsdatum' | 'betrag' | 'mitglied_name' | 'artname'>[], laufid: string | null): Tx[] {
  const lauf = laufid ? String(Number(laufid)) : '';
  const sortiert = [...pos].sort((a, b) => a.zahler_adrnr.localeCompare(b.zahler_adrnr) || a.mandatsref.localeCompare(b.mandatsref) || a.iban.localeCompare(b.iban));
  const gruppen: (Tx & { nachname: string; vornamen: string[]; arten: string[] })[] = [];
  for (const p of sortiert) {
    let g = gruppen.find((x) => x.zahler_adrnr === p.zahler_adrnr && x.mandatsref === p.mandatsref && x.iban === p.iban);
    if (!g) {
      const nr = p.zahler_adrnr.replace(/^0+/, '');
      let e2e = lauf ? `TCO${lauf}-${nr}` : '';
      for (let n = 2; lauf && gruppen.some((x) => x.e2e_id === e2e); n++) e2e = `TCO${lauf}-${nr}-${n}`;
      g = { zahler_adrnr: p.zahler_adrnr, zahler_name: p.zahler_name, fi_name: p.fi_name, iban: p.iban, bic: p.bic, mandatsref: p.mandatsref,
        mandatsdatum: p.mandatsdatum ?? '', betrag: 0, anzahl: 0, e2e_id: e2e, zweck: '', positionen: '', nachname: '', vornamen: [], arten: [] };
      gruppen.push(g);
    }
    g.betrag = runden(g.betrag + p.betrag);
    g.anzahl++;
    const [nn, vn] = p.mitglied_name.split(', ');
    if (!g.nachname) g.nachname = (nn ?? '').trim();
    if (vn && !g.vornamen.includes(vn.trim())) g.vornamen.push(vn.trim());
    g.arten.push(p.artname);
  }
  return gruppen.map(({ nachname, vornamen, arten, ...g }) => {
    const namen = sepaText(`${nachname} ${vornamen.join('/')}`, 27).toUpperCase().replace(/[/ ]+$/, '');
    const art = sepaText(arten.join('/'), 27).toUpperCase().replace(/[/ ]+$/, '');
    return { ...g, zweck: `TC OBERTHAL ${namen} ${art} VIELEN DANK`, positionen: arten.join(', ') };
  });
}

/**
 * Lauf erzeugen (LAUF_ERZEUGEN): Vorschlag wird hier neu ermittelt (aktuelle Mandate/IBAN, E10);
 * `ohne`: abgewählte Positionen (E7). Fehler der Dateiprüfung verhindern den Lauf.
 */
export async function laufErzeugen(tx: Db, cfg: Konfig, p: { sollper: string; mitMb: boolean; mitJt: boolean; mitVz?: boolean; faellig: string; ohne: string[] }, benutzer: string) {
  const fehlt = konfigFehlt(cfg);
  if (fehlt.length) throw new BusinessError(`Gläubigerdaten unvollständig: ${fehlt.join(', ')}. Ohne diese Angaben kann keine Lastschriftdatei erzeugt werden.`);
  await tx`select pg_advisory_xact_lock(hashtext('tco.soll_kopf'))`;
  const v = await vorschlag(tx, p.sollper, p.mitMb, p.mitJt, p.faellig, p.mitVz ?? false);
  const pos = v.pos.filter((x) => !p.ohne.includes(x.key));
  if (!pos.length) return { laufid: null, meldungen: [{ zeile: 0, zahlerNr: '', schwere: 'E', feld: 'Positionen', text: 'Keine Positionen für den Einzug vorhanden.' }] as Meldung[] };

  const [mx] = await tx`select coalesce(max(laufid::bigint), 0) + 1 as n from tco.soll_kopf where laufid ~ '^[0-9]+$'`;
  const laufid = String(mx.n).padStart(10, '0');
  const txs = lastschriften(pos, laufid);
  const jetzt = new Date();
  const d = heute();
  const zeit = `${String(jetzt.getHours()).padStart(2, '0')}:${String(jetzt.getMinutes()).padStart(2, '0')}:${String(jetzt.getSeconds()).padStart(2, '0')}`;
  const msgid = `${dat(d)}-${zeit}`;
  const posten: Lastschrift[] = txs.map((t) => ({
    zahlerNr: t.zahler_adrnr.replace(/^0+/, ''), name: t.fi_name, iban: t.iban, bic: t.bic, mandat: t.mandatsref,
    mandatsdatum: t.mandatsdatum, betrag: t.betrag, zweck: t.zweck, endToEndId: 'NOTPROVIDED', sequenz: 'RCUR',
  }));
  const r = pain008({
    glaeubiger: { name: cfg.gl_name.toUpperCase(), iban: cfg.iban, bic: cfg.bic, glaeubigerId: cfg.gl_id },
    faellig: p.faellig, posten, heute: d, zeit, variante: 'TCO02', nachrichtenId: msgid, pmtInfPrefix: 'TCO',
  });
  if (r.fehler || !r.xml) return { laufid: null, meldungen: r.meldungen };

  const summe = runden(pos.reduce((s, x) => s + x.betrag, 0));
  await tx`
    insert into tco.soll_kopf (laufid, sollper, mit_mb, mit_jt, faellig, msgid, anz_pos, anz_tx, summe, status, ernam, erdat, erzeit, xml)
    values (${laufid}, ${p.sollper}, ${p.mitMb}, ${p.mitJt}, ${p.faellig}, ${msgid}, ${pos.length}, ${txs.length}, ${summe}, 'E',
            ${benutzer}, current_date, localtime(0), ${r.xml})`;
  const e2e = (x: SollPos) => txs.find((t) => t.zahler_adrnr === x.zahler_adrnr && t.mandatsref === x.mandatsref && t.iban === x.iban)!.e2e_id;
  const zeilen = pos.map((x) => ({
    sollper: x.sollper, adrnr: x.adrnr, vertragnr: x.vertragnr, laufid, art: x.art, artname: x.artname, beitragsart: x.beitragsart,
    betrag: x.betrag, konto: x.konto, mitglnr: x.mitglnr, mitglied_name: x.mitglied_name, zahler_adrnr: x.zahler_adrnr,
    zahler_name: x.zahler_name, fi_name: x.fi_name, iban: x.iban, bic: x.bic || null, mandatsref: x.mandatsref,
    mandatsdatum: x.mandatsdatum, e2e_id: e2e(x), status: '',
  }));
  try {
    await tx`insert into tco.soll_pos ${tx(zeilen as never)}`;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new BusinessError('Lauf konnte nicht gesichert werden (Positionen bereits eingezogen?).');
    throw e;
  }
  const vz = pos.filter((x) => x.beitragsart === ART.verzehr).map((x) => x.vertragnr);
  if (vz.length) await tx`update tco.vz_belege set laufid = ${laufid} where rgnr = any(${vz})`;
  return { laufid, meldungen: r.meldungen, anzahl: pos.length, summe };
}

export async function laeufeLesen(db: Db) {
  return db`
    select laufid, sollper, mit_mb, mit_jt, faellig::text as faellig, anz_pos, anz_tx, summe::float8 as summe, status,
           zahl_datum::text as zahl_datum, fi_datum::text as fi_datum, ernam, erdat::text as erdat, pl_doc_id,
           (select max(internenr) from tco.soll_pos p where p.laufid = k.laufid) as internenr
      from tco.soll_kopf k order by laufid desc`;
}

export async function laufLesen(db: Db, laufid: string) {
  const [k] = await db`
    select laufid, sollper, mit_mb, mit_jt, faellig::text as faellig, msgid, anz_pos, anz_tx, summe::float8 as summe, status,
           zahl_datum::text as zahl_datum, fi_datum::text as fi_datum, ernam, erdat::text as erdat, erzeit::text as erzeit, pl_doc_id,
           xml is not null as hat_xml
      from tco.soll_kopf where laufid = ${laufid}`;
  if (!k) throw new BusinessError('Lauf nicht gefunden.');
  const pos = await db`
    select adrnr || '|' || vertragnr as key, sollper, adrnr, vertragnr, art, artname, beitragsart, betrag::float8 as betrag, konto, mitglnr,
           mitglied_name, zahler_adrnr, zahler_name, fi_name, iban, bic, mandatsref, mandatsdatum::text as mandatsdatum, e2e_id,
           status, internenr, fi_posnr
      from tco.soll_pos where laufid = ${laufid}
     order by zahler_name, zahler_adrnr, mitglied_name, beitragsart, vertragnr`;
  return { kopf: k, pos, tx: lastschriften(pos as never, laufid) };
}

/** Storno (nur Datei erzeugt): Positionen löschen, Kopf bleibt mit Status S */
export async function laufStornieren(tx: Db, laufid: string) {
  const [k] = await tx`select status from tco.soll_kopf where laufid = ${laufid} for update`;
  if (!k) throw new BusinessError('Lauf nicht gefunden.');
  if (k.status !== 'E') throw new BusinessError(k.status === 'V' ? 'Der Lauf ist bereits in FI verbucht – bitte zuerst dort die Buchung stornieren.' : 'Stornieren ist nur vor der Verbuchung möglich.');
  await tx`delete from tco.soll_pos where laufid = ${laufid}`;
  await tx`update tco.soll_kopf set status = 'S' where laufid = ${laufid}`;
  await tx`update tco.vz_belege set laufid = null where laufid = ${laufid} and status <> 'BEZAHLT'`;
}

// ---------------------------------------------------------------- Zusammenspiel mit FI Belege
export interface OffenerLauf { laufid: string; sollper: string; faellig: string | null; summe: number; anzahl: number; konto: string; text: string }

/** Offene Läufe (erzeugt, noch nicht verbucht) mit Summe der offenen Positionen und Hauptkonto */
export async function offeneLaeufe(db: Db): Promise<OffenerLauf[]> {
  const rows = await db`
    select k.laufid, k.sollper, k.faellig::text as faellig, p.konto, sum(p.betrag)::float8 as summe, count(*)::int as n
      from tco.soll_kopf k join tco.soll_pos p on p.laufid = k.laufid and coalesce(p.status, '') = ''
     where k.status in ('E', 'Z')
     group by k.laufid, k.sollper, k.faellig, p.konto`;
  const m = new Map<string, OffenerLauf & { max: number }>();
  for (const r of rows) {
    const l = m.get(r.laufid) ?? { laufid: r.laufid, sollper: r.sollper, faellig: r.faellig, summe: 0, anzahl: 0, konto: r.konto, max: 0, text: '' };
    l.summe = runden(l.summe + r.summe);
    l.anzahl += r.n;
    if (r.summe > l.max) { l.max = r.summe; l.konto = r.konto; }
    m.set(r.laufid, l);
  }
  return [...m.values()].map(({ max: _m, ...l }) => ({
    ...l, text: `Sollstellung Lauf ${Number(l.laufid)} (${l.sollper.slice(4, 6)}/${l.sollper.slice(0, 4)}, ${l.anzahl} Positionen)`,
  })).sort((a, b) => b.laufid.localeCompare(a.laufid));
}

/** Lauf zu einer Gutschrift (LAUF_ZU_ZAHLUNG): gleiche Summe, Fälligkeit höchstens 14 Tage entfernt, nächster gewinnt */
export function laufZuZahlung(laeufe: OffenerLauf[], betrag: number, datum: string): OffenerLauf | null {
  const tage = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);
  return laeufe.filter((l) => l.summe === runden(Math.abs(betrag)) && (!l.faellig || tage(l.faellig, datum) <= 14))
    .sort((a, b) => tage(a.faellig ?? datum, datum) - tage(b.faellig ?? datum, datum))[0] ?? null;
}

/** Positionen der Splitbuchung eines Laufs (Erlöskonto je Position, Text „Vertragsart/Name des Zahlers“) */
export async function laufPositionen(db: Db, laufid: string) {
  const [k] = await db`select status from tco.soll_kopf where laufid = ${laufid}`;
  if (!k) throw new BusinessError(`Sollstellung Lauf ${Number(laufid)} nicht gefunden`);
  if (!['E', 'Z'].includes(k.status)) throw new BusinessError(`Sollstellung Lauf ${Number(laufid)} ist bereits verbucht oder storniert`);
  const pos = await db`
    select adrnr, vertragnr, konto, betrag::float8 as betrag, artname, fi_name from tco.soll_pos
     where laufid = ${laufid} and coalesce(status, '') = ''
     order by zahler_name, zahler_adrnr, mitglied_name, beitragsart, vertragnr`;
  if (!pos.length) throw new BusinessError(`Sollstellung Lauf ${Number(laufid)} hat keine offenen Positionen`);
  return pos.map((p) => ({ adrnr: p.adrnr as string, vertragnr: p.vertragnr as string, gkonto: p.konto as string, betrag: p.betrag as number, text: `${String(p.artname ?? '').trim()}/${p.fi_name ?? ''}`.slice(0, 60) }));
}

/** Nach dem Buchen in FI: Positionen mit interner Nummer und Position der Erlöszeile versehen, Lauf verbucht */
export async function laufVerbucht(tx: Db, laufid: string, internenr: string, datum: string) {
  const pos = await laufPositionen(tx, laufid);
  const zaehler = new Map<string, number>();
  for (const p of pos) {
    const n = zaehler.get(p.gkonto) ?? 0;
    zaehler.set(p.gkonto, n + 1);
    await tx`update tco.soll_pos set status = 'V', internenr = ${internenr}, fi_posnr = ${n}
              where laufid = ${laufid} and adrnr = ${p.adrnr} and vertragnr = ${p.vertragnr}`;
  }
  await tx`update tco.soll_kopf set status = 'V', zahl_datum = ${datum}, fi_datum = current_date where laufid = ${laufid}`;
  // Verzehrabrechnungen des Laufs gelten mit der Verbuchung als bezahlt
  await tx`update tco.vz_belege set status = 'BEZAHLT', bezahlt_am = ${datum} where laufid = ${laufid} and status = 'GESTELLT'`;
}

/** Storno in FI: Lauf wieder offen (FI_ZUORDNUNG_AUFHEBEN) */
export async function laufZuruecksetzen(tx: Db, internenr: string): Promise<string | null> {
  const [p] = await tx`select laufid from tco.soll_pos where internenr = ${internenr} and status = 'V' limit 1`;
  if (!p) return null;
  await tx`update tco.soll_pos set status = '', internenr = null, fi_posnr = null where laufid = ${p.laufid} and internenr = ${internenr}`;
  await tx`update tco.soll_kopf set status = 'E', zahl_datum = null, fi_datum = null where laufid = ${p.laufid} and status = 'V'`;
  await tx`update tco.vz_belege set status = 'GESTELLT', bezahlt_am = null where laufid = ${p.laufid} and status = 'BEZAHLT'`;
  return p.laufid;
}

export const vorschlagFaelligkeit = faelligkeitVorschlag;
