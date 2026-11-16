/**
 * Zählerstände (Bereich Instandhaltung): Datenzugriff – Zähler, Stände, Übersicht, Auswertung, Import/Export,
 * Einträge im Arbeitsvorrat. Die Rechenregeln stehen in logik.ts (ohne Datenbank).
 */
import { BusinessError } from '../../../../server/src/errors.js';
import type { Aufgabe } from '../../../../server/src/lib/arbeitsvorrat.js';
import type { Db } from '../verein.js';
import type {
  Auswertung, ImportErgebnis, Jahresvergleich, Pruefung, StandArt, StandEingabe, Zaehler, ZaehlerDetail, Zaehlerstand, ZaehlerStamm, ZaehlerZeile,
} from '../../web/zaehler/typen.js';
import {
  csvLesen, csvSchreiben, jahresvergleich, kennzahlen, mitVerbrauch, perioden, pruefen, r2, r3, reihe, verlauf12, zahlDe, type CsvExportZeile, type Raster, type Stand,
} from './logik.js';

/**
 * Berechtigungsobjekte Zählerstände:
 *  - tco.zaehler:display  Zähler, Stände, Auswertungen, Ablesebogen und QR-Codes ansehen
 *  - tco.zaehler:edit     Stände erfassen, ändern, löschen und importieren
 *  - tco.zaehler:admin    Zähler anlegen, ändern, deaktivieren und löschen
 */
export const P_ZAEHLER = { display: 'tco.zaehler:display', edit: 'tco.zaehler:edit', admin: 'tco.zaehler:admin' };

/** Seite der Oberfläche (Übersicht; /<id> = Zähler, /erfassen?zaehler=<id> = Ablesung erfassen) */
export const ZAEHLER_SEITE = '/tco/zaehler';

const dat = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

// ---------------------------------------------------------------- Lesen

export async function zaehlerLesen(db: Db, o: { alle?: boolean; ids?: number[] } = {}): Promise<Zaehler[]> {
  const ids = o.ids ?? null;
  return (await db`
    select id, nummer, bezeichnung, medium, einheit, standort, zaehlernummer, faktor::float8 as faktor, verbrauchseinheit, stellen,
           intervall_tage, arbeitspreis::float8 as arbeitspreis, grundpreis_monat::float8 as grundpreis_monat, jahresziel::float8 as jahresziel,
           aktiv, notiz
      from tco.zaehler
     where (${!!o.alle} or aktiv) and (${ids === null} or id = any(${ids ?? []}::int[]))
     order by nummer`) as unknown as Zaehler[];
}

export async function zaehlerEins(db: Db, id: number): Promise<Zaehler> {
  const [z] = await zaehlerLesen(db, { alle: true, ids: [id] });
  if (!z) throw new BusinessError('Zähler nicht gefunden.', 404);
  return z;
}

type StandRoh = Omit<Zaehlerstand, 'verbrauch' | 'tagesverbrauch'>;
/** Stände der Zähler, nach Zähler gruppiert (zeitlich aufsteigend) */
export async function staendeLesen(db: Db, zaehlerIds: number[]): Promise<Map<number, StandRoh[]>> {
  const rows = (await db`
    select s.id, s.zaehler_id, to_char(s.datum, 'YYYY-MM-DD') as datum, s.stand::float8 as stand, s.art, s.notiz,
           s.foto is not null as "hatFoto", u.display_name as "erfasstVon"
      from tco.zaehlerstand s left join core.users u on u.id = s.erfasst_von
     where s.zaehler_id = any(${zaehlerIds}::int[])
     order by s.zaehler_id, s.datum, s.id`) as unknown as StandRoh[];
  const out = new Map<number, StandRoh[]>(zaehlerIds.map((id) => [id, []]));
  for (const r of rows) out.get(r.zaehler_id)!.push(r);
  return out;
}

/** Übersicht (GET /zaehler) */
export async function uebersicht(db: Db, alle: boolean, stichtag: string): Promise<ZaehlerZeile[]> {
  const zs = await zaehlerLesen(db, { alle });
  const st = await staendeLesen(db, zs.map((z) => z.id));
  return zs.map((z) => ({ ...z, kennzahlen: kennzahlen(z, st.get(z.id)!, stichtag), verlauf12: verlauf12(st.get(z.id)!, z, stichtag) }));
}

