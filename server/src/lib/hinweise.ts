/**
 * Hinweise im Arbeitsvorrat (#232, V1): Ereignisse, die jemand wissen muss, sich aber nicht aus dem aktuellen Stand
 * berechnen lassen – ein Mitglied ändert seine Bankverbindung, eine Schnittstelle scheitert, ein Lauf sperrt Benutzer.
 *
 * Die Stelle, an der das Ereignis geschieht, meldet es mit hinweisMelden(). Der Hinweis steht im Arbeitsvorrat der
 * Anwendung (Startseite), bis jemand mit dem Recht der zugehörigen App „gesehen“ ankreuzt – oder, bei Störungen, bis
 * der nächste Versuch gelingt (hinweisBeheben). Je Quelle und Objekt gibt es höchstens einen offenen Hinweis;
 * Wiederholungen schreiben ihn fort und zählen hoch.
 *
 * Kein Änderungsbeleg: Die Tabelle ist selbst ein Protokoll (wer wann „gesehen“ bestätigt hat, steht in der Zeile).
 */
import type { FastifyRequest } from 'fastify';
import { can } from '../auth.js';
import { sql, type Tx } from '../db.js';
import { BusinessError } from '../errors.js';
import type { Aufgabe } from './arbeitsvorrat.js';

/** außerhalb einer Transaktion melden (Hintergrundläufe, Fehlerbehandlung) */
export const HINWEIS_DB = sql as unknown as Tx;

export interface HinweisNeu {
  /** Anwendung, in deren Block der Hinweis steht: core, tco, transport */
  modul: string;
  /** Art des Ereignisses in Großbuchstaben, z. B. MG_BANK – eindeutig je Anwendung */
  quelle: string;
  /** worum es geht (Mitgliedsnummer, Benutzer …): je Quelle und Objekt höchstens ein offener Hinweis */
  objekt?: string | number | null;
  /** Zuständigkeit, unter der der Hinweis im Arbeitsvorrat steht (Kassenwart, Vorstand, Administration …) */
  bereich: string;
  /** Recht der App, in der man dem Hinweis nachgeht: Wer es hat, sieht den Hinweis und darf „gesehen“ bestätigen */
  recht: string;
  /** Bezeichnung der Ereignisart, z. B. „Bankverbindung geändert“ */
  art: string;
  /** wen oder was es betrifft, z. B. „Mia Matchball (1234)“ */
  titel: string;
  text?: string;
  icon?: string;
  state?: Aufgabe['state'];
  /** Portalpfad der App, in der man nachsieht */
  pfad: string;
}

/** Ereignis melden – in der Transaktion der Änderung (tx) oder mit HINWEIS_DB */
export async function hinweisMelden(db: Tx, h: HinweisNeu): Promise<void> {
  await db`
    insert into core.hinweise (modul, quelle, objekt, bereich, recht, art, titel, text, icon, state, pfad)
    values (${h.modul}, ${h.quelle}, ${String(h.objekt ?? '')}, ${h.bereich}, ${h.recht}, ${h.art}, ${h.titel}, ${h.text ?? ''},
            ${h.icon ?? 'message-information'}, ${h.state ?? 'Information'}, ${h.pfad})
    on conflict (modul, quelle, objekt) where erledigt_am is null
    do update set bereich = excluded.bereich, recht = excluded.recht, art = excluded.art, titel = excluded.titel, text = excluded.text,
                  icon = excluded.icon, state = excluded.state, pfad = excluded.pfad,
                  anzahl = core.hinweise.anzahl + 1, zuletzt_am = now()`;
}

/**
 * Störung melden, ohne den eigentlichen Fehler zu verdecken: für catch-Zweige und Hintergrundläufe.
 * Scheitert das Melden selbst, steht es nur im Server-Log.
 */
