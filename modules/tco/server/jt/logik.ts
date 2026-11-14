import { BusinessError } from '../../../../server/src/errors.js';
import { addTage, condense, heute, runden } from '../format.js';
import type { Db, Verein } from '../verein.js';
import { tcoSchnittstelle } from '../hinweise.js';
import { V_FERIEN, V_STUNDEN } from '../verbindung.js';

/**
 * Abrechnung Jugendtraining – Port von Z2UI5_CL_TCO_JUGEND_V3.
 * Trainingszeiten (tco.jrueckm) je Trainer und Tag als Dauer, Entgelte je Stunde
 * zeitabhängig (tco.trentgelt: Trainer + Gültig bis; „Gültig ab“ ergibt sich aus
 * dem vorherigen Satz desselben Trainers). Maßgeblich ist das Leistungsdatum.
 */

export const ARTEN = ['Jugendtraining', 'Schnuppertraining', 'Schul-AG', 'Betreuung Spieltage'] as const;
export const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
export const UNBEFRISTET = '9999-12-31';

export const monatsname = (monat: string) => `${MONATE[Number(monat.slice(4, 6)) - 1]} ${monat.slice(0, 4)}`;

export function grenzen(monat: string): { von: string; bis: string } {
  if (!/^\d{4}(0[1-9]|1[0-2])$/.test(monat)) throw new BusinessError('Ungültiger Monat');
  const von = `${monat.slice(0, 4)}-${monat.slice(4, 6)}-01`;
  const n = new Date(Date.UTC(Number(monat.slice(0, 4)), Number(monat.slice(4, 6)), 0));
  return { von, bis: n.toISOString().slice(0, 10) };
}

/** Name zum Abgleich: Großschreibung, ß → SS, Leerraum vereinheitlicht */
export const nameKey = (s: string | null | undefined) => condense((s ?? '').replace(/ß/g, 'ss').replace(/,/g, ' ')).toUpperCase();

// ---------------------------------------------------------------------------
// Entgelte
// ---------------------------------------------------------------------------

export interface Satz { adrnr: string; valid_to: string; betrag: number }
export type Saetze = Map<string, Satz[]>;

export async function saetzeLesen(db: Db): Promise<Saetze> {
  const rows = await db`select adrnr, to_char(valid_to, 'YYYY-MM-DD') as valid_to, betrag::float8 as betrag
                          from tco.trentgelt order by adrnr, valid_to`;
  const m: Saetze = new Map();
  for (const r of rows) {
    const l = m.get(r.adrnr) ?? [];
    l.push({ adrnr: r.adrnr, valid_to: r.valid_to, betrag: Number(r.betrag ?? 0) });
    m.set(r.adrnr, l);
  }
  return m;
}

/** Satz, der am Leistungsdatum galt (kleinstes Gültig-bis ≥ Datum) */
export function satzAm(s: Saetze, adrnr: string, datum: string): number {
  return s.get(adrnr)?.find((x) => x.valid_to >= datum)?.betrag ?? 0;
}

export interface Entgelt {
  adrnr: string; trainer: string; valid_from: string | null; valid_to: string; betrag: number;
  status: 'OLD' | 'CUR' | 'FUT'; status_txt: string; aktiv: boolean;
}

/** Entgelte mit abgeleitetem „Gültig ab“ und Status zum heutigen Tag */
export async function entgelteLesen(db: Db): Promise<Entgelt[]> {
  const s = await saetzeLesen(db);
  const trainer = new Map((await trainerLesen(db)).map((t) => [t.adrnr, t]));
  const namen = await namenLesen(db, [...s.keys()]);
  const h = heute();
  const out: Entgelt[] = [];
  for (const [adrnr, l] of s) {
    let prev: string | null = null;
    for (const x of l) {
      const from = prev && prev < UNBEFRISTET ? addTage(prev, 1) : null;
      let status: Entgelt['status'] = x.valid_to < h ? 'OLD' : from && from > h ? 'FUT' : 'CUR';
      let txt = status === 'OLD' ? 'abgelaufen' : status === 'FUT' ? 'künftig' : 'aktuell gültig';
      const aktiv = trainer.has(adrnr);
      if (!aktiv && status !== 'OLD') { status = 'OLD'; txt = 'Trainer inaktiv'; }
      out.push({ adrnr, trainer: namen.get(adrnr) ?? adrnr, valid_from: from, valid_to: x.valid_to, betrag: x.betrag, status, status_txt: txt, aktiv });
      prev = x.valid_to;
    }
  }
  return out.sort((a, b) => a.trainer.localeCompare(b.trainer, 'de') || a.valid_to.localeCompare(b.valid_to));
}

