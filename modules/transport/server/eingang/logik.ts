/**
 * Euroflex Posteingang – Zuordnung einer E-Mail zum Auftrag (reine Funktionen ohne Datenbank).
 *
 * Die Verarbeitung (verarbeitung.ts) sammelt Treffer – Antwort auf eine eigene E-Mail, Auftragsnummer, Order-/Lade-/
 * Rechnungsnummer, Absender – und lässt sie hier je Auftrag zu einem Trefferwert (0–100) zusammenrechnen. Eindeutig,
 * mindestens die Schwelle und Funktion „Automatisch ablegen“ an → ablegen, sonst Prüfliste.
 * Fachliche Beschreibung: docs/euroflex-mailworkflows.md, Abschnitt „Eingang“.
 *
 * Bewusst ohne Importe, die Datenbank, Fastify oder zod laden – die Tests laufen ohne Datenbank.
 */
import type { VerbindungDef } from '../../../../server/src/lib/verbindungen.js';
export { absender, dateinameSicher, htmlText, mailHtml, relevanterAnhang } from '../../../tco/server/eingang/logik.js';

/** Punkte je Merkmal (Vertrag, Tabelle „Zuordnung (Punkte)“) */
export const PUNKTE = {
  antwort: 100,
  nummer: 90,
  referenz: 70,
  absenderEinzig: 50,
  absenderMehrere: 30,
} as const;
export const PUNKTE_MAX = 100;

export type Merkmal = 'antwort' | 'nummer' | 'referenz' | 'absender';
/** ein Treffer für einen Auftrag; je Auftrag zählt jedes Merkmal höchstens einmal (der höchste Wert) */
export interface Treffer { auftragsnr: string; art: Merkmal; punkte: number; grund: string }
export interface Grund { grund: string; punkte: number; art?: Merkmal }
export interface Kandidat { auftragsnr: string; punkte: number; gruende: Grund[] }

export interface Entscheidung {
  status: 'abgelegt' | 'pruefen';
  /** eindeutig bester Auftrag – auch als Vorschlag in der Prüfliste; null bei Gleichstand oder ohne Kandidaten */
  auftragsnr: string | null;
  punkte: number;
  begruendung: Grund[];
  eindeutig: boolean;
  /** Klartext, warum geprüft werden muss */
  hinweis: string | null;
}

// Wortgrenze: kein Buchstabe und keine Ziffer davor bzw. dahinter (Unterstrich, Punkt, Bindestrich zählen als Grenze –
// „Lieferschein_2026_0153.pdf“ und mit Fahrtzusatz „2026_0153-2“ sollen treffen)
const NUMMER_GETRENNT = /(?<![\p{L}\p{N}])(20\d{2})[_\-/](\d{4})(?![\p{L}\p{N}])/gu;
const NUMMER_KOMPAKT = /(?<![\p{L}\p{N}])(20\d{2})(\d{4})(?![\p{L}\p{N}])/gu;

/**
 * Auftragsnummern im Text: JJJJ_NNNN, JJJJ-NNNN, JJJJ/NNNN und JJJJNNNN (jeweils mit Wortgrenze; JJJJNNNN nur, wenn es kein Datum JJJJMMTT sein kann) → normalisiert JJJJ_NNNN,
 * ohne Doppelte, in der Reihenfolge des ersten Auftretens. Ob es den Auftrag gibt, prüft der Aufrufer.
 */
export function auftragsnummernFinden(...texte: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const add = (j: string, n: string) => { const nr = `${j}_${n}`; if (!out.includes(nr)) out.push(nr); };
  for (const t of texte) {
    if (!t) continue;
    for (const m of t.matchAll(NUMMER_GETRENNT)) add(m[1], m[2]);
    // JJJJMMTT ist fast immer ein Datum (Dateinamen wie „503_20261117_0503.PDF“) – kompakt nur, was kein Datum sein kann
    for (const m of t.matchAll(NUMMER_KOMPAKT)) if (!istDatumMmTt(m[2])) add(m[1], m[2]);
  }
  return out;
}

/** „1117“ → true (17. November); „1351“, „0000“, „0732“ → false */
export function istDatumMmTt(nnnn: string): boolean {
  const mm = Number(nnnn.slice(0, 2));
  const tt = Number(nnnn.slice(2));
  return mm >= 1 && mm <= 12 && tt >= 1 && tt <= 31;
}

const regexSicher = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normText = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();

