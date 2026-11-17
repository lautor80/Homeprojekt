/**
 * Sammelversand „Versenden…“ – reine Regeln ohne Datenbank, Fastify oder zod (testbar mit server/test/transport_sammelversand.test.ts).
 * Vertrag: docs/euroflex-mailworkflows.md, Abschnitt „Ausgang (Sammelversand)“.
 *
 *  - eine E-Mail je Auftrag und Empfänger: mehrere Dokumentarten an denselben Empfänger desselben Auftrags werden zusammengefasst
 *    (Betreff und Text der ersten Art, Anhänge aller Arten)
 *  - Transportauftrag je Fahrt an den Unternehmer der Fahrt, Lieferschein an den Kunden, Rechnung an den Rechnungsempfänger (sonst Kunde)
 *  - eine Rechnung (auch eine Sammelrechnung) geht nur einmal hinaus – mit dem ersten ausgewählten Auftrag
 *  - mit aktivem Rechnungsversand (Absender-Postfach/BCC) ist eine Rechnung immer eine eigene E-Mail (nie mit Lieferschein oder
 *    Transportauftrag zusammen): Die BCC-Adresse (z. B. DATEV-Upload) übernimmt jeden Anhang als Beleg
 *  - Modus je E-Mail: Einstellung der ersten Art; „senden“ nur, wenn erlaubt
 */

export type Art = 'T' | 'L' | 'R';
export type Rolle = 'unternehmer' | 'kunde' | 'rechnungsempfaenger';
export type Modus = 'entwurf' | 'senden';

export const ART_REIHENFOLGE: Art[] = ['T', 'L', 'R'];
export const ROLLE_JE_ART: Record<Art, Rolle> = { T: 'unternehmer', L: 'kunde', R: 'rechnungsempfaenger' };
export const ART_TEXT: Record<Art, string> = { T: 'Transportauftrag', L: 'Lieferschein', R: 'Rechnung' };

/** die Felder einer Adresse, die der Versand braucht */
export interface Empfaenger {
  adrnr: number | null;
  kundenname: string | null;
  email: string | null;
  land: string | null;
  anrede: string | null;
  vorname: string | null;
  name: string | null;
}

/** ein zu versendendes Dokument (PDF) eines Auftrags */
export interface VersandDokument {
  auftragsnr: string;
  art: Art;
  /** Position der Fahrt – nur beim Transportauftrag eines Auftrags mit mehreren Fahrten */
  fahrt?: number;
  /** Id für das PDF: Auftragsnummer bzw. „Auftrag-Fahrt“ (T, L) oder Rechnungsnummer (R) */
  kennung: string;
  faktura: string | null;
  empfaenger: Empfaenger | null;
}

export interface MailtextVorlage { art: string; sprache: string; text: string }

export interface GeplanteMail {
  schluessel: string;
  auftragsnr: string;
  fahrt?: number;
  rolle: Rolle;
  empfaenger: Empfaenger | null;
  an: string;
  betreff: string;
  text: string;
  arten: Art[];
  dokumente: VersandDokument[];
}

/** „a@b; c@d e@f“ → Liste der Adressen (ohne Prüfung) */
export const adressListe = (roh: string) => roh.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

/** Was gilt für E-Mails mit Rechnung? Absender und BCC nur mit eingeschalteter Funktion und eingetragenen Werten */
export function rechnungsVersandAus(aktiv: boolean, r: { absender: string; bcc: string }): { absender: string | null; bcc: string[] } {
  if (!aktiv) return { absender: null, bcc: [] };
  return { absender: r.absender.trim() || null, bcc: adressListe(r.bcc) };
}

/** deterministischer Schlüssel einer E-Mail – erste Art bestimmt Fahrt und Rolle */
export const schluesselBilden = (auftragsnr: string, fahrt: number | undefined, rolle: Rolle) => `${auftragsnr}|${fahrt ?? ''}|${rolle}`;

const condense = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Sprache der Vorlage: Deutschland → D, sonst E (wie POST /mails) */
export const sprache = (e: Empfaenger | null): 'D' | 'E' => ((e?.land ?? 'DE') === 'DE' ? 'D' : 'E');

export function anrede(e: Empfaenger | null): string {
  if (sprache(e) === 'E') return 'Dear Sir or Madam';
  if (e?.anrede === 'Herr') return `Sehr geehrter Herr ${condense(`${e.vorname ?? ''} ${e.name ?? ''}`)}`;
  if (e?.anrede === 'Frau') return `Sehr geehrte Frau ${condense(`${e.vorname ?? ''} ${e.name ?? ''}`)}`;
  return 'Sehr geehrte Damen und Herren';
}

/** Betreff und Text eines Dokuments aus den Mailtexten der Stammdaten (wie POST /mails) */
export function mailtext(d: VersandDokument, vorlagen: MailtextVorlage[]): { betreff: string; text: string } {
  const nr = d.art === 'T' ? d.kennung : d.auftragsnr;
  const vorlage = vorlagen.find((t) => t.art === d.art && t.sprache === sprache(d.empfaenger))?.text ?? '';
  const text = vorlage.replace(/\{ANREDE\}/g, anrede(d.empfaenger)).replace(/\{AUFTRAG\}/g, nr).replace(/\{RECHNUNG\}/g, d.faktura ?? '');
  const betreff = d.art === 'T' ? `Transportauftrag ${nr}` : d.art === 'L' ? `Lieferschein ${nr}` : `Rechnung ${d.faktura ?? ''}`.trim();
  return { betreff, text };
}