const betragOk = (b: number) => Number.isFinite(b) && b >= 0 && b <= 999;

/**
 * Neues Entgelt ab Stichtag: der Satz, der den Stichtag abdeckt, wird am Vortag
 * abgegrenzt, der neue Satz übernimmt dessen Gültig-bis. Beginnt der abdeckende
 * Satz genau am Stichtag, wird nur das Entgelt ersetzt. Ohne abdeckenden Satz
 * entsteht ein unbefristeter Satz.
 */
export async function entgeltNeu(tx: Db, adrnr: string, ab: string, betrag: number): Promise<string> {
  if (!betragOk(betrag)) throw new BusinessError('Bitte ein Entgelt zwischen 0 und 999 € je Stunde angeben.');
  const [t] = await tx`select 1 from tco.mitgliedera where adrnr = ${adrnr} and trainer`;
  if (!t) throw new BusinessError('Bitte einen aktiven Trainer wählen.');
  const l = (await saetzeLesen(tx)).get(adrnr) ?? [];
  const idx = l.findIndex((x) => x.valid_to >= ab);
  if (idx < 0) {
    await tx`insert into tco.trentgelt (adrnr, valid_to, betrag) values (${adrnr}, ${UNBEFRISTET}, ${betrag})
             on conflict (adrnr, valid_to) do update set betrag = excluded.betrag`;
    return `Entgelt ab ${ab.split('-').reverse().join('.')} unbefristet angelegt.`;
  }
  const c = l[idx];
  const from = idx > 0 && l[idx - 1].valid_to < UNBEFRISTET ? addTage(l[idx - 1].valid_to, 1) : null;
  if (from === ab) {
    await tx`update tco.trentgelt set betrag = ${betrag} where adrnr = ${adrnr} and valid_to = ${c.valid_to}`;
    return 'Entgelt ersetzt.';
  }
  const vortag = addTage(ab, -1);
  await tx`update tco.trentgelt set valid_to = ${vortag} where adrnr = ${adrnr} and valid_to = ${c.valid_to}`;
  await tx`insert into tco.trentgelt (adrnr, valid_to, betrag) values (${adrnr}, ${c.valid_to}, ${betrag})`;
  return `Bisheriges Entgelt bis ${vortag.split('-').reverse().join('.')} abgegrenzt, neues Entgelt ab ${ab.split('-').reverse().join('.')} angelegt.`;
}

export async function entgeltAendern(tx: Db, adrnr: string, validTo: string, neu: { valid_to: string; betrag: number }) {
  if (!betragOk(neu.betrag)) throw new BusinessError('Bitte ein Entgelt zwischen 0 und 999 € je Stunde angeben.');
  if (neu.valid_to !== validTo) {
    const [d] = await tx`select 1 from tco.trentgelt where adrnr = ${adrnr} and valid_to = ${neu.valid_to}`;
    if (d) throw new BusinessError(`Für diesen Trainer gibt es bereits einen Satz bis ${neu.valid_to.split('-').reverse().join('.')}.`);
  }
  const r = await tx`update tco.trentgelt set valid_to = ${neu.valid_to}, betrag = ${neu.betrag}
                      where adrnr = ${adrnr} and valid_to = ${validTo}`;
  if (!r.count) throw new BusinessError('Satz nicht gefunden – bitte neu laden.');
}

export async function entgeltLoeschen(tx: Db, adrnr: string, validTo: string) {
  await tx`delete from tco.trentgelt where adrnr = ${adrnr} and valid_to = ${validTo}`;
}

// ---------------------------------------------------------------------------
// Trainer
// ---------------------------------------------------------------------------

export interface Trainer {
  adrnr: string; name: string; vorname: string; nachname: string; steuernummer: string; satz: number | null;
  /** zugeordneter Portal-Benutzer für „Meine Trainingszeiten“ */
  benutzer_id: string | null; benutzer: string | null;
}

export async function namenLesen(db: Db, adrnrs: string[]): Promise<Map<string, string>> {
  if (!adrnrs.length) return new Map();
  const rows = await db`select adrnr, vorname, nachname from tco.mitglieder where adrnr = any(${adrnrs})`;
  const m = new Map<string, string>(rows.map((r) => [r.adrnr, condense(`${r.vorname ?? ''} ${r.nachname ?? ''}`) || r.adrnr]));
  // ohne Mitgliedssatz: Alias aus den Rückmeldungen
  const fehlt = adrnrs.filter((a) => !m.has(a));
  if (fehlt.length) {
    for (const r of await db`select distinct on (adrnr) adrnr, zalias from tco.jrueckm where adrnr = any(${fehlt}) order by adrnr, datum desc`) {
      m.set(r.adrnr, r.zalias);
    }
  }
  return m;
}

