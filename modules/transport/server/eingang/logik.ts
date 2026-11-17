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
 * Auftragsnummern im Text: JJJJ_NNNN, JJJJ-NNNN, JJJJ/NNNN und JJJJNNNN (jeweils mit Wortgrenze) → normalisiert JJJJ_NNNN,
 * ohne Doppelte, in der Reihenfolge des ersten Auftretens. Ob es den Auftrag gibt, prüft der Aufrufer.
 */
export function auftragsnummernFinden(...texte: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const add = (j: string, n: string) => { const nr = `${j}_${n}`; if (!out.includes(nr)) out.push(nr); };
  for (const t of texte) {
    if (!t) continue;
    for (const m of t.matchAll(NUMMER_GETRENNT)) add(m[1], m[2]);
    for (const m of t.matchAll(NUMMER_KOMPAKT)) add(m[1], m[2]);
  }
  return out;
}

const regexSicher = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normText = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();

/** Referenz (Order-, Lade-, Rechnungsnummer) brauchbar? mindestens 4 Zeichen und nicht nur Nullen/Leerzeichen */
export function referenzTauglich(wert: string | null | undefined): boolean {
  const w = (wert ?? '').trim();
  return w.length >= 4 && /[\p{L}\p{N}]/u.test(w) && !/^0+$/.test(w);
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
  beschreibung: 'Startet über „Jetzt abrufen“ im Posteingang den n8n-Workflow „Euroflex Maileingang“ (Webhook-Knoten „Jetzt abrufen“, '
    + 'Production-URL …/webhook/euroflex-maileingang-abruf). Anmeldung per Header: Der Webhook-Schlüssel muss dem Wert der n8n-Zugangsdatei am '
    + 'Webhook-Knoten (Name X-Euroflex-Key) entsprechen. Ohne Verbindungstest, weil jeder Aufruf den Abruf wirklich startet. '
    + 'Einrichtung: docs/n8n/EUROFLEX-MAILEINGANG.md.',
  auth: ['header', 'keine'],
  header_name: 'X-Euroflex-Key',
  felder: { url: 'Webhook-URL (z. B. http://n8n:5678/webhook/euroflex-maileingang-abruf)', geheimnis: 'Webhook-Schlüssel', header_name: 'Header-Name' },
};
