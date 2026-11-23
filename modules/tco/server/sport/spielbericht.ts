/**
 * Spielberichte (Sport → Spielberichte): Mannschaftsspieltage und Meldelisten aus STB.LIGA.NU übernehmen, je Spieltag
 * den Spielbericht nach dem DTB-Formular erfassen, von beiden Mannschaftsführern freigeben lassen und einreichen.
 *
 * Unterkapitel Import (eingefügte Tabelle, wie die Massenanlage im Vereinskalender):
 *  - Spieltage: Spielplan Tag | Datum | Uhrzeit | Nr. | Halle | Platz | Liga | Heim | Gast (`kalender/spielplan.ts`);
 *    gleiche Begegnung (Datum, Liga, Heim, Gast) wird aktualisiert statt doppelt angelegt.
 *  - Meldelisten: Rang | Mannschaft | LK | ID-Nummer | Name, Vorname | Nation (`meldeliste.ts`) je Saison, Verein und
 *    Konkurrenz; ein erneuter Import ersetzt die Liste. Spielberichte behalten die Spieler, wie sie aufgestellt wurden.
 *
 * Zuordnung Spieltag → Meldeliste: Verein und Mannschaftsnummer aus dem Mannschaftsnamen („TC Oberthal 2“), Konkurrenz
 * = längster Listenname, der in der Liga vorkommt („Herren 40“ in „Herren 40 Verbandsliga“).
 */
import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import { condense } from '../format.js';
import { spielplanLesen } from '../kalender/spielplan.js';
import { konkurrenzZurLiga, meldelisteLesen } from './meldeliste.js';
import { berichtWerten, leererBericht, saisonZu, vereinUndNummer, type SbDaten, type SbSpieler } from './spielbericht-logik.js';

const zeitText = (v: unknown) => (v == null ? null : String(v));

// ---------------------------------------------------------------- Spieltage

export interface SpieltagImport { datum: string; uhrzeit: string | null; nr: string; halle: string; platz: string; liga: string; heim: string; gast: string }

/** Eingefügten Spielplan lesen – schreibt nichts; je Zeile „neu“, „vorhanden“ (wird aktualisiert) oder Fehler */
export async function spieltageVorschau(db: Db, text: string) {
  const { zeilen, ignoriert } = spielplanLesen(text);
  if (zeilen.length > 300) throw new BusinessError(`Der Text enthält ${zeilen.length} Spieltage – höchstens 300 je Import.`);
  const ok = zeilen.filter((z) => !z.fehler && z.heim && z.gast);
  const da = ok.length
    ? await db`select datum::text as datum, liga, heim, gast from tco.sb_spieltage
                where datum = any(${ok.map((z) => z.datum)}::date[])`
    : [];
  const k = (z: { datum: string; liga: string; heim: string; gast: string }) => `${z.datum}|${z.liga}|${z.heim}|${z.gast}`.toLowerCase();
  const vorhanden = new Set(da.map((r) => k(r as never)));
  return {
    ignoriert,
    zeilen: zeilen.map((z) => ({
      ...z,
      fehler: z.fehler ?? (!z.heim || !z.gast ? 'Heim- oder Gastmannschaft fehlt' : null),
      saison: z.datum ? saisonZu(z.datum) : '',
      status: z.fehler || !z.heim || !z.gast ? 'fehler' : vorhanden.has(k(z)) ? 'vorhanden' : 'neu',
    })),
  };
}

export async function spieltageImportieren(tx: Db, zeilen: SpieltagImport[]): Promise<string> {
  let neu = 0, aktualisiert = 0;
  for (const z of zeilen) {
    const [r] = await tx`
      insert into tco.sb_spieltage (saison, datum, uhrzeit, nr, halle, platz, liga, heim, gast)
      values (${saisonZu(z.datum)}, ${z.datum}, ${z.uhrzeit}, ${z.nr}, ${z.halle}, ${z.platz}, ${condense(z.liga)}, ${condense(z.heim)}, ${condense(z.gast)})
      on conflict (datum, liga, heim, gast) do update set uhrzeit = excluded.uhrzeit, nr = excluded.nr, halle = excluded.halle, platz = excluded.platz
      returning (xmax = 0) as neu`;
    if (r.neu) neu++; else aktualisiert++;
  }
  return `${neu} Spieltag${neu === 1 ? '' : 'e'} angelegt, ${aktualisiert} aktualisiert.`;
}