/** Personen mit Trainer-Kennzeichen, mit heute gültigem Satz */
export async function trainerLesen(db: Db): Promise<Trainer[]> {
  const rows = await db`
    select a.adrnr, coalesce(m.vorname, '') as vorname, coalesce(m.nachname, '') as nachname, coalesce(a.steuernummer, '') as steuernummer,
           (select e.betrag::float8 from tco.trentgelt e where e.adrnr = a.adrnr and e.valid_to >= current_date order by e.valid_to limit 1) as satz,
           a.benutzer_id::text as benutzer_id, u.display_name as benutzer
      from tco.mitgliedera a left join tco.mitglieder m on m.adrnr = a.adrnr left join core.users u on u.id = a.benutzer_id
     where a.trainer
     order by m.nachname, m.vorname`;
  return rows.map((r) => ({
    adrnr: r.adrnr, vorname: r.vorname, nachname: r.nachname, steuernummer: r.steuernummer,
    name: condense(`${r.vorname} ${r.nachname}`) || r.adrnr, satz: r.satz === null ? null : Number(r.satz),
    benutzer_id: r.benutzer_id ?? null, benutzer: r.benutzer ?? null,
  }));
}

/** Portal-Benutzer einem Trainer zuordnen (null = Zuordnung lösen); ein Benutzer gehört zu höchstens einem Trainer */
export async function trainerBenutzerSetzen(tx: Db, adrnr: string, benutzerId: string | null) {
  const [t] = await tx`select trainer from tco.mitgliedera where adrnr = ${adrnr}`;
  if (!t?.trainer) throw new BusinessError('Die Person ist nicht als Trainer gekennzeichnet.');
  if (benutzerId) {
    const [u] = await tx`select display_name from core.users where id = ${benutzerId}`;
    if (!u) throw new BusinessError('Benutzer nicht gefunden.');
    const [belegt] = await tx`select a.adrnr, m.vorname, m.nachname from tco.mitgliedera a left join tco.mitglieder m on m.adrnr = a.adrnr
                               where a.benutzer_id = ${benutzerId} and a.adrnr <> ${adrnr}`;
    if (belegt) throw new BusinessError(`Der Benutzer ${u.display_name} ist bereits ${condense(`${belegt.vorname ?? ''} ${belegt.nachname ?? ''}`)} zugeordnet.`);
  }
  await tx`update tco.mitgliedera set benutzer_id = ${benutzerId} where adrnr = ${adrnr}`;
}

/** Portal-Benutzer zur Auswahl in der Trainerpflege */
export async function benutzerAuswahl(db: Db): Promise<{ id: string; name: string; username: string }[]> {
  const rows = await db`select id::text as id, display_name, username from core.users where active order by display_name`;
  return rows.map((r) => ({ id: r.id, name: r.display_name, username: r.username }));
}

export async function trainerSetzen(tx: Db, adrnr: string, aktiv: boolean, steuernummer?: string | null) {
  const [m] = await tx`select 1 from tco.mitglieder where adrnr = ${adrnr}`;
  if (!m) throw new BusinessError('Mitglied nicht gefunden.');
  await tx`insert into tco.mitgliedera (adrnr, trainer, steuernummer) values (${adrnr}, ${aktiv}, ${steuernummer ?? null})
           on conflict (adrnr) do update set trainer = excluded.trainer,
             steuernummer = ${steuernummer === undefined ? tx`tco.mitgliedera.steuernummer` : tx`excluded.steuernummer`}`;
}

/** Mitglieder für die Trainerauswahl */
export async function mitgliederSuchen(db: Db): Promise<{ adrnr: string; name: string; trainer: boolean }[]> {
  const rows = await db`
    select m.adrnr, m.vorname, m.nachname, coalesce(a.trainer, false) as trainer
      from tco.mitglieder m left join tco.mitgliedera a on a.adrnr = m.adrnr
     where coalesce(m.austritt, '9999-12-31') >= current_date - 365
     order by m.nachname, m.vorname`;
  return rows.map((r) => ({ adrnr: r.adrnr, name: [r.nachname, r.vorname].filter(Boolean).join(', ') || r.adrnr, trainer: r.trainer }));
}

