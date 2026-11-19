/**
 * Turniere – Modus „liga“ (Monats-Gruppenliga).
 *
 * Je Runde (= Kalendermonat) werden alle Gemeldeten nach Stärke in 4er-/5er-Gruppen geschnitten (Gruppe 1 = stärkste),
 * in jeder Gruppe spielt jeder gegen jeden. Nach dem Monat steigt der Erste jeder Gruppe auf, der Letzte ab;
 * Neueinsteiger werden nach LK/Rang einsortiert, Abgemeldete fallen heraus. Am Monatsende werden offene Spiele
 * gewertet: hat sich genau eine Seite nachweislich um einen Termin bemüht, gewinnt sie kampflos, sonst bekommt
 * niemand etwas („keine“). Gesamtwertung über alle Monate nach Siegquote.
 *
 * Routen (Prefix /api/m/tco):
 *  GET  /turniere/:id/liga/vorschau                      nächste Einteilung
 *  POST /turniere/:id/liga/runde                         nächste Runde starten
 *  PUT  /turniere/:id/liga/runde/:nr/einteilung          Person in andere Gruppe schieben (nur ohne Ergebnisse in beiden Gruppen)
 *  POST /turniere/:id/liga/runde/:nr/abschliessen        Monatsabschluss
 *  POST /turniere/:id/liga/runde/:nr/oeffnen             wieder öffnen (nur ohne Folgerunde)
 *  PUT  /turniere/:id/liga/spiele/:sid/bemueht           a | b | beide | null
 *  POST /turnier/liga/zugang/:schluessel/bemueht         persönlicher Link: „Ich habe mich um einen Termin bemüht“
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { withChange } from '../../../../server/src/db.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { DB, type Db } from '../verein.js';
import { aktiveTeilnehmer, nachStaerke, P_TURNIER, rundenLesen, spieleLesen, teilnehmerZumZugang, turnierLesen, type ModusDef } from './daten.js';
import {
  einteilen, folgemonat, gesamtWertung, gruppenTabelle, jederGegenJeden, monatAusStart, naechsteReihenfolge,
  type Einsortiert, type LigaLiveDaten, type LigaRunde, type TabellenZeile, type Vorschau,
} from './liga-logik.js';
import { STANDARD_EINSTELLUNGEN, vollname, type LigaEinstellungen, type Runde, type Spiel, type Turnier } from './typen.js';

export type { LigaGruppe, LigaLiveDaten, LigaRunde, Vorschau } from './liga-logik.js';

/** Kennzeichnung der beim Monatsabschluss automatisch gewerteten Spiele (beim Wieder-Öffnen zurückgesetzt) */
const ABSCHLUSS = 'Monatsabschluss';

export function ligaEinstellungen(t: Turnier): LigaEinstellungen {
  const e = { ...STANDARD_EINSTELLUNGEN.liga, ...(t.einstellungen as Partial<LigaEinstellungen>) };
  return { ...e, gruppengroesse: Number(e.gruppengroesse) === 5 ? 5 : 4, setzung: e.setzung === 'manuell' ? 'manuell' : 'lk', runden: Number(e.runden) || 0 };
}

interface Einteilung { runde_id: number; teilnehmer_id: number; gruppe: number; pos: number }
async function einteilungLesen(db: Db, turnierId: number): Promise<Einteilung[]> {
  return db<Einteilung[]>`select e.runde_id, e.teilnehmer_id, e.gruppe, e.pos from tco.turnier_einteilung e
                          join tco.turnier_runden r on r.id = e.runde_id where r.turnier_id = ${turnierId} order by e.gruppe, e.pos`;
}

/** Gruppen einer Runde: IDs je Gruppe in Startreihenfolge */
function gruppenDerRunde(ein: Einteilung[], rundeId: number): number[][] {
  const m = new Map<number, number[]>();
  for (const e of ein.filter((x) => x.runde_id === rundeId)) m.set(e.gruppe, [...(m.get(e.gruppe) ?? []), e.teilnehmer_id]);
  return [...m.entries()].sort(([a], [b]) => a - b).map(([, ids]) => ids);
}

