import crypto from 'node:crypto';
import { BusinessError } from '../../../../server/src/errors.js';
import type { Db, Verein } from '../verein.js';
import { addTage, dat, heute, runden } from '../format.js';
import { adrKey } from '../soll/logik.js';
import { betragInWorten } from './zahlwort.js';
import { PLATZHALTER, TEXTE, texteMischen, textePruefen, type Texte } from './texte.js';
import { zuwendungPdf, type Dokument } from './pdf.js';

/**
 * Zuwendungsbestätigungen für Geldspenden (§ 10b EStG, § 50 EStDV).
 *
 * Quelle sind ausschließlich nicht stornierte FI-Buchungen im Haben eines Erlöskontos, deren Gegenkonto ein Geldkonto
 * ist (tatsächlicher Zufluss): Buchungen auf den Spendenkonten der Einstellungen und die Erlöszeilen verbuchter
 * Sollstellungs-Positionen der Spenden-Beitragsarten. Mitgliedsbeiträge, Trainings-, Hallen- und Verzehrentgelte werden
 * nie bestätigt (Sportverein: § 10b Abs. 1 Satz 8 Nr. 1 EStG). Eine Lastschrift-Spende zählt erst nach der Verbuchung
 * in FI; Rückbuchungen auf einem Spendenkonto sperren die passende Spende, bis sie geklärt sind.
 * Jede Buchungszeile gehört höchstens einer gültigen Bestätigung (eindeutiger Index auf tco.zuw_pos).
 */

export const P_ZUW = { display: 'tco.zuwendung:display', execute: 'tco.zuwendung:execute', admin: 'tco.zuwendung:admin' };
export const F_ZUW_JAHRESLAUF = 'tco.zuwendung.jahreslauf';
export const F_ZUW_MAIL = 'tco.zuwendung.mail';

/** Gültigkeit des Bescheids in Jahren ab seinem Datum (Hinweis des Musters, § 63 Abs. 5 AO) */
export const BESCHEID = {
  FREISTELLUNG: { text: 'Freistellungsbescheid bzw. Anlage zum Körperschaftsteuerbescheid', jahre: 5 },
  FESTSTELLUNG: { text: 'Feststellungsbescheid nach § 60a AO', jahre: 3 },
} as const;
export type BescheidArt = keyof typeof BESCHEID;
/** Tage, die eine Rückbuchung (z. B. Rücklastschrift) nach der Spende liegen darf, um ihr zugerechnet zu werden */
export const RUECK_TAGE = 70;

const liste = (s: string | null | undefined) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const artNorm = (a: unknown) => String(a ?? '').trim().replace(/^0+(?=\d)/, '');

// ---------------------------------------------------------------- Einstellungen
export interface Cfg {
  bescheid_art: '' | BescheidArt; finanzamt: string; steuernummer: string; bescheid_datum: string | null; veranlagungszeitraum: string;
  zweck: string; zweck_satzung: string; unterzeichner: string; funktion: string; ort: string; unterschrift: string | null;
  spendenkonten: string[]; spendenarten: string[]; mail_erlaubt: boolean; texte: Record<string, string>;
  muster_geprueft_am: string | null; muster_geprueft_von: string | null;
}

export async function cfgLesen(db: Db): Promise<Cfg> {
  const [c] = await db`select *, bescheid_datum::text as bescheid_tag, muster_geprueft_am::text as geprueft from tco.zuw_cfg where id = 1`;
  return {
    bescheid_art: c.bescheid_art, finanzamt: c.finanzamt, steuernummer: c.steuernummer, bescheid_datum: c.bescheid_tag, veranlagungszeitraum: c.veranlagungszeitraum,
    zweck: c.zweck, zweck_satzung: c.zweck_satzung, unterzeichner: c.unterzeichner, funktion: c.funktion, ort: c.ort, unterschrift: c.unterschrift,
    spendenkonten: liste(c.spendenkonten), spendenarten: liste(c.spendenarten).map(artNorm), mail_erlaubt: c.mail_erlaubt, texte: c.texte ?? {},
    muster_geprueft_am: c.geprueft, muster_geprueft_von: c.muster_geprueft_von,
  };
}

/** Datum + n Jahre (29.02. → 28.02.) */
export function plusJahre(iso: string, jahre: number): string {
  const [j, m, t] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(j + jahre, m - 1, t, 12));
  if (d.getUTCMonth() !== m - 1) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

export interface BescheidStand { ok: boolean; gueltig_bis: string | null; text: string }
/**
 * Bescheid am Tag der Ausstellung noch gültig? Freistellungsbescheid: Datum nicht länger als 5 Jahre zurück,
 * Feststellung nach § 60a AO: nicht länger als 3 Jahre. Der Tag, an dem die Frist genau erreicht ist, zählt noch.
 */
export function bescheidPruefen(c: Pick<Cfg, 'bescheid_art' | 'bescheid_datum'>, stichtag: string): BescheidStand {
  if (!c.bescheid_art || !c.bescheid_datum) return { ok: false, gueltig_bis: null, text: 'Art und Datum des Bescheids fehlen.' };
  const b = BESCHEID[c.bescheid_art];
  if (c.bescheid_datum > stichtag) return { ok: false, gueltig_bis: null, text: `Das Datum des Bescheids (${dat(c.bescheid_datum)}) liegt in der Zukunft.` };
  const bis = plusJahre(c.bescheid_datum, b.jahre);
  if (stichtag > bis) {
    return {
      ok: false, gueltig_bis: bis,
      text: `Der ${b.text} vom ${dat(c.bescheid_datum)} ist älter als ${b.jahre} Jahre (gültig bis ${dat(bis)}) – Zuwendungsbestätigungen dürfen damit nicht mehr ausgestellt werden. Bitte den aktuellen Bescheid in den Einstellungen eintragen.`,
    };
  }
  return { ok: true, gueltig_bis: bis, text: `${b.text} vom ${dat(c.bescheid_datum)}, verwendbar bis ${dat(bis)}.` };
}

