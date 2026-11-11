import { BusinessError } from '../../../../server/src/errors.js';
import { csvParse, dekodieren, sapDatum, sapZeit } from '../../../../server/src/lib/sapcsv.js';
import type { Db, Verein } from '../verein.js';
import { dat, heute, nameSchoen, zeit } from '../format.js';
import { ep3BenutzerAnlegen } from '../platz/registrierung.js';
import { ep3EventsImportieren } from '../platz/belegungen.js';

/**
 * Import der EP3-Exporte (Buchungssystem ep3-bs): Buchungen, Kunden, Buchungstexte.
 * Port von IMPORT_CSV / CSV_TYP_ERMITTELN / ZCL_TCO_RECHNUNGEN=>BOOKINGS_IMPORTIEREN.
 */

export type Ep3Typ = 'BUCHUNGEN' | 'KUNDEN' | 'TEXTE' | 'EVENTS';

export function ep3Typ(kopf: string[]): Ep3Typ | null {
  const k = new Set(kopf.map((s) => s.trim().toUpperCase()));
  if (k.has('ZUID') && k.has('KEY')) return 'KUNDEN';
  if (k.has('EID') && k.has('DATETIME_START')) return 'EVENTS';
  if (k.has('BID') && k.has('DATUM')) return 'BUCHUNGEN';
  if (k.has('BID') && k.has('TEXT')) return 'TEXTE';
  return null;
}

/** BID im SAP-Format (10 Stellen, führende Nullen) – wie die aus SAP übernommenen Buchungen und Rechnungspositionen */
export const bidNorm = (b: string) => { const t = b.trim(); return /^\d{1,9}$/.test(t) ? t.padStart(10, '0') : t; };

/** Spalten mit dem gebuchten Platz im EP3-Export (Name bevorzugt, sonst Nummer) */
const PLATZ_SPALTEN = ['PLATZ', 'SQUARE', 'SQUARE_NAME', 'COURT', 'SNAME', 'SID'];

const STATUS: Record<string, string> = { single: '1', subscription: '3', cancelled: '2' };

/** Einzelne Änderungen für das Importprotokoll (neu angelegte Kunden, neu ergänzte Buchungen) */
export interface ImportDetail { art: 'Kunde neu' | 'Buchung neu'; text: string }
export interface ImportErgebnis {
  typ: Ep3Typ | null; text: string; ok: boolean; details?: ImportDetail[];
  /** EP3-Namen (Schlüssel der Personenliste) mit neu ergänzten Buchungen – vollständig, ohne Obergrenze */
  personenNeu?: string[];
}

/** Obergrenze je Protokoll, damit ein Erstimport das Protokoll nicht sprengt */
const MAX_DETAILS = 200;
function begrenzt(d: ImportDetail[], art: ImportDetail['art']): ImportDetail[] {
  if (d.length <= MAX_DETAILS) return d;
  return [...d.slice(0, MAX_DETAILS), { art, text: `… und ${d.length - MAX_DETAILS} weitere` }];
}

export async function ep3Importieren(tx: Db, inhalt: string | Buffer): Promise<ImportErgebnis> {
  const text = typeof inhalt === 'string' ? inhalt : dekodieren(inhalt);
  const rows = csvParse(text);
  if (rows.length < 1) return { typ: null, ok: false, text: 'Die Datei ist leer.' };
  const kopf = rows[0].map((s) => s.trim().toUpperCase());
  const typ = ep3Typ(kopf);
  const idx = (n: string) => kopf.indexOf(n);
  const daten = rows.slice(1);
  if (typ === 'KUNDEN') return kundenImportieren(tx, daten, idx);
  if (typ === 'TEXTE') return texteImportieren(tx, daten, idx);
  if (typ === 'EVENTS') {
    // Platz über Bezeichnung oder Alias (wie bei den Buchungen)
    const plaetze = await tx`select id, name, aliase from tco.plaetze`;
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toUpperCase();
    const map = new Map<string, number>();
    for (const p of plaetze) for (const n of [p.name, ...String(p.aliase ?? '').split(',')]) if (norm(n)) map.set(norm(n), p.id);
    return { typ: 'EVENTS', ok: true, text: await ep3EventsImportieren(tx, daten, idx, (n) => map.get(norm(n)) ?? null) };
  }
  if (typ === 'BUCHUNGEN') return buchungenImportieren(tx, daten, idx);
  return {
    typ: null, ok: false,
    text: `Die Datei konnte keiner Tabelle zugeordnet werden. Erwartet: EP3_BOOKINGS (BID, DATUM …), EP3_USER (ZUID, KEY, VALUE …), EP3_TEXTE (BID, TEXT) oder EP3_EVENTS (EID, DATETIME_START …). Erkannt wurden: ${kopf.join(', ')}`,
  };
}