function tabellen(gruppen: number[][], spiele: Spiel[]): TabellenZeile[][] {
  return gruppen.map((ids, i) => gruppenTabelle(ids, spiele, { gruppe: i + 1, gruppen: gruppen.length }));
}

/** Einteilung der nächsten Runde berechnen (ohne zu speichern) */
export async function vorschau(db: Db, t: Turnier): Promise<Vorschau> {
  const e = ligaEinstellungen(t);
  const runden = await rundenLesen(db, t.id);
  const letzte = runden.at(-1);
  const nr = (letzte?.nr ?? 0) + 1;
  const aktive = nachStaerke(await aktiveTeilnehmer(db, t.id), e.setzung);
  let hinweis: string | null = null;
  let monat: string | null;
  let liste: Einsortiert[];
  if (!letzte) {
    monat = monatAusStart(e.start);
    if (!monat) hinweis = 'Bitte in den Einstellungen den Startmonat (JJJJ-MM) eintragen.';
    liste = aktive.map((x) => ({ id: x.id, merkmal: null }));
  } else {
    monat = letzte.monat ? folgemonat(String(letzte.monat)) : null;
    if (letzte.status !== 'abgeschlossen') hinweis = `Monat ${letzte.nr} ist noch nicht abgeschlossen.`;
    const ein = await einteilungLesen(db, t.id);
    const spiele = (await spieleLesen(db, t.id)).filter((s) => s.runde_id === letzte.id);
    const endstand = tabellen(gruppenDerRunde(ein, letzte.id), spiele).map((tab) => tab.map((z) => z.teilnehmer_id));
    liste = naechsteReihenfolge(endstand, aktive, e.setzung);
  }
  if (!hinweis && e.runden && nr > e.runden) hinweis = `Alle ${e.runden} geplanten Monate sind angelegt – für weitere bitte „Anzahl Monate“ erhöhen.`;
  if (!hinweis && t.status === 'beendet') hinweis = 'Das Turnier ist beendet.';
  if (!hinweis && liste.length < 2) hinweis = 'Für eine Runde braucht es mindestens zwei gemeldete Personen.';
  const gruppen = einteilen(liste, e.gruppengroesse).map((p, i) => ({ gruppe: i + 1, personen: p.map(({ id, merkmal }) => ({ id, merkmal })) }));
  return { moeglich: !hinweis, hinweis, nr, monat, gruppen };
}

/** Spiele einer Gruppe anlegen (jeder gegen jeden) */
async function gruppenSpieleAnlegen(tx: Db, t: Turnier, r: Pick<Runde, 'id' | 'nr'>, gruppe: number, ids: number[]) {
  const paare = jederGegenJeden(ids);
  for (let i = 0; i < paare.length; i++) {
    await tx`insert into tco.turnier_spiele (turnier_id, runde_id, feld, runde, pos, gruppe, a, b)
             values (${t.id}, ${r.id}, 'gruppe', ${r.nr}, ${i + 1}, ${gruppe}, ${[paare[i][0]]}, ${[paare[i][1]]})`;
  }
}

async function rundeLesen(db: Db, turnierId: number, nr: number): Promise<Runde> {
  const [r] = await db<Runde[]>`select id, turnier_id, nr, monat, beginn, minuten, status from tco.turnier_runden where turnier_id = ${turnierId} and nr = ${nr}`;
  if (!r) throw new BusinessError(`Monat ${nr} gibt es nicht.`, 404);
  return r;
}

async function sperren(tx: Db, id: number): Promise<Turnier> {
  await tx`select id from tco.turniere where id = ${id} for update`;
  const t = await turnierLesen(tx, id);
  if (t.modus !== 'liga') throw new BusinessError('Das Turnier ist keine Gruppenliga.');
  return t;
}

