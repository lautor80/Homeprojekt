/**
 * Mahnwesen – Daten und Lauf: offene Posten lesen, Stand je Posten, Mahnlauf (Vorschlag bzw. Versand), Freigabe eines
 * Vorschlags, Automatik im Hintergrund, Einträge für den Arbeitsvorrat.
 *
 * Absicherung:
 *  - höchstens ein Lauf in Arbeit (eindeutiger Index auf status = 'LAEUFT'); ein hängengebliebener Lauf wird nach 30 Minuten
 *    als abgebrochen vermerkt,
 *  - je Posten und Stufe nur ein Vorschlag bzw. eine zugestellte Mahnung (eindeutiger Index),
 *  - unmittelbar vor dem Senden wird jeder Posten erneut gegen den Zahlungsstand und die Mahnsperren geprüft,
 *  - Systemabsender (persoenlich: false) – auch beim Start von Hand, damit Antworten an die Adresse der Einstellungen gehen.
 *
 * Protokoll (Funktion „Mahnungen in Paperless protokollieren“): Jede Stufe wird als Notiz am Paperless-Dokument des Postens
 * festgehalten, als Anhang dient die dort abgelegte Fassung. Fehler dabei verhindern die Mahnung nie.
 */
import type { FastifyBaseLogger } from 'fastify';
import { withChange } from '../../../../server/src/db.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { appAktiv, funktionAktiv, modulId } from '../../../../server/src/funktionsschalter.js';
import { mailVerfuegbar } from '../../../../server/src/lib/mail.js';
import { DB, paperless, plAktiv, vereinLesen, type Db, type Verein } from '../verein.js';
import { addTage, dat, eur, heute as heuteIso, nameSchoen, runden } from '../format.js';
import { kontaktLesen, mailSenden, type MailAnhang } from '../kommunikation.js';
import { mailtextFuellen } from '../mailtexte.js';
import { adrnrErmitteln } from '../halle/daten.js';
import { paperlessNotiz, rechnungPdfErzeugen } from '../halle/versand.js';
import { belegErzeugen } from '../verzehr/beleg.js';
import {
  ART_TEXT, artenListe, automatikFaellig, F_MAHN_AUTOMATIK, F_MAHN_PAPERLESS, faelligkeit, lokal, mailtextSchluessel, mailWerte, notizText, planen, sperreFuer, standErmitteln, STANDARD_STUFEN, vorschlagAbgleichen,
  type HistorieZeile, type MahnCfg, type MahnMail, type OffenerPosten, type Plan, type PostenArt, type PostenStand, type SperreZeile, type Stufe, type VorschlagZeile,
} from './logik.js';

export interface Wer { id: string | null; name: string }
export const SYSTEM: Wer = { id: null, name: 'system (Mahnlauf)' };
/** höchstens so viele PDF-Anhänge je E-Mail (Größe der Nachricht) */
const MAX_ANHAENGE = 5;

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------

export async function cfgLesen(db: Db = DB): Promise<MahnCfg> {
  const [c] = await db`select aktiv, modus, wochentage, uhrzeit, zahlungsziel_tage, frist_tage, stufen, mindestbetrag::float8 as mindestbetrag, max_je_lauf, arten,
                              halle_gedruckt, anhang, absender, absender_name, antwort_an, kopie_an, letzter_lauf
                         from tco.mahn_cfg where id = 1`;
  const stufen = (Array.isArray(c?.stufen) ? c.stufen as Stufe[] : STANDARD_STUFEN).map((s) => ({ name: String(s.name), tage: Number(s.tage), gebuehr: Number(s.gebuehr) || 0 }));
  return {
    aktiv: !!c?.aktiv, modus: c?.modus === 'SENDEN' ? 'SENDEN' : 'VORSCHLAG', wochentage: c?.wochentage ?? '1', uhrzeit: c?.uhrzeit ?? '08:00',
    zahlungsziel_tage: c?.zahlungsziel_tage ?? null, frist_tage: c?.frist_tage ?? 10, stufen: stufen.length ? stufen : STANDARD_STUFEN,
    mindestbetrag: Number(c?.mindestbetrag ?? 5), max_je_lauf: c?.max_je_lauf ?? 50, arten: c?.arten ?? 'HALLE,VERZEHR', halle_gedruckt: !!c?.halle_gedruckt,
    anhang: c?.anhang !== false, absender: c?.absender ?? '', absender_name: c?.absender_name ?? '', antwort_an: c?.antwort_an ?? '', kopie_an: c?.kopie_an ?? '',
    letzter_lauf: c?.letzter_lauf ? new Date(c.letzter_lauf as string).toISOString() : null,
  };
}

