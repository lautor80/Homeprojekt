/**
 * Auftrag aus Beleg: Abgleich der Texterkennung (erkennung.ts) mit den Daten des Portals – Kontakte, Wertelisten,
 * vorhandene Aufträge, Leseprofile. Reine Logik ohne Datenbank (die Zugriffe stehen in routes.ts).
 * Doku: docs/euroflex-belegerfassung.md
 *
 * Grundregel wie in typen.ts: eindeutig → übernehmen · mehrere Möglichkeiten → „unklar“ mit Kandidaten (die Maske fragt
 * nach) · nichts gefunden → „fehlt“ (von Hand nachtragen). Es wird nie geraten.
 */
import type { BelegAnschrift, BelegErkennung, BelegLayout, BelegProfil, BelegVorschlag, Dublette, Feld, Kandidat } from './typen.js';

/** Kontakt des Portals (transport.adressen), soweit der Abgleich ihn braucht */
export interface Kontakt {
  adrnr: number;
  kundenname: string | null;
  kundenname2: string | null;
  strasse: string | null;
  plz: string | null;
  ort: string | null;
}
/** Wert einer Werteliste (transport.werte); inaktive Werte werden nicht vorgeschlagen */
export interface Listenwert { key: string; text: string; aktiv?: boolean }
export type Wertelisten = Record<'FAHRZEUGTYP' | 'LADEGUT' | 'LADEWEISE' | 'PALETTENTAUSCH', Listenwert[]>;
/** vorhandener Auftrag für die Dublettenprüfung; kunde = Name des Kunden */
export interface AuftragKurz { auftragsnr: string; anlagedatum: string | null; ordernummer: string | null; kunde: string | null }

const fehlt = <T>(hinweis: string | null): Feld<T> => ({ status: 'fehlt', wert: null, kandidaten: [], herkunft: null, hinweis });
const eindeutig = <T>(wert: T, herkunft: string | null, hinweis: string | null): Feld<T> => ({ status: 'eindeutig', wert, kandidaten: [], herkunft, hinweis });
const unklar = <T>(kandidaten: Kandidat<T>[], hinweis: string): Feld<T> => ({ status: 'unklar', wert: null, kandidaten, herkunft: null, hinweis });

// ---------------------------------------------------------------- Vergleichsformen

/** Vergleichsform: klein, Umlaute und ß ausgeschrieben, ohne Akzente und Satzzeichen, einfache Leerzeichen */
export function normal(s: string | null | undefined): string {
  return (s ?? '').normalize('NFC').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Rechtsformen und Füllwörter, die beim Namensvergleich nicht zählen */
const RECHTSFORMEN = new Set([
  'gmbh', 'ggmbh', 'mbh', 'ag', 'kg', 'kgaa', 'co', 'ohg', 'gbr', 'ug', 'eg', 'ev', 'ek', 'se', 'sa', 'sas', 'sarl', 'srl', 'spa', 'bv', 'nv',
  'ltd', 'limited', 'inc', 'llc', 'plc', 'sro', 'doo', 'kft', 'haftungsbeschraenkt', 'und',
]);
/** Wörter, die allein keine Firma kennzeichnen – eine Teilübereinstimmung nur darüber zählt nicht */
const ALLGEMEIN = new Set([
  'spedition', 'speditions', 'transport', 'transporte', 'logistik', 'logistics', 'handel', 'handels', 'holz', 'gruppe', 'group', 'international',
  'deutschland', 'gesellschaft', 'firma', 'werk', 'werke', 'service', 'services',
]);

/** Wörter eines Firmennamens in Vergleichsform, ohne Rechtsform („Muster GmbH & Co. KG“ → [muster], „Exemple S.A.“ → [exemple]) */
export function namensWoerter(name: string | null | undefined): string[] {
  // Abkürzungen mit Punkten zusammenziehen: „S.A.“ → „sa“, „e. K.“ → „ek“, „S.à r.l.“ bleibt über die Wortliste erkennbar
  const roh = (name ?? '').normalize('NFC').toLowerCase().replace(/\b(?:[a-zà-ÿ]\.\s?){2,}/g, (m) => `${m.replace(/[.\s]/g, '')} `);
  const alle = normal(roh).replace(/\bsp z ?o ?o\b/g, ' ').split(' ').filter(Boolean);
  const ohne = alle.filter((w) => !RECHTSFORMEN.has(w));
  // besteht der Name nur aus solchen Wörtern, bleibt er wie er ist
  return ohne.length ? ohne : alle;
}

const plzForm = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/^\s*[A-Z]{1,3}\s*-\s*/, '').replace(/[^A-Z0-9]/g, '');