/** Zähler mit Ständen (neueste zuerst) und Kennzahlen */
export async function detail(db: Db, id: number, stichtag: string): Promise<ZaehlerDetail> {
  const z = await zaehlerEins(db, id);
  const st = (await staendeLesen(db, [id])).get(id)!;
  return { zaehler: z, staende: mitVerbrauch(st, z).reverse(), kennzahlen: kennzahlen(z, st, stichtag) };
}

// ---------------------------------------------------------------- Zähler pflegen

export async function zaehlerAnlegen(tx: Db, b: ZaehlerStamm): Promise<{ id: number; nummer: string }> {
  const [{ n }] = await tx`select core.next_number('ZAEHLER', 0)::int as n`;
  const nummer = `Z${String(n).padStart(4, '0')}`;
  const [r] = await tx`
    insert into tco.zaehler (nummer, bezeichnung, medium, einheit, standort, zaehlernummer, faktor, verbrauchseinheit, stellen, intervall_tage,
                             arbeitspreis, grundpreis_monat, jahresziel, aktiv, notiz)
    values (${nummer}, ${b.bezeichnung}, ${b.medium}, ${b.einheit}, ${b.standort}, ${b.zaehlernummer}, ${b.faktor}, ${b.verbrauchseinheit}, ${b.stellen},
            ${b.intervall_tage}, ${b.arbeitspreis}, ${b.grundpreis_monat}, ${b.jahresziel}, ${b.aktiv}, ${b.notiz})
    returning id`;
  return { id: r.id, nummer };
}

export async function zaehlerAendern(tx: Db, id: number, b: ZaehlerStamm): Promise<void> {
  const r = await tx`
    update tco.zaehler set bezeichnung = ${b.bezeichnung}, medium = ${b.medium}, einheit = ${b.einheit}, standort = ${b.standort},
           zaehlernummer = ${b.zaehlernummer}, faktor = ${b.faktor}, verbrauchseinheit = ${b.verbrauchseinheit}, stellen = ${b.stellen},
           intervall_tage = ${b.intervall_tage}, arbeitspreis = ${b.arbeitspreis}, grundpreis_monat = ${b.grundpreis_monat},
           jahresziel = ${b.jahresziel}, aktiv = ${b.aktiv}, notiz = ${b.notiz}
     where id = ${id}`;
  if (!r.count) throw new BusinessError('Zähler nicht gefunden.', 404);
}

export async function zaehlerLoeschen(tx: Db, id: number): Promise<string> {
  const z = await zaehlerEins(tx, id);
  const [{ n }] = await tx`select count(*)::int as n from tco.zaehlerstand where zaehler_id = ${id}`;
  if (n) throw new BusinessError('Zähler hat Ablesungen – bitte deaktivieren');
  await tx`delete from tco.zaehler where id = ${id}`;
  return `${z.nummer} ${z.bezeichnung}`;
}

// ---------------------------------------------------------------- Stände

export interface Ich { id: string | null }

/** Foto als data:-URL (JPEG/PNG/WebP, höchstens 3 MB) → Inhalt und Typ */
export function fotoLesen(data: string): { daten: Buffer; typ: string } {
  const m = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(data.trim());
  if (!m) throw new BusinessError('Das Foto muss ein JPEG-, PNG- oder WebP-Bild sein.');
  const daten = Buffer.from(m[2], 'base64');
  if (!daten.length) throw new BusinessError('Das Foto ist leer.');
  if (daten.length > 3 * 1024 * 1024) throw new BusinessError('Das Foto ist zu groß (höchstens 3 MB).');
  return { daten, typ: m[1] === 'image/jpg' ? 'image/jpeg' : m[1] };
}

/** Prüfung einer Eingabe gegen die vorhandenen Stände (ohne den Satz ohne, beim Ändern) */
export async function standPruefen(db: Db, zaehlerId: number, e: Pick<StandEingabe, 'datum' | 'stand' | 'art'>, stichtag: string, ohne: number | null = null): Promise<Pruefung> {
  const z = await zaehlerEins(db, zaehlerId);
  const st = (await staendeLesen(db, [zaehlerId])).get(zaehlerId)!.filter((s) => s.id !== ohne);
  return pruefen(z, st, { id: ohne ?? undefined, datum: e.datum, stand: e.stand, art: e.art }, stichtag);
}

/** Fehler verhindern das Speichern (400), eine Warnung nur ohne Bestätigung (409) */
function durchsetzen(p: Pruefung, bestaetigt: boolean | undefined) {
  if (p.fehler) throw new BusinessError(p.fehler, 400);
  if (p.warnung && !bestaetigt) throw new BusinessError(p.warnung, 409);
}

