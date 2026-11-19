/**
 * Turniere – Modus „spass“: Doppel-/Mixed-Spaßturnier mit Zeitrunden.
 *
 * Ablauf: Runde auslosen (Pausen + Paarungen, siehe spass-logik.ts) → starten (Countdown) → Ergebnisse (Spiele je Team)
 * über Verwaltung, persönlichen Link oder Platz-QR → abschließen (offene Spiele bleiben ungewertet) → nächste Runde.
 *
 * Pausenwunsch für die nächste Runde: Spalte tco.turnier_teilnehmer.pause_naechste (Migration 101). Beim Auslosen
 * wandert er nach turnier_einteilung.pause_gewuenscht und wird zurückgesetzt; wird die noch nicht gestartete Runde
 * gelöscht, lebt er wieder auf. (Bewusst nicht in turniere.einstellungen: die werden beim Speichern der Turnierdaten
 * als Ganzes überschrieben und sind öffentlich sichtbar.)
 *
 * Routen (Prefix /api/m/tco):
 *  Verwaltung  POST   /turniere/:id/spass/runde                 nächste Runde auslosen (vorige muss abgeschlossen sein)
 *              POST   /turniere/:id/spass/runde/:nr/start       Runde starten (Beginn = jetzt)
 *              POST   /turniere/:id/spass/runde/:nr/abschliessen
 *              DELETE /turniere/:id/spass/runde/:nr             noch nicht gestartete Runde löschen (danach neu losen)
 *              PUT    /turniere/:id/spass/pause                 { teilnehmer_id, pause }
 *              POST   /turniere/:id/spass/qr                    neuer Platz-Link + QR-Code (alter Link wird ungültig)
 *  öffentlich  GET    /turnier/spass/zugang/:schluessel         Pausenwunsch und eigener Platz (persönlicher Link)
 *              POST   /turnier/spass/zugang/:schluessel/pause   { pause }
 *              GET    /turnier/spass/platz/:kennung?k=…         aktuelle Runde für die Eingabe am Platz
 *              POST   /turnier/spass/platz/:kennung/ergebnis    { k, spiel_id, spiele_a, spiele_b }
 */
import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { withChange } from '../../../../server/src/db.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { portalUrl } from '../../../../server/src/kennwort.js';
import { DB, type Db } from '../verein.js';
import {
  aktiveTeilnehmer, ergebnisSpeichern, P_TURNIER, platzSchluesselErzeugen, platzSchluesselPruefen, rundenLesen, spieleLesen,
  teilnehmerLesen, teilnehmerZumZugang, turnierLesen, type ModusDef,
} from './daten.js';
import { historieAus, rangliste, rundeAuslosen, type SpassLiveDaten, type SpassPlatzAntwort, type SpassRundeDaten, type SpassZugangAntwort } from './spass-logik.js';
import { kurzname, STANDARD_EINSTELLUNGEN, vollname, type Modus, type Runde, type Spiel, type SpassEinstellungen, type Turnier } from './typen.js';

export function spassEinstellungen(t: Pick<Turnier, 'einstellungen'>): SpassEinstellungen {
  const e = { ...STANDARD_EINSTELLUNGEN.spass, ...(t.einstellungen as Partial<SpassEinstellungen>) };
  const zahl = (v: unknown, min: number, max: number, std: number) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : std;
  };
  return {
    plaetze: zahl(e.plaetze, 1, 64, STANDARD_EINSTELLUNGEN.spass.plaetze),
    minuten: zahl(e.minuten, 1, 240, STANDARD_EINSTELLUNGEN.spass.minuten),
    runden: zahl(e.runden, 0, 99, STANDARD_EINSTELLUNGEN.spass.runden),
  };
}

const ende = (r: Pick<Runde, 'beginn' | 'minuten'>) => (r.beginn ? new Date(new Date(r.beginn).getTime() + (r.minuten ?? 0) * 60_000).toISOString() : null);
const iso = (v: string | Date | null) => (v ? new Date(v).toISOString() : null);

async function einteilungLesen(db: Db, turnierId: number) {
  return db<{ runde_id: number; teilnehmer_id: number; pause: boolean; pause_gewuenscht: boolean }[]>`
    select e.runde_id, e.teilnehmer_id, e.pause, e.pause_gewuenscht from tco.turnier_einteilung e
    join tco.turnier_runden r on r.id = e.runde_id where r.turnier_id = ${turnierId}`;
}

async function pauseNaechsteLesen(db: Db, turnierId: number): Promise<number[]> {
  const r = await db<{ id: number }[]>`select id from tco.turnier_teilnehmer where turnier_id = ${turnierId} and status = 'gemeldet' and pause_naechste order by id`;
  return r.map((x) => x.id);
}

