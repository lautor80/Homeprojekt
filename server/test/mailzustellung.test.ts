/**
 * Unzustellbare Empfängeradressen (server/src/lib/mailzustellung.ts), ohne Datenbank:
 * Einstufung der Fehlermeldung (nur „Adresse gibt es nicht“ zählt), betroffene Empfänger, Zustellbericht (DSN), Empfängerfeld ohne gesperrte.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { betroffeneEmpfaenger, dauerhafterEmpfaengerfehler, dsnAbschnitt, dsnEmpfaenger, empfaengerOhne } from '../src/lib/mailzustellung.js';
import { rueckGrund } from '../src/lib/maileingang.js';

test('Einstufung: dauerhafte Empfängerfehler', () => {
  for (const t of [
    '550 5.1.1 <weg@example.org>: Recipient address rejected: User unknown in virtual mailbox table',
    "Can't send mail - all recipients were rejected: 550 5.1.1 <weg@example.org>: Recipient address rejected: User unknown",
    '550-Requested action not taken: mailbox unavailable 550 For explanation visit https://postmaster.example.net/case?c=r1601',
    '550 Requested action not taken: mailbox unavailable',
    '551 User not local; please try <forward-path>',
    '553 Requested action not taken: mailbox name not allowed',
    '550-5.1.1 The email account that you tried to reach does not exist. Please try 550-5.1.1 double-checking the recipient\'s email address',
    'Diagnostic-Code: smtp; 550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup',
    '550 5.4.1 Recipient address rejected: Access denied',
    'Status: 5.1.2 Diagnostic-Code: smtp; 554 5.1.2 Bad destination system address',
    'Status: 5.4.4 (unable to route: no mail hosts for domain)',
    'No such user here',
    'Unrouteable address',
    'Host or domain name not found. Name service error for name=gibtsnicht.example type=MX: Host not found',
    'SMTP error from remote mail server after RCPT TO:<erika.muster@example.org>: 550-Requested action not taken: mailbox unavailable',
    'Ungültige Adresse in an: erika.muster@example',
    'Empfänger unbekannt',
  ]) assert.equal(dauerhafterEmpfaengerfehler(t), true, t);
});

test('Einstufung: Konfigurations-, Absender- und vorübergehende Fehler setzen nie einen Vermerk', () => {
  for (const t of [
    '', null, undefined, 'Versand fehlgeschlagen', 'unbekannt',
    // Einrichtung und Erreichbarkeit
    'n8n-Workflow "TCO Mailversand" ist nicht aktiv oder die URL stimmt nicht (Webhook 404)',
    'n8n hat den Webhook-Schlüssel abgelehnt: Im n8n-Credential „Header Auth account“ muss der Name „X-TCO-Key“ lauten',
    'n8n nicht erreichbar: fetch failed', 'n8n nicht erreichbar: The operation was aborted due to timeout',
    'Unerwartete Antwort von n8n (HTTP 500)', 'HTTP 550: irgendwas', 'Der n8n-Mailversand ist nicht eingerichtet (Webhook-URL fehlt)',
    'connect ECONNREFUSED 192.0.2.5:587', 'getaddrinfo ENOTFOUND smtp.example.org', 'Connection timeout', 'Greeting never received', 'ETIMEDOUT',
    'Invalid login: 535 5.7.8 Authentication credentials invalid', '535 Authentication failed', '530 5.7.0 Must issue a STARTTLS command first',
    // Absender nicht erlaubt
    '550 5.7.1 Sender address rejected: not owned by user kasse@verein.example', '553 5.7.1 <x@y.de>: Sender address rejected: not logged in',
    '550 5.7.60 SMTP; Client does not have permissions to send as this sender', '554 5.7.1 <weg@example.org>: Relay access denied',
    '550 Mail from kasse@verein.example rejected', '550 5.1.8 Sender address rejected: Domain not found', '550 5.1.0 Address rejected.',
    // vorübergehend
    '450 4.1.1 <weg@example.org>: Recipient address rejected: unverified address', '451 4.7.1 Greylisted, please try again later',
    '421 4.4.2 Connection dropped', '452 4.2.2 Mailbox full', 'Status: 4.4.1 Action: delayed',
    // dauerhaft, aber nicht die Adresse: Postfach voll, Spam, Größe, Richtlinie
    '552 5.2.2 Mailbox full', '550 5.2.2 <weg@example.org>: user is over quota', '550 5.7.1 Message rejected as spam by Content Filtering',
    '552 5.3.4 Message size exceeds fixed limit', '550 5.7.1 Service unavailable; client host blocked using Spamhaus',
    '550 5.7.26 Unauthenticated email is not accepted due to DMARC policy', '550 High probability of spam', '554 5.6.0 Message content rejected',
    '550 5.0.0 Zugriff verweigert', '554 Transaction failed',
    'Ungültige Adresse in antwort_an: kasse@verein', 'Kein Empfänger angegeben', 'Anhang rechnung.pdf ist leer',
  ]) assert.equal(dauerhafterEmpfaengerfehler(t), false, String(t));
});

test('Betroffene Empfänger: genannte Adresse, sonst der einzige Empfänger – bei mehreren ohne Nennung keiner', () => {
  assert.deepEqual(betroffeneEmpfaenger('550 5.1.1 <Weg@Example.org>: User unknown', ['gut@example.org', 'weg@example.org']), ['weg@example.org']);
  assert.deepEqual(betroffeneEmpfaenger('550 User unknown', ['weg@example.org']), ['weg@example.org']);
  assert.deepEqual(betroffeneEmpfaenger('550 User unknown', ['gut@example.org', 'weg@example.org']), []);
  assert.deepEqual(betroffeneEmpfaenger('550 User unknown', []), []);
});

const DSN = `This is the mail system at host mail.verein.example.

<weg@example.org>: host mx.example.org[192.0.2.7] said: 550 5.1.1
    <weg@example.org>: Recipient address rejected: User unknown (in reply to RCPT TO command)

Reporting-MTA: dns; mail.verein.example
Arrival-Date: Sat, 14 Nov 2026 10:00:00 +0100 (CET)

Final-Recipient: rfc822; weg@example.org
Original-Recipient: rfc822;Weg@Example.org
Action: failed
Status: 5.1.1
Remote-MTA: dns; mx.example.org
Diagnostic-Code: smtp; 550 5.1.1 <weg@example.org>: Recipient address rejected: User unknown

Final-Recipient: rfc822; voll@example.org
Action: failed
Status: 5.2.2
Diagnostic-Code: smtp; 552 5.2.2 Mailbox full

Final-Recipient: rfc822; spaeter@example.org
Action: delayed
Status: 4.4.1
`;

test('Zustellbericht (DSN): fehlgeschlagene Empfänger und Einstufung je Abschnitt', () => {
  assert.deepEqual(dsnEmpfaenger(DSN), ['weg@example.org', 'voll@example.org'], 'verzögerte Zustellung zählt nicht');
  assert.deepEqual(dsnEmpfaenger('Mail delivery failed: weg@example.org'), [], 'ohne Zustellbericht keine sicheren Empfänger');
  assert.equal(dauerhafterEmpfaengerfehler(rueckGrund(dsnAbschnitt(DSN, 'weg@example.org'))), true);
  assert.equal(dauerhafterEmpfaengerfehler(rueckGrund(dsnAbschnitt(DSN, 'voll@example.org'))), false, 'Postfach voll ist keine falsche Adresse');
});

test('Empfängerfeld ohne gesperrte Adressen', () => {
  const g = new Set(['weg@example.org']);
  assert.deepEqual(empfaengerOhne('gut@example.org', g), { feld: 'gut@example.org', entfernt: [], unklar: false });
  assert.deepEqual(empfaengerOhne('Erika <WEG@example.org>; gut@example.org, Max Muster <max@example.org>', g),
    { feld: 'gut@example.org, Max Muster <max@example.org>', entfernt: ['weg@example.org'], unklar: false });
  assert.deepEqual(empfaengerOhne('weg@example.org', g), { feld: '', entfernt: ['weg@example.org'], unklar: false });
  assert.deepEqual(empfaengerOhne(null, g), { feld: '', entfernt: [], unklar: false });
  // Name mit Komma: Das Feld lässt sich nicht sicher zerlegen – nichts entfernen, der Versand lehnt dann ab
  const r = empfaengerOhne('"Muster, Erika" <weg@example.org>, gut@example.org', g);
  assert.equal(r.unklar, true);
  assert.equal(r.feld, '"Muster, Erika" <weg@example.org>, gut@example.org');
});