export async function standAnlegen(tx: Db, zaehlerId: number, e: StandEingabe, ich: Ich, stichtag: string): Promise<{ id: number; pruefung: Pruefung }> {
  await tx`select id from tco.zaehler where id = ${zaehlerId} for update`; // gleichzeitige Erfassung am selben Zähler nacheinander
  const p = await standPruefen(tx, zaehlerId, e, stichtag);
  durchsetzen(p, e.bestaetigt);
  const f = e.foto ? fotoLesen(e.foto) : null;
  const [r] = await tx`
    insert into tco.zaehlerstand (zaehler_id, datum, stand, art, notiz, foto, foto_typ, erfasst_von)
    values (${zaehlerId}, ${e.datum}, ${e.stand}, ${e.art}, ${e.notiz}, ${f?.daten ?? null}, ${f?.typ ?? null}, ${ich.id})
    returning id`;
  return { id: r.id, pruefung: p };
}

async function standKopf(db: Db, sid: number): Promise<{ zaehler_id: number; datum: string; art: StandArt }> {
  const [s] = await db`select zaehler_id, to_char(datum, 'YYYY-MM-DD') as datum, art from tco.zaehlerstand where id = ${sid}`;
  if (!s) throw new BusinessError('Zählerstand nicht gefunden.', 404);
  return s as unknown as { zaehler_id: number; datum: string; art: StandArt };
}

export async function standAendern(tx: Db, sid: number, e: StandEingabe, stichtag: string): Promise<{ id: number; pruefung: Pruefung }> {
  const k = await standKopf(tx, sid);
  await tx`select id from tco.zaehler where id = ${k.zaehler_id} for update`;
  const p = await standPruefen(tx, k.zaehler_id, e, stichtag, sid);
  durchsetzen(p, e.bestaetigt);
  await tx`update tco.zaehlerstand set datum = ${e.datum}, stand = ${e.stand}, art = ${e.art}, notiz = ${e.notiz} where id = ${sid}`;
  if (e.foto === null) await tx`update tco.zaehlerstand set foto = null, foto_typ = null where id = ${sid}`;
  else if (e.foto !== undefined) {
    const f = fotoLesen(e.foto);
    await tx`update tco.zaehlerstand set foto = ${f.daten}, foto_typ = ${f.typ} where id = ${sid}`;
  }
  return { id: sid, pruefung: p };
}

export async function standLoeschen(tx: Db, sid: number): Promise<string> {
  const k = await standKopf(tx, sid);
  await tx`delete from tco.zaehlerstand where id = ${sid}`;
  return `Stand vom ${dat(k.datum)} gelöscht.`;
}

export async function fotoLaden(db: Db, sid: number): Promise<{ daten: Buffer; typ: string }> {
  const [f] = await db`select foto, foto_typ from tco.zaehlerstand where id = ${sid}`;
  if (!f?.foto) throw new BusinessError('Zu diesem Stand gibt es kein Foto.', 404);
  return { daten: f.foto as Buffer, typ: String(f.foto_typ ?? 'image/jpeg') };
}

// ---------------------------------------------------------------- Auswertung

/** Zeitraum der Auswertung: von/bis als YYYY-MM (bei raster jahr auch YYYY); ohne Angabe die letzten 12 Monate bzw. 5 Jahre */
export function zeitraum(raster: Raster, von: string | undefined, bis: string | undefined, stichtag: string): { von: string; bis: string } {
  const norm = (x: string, ende: boolean) => (x.length === 4 ? `${x}-${ende ? '12' : '01'}` : x);
  // bis zuerst normieren: „2025“ im Monatsraster = bis 2025-12, ohne von also 2025-01 … 2025-12
  const bRoh = bis ?? (raster === 'jahr' ? stichtag.slice(0, 4) : stichtag.slice(0, 7));
  const b = raster === 'monat' ? norm(bRoh, true) : bRoh;
  let v = von;
  if (!v) {
    const j = +b.slice(0, 4);
    if (raster === 'jahr') v = String(j - 4);
    else { const m = +b.slice(5, 7); v = m === 12 ? `${j}-01` : `${j - 1}-${String(m + 1).padStart(2, '0')}`; }
  }
  const out = { von: norm(v, false), bis: norm(b, true) };
  if (out.von > out.bis) throw new BusinessError('„Von“ liegt nach „Bis“.');
  if (raster === 'monat' && perioden(out.von, out.bis, 'monat').length > 240) throw new BusinessError('Höchstens 240 Monate auf einmal – bitte das Jahresraster verwenden.');
  return out;
}

