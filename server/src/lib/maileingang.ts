/**
 * Rückmeldungen zu gesendeten E-Mails einordnen (E-Mail-Protokoll): reine Hilfsfunktionen ohne Datenbank.
 * n8n liefert jede eingegangene Mail der Absender-Postfächer; hier wird entschieden, ob es eine Unzustellbar-Meldung,
 * eine Abwesenheitsnotiz oder eine Antwort ist, und was zum Zuordnen gebraucht wird. Der Text wird nur ausgewertet, nie gespeichert.
 */
import { adressen } from './mailuebersicht.js';

export type EingangArt = 'unzustellbar' | 'abwesenheit' | 'antwort';

export interface Eingang {
  postfach?: string | null;
  von?: string | null;
  betreff?: string | null;
  /** Datum der Mail (ISO oder RFC 2822) */
  datum?: string | null;
  message_id?: string | null;
  in_reply_to?: string | null;
  references?: string | null;
  /** Kopfzeile Auto-Submitted (auto-replied = Abwesenheit, auto-generated = Systemmeldung) */
  auto?: string | null;
  text?: string | null;
}

const DAEMON = /mailer-daemon|postmaster|mail delivery (sub)?system/i;
const BETREFF_RUECK = /deliver(y|ed)? .*(fail|notif|status)|undeliver|unzustellbar|nicht zustellbar|returned mail|failure notice|zustellung .*(fehlgeschlagen|nicht)|delivery status notification/i;
const BETREFF_ABWESEND = /abwesen|out of office|automatische antwort|automatic reply|auto(-| )?reply|autoreply|urlaub|nicht im (büro|haus)/i;

export function einordnen(e: Eingang): EingangArt {
  if (DAEMON.test(e.von ?? '') || BETREFF_RUECK.test(e.betreff ?? '')) return 'unzustellbar';
  if (/auto-replied/i.test(e.auto ?? '') || BETREFF_ABWESEND.test(e.betreff ?? '')) return 'abwesenheit';
  return 'antwort';
}

/** Message-IDs ohne spitze Klammern, klein geschrieben (Kopfzeilen können mehrere enthalten) */
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

/** Message-ID der ursprünglichen E-Mail aus dem Text eines Rückläufers (Zeile „Message-ID: <…>“) */
export function messageIdsImText(text: string | null | undefined): string[] {
  return messageIds(...[...(text ?? '').matchAll(/message-id:\s*<([^>\s]+)>/gi)].map((m) => m[1]));
}

/** Adressen im Text eines Rückläufers, die als fehlgeschlagene Empfänger in Frage kommen (ohne System- und eigene Adressen) */
export function adressenImText(text: string | null | undefined, ohne: (string | null | undefined)[] = []): string[] {
  const eigene = new Set(ohne.flatMap((x) => adressen(x)));
  const gefunden = ((text ?? '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).map((x) => x.toLowerCase());
  return [...new Set(gefunden)].filter((a) => !eigene.has(a) && !/^(mailer-daemon|postmaster)@/.test(a));
}

/** Fehlerzeilen des Mailservers aus einem Rückläufer (SMTP-Code 4xx/5xx bzw. Statuscode 5.1.1), höchstens 500 Zeichen */
export function rueckGrund(text: string | null | undefined): string {
  const zeilen = (text ?? '').split(/\r?\n/).map((z) => z.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const treffer = zeilen.filter((z) => /^(smtp error|remote server returned|diagnostic-code:|status: [45]\.)/i.test(z) || /(^|[\s:(])[45]\d\d[ -]/.test(z) || /\b[45]\.\d{1,3}\.\d{1,3}\b/.test(z));
  return [...new Set(treffer)].slice(0, 4).join(' ').slice(0, 500);
}

/** Betreff ohne Antwort-/Weiterleitungszusätze, klein geschrieben – zum Vergleich mit dem Betreff der gesendeten E-Mail */
export function betreffKern(betreff: string | null | undefined): string {
  let b = (betreff ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  for (let i = 0; i < 10; i++) {
    const n = b.replace(/^((re|aw|wg|fw|fwd|antw|antwort|automatische antwort|automatic reply)\s*(\[\d+\])?\s*:\s*)/i, '');
    if (n === b) break;
    b = n;
  }
  return b;
}

/** Datum der Mail, sonst jetzt (auch bei unlesbarem oder offensichtlich falschem Datum) */
export function eingangZeit(datum: string | null | undefined, jetzt = new Date()): Date {
  const d = datum ? new Date(datum) : null;
  if (!d || Number.isNaN(d.getTime()) || d.getTime() > jetzt.getTime() + 3600_000) return jetzt;
  return d;
}