export async function spieltagLoeschen(tx: Db, id: number): Promise<string> {
  const [b] = await tx`select status from tco.sb_berichte where spieltag_id = ${id}`;
  if (b) throw new BusinessError('Zu diesem Spieltag gibt es schon einen Spielbericht – er kann nicht gelöscht werden.');
  const [r] = await tx`delete from tco.sb_spieltage where id = ${id} returning heim, gast`;
  if (!r) throw new BusinessError('Spieltag nicht gefunden.', 404);
  return `Spieltag ${r.heim} – ${r.gast} gelöscht.`;
}

interface ListeKopf { id: number; saison: string; verein: string; konkurrenz: string; spieler: number }

/** passende Meldeliste zu einer Mannschaft im Spieltag */
function listeZu<T extends ListeKopf>(listen: T[], saison: string, team: string, liga: string): T | null {
  const { verein } = vereinUndNummer(team);
  return konkurrenzZurLiga(liga, listen.filter((l) => l.saison === saison && l.verein.toLowerCase() === verein.toLowerCase()));
}

export async function spieltageLesen(db: Db) {
  const rows = await db`
    select s.id, s.saison, s.datum::text as datum, s.uhrzeit, s.nr, s.halle, s.platz, s.liga, s.heim, s.gast,
           b.status, b.daten, b.heim_name, b.gast_name
      from tco.sb_spieltage s left join tco.sb_berichte b on b.spieltag_id = s.id
     order by s.datum desc, s.uhrzeit nulls last, s.id`;
  const listen = await listenLesen(db);
  return {
    saisons: [...new Set(rows.map((r) => r.saison as string))],
    zeilen: rows.map((r) => {
      const w = r.daten ? berichtWerten(r.daten as SbDaten) : null;
      return {
        id: r.id, saison: r.saison, datum: r.datum, uhrzeit: zeitText(r.uhrzeit), nr: r.nr, halle: r.halle, platz: r.platz, liga: r.liga, heim: r.heim, gast: r.gast,
        status: (r.status ?? 'kein') as 'kein' | 'entwurf' | 'eingereicht',
        punkte: w && w.fertig ? w.summe.punkte : null, fertig: w?.fertig ?? 0, anzahl: w?.anzahl ?? 0,
        freigaben: (r.heim_name ? 1 : 0) + (r.gast_name ? 1 : 0),
        listeHeim: listeZu(listen, r.saison, r.heim, r.liga)?.id ?? null, listeGast: listeZu(listen, r.saison, r.gast, r.liga)?.id ?? null,
      };
    }),
  };
}

// ---------------------------------------------------------------- Meldelisten

export async function listenLesen(db: Db): Promise<(ListeKopf & { stand: string })[]> {
  const rows = await db`
    select l.id, l.saison, l.verein, l.konkurrenz, l.updated_at::text as stand, count(p.rang)::int as spieler
      from tco.sb_meldelisten l left join tco.sb_meldespieler p on p.liste_id = l.id
     group by l.id order by l.saison desc, lower(l.verein), lower(l.konkurrenz)`;
  return rows as never;
}

export async function listeLesen(db: Db, id: number) {
  const [l] = await db`select id, saison, verein, konkurrenz, updated_at::text as stand from tco.sb_meldelisten where id = ${id}`;
  if (!l) throw new BusinessError('Meldeliste nicht gefunden.', 404);
  // Mitglied über die ID-Nr. aus den nuLiga-Spielerdaten
  const spieler = await db`
    select p.rang, p.mannschaft, p.nachname, p.vorname, p.id_nr, p.lk::float8 as lk, p.nation,
           (select m.adrnr from tco.mitgliedera a join tco.mitglieder m on m.adrnr = a.adrnr where a.id_nr = p.id_nr limit 1) as adrnr
      from tco.sb_meldespieler p where p.liste_id = ${id} order by p.rang`;
  return { ...l, spieler };
}

/** Meldeliste lesen (Vorschau) – schreibt nichts */
export function listeVorschau(text: string) {
  const r = meldelisteLesen(text);
  if (r.spieler.length > 300) throw new BusinessError('Höchstens 300 Spieler je Meldeliste.');
  return r;
}