export async function stoerungMelden(h: HinweisNeu, log?: { warn: (e: unknown, text: string) => void }): Promise<void> {
  gestoert.set(merker(h.modul, h.quelle, h.objekt), true);
  try { await hinweisMelden(HINWEIS_DB, { state: 'Negative', icon: 'error', ...h }); } catch (e) { log?.warn(e, `Hinweis ${h.modul}/${h.quelle} nicht gespeichert`); }
}

/** Stand je Schnittstelle in diesem Prozess: true = Störung gemeldet, false = läuft; fehlt = nach dem Start noch unbekannt */
const gestoert = new Map<string, boolean>();
const merker = (modul: string, quelle: string, objekt?: string | number | null) => `${modul}\n${quelle}\n${objekt ?? ''}`;

/**
 * Schnittstelle hat geantwortet: eine zuvor gemeldete Störung schließt sich. Kostet nur beim ersten Erfolg nach dem Start
 * und nach einer Störung eine Datenbankabfrage – danach merkt sich der Prozess, dass nichts offen ist.
 */
export async function laeuft(modul: string, quelle: string, objekt?: string | number | null): Promise<void> {
  const k = merker(modul, quelle, objekt);
  if (gestoert.get(k) === false) return;
  gestoert.set(k, false);
  await hinweisBeheben(modul, quelle, objekt ?? '');
}

/**
 * Aufruf einer Schnittstelle überwachen: Scheitert er, steht die Störung mit der Fehlermeldung im Arbeitsvorrat –
 * der Fehler geht unverändert weiter an den Aufrufer. Klappt der nächste Aufruf, verschwindet die Störung von selbst.
 */
export async function ueberwacht<T>(h: Omit<HinweisNeu, 'text'>, fn: () => Promise<T>): Promise<T> {
  let r: T;
  try { r = await fn(); } catch (e) {
    await stoerungMelden({ ...h, text: String((e as Error)?.message ?? e).replace(/\s+/g, ' ').slice(0, 300) });
    throw e;
  }
  await laeuft(h.modul, h.quelle, h.objekt);
  return r;
}

/** Störung behoben (der nächste Versuch hat geklappt): offene Hinweise der Quelle schließen sich von selbst */
export async function hinweisBeheben(modul: string, quelle: string, objekt?: string | number | null): Promise<void> {
  try {
    await sql`update core.hinweise set erledigt_am = now(), erledigt_von = 'behoben'
               where modul = ${modul} and quelle = ${quelle} and erledigt_am is null ${objekt == null ? sql`` : sql`and objekt = ${String(objekt)}`}`;
  } catch { /* der Hinweis bleibt stehen, bis ihn jemand bestätigt */ }
}

/**
 * Offene Störungen für die Zeile „Stand“ der App Schnittstellen (#232, S1) – dieselbe Quelle wie der Arbeitsvorrat:
 * was dort rot steht, steht auch am Zugang. Schlüssel: „<modul>\n<quelle>\n<objekt>“.
 */
export interface Stoerung { text: string; seit: string; anzahl: number }
export async function offeneStoerungen(quellen: string[]): Promise<Map<string, Stoerung>> {
  const rows = await sql`select modul, quelle, objekt, text, anzahl, to_char(erstellt_am at time zone 'Europe/Berlin', 'YYYY-MM-DD') as seit
                           from core.hinweise where erledigt_am is null and quelle = any(${quellen})`;
  return new Map(rows.map((r) => [merker(r.modul as string, r.quelle as string, r.objekt as string), { text: r.text as string, seit: r.seit as string, anzahl: Number(r.anzahl) }]));
}
export const stoerungSchluessel = (modul: string, quelle: string, objekt?: string | number | null): string => merker(modul, quelle, objekt);

interface Zeile { id: number; quelle: string; bereich: string; recht: string; art: string; titel: string; text: string; icon: string; state: Aufgabe['state']; pfad: string; anzahl: number; datum: string }
const RANG = { Negative: 3, Critical: 2, Information: 1 } as const;
export const HINWEIS_GESEHEN = '/api/arbeitsvorrat/hinweis-gesehen';

