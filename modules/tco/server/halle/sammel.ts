import { BusinessError } from '../../../../server/src/errors.js';
import { paperless, plAktiv, type Db, type Verein } from '../verein.js';
import { condense } from '../format.js';
import { adrnrAusZuid } from '../kommunikation.js';
import { kopfLesen, manuellePosition, rechnungAnlegen, rgAenderbar } from './daten.js';

/**
 * Rechnungen ohne Hallenbuchung (z. B. „Teilnahme Winterhallenrunde“): eine Position für viele Personen,
 * je Person eine Rechnung. Personen sind Mitglieder oder Kunden (EP3 bzw. im Portal angelegt, ab 90.000.000).
 * Namen lassen sich als Text einfügen oder aus einem Bild (Zwischenablage) per Paperless-OCR lesen und werden
 * gegen Mitglieder und Kunden abgeglichen – die Entscheidung trifft der Benutzer.
 */

export interface Kandidat { key: string; art: 'M' | 'K'; name: string; kunde: string; adrnr: string; info: string; vorname: string; nachname: string }

const norm = (s: string) => s.toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 -]+/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s: string) => norm(s).split(/[ -]/).filter((t) => t.length > 1);

/** Levenshtein-Abstand (für Tippfehler aus der Texterkennung) */
export function abstand(a: string, b: string): number {
  if (a === b) return 0;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}
const gleich = (a: string, b: string) => a === b || (a.length >= 5 && b.length >= 5 && abstand(a, b) <= 1);

/** Mitglieder (ohne lange Ausgetretene) und Kunden ohne Mitgliedschaft */
export async function kandidaten(db: Db): Promise<Kandidat[]> {
  const m = await db`select adrnr, vorname, nachname, ort, austritt::text as austritt from tco.mitglieder
                      where austritt is null or austritt >= current_date - interval '2 years' order by nachname, vorname`;
  const k = await db`select distinct on (zuid) zuid, vorname, nachname, wohnort, email from tco.kunden
                      where zuid not in (select zuid from tco.mitgliedera where zuid is not null) and coalesce(status, '') not in ('deleted')
                      order by zuid, zalias`;
  const name = (v: string | null, n: string | null) => condense(`${v ?? ''} ${n ?? ''}`);
  return [
    ...m.map((x) => ({
      key: `M:${x.adrnr}`, art: 'M' as const, adrnr: x.adrnr, name: name(x.vorname, x.nachname), kunde: name(x.vorname, x.nachname).toUpperCase(),
      vorname: x.vorname ?? '', nachname: x.nachname ?? '',
      info: `Mitglied${x.ort ? ` · ${x.ort}` : ''}${x.austritt ? ' · ausgetreten' : ''}`,
    })),
    ...k.filter((x) => name(x.vorname, x.nachname)).map((x) => ({
      key: `K:${x.zuid}`, art: 'K' as const, adrnr: adrnrAusZuid(x.zuid), name: name(x.vorname, x.nachname), kunde: name(x.vorname, x.nachname).toUpperCase(),
      vorname: x.vorname ?? '', nachname: x.nachname ?? '',
      info: `${Number(x.zuid) >= 90_000_000 ? 'Kunde (Portal)' : 'EP3-Kunde'}${x.wohnort ? ` · ${x.wohnort}` : x.email ? ` · ${x.email}` : ''}`,
    })),
  ];
}

export interface Treffer { zeile: string; vorschlaege: (Kandidat & { punkte: number })[]; vorname: string; nachname: string }

/**
 * Rohtext (eingefügt oder aus der Texterkennung) in Namenszeilen zerlegen. Typische Aufstellungen wie
 * „1  Gross, Alexander (1, LK5,3)“ (nuLiga/Meldeliste): Rang vorne, Klammerzusätze (Position, LK) und
 * LK-Angaben werden entfernt. Enthalten mehrere Zeilen „Nachname, Vorname“, gelten Zeilen ohne Komma
 * als Überschrift (z. B. „TC Oberthal 1“) und werden übergangen.
 */
