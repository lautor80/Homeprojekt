/**
 * Turniere: Datenzugriff, den alle Modi teilen – Turnier, Teilnehmende, Runden, Spiele lesen; Ergebnis speichern;
 * Stärke-Rangliste (LK oder manueller Rang); persönlicher Link.
 */
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import type { Modus, Runde, Satz, Seite, Spiel, Teilnehmer, Turnier, Wertung } from './typen.js';
import { einzelAuswerten, ErgebnisFehler, spassAuswerten } from './wertung.js';

export const P_TURNIER = { display: 'tco.turnier:display', edit: 'tco.turnier:edit' };

/** Schnittstelle je Modus (ko.ts, liga.ts, spass.ts) */
export interface ModusDef {
  /**
   * Daten für die Live-Ansicht (öffentlich und Verwaltung), z. B. Tableau, Gruppentabellen, Rangliste.
   * Namen NICHT hier auflösen – die Routen liefern die Teilnehmerliste mit (öffentlich gekürzt „Vorname N.“).
   */
  live: (db: Db, t: Turnier) => Promise<unknown>;
  /**
   * Zusätzliche Routen des Modus (Prefix /api/m/tco). Verwaltung unter /turniere/:id/<modus>/…
   * (requireAuth(P_TURNIER.…)), öffentliche unter /turnier/<modus>/…
   */
  routes?: (app: FastifyInstance) => void | Promise<void>;
  /** nach dem Speichern eines Ergebnisses in derselben Transaktion (KO: Sieger weiterrücken, Nebenrunde füllen) */
  nachErgebnis?: (tx: Db, t: Turnier, s: Spiel) => Promise<void>;
}

export async function turnierLesen(db: Db, id: number): Promise<Turnier> {
  const [t] = await db<Turnier[]>`select id, kennung, name, modus, status, beschreibung, meldeschluss, max_teilnehmer, einstellungen
                                  from tco.turniere where id = ${id}`;
  if (!t) throw new BusinessError('Turnier nicht gefunden.', 404);
  return t;
}

export async function turnierZurKennung(db: Db, kennung: string): Promise<Turnier> {
  const [t] = await db<{ id: number }[]>`select id from tco.turniere where kennung = ${kennung} and status <> 'entwurf'`;
  if (!t) throw new BusinessError('Dieses Turnier gibt es nicht (mehr).', 404);
  return turnierLesen(db, t.id);
}

const TN_SPALTEN = 'id, turnier_id, vorname, nachname, geburtsjahr, geschlecht, email, telefon, adrnr, lk::float as lk, rang, setzplatz, status, bemerkung, angemeldet_am';

/** Teilnehmende eines Turniers (alle Status), in Meldereihenfolge */
export async function teilnehmerLesen(db: Db, turnierId: number): Promise<Teilnehmer[]> {
  return db.unsafe(`select ${TN_SPALTEN} from tco.turnier_teilnehmer where turnier_id = $1 order by angemeldet_am, id`, [turnierId]) as unknown as Promise<Teilnehmer[]>;
}

/** nur Gemeldete (ohne Warteliste und Abgemeldete) */
export async function aktiveTeilnehmer(db: Db, turnierId: number): Promise<Teilnehmer[]> {
  return (await teilnehmerLesen(db, turnierId)).filter((t) => t.status === 'gemeldet');
}

/**
 * Stärke-Rangliste: manuell = nach Rang (ohne Rang ans Ende), LK = aufsteigend (LK 1 ist am stärksten, ohne LK ans Ende).
 * Gleichstand: manueller Rang, dann frühere Meldung.
 */
export function nachStaerke<T extends Pick<Teilnehmer, 'id' | 'lk' | 'rang' | 'angemeldet_am'>>(liste: T[], setzung: 'lk' | 'manuell'): T[] {
  const gross = Number.MAX_SAFE_INTEGER;
  return [...liste].sort((x, y) => {
    const k = setzung === 'manuell'
      ? (x.rang ?? gross) - (y.rang ?? gross) || (x.lk ?? 99) - (y.lk ?? 99)
      : (x.lk ?? 99) - (y.lk ?? 99) || (x.rang ?? gross) - (y.rang ?? gross);
    return k || String(x.angemeldet_am).localeCompare(String(y.angemeldet_am)) || x.id - y.id;
  });
}

export async function rundenLesen(db: Db, turnierId: number): Promise<Runde[]> {
  return db<Runde[]>`select id, turnier_id, nr, monat, beginn, minuten, status from tco.turnier_runden where turnier_id = ${turnierId} order by nr`;
}

export async function spieleLesen(db: Db, turnierId: number): Promise<Spiel[]> {
  return db<Spiel[]>`select id, turnier_id, runde_id, feld, runde, pos, gruppe, platz, a, b, saetze, wertung, sieger, bemueht, eingetragen_von, eingetragen_am
                     from tco.turnier_spiele where turnier_id = ${turnierId} order by feld, runde, gruppe nulls first, pos, id`;
}

export interface ErgebnisEingabe {
  wertung: Exclude<Wertung, 'offen' | 'freilos'>;
  saetze?: Satz[] | null;
  sieger?: Seite | null;
}

/**
 * Ergebnis eines Spiels speichern (Verwaltung, persönlicher Link, Platz-QR). Prüft Zählweise je Modus und ruft
 * danach nachErgebnis des Modus auf. nurTeilnehmer: dieser Teilnehmer muss mitspielen.
 */