function enthaelt(lang: string[], kurz: string[]): boolean {
  for (let i = 0; i + kurz.length <= lang.length; i++) if (kurz.every((w, j) => lang[i + j] === w)) return true;
  return false;
}

/** voll = gleicher Name · teil = der kürzere Name steht als Wortfolge im längeren und enthält ein kennzeichnendes Wort */
function namensgrad(beleg: string[], kontakt: string[]): 'voll' | 'teil' | null {
  if (!beleg.length || !kontakt.length) return null;
  if (beleg.length === kontakt.length && beleg.every((w, i) => w === kontakt[i])) return beleg.join('').length >= 2 ? 'voll' : null;
  const [kurz, lang] = beleg.length < kontakt.length ? [beleg, kontakt] : [kontakt, beleg];
  if (kurz.length === lang.length || !enthaelt(lang, kurz)) return null;
  if (kurz.join('').length < 4 || !kurz.some((w) => w.length >= 3 && !ALLGEMEIN.has(w) && !/^\d+$/.test(w))) return null;
  return 'teil';
}

// ---------------------------------------------------------------- Kunde

/** Anzeigetext eines Kontakts in der Auswahl: „Name, PLZ Ort“ */
export function kontaktText(k: Kontakt): string {
  const name = [k.kundenname, k.kundenname2].map((x) => (x ?? '').trim()).filter(Boolean).join(' ');
  const ort = [k.plz, k.ort].map((x) => (x ?? '').trim()).filter(Boolean).join(' ');
  return ort ? `${name}, ${ort}` : name;
}

/**
 * Wie sicher passt ein Kontakt zu einer Firma des Belegs?
 *  3 = gleicher Name, PLZ oder Ort bestätigt · 2 = gleicher Name ohne Ortsangabe auf einer Seite, oder Teilname mit gleicher PLZ
 *  1 = nur Kandidat (Teilname ohne passende PLZ, oder gleicher Name an einem anderen Ort) · 0 = passt nicht
 */
export function kontaktStufe(firma: BelegAnschrift, k: Kontakt): 0 | 1 | 2 | 3 {
  const beleg = namensWoerter(firma.name);
  const n1 = namensWoerter(k.kundenname);
  const n12 = namensWoerter(`${k.kundenname ?? ''} ${k.kundenname2 ?? ''}`);
  const grade = [namensgrad(beleg, n1), namensgrad(beleg, n12)];
  const grad = grade.includes('voll') ? 'voll' : grade.includes('teil') ? 'teil' : null;
  if (!grad) return 0;
  const [pb, pk] = [plzForm(firma.plz), plzForm(k.plz)];
  const [ob, ok] = [normal(firma.ort), normal(k.ort)];
  const plzGleich = !!pb && pb === pk;
  const bestaetigt = plzGleich || (!!ob && ob === ok);
  const widerspruch = !bestaetigt && ((!!pb && !!pk) || (!!ob && !!ok));
  if (grad === 'voll') return bestaetigt ? 3 : widerspruch ? 1 : 2;
  return plzGleich ? 2 : 1;
}

const NICHT_GEFUNDEN = 'Kunde nicht in den Kontakten gefunden – bitte von Hand wählen oder Kontakt anlegen';
const HOECHSTENS = 20;

/**
 * Auftraggeber laut Beleg gegen die Kontakte: Genau ein Kontakt passt → eindeutig (wert = adrnr). Mehrere Kontakte oder mehrere
 * Firmen mit Treffern → unklar – außer der bevorzugte Kunde des Leseprofils ist unter den sicheren Treffern. Kein Kontakt → fehlt.
 */
