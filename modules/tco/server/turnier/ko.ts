/**
 * Turniere – Modus „ko“: KO-Turnier nach Setzung (bis 64 Teilnehmende) mit Nebenrunde. Die reine Logik (Setzschema, Freilose,
 * Struktur der Nebenrunde, Abgleich) steht in ko-logik.ts; hier Datenbank und Routen.
 *
 *  - POST   /turniere/:id/ko/auslosen   – Hauptfeld auslosen (nur ohne Ergebnisse; vorhandene Auslosung wird ersetzt), Status → läuft
 *  - DELETE /turniere/:id/ko/auslosung  – Auslosung aufheben (nur ohne Ergebnisse)
 *  - GET    /turniere/:id/ko/vorschau   – Setzliste, Feldgröße, Freilose (optional ?setzung=&gesetzte= für ungespeicherte Einstellungen)
 *
 * Die Setzliste der Auslosung und die Art der Nebenrunde werden in einstellungen.auslosung gespeichert (KoAuslosungInfo), damit
 * eine spätere Änderung der Einstellungen ein laufendes Tableau nicht verändert.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { DB, type Db } from '../verein.js';
import { aktiveTeilnehmer, nachStaerke, P_TURNIER, turnierLesen, type ModusDef } from './daten.js';
import {
  abgleichen, auslosen, linienAusSpielen, MAX_FELD, setzlisteBilden, strukturBilden, zweierpotenz,
  type IstSpiel, type KoAuslosungInfo, type KoFeld, type KoLiveDaten, type KoLiveFeld, type Nebenrunde, type Struktur,
} from './ko-logik.js';
import { STANDARD_EINSTELLUNGEN, type KoEinstellungen, type Spiel, type Turnier } from './typen.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

export function koEinstellungen(t: Turnier): KoEinstellungen & { auslosung?: KoAuslosungInfo } {
  return { ...STANDARD_EINSTELLUNGEN.ko, ...(t.einstellungen as Partial<KoEinstellungen>) };
}

type KoSpiel = Spiel & { feld: KoFeld };
async function koSpiele(db: Db, turnierId: number): Promise<KoSpiel[]> {
  return db<KoSpiel[]>`select id, turnier_id, runde_id, feld, runde, pos, gruppe, platz, a, b, saetze, wertung, sieger, bemueht, eingetragen_von, eingetragen_am
                     from tco.turnier_spiele where turnier_id = ${turnierId} and feld in ('haupt', 'neben') order by feld, runde, pos`;
}

function strukturAus(t: Turnier, spiele: IstSpiel[]): Struktur | null {
  const linien = linienAusSpielen(spiele);
  if (!linien.length) return null;
  const e = koEinstellungen(t);
  return strukturBilden(linien, (e.auslosung?.nebenrunde ?? e.nebenrunde) as Nebenrunde);
}

/**
 * Alle KO-Spiele mit der Struktur abgleichen: Sieger weiterrücken, Verlierer in die Nebenrunde, Freilose werten, nach einer
 * Korrektur Folgeeinträge zurücknehmen. Ist ein betroffenes Folgespiel schon gewertet → BusinessError (Transaktion wird zurückgerollt).
 */
export async function koAbgleichen(tx: Db, t: Turnier): Promise<void> {
  const spiele = await koSpiele(tx, t.id);
  const s = strukturAus(t, spiele);
  if (!s) return;
  const { aenderungen, konflikte } = abgleichen(s, spiele);
  if (konflikte.length) {
    const k = konflikte[0];
    const r = s.runden.find((x) => x.feld === k.feld && x.runde === k.runde);
    const wo = `${k.feld === 'haupt' ? 'Hauptfeld' : 'Nebenrunde'}, ${r?.titel ?? `${k.runde}. Runde`}, Spiel ${k.pos + 1}`;
    throw new BusinessError(`Das Folgespiel (${wo}) hat bereits ein Ergebnis. Bitte zuerst dort das Ergebnis zurücksetzen.`);
  }
  for (const x of aenderungen) {
    await tx`update tco.turnier_spiele set a = ${x.a}::int[], b = ${x.b}::int[], wertung = ${x.wertung}, sieger = ${x.sieger},
               saetze = null, eingetragen_von = null, eingetragen_am = null
             where turnier_id = ${t.id} and feld = ${x.feld} and runde = ${x.runde} and pos = ${x.pos} and wertung in ('offen', 'freilos')`;
  }
}