export async function auswertung(db: Db, ids: number[], raster: Raster, von: string, bis: string): Promise<Auswertung> {
  const zs = await zaehlerLesen(db, ids.length ? { alle: true, ids } : {});
  const st = await staendeLesen(db, zs.map((z) => z.id));
  const liste = perioden(von, bis, raster);
  const monate = raster === 'jahr' ? 12 : 1;
  return {
    perioden: liste,
    reihen: zs.map((z) => {
      const verbrauch = reihe(st.get(z.id)!, z, liste, raster);
      const ohnePreis = z.arbeitspreis == null && z.grundpreis_monat == null;
      const kosten = verbrauch.map((v) => (v == null || ohnePreis ? null : r2(v * (z.arbeitspreis ?? 0) + monate * (z.grundpreis_monat ?? 0))));
      return {
        zaehlerId: z.id, bezeichnung: z.bezeichnung, medium: z.medium, einheit: z.verbrauchseinheit || z.einheit,
        verbrauch, kosten,
        summe: r3(verbrauch.reduce<number>((n, v) => n + (v ?? 0), 0)),
        kostenSumme: ohnePreis ? null : r2(kosten.reduce<number>((n, k) => n + (k ?? 0), 0)),
      };
    }),
  };
}

export async function vergleich(db: Db, id: number): Promise<Jahresvergleich> {
  const z = await zaehlerEins(db, id);
  return { jahre: jahresvergleich((await staendeLesen(db, [id])).get(id)!, z) };
}

// ---------------------------------------------------------------- Export / Import

/** CSV der Stände (ids leer = alle Zähler), optional im Zeitraum von/bis (YYYY-MM) */
export async function exportCsv(db: Db, ids: number[], von: string | null, bis: string | null): Promise<string> {
  const zs = await zaehlerLesen(db, ids.length ? { alle: true, ids } : { alle: true });
  const st = await staendeLesen(db, zs.map((z) => z.id));
  const zeilen: CsvExportZeile[] = [];
  for (const z of zs) {
    for (const s of mitVerbrauch(st.get(z.id)!, z)) {
      if (von && s.datum.slice(0, 7) < von) continue;
      if (bis && s.datum.slice(0, 7) > bis) continue;
      zeilen.push({ nummer: z.nummer, bezeichnung: z.bezeichnung, zaehlernummer: z.zaehlernummer, medium: z.medium, einheit: z.einheit,
        datum: s.datum, stand: s.stand, art: s.art, verbrauch: s.verbrauch, notiz: s.notiz });
    }
  }
  return csvSchreiben(zeilen);
}

/**
 * CSV-Import prüfen bzw. übernehmen: Zähler über Nummer, Zählernummer oder Bezeichnung (ohne Groß-/Kleinschreibung);
 * jede Zeile wird gegen die vorhandenen und die vorigen Zeilen der Datei geprüft. Übernommen werden nur fehlerfreie
 * Zeilen (Warnungen gelten mit dem Import als bestätigt) – alles in der Transaktion des Aufrufers.
 */