/** fehlende Pflichtangaben der Einstellungen bzw. des Vereins */
export function cfgFehlt(c: Cfg, v: Pick<Verein, 'name' | 'strasse' | 'plz_ort'>): string[] {
  return [
    !v.name?.trim() && 'Name des Vereins (Verein und Bank)', !(v.strasse?.trim() && v.plz_ort?.trim()) && 'Anschrift des Vereins (Verein und Bank)',
    !c.bescheid_art && 'Art des Bescheids', !c.finanzamt.trim() && 'Finanzamt', !c.steuernummer.trim() && 'Steuernummer', !c.bescheid_datum && 'Datum des Bescheids',
    c.bescheid_art === 'FREISTELLUNG' && !c.veranlagungszeitraum.trim() && 'Veranlagungszeitraum', !c.zweck.trim() && 'begünstigter Zweck',
    c.bescheid_art === 'FESTSTELLUNG' && !c.zweck_satzung.trim() && 'Zweck laut Satzung', !c.unterzeichner.trim() && 'Unterzeichner', !c.ort.trim() && 'Ort',
    !c.spendenkonten.length && !c.spendenarten.length && 'Spendenkonten oder Spenden-Beitragsarten',
  ].filter(Boolean) as string[];
}

/** Gründe, aus denen keine Bestätigung ausgestellt werden darf (leer = Ausstellung möglich) */
export function sperren(c: Cfg, v: Pick<Verein, 'name' | 'strasse' | 'plz_ort'>, stichtag: string): string[] {
  const out: string[] = [];
  const fehlt = cfgFehlt(c, v);
  if (fehlt.length) out.push(`In den Einstellungen fehlt: ${fehlt.join(', ')}.`);
  if (c.bescheid_art && c.bescheid_datum) { const b = bescheidPruefen(c, stichtag); if (!b.ok) out.push(b.text); }
  if (!c.muster_geprueft_am) out.push('Der Wortlaut der Bestätigung ist noch nicht mit dem amtlichen Muster des BMF abgeglichen (Einstellungen → Zuwendungsbestätigungen → Textbausteine).');
  return out;
}

export interface CfgEingabe extends Omit<Cfg, 'muster_geprueft_am' | 'muster_geprueft_von' | 'bescheid_art'> { bescheid_art: string; muster_geprueft: boolean }

export async function cfgSichern(tx: Db, e: CfgEingabe, benutzer: string): Promise<{ warnungen: string[] }> {
  const f: string[] = [];
  const warnungen: string[] = [];
  if (e.bescheid_art && !(e.bescheid_art in BESCHEID)) f.push('Unbekannte Art des Bescheids.');
  if (e.bescheid_datum && e.bescheid_datum > heute()) f.push('Das Datum des Bescheids liegt in der Zukunft.');
  const konten = [...new Set(e.spendenkonten.map((k) => k.trim()).filter(Boolean))];
  const arten = [...new Set(e.spendenarten.map(artNorm).filter(Boolean))];
  if (konten.length) {
    const da = await tx`select konto, coalesce(kennzahl, '') as kennzahl from tco.fikonten where konto = any(${konten})`;
    const fehlt = konten.filter((k) => !da.some((d) => d.konto === k));
    if (fehlt.length) f.push(`Konto nicht im Kontenstamm: ${fehlt.join(', ')}.`);
    const geld = da.filter((d) => d.kennzahl === 'BA' || d.kennzahl === 'BK').map((d) => d.konto as string);
    if (geld.length) f.push(`Geldkonten können keine Spendenkonten sein: ${geld.join(', ')}.`);
    // Konto, auf das auch andere Beitragsarten gebucht werden: Lastschriften werden über die Beitragsart getrennt, manuelle Buchungen nicht
    const fremd = (await tx`select art, bezeichnung, erloeskonto from tco.beitrag where erloeskonto = any(${konten})`).filter((b) => !arten.includes(artNorm(b.art)));
    for (const b of fremd) warnungen.push(`Auf Konto ${b.erloeskonto} wird auch die Beitragsart ${artNorm(b.art)} „${b.bezeichnung ?? ''}“ gebucht, die keine Spende ist – von Hand gebuchte Zahlungen dieser Art auf dem Konto bitte in der App als „keine Spende“ ausschließen.`);
  }
  if (arten.length) {
    const da = new Set((await tx`select art from tco.beitrag`).map((b) => artNorm(b.art)));
    const fehlt = arten.filter((a) => !da.has(a));
    if (fehlt.length) f.push(`Beitragsart nicht im Beitragsstamm: ${fehlt.join(', ')}.`);
  }
  if (e.unterschrift && !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(e.unterschrift)) f.push('Unterschrift: bitte ein Bild im Format PNG oder JPEG wählen.');
  if (e.unterschrift && e.unterschrift.length > 400_000) f.push('Unterschrift: das Bild ist zu groß (höchstens ca. 300 KB).');
  const t = textePruefen(e.texte);
  f.push(...t.fehler);
  if (f.length) throw new BusinessError(f.join(' '));

  const [alt] = await tx`select texte, muster_geprueft_am, muster_geprueft_von from tco.zuw_cfg where id = 1 for update`;
  const geaendert = JSON.stringify(texteMischen(alt.texte)) !== JSON.stringify(texteMischen(t.texte));
  // Die Bestätigung „mit dem amtlichen Muster abgeglichen“ gilt für genau diesen Wortlaut: ändert er sich, ist neu zu bestätigen
  const behalten = e.muster_geprueft && !geaendert && alt.muster_geprueft_am;
  await tx`
    update tco.zuw_cfg set bescheid_art = ${e.bescheid_art}, finanzamt = ${e.finanzamt.trim()}, steuernummer = ${e.steuernummer.trim()},
           bescheid_datum = ${e.bescheid_datum || null}, veranlagungszeitraum = ${e.veranlagungszeitraum.trim()}, zweck = ${e.zweck.trim()},
           zweck_satzung = ${e.zweck_satzung.trim()}, unterzeichner = ${e.unterzeichner.trim()}, funktion = ${e.funktion.trim()}, ort = ${e.ort.trim()},
           unterschrift = ${e.unterschrift || null}, spendenkonten = ${konten.join(',')}, spendenarten = ${arten.join(',')}, mail_erlaubt = ${e.mail_erlaubt},
           texte = ${tx.json(t.texte as never)},
           muster_geprueft_am = ${e.muster_geprueft ? (behalten ? alt.muster_geprueft_am : new Date()) : null},
           muster_geprueft_von = ${e.muster_geprueft ? (behalten ? alt.muster_geprueft_von : benutzer) : null},
           geaendert_am = now(), geaendert_von = ${benutzer}
     where id = 1`;
  return { warnungen };
}