function rundeDaten(r: Runde, spiele: Spiel[], einteilung: Awaited<ReturnType<typeof einteilungLesen>>): SpassRundeDaten {
  const e = einteilung.filter((x) => x.runde_id === r.id);
  return {
    id: r.id, nr: r.nr, status: r.status, beginn: iso(r.beginn), minuten: r.minuten ?? 0, endeUm: ende(r),
    plaetze: spiele.filter((s) => s.runde_id === r.id).sort((x, y) => (x.platz ?? 0) - (y.platz ?? 0))
      .map((s) => ({ spiel_id: s.id, platz: s.platz ?? 0, a: s.a, b: s.b, saetze: s.saetze, wertung: s.wertung, sieger: s.sieger })),
    pausen: e.filter((x) => x.pause).map((x) => x.teilnehmer_id),
    pausen_gewuenscht: e.filter((x) => x.pause_gewuenscht).map((x) => x.teilnehmer_id),
  };
}

export async function spassLive(db: Db, t: Turnier): Promise<SpassLiveDaten> {
  const einst = spassEinstellungen(t);
  const runden = await rundenLesen(db, t.id);
  const spiele = (await spieleLesen(db, t.id)).filter((s) => s.feld === 'runde');
  const einteilung = await einteilungLesen(db, t.id);
  const tn = (await teilnehmerLesen(db, t.id)).filter((x) => x.status !== 'abgemeldet');
  const h = historieAus(spiele, einteilung.filter((x) => x.pause).map((x) => x.teilnehmer_id));
  const ids = new Set([...tn.filter((x) => x.status === 'gemeldet').map((x) => x.id), ...h.gespielt.keys()]);
  const letzte = runden.at(-1);
  return {
    einstellungen: einst,
    runde: letzte ? rundeDaten(letzte, spiele, einteilung) : null,
    runden: runden.map((r) => {
      const s = spiele.filter((x) => x.runde_id === r.id);
      return { nr: r.nr, status: r.status, beginn: iso(r.beginn), minuten: r.minuten ?? 0, spiele: s.length, gewertet: s.filter((x) => x.wertung === 'gespielt').length };
    }),
    rangliste: rangliste(spiele, [...ids], h),
    pause_naechste: await pauseNaechsteLesen(db, t.id),
    fertig: einst.runden > 0 && runden.filter((r) => r.status === 'abgeschlossen').length >= einst.runden,
  };
}

async function spassTurnier(db: Db, id: number) {
  const t = await turnierLesen(db, id);
  if (t.modus !== 'spass') throw new BusinessError('Das ist kein Spaßturnier.');
  return t;
}

async function rundeZurNr(db: Db, turnierId: number, nr: number, sperren = false) {
  const [r] = sperren
    ? await db<Runde[]>`select * from tco.turnier_runden where turnier_id = ${turnierId} and nr = ${nr} for update`
    : await db<Runde[]>`select * from tco.turnier_runden where turnier_id = ${turnierId} and nr = ${nr}`;
  if (!r) throw new BusinessError(`Runde ${nr} gibt es nicht.`, 404);
  return r;
}