/**
 * Offene Hinweise einer Anwendung als Einträge des Arbeitsvorrats – nur die, deren App der Benutzer bedienen darf.
 * Mehrere Hinweise derselben Art stehen gesammelt unter einem Eintrag: einzeln oder alle auf einmal bestätigen.
 */
export async function hinweisAufgaben(req: FastifyRequest, modul: string): Promise<Aufgabe[]> {
  const rows = ((await sql`
    select id::int as id, quelle, bereich, recht, art, titel, text, icon, state, pfad, anzahl,
           to_char(zuletzt_am at time zone 'Europe/Berlin', 'YYYY-MM-DD') as datum
      from core.hinweise where modul = ${modul} and erledigt_am is null
     order by zuletzt_am desc, id desc limit 500`) as unknown as Zeile[]).filter((r) => can(req, r.recht));
  const mal = (r: Zeile) => (r.anzahl > 1 ? ` (${r.anzahl}×)` : '');
  const gruppen = new Map<string, Zeile[]>();
  for (const r of rows) { const k = `${r.bereich}\n${r.quelle}`; gruppen.set(k, [...(gruppen.get(k) ?? []), r]); }
  const out: Aufgabe[] = [];
  for (const g of gruppen.values()) {
    const eintrag = (r: Zeile, mitArt: boolean): Aufgabe => ({
      key: `HINWEIS:${r.quelle}:${r.id}`, bereich: r.bereich, icon: r.icon, state: r.state, datum: r.datum, pfad: r.pfad,
      titel: `${mitArt ? `${r.art}: ` : ''}${r.titel}${mal(r)}`, text: r.text,
      erledigen: { text: 'gesehen', url: HINWEIS_GESEHEN, body: { id: r.id } },
    });
    if (g.length === 1) { out.push(eintrag(g[0], true)); continue; }
    out.push({
      key: `HINWEIS:${g[0].quelle}`, bereich: g[0].bereich, icon: g[0].icon, datum: g[0].datum, pfad: g[0].pfad,
      state: g.reduce<Aufgabe['state']>((s, r) => (RANG[r.state] > RANG[s] ? r.state : s), 'Information'),
      titel: `${g[0].art} (${g.length})`, text: 'einzeln oder alle auf einmal als gesehen bestätigen',
      erledigen: { text: 'alle gesehen', url: HINWEIS_GESEHEN, body: { modul, quelle: g[0].quelle, bereich: g[0].bereich } },
      kinder: g.map((r) => eintrag(r, false)),
    });
  }
  return out;
}

/** „gesehen“: einen Hinweis (id) oder alle offenen einer Art (modul, quelle, bereich) – nur mit dem Recht der zugehörigen App */
export async function hinweisGesehen(req: FastifyRequest, b: { id?: number; modul?: string; quelle?: string; bereich?: string }): Promise<number> {
  const rows = b.id
    ? await sql`select id::int as id, recht from core.hinweise where id = ${b.id} and erledigt_am is null`
    : await sql`select id::int as id, recht from core.hinweise where modul = ${b.modul ?? ''} and quelle = ${b.quelle ?? ''} and erledigt_am is null
                   ${b.bereich ? sql`and bereich = ${b.bereich}` : sql``}`;
  const ids = rows.filter((r) => can(req, r.recht as string)).map((r) => r.id as number);
  // einzelner Hinweis, den es (so) nicht gibt: schon bestätigt – oder nicht für diesen Benutzer
  if (b.id && !ids.length && rows.length) throw new BusinessError('Keine Berechtigung für diesen Hinweis.', 403);
  if (!ids.length) return 0;
  const wer = req.user?.displayName || req.user?.username || 'unbekannt';
  const r = await sql`update core.hinweise set erledigt_am = now(), erledigt_von = ${wer} where id = any(${ids}) and erledigt_am is null`;
  return r.count;
}