export function kundeAbgleichen(feld: Feld<BelegAnschrift>, kontakte: Kontakt[], bevorzugt: number | null = null): { kunde: Feld<number>; kundeImBeleg: BelegAnschrift[] } {
  // alle Firmen laut Beleg, jede einmal
  const roh: { a: BelegAnschrift; herkunft: string | null }[] = feld.status === 'eindeutig' && feld.wert
    ? [{ a: feld.wert, herkunft: feld.herkunft }]
    : feld.status === 'unklar' ? feld.kandidaten.map((k) => ({ a: k.wert, herkunft: k.herkunft })) : [];
  const firmen: typeof roh = [];
  for (const f of roh) {
    if (!f.a || !(f.a.name ?? '').trim()) continue;
    const s = `${namensWoerter(f.a.name).join(' ')}|${plzForm(f.a.plz)}`;
    if (!firmen.some((x) => `${namensWoerter(x.a.name).join(' ')}|${plzForm(x.a.plz)}` === s)) firmen.push(f);
  }
  const kundeImBeleg = firmen.map((f) => f.a);
  if (!firmen.length) return { kunde: fehlt(feld.hinweis ?? 'Im Beleg wurde kein Auftraggeber erkannt – bitte von Hand wählen.'), kundeImBeleg };

  interface Treffer { k: Kontakt; firma: number; herkunft: string }
  const sicher = new Map<number, Treffer>();
  const unsicher = new Map<number, Treffer>();
  firmen.forEach((f, i) => {
    const stufen = kontakte.map((k) => ({ k, stufe: kontaktStufe(f.a, k) })).filter((x) => x.stufe > 0);
    const beste = stufen.reduce((m, x) => Math.max(m, x.stufe), 0);
    // je Firma zählt nur die beste Stufe: ein bestätigter Treffer verdrängt gleichnamige ohne Ort und bloße Kandidaten
    for (const x of stufen.filter((y) => y.stufe === beste)) {
      const t: Treffer = { k: x.k, firma: i, herkunft: f.herkunft ?? f.a.name };
      if (beste >= 2) { if (!sicher.has(x.k.adrnr)) sicher.set(x.k.adrnr, t); } else if (!unsicher.has(x.k.adrnr)) unsicher.set(x.k.adrnr, t);
    }
  });
  for (const nr of sicher.keys()) unsicher.delete(nr);

  if (!sicher.size && !unsicher.size) return { kunde: fehlt(NICHT_GEFUNDEN), kundeImBeleg };
  if (sicher.size === 1 && !unsicher.size) {
    const [t] = [...sicher.values()];
    const hinweis = firmen.length > 1 ? 'Im Beleg stehen mehrere Firmen – nur diese ist in den Kontakten.' : null;
    return { kunde: eindeutig(t.k.adrnr, t.herkunft, hinweis), kundeImBeleg };
  }
  const vorzug = bevorzugt != null ? sicher.get(bevorzugt) : undefined;
  if (vorzug) {
    return { kunde: eindeutig(vorzug.k.adrnr, vorzug.herkunft, 'Mehrere Kontakte passen – gewählt wurde der im Leseprofil hinterlegte Kunde.'), kundeImBeleg };
  }
  const alle = [...sicher.values(), ...unsicher.values()];
  const kandidaten: Kandidat<number>[] = alle.slice(0, HOECHSTENS).map((t) => ({ wert: t.k.adrnr, text: kontaktText(t.k), herkunft: t.herkunft }));
  const hinweis = sicher.size > 1 && new Set([...sicher.values()].map((t) => t.firma)).size > 1
    ? 'Im Beleg stehen mehrere Firmen, die es in den Kontakten gibt – bitte den Auftraggeber wählen.'
    : sicher.size > 1 ? 'Mehrere Kontakte passen zum Auftraggeber im Beleg – bitte wählen.'
      : sicher.size === 1 ? 'Ein Kontakt passt, zu einer weiteren Firma im Beleg gibt es ähnliche Kontakte – bitte den Auftraggeber wählen.'
        : 'Kein Kontakt passt sicher (Name nur teilweise gleich oder anderer Ort) – bitte prüfen und wählen oder Kontakt anlegen.';
  return { kunde: unklar(kandidaten, hinweis), kundeImBeleg };
}