async function kundenImportieren(tx: Db, rows: string[][], idx: (n: string) => number): Promise<ImportErgebnis> {
  const i = { zuid: idx('ZUID'), zalias: idx('ZALIAS'), status: idx('STATUS'), email: idx('EMAIL'), key: idx('KEY'), value: idx('VALUE') };
  // optional: Kennwort-Hash aus bs_users.pw (Spalte PW/ZPW/PASSWORD) – für die Übernahme ins Portal
  const iPw = ['PW', 'ZPW', 'PASSWORD', 'PASSWORT'].map(idx).find((x) => x >= 0) ?? -1;
  const kunden = new Map<string, Record<string, string>>();
  for (const r of rows) {
    const zuid = (r[i.zuid] ?? '').trim();
    if (!zuid) continue;
    const k = kunden.get(zuid) ?? { zuid, zalias: (r[i.zalias] ?? '').trim(), status: (r[i.status] ?? '').trim(), email: (r[i.email] ?? '').trim() };
    if (iPw >= 0 && /^\$2[abxy]?\$\d\d\$/.test((r[iPw] ?? '').trim())) k.pw_hash = (r[iPw] ?? '').trim();
    const key = (r[i.key] ?? '').trim().toLowerCase();
    const val = (r[i.value] ?? '').trim();
    const feld: Record<string, string> = { firstname: 'vorname', lastname: 'nachname', street: 'strasse', zip: 'plz', city: 'wohnort', phone: 'telefonnummer', gender: 'geschlecht' };
    if (feld[key]) k[feld[key]] = key === 'gender' ? (val === 'male' ? 'm' : val === 'female' ? 'w' : val.slice(0, 1)) : val;
    kunden.set(zuid, k);
  }
  const zuids = [...kunden.keys()];
  // Portalzuordnung und übernommene Kennwörter überleben den erneuten Import
  const bisher = new Map<string, { benutzer_id: string | null; pw_hash: string | null }>();
  const vorhanden = new Set<string>();
  if (zuids.length) {
    for (const r of await tx`select zuid from tco.kunden where zuid = any(${zuids})`) vorhanden.add(r.zuid as string);
    for (const b of await tx`select zuid, benutzer_id::text, pw_hash from tco.kunden where zuid = any(${zuids}) and (benutzer_id is not null or pw_hash is not null)`) {
      bisher.set(b.zuid, { benutzer_id: b.benutzer_id, pw_hash: b.pw_hash });
    }
    await tx`delete from tco.kunden where zuid = any(${zuids})`;
  }
  for (const k of kunden.values()) {
    const alt = bisher.get(k.zuid);
    await tx`insert into tco.kunden (zuid, zalias, status, email, vorname, nachname, strasse, plz, wohnort, telefonnummer, geschlecht, pw_hash, benutzer_id)
             values (${k.zuid}, ${k.zalias || k.zuid}, ${k.status || null}, ${k.email || null}, ${k.vorname ?? null}, ${k.nachname ?? null},
                     ${k.strasse ?? null}, ${k.plz ?? null}, ${k.wohnort ?? null}, ${k.telefonnummer ?? null}, ${k.geschlecht ?? null},
                     ${k.pw_hash ?? alt?.pw_hash ?? null}, ${alt?.benutzer_id ?? null})`;
  }
  const mitPw = [...kunden.values()].filter((k) => k.pw_hash).length;
  const neuKunden = [...kunden.values()].filter((k) => !vorhanden.has(k.zuid))
    .map((k) => ({ name: [k.vorname, k.nachname].filter(Boolean).join(' ') || k.zalias || k.zuid, k }))
    .sort((x, y) => x.name.localeCompare(y.name, 'de'))
    .map(({ name, k }): ImportDetail => ({ art: 'Kunde neu', text: `${name} (ZUID ${k.zuid}${k.email ? `, ${k.email}` : ''})` }));
  // Portalbenutzer für alle aktiven EP3-Kunden anlegen (Benutzername = E-Mail, Rolle Hallennutzer) und zuordnen
  const b = await ep3BenutzerAnlegen(tx, zuids);
  return {
    typ: 'KUNDEN', ok: true,
    details: begrenzt(neuKunden, 'Kunde neu'),
    text: `Kunden: ${rows.length} gelesen, ${kunden.size} übertragen, ${neuKunden.length} neu${mitPw ? `, ${mitPw} Kennwörter übernommen` : ''}`
      + (b.angelegt ? `, ${b.angelegt} Benutzer angelegt` : '') + (b.mitglieder ? ` (${b.mitglieder} Mitgliedern zugeordnet)` : '')
      + (b.ohneKennwort ? `, ${b.ohneKennwort} ohne Kennwort (Kennwort über die Benutzerpflege setzen)` : '')
      + (b.ohneBuchung ? `, ${b.ohneBuchung} ohne Buchung in den letzten 12 Monaten nicht übernommen` : ''),
  };
}