export function zeilenBereinigen(text: string): string[] {
  const roh = text.split(/\r?\n|;/)
    .map((z) => condense(z
      .replace(/\([^)]*\)?|\[[^\]]*\]?/g, ' ')                   // (1, LK5,3) bzw. abgeschnittene Klammer aus der OCR
      .replace(/\bLK\s*\d+(?:[.,]\d+)?\b/gi, ' ')                  // LK-Angaben ohne Klammer
      .replace(/^[\s\d.)\-•*|:]+/, '')                             // Rang/Aufzählung vorne
      .replace(/[\s\d.,|:]+$/, '')))                                // Reste hinten
    .filter((z) => tokens(z).length >= 1 && /[a-zäöüß]/i.test(z));
  const mitKomma = roh.filter((z) => /^[^,]+,\s*\S/.test(z));
  return mitKomma.length >= 2 ? mitKomma : roh;
}

/** Zeilen (eine Person je Zeile) gegen Mitglieder/Kunden abgleichen – beste Vorschläge zuerst */
export function namenAbgleichen(text: string, liste: Kandidat[]): Treffer[] {
  const zeilen = zeilenBereinigen(text);
  const vorbereitet = liste.map((k) => ({ k, vn: tokens(k.vorname), nn: tokens(k.nachname) }));
  const out: Treffer[] = [];
  const gesehen = new Set<string>();
  for (const zeile of zeilen) {
    // „Nachname, Vorname“ → „Vorname Nachname“
    const z = zeile.includes(',') ? zeile.split(',').map((t) => t.trim()).reverse().join(' ') : zeile;
    const t = tokens(z);
    if (!t.length || gesehen.has(t.join(' '))) continue;
    gesehen.add(t.join(' '));
    const bewertet = vorbereitet.map(({ k, vn, nn }) => {
      const nachnameOk = nn.length > 0 && nn.every((x) => t.some((y) => gleich(x, y)));
      const vornameOk = vn.length > 0 && vn.some((x) => t.some((y) => gleich(x, y)));
      const initial = vn.length > 0 && t.some((y) => y.length === 1 || y[0] === vn[0][0]);
      let punkte = 0;
      if (nachnameOk && vornameOk) punkte = t.length === vn.length + nn.length ? 100 : 90;
      else if (nachnameOk && initial) punkte = 70;
      else if (nachnameOk) punkte = 50;
      else if (vornameOk && t.length === 1) punkte = 20;
      return { ...k, punkte };
    }).filter((x) => x.punkte >= 50).sort((a, b) => b.punkte - a.punkte || (a.art === 'M' ? -1 : 1) || a.name.localeCompare(b.name, 'de'));
    const teile = z.split(' ');
    out.push({ zeile, vorschlaege: bewertet.slice(0, 5), vorname: teile.length > 1 ? teile.slice(0, -1).join(' ') : '', nachname: teile[teile.length - 1] ?? '' });
  }
  return out;
}

export const BELEG_TITEL = 'Sammelrechnung Namensliste';

/**
 * Bild (z. B. Screenshot einer Mannschaftsaufstellung) in Paperless ablegen und den erkannten Text lesen.
 * Das Dokument bleibt erhalten (DOKID), damit es erneut gelesen und mit den Rechnungspositionen verknüpft
 * werden kann; wird die Sammelrechnung verworfen, löscht der Dialog es wieder (belegVerwerfen).
 */
export async function bildLesen(v: Verein, bild: Buffer, mime: string): Promise<{ text: string; docId: number }> {
  if (!plAktiv(v)) throw new BusinessError('Für die Texterkennung aus Bildern wird Paperless benötigt (Administration → Schnittstellen).');
  if (!/^image\/(png|jpe?g|webp|gif|tiff)$/.test(mime)) throw new BusinessError('Bitte ein Bild (PNG, JPG, WEBP, GIF, TIFF) einfügen.');
  const pl = paperless(v);
  const endung = mime.split('/')[1].replace('jpeg', 'jpg');
  const jetzt = new Date();
  const titel = `${BELEG_TITEL} ${jetzt.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })} ${jetzt.toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' })}`;
  const task = await pl.upload(bild, `sammelrechnung-${jetzt.getTime()}.${endung}`, { title: titel, mime });
  const id = await pl.warteAufDokument(task, 60, 1000);
  if (!id) throw new BusinessError('Die Texterkennung dauert zu lange – bitte in einer Minute die DOKID des Belegs eingeben und „Lesen“ wählen.');
  const d = await pl.dokument(id);
  return { text: String(d.content ?? ''), docId: id };
}