export async function cfgSichern(tx: Db, c: Omit<MahnCfg, 'letzter_lauf'>): Promise<void> {
  await tx`update tco.mahn_cfg set aktiv = ${c.aktiv}, modus = ${c.modus}, wochentage = ${c.wochentage}, uhrzeit = ${c.uhrzeit}, zahlungsziel_tage = ${c.zahlungsziel_tage},
                  frist_tage = ${c.frist_tage}, stufen = ${tx.json(c.stufen as never)}, mindestbetrag = ${c.mindestbetrag}, max_je_lauf = ${c.max_je_lauf}, arten = ${c.arten},
                  halle_gedruckt = ${c.halle_gedruckt}, anhang = ${c.anhang}, absender = ${c.absender}, absender_name = ${c.absender_name},
                  antwort_an = ${c.antwort_an}, kopie_an = ${c.kopie_an}
            where id = 1`;
}

// ---------------------------------------------------------------------------
// Offene Posten, Historie, Sperren
// ---------------------------------------------------------------------------

/**
 * Mahnfähige Posten nach aktuellem Zahlungsstand:
 *  HALLE    Hallenrechnungen „Versendet“ und „Teilbezahlt“ (auf Wunsch auch „Gedruckt“), Rest nach Teilzahlungen > 0 –
 *           „In Bearbeitung“, „Bezahlt“ und „Forderung ausgefallen“ nie
 *  VERZEHR  gestellte Sammelabrechnungen zur Überweisung – nicht die per Lastschrift (sie stecken im nächsten Beitragslauf)
 * `nur` beschränkt auf bestimmte Nummern (Prüfung unmittelbar vor dem Senden).
 */
export async function offenePostenLesen(db: Db, v: Pick<Verein, 'zahlungsziel_tage'>, cfg: MahnCfg, nur?: { art: PostenArt; nr: string }[]): Promise<OffenerPosten[]> {
  const ziel = cfg.zahlungsziel_tage ?? v.zahlungsziel_tage ?? 14;
  const arten = artenListe(cfg);
  const nrs = (art: PostenArt) => (nur ? nur.filter((x) => x.art === art).map((x) => x.nr) : null);
  const out: OffenerPosten[] = [];
  if (arten.includes('HALLE') && (!nur || nrs('HALLE')!.length)) {
    const status = cfg.halle_gedruckt ? ['2', '3', '5'] : ['3', '5'];
    const liste = nrs('HALLE');
    const rows = await db`
      select k.rgnr_txt as nr, k.kunde, k.adrnr, k.betrag::float8 as gesamt,
             (k.betrag - coalesce((select sum(z.betrag) from tco.rgtz z where z.rgnr_txt = k.rgnr_txt), 0))::float8 as rest,
             to_char(coalesce(k.versendet, k.gedruckt, k.angelegt_am, current_date), 'YYYY-MM-DD') as datum,
             nullif(trim(concat_ws(' ', m.vorname, m.nachname)), '') as mitglied
        from tco.rgkopf k left join tco.mitglieder m on m.adrnr = k.adrnr
       where k.status = any(${status}) ${liste ? db`and k.rgnr_txt = any(${liste})` : db``}
       order by k.rgnr_txt`;
    const jeKunde = new Map<string, string | null>();
    for (const r of rows) {
      if (!(r.rest > 0)) continue;
      let adrnr = (r.adrnr as string | null) || null;
      if (!adrnr) {
        if (!jeKunde.has(r.kunde)) jeKunde.set(r.kunde, await adrnrErmitteln(db, r.kunde ?? ''));
        adrnr = jeKunde.get(r.kunde) ?? null;
      }
      out.push({
        art: 'HALLE', nr: r.nr, schuldner: adrnr ?? `K:${(r.kunde ?? '').trim()}`, name: r.mitglied ?? nameSchoen(r.kunde), betrag: runden(r.rest), gesamt: Number(r.gesamt),
        datum: r.datum, faellig: faelligkeit(r.datum, null, ziel),
      });
    }
  }
  if (arten.includes('VERZEHR') && (!nur || nrs('VERZEHR')!.length)) {
    const liste = nrs('VERZEHR');
    const rows = await db`
      select b.rgnr as nr, b.adrnr, b.betrag::float8 as betrag, to_char(b.datum, 'YYYY-MM-DD') as datum, to_char(b.faellig, 'YYYY-MM-DD') as faellig,
             nullif(trim(concat_ws(' ', m.vorname, m.nachname)), '') as mitglied
        from tco.vz_belege b left join tco.mitglieder m on m.adrnr = b.adrnr
       where b.art = 'SAMMEL' and b.status = 'GESTELLT' and b.laufid is null and coalesce(b.zahlart, '') <> 'LASTSCHRIFT' and b.betrag > 0
             ${liste ? db`and b.rgnr = any(${liste})` : db``}
       order by b.rgnr`;
    for (const r of rows) {
      out.push({
        art: 'VERZEHR', nr: r.nr, schuldner: r.adrnr, name: r.mitglied ?? r.adrnr, betrag: Number(r.betrag), gesamt: Number(r.betrag),
        datum: r.datum, faellig: faelligkeit(r.datum, r.faellig, ziel),
      });
    }
  }
  return out;
}