// ---------------------------------------------------------------------------
// Trainingszeiten
// ---------------------------------------------------------------------------

export interface Zeit { adrnr: string; datum: string; trainingsart: string; anzahl: number; zalias: string; satz: number; betrag: number }

export async function zeitenLesen(db: Db, monat: string, s?: Saetze): Promise<Zeit[]> {
  const { von, bis } = grenzen(monat);
  const saetze = s ?? await saetzeLesen(db);
  const rows = await db`select adrnr, to_char(datum, 'YYYY-MM-DD') as datum, trainingsart, coalesce(anzahl, 0)::float8 as anzahl, zalias
                          from tco.jrueckm where datum between ${von} and ${bis} order by datum, adrnr, trainingsart`;
  // gleiche Zeit unter verschiedenen Alias-Schreibweisen nur einmal
  const m = new Map<string, Zeit>();
  for (const r of rows) {
    const k = `${r.adrnr}|${r.datum}|${r.trainingsart}`;
    const satz = satzAm(saetze, r.adrnr, r.datum);
    const z = m.get(k);
    if (z) { z.anzahl = Math.max(z.anzahl, Number(r.anzahl)); z.betrag = runden(z.anzahl * satz); continue; }
    m.set(k, { adrnr: r.adrnr, datum: r.datum, trainingsart: r.trainingsart, anzahl: Number(r.anzahl), zalias: r.zalias, satz, betrag: runden(Number(r.anzahl) * satz) });
  }
  return [...m.values()];
}

function anzahlPruefen(a: number) {
  if (!Number.isFinite(a) || a < 0 || a > 24) throw new BusinessError('Die Dauer bitte in Stunden zwischen 0 und 24 angeben.');
  if (Math.round(a * 100) !== a * 100) throw new BusinessError('Die Dauer höchstens mit zwei Nachkommastellen angeben.');
}

async function trainerPruefen(db: Db, adrnr: string): Promise<string> {
  const n = (await namenLesen(db, [adrnr])).get(adrnr);
  if (!n) throw new BusinessError('Trainer nicht gefunden.');
  return n;
}

/** Zeit anlegen oder ändern (Schlüssel Trainer + Datum + Trainingsart) */
export async function zeitSetzen(tx: Db, d: { adrnr: string; datum: string; trainingsart: string; anzahl: number; altArt?: string | null }) {
  anzahlPruefen(d.anzahl);
  if (!(ARTEN as readonly string[]).includes(d.trainingsart)) throw new BusinessError('Unbekannte Trainingsart.');
  const name = await trainerPruefen(tx, d.adrnr);
  if (d.altArt && d.altArt !== d.trainingsart) {
    await tx`delete from tco.jrueckm where adrnr = ${d.adrnr} and datum = ${d.datum} and trainingsart = ${d.altArt}`;
  }
  const r = await tx`update tco.jrueckm set anzahl = ${d.anzahl}
                      where adrnr = ${d.adrnr} and datum = ${d.datum} and trainingsart = ${d.trainingsart}`;
  if (!r.count) {
    await tx`insert into tco.jrueckm (zalias, adrnr, datum, trainingsart, anzahl) values (${name}, ${d.adrnr}, ${d.datum}, ${d.trainingsart}, ${d.anzahl})`;
  }
}

export async function zeitLoeschen(tx: Db, adrnr: string, datum: string, trainingsart: string) {
  await tx`delete from tco.jrueckm where adrnr = ${adrnr} and datum = ${datum} and trainingsart = ${trainingsart}`;
}

