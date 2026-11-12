/**
 * Spielerdaten aus nuLiga (#162): Die im Verbandsportal heruntergeladene Datei „Mitgliederdaten“ (CSV) wird mit den aktiven
 * Mitgliedern abgeglichen; bei einem Treffer werden ID-Nr. und LK in die Mitglieder-Zusatzdaten (tco.mitgliedera) übernommen.
 *
 * Abgleich in dieser Reihenfolge: bereits gespeicherte ID-Nr. · Name + Geburtsdatum · eindeutiger Name (Geburtsdatum fehlt
 * auf einer Seite). Unsichere Treffer (Geburtsdatum weicht ab, Vorname weicht ab, ID-Nr. schon bei einem anderen Mitglied)
 * werden nur als Vorschlag angezeigt und erst nach ausdrücklicher Auswahl übernommen.
 *
 * Ähnliche Namen (Schreibweise „Matteo“/„Mateo“, vertauschte oder fehlende Buchstaben, in der Datei durch „?“ ersetzte
 * Sonderzeichen wie „Sch?n“) werden als Prüffall vorgeschlagen. Was der Abgleich nicht findet, ordnet der Benutzer von Hand zu
 * (manuell: Mitglied ohne Treffer ↔ noch nicht zugeordnete Person der Datei).
 */
import { BusinessError } from '../../../../server/src/errors.js';
import { csvParse, dekodieren } from '../../../../server/src/lib/sapcsv.js';
import type { Db } from '../verein.js';
import { condense, dat, heute } from '../format.js';
import { leer, normName } from '../mitglieder/logik.js';

export interface NuPerson { zeile: number; nachname: string; vorname: string; geburtsdatum: string | null; lk: number | null; id_nr: string | null }

const kopf = (s: string) => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]/g, '');
const SPALTEN = {
  nachname: ['nachname', 'name', 'familienname', 'zuname'],
  vorname: ['vorname', 'rufname'],
  geburtsdatum: ['geburtsdatum', 'gebdatum', 'gebdat', 'geburtstag', 'geboren', 'geb', 'jahrgang'],
  lk: ['lk', 'leistungsklasse', 'aktuellelk'],
  id_nr: ['idnr', 'idnummer', 'id', 'dtbid', 'dtbidnr', 'dtbidnummer', 'spieleridnr', 'spielerid', 'dtbspieleridnr'],
} as const;

