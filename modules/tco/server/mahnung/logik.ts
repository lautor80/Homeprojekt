/**
 * Mahnwesen – Regeln ohne Datenbank: Fälligkeit, Stufen, nächster Schritt je Posten, Plan eines Laufs, Zeitplan der
 * Automatik, Werte und Standardtexte der E-Mails.
 *
 * Begriffe:
 *  - Posten: eine offene Forderung (Hallenrechnung mit Rest nach Teilzahlungen, gestellte Verzehrabrechnung zur Überweisung).
 *  - Stufe: Zahlungserinnerung → 1. Mahnung → 2. Mahnung (Anzahl, Tage und Gebühr aus den Einstellungen). Die erste Stufe
 *    wird `tage` Tage nach der Fälligkeit fällig, jede weitere `tage` Tage nach der Zustellung der vorherigen.
 *  - Eine Stufe gilt nur als erreicht, wenn sie zugestellt wurde (E-Mail gesendet oder von Hand als Brief/Anruf vermerkt).
 *  - Nach der letzten Stufe gibt es keine weitere E-Mail: Ist deren Frist verstrichen, steht der Posten als
 *    „Forderung manuell klären“ im Arbeitsvorrat des Kassenwarts.
 */
import { z } from 'zod';
import type { Verein } from '../verein.js';
import { addTage, dat, eur, ibanFormat, runden } from '../format.js';
import type { MailtextDef, MailVorlage } from '../mailtexte.js';

export const P_MAHN = { display: 'tco.mahnung:display', execute: 'tco.mahnung:execute', admin: 'tco.mahnung:admin' };
/** Funktionsschalter des automatischen Laufs (funktionen.ts) */
export const F_MAHN_AUTOMATIK = 'tco.mahnung.automatik';
/** Funktionsschalter: Mahnungen als Notiz am Paperless-Dokument der Rechnung bzw. Abrechnung protokollieren */
export const F_MAHN_PAPERLESS = 'tco.mahnung.paperless';

export type PostenArt = 'HALLE' | 'VERZEHR';
export const ART_TEXT: Record<PostenArt, string> = { HALLE: 'Hallenrechnung', VERZEHR: 'Verzehrabrechnung' };
export const MAX_STUFEN = 4;

/** buchungssperre: ab dieser Stufe (zugestellt) darf der Schuldner bis zur Zahlung keine neuen Hallenstunden buchen */
export interface Stufe { name: string; tage: number; gebuehr: number; buchungssperre?: boolean }
export interface MahnCfg {
  aktiv: boolean; modus: 'VORSCHLAG' | 'SENDEN'; wochentage: string; uhrzeit: string;
  /** null = Zahlungsziel des Vereins */
  zahlungsziel_tage: number | null;
  frist_tage: number; stufen: Stufe[]; mindestbetrag: number; max_je_lauf: number; arten: string; halle_gedruckt: boolean; anhang: boolean;
  absender: string; absender_name: string; antwort_an: string; kopie_an: string; letzter_lauf: string | null;
}

export const STANDARD_STUFEN: Stufe[] = [
  { name: 'Zahlungserinnerung', tage: 7, gebuehr: 0, buchungssperre: false }, { name: '1. Mahnung', tage: 14, gebuehr: 0, buchungssperre: false },
  { name: '2. Mahnung', tage: 14, gebuehr: 0, buchungssperre: false },
];

const mail = z.string().trim().max(200).refine((x) => !x || /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(x), 'Bitte eine gültige E-Mail-Adresse angeben');

