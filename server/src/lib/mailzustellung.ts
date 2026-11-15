/**
 * Unzustellbare Empfängeradressen: reine Hilfsfunktionen ohne Datenbank.
 *
 * - dauerhafterEmpfaengerfehler(): Sagt die Fehlermeldung des Mailservers, dass es die Adresse nicht gibt? Nur dann wird sie
 *   beim Eigentümer vermerkt (z. B. im Mitgliederstamm, ServerModule.mailUnzustellbar). Konfigurations- und vorübergehende
 *   Fehler (Webhook, Schlüssel, Zeitüberschreitung, 4xx, Absender nicht erlaubt, Spam, Postfach voll) zählen nie.
 * - dsnEmpfaenger(): fehlgeschlagene Adressen aus einer Unzustellbarkeitsnachricht (DSN, RFC 3464).
 * - empfaengerOhne(): gesperrte Adressen aus einem Empfängerfeld nehmen (Versand unterdrücken, lib/mailsperre.ts).
 */
import { adressen } from './mailuebersicht.js';

/** nie ein Fehler der Empfängeradresse: Einrichtung, Erreichbarkeit, Absender, Inhalt, Postfach voll */
const NIE = new RegExp([
  'webhook', 'workflow', 'n8n', 'schlüssel', 'schluessel', 'credential', 'zugangsdatei', 'nicht eingerichtet', 'nicht erreichbar',
  'zeitüberschreitung', 'timeout', 'timed out', 'etimedout', 'econn', 'ehostunreach', 'enetunreach', 'eai_again', 'socket', '\\btls\\b', 'certificate', 'handshake',
  'fetch failed', 'http \\d{3}', 'unerwartete antwort',
  'authenti[cf]', 'auth(orization)? (failed|required|data)', 'login', 'password', 'kennwort', 'anmeld',
  'sender', 'absender', 'mail from', 'from address', 'not owned', 'not allowed to send', 'send as', 'relay', 'spf', 'dkim', 'dmarc',
  'spam', 'blacklist', 'blocklist', 'blocked', 'reputation', 'policy', 'content', 'virus', 'greylist', 'graylist', 'rate limit', 'too many', 'try again', 'temporar',
  'quota', 'mailbox (is )?full', 'over ?quota', 'storage', 'postfach (ist )?voll', 'too large', 'size limit', 'anh[aä]ng',
].join('|'), 'i');