/** Wer ist „derselbe Empfänger“? Gleiche E-Mail-Adresse, ohne Adresse dieselbe Adressnummer; sonst je Dokument eigen */
export function empfaengerSchluessel(d: VersandDokument): string {
  const mail = (d.empfaenger?.email ?? '').trim().toLowerCase();
  if (mail) return `m:${mail}`;
  if (d.empfaenger?.adrnr) return `a:${d.empfaenger.adrnr}`;
  return `d:${d.art}|${d.fahrt ?? ''}`;
}

/**
 * Dokumente → E-Mails. Reihenfolge bleibt erhalten (Aufträge wie ausgewählt, je Auftrag T je Fahrt, L, R).
 * Rechnungen: jede Rechnungsnummer nur einmal (Sammelrechnung beim ersten ausgewählten Auftrag).
 */
export function mailsPlanen(dokumente: VersandDokument[], vorlagen: MailtextVorlage[], o: { rechnungEinzeln?: boolean } = {}): GeplanteMail[] {
  const mails: GeplanteMail[] = [];
  const index = new Map<string, GeplanteMail>();
  const rechnungen = new Set<string>();
  for (const d of dokumente) {
    if (d.art === 'R') {
      if (!d.faktura || rechnungen.has(d.faktura)) continue;
      rechnungen.add(d.faktura);
    }
    // Rechnungsversand aktiv: Rechnung als eigene E-Mail (Absender/BCC), sonst je Auftrag und Empfänger zusammenfassen
    const k = d.art === 'R' && o.rechnungEinzeln ? `${d.auftragsnr}\u0000R\u0000${d.faktura}` : `${d.auftragsnr}\u0000${empfaengerSchluessel(d)}`;
    const vorhanden = index.get(k);
    if (vorhanden) {
      if (!vorhanden.arten.includes(d.art)) vorhanden.arten.push(d.art);
      vorhanden.dokumente.push(d);
      continue;
    }
    const rolle = ROLLE_JE_ART[d.art];
    const { betreff, text } = mailtext(d, vorlagen);
    const m: GeplanteMail = {
      schluessel: schluesselBilden(d.auftragsnr, d.fahrt, rolle), auftragsnr: d.auftragsnr, ...(d.fahrt ? { fahrt: d.fahrt } : {}), rolle,
      empfaenger: d.empfaenger, an: (d.empfaenger?.email ?? '').trim(), betreff, text, arten: [d.art], dokumente: [d],
    };
    index.set(k, m);
    mails.push(m);
  }
  return mails;
}

/** Modus einer E-Mail: Einstellung der ersten Art; „senden“ nur mit Funktion und Recht und nicht bei „nur Entwürfe“ */
export function modusFuer(arten: Art[], einstellung: Record<Art, { modus: Modus }>, sendenErlaubt: boolean, nurEntwurf = false): Modus {
  const erste = arten[0];
  if (!erste || nurEntwurf || !sendenErlaubt) return 'entwurf';
  return einstellung[erste]?.modus === 'senden' ? 'senden' : 'entwurf';
}

/** gewählte Arten in fester Reihenfolge, ohne Doppelte */
export const artenOrdnen = (arten: Art[]): Art[] => ART_REIHENFOLGE.filter((a) => arten.includes(a));

// ---------------------------------------------------------------- .eml (wie MailEntwurf.emlErzeugen, serverseitig)
const b64Zeilen = (b: Uint8Array) => Buffer.from(b).toString('base64').replace(/.{1,76}/g, '$&\r\n');
/** Kopfzeile mit Umlauten: RFC 2047 (UTF-8, Base64) */
export const kopfKodieren = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

export interface EmlAnhang { name: string; mime: string; daten: Uint8Array }

/** E-Mail-Datei als Entwurf (X-Unsent: 1) – Outlook öffnet sie mit „Senden“ */
export function emlBauen(m: { an: string; cc?: string; bcc?: string; von?: string; betreff: string; text: string; anhaenge: EmlAnhang[] }, grenze = `----=_Euroflex_${Math.random().toString(36).slice(2)}`): string {
  const teile: string[] = [];
  // Rechnungsversand: Absender-Postfach (Outlook nimmt es, wenn das Konto dort eingerichtet ist) und BCC
  if (m.von?.trim()) teile.push(`From: ${m.von.trim()}`);
  teile.push(`To: ${m.an}`);
  if (m.cc?.trim()) teile.push(`Cc: ${m.cc.trim()}`);
  if (m.bcc?.trim()) teile.push(`Bcc: ${m.bcc.trim()}`);
  teile.push(
    `Subject: ${kopfKodieren(m.betreff)}`,
    'X-Unsent: 1',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${grenze}"`,
    '',
    `--${grenze}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64Zeilen(Buffer.from(m.text.replace(/\r?\n/g, '\r\n'), 'utf8')),
  );
  for (const a of m.anhaenge) {
    const n = kopfKodieren(a.name);
    teile.push(`--${grenze}`, `Content-Type: ${a.mime}; name="${n}"`, `Content-Disposition: attachment; filename="${n}"`,
      'Content-Transfer-Encoding: base64', '', b64Zeilen(a.daten));
  }
  teile.push(`--${grenze}--`, '');
  return teile.join('\r\n');
}

/** Dateiname einer EML-Datei aus dem Betreff, innerhalb einer Lieferung eindeutig */
export function emlDateiname(betreff: string, vergeben: Set<string>): string {
  const basis = betreff.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 150) || 'E-Mail';
  let name = `${basis}.eml`;
  for (let i = 2; vergeben.has(name.toLowerCase()); i++) name = `${basis} (${i}).eml`;
  vergeben.add(name.toLowerCase());
  return name;
}