/** „LK25,0“, „25.0“, „LK 2,4“ → 25 / 2.4; „-“ oder leer → null */
export function lkLesen(v: string): number | null {
  const m = /(\d{1,2})(?:[.,](\d))?/.exec(v.replace(/\s/g, ''));
  if (!m) return null;
  const n = Number(`${m[1]}.${m[2] ?? '0'}`);
  return n >= 1 && n <= 25 ? n : null;
}
export const lkText = (lk: number | null | undefined) => (lk == null ? '' : `LK ${Number(lk).toFixed(1).replace('.', ',')}`);
function datumLesen(v: string): string | null {
  const s = v.trim();
  let m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** nuLiga-Datei lesen: Spalten über die Kopfzeile finden (Reihenfolge und weitere Spalten sind egal) */
export function nuligaLesen(datei: Buffer): NuPerson[] {
  const zeilen = csvParse(dekodieren(datei)).filter((z) => z.some((x) => x.trim()));
  if (zeilen.length < 2) throw new BusinessError('Die Datei enthält keine Daten.');
  const k = zeilen[0].map(kopf);
  const finde = (f: keyof typeof SPALTEN) => { for (const n of SPALTEN[f]) { const i = k.indexOf(n); if (i >= 0) return i; } return -1; };
  const s = { nachname: finde('nachname'), vorname: finde('vorname'), geburtsdatum: finde('geburtsdatum'), lk: finde('lk'), id_nr: finde('id_nr') };
  const gefunden = zeilen[0].map((x) => x.trim()).filter(Boolean).join(', ');
  if (s.nachname < 0) throw new BusinessError(`Die Spalte „Nachname“ fehlt. Bitte die Datei „Download Mitgliederdaten (Excel, csv)“ aus nuLiga verwenden. Gefundene Spalten: ${gefunden}`);
  if (s.lk < 0 && s.id_nr < 0) throw new BusinessError(`Die Spalten „LK“ und „ID-Nr“ fehlen. Gefundene Spalten: ${gefunden}`);
  const personen: NuPerson[] = [];
  zeilen.slice(1).forEach((z, i) => {
    let nachname = condense(z[s.nachname] ?? ''), vorname = s.vorname >= 0 ? condense(z[s.vorname] ?? '') : '';
    // eine Spalte „Name“ mit „Nachname, Vorname“
    if (!vorname && nachname.includes(',')) [nachname, vorname] = nachname.split(',').map((x) => condense(x));
    if (!nachname) return;
    const id = s.id_nr >= 0 ? (z[s.id_nr] ?? '').replace(/\D/g, '') : '';
    personen.push({
      zeile: i + 2, nachname, vorname, geburtsdatum: s.geburtsdatum >= 0 ? datumLesen(z[s.geburtsdatum] ?? '') : null,
      lk: s.lk >= 0 ? lkLesen(z[s.lk] ?? '') : null, id_nr: id.length >= 5 && Number(id) > 0 ? id : null,
    });
  });
  if (!personen.length) throw new BusinessError('Die Datei enthält keine Personen.');
  return personen;
}

/** in der Datei verlorene Sonderzeichen: „?“ bzw. Ersatzzeichen stehen für 0–2 beliebige Buchstaben („Sch?n“ = Schön, „R?ghioui“ = R'ghioui) */
const WILD = /[?\uFFFD]+/;
export function nameGleich(ausDatei: string, imPortal: string): boolean {
  if (!WILD.test(ausDatei)) return normName(ausDatei) === normName(imPortal);
  const teile = ausDatei.split(WILD).map((t) => normName(t).replace(/[^a-z ]/g, ''));
  return new RegExp(`^${teile.join('[a-z ]{0,3}')}$`).test(normName(imPortal));
}
/** Editierdistanz (Levenshtein), abgebrochen bei mehr als `max` */
export function abstand(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let v = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const n = [i];
    for (let j = 1; j <= b.length; j++) n[j] = Math.min(v[j] + 1, n[j - 1] + 1, v[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    v = n;
  }
  return v[b.length];
}

export interface Treffer {
  adrnr: string; zeile: number; name: string; mitglnrn: string; geburtsdatum: string | null; inDatei: string;
  art: 'ID' | 'NAME_GEB' | 'NAME' | 'PRUEFEN' | 'MANUELL'; sicher: boolean; hinweis: string | null;
  id_alt: string | null; id_neu: string | null; lk_alt: number | null; lk_neu: number | null;
  /** ID-Nr. oder LK würden sich ändern */
  aenderung: boolean;
}
interface Mitglied {
  adrnr: string; vorname: string; nachname: string; geburtsdatum: string | null; mitglnrn: string; id_nr: string | null; lk: number | null; lk_stand: string | null;
  eintritt?: string | null;
  /** „Für Meldung irrelevant“: null = offen, true = gesetzt, false = hat eine ID-Nr. */
  irrelevant?: boolean | null;
}

export async function mitgliederLesen(db: Db): Promise<Mitglied[]> {
  const rows = await db`
    select m.adrnr, m.vorname, m.nachname, m.geburtsdatum::text as geburtsdatum, m.mitglnrn, a.id_nr, a.lk::float8 as lk, a.lk_stand::text as lk_stand,
           m.eintritt::text as eintritt, a.meldung_irrelevant
      from tco.mitglieder m left join tco.mitgliedera a on a.adrnr = m.adrnr
     where m.eintritt is not null and (m.austritt is null or m.austritt >= current_date)
     order by lower(m.nachname), lower(m.vorname), m.adrnr`;
  return rows.map((r) => ({
    adrnr: r.adrnr, vorname: leer(r.vorname), nachname: leer(r.nachname), geburtsdatum: r.geburtsdatum, mitglnrn: leer(r.mitglnrn),
    id_nr: leer(r.id_nr) || null, lk: r.lk == null ? null : Number(r.lk), lk_stand: r.lk_stand,
    eintritt: r.eintritt, irrelevant: leer(r.id_nr) ? false : r.meldung_irrelevant === true ? true : null,
  }));
}

export function abgleichen(mitglieder: Mitglied[], personen: NuPerson[], manuell: { adrnr: string; zeile: number }[] = []) {
  const treffer: Treffer[] = [];
  const mFrei = new Map(mitglieder.map((m) => [m.adrnr, m]));
  const pFrei = new Map(personen.map((p) => [p.zeile, p]));
  const nm = (v: string, n: string) => normName(`${v} ${n}`);
  const idBei = new Map(mitglieder.filter((m) => m.id_nr).map((m) => [m.id_nr!, m.adrnr]));
  const paar = (m: Mitglied, p: NuPerson, art: Treffer['art'], sicher: boolean, hinweis: string | null) => {
    // ID-Nr. der Datei gehört schon zu einem anderen Mitglied: nur als Vorschlag
    const fremd = p.id_nr && idBei.has(p.id_nr) && idBei.get(p.id_nr) !== m.adrnr;
    if (fremd) { sicher = false; hinweis = `ID-Nr. ${p.id_nr} ist bereits bei einem anderen Mitglied gespeichert.`; }
    else if (sicher && m.id_nr && p.id_nr && m.id_nr !== p.id_nr) { sicher = false; hinweis = `Gespeicherte ID-Nr. ${m.id_nr} weicht ab – bitte prüfen.`; }
    const id_neu = p.id_nr ?? m.id_nr;        // eine fehlende ID-Nr. in der Datei löscht die gespeicherte nicht
    treffer.push({
      adrnr: m.adrnr, zeile: p.zeile, name: condense(`${m.nachname}, ${m.vorname}`), mitglnrn: m.mitglnrn, geburtsdatum: m.geburtsdatum,
      inDatei: condense(`${p.nachname}, ${p.vorname}${p.geburtsdatum ? ` (${dat(p.geburtsdatum)})` : ''}`), art, sicher, hinweis,
      id_alt: m.id_nr, id_neu, lk_alt: m.lk, lk_neu: p.lk, aenderung: id_neu !== m.id_nr || p.lk !== m.lk,
    });
    mFrei.delete(m.adrnr); pFrei.delete(p.zeile);
  };
  // gleicher Name – in der Datei verlorene Sonderzeichen („?“) zählen als Platzhalter
  const gleich = (p: NuPerson, m: Mitglied) => nameGleich(`${p.vorname} ${p.nachname}`, `${m.vorname} ${m.nachname}`);
  // 0. von Hand zugeordnet
  for (const z of manuell) {
    const m = mFrei.get(z.adrnr), p = pFrei.get(z.zeile);
    if (m && p) paar(m, p, 'MANUELL', true, 'von Hand zugeordnet');
  }
  // 1. gespeicherte ID-Nr.
  for (const p of personen) {
    const m = p.id_nr ? [...mFrei.values()].find((x) => x.id_nr === p.id_nr) : null;
    if (m) paar(m, p, 'ID', true, gleich(p, m) ? null : 'Name weicht ab – Treffer über die gespeicherte ID-Nr.');
  }
  // 2. Name und Geburtsdatum
  for (const p of [...pFrei.values()]) {
    if (!p.geburtsdatum) continue;
    const ms = [...mFrei.values()].filter((m) => m.geburtsdatum === p.geburtsdatum && gleich(p, m));
    if (ms.length === 1) paar(ms[0], p, 'NAME_GEB', true, null);
  }
  // 3. gleicher Name: eindeutig → Treffer; Geburtsdatum abweichend → prüfen
  for (const p of [...pFrei.values()]) {
    const ms = [...mFrei.values()].filter((m) => gleich(p, m));
    const ps = [...pFrei.values()].filter((x) => nm(x.vorname, x.nachname) === nm(p.vorname, p.nachname));
    if (ms.length !== 1 || ps.length !== 1) continue;
    const m = ms[0];
    if (m.geburtsdatum && p.geburtsdatum) paar(m, p, 'PRUEFEN', false, `Geburtsdatum weicht ab: Portal ${dat(m.geburtsdatum)}, nuLiga ${dat(p.geburtsdatum)}.`);
    else paar(m, p, 'NAME', true, 'Treffer über den Namen (kein Geburtsdatum zum Vergleich).');
  }
  // 4. gleicher Nachname und gleiches Geburtsdatum, Vorname weicht ab (Rufname, Doppelname): prüfen
  for (const p of [...pFrei.values()]) {
    if (!p.geburtsdatum) continue;
    const ms = [...mFrei.values()].filter((m) => m.geburtsdatum === p.geburtsdatum && nameGleich(p.nachname, m.nachname));
    if (ms.length === 1) paar(ms[0], p, 'PRUEFEN', false, `Vorname weicht ab: Portal „${ms[0].vorname}“, nuLiga „${p.vorname}“.`);
  }
  // 5. ähnliche Namen (Schreibweise, Tippfehler): bester Kandidat je Person als Prüffall
  const kandidaten: { m: Mitglied; p: NuPerson; d: number }[] = [];
  for (const p of pFrei.values()) {
    const pv = normName(p.vorname.replace(WILD, '')), pn = normName(p.nachname.replace(WILD, ''));
    for (const m of mFrei.values()) {
      const mv = normName(m.vorname), mn = normName(m.nachname);
      const gebGleich = !!p.geburtsdatum && p.geburtsdatum === m.geburtsdatum;
      const nachGleich = nameGleich(p.nachname, m.nachname), vorGleich = nameGleich(p.vorname, m.vorname);
      const dv = vorGleich ? 0 : abstand(pv, mv, 2), dn = nachGleich ? 0 : abstand(pn, mn, 2);
      const vorTeil = pv.length >= 3 && mv.length >= 3 && (pv.startsWith(mv) || mv.startsWith(pv) || pv.split(' ').some((t) => t.length >= 3 && mv.split(' ').includes(t)));
      const passt = (nachGleich && (vorTeil || (dv <= 2 && Math.min(pv.length, mv.length) >= 4) || (dv <= 1 && gebGleich)))
        || (vorGleich && dn <= (gebGleich ? 2 : 1) && Math.min(pn.length, mn.length) >= 4)
        || (gebGleich && dv + dn <= 3);
      if (passt) kandidaten.push({ m, p, d: dv + dn + (gebGleich ? 0 : 1) + (vorTeil && !vorGleich ? 1 : 0) });
    }
  }
  kandidaten.sort((x, y) => x.d - y.d || x.p.zeile - y.p.zeile);
  for (const k of kandidaten) {
    if (!mFrei.has(k.m.adrnr) || !pFrei.has(k.p.zeile)) continue;
    const geb = k.m.geburtsdatum && k.p.geburtsdatum && k.m.geburtsdatum !== k.p.geburtsdatum
      ? ` Geburtsdatum weicht ab: Portal ${dat(k.m.geburtsdatum)}, nuLiga ${dat(k.p.geburtsdatum)}.` : '';
    paar(k.m, k.p, 'PRUEFEN', false, `Ähnlicher Name: Portal „${condense(`${k.m.vorname} ${k.m.nachname}`)}“, nuLiga „${condense(`${k.p.vorname} ${k.p.nachname}`)}“.${geb}`);
  }
  treffer.sort((a, b) => Number(a.sicher) - Number(b.sicher) || a.name.localeCompare(b.name, 'de'));
  return {
    treffer,
    // „Für Meldung irrelevant“ gekennzeichnete Mitglieder werden nicht mehr als fehlend aufgeführt
    ohneTreffer: [...mFrei.values()].filter((m) => m.irrelevant !== true).map((m) => ({ adrnr: m.adrnr, name: condense(`${m.nachname}, ${m.vorname}`), geburtsdatum: m.geburtsdatum, id_nr: m.id_nr, lk: m.lk })),
    nurDatei: [...pFrei.values()].map((p) => ({ zeile: p.zeile, name: condense(`${p.nachname}, ${p.vorname}`), geburtsdatum: p.geburtsdatum, id_nr: p.id_nr, lk: p.lk })),
  };
}

export async function abgleich(db: Db, datei: Buffer) {
  const personen = nuligaLesen(datei);
  const r = abgleichen(await mitgliederLesen(db), personen);
  return {
    ...r, personen: personen.length,
    anzahl: {
      aenderungen: r.treffer.filter((t) => t.sicher && t.aenderung).length, unveraendert: r.treffer.filter((t) => t.sicher && !t.aenderung).length,
      pruefen: r.treffer.filter((t) => !t.sicher).length, ohneTreffer: r.ohneTreffer.length, nurDatei: r.nurDatei.length,
    },
  };
}

/**
 * Ausgewählte Treffer übernehmen. Die Werte kommen aus der erneut gelesenen Datei, nicht aus der Anfrage; übernommen werden
 * nur Paare (Mitglied, Zeile), die der Abgleich selbst gefunden hat, sowie ausdrücklich von Hand zugeordnete Paare.
 */
export async function uebernehmen(tx: Db, datei: Buffer, auswahl: { adrnr: string; zeile: number; manuell?: boolean }[]): Promise<string> {
  const mitglieder = await mitgliederLesen(tx);
  const personen = nuligaLesen(datei);
  // von Hand zugeordnet: nur Mitglieder und Personen, für die der Abgleich keinen sicheren Treffer hat
  const hand = auswahl.filter((x) => x.manuell);
  if (hand.length) {
    const auto = abgleichen(mitglieder, personen);
    for (const z of hand) {
      const m = mitglieder.find((x) => x.adrnr === z.adrnr), p = personen.find((x) => x.zeile === z.zeile);
      if (!m || !p) throw new BusinessError('Die Zuordnung passt nicht mehr zur Datei – bitte die Datei erneut ablegen.');
      if (auto.treffer.some((t) => t.sicher && (t.adrnr === z.adrnr || t.zeile === z.zeile))) {
        throw new BusinessError(`${condense(`${m.nachname}, ${m.vorname}`)} ↔ ${condense(`${p.nachname}, ${p.vorname}`)}: Mitglied oder Person ist bereits sicher zugeordnet.`);
      }
    }
    if (new Set(hand.map((z) => z.adrnr)).size !== hand.length || new Set(hand.map((z) => z.zeile)).size !== hand.length) throw new BusinessError('Eine Person oder ein Mitglied ist mehrfach zugeordnet.');
  }
  const r = abgleichen(mitglieder, personen, hand);
  const h = heute();
  const jahr = Number(h.slice(0, 4));
  let n = 0, lkNeu = 0, idNeu = 0;
  for (const a of auswahl) {
    const t = r.treffer.find((x) => x.adrnr === a.adrnr && x.zeile === a.zeile);
    if (!t) throw new BusinessError('Die Auswahl passt nicht mehr zur Datei – bitte die Datei erneut ablegen.');
    if (t.id_neu && t.id_neu !== t.id_alt) {
      const [fremd] = await tx`select adrnr from tco.mitgliedera where id_nr = ${t.id_neu} and adrnr <> ${t.adrnr}`;
      if (fremd) throw new BusinessError(`${t.name}: Die ID-Nr. ${t.id_neu} ist bereits bei einem anderen Mitglied gespeichert.`);
      idNeu++;
    }
    if (t.lk_neu !== t.lk_alt) lkNeu++;
    // mit ID-Nr. ist das Mitglied gemeldet: Kennzeichen „Für Meldung irrelevant“ automatisch auf „nicht gesetzt“
    const irr = t.id_neu ? false : null;
    await tx`insert into tco.mitgliedera (adrnr, id_nr, lk, lk_stand, meldung_irrelevant) values (${t.adrnr}, ${t.id_neu}, ${t.lk_neu}, ${h}, ${irr})
             on conflict (adrnr) do update set id_nr = excluded.id_nr, lk = excluded.lk, lk_stand = excluded.lk_stand,
               meldung_irrelevant = case when excluded.id_nr is not null then false else tco.mitgliedera.meldung_irrelevant end`;
    if (t.lk_neu != null) {
      await tx`insert into tco.mitglieder_lk (adrnr, jahr, lk, stand) values (${t.adrnr}, ${jahr}, ${t.lk_neu}, ${h})
               on conflict (adrnr, jahr) do update set lk = excluded.lk, stand = excluded.stand`;
    }
    n++;
  }
  return `${n} Mitglied${n === 1 ? '' : 'er'} abgeglichen: ${idNeu} ID-Nr. und ${lkNeu} LK neu oder geändert (Stand ${dat(h)}).`;
}

/**
 * Aktueller Stand für die App: alle aktiven Mitglieder mit Eintritt, ID-Nr., LK, Verlauf der letzten Jahre und dem Kennzeichen
 * „Für Meldung irrelevant“ – jüngster Eintritt zuerst.
 */
export async function standLesen(db: Db) {
  const m = await mitgliederLesen(db);
  const verlauf = await db`select adrnr, jahr, lk::float8 as lk from tco.mitglieder_lk where jahr >= ${Number(heute().slice(0, 4)) - 3} order by jahr desc`;
  const [letzter] = await db`select max(lk_stand)::text as d from tco.mitgliedera`;
  const sortiert = [...m].sort((a, b) => (b.eintritt ?? '').localeCompare(a.eintritt ?? '') || a.nachname.localeCompare(b.nachname, 'de') || a.vorname.localeCompare(b.vorname, 'de'));
  return {
    zeilen: sortiert.map((x) => ({
      adrnr: x.adrnr, name: condense(`${x.nachname}, ${x.vorname}`), nachname: x.nachname, vorname: x.vorname, mitglnrn: x.mitglnrn, geburtsdatum: x.geburtsdatum,
      eintritt: x.eintritt ?? null, id_nr: x.id_nr, lk: x.lk, lk_stand: x.lk_stand, irrelevant: x.irrelevant ?? null,
      verlauf: verlauf.filter((v) => v.adrnr === x.adrnr).map((v) => ({ jahr: Number(v.jahr), lk: Number(v.lk) })),
    })),
    anzahl: {
      mitglieder: m.length, mitId: m.filter((x) => x.id_nr).length, ohneId: m.filter((x) => !x.id_nr && x.irrelevant !== true).length,
      irrelevant: m.filter((x) => x.irrelevant === true).length, mitLk: m.filter((x) => x.lk != null).length,
    },
    letzterAbgleich: letzter?.d ?? null,
  };
}

/**
 * Kennzeichen „Für Meldung irrelevant“ gesammelt setzen oder zurücknehmen (zurückgenommen = wieder offen).
 * Mitglieder mit ID-Nr. sind gemeldet – für sie lässt sich das Kennzeichen nicht setzen.
 */
export async function irrelevantSetzen(tx: Db, adrnrs: string[], irrelevant: boolean): Promise<string> {
  const ids = [...new Set(adrnrs)];
  const rows = await tx`select m.adrnr, m.vorname, m.nachname, a.id_nr from tco.mitglieder m left join tco.mitgliedera a on a.adrnr = m.adrnr where m.adrnr = any(${ids})`;
  if (rows.length !== ids.length) throw new BusinessError('Mindestens ein Mitglied wurde nicht gefunden – bitte die Liste aktualisieren.');
  const mitId = rows.filter((r) => leer(r.id_nr));
  if (irrelevant && mitId.length) {
    throw new BusinessError(`${condense(`${mitId[0].nachname}, ${mitId[0].vorname}`)}${mitId.length > 1 ? ` und ${mitId.length - 1} weitere` : ''}: Mitglieder mit ID-Nr. sind gemeldet und können nicht als „Für Meldung irrelevant“ gekennzeichnet werden.`);
  }
  for (const r of rows) {
    const wert = leer(r.id_nr) ? false : irrelevant ? true : null;
    await tx`insert into tco.mitgliedera (adrnr, meldung_irrelevant) values (${r.adrnr}, ${wert}) on conflict (adrnr) do update set meldung_irrelevant = excluded.meldung_irrelevant`;
  }
  return irrelevant ? `${rows.length} Mitglied${rows.length === 1 ? '' : 'er'} als „Für Meldung irrelevant“ gekennzeichnet.` : `Kennzeichen bei ${rows.length} Mitglied${rows.length === 1 ? '' : 'ern'} entfernt.`;
}