export async function listeSpeichern(tx: Db, b: { saison: string; verein: string; konkurrenz: string; text: string }): Promise<{ id: number; text: string }> {
  const r = listeVorschau(b.text);
  if (r.fehler.length) throw new BusinessError(`Die Meldeliste enthält Fehler:\n${r.fehler.slice(0, 5).map((f) => `Zeile ${f.zeile}: ${f.text}`).join('\n')}`);
  if (!r.spieler.length) throw new BusinessError('In der Tabelle wurden keine Spieler erkannt (Rang und Name je Zeile).');
  const saison = condense(b.saison), verein = condense(b.verein), konkurrenz = condense(b.konkurrenz);
  const [l] = await tx`
    insert into tco.sb_meldelisten (saison, verein, konkurrenz) values (${saison}, ${verein}, ${konkurrenz})
    on conflict (saison, verein, konkurrenz) do update set updated_at = now() returning id`;
  await tx`delete from tco.sb_meldespieler where liste_id = ${l.id}`;
  const s = r.spieler;
  // leere Werte als '' übergeben und in SQL zu null machen (Listen mit null-Einträgen vermeiden)
  const t = (v: unknown) => (v == null ? '' : String(v));
  await tx`
    insert into tco.sb_meldespieler (liste_id, rang, mannschaft, nachname, vorname, id_nr, lk, nation)
    select ${l.id}, u.r, nullif(u.m, '')::int, u.n, u.v, nullif(u.i, ''), nullif(u.l, '')::numeric, u.na
      from unnest(${s.map((x) => x.rang)}::int[], ${s.map((x) => t(x.mannschaft))}::text[], ${s.map((x) => x.nachname)}::text[],
                  ${s.map((x) => x.vorname)}::text[], ${s.map((x) => t(x.id_nr))}::text[], ${s.map((x) => t(x.lk))}::text[],
                  ${s.map((x) => x.nation)}::text[]) as u(r, m, n, v, i, l, na)`;
  return { id: l.id, text: `Meldeliste ${konkurrenz} von ${verein} (${saison}) mit ${s.length} Spieler${s.length === 1 ? '' : 'n'} gespeichert.` };
}

export async function listeLoeschen(tx: Db, id: number): Promise<string> {
  const [r] = await tx`delete from tco.sb_meldelisten where id = ${id} returning verein, konkurrenz`;
  if (!r) throw new BusinessError('Meldeliste nicht gefunden.', 404);
  return `Meldeliste ${r.konkurrenz} von ${r.verein} gelöscht.`;
}

// ---------------------------------------------------------------- Spielbericht

export interface Freigabe { name: string; am: string; von: string }
const freigabe = (r: Record<string, unknown>, k: 'heim' | 'gast' | 'osr'): Freigabe | null =>
  (r[`${k}_name`] ? { name: String(r[`${k}_name`]), am: String(r[`${k}_am`]), von: String(r[`${k}_von`] ?? '') } : null);

async function spieltag(db: Db, id: number) {
  const [s] = await db`select id, saison, datum::text as datum, uhrzeit, nr, halle, platz, liga, heim, gast from tco.sb_spieltage where id = ${id}`;
  if (!s) throw new BusinessError('Spieltag nicht gefunden.', 404);
  return s;
}

export async function berichtLesen(db: Db, id: number) {
  const s = await spieltag(db, id);
  const [b] = await db`select daten, status, heim_name, heim_am::text, heim_von, gast_name, gast_am::text, gast_von, osr_name, osr_am::text, osr_von,
                              eingereicht_am::text, eingereicht_von, updated_at::text as stand
                         from tco.sb_berichte where spieltag_id = ${id}`;
  const listen = await listenLesen(db);
  const seite = async (team: string) => {
    const l = listeZu(listen, s.saison, team, s.liga);
    const spieler: (SbSpieler & { lk: number | null })[] = l
      ? (await db`select rang, mannschaft, nachname, vorname, id_nr, lk::float8 as lk from tco.sb_meldespieler where liste_id = ${l.id} order by rang`)
        .map((p) => ({ rang: p.rang, mannschaft: p.mannschaft, name: condense(`${p.vorname} ${p.nachname}`), id_nr: p.id_nr, lk: p.lk }))
      : [];
    return { team, ...vereinUndNummer(team), liste: l ? { id: l.id, konkurrenz: l.konkurrenz, verein: l.verein } : null, spieler };
  };
  return {
    spieltag: { ...s, uhrzeit: zeitText(s.uhrzeit) },
    heim: await seite(s.heim), gast: await seite(s.gast),
    daten: (b?.daten as SbDaten | undefined) ?? leererBericht(),
    gespeichert: !!b, status: (b?.status ?? 'entwurf') as 'entwurf' | 'eingereicht', stand: b?.stand ?? null,
    freigaben: { heim: b ? freigabe(b, 'heim') : null, gast: b ? freigabe(b, 'gast') : null, osr: b ? freigabe(b, 'osr') : null },
    eingereicht: b?.eingereicht_am ? { am: b.eingereicht_am, von: b.eingereicht_von } : null,
  };
}