/** Auswahl und Vorschläge für die Einstellungen */
export async function cfgAuswahl(db: Db) {
  const konten = await db`select konto, coalesce(name, '') as name from tco.fikonten where coalesce(kennzahl, '') not in ('BA', 'BK') and konto ~ '^[48]' order by konto`;
  const arten = await db`select art, coalesce(bezeichnung, '') as bezeichnung, coalesce(erloeskonto, '') as erloeskonto from tco.beitrag order by art`;
  return {
    konten: konten.map((k) => ({ konto: k.konto as string, name: k.name as string, vorschlag: /spende/i.test(k.name) })),
    arten: arten.map((a) => ({ art: artNorm(a.art), bezeichnung: a.bezeichnung as string, erloeskonto: a.erloeskonto as string, vorschlag: /spende/i.test(a.bezeichnung) })),
    textbausteine: TEXTE, platzhalter: PLATZHALTER, bescheidarten: Object.entries(BESCHEID).map(([id, b]) => ({ id, text: b.text, jahre: b.jahre })),
  };
}

// ---------------------------------------------------------------- Quellen
export interface Quelle {
  key: string; internenr: string; konto: string; posnr: number; datum: string; betrag: number; text: string; belnr: string;
  /** SOLL = Lastschrift aus der Sollstellung (verbucht), FI = sonstige Buchung auf einem Spendenkonto */
  herkunft: 'SOLL' | 'FI'; artname: string;
  spender: string | null; spender_von: 'SOLL' | 'HAND' | null;
  verzicht: boolean; zbnr: string | null;
  /** warum die Spende (noch) nicht bestätigt werden kann */
  sperre: string | null; ausschluss: string | null; grund: string | null;
  vorschlag: { adrnr: string; name: string } | null;
}
export interface Rueckbuchung { key: string; internenr: string; konto: string; posnr: number; datum: string; betrag: number; text: string; belnr: string; kandidaten: string[] }
export interface SpenderZeile {
  key: string; typ: 'M' | 'X'; adrnr: string | null; spender_id: number | null; name: string; korrespondent: string; anschrift: string[]; email: string;
  /** Adresse ist im Mitgliederstamm als unzustellbar vermerkt – der Versand wird sie ablehnen (bitte drucken) */
  email_unzustellbar: boolean;
  /** fehlende Angaben, ohne die keine Bestätigung ausgestellt wird */
  fehlt: string[]; offen: Quelle[]; bestaetigt: Quelle[]; gesperrt: Quelle[]; summe_offen: number;
}
export interface Vorschlag {
  jahr: number; sperren: string[]; bescheid: BescheidStand; spender: SpenderZeile[]; ohne_spender: Quelle[]; ausgeschlossen: Quelle[];
  rueckbuchungen: Rueckbuchung[]; summe_offen: number; anzahl_offen: number; mail_erlaubt: boolean;
}

export const quelleKey = (q: { internenr: string; konto: string; posnr: number }) => `${q.internenr}|${q.konto}|${q.posnr}`;
export function keyTeilen(key: string): { internenr: string; konto: string; posnr: number } {
  const [internenr, konto, posnr] = key.split('|');
  if (!internenr || !konto || !/^\d+$/.test(posnr ?? '')) throw new BusinessError('Ungültige Buchungsangabe.');
  return { internenr, konto, posnr: Number(posnr) };
}

interface Person { name: string; korrespondent: string; strasse: string; plz: string; ort: string; email: string; unzustellbar?: boolean }
const anschrift = (p: Pick<Person, 'strasse' | 'plz' | 'ort'>) => [p.strasse.trim(), `${p.plz} ${p.ort}`.trim()].filter(Boolean);
const personFehlt = (p: Person) => [!p.name.trim() && 'Name', !p.strasse.trim() && 'Straße', !(p.plz.trim() && p.ort.trim()) && 'PLZ/Ort'].filter(Boolean) as string[];

/** Mitglieder als mögliche Spender (Name und Anschrift aus dem Mitgliederstamm, Schlüssel = Adressnummer 10-stellig) */
async function personenLesen(db: Db): Promise<Map<string, Person>> {
  const out = new Map<string, Person>();
  const mg = await db`select adrnr, coalesce(vorname, '') as vorname, coalesce(nachname, '') as nachname, coalesce(strasse, '') as strasse,
                             coalesce(plz, '') as plz, coalesce(ort, '') as ort, coalesce(email, '') as email,
                             (email_unzustellbar_seit is not null and lower(btrim(coalesce(email, ''))) = coalesce(email_unzustellbar_adresse, '')) as unzustellbar
                        from tco.mitglieder`;
  for (const m of mg) {
    out.set(adrKey(m.adrnr), {
      name: `${m.vorname} ${m.nachname}`.trim(), korrespondent: `${m.nachname} ${m.vorname}`.trim(), strasse: m.strasse, plz: m.plz, ort: m.ort, email: String(m.email).trim(), unzustellbar: !!m.unzustellbar,
    });
  }
  return out;
}