/**
 * Referenz (Order-, Lade-, Rechnungsnummer) brauchbar? mindestens 4 Zeichen, mindestens eine Ziffer und nicht nur Nullen –
 * Platzhalter wie „FOLGT“, „Muster“ oder „Bestellung“ stehen in fast jeder Werbemail und ergäben Dutzende Kandidaten.
 */
export function referenzTauglich(wert: string | null | undefined): boolean {
  const w = (wert ?? '').trim();
  return w.length >= 4 && /\p{N}/u.test(w) && !/^[0\s]+$/.test(w);
}

/**
 * Textquelle der Suche: Art (Betreff, Mailtext, Dateiname, Dokument), Name des Dokuments, Text für die Suche (bei OCR mit
 * zusammengezogenen Nummern, siehe ocrNummern) und Originaltext für den Ausschnitt in der Herkunft.
 */
export interface Quelle { art: 'betreff' | 'mailtext' | 'dateiname' | 'dokument'; name: string; text: string; roh: string }

/** Quellen in der Reihenfolge der Herkunftsangaben: Betreff, Mailtext, Dateinamen, Dokumente (Texterkennung) */
export function suchQuellen(q: { betreff: string; text: string; dateien: string[]; ocr: { datei: string; text: string }[] }): Quelle[] {
  return [
    { art: 'betreff', name: '', text: q.betreff, roh: q.betreff },
    { art: 'mailtext', name: '', text: q.text, roh: q.text },
    ...q.dateien.map((d): Quelle => ({ art: 'dateiname', name: d, text: d, roh: d })),
    ...q.ocr.map((o): Quelle => ({ art: 'dokument', name: o.datei, text: ocrNummern(o.text), roh: o.text })),
  ];
}

/**
 * Texterkennung liest den Unterstrich oft als Leerzeichen („2026 0153“, auch „2026 _ 0153“) – in erkanntem Text wird das zur
 * Auftragsnummer zusammengezogen. Nur für OCR-Text: im Mailtext wäre „2026 1234“ zu oft etwas anderes.
 */
export function ocrNummern(text: string): string {
  return text.replace(/(?<![\p{L}\p{N}])(20\d{2})[ \t]*[ _\t][ \t]*(\d{4})(?![\p{L}\p{N}])/gu, '$1_$2');
}

/** Ausschnitt um eine Fundstelle: bis zu 40 Zeichen davor und danach, Leerraum zusammengefasst, mit „…“ an Schnittkanten */
export function ausschnitt(text: string, start: number, ende: number, rand = 40): string {
  const von = Math.max(0, start - rand);
  const bis = Math.min(text.length, ende + rand);
  const t = text.slice(von, bis).replace(/\s+/g, ' ').trim();
  return `${von > 0 ? '…' : ''}${t}${bis < text.length ? '…' : ''}`;
}

const herkunftName = (q: Quelle) => q.art === 'betreff' ? 'Betreff' : q.art === 'mailtext' ? 'Mailtext' : q.art === 'dateiname' ? `Dateiname „${q.name}“`
  : `${/\.pdf$/i.test(q.name) ? 'PDF' : 'Dokument'} „${q.name}“ (Texterkennung)`;

/** Fundstelle im Originaltext suchen (Regex mit Flag u) → „Mailtext: „…Ausschnitt…““; Dateinamen ohne Ausschnitt */
function herkunftEintrag(q: Quelle, muster: RegExp): string | null {
  const m = muster.exec(q.roh);
  if (!m) return null;
  if (q.art === 'dateiname') return herkunftName(q);
  return `${herkunftName(q)}: „${ausschnitt(q.roh, m.index, m.index + m[0].length)}“`;
}

/** Herkunft einer Auftrags-/Rechnungsnummer (JJJJ_NNNN): je Quelle mit Treffer Art, Name und Textausschnitt */
export function herkunftNummer(quellen: Quelle[], nr: string): string[] {
  const [j, n] = nr.split('_');
  const muster = new RegExp(`(?<![\\p{L}\\p{N}])${j}(?:[_\\-/]|[ \\t]*[ _\\t][ \\t]*)?${n}(?![\\p{L}\\p{N}])`, 'u');
  return quellen.filter((q) => auftragsnummernFinden(q.text).includes(nr))
    .map((q) => herkunftEintrag(q, muster) ?? herkunftName(q));
}

/** Herkunft einer Referenz (Wortgrenze, Groß-/Kleinschreibung und Leerraum egal) */
export function herkunftReferenz(quellen: Quelle[], wert: string): string[] {
  const muster = new RegExp(`(?<![\\p{L}\\p{N}])${wert.trim().split(/\s+/).map(regexSicher).join('\\s+')}(?![\\p{L}\\p{N}])`, 'iu');
  return quellen.filter((q) => !!q.text && referenzImText(q.text, wert)).map((q) => herkunftEintrag(q, muster) ?? herkunftName(q));
}