// ------------------------------------------------------------------ Live
async function live(db: Db, t: Turnier): Promise<LigaLiveDaten> {
  const runden = await rundenLesen(db, t.id);
  const ein = await einteilungLesen(db, t.id);
  const spiele = (await spieleLesen(db, t.id)).filter((s) => s.feld === 'gruppe');
  const verlauf: LigaLiveDaten['verlauf'] = {};
  const lr: LigaRunde[] = runden.map((r) => {
    const sp = spiele.filter((s) => s.runde_id === r.id);
    const gruppen = gruppenDerRunde(ein, r.id);
    for (const [i, ids] of gruppen.entries()) for (const id of ids) (verlauf[id] ??= []).push({ nr: r.nr, monat: r.monat, gruppe: i + 1 });
    return {
      nr: r.nr, monat: r.monat, status: r.status, spiele: sp.length, offen: sp.filter((s) => s.wertung === 'offen').length,
      gruppen: tabellen(gruppen, sp).map((tabelle, i) => ({
        gruppe: i + 1, tabelle,
        spiele: sp.filter((s) => s.gruppe === i + 1).map(({ id, gruppe, pos, a, b, saetze, wertung, sieger, bemueht }) => ({ id, gruppe, pos, a, b, saetze, wertung, sieger, bemueht })),
      })),
    };
  });
  const ids = [...new Set(ein.map((e) => e.teilnehmer_id))];
  return { einstellungen: ligaEinstellungen(t), aktuell: runden.at(-1)?.nr ?? null, runden: lr, gesamt: gesamtWertung(spiele, ids), verlauf };
}

// ------------------------------------------------------------------ Routen
const idParam = z.object({ id: z.coerce.number().int().positive() });
const nrParam = idParam.extend({ nr: z.coerce.number().int().positive() });
const benutzer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'Turnierleitung';

const versuche = new Map<string, { n: number; bis: number }>();
function limit(schluessel: string, max: number) {
  const jetzt = Date.now();
  const v = versuche.get(schluessel);
  const cur = v && v.bis > jetzt ? v : { n: 0, bis: jetzt + 60 * 60_000 };
  cur.n++;
  versuche.set(schluessel, cur);
  if (cur.n > max) throw new BusinessError('Zu viele Versuche – bitte später erneut versuchen.', 429);
}