/** nächste Runde auslosen und speichern; liefert die Rundennummer */
export async function naechsteRunde(tx: Db, turnierId: number, rnd: () => number = Math.random): Promise<{ nr: number; spiele: number; pausen: number }> {
  await tx`select id from tco.turniere where id = ${turnierId} for update`;
  const t = await spassTurnier(tx, turnierId);
  if (t.status === 'beendet') throw new BusinessError('Das Turnier ist beendet.');
  const einst = spassEinstellungen(t);
  const runden = await rundenLesen(tx, t.id);
  const letzte = runden.at(-1);
  if (letzte && letzte.status !== 'abgeschlossen') throw new BusinessError(`Bitte zuerst Runde ${letzte.nr} abschließen.`);
  if (einst.runden > 0 && runden.length >= einst.runden) throw new BusinessError(`Alle ${einst.runden} Runden sind gespielt – für weitere Runden bitte die Rundenzahl in den Einstellungen erhöhen.`);
  const personen = (await aktiveTeilnehmer(tx, t.id)).map((x) => x.id);
  const wunsch = (await pauseNaechsteLesen(tx, t.id)).filter((id) => personen.includes(id));
  const spiele = (await spieleLesen(tx, t.id)).filter((s) => s.feld === 'runde');
  const pausen = (await einteilungLesen(tx, t.id)).filter((x) => x.pause).map((x) => x.teilnehmer_id);
  const los = rundeAuslosen({ personen, pauseWunsch: wunsch, historie: historieAus(spiele, pausen), plaetze: einst.plaetze, rnd });
  if (!los.spiele.length) throw new BusinessError(`Zu wenige Personen für ein Doppel: ${personen.length - wunsch.length} verfügbar, mindestens 4 nötig.`);
  const nr = (letzte?.nr ?? 0) + 1;
  const [r] = await tx<{ id: number }[]>`insert into tco.turnier_runden (turnier_id, nr, minuten, status) values (${t.id}, ${nr}, ${einst.minuten}, 'geplant') returning id`;
  const pauseSet = new Set(los.pause), wunschSet = new Set(los.pauseGewuenscht);
  for (const id of personen) {
    await tx`insert into tco.turnier_einteilung (runde_id, teilnehmer_id, pause, pause_gewuenscht) values (${r.id}, ${id}, ${pauseSet.has(id)}, ${wunschSet.has(id)})`;
  }
  for (const s of los.spiele) {
    await tx`insert into tco.turnier_spiele (turnier_id, runde_id, feld, runde, pos, platz, a, b)
             values (${t.id}, ${r.id}, 'runde', ${nr}, ${s.platz}, ${s.platz}, ${s.a}, ${s.b})`;
  }
  await tx`update tco.turnier_teilnehmer set pause_naechste = false where turnier_id = ${t.id} and pause_naechste`;
  // mit der ersten Auslosung läuft das Turnier (öffentliche Live-Ansicht und Platz-Eingabe)
  if (t.status === 'entwurf' || t.status === 'anmeldung') await tx`update tco.turniere set status = 'laeuft' where id = ${t.id}`;
  return { nr, spiele: los.spiele.length, pausen: los.pause.length };
}

/** Ergebnisse nur in gestarteten Runden (nicht in einer erst ausgelosten) */
async function nachErgebnis(tx: Db, _t: Turnier, s: Spiel) {
  if (s.feld !== 'runde' || s.wertung === 'offen' || !s.runde_id) return;
  const [r] = await tx<{ status: string; nr: number }[]>`select status, nr from tco.turnier_runden where id = ${s.runde_id}`;
  if (r?.status === 'geplant') throw new BusinessError(`Runde ${r.nr} ist noch nicht gestartet.`);
}

export const SPASS: ModusDef = {
  live: spassLive,
  nachErgebnis,
  routes: spassRoutes,
};

/** für ergebnisSpeichern ohne Zirkelimport von routes.ts: alle Spaß-Spiele landen im Modus „spass“ */
const NUR_SPASS = { spass: SPASS } as unknown as Record<Modus, ModusDef>;

const versuche = new Map<string, { n: number; bis: number }>();
function limit(schluessel: string, max: number) {
  const jetzt = Date.now();
  const v = versuche.get(schluessel);
  const cur = v && v.bis > jetzt ? v : { n: 0, bis: jetzt + 60 * 60_000 };
  cur.n++;
  versuche.set(schluessel, cur);
  if (cur.n > max) throw new BusinessError('Zu viele Versuche – bitte später erneut versuchen.', 429);
}

const idParam = z.object({ id: z.coerce.number().int().positive() });
const nrParam = z.object({ id: z.coerce.number().int().positive(), nr: z.coerce.number().int().positive() });
const kennungParam = z.object({ kennung: z.string().max(60) });
const schluesselParam = z.object({ schluessel: z.string().max(80) });
const spieleZahl = z.number().int().min(0).max(99);

async function platzLink(kennung: string, schluessel: string) {
  return `${(await portalUrl()) ?? ''}/turnier-platz?t=${encodeURIComponent(kennung)}&k=${encodeURIComponent(schluessel)}`;
}