export async function historieLesen(db: Db, f: { art?: PostenArt; nr?: string; alle?: boolean } = {}): Promise<HistorieZeile[]> {
  const rows = await db`
    select p.id, p.lauf_id, p.art, p.nr, p.stufe, p.stufe_name, p.status, p.an, p.meldung, p.weg, to_char(p.frist, 'YYYY-MM-DD') as frist,
           to_char(coalesce(p.erledigt_am, p.angelegt_am) at time zone 'Europe/Berlin', 'YYYY-MM-DD') as tag
      from tco.mahn_posten p
     where true ${f.alle ? db`` : db`and p.status not in ('VERWORFEN', 'ENTFALLEN')`}
           ${f.art && f.nr ? db`and p.art = ${f.art} and p.nr = ${f.nr}` : db``}
     order by p.id`;
  return rows as unknown as HistorieZeile[];
}

export async function sperrenLesen(db: Db, nurAktive = true, heute = heuteIso()): Promise<(SperreZeile & { name: string; angelegt_am: string; angelegt_von: string; aufgehoben_am: string | null; aufgehoben_von: string | null })[]> {
  const rows = await db`
    select id, ebene, art, schluessel, name, grund, to_char(bis, 'YYYY-MM-DD') as bis, to_char(angelegt_am at time zone 'Europe/Berlin', 'YYYY-MM-DD') as angelegt_am, angelegt_von,
           to_char(aufgehoben_am at time zone 'Europe/Berlin', 'YYYY-MM-DD') as aufgehoben_am, aufgehoben_von
      from tco.mahn_sperre
     where true ${nurAktive ? db`and aufgehoben_am is null and (bis is null or bis >= ${heute}::date)` : db``}
     order by (aufgehoben_am is not null), id desc`;
  return rows as never;
}

export interface Stand { cfg: MahnCfg; stand: PostenStand[] }

/** Stand aller offenen Posten zum Stichtag – Grundlage für App, Vorschau und Lauf */
export async function standLesen(db: Db = DB, heute = heuteIso()): Promise<Stand> {
  const cfg = await cfgLesen(db);
  // nur das Zahlungsziel des Vereins – ohne die Anbindungen (der Arbeitsvorrat ruft das bei jedem Aufbau der Startseite)
  const [verein] = await db`select zahlungsziel_tage from tco.verein where id = 1`;
  const posten = await offenePostenLesen(db, { zahlungsziel_tage: verein?.zahlungsziel_tage ?? 14 }, cfg);
  const [historie, sperren] = [await historieLesen(db), await sperrenLesen(db, true, heute)];
  let stand = standErmitteln(posten, historie, sperren, cfg, heute);
  // nicht erreichte Schuldner: hat sich die E-Mail-Adresse seit dem Versuch geändert, wird erneut versucht
  const offen = [...new Set(stand.filter((p) => p.schritt === 'UNERREICHBAR' && !p.schuldner.startsWith('K:')).map((p) => p.schuldner))];
  if (offen.length) {
    const adressen = new Map<string, string>();
    for (const a of offen) adressen.set(a, (await kontaktLesen(db, a))?.email ?? '');
    stand = standErmitteln(posten, historie, sperren, cfg, heute, adressen);
  }
  return { cfg, stand };
}

// ---------------------------------------------------------------------------
// Lauf
// ---------------------------------------------------------------------------

export interface LaufErgebnis {
  id: number; status: string; modus: 'VORSCHLAG' | 'SENDEN';
  schuldner: number; posten: number; gesendet: number; nicht_erreichbar: number; fehler: number; entfallen: number; zurueckgestellt: number; text: string;
}

const istDoppelt = (e: unknown) => (e as { code?: string })?.code === '23505';

/** hängengebliebene Läufe (Absturz, Neustart) freigeben – sonst bliebe die Sperre für immer */
async function aufraeumen() {
  await DB`update tco.mahn_lauf set status = 'FEHLER', beendet_am = now(), meldung = 'abgebrochen (keine Rückmeldung nach 30 Minuten)'
            where status = 'LAEUFT' and gestartet_am < now() - interval '30 minutes'`;
}

async function zaehlen(id: number): Promise<Omit<LaufErgebnis, 'text'>> {
  const [l] = await DB`select status, modus, zurueckgestellt from tco.mahn_lauf where id = ${id}`;
  const [n] = await DB`select count(*)::int as posten, count(distinct schuldner)::int as schuldner,
                              count(distinct schuldner) filter (where status = 'GESENDET')::int as gesendet,
                              count(distinct schuldner) filter (where status = 'NICHT_ERREICHBAR')::int as nicht_erreichbar,
                              count(distinct schuldner) filter (where status = 'FEHLER')::int as fehler,
                              count(*) filter (where status = 'ENTFALLEN')::int as entfallen
                         from tco.mahn_posten where lauf_id = ${id}`;
  return { id, status: l.status, modus: l.modus, zurueckgestellt: l.zurueckgestellt, ...(n as unknown as Pick<LaufErgebnis, 'posten' | 'schuldner' | 'gesendet' | 'nicht_erreichbar' | 'fehler' | 'entfallen'>) };
}