/** Spenden eines Jahres mit Spender, Bestätigung und Sperren – Grundlage von Vorschlagsliste, Vorschau und Ausstellung */
export async function vorschlag(db: Db, v: Pick<Verein, 'name' | 'strasse' | 'plz_ort'>, jahr: number, stichtag = heute()): Promise<Vorschlag> {
  const c = await cfgLesen(db);
  const von = `${jahr}-01-01`;
  const bis = `${jahr}-12-31`;
  const rueckBis = addTage(bis, RUECK_TAGE);
  const zeilen = await db`
    select b.internenr, b.konto, b.posnr, b.datum::text as datum, coalesce(b.soll, 0)::float8 as soll, coalesce(b.haben, 0)::float8 as haben,
           coalesce(b.text, '') as text, coalesce(b.belnr, '') as belnr, coalesce(b.gkonto, '') as gkonto,
           exists (select 1 from tco.fibuchungen s where s.storno_zu = b.internenr) as storniert,
           p.sollper, p.adrnr as p_adrnr, p.zahler_adrnr, p.art, coalesce(p.artname, '') as artname,
           coalesce(g.kennzahl, '') in ('BA', 'BK') as geld,
           m.adrnr as m_adrnr, m.spender_id, coalesce(m.verzicht, false) as verzicht, m.ausschluss, m.grund,
           (select z.zbnr from tco.zuw_pos z where z.internenr = b.internenr and z.konto = b.konto and z.posnr = b.posnr and z.aktiv) as zbnr
      from tco.fibuchungen b
      left join tco.soll_pos p on p.internenr = b.internenr and p.konto = b.konto and p.fi_posnr = b.posnr and p.status = 'V'
      left join tco.fikonten g on g.konto = b.gkonto
      left join tco.zuw_merkmal m on m.internenr = b.internenr and m.konto = b.konto and m.posnr = b.posnr
     where b.datum between ${von} and ${rueckBis} and b.storno_zu is null
       and (b.konto = any(${c.spendenkonten}) or p.sollper is not null)
     order by b.datum, b.internenr, b.konto, b.posnr`;
  const personen = await personenLesen(db);
  const extern = new Map((await db`select * from tco.zuw_spender`).map((s) => [Number(s.spender_id), s]));

  const spenden: Quelle[] = [];
  const rueck: Rueckbuchung[] = [];
  for (const z of zeilen) {
    if (z.storniert) continue;                                        // storniert = nicht zugeflossen
    const ausSoll = z.sollper != null;
    const spendenart = ausSoll && c.spendenarten.includes(artNorm(z.art));
    if (ausSoll && !spendenart) continue;                             // Mitgliedsbeitrag, Jugendtraining, Verzehr: nie bestätigen
    if (!ausSoll && !c.spendenkonten.includes(z.konto)) continue;
    const basis = { key: quelleKey(z as never), internenr: z.internenr as string, konto: z.konto as string, posnr: Number(z.posnr), datum: z.datum as string, text: z.text as string, belnr: z.belnr as string };
    if (z.soll > 0 && !(z.haben > 0)) {
      // Belastung eines Spendenkontos: Rückbuchung (z. B. Rücklastschrift), solange sie nicht geklärt ist
      if (z.ausschluss !== 'GEKLAERT') rueck.push({ ...basis, betrag: runden(z.soll), kandidaten: [] });
      continue;
    }
    if (!(z.haben > 0) || z.datum > bis) continue;
    let spender: string | null = null;
    let spenderVon: Quelle['spender_von'] = null;
    if (z.spender_id != null) { spender = `X:${z.spender_id}`; spenderVon = 'HAND'; }
    else if (z.m_adrnr) { spender = `M:${adrKey(z.m_adrnr)}`; spenderVon = 'HAND'; }
    else if (ausSoll) { spender = `M:${adrKey(z.zahler_adrnr) || adrKey(z.p_adrnr)}`; spenderVon = 'SOLL'; }
    const q: Quelle = {
      ...basis, betrag: runden(z.haben), herkunft: ausSoll ? 'SOLL' : 'FI', artname: ausSoll ? String(z.artname).trim() || 'Spende' : 'Spende',
      spender, spender_von: spenderVon, verzicht: !!z.verzicht, zbnr: z.zbnr ?? null, sperre: null,
      ausschluss: z.ausschluss === 'RUECKLAST' || z.ausschluss === 'KEINE_SPENDE' ? z.ausschluss : null, grund: z.grund ?? null, vorschlag: null,
    };
    if (q.ausschluss) q.sperre = `${q.ausschluss === 'RUECKLAST' ? 'Rücklastschrift – nicht zugeflossen' : 'Keine Spende'}${q.grund ? `: ${q.grund}` : ''}`;
    else if (!z.geld) q.sperre = `Gegenkonto ${z.gkonto || '–'} ist kein Geldkonto – kein Zufluss (Umbuchung).`;
    else if (q.datum > stichtag) q.sperre = `Das Buchungsdatum ${dat(q.datum)} liegt in der Zukunft.`;
    spenden.push(q);
  }
  // Ungeklärte Rückbuchung sperrt Spenden desselben Kontos mit gleichem Betrag aus den RUECK_TAGE Tagen davor
  for (const r of rueck) {
    const ab = addTage(r.datum, -RUECK_TAGE);
    for (const q of spenden) {
      if (q.konto !== r.konto || q.betrag !== r.betrag || q.datum > r.datum || q.datum < ab || q.ausschluss) continue;
      r.kandidaten.push(q.key);
      if (!q.sperre) q.sperre = `Rückbuchung vom ${dat(r.datum)} über ${r.betrag.toFixed(2).replace('.', ',')} € (Beleg ${Number(r.internenr) || r.internenr}) ist ungeklärt – Rücklastschrift?`;
    }
  }
  // Vorschlag für Buchungen ohne Spender: genau ein Mitglied, dessen Vor- und Nachname im Buchungstext steht
  const namen = [...personen.entries()].map(([adrnr, p]) => ({ adrnr, name: p.name, teile: p.name.toLowerCase().split(/\s+/).filter((t) => t.length > 1) })).filter((n) => n.teile.length >= 2);
  for (const q of spenden) {
    if (q.spender || q.zbnr) continue;
    const t = q.text.toLowerCase();
    const treffer = namen.filter((n) => n.teile.every((x) => t.includes(x)));
    if (treffer.length === 1) q.vorschlag = { adrnr: treffer[0].adrnr, name: treffer[0].name };
  }

  const gruppen = new Map<string, SpenderZeile>();
  const ohne: Quelle[] = [];
  const ausgeschlossen: Quelle[] = [];
  for (const q of spenden) {
    if (q.ausschluss && !q.zbnr) { ausgeschlossen.push(q); continue; }
    if (!q.spender) { ohne.push(q); continue; }
    let g = gruppen.get(q.spender);
    if (!g) {
      const typ = q.spender.startsWith('X:') ? 'X' : 'M';
      const id = q.spender.slice(2);
      let p: Person;
      if (typ === 'X') {
        const s = extern.get(Number(id));
        p = { name: [s?.name, s?.zusatz].filter(Boolean).join(', '), korrespondent: s?.name ?? '', strasse: s?.strasse ?? '', plz: s?.plz ?? '', ort: s?.ort ?? '', email: (s?.email ?? '').trim() };
      } else p = personen.get(id) ?? { name: '', korrespondent: '', strasse: '', plz: '', ort: '', email: '' };
      const fehlt = typ === 'M' && !personen.has(id) ? [`Adressnummer ${id || '–'} gibt es im Mitgliederstamm nicht`] : personFehlt(p);
      g = {
        key: q.spender, typ, adrnr: typ === 'M' ? id : null, spender_id: typ === 'X' ? Number(id) : null, name: p.name || `Adressnummer ${id}`, korrespondent: p.korrespondent || p.name,
        anschrift: anschrift(p), email: p.email, email_unzustellbar: !!p.unzustellbar, fehlt, offen: [], bestaetigt: [], gesperrt: [], summe_offen: 0,
      };
      gruppen.set(q.spender, g);
    }
    if (q.zbnr) g.bestaetigt.push(q);
    else if (q.sperre) g.gesperrt.push(q);
    else { g.offen.push(q); g.summe_offen = runden(g.summe_offen + q.betrag); }
  }
  const spender = [...gruppen.values()].sort((a, b) => a.korrespondent.localeCompare(b.korrespondent, 'de') || a.key.localeCompare(b.key));
  return {
    jahr, sperren: sperren(c, v, stichtag), bescheid: bescheidPruefen(c, stichtag), spender, ohne_spender: ohne, ausgeschlossen,
    rueckbuchungen: rueck.filter((r) => r.datum <= bis || r.kandidaten.length > 0),
    summe_offen: runden(spender.reduce((s, g) => s + g.summe_offen, 0)), anzahl_offen: spender.reduce((n, g) => n + g.offen.length, 0), mail_erlaubt: c.mail_erlaubt,
  };
}