/** Statuscodes, die „diese Adresse gibt es nicht“ bedeuten (RFC 3463: 5.1.x Adresse, 5.4.4 nicht zustellbare Domain) */
const STATUS_ADRESSE = /(?<![\d.])5\.(1\.(1|2|3|6|10)|4\.4)(?![\d.]*\d)/;
/** Statuscodes der Klasse 5, die nie die Adresse meinen: 5.2 Postfach (voll, gesperrt), 5.3 Mailsystem, 5.5 Protokoll, 5.6 Inhalt, 5.7 Richtlinie */
const STATUS_ANDERER = /(?<![\d.])5\.[23567]\.\d{1,3}(?![\d.]*\d)/;
/** sonstiger erweiterter Statuscode der Klasse 5 (5.0.0, 5.4.1 …): nur mit eindeutigem Text ein Adressfehler */
const STATUS_UNBESTIMMT = /(?<![\d.])5\.\d{1,3}\.\d{1,3}(?![\d.]*\d)/;
const STATUS_VORUEBERGEHEND = /(?<![\d.])4\.\d{1,3}\.\d{1,3}(?![\d.]*\d)|(^|[\s:(<\[])4[0-9]{2}[ -]/;
const SMTP_ADRESSE = /(^|[\s:(<\[])55[013][ -]/;
const TEXT_ADRESSE = new RegExp([
  'user unknown', 'unknown user', 'no such user', 'no such (mailbox|recipient|address|account)', 'user (does not|doesn.?t) exist', 'user not found',
  'mailbox unavailable', 'mailbox not found', 'mailbox (does not|doesn.?t) exist', 'no mailbox here', 'unknown (recipient|mailbox|address)',
  'recipient (address )?rejected', 'recipient not found', 'recipient unknown', 'invalid recipient', 'invalid mailbox', 'invalid address',
  'address (does not|doesn.?t) exist', 'address not found', 'account (does not|doesn.?t) exist', 'account (has been )?disabled',
  'bad destination (mailbox|system) address', 'all recipients were rejected', 'no valid recipients',
  'domain not found', 'domain (does not|doesn.?t) exist', 'unknown domain', 'no such domain', 'nxdomain', 'host or domain name not found',
  'unrouteable address', 'unroutable address', 'domain existiert nicht', 'empfänger unbekannt', 'adresse unbekannt', 'postfach (nicht gefunden|unbekannt|existiert nicht)',
  // der n8n-Workflow „TCO Mailversand“ prüft die Schreibweise selbst
  'ungültige adresse in (an|cc|bcc):',
].join('|'), 'i');

/**
 * true nur, wenn die Fehlermeldung eindeutig sagt, dass es die Empfängeradresse nicht (mehr) gibt.
 * Im Zweifel false – ein falscher Vermerk würde künftige E-Mails an ein erreichbares Mitglied unterdrücken.
 */
export function dauerhafterEmpfaengerfehler(fehler: string | null | undefined): boolean {
  const t = (fehler ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (NIE.test(t)) return false;
  if (STATUS_ADRESSE.test(t)) return true;
  if (STATUS_ANDERER.test(t)) return false;
  // nur vorübergehend (4xx / 4.x.x) und kein 550/551/553 daneben
  if (STATUS_VORUEBERGEHEND.test(t) && !SMTP_ADRESSE.test(t)) return false;
  if (TEXT_ADRESSE.test(t)) return true;
  // 550/551/553 ohne erweiterten Statuscode: Postfach nicht verfügbar / Empfänger nicht hier / Postfachname nicht erlaubt
  return SMTP_ADRESSE.test(t) && !STATUS_UNBESTIMMT.test(t);
}

/**
 * Welche Empfänger eines fehlgeschlagenen Versands betrifft der Fehler? Die in der Meldung genannten Empfänger; nennt sie
 * keinen und gab es nur einen Empfänger, dieser. Bei mehreren Empfängern ohne Nennung: keiner (nicht raten).
 */
export function betroffeneEmpfaenger(fehler: string | null | undefined, empfaenger: string[]): string[] {
  const text = (fehler ?? '').toLowerCase();
  const alle = [...new Set(empfaenger.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const genannt = alle.filter((e) => text.includes(e));
  return genannt.length ? genannt : alle.length === 1 ? alle : [];
}

/** Zustellbericht (DSN): Adressen aus „Final-Recipient“/„Original-Recipient“, nur aus Abschnitten mit „Action: failed“ bzw. ohne Angabe */
export function dsnEmpfaenger(text: string | null | undefined): string[] {
  const out: string[] = [];
  // je Empfänger ein Abschnitt, getrennt durch Leerzeilen
  for (const block of (text ?? '').split(/\r?\n\s*\r?\n/)) {
    const treffer = [...block.matchAll(/^\s*(?:final|original)-recipient:\s*(?:[a-z0-9-]+\s*;)?\s*<?([^\s<>;]+@[^\s<>;]+)>?/gim)].map((m) => m[1].toLowerCase());
    if (!treffer.length) continue;
    const aktion = /^\s*action:\s*([a-z-]+)/im.exec(block)?.[1]?.toLowerCase();
    if (aktion && aktion !== 'failed') continue; // delayed, delivered, relayed, expanded
    for (const a of treffer) if (!out.includes(a)) out.push(a);
  }
  return out;
}

/** Teil eines Zustellberichts, der zu einer Adresse gehört (deren DSN-Abschnitt), sonst der ganze Text – für die Einstufung je Empfänger */
export function dsnAbschnitt(text: string | null | undefined, adresse: string): string {
  const a = adresse.toLowerCase();
  const block = (text ?? '').split(/\r?\n\s*\r?\n/).find((b) => /^\s*(final|original)-recipient:/im.test(b) && b.toLowerCase().includes(a));
  return block ?? (text ?? '');
}

/**
 * Empfängerfeld (mehrere mit Komma/Semikolon, auch „Name <adresse>“) ohne die gesperrten Adressen.
 * unklar = das Feld ließ sich nicht sicher zerlegen (Teil ohne erkennbare Adresse) – dann wird nichts entfernt.
 */
export function empfaengerOhne(feld: string | null | undefined, gesperrt: Set<string>): { feld: string; entfernt: string[]; unklar: boolean } {
  const roh = feld ?? '';
  const teile = roh.split(/[;,]+/).map((x) => x.trim()).filter(Boolean);
  const entfernt: string[] = [];
  const bleibt: string[] = [];
  let unklar = false;
  for (const t of teile) {
    const a = adressen(t);
    if (a.length !== 1) { unklar = true; bleibt.push(t); continue; }
    if (gesperrt.has(a[0])) entfernt.push(a[0]); else bleibt.push(t);
  }
  if (!entfernt.length) return { feld: roh, entfernt: [], unklar: false };
  if (unklar) return { feld: roh, entfernt: [...new Set(entfernt)], unklar: true };
  return { feld: bleibt.join(', '), entfernt: [...new Set(entfernt)], unklar: false };
}