function ergebnisText(e: Omit<LaufErgebnis, 'text'>): string {
  if (e.status === 'VORSCHLAG') {
    return e.posten ? `Vorschlag mit ${e.schuldner} Schuldner${e.schuldner === 1 ? '' : 'n'} und ${e.posten} Posten erzeugt – es wurde nichts gesendet.` : 'Nichts zu mahnen.';
  }
  if (!e.posten) return 'Nichts zu mahnen – es wurde keine E-Mail gesendet.';
  return [`${e.gesendet} E-Mail${e.gesendet === 1 ? '' : 's'} gesendet`, ...(e.nicht_erreichbar ? [`${e.nicht_erreichbar} nicht erreichbar`] : []),
    ...(e.fehler ? [`${e.fehler} mit Fehler`] : []), ...(e.entfallen ? [`${e.entfallen} Posten entfallen (inzwischen bezahlt oder gesperrt)`] : []),
    ...(e.zurueckgestellt ? [`${e.zurueckgestellt} Schuldner zurückgestellt (Obergrenze)`] : [])].join(', ');
}

/** Vorschau: was der nächste Lauf tun würde (nichts wird geschrieben oder gesendet) */
export async function vorschau(db: Db = DB, heute = heuteIso()): Promise<Plan & { cfg: MahnCfg; stand: PostenStand[] }> {
  const { cfg, stand } = await standLesen(db, heute);
  return { ...planen(stand, cfg), cfg, stand };
}

/**
 * Mahnlauf: fällige Posten ermitteln und als Vorschlag festhalten; im Modus SENDEN sofort versenden.
 * Ein noch offener Vorschlag wird durch den neuen Lauf ersetzt.
 */
export async function laufAusfuehren(o: { art: 'AUTO' | 'MANUELL'; modus: 'VORSCHLAG' | 'SENDEN'; wer: Wer; heute?: string }): Promise<LaufErgebnis> {
  const heute = o.heute ?? heuteIso();
  await aufraeumen();
  let id: number;
  try {
    const [l] = await DB`insert into tco.mahn_lauf (art, modus, status, stichtag, gestartet_von) values (${o.art}, ${o.modus}, 'LAEUFT', ${heute}, ${o.wer.name}) returning id`;
    id = l.id as number;
  } catch (e) {
    if (istDoppelt(e)) throw new BusinessError('Es läuft bereits ein Mahnlauf – bitte dessen Ende abwarten.', 409);
    throw e;
  }
  try {
    if (o.modus === 'SENDEN' && !(await mailVerfuegbar())) throw new BusinessError('Der E-Mail-Versand ist nicht eingerichtet (Administration → Schnittstellen) – es wurde nichts gesendet.');
    const ctx = { userId: o.wer.id, username: o.wer.name, action: 'MAHNLAUF' };
    // ein offener Vorschlag wird ersetzt: Der neue Lauf rechnet mit dem heutigen Zahlungsstand
    await withChange(ctx, async (tx) => {
      await tx`update tco.mahn_posten set status = 'VERWORFEN', meldung = ${`durch Lauf ${id} ersetzt`}, erledigt_am = now(), erledigt_von = ${o.wer.name} where status = 'VORSCHLAG'`;
      await tx`update tco.mahn_lauf set status = 'VERWORFEN', beendet_am = now(), meldung = ${`durch Lauf ${id} ersetzt`} where status = 'VORSCHLAG'`;
    });
    const { cfg, stand } = await standLesen(DB, heute);
    const plan = planen(stand, cfg);
    const frist = addTage(heute, cfg.frist_tage);
    const zeilen = plan.mails.flatMap((m) => m.posten.map((p, i) => ({ ...p, stufe: p.naechste!, stufe_name: p.naechste_name, gebuehr: i === 0 ? m.gebuehr : 0 })));
    if (zeilen.length) {
      await withChange(ctx, (tx) => tx`
        insert into tco.mahn_posten (lauf_id, art, nr, schuldner, name, betrag, faellig, stufe, stufe_name, gebuehr, frist)
        select ${id}, x.art, x.nr, x.schuldner, x.name, x.betrag, x.faellig::date, x.stufe, x.stufe_name, x.gebuehr, ${frist}::date
          from unnest(${zeilen.map((z) => z.art)}::text[], ${zeilen.map((z) => z.nr)}::text[], ${zeilen.map((z) => z.schuldner)}::text[], ${zeilen.map((z) => z.name)}::text[],
                      ${zeilen.map((z) => z.betrag)}::numeric[], ${zeilen.map((z) => z.faellig)}::text[], ${zeilen.map((z) => z.stufe)}::int[],
                      ${zeilen.map((z) => z.stufe_name)}::text[], ${zeilen.map((z) => z.gebuehr)}::numeric[])
               as x(art, nr, schuldner, name, betrag, faellig, stufe, stufe_name, gebuehr)
        on conflict do nothing`);
    }
    await DB`update tco.mahn_lauf set zurueckgestellt = ${plan.zurueckgestellt.length} where id = ${id}`;
    if (o.modus === 'SENDEN') await senden(id, o.wer, heute);
    const offen = o.modus === 'VORSCHLAG' && zeilen.length > 0;
    await DB`update tco.mahn_lauf set status = ${offen ? 'VORSCHLAG' : 'FERTIG'}, beendet_am = now() where id = ${id}`;
  } catch (e) {
    await DB`update tco.mahn_lauf set status = 'FEHLER', beendet_am = now(), meldung = ${String((e as Error).message).slice(0, 500)} where id = ${id}`.catch(() => null);
    throw e;
  }
  const z = await zaehlen(id);
  return { ...z, text: ergebnisText(z) };
}