// ---------------------------------------------------------------- Merkmale von Hand
async function quellePruefen(tx: Db, k: { internenr: string; konto: string; posnr: number }) {
  const [b] = await tx`select datum::text as datum, coalesce(soll, 0)::float8 as soll, coalesce(haben, 0)::float8 as haben from tco.fibuchungen
                        where internenr = ${k.internenr} and konto = ${k.konto} and posnr = ${k.posnr} and storno_zu is null`;
  if (!b) throw new BusinessError(`Buchung ${k.internenr} (Konto ${k.konto}) nicht gefunden.`, 404);
  const [z] = await tx`select zbnr from tco.zuw_pos where internenr = ${k.internenr} and konto = ${k.konto} and posnr = ${k.posnr} and aktiv`;
  if (z) throw new BusinessError(`Die Spende ist bereits mit ${z.zbnr} bestätigt – Änderungen nur nach Storno der Bestätigung.`, 409);
  return b;
}

export interface MerkmalEingabe {
  key: string; spender?: string | null; verzicht?: boolean;
  /** RUECKLAST | KEINE_SPENDE schließt die Buchung aus, null nimmt den Ausschluss zurück */
  ausschluss?: 'RUECKLAST' | 'KEINE_SPENDE' | null; grund?: string | null;
}

/** Spender, Verzicht bzw. Ausschluss einer Spende von Hand festlegen (nicht für bereits bestätigte Spenden) */
export async function merkmalSichern(tx: Db, e: MerkmalEingabe, benutzer: string): Promise<void> {
  const k = keyTeilen(e.key);
  const b = await quellePruefen(tx, k);
  if (!(b.haben > 0)) throw new BusinessError('Nur Einnahmen (Haben) lassen sich als Spende zuordnen.');
  const [alt] = await tx`select * from tco.zuw_merkmal where internenr = ${k.internenr} and konto = ${k.konto} and posnr = ${k.posnr}`;
  let adrnr: string | null = alt?.adrnr ?? null;
  let spenderId: number | null = alt?.spender_id ?? null;
  if (e.spender !== undefined) {
    adrnr = null; spenderId = null;
    if (e.spender?.startsWith('M:')) {
      const [m] = await tx`select adrnr from tco.mitglieder where adrnr = any(${[e.spender.slice(2), String(Number(e.spender.slice(2)) || '')]}) limit 1`;
      if (!m) throw new BusinessError('Mitglied nicht gefunden.');
      adrnr = m.adrnr;
    } else if (e.spender?.startsWith('X:')) {
      const [s] = await tx`select spender_id from tco.zuw_spender where spender_id = ${Number(e.spender.slice(2)) || 0}`;
      if (!s) throw new BusinessError('Spender nicht gefunden.');
      spenderId = s.spender_id;
    } else if (e.spender) throw new BusinessError('Ungültiger Spender.');
  }
  const ausschluss = e.ausschluss === undefined ? (alt?.ausschluss ?? null) : e.ausschluss;
  const grund = e.ausschluss === undefined ? (alt?.grund ?? null) : (e.grund ?? '').trim() || null;
  if (ausschluss && !grund) throw new BusinessError('Bitte einen Grund angeben, warum die Buchung nicht bestätigt wird.');
  const verzicht = e.verzicht ?? alt?.verzicht ?? false;
  await tx`
    insert into tco.zuw_merkmal (internenr, konto, posnr, adrnr, spender_id, verzicht, ausschluss, grund, geaendert_von)
    values (${k.internenr}, ${k.konto}, ${k.posnr}, ${adrnr}, ${spenderId}, ${verzicht}, ${ausschluss}, ${ausschluss ? grund : null}, ${benutzer})
    on conflict (internenr, konto, posnr) do update set adrnr = excluded.adrnr, spender_id = excluded.spender_id, verzicht = excluded.verzicht,
      ausschluss = excluded.ausschluss, grund = excluded.grund, geaendert_am = now(), geaendert_von = excluded.geaendert_von`;
}