/** ISO-Wochentag 1 = Montag … 7 = Sonntag */
export const isoWtag = (iso: string) => ((new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;

/** Trainingstage für die gewählten Wochentage des Monats anlegen (ohne Dauer) */
export async function tageGenerieren(tx: Db, adrnr: string, monat: string, wochentage: number[], art: string): Promise<number> {
  if (!wochentage.length) throw new BusinessError('Bitte zuerst Wochentage wählen.');
  const name = await trainerPruefen(tx, adrnr);
  const { von, bis } = grenzen(monat);
  let n = 0;
  for (let d = von; d <= bis; d = addTage(d, 1)) {
    if (!wochentage.includes(isoWtag(d))) continue;
    const [x] = await tx`select 1 from tco.jrueckm where adrnr = ${adrnr} and datum = ${d}`;
    if (x) continue;
    await tx`insert into tco.jrueckm (zalias, adrnr, datum, trainingsart, anzahl) values (${name}, ${adrnr}, ${d}, ${art}, 0)`;
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Import der Rückmeldungen (Nextcloud Forms, CSV oder über n8n)
// ---------------------------------------------------------------------------

export interface ImportZeile { datum: string; trainer: string; anzahl: string; ergebnis: string; state: 'Positive' | 'Critical' | 'Negative' | 'None' }

/** Mitglied zum Namen „Vorname Nachname“ (auch „Nachname Vorname“), Trainer bevorzugt */
async function adrnrZuName(db: Db, name: string): Promise<string | null> {
  const k = nameKey(name);
  if (!k) return null;
  const rows = await db`
    select m.adrnr, coalesce(a.trainer, false) as trainer
      from tco.mitglieder m left join tco.mitgliedera a on a.adrnr = m.adrnr
     where upper(replace(trim(coalesce(m.vorname, '') || ' ' || coalesce(m.nachname, '')), 'ß', 'ss')) = ${k}
        or upper(replace(trim(coalesce(m.nachname, '') || ' ' || coalesce(m.vorname, '')), 'ß', 'ss')) = ${k}
     order by 2 desc, m.adrnr`;
  if (rows[0]) return rows[0].adrnr;
  const [z] = await db`select adrnr from tco.jrueckm where upper(replace(zalias, 'ß', 'ss')) = ${k} order by datum desc limit 1`;
  return z?.adrnr ?? null;
}

/**
 * CSV wie der Nextcloud-Export: Spalte 4 TrainerIn, 5 Datum (ISO), 6 Stunden.
 * Übernommen wird nur, was in den Monat fällt, einem Mitglied zugeordnet werden
 * kann und noch nicht vorhanden ist (Trainer + Datum).
 */
export async function importieren(tx: Db, monat: string, csv: string, ferien: Map<string, string>) {
  const { von, bis } = grenzen(monat);
  const zeilen = csv.replace(/^﻿/, '').replace(/\r/g, '').replace(/"/g, '').split('\n');
  const prot: ImportZeile[] = [];
  let ok = 0, dup = 0, err = 0, fer = 0, aussen = 0;
  const neu = new Set<string>();
  for (const z of zeilen.slice(1)) {
    if (!z.trim()) continue;
    const c = z.split(',');
    if (c.length < 6) continue;
    const name = condense(c[3]);
    const iso = c[4].trim();
    const anz = c[5].trim();
    const datum = /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : '';
    if (datum && (datum < von || datum > bis)) { aussen++; continue; }
    const p: ImportZeile = { datum, trainer: name, anzahl: anz, ergebnis: '', state: 'None' };
    prot.push(p);
    if (!datum) { p.ergebnis = 'Datum nicht lesbar'; p.state = 'Negative'; err++; continue; }
    const std = Number(anz.replace(/\s*(std\.?|stunden|h)$/i, '').replace(',', '.'));
    if (!Number.isFinite(std) || std < 0 || std > 24) { p.ergebnis = 'Stunden nicht lesbar'; p.state = 'Negative'; err++; continue; }
    const adrnr = await adrnrZuName(tx, name);
    if (!adrnr) { p.ergebnis = 'Kein Mitglied gefunden'; p.state = 'Negative'; err++; continue; }
    const [x] = await tx`select 1 from tco.jrueckm where adrnr = ${adrnr} and datum = ${datum}`;
    if (x || neu.has(`${adrnr}|${datum}`)) { p.ergebnis = 'Bereits vorhanden'; dup++; continue; }
    await tx`insert into tco.jrueckm (zalias, adrnr, datum, trainingsart, anzahl) values (${name}, ${adrnr}, ${datum}, 'Jugendtraining', ${std})`;
    neu.add(`${adrnr}|${datum}`);
    ok++;
    const f = ferien.get(datum);
    if (f) { p.ergebnis = `Übernommen – liegt in den ${f}`; p.state = 'Critical'; fer++; } else { p.ergebnis = 'Übernommen'; p.state = 'Positive'; }
  }
  let text = `${prot.length} Zeilen für ${monatsname(monat)} gelesen: ${ok} übernommen (davon ${fer} in den Schulferien), ${dup} bereits vorhanden, ${err} ohne Zuordnung.`;
  if (aussen) text += ` ${aussen} Rückmeldung(en) anderer Monate nicht geladen.`;
  const state = err ? 'Negative' : dup || fer ? 'Critical' : 'Positive';
  return { prot, text, state, ok };
}

function authHeader(v: Verein, welche: 'stunden' | 'ferien'): Record<string, string> {
  const a = (welche === 'ferien' ? v.n8n_ferien_auth : v.n8n_stunden_auth)?.trim();
  return a ? { Authorization: a } : {};
}

async function n8nGet(url: string, v: Verein, was: string, welche: 'stunden' | 'ferien' = 'stunden'): Promise<Response> {
  try {
    return await fetch(url, { headers: authHeader(v, welche), signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new BusinessError(`${was}: n8n nicht erreichbar (${(e as Error).message})`);
  }
}

/** Rückmeldungen über den n8n-Webhook TCO_N8N_STUNDEN (CSV oder JSON) */
export async function rueckmeldungenAbrufen(v: Verein): Promise<{ csv: string; ungueltig: number }> {
  if (!v.n8n_stunden_url) throw new BusinessError('Der Webhook für die Rückmeldungen ist nicht eingerichtet (Administration → Schnittstellen → Anbindungen).');
  // Abruf überwacht (#232, V1): Scheitert er, steht die Störung im Arbeitsvorrat, bis der nächste Abruf klappt
  const stundenUrl = v.n8n_stunden_url;
  const res = await tcoSchnittstelle(V_STUNDEN, 'Rückmeldungen Jugendtraining (n8n)', async () => {
    const u = new URL(stundenUrl);
    u.searchParams.set('format', 'csv');
    const r = await n8nGet(u.toString(), v, 'Nextcloud');
    if (r.status === 401 || r.status === 403) throw new BusinessError('Anmeldung am n8n-Webhook abgelehnt – Authorization in den Stammdaten prüfen.');
    if (r.status === 404) throw new BusinessError('n8n-Webhook nicht gefunden – ist der Workflow aktiv?');
    if (!r.ok) throw new BusinessError(`n8n antwortet mit HTTP ${r.status}.`);
    return r;
  });
  const t = (await res.text()).replace(/\r/g, '');
  const hdr = Number(res.headers.get('x-tco-ungueltig') ?? 0) || 0;
  if (!/^\s*\{/.test(t)) return { csv: t, ungueltig: hdr };
  let j: { rueckmeldungen?: Record<string, unknown>[] };
  try { j = JSON.parse(t); } catch { throw new BusinessError('Antwort von n8n nicht lesbar.'); }
  if (!Array.isArray(j.rueckmeldungen)) throw new BusinessError('Antwort von n8n enthält kein Feld "rueckmeldungen".');
  const lines = ['User ID,User display name,Timestamp,TrainerIn,Datum,Stunden'];
  let ungueltig = 0;
  for (const r of j.rueckmeldungen) {
    let id = '', ts = '', trainer = '', datum = '', std = '';
    for (const [k0, v0] of Object.entries(r)) {
      const k = k0.toUpperCase();
      const val = String(v0 ?? '');
      if (k === 'SUBMISSIONID') id = val;
      else if (k === 'EINGEREICHT') ts = val;
      else if (k === 'STUNDENROH' || k === 'GUELTIG') continue;
      else if (k.includes('STUNDEN')) std = val;
      else if (k === 'DATUM' || k.includes('TAG')) datum = val;
      else if (k.includes('TRAINER')) trainer = val;
    }
    std = std.trim().replace(',', '.').replace(/\s*(std\.?|stunden|h)$/i, '');
    datum = datum.trim();
    trainer = condense(trainer.replace(/,/g, ' '));
    if (/^\d+(\.\d+)?$/.test(std) && /^\d{4}-\d{2}-\d{2}$/.test(datum) && trainer) {
      lines.push(`${id},,${ts.replace(/,/g, ' ')},${trainer},${datum},${std}`);
    } else ungueltig++;
  }
  return { csv: lines.join('\n'), ungueltig };
}

// ---------------------------------------------------------------------------
// Schulferien und Feiertage Saarland (n8n-Webhook ferien-saarland)
// ---------------------------------------------------------------------------

export interface Ferientag { datum: string; ferien: string | null; feiertag: string | null }

export async function ferienLesen(db: Db, jahr: number): Promise<Ferientag[]> {
  const r = await db`select to_char(datum, 'YYYY-MM-DD') as datum, ferien, feiertag from tco.ferien where jahr = ${jahr} order by datum`;
  return r.map((x) => ({ datum: x.datum, ferien: x.ferien || null, feiertag: x.feiertag || null }));
}

/** Ferien und Feiertage eines Jahres über n8n laden und speichern (je Jahr ersetzt) */
export async function ferienSynchronisieren(tx: Db, v: Verein, jahr: number, benutzer: string): Promise<{ ferien: number; feiertage: number }> {
  if (!v.n8n_ferien_url) throw new BusinessError('Der Webhook für die Schulferien ist nicht eingerichtet (Administration → Schnittstellen → Anbindungen).');
  // Abruf überwacht (#232, V1) – außerhalb der Transaktion gemeldet, damit die Störung auch bei Abbruch stehen bleibt
  const ferienUrl = v.n8n_ferien_url;
  const j = await tcoSchnittstelle(V_FERIEN, 'Schulferien Saarland (n8n)', async () => {
    const u = new URL(ferienUrl);
    u.searchParams.set('jahr', String(jahr));
    const res = await n8nGet(u.toString(), v, 'Schulferien', 'ferien');
    let x: { fehler?: string; ferientage?: { datum: string; ferien: string }[]; feiertage?: { datum: string; name: string }[] };
    try { x = await res.json(); } catch { throw new BusinessError('Ferien-Antwort nicht lesbar.'); }
    if (!res.ok) throw new BusinessError(x?.fehler || `Ferien-Webhook antwortet mit HTTP ${res.status}.`);
    return x;
  });
  const tage = new Map<string, Ferientag>();
  for (const f of j.ferientage ?? []) {
    const d = String(f.datum ?? '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) tage.set(d, { datum: d, ferien: f.ferien || 'Schulferien', feiertag: null });
  }
  for (const f of j.feiertage ?? []) {
    const d = String(f.datum ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const t = tage.get(d) ?? { datum: d, ferien: null, feiertag: null };
    t.feiertag = f.name || 'Feiertag';
    tage.set(d, t);
  }
  if (!tage.size) throw new BusinessError(`n8n lieferte keine Ferientage für ${jahr}.`);
  await tx`delete from tco.ferien where jahr = ${jahr}`;
  for (const t of tage.values()) {
    await tx`insert into tco.ferien (datum, jahr, ferien, feiertag, geladen_am, geladen_von)
             values (${t.datum}, ${Number(t.datum.slice(0, 4))}, ${t.ferien}, ${t.feiertag}, now(), ${benutzer})`;
  }
  const arr = [...tage.values()];
  return { ferien: arr.filter((t) => t.ferien).length, feiertage: arr.filter((t) => t.feiertag).length };
}

// ---------------------------------------------------------------------------
// Abrechnung je Trainer und Monat
// ---------------------------------------------------------------------------

export interface Doku {
  adrnr: string; monat: string; belegnr: string | null; doc_id: number | null; erstellt_am: string | null; bezahlt_am: string | null;
  stunden: number; betrag: number; bezahlt_betrag: number;
  /** Freigabe durch den Trainer (YYYY-MM-DD HH:MI, Europe/Berlin) */
  freigegeben_am: string | null; freigegeben_von: string | null;
  /** Trainer bittet um Öffnung des freigegebenen Monats */
  oeffnung_angefragt_am: string | null; oeffnung_grund: string | null;
}

export async function dokuLesen(db: Db, adrnr: string, monat: string): Promise<Doku | null> {
  const [d] = await db`select adrnr, monat, belegnr, doc_id, to_char(erstellt_am, 'YYYY-MM-DD') as erstellt_am,
                              to_char(bezahlt_am, 'YYYY-MM-DD') as bezahlt_am, coalesce(stunden, 0)::float8 as stunden,
                              coalesce(betrag, 0)::float8 as betrag, coalesce(bezahlt_betrag, 0)::float8 as bezahlt_betrag,
                              to_char(freigegeben_am at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as freigegeben_am, freigegeben_von,
                              to_char(oeffnung_angefragt_am at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as oeffnung_angefragt_am, oeffnung_grund
                         from tco.jt_doku where adrnr = ${adrnr} and monat = ${monat}`;
  return (d as unknown as Doku) ?? null;
}

/** bisher gezahlter Betrag (Altbestand ohne Betrag: Nachweisbetrag bzw. aktueller Betrag) */
export function gezahlt(d: Doku | null, aktuell = 0): number {
  if (!d) return 0;
  if (d.bezahlt_betrag > 0) return d.bezahlt_betrag;
  if (!d.bezahlt_am) return 0;
  return d.betrag > 0 ? d.betrag : aktuell;
}
export const istBezahlt = (d: Doku | null, aktuell = 0) => !!d?.bezahlt_am && gezahlt(d, aktuell) >= (d.betrag || aktuell);

export interface AbrZeile {
  adrnr: string; trainer: string; stunden: number; betrag: number; satz: number | null;
  status: string; state: 'None' | 'Positive' | 'Critical' | 'Information'; doc_id: number | null; belegnr: string | null;
  bezahlt_am: string | null; bezahlbar: boolean; mobil: boolean;
  /** vom Trainer freigegeben (YYYY-MM-DD HH:MI) */
  freigegeben_am: string | null; freigegeben_von: string | null;
  /** Trainer bittet um Öffnung */
  oeffnung_angefragt_am: string | null; oeffnung_grund: string | null;
}

const datumDe = (s: string) => s.slice(0, 10).split('-').reverse().join('.');

export async function abrechnung(db: Db, monat: string, zeiten: Zeit[], trainer: Trainer[]): Promise<AbrZeile[]> {
  const jm = `${monat.slice(0, 4)}_${monat.slice(4, 6)}`;
  const ids = new Set([...trainer.map((t) => t.adrnr), ...zeiten.map((z) => z.adrnr)]);
  const namen = await namenLesen(db, [...ids]);
  const docs = new Map((await db`select adrnr from tco.jt_doku where monat = ${monat}`).map((r) => [r.adrnr, true]));
  const mobil = new Map((await db`select adrnr, telefon6 from tco.mitglieder where adrnr = any(${[...ids]})`).map((r) => [r.adrnr, !!(r.telefon6 ?? '').trim()]));
  const out: AbrZeile[] = [];
  for (const adrnr of ids) {
    const z = zeiten.filter((x) => x.adrnr === adrnr);
    const std = runden(z.reduce((s, x) => s + x.anzahl, 0));
    const eur = runden(z.reduce((s, x) => s + x.betrag, 0));
    const d = docs.has(adrnr) ? await dokuLesen(db, adrnr, monat) : null;
    // Altbestand (bezahlt, ohne Stunden/Betrag) wie in SAP mit dem aktuellen Stand ergänzen
    if (d && d.doc_id && d.bezahlt_am && !d.betrag && !d.bezahlt_betrag && eur > 0) { d.stunden = std; d.betrag = eur; d.bezahlt_betrag = eur; }
    const t = trainer.find((x) => x.adrnr === adrnr);
    const r: AbrZeile = {
      adrnr, trainer: t?.name ?? namen.get(adrnr) ?? adrnr, stunden: std, betrag: eur, satz: t?.satz ?? null,
      status: std > 0 ? 'Nicht gedruckt' : 'Keine Stunden', state: std > 0 ? 'Critical' : 'None',
      doc_id: d?.doc_id ?? null, belegnr: d?.belegnr ?? null, bezahlt_am: null, bezahlbar: std > 0, mobil: mobil.get(adrnr) ?? false, freigegeben_am: d?.freigegeben_am ?? null, freigegeben_von: d?.freigegeben_von ?? null,
      oeffnung_angefragt_am: d?.oeffnung_angefragt_am ?? null, oeffnung_grund: d?.oeffnung_grund ?? null,
    };
    if (d?.doc_id) {
      const diff = runden(std - d.stunden);
      const gez = gezahlt(d, eur);
      r.status = `${jm} abgelegt`; r.state = 'Positive';
      if (d.stunden > 0 && diff !== 0) {
        r.status = `${jm} Nachmeldung ${diff > 0 ? '+' : ''}${diff.toLocaleString('de-DE')} Std. – bitte neu drucken`; r.state = 'Critical';
      } else if (istBezahlt(d, eur)) {
        r.status = `${jm} abgelegt, bezahlt am ${d.bezahlt_am!.split('-').reverse().join('.')}`;
      } else if (d.freigegeben_am && gez === 0 && d.oeffnung_angefragt_am) {
        r.status = `${jm} freigegeben – Trainer bittet um Öffnung`; r.state = 'Critical';
      } else if (d.freigegeben_am && gez === 0) {
        r.status = `${jm} freigegeben am ${datumDe(d.freigegeben_am)} – zur Zahlung`; r.state = 'Information';
      } else if (gez > 0) {
        r.status = `${jm} wiedereröffnet, offen ${runden(d.betrag - gez).toLocaleString('de-DE', { minimumFractionDigits: 2 })} €`; r.state = 'Critical';
      }
      r.status += ` · DOKID ${String(d.doc_id).padStart(6, '0')}`;
      if (istBezahlt(d, eur)) { r.bezahlt_am = d.bezahlt_am; r.bezahlbar = false; }
    }
    if (!t && !std && !d) continue;
    out.push(r);
  }
  return out.sort((a, b) => a.trainer.localeCompare(b.trainer, 'de'));
}