/** vorhandenen Paperless-Beleg (DOKID) erneut lesen – Text der Texterkennung */
export async function belegLesen(v: Verein, id: number): Promise<{ text: string; titel: string; docId: number }> {
  if (!plAktiv(v)) throw new BusinessError('Paperless ist nicht eingerichtet (Administration → Schnittstellen).');
  const d = await paperless(v).dokument(id).catch(() => null);
  if (!d) throw new BusinessError(`Paperless-Dokument ${id} nicht gefunden.`, 404);
  const text = String(d.content ?? '');
  if (!text.trim()) throw new BusinessError(`Paperless-Dokument ${id} enthält (noch) keinen erkannten Text – die Texterkennung läuft eventuell noch.`);
  return { text, titel: String(d.title ?? ''), docId: id };
}

/** nicht verwendeten Beleg wieder löschen – nur eigene Namenslisten, die noch an keiner Position hängen */
export async function belegVerwerfen(db: Db, v: Verein, id: number) {
  if (!plAktiv(v)) return;
  const [verknuepft] = await db`select 1 from tco.rgpos where beleg_doc_id = ${id} limit 1`;
  if (verknuepft) return;
  const pl = paperless(v);
  const d = await pl.dokument(id).catch(() => null);
  if (!d || !String(d.title ?? '').startsWith(BELEG_TITEL)) return;
  await pl.loeschen(id);
}

export interface Empfaenger { key?: string | null; neu?: { vorname: string; nachname: string; email?: string | null; strasse?: string | null; plz?: string | null; ort?: string | null } | null }

/** Kunde im Portal anlegen (ohne Benutzer) – Nummernkreis wie bei Registrierungen (ab 90.000.000) */
export async function kundeAnlegen(tx: Db, n: NonNullable<Empfaenger['neu']>): Promise<Kandidat> {
  const vorname = condense(n.vorname), nachname = condense(n.nachname);
  if (!nachname) throw new BusinessError('Für einen neuen Kunden bitte mindestens den Nachnamen angeben.');
  const [{ nr }] = await tx`select core.next_number('TCO_KUNDE', 0)::bigint as nr`;
  const zuid = String(90_000_000 + Number(nr));
  await tx`insert into tco.kunden (zuid, zalias, status, email, vorname, nachname, strasse, plz, wohnort)
           values (${zuid}, ${`portal-${zuid}`}, 'portal', ${n.email?.trim() || null}, ${vorname || null}, ${nachname},
                   ${n.strasse?.trim() || null}, ${n.plz?.trim() || null}, ${n.ort?.trim() || null})`;
  const name = condense(`${vorname} ${nachname}`);
  return { key: `K:${zuid}`, art: 'K', adrnr: adrnrAusZuid(zuid), name, kunde: name.toUpperCase(), vorname, nachname, info: 'Kunde (Portal)' };
}

export async function kandidatLesen(tx: Db, key: string): Promise<Kandidat> {
  const [art, id] = key.split(':');
  if (art === 'M') {
    const [m] = await tx`select adrnr, vorname, nachname from tco.mitglieder where adrnr = ${id}`;
    if (!m) throw new BusinessError(`Mitglied ${id} nicht gefunden.`);
    const name = condense(`${m.vorname ?? ''} ${m.nachname ?? ''}`);
    return { key, art: 'M', adrnr: m.adrnr, name, kunde: name.toUpperCase(), vorname: m.vorname ?? '', nachname: m.nachname ?? '', info: 'Mitglied' };
  }
  if (art === 'K') {
    const [k] = await tx`select zuid, vorname, nachname from tco.kunden where zuid = ${id} order by zalias limit 1`;
    if (!k) throw new BusinessError(`Kunde ${id} nicht gefunden.`);
    const name = condense(`${k.vorname ?? ''} ${k.nachname ?? ''}`);
    return { key, art: 'K', adrnr: adrnrAusZuid(k.zuid), name, kunde: name.toUpperCase(), vorname: k.vorname ?? '', nachname: k.nachname ?? '', info: 'Kunde' };
  }
  throw new BusinessError(`Ungültige Auswahl ${key}.`);
}

/**
 * Je Empfänger eine Rechnung mit der Position anlegen – oder an eine noch offene Rechnung
 * („In Bearbeitung“) derselben Person anhängen. Die Rechnung trägt die Adressnummer direkt.
 */
/** Rechnungen einer Person, denen eine Position zugeordnet werden könnte (änderbar) bzw. die schon existieren */
export interface PersonRechnung { rgnr: string; status: string; betrag: number; angelegt_am: string | null; versendet: string | null; aenderbar: boolean }