export async function ergebnisSpeichern(tx: Db, modi: Record<Modus, ModusDef>, spielId: number, e: ErgebnisEingabe,
  o: { von: string; turnierId?: number; nurTeilnehmer?: number }): Promise<Spiel> {
  const [vorab] = await tx<{ turnier_id: number }[]>`select turnier_id from tco.turnier_spiele where id = ${spielId}`;
  if (!vorab || (o.turnierId && vorab.turnier_id !== o.turnierId)) throw new BusinessError('Spiel nicht gefunden.', 404);
  // erst das Turnier sperren, dann das Spiel: gleichzeitige Eingaben (z. B. beide Halbfinals) laufen nacheinander,
  // damit der Abgleich des Modus (KO: Weiterrücken) immer auf dem bestätigten Stand aufsetzt
  await turnierSperren(tx, vorab.turnier_id);
  const [s] = await tx<Spiel[]>`select * from tco.turnier_spiele where id = ${spielId} for update`;
  const t = await turnierLesen(tx, s.turnier_id);
  if (t.status === 'beendet') throw new BusinessError('Das Turnier ist beendet – Ergebnisse lassen sich nicht mehr ändern.');
  if (o.nurTeilnehmer) {
    if (![...s.a, ...s.b].includes(o.nurTeilnehmer)) throw new BusinessError('Du spielst in diesem Spiel nicht mit.', 403);
    // über den persönlichen Link nur gespielte bzw. aufgegebene Spiele – kampflos und „nicht gespielt“ entscheidet die Turnierleitung
    if (e.wertung !== 'gespielt' && e.wertung !== 'aufgabe') throw new BusinessError('Kampflose oder nicht gespielte Spiele trägt die Turnierleitung ein.', 403);
    if (s.wertung !== 'offen' && s.eingetragen_von !== o.von) throw new BusinessError('Für dieses Spiel ist schon ein Ergebnis eingetragen – Korrekturen bitte über die Turnierleitung.', 403);
  }
  if (!s.a.length || !s.b.length) throw new BusinessError('Die Paarung steht noch nicht fest.');
  if (s.runde_id) {
    const [r] = await tx<{ status: string }[]>`select status from tco.turnier_runden where id = ${s.runde_id}`;
    if (r?.status === 'abgeschlossen' && o.nurTeilnehmer) throw new BusinessError('Die Runde ist abgeschlossen – bitte an die Turnierleitung wenden.');
  }
  let aus;
  try {
    if (s.feld === 'runde') {
      if (e.wertung !== 'gespielt') throw new ErgebnisFehler('Beim Spaßturnier bitte die gewonnenen Spiele je Team eingeben.');
      const [x, y] = e.saetze?.[0] ?? [];
      aus = spassAuswerten(x as number, y as number);
      e = { wertung: 'gespielt', saetze: [[x as number, y as number]] };
    } else {
      if (e.wertung === 'keine' && s.feld !== 'gruppe') throw new ErgebnisFehler('„Nicht gespielt“ gibt es nur in der Liga.');
      aus = einzelAuswerten(e.wertung, e.saetze, e.sieger);
    }
  } catch (err) {
    if (err instanceof ErgebnisFehler) throw new BusinessError(err.message);
    throw err;
  }
  const saetze = e.wertung === 'wo' || e.wertung === 'keine' ? null : (e.saetze ?? null);
  const [neu] = await tx<Spiel[]>`update tco.turnier_spiele set wertung = ${e.wertung}, saetze = ${saetze ? tx.json(saetze) : null}, sieger = ${aus.sieger},
                                    eingetragen_von = ${o.von}, eingetragen_am = now()
                                  where id = ${spielId} returning *`;
  await modi[t.modus].nachErgebnis?.(tx, t, neu);
  return neu;
}

/** Turnier für die Dauer der Transaktion sperren (Reihenfolge: immer zuerst das Turnier, dann Spiele) */
export async function turnierSperren(tx: Db, turnierId: number): Promise<void> {
  await tx`select id from tco.turniere where id = ${turnierId} for update`;
}

/** neuen persönlichen Link-Schlüssel erzeugen (gespeichert wird nur der Hash) */
export async function zugangErzeugen(tx: Db, teilnehmerId: number): Promise<string> {
  const schluessel = crypto.randomBytes(24).toString('base64url');
  await tx`update tco.turnier_teilnehmer set zugang_hash = ${sha256(schluessel)} where id = ${teilnehmerId}`;
  return schluessel;
}

export async function teilnehmerZumZugang(db: Db, schluessel: string): Promise<Teilnehmer> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(schluessel)) throw new BusinessError('Der Link ist ungültig.', 404);
  const [t] = await db.unsafe(`select ${TN_SPALTEN} from tco.turnier_teilnehmer x where zugang_hash = $1
                                and exists (select 1 from tco.turniere t where t.id = x.turnier_id and t.status <> 'entwurf')`, [sha256(schluessel)]) as unknown as Teilnehmer[];
  if (!t || t.status === 'abgemeldet') throw new BusinessError('Der Link ist ungültig oder die Anmeldung wurde zurückgezogen.', 404);
  return t;
}

/** Platz-Schlüssel (Spaßturnier, QR-Code am Platz) erzeugen */
export async function platzSchluesselErzeugen(tx: Db, turnierId: number): Promise<string> {
  const schluessel = crypto.randomBytes(18).toString('base64url');
  await tx`update tco.turniere set platz_hash = ${sha256(schluessel)} where id = ${turnierId}`;
  return schluessel;
}

export async function platzSchluesselPruefen(db: Db, kennung: string, schluessel: string): Promise<Turnier> {
  const [t] = await db<{ id: number }[]>`select id from tco.turniere where kennung = ${kennung} and platz_hash = ${sha256(schluessel)} and status <> 'entwurf'`;
  if (!t) throw new BusinessError('Der Platz-Link ist ungültig.', 404);
  return turnierLesen(db, t.id);
}