/** Einstellungen des Mahnwesens (Administration → Einstellungen → TC Oberthal → Mahnwesen) */
export const CFG_SCHEMA = z.object({
  aktiv: z.boolean(),
  modus: z.enum(['VORSCHLAG', 'SENDEN']),
  wochentage: z.array(z.coerce.number().int().min(1).max(7)).max(7).transform((l) => [...new Set(l)].sort().join(',')),
  uhrzeit: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Uhrzeit im Format HH:MM'),
  zahlungsziel_tage: z.union([z.literal('').transform(() => null), z.null(), z.coerce.number().int().min(0).max(90)]),
  frist_tage: z.coerce.number().int().min(1, 'Die neue Zahlungsfrist beträgt mindestens einen Tag').max(60),
  stufen: z.array(z.object({
    name: z.string().trim().min(1, 'Jede Stufe braucht einen Namen').max(40),
    tage: z.coerce.number().int().min(0).max(365),
    gebuehr: z.coerce.number().min(0).max(50, 'Mahngebühr höchstens 50 €').transform(runden),
    buchungssperre: z.boolean().default(false),
  })).min(1, 'Mindestens eine Stufe').max(MAX_STUFEN, `Höchstens ${MAX_STUFEN} Stufen`),
  mindestbetrag: z.coerce.number().min(0).max(1000).transform(runden),
  max_je_lauf: z.coerce.number().int().min(1).max(500),
  arten: z.array(z.enum(['HALLE', 'VERZEHR'])).transform((l) => [...new Set(l)].join(',')),
  halle_gedruckt: z.boolean(),
  anhang: z.boolean(),
  absender: mail, absender_name: z.string().trim().max(80), antwort_an: mail, kopie_an: mail,
}).superRefine((c, ctx) => {
  if (c.aktiv && !c.wochentage) ctx.addIssue({ code: 'custom', message: 'Für die Automatik bitte mindestens einen Wochentag wählen.' });
  if (new Set(c.stufen.map((s) => s.name.toLowerCase())).size !== c.stufen.length) ctx.addIssue({ code: 'custom', message: 'Die Namen der Stufen müssen sich unterscheiden.' });
  // niemand wird vor Ablauf der Frist gemahnt, die ihm die vorherige Stufe eingeräumt hat
  c.stufen.forEach((s, i) => {
    if (i > 0 && s.tage < c.frist_tage) ctx.addIssue({ code: 'custom', message: `„${s.name}“: mindestens ${c.frist_tage} Tage nach der vorherigen Stufe (neue Zahlungsfrist).` });
  });
});

export const artenListe = (cfg: Pick<MahnCfg, 'arten'>) => cfg.arten.split(',').map((x) => x.trim()).filter((x): x is PostenArt => x === 'HALLE' || x === 'VERZEHR');

// ---------------------------------------------------------------------------
// Fälligkeit und Stand je Posten
// ---------------------------------------------------------------------------

/** eigenes Fälligkeitsdatum des Belegs, sonst Rechnungs-/Versanddatum + Zahlungsziel */
export const faelligkeit = (datum: string, eigen: string | null | undefined, zielTage: number) => eigen || addTage(datum, zielTage);

export interface OffenerPosten {
  art: PostenArt; nr: string;
  /** Adressnummer (Mitglied oder Kunde 99…), sonst „K:<Name>“ */
  schuldner: string; name: string;
  /** offener Betrag (Rest nach Teilzahlungen) */
  betrag: number; gesamt: number;
  /** Rechnungs- bzw. Versanddatum */
  datum: string; faellig: string;
}
export interface HistorieZeile {
  id: number; lauf_id: number; art: PostenArt; nr: string; stufe: number; stufe_name: string;
  status: 'VORSCHLAG' | 'GESENDET' | 'NICHT_ERREICHBAR' | 'FEHLER' | 'ENTFALLEN' | 'VERWORFEN';
  /** Tag der Zustellung bzw. des Versuchs (JJJJ-MM-TT) */
  tag: string | null; frist: string | null; an: string | null; meldung: string | null; weg: string | null;
}
export interface SperreZeile { id: number; ebene: 'RECHNUNG' | 'SCHULDNER'; art: PostenArt | null; schluessel: string; grund: string; bis: string | null }

export type Schritt = 'NICHT_FAELLIG' | 'WARTET' | 'MAHNEN' | 'VORSCHLAG' | 'UNERREICHBAR' | 'KLAEREN' | 'GESPERRT' | 'KLEINBETRAG';
export const SCHRITT_TEXT: Record<Schritt, string> = {
  NICHT_FAELLIG: 'noch nicht fällig', WARTET: 'wartet auf Fristablauf', MAHNEN: 'im nächsten Lauf', VORSCHLAG: 'im Vorschlag – wartet auf Freigabe',
  UNERREICHBAR: 'nicht per E-Mail erreichbar', KLAEREN: 'Forderung manuell klären', GESPERRT: 'Mahnsperre', KLEINBETRAG: 'unter dem Mindestbetrag',
};