/** „Herkunft: Betreff: „…“; PDF „x.pdf“ (Texterkennung): „…““ */
export function herkunftText(eintraege: string[]): string {
  return `Herkunft: ${eintraege.length ? eintraege.join('; ') : 'E-Mail'}`;
}

/**
 * Vorrang der Nummernsuche: Hat die E-Mail eine Auftrags- oder Rechnungsnummer (oder ist sie die Antwort auf eine eigene E-Mail),
 * zählen nur noch die so gefundenen Aufträge – schwache Treffer (Referenz, Absender) anderer Aufträge fallen weg.
 */
export function nummernVorrang(treffer: Treffer[]): Treffer[] {
  const sicher = new Set(treffer.filter((t) => t.art === 'nummer' || t.art === 'antwort').map((t) => t.auftragsnr));
  return sicher.size ? treffer.filter((t) => sicher.has(t.auftragsnr)) : treffer;
}

/** Steht die Referenz mit Wortgrenze im Text? (Groß-/Kleinschreibung und Leerraum egal) */
export function referenzImText(text: string, wert: string): boolean {
  if (!referenzTauglich(wert)) return false;
  const w = normText(wert.trim());
  const t = normText(text);
  if (!t.includes(w)) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${regexSicher(w)}(?![\\p{L}\\p{N}])`, 'u').test(t);
}

/** Message-IDs ohne spitze Klammern, klein geschrieben (Kopfzeilen In-Reply-To/References können mehrere enthalten) */
export function messageIds(...quellen: (string | null | undefined)[]): string[] {
  const ids: string[] = [];
  for (const q of quellen) {
    for (const t of (q ?? '').split(/[\s,]+/)) {
      const id = t.replace(/^<|>$/g, '').trim().toLowerCase();
      if (id.includes('@') && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/** Objekt im E-Mail-Protokoll → Auftragsnummer: Fahrtzusatz abschneiden („2026_0153-2“ → „2026_0153“) */
export function objektAuftrag(objekt: string | null | undefined): string | null {
  const m = /^\s*(\d{4}_\d{4})(?:-\d+)?\s*$/.exec(objekt ?? '');
  return m ? m[1] : null;
}

/** Absender-Treffer: genau ein offener Auftrag → 50, sonst 30 je Kandidat */
export function absenderTreffer(auftraege: string[], adresse: string): Treffer[] {
  const liste = [...new Set(auftraege)];
  const punkte = liste.length === 1 ? PUNKTE.absenderEinzig : PUNKTE.absenderMehrere;
  const grund = liste.length === 1 ? `Absender ${adresse} gehört zum einzigen offenen Auftrag`
    : `Absender ${adresse} gehört zu ${liste.length} offenen Aufträgen`;
  return liste.map((auftragsnr) => ({ auftragsnr, art: 'absender', punkte, grund }));
}

/**
 * Treffer je Auftrag zusammenrechnen: je Merkmal zählt der höchste Treffer, die Summe ist auf 100 gedeckelt.
 * Ergebnis absteigend nach Punkten (bei Gleichstand nach Auftragsnummer, absteigend – neuere zuerst).
 */
export function bewerten(treffer: Treffer[]): Kandidat[] {
  const je = new Map<string, Map<Merkmal, Treffer>>();
  for (const t of treffer) {
    const m = je.get(t.auftragsnr) ?? new Map<Merkmal, Treffer>();
    const alt = m.get(t.art);
    if (!alt || t.punkte > alt.punkte) m.set(t.art, t);
    je.set(t.auftragsnr, m);
  }
  const reihenfolge: Merkmal[] = ['antwort', 'nummer', 'referenz', 'absender'];
  return [...je].map(([auftragsnr, m]) => {
    const gruende = reihenfolge.filter((a) => m.has(a)).map((a) => ({ grund: m.get(a)!.grund, punkte: m.get(a)!.punkte, art: a }));
    return { auftragsnr, punkte: Math.min(PUNKTE_MAX, gruende.reduce((s, g) => s + g.punkte, 0)), gruende };
  }).sort((a, b) => b.punkte - a.punkte || b.auftragsnr.localeCompare(a.auftragsnr));
}

/** Eindeutig, mindestens die Schwelle und Automatik an → ablegen; sonst Prüfliste (mit Vorschlag, wenn eindeutig) */
export function entscheiden(kandidaten: Kandidat[], schwelle: number, automatik: boolean): Entscheidung {
  const [erster, zweiter] = kandidaten;
  if (!erster) return { status: 'pruefen', auftragsnr: null, punkte: 0, begruendung: [], eindeutig: false, hinweis: 'Kein passender Auftrag gefunden.' };
  const eindeutig = !zweiter || erster.punkte > zweiter.punkte;
  const basis = { punkte: erster.punkte, begruendung: eindeutig ? erster.gruende : [], eindeutig };
  if (!eindeutig) {
    const gleich = kandidaten.filter((k) => k.punkte === erster.punkte).map((k) => k.auftragsnr);
    return { ...basis, status: 'pruefen', auftragsnr: null, hinweis: `Nicht eindeutig: ${gleich.join(', ')} mit je ${erster.punkte} Punkten.` };
  }
  if (erster.punkte < schwelle) {
    return { ...basis, status: 'pruefen', auftragsnr: erster.auftragsnr, hinweis: `Trefferwert ${erster.punkte} liegt unter der Schwelle ${schwelle}.` };
  }
  if (!automatik) {
    return { ...basis, status: 'pruefen', auftragsnr: erster.auftragsnr, hinweis: 'Automatisch ablegen ist abgeschaltet (Administration → Funktionen).' };
  }
  return { ...basis, status: 'abgelegt', auftragsnr: erster.auftragsnr, hinweis: null };
}

/** Mail-Kopfdaten für den Dateinamen der E-Mail als PDF: „2026-11-17 AW Lieferschein 2026_0153.pdf“ */
export function mailDateiname(datum: string, betreff: string): string {
  // eslint-disable-next-line no-control-regex
  const b = betreff.replace(/[\u0000-\u001f\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'E-Mail';
  return `${datum ? `${datum} ` : ''}${b}.pdf`;
}

/** Speicherbelegung → Warnung ab der Grenze aus den Einstellungen */
export const speicherWarnung = (bytes: number, warnungMb: number) => bytes > warnungMb * 1024 * 1024;

// ---------------------------------------------------------------- Anbindung „jetzt abrufen“ (n8n)
export const V_MAILEINGANG = 'transport.maileingang';

/** Anbindung für den Knopf „Jetzt abrufen“ im Posteingang (Administration → Schnittstellen) – nur Daten, ohne Verbindungstest */
export const MAILEINGANG_VERBINDUNG: VerbindungDef = {
  id: V_MAILEINGANG, text: 'Euroflex Maileingang jetzt abrufen (n8n)', reiter: 'E-Mail',
  beschreibung: 'Startet über „Jetzt abrufen“ im Posteingang den n8n-Workflow „Euroflex Maileingang“ (Webhook-Knoten „Webhook Portal“, '
    + 'Production-URL …/webhook/euroflex-maileingang). Anmeldung per Header: Der Webhook-Schlüssel muss dem Wert der n8n-Zugangsdatei am '
    + 'Webhook-Knoten (Name X-Euroflex-Key) entsprechen. Ohne Verbindungstest, weil jeder Aufruf den Abruf wirklich startet. '
    + 'Einrichtung: docs/n8n/EUROFLEX-MAILEINGANG.md.',
  auth: ['header', 'keine'],
  header_name: 'X-Euroflex-Key',
  felder: { url: 'Webhook-URL (z. B. http://n8n:5678/webhook/euroflex-maileingang)', geheimnis: 'Webhook-Schlüssel', header_name: 'Header-Name' },
};

/**
 * Eingangspostfächer für die App „Posteingang“ (Filter und Anzeige): erst die in den Einstellungen eingetragenen mit ihrer
 * Bezeichnung (Reihenfolge der Einstellungen), dann Postfächer, aus denen schon Mails kamen, die nicht eingetragen sind
 * (Bezeichnung = Adresse). Ohne Bezeichnung zeigt die Oberfläche den Teil vor dem @ („info“, „buchhaltung“).
 */
export function postfachListe(eingetragen: { adresse: string; bezeichnung: string }[], gesehen: string[]): { adresse: string; bezeichnung: string }[] {
  const norm = (x: string) => x.trim().toLowerCase();
  const liste = eingetragen.filter((p) => norm(p.adresse))
    .map((p) => ({ adresse: norm(p.adresse), bezeichnung: p.bezeichnung.trim() || norm(p.adresse).split('@')[0] }));
  for (const g of gesehen.map(norm)) if (g && !liste.some((p) => p.adresse === g)) liste.push({ adresse: g, bezeichnung: g });
  return liste;
}