/** Vorschlag freigeben: die vorgeschlagenen Posten jetzt senden (jeder wird vorher erneut geprüft) */
export async function laufFreigeben(id: number, wer: Wer, heute = heuteIso()): Promise<LaufErgebnis> {
  await aufraeumen();
  if (!(await mailVerfuegbar())) throw new BusinessError('Der E-Mail-Versand ist nicht eingerichtet (Administration → Schnittstellen) – es wurde nichts gesendet.');
  let frei;
  try {
    frei = await DB`update tco.mahn_lauf set status = 'LAEUFT', freigegeben_am = now(), freigegeben_von = ${wer.name}, gestartet_am = now() where id = ${id} and status = 'VORSCHLAG' returning id`;
  } catch (e) {
    if (istDoppelt(e)) throw new BusinessError('Es läuft bereits ein Mahnlauf – bitte dessen Ende abwarten.', 409);
    throw e;
  }
  if (!frei.length) throw new BusinessError('Dieser Vorschlag ist nicht mehr offen (bereits freigegeben, verworfen oder durch einen neuen Lauf ersetzt).', 409);
  try {
    await senden(id, wer, heute);
    await DB`update tco.mahn_lauf set status = 'FERTIG', beendet_am = now() where id = ${id}`;
  } catch (e) {
    await DB`update tco.mahn_lauf set status = 'FEHLER', beendet_am = now(), meldung = ${String((e as Error).message).slice(0, 500)} where id = ${id}`.catch(() => null);
    throw e;
  }
  const z = await zaehlen(id);
  return { ...z, text: ergebnisText(z) };
}

/** Vorschlag verwerfen – es wird nichts gesendet */
export async function laufVerwerfen(tx: Db, id: number, wer: Wer): Promise<void> {
  const r = await tx`update tco.mahn_lauf set status = 'VERWORFEN', beendet_am = now(), meldung = ${`verworfen von ${wer.name}`} where id = ${id} and status = 'VORSCHLAG' returning id`;
  if (!r.length) throw new BusinessError('Dieser Vorschlag ist nicht mehr offen.', 409);
  await tx`update tco.mahn_posten set status = 'VERWORFEN', meldung = 'Vorschlag verworfen', erledigt_am = now(), erledigt_von = ${wer.name} where lauf_id = ${id} and status = 'VORSCHLAG'`;
}

interface PostenZeile { id: number; art: PostenArt; nr: string; schuldner: string; name: string; stufe: number; stufe_name: string; faellig: string; betrag: number }

// ---------------------------------------------------------------------------
// Paperless: Dokument des Postens, Anhang, Protokoll
// ---------------------------------------------------------------------------

