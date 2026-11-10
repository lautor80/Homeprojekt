/**
 * Dokumenteneingang – Regelwerk (reine Funktionen ohne Datenbank).
 *
 * Eine Regel besteht aus Bedingungen (wann greift sie), optionaler Extraktion (Felder per Muster aus Betreff, Text oder
 * Dokumenttext lesen) und Aktionen (Ablage in Paperless/Nextcloud, Behandlung der E-Mail). Regeln werden nach Priorität
 * geprüft; die erste passende gewinnt. „anhang“-Regeln laufen je Anhang, „mail“-Regeln einmal je E-Mail.
 *
 * Die Ablage nutzt die Vorlagen der zentralen Paperless-Zuordnung: Platzhalter `{name}` mit Modifikatoren wie
 * `{datum|datum}` oder `{datei|ohneEndung}` (siehe server/src/lib/paperless-mapping.ts).
 */
import type { Regel as PaperlessRegel } from '../../../../server/src/lib/paperless-mapping.js';

export const FELDER = {
  von: 'Absender-Adresse',
  domain: 'Absender-Domain',
  von_name: 'Absender-Name',
  an: 'Empfänger',
  postfach: 'Postfach',
  betreff: 'Betreff',
  text: 'Mailtext',
  html: 'Mailtext (HTML)',
  korrespondent: 'Korrespondent',
  mitglied: 'Absender ist Mitglied (ja/nein)',
  anhaenge: 'Anzahl Anhänge',
  datei: 'Dateiname',
  mime: 'Dateityp (MIME)',
  doktext: 'Dokumenttext',
} as const;
export type Feld = keyof typeof FELDER;
export const FELD_IDS = Object.keys(FELDER) as [Feld, ...Feld[]];

export const OPERATOREN = {
  ist: 'ist',
  enthaelt: 'enthält',
  beginnt: 'beginnt mit',
  endet: 'endet mit',
  muster: 'passt auf Muster (Regex)',
  liste: 'ist in Liste (Komma)',
} as const;
export type Operator = keyof typeof OPERATOREN;
export const OPERATOR_IDS = Object.keys(OPERATOREN) as [Operator, ...Operator[]];

export const QUELLEN = { betreff: 'Betreff', text: 'Mailtext', html: 'Mailtext (HTML)', datei: 'Dateiname', doktext: 'Dokumenttext' } as const;
export type Quelle = keyof typeof QUELLEN;
export const QUELLE_IDS = Object.keys(QUELLEN) as [Quelle, ...Quelle[]];

export interface Bedingung { feld: Feld; op: Operator; wert: string; nicht?: boolean }
/** Feld per Muster lesen: erste Klammergruppe des regulären Ausdrucks, sonst der ganze Treffer → Platzhalter {feld.<name>} */
export interface Extraktion { name: string; quelle: Quelle; muster: string; pflicht?: boolean }

export interface MailAktion { art: 'keine' | 'verschieben' | 'loeschen'; ordner?: string; gelesen?: boolean }
export interface Aktionen {
  paperless?: PaperlessRegel & { aktiv: boolean };
  nextcloud?: { aktiv: boolean; pfad: string; dateiname: string };
  /** nur je Anhang: alle Anhänge einer E-Mail, für die die Regel greift, vor der Ablage zu einem PDF zusammenfassen */
  zusammenfassen?: { aktiv: boolean; dateiname: string; reihenfolge: 'mail' | 'name' };
  mail?: MailAktion;
  /** Folgeaufgabe – wird n8n gemeldet; der Knoten dort ist zunächst deaktiviert */
  aufgabe?: { aktiv: boolean; titel: string; faellig_tage?: number | null };
}

export interface RegelDef {
  id: number;
  name: string;
  status: 'aktiv' | 'testlauf' | 'aus';
  prioritaet: number;
  gilt_fuer: 'anhang' | 'mail';
  verknuepfung: 'und' | 'oder';
  bedingungen: Bedingung[];
  extraktion: Extraktion[];
  aktionen: Aktionen;
  automatik: 'immer' | 'pruefen';
  version: number;
}

/** Werte der Bedingungsfelder (alles Text; fehlende Felder gelten als leer) */
export type Kontext = Partial<Record<Feld, string>>;

