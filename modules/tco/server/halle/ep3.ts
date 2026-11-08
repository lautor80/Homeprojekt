import { BusinessError } from '../../../../server/src/errors.js';
import { csvParse, dekodieren, sapDatum, sapZeit } from '../../../../server/src/lib/sapcsv.js';
import type { Db, Verein } from '../verein.js';
import { dat, heute, zeit } from '../format.js';
import { ep3BenutzerAnlegen } from '../platz/registrierung.js';

/**
 * Import der EP3-Exporte (Buchungssystem ep3-bs): Buchungen, Kunden, Buchungstexte.
 * Port von IMPORT_CSV / CSV_TYP_ERMITTELN / ZCL_TCO_RECHNUNGEN=>BOOKINGS_IMPORTIEREN.
 */

export type Ep3Typ = 'BUCHUNGEN' | 'KUNDEN' | 'TEXTE';

export function ep3Typ(kopf: string[]): Ep3Typ | null {
  const k = new Set(kopf.map((s) => s.trim().toUpperCase()));
  if (k.has('ZUID') && k.has('KEY')) return 'KUNDEN';
  if (k.has('BID') && k.has('DATUM')) return 'BUCHUNGEN';
  if (k.has('BID') && k.has('TEXT')) return 'TEXTE';
  return null;
}

/** BID im SAP-Format (10 Stellen, führende Nullen) – wie die aus SAP übernommenen Buchungen und Rechnungspositionen */
export const bidNorm = (b: string) => { const t = b.trim(); return /^\d{1,9}$/.test(t) ? t.padStart(10, '0') : t; };

/** Spalten mit dem gebuchten Platz im EP3-Export (Name bevorzugt, sonst Nummer) */
const PLATZ_SPALTEN = ['PLATZ', 'SQUARE', 'SQUARE_NAME', 'COURT', 'SNAME', 'SID'];

const STATUS: Record<string, string> = { single: '1', subscription: '3', cancelled: '2' };

export interface ImportErgebnis { typ: Ep3Typ | null; text: string; ok: boolean }

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
  if (typ === 'BUCHUNGEN') return buchungenImportieren(tx, daten, idx);
  return {
    typ: null, ok: false,
    text: `Die Datei konnte keiner Tabelle zugeordnet werden. Erwartet: EP3_BOOKINGS (BID, DATUM …), EP3_USER (ZUID, KEY, VALUE …) oder EP3_TEXTE (BID, TEXT). Erkannt wurden: ${kopf.join(', ')}`,
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
  if (zuids.length) {
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
  // Portalbenutzer für alle aktiven EP3-Kunden anlegen (Benutzername = E-Mail, Rolle Hallennutzer) und zuordnen
  const b = await ep3BenutzerAnlegen(tx, zuids);
  return {
    typ: 'KUNDEN', ok: true,
    text: `Kunden: ${rows.length} gelesen, ${kunden.size} übertragen${mitPw ? `, ${mitPw} Kennwörter übernommen` : ''}`
      + (b.angelegt ? `, ${b.angelegt} Benutzer angelegt` : '') + (b.mitglieder ? ` (${b.mitglieder} Mitgliedern zugeordnet)` : '')
      + (b.ohneKennwort ? `, ${b.ohneKennwort} ohne Kennwort (Kennwort über die Benutzerpflege setzen)` : ''),
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
  return { typ: 'BUCHUNGEN', ok: true, text };
}

/** EP3-Import über den n8n-Workflow „TCO EP3 Import Hallenrechnungen“ */
export async function ep3UeberN8n(v: Verein, benutzer: string): Promise<{ bookings_csv?: string; kunden_csv?: string; texte_csv?: string }> {
  if (!v.n8n_ep3_url) throw new BusinessError('Der EP3-Import über n8n ist nicht eingerichtet (Stammdaten → Anbindungen).');
  let res: Response;
  try {
    res = await fetch(v.n8n_ep3_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(v.n8n_ep3_auth ? { Authorization: v.n8n_ep3_auth } : {}) },
      body: JSON.stringify({ quelle: 'Portal Hallenabrechnung', user: benutzer }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    throw new BusinessError(`n8n nicht erreichbar: ${(e as Error).message}`);
  }
  const t = await res.text();
  if (!res.ok) throw new BusinessError(`n8n antwortet mit HTTP ${res.status}: ${t.slice(0, 300)}`);
  let j: Record<string, string>;
  try { j = JSON.parse(t); } catch { throw new BusinessError('n8n hat keine gültigen Daten geliefert.'); }
  if (!j.bookings_csv && !j.kunden_csv && !j.texte_csv) throw new BusinessError('n8n hat keine Daten geliefert.');
  return j;
}