export interface PostenStand extends OffenerPosten {
  /** erreichte (zugestellte) Stufe, 0 = noch nicht gemahnt */
  stufe: number; stufe_name: string;
  /** Tag der letzten zugestellten Stufe */
  gemahnt_am: string | null;
  /** nächste Stufe – null nach der letzten */
  naechste: number | null; naechste_name: string;
  schritt: Schritt;
  /** ab wann der nächste Schritt ansteht */
  ab: string | null;
  hinweis: string;
  sperre: { id: number; grund: string; bis: string | null; ebene: SperreZeile['ebene'] } | null;
  /** Zeile des letzten erfolglosen Versuchs der nächsten Stufe */
  versuch: { id: number; an: string; meldung: string; tag: string | null } | null;
}

export const sperreAktiv = (s: SperreZeile, heute: string) => !s.bis || s.bis >= heute;
export function sperreFuer(p: Pick<OffenerPosten, 'art' | 'nr' | 'schuldner'>, sperren: SperreZeile[], heute: string): SperreZeile | null {
  return sperren.find((s) => sperreAktiv(s, heute) && (s.ebene === 'RECHNUNG' ? s.art === p.art && s.schluessel === p.nr : s.schluessel === p.schuldner)) ?? null;
}

/**
 * Stand und nächster Schritt je offenem Posten.
 * `adressen`: aktuelle E-Mail-Adresse je Schuldner – ein Posten, dessen letzter Versuch die Adresse nicht erreichte, wird
 * erst wieder vorgeschlagen, wenn sich die Adresse geändert hat (sonst bleibt er in der Liste „nicht erreichbar“).
 */