async function ergebnisseVorhanden(tx: Db, turnierId: number): Promise<number> {
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from tco.turnier_spiele
                                             where turnier_id = ${turnierId} and feld in ('haupt', 'neben') and wertung not in ('offen', 'freilos')`;
  return n;
}

async function staerkeListe(db: Db, t: Turnier, setzung: 'lk' | 'manuell') {
  return nachStaerke(await aktiveTeilnehmer(db, t.id), setzung);
}

/** Auslosung durchführen und speichern (rnd für Tests übergebbar) */
export async function koAuslosen(tx: Db, turnierId: number, rnd: () => number = Math.random) {
  await tx`select id from tco.turniere where id = ${turnierId} for update`;
  const t = await turnierLesen(tx, turnierId);
  if (t.modus !== 'ko') throw new BusinessError('Das Turnier ist kein KO-Turnier.');
  if (t.status === 'beendet') throw new BusinessError('Das Turnier ist beendet.');
  if (await ergebnisseVorhanden(tx, t.id)) throw new BusinessError('Es gibt bereits Ergebnisse – eine neue Auslosung ist nicht mehr möglich.');
  const e = koEinstellungen(t);
  const staerke = await staerkeListe(tx, t, e.setzung);
  if (staerke.length < 2) throw new BusinessError('Für die Auslosung braucht es mindestens zwei gemeldete Teilnehmende.');
  if (staerke.length > MAX_FELD) throw new BusinessError(`Das KO-Feld fasst höchstens ${MAX_FELD} Teilnehmende – gemeldet sind ${staerke.length}. Bitte einige auf die Warteliste setzen.`);
  const aus = auslosen(staerke, e.gesetzte, rnd);
  const s = strukturBilden(aus.linien, e.nebenrunde);
  await tx`delete from tco.turnier_spiele where turnier_id = ${t.id} and feld in ('haupt', 'neben')`;
  for (const sp of s.spiele) {
    const a = sp.a.art === 'start' && sp.a.id != null ? [sp.a.id] : [];
    const b = sp.b.art === 'start' && sp.b.id != null ? [sp.b.id] : [];
    await tx`insert into tco.turnier_spiele (turnier_id, feld, runde, pos, a, b) values (${t.id}, ${sp.feld}, ${sp.runde}, ${sp.pos}, ${a}::int[], ${b}::int[])`;
  }
  const info: KoAuslosungInfo = {
    feld: aus.feld, nebenrunde: e.nebenrunde, am: new Date().toISOString(),
    gesetzte: Object.fromEntries(aus.gesetzte.map((id, i) => [String(id), i + 1])),
  };
  const einst = { ...t.einstellungen, auslosung: info };
  await tx`update tco.turniere set status = 'laeuft', einstellungen = ${tx.json(einst as never)} where id = ${t.id}`;
  await koAbgleichen(tx, { ...t, einstellungen: einst });
  return { ok: true, feld: aus.feld, freilose: aus.freilose, gesetzte: aus.gesetzte.length, spiele: s.spiele.length };
}

export async function koAuslosungAufheben(tx: Db, turnierId: number) {
  await tx`select id from tco.turniere where id = ${turnierId} for update`;
  const t = await turnierLesen(tx, turnierId);
  if (t.modus !== 'ko') throw new BusinessError('Das Turnier ist kein KO-Turnier.');
  const n = await ergebnisseVorhanden(tx, t.id);
  if (n) throw new BusinessError(`Es gibt bereits ${n} Ergebnis${n === 1 ? '' : 'se'} – die Auslosung lässt sich nicht mehr aufheben. Bitte zuerst die Ergebnisse zurücksetzen.`);
  await tx`delete from tco.turnier_spiele where turnier_id = ${t.id} and feld in ('haupt', 'neben')`;
  const { auslosung: _weg, ...einst } = t.einstellungen as Record<string, unknown>;
  await tx`update tco.turniere set einstellungen = ${tx.json(einst as never)} where id = ${t.id}`;
  return { ok: true };
}

async function koLive(db: Db, t: Turnier): Promise<KoLiveDaten> {
  const e = koEinstellungen(t);
  const spiele = await koSpiele(db, t.id);
  const s = strukturAus(t, spiele);
  const gesetzte: Record<number, number> = {};
  if (!s) return { ausgelost: false, feld: null, nebenrunde: e.nebenrunde, haupt: null, neben: null, gesetzte };
  for (const [id, platz] of Object.entries(e.auslosung?.gesetzte ?? {})) gesetzte[Number(id)] = platz;
  const feld = (f: 'haupt' | 'neben'): KoLiveFeld | null => {
    const runden = s.runden.filter((r) => r.feld === f).map((r) => ({
      nr: r.runde, titel: r.titel, einstieg: r.einstieg,
      spiele: spiele.filter((x) => x.feld === f && x.runde === r.runde).map((x) => ({
        id: x.id, runde: x.runde, pos: x.pos, a: x.a[0] ?? null, b: x.b[0] ?? null, saetze: x.saetze, wertung: x.wertung, sieger: x.sieger,
      })),
    }));
    if (!runden.length) return null;
    const fin = runden[runden.length - 1].spiele[0];
    const sieger = fin && (fin.sieger === 'a' ? fin.a : fin.sieger === 'b' ? fin.b : null);
    return { runden, sieger: sieger ?? null };
  };
  return { ausgelost: true, feld: s.feld, nebenrunde: s.nebenrunde, haupt: feld('haupt'), neben: feld('neben'), gesetzte };
}

export const KO: ModusDef = {
  live: koLive,
  nachErgebnis: async (tx, t, s) => {
    if (s.feld !== 'haupt' && s.feld !== 'neben') return;
    await koAbgleichen(tx, t);
  },
  routes: (app: FastifyInstance) => {
    const pflegen = { preHandler: requireAuth(P_TURNIER.edit) };
    const anzeigen = { preHandler: requireAuth(P_TURNIER.display) };

    app.post('/turniere/:id/ko/auslosen', pflegen, async (req) => {
      const { id } = idParam.parse(req.params);
      return change(req, (tx) => koAuslosen(tx, id), { action: 'TURNIER_AUSLOSUNG' });
    });

    app.delete('/turniere/:id/ko/auslosung', pflegen, async (req) => {
      const { id } = idParam.parse(req.params);
      return change(req, (tx) => koAuslosungAufheben(tx, id), { action: 'TURNIER_AUSLOSUNG' });
    });

    /** Vorschau der Setzliste (ohne zu speichern) */
    app.get('/turniere/:id/ko/vorschau', anzeigen, async (req) => {
      const { id } = idParam.parse(req.params);
      const q = z.object({
        setzung: z.enum(['lk', 'manuell']).optional(),
        gesetzte: z.coerce.number().int().min(0).max(16).optional(),
      }).parse(req.query);
      const t = await turnierLesen(DB, id);
      const e = koEinstellungen(t);
      const setzung = q.setzung ?? e.setzung, gesetzte = q.gesetzte ?? e.gesetzte;
      const staerke = await staerkeListe(DB, t, setzung);
      const anzahl = staerke.length;
      const feld = anzahl > MAX_FELD ? null : zweierpotenz(Math.max(anzahl, 2));
      const setz = feld ? setzlisteBilden(staerke, gesetzte, feld) : [];
      const platz = new Map(setz.map((id, i) => [id, i + 1]));
      // Freilose: zuerst an die Gesetzten, dann an die nächststärksten Ungesetzten
      const frei = new Set([...setz, ...staerke.map((x) => x.id).filter((x) => !platz.has(x))].slice(0, feld ? feld - anzahl : 0));
      return {
        anzahl, feld, freilose: feld ? feld - anzahl : null,
        hinweis: anzahl > MAX_FELD ? `Mehr als ${MAX_FELD} Teilnehmende – bitte einige auf die Warteliste setzen.` : anzahl < 2 ? 'Es sind noch keine zwei Teilnehmenden gemeldet.' : null,
        staerke: staerke.map((x, i) => ({ id: x.id, rang: i + 1, setzplatz: platz.get(x.id) ?? null, manuell: x.setzplatz, lk: x.lk, freilos: frei.has(x.id) })),
      };
    });
  },
};