async function texteImportieren(tx: Db, rows: string[][], idx: (n: string) => number): Promise<ImportErgebnis> {
  const ib = idx('BID');
  const it = idx('TEXT');
  const texte = new Map<string, string>();
  for (const r of rows) {
    const bid = bidNorm(r[ib] ?? '');
    if (!bid || texte.has(bid)) continue;
    texte.set(bid, (r[it] ?? '').replace(/\s*\n\s*/g, ' ').trim());
  }
  for (const [bid, text] of texte) {
    await tx`insert into tco.bookingstxt (bid, text) values (${bid}, ${text})
             on conflict (bid) do update set text = excluded.text`;
  }
  return { typ: 'TEXTE', ok: true, text: `Buchungstexte: ${rows.length} gelesen, ${texte.size} übertragen` };
}

interface ImpBuchung { bid: string; datum: string; time_start: string | null; time_ende: string | null; kunde: string; text: string | null; status: string; preis: number | null; platz: string | null }

async function buchungenImportieren(tx: Db, rows: string[][], idx: (n: string) => number): Promise<ImportErgebnis> {
  const i = { bid: idx('BID'), datum: idx('DATUM'), von: idx('TIME_START'), bis: idx('TIME_ENDE'), kunde: idx('KUNDE'), text: idx('TEXT'), status: idx('STATUS'), preis: idx('PREIS'),
    platz: PLATZ_SPALTEN.map(idx).find((x) => x >= 0) ?? -1 };
  if (i.bid < 0 || i.datum < 0) throw new BusinessError('Spalten BID / DATUM nicht gefunden.');
  const liste: ImpBuchung[] = [];
  for (const r of rows) {
    const bid = bidNorm(r[i.bid] ?? '');
    let datum: string | null = null;
    try { datum = sapDatum((r[i.datum] ?? '').trim().split(/[ T]/)[0]); } catch { datum = null; }
    if (!bid || !datum) continue;
    const st = (r[i.status] ?? '').trim().toLowerCase();
    let von: string | null = null;
    let bis: string | null = null;
    try { von = i.von >= 0 ? sapZeit(r[i.von] ?? '') : null; bis = i.bis >= 0 ? sapZeit(r[i.bis] ?? '') : null; } catch { /* leer lassen */ }
    const pr = i.preis >= 0 ? Number(String(r[i.preis] ?? '').replace(',', '.')) : NaN;
    liste.push({
      bid, datum, time_start: von, time_ende: bis,
      kunde: (r[i.kunde] ?? '').trim().toUpperCase(),
      text: i.text >= 0 ? (r[i.text] ?? '').trim() || null : null,
      status: STATUS[st] ?? (/^\d$/.test(st) ? st : '0'),
      preis: Number.isFinite(pr) ? pr : null,
      platz: i.platz >= 0 ? (r[i.platz] ?? '').trim() || null : null,
    });
  }
  if (!liste.length) throw new BusinessError('Keine gültigen Buchungen in der Datei gefunden');

  const bids = [...new Set(liste.map((b) => b.bid))];
  const bestand = await tx`select bid, datum::text, assigned, erstellt::text, status from tco.bookings where bid = any(${bids})`;
  const key = (b: { bid: string; datum: string }) => `${b.bid}|${b.datum}`;
  const best = new Map(bestand.map((b) => [key(b as never), b]));
  const datVon = liste.reduce((m, b) => (b.datum < m ? b.datum : m), liste[0].datum);
  const datBis = liste.reduce((m, b) => (b.datum > m ? b.datum : m), liste[0].datum);
  // Abo-Serien, die bereits abgerechnet/irrelevant sind: neue Termine erben die Kennzeichnung
  // (verhindert die doppelte Abrechnung einer verlängerten Serie, Befund E6 in SAP)
  const abgerechnetJeBid = new Map<string, string>();
  for (const b of bestand) if ((b.assigned ?? '') !== '' && b.status === '3') abgerechnetJeBid.set(b.bid, b.assigned);
  const aboEinzel = new Set((await tx`select bid from tco.bookings_ch where bid = any(${bids}) and status_abw = '1'`).map((r) => r.bid as string));

  let neu = 0;
  const neuListe: ImpBuchung[] = [];
  let geaendert = 0;
  let abgerechnet = 0;
  let geerbt = 0;
  let repariert = 0;
  const h = heute();
  for (const b of liste) {
    const desc = `${dat(b.datum)} von ${zeit(b.time_start)} bis ${zeit(b.time_ende)} Uhr`;
    const alt = best.get(key(b));
    if (!alt) {
      const erbe = b.status === '3' && !aboEinzel.has(b.bid) ? abgerechnetJeBid.get(b.bid) ?? '' : '';
      if (erbe) geerbt++;
      await tx`insert into tco.bookings (bid, datum, time_start, time_ende, kunde, status, description, preis, erstellt, assigned, text, platz)
               values (${b.bid}, ${b.datum}, ${b.time_start}, ${b.time_ende}, ${b.kunde}, ${b.status}, ${desc}, ${b.preis}, ${h}, ${erbe}, ${b.text}, ${b.platz})`;
      neu++;
      neuListe.push(b);
      continue;
    }
    best.delete(key(b));
    if ((alt.assigned ?? '') !== '') {
      if (b.platz) await tx`update tco.bookings set platz = ${b.platz} where bid = ${b.bid} and datum = ${b.datum} and platz is distinct from ${b.platz}`;
      abgerechnet++;
      continue;
    }
    // Reparatur: offene Termine einer bereits abgerechneten Abo-Serie, die ein früherer Import angelegt hat
    // (z. B. Serie in EP3 auf einen anderen Wochentag verschoben – gleiche BID, neue Daten), erben die Kennzeichnung
    const erbeAlt = b.status === '3' && !aboEinzel.has(b.bid) ? abgerechnetJeBid.get(b.bid) ?? '' : '';
    if (erbeAlt) repariert++;
    await tx`update tco.bookings set time_start = ${b.time_start}, time_ende = ${b.time_ende}, kunde = ${b.kunde}, status = ${b.status},
                    description = ${desc}, preis = ${b.preis}, geaendert = ${h}, text = ${b.text}, platz = coalesce(${b.platz}, platz)
                    ${erbeAlt ? tx`, assigned = ${erbeAlt}` : tx``}
              where bid = ${b.bid} and datum = ${b.datum}`;
    geaendert++;
  }
  // im Buchungssystem entfallene offene Termine im Zeitraum der Datei
  let entfallen = 0;
  for (const alt of best.values()) {
    if ((alt.assigned ?? '') !== '' || alt.datum < datVon || alt.datum > datBis) continue;
    await tx`update tco.bookings set status = '4', geaendert = ${h} where bid = ${alt.bid} and datum = ${alt.datum}`;
    entfallen++;
  }
  let text = `Buchungen: ${liste.length} gelesen, ${neu} neu, ${geaendert} aktualisiert, ${abgerechnet} bereits abgerechnet`;
  if (entfallen) text += `, ${entfallen} entfallen`;
  if (geerbt) text += ` (${geerbt} neue Termine bereits abgerechneter Abos automatisch mitgesperrt)`;
  if (repariert) text += ` (${repariert} offene Termine bereits abgerechneter Abos nachträglich gesperrt)`;
  const details = neuListe
    .sort((a, b) => nameSchoen(a.kunde).localeCompare(nameSchoen(b.kunde), 'de') || a.datum.localeCompare(b.datum) || (a.time_start ?? '').localeCompare(b.time_start ?? ''))
    .map((b): ImportDetail => ({
      art: 'Buchung neu',
      text: `${nameSchoen(b.kunde) || 'ohne Namen'} – ${dat(b.datum)}, ${zeit(b.time_start)}–${zeit(b.time_ende)} Uhr`
        + `${b.platz ? `, ${b.platz}` : ''} (${b.status === '3' ? 'Abo' : 'Einzel'}, Buchung ${b.bid.replace(/^0+/, '')})`,
    }));
  return { typ: 'BUCHUNGEN', ok: true, text, details: begrenzt(details, 'Buchung neu'), personenNeu: [...new Set(neuListe.map((b) => b.kunde))] };
}