// ---------------------------------------------------------------- Wertelisten

const FUELLWOERTER = new Set(['mit', 'und', 'oder', 'der', 'die', 'das', 'den', 'dem', 'fuer', 'von', 'vom', 'zum', 'zur', 'per', 'bis', 'laut', 'siehe', 'bitte', 'ca']);
const woerter = (n: string) => n.split(' ').filter((w) => w.length >= 3 && !FUELLWOERTER.has(w) && !/^\d+$/.test(w));

/** Werte, die zum Belegtext passen: zuerst gleicher Schlüssel oder gleiche Bezeichnung, sonst Wortvergleich („Plane“ ↔ „Planenauflieger“) */
export function listenTreffer(text: string, werte: Listenwert[]): { treffer: Listenwert[]; genau: boolean } {
  const n = normal(text);
  const aktiv = werte.filter((w) => w.aktiv !== false);
  if (!n) return { treffer: [], genau: false };
  const genau = aktiv.filter((w) => normal(w.key) === n || normal(w.text) === n);
  if (genau.length) return { treffer: genau, genau: true };
  const tb = woerter(n);
  const passt = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a)));
  return { treffer: aktiv.filter((w) => woerter(normal(w.text)).some((b) => tb.some((a) => passt(a, b)))), genau: false };
}

/**
 * Feld mit Belegtext (z. B. „LKW mit Plane 13,6“) gegen eine Werteliste: genau ein Wert → eindeutig (wert = Schlüssel),
 * mehrere → unklar mit Kandidaten, keiner → fehlt; der Hinweis nennt den Belegtext. liste = Name der Liste für den Hinweis.
 */
export function wertAbgleichen(feld: Feld, werte: Listenwert[], liste: string): Feld {
  const texte: { text: string; herkunft: string | null }[] = (feld.status === 'eindeutig' && feld.wert
    ? [{ text: feld.wert, herkunft: feld.herkunft }]
    : feld.status === 'unklar' ? feld.kandidaten.map((k) => ({ text: k.wert, herkunft: k.herkunft })) : [])
    .filter((t) => (t.text ?? '').trim());
  if (!texte.length) return fehlt(feld.hinweis);
  const imBeleg = `Im Beleg: ${texte.map((t) => t.text.trim()).join(' / ')}`;

  if (texte.length === 1) {
    const { treffer, genau } = listenTreffer(texte[0].text, werte);
    if (treffer.length === 1) return eindeutig(treffer[0].key, texte[0].herkunft ?? texte[0].text.trim(), genau ? null : imBeleg);
    if (!treffer.length) return fehlt(`${imBeleg} – kein passender Wert in der Liste ${liste}, bitte von Hand wählen.`);
    return unklar(treffer.map((w) => ({ wert: w.key, text: w.text, herkunft: texte[0].herkunft ?? texte[0].text.trim() })),
      `${imBeleg} – mehrere Werte der Liste ${liste} passen, bitte wählen.`);
  }
  // mehrere mögliche Texte im Beleg: auch ein einzelner passender Wert wird nur vorgeschlagen, nicht übernommen
  const kandidaten: Kandidat[] = [];
  for (const t of texte) {
    for (const w of listenTreffer(t.text, werte).treffer) {
      if (!kandidaten.some((k) => k.wert === w.key)) kandidaten.push({ wert: w.key, text: w.text, herkunft: t.herkunft ?? t.text.trim() });
    }
  }
  if (!kandidaten.length) return fehlt(`${imBeleg} – kein passender Wert in der Liste ${liste}, bitte von Hand wählen.`);
  return unklar(kandidaten, `${imBeleg} – nicht eindeutig, bitte wählen.`);
}

// ---------------------------------------------------------------- Dubletten