/**
 * Rückbuchung auf einem Spendenkonto klären: Sie betrifft eine Spende (die damit als Rücklastschrift ausgeschlossen wird)
 * oder keine bestätigungsfähige Spende (mit Grund). Danach sperrt sie nichts mehr.
 */
export async function rueckbuchungKlaeren(tx: Db, e: { key: string; betrifft?: string | null; grund?: string | null }, benutzer: string): Promise<void> {
  const k = keyTeilen(e.key);
  const [b] = await tx`select datum::text as datum, coalesce(soll, 0)::float8 as soll from tco.fibuchungen
                        where internenr = ${k.internenr} and konto = ${k.konto} and posnr = ${k.posnr} and storno_zu is null`;
  if (!b || !(b.soll > 0)) throw new BusinessError('Rückbuchung nicht gefunden.', 404);
  const grund = (e.grund ?? '').trim();
  if (e.betrifft) {
    await merkmalSichern(tx, { key: e.betrifft, ausschluss: 'RUECKLAST', grund: `Rückbuchung vom ${dat(b.datum)}, Beleg ${Number(k.internenr) || k.internenr}${grund ? ` – ${grund}` : ''}` }, benutzer);
  } else if (!grund) throw new BusinessError('Bitte die betroffene Spende wählen oder einen Grund angeben.');
  await tx`
    insert into tco.zuw_merkmal (internenr, konto, posnr, ausschluss, grund, geaendert_von)
    values (${k.internenr}, ${k.konto}, ${k.posnr}, 'GEKLAERT', ${e.betrifft ? `betrifft Buchung ${keyTeilen(e.betrifft).internenr}${grund ? ` – ${grund}` : ''}` : grund}, ${benutzer})
    on conflict (internenr, konto, posnr) do update set ausschluss = 'GEKLAERT', grund = excluded.grund, geaendert_am = now(), geaendert_von = excluded.geaendert_von`;
}

export interface SpenderEingabe { name: string; zusatz?: string | null; strasse: string; plz: string; ort: string; email?: string | null }
/** Spender ohne Mitgliedschaft anlegen bzw. ändern (wirkt auf künftige Bestätigungen; ausgestellte bleiben unverändert) */
export async function spenderSichern(tx: Db, id: number | null, e: SpenderEingabe, benutzer: string): Promise<number> {
  const w = { name: e.name.trim(), zusatz: e.zusatz?.trim() || null, strasse: e.strasse.trim(), plz: e.plz.trim(), ort: e.ort.trim(), email: e.email?.trim() || null };
  if (id == null) {
    const [r] = await tx`insert into tco.zuw_spender (name, zusatz, strasse, plz, ort, email, erfasst_von)
                         values (${w.name}, ${w.zusatz}, ${w.strasse}, ${w.plz}, ${w.ort}, ${w.email}, ${benutzer}) returning spender_id`;
    return r.spender_id as number;
  }
  const r = await tx`update tco.zuw_spender set name = ${w.name}, zusatz = ${w.zusatz}, strasse = ${w.strasse}, plz = ${w.plz}, ort = ${w.ort}, email = ${w.email} where spender_id = ${id}`;
  if (!r.count) throw new BusinessError('Spender nicht gefunden.', 404);
  return id;
}

// ---------------------------------------------------------------- Bestätigung
export interface Auftrag { art: 'EINZEL' | 'SAMMEL'; jahr: number; spender: string; quellen?: string[] | null }