/** Paperless-Dokument der Rechnung bzw. Abrechnung (null = nie nach Paperless abgelegt) */
export async function dokumentId(db: Db, art: PostenArt, nr: string): Promise<number | null> {
  const [r] = art === 'HALLE'
    ? await db`select doknr::text as id from tco.rgkopf where rgnr_txt = ${nr}`
    : await db`select doc_id::text as id from tco.vz_belege where rgnr = ${nr}`;
  const id = Number(r?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Protokoll in Paperless eingeschaltet und Paperless eingerichtet */
export const protokollAktiv = (v: Verein) => funktionAktiv(F_MAHN_PAPERLESS) && plAktiv(v);

/** Notiz an das Paperless-Dokument des Postens – liefert eine Warnung statt eines Fehlers */
export async function mahnNotiz(v: Verein, art: PostenArt, nr: string, text: string): Promise<string | null> {
  if (!protokollAktiv(v)) return null;
  try {
    const id = await dokumentId(DB, art, nr);
    if (!id) return null;
    return await paperlessNotiz(v, id, text);
  } catch (e) {
    return `Paperless-Notiz nicht geschrieben: ${(e as Error).message}`;
  }
}

export const jetztText = () => {
  const l = lokal(new Date());
  return `${dat(l.datum)} ${l.zeit}`;
};

/**
 * Anhang zu einem Posten: die in Paperless abgelegte Fassung (Protokoll eingeschaltet), sonst bzw. ohne Dokument die
 * Rechnung bzw. Abrechnung neu als PDF mit GiroCode – ein Fehler dabei verhindert die Mahnung nicht.
 */
async function anhang(v: Verein, p: PostenZeile): Promise<MailAnhang | null> {
  const dateiname = p.art === 'HALLE' ? `Rechnung_${p.nr}.pdf` : `Verzehrabrechnung_${p.nr}.pdf`;
  if (protokollAktiv(v)) {
    try {
      const id = await dokumentId(DB, p.art, p.nr);
      if (id) {
        const pl = paperless(v);
        const ver = await pl.neuesteVersion(id);
        const d = await pl.download(ver);
        return { dateiname, inhalt: d.data, paperless_root_id: id, paperless_version_id: ver, objekt: p.nr };
      }
    } catch { /* weiter mit neu erzeugtem PDF */ }
  }
  try {
    if (p.art === 'HALLE') return { dateiname: `Rechnung_${p.nr}.pdf`, inhalt: (await rechnungPdfErzeugen(DB, v, p.nr)).pdf, objekt: p.nr };
    return { dateiname: `Verzehrabrechnung_${p.nr}.pdf`, inhalt: (await belegErzeugen(DB, v, p.nr)).pdf, objekt: p.nr };
  } catch { return null; }
}

/**
 * Die vorgeschlagenen Posten eines Laufs senden: je Schuldner eine E-Mail mit allen Posten, die höchste Stufe bestimmt den Text.
 * Jeder Posten wird unmittelbar vorher gegen Zahlungsstand und Sperren geprüft. Jedes Ergebnis ungleich „gesendet“ gilt als
 * nicht zugestellt (Liste „nicht per E-Mail erreichbar“) – die Stufe ist dann nicht erreicht.
 */
async function senden(laufId: number, wer: Wer, heute: string): Promise<void> {
  const ctx = { userId: wer.id, username: wer.name, action: 'MAHNLAUF' };
  const rows = await DB`select id, art, nr, schuldner, name, stufe, stufe_name, to_char(faellig, 'YYYY-MM-DD') as faellig, betrag::float8 as betrag
                          from tco.mahn_posten where lauf_id = ${laufId} and status = 'VORSCHLAG' order by faellig, id` as unknown as PostenZeile[];
  const gruppen = new Map<string, PostenZeile[]>();
  for (const r of rows) {
    if (!gruppen.has(r.schuldner)) gruppen.set(r.schuldner, []);
    gruppen.get(r.schuldner)!.push(r);
  }
  for (const [schuldner, posten] of gruppen) {
    // aktueller Stand: Einstellungen, Zahlungen und Sperren können sich seit dem Vorschlag geändert haben
    const [cfg, v] = [await cfgLesen(DB), await vereinLesen(DB)];
    const aktuell = await offenePostenLesen(DB, v, cfg, posten.map((p) => ({ art: p.art, nr: p.nr })));
    const sperren = await sperrenLesen(DB, true, heute);
    const bleibt: (PostenZeile & { offen: OffenerPosten })[] = [];
    const entfaellt: { id: number; meldung: string }[] = [];
    for (const p of posten) {
      const o = aktuell.find((x) => x.art === p.art && x.nr === p.nr);
      const s = o ? sperreFuer(o, sperren, heute) : null;
      if (!o) entfaellt.push({ id: p.id, meldung: 'inzwischen bezahlt bzw. nicht mehr offen' });
      else if (s) entfaellt.push({ id: p.id, meldung: `Mahnsperre: ${s.grund}` });
      else bleibt.push({ ...p, offen: o });
    }
    const summe = runden(bleibt.reduce((x, p) => x + p.offen.betrag, 0));
    if (bleibt.length && summe < cfg.mindestbetrag) {
      entfaellt.push(...bleibt.map((p) => ({ id: p.id, meldung: `offen nur noch ${eur(summe)} – unter dem Mindestbetrag` })));
      bleibt.length = 0;
    }
    if (entfaellt.length) {
      await withChange(ctx, async (tx) => {
        for (const e of entfaellt) await tx`update tco.mahn_posten set status = 'ENTFALLEN', meldung = ${e.meldung}, gebuehr = 0, erledigt_am = now(), erledigt_von = ${wer.name} where id = ${e.id} and status = 'VORSCHLAG'`;
      });
    }
    if (!bleibt.length) continue;

    const stufe = Math.max(...bleibt.map((p) => p.stufe));
    const stufeName = bleibt.find((p) => p.stufe === stufe)!.stufe_name;
    const gebuehr = cfg.stufen[stufe - 1]?.gebuehr ?? 0;
    const frist = addTage(heute, cfg.frist_tage);
    let anhaenge: MailAnhang[] = [];
    const abschliessen = async (status: 'GESENDET' | 'NICHT_ERREICHBAR' | 'FEHLER', an: string, meldung: string | null) => {
      await withChange(ctx, async (tx) => {
        for (const [i, p] of bleibt.entries()) {
          await tx`update tco.mahn_posten set status = ${status}, weg = ${status === 'GESENDET' ? 'MAIL' : null}, an = ${an}, meldung = ${meldung ? meldung.slice(0, 500) : null},
                          betrag = ${p.offen.betrag}, gebuehr = ${i === 0 ? gebuehr : 0}, frist = ${frist}::date, erledigt_am = now(), erledigt_von = ${wer.name}
                    where id = ${p.id} and status = 'VORSCHLAG'`;
        }
      });
      // Protokoll am Paperless-Dokument jedes Postens; eine fehlgeschlagene Notiz wird am Posten vermerkt
      const zeitpunkt = jetztText();
      for (const [i, p] of bleibt.entries()) {
        const w = await mahnNotiz(v, p.art, p.nr, notizText({
          stufe_name: stufeName, ergebnis: status, zeitpunkt, wer: wer.name, lauf_id: laufId, an, betrag: p.offen.betrag, gebuehr: i === 0 ? gebuehr : 0,
          frist: status === 'GESENDET' ? frist : null, meldung, anhaenge: anhaenge.map((a) => a.dateiname),
        }));
        if (w) await DB`update tco.mahn_posten set meldung = left(concat_ws(' · ', meldung, ${w}::text), 500) where id = ${p.id}`.catch(() => null);
      }
    };
    const kontakt = schuldner.startsWith('K:') ? null : await kontaktLesen(DB, schuldner);
    const an = (kontakt?.email ?? '').trim();
    if (!an) {
      await abschliessen('NICHT_ERREICHBAR', '', kontakt ? 'keine E-Mail-Adresse hinterlegt' : 'kein Mitglied bzw. Kunde zum Namen gefunden – keine E-Mail-Adresse');
      continue;
    }
    const m: Pick<MahnMail, 'posten' | 'stufe_name' | 'summe' | 'gebuehr'> = {
      posten: bleibt.map((p) => ({ ...p.offen }) as PostenStand), stufe_name: stufeName, summe, gebuehr,
    };
    const text = await mailtextFuellen(DB, v, mailtextSchluessel(stufe), mailWerte(v, kontakt?.vorname ?? '', m, frist));
    anhaenge = [];
    if (cfg.anhang) {
      for (const p of bleibt.slice(0, MAX_ANHAENGE)) {
        const a = await anhang(v, p);
        if (a) anhaenge.push(a);
      }
    }
    try {
      const r = await mailSenden(v, {
        modus: 'senden', anwendung: 'MAHNUNG', objekt: bleibt.map((p) => p.nr).join(',').slice(0, 200), an, bcc: cfg.kopie_an || undefined,
        betreff: text.betreff, text: text.text, benutzer: wer.name, anhaenge, persoenlich: false,
        absender: cfg.absender || undefined, absender_name: cfg.absender ? cfg.absender_name || v.name : undefined, antwort_an: cfg.antwort_an || undefined,
        // nie unverändert wiederholen: Der Posten kann inzwischen bezahlt sein – ein neuer Lauf prüft das
        wiederholung: { art: 'NEU_AUSLOESEN', hinweis: 'Mahnungen werden nicht unverändert wiederholt – der Posten könnte inzwischen bezahlt sein. Im Mahnwesen unter „Nicht erreichbar“ erneut versuchen; der nächste Lauf prüft den Zahlungsstand.' },
      });
      if (r.status === 'gesendet') await abschliessen('GESENDET', an, null);
      else await abschliessen('NICHT_ERREICHBAR', an, r.fehler || r.hinweis || `Versand nicht bestätigt (Status ${r.status})`);
    } catch (e) {
      await abschliessen('FEHLER', an, (e as Error).message);
    }
    // den Lauf als lebendig kennzeichnen (Schutz vor dem Aufräumen bei sehr langen Läufen)
    await DB`update tco.mahn_lauf set gestartet_am = now() where id = ${laufId} and status = 'LAEUFT' and gestartet_am < now() - interval '10 minutes'`;
  }
}

// ---------------------------------------------------------------------------
// Automatik
// ---------------------------------------------------------------------------

/**
 * Jede Minute aus dem Hintergrund gerufen: startet den Lauf, wenn die Automatik eingeschaltet und fällig ist.
 * Mehrere Instanzen: Der Tageslauf wird atomar beansprucht – nur eine startet.
 */
export async function automatikPruefen(log: Pick<FastifyBaseLogger, 'info' | 'warn'>, jetzt = new Date()): Promise<LaufErgebnis | null> {
  // Funktionsschalter: abgeschaltete Apps und Funktionen laufen nicht von selbst
  if (!funktionAktiv(modulId('tco')) || !appAktiv('tco', 'Mahnwesen') || !funktionAktiv(F_MAHN_AUTOMATIK)) return null;
  const cfg = await cfgLesen(DB);
  if (!automatikFaellig(cfg, jetzt)) return null;
  const tag = lokal(jetzt).datum;
  const [frei] = await DB`update tco.mahn_cfg set letzter_lauf = ${jetzt}
                           where id = 1 and aktiv and (letzter_lauf is null or (letzter_lauf at time zone 'Europe/Berlin')::date <> ${tag}::date) returning id`;
  if (!frei) return null;
  try {
    const r = await laufAusfuehren({ art: 'AUTO', modus: cfg.modus, wer: SYSTEM, heute: tag });
    log.info({ lauf: r.id, gesendet: r.gesendet, posten: r.posten }, `Mahnlauf: ${r.text}`);
    return r;
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'Mahnlauf fehlgeschlagen');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Arbeitsvorrat (Kassenwart)
// ---------------------------------------------------------------------------

export async function aufgaben(db: Db) {
  type Eintrag = { key: string; bereich: string; icon: string; state: 'Critical' | 'Information' | 'Negative'; titel: string; text: string; datum: string | null; pfad: string; betrag?: number };
  const out: Eintrag[] = [];
  const [l] = await db`select id, status, art, meldung, to_char(gestartet_am at time zone 'Europe/Berlin', 'YYYY-MM-DD') as tag
                         from tco.mahn_lauf l where status <> 'VERWORFEN' order by id desc limit 1`;
  if (!l) return out; // noch nie gelaufen: nichts zu tun
  const { stand } = await standLesen(db);
  if (l.status === 'VORSCHLAG') {
    // aktueller Zahlungsstand: inzwischen bezahlte bzw. gesperrte Posten zählen nicht mehr mit
    const zeilen = await db`select art, nr, schuldner, betrag::float8 as betrag, status from tco.mahn_posten where lauf_id = ${l.id} and status = 'VORSCHLAG'` as unknown as VorschlagZeile[];
    const ab = vorschlagAbgleichen(zeilen, stand, await sperrenLesen(db), heuteIso());
    out.push({
      key: `MAHN_VORSCHLAG:${l.id}`, bereich: 'Kassenwart', icon: 'payment-approval', state: 'Information', titel: 'Mahnvorschlag freigeben',
      text: ab.schuldner
        ? `${ab.schuldner} Schuldner mit ${eur(ab.betrag)} – prüfen und freigeben, erst dann gehen die E-Mails hinaus.`
        : 'Alle vorgeschlagenen Posten sind inzwischen bezahlt bzw. gesperrt – den Vorschlag verwerfen.',
      datum: l.tag, pfad: '/tco/mahnwesen?tab=vorschlag', betrag: ab.betrag,
    });
  }
  if (l.status === 'FEHLER') {
    out.push({
      key: `MAHN_LAUF:${l.id}`, bereich: 'Kassenwart', icon: 'alert', state: 'Negative', titel: 'Mahnlauf fehlgeschlagen',
      text: `${l.art === 'AUTO' ? 'Automatischer Lauf' : 'Lauf'} vom ${dat(l.tag)}: ${l.meldung ?? 'ohne Meldung'}`.slice(0, 300), datum: l.tag, pfad: '/tco/mahnwesen?tab=laeufe',
    });
  }
  for (const p of stand.filter((x) => x.schritt === 'KLAEREN')) {
    out.push({
      key: `MAHN_KLAEREN:${p.art}:${p.nr}`, bereich: 'Kassenwart', icon: 'money-bills', state: 'Negative', titel: `Forderung manuell klären: ${p.name}`,
      text: `${ART_TEXT[p.art]} ${p.nr} über ${eur(p.betrag)} – ${p.hinweis}.`, datum: p.ab, pfad: '/tco/mahnwesen?tab=posten', betrag: p.betrag,
    });
  }
  const un = stand.filter((x) => x.schritt === 'UNERREICHBAR');
  if (un.length) {
    const n = new Set(un.map((x) => x.schuldner)).size;
    out.push({
      key: 'MAHN_UNERREICHBAR', bereich: 'Kassenwart', icon: 'email', state: 'Critical', titel: `${n} Schuldner nicht per E-Mail erreichbar`,
      text: `${un.length} Posten über ${eur(runden(un.reduce((s, x) => s + x.betrag, 0)))} – per Brief oder Anruf erinnern und die Zustellung vermerken.`,
      datum: un.map((x) => x.versuch?.tag ?? '').sort()[0] || null, pfad: '/tco/mahnwesen?tab=unerreichbar', betrag: runden(un.reduce((s, x) => s + x.betrag, 0)),
    });
  }
  return out;
}