/** Vergleichsform der Auftragsnr. des Kunden: getrimmt, ohne Groß-/Kleinschreibung */
export const orderSchluessel = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** Auftragsnummern des Kunden laut Beleg in Vergleichsform – der eindeutige Wert oder alle Kandidaten */
export function ordernummernImBeleg(feld: Feld): string[] {
  const alle = feld.status === 'eindeutig' ? [feld.wert] : feld.status === 'unklar' ? feld.kandidaten.map((k) => k.wert) : [];
  return [...new Set(alle.map(orderSchluessel).filter(Boolean))];
}

/** Vorhandene Aufträge mit derselben Auftragsnr. des Kunden */
export function dublettenFinden(feld: Feld, auftraege: AuftragKurz[]): Dublette[] {
  const nummern = new Set(ordernummernImBeleg(feld));
  if (!nummern.size) return [];
  return auftraege.filter((a) => nummern.has(orderSchluessel(a.ordernummer)))
    .map((a) => ({ auftragsnr: a.auftragsnr, anlagedatum: a.anlagedatum, kunde: a.kunde }));
}

// ---------------------------------------------------------------- Leseprofile

export const LAYOUTS: BelegLayout[] = ['bestellung', 'ladeauftrag', 'allgemein'];
export const STANDARD_PROFILE: BelegProfil[] = [
  { layout: 'bestellung', bezeichnung: 'Bestellung über Frachtkosten', aktiv: true, kunde: null, kunde_name: null },
  { layout: 'ladeauftrag', bezeichnung: 'Ladeauftrag / Transportauftrag', aktiv: true, kunde: null, kunde_name: null },
  { layout: 'allgemein', bezeichnung: 'Allgemein (Schlagworte)', aktiv: true, kunde: null, kunde_name: null },
];

/**
 * Die Leseprofile, wie sie beim Lesen gelten: alle drei Layouts in fester Reihenfolge. Ist die Funktion „Leseprofile pflegen“
 * abgeschaltet (pflege = false), gelten alle als aktiv und ohne bevorzugten Kunden.
 */
export function wirksameProfile(gespeichert: BelegProfil[], pflege: boolean): BelegProfil[] {
  return STANDARD_PROFILE.map((s) => {
    const p = gespeichert.find((x) => x.layout === s.layout);
    if (!p) return { ...s };
    return pflege ? { ...p } : { ...p, aktiv: true, kunde: null, kunde_name: null };
  });
}

// ---------------------------------------------------------------- Vorschlag

export interface Abgleichsdaten {
  kontakte: Kontakt[];
  werte: Wertelisten;
  /** Aufträge, die für die Dublettenprüfung in Frage kommen (die Route liest nur die mit passender Auftragsnr. des Kunden) */
  auftraege: AuftragKurz[];
  /** das Leseprofil des erkannten Layouts */
  profil: { bezeichnung: string; kunde: number | null };
  /** gelesener Text des Belegs */
  text: string;
}

/** Erkennung + Daten des Portals → Vorschlag für die Erfassungsmaske. Stops, Preise, Gewicht, Lademeter, Besonderheiten bleiben unverändert. */
export function belegAbgleichen(e: BelegErkennung, d: Abgleichsdaten): BelegVorschlag {
  const { kunde: kundeFeld, ...rest } = e;
  const { kunde, kundeImBeleg } = kundeAbgleichen(kundeFeld, d.kontakte, d.profil.kunde);
  return {
    ...rest,
    kunde,
    kundeImBeleg,
    fahrzeugtyp: wertAbgleichen(e.fahrzeugtyp, d.werte.FAHRZEUGTYP, 'Fahrzeugtyp'),
    ladegut: wertAbgleichen(e.ladegut, d.werte.LADEGUT, 'Ladegut'),
    ladeweise: wertAbgleichen(e.ladeweise, d.werte.LADEWEISE, 'Ladeweise'),
    palettentausch: wertAbgleichen(e.palettentausch, d.werte.PALETTENTAUSCH, 'Palettentausch'),
    dubletten: dublettenFinden(e.ordernummer, d.auftraege),
    profil: d.profil.bezeichnung,
    text: d.text,
  };
}