export function standErmitteln(posten: OffenerPosten[], historie: HistorieZeile[], sperren: SperreZeile[], cfg: Pick<MahnCfg, 'stufen' | 'frist_tage' | 'mindestbetrag'>,
  heute: string, adressen: Map<string, string> = new Map()): PostenStand[] {
  const jeNr = new Map<string, HistorieZeile[]>();
  for (const h of historie) {
    const k = `${h.art}:${h.nr}`;
    if (!jeNr.has(k)) jeNr.set(k, []);
    jeNr.get(k)!.push(h);
  }
  const letzte = cfg.stufen.length;
  const out: PostenStand[] = posten.map((p) => {
    const h = (jeNr.get(`${p.art}:${p.nr}`) ?? []).slice().sort((a, b) => a.id - b.id);
    const zugestellt = h.filter((x) => x.status === 'GESENDET').sort((a, b) => b.stufe - a.stufe || b.id - a.id)[0] ?? null;
    const stufe = zugestellt?.stufe ?? 0;
    const basis: PostenStand = {
      ...p, stufe, stufe_name: zugestellt?.stufe_name ?? '', gemahnt_am: zugestellt?.tag ?? null,
      naechste: stufe < letzte ? stufe + 1 : null, naechste_name: stufe < letzte ? cfg.stufen[stufe].name : '',
      schritt: 'WARTET', ab: null, hinweis: '', sperre: null, versuch: null,
    };
    const s = sperreFuer(p, sperren, heute);
    if (s) return { ...basis, schritt: 'GESPERRT', sperre: { id: s.id, grund: s.grund, bis: s.bis, ebene: s.ebene }, hinweis: `${s.grund}${s.bis ? ` (bis ${dat(s.bis)})` : ''}` };
    if (basis.naechste === null) {
      // letzte Stufe zugestellt: nach Ablauf ihrer Frist manuell klären
      const frist = zugestellt?.frist ?? addTage(zugestellt?.tag ?? heute, cfg.frist_tage);
      return heute > frist
        ? { ...basis, schritt: 'KLAEREN', ab: addTage(frist, 1), hinweis: `${zugestellt?.stufe_name ?? 'letzte Stufe'} vom ${dat(zugestellt?.tag)} ohne Zahlung – Frist ${dat(frist)} verstrichen` }
        : { ...basis, schritt: 'WARTET', ab: addTage(frist, 1), hinweis: `Frist der letzten Stufe läuft bis ${dat(frist)}` };
    }
    const def = cfg.stufen[basis.naechste - 1];
    // frühestens am Tag nach der Fälligkeit; weitere Stufen ab Zustellung der vorherigen
    const ab = stufe === 0 ? addTage(p.faellig, Math.max(1, def.tage)) : addTage(zugestellt!.tag ?? heute, def.tage);
    if (heute < ab) return { ...basis, schritt: stufe === 0 && heute <= p.faellig ? 'NICHT_FAELLIG' : 'WARTET', ab, hinweis: `${def.name} ab ${dat(ab)}` };
    const versuche = h.filter((x) => x.stufe === basis.naechste);
    if (versuche.some((x) => x.status === 'VORSCHLAG')) return { ...basis, schritt: 'VORSCHLAG', ab, hinweis: `${def.name} vorgeschlagen` };
    const zuletzt = versuche.filter((x) => x.status === 'NICHT_ERREICHBAR' || x.status === 'FEHLER').at(-1);
    if (zuletzt?.status === 'NICHT_ERREICHBAR') {
      const jetzt = adressen.get(p.schuldner) ?? '';
      const versuch = { id: zuletzt.id, an: zuletzt.an ?? '', meldung: zuletzt.meldung ?? '', tag: zuletzt.tag };
      if (!jetzt || jetzt.toLowerCase() === (zuletzt.an ?? '').toLowerCase()) {
        return { ...basis, schritt: 'UNERREICHBAR', ab, versuch, hinweis: `${def.name} nicht zugestellt: ${zuletzt.meldung ?? 'keine E-Mail-Adresse'}` };
      }
      return { ...basis, schritt: 'MAHNEN', ab, versuch, hinweis: `${def.name} – neue E-Mail-Adresse, erneuter Versuch` };
    }
    return { ...basis, schritt: 'MAHNEN', ab, hinweis: zuletzt ? `${def.name} – erneuter Versuch nach Fehler` : def.name };
  });
  // Kleinbeträge: Summe der anstehenden Posten je Schuldner unter dem Mindestbetrag → nicht mahnen
  const summe = new Map<string, number>();
  for (const p of out) if (p.schritt === 'MAHNEN') summe.set(p.schuldner, (summe.get(p.schuldner) ?? 0) + p.betrag);
  for (const p of out) {
    if (p.schritt === 'MAHNEN' && runden(summe.get(p.schuldner) ?? 0) < cfg.mindestbetrag) {
      p.schritt = 'KLEINBETRAG';
      p.hinweis = `offen ${eur(runden(summe.get(p.schuldner) ?? 0))} – unter dem Mindestbetrag von ${eur(cfg.mindestbetrag)}`;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plan eines Laufs: je Schuldner eine E-Mail mit allen anstehenden Posten
// ---------------------------------------------------------------------------

export interface MahnMail {
  schuldner: string; name: string; posten: PostenStand[];
  /** höchste Stufe der Posten – sie bestimmt Text und Gebühr */
  stufe: number; stufe_name: string;
  summe: number; gebuehr: number;
}
export interface Plan { mails: MahnMail[]; zurueckgestellt: MahnMail[] }

export function planen(stand: PostenStand[], cfg: Pick<MahnCfg, 'stufen' | 'max_je_lauf'>): Plan {
  const gruppen = new Map<string, PostenStand[]>();
  for (const p of stand) {
    if (p.schritt !== 'MAHNEN' || p.naechste === null) continue;
    if (!gruppen.has(p.schuldner)) gruppen.set(p.schuldner, []);
    gruppen.get(p.schuldner)!.push(p);
  }
  const alle: MahnMail[] = [...gruppen.entries()].map(([schuldner, posten]) => {
    posten.sort((a, b) => a.faellig.localeCompare(b.faellig) || a.nr.localeCompare(b.nr));
    const stufe = Math.max(...posten.map((p) => p.naechste!));
    const def = cfg.stufen[stufe - 1];
    return { schuldner, name: posten[0].name, posten, stufe, stufe_name: def.name, summe: runden(posten.reduce((s, p) => s + p.betrag, 0)), gebuehr: def.gebuehr };
  });
  // älteste Forderung zuerst; über der Obergrenze wartet der Rest auf den nächsten Lauf
  alle.sort((a, b) => a.posten[0].faellig.localeCompare(b.posten[0].faellig) || a.schuldner.localeCompare(b.schuldner));
  return { mails: alle.slice(0, cfg.max_je_lauf), zurueckgestellt: alle.slice(cfg.max_je_lauf) };
}

// ---------------------------------------------------------------------------
// Zeitplan der Automatik
// ---------------------------------------------------------------------------

/** Datum, Uhrzeit und ISO-Wochentag (1 = Montag) in Ortszeit des Vereins */
export function lokal(d: Date): { datum: string; zeit: string; wochentag: number } {
  const t = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return { datum: `${t.year}-${t.month}-${t.day}`, zeit: `${t.hour}:${t.minute}`, wochentag: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(t.weekday) + 1 };
}
const tage = (cfg: Pick<MahnCfg, 'wochentage'>) => cfg.wochentage.split(',').map((x) => Number(x.trim())).filter((n) => n >= 1 && n <= 7);

/** Automatik fällig: eingeschaltet, heute ein gewählter Wochentag, Uhrzeit erreicht und heute noch nicht gelaufen */
export function automatikFaellig(cfg: Pick<MahnCfg, 'aktiv' | 'wochentage' | 'uhrzeit' | 'letzter_lauf'>, jetzt = new Date()): boolean {
  if (!cfg.aktiv) return false;
  const h = lokal(jetzt);
  if (!tage(cfg).includes(h.wochentag) || h.zeit < cfg.uhrzeit) return false;
  return !cfg.letzter_lauf || lokal(new Date(cfg.letzter_lauf)).datum !== h.datum;
}

/** nächster automatischer Lauf (Datum JJJJ-MM-TT) – null, wenn die Automatik aus ist */
export function naechsterLauf(cfg: Pick<MahnCfg, 'aktiv' | 'wochentage' | 'uhrzeit' | 'letzter_lauf'>, jetzt = new Date()): string | null {
  if (!cfg.aktiv || !tage(cfg).length) return null;
  const h = lokal(jetzt);
  const heuteGelaufen = !!cfg.letzter_lauf && lokal(new Date(cfg.letzter_lauf)).datum === h.datum;
  for (let i = 0; i < 8; i++) {
    const wt = ((h.wochentag - 1 + i) % 7) + 1;
    if (!tage(cfg).includes(wt) || (i === 0 && heuteGelaufen)) continue;
    return addTage(h.datum, i);
  }
  return null;
}

// ---------------------------------------------------------------------------
// E-Mail: Werte der Platzhalter und Standardtexte je Stufe
// ---------------------------------------------------------------------------

export const MAHN_PLATZHALTER = {
  Anrede: 'Anrede mit Vorname („Hallo Mia“, ohne Vorname „Guten Tag“)',
  Stufe: 'Name der Stufe aus den Einstellungen (z. B. „1. Mahnung“)',
  Posten: 'alle fälligen Posten, je Zeile: Art, Nummer, Datum, fällig am, offener Betrag',
  Rechnungsnummer: 'Rechnungs- bzw. Belegnummern, mit Komma getrennt',
  Betrag: 'offener Gesamtbetrag einschließlich Mahngebühr, mit Währung',
  Gebuehr: 'Satz zur Mahngebühr (leer ohne Gebühr)',
  Faelligkeit: 'Fälligkeitsdatum (bei mehreren Posten das älteste)',
  Frist: 'neue Zahlungsfrist (Datum)',
  Bankverbindung: 'Kontoinhaber, IBAN, BIC, Bank und Verwendungszweck',
};

/** Werte der Platzhalter für die E-Mail an einen Schuldner */
export function mailWerte(v: Pick<Verein, 'name' | 'iban' | 'bic' | 'bank'>, vorname: string, m: Pick<MahnMail, 'posten' | 'stufe_name' | 'summe' | 'gebuehr'>, frist: string): Record<string, string> {
  const nrs = m.posten.map((p) => p.nr).join(', ');
  return {
    Anrede: vorname.trim() ? `Hallo ${vorname.trim()}` : 'Guten Tag',
    Stufe: m.stufe_name,
    Posten: m.posten.map((p) => `${ART_TEXT[p.art]} ${p.nr} vom ${dat(p.datum)}, fällig am ${dat(p.faellig)}: ${eur(p.betrag)}${p.betrag < p.gesamt ? ` (Rest von ${eur(p.gesamt)})` : ''}`).join('\n'),
    Rechnungsnummer: nrs,
    Betrag: eur(runden(m.summe + m.gebuehr)),
    Gebuehr: m.gebuehr > 0 ? `Darin enthalten ist eine Mahngebühr von ${eur(m.gebuehr)}.` : '',
    Faelligkeit: dat(m.posten.map((p) => p.faellig).sort()[0]),
    Frist: dat(frist),
    Bankverbindung: [`Kontoinhaber: ${v.name}`, `IBAN: ${ibanFormat(v.iban)}`, ...(v.bic ? [`BIC: ${v.bic}`] : []), ...(v.bank ? [`Bank: ${v.bank}`] : []), `Verwendungszweck: ${nrs}`].join('\n'),
  };
}

const gruss = (v: Verein) => `Viele Grüße\n${v.ansprechpartner || v.name}`;
const ENDE = 'Hast du inzwischen bezahlt, betrachte diese E-Mail bitte als gegenstandslos.';
const STANDARD: ((v: Verein) => MailVorlage)[] = [
  (v) => ({
    betreff: `${v.name}: Zahlungserinnerung zu {Rechnungsnummer}`,
    text: '{Anrede},\n\nsicher ist es im Alltag untergegangen: Zu folgenden Posten haben wir noch keinen Zahlungseingang festgestellt.\n\n{Posten}\n\n'
      + 'Offener Betrag: {Betrag}\n{Gebuehr}\n\nBitte überweise den Betrag bis zum {Frist} auf unser Vereinskonto:\n\n{Bankverbindung}\n\n'
      + `${ENDE}\n\n${gruss(v)}`,
  }),
  (v) => ({
    betreff: `${v.name}: {Stufe} zu {Rechnungsnummer}`,
    text: '{Anrede},\n\nauf unsere Zahlungserinnerung haben wir leider noch keinen Zahlungseingang festgestellt. Folgende Posten sind seit dem {Faelligkeit} fällig:\n\n{Posten}\n\n'
      + 'Offener Betrag: {Betrag}\n{Gebuehr}\n\nBitte überweise den Betrag bis spätestens {Frist} auf unser Vereinskonto:\n\n{Bankverbindung}\n\n'
      + `${ENDE} Bei Fragen oder wenn etwas nicht stimmt, melde dich bitte kurz bei uns.\n\n${gruss(v)}`,
  }),
  (v) => ({
    betreff: `${v.name}: {Stufe} zu {Rechnungsnummer}`,
    text: '{Anrede},\n\ntrotz unserer bisherigen Schreiben sind folgende Posten weiterhin offen (fällig seit dem {Faelligkeit}):\n\n{Posten}\n\n'
      + 'Offener Betrag: {Betrag}\n{Gebuehr}\n\nWir bitten dich, den Betrag bis spätestens {Frist} auf unser Vereinskonto zu überweisen:\n\n{Bankverbindung}\n\n'
      + `Geht bis dahin keine Zahlung ein, wendet sich der Vorstand persönlich an dich. ${ENDE}\n\n${gruss(v)}`,
  }),
];

/** Schlüssel des E-Mail-Textes einer Stufe (Verzeichnis der E-Mail-Texte) */
export const mailtextSchluessel = (stufe: number) => `mahnung.stufe${Math.min(Math.max(stufe, 1), MAX_STUFEN)}`;

/** Einträge für das Verzeichnis der E-Mail-Texte: je Stufe ein pflegbarer Text */
export const MAHN_MAILTEXTE: MailtextDef[] = Array.from({ length: MAX_STUFEN }, (_x, i) => ({
  schluessel: mailtextSchluessel(i + 1), bereich: 'Mahnwesen',
  name: `Stufe ${i + 1}${STANDARD_STUFEN[i] ? ` (Vorgabe: ${STANDARD_STUFEN[i].name})` : ' (nur bei vier Stufen)'}`,
  wann: `Mahnlauf: E-Mail an Schuldner, deren höchste fällige Stufe die ${i + 1}. ist – je Schuldner eine E-Mail mit allen fälligen Posten`,
  platzhalter: MAHN_PLATZHALTER, pflicht: ['Posten', 'Betrag'],
  standard: STANDARD[Math.min(i, STANDARD.length - 1)],
}));

// ---------------------------------------------------------------------------
// Protokoll am Paperless-Dokument
// ---------------------------------------------------------------------------

export const WEG_TEXT: Record<string, string> = { MAIL: 'per E-Mail', BRIEF: 'per Brief', TELEFON: 'telefonisch', PERSOENLICH: 'persönlich' };

export interface NotizDaten {
  stufe_name: string;
  ergebnis: 'GESENDET' | 'NICHT_ERREICHBAR' | 'FEHLER' | 'ZUGESTELLT';
  /** Zeitpunkt „TT.MM.JJJJ HH:MM“ */
  zeitpunkt: string;
  wer: string;
  lauf_id?: number | null;
  weg?: string | null;
  an?: string | null;
  betrag: number;
  gebuehr?: number;
  /** neue Zahlungsfrist (ISO) */
  frist?: string | null;
  meldung?: string | null;
  /** Dateinamen der Anhänge der E-Mail */
  anhaenge?: string[];
}

/** Text der Notiz am Paperless-Dokument – eine Zeile je Mahnstufe und Ergebnis */
export function notizText(d: NotizDaten): string {
  const lauf = d.lauf_id ? ` (Mahnlauf ${d.lauf_id})` : '';
  const betrag = `offen ${eur(d.betrag)}${d.gebuehr ? `, Mahngebühr ${eur(d.gebuehr)}` : ''}`;
  const frist = d.frist ? `, neue Zahlungsfrist ${dat(d.frist)}` : '';
  const bem = d.meldung ? ` – ${d.meldung}` : '';
  if (d.ergebnis === 'GESENDET') {
    const anh = d.anhaenge?.length ? `, Anhang: ${d.anhaenge.join(', ')}` : ', ohne Anhang';
    return `${d.stufe_name} per E-Mail gesendet am ${d.zeitpunkt} an ${d.an}${lauf} durch ${d.wer} – ${betrag}${frist}${anh}`;
  }
  if (d.ergebnis === 'ZUGESTELLT') {
    return `${d.stufe_name} ${WEG_TEXT[d.weg ?? ''] ?? d.weg ?? ''} zugestellt, vermerkt am ${d.zeitpunkt} durch ${d.wer} – ${betrag}${frist}${bem}`;
  }
  const grund = d.meldung ? `: ${d.meldung}` : '';
  const ziel = d.an ? ` an ${d.an}` : '';
  return `${d.stufe_name} nicht zugestellt${ziel} am ${d.zeitpunkt}${lauf}${grund} – ${betrag}. Die Stufe gilt nicht als erreicht.`;
}

// ---------------------------------------------------------------------------
// Offener Vorschlag gegen den aktuellen Zahlungsstand
// ---------------------------------------------------------------------------

export interface VorschlagZeile { art: PostenArt; nr: string; schuldner: string; betrag: number; status: string }

export interface VorschlagAbgleich {
  /** aktuell offener Betrag – null = nicht mehr offen */
  aktuell: number | null;
  /** Grund, warum der Posten beim Senden entfällt bzw. sich geändert hat – null = unverändert */
  hinweis: string | null;
  /** wird beim Freigeben voraussichtlich noch gemahnt */
  gilt: boolean;
}

/**
 * Zeilen eines offenen Vorschlags gegen den aktuellen Stand prüfen: inzwischen bezahlte, nicht mehr offene oder gesperrte
 * Posten sind markiert und zählen nicht mehr mit; bei Teilzahlung gilt der Rest. Dieselbe Prüfung macht das Senden.
 */
export function vorschlagAbgleichen<Z extends VorschlagZeile>(zeilen: Z[], offen: OffenerPosten[], sperren: SperreZeile[], heute: string):
  { zeilen: (Z & VorschlagAbgleich)[]; schuldner: number; betrag: number } {
  const jeNr = new Map(offen.map((o) => [`${o.art}:${o.nr}`, o]));
  const out = zeilen.map((z) => {
    if (z.status !== 'VORSCHLAG') return { ...z, aktuell: z.betrag, hinweis: null, gilt: false };
    const o = jeNr.get(`${z.art}:${z.nr}`);
    if (!o) return { ...z, aktuell: null, hinweis: 'inzwischen bezahlt bzw. nicht mehr offen – entfällt beim Senden', gilt: false };
    const s = sperreFuer(o, sperren, heute);
    if (s) return { ...z, aktuell: o.betrag, hinweis: `Mahnsperre (${s.grund}) – entfällt beim Senden`, gilt: false };
    const hinweis = o.betrag < z.betrag - 0.004 ? `teilbezahlt – gemahnt werden noch ${eur(o.betrag)}` : null;
    return { ...z, aktuell: o.betrag, hinweis, gilt: true };
  });
  const gilt = out.filter((z) => z.gilt);
  return { zeilen: out, schuldner: new Set(gilt.map((z) => z.schuldner)).size, betrag: runden(gilt.reduce((x, z) => x + (z.aktuell ?? 0), 0)) };
}

// ---------------------------------------------------------------------------
// Buchungssperre: keine neuen Hallenstunden bis zur Zahlung
// ---------------------------------------------------------------------------

/**
 * Erste Stufe (1-basiert) mit dem Kennzeichen „Buchungssperre“ – null, wenn keine Stufe es trägt (Sperre aus).
 * Das Kennzeichen gilt „ab dieser Stufe“: auch alle höheren Stufen sperren.
 */
export const sperrStufe = (cfg: Pick<MahnCfg, 'stufen'>): number | null => {
  const i = cfg.stufen.findIndex((s) => !!s.buchungssperre);
  return i < 0 ? null : i + 1;
};

export interface SperrPosten { art: PostenArt; nr: string; schuldner: string; name: string; betrag: number; faellig: string; stufe_name: string; gemahnt_am: string | null }

/**
 * Posten, die eine Buchungssperre auslösen: noch offen (Rest > 0), zugestellte Stufe mindestens die Sperrstufe und keine
 * aktive Mahnsperre (eine Mahnsperre – z. B. Ratenzahlung vereinbart – hebt auch die Buchungssperre auf).
 * Ist alles bezahlt, ist der Posten nicht mehr offen: Die Sperre endet ohne weiteres Zutun.
 */
export function sperrPosten(stand: PostenStand[], cfg: Pick<MahnCfg, 'stufen'>): SperrPosten[] {
  const ab = sperrStufe(cfg);
  if (ab === null) return [];
  return stand.filter((p) => p.stufe >= ab && !p.sperre && p.betrag > 0)
    .map((p) => ({ art: p.art, nr: p.nr, schuldner: p.schuldner, name: p.name, betrag: p.betrag, faellig: p.faellig, stufe_name: p.stufe_name, gemahnt_am: p.gemahnt_am }))
    .sort((a, b) => a.faellig.localeCompare(b.faellig) || a.nr.localeCompare(b.nr));
}

/** Meldung an das Mitglied (Anmeldung, Platz buchen) – null ohne Sperre */
export function sperrText(posten: Pick<SperrPosten, 'nr' | 'betrag'>[]): string | null {
  if (!posten.length) return null;
  const summe = runden(posten.reduce((s, p) => s + p.betrag, 0));
  return `Neue Hallenstunden können erst wieder gebucht werden, wenn ${posten.length === 1 ? 'die angemahnte Rechnung' : 'die angemahnten Rechnungen'} `
    + `${posten.map((p) => p.nr).join(', ')} (offen ${eur(summe)}) bezahlt ${posten.length === 1 ? 'ist' : 'sind'}. `
    + 'Nach dem Zahlungseingang wird die Buchung automatisch wieder freigegeben.';
}