async function routes(app: FastifyInstance) {
  const anzeigen = { preHandler: requireAuth(P_TURNIER.display) };
  const pflegen = { preHandler: requireAuth(P_TURNIER.edit) };

  app.get('/turniere/:id/liga/vorschau', anzeigen, async (req) => {
    const { id } = idParam.parse(req.params);
    return vorschau(DB, await turnierLesen(DB, id));
  });

  app.post('/turniere/:id/liga/runde', pflegen, async (req) => change(req, async (tx) => {
    const { id } = idParam.parse(req.params);
    const t = await sperren(tx, id);
    const v = await vorschau(tx, t);
    if (!v.moeglich) throw new BusinessError(v.hinweis ?? 'Die Runde lässt sich nicht starten.');
    const [r] = await tx<Runde[]>`insert into tco.turnier_runden (turnier_id, nr, monat, status) values (${id}, ${v.nr}, ${v.monat}, 'laeuft') returning *`;
    for (const g of v.gruppen) {
      for (const [pos, p] of g.personen.entries()) {
        await tx`insert into tco.turnier_einteilung (runde_id, teilnehmer_id, gruppe, pos) values (${r.id}, ${p.id}, ${g.gruppe}, ${pos})`;
      }
      await gruppenSpieleAnlegen(tx, t, r, g.gruppe, g.personen.map((p) => p.id));
    }
    if (t.status === 'entwurf' || t.status === 'anmeldung') await tx`update tco.turniere set status = 'laeuft' where id = ${id}`;
    return { nr: r.nr, monat: r.monat, gruppen: v.gruppen.length };
  }, { action: 'TURNIER_LIGA_RUNDE' }));

  /** Person vor dem ersten Ergebnis in eine andere Gruppe schieben; Spiele beider Gruppen werden neu angelegt */
  app.put('/turniere/:id/liga/runde/:nr/einteilung', pflegen, async (req) => {
    const { id, nr } = nrParam.parse(req.params);
    const d = z.object({ teilnehmer_id: z.number().int().positive(), gruppe: z.number().int().positive() }).parse(req.body);
    return change(req, async (tx) => {
      const t = await sperren(tx, id);
      const r = await rundeLesen(tx, id, nr);
      if (r.status !== 'laeuft') throw new BusinessError('Die Einteilung lässt sich nur in einem laufenden Monat ändern.');
      const ein = (await einteilungLesen(tx, id)).filter((e) => e.runde_id === r.id);
      const ich = ein.find((e) => e.teilnehmer_id === d.teilnehmer_id);
      if (!ich) throw new BusinessError('Diese Person ist in diesem Monat nicht eingeteilt.');
      const anzahl = Math.max(...ein.map((e) => e.gruppe));
      if (d.gruppe > anzahl) throw new BusinessError(`Es gibt nur ${anzahl} Gruppen.`);
      if (d.gruppe === ich.gruppe) return { ok: true };
      if (ein.filter((e) => e.gruppe === ich.gruppe).length <= 2) throw new BusinessError('Die Gruppe würde zu klein.');
      const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from tco.turnier_spiele where runde_id = ${r.id}
                                                 and gruppe = any(${[ich.gruppe, d.gruppe]}) and wertung <> 'offen'`;
      if (n) throw new BusinessError('In einer der beiden Gruppen gibt es schon Ergebnisse – die Einteilung lässt sich nicht mehr ändern.');
      await tx`delete from tco.turnier_spiele where runde_id = ${r.id} and gruppe = any(${[ich.gruppe, d.gruppe]})`;
      const pos = Math.max(-1, ...ein.filter((e) => e.gruppe === d.gruppe).map((e) => e.pos)) + 1;
      await tx`update tco.turnier_einteilung set gruppe = ${d.gruppe}, pos = ${pos} where runde_id = ${r.id} and teilnehmer_id = ${d.teilnehmer_id}`;
      const neu = (await einteilungLesen(tx, id)).filter((e) => e.runde_id === r.id);
      for (const g of [ich.gruppe, d.gruppe]) await gruppenSpieleAnlegen(tx, t, r, g, neu.filter((e) => e.gruppe === g).map((e) => e.teilnehmer_id));
      return { ok: true };
    }, { action: 'TURNIER_LIGA_EINTEILUNG' });
  });

  app.post('/turniere/:id/liga/runde/:nr/abschliessen', pflegen, async (req) => {
    const { id, nr } = nrParam.parse(req.params);
    return change(req, async (tx) => {
      await sperren(tx, id);
      const r = await rundeLesen(tx, id, nr);
      if (r.status === 'abgeschlossen') throw new BusinessError(`Monat ${nr} ist bereits abgeschlossen.`);
      const wo = await tx`update tco.turnier_spiele set wertung = 'wo', sieger = bemueht, saetze = null, eingetragen_von = ${ABSCHLUSS}, eingetragen_am = now()
                          where runde_id = ${r.id} and wertung = 'offen' and bemueht in ('a', 'b')`;
      const keine = await tx`update tco.turnier_spiele set wertung = 'keine', sieger = null, saetze = null, eingetragen_von = ${ABSCHLUSS}, eingetragen_am = now()
                             where runde_id = ${r.id} and wertung = 'offen'`;
      await tx`update tco.turnier_runden set status = 'abgeschlossen' where id = ${r.id}`;
      return { kampflos: wo.count, keine: keine.count };
    }, { action: 'TURNIER_LIGA_ABSCHLUSS' });
  });

  app.post('/turniere/:id/liga/runde/:nr/oeffnen', pflegen, async (req) => {
    const { id, nr } = nrParam.parse(req.params);
    return change(req, async (tx) => {
      await sperren(tx, id);
      const r = await rundeLesen(tx, id, nr);
      if (r.status !== 'abgeschlossen') throw new BusinessError(`Monat ${nr} ist nicht abgeschlossen.`);
      const [folge] = await tx`select 1 from tco.turnier_runden where turnier_id = ${id} and nr > ${nr}`;
      if (folge) throw new BusinessError('Es gibt schon einen Folgemonat – dieser Monat lässt sich nicht mehr öffnen.');
      // beim Abschluss automatisch gewertete Spiele wieder offen
      await tx`update tco.turnier_spiele set wertung = 'offen', sieger = null, saetze = null, eingetragen_von = ${benutzer(req)}, eingetragen_am = now()
               where runde_id = ${r.id} and eingetragen_von = ${ABSCHLUSS}`;
      await tx`update tco.turnier_runden set status = 'laeuft' where id = ${r.id}`;
      return { ok: true };
    }, { action: 'TURNIER_LIGA_OEFFNEN' });
  });

  app.put('/turniere/:id/liga/spiele/:sid/bemueht', pflegen, async (req) => {
    const { id, sid } = idParam.extend({ sid: z.coerce.number().int().positive() }).parse(req.params);
    const { bemueht } = z.object({ bemueht: z.enum(['a', 'b', 'beide']).nullable() }).parse(req.body);
    return change(req, async (tx) => {
      const r = await tx`update tco.turnier_spiele set bemueht = ${bemueht} where id = ${sid} and turnier_id = ${id} and feld = 'gruppe' and wertung = 'offen'`;
      if (!r.count) throw new BusinessError('Spiel nicht gefunden oder bereits gewertet.');
      return { ok: true };
    }, { action: 'TURNIER_LIGA_BEMUEHT' });
  });

  /** persönlicher Link: eigene Seite als „bemüht“ markieren; hat die andere Seite schon gesetzt → 'beide' */
  app.post('/turnier/liga/zugang/:schluessel/bemueht', async (req) => {
    limit(`${req.ip}|turnierlink-bemueht`, 120);
    const { schluessel } = z.object({ schluessel: z.string().max(80) }).parse(req.params);
    const { spiel_id } = z.object({ spiel_id: z.number().int().positive() }).parse(req.body);
    const ich = await teilnehmerZumZugang(DB, schluessel);
    const bemueht = await withChange({ userId: null, username: `turnier:${ich.id}`, action: 'TURNIER_LIGA_BEMUEHT', reason: `persönlicher Link ${vollname(ich)}` }, async (tx) => {
      const [s] = await tx<(Spiel & { rstatus: string | null })[]>`select s.*, r.status as rstatus from tco.turnier_spiele s left join tco.turnier_runden r on r.id = s.runde_id
                                                                    where s.id = ${spiel_id} and s.turnier_id = ${ich.turnier_id} and s.feld = 'gruppe' for update of s`;
      if (!s || ![...s.a, ...s.b].includes(ich.id)) throw new BusinessError('Spiel nicht gefunden.', 404);
      if (s.rstatus !== 'laeuft') throw new BusinessError('Der Monat ist abgeschlossen – bitte an die Turnierleitung wenden.');
      if (s.wertung !== 'offen') throw new BusinessError('Für dieses Spiel gibt es schon ein Ergebnis.');
      const meine = s.a.includes(ich.id) ? 'a' : 'b';
      const neu = s.bemueht == null || s.bemueht === meine ? meine : 'beide';
      if (neu !== s.bemueht) await tx`update tco.turnier_spiele set bemueht = ${neu} where id = ${s.id}`;
      return neu;
    });
    return { ok: true, bemueht, text: 'Danke – dein Bemühen um einen Termin ist vermerkt.' };
  });
}

export const LIGA: ModusDef = { live, routes };