async function sperreEingereicht(tx: Db, id: number) {
  const [b] = await tx`select status, daten, heim_name, gast_name, osr_name from tco.sb_berichte where spieltag_id = ${id} for update`;
  if (b?.status === 'eingereicht') throw new BusinessError('Der Spielbericht ist eingereicht und kann nicht mehr geändert werden. Zum Korrigieren zuerst die Einreichung zurücknehmen.');
  return b;
}

/** Entwurf sichern; eine inhaltliche Änderung setzt bereits erteilte Freigaben zurück */
export async function berichtSpeichern(tx: Db, id: number, daten: SbDaten): Promise<string> {
  await spieltag(tx, id);
  const alt = await sperreEingereicht(tx, id);
  const geaendert = !alt || JSON.stringify(alt.daten) !== JSON.stringify(daten);
  if (!geaendert) return 'Keine Änderungen.';
  const [r] = await tx`
    insert into tco.sb_berichte (spieltag_id, daten) values (${id}, ${tx.json(daten as never)})
    on conflict (spieltag_id) do update set daten = excluded.daten,
      heim_name = null, heim_am = null, heim_von = null, gast_name = null, gast_am = null, gast_von = null, osr_name = null, osr_am = null, osr_von = null
    returning (xmax = 0) as neu`;
  if (r.neu) return 'Spielbericht angelegt.';
  return alt.heim_name || alt.gast_name || alt.osr_name ? 'Spielbericht gesichert – die Freigaben wurden zurückgesetzt, weil sich der Inhalt geändert hat.' : 'Spielbericht gesichert.';
}

/** Freigabe statt Unterschrift erteilen oder zurücknehmen (name = null) */
export async function freigeben(tx: Db, id: number, rolle: 'heim' | 'gast' | 'osr', name: string | null, wer: string): Promise<string> {
  const b = await sperreEingereicht(tx, id);
  if (!b) throw new BusinessError('Bitte den Spielbericht zuerst sichern.');
  const n = name ? condense(name) : null;
  if (rolle === 'heim') await tx`update tco.sb_berichte set heim_name = ${n}, heim_am = ${n ? new Date() : null}, heim_von = ${n ? wer : null} where spieltag_id = ${id}`;
  else if (rolle === 'gast') await tx`update tco.sb_berichte set gast_name = ${n}, gast_am = ${n ? new Date() : null}, gast_von = ${n ? wer : null} where spieltag_id = ${id}`;
  else await tx`update tco.sb_berichte set osr_name = ${n}, osr_am = ${n ? new Date() : null}, osr_von = ${n ? wer : null} where spieltag_id = ${id}`;
  const wen = { heim: 'Mannschaftsführer Heim', gast: 'Mannschaftsführer Gast', osr: 'Oberschiedsrichter' }[rolle];
  return n ? `Freigabe ${wen} (${n}) erteilt.` : `Freigabe ${wen} zurückgenommen.`;
}

export async function einreichen(tx: Db, id: number, wer: string): Promise<string> {
  const b = await sperreEingereicht(tx, id);
  if (!b) throw new BusinessError('Bitte den Spielbericht zuerst sichern.');
  const f = b;
  const s = await berichtLesen(tx, id);
  const w = berichtWerten(b.daten as SbDaten, { a: s.heim.nr, b: s.gast.nr });
  const offen = w.pruefungen.filter((p) => !p.ok).map((p) => p.text);
  if (!f.heim_name || !f.gast_name) offen.push('Freigabe durch beide Mannschaftsführer');
  if ((b.daten as SbDaten).osr?.trim() && !f.osr_name) offen.push('Freigabe durch den Oberschiedsrichter');
  if (offen.length) throw new BusinessError(`Der Spielbericht kann noch nicht eingereicht werden:\n– ${offen.join('\n– ')}`);
  await tx`update tco.sb_berichte set status = 'eingereicht', eingereicht_am = now(), eingereicht_von = ${wer} where spieltag_id = ${id}`;
  const p = w.summe.punkte;
  return `Spielbericht ${s.spieltag.heim} – ${s.spieltag.gast} (${p[0]}:${p[1]}) eingereicht.`;
}

export async function zuruecknehmen(tx: Db, id: number): Promise<string> {
  const [r] = await tx`update tco.sb_berichte set status = 'entwurf', eingereicht_am = null, eingereicht_von = null
                        where spieltag_id = ${id} and status = 'eingereicht' returning spieltag_id`;
  if (!r) throw new BusinessError('Der Spielbericht ist nicht eingereicht.');
  return 'Einreichung zurückgenommen – der Spielbericht ist wieder ein Entwurf.';
}