/** Dokument (Druckdaten) einer Bestätigung aus dem aktuellen Stand – für Vorschau und Ausstellung */
export async function dokumentBauen(db: Db, v: Verein, a: Auftrag, stichtag = heute()): Promise<{ dok: Dokument; quellen: Quelle[]; spender: SpenderZeile; sperren: string[] }> {
  const vs = await vorschlag(db, v, a.jahr, stichtag);
  const sp = vs.spender.find((s) => s.key === a.spender);
  if (!sp) throw new BusinessError('Für diesen Spender gibt es im gewählten Jahr keine Spenden.', 404);
  const alle = new Map([...sp.offen, ...sp.gesperrt, ...sp.bestaetigt].map((q) => [q.key, q]));
  const keys = a.quellen?.length ? [...new Set(a.quellen)] : sp.offen.map((q) => q.key);
  const quellen: Quelle[] = [];
  for (const k of keys) {
    const q = alle.get(k);
    if (!q) throw new BusinessError('Eine der gewählten Spenden gehört nicht (mehr) zu diesem Spender – bitte die Liste neu laden.', 409);
    if (q.zbnr) throw new BusinessError(`Die Spende vom ${dat(q.datum)} über ${q.betrag.toFixed(2).replace('.', ',')} € ist bereits mit ${q.zbnr} bestätigt.`, 409);
    if (q.sperre) throw new BusinessError(`Die Spende vom ${dat(q.datum)} kann nicht bestätigt werden: ${q.sperre}`, 409);
    quellen.push(q);
  }
  quellen.sort((x, y) => x.datum.localeCompare(y.datum) || x.key.localeCompare(y.key));
  if (!quellen.length) throw new BusinessError('Für diesen Spender gibt es keine offenen Spenden.');
  if (a.art === 'EINZEL' && quellen.length !== 1) throw new BusinessError('Eine Einzelbestätigung gilt für genau eine Spende.');
  if (a.art === 'SAMMEL') {
    if (quellen.length < 2) throw new BusinessError('Eine Sammelbestätigung fasst mindestens zwei Spenden zusammen – bei nur einer Spende bitte die Einzelbestätigung wählen.');
    // die Sammelbestätigung erklärt, dass es zu ihren Zuwendungen keine weitere Bestätigung gibt – eine ungeklärte Spende des Jahres hält sie deshalb an
    const haengt = sp.gesperrt.filter((q) => !q.ausschluss);
    if (haengt.length) throw new BusinessError(`Sammelbestätigung noch nicht möglich: ${haengt.length === 1 ? 'eine Spende' : `${haengt.length} Spenden`} dieses Spenders im Jahr ${a.jahr} ${haengt.length === 1 ? 'ist' : 'sind'} ungeklärt (${haengt[0].sperre}).`, 409);
  }
  if (sp.fehlt.length) throw new BusinessError(`Name und Anschrift des Zuwendenden sind unvollständig (${sp.fehlt.join(', ')}) – bitte ${sp.typ === 'M' ? 'im Mitgliederstamm' : 'beim Spender'} ergänzen.`);
  const c = await cfgLesen(db);
  const betrag = runden(quellen.reduce((s, q) => s + q.betrag, 0));
  const dok: Dokument = {
    nummer: null, art: a.art, jahr: a.jahr,
    aussteller: { name: v.name, strasse: v.strasse ?? '', plz_ort: v.plz_ort ?? '' },
    spender: { name: sp.name, anschrift: sp.anschrift },
    betrag, betrag_worte: betragInWorten(betrag),
    tag: a.art === 'EINZEL' ? quellen[0].datum : null,
    zeitraum: a.art === 'SAMMEL' ? { von: `${a.jahr}-01-01`, bis: `${a.jahr}-12-31` < stichtag ? `${a.jahr}-12-31` : stichtag } : null,
    verzicht: a.art === 'EINZEL' ? quellen[0].verzicht : false,
    bescheid: { art: c.bescheid_art as BescheidArt, finanzamt: c.finanzamt, steuernummer: c.steuernummer, datum: c.bescheid_datum ?? '', veranlagungszeitraum: c.veranlagungszeitraum },
    zweck: c.zweck, zweck_satzung: c.zweck_satzung, ort: c.ort, datum: stichtag, unterzeichner: c.unterzeichner, funktion: c.funktion, unterschrift: c.unterschrift,
    texte: texteMischen(c.texte) as Texte,
    positionen: quellen.map((q) => ({ datum: q.datum, art: 'Geldspende', verzicht: q.verzicht, betrag: q.betrag })),
  };
  return { dok, quellen, spender: sp, sperren: vs.sperren };
}

export const zbNummer = (jahr: number, lfdnr: number) => `ZB-${jahr}-${String(lfdnr).padStart(4, '0')}`;

/** Sperre für die Nummernvergabe und gegen gleichzeitiges Ausstellen bis Transaktionsende */
async function sperreSetzen(tx: Db) {
  await tx`select pg_advisory_xact_lock(hashtext('tco.zuw_kopf'))`;
}

/**
 * Bestätigung ausstellen: prüft Einstellungen, Bescheid und die gewählten Spenden gegen den aktuellen Stand, vergibt die
 * fortlaufende Nummer ZB-JJJJ-NNNN (Jahr der Zuwendung) und speichert Druckdaten und PDF unveränderlich.
 */
export async function ausstellen(tx: Db, v: Verein, a: Auftrag, benutzer: string, stichtag = heute()): Promise<{ zbnr: string; betrag: number; name: string; art: Auftrag['art'] }> {
  await sperreSetzen(tx);
  const { dok, quellen, spender, sperren: gruende } = await dokumentBauen(tx, v, a, stichtag);
  if (gruende.length) throw new BusinessError(`Ausstellung gesperrt: ${gruende.join(' ')}`, 409);
  const [n] = await tx`select coalesce(max(lfdnr), 0) + 1 as n from tco.zuw_kopf where jahr = ${a.jahr}`;
  const zbnr = zbNummer(a.jahr, Number(n.n));
  dok.nummer = zbnr;
  const pdf = await zuwendungPdf(v, [dok]);
  await tx`
    insert into tco.zuw_kopf (zbnr, jahr, lfdnr, art, adrnr, spender_id, spender_name, spender_anschrift, spender_email, betrag, betrag_worte, tag, zeitraum_von, zeitraum_bis,
                              verzicht, ausgestellt_am, ausgestellt_von, daten, pdf, pdf_sha256)
    values (${zbnr}, ${a.jahr}, ${Number(n.n)}, ${a.art}, ${spender.adrnr}, ${spender.spender_id}, ${dok.spender.name}, ${dok.spender.anschrift.join('\n')}, ${spender.email || null},
            ${dok.betrag}, ${dok.betrag_worte}, ${dok.tag}, ${dok.zeitraum?.von ?? null}, ${dok.zeitraum?.bis ?? null}, ${dok.verzicht}, ${stichtag}, ${benutzer},
            ${tx.json(dok as never)}, ${pdf}, ${crypto.createHash('sha256').update(pdf).digest('hex')})`;
  await tx`
    insert into tco.zuw_pos (zbnr, lfd, internenr, konto, posnr, datum, betrag, verzicht, text)
    select ${zbnr}::text, u.lfd, u.internenr, u.konto, u.posnr, u.datum, u.betrag, u.verzicht = 'J', u.text
      from unnest(${quellen.map((_q, i) => i + 1)}::int[], ${quellen.map((q) => q.internenr)}::text[], ${quellen.map((q) => q.konto)}::text[],
                  ${quellen.map((q) => q.posnr)}::int[], ${quellen.map((q) => q.datum)}::date[], ${quellen.map((q) => q.betrag)}::numeric[],
                  ${quellen.map((q) => (q.verzicht ? 'J' : 'N'))}::text[], ${quellen.map((q) => q.text)}::text[])
           as u (lfd, internenr, konto, posnr, datum, betrag, verzicht, text)`;
  return { zbnr, betrag: dok.betrag, name: dok.spender.name, art: a.art };
}