/**
 * Abgleich ohne Schreiben (#20): Buchungen, die in den letzten `tage` Tagen in EP3 angelegt wurden (Spalte ERSTELLT; ohne sie:
 * Buchungsdatum in diesem Zeitraum) und im Portal fehlen (BID + Datum). Stornierte EP3-Buchungen zählen nicht.
 * Es wird nur gelesen – keine Änderung an der Datenbank.
 */
export interface Ep3Abweichung { bid: string; datum: string; kunde: string; von: string | null; bis: string | null; platz: string | null; erstellt: string | null; art: 'Abo' | 'Einzel' }
export async function ep3Abgleich(db: Db, bookingsCsv: string | null | undefined, stichtag: string, tage = 5): Promise<{ geprueft: number; fehlend: Ep3Abweichung[]; ab: string; mitErstellt: boolean }> {
  const d = new Date(`${stichtag}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - tage);
  const ab = d.toISOString().slice(0, 10);
  const rows = bookingsCsv ? csvParse(bookingsCsv) : [];
  if (rows.length < 2) return { geprueft: 0, fehlend: [], ab, mitErstellt: false };
  const kopf = rows[0].map((x) => x.trim().toUpperCase());
  const idx = (n: string) => kopf.indexOf(n);
  const i = { bid: idx('BID'), datum: idx('DATUM'), von: idx('TIME_START'), bis: idx('TIME_ENDE'), kunde: idx('KUNDE'), status: idx('STATUS'), erstellt: idx('ERSTELLT'),
    platz: PLATZ_SPALTEN.map(idx).find((x) => x >= 0) ?? -1 };
  if (i.bid < 0 || i.datum < 0) throw new BusinessError('EP3-Buchungen: Spalten BID / DATUM nicht gefunden.');
  const kandidaten: Ep3Abweichung[] = [];
  for (const r of rows.slice(1)) {
    const bid = bidNorm(r[i.bid] ?? '');
    let datum: string | null = null;
    try { datum = sapDatum((r[i.datum] ?? '').trim().split(/[ T]/)[0]); } catch { datum = null; }
    if (!bid || !datum) continue;
    const st = (r[i.status] ?? '').trim().toLowerCase();
    if ((STATUS[st] ?? st) === '2') continue;
    let erstellt: string | null = null;
    if (i.erstellt >= 0) { try { erstellt = sapDatum((r[i.erstellt] ?? '').trim().split(/[ T]/)[0]); } catch { erstellt = null; } }
    const relevant = i.erstellt >= 0 ? !!erstellt && erstellt >= ab && erstellt <= stichtag : datum >= ab && datum <= stichtag;
    if (!relevant) continue;
    let von: string | null = null;
    let bis: string | null = null;
    try { von = i.von >= 0 ? sapZeit(r[i.von] ?? '') : null; bis = i.bis >= 0 ? sapZeit(r[i.bis] ?? '') : null; } catch { /* leer */ }
    kandidaten.push({ bid, datum, kunde: (r[i.kunde] ?? '').trim().toUpperCase(), von, bis, platz: i.platz >= 0 ? (r[i.platz] ?? '').trim() || null : null,
      erstellt, art: (STATUS[st] ?? st) === '3' ? 'Abo' : 'Einzel' });
  }
  if (!kandidaten.length) return { geprueft: 0, fehlend: [], ab, mitErstellt: i.erstellt >= 0 };
  const bids = [...new Set(kandidaten.map((k) => k.bid))];
  const vorhanden = new Set((await db`select bid, datum::text as datum from tco.bookings where bid = any(${bids})`).map((r) => `${r.bid}|${r.datum}`));
  const fehlend = kandidaten.filter((k) => !vorhanden.has(`${k.bid}|${k.datum}`))
    .sort((a, b) => a.datum.localeCompare(b.datum) || (a.von ?? '').localeCompare(b.von ?? ''));
  return { geprueft: kandidaten.length, fehlend, ab, mitErstellt: i.erstellt >= 0 };
}

/** frühestes und spätestes Datum der Buchungsdatei (zeigt, welchen Zeitraum der Workflow tatsächlich geliefert hat) */
export function zeitraumDerBuchungen(csv: string | undefined): { von: string; bis: string } | null {
  if (!csv) return null;
  const rows = csvParse(csv);
  const i = (rows[0] ?? []).map((x) => x.trim().toUpperCase()).indexOf('DATUM');
  if (i < 0) return null;
  let von = '', bis = '';
  for (const r of rows.slice(1)) {
    let d: string | null = null;
    try { d = sapDatum((r[i] ?? '').trim().split(/[ T]/)[0]); } catch { d = null; }
    if (!d) continue;
    if (!von || d < von) von = d;
    if (!bis || d > bis) bis = d;
  }
  return von ? { von, bis } : null;
}

/**
 * EP3-Import über den n8n-Workflow (docs/n8n/tco-ep3-import.json, „TCO EP3 Import Portal“).
 * `ab` (JJJJ-MM-TT): Buchungen ab diesem Datum anfordern statt des Standardzeitraums des Workflows (18 Monate) – #103.
 * Der Workflow meldet in `ab` zurück, ob er den Zeitraum übernommen hat (ältere Workflows kennen den Parameter nicht).
 */
export async function ep3UeberN8n(v: Verein, benutzer: string, ab: string | null = null): Promise<{ bookings_csv?: string; kunden_csv?: string; texte_csv?: string; events_csv?: string; ab?: string | null }> {
  if (!v.n8n_ep3_url) throw new BusinessError('Der EP3-Import über n8n ist nicht eingerichtet (Administration → Anbindungen).');
  let res: Response;
  try {
    res = await fetch(v.n8n_ep3_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(v.n8n_ep3_auth ? { Authorization: v.n8n_ep3_auth } : {}) },
      body: JSON.stringify({ quelle: 'Portal Hallenabrechnung', user: benutzer, ...(ab ? { ab } : {}) }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    throw new BusinessError(`n8n nicht erreichbar: ${(e as Error).message}`);
  }
  const t = await res.text();
  if (!res.ok) throw new BusinessError(`n8n antwortet mit HTTP ${res.status}: ${t.slice(0, 300)}`);
  let j: Record<string, string | null>;
  try { j = JSON.parse(t); } catch { throw new BusinessError('n8n hat keine gültigen Daten geliefert.'); }
  if (!j.bookings_csv && !j.kunden_csv && !j.texte_csv) throw new BusinessError('n8n hat keine Daten geliefert.');
  return j as { bookings_csv?: string; kunden_csv?: string; texte_csv?: string; events_csv?: string; ab?: string | null };
}