export async function importieren(tx: Db, csv: string, uebernehmen: boolean, ich: Ich, stichtag: string): Promise<ImportErgebnis> {
  const gelesen = csvLesen(csv);
  if (!gelesen.length) throw new BusinessError('Die Datei enthält keine Zeilen.');
  if (gelesen.length > 5000) throw new BusinessError('Höchstens 5000 Zeilen auf einmal.');
  const zs = await zaehlerLesen(tx, { alle: true });
  const schluessel = (t: string) => t.trim().toLowerCase();
  const finde = (t: string): Zaehler[] => {
    const k = schluessel(t);
    for (const feld of ['nummer', 'zaehlernummer', 'bezeichnung'] as const) {
      const treffer = zs.filter((z) => z[feld] && schluessel(z[feld]!) === k);
      if (treffer.length) return treffer;
    }
    return [];
  };
  const st = await staendeLesen(tx, zs.map((z) => z.id));
  const ergebnis: ImportErgebnis = { zeilen: [], uebernommen: 0 };
  for (const g of gelesen) {
    let fehler = g.fehler, warnung: string | null = null, anzeige = g.zaehler;
    const treffer = fehler ? [] : finde(g.zaehler);
    if (!fehler && !treffer.length) fehler = `Zähler „${g.zaehler}“ nicht gefunden (Nummer, Zählernummer oder Bezeichnung).`;
    else if (!fehler && treffer.length > 1) fehler = `„${g.zaehler}“ ist nicht eindeutig (${treffer.map((z) => z.nummer).join(', ')}) – bitte die Nummer angeben.`;
    if (!fehler) {
      const z = treffer[0];
      anzeige = `${z.nummer} ${z.bezeichnung}`;
      const liste = st.get(z.id)! as Stand[];
      const p = pruefen(z, liste, { datum: g.datum, stand: g.stand, art: g.art }, stichtag);
      fehler = p.fehler;
      warnung = p.warnung;
      if (!fehler) {
        liste.push({ datum: g.datum, stand: g.stand, art: g.art });
        if (uebernehmen) {
          await tx`insert into tco.zaehlerstand (zaehler_id, datum, stand, art, notiz, erfasst_von)
                   values (${z.id}, ${g.datum}, ${g.stand}, ${g.art}, ${g.notiz}, ${ich.id})`;
          ergebnis.uebernommen++;
        }
      }
    }
    ergebnis.zeilen.push({ zeile: g.zeile, zaehler: anzeige, datum: g.datum, stand: g.stand, art: g.art, fehler, warnung });
  }
  return ergebnis;
}

// ---------------------------------------------------------------- Ablesebogen

export interface BogenZeile { zaehler: Zaehler; letzte: { datum: string; stand: number } | null; faelligAm: string | null; ueberfaellig: boolean }
export async function bogenLesen(db: Db, stichtag: string): Promise<BogenZeile[]> {
  const zs = await zaehlerLesen(db);
  const st = await staendeLesen(db, zs.map((z) => z.id));
  return zs.map((z) => {
    const k = kennzahlen(z, st.get(z.id)!, stichtag);
    return { zaehler: z, letzte: k.letzteAblesung, faelligAm: k.faelligAm, ueberfaellig: k.ueberfaellig };
  });
}

// ---------------------------------------------------------------- Arbeitsvorrat

/**
 * Einträge im Arbeitsvorrat (Bereich „Instandhaltung“): wer Stände erfassen darf, sieht je überfälligem aktivem Zähler
 * „Zähler ablesen“; wer die Zählerstände ansehen darf, je Zähler mit Hochrechnung über dem Jahresziel einen Hinweis.
 */
export async function aufgaben(db: Db, o: { ablesen: boolean; ziel: boolean }, stichtag: string): Promise<Aufgabe[]> {
  if (!o.ablesen && !o.ziel) return [];
  const zs = await zaehlerLesen(db);
  const st = await staendeLesen(db, zs.map((z) => z.id));
  const out: Aufgabe[] = [];
  for (const z of zs) {
    const k = kennzahlen(z, st.get(z.id)!, stichtag);
    const einheit = z.verbrauchseinheit || z.einheit;
    if (o.ablesen && k.ueberfaellig && k.faelligAm) {
      out.push({
        key: `ZAEHLER_ABLESEN:${z.id}`, bereich: 'Instandhaltung', icon: 'measuring-point', state: 'Critical',
        titel: `Zähler ablesen: ${z.bezeichnung} – fällig seit ${dat(k.faelligAm)}`,
        text: [z.nummer, z.standort, k.letzteAblesung && `letzter Stand ${zahlDe(k.letzteAblesung.stand)} ${z.einheit} am ${dat(k.letzteAblesung.datum)}`]
          .filter(Boolean).join(' · '),
        datum: k.faelligAm, pfad: `/tco/zaehler/erfassen?zaehler=${z.id}`,
      });
    }
    if (o.ziel && k.zielUeberschritten) {
      out.push({
        key: `ZAEHLER_ZIEL:${z.id}`, bereich: 'Instandhaltung', icon: 'trend-up', state: 'Information',
        titel: `Jahresziel überschritten: ${z.bezeichnung}`,
        text: `Hochrechnung ${stichtag.slice(0, 4)}: ${zahlDe(k.prognoseJahr!, 0)} ${einheit}, Ziel ${zahlDe(z.jahresziel!, 0)} ${einheit}`,
        datum: k.letzteAblesung?.datum ?? null, pfad: `${ZAEHLER_SEITE}/${z.id}`,
      });
    }
  }
  return out;
}