export interface LaufErgebnis { ausgestellt: { zbnr: string; name: string; betrag: number; art: string }[]; uebersprungen: { name: string; grund: string }[] }
/**
 * Jahreslauf: je Spender mit offenen Spenden eine Sammelbestätigung (bei genau einer Spende eine Einzelbestätigung).
 * Spender mit ungeklärten Spenden oder unvollständiger Anschrift werden übersprungen und genannt.
 */
export async function jahreslauf(tx: Db, v: Verein, jahr: number, benutzer: string, stichtag = heute()): Promise<LaufErgebnis> {
  await sperreSetzen(tx);
  const vs = await vorschlag(tx, v, jahr, stichtag);
  if (vs.sperren.length) throw new BusinessError(`Ausstellung gesperrt: ${vs.sperren.join(' ')}`, 409);
  const out: LaufErgebnis = { ausgestellt: [], uebersprungen: [] };
  for (const sp of vs.spender) {
    if (!sp.offen.length) continue;
    const haengt = sp.gesperrt.filter((q) => !q.ausschluss);
    if (sp.fehlt.length) { out.uebersprungen.push({ name: sp.name, grund: `Anschrift unvollständig (${sp.fehlt.join(', ')})` }); continue; }
    if (haengt.length) { out.uebersprungen.push({ name: sp.name, grund: haengt[0].sperre ?? 'ungeklärte Spende' }); continue; }
    out.ausgestellt.push(await ausstellen(tx, v, { art: sp.offen.length === 1 ? 'EINZEL' : 'SAMMEL', jahr, spender: sp.key }, benutzer, stichtag));
  }
  return out;
}

/** Storno mit Grund: Die Bestätigung bleibt samt PDF gespeichert, ihre Spenden werden wieder frei (Neuausstellung) */
export async function stornieren(tx: Db, zbnr: string, grund: string, benutzer: string): Promise<void> {
  if (!grund.trim()) throw new BusinessError('Bitte einen Stornogrund angeben.');
  await sperreSetzen(tx);
  const [k] = await tx`select status from tco.zuw_kopf where zbnr = ${zbnr} for update`;
  if (!k) throw new BusinessError(`Zuwendungsbestätigung ${zbnr} nicht gefunden.`, 404);
  if (k.status === 'S') throw new BusinessError(`Zuwendungsbestätigung ${zbnr} ist bereits storniert.`, 409);
  await tx`update tco.zuw_kopf set status = 'S', storno_am = now(), storno_von = ${benutzer}, storno_grund = ${grund.trim()} where zbnr = ${zbnr}`;
  await tx`update tco.zuw_pos set aktiv = false where zbnr = ${zbnr}`;
}

export const STATUS: Record<string, string> = { A: 'Ausgestellt', S: 'Storniert' };
export const VERSAND: Record<string, string> = { '': 'Offen', GESENDET: 'Per E-Mail versendet', GEDRUCKT: 'Gedruckt', NICHT_VERSENDET: 'Nicht versendet – bitte drucken' };

/** Liste der ausgestellten Bestätigungen (ohne PDF); „hinweis“ nennt Bestätigungen, deren Buchung inzwischen storniert wurde */
export async function bestaetigungenLesen(db: Db, jahr: number | null) {
  const r = await db`
    select k.zbnr, k.jahr, k.art, k.status, k.adrnr, k.spender_id, k.spender_name, k.spender_email, k.betrag::float8 as betrag, k.tag::text as tag,
           k.zeitraum_von::text as zeitraum_von, k.zeitraum_bis::text as zeitraum_bis, k.ausgestellt_am::text as ausgestellt_am, k.ausgestellt_von,
           k.paperless_id, k.versand_status, k.versand_am::text as versand_am, k.versand_an, k.versand_hinweis,
           k.storno_am::text as storno_am, k.storno_von, k.storno_grund,
           (select count(*)::int from tco.zuw_pos p where p.zbnr = k.zbnr) as anzahl,
           exists (select 1 from tco.zuw_pos p join tco.fibuchungen s on s.storno_zu = p.internenr where p.zbnr = k.zbnr and p.aktiv) as quelle_storniert
      from tco.zuw_kopf k
     where ${jahr == null ? db`true` : db`k.jahr = ${jahr}`}
     order by k.jahr desc, k.lfdnr desc`;
  return r.map((k) => ({
    ...k, status_txt: STATUS[k.status as string], versand_txt: k.status === 'S' ? '' : VERSAND[k.versand_status as string],
    hinweis: k.quelle_storniert && k.status === 'A' ? 'Eine bestätigte Buchung wurde in FI storniert – bitte die Bestätigung stornieren.' : null,
  }));
}

export interface KopfZeile {
  zbnr: string; jahr: number; art: 'EINZEL' | 'SAMMEL'; status: string; adrnr: string | null; spender_id: number | null; spender_name: string; spender_email: string | null;
  betrag: number; ausgestellt_am: string; paperless_id: number | null; versand_status: string; daten: Dokument;
}
export async function kopfLesen(db: Db, zbnr: string): Promise<KopfZeile> {
  const [k] = await db`select zbnr, jahr, art, status, adrnr, spender_id, spender_name, spender_email, betrag::float8 as betrag, ausgestellt_am::text as ausgestellt_am,
                              paperless_id, versand_status, daten from tco.zuw_kopf where zbnr = ${zbnr}`;
  if (!k) throw new BusinessError(`Zuwendungsbestätigung ${zbnr} nicht gefunden.`, 404);
  return k as unknown as KopfZeile;
}
export async function pdfLesen(db: Db, zbnr: string): Promise<Buffer> {
  const [k] = await db`select pdf from tco.zuw_kopf where zbnr = ${zbnr}`;
  if (!k) throw new BusinessError(`Zuwendungsbestätigung ${zbnr} nicht gefunden.`, 404);
  return Buffer.from(k.pdf as Uint8Array);
}