export interface Korrespondent { id: number; name: string; kurz: string; adressen: string }

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** „Max Muster <max@example.org>“ → Adresse (klein) und Anzeigename */
export function absender(von: string | null | undefined): { adresse: string; name: string; domain: string } {
  const roh = (von ?? '').trim();
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(roh) ?? /([^\s<>"',;]+@[^\s<>"',;]+)/.exec(roh);
  const adresse = (m?.[1] ?? '').toLowerCase();
  const name = roh.replace(/<[^>]*>/g, ' ').replace(/["']/g, ' ').replace(/\s+/g, ' ').trim();
  return { adresse, name: name && name.toLowerCase() !== adresse ? name : '', domain: adresse.split('@')[1] ?? '' };
}

export const listeTeilen = (s: string | null | undefined) => (s ?? '').split(/[,;\n]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);

/** Korrespondent zu einer Absenderadresse: ganze Adresse oder Domain (auch Subdomains, „@“ davor erlaubt) */
export function korrespondentFinden(liste: Korrespondent[], adresse: string): Korrespondent | null {
  const a = adresse.toLowerCase();
  const domain = a.split('@')[1] ?? '';
  if (!a) return null;
  // genaue Adresse schlägt Domain
  for (const k of liste) if (listeTeilen(k.adressen).some((x) => x.includes('@') && !x.startsWith('@') && x === a)) return k;
  for (const k of liste) {
    for (const x of listeTeilen(k.adressen)) {
      const d = x.startsWith('@') ? x.slice(1) : x.includes('@') ? '' : x;
      if (d && (domain === d || domain.endsWith(`.${d}`))) return k;
    }
  }
  return null;
}

export function bedingungPasst(b: Bedingung, k: Kontext): boolean {
  const ist = norm(k[b.feld]);
  const soll = norm(b.wert);
  let ok: boolean;
  switch (b.op) {
    case 'ist': ok = ist === soll; break;
    case 'enthaelt': ok = soll !== '' && ist.includes(soll); break;
    case 'beginnt': ok = soll !== '' && ist.startsWith(soll); break;
    case 'endet': ok = soll !== '' && ist.endsWith(soll); break;
    case 'liste': ok = listeTeilen(b.wert).includes(ist); break;
    case 'muster':
      try { ok = b.wert.trim() !== '' && new RegExp(b.wert, 'i').test(k[b.feld] ?? ''); } catch { ok = false; }
      break;
    default: ok = false;
  }
  return b.nicht ? !ok : ok;
}

/** Regel ohne Bedingungen passt nie (keine versehentliche Auffangregel) */
export function regelPasst(r: Pick<RegelDef, 'bedingungen' | 'verknuepfung'>, k: Kontext): boolean {
  if (!r.bedingungen.length) return false;
  return r.verknuepfung === 'oder' ? r.bedingungen.some((b) => bedingungPasst(b, k)) : r.bedingungen.every((b) => bedingungPasst(b, k));
}

export const sortiert = <T extends { prioritaet: number; id: number }>(regeln: T[]): T[] =>
  [...regeln].sort((a, b) => a.prioritaet - b.prioritaet || a.id - b.id);

/** erste passende Regel (nach Priorität) für eine E-Mail bzw. einen Anhang; ausgeschaltete Regeln zählen nicht */
export function waehlen(regeln: RegelDef[], k: Kontext, art: 'anhang' | 'mail'): RegelDef | null {
  return sortiert(regeln).find((r) => r.status !== 'aus' && r.gilt_fuer === art && regelPasst(r, k)) ?? null;
}

/** Felder laut Extraktion lesen; `fehlend` = Pflichtfelder ohne Treffer */
export function extrahieren(ex: Extraktion[], k: Kontext): { felder: Record<string, string>; fehlend: string[] } {
  const felder: Record<string, string> = {};
  const fehlend: string[] = [];
  for (const e of ex) {
    const name = e.name.trim();
    if (!name) continue;
    let wert = '';
    try {
      const m = new RegExp(e.muster, 'i').exec(k[e.quelle] ?? '');
      wert = (m?.[1] ?? m?.[0] ?? '').replace(/\s+/g, ' ').trim();
    } catch { wert = ''; }
    felder[name] = wert;
    if (!wert && e.pflicht) fehlend.push(name);
  }
  return { felder, fehlend };
}

/** Prüft die regulären Ausdrücke einer Regel; liefert die Fehlertexte */
export function musterFehler(r: Pick<RegelDef, 'bedingungen' | 'extraktion'>): string[] {
  const fehler: string[] = [];
  const pruefe = (muster: string, wo: string) => { try { new RegExp(muster, 'i'); } catch (e) { fehler.push(`${wo}: ${(e as Error).message}`); } };
  for (const b of r.bedingungen) if (b.op === 'muster') pruefe(b.wert, `Bedingung „${FELDER[b.feld]}“`);
  for (const e of r.extraktion) pruefe(e.muster, `Feld „${e.name}“`);
  return fehler;
}

/** Platzhalter der Ablagevorlagen: Grundwerte + extrahierte Felder als {feld.<name>} */
export function platzhalter(basis: Record<string, unknown>, felder: Record<string, string>): Record<string, unknown> {
  const w: Record<string, unknown> = { ...basis };
  for (const [name, wert] of Object.entries(felder)) w[`feld.${name}`] = wert;
  return w;
}

/** Beschreibung der Platzhalter für die Oberfläche */
export const PLATZHALTER: { name: string; text: string }[] = [
  { name: 'datei', text: 'Dateiname des Anhangs (mit {datei|ohneEndung} ohne Endung)' },
  { name: 'betreff', text: 'Betreff der E-Mail' },
  { name: 'von', text: 'Absender-Adresse' },
  { name: 'von_name', text: 'Absender-Name' },
  { name: 'domain', text: 'Absender-Domain' },
  { name: 'postfach', text: 'Postfach' },
  { name: 'datum', text: 'Datum der E-Mail (JJJJ-MM-TT; {datum|datum} = TT.MM.JJJJ)' },
  { name: 'jahr', text: 'Jahr der E-Mail' },
  { name: 'monat', text: 'Monat der E-Mail (zweistellig)' },
  { name: 'heute', text: 'heutiges Datum (JJJJ-MM-TT)' },
  { name: 'korrespondent', text: 'Name des Korrespondenten (Stammdaten)' },
  { name: 'kurz', text: 'Kurzname des Korrespondenten' },
  { name: 'mitglied', text: 'Mitglied „Nachname Vorname“ (Absender ist Mitglied)' },
  { name: 'vorname', text: 'Vorname des Mitglieds' },
  { name: 'nachname', text: 'Nachname des Mitglieds' },
  { name: 'adrnr', text: 'Adressnummer des Mitglieds' },
  { name: 'feld.<name>', text: 'per Muster extrahiertes Feld' },
];

/** Signatur-Logos, Kalender- und Signaturdateien sind keine Dokumente */
export function relevanterAnhang(a: { name: string; mime?: string | null; groesse: number }): boolean {
  const name = a.name.toLowerCase();
  if (/\.(ics|vcf|p7s|asc|sig)$/.test(name) || /^smime\./.test(name)) return false;
  if (/^image\//.test(a.mime ?? '') && a.groesse < 30_000) return false;
  return a.groesse > 0;
}

/** Dateiname ohne Pfad- und Steuerzeichen */
export function dateinameSicher(s: string, ersatz = 'dokument'): string {
  // eslint-disable-next-line no-control-regex
  const n = s.replace(/[\u0000-\u001f\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 150);
  return n || ersatz;
}

/** Ordnerpfad aus einer Vorlage: Segmente säubern, „..“ verwerfen */
export function pfadSicher(s: string): string {
  return s.split('/').map((t) => dateinameSicher(t, '')).filter((t) => t && t !== '..' && t !== '.').join('/');
}

export type DokStatus = 'neu' | 'pruefen' | 'fehler' | 'abgelegt' | 'dublette' | 'ignoriert';
export type VorgangStatus = 'neu' | 'pruefen' | 'fehler' | 'abgelegt' | 'ohne_regel' | 'ignoriert';

/** Status des Vorgangs aus seinen Dokumenten; `mailRegel` = eine aktive Regel hat die E-Mail selbst behandelt */
export function vorgangStatus(dokumente: DokStatus[], mailRegel: boolean): VorgangStatus {
  if (dokumente.includes('fehler')) return 'fehler';
  if (dokumente.includes('pruefen') || dokumente.includes('neu')) return 'pruefen';
  if (!dokumente.length) return mailRegel ? 'abgelegt' : 'ohne_regel';
  if (dokumente.every((d) => d === 'ignoriert')) return mailRegel ? 'abgelegt' : 'ignoriert';
  return 'abgelegt';
}

/** E-Mail als einfaches HTML-Dokument (nur Text – keine fremden Bilder, Skripte oder Nachladen) */
export function mailHtml(m: { von: string; an: string; betreff: string; datum: string; text: string }): string {
  const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const zeile = (t: string, w: string) => `<tr><th>${t}</th><td>${esc(w)}</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Arial,Helvetica,sans-serif;font-size:10.5pt;color:#111}
    table{border-collapse:collapse;margin-bottom:14pt} th{text-align:left;padding:2pt 10pt 2pt 0;color:#555;font-weight:normal;vertical-align:top}
    td{padding:2pt 0} pre{white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:inherit;border-top:1px solid #ccc;padding-top:10pt}
  </style></head><body><table>${zeile('Von', m.von)}${zeile('An', m.an)}${zeile('Datum', m.datum)}${zeile('Betreff', m.betreff)}</table><pre>${esc(m.text)}</pre></body></html>`;
}

/** HTML grob in Text wandeln (für Mails ohne Textteil) */
export function htmlText(html: string | null | undefined): string {
  return (html ?? '').replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>(\s*)/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}