async function spassRoutes(app: FastifyInstance) {
  const pflegen = { preHandler: requireAuth(P_TURNIER.edit) };

  app.post('/turniere/:id/spass/runde', pflegen, async (req) => {
    const { id } = idParam.parse(req.params);
    return change(req, (tx) => naechsteRunde(tx, id), { action: 'TURNIER_RUNDE' });
  });

  app.post('/turniere/:id/spass/runde/:nr/start', pflegen, async (req) => {
    const { id, nr } = nrParam.parse(req.params);
    return change(req, async (tx) => {
      const t = await spassTurnier(tx, id);
      if (t.status === 'beendet') throw new BusinessError('Das Turnier ist beendet.');
      const r = await rundeZurNr(tx, id, nr, true);
      if (r.status !== 'geplant') throw new BusinessError(`Runde ${nr} ist bereits ${r.status === 'laeuft' ? 'gestartet' : 'abgeschlossen'}.`);
      const [neu] = await tx<Runde[]>`update tco.turnier_runden set status = 'laeuft', beginn = now() where id = ${r.id} returning *`;
      return { ok: true, beginn: iso(neu.beginn), endeUm: ende(neu) };
    }, { action: 'TURNIER_RUNDE' });
  });

  app.post('/turniere/:id/spass/runde/:nr/abschliessen', pflegen, async (req) => {
    const { id, nr } = nrParam.parse(req.params);
    return change(req, async (tx) => {
      await spassTurnier(tx, id);
      const r = await rundeZurNr(tx, id, nr, true);
      if (r.status === 'abgeschlossen') throw new BusinessError(`Runde ${nr} ist bereits abgeschlossen.`);
      await tx`update tco.turnier_runden set status = 'abgeschlossen', beginn = coalesce(beginn, now()) where id = ${r.id}`;
      const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from tco.turnier_spiele where runde_id = ${r.id} and wertung = 'offen'`;
      return { ok: true, offen: n };
    }, { action: 'TURNIER_RUNDE' });
  });

  app.delete('/turniere/:id/spass/runde/:nr', pflegen, async (req) => {
    const { id, nr } = nrParam.parse(req.params);
    return change(req, async (tx) => {
      await spassTurnier(tx, id);
      const r = await rundeZurNr(tx, id, nr, true);
      if (r.status !== 'geplant') throw new BusinessError('Nur eine noch nicht gestartete Runde lässt sich löschen.');
      const [neuer] = await tx`select 1 from tco.turnier_runden where turnier_id = ${id} and nr > ${nr}`;
      if (neuer) throw new BusinessError('Nur die letzte Runde lässt sich löschen.');
      const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from tco.turnier_spiele where runde_id = ${r.id} and wertung <> 'offen'`;
      if (n) throw new BusinessError('In dieser Runde gibt es schon Ergebnisse.');
      // Pausenwünsche dieser Runde gelten wieder für die nächste Auslosung
      await tx`update tco.turnier_teilnehmer set pause_naechste = true
               where id in (select teilnehmer_id from tco.turnier_einteilung where runde_id = ${r.id} and pause_gewuenscht)`;
      await tx`delete from tco.turnier_runden where id = ${r.id}`;
      return { ok: true };
    }, { action: 'TURNIER_RUNDE' });
  });

  app.put('/turniere/:id/spass/pause', pflegen, async (req) => {
    const { id } = idParam.parse(req.params);
    const d = z.object({ teilnehmer_id: z.number().int().positive(), pause: z.boolean() }).parse(req.body);
    return change(req, async (tx) => {
      await spassTurnier(tx, id);
      const r = await tx`update tco.turnier_teilnehmer set pause_naechste = ${d.pause} where id = ${d.teilnehmer_id} and turnier_id = ${id}`;
      if (!r.count) throw new BusinessError('Teilnehmer nicht gefunden.', 404);
      return { ok: true };
    }, { action: 'TURNIER_PAUSE' });
  });

  /** neuer Platz-Link mit QR-Code (SVG als Data-URL); ein älterer Platz-Link wird damit ungültig */
  app.post('/turniere/:id/spass/qr', pflegen, async (req) => {
    const { id } = idParam.parse(req.params);
    const t = await spassTurnier(DB, id);
    const s = await change(req, (tx) => platzSchluesselErzeugen(tx, id), { action: 'TURNIER_PLATZLINK' });
    const link = await platzLink(t.kennung, s);
    const svg = await QRCode.toString(link, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
    return { link, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, absolut: /^https?:\/\//.test(link) };
  });

  // ------------------------------------------------------------------ persönlicher Link
  app.get('/turnier/spass/zugang/:schluessel', async (req): Promise<SpassZugangAntwort> => {
    limit(`${req.ip}|spass-zugang`, 1200);
    const { schluessel } = schluesselParam.parse(req.params);
    const ich = await teilnehmerZumZugang(DB, schluessel);
    const t = await spassTurnier(DB, ich.turnier_id);
    const [{ pause_naechste }] = await DB<{ pause_naechste: boolean }[]>`select pause_naechste from tco.turnier_teilnehmer where id = ${ich.id}`;
    const live = await spassLive(DB, t);
    const namen = new Map((await teilnehmerLesen(DB, t.id)).map((x) => [x.id, vollname(x)]));
    const r = live.runde;
    const mein = r?.plaetze.find((p) => p.a.includes(ich.id) || p.b.includes(ich.id));
    const seite: 'a' | 'b' | null = mein ? (mein.a.includes(ich.id) ? 'a' : 'b') : null;
    return {
      pause_naechste,
      fertig: live.fertig,
      runde: r ? { nr: r.nr, status: r.status, beginn: r.beginn, minuten: r.minuten, endeUm: r.endeUm, pause: r.pausen.includes(ich.id) } : null,
      platz: mein && seite ? {
        spiel_id: mein.spiel_id, platz: mein.platz, seite,
        partner: (seite === 'a' ? mein.a : mein.b).filter((x) => x !== ich.id).map((x) => namen.get(x) ?? '?'),
        gegner: (seite === 'a' ? mein.b : mein.a).map((x) => namen.get(x) ?? '?'),
        saetze: mein.saetze, wertung: mein.wertung,
      } : null,
      rang: live.rangliste.find((x) => x.teilnehmer_id === ich.id) ?? null,
    };
  });

  app.post('/turnier/spass/zugang/:schluessel/pause', async (req) => {
    limit(`${req.ip}|spass-post`, 300);
    const { schluessel } = schluesselParam.parse(req.params);
    const { pause } = z.object({ pause: z.boolean() }).parse(req.body);
    const ich = await teilnehmerZumZugang(DB, schluessel);
    await spassTurnier(DB, ich.turnier_id);
    await withChange({ userId: null, username: `turnier:${ich.id}`, action: 'TURNIER_PAUSE', reason: `persönlicher Link ${vollname(ich)}` },
      (tx) => tx`update tco.turnier_teilnehmer set pause_naechste = ${pause} where id = ${ich.id}`);
    return { ok: true, pause_naechste: pause };
  });

  // ------------------------------------------------------------------ Platz-QR
  app.get('/turnier/spass/platz/:kennung', async (req) => {
    limit(`${req.ip}|spass-platz`, 3000);
    const { kennung } = kennungParam.parse(req.params);
    const { k } = z.object({ k: z.string().max(80) }).parse(req.query);
    const t = await platzSchluesselPruefen(DB, kennung, k);
    return platzDaten(DB, t);
  });

  app.post('/turnier/spass/platz/:kennung/ergebnis', async (req) => {
    limit(`${req.ip}|spass-post`, 300);
    const { kennung } = kennungParam.parse(req.params);
    const d = z.object({ k: z.string().max(80), spiel_id: z.number().int().positive(), spiele_a: spieleZahl, spiele_b: spieleZahl }).parse(req.body);
    const t = await platzSchluesselPruefen(DB, kennung, d.k);
    if (t.modus !== 'spass') throw new BusinessError('Das ist kein Spaßturnier.');
    await withChange({ userId: null, username: 'turnier:platz', action: 'TURNIER_ERGEBNIS', reason: `Platz-QR ${t.kennung}` }, async (tx) => {
      const [s] = await tx<{ status: string; nr: number; platz: number | null }[]>`
        select r.status, r.nr, s.platz from tco.turnier_spiele s join tco.turnier_runden r on r.id = s.runde_id
        where s.id = ${d.spiel_id} and s.turnier_id = ${t.id} and s.feld = 'runde'`;
      if (!s) throw new BusinessError('Spiel nicht gefunden.', 404);
      if (s.status !== 'laeuft') throw new BusinessError(s.status === 'geplant' ? `Runde ${s.nr} ist noch nicht gestartet.` : `Runde ${s.nr} ist abgeschlossen – bitte an die Turnierleitung wenden.`);
      return ergebnisSpeichern(tx, NUR_SPASS, d.spiel_id, { wertung: 'gespielt', saetze: [[d.spiele_a, d.spiele_b]] }, { von: `Platz ${s.platz ?? ''}`.trim(), turnierId: t.id });
    });
    return { ok: true, ...(await platzDaten(DB, t)) };
  });
}

/** Daten für die Eingabe am Platz: aktuelle Runde mit Kurznamen der Spielenden */
async function platzDaten(db: Db, t: Turnier): Promise<SpassPlatzAntwort> {
  const live = await spassLive(db, t);
  const namen = new Map((await teilnehmerLesen(db, t.id)).map((x) => [x.id, kurzname(x)]));
  const r = live.runde;
  const n = (ids: number[]) => ids.map((x) => namen.get(x) ?? '?');
  return {
    turnier: { name: t.name, kennung: t.kennung, status: t.status },
    runde: r ? {
      nr: r.nr, status: r.status, beginn: r.beginn, minuten: r.minuten, endeUm: r.endeUm,
      plaetze: r.plaetze.map((p) => ({ ...p, namen_a: n(p.a), namen_b: n(p.b) })),
      pausen: n(r.pausen),
    } : null,
    stand: new Date().toISOString(),
  };
}