export async function rechnungenZuPersonen(db: Db, keys: string[]): Promise<Record<string, PersonRechnung[]>> {
  const out: Record<string, PersonRechnung[]> = {};
  for (const key of [...new Set(keys)].slice(0, 300)) {
    const k = await kandidatLesen(db, key).catch(() => null);
    if (!k) { out[key] = []; continue; }
    const rows = await db`select rgnr_txt, status, betrag::float8 as betrag, angelegt_am::text as angelegt_am, versendet::text as versendet
                            from tco.rgkopf
                           where (adrnr = ${k.adrnr} or (adrnr is null and upper(trim(kunde)) = ${k.kunde}))
                             and status not in ('4', '6')
                           order by rgnr_txt desc limit 20`;
    out[key] = rows.map((r) => ({
      rgnr: r.rgnr_txt as string, status: r.status as string, betrag: Number(r.betrag), angelegt_am: r.angelegt_am as string | null,
      versendet: r.versendet as string | null, aenderbar: rgAenderbar({ status: r.status as string, versendet: r.versendet as string | null }),
    }));
  }
  return out;
}

/**
 * Je Empfänger die Position anlegen – auf eine gewählte bestehende Rechnung der Person (`rgnr`),
 * auf eine neue Rechnung (`rgnr: 'NEU'`) oder (ohne Angabe) wie bisher je nach `anhaengen`.
 * `preis` je Empfänger überschreibt den Einzelpreis (Splitbuchung: Gesamtbetrag auf Personen verteilt).
 */
export async function sammelRechnungen(tx: Db, d: {
  empfaenger: (Empfaenger & { rgnr?: string | null; preis?: number | null })[];
  position: { prod_key: string; beschreibung?: string | null; menge: number; preis?: number | null }; anhaengen: boolean;
  belegDocId?: number | null;
}) {
  if (!d.empfaenger.length) throw new BusinessError('Bitte mindestens eine Person auswählen.');
  const ergebnis: { name: string; rgnr: string; neu: boolean; kundeNeu: boolean; betrag: number }[] = [];
  const doppelt = new Set<string>();
  for (const e of d.empfaenger) {
    const k = e.key ? await kandidatLesen(tx, e.key) : e.neu ? await kundeAnlegen(tx, e.neu) : null;
    if (!k) continue;
    if (doppelt.has(k.adrnr)) continue;
    doppelt.add(k.adrnr);
    let rgnr: string | null = null;
    if (e.rgnr && e.rgnr !== 'NEU') {
      // gewählte Rechnung muss zur Person gehören und noch Positionen aufnehmen
      const [r] = await tx`select rgnr_txt from tco.rgkopf where rgnr_txt = ${e.rgnr} and (adrnr = ${k.adrnr} or (adrnr is null and upper(trim(kunde)) = ${k.kunde}))`;
      if (!r) throw new BusinessError(`Rechnung ${e.rgnr} gehört nicht zu ${k.name}.`);
      if (!rgAenderbar(await kopfLesen(tx, e.rgnr))) throw new BusinessError(`Rechnung ${e.rgnr} (${k.name}) nimmt keine Positionen mehr auf.`);
      rgnr = e.rgnr;
      await tx`update tco.rgkopf set adrnr = ${k.adrnr} where rgnr_txt = ${rgnr} and adrnr is null`;
    } else if (!e.rgnr && d.anhaengen) {
      const [r] = await tx`select rgnr_txt from tco.rgkopf where adrnr = ${k.adrnr} and status = '1' order by rgnr_txt desc limit 1`;
      if (r && rgAenderbar(await kopfLesen(tx, r.rgnr_txt))) rgnr = r.rgnr_txt;
    }
    const neu = !rgnr;
    if (!rgnr) {
      rgnr = await rechnungAnlegen(tx, k.kunde);
      await tx`update tco.rgkopf set adrnr = ${k.adrnr} where rgnr_txt = ${rgnr}`;
    }
    const preisJe = e.preis ?? null;
    const p = await manuellePosition(tx, rgnr, preisJe !== null ? { ...d.position, preis: preisJe } : d.position, { preisVorgabe: preisJe !== null });
    if (d.belegDocId) await tx`update tco.rgpos set beleg_doc_id = ${d.belegDocId} where rgnr_txt = ${rgnr} and rgpos = ${p.rgpos}`;
    ergebnis.push({ name: k.name, rgnr, neu, kundeNeu: !e.key, betrag: p.betrag });
  }
  return ergebnis;
}
